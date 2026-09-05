import { execFile } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { ComfyClient } from "./comfy-client.js";

const runFile = promisify(execFile);

type ExportTimeline = {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  externalAudioFile: string | null;
  externalAudioName: string | null;
  originalAudioGain: number;
  externalAudioGain: number;
  externalAudioLoop: boolean;
  audioTracks?: Array<{
    file: string;
    name: string;
    sourceDuration: number | null;
    startTime: number;
    trimStart: number;
    trimEnd: number | null;
    gain: number;
    muted: boolean;
    solo: boolean;
    loop: boolean;
    fadeIn: number;
    fadeOut: number;
  }>;
  clips: Array<{
    trimStart: number;
    trimEnd: number;
    volume: number;
    hasAudio?: boolean;
    isStillImage?: boolean;
    cropX?: number;
    cropY?: number;
    cropZoom?: number;
    cropWidth?: number;
    cropHeight?: number;
    cropAspect?: string;
    sourceAspectFormat?: string;
    output: { mediaPath: string; filename: string };
  }>;
};

function safeName(value: string) {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "montaggio";
}
function concatPath(value: string) {
  return value.replace(/\\/g, "/").replace(/'/g, "'\\''");
}
function annotatedMedia(value: string) {
  const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(value.trim());
  const raw = (match?.[1] ?? value).replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean);
  return {
    filename: parts.pop() ?? raw,
    subfolder: parts.join("/"),
    type: (match?.[2] ?? "input") as "input" | "output" | "temp",
  };
}

function ratioFromLabel(value: string | undefined, fallback = 16 / 9) {
  const match = /(^|\D)(\d+):(\d+)(\D|$)/.exec(value ?? "");
  if (!match) return fallback;
  const width = Number(match[2]);
  const height = Number(match[3]);
  return width > 0 && height > 0 ? width / height : fallback;
}

function evenDimensionsForRatio(ratio: number) {
  const targetArea = 1280 * 720;
  const height = Math.max(64, Math.round(Math.sqrt(targetArea / ratio) / 2) * 2);
  const width = Math.max(64, Math.round((height * ratio) / 2) * 2);
  return { width, height };
}

export class TimelineExportService {
  constructor(
    private readonly comfy: ComfyClient,
    private readonly dataDir: string,
    private readonly ffmpegPath: string,
  ) {}

  async export(timeline: ExportTimeline) {
    if (timeline.clips.length === 0) throw new Error("La timeline non contiene clip");
    const usesAspectCrop = timeline.clips.some(clip => (clip.cropAspect ?? "original") !== "original");
    const cropRatios = timeline.clips.map(clip => {
      const sourceRatio = ratioFromLabel(clip.sourceAspectFormat);
      if ((clip.cropAspect ?? "original") !== "original") return ratioFromLabel(clip.cropAspect, sourceRatio);
      const width = clip.cropWidth ?? clip.cropZoom ?? 1;
      const height = clip.cropHeight ?? clip.cropZoom ?? 1;
      return sourceRatio * width / height;
    });
    if (usesAspectCrop && cropRatios.some(ratio => Math.abs(ratio - cropRatios[0]) > 0.015)) {
      throw new Error("Tutte le clip devono usare lo stesso rapporto crop prima dell’export");
    }
    const targetDimensions = usesAspectCrop ? evenDimensionsForRatio(cropRatios[0]) : null;
    const workDir = mkdtempSync(path.join(tmpdir(), "h3-studio-export-"));
    const exportDir = path.join(this.dataDir, "exports", timeline.projectId);
    mkdirSync(exportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${safeName(timeline.projectName)}_${safeName(timeline.name)}_${stamp}.mp4`;
    const outputPath = path.join(exportDir, filename);
    try {
      const processed: string[] = [];
      for (const [index, clip] of timeline.clips.entries()) {
        const url = new URL(clip.output.mediaPath, "http://h3.local");
        const source = await this.comfy.mediaResponse(
          url.searchParams.get("filename") ?? clip.output.filename,
          url.searchParams.get("subfolder") ?? "",
          (url.searchParams.get("type") as "input" | "output" | "temp") ?? "output",
        );
        if (!source.ok || !source.body) throw new Error(`Clip ${index + 1} non leggibile da ComfyUI`);
        const sourceExtension = path.extname(clip.output.filename) || (clip.isStillImage ? ".png" : ".mp4");
        const originalPath = path.join(workDir, `source_${index + 1}${sourceExtension}`);
        await pipeline(Readable.fromWeb(source.body as never), createWriteStream(originalPath));
        const processedPath = path.join(workDir, `clip_${index + 1}.mp4`);
        const duration = Math.max(0.05, clip.trimEnd - clip.trimStart);
        const cropWidth = Math.min(1, Math.max(0.05, clip.cropWidth ?? clip.cropZoom ?? 1));
        const cropHeight = Math.min(1, Math.max(0.05, clip.cropHeight ?? clip.cropZoom ?? 1));
        const cropX = Math.min(1 - cropWidth, Math.max(0, clip.cropX ?? 0));
        const cropY = Math.min(1 - cropHeight, Math.max(0, clip.cropY ?? 0));
        const hasCrop = cropWidth < 0.999 || cropHeight < 0.999 || cropX > 0.001 || cropY > 0.001;
        const filters: string[] = [];
        if (hasCrop) {
          filters.push(`crop=w='trunc(iw*${cropWidth}/2)*2':h='trunc(ih*${cropHeight}/2)*2':x='trunc(iw*${cropX}/2)*2':y='trunc(ih*${cropY}/2)*2'`);
        }
        if (targetDimensions) {
          filters.push(`scale=${targetDimensions.width}:${targetDimensions.height}:flags=lanczos`);
        } else if (hasCrop) {
          filters.push(`scale=w='trunc(iw/${cropWidth}/2)*2':h='trunc(ih/${cropHeight}/2)*2':flags=lanczos`);
        } else if (clip.isStillImage) {
          filters.push("scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2':flags=lanczos");
        }
        filters.push("setsar=1", "setpts=PTS-STARTPTS");
        const videoFilters = filters.join(",");
        const sourceArgs = clip.isStillImage
          ? ["-y", "-loop", "1", "-i", originalPath]
          : ["-y", "-ss", String(clip.trimStart), "-i", originalPath];
        if (clip.hasAudio === false) {
          sourceArgs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
        }
        sourceArgs.push(
          "-t", String(duration),
          "-map", "0:v:0", "-map", clip.hasAudio === false ? "1:a:0" : "0:a:0?", "-vf", videoFilters,
          "-af", `volume=${clip.volume},asetpts=PTS-STARTPTS`,
          "-c:v", "libx264", "-preset", "medium", "-crf", "16",
          "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
          processedPath,
        );
        await runFile(
          this.ffmpegPath,
          sourceArgs,
          { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        );
        processed.push(processedPath);
      }

      const listPath = path.join(workDir, "concat.txt");
      const joinedPath = path.join(workDir, "joined.mp4");
      writeFileSync(listPath, processed.map(clip => `file '${concatPath(clip)}'`).join("\n"), "utf8");
      await runFile(
        this.ffmpegPath,
        ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", joinedPath],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );

      const timelineDuration = timeline.clips.reduce(
        (total, clip) => total + Math.max(0.05, clip.trimEnd - clip.trimStart),
        0,
      );
      const configuredTracks = timeline.audioTracks?.length
        ? timeline.audioTracks
        : timeline.externalAudioFile ? [{
            file: timeline.externalAudioFile,
            name: timeline.externalAudioName ?? "Traccia audio",
            sourceDuration: null,
            startTime: 0,
            trimStart: 0,
            trimEnd: null,
            gain: timeline.externalAudioGain,
            muted: false,
            solo: false,
            loop: timeline.externalAudioLoop,
            fadeIn: 0,
            fadeOut: 0,
          }] : [];
      const hasSolo = configuredTracks.some(track => track.solo && !track.muted);
      const activeTracks = configuredTracks.filter(track => !track.muted && (!hasSolo || track.solo));
      if (activeTracks.length) {
        const args = ["-y", "-i", joinedPath];
        const downloaded: Array<{ track: (typeof activeTracks)[number]; path: string }> = [];
        for (const [index, track] of activeTracks.entries()) {
          const audio = annotatedMedia(track.file);
          const response = await this.comfy.mediaResponse(audio.filename, audio.subfolder, audio.type);
          if (!response.ok || !response.body) throw new Error(`Traccia audio ${index + 1} non leggibile da ComfyUI`);
          const audioPath = path.join(workDir, `external_${index + 1}${path.extname(audio.filename) || ".audio"}`);
          await pipeline(Readable.fromWeb(response.body as never), createWriteStream(audioPath));
          downloaded.push({ track, path: audioPath });
          if (track.loop) args.push("-stream_loop", "-1");
          args.push("-i", audioPath);
        }
        const filters: string[] = [];
        const mixInputs: string[] = [];
        if (timeline.originalAudioGain > 0) {
          filters.push(`[0:a:0]volume=${timeline.originalAudioGain},apad=whole_dur=${timelineDuration}[original]`);
          mixInputs.push("[original]");
        }
        downloaded.forEach(({ track }, index) => {
          const available = track.trimEnd ?? track.sourceDuration ?? timelineDuration + track.trimStart;
          const naturalDuration = Math.max(0.05, available - track.trimStart);
          const remaining = Math.max(0.05, timelineDuration - track.startTime);
          const playDuration = track.loop ? remaining : Math.min(naturalDuration, remaining);
          const fadeIn = Math.min(track.fadeIn, playDuration);
          const fadeOut = Math.min(track.fadeOut, playDuration);
          const chain = [
            `atrim=start=${track.trimStart}:duration=${playDuration}`,
            "asetpts=PTS-STARTPTS",
            `volume=${track.gain}`,
          ];
          if (fadeIn > 0.001) chain.push(`afade=t=in:st=0:d=${fadeIn}`);
          if (fadeOut > 0.001) chain.push(`afade=t=out:st=${Math.max(0, playDuration - fadeOut)}:d=${fadeOut}`);
          if (track.startTime > 0.001) chain.push(`adelay=${Math.round(track.startTime * 1000)}:all=1`);
          chain.push(`apad=whole_dur=${timelineDuration}`);
          filters.push(`[${index + 1}:a:0]${chain.join(",")}[track${index}]`);
          mixInputs.push(`[track${index}]`);
        });
        filters.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[mixed]`);
        args.push(
          "-filter_complex", filters.join(";"),
          "-map", "0:v:0", "-map", "[mixed]", "-c:v", "copy", "-c:a", "aac",
          "-b:a", "192k", "-t", String(timelineDuration), outputPath,
        );
        await runFile(this.ffmpegPath, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      } else if (timeline.originalAudioGain <= 0) {
        await runFile(this.ffmpegPath, ["-y", "-i", joinedPath, "-map", "0:v:0", "-c:v", "copy", "-an", outputPath], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      } else if (Math.abs(timeline.originalAudioGain - 1) > 0.001) {
        await runFile(this.ffmpegPath, ["-y", "-i", joinedPath, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-af", `volume=${timeline.originalAudioGain}`, "-c:a", "aac", "-b:a", "192k", outputPath], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      } else {
        copyFileSync(joinedPath, outputPath);
      }
      return {
        filename,
        outputPath,
        mediaPath: `/api/exports/${timeline.projectId}/${encodeURIComponent(filename)}`,
        clipCount: timeline.clips.length,
        timelineId: timeline.id,
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

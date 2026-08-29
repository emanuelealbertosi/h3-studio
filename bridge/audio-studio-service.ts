import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ComfyApiPrompt, ComfyHistoryEntry } from "./comfy-client.js";
import type { ComfyClient } from "./comfy-client.js";
import type { ComfyProgressTracker } from "./comfy-progress.js";
import { AudioJobRepository, type AudioOutput } from "./audio-job-repository.js";
import type { ExternalMediaRepository } from "./external-media-repository.js";
import type { RuntimeSettingsStore } from "./runtime-settings.js";

const execFileAsync = promisify(execFile);

export function stereoCodecArgs(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".wav") return ["-c:a", "pcm_s16le"];
  if (extension === ".flac") return ["-c:a", "flac"];
  if (extension === ".mp3") return ["-c:a", "libmp3lame", "-b:a", "192k"];
  if (extension === ".ogg") return ["-c:a", "libvorbis", "-q:a", "6"];
  if (extension === ".m4a" || extension === ".aac") return ["-c:a", "aac", "-b:a", "192k"];
  return ["-c:a", "pcm_s16le"];
}

export async function probeAudioDuration(filename: string, ffmpegPath: string) {
  const probe = await execFileAsync(ffprobeFor(ffmpegPath), [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filename,
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Durata del parlato non rilevabile");
  }
  return duration;
}

export function speechTrackMixFilter(value: {
  durationSeconds: number;
  voiceGain: number;
  musicGain: number;
  ducking: number;
}) {
  const duration = Math.max(0.1, value.durationSeconds);
  const ratio = 1 + Math.max(0, Math.min(1, value.ducking)) * 11;
  return [
    "[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo,aresample=async=1:first_pts=0,asplit=2[voice_sc][voice_mix]",
    `[1:a:0]aformat=sample_rates=48000:channel_layouts=stereo,aresample=async=1:first_pts=0,apad,atrim=0:${duration.toFixed(3)},volume=${value.musicGain}[music]`,
    `[music][voice_sc]sidechaincompress=threshold=0.025:ratio=${ratio.toFixed(2)}:attack=15:release=350[ducked]`,
    `[voice_mix]volume=${value.voiceGain}[voice]`,
    "[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[out]",
  ].join(";");
}

function ffprobeFor(ffmpegPath: string) {
  const directory = path.dirname(ffmpegPath);
  const filename = path.basename(ffmpegPath).toLowerCase();
  if (filename === "ffmpeg.exe") return path.join(directory, "ffprobe.exe");
  if (filename === "ffmpeg") return directory === "." ? "ffprobe" : path.join(directory, "ffprobe");
  return "ffprobe";
}

async function ensureStereoAudioFile(filename: string, ffmpegPath: string) {
  let channels: number | null = null;
  try {
    const probe = await execFileAsync(ffprobeFor(ffmpegPath), [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
      "-of", "default=noprint_wrappers=1:nokey=1", filename,
    ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    channels = Number(probe.stdout.trim());
  } catch {
    // FFmpeg eseguirà comunque una validazione completa durante la conversione.
  }
  if (channels === 2) return { converted: false, channels: 2 };
  const extension = path.extname(filename) || ".wav";
  const temporary = path.join(
    path.dirname(filename),
    `${path.basename(filename, path.extname(filename))}.stereo-${randomUUID().slice(0, 8)}${extension}`,
  );
  try {
    await execFileAsync(ffmpegPath, [
      "-y", "-v", "error", "-i", filename, "-map", "0:a:0", "-vn", "-ac", "2",
      ...stereoCodecArgs(filename), temporary,
    ], { encoding: "utf8", timeout: 5 * 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    await copyFile(temporary, filename);
    return { converted: true, channels: 2 };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

const MAX_SEED = 2_147_483_647;
const activeStates = new Set(["prepared", "queued", "loading", "running", "finalizing"]);

export type MusicPlan = {
  caption: string;
  lyrics: string;
  instrumental: boolean;
  summary: string;
};

const MUSIC_PLANNER_SYSTEM_PROMPT = `You are the Music Planner for H3 Studio and MiniMax Music 3.
Convert a natural-language music request into one strict JSON object with no markdown:
{"caption":"English production prompt","lyrics":"structured lyrics or empty string","instrumental":true,"summary":"short Italian explanation"}

The caption must be written in English and specify genre, mood, BPM or tempo, instrumentation, arrangement, song structure, vocal profile and language when applicable, mix, production character and ending. Adapt the structure to the requested duration. Do not mention software, models, nodes or prompt engineering.
If instrumental is true, lyrics must be an empty string and the caption must explicitly say instrumental with no vocals.
If instrumental is false, lyrics must contain complete singable lyrics in the requested language, organized with English section tags such as [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Bridge] and [Outro]. Use only the sections that fit the duration. Preserve any lyrics supplied by the user, correcting and structuring them without changing their intended meaning unless explicitly asked.
The summary must be concise Italian and explain the musical choices. Never return additional keys.`;

const SPEECH_TRACK_PLANNER_PREFIX = `Create an instrumental backing track for an existing spoken-word recording.
The original speech will remain untouched and will be mixed over the generated music.
Leave rhythmic and spectral space for intelligible speech, avoid lead vocals and avoid dominant lead instruments.
Use a clear intro, supportive development and a resolved ending sized to the exact recording duration.
Match the emotional meaning and pacing of the transcript without turning its words into sung lyrics.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${label} deve contenere da ${minimum} a ${maximum.toLocaleString("it-IT")} caratteri`);
  }
  return normalized;
}

export function normalizeHiggsTtsText(value: unknown) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) return "";
  const higgsTokens = source.match(/^(?:\s*<\|(?:emotion|style|prosody|sfx):[^>]+\|>\s*)+/i)?.[0].trim() ?? "";
  const dialogue = [...source.matchAll(/<d>\s*(?:\[[^\]]+\]\s*)?([\s\S]*?)\s*<\/d>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (dialogue.length) return [higgsTokens, dialogue.join(" ")].filter(Boolean).join(" ");
  return source;
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} deve essere compreso fra ${minimum} e ${maximum}`);
  }
  return normalized;
}

function seed(value: unknown) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 && normalized <= MAX_SEED
    ? normalized
    : Math.floor(Math.random() * MAX_SEED);
}

function extractJsonObject(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? raw;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM non ha restituito il piano musicale JSON");
  return JSON.parse(source.slice(start, end + 1)) as unknown;
}

export function normalizeMusicPlan(raw: string, expectedInstrumental: boolean): MusicPlan {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) throw new Error("Piano musicale LLM non valido");
  const caption = typeof parsed.caption === "string" ? parsed.caption.trim().slice(0, 10_000) : "";
  const lyrics = typeof parsed.lyrics === "string" ? parsed.lyrics.trim().slice(0, 30_000) : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 1_000) : "";
  if (caption.length < 20) throw new Error("LLM ha prodotto una descrizione musicale troppo breve");
  if (!expectedInstrumental && lyrics.length < 10) throw new Error("LLM non ha prodotto le lyrics richieste");
  return {
    caption,
    lyrics: expectedInstrumental ? "" : lyrics,
    instrumental: expectedInstrumental,
    summary: summary || "Piano musicale preparato dal modello LLM.",
  };
}

function findAudioOutput(entry: ComfyHistoryEntry) {
  if (!isRecord(entry.outputs)) return null;
  for (const output of Object.values(entry.outputs)) {
    if (!isRecord(output)) continue;
    for (const value of Object.values(output)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!isRecord(item) || typeof item.filename !== "string") continue;
        if (!/\.(wav|flac|mp3|ogg|m4a)$/i.test(item.filename)) continue;
        const type: "input" | "output" | "temp" =
          item.type === "input" || item.type === "temp" ? item.type : "output";
        return {
          filename: item.filename,
          subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
          type,
          format: typeof item.format === "string" && item.format.startsWith("audio/")
            ? item.format
            : `audio/${path.extname(item.filename).slice(1).toLowerCase() || "wav"}`,
        };
      }
    }
  }
  return null;
}

function buildMusicPrompt(value: {
  caption: string;
  lyrics: string;
  durationSeconds: number;
  seed: number;
  model: string;
  encoder: string;
  vae: string;
  steps: number;
  cfg: number;
  tiledDecode: boolean;
  filenamePrefix: string;
}): ComfyApiPrompt {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: value.model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: value.encoder, type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: value.vae } },
    "4": {
      class_type: "MiniMaxMusic3TextEncode",
      inputs: {
        clip: ["2", 0], caption: value.caption, lyrics: value.lyrics,
        seed: value.seed, max_duration: value.durationSeconds,
        cfg_scale: value.cfg, top_k: 50,
      },
    },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "EmptyMiniMaxMusic3LatentAudio", inputs: { seconds: ["4", 1], batch_size: 1 } },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], seed: value.seed, steps: value.steps, cfg: value.cfg,
        sampler_name: "euler", scheduler: "simple", positive: ["4", 0],
        negative: ["5", 0], latent_image: ["6", 0], denoise: 1,
      },
    },
    "8": value.tiledDecode
      ? { class_type: "VAEDecodeAudioTiled", inputs: { samples: ["7", 0], vae: ["3", 0], tile_size: 1536, overlap: 64 } }
      : { class_type: "VAEDecodeAudio", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveAudio", inputs: { audio: ["8", 0], filename_prefix: value.filenamePrefix } },
  };
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export class AudioStudioService {
  private readonly ttsProcesses = new Map<string, { child: ChildProcessWithoutNullStreams; controller: AbortController }>();
  private readonly cancelledJobs = new Set<string>();
  private readonly ttsStopOperations = new Map<string, Promise<void>>();
  private readonly speechMixes = new Set<string>();
  private readonly voiceConversions = new Set<string>();
  private readonly audioCppProcesses = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly comfy: ComfyClient,
    private readonly repository: AudioJobRepository,
    private readonly runtimeSettings: RuntimeSettingsStore,
    private readonly progressTracker: ComfyProgressTracker,
    private readonly externalMedia: ExternalMediaRepository,
    private readonly comfyOutputDir: string,
    private readonly dataDir: string,
    private readonly ffmpegPath: string,
  ) {}

  async status() {
    const settings = await this.runtimeSettings.get();
    const root = settings.tts.root;
    const voicesDir = path.join(root, "voices");
    const voices = existsSync(voicesDir)
      ? (await readdir(voicesDir)).filter((file) => /\.(wav|mp3|ogg|flac)$/i.test(file)).sort()
      : [];
    const [musicModels, encoders, vaes, musicNode, chatRuntime] = await Promise.all([
      this.comfy.modelFiles("diffusion_models").catch((): string[] => []),
      this.comfy.modelFiles("text_encoders").catch((): string[] => []),
      this.comfy.modelFiles("vae").catch((): string[] => []),
      this.comfy.objectInfo("MiniMaxMusic3TextEncode").catch(() => null),
      this.comfy.chatStatus().catch(() => null),
    ]);
    return {
      tts: {
        ready: existsSync(path.join(root, "python", "python.exe")) && existsSync(path.join(root, "server.py")),
        root,
        voices,
        defaultVoice: settings.tts.voice,
        unloadPolicy: "always-after-job",
        plannerReady: chatRuntime?.ready === true,
        plannerModel: settings.chat.model,
        transcriptionReady: existsSync(path.join(root, "python", "python.exe")),
        transcriptionModel: "openai/whisper-small",
        transcriptionUnloadPolicy: "process-exit",
      },
      music: {
        ready: isRecord(musicNode) && isRecord(musicNode.MiniMaxMusic3TextEncode)
          && musicModels.includes(settings.music.model)
          && encoders.includes(settings.music.encoder)
          && vaes.includes(settings.music.vae),
        ...settings.music,
        plannerReady: chatRuntime?.ready === true,
        plannerModel: settings.chat.model,
      },
      voiceConversion: (() => {
        const conversionRoot = settings.voiceConversion.root;
        const cli = path.join(conversionRoot, "audiocpp_cli.exe");
        const separatorModel = path.resolve(conversionRoot, settings.voiceConversion.separatorModel);
        const seedVcModel = path.resolve(conversionRoot, settings.voiceConversion.seedVcModel);
        return {
          ready: existsSync(cli) && existsSync(separatorModel) && existsSync(seedVcModel),
          cli,
          root: conversionRoot,
          separatorModel,
          seedVcModel,
          backend: settings.voiceConversion.backend,
          steps: settings.voiceConversion.steps,
          f0Condition: settings.voiceConversion.f0Condition,
          autoF0Adjust: settings.voiceConversion.autoF0Adjust,
          unloadPolicy: "process-exit",
        };
      })(),
      jobs: this.repository.count(),
    };
  }

  async planMusic(value: unknown): Promise<MusicPlan> {
    if (!isRecord(value)) throw new Error("Richiesta Music Planner non valida");
    const idea = text(value.idea, "Idea musicale", 3, 10_000);
    const instrumental = value.instrumental !== false;
    const durationSeconds = boundedNumber(value.durationSeconds ?? 30, "Durata", 5, 360);
    const providedLyrics = typeof value.lyrics === "string" ? value.lyrics.trim().slice(0, 30_000) : "";
    const settings = (await this.runtimeSettings.get()).chat;
    try {
      const response = await this.comfy.chatGenerate({
        model: settings.model,
        projector: settings.projector,
        n_ctx: settings.nCtx,
        n_gpu_layers: settings.nGpuLayers,
        n_threads: settings.nThreads,
        max_tokens: Math.max(1_024, Math.min(4_096, settings.maxNewTokens)),
        temperature: 0.35,
        top_p: 0.9,
        messages: [
          { role: "system", content: MUSIC_PLANNER_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `REQUESTED_DURATION_SECONDS: ${durationSeconds}`,
              `OUTPUT_MODE: ${instrumental ? "instrumental" : "song_with_vocals"}`,
              `NATURAL_LANGUAGE_REQUEST:\n${idea}`,
              providedLyrics ? `USER_LYRICS_TO_PRESERVE:\n${providedLyrics}` : "USER_LYRICS_TO_PRESERVE: none",
            ].join("\n\n"),
          },
        ],
        images: [],
      });
      if (!response.ok || !response.text?.trim()) {
        throw new Error(response.error ?? "LLM non ha preparato il brano");
      }
      return normalizeMusicPlan(response.text, instrumental);
    } finally {
      await this.comfy.chatUnload().catch(() => undefined);
    }
  }

  async planSpeechTrack(value: unknown): Promise<MusicPlan> {
    if (!isRecord(value)) throw new Error("Richiesta Parlato → brano non valida");
    const idea = typeof value.idea === "string" ? value.idea.trim().slice(0, 10_000) : "";
    const transcript = typeof value.referenceText === "string"
      ? value.referenceText.trim().slice(0, 20_000)
      : "";
    const referenceFile = typeof value.referenceFile === "string"
      ? value.referenceFile.trim().slice(0, 2_000)
      : "";
    let durationSeconds = boundedNumber(value.durationSeconds ?? 30, "Durata", 1, 360);
    let materialized: string | null = null;
    if (referenceFile) {
      try {
        materialized = await this.materializeReference(
          `speech-plan-${randomUUID().slice(0, 8)}`,
          referenceFile,
        );
        durationSeconds = await probeAudioDuration(materialized, this.ffmpegPath);
        if (durationSeconds > 360) throw new Error("Il parlato supera la durata massima di 6 minuti");
      } finally {
        if (materialized) await unlink(materialized).catch(() => undefined);
      }
    }
    const naturalRequest = [
      SPEECH_TRACK_PLANNER_PREFIX,
      idea ? `CREATIVE_DIRECTION:\n${idea}` : "CREATIVE_DIRECTION: infer a tasteful, neutral cinematic direction from the transcript.",
      transcript ? `SPOKEN_TRANSCRIPT_FOR_CONTEXT_ONLY:\n${transcript}` : "SPOKEN_TRANSCRIPT_FOR_CONTEXT_ONLY: unavailable.",
      `EXACT_TARGET_DURATION: ${durationSeconds.toFixed(2)} seconds.`,
    ].join("\n\n");
    const plan = await this.planMusic({
      idea: naturalRequest,
      instrumental: true,
      durationSeconds,
      lyrics: "",
    });
    return {
      ...plan,
      instrumental: true,
      lyrics: "",
      caption: `${plan.caption} Instrumental only, no vocals, with restrained midrange and space for spoken narration.`,
      summary: `${plan.summary} Base predisposta per ducking e mix con il parlato originale.`,
    };
  }

  async transcribeReference(value: unknown) {
    if (!isRecord(value)) throw new Error("Richiesta trascrizione non valida");
    if (this.ttsProcesses.size > 0) throw new Error("Attendi la fine della sintesi TTS prima di trascrivere una reference");
    const file = text(value.file, "Reference vocale", 1, 2_000);
    const settings = await this.runtimeSettings.get();
    const root = settings.tts.root;
    const python = path.join(root, "python", "python.exe");
    const script = path.resolve("bridge", "transcribe-reference.py");
    if (!existsSync(python) || !existsSync(script)) throw new Error("Runtime di trascrizione non disponibile");
    const token = `asr-${randomUUID().slice(0, 8)}`;
    let referencePath: string | null = null;
    try {
      await this.comfy.chatUnload().catch(() => undefined);
      await this.comfy.freeMemory(true).catch(() => undefined);
      referencePath = await this.materializeReference(token, file);
      const cacheDir = path.join(root, "models", "whisper");
      await mkdir(cacheDir, { recursive: true });
      const child = spawn(python, [script, "--audio", referencePath, "--cache-dir", cacheDir], {
        cwd: path.dirname(script), windowsHide: true,
        env: { ...process.env, HF_HOME: cacheDir, HUGGINGFACE_HUB_CACHE: cacheDir, TRANSFORMERS_CACHE: cacheDir, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(() => reject(new Error("Timeout durante la trascrizione della reference")));
        }, 12 * 60_000);
        child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-50_000); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-20_000); });
        child.once("error", (error) => finish(() => reject(error)));
        child.once("exit", (code) => finish(() => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Whisper si e chiuso con codice ${code}: ${stderr.slice(-1_000)}`))));
      });
      const marker = result.stdout.match(/H3_TRANSCRIPT_JSON=(\{[^\r\n]+\})/g)?.at(-1);
      if (!marker) throw new Error(`Whisper non ha restituito una trascrizione${result.stderr ? `: ${result.stderr.slice(-500)}` : ""}`);
      const parsed = JSON.parse(marker.slice("H3_TRANSCRIPT_JSON=".length)) as { text?: unknown; model?: unknown };
      const transcript = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!transcript) throw new Error("Il campione non contiene parlato riconoscibile");
      return { text: transcript, model: typeof parsed.model === "string" ? parsed.model : "openai/whisper-small", unloadPolicy: "process-exit" };
    } finally {
      if (referencePath) await unlink(referencePath).catch(() => undefined);
      await this.comfy.freeMemory(true).catch(() => undefined);
    }
  }


  async submit(value: unknown) {
    if (!isRecord(value)) throw new Error("Richiesta audio non valida");
    const requestedKind = value.kind === "tts" || value.kind === "music" || value.kind === "speech_music" || value.kind === "voice_cover"
      ? value.kind
      : null;
    if (!requestedKind) throw new Error("Scegli TTS, Musica, Parlato → brano oppure Canzone col mio timbro");
    const kind = requestedKind === "speech_music" || requestedKind === "voice_cover" ? "music" : requestedKind;
    const projectId = text(value.projectId, "Progetto", 1, 100);
    const settings = await this.runtimeSettings.get();
    if (kind === "tts") {
      const prompt = text(normalizeHiggsTtsText(value.text), "Testo TTS", 1, 20_000);
      const referenceFile = typeof value.referenceFile === "string" && value.referenceFile.trim()
        ? value.referenceFile.trim()
        : null;
      const referenceText = typeof value.referenceText === "string" ? value.referenceText.trim().slice(0, 20_000) : "";
      const voice = typeof value.voice === "string" && value.voice.trim() ? value.voice.trim() : settings.tts.voice;
      const ttsSeed = seed(value.seed);
      const job = this.repository.create({
        projectId, kind, prompt, voice, referenceFile, referenceText, seed: ttsSeed,
        settings: {
          engine: "higgs-audio-v3-tts-4b", temperature: settings.tts.temperature,
          topP: settings.tts.topP, topK: settings.tts.topK, speed: settings.tts.speed,
          maxNewTokens: settings.tts.maxNewTokens, unloadAfterJob: true,
        },
      });
      void this.runTts(job.id).catch(() => undefined);
      return this.repository.get(job.id)!;
    }

    const speechMode = requestedKind === "speech_music";
    const voiceCoverMode = requestedKind === "voice_cover";
    const caption = text(value.caption, "Descrizione musica", 3, 10_000);
    const lyrics = speechMode
      ? ""
      : typeof value.lyrics === "string" ? value.lyrics.trim().slice(0, 30_000) : "";
    const referenceFile = speechMode || voiceCoverMode
      ? text(value.referenceFile, "Parlato sorgente", 1, 2_000)
      : null;
    const referenceText = (speechMode || voiceCoverMode) && typeof value.referenceText === "string"
      ? value.referenceText.trim().slice(0, 20_000)
      : "";
    const voiceGain = speechMode ? boundedNumber(value.voiceGain ?? 1, "Volume voce", 0, 2) : 1;
    const musicGain = speechMode ? boundedNumber(value.musicGain ?? 0.55, "Volume musica", 0, 2) : 1;
    const ducking = speechMode ? boundedNumber(value.ducking ?? 0.7, "Ducking", 0, 1) : 0;
    let durationSeconds = boundedNumber(value.durationSeconds ?? 30, "Durata", 5, 360);
    if (speechMode) {
      const token = `speech-probe-${randomUUID().slice(0, 8)}`;
      let materialized: string | null = null;
      try {
        materialized = await this.materializeReference(token, referenceFile!);
        durationSeconds = await probeAudioDuration(materialized, this.ffmpegPath);
        if (durationSeconds > 360) throw new Error("Il parlato supera la durata massima di 6 minuti");
      } finally {
        if (materialized) await unlink(materialized).catch(() => undefined);
      }
    }
    const musicSeed = seed(value.seed);
    const idHint = randomUUID().slice(0, 8);
    const apiPrompt = buildMusicPrompt({
      caption, lyrics, durationSeconds: Math.max(5, durationSeconds), seed: musicSeed, ...settings.music,
      filenamePrefix: `H3_STUDIO_AUDIO/${speechMode ? "speech_base" : voiceCoverMode ? "voice_cover_base" : "music"}_${projectId}_${idHint}`,
    });
    const job = this.repository.create({
      projectId, kind, prompt: caption, lyrics, durationSeconds, seed: musicSeed,
      referenceFile, referenceText,
      settings: {
        ...settings.music,
        engine: "minimax-music-3",
        mode: speechMode ? "speech_music" : voiceCoverMode ? "voice_cover" : "music",
        voiceGain,
        musicGain,
        ducking,
        apiPrompt,
      },
    });
    try {
      await this.comfy.chatUnload().catch(() => undefined);
      const queued = await this.comfy.queuePrompt(apiPrompt, `h3-studio-audio-${job.id}`);
      this.repository.update(job.id, {
        status: "queued",
        phaseLabel: speechMode ? "Base strumentale in coda su ComfyUI" : voiceCoverMode ? "Canzone sorgente in coda su ComfyUI" : "In coda su ComfyUI",
        progress: null,
        promptId: queued.promptId, queueNumber: queued.queueNumber, error: null,
      });
      this.progressTracker.register(queued.promptId, apiPrompt, "audio");
    } catch (error) {
      this.repository.update(job.id, {
        status: "failed", phaseLabel: speechMode ? "Invio base strumentale fallito" : voiceCoverMode ? "Invio canzone sorgente fallito" : "Invio musica fallito", progress: null,
        error: error instanceof Error ? error.message : "Invio MiniMax Music fallito",
      });
    }
    return this.repository.get(job.id)!;
  }

  async regenerate(id: string, promptValue: unknown, lyricsValue?: unknown) {
    const source = this.repository.get(id);
    if (!source) throw new Error("Job audio da rigenerare non trovato");
    const prompt = text(promptValue, source.kind === "tts" ? "Testo TTS" : "Descrizione musica", 1, source.kind === "tts" ? 20_000 : 10_000);
    const regeneratedLyrics = typeof lyricsValue === "string"
      ? lyricsValue.trim().slice(0, 30_000)
      : source.lyrics;
    if (source.kind === "tts") {
      return this.submit({
        kind: "tts", projectId: source.projectId, text: prompt, voice: source.voice,
        referenceFile: source.referenceFile, referenceText: source.referenceText,
      });
    }
    if (source.settings.mode === "speech_music") {
      return this.submit({
        kind: "speech_music",
        projectId: source.projectId,
        caption: prompt,
        referenceFile: source.referenceFile,
        referenceText: source.referenceText,
        durationSeconds: source.durationSeconds ?? 30,
        voiceGain: source.settings.voiceGain,
        musicGain: source.settings.musicGain,
        ducking: source.settings.ducking,
      });
    }
    if (source.settings.mode === "voice_cover") {
      return this.submit({
        kind: "voice_cover",
        projectId: source.projectId,
        caption: prompt,
        lyrics: regeneratedLyrics,
        referenceFile: source.referenceFile,
        referenceText: source.referenceText,
        durationSeconds: source.durationSeconds ?? 30,
      });
    }
    return this.submit({
      kind: "music", projectId: source.projectId, caption: prompt,
      lyrics: regeneratedLyrics, durationSeconds: source.durationSeconds ?? 30,
    });
  }

  private async materializeReference(jobId: string, file: string) {
    const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(file.replace(/\\/g, "/"));
    const relative = match?.[1] ?? file;
    const type = (match?.[2] ?? "input") as "input" | "output" | "temp";
    const slash = relative.lastIndexOf("/");
    const filename = slash >= 0 ? relative.slice(slash + 1) : relative;
    const subfolder = slash >= 0 ? relative.slice(0, slash) : "";
    const response = await this.comfy.mediaResponse(filename, subfolder, type);
    if (!response.ok) throw new Error("Reference vocale non leggibile da ComfyUI");
    const extension = path.extname(filename) || ".wav";
    const folder = path.join(this.dataDir, "audio-temp");
    await mkdir(folder, { recursive: true });
    const target = path.join(folder, `${jobId}-voice${extension}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    await ensureStereoAudioFile(target, this.ffmpegPath);
    return target;
  }

  private async finalizeSpeechMusic(
    job: NonNullable<ReturnType<AudioJobRepository["get"]>>,
    baseOutput: Omit<AudioOutput, "file" | "mediaPath">,
  ) {
    if (!job.referenceFile) throw new Error("Parlato sorgente non disponibile");
    const basePath = path.join(this.comfyOutputDir, baseOutput.subfolder, baseOutput.filename);
    if (!existsSync(basePath)) throw new Error("Base strumentale generata ma non trovata su disco");
    const subfolder = "H3_STUDIO_AUDIO";
    const filename = `speech_music_${job.projectId}_${job.id.slice(0, 8)}.wav`;
    const folder = path.join(this.comfyOutputDir, subfolder);
    const target = path.join(folder, filename);
    let voicePath: string | null = null;
    try {
      this.repository.update(job.id, {
        status: "finalizing",
        phaseLabel: "Mix voce, base e ducking",
        progress: 98,
        error: null,
      });
      await mkdir(folder, { recursive: true });
      voicePath = await this.materializeReference(job.id, job.referenceFile);
      const durationSeconds = job.durationSeconds ??
        await probeAudioDuration(voicePath, this.ffmpegPath);
      const voiceGain = boundedNumber(job.settings.voiceGain ?? 1, "Volume voce", 0, 2);
      const musicGain = boundedNumber(job.settings.musicGain ?? 0.55, "Volume musica", 0, 2);
      const ducking = boundedNumber(job.settings.ducking ?? 0.7, "Ducking", 0, 1);
      await execFileAsync(this.ffmpegPath, [
        "-y", "-v", "error",
        "-i", voicePath,
        "-i", basePath,
        "-filter_complex", speechTrackMixFilter({ durationSeconds, voiceGain, musicGain, ducking }),
        "-map", "[out]",
        "-ar", "48000",
        "-ac", "2",
        "-c:a", "pcm_s16le",
        target,
      ], {
        encoding: "utf8",
        timeout: 12 * 60_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      await ensureStereoAudioFile(target, this.ffmpegPath);
      if (this.repository.get(job.id)?.status === "cancelled") {
        await unlink(target).catch(() => undefined);
        return;
      }
      const size = await stat(target).then((value) => value.size);
      const output: Omit<AudioOutput, "file" | "mediaPath"> = {
        filename,
        subfolder,
        type: "output",
        format: "audio/wav",
      };
      const external = this.externalMedia.upsert({
        kind: "audio",
        file: `${subfolder}/${filename} [output]`,
        name: filename,
        original: filename,
        size,
        duration: durationSeconds,
        has_audio: true,
      }, job.projectId);
      this.repository.update(job.id, {
        status: "ready",
        phaseLabel: "Parlato e musica stereo pronti",
        progress: 100,
        output,
        externalMediaId: external.id,
        error: null,
      });
      await unlink(basePath).catch(() => undefined);
    } finally {
      if (voicePath) await unlink(voicePath).catch(() => undefined);
    }
  }

  private async runAudioCpp(
    jobId: string,
    args: string[],
    phaseLabel: string,
    progressStart: number,
    progressEnd: number,
  ) {
    const settings = await this.runtimeSettings.get();
    const cli = path.join(settings.voiceConversion.root, "audiocpp_cli.exe");
    if (!existsSync(cli)) throw new Error(`Runtime audio.cpp non trovato in ${settings.voiceConversion.root}`);
    if (this.cancelledJobs.has(jobId)) throw new Error("Conversione timbrica interrotta");
    this.repository.update(jobId, {
      status: "finalizing",
      phaseLabel,
      progress: progressStart,
      error: null,
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cli, args, {
        cwd: settings.voiceConversion.root,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.audioCppProcesses.set(jobId, child);
      let stderr = "";
      const parseProgress = (chunk: Buffer) => {
        const value = chunk.toString("utf8");
        const matches = [...value.matchAll(/(?:progress|step)\D{0,12}(\d+)\s*(?:\/\s*(\d+)|%)/gi)];
        const last = matches.at(-1);
        if (!last) return;
        const raw = last[2] ? Number(last[1]) / Math.max(1, Number(last[2])) : Number(last[1]) / 100;
        const progress = Math.round(progressStart + Math.max(0, Math.min(1, raw)) * (progressEnd - progressStart));
        this.repository.update(jobId, { phaseLabel, progress });
      };
      child.stdout.on("data", parseProgress);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-12_000);
        parseProgress(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        this.audioCppProcesses.delete(jobId);
        if (this.cancelledJobs.has(jobId)) reject(new Error("Conversione timbrica interrotta"));
        else if (code === 0) {
          this.repository.update(jobId, { phaseLabel, progress: progressEnd });
          resolve();
        } else reject(new Error(`audio.cpp si è chiuso con codice ${code}${stderr ? `: ${stderr.slice(-1_000)}` : ""}`));
      });
    });
  }

  private async stopAudioCppProcess(jobId: string) {
    const child = this.audioCppProcesses.get(jobId);
    if (!child) return;
    const pid = child.pid;
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (pid && child.exitCode === null && process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    } else if (child.exitCode === null) child.kill("SIGKILL");
    this.audioCppProcesses.delete(jobId);
  }

  private async finalizeVoiceCover(
    job: NonNullable<ReturnType<AudioJobRepository["get"]>>,
    baseOutput: Omit<AudioOutput, "file" | "mediaPath">,
  ) {
    if (!job.referenceFile) throw new Error("Reference timbrica non disponibile");
    const settings = await this.runtimeSettings.get();
    const conversion = settings.voiceConversion;
    const separatorModel = path.resolve(conversion.root, conversion.separatorModel);
    const seedVcModel = path.resolve(conversion.root, conversion.seedVcModel);
    if (!existsSync(separatorModel) || !existsSync(seedVcModel)) {
      throw new Error("Installa BS-RoFormer e Seed-VC dal setup audio.cpp indicato in Admin");
    }
    const basePath = path.join(this.comfyOutputDir, baseOutput.subfolder, baseOutput.filename);
    if (!existsSync(basePath)) throw new Error("Canzone MiniMax generata ma non trovata su disco");
    const temporary = path.join(this.dataDir, "audio-temp", `voice-cover-${job.id}`);
    const stems = path.join(temporary, "stems");
    const normalizedSong = path.join(temporary, "song-44100.wav");
    const referenceWav = path.join(temporary, "voice-reference.wav");
    const convertedVocal = path.join(temporary, "converted-vocal.wav");
    let materializedReference: string | null = null;
    try {
      await rm(temporary, { recursive: true, force: true });
      await mkdir(stems, { recursive: true });
      await this.comfy.freeMemory(true).catch(() => undefined);
      this.repository.update(job.id, { status: "finalizing", phaseLabel: "Preparazione stem e reference", progress: 72, error: null });
      materializedReference = await this.materializeReference(job.id, job.referenceFile);
      await Promise.all([
        execFileAsync(this.ffmpegPath, ["-y", "-v", "error", "-i", basePath, "-vn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", normalizedSong], { windowsHide: true, timeout: 10 * 60_000 }),
        execFileAsync(this.ffmpegPath, ["-y", "-v", "error", "-i", materializedReference, "-vn", "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", referenceWav], { windowsHide: true, timeout: 5 * 60_000 }),
      ]);
      await this.runAudioCpp(job.id, [
        "--task", "sep", "--family", "bs_roformer", "--model", separatorModel,
        "--backend", conversion.backend, "--audio", normalizedSong, "--out-dir", stems,
        "--session-option", "bs_roformer.num_overlap=2", "--log",
      ], "Separazione voce e base", 75, 84);
      const stemFiles = await readdir(stems);
      const vocals = stemFiles.find((file) => /vocals?\.wav$/i.test(file));
      const instrumental = stemFiles.find((file) => /instrumental\.wav$/i.test(file));
      if (!vocals || !instrumental) throw new Error(`Separazione incompleta: ${stemFiles.join(", ") || "nessuno stem"}`);
      const svcArgs = [
        "--task", "svc", "--family", "seed_vc", "--model", seedVcModel,
        "--backend", conversion.backend, "--task-route", "v1_svc",
        "--audio", path.join(stems, vocals), "--voice-ref", referenceWav,
        "--out", convertedVocal, "--num-inference-steps", String(conversion.steps),
        "--request-option", `f0_condition=${conversion.f0Condition}`,
        "--request-option", `auto_f0_adjust=${conversion.autoF0Adjust}`,
        "--seed", String(job.seed), "--log",
      ];
      await this.runAudioCpp(job.id, svcArgs, "Trasferimento del timbro con Seed-VC", 85, 95);
      const subfolder = "H3_STUDIO_AUDIO";
      const filename = `voice_cover_${job.projectId}_${job.id.slice(0, 8)}.wav`;
      const folder = path.join(this.comfyOutputDir, subfolder);
      const target = path.join(folder, filename);
      await mkdir(folder, { recursive: true });
      this.repository.update(job.id, { status: "finalizing", phaseLabel: "Remix stereo finale", progress: 97, error: null });
      await execFileAsync(this.ffmpegPath, [
        "-y", "-v", "error", "-i", path.join(stems, instrumental), "-i", convertedVocal,
        "-filter_complex",
        "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.98[inst];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[voc];[inst][voc]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[out]",
        "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", target,
      ], { encoding: "utf8", timeout: 15 * 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      await ensureStereoAudioFile(target, this.ffmpegPath);
      if (this.repository.get(job.id)?.status === "cancelled") {
        await unlink(target).catch(() => undefined);
        return;
      }
      const [size, durationSeconds] = await Promise.all([
        stat(target).then((value) => value.size),
        probeAudioDuration(target, this.ffmpegPath),
      ]);
      const output: Omit<AudioOutput, "file" | "mediaPath"> = { filename, subfolder, type: "output", format: "audio/wav" };
      const external = this.externalMedia.upsert({
        kind: "audio", file: `${subfolder}/${filename} [output]`, name: filename,
        original: filename, size, duration: durationSeconds, has_audio: true,
      }, job.projectId);
      this.repository.update(job.id, {
        status: "ready", phaseLabel: "Canzone col timbro scelto pronta · modelli scaricati",
        progress: 100, output, externalMediaId: external.id, error: null,
      });
      await unlink(basePath).catch(() => undefined);
    } finally {
      await this.stopAudioCppProcess(job.id);
      if (materializedReference) await unlink(materializedReference).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      await this.comfy.freeMemory(true).catch(() => undefined);
    }
  }

  private async waitForHiggs(jobId: string, port: number, child: ChildProcessWithoutNullStreams) {
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      if (this.cancelledJobs.has(jobId)) throw new Error("Sintesi interrotta");
      if (child.exitCode !== null) throw new Error(`Higgs si è chiuso con codice ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const payload = await response.json() as { status?: string };
        if (response.ok && payload.status === "ok") return;
      } catch {
        // Model startup can take several minutes; continue polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("Timeout durante il caricamento di Higgs Audio");
  }

  private async stopTtsProcess(jobId: string) {
    const existing = this.ttsStopOperations.get(jobId);
    if (existing) return existing;
    const operation = (async () => {
      const active = this.ttsProcesses.get(jobId);
      if (!active) return;
      active.controller.abort();
      const pid = active.child.pid;
      if (active.child.exitCode === null) active.child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => active.child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (pid && active.child.exitCode === null && process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("exit", () => resolve());
          killer.once("error", () => resolve());
        });
      } else if (active.child.exitCode === null) {
        active.child.kill("SIGKILL");
      }
      this.ttsProcesses.delete(jobId);
    })();
    this.ttsStopOperations.set(jobId, operation);
    try {
      await operation;
    } finally {
      this.ttsStopOperations.delete(jobId);
    }
  }

  private async runTts(jobId: string) {
    const job = this.repository.get(jobId);
    if (!job || job.kind !== "tts") return;
    const settings = await this.runtimeSettings.get();
    const root = settings.tts.root;
    const python = path.join(root, "python", "python.exe");
    const script = path.join(root, "server.py");
    if (!existsSync(python) || !existsSync(script)) {
      this.repository.update(jobId, { status: "failed", phaseLabel: "Higgs non disponibile", error: `Runtime Higgs non trovato in ${root}` });
      return;
    }
    let referencePath: string | null = null;
    let effectiveReferenceText = job.referenceText;
    const controller = new AbortController();
    try {
      this.repository.update(jobId, { status: "loading", phaseLabel: "Scaricamento modelli ComfyUI", progress: 2, error: null });
      if (job.referenceFile && !effectiveReferenceText) {
        this.repository.update(jobId, { status: "loading", phaseLabel: "Trascrizione reference con Whisper", progress: 3, error: null });
        const transcription = await this.transcribeReference({ file: job.referenceFile });
        effectiveReferenceText = transcription.text;
      }
      await this.comfy.chatUnload().catch(() => undefined);
      await this.comfy.freeMemory(true).catch(() => undefined);
      if (this.cancelledJobs.has(jobId)) throw new Error("Sintesi interrotta");
      if (job.referenceFile) referencePath = await this.materializeReference(jobId, job.referenceFile);
      const port = await freePort();
      const cacheDir = path.join(root, "models");
      const child = spawn(python, [script, "--host", "127.0.0.1", "--port", String(port)], {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          TEMP: path.join(root, "temp"), TMP: path.join(root, "temp"),
          HF_HOME: cacheDir, HUGGINGFACE_HUB_CACHE: cacheDir, TRANSFORMERS_CACHE: cacheDir,
          TORCH_HOME: path.join(cacheDir, "torch"), XDG_CACHE_HOME: path.join(root, "cache"),
          PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", GGML_CUDA_NO_PINNED: "1",
          HIGGS_TTS_PRECISION: "8bit", HF_HUB_OFFLINE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.ttsProcesses.set(jobId, { child, controller });
      if (this.cancelledJobs.has(jobId)) {
        controller.abort();
        throw new Error("Sintesi interrotta");
      }
      let stderr = "";
      const parseOutput = (chunk: Buffer) => {
        const line = chunk.toString("utf8");
        if (/Modello pronto/i.test(line)) this.repository.update(jobId, { phaseLabel: "Higgs pronto", progress: 35 });
        const match = /chunk\s+(\d+)\/(\d+)/i.exec(line);
        if (match) {
          const current = Number(match[1]);
          const total = Number(match[2]);
          this.repository.update(jobId, { status: "running", phaseLabel: `Sintesi voce ${current}/${total}`, progress: 40 + Math.round((current / total) * 50) });
        }
      };
      child.stdout.on("data", parseOutput);
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8_000); parseOutput(chunk); });
      this.repository.update(jobId, { status: "loading", phaseLabel: "Caricamento Higgs Audio 8-bit", progress: 8 });
      await this.waitForHiggs(jobId, port, child);
      this.repository.update(jobId, { status: "running", phaseLabel: "Sintesi della voce", progress: 40 });
      const response = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "higgs-audio-v3-tts-4b", input: job.prompt, voice: job.voice,
          response_format: "wav", seed: job.seed,
          temperature: settings.tts.temperature, top_p: settings.tts.topP,
          top_k: settings.tts.topK, speed: settings.tts.speed,
          max_new_tokens: settings.tts.maxNewTokens,
          ...(referencePath ? { references: [{ audio_path: referencePath, text: effectiveReferenceText || undefined }] } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Higgs Audio HTTP ${response.status}: ${await response.text()}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength < 128) throw new Error(`Higgs non ha prodotto audio${stderr ? `: ${stderr.slice(-500)}` : ""}`);
      this.repository.update(jobId, { status: "finalizing", phaseLabel: "Salvataggio e catalogazione", progress: 95 });
      const subfolder = "H3_STUDIO_AUDIO";
      const filename = `tts_${job.projectId}_${job.id.slice(0, 8)}.wav`;
      const folder = path.join(this.comfyOutputDir, subfolder);
      await mkdir(folder, { recursive: true });
      const target = path.join(folder, filename);
      await writeFile(target, bytes);
      await ensureStereoAudioFile(target, this.ffmpegPath);
      const outputSize = await stat(target).then((value) => value.size);
      const output: Omit<AudioOutput, "file" | "mediaPath"> = { filename, subfolder, type: "output", format: "audio/wav" };
      const external = this.externalMedia.upsert({
        kind: "audio", file: `${subfolder}/${filename} [output]`, name: filename,
        original: filename, size: outputSize, has_audio: true,
      }, job.projectId);
      this.repository.update(jobId, {
        status: "ready", phaseLabel: "Voce stereo pronta · modello scaricato", progress: 100,
        output, externalMediaId: external.id, error: null,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || this.repository.get(jobId)?.status === "cancelled";
      this.repository.update(jobId, {
        status: cancelled ? "cancelled" : "failed",
        phaseLabel: cancelled ? "Sintesi interrotta" : "Sintesi fallita",
        progress: null,
        error: cancelled ? null : error instanceof Error ? error.message : "Sintesi Higgs fallita",
      });
    } finally {
      await this.stopTtsProcess(jobId);
      this.cancelledJobs.delete(jobId);
      if (referencePath) await unlink(referencePath).catch(() => undefined);
    }
  }

  async sync() {
    const pendingMusic = this.repository.pending().filter((job) => job.kind === "music" && job.promptId);
    if (!pendingMusic.length) return 0;
    const [history, queue] = await Promise.all([this.comfy.history(200), this.comfy.queueState()]);
    for (const job of pendingMusic) {
      const entry = history[job.promptId!];
      const output = entry ? findAudioOutput(entry) : null;
      if (output) {
        if (job.settings.mode === "speech_music") {
          if (this.speechMixes.has(job.id)) continue;
          this.speechMixes.add(job.id);
          try {
            await this.finalizeSpeechMusic(job, output);
          } catch (error) {
            this.repository.update(job.id, {
              status: "failed",
              phaseLabel: "Mix Parlato → brano fallito",
              progress: null,
              error: error instanceof Error ? error.message : "Mix voce e musica non riuscito",
            });
          } finally {
            this.speechMixes.delete(job.id);
          }
          continue;
        }
        if (job.settings.mode === "voice_cover") {
          if (this.voiceConversions.has(job.id)) continue;
          this.voiceConversions.add(job.id);
          try {
            await this.finalizeVoiceCover(job, output);
          } catch (error) {
            const cancelled = this.repository.get(job.id)?.status === "cancelled" || this.cancelledJobs.has(job.id);
            this.repository.update(job.id, {
              status: cancelled ? "cancelled" : "failed",
              phaseLabel: cancelled ? "Conversione timbrica interrotta" : "Conversione timbrica fallita",
              progress: null,
              error: cancelled ? null : error instanceof Error ? error.message : "Trasferimento del timbro non riuscito",
            });
          } finally {
            this.voiceConversions.delete(job.id);
            this.cancelledJobs.delete(job.id);
          }
          continue;
        }
        const absolute = path.join(this.comfyOutputDir, output.subfolder, output.filename);
        try {
          this.repository.update(job.id, { status: "finalizing", phaseLabel: "Verifica stereo", progress: 98, error: null });
          await ensureStereoAudioFile(absolute, this.ffmpegPath);
          const size = await stat(absolute).then((value) => value.size).catch(() => null);
          const external = this.externalMedia.upsert({
            kind: "audio", file: `${output.subfolder ? `${output.subfolder}/` : ""}${output.filename} [${output.type}]`,
            name: output.filename, original: output.filename, size, duration: job.durationSeconds, has_audio: true,
          }, job.projectId);
          this.repository.update(job.id, { status: "ready", phaseLabel: "Musica stereo pronta", progress: 100, output, externalMediaId: external.id, error: null });
        } catch (error) {
          this.repository.update(job.id, {
            status: "failed", phaseLabel: "Normalizzazione stereo fallita", progress: null,
            error: error instanceof Error ? error.message : "Audio stereo non prodotto",
          });
        }
        continue;
      }
      const tracked = this.progressTracker.get(job.promptId!);
      if (queue.runningPromptIds.has(job.promptId!)) {
        this.repository.update(job.id, { status: "running", phaseLabel: tracked?.phaseLabel ?? "Generazione musica", progress: tracked?.progress ?? null });
      } else if (queue.pendingPromptIds.has(job.promptId!)) {
        this.repository.update(job.id, { status: "queued", phaseLabel: "In coda su ComfyUI", progress: null });
      } else if (isRecord(entry?.status) && entry?.status?.status_str === "error") {
        this.repository.update(job.id, { status: "failed", phaseLabel: "Generazione musica fallita", progress: null, error: "ComfyUI ha interrotto MiniMax Music" });
      } else if (isRecord(entry?.status) && ["success", "completed"].includes(String(entry?.status?.status_str))) {
        this.repository.update(job.id, { status: "failed", phaseLabel: "Output musica mancante", progress: null, error: "ComfyUI ha completato il job senza produrre un file audio" });
      }
    }
    return pendingMusic.length;
  }

  async recover() {
    const interruptedTts = this.repository.markInterrupted();
    await this.sync().catch(() => undefined);
    return interruptedTts;
  }

  async get(id: string) {
    await this.sync().catch(() => undefined);
    return this.repository.get(id);
  }

  async list(limit = 50, projectId?: string | null) {
    await this.sync().catch(() => undefined);
    return this.repository.list(limit, projectId);
  }

  async cancel(id: string) {
    const job = this.repository.get(id);
    if (!job) return null;
    if (!activeStates.has(job.status)) return job;
    this.repository.update(id, { status: "cancelled", phaseLabel: "Interruzione in corso", progress: null, error: null });
    if (job.kind === "tts") {
      this.cancelledJobs.add(id);
      await this.stopTtsProcess(id);
    }
    else if (job.settings.mode === "voice_cover") {
      this.cancelledJobs.add(id);
      await this.stopAudioCppProcess(id);
      if (job.promptId) await this.comfy.cancelPrompts([job.promptId]);
    }
    else if (job.promptId) await this.comfy.cancelPrompts([job.promptId]);
    return this.repository.update(id, { status: "cancelled", phaseLabel: "Interrotto", progress: null, error: null });
  }

  async delete(id: string) {
    const job = this.repository.get(id);
    if (!job) throw new Error("Job audio non trovato");
    if (activeStates.has(job.status)) await this.cancel(id);
    const deleted = this.repository.delete(id);
    return { deleted, externalMediaId: deleted.externalMediaId };
  }
}

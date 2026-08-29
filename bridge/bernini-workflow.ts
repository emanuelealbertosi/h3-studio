import path from "node:path";
import type { ComfyApiPrompt } from "./comfy-client.js";
import type { StudioJobRequest } from "./studio-job.js";

export const BERNINI_PREVIEW_MODEL =
  "wan2.1_bernini_1.3B_fp16.safetensors";
export const BERNINI_TEXT_ENCODER =
  "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
export const BERNINI_VAE = "wan_2.1_vae.safetensors";
export const BERNINI_PREVIEW_STEPS = 20;

const NEGATIVE_PROMPT =
  "oversaturated, overexposed, static, scene cut, camera cut, blurry details, subtitles, illustration, painting, grey cast, worst quality, low quality, JPEG artifacts, ugly, malformed anatomy, extra fingers, deformed hands, deformed face, disfigured limbs, fused fingers, frozen frame, cluttered background, duplicated people, walking backwards, flicker, temporal inconsistency";

type MediaItem = {
  kind?: unknown;
  file?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
};

function cleanComfyFile(value: string) {
  return value.replace(/ \[(?:input|output|temp)\]$/i, "");
}

function comfyFileType(value: string) {
  return value.match(/ \[(input|output|temp)\]$/i)?.[1]?.toLowerCase() ?? "input";
}

function outputVideoPath(value: string, comfyOutputDir?: string) {
  if (!comfyOutputDir) {
    throw new Error("Configura la cartella output ComfyUI per modificare un video della Libreria con Bernini");
  }
  const root = path.resolve(comfyOutputDir);
  const absolute = path.resolve(root, cleanComfyFile(value));
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Percorso video Bernini non valido");
  }
  return absolute;
}

function sourceItems(request: StudioJobRequest) {
  return JSON.parse(request.mediaState || "[]") as MediaItem[];
}

function sourceDuration(request: StudioJobRequest, video: MediaItem) {
  const duration = Number(video.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  return request.durationSeconds;
}

function berniniDimensions(video: MediaItem) {
  const width = Number(video.width);
  const height = Number(video.height);
  const ratio = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 16 / 9;
  const targetArea = 832 * 480;
  let targetWidth = Math.sqrt(targetArea * ratio);
  let targetHeight = targetWidth / ratio;
  const maxEdge = 832;
  if (Math.max(targetWidth, targetHeight) > maxEdge) {
    const scale = maxEdge / Math.max(targetWidth, targetHeight);
    targetWidth *= scale;
    targetHeight *= scale;
  }
  return {
    width: Math.max(16, Math.round(targetWidth / 16) * 16),
    height: Math.max(16, Math.round(targetHeight / 16) * 16),
  };
}

function berniniLength(durationSeconds: number) {
  const rawFrames = Math.max(1, Math.floor(durationSeconds * 24));
  return Math.max(1, Math.floor((rawFrames - 1) / 4) * 4 + 1);
}

export function buildBerniniPrompt(
  request: StudioJobRequest,
  seed: number,
  filenamePrefix: string,
  comfyOutputDir?: string,
): ComfyApiPrompt {
  if (request.generationMode !== "VIDEO EDITING") {
    throw new Error("Bernini fedele è disponibile soltanto in Edit video");
  }
  const items = sourceItems(request);
  const source = items.find(
    (item) => item.kind === "video" && typeof item.file === "string",
  );
  if (!source || typeof source.file !== "string") {
    throw new Error("Bernini richiede un video sorgente");
  }
  const duration = sourceDuration(request, source);
  if (duration > 15.5) {
    throw new Error(
      "Bernini Preview 1.3B accetta clip fino a 15 secondi per singolo edit",
    );
  }
  const dimensions = berniniDimensions(source);
  const length = berniniLength(duration);
  const sourceType = comfyFileType(source.file);
  if (sourceType === "temp") {
    throw new Error("Salva prima il video temporaneo nella Libreria o ricaricalo da disco per usarlo con Bernini");
  }
  const prompt: ComfyApiPrompt = {
    "1": {
      class_type: sourceType === "output" ? "VHS_LoadVideoPath" : "VHS_LoadVideo",
      inputs: {
        video: sourceType === "output"
          ? outputVideoPath(source.file, comfyOutputDir)
          : cleanComfyFile(source.file),
        force_rate: 24,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: length,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: BERNINI_TEXT_ENCODER,
        type: "wan",
        device: "default",
      },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: `You are a helpful assistant specialized in video editing on content propagation.\n\n${request.prompt}\n\nPreserve the source video's identity, composition, timing, camera path, body motion and temporal continuity unless the requested edit explicitly changes one of them. Apply only the requested transformation.`,
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["2", 0], text: NEGATIVE_PROMPT },
    },
    "5": {
      class_type: "VAELoader",
      inputs: { vae_name: BERNINI_VAE },
    },
    "6": {
      class_type: "UNETLoader",
      inputs: { unet_name: BERNINI_PREVIEW_MODEL, weight_dtype: "default" },
    },
    "7": {
      class_type: "BerniniConditioning",
      inputs: {
        positive: ["3", 0],
        negative: ["4", 0],
        vae: ["5", 0],
        source_video: ["1", 0],
        width: dimensions.width,
        height: dimensions.height,
        length,
        batch_size: 1,
        ref_max_size: 832,
      },
    },
    "8": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "euler" },
    },
    "9": {
      class_type: "BasicScheduler",
      inputs: {
        model: ["6", 0],
        scheduler: "simple",
        steps: BERNINI_PREVIEW_STEPS,
        denoise: 1,
      },
    },
    "10": {
      class_type: "SamplerCustom",
      inputs: {
        model: ["6", 0],
        add_noise: true,
        noise_seed: seed,
        cfg: 5,
        positive: ["7", 0],
        negative: ["7", 1],
        sampler: ["8", 0],
        sigmas: ["9", 0],
        latent_image: ["7", 2],
      },
    },
    "11": {
      class_type: "VAEDecode",
      inputs: { samples: ["10", 0], vae: ["5", 0] },
    },
    "12": {
      class_type: "VHS_VideoCombine",
      inputs: {
        images: ["11", 0],
        audio: ["1", 2],
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: filenamePrefix,
        format: "video/h264-mp4",
        pix_fmt: "yuv420p",
        crf: 19,
        save_metadata: true,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
      },
    },
  };

  let nextNode = 13;
  const references = items.filter(
    (item) => item.kind === "picture" && typeof item.file === "string",
  ).slice(0, 8);
  references.forEach((reference, index) => {
    const nodeId = String(nextNode++);
    const referenceFile = reference.file as string;
    const referenceType = comfyFileType(referenceFile);
    if (referenceType === "temp") {
      throw new Error("Salva prima le immagini temporanee nella Libreria o ricaricale da disco per usarle con Bernini");
    }
    prompt[nodeId] = {
      class_type: referenceType === "output" ? "LoadImageOutput" : "LoadImage",
      inputs: { image: cleanComfyFile(referenceFile) },
    };
    prompt["7"].inputs[`reference_images.reference_image_${index}`] = [nodeId, 0];
  });
  return prompt;
}

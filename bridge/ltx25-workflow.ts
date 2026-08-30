import type { ComfyApiPrompt } from "./comfy-client.js";
import type { Ltx25EngineSettings } from "./runtime-settings.js";
import type { StudioJobRequest } from "./studio-job.js";

const FPS = 24;
const DISTILLED_SIGMAS =
  "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";

const RATIOS: Record<string, number> = {
  "16:9 landscape": 16 / 9,
  "9:16 portrait": 9 / 16,
  "1:1 square": 1,
  "4:3 landscape": 4 / 3,
  "3:4 portrait": 3 / 4,
  "3:2 landscape": 3 / 2,
  "2:3 portrait": 2 / 3,
  "21:9 ultrawide": 21 / 9,
  "9:21 vertical ultrawide": 9 / 21,
  "5:4 landscape": 5 / 4,
  "4:5 portrait": 4 / 5,
};

function align32(value: number) {
  return Math.max(64, Math.round(value / 32) * 32);
}

function mediaItems(request: StudioJobRequest) {
  try {
    const value: unknown = JSON.parse(request.mediaState || "[]");
    return Array.isArray(value) ? value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    ) : [];
  } catch {
    return [];
  }
}

function sourceRatio(request: StudioJobRequest) {
  const picture = mediaItems(request).find((item) => item.kind === "picture");
  const width = Number(picture?.width);
  const height = Number(picture?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 16 / 9;
}

export function ltx25Dimensions(request: StudioJobRequest) {
  const ratio = request.aspectFormat === "keep source aspect"
    ? sourceRatio(request)
    : RATIOS[request.aspectFormat] ?? 16 / 9;
  const area = request.megapixels * 1_000_000;
  const width = align32(Math.sqrt(area * ratio));
  const height = align32(width / ratio);
  return { width, height };
}

function firstPicture(request: StudioJobRequest) {
  const picture = mediaItems(request).find((item) => item.kind === "picture");
  const file = typeof picture?.file === "string" ? picture.file.trim() : "";
  return file || null;
}

export function buildLtx25Prompt(
  request: StudioJobRequest,
  settings: Ltx25EngineSettings,
  seed: number,
  filenamePrefix: string,
): ComfyApiPrompt {
  if (request.generationMode !== "T2V" && request.generationMode !== "I2V") {
    throw new Error("LTX 2.5 supporta per ora Text to video e Image to video");
  }
  const picture = request.generationMode === "I2V" ? firstPicture(request) : null;
  if (request.generationMode === "I2V" && !picture) {
    throw new Error("Image to video LTX 2.5 richiede un'immagine iniziale");
  }
  const { width, height } = ltx25Dimensions(request);
  const frames = 1 + Math.floor((request.durationSeconds * FPS) / 8) * 8;
  const prompt: ComfyApiPrompt = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: settings.model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: settings.encoder, type: "ltxv", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: settings.videoVae } },
    "4": { class_type: "VAELoader", inputs: { vae_name: settings.audioVae } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: request.prompt, clip: ["2", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "7": { class_type: "LTXVConditioning", inputs: { positive: ["5", 0], negative: ["6", 0], frame_rate: FPS } },
    "8": { class_type: "EmptyLTXVLatentVideo", inputs: { width, height, length: frames, batch_size: 1 } },
    "9": { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: frames, frame_rate: FPS, batch_size: 1, audio_vae: ["4", 0] } },
    "10": { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["8", 0], audio_latent: ["9", 0] } },
    "14": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "15": { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["7", 0], negative: ["7", 1], cfg: settings.cfg } },
    "16": { class_type: "KSamplerSelect", inputs: { sampler_name: settings.sampler } },
    "17": { class_type: "ManualSigmas", inputs: { sigmas: DISTILLED_SIGMAS } },
    "18": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["14", 0], guider: ["15", 0], sampler: ["16", 0], sigmas: ["17", 0], latent_image: ["10", 0] } },
    "19": { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["18", 0] } },
    "20": { class_type: "VAEDecodeTiled", inputs: { samples: ["19", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    "21": { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["19", 1], audio_vae: ["4", 0] } },
    "22": { class_type: "CreateVideo", inputs: { images: ["20", 0], audio: ["21", 0], fps: FPS, bit_depth: 8 } },
    "23": { class_type: "SaveVideo", inputs: { video: ["22", 0], filename_prefix: filenamePrefix, format: "auto", codec: "auto" } },
  };
  if (picture) {
    prompt["11"] = { class_type: "LoadImage", inputs: { image: picture } };
    prompt["12"] = { class_type: "LTXVPreprocess", inputs: { image: ["11", 0], img_compression: 18 } };
    prompt["13"] = {
      class_type: "LTXVImgToVideoInplace",
      inputs: { vae: ["3", 0], image: ["12", 0], latent: ["10", 0], strength: 0.7, bypass: false },
    };
    prompt["18"].inputs.latent_image = ["13", 0];
  }
  return prompt;
}

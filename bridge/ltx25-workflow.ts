import type { ComfyApiPrompt } from "./comfy-client.js";
import type { Ltx25EngineSettings } from "./runtime-settings.js";
import type { StudioJobRequest } from "./studio-job.js";

const FPS = 24;
const DISTILLED_SIGMAS =
  "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
const QUALITY_REFINE_SIGMAS = "0.85, 0.7250, 0.4219, 0.0";

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
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 16 / 9;
  }
  const ratio = width / height;
  if (ratio < 0.4 || ratio > 2.5) {
    throw new Error(
      "LTX 2.5 non supporta il rapporto estremo dell'immagine sorgente; scegli un formato esplicito.",
    );
  }
  return ratio;
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
  const quality = request.qualityMode === "max";
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
    // Official LTX 2.5 low-memory decode profile. The wider temporal overlap
    // avoids visible joins without requiring a full-frame VAE decode.
    "20": { class_type: "VAEDecodeTiled", inputs: { samples: ["19", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 } },
    "21": { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["19", 1], audio_vae: ["4", 0] } },
    "22": { class_type: "CreateVideo", inputs: { images: ["20", 0], audio: ["21", 0], fps: FPS, bit_depth: 8 } },
    "23": { class_type: "SaveVideo", inputs: { video: ["22", 0], filename_prefix: filenamePrefix, format: "auto", codec: "auto" } },
  };
  if (picture) {
    prompt["11"] = { class_type: "LoadImage", inputs: { image: picture } };
    prompt["12"] = { class_type: "LTXVPreprocess", inputs: { image: ["11", 0], img_compression: 18 } };
    prompt["13"] = {
      class_type: "LTXVImgToVideoInplace",
      inputs: { vae: ["3", 0], image: ["12", 0], latent: ["8", 0], strength: 0.7, bypass: false },
    };
    prompt["10"].inputs.video_latent = ["13", 0];
  }
  if (quality) {
    prompt["24"] = {
      class_type: "LatentUpscaleModelLoader",
      inputs: { model_name: settings.upscaler },
    };
    prompt["25"] = {
      class_type: "LTXVLatentUpsampler",
      inputs: { samples: ["19", 0], upscale_model: ["24", 0], vae: ["3", 0] },
    };
    let refinedVideoLatent: [string, number] = ["25", 0];
    if (picture) {
      prompt["34"] = {
        class_type: "LTXVImgToVideoInplace",
        inputs: {
          vae: ["3", 0],
          image: ["12", 0],
          latent: ["25", 0],
          strength: 1,
          bypass: false,
        },
      };
      refinedVideoLatent = ["34", 0];
    }
    prompt["26"] = {
      class_type: "LTXVCropGuides",
      inputs: { positive: ["7", 0], negative: ["7", 1], latent: ["19", 0] },
    };
    prompt["27"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: { video_latent: refinedVideoLatent, audio_latent: ["19", 1] },
    };
    prompt["28"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
    prompt["29"] = {
      class_type: "CFGGuider",
      inputs: {
        model: ["1", 0],
        positive: ["26", 0],
        negative: ["26", 1],
        cfg: 1,
      },
    };
    prompt["30"] = {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "euler_cfg_pp" },
    };
    prompt["31"] = {
      class_type: "ManualSigmas",
      inputs: { sigmas: QUALITY_REFINE_SIGMAS },
    };
    prompt["32"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["28", 0],
        guider: ["29", 0],
        sampler: ["30", 0],
        sigmas: ["31", 0],
        latent_image: ["27", 0],
      },
    };
    prompt["33"] = {
      class_type: "LTXVSeparateAVLatent",
      inputs: { av_latent: ["32", 0] },
    };
    prompt["20"].inputs.samples = ["33", 0];
    prompt["21"].inputs.samples = ["33", 1];
  }
  return prompt;
}

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ComfyApiNode, ComfyApiPrompt, ComfyClient } from "./comfy-client.js";
import type { ComfyProgressTracker } from "./comfy-progress.js";
import type { JobRepository } from "./job-repository.js";
import {
  CandidateVariantRepository,
  type CandidateVariantKind,
  type UpscaleTargetMegapixels,
} from "./candidate-variant-repository.js";
import { findVideoOutput, type MediaOutput } from "./studio-job.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WORKFLOW_TARGET_MEGAPIXELS: Record<UpscaleTargetMegapixels, number> = {
  1: 0.98,
  2: 1.96,
};

export function normalizeUpscaleTarget(value: unknown): UpscaleTargetMegapixels {
  const target = Number(value);
  if (target !== 1 && target !== 2) {
    throw new Error("targetMegapixels deve essere 1 oppure 2");
  }
  return target;
}

export function workflowMegapixelsForTarget(target: UpscaleTargetMegapixels) {
  return WORKFLOW_TARGET_MEGAPIXELS[target];
}

export function scaledManualUpscaleDimensions(
  widthValue: unknown,
  heightValue: unknown,
  targetMegapixels: UpscaleTargetMegapixels,
) {
  const width = Number(widthValue);
  const height = Number(heightValue);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Dimensioni manuali sorgente non valide");
  }
  const ratio = width / height;
  const targetPixels = workflowMegapixelsForTarget(targetMegapixels) * 1024 * 1024;
  const snap = (value: number) => Math.max(32, Math.min(4096, Math.round(value / 32) * 32));
  return {
    width: snap(Math.sqrt(targetPixels * ratio)),
    height: snap(Math.sqrt(targetPixels / ratio)),
  };
}

function optionalSourceVariantId(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 80) {
    throw new Error("sourceVariantId non valido");
  }
  return value;
}

function sourceMegapixels(value: number) {
  return value >= 0.98 ? 1 : value;
}

async function requireNode(
  comfy: ComfyClient,
  nodeName: string,
  unavailableMessage: string,
) {
  try {
    return await comfy.objectInfo(nodeName);
  } catch {
    throw new Error(unavailableMessage);
  }
}

function node(prompt: ComfyApiPrompt, classType: string): ComfyApiNode {
  const matches = Object.values(prompt).filter((item) => item.class_type === classType);
  if (matches.length !== 1) {
    throw new Error(`Workflow sorgente: atteso un nodo ${classType}, trovati ${matches.length}`);
  }
  return matches[0];
}

function absoluteOutputPath(root: string, output: MediaOutput) {
  if (output.type !== "output") {
    throw new Error("Il Face Refiner richiede un video salvato nell'output ComfyUI");
  }
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, output.subfolder, output.filename);
  const relative = path.relative(normalizedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Percorso output candidato non valido");
  }
  return target;
}

export function upscalePrompt(
  original: ComfyApiPrompt,
  filenamePrefix: string,
  targetMegapixels: UpscaleTargetMegapixels,
) {
  const prompt = clone(original);
  const sampler = node(prompt, "H3ReferenceMemorySampler");
  const saver = node(prompt, "H3SaveContinuation");
  const dimensions = node(prompt, "H3AspectMegapixelSize");
  const sourceSizeMode = String(dimensions.inputs.size_mode ?? "megapixels + format");
  if (sourceSizeMode === "manual width x height") {
    const scaled = scaledManualUpscaleDimensions(
      dimensions.inputs.manual_width,
      dimensions.inputs.manual_height,
      targetMegapixels,
    );
    dimensions.inputs.manual_width = scaled.width;
    dimensions.inputs.manual_height = scaled.height;
  } else if (
    sourceSizeMode !== "source aspect + megapixels"
    && sourceSizeMode !== "megapixels + format"
  ) {
    dimensions.inputs.size_mode = "megapixels + format";
  }
  dimensions.inputs.megapixels = workflowMegapixelsForTarget(targetMegapixels);
  sampler.inputs.studio_upscale = true;
  sampler.inputs.studio_upscale_model =
    "minimax_h3_latent_upscaler_3d_fp16.safetensors";
  sampler.inputs.studio_upscale_source_ratio = 0.6;
  // H3 reference/keyframe conditioning contains resolution-dependent video
  // rows. Reusing the low-resolution guider after the latent is enlarged can
  // therefore crash the high-resolution refine with a row-shape mismatch.
  // The learned 3D latent upscale itself is safe and remains enabled.
  sampler.inputs.studio_upscale_refine_steps = 0;
  sampler.inputs.studio_upscale_precision = "fp16";
  saver.inputs.filename_prefix = filenamePrefix;
  saver.inputs.prepend_source_video = false;
  return prompt;
}

function copiedInputs(original: ComfyApiPrompt, classType: string) {
  return clone(node(original, classType).inputs);
}

export function facePrompt(input: {
  original: ComfyApiPrompt;
  sourcePath: string;
  prompt: string;
  seed: number;
  filenamePrefix: string;
  useTurbo: boolean;
}) {
  const originalSampler = node(input.original, "H3ReferenceMemorySampler");
  const modelInputs = copiedInputs(input.original, "H3ModelLoaderAny");
  const clipInputs = copiedInputs(input.original, "H3ClipLoaderAny");
  const vaes = Object.values(input.original).filter((item) => item.class_type === "VAELoader");
  if (vaes.length !== 2) throw new Error("Workflow sorgente: attesi Video VAE e Audio VAE");
  const videoVae = vaes.find((item) => String(item.inputs.vae_name ?? "").toLowerCase().includes("video"));
  const audioVae = vaes.find((item) => String(item.inputs.vae_name ?? "").toLowerCase().includes("audio"));
  if (!videoVae || !audioVae) throw new Error("Workflow sorgente: impossibile distinguere le due VAE H3");
  const videoVaeInputs = clone(videoVae.inputs);
  const audioVaeInputs = clone(audioVae.inputs);
  const loraInputs = copiedInputs(input.original, "Power Lora Loader (rgthree)");
  const sageInputs = copiedInputs(input.original, "PathchSageAttentionKJ");
  const shiftInputs = copiedInputs(input.original, "MiniMaxH3SigmaShift");
  loraInputs.model = ["108", 0];
  if (!input.useTurbo) {
    for (const [name, value] of Object.entries(loraInputs)) {
      if (/^lora_\d+$/.test(name) && typeof value === "object" && value) {
        (value as Record<string, unknown>).on = false;
      }
    }
  }
  sageInputs.model = ["109", 0];
  shiftInputs.model = ["110", 0];

  return {
    "101": { class_type: "VHS_LoadVideoPath", inputs: {
      video: input.sourcePath, force_rate: 0, custom_width: 0, custom_height: 0,
      frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: "None",
    } },
    "102": { class_type: "H3FaceTrackCrop", inputs: {
      images: ["101", 0], detector: "bbox\\face_yolov8m.pt", confidence: 0.35,
      crop_factor: 3, canvas_width: 512, canvas_height: 512,
      canvas_mode: "auto_capped_768", smooth_window: 21,
      size_smooth_window: 51, smooth_method: "gaussian", size_mode: "per_frame",
      identity_track: true, identity_threshold: 0.28, select: "largest",
      fallback_detector: "none", fallback_head_frac: 0.5,
    } },
    "103": { class_type: "H3ClipLoaderAny", inputs: clipInputs },
    "104": { class_type: "VAELoader", inputs: videoVaeInputs },
    "105": { class_type: "VAELoader", inputs: audioVaeInputs },
    "106": { class_type: "MiniMaxH3ReferenceToVideo", inputs: {
      clip: ["103", 0], vae: ["104", 0], audio_vae: ["105", 0],
      prompt: input.prompt, width: ["102", 4], height: ["102", 5],
      length: ["101", 1], ref_image_size: "match",
    } },
    "107": { class_type: "H3InjectVideoLatent", inputs: {
      av_latent: ["106", 1], images: ["102", 0], vae: ["104", 0],
    } },
    "108": { class_type: "H3ModelLoaderAny", inputs: modelInputs },
    "109": { class_type: "Power Lora Loader (rgthree)", inputs: loraInputs },
    "110": { class_type: "PathchSageAttentionKJ", inputs: sageInputs },
    "111": { class_type: "MiniMaxH3SigmaShift", inputs: shiftInputs },
    "112": { class_type: "MiniMaxH3NativeAudioLock", inputs: {
      model: ["111", 0], av_latent: ["107", 0], audio_vae: ["105", 0], audio: ["101", 2],
    } },
    "113": { class_type: "BasicGuider", inputs: {
      model: ["112", 0], conditioning: ["106", 0],
    } },
    "114": { class_type: "KSamplerSelect", inputs: {
      sampler_name: String(originalSampler.inputs.sampler_name ?? "res_multistep"),
    } },
    "115": { class_type: "BasicScheduler", inputs: {
      model: ["112", 0], scheduler: String(originalSampler.inputs.scheduler ?? "simple"),
      steps: input.useTurbo ? 4 : 8, denoise: 0.45,
    } },
    "116": { class_type: "RandomNoise", inputs: { noise_seed: input.seed } },
    "117": { class_type: "H3PerFrameDenoise", inputs: {
      av_latent: ["112", 1], transform: ["102", 1], strength_small_face: 0.8,
      strength_large_face: 0.35, scale_mode: "absolute_px", face_px_small: 30,
      face_px_large: 120, gamma: 1, smooth_frames: 9,
    } },
    "118": { class_type: "SamplerCustomAdvanced", inputs: {
      noise: ["116", 0], guider: ["113", 0], sampler: ["114", 0],
      sigmas: ["115", 0], latent_image: ["117", 0],
    } },
    "119": { class_type: "VAEDecode", inputs: {
      samples: ["118", 0], vae: ["104", 0],
    } },
    "120": { class_type: "H3FaceStitch", inputs: {
      base_images: ["101", 0], refined_crops: ["119", 0], transform: ["102", 1],
      paste_region: "face_only", mask_dilation: 24, feather: 24,
      colour_match: 1, blend: 1, undetected_frames: "fade_out",
      feather_scales_with_crop: false,
    } },
    "121": { class_type: "VHS_VideoCombine", inputs: {
      images: ["120", 0], audio: ["101", 2], frame_rate: 24, loop_count: 0,
      filename_prefix: input.filenamePrefix, format: "video/h264-mp4",
      pix_fmt: "yuv420p", crf: 16, save_metadata: true,
      trim_to_audio: false, pingpong: false, save_output: true,
    } },
  } satisfies ComfyApiPrompt;
}

export class PostprocessService {
  constructor(
    private readonly comfy: ComfyClient,
    private readonly progress: ComfyProgressTracker,
    private readonly jobs: JobRepository,
    private readonly variants: CandidateVariantRepository,
    private readonly comfyOutputDir: string,
  ) {}

  async create(
    jobId: string,
    candidateIndex: number,
    rawKind: unknown,
    rawSourceVariantId?: unknown,
    rawTargetMegapixels?: unknown,
  ) {
    const requestedKind = rawKind === "face" || rawKind === "upscale" || rawKind === "face_upscale"
      ? rawKind as CandidateVariantKind
      : null;
    if (!requestedKind) throw new Error("Variante richiesta non valida");
    const source = this.jobs.candidateSnapshot(jobId, candidateIndex);
    if (!source?.job || source.candidate.status !== "ready" || !source.candidate.output) {
      throw new Error("Il candidato originale deve essere completato");
    }

    const sourceVariantId = optionalSourceVariantId(rawSourceVariantId);
    const parentVariant = sourceVariantId ? this.variants.get(sourceVariantId) : null;
    if (sourceVariantId && !parentVariant) {
      throw new Error("Variante sorgente non trovata");
    }
    if (
      parentVariant
      && (
        parentVariant.sourceJobId !== jobId
        || parentVariant.sourceCandidateIndex !== candidateIndex
      )
    ) {
      throw new Error("La variante sorgente non appartiene al candidato richiesto");
    }
    if (parentVariant && (parentVariant.status !== "ready" || !parentVariant.output)) {
      throw new Error("La variante sorgente deve essere completata");
    }
    if (parentVariant && requestedKind !== "face") {
      throw new Error("Solo Face può essere applicato a una variante già elaborata");
    }
    if (parentVariant && parentVariant.kind !== "upscale") {
      throw new Error("Face può essere applicato soltanto a una variante Upscale pronta");
    }

    const requestedTarget = rawTargetMegapixels === undefined
      || rawTargetMegapixels === null
      || rawTargetMegapixels === ""
      ? null
      : normalizeUpscaleTarget(rawTargetMegapixels);
    const needsUpscale = requestedKind === "upscale" || requestedKind === "face_upscale";
    const targetMegapixels = needsUpscale
      ? requestedTarget ?? 1
      : parentVariant?.targetMegapixels ?? null;
    if (
      needsUpscale
      && targetMegapixels !== null
      && targetMegapixels <= sourceMegapixels(source.job.request.megapixels)
    ) {
      throw new Error(
        `Upscale ${targetMegapixels} MP non disponibile: la risoluzione deve essere superiore alla sorgente`,
      );
    }
    const kind: CandidateVariantKind = requestedKind === "face"
      && parentVariant?.targetMegapixels
      ? "face_upscale"
      : requestedKind;

    if (requestedKind === "face" || requestedKind === "face_upscale") {
      await requireNode(
        this.comfy,
        "H3FaceTrackCrop",
        "Face Refiner installato ma non ancora caricato: riavvia ComfyUI.",
      );
    }
    if (requestedKind === "upscale" || requestedKind === "face_upscale") {
      const [, samplerInfo] = await Promise.all([
        requireNode(
          this.comfy,
          "MinimaxH3LatentUpscaler3D",
          "Latent Upscaler installato ma non ancora caricato: riavvia ComfyUI.",
        ),
        requireNode(
          this.comfy,
          "H3ReferenceMemorySampler",
          "Sampler H3 non disponibile: riavvia ComfyUI.",
        ),
      ]);
      const sampler = samplerInfo.H3ReferenceMemorySampler;
      const samplerInput = isRecord(sampler) && isRecord(sampler.input)
        ? sampler.input
        : null;
      const optional = samplerInput && isRecord(samplerInput.optional)
        ? samplerInput.optional
        : null;
      if (!optional || !("studio_upscale" in optional)) {
        throw new Error(
          "Upscaler installato, ma il sampler H3 aggiornato non è ancora caricato: riavvia ComfyUI.",
        );
      }
    }

    const temporaryId = randomUUID();
    const basePrefix = `video/H3_STUDIO/${jobId}/candidate_${candidateIndex}/variants/${temporaryId}`;
    const stage = requestedKind === "face" ? "face" : "upscale";
    const prompt = stage === "upscale"
      ? upscalePrompt(
          source.candidate.apiPrompt,
          `${basePrefix}_upscale`,
          targetMegapixels!,
        )
      : facePrompt({
          original: source.candidate.apiPrompt,
          sourcePath: absoluteOutputPath(
            this.comfyOutputDir,
            parentVariant?.output ?? source.candidate.output,
          ),
          prompt: source.job.request.prompt,
          seed: source.candidate.seed,
          filenamePrefix: `${basePrefix}_face`,
          useTurbo: source.job.engine.loras.some((slot) =>
            slot.name.toLowerCase().includes("turbo")),
        });
    const record = this.variants.create({
      sourceJobId: jobId,
      sourceCandidateIndex: candidateIndex,
      sourceVariantId,
      targetMegapixels,
      kind,
      stage,
      prompt,
      filenamePrefix: stage === "upscale" ? `${basePrefix}_upscale` : `${basePrefix}_face`,
    });
    try {
      const queued = await this.comfy.queuePrompt(prompt, `h3-studio-variant-${record.id}`);
      this.progress.register(queued.promptId, prompt);
      this.variants.markQueued(record.id, queued.promptId, queued.queueNumber);
      return this.variants.get(record.id);
    } catch (error) {
      this.variants.updateStatus(
        record.id,
        "failed",
        null,
        error instanceof Error ? error.message : "Invio variante fallito",
      );
      throw error;
    }
  }

  private async refreshJob(jobId: string) {
    const records = this.variants.listForJob(jobId);
    if (!records.some((item) => item.status !== "ready" && item.status !== "failed")) {
      return records;
    }
    const [history, queue] = await Promise.all([
      this.comfy.history(200),
      this.comfy.queueState(),
    ]);
    for (const variant of records) {
      if (!variant.promptId || variant.status === "ready" || variant.status === "failed") continue;
      const entry = history[variant.promptId];
      const statusString = entry?.status && typeof entry.status === "object"
        ? (entry.status as Record<string, unknown>).status_str
        : null;
      const output = entry ? findVideoOutput(entry.outputs) : null;
      if (statusString === "error") {
        this.variants.updateStatus(variant.id, "failed", null, "ComfyUI ha interrotto il post-process");
        continue;
      }
      if (statusString === "success" && output) {
        if (variant.kind === "face_upscale" && variant.stage === "upscale") {
          const source = this.jobs.candidateSnapshot(
            variant.sourceJobId,
            variant.sourceCandidateIndex,
          );
          if (!source?.job) {
            this.variants.updateStatus(variant.id, "failed", null, "Candidato sorgente non trovato");
            continue;
          }
          try {
            const prefix = `${variant.filenamePrefix.replace(/_upscale$/, "")}_face`;
            const prompt = facePrompt({
              original: source.candidate.apiPrompt,
              sourcePath: absoluteOutputPath(this.comfyOutputDir, output),
              prompt: source.job.request.prompt,
              seed: source.candidate.seed,
              filenamePrefix: prefix,
              useTurbo: source.job.engine.loras.some((slot) =>
                slot.name.toLowerCase().includes("turbo")),
            });
            const queued = await this.comfy.queuePrompt(prompt, `h3-studio-variant-${variant.id}-face`);
            this.progress.register(queued.promptId, prompt);
            this.variants.advanceToFace(
              variant.id, prompt, prefix, output, queued.promptId, queued.queueNumber,
            );
          } catch (error) {
            this.variants.updateStatus(
              variant.id,
              "failed",
              null,
              error instanceof Error ? error.message : "Avvio Face Refiner fallito",
            );
          }
        } else {
          this.variants.updateStatus(variant.id, "ready", output);
        }
        continue;
      }
      const status = queue.runningPromptIds.has(variant.promptId)
        ? "rendering"
        : queue.pendingPromptIds.has(variant.promptId)
          ? "queued"
          : variant.status;
      this.variants.updateStatus(variant.id, status);
    }
    return this.variants.listForJob(jobId);
  }

  async listForJob(jobId: string) {
    const records = await this.refreshJob(jobId);
    return records.map((variant) => {
      const live = variant.promptId ? this.progress.get(variant.promptId) : null;
      const ready = variant.status === "ready";
      return {
        ...variant,
        phaseLabel: ready
          ? "Variante pronta"
          : variant.status === "failed"
            ? variant.error ?? "Post-process fallito"
            : variant.kind === "face_upscale" && variant.stage === "face"
              ? "Upscale pronto · Face Refiner in corso"
              : live?.phaseLabel ?? (variant.status === "queued" ? "In coda" : "Post-process in corso"),
        progress: ready ? 100 : live?.progress ?? null,
      };
    });
  }

  async cancelForJob(jobId: string) {
    const active = this.variants.listForJob(jobId).filter(
      (variant) => variant.status !== "ready" && variant.status !== "failed",
    );
    await this.comfy.cancelPrompts(
      active.flatMap((variant) => variant.promptId ? [variant.promptId] : []),
    );
    for (const variant of active) {
      this.variants.updateStatus(
        variant.id,
        "failed",
        null,
        "Interrotto su richiesta",
      );
    }
    return this.listForJob(jobId);
  }

  async recover() {
    let count = 0;
    for (const item of this.variants.recoverable()) {
      try {
        this.progress.register(item.prompt_id, JSON.parse(item.api_prompt_json) as ComfyApiPrompt);
        count += 1;
      } catch {
        // A stale post-process snapshot must not prevent bridge startup.
      }
    }
    return count;
  }
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ImageStudioPanel, {
  type ImageStudioIncomingReference,
} from "./image-studio-panel";
import ChatPanel from "./chat-panel";
import AudioStudioPanel from "./audio-studio-panel";
import RegenerateDialog from "./regenerate-dialog";
import {
  compatiblePddFilesForModel,
  fastPddPairForModel,
  isOfficialFastPddModel,
  preferredPddFileForModel,
} from "../bridge/pdd-compatibility";

type CandidateStatus =
  | "idle"
  | "submitted"
  | "queued"
  | "rendering"
  | "ready"
  | "failed";

type VariantKind = "face" | "upscale" | "face_upscale";
type UpscaleTargetMegapixels = 1 | 2;
type CandidateVariant = {
  id: string;
  sourceCandidateIndex: number;
  sourceVariantId?: string | null;
  kind: VariantKind;
  stage: "face" | "upscale";
  targetMegapixels?: UpscaleTargetMegapixels | null;
  status: CandidateStatus | "prepared";
  phaseLabel?: string;
  progress?: number | null;
  processingSeconds?: number | null;
  error?: string | null;
  output: { mediaPath: string; filename: string } | null;
};

type Candidate = {
  id: number;
  progress: number;
  seed: number;
  status: CandidateStatus;
  promptId?: string | null;
  mediaPath?: string | null;
  phaseLabel?: string;
  progressExact?: boolean;
  processingSeconds?: number | null;
  error?: string | null;
  variants?: CandidateVariant[];
  activeVariantId?: string | null;
};

type PendingUpscaleRequest = {
  jobId: string;
  candidateId: number;
  sourceMegapixels: number;
  targetMegapixels: UpscaleTargetMegapixels;
};

type ConnectionState =
  | "checking"
  | "connected"
  | "comfy-offline"
  | "bridge-offline";
type SeedMode = "random" | "base" | "fixed";
type QualityMode = "fast" | "min" | "med" | "max";
type GenerationPreset = "fast" | "8" | "12" | "20" | "30";
type Megapixels = 0.5 | 0.7 | 0.98;

type BridgeHealthPayload = {
  bridge?: { status?: string; postprocessContract?: number };
  comfyui?: {
    connected?: boolean;
    error?: string | null;
    queue?: { running?: number; pending?: number };
  };
  fastEngine?: {
    model?: string;
    loras?: EngineLoraSlot[];
    steps?: number;
  };
};

const bridgeUrl =
  process.env.NEXT_PUBLIC_H3_BRIDGE_URL ??
  (typeof window === "undefined"
    ? "http://127.0.0.1:8787"
    : window.location.hostname.endsWith(".ts.net")
      ? `https://${window.location.hostname}:8787`
      : `http://${window.location.hostname}:8787`);

const modes = [
  { value: "t2v", label: "Text to video", factor: 1 },
  { value: "i2v", label: "Image to video", factor: 1.05 },
  { value: "reference", label: "Reference", factor: 1.15 },
  { value: "keyframes", label: "Keyframes", factor: 1.15 },
  { value: "continue", label: "Continue video", factor: 1.2 },
  { value: "edit", label: "Edit video", factor: 1.2 },
] as const;

type StudioMode = (typeof modes)[number]["value"];
type GenerationMode =
  | "T2V"
  | "I2V"
  | "R2V"
  | "KEYFRAMES"
  | "VIDEO EXTENSION"
  | "VIDEO EDITING";

const generationModeByUi: Record<StudioMode, GenerationMode> = {
  t2v: "T2V",
  i2v: "I2V",
  reference: "R2V",
  keyframes: "KEYFRAMES",
  continue: "VIDEO EXTENSION",
  edit: "VIDEO EDITING",
};

const uiModeByGeneration: Record<GenerationMode, StudioMode> = {
  T2V: "t2v",
  I2V: "i2v",
  R2V: "reference",
  KEYFRAMES: "keyframes",
  "VIDEO EXTENSION": "continue",
  "VIDEO EDITING": "edit",
};

type AudioRoutingRole =
  | "reference_audio"
  | "voice_ref"
  | "ignore"
  | "exact_soundtrack"
  | "exact_soundtrack_plus_h3_sfx"
  | "music_video_lipsync";

type MediaAsset = {
  kind: "picture" | "video" | "audio";
  file: string;
  name: string;
  caption?: string;
  mention?: string;
  mediaPath?: string;
  libraryAssetId?: string;
  externalMediaId?: string;
  origin?: "external";
  referenceRole?: string;
  shotUsage?: "auto" | "all" | number[];
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  has_audio?: boolean;
  audio_mode?: "paired" | "standalone" | "off";
  audio_role?: AudioRoutingRole;
  uid: string;
};

type ExternalMediaAsset = {
  id: string;
  origin: "external";
  kind: "picture" | "video" | "audio";
  file: string;
  name: string;
  originalName: string;
  size: number | null;
  duration: number | null;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  originProjectId: string | null;
  originProjectName: string | null;
  mediaPath: string;
  createdAt: string;
  updatedAt: string;
};

type ImageProjectTag = "untagged" | "character" | "object" | "background";

type ImagePickerOutput = {
  mediaPath: string;
  filename?: string;
  file?: string;
  subfolder?: string;
  type?: "input" | "output" | "temp";
  width?: number | null;
  height?: number | null;
};

type ImagePickerCandidate = {
  index: number;
  displayName?: string | null;
  status: string;
  output: ImagePickerOutput | null;
  projectLinks?: Array<
    | string
    | {
        projectId: string;
        projectName?: string | null;
        candidateIndex?: number | null;
        tag?: ImageProjectTag | null;
      }
  >;
};

type ImagePickerJob = {
  id: string;
  originProjectId: string | null;
  originProjectName: string | null;
  prompt: string;
  width: number;
  height: number;
  candidates: ImagePickerCandidate[];
};

type GeneratedImagePickerItem = {
  job: ImagePickerJob;
  candidate: ImagePickerCandidate & { output: ImagePickerOutput };
  sameProject: boolean;
};

type AssetLibraryImage = {
  id: string;
  name: string;
  detail: string;
  file: string;
  mediaPath: string;
  width?: number | null;
  height?: number | null;
  tag: ImageProjectTag;
  projectName?: string | null;
  source: "image-studio" | "legacy";
  assetId?: string;
  jobId?: string;
  candidateIndex?: number;
  referenceId?: string;
};

type MentionState = { start: number; end: number; query: string };

function mentionBase(name: string) {
  const clean = name
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return clean || "media";
}

function uniqueMention(name: string, assets: MediaAsset[]) {
  const base = mentionBase(name);
  const used = new Set(assets.map((asset) => asset.mention).filter(Boolean));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function mediaToken(assets: MediaAsset[], index: number) {
  const asset = assets[index];
  const ordinal = assets.slice(0, index + 1).filter((item) => item.kind === asset.kind).length;
  const label = asset.kind === "picture" ? "Picture" : asset.kind === "video" ? "Video" : "Audio";
  return `<${label} ${ordinal}>`;
}

function mediaPreviewPath(asset: MediaAsset) {
  if (asset.mediaPath) return asset.mediaPath;
  const match = asset.file.match(/^(.*?)(?: \[(input|output|temp)\])?$/i);
  const relative = (match?.[1] ?? asset.file).replace(/\\/g, "/");
  const slash = relative.lastIndexOf("/");
  const filename = slash >= 0 ? relative.slice(slash + 1) : relative;
  const subfolder = slash >= 0 ? relative.slice(0, slash) : "";
  const type = (match?.[2] ?? "input").toLowerCase();
  const query = new URLSearchParams({ filename, subfolder, type });
  return `/api/media?${query.toString()}`;
}

function imageReferenceFile(output: ImagePickerOutput) {
  if (output.file?.trim()) return output.file;
  const relative = [output.subfolder, output.filename].filter(Boolean).join("/");
  if (relative) return `${relative} [${output.type ?? "output"}]`;
  try {
    const url = new URL(output.mediaPath, "http://h3-studio.local");
    const filename = url.searchParams.get("filename");
    if (filename) {
      const subfolder = url.searchParams.get("subfolder") ?? "";
      const type = url.searchParams.get("type") ?? "output";
      return `${subfolder ? `${subfolder}/` : ""}${filename} [${type}]`;
    }
  } catch {
    // Historical entries can contain a plain media path instead of a URL.
  }
  return output.mediaPath;
}

function imageCandidateTag(candidate: ImagePickerCandidate, projectId: string) {
  const links = (candidate.projectLinks ?? []).flatMap((link) =>
    typeof link === "string"
      ? [{ projectId: link, tag: null }]
      : [{ projectId: link.projectId, tag: link.tag ?? null }],
  );
  const tag =
    links.find((link) => link.projectId === projectId)?.tag ??
    links.find((link) => link.tag && link.tag !== "untagged")?.tag;
  return tag && tag !== "untagged" ? tag : undefined;
}

function generatedAssetImages(imageJobs: ImagePickerJob[]) {
  const collected: AssetLibraryImage[] = [];
  const seen = new Set<string>();
  for (const job of imageJobs) {
    for (const candidate of job.candidates) {
      if (candidate.status !== "ready" || !candidate.output) continue;
      const file = imageReferenceFile(candidate.output);
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        id: `generated:${job.id}:${candidate.index}`,
        name: candidate.displayName ?? `Immagine ${job.id.slice(0, 8)} · candidato ${candidate.index}`,
        detail: job.prompt,
        file,
        mediaPath: candidate.output.mediaPath,
        width: candidate.output.width ?? job.width,
        height: candidate.output.height ?? job.height,
        tag: imageCandidateTag(candidate, "") ?? "untagged",
        projectName: job.originProjectName,
        source: "image-studio",
        jobId: job.id,
        candidateIndex: candidate.index,
      });
    }
  }
  return collected;
}

function buildReferenceRoles(assets: MediaAsset[], fallback: string) {
  if (!assets.length) return fallback || "AUTO";
  return assets
    .map((asset, index) => {
      const caption = asset.caption?.trim() || asset.name;
      const role = asset.referenceRole ? `, ${asset.referenceRole.replace("_", " ")}` : "";
      const schedule = asset.shotUsage === "all"
        ? ", REQUIRED in every generated clip"
        : Array.isArray(asset.shotUsage) && asset.shotUsage.length
          ? `, use ONLY in generated clips ${asset.shotUsage.join(", ")}`
          : ", shot schedule AUTO: choose only the clips that need it";
      return `${mediaToken(assets, index)} = ${caption}${role}${schedule}`;
    })
    .join("; ");
}

function resolvePromptMentions(value: string, assets: MediaAsset[]) {
  const firstByMention = new Map<string, number>();
  assets.forEach((asset, index) => {
    if (asset.mention && !firstByMention.has(asset.mention)) firstByMention.set(asset.mention, index);
  });
  let resolved = value;
  for (const [mention, index] of firstByMention) {
    const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    resolved = resolved.replace(new RegExp(`@${escaped}(?![a-zA-Z0-9_-])`, "g"), mediaToken(assets, index));
  }
  return resolved;
}

const creativePresets = [
  {
    label: "Camera",
    items: [
      { icon: "→", label: "Tracking", text: "smooth forward tracking shot" },
      { icon: "↻", label: "Orbit", text: "dynamic 180-degree orbit camera move" },
      { icon: "↥", label: "Crane", text: "large-amplitude crane-up reveal" },
      { icon: "⌁", label: "Handheld", text: "controlled cinematic handheld camera" },
      { icon: "⌃", label: "Drone", text: "fast low-altitude drone fly-through" },
    ],
  },
  {
    label: "Obiettivo",
    items: [
      { icon: "24", label: "24mm", text: "24mm wide-angle cinema lens" },
      { icon: "35", label: "35mm", text: "35mm anamorphic cinema lens" },
      { icon: "50", label: "50mm", text: "50mm natural-perspective cinema lens" },
      { icon: "85", label: "85mm", text: "85mm portrait lens with shallow depth of field" },
      { icon: "◎", label: "Macro", text: "macro lens extreme close-up" },
    ],
  },
  {
    label: "Effetti",
    items: [
      { icon: "½", label: "Slow motion", text: "brief physically accurate slow motion" },
      { icon: "»", label: "Speed ramp", text: "cinematic speed ramp into the action" },
      { icon: "◉", label: "Dolly zoom", text: "dramatic dolly zoom" },
      { icon: "⇄", label: "Rack focus", text: "precise rack focus between foreground and subject" },
      { icon: "✦", label: "Particles", text: "volumetric particles and realistic atmospheric debris" },
    ],
  },
] as const;

const aspectFormats = [
  { value: "16:9 landscape", label: "16:9 · Orizzontale" },
  { value: "9:16 portrait", label: "9:16 · Verticale" },
  { value: "1:1 square", label: "1:1 · Quadrato" },
  { value: "4:3 landscape", label: "4:3 · Orizzontale" },
  { value: "3:4 portrait", label: "3:4 · Verticale" },
  { value: "3:2 landscape", label: "3:2 · Orizzontale" },
  { value: "2:3 portrait", label: "2:3 · Verticale" },
  { value: "21:9 ultrawide", label: "21:9 · Ultrawide" },
  { value: "9:21 vertical ultrawide", label: "9:21 · Verticale ultra" },
  { value: "5:4 landscape", label: "5:4 · Orizzontale" },
  { value: "4:5 portrait", label: "4:5 · Verticale" },
] as const;

const KEEP_SOURCE_ASPECT_FORMAT = "keep source aspect" as const;

function sourceAspectLabel(mode: StudioMode) {
  if (mode === "i2v" || mode === "keyframes") return "Mantieni proporzioni · Picture 1";
  if (mode === "continue" || mode === "edit") return "Mantieni proporzioni · Video 1";
  if (mode === "reference") return "Mantieni proporzioni · Picture/Video 1";
  return null;
}

const initialCandidates: Candidate[] = [
  { id: 1, progress: 0, seed: 0, status: "idle" },
  { id: 2, progress: 0, seed: 0, status: "idle" },
  { id: 3, progress: 0, seed: 0, status: "idle" },
  { id: 4, progress: 0, seed: 0, status: "idle" },
];

function formatStatus(candidate: Candidate) {
  if (candidate.phaseLabel) return candidate.phaseLabel;
  if (candidate.status === "idle") return "Pronto a generare";
  if (candidate.status === "failed") return "Generazione fallita";
  if (candidate.status === "ready") return "Pronto";
  if (candidate.status === "submitted") return "Invio a ComfyUI";
  if (candidate.status === "rendering") return "ComfyUI in esecuzione";
  if (candidate.status === "queued") return "In coda";
  if (candidate.progress < 18) return "Caricamento modelli";
  if (candidate.progress < 86) return "Generazione video";
  return "Finalizzazione";
}

function formatMegapixels(value: number) {
  return value === 0.98 ? "0.98" : value.toFixed(1);
}

function formatProcessingTime(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value > 0 && value < 1) return "<1s";
  const totalSeconds = Math.round(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function formatProcessingTimeLabel(value: number | null | undefined) {
  const formatted = formatProcessingTime(value);
  return formatted ? `Tempo ${formatted}` : null;
}

type EngineLoraSlot = {
  name: string;
  strength: number;
};

function isFastCreativeLora(name: string) {
  return !/(?:turbo|distill|pdd|acc[-_ ]?8)/i.test(name);
}

function compatibleEngineOptions(
  values: string[],
  current: string,
  pattern: RegExp,
) {
  const compatible = values.filter((value) => pattern.test(value));
  const options = compatible.length > 0 ? [...compatible] : [...values];
  if (current && !options.includes(current)) options.unshift(current);
  return options;
}

function preferredFlux2Encoder(model: string, encoders: string[], fallback: string) {
  const pattern = /(?:9b|snofs)/i.test(model) ? /qwen.*3.*8b/i : /qwen.*3.*4b/i;
  return encoders.find((encoder) => pattern.test(encoder)) ?? fallback;
}

type EngineAdminResponse = {
  workflow: {
    source: string;
    apiPrompt: string;
    capturedAt: string | null;
    ready: boolean;
  };
  fastWorkflow: {
    ready: boolean;
    apiPromptPath: string;
    recipe: string;
    error?: string;
  };
  kreaWorkflow: { source: string };
  imageEditWorkflow: { source: string };
  animaWorkflow: { source: string };
  minimaxImageWorkflow: { source: string };
  audioStudio?: {
    tts: { ready: boolean; root: string; voices: string[]; defaultVoice: string; unloadPolicy: string };
    music: { ready: boolean; model: string; encoder: string; vae: string; steps: number; cfg: number };
    voiceConversion: { ready: boolean; root: string; backend: "cuda" | "cpu"; steps: number; separatorModel: string; seedVcModel: string; unloadPolicy: string };
  } | null;
  settings: {
    h3: {
      model: string;
      loras: EngineLoraSlot[];
      steps: number;
    };
    fast: {
      model: string;
      pddFile: string;
      loras: EngineLoraSlot[];
      steps: 8;
    };
    krea: {
      model: string;
      encoder: string;
      vae: string;
      loras: EngineLoraSlot[];
      steps: number;
    };
    imageEdit: {
      model: string;
      encoder: string;
      vae: string;
      steps: number;
      cfg: number;
      kvCacheEnabled: boolean;
      attentionBackend: "auto" | "pytorch attention" | "comfy kitchen attention";
    };
    anima: {
      model: string;
      encoder: string;
      vae: string;
      loras: EngineLoraSlot[];
      steps: number;
      cfg: number;
    };
    chat: {
      model: string;
      projector: string;
      nCtx: number;
      nGpuLayers: number;
      nThreads: number;
      maxNewTokens: number;
      temperature: number;
      topP: number;
    };
    tts: {
      root: string;
      voice: string;
      temperature: number;
      topP: number;
      topK: number;
      speed: number;
      maxNewTokens: number;
    };
    music: {
      model: string;
      encoder: string;
      vae: string;
      steps: number;
      cfg: number;
      tiledDecode: boolean;
    };
    voiceConversion: {
      root: string;
      separatorModel: string;
      seedVcModel: string;
      backend: "cuda" | "cpu";
      steps: number;
      f0Condition: boolean;
      autoF0Adjust: boolean;
    };
  };
  capabilities: {
    models: string[];
    loras: string[];
    pddFiles: string[];
    textEncoders: string[];
    vaes: string[];
    chatModels: string[];
    chatProjectors: string[];
    chatRuntime: { ready: boolean; loaded: boolean; version: string | null; error: string | null };
    imageAttentionBackends: string[];
  };
};

type AdminLlmRuntimeStatus = {
  supported: boolean;
  processes: Array<{ pid: number; name: string }>;
  gpu: { usedMiB: number; totalMiB: number } | null;
};

type WorkflowCatalogItem = {
  id: string;
  role: "video" | "fast" | "image" | "image_edit" | "image_anima" | "image_minimax";
  name: string;
  description: string;
  file: string;
};

type InstallSettings = {
  comfyUrl: string;
  comfyOutputDir: string;
  videoWorkflowId: string;
  fastWorkflowId: string;
  imageWorkflowId: string;
  imageEditWorkflowId: string;
  imageAnimaWorkflowId: string;
  imageMinimaxWorkflowId: string;
  ffmpegPath: string;
};

type InstallAdminResponse = {
  settings: InstallSettings;
  workflowCatalog: WorkflowCatalogItem[];
  dependencies: Array<{
    id: string;
    label: string;
    kind: "custom_node" | "model";
    installed: boolean;
    url?: string;
    requiredFor?: string[];
    folder?: string;
    filenames?: string[];
    notes?: string;
    checks: Array<{ className?: string; filename?: string; installed: boolean }>;
  }>;
};

type SetupStatus = {
  setupRequired: boolean;
  authenticated: boolean;
  defaults: InstallSettings;
  workflowCatalog: WorkflowCatalogItem[];
};

type RemoteJob = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  sourceJobId: string | null;
  status: string;
  createdAt: string;
  selectedCandidateIndex: number | null;
  engine: {
    profile?: "standard" | "fast";
    pddFile?: string | null;
    model: string;
    lora: string;
    loraStrength: number;
    loras?: EngineLoraSlot[];
    steps: number;
  };
  request: {
    prompt: string;
    promptLength: number;
    candidateCount: 1 | 2 | 3 | 4;
    shotCount?: number;
    durationSeconds: 5 | 10 | 15;
    megapixels: Megapixels;
    generationMode: GenerationMode;
    aspectFormat: string;
    seedMode?: SeedMode;
    qualityMode?: QualityMode;
    turboEnabled?: boolean;
    seed?: number;
    mediaState?: string;
    referenceRoles?: string;
    keyframePositions?: string;
    sourceVideoAudio?: "AUTO" | "IGNORE" | "REFERENCE" | "REUSE";
    projectId?: string | null;
    sourceJobId?: string | null;
    muteDiegetic?: boolean;
    muteNonDiegetic?: boolean;
  };
  candidates: Array<{
    index: number;
    seed: number;
    displayName?: string | null;
    promptId: string | null;
    status: CandidateStatus | "prepared";
    phaseLabel?: string;
    progress?: number | null;
    progressExact?: boolean;
    processingSeconds?: number | null;
    error?: string | null;
    output: { mediaPath: string; filename: string } | null;
  }>;
  variants?: CandidateVariant[];
};

type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  clipCount: number;
  timelineCount: number;
  jobCount: number;
};

type ProjectTimelineSummary = {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  externalAudioFile: string | null;
  externalAudioName: string | null;
  originalAudioGain: number;
  externalAudioGain: number;
  externalAudioLoop: boolean;
  createdAt: string;
  updatedAt: string;
  clipCount: number;
};

type ProjectClip = {
  id: string;
  projectId: string;
  timelineId: string;
  sourceJobId: string;
  sourceCandidateIndex: number;
  sourceVariantId: string | null;
  variantKind: VariantKind | "original";
  position: number;
  label: string;
  createdAt: string;
  seed: number;
  sourceDuration: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
  output: { mediaPath: string; filename: string };
  variants: Array<{
    id: string;
    kind: VariantKind;
    targetMegapixels?: UpscaleTargetMegapixels | null;
    output: { mediaPath: string; filename: string };
  }>;
};

function variantLabel(
  kind: VariantKind | "original",
  targetMegapixels?: number | null,
) {
  const target = targetMegapixels === 2 ? "2 MP" : "1 MP";
  if (kind === "face") return "Face";
  if (kind === "upscale") return `Upscale ${target}`;
  if (kind === "face_upscale") return `Face + ${target}`;
  return "Originale";
}

const upscaleTargets = [1, 2] as const satisfies readonly UpscaleTargetMegapixels[];

function canonicalVideoMegapixels(value: number) {
  if (Math.abs(value - 0.98) < 0.03) return 1;
  if (Math.abs(value - 1.96) < 0.05) return 2;
  return value;
}

function candidateVersionMegapixels(
  originalMegapixels: number,
  activeVariant: CandidateVariant | undefined,
  variants: CandidateVariant[],
  visited = new Set<string>(),
): number {
  if (!activeVariant) return canonicalVideoMegapixels(originalMegapixels);
  if (typeof activeVariant.targetMegapixels === "number") {
    return canonicalVideoMegapixels(activeVariant.targetMegapixels);
  }
  if (visited.has(activeVariant.id)) {
    return canonicalVideoMegapixels(originalMegapixels);
  }
  visited.add(activeVariant.id);
  if (activeVariant.sourceVariantId) {
    return candidateVersionMegapixels(
      originalMegapixels,
      variants.find((variant) => variant.id === activeVariant.sourceVariantId),
      variants,
      visited,
    );
  }
  // Le varianti storiche non avevano metadati: l'upscale legacy era sempre 1 MP.
  if (activeVariant.kind === "upscale" || activeVariant.kind === "face_upscale") {
    return 1;
  }
  return canonicalVideoMegapixels(originalMegapixels);
}

type CandidateDeletionResult = {
  jobDeleted: boolean;
  removedClips: number;
  removedFiles: number;
  warnings: string[];
};

async function requestCandidateDeletion(jobId: string, candidateIndex: number) {
  const response = await fetch(
    `${bridgeUrl}/api/jobs/${jobId}/candidates/${candidateIndex}/delete`,
    { method: "POST" },
  );
  const payload = (await response.json()) as Partial<CandidateDeletionResult> & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
  }
  return {
    jobDeleted: Boolean(payload.jobDeleted),
    removedClips: Number(payload.removedClips ?? 0),
    removedFiles: Number(payload.removedFiles ?? 0),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
  } satisfies CandidateDeletionResult;
}

type ProjectDetail = ProjectSummary & {
  timelines: ProjectTimelineSummary[];
  clips: ProjectClip[];
};

type TimelineDetail = ProjectTimelineSummary & { clips: ProjectClip[] };

type CreativeReference = {
  id: string;
  assetId: string;
  label: string;
  role: string;
  source: "upload" | "generated";
  file: string;
  name: string;
  mediaPath: string;
  width: number | null;
  height: number | null;
};

type CreativeGeneration = {
  id: string;
  status: "prepared" | "queued" | "running" | "ready" | "failed";
  seed: number;
  promptId: string | null;
  error: string | null;
  createdAt: string;
};

type CreativeAsset = {
  id: string;
  kind: "character" | "object";
  name: string;
  description: string;
  generationPrompt: string;
  status: "draft" | "ready" | "generating" | "failed";
  referenceCount: number;
  hero: CreativeReference | null;
  references?: CreativeReference[];
  generations?: CreativeGeneration[];
};

function HistoryPanel({
  onOpen,
  onUseClip,
  onNewGeneration,
}: {
  onOpen: (job: RemoteJob) => void;
  onUseClip: (clip: ProjectClip, mode: "continue" | "edit" | "reference") => void;
  onNewGeneration: (projectId?: string) => void;
}) {
  const [jobs, setJobs] = useState<RemoteJob[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [timelineId, setTimelineId] = useState("");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [transferTargetId, setTransferTargetId] = useState("");
  const [montageIndex, setMontageIndex] = useState(0);
  const [montagePlaying, setMontagePlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedMediaPath, setExportedMediaPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Caricamento cronologia…");

  async function loadJobs(targetProjectId = projectId) {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (targetProjectId) query.set("projectId", targetProjectId);
      const response = await fetch(`${bridgeUrl}/api/jobs?${query.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
      const payload = (await response.json()) as { jobs?: RemoteJob[] };
      const loaded = payload.jobs ?? [];
      setJobs(loaded);
      setMessage(
        loaded.length === 0
          ? "Nessun job salvato"
          : `${loaded.length} job salvati localmente`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cronologia non disponibile");
    } finally {
      setLoading(false);
    }
  }

  async function loadProjects() {
    const response = await fetch(`${bridgeUrl}/api/projects`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
    const payload = (await response.json()) as { projects?: ProjectSummary[] };
    const loaded = payload.projects ?? [];
    setProjects(loaded);
    setProjectId((current) =>
      current && loaded.some((item) => item.id === current)
        ? current
        : loaded[0]?.id ?? "",
    );
  }

  async function loadProject(id: string) {
    if (!id) {
      setProject(null);
      return;
    }
    const response = await fetch(`${bridgeUrl}/api/projects/${id}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
    const payload = (await response.json()) as { project?: ProjectDetail };
    setProject(payload.project ?? null);
    setTimelineId((current) =>
      current && payload.project?.timelines.some((item) => item.id === current)
        ? current
        : payload.project?.timelines[0]?.id ?? "",
    );
    setMontageIndex((current) =>
      Math.min(current, Math.max(0, (payload.project?.clips.length ?? 1) - 1)),
    );
  }

  async function refreshAll() {
    setLoading(true);
    try {
      await Promise.all([loadJobs(projectId), loadProjects()]);
      if (projectId) await loadProject(projectId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Aggiornamento fallito");
    } finally {
      setLoading(false);
    }
  }

  async function createProject() {
    if (!newProjectName.trim()) return;
    try {
      const response = await fetch(`${bridgeUrl}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newProjectName }),
      });
      const payload = (await response.json()) as {
        project?: ProjectDetail;
        error?: string;
      };
      if (!response.ok || !payload.project) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setNewProjectName("");
      await loadProjects();
      setProjectId(payload.project.id);
      setProject(payload.project);
      setMessage(`Progetto “${payload.project.name}” creato`);
      onNewGeneration(payload.project.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Creazione fallita");
    }
  }

  async function projectMutation(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    }
    setExportedMediaPath("");
    if (projectId) await loadProject(projectId);
    await loadProjects();
  }

  async function exportProject() {
    if (!projectId || !project?.clips.length) return;
    setExporting(true);
    setExportedMediaPath("");
    setMessage("Esportazione MP4 in corso…");
    try {
      const response = await fetch(`${bridgeUrl}/api/projects/${projectId}/export`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        export?: { mediaPath: string; filename: string; clipCount: number };
        error?: string;
      };
      if (!response.ok || !payload.export) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setExportedMediaPath(payload.export.mediaPath);
      setMessage(
        `MP4 pronto: ${payload.export.clipCount} clip unite in ${payload.export.filename}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Esportazione fallita");
    } finally {
      setExporting(false);
    }
  }

  async function addJobToProject(
    job: RemoteJob,
    candidate: RemoteJob["candidates"][number],
    variant?: CandidateVariant,
  ) {
    if (!projectId || !timelineId || !candidate.output) return;
    try {
      await projectMutation(`/api/timelines/${timelineId}/clips`, {
        jobId: job.id,
        candidateIndex: candidate.index,
        variantId: variant?.id ?? null,
        label: `Candidato ${candidate.index} · ${variant ? variantLabel(variant.kind, variant.targetMegapixels) : "Originale"} · ${job.id.slice(0, 8)}`,
      });
      setMessage("Clip aggiunta alla timeline");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Aggiunta clip fallita");
    }
  }

  async function transferClip(clip: ProjectClip, operation: "copy" | "move") {
    if (!transferTargetId || transferTargetId === projectId) return;
    try {
      await projectMutation(`/api/project-clips/${clip.id}/${operation}`, {
        targetProjectId: transferTargetId,
      });
      if (projectId) await loadProject(projectId);
      setMessage(operation === "copy" ? "Clip copiata" : "Clip spostata");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trasferimento fallito");
    }
  }

  async function reorderTimelineClip(clip: ProjectClip, position: number) {
    try {
      await projectMutation(`/api/project-clips/${clip.id}/reorder`, {
        position,
      });
      setMessage("Ordine timeline aggiornato");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Riordino fallito");
    }
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    void loadProject(projectId).catch((error) =>
      setMessage(error instanceof Error ? error.message : "Progetto non disponibile"),
    );
    setMontagePlaying(false);
    setExportedMediaPath("");
    void loadJobs(projectId);
  }, [projectId]);

  const currentClip = project?.clips[montageIndex] ?? null;
  const transferProjects = projects.filter((item) => item.id !== projectId);

  return (
    <section className="history-panel">
      <div className="history-heading">
        <div>
          <span className="section-index">PROGETTI</span>
          <h2>Progetti e generazioni</h2>
          <p>{message}</p>
        </div>
        <div className="history-heading-actions">
          <button className="primary-action" onClick={() => onNewGeneration(projectId || undefined)} type="button">
            + Nuova generazione
          </button>
          <button disabled={loading} onClick={refreshAll} type="button">
            {loading ? "Aggiornamento…" : "Aggiorna"}
          </button>
        </div>
      </div>

      <div className="project-toolbar">
        <label>
          <span>Progetto attivo</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Nessun progetto</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.clipCount} clip
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Nuovo progetto</span>
          <input
            maxLength={80}
            onChange={(event) => setNewProjectName(event.target.value)}
            placeholder="Es. Dragon duel"
            value={newProjectName}
          />
        </label>
        <button disabled={!newProjectName.trim()} onClick={createProject} type="button">
          Crea progetto
        </button>
        {project?.timelines.length ? (
          <label>
            <span>Montaggio destinazione</span>
            <select value={timelineId} onChange={(event) => setTimelineId(event.target.value)}>
              {project.timelines.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.clipCount} clip</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {project && (
        <section className="montage-panel" hidden>
          <div className="montage-stage">
            {currentClip ? (
              <video
                autoPlay={montagePlaying}
                controls
                key={currentClip.id}
                onEnded={() => {
                  if (montageIndex < project.clips.length - 1) {
                    setMontageIndex((index) => index + 1);
                  } else {
                    setMontagePlaying(false);
                    setMontageIndex(0);
                  }
                }}
                playsInline
                preload="metadata"
                src={`${bridgeUrl}${currentClip.output.mediaPath}`}
              />
            ) : (
              <div className="montage-empty">Aggiungi un candidato completato alla timeline</div>
            )}
            {currentClip && (
              <span className="montage-counter">
                {montageIndex + 1} / {project.clips.length}
              </span>
            )}
          </div>

          <div className="montage-controls">
            <div>
              <strong>{project.name}</strong>
              <span>Playback virtuale · i file originali restano separati</span>
            </div>
            <div className="montage-actions">
              <button
                disabled={!project.clips.length}
                onClick={() => {
                  setMontageIndex(0);
                  setMontagePlaying(true);
                }}
                type="button"
              >
                ▶ Riproduci
              </button>
              <button
                disabled={!project.clips.length || exporting}
                onClick={() => void exportProject()}
                type="button"
              >
                {exporting ? "Esportazione…" : "⇩ Esporta MP4"}
              </button>
              {exportedMediaPath && (
                <a
                  download
                  href={`${bridgeUrl}${exportedMediaPath}`}
                  rel="noopener"
                  target="_blank"
                >
                  Scarica MP4 pronto
                </a>
              )}
            </div>
          </div>

          <div className="timeline-strip">
            {project.clips.map((clip, index) => (
              <article
                className={index === montageIndex ? "timeline-clip active" : "timeline-clip"}
                key={clip.id}
              >
                <button
                  className="timeline-preview"
                  onClick={() => {
                    setMontageIndex(index);
                    setMontagePlaying(false);
                  }}
                  type="button"
                >
                  <video muted playsInline preload="metadata" src={`${bridgeUrl}${clip.output.mediaPath}`} />
                  <span>{index + 1}</span>
                </button>
                <div className="timeline-clip-body">
                  <strong>{clip.label}</strong>
                  <small>Seed {clip.seed}</small>
                  <div>
                    <button onClick={() => onUseClip(clip, "continue")} type="button">Continua</button>
                    <button onClick={() => onUseClip(clip, "edit")} type="button">Edita</button>
                    <button
                      disabled={index === 0}
                      onClick={() => void reorderTimelineClip(clip, index - 1)}
                      type="button"
                    >
                      ←
                    </button>
                    <button
                      disabled={index === project.clips.length - 1}
                      onClick={() => void reorderTimelineClip(clip, index + 1)}
                      type="button"
                    >
                      →
                    </button>
                    <button disabled={!transferTargetId} onClick={() => void transferClip(clip, "copy")} type="button">Copia</button>
                    <button disabled={!transferTargetId} onClick={() => void transferClip(clip, "move")} type="button">Sposta</button>
                  </div>
                </div>
              </article>
            ))}
          </div>

          {transferProjects.length > 0 && (
            <label className="transfer-target">
              <span>Destinazione per Copia/Sposta</span>
              <select value={transferTargetId} onChange={(event) => setTransferTargetId(event.target.value)}>
                <option value="">Scegli progetto…</option>
                {transferProjects.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
          )}
        </section>
      )}

      <div className="history-subheading">
        <div>
          <span className="section-index">LIBRERIA</span>
          <h3>Generazioni disponibili</h3>
        </div>
        <span>{jobs.length} job</span>
      </div>

      <div className="history-list">
        {jobs.map((job) => {
          const selectedCandidate =
            job.candidates.find(
              (candidate) => candidate.index === job.selectedCandidateIndex,
            ) ?? job.candidates.find((candidate) => candidate.output);
          const selectedVariants = (job.variants ?? []).filter(
            (variant) =>
              variant.sourceCandidateIndex === selectedCandidate?.index &&
              variant.status === "ready" && variant.output,
          );
          const selectedCandidateTime = formatProcessingTimeLabel(
            selectedCandidate?.processingSeconds,
          );
          return (
            <article className="history-card" key={job.id}>
              <div className="history-preview">
                {selectedCandidate?.output ? (
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={`${bridgeUrl}${selectedCandidate.output.mediaPath}`}
                  />
                ) : (
                  <div className="history-placeholder">Output non ancora disponibile</div>
                )}
                {job.selectedCandidateIndex && (
                  <span className="history-selected">
                    Candidato {job.selectedCandidateIndex} scelto
                  </span>
                )}
              </div>

              <div className="history-body">
                <div className="history-meta-row">
                  <div>
                    <span className={`history-status ${job.status}`}>{job.status}</span>
                    <span className="project-job-badge">{job.projectName ?? "Senza progetto"}</span>
                  </div>
                  <time dateTime={job.createdAt}>
                    {new Date(job.createdAt).toLocaleString("it-IT")}
                  </time>
                </div>
                <p>{job.request.prompt}</p>
                <div className="history-specs">
                  <span>{job.request.shotCount && job.request.shotCount > 1 ? `${job.request.shotCount} shot × ${job.request.durationSeconds}s` : `${job.request.durationSeconds}s`}</span>
                  <span>{formatMegapixels(job.request.megapixels)} MP</span>
                  <span>{job.request.aspectFormat.split(" ")[0]}</span>
                  <span>{job.engine.steps} step</span>
                  <span>
                    Seed {job.request.seedMode === "fixed" ? "bloccato" : job.request.seedMode === "base" ? "base +1" : "random"}
                  </span>
                  <span>{job.candidates.length} candidat{job.candidates.length === 1 ? "o" : "i"}</span>
                  {selectedCandidateTime && <span>{selectedCandidateTime}</span>}
                </div>
                <div className="history-footer">
                  <code>{job.id.slice(0, 8)}</code>
                  <div>
                    <button onClick={() => onOpen(job)} type="button">
                      Apri nello Studio
                    </button>
                    <button
                      disabled={!timelineId || !selectedCandidate?.output}
                      onClick={() => selectedCandidate && void addJobToProject(job, selectedCandidate)}
                      type="button"
                    >
                      + Timeline
                    </button>
                    {selectedVariants.map((variant) => {
                      const variantProcessingTime = formatProcessingTimeLabel(
                        variant.processingSeconds,
                      );
                      return (
                        <button
                          disabled={!timelineId}
                          key={variant.id}
                          onClick={() => selectedCandidate && void addJobToProject(job, selectedCandidate, variant)}
                          type="button"
                        >
                          + {variantLabel(variant.kind, variant.targetMegapixels)}
                          {variantProcessingTime ? ` · ${variantProcessingTime}` : ""}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MontagesPanel({
  onUseClip,
  initialProjectId,
  initialTimelineId,
}: {
  onUseClip: (clip: ProjectClip, mode: "continue" | "edit" | "reference") => void;
  initialProjectId?: string;
  initialTimelineId?: string;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [timelines, setTimelines] = useState<ProjectTimelineSummary[]>([]);
  const [timelineId, setTimelineId] = useState("");
  const [timeline, setTimeline] = useState<TimelineDetail | null>(null);
  const [projectJobs, setProjectJobs] = useState<RemoteJob[]>([]);
  const [sourceVersions, setSourceVersions] = useState<Record<string, string>>({});
  const [addingSource, setAddingSource] = useState<string | null>(null);
  const [removingClipId, setRemovingClipId] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [newName, setNewName] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Caricamento montaggi…");
  const [exportedMediaPath, setExportedMediaPath] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  async function loadProjects() {
    const response = await fetch(`${bridgeUrl}/api/projects`, { cache: "no-store" });
    const payload = (await response.json()) as { projects?: ProjectSummary[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    const loaded = payload.projects ?? [];
    setProjects(loaded);
    setProjectId(current => current && loaded.some(item => item.id === current) ? current : loaded[0]?.id ?? "");
  }

  async function loadTimelines(id: string) {
    if (!id) {
      setTimelines([]);
      setTimelineId("");
      setTimeline(null);
      return;
    }
    const response = await fetch(`${bridgeUrl}/api/projects/${id}/timelines`, { cache: "no-store" });
    const payload = (await response.json()) as { timelines?: ProjectTimelineSummary[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    const loaded = payload.timelines ?? [];
    setTimelines(loaded);
    setTimelineId(current => current && loaded.some(item => item.id === current) ? current : loaded[0]?.id ?? "");
  }

  async function loadProjectJobs(id: string) {
    if (!id) {
      setProjectJobs([]);
      return;
    }
    setLoadingSources(true);
    try {
      const query = new URLSearchParams({ limit: "100", projectId: id });
      const response = await fetch(`${bridgeUrl}/api/jobs?${query.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as { jobs?: RemoteJob[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setProjectJobs(payload.jobs ?? []);
    } finally {
      setLoadingSources(false);
    }
  }

  async function loadTimeline(id: string) {
    if (!id) { setTimeline(null); return; }
    const response = await fetch(`${bridgeUrl}/api/timelines/${id}`, { cache: "no-store" });
    const payload = (await response.json()) as { timeline?: TimelineDetail; error?: string };
    if (!response.ok || !payload.timeline) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    setTimeline(payload.timeline);
    setCurrentIndex(index => Math.min(index, Math.max(0, payload.timeline!.clips.length - 1)));
  }

  async function timelineMutation(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { timeline?: TimelineDetail; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    if (payload.timeline) setTimeline(payload.timeline);
    if (projectId) await loadTimelines(projectId);
    return payload.timeline;
  }

  async function createTimeline() {
    if (!projectId || !newName.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/projects/${projectId}/timelines`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const payload = (await response.json()) as { timeline?: TimelineDetail; error?: string };
      if (!response.ok || !payload.timeline) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setNewName("");
      await loadTimelines(projectId);
      setTimelineId(payload.timeline.id);
      setTimeline(payload.timeline);
      setMessage(`Montaggio “${payload.timeline.name}” creato`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Creazione montaggio fallita");
    } finally { setBusy(false); }
  }

  async function addProjectSource(
    job: RemoteJob,
    candidate: RemoteJob["candidates"][number],
    versionId: string,
  ) {
    if (!timelineId || !candidate.output) return;
    const key = `${job.id}-${candidate.index}`;
    const variant = (job.variants ?? []).find(
      item => item.id === versionId && item.status === "ready" && item.output,
    );
    setAddingSource(key);
    try {
      await timelineMutation(`/api/timelines/${timelineId}/clips`, {
        jobId: job.id,
        candidateIndex: candidate.index,
        variantId: variant?.id ?? null,
        label: `Candidato ${candidate.index} · ${variant ? variantLabel(variant.kind, variant.targetMegapixels) : "Originale"} · ${job.id.slice(0, 8)}`,
      });
      setMessage(`${variant ? variantLabel(variant.kind, variant.targetMegapixels) : "Originale"} aggiunta a “${timeline?.name ?? "montaggio"}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Aggiunta clip fallita");
    } finally {
      setAddingSource(null);
    }
  }

  function patchClip(clipId: string, update: Partial<ProjectClip>) {
    setTimeline(current => current ? {
      ...current,
      clips: current.clips.map(clip => clip.id === clipId ? { ...clip, ...update } : clip),
    } : current);
  }

  async function saveClip(clip: ProjectClip) {
    try {
      const updated = await timelineMutation(`/api/project-clips/${clip.id}/trim`, {
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        volume: clip.volume,
        variantId: clip.sourceVariantId,
      });
      if (updated) setMessage(`Trim salvato · ${(clip.trimEnd - clip.trimStart).toFixed(2)}s`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Salvataggio trim fallito");
      if (timelineId) await loadTimeline(timelineId);
    }
  }

  async function saveMixer(update: Partial<TimelineDetail>) {
    if (!timeline) return;
    setTimeline({ ...timeline, ...update });
    try {
      await timelineMutation(`/api/timelines/${timeline.id}`, {
        name: update.name ?? timeline.name,
        externalAudioFile: update.externalAudioFile === undefined ? timeline.externalAudioFile : update.externalAudioFile,
        externalAudioName: update.externalAudioName === undefined ? timeline.externalAudioName : update.externalAudioName,
        originalAudioGain: update.originalAudioGain ?? timeline.originalAudioGain,
        externalAudioGain: update.externalAudioGain ?? timeline.externalAudioGain,
        externalAudioLoop: update.externalAudioLoop ?? timeline.externalAudioLoop,
      });
      setMessage("Impostazioni montaggio salvate");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Mixer non salvato");
    }
  }

  async function uploadExternalAudio(file: File | undefined) {
    if (!file || !timeline) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const query = projectId
        ? `?${new URLSearchParams({ projectId }).toString()}`
        : "";
      const response = await fetch(`${bridgeUrl}/api/assets/upload${query}`, { method: "POST", body });
      const payload = (await response.json()) as { asset?: { kind: string; file: string; name: string }; error?: string };
      if (!response.ok || !payload.asset || payload.asset.kind !== "audio") throw new Error(payload.error ?? "Seleziona un file audio");
      await saveMixer({ externalAudioFile: payload.asset.file, externalAudioName: payload.asset.name });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload audio fallito");
    } finally { setBusy(false); }
  }

  async function exportTimeline() {
    if (!timeline?.clips.length) return;
    setBusy(true);
    setExportedMediaPath("");
    setMessage("Trim, concatenazione e mix audio in corso…");
    try {
      const response = await fetch(`${bridgeUrl}/api/timelines/${timeline.id}/export`, { method: "POST" });
      const payload = (await response.json()) as { export?: { mediaPath: string; filename: string }; error?: string };
      if (!response.ok || !payload.export) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setExportedMediaPath(payload.export.mediaPath);
      setMessage(`MP4 pronto: ${payload.export.filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export fallito");
    } finally { setBusy(false); }
  }

  async function reorder(clip: ProjectClip, position: number) {
    try {
      await timelineMutation(`/api/project-clips/${clip.id}/reorder`, { position });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Riordino fallito"); }
  }

  async function removeClip(clip: ProjectClip) {
    if (!window.confirm(
      `Rimuovere “${clip.label}” da questo montaggio?\n\nIl video originale resterà nel progetto e nella Libreria.`,
    )) return;
    setRemovingClipId(clip.id);
    setPlaying(false);
    try {
      const response = await fetch(`${bridgeUrl}/api/project-clips/${clip.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { timeline?: TimelineDetail; error?: string };
      if (!response.ok || !payload.timeline) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setTimeline(payload.timeline);
      setCurrentIndex(index => Math.min(index, Math.max(0, payload.timeline!.clips.length - 1)));
      setExportedMediaPath("");
      if (projectId) await loadTimelines(projectId);
      setMessage(`“${clip.label}” rimossa dal montaggio · il video originale è ancora in Libreria`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rimozione clip fallita");
      if (timelineId) await loadTimeline(timelineId);
    } finally {
      setRemovingClipId(null);
    }
  }

  useEffect(() => {
    void loadProjects().catch(error => setMessage(error instanceof Error ? error.message : "Progetti non disponibili"));
  }, []);
  useEffect(() => {
    if (initialProjectId) setProjectId(initialProjectId);
  }, [initialProjectId]);
  useEffect(() => {
    setPlaying(false);
    void loadTimelines(projectId).catch(error => setMessage(error instanceof Error ? error.message : "Montaggi non disponibili"));
    void loadProjectJobs(projectId).catch(error => setMessage(error instanceof Error ? error.message : "Clip del progetto non disponibili"));
  }, [projectId]);
  useEffect(() => {
    if (initialTimelineId) setTimelineId(initialTimelineId);
  }, [initialTimelineId]);
  useEffect(() => {
    setPlaying(false);
    setExportedMediaPath("");
    void loadTimeline(timelineId).catch(error => setMessage(error instanceof Error ? error.message : "Montaggio non disponibile"));
  }, [timelineId]);
  useEffect(() => {
    if (playing) void videoRef.current?.play();
    else videoRef.current?.pause();
  }, [playing, currentIndex]);

  const projectSources = useMemo(() => projectJobs.flatMap(job =>
    job.candidates
      .filter(candidate => candidate.status === "ready" && candidate.output)
      .map(candidate => ({
        job,
        candidate,
        variants: (job.variants ?? []).filter(
          variant => variant.sourceCandidateIndex === candidate.index && variant.status === "ready" && variant.output,
        ),
      })),
  ), [projectJobs]);
  const currentClip = timeline?.clips[currentIndex] ?? null;
  return (
    <section className="montages-workspace">
      <div className="history-heading">
        <div>
          <span className="section-index">MONTAGGI</span>
          <h2>Timeline del progetto</h2>
          <p>{message}</p>
        </div>
        <button disabled={busy || !timeline?.clips.length} onClick={() => void exportTimeline()} type="button">
          {busy ? "Elaborazione…" : "⇩ Esporta MP4"}
        </button>
      </div>

      <div className="montage-selector-bar">
        <label><span>Progetto</span><select value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">Nessun progetto</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.timelineCount} montaggi</option>)}
        </select></label>
        <label><span>Montaggio</span><select value={timelineId} onChange={event => setTimelineId(event.target.value)}>
          {timelines.map(item => <option key={item.id} value={item.id}>{item.name} · {item.clipCount} clip</option>)}
        </select></label>
        <label><span>Nuovo montaggio</span><input maxLength={80} placeholder="Es. Director's cut" value={newName} onChange={event => setNewName(event.target.value)} /></label>
        <button disabled={busy || !projectId || !newName.trim()} onClick={() => void createTimeline()} type="button">+ Crea</button>
      </div>

      {projectId && (
        <section className="montage-source-bin" aria-label="Clip del progetto">
          <div className="montage-source-heading">
            <div>
              <span className="section-index">MEDIA DEL PROGETTO</span>
              <h3>Clip da aggiungere</h3>
            </div>
            <span>{loadingSources ? "Caricamento…" : `${projectSources.length} candidate pronte`}</span>
          </div>
          {projectSources.length ? (
            <div className="montage-source-strip">
              {projectSources.map(({ job, candidate, variants }) => {
                const key = `${job.id}-${candidate.index}`;
                const versionId = sourceVersions[key] ?? "original";
                const selectedVariant = variants.find(variant => variant.id === versionId);
                const output = selectedVariant?.output ?? candidate.output;
                const alreadyUsed = Boolean(timeline?.clips.some(
                  clip => clip.sourceJobId === job.id && clip.sourceCandidateIndex === candidate.index,
                ));
                return (
                  <article className="montage-source-card" key={key}>
                    <div className="montage-source-preview">
                      {output && <video muted playsInline preload="metadata" src={`${bridgeUrl}${output.mediaPath}`} />}
                      <span>Seed {candidate.seed}</span>
                    </div>
                    <div className="montage-source-body">
                      <strong>Candidato {candidate.index} · {job.id.slice(0, 8)}</strong>
                      <p title={job.request.prompt}>{job.request.prompt}</p>
                      <label>
                        <span>Versione</span>
                        <select
                          aria-label={`Versione candidato ${candidate.index}`}
                          value={versionId}
                          onChange={event => setSourceVersions(current => ({ ...current, [key]: event.target.value }))}
                        >
                          <option value="original">Originale</option>
                          {variants.map(variant => (
                            <option key={variant.id} value={variant.id}>{variantLabel(variant.kind, variant.targetMegapixels)}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        disabled={!timelineId || addingSource === key}
                        onClick={() => void addProjectSource(job, candidate, versionId)}
                        type="button"
                      >
                        {addingSource === key ? "Aggiunta…" : alreadyUsed ? "+ Aggiungi ancora" : "+ Aggiungi al montaggio"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="montage-source-empty">
              {loadingSources ? "Cerco le clip generate…" : "Nessuna clip completata associata a questo progetto."}
            </div>
          )}
        </section>
      )}

      {!projects.length ? (
        <div className="montage-empty-large">Crea prima un progetto dalla voce “Progetti”.</div>
      ) : timeline ? (
        <>
          <div className="montage-editor-grid">
            <div className="montage-player">
              {currentClip ? (
                <video
                  autoPlay={playing}
                  controls
                  key={`${currentClip.id}:${currentClip.sourceVariantId ?? "original"}`}
                  onLoadedMetadata={event => { event.currentTarget.currentTime = currentClip.trimStart; }}
                  onTimeUpdate={event => {
                    if (event.currentTarget.currentTime < currentClip.trimEnd - 0.03) return;
                    if (currentIndex < timeline.clips.length - 1) setCurrentIndex(index => index + 1);
                    else { setPlaying(false); setCurrentIndex(0); }
                  }}
                  playsInline
                  preload="metadata"
                  ref={videoRef}
                  src={`${bridgeUrl}${currentClip.output.mediaPath}`}
                />
              ) : <div className="montage-empty">Aggiungi clip da Progetti</div>}
              {currentClip && <span className="montage-counter">{currentIndex + 1} / {timeline.clips.length}</span>}
              {currentClip && <button
                aria-label={`Rimuovi ${currentClip.label} dal montaggio`}
                className="timeline-player-remove"
                disabled={removingClipId === currentClip.id}
                onClick={() => void removeClip(currentClip)}
                title="Rimuovi soltanto da questo montaggio"
                type="button"
              >🗑 <span>Rimuovi dalla timeline</span></button>}
            </div>
            <aside className="audio-mixer">
              <span className="section-index">AUDIO</span>
              <h3>Mixer del montaggio</h3>
              <label><span>Audio originale</span><input min="0" max="2" step="0.05" type="range" value={timeline.originalAudioGain} onChange={event => setTimeline({ ...timeline, originalAudioGain: Number(event.target.value) })} onPointerUp={() => void saveMixer({ originalAudioGain: timeline.originalAudioGain })} /><b>{timeline.originalAudioGain.toFixed(2)}</b></label>
              <label><span>Audio esterno</span><input disabled={!timeline.externalAudioFile} min="0" max="2" step="0.05" type="range" value={timeline.externalAudioGain} onChange={event => setTimeline({ ...timeline, externalAudioGain: Number(event.target.value) })} onPointerUp={() => void saveMixer({ externalAudioGain: timeline.externalAudioGain })} /><b>{timeline.externalAudioGain.toFixed(2)}</b></label>
              <label className="audio-upload">{busy ? "Caricamento…" : timeline.externalAudioName ?? "+ Carica musica / voce / SFX"}<input accept="audio/*" type="file" onChange={event => { void uploadExternalAudio(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
              {timeline.externalAudioFile && <div className="audio-file-actions">
                <label><input checked={timeline.externalAudioLoop} type="checkbox" onChange={event => void saveMixer({ externalAudioLoop: event.target.checked })} /> Ripeti fino alla fine</label>
                <button onClick={() => void saveMixer({ externalAudioFile: null, externalAudioName: null })} type="button">Rimuovi</button>
              </div>}
              <p>L’audio H3 è già mixato: qui controlli la traccia originale intera e una traccia esterna indipendente.</p>
              <button disabled={!timeline.clips.length} onClick={() => { setCurrentIndex(0); setPlaying(true); }} type="button">▶ Riproduci montaggio</button>
              {exportedMediaPath && <a download href={`${bridgeUrl}${exportedMediaPath}`} rel="noopener" target="_blank">Scarica MP4 pronto</a>}
            </aside>
          </div>

          <div className="timeline-editor-strip">
            {timeline.clips.map((clip, index) => (
              <article className={index === currentIndex ? "timeline-editor-clip active" : "timeline-editor-clip"} key={clip.id}>
                <button className="timeline-preview" onClick={() => { setCurrentIndex(index); setPlaying(false); }} type="button">
                  <video muted playsInline preload="metadata" src={`${bridgeUrl}${clip.output.mediaPath}`} />
                  <span>{index + 1}</span>
                </button>
                <div className="timeline-editor-fields">
                  <strong>{clip.label}</strong>
                  <div className="trim-fields">
                    <label>Versione <select
                      value={clip.sourceVariantId ?? "original"}
                      onChange={(event) => {
                        const variantId = event.target.value === "original" ? null : event.target.value;
                        void timelineMutation(`/api/project-clips/${clip.id}/trim`, {
                          trimStart: clip.trimStart,
                          trimEnd: clip.trimEnd,
                          volume: clip.volume,
                          variantId,
                        }).then(() => setMessage(`Versione ${variantId ? "post-process" : "originale"} attiva`));
                      }}
                    >
                      <option value="original">Originale</option>
                      {clip.variants.map((variant) => (
                        <option key={variant.id} value={variant.id}>{variantLabel(variant.kind, variant.targetMegapixels)}</option>
                      ))}
                    </select></label>
                    <label>Da <input min="0" max={clip.trimEnd - 0.05} step="0.05" type="number" value={clip.trimStart} onChange={event => patchClip(clip.id, { trimStart: Number(event.target.value) })} onBlur={() => void saveClip(clip)} /></label>
                    <label>A <input min={clip.trimStart + 0.05} max={clip.sourceDuration} step="0.05" type="number" value={clip.trimEnd} onChange={event => patchClip(clip.id, { trimEnd: Number(event.target.value) })} onBlur={() => void saveClip(clip)} /></label>
                    <label>Vol <input min="0" max="2" step="0.05" type="number" value={clip.volume} onChange={event => patchClip(clip.id, { volume: Number(event.target.value) })} onBlur={() => void saveClip(clip)} /></label>
                  </div>
                  <small>{(clip.trimEnd - clip.trimStart).toFixed(2)}s usati di {clip.sourceDuration}s</small>
                  <div className="timeline-clip-actions">
                    <button disabled={index === 0} onClick={() => void reorder(clip, index - 1)} type="button">←</button>
                    <button disabled={index === timeline.clips.length - 1} onClick={() => void reorder(clip, index + 1)} type="button">→</button>
                    <button onClick={() => onUseClip(clip, "continue")} type="button">Continua</button>
                    <button onClick={() => onUseClip(clip, "edit")} type="button">Edita</button>
                    <button
                      className="remove"
                      disabled={removingClipId === clip.id}
                      onClick={() => void removeClip(clip)}
                      title="Il video originale resterà in Libreria"
                      type="button"
                    >🗑 Rimuovi</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : <div className="montage-empty-large">Crea un montaggio per questo progetto.</div>}
    </section>
  );
}

type MediaLibraryCategory = "all" | "montages" | "assets" | "images" | "external" | "videos";

function MediaLibraryPanel({
  onUseReferences,
  onUseVideo,
  onUseExternal,
  onUseImage,
  onOpenMontage,
  onVideoDeleted,
}: {
  onUseReferences: (asset: CreativeAsset, references: CreativeReference[]) => void;
  onUseVideo: (job: RemoteJob, candidate: RemoteJob["candidates"][number]) => void;
  onUseExternal: (asset: ExternalMediaAsset) => void;
  onUseImage: (image: AssetLibraryImage) => void;
  onOpenMontage: (projectId: string, timelineId: string) => void;
  onVideoDeleted: (
    jobId: string,
    candidateIndex: number,
    result: CandidateDeletionResult,
  ) => void;
}) {
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [imageJobs, setImageJobs] = useState<ImagePickerJob[]>([]);
  const [jobs, setJobs] = useState<RemoteJob[]>([]);
  const [externalAssets, setExternalAssets] = useState<ExternalMediaAsset[]>([]);
  const [montages, setMontages] = useState<TimelineDetail[]>([]);
  const [message, setMessage] = useState("Caricamento libreria media…");
  const [deletingVideo, setDeletingVideo] = useState<string | null>(null);
  const [deletingTimeline, setDeletingTimeline] = useState<string | null>(null);
  const [renamingMedia, setRenamingMedia] = useState<string | null>(null);
  const [libraryBulkMode, setLibraryBulkMode] = useState(false);
  const [libraryBulkSelected, setLibraryBulkSelected] = useState<string[]>([]);
  const [libraryBulkDeleting, setLibraryBulkDeleting] = useState(false);
  const [libraryCategory, setLibraryCategory] = useState<MediaLibraryCategory>("all");

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const [assetResponse, imageResponse, jobResponse, projectResponse, externalResponse] = await Promise.all([
          fetch(`${bridgeUrl}/api/library`, { cache: "no-store" }),
          fetch(`${bridgeUrl}/api/image-jobs?limit=200`, { cache: "no-store" }),
          fetch(`${bridgeUrl}/api/jobs?limit=40`, { cache: "no-store" }),
          fetch(`${bridgeUrl}/api/projects`, { cache: "no-store" }),
          fetch(`${bridgeUrl}/api/external-media`, { cache: "no-store" }),
        ]);
        const assetPayload = (await assetResponse.json()) as { assets?: CreativeAsset[] };
        const imagePayload = (await imageResponse.json()) as { jobs?: ImagePickerJob[]; error?: string };
        const jobPayload = (await jobResponse.json()) as { jobs?: RemoteJob[] };
        const projectPayload = (await projectResponse.json()) as { projects?: ProjectSummary[] };
        const externalPayload = (await externalResponse.json()) as { assets?: ExternalMediaAsset[] };
        const timelineLists = await Promise.all((projectPayload.projects ?? []).map(async (project) => {
          const response = await fetch(`${bridgeUrl}/api/projects/${project.id}/timelines`, { cache: "no-store" });
          const payload = (await response.json()) as { timelines?: ProjectTimelineSummary[] };
          return payload.timelines ?? [];
        }));
        const timelineDetails = await Promise.all(timelineLists.flat().map(async (timeline) => {
          const response = await fetch(`${bridgeUrl}/api/timelines/${timeline.id}`, { cache: "no-store" });
          const payload = (await response.json()) as { timeline?: TimelineDetail };
          return payload.timeline ?? null;
        }));
        if (!imageResponse.ok) throw new Error(imagePayload.error ?? `Bridge HTTP ${imageResponse.status}`);
        if (disposed) return;
        setAssets(assetPayload.assets ?? []);
        setImageJobs(imagePayload.jobs ?? []);
        setJobs(jobPayload.jobs ?? []);
        setExternalAssets(externalPayload.assets ?? []);
        setMontages(timelineDetails.filter((item): item is TimelineDetail => Boolean(item)));
        setMessage("Asset pronti: scegli cosa riutilizzare senza nuovi upload");
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : "Libreria media non disponibile");
      }
    };
    void load();
    return () => { disposed = true; };
  }, []);

  async function useAsset(asset: CreativeAsset) {
    const response = await fetch(`${bridgeUrl}/api/library/${asset.id}`, { cache: "no-store" });
    const payload = (await response.json()) as { asset?: CreativeAsset; error?: string };
    if (!response.ok || !payload.asset) {
      setMessage(payload.error ?? "Asset non disponibile");
      return;
    }
    onUseReferences(payload.asset, payload.asset.references ?? []);
  }

  async function removeLibraryVideo(job: RemoteJob, candidateIndex: number) {
    const result = await requestCandidateDeletion(job.id, candidateIndex);
    setJobs((current) => current.flatMap((item) => {
      if (item.id !== job.id) return [item];
      const candidates = item.candidates.filter((candidate) => candidate.index !== candidateIndex);
      return result.jobDeleted ? [] : [{ ...item, candidates }];
    }));
    setMontages((current) => current.map((timeline) => {
      const clips = timeline.clips.filter((clip) => !(
        clip.sourceJobId === job.id && clip.sourceCandidateIndex === candidateIndex
      ));
      return { ...timeline, clips, clipCount: clips.length };
    }));
    onVideoDeleted(job.id, candidateIndex, result);
    return result;
  }
  async function deleteVideo(job: RemoteJob, candidateIndex: number) {
    const key = `${job.id}-${candidateIndex}`;
    if (!window.confirm(
      "Eliminare definitivamente questo video? Verrà rimosso anche da tutti i montaggi e saranno cancellate le sue varianti Face/Upscale.",
    )) return;
    setDeletingVideo(key);
    setMessage("Eliminazione video e collegamenti ai montaggi…");
    try {
      const result = await removeLibraryVideo(job, candidateIndex);
      setLibraryBulkSelected((current) => current.filter((item) => item !== `video:${job.id}:${candidateIndex}`));

      setMessage(
        `Video eliminato · ${result.removedClips} clip rimosse dai montaggi` +
          (result.warnings.length ? ` · ${result.warnings.join(" · ")}` : ""),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Eliminazione fallita");
    } finally {
      setDeletingVideo(null);
    }
  }

  async function deleteExternalMedia(asset: ExternalMediaAsset) {
    if (!window.confirm(
      `Rimuovere “${asset.originalName}” dalla Libreria? Il file già copiato in ComfyUI non verrà cancellato.`,
    )) return;
    try {
      const response = await fetch(`${bridgeUrl}/api/external-media/${asset.id}/delete`, {
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setExternalAssets((current) => current.filter((item) => item.id !== asset.id));
      setLibraryBulkSelected((current) => current.filter((item) => item !== `external:${asset.id}`));
      setMessage(`“${asset.originalName}” rimossa dalla Libreria`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rimozione media esterno fallita");
    }
  }

  async function renameTimeline(timeline: TimelineDetail) {
    const name = window.prompt("Nuovo nome del montaggio", timeline.name)?.trim();
    if (!name || name === timeline.name) return;
    setRenamingMedia(`timeline:${timeline.id}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/timelines/${timeline.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as { timeline?: TimelineDetail; error?: string };
      if (!response.ok || !payload.timeline) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setMontages((current) => current.map((item) => item.id === timeline.id ? payload.timeline! : item));
      setMessage(`Montaggio rinominato “${payload.timeline.name}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rinomina montaggio fallita");
    } finally {
      setRenamingMedia(null);
    }
  }
  async function removeTimeline(timeline: TimelineDetail) {
    const response = await fetch(`${bridgeUrl}/api/timelines/${timeline.id}`, {
      method: "DELETE",
    });
    const payload = await response.json() as {
      deletion?: { id: string; projectId: string; name: string; removedClips: number };
      error?: string;
    };
    if (!response.ok || !payload.deletion) {
      throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    }
    setMontages((current) => current.filter((item) => item.id !== timeline.id));
    return payload.deletion;
  }

  async function deleteTimelineFromLibrary(timeline: TimelineDetail) {
    if (!window.confirm(
      `Eliminare definitivamente il montaggio “${timeline.name}”?\n\nLe clip verranno scollegate, ma tutti i video sorgente resteranno nel progetto e nella Libreria.`,
    )) return;
    setDeletingTimeline(timeline.id);
    try {
      const deletion = await removeTimeline(timeline);
      setLibraryBulkSelected((current) => current.filter((item) => item !== `timeline:${timeline.id}`));
      setMessage(`Montaggio “${timeline.name}” eliminato · ${deletion.removedClips} clip scollegate · video sorgente conservati`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Eliminazione montaggio fallita");
    } finally {
      setDeletingTimeline(null);
    }
  }
  async function renameCreativeAsset(asset: CreativeAsset) {
    const name = window.prompt("Nuovo nome dell'asset", asset.name)?.trim();
    if (!name || name === asset.name) return;
    setRenamingMedia(`creative:${asset.id}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/library/${asset.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as { asset?: CreativeAsset; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setAssets((current) => current.map((item) => item.id === asset.id ? payload.asset! : item));
      setMessage(`Asset rinominato “${payload.asset.name}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rinomina asset fallita");
    } finally {
      setRenamingMedia(null);
    }
  }

  async function renameExternalMedia(asset: ExternalMediaAsset) {
    const name = window.prompt("Nuovo nome del media", asset.originalName)?.trim();
    if (!name || name === asset.originalName) return;
    setRenamingMedia(`external:${asset.id}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/external-media/${asset.id}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as { asset?: ExternalMediaAsset; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setExternalAssets((current) => current.map((item) => item.id === asset.id ? payload.asset! : item));
      setMessage(`Media rinominato “${payload.asset.originalName}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rinomina media fallita");
    } finally {
      setRenamingMedia(null);
    }
  }

  async function renameVideo(job: RemoteJob, candidate: RemoteJob["candidates"][number]) {
    const currentName = candidate.displayName ?? `Video ${job.id.slice(0, 8)} · candidato ${candidate.index}`;
    const name = window.prompt("Nuovo nome del video", currentName)?.trim();
    if (!name || name === currentName) return;
    const key = `video:${job.id}:${candidate.index}`;
    setRenamingMedia(key);
    try {
      const response = await fetch(`${bridgeUrl}/api/jobs/${job.id}/candidates/${candidate.index}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as { job?: RemoteJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setJobs((current) => current.map((item) => item.id === job.id ? payload.job! : item));
      setMessage(`Video rinominato “${name}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rinomina video fallita");
    } finally {
      setRenamingMedia(null);
    }
  }
  async function renameGeneratedImage(image: AssetLibraryImage) {
    if (!image.jobId || image.candidateIndex === undefined) return;
    const name = window.prompt("Nuovo nome dell'immagine", image.name)?.trim();
    if (!name || name === image.name) return;
    const key = `image:${image.jobId}:${image.candidateIndex}`;
    setRenamingMedia(key);
    try {
      const response = await fetch(`${bridgeUrl}/api/image-jobs/${image.jobId}/candidates/${image.candidateIndex}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as { job?: ImagePickerJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setImageJobs((current) => current.map((job) => job.id === image.jobId ? payload.job! : job));
      setMessage(`Immagine rinominata “${name}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rinomina immagine fallita");
    } finally {
      setRenamingMedia(null);
    }
  }

  async function removeGeneratedImage(image: AssetLibraryImage) {
    if (!image.jobId || image.candidateIndex === undefined) throw new Error("Immagine non valida");
    const response = await fetch(`${bridgeUrl}/api/image-jobs/${image.jobId}/candidates/${image.candidateIndex}/delete`, {
      method: "POST",
    });
    const payload = await response.json() as { error?: string; jobDeleted?: boolean; job?: ImagePickerJob | null };
    if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    setImageJobs((current) => {
      if (payload.jobDeleted) return current.filter((job) => job.id !== image.jobId);
      if (payload.job) return current.map((job) => job.id === image.jobId ? payload.job! : job);
      return current.map((job) => job.id === image.jobId
        ? { ...job, candidates: job.candidates.filter((candidate) => candidate.index !== image.candidateIndex) }
        : job);
    });
  }

  async function deleteGeneratedImage(image: AssetLibraryImage) {
    if (!window.confirm(`Eliminare definitivamente “${image.name}” da Assets e Libreria?`)) return;
    const key = `image:${image.jobId}:${image.candidateIndex}`;
    setDeletingVideo(key);
    try {
      await removeGeneratedImage(image);
      setLibraryBulkSelected((current) => current.filter((item) => item !== key));
      setMessage(`“${image.name}” eliminata da Assets e Libreria`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Eliminazione immagine fallita");
    } finally {
      setDeletingVideo(null);
    }
  }

  function toggleLibraryBulk(key: string) {
    setLibraryBulkSelected((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
  }

  function closeLibraryBulk() {
    setLibraryBulkMode(false);
    setLibraryBulkSelected([]);
  }

  async function deleteLibrarySelection() {
    if (!libraryBulkSelected.length) return;
    if (!window.confirm(
      `Eliminare definitivamente ${libraryBulkSelected.length} elementi selezionati? I video eliminati saranno rimossi dai montaggi; eliminare un montaggio non cancella i suoi video sorgente.`,
    )) return;
    setLibraryBulkDeleting(true);
    setMessage(`Eliminazione di ${libraryBulkSelected.length} elementi…`);
    const failed: string[] = [];
    let deleted = 0;
    let removedClips = 0;
    for (const key of libraryBulkSelected) {
      try {
        if (key.startsWith("creative:")) {
          const id = key.slice("creative:".length);
          const response = await fetch(`${bridgeUrl}/api/library/${id}/delete`, { method: "POST" });
          const payload = await response.json() as { error?: string };
          if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
          setAssets((current) => current.filter((item) => item.id !== id));
        } else if (key.startsWith("image:")) {
          const [, jobId, indexValue] = key.split(":");
          const image = generatedImages.find((item) => item.jobId === jobId && item.candidateIndex === Number(indexValue));
          if (!image) throw new Error("Immagine selezionata non trovata");
          await removeGeneratedImage(image);
        } else if (key.startsWith("timeline:")) {
          const id = key.slice("timeline:".length);
          const timeline = montages.find((item) => item.id === id);
          if (!timeline) throw new Error("Montaggio selezionato non trovato");
          const deletion = await removeTimeline(timeline);
          removedClips += deletion.removedClips;
        } else if (key.startsWith("external:")) {
          const id = key.slice("external:".length);
          const response = await fetch(`${bridgeUrl}/api/external-media/${id}/delete`, { method: "POST" });
          const payload = await response.json() as { error?: string };
          if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
          setExternalAssets((current) => current.filter((item) => item.id !== id));
        } else if (key.startsWith("video:")) {
          const [, jobId, indexValue] = key.split(":");
          const job = jobs.find((item) => item.id === jobId);
          const candidateIndex = Number(indexValue);
          if (!job || !Number.isInteger(candidateIndex)) throw new Error("Video selezionato non trovato");
          const result = await removeLibraryVideo(job, candidateIndex);
          removedClips += result.removedClips;
        } else {
          throw new Error("Elemento selezionato non riconosciuto");
        }
        deleted += 1;
      } catch {
        failed.push(key);
      }
    }
    setLibraryBulkSelected(failed);
    setLibraryBulkMode(failed.length > 0);
    setLibraryBulkDeleting(false);
    setMessage(`${deleted} elementi eliminati${removedClips ? ` · ${removedClips} clip rimosse dai montaggi` : ""}${failed.length ? ` · ${failed.length} non eliminati` : ""}`);
  }
  const generatedImages = useMemo(() => generatedAssetImages(imageJobs), [imageJobs]);
  const taggedGeneratedImages = generatedImages.filter((image) => image.tag !== "untagged");
  const untaggedGeneratedImages = generatedImages.filter((image) => image.tag === "untagged");
  const videos = jobs.flatMap((job) =>
    job.candidates.filter((candidate) => candidate.output).map((candidate) => ({ job, candidate })),
  );
  const libraryCategoryOptions: Array<{ value: MediaLibraryCategory; label: string; count: number }> = [
    {
      value: "all",
      label: "Tutto",
      count: montages.length + assets.length + generatedImages.length + externalAssets.length + videos.length,
    },
    { value: "montages", label: "Montaggi", count: montages.length },
    { value: "assets", label: "Asset", count: assets.length + taggedGeneratedImages.length },
    { value: "images", label: "Immagini", count: untaggedGeneratedImages.length },
    { value: "external", label: "Esterni", count: externalAssets.length },
    { value: "videos", label: "Video", count: videos.length },
  ];

  return (
    <section className="media-library-panel">
      <div className="history-heading">
        <div><span className="section-index">LIBRERIA</span><h2>Tutti i media</h2><p>{message}</p></div>
        <div className="bulk-selection-actions">
          {libraryBulkMode ? <>
            <span>{libraryBulkSelected.length} selezionati</span>
            <button className="danger" disabled={!libraryBulkSelected.length || libraryBulkDeleting} onClick={() => void deleteLibrarySelection()} type="button">{libraryBulkDeleting ? "Eliminazione…" : "Elimina selezionati"}</button>
            <button disabled={libraryBulkDeleting} onClick={closeLibraryBulk} type="button">Annulla</button>
          </> : <button onClick={() => setLibraryBulkMode(true)} type="button">Seleziona</button>}
        </div>
      </div>

      <nav aria-label="Filtra la Libreria per categoria" className="media-library-category-filter">
        {libraryCategoryOptions.map((option) => (
          <button
            aria-pressed={libraryCategory === option.value}
            className={libraryCategory === option.value ? "active" : ""}
            key={option.value}
            onClick={() => setLibraryCategory(option.value)}
            type="button"
          >
            <span>{option.label}</span>
            <strong>{option.count}</strong>
          </button>
        ))}
      </nav>

      {(libraryCategory === "all" || libraryCategory === "montages") && <section className="media-library-section">
        <div><h3>Montaggi</h3><span>{montages.length} timeline</span></div>
        <div className="media-library-grid">
          {montages.map((timeline) => (
            <article className={libraryBulkSelected.includes(`timeline:${timeline.id}`) ? "bulk-selected" : ""} key={timeline.id}>
              <div className="media-library-preview">
                {timeline.clips[0] ? <video muted playsInline preload="metadata" src={`${bridgeUrl}${timeline.clips[0].output.mediaPath}`} /> : <span>≋</span>}
                {libraryBulkMode && <button aria-label={`Seleziona ${timeline.name}`} aria-pressed={libraryBulkSelected.includes(`timeline:${timeline.id}`)} className="bulk-select-button" onClick={() => toggleLibraryBulk(`timeline:${timeline.id}`)} type="button">{libraryBulkSelected.includes(`timeline:${timeline.id}`) ? "✓" : ""}</button>}
                <button aria-label={`Rinomina ${timeline.name}`} className="media-rename-button" disabled={renamingMedia === `timeline:${timeline.id}`} onClick={() => void renameTimeline(timeline)} title="Rinomina montaggio" type="button">✎</button>
                <button aria-label={`Elimina ${timeline.name}`} className="video-trash-button" disabled={deletingTimeline === timeline.id} onClick={() => void deleteTimelineFromLibrary(timeline)} title="Elimina montaggio; conserva i video sorgente" type="button">🗑</button>
              </div>
              <div><strong>{timeline.name}</strong><small>{timeline.projectName} · {timeline.clipCount} clip</small></div>
              <button onClick={() => onOpenMontage(timeline.projectId, timeline.id)} type="button">Apri montaggio</button>
            </article>
          ))}
          {!montages.length && <div className="media-library-empty">Nessun montaggio disponibile</div>}
        </div>
      </section>}

      {(libraryCategory === "all" || libraryCategory === "assets") && <section className="media-library-section">
        <div><h3>Personaggi, oggetti e luoghi</h3><span>{assets.length + taggedGeneratedImages.length} asset</span></div>
        <div className="media-library-grid">
          {assets.map((asset) => (
            <article className={libraryBulkSelected.includes(`creative:${asset.id}`) ? "bulk-selected" : ""} key={asset.id}>
              <div className="media-library-preview">
                {asset.hero ? <img alt="" src={`${bridgeUrl}${asset.hero.mediaPath}`} /> : <span>{asset.kind === "character" ? "◎" : "◇"}</span>}
                {libraryBulkMode && <button aria-label={`Seleziona ${asset.name}`} aria-pressed={libraryBulkSelected.includes(`creative:${asset.id}`)} className="bulk-select-button" onClick={() => toggleLibraryBulk(`creative:${asset.id}`)} type="button">{libraryBulkSelected.includes(`creative:${asset.id}`) ? "✓" : ""}</button>}
                <button aria-label={`Rinomina ${asset.name}`} className="media-rename-button" disabled={renamingMedia === `creative:${asset.id}`} onClick={() => void renameCreativeAsset(asset)} title="Rinomina asset" type="button">✎</button>
              </div>
              <div><strong>{asset.name}</strong><small>{asset.kind === "character" ? "Personaggio" : "Oggetto"} · {asset.referenceCount} reference</small></div>
              <button disabled={!asset.referenceCount} onClick={() => void useAsset(asset)} type="button">Usa nello Studio</button>
            </article>
          ))}
          {taggedGeneratedImages.map((image) => {
            const key = `image:${image.jobId}:${image.candidateIndex}`;
            const typeLabel = image.tag === "character" ? "Personaggio" : image.tag === "object" ? "Oggetto" : "Luogo";
            return (
              <article className={libraryBulkSelected.includes(key) ? "bulk-selected" : ""} key={image.id}>
                <div className="media-library-preview">
                  <img alt={image.name} src={`${bridgeUrl}${image.mediaPath}`} />
                  {libraryBulkMode && <button aria-label={`Seleziona ${image.name}`} aria-pressed={libraryBulkSelected.includes(key)} className="bulk-select-button" onClick={() => toggleLibraryBulk(key)} type="button">{libraryBulkSelected.includes(key) ? "✓" : ""}</button>}
                  <button aria-label={`Rinomina ${image.name}`} className="media-rename-button" disabled={renamingMedia === key} onClick={() => void renameGeneratedImage(image)} title="Rinomina immagine" type="button">✎</button>
                  <button aria-label={`Elimina ${image.name}`} className="video-trash-button" disabled={deletingVideo === key} onClick={() => void deleteGeneratedImage(image)} title="Elimina da Assets e Libreria" type="button">🗑</button>
                </div>
                <div><strong>{image.name}</strong><small>{typeLabel} · {image.projectName ?? "Condiviso"}</small></div>
                <button onClick={() => onUseImage(image)} type="button">Manda a Studio<span>Allegato immagine</span></button>
              </article>
            );
          })}
          {!assets.length && !taggedGeneratedImages.length && <div className="media-library-empty">Nessun personaggio, oggetto o luogo</div>}
        </div>
      </section>}

      {(libraryCategory === "all" || libraryCategory === "images") && (
        <section className="media-library-section">
          <div><h3>Immagini senza tag</h3><span>{untaggedGeneratedImages.length} immagini</span></div>
          <div className="media-library-grid">
            {untaggedGeneratedImages.map((image) => {
              const key = `image:${image.jobId}:${image.candidateIndex}`;
              return (
                <article className={libraryBulkSelected.includes(key) ? "bulk-selected" : ""} key={image.id}>
                  <div className="media-library-preview">
                    <img alt={image.name} src={`${bridgeUrl}${image.mediaPath}`} />
                    {libraryBulkMode && <button aria-label={`Seleziona ${image.name}`} aria-pressed={libraryBulkSelected.includes(key)} className="bulk-select-button" onClick={() => toggleLibraryBulk(key)} type="button">{libraryBulkSelected.includes(key) ? "✓" : ""}</button>}
                    <button aria-label={`Rinomina ${image.name}`} className="media-rename-button" disabled={renamingMedia === key} onClick={() => void renameGeneratedImage(image)} title="Rinomina immagine" type="button">✎</button>
                    <button aria-label={`Elimina ${image.name}`} className="video-trash-button" disabled={deletingVideo === key} onClick={() => void deleteGeneratedImage(image)} title="Elimina da Assets e Libreria" type="button">🗑</button>
                  </div>
                  <div><strong>{image.name}</strong><small>Immagine · {image.projectName ?? "Senza progetto"}</small></div>
                  <button onClick={() => onUseImage(image)} type="button">Manda a Studio<span>Allegato immagine</span></button>
                </article>
              );
            })}
            {!untaggedGeneratedImages.length && <div className="media-library-empty">Nessuna immagine senza tag</div>}
          </div>
        </section>
      )}
      {(libraryCategory === "all" || libraryCategory === "external") && <section className="media-library-section">
        <div><h3>Esterni</h3><span>{externalAssets.length} media</span></div>
        <div className="media-library-grid">
          {externalAssets.map((asset) => (
            <article className={libraryBulkSelected.includes(`external:${asset.id}`) ? "bulk-selected" : ""} key={asset.id}>
              <div className="media-library-preview">
                {asset.kind === "picture" ? (
                  <img alt="" src={`${bridgeUrl}${asset.mediaPath}`} />
                ) : asset.kind === "video" ? (
                  <video muted playsInline preload="metadata" src={`${bridgeUrl}${asset.mediaPath}`} />
                ) : (
                  <audio controls preload="metadata" src={`${bridgeUrl}${asset.mediaPath}`} />
                )}
                {libraryBulkMode && <button aria-label={`Seleziona ${asset.originalName}`} aria-pressed={libraryBulkSelected.includes(`external:${asset.id}`)} className="bulk-select-button" onClick={() => toggleLibraryBulk(`external:${asset.id}`)} type="button">{libraryBulkSelected.includes(`external:${asset.id}`) ? "✓" : ""}</button>}
                <button aria-label={`Rinomina ${asset.originalName}`} className="media-rename-button" disabled={renamingMedia === `external:${asset.id}`} onClick={() => void renameExternalMedia(asset)} title="Rinomina media" type="button">✎</button>
                <button
                  aria-label={`Rimuovi ${asset.originalName} dalla Libreria`}
                  className="video-trash-button"
                  onClick={() => void deleteExternalMedia(asset)}
                  title="Rimuovi dalla Libreria senza cancellare il file ComfyUI"
                  type="button"
                >
                  🗑
                </button>
              </div>
              <div>
                <strong>{asset.originalName}</strong>
                <small>Esterno · {asset.originProjectName ?? "Condiviso"}</small>
              </div>
              <button onClick={() => onUseExternal(asset)} type="button">
                Manda a Studio
                <span>Allegato {asset.kind === "picture" ? "immagine" : asset.kind}</span>
              </button>
            </article>
          ))}
          {!externalAssets.length && <div className="media-library-empty">Nessun media esterno caricato</div>}
        </div>
      </section>}

      {(libraryCategory === "all" || libraryCategory === "videos") && <section className="media-library-section">
        <div><h3>Video generati</h3><span>{videos.length} video</span></div>
        <div className="media-library-grid">
          {videos.slice(0, 36).map(({ job, candidate }) => (
            <article className={libraryBulkSelected.includes(`video:${job.id}:${candidate.index}`) ? "bulk-selected" : ""} key={`${job.id}-${candidate.index}`}>
              <div className="media-library-preview">
                <video muted playsInline preload="metadata" src={`${bridgeUrl}${candidate.output!.mediaPath}`} />
                {libraryBulkMode && <button aria-label={`Seleziona video ${candidate.index}`} aria-pressed={libraryBulkSelected.includes(`video:${job.id}:${candidate.index}`)} className="bulk-select-button" onClick={() => toggleLibraryBulk(`video:${job.id}:${candidate.index}`)} type="button">{libraryBulkSelected.includes(`video:${job.id}:${candidate.index}`) ? "✓" : ""}</button>}
                <button aria-label={`Rinomina video ${candidate.index}`} className="media-rename-button" disabled={renamingMedia === `video:${job.id}:${candidate.index}`} onClick={() => void renameVideo(job, candidate)} title="Rinomina video" type="button">✎</button>
                <button
                  aria-label={`Elimina candidato ${candidate.index}`}
                  className="video-trash-button"
                  disabled={deletingVideo === `${job.id}-${candidate.index}`}
                  onClick={() => void deleteVideo(job, candidate.index)}
                  title="Elimina video e rimuovilo dai montaggi"
                  type="button"
                >
                  🗑
                </button>
              </div>
              <div><strong>{candidate.displayName ?? `Video ${job.id.slice(0, 8)} · candidato ${candidate.index}`}</strong><small>{job.projectName ?? "Senza progetto"}</small></div>
              <button onClick={() => onUseVideo(job, candidate)} type="button">
                Manda a Studio
                <span>Allegato video</span>
              </button>
            </article>
          ))}
          {!videos.length && <div className="media-library-empty">Nessun video completato</div>}
        </div>
      </section>}
    </section>
  );
}

function AssetLibraryPanel({
  initialKind,
  onSendToStudio,
}: {
  initialKind: "all" | "character" | "object";
  onSendToStudio: (images: AssetLibraryImage[]) => void;
}) {
  type AssetFilter = "all" | ImageProjectTag;
  const [filter, setFilter] = useState<AssetFilter>(initialKind);
  const [query, setQuery] = useState("");
  const [imageJobs, setImageJobs] = useState<ImagePickerJob[]>([]);
  const [legacyAssets, setLegacyAssets] = useState<CreativeAsset[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("Caricamento immagini…");
  const [dragging, setDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<AssetLibraryImage | null>(null);
  const [previewZoomed, setPreviewZoomed] = useState(false);
  const [deletingImageId, setDeletingImageId] = useState<string | null>(null);
  const [renamingImageId, setRenamingImageId] = useState<string | null>(null);
  const [assetBulkMode, setAssetBulkMode] = useState(false);
  const [assetBulkSelected, setAssetBulkSelected] = useState<string[]>([]);
  const [assetBulkDeleting, setAssetBulkDeleting] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const [imageResponse, assetResponse] = await Promise.all([
          fetch(`${bridgeUrl}/api/image-jobs?limit=200`, { cache: "no-store" }),
          fetch(`${bridgeUrl}/api/library`, { cache: "no-store" }),
        ]);
        const imagePayload = (await imageResponse.json()) as {
          jobs?: ImagePickerJob[];
          error?: string;
        };
        const assetPayload = (await assetResponse.json()) as {
          assets?: CreativeAsset[];
          error?: string;
        };
        if (!imageResponse.ok) {
          throw new Error(imagePayload.error ?? `Bridge HTTP ${imageResponse.status}`);
        }
        if (!assetResponse.ok) {
          throw new Error(assetPayload.error ?? `Bridge HTTP ${assetResponse.status}`);
        }
        const details = await Promise.all(
          (assetPayload.assets ?? []).map(async (asset) => {
            const response = await fetch(`${bridgeUrl}/api/library/${asset.id}`, {
              cache: "no-store",
            });
            if (!response.ok) return asset;
            const payload = (await response.json()) as { asset?: CreativeAsset };
            return payload.asset ?? asset;
          }),
        );
        if (disposed) return;
        setImageJobs(imagePayload.jobs ?? []);
        setLegacyAssets(details);
        setMessage("Seleziona fino a quattro immagini oppure trascinale nel box");
      } catch (error) {
        if (!disposed) {
          setMessage(
            error instanceof Error ? error.message : "Assets non disponibili",
          );
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    setFilter(initialKind);
  }, [initialKind]);

  useEffect(() => {
    if (!previewImage) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewImage]);

  const images = useMemo(() => {
    const collected = generatedAssetImages(imageJobs);
    const seen = new Set(collected.map((image) => image.file.toLowerCase()));
    for (const asset of legacyAssets) {
      for (const reference of asset.references ?? []) {
        const key = reference.file.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({
          id: `legacy:${reference.id}`,
          name: `${asset.name} · ${reference.label}`,
          detail: asset.description || reference.role.replaceAll("_", " "),
          file: reference.file,
          mediaPath: reference.mediaPath,
          width: reference.width,
          height: reference.height,
          tag: asset.kind,
          source: "legacy",
          assetId: asset.id,
          referenceId: reference.id,
        });
      }
    }
    return collected;
  }, [imageJobs, legacyAssets]);

  useEffect(() => {
    const available = new Set(images.map((image) => image.id));
    setSelectedIds((current) => current.filter((id) => available.has(id)));
  }, [images]);

  const visibleImages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return images.filter((image) => {
      if (filter !== "all" && image.tag !== filter) return false;
      if (!normalizedQuery) return true;
      return `${image.name} ${image.detail} ${image.projectName ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [filter, images, query]);

  const selectedImages = selectedIds.flatMap((id) => {
    const image = images.find((item) => item.id === id);
    return image ? [image] : [];
  });

  function toggleSelection(id: string) {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 4) {
        setMessage("Flux Klein accetta al massimo quattro immagini");
        return current;
      }
      return [...current, id];
    });
  }

  function addDroppedSelection(id: string) {
    if (!id || selectedIds.includes(id)) return;
    toggleSelection(id);
  }

  function openImagePreview(image: AssetLibraryImage) {
    setPreviewZoomed(false);
    setPreviewImage(image);
  }

  async function renameAssetImage(image: AssetLibraryImage) {
    const currentName = image.source === "legacy"
      ? legacyAssets.find((asset) => asset.id === image.assetId)?.name ?? image.name
      : image.name;
    const name = window.prompt("Nuovo nome dell'immagine", currentName)?.trim();
    if (!name || name === currentName) return;
    setRenamingImageId(image.id);
    try {
      if (image.source === "image-studio" && image.jobId && image.candidateIndex !== undefined) {
        const response = await fetch(`${bridgeUrl}/api/image-jobs/${image.jobId}/candidates/${image.candidateIndex}/rename`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const payload = await response.json() as { job?: ImagePickerJob; error?: string };
        if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
        setImageJobs((current) => current.map((job) => job.id === image.jobId ? payload.job! : job));
      } else if (image.assetId) {
        const response = await fetch(`${bridgeUrl}/api/library/${image.assetId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const payload = await response.json() as { asset?: CreativeAsset; error?: string };
        if (!response.ok || !payload.asset) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
        setLegacyAssets((current) => current.map((asset) => asset.id === image.assetId ? payload.asset! : asset));
      } else {
        throw new Error("Origine dell'asset non riconosciuta");
      }
      if (previewImage?.id === image.id) setPreviewImage(null);
      setMessage(`Immagine rinominata “${name}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rinomina immagine fallita");
    } finally {
      setRenamingImageId(null);
    }
  }
  async function deleteAssetImage(image: AssetLibraryImage) {
    const confirmed = window.confirm(
      `Eliminare definitivamente “${image.name}” dagli Assets? Non sarà più disponibile nei progetti e nei picker dello Studio.`,
    );
    if (!confirmed) return;
    setDeletingImageId(image.id);
    setMessage(`Eliminazione di ${image.name}…`);
    try {
      const endpoint = image.source === "image-studio"
        ? `/api/image-jobs/${image.jobId}/candidates/${image.candidateIndex}/delete`
        : `/api/library-references/${image.referenceId}/delete`;
      const response = await fetch(`${bridgeUrl}${endpoint}`, { method: "POST" });
      const payload = (await response.json()) as {
        error?: string;
        jobDeleted?: boolean;
        job?: ImagePickerJob | null;
        asset?: CreativeAsset;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      if (image.source === "image-studio" && image.jobId) {
        setImageJobs((current) => {
          if (payload.jobDeleted) return current.filter((job) => job.id !== image.jobId);
          if (payload.job) {
            return current.map((job) => job.id === image.jobId ? payload.job! : job);
          }
          return current.map((job) => job.id === image.jobId
            ? { ...job, candidates: job.candidates.filter((candidate) => candidate.index !== image.candidateIndex) }
            : job);
        });
      } else if (image.referenceId) {
        setLegacyAssets((current) => payload.asset
          ? current.map((asset) => asset.id === payload.asset!.id ? payload.asset! : asset)
          : current.map((asset) => ({
              ...asset,
              references: (asset.references ?? []).filter((reference) => reference.id !== image.referenceId),
            })));
      }
      setSelectedIds((current) => current.filter((id) => id !== image.id));
      setAssetBulkSelected((current) => current.filter((id) => id !== image.id));
      if (previewImage?.id === image.id) setPreviewImage(null);
      setMessage(`${image.name} rimossa dagli Assets`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Eliminazione immagine fallita");
    } finally {
      setDeletingImageId(null);
    }
  }

  function toggleAssetBulk(id: string) {
    setAssetBulkSelected((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  }

  function closeAssetBulk() {
    setAssetBulkMode(false);
    setAssetBulkSelected([]);
  }

  async function deleteAssetSelection() {
    if (!assetBulkSelected.length) return;
    if (!window.confirm(`Eliminare definitivamente ${assetBulkSelected.length} immagini selezionate dagli Assets?`)) return;
    setAssetBulkDeleting(true);
    setMessage(`Eliminazione di ${assetBulkSelected.length} immagini…`);
    const failed: string[] = [];
    let deleted = 0;
    for (const id of assetBulkSelected) {
      const image = images.find((item) => item.id === id);
      if (!image) continue;
      try {
        const endpoint = image.source === "image-studio"
          ? `/api/image-jobs/${image.jobId}/candidates/${image.candidateIndex}/delete`
          : `/api/library-references/${image.referenceId}/delete`;
        const response = await fetch(`${bridgeUrl}${endpoint}`, { method: "POST" });
        const payload = await response.json() as {
          error?: string; jobDeleted?: boolean; job?: ImagePickerJob | null; asset?: CreativeAsset;
        };
        if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
        if (image.source === "image-studio" && image.jobId) {
          setImageJobs((current) => {
            if (payload.jobDeleted) return current.filter((job) => job.id !== image.jobId);
            if (payload.job) return current.map((job) => job.id === image.jobId ? payload.job! : job);
            return current.map((job) => job.id === image.jobId
              ? { ...job, candidates: job.candidates.filter((candidate) => candidate.index !== image.candidateIndex) }
              : job);
          });
        } else if (image.referenceId) {
          setLegacyAssets((current) => payload.asset
            ? current.map((asset) => asset.id === payload.asset!.id ? payload.asset! : asset)
            : current.map((asset) => ({
                ...asset,
                references: (asset.references ?? []).filter((reference) => reference.id !== image.referenceId),
              })));
        }
        setSelectedIds((current) => current.filter((selectedId) => selectedId !== image.id));
        if (previewImage?.id === image.id) setPreviewImage(null);
        deleted += 1;
      } catch {
        failed.push(id);
      }
    }
    setAssetBulkSelected(failed);
    setAssetBulkMode(failed.length > 0);
    setAssetBulkDeleting(false);
    setMessage(`${deleted} immagini eliminate${failed.length ? ` · ${failed.length} non eliminate` : ""}`);
  }
  const filterOptions: Array<{ value: AssetFilter; label: string }> = [
    { value: "all", label: "Tutte" },
    { value: "character", label: "Personaggi" },
    { value: "object", label: "Oggetti" },
    { value: "background", label: "Luoghi" },
    { value: "untagged", label: "Senza tag" },
  ];

  return (
    <section className="asset-library-panel">
      <div className="library-heading">
        <div>
          <span className="section-index">ASSETS</span>
          <h2>Immagini riutilizzabili</h2>
          <p>{message}</p>
        </div>
        <div className="bulk-selection-actions">
          <span className="asset-library-count">{images.length} immagini</span>
          {assetBulkMode ? <>
            <span>{assetBulkSelected.length} selezionate</span>
            <button className="danger" disabled={!assetBulkSelected.length || assetBulkDeleting} onClick={() => void deleteAssetSelection()} type="button">{assetBulkDeleting ? "Eliminazione…" : "Elimina selezionate"}</button>
            <button disabled={assetBulkDeleting} onClick={closeAssetBulk} type="button">Annulla</button>
          </> : <button onClick={() => setAssetBulkMode(true)} type="button">Seleziona</button>}
        </div>
      </div>

      <div className="asset-library-toolbar">
        <div className="library-filters" aria-label="Filtra Assets">
          {filterOptions.map((option) => (
            <button
              className={filter === option.value ? "active" : ""}
              key={option.value}
              onClick={() => setFilter(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <label>
          <span>Cerca</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Nome, prompt o progetto"
            type="search"
            value={query}
          />
        </label>
      </div>

      <div className="asset-library-workspace">
        <div className="asset-library-grid">
          {visibleImages.map((image) => {
            const selected = selectedIds.includes(image.id);
            return (
              <article
                className={`asset-library-card ${selected || assetBulkSelected.includes(image.id) ? "selected" : ""}`}
                draggable={!assetBulkMode}
                key={image.id}
                onDragEnd={() => setDragging(false)}
                onDragStart={(event) => {
                  setDragging(true);
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData("application/x-h3-asset-id", image.id);
                  event.dataTransfer.setData("text/plain", image.id);
                }}
              >
                <button
                  aria-pressed={assetBulkMode ? assetBulkSelected.includes(image.id) : selected}
                  className="asset-library-card-select"
                  onClick={() => assetBulkMode ? toggleAssetBulk(image.id) : toggleSelection(image.id)}
                  type="button"
                >
                  <div className="asset-library-thumbnail">
                    <img alt={image.name} src={`${bridgeUrl}${image.mediaPath}`} />
                    <span>{assetBulkMode ? (assetBulkSelected.includes(image.id) ? "✓ Da eliminare" : "Seleziona") : selected ? "✓ Selezionata" : image.tag === "background" ? "Luogo" : image.tag === "untagged" ? "Immagine" : image.tag === "character" ? "Personaggio" : "Oggetto"}</span>
                  </div>
                  <strong>{image.name}</strong>
                  <small>{image.projectName ?? (image.source === "legacy" ? "Asset precedente" : "Senza progetto")}</small>
                  <p>{image.detail}</p>
                </button>
                <div className="asset-library-card-actions">
                  <button aria-label={`Rinomina ${image.name}`} disabled={renamingImageId === image.id} onClick={() => void renameAssetImage(image)} title="Rinomina" type="button">{renamingImageId === image.id ? "…" : "✎"}</button>
                  <button
                    aria-label={`Ingrandisci ${image.name}`}
                    onClick={() => openImagePreview(image)}
                    title="Ingrandisci"
                    type="button"
                  >
                    ⛶
                  </button>
                  <button
                    aria-label={`Elimina ${image.name}`}
                    className="danger"
                    disabled={deletingImageId === image.id}
                    onClick={() => void deleteAssetImage(image)}
                    title="Elimina dagli Assets"
                    type="button"
                  >
                    {deletingImageId === image.id ? "…" : "⌫"}
                  </button>
                </div>
              </article>
            );
          })}
          {!visibleImages.length && (
            <div className="media-library-empty">
              Nessuna immagine corrisponde al filtro.
            </div>
          )}
        </div>

        <aside
          className={`asset-studio-dropzone ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addDroppedSelection(
              event.dataTransfer.getData("application/x-h3-asset-id") ||
                event.dataTransfer.getData("text/plain"),
            );
          }}
        >
          <div>
            <span className="section-index">SELEZIONE</span>
            <strong>Trascina qui le immagini</strong>
            <small>Oppure cliccale nella griglia · massimo 4</small>
          </div>
          <div className="asset-studio-selection">
            {selectedImages.map((image, index) => (
              <article key={image.id}>
                <img alt="" src={`${bridgeUrl}${image.mediaPath}`} />
                <span>{index + 1}</span>
                <button
                  aria-label={`Rimuovi ${image.name}`}
                  onClick={() => toggleSelection(image.id)}
                  type="button"
                >
                  ×
                </button>
              </article>
            ))}
            {!selectedImages.length && <p>Nessun asset selezionato</p>}
          </div>
          <button
            className="send-assets-to-studio"
            disabled={!selectedImages.length}
            onClick={() => onSendToStudio(selectedImages)}
            type="button"
          >
            Manda a Studio
            <span>
              {selectedImages.length
                ? `${selectedImages.length} allegati · Video Reference + Immagini Edit`
                : "Seleziona almeno un’immagine"}
            </span>
          </button>
        </aside>
      </div>
      {previewImage && (
        <div
          aria-label={`Anteprima ${previewImage.name}`}
          aria-modal="true"
          className="reference-lightbox asset-image-lightbox"
          onMouseDown={() => setPreviewImage(null)}
          role="dialog"
        >
          <div onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>{previewImage.name}</strong>
                <span>{previewImage.width && previewImage.height ? `${previewImage.width} × ${previewImage.height}` : "Anteprima asset"}</span>
              </div>
              <div>
                <a download href={`${bridgeUrl}${previewImage.mediaPath}${previewImage.mediaPath.includes("?") ? "&" : "?"}download=1`}>⇩ Scarica</a>
                <button onClick={() => setPreviewImage(null)} type="button">×</button>
              </div>
            </header>
            <button
              aria-label={previewZoomed ? "Adatta immagine alla finestra" : "Zoom immagine"}
              className={`asset-image-lightbox-canvas ${previewZoomed ? "zoomed" : ""}`}
              onClick={() => setPreviewZoomed((current) => !current)}
              title={previewZoomed ? "Clicca per adattare" : "Clicca per ingrandire"}
              type="button"
            >
              <img alt={previewImage.name} src={`${bridgeUrl}${previewImage.mediaPath}`} />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function CreativeLibraryPanel({
  initialKind,
  onUseReferences,
}: {
  initialKind: "all" | "character" | "object";
  onUseReferences: (asset: CreativeAsset, references: CreativeReference[]) => void;
}) {
  const [filter, setFilter] = useState(initialKind);
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<CreativeAsset | null>(null);
  const [newKind, setNewKind] = useState<"character" | "object">(
    initialKind === "object" ? "object" : "character",
  );
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [message, setMessage] = useState("Caricamento libreria…");
  const [busy, setBusy] = useState(false);
  const [kreaReady, setKreaReady] = useState<boolean | null>(null);
  const [previewReference, setPreviewReference] = useState<CreativeReference | null>(null);

  useEffect(() => {
    if (!previewReference) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewReference(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewReference]);

  async function loadAssets(nextFilter = filter) {
    const query = nextFilter === "all" ? "" : `?kind=${nextFilter}`;
    const response = await fetch(`${bridgeUrl}/api/library${query}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      assets?: CreativeAsset[];
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    const loaded = payload.assets ?? [];
    setAssets(loaded);
    setSelectedId((current) =>
      current && loaded.some((asset) => asset.id === current)
        ? current
        : loaded[0]?.id ?? "",
    );
    setMessage(loaded.length ? `${loaded.length} asset in libreria` : "Libreria vuota");
  }

  async function loadAsset(assetId: string) {
    if (!assetId) {
      setSelectedAsset(null);
      return;
    }
    const response = await fetch(`${bridgeUrl}/api/library/${assetId}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      asset?: CreativeAsset;
      error?: string;
    };
    if (!response.ok || !payload.asset) {
      throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    }
    setSelectedAsset(payload.asset);
    setAssets((current) =>
      current.map((asset) => (asset.id === payload.asset!.id ? payload.asset! : asset)),
    );
  }

  useEffect(() => {
    setFilter(initialKind);
    setNewKind(initialKind === "object" ? "object" : "character");
    void loadAssets(initialKind).catch((error) =>
      setMessage(error instanceof Error ? error.message : "Libreria non disponibile"),
    );
  }, [initialKind]);

  useEffect(() => {
    void loadAsset(selectedId).catch((error) =>
      setMessage(error instanceof Error ? error.message : "Asset non disponibile"),
    );
  }, [selectedId]);

  useEffect(() => {
    fetch(`${bridgeUrl}/api/krea/status`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as { krea?: { ready?: boolean } };
        setKreaReady(Boolean(response.ok && payload.krea?.ready));
      })
      .catch(() => setKreaReady(false));
  }, []);

  useEffect(() => {
    if (selectedAsset?.status !== "generating") return;
    const timer = window.setInterval(() => {
      void loadAsset(selectedAsset.id).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [selectedAsset?.id, selectedAsset?.status]);

  async function createAsset() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/library`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: newKind,
          name: newName,
          description: newDescription,
          generationPrompt: newDescription,
        }),
      });
      const payload = (await response.json()) as { asset?: CreativeAsset; error?: string };
      if (!response.ok || !payload.asset) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setNewName("");
      setNewDescription("");
      setFilter("all");
      await loadAssets("all");
      setSelectedId(payload.asset.id);
      setSelectedAsset(payload.asset);
      setMessage(`${newKind === "character" ? "Personaggio" : "Oggetto"} creato`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Creazione fallita");
    } finally {
      setBusy(false);
    }
  }

  async function saveAsset() {
    if (!selectedAsset) return;
    setBusy(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/library/${selectedAsset.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: selectedAsset.name,
          description: selectedAsset.description,
          generationPrompt: selectedAsset.generationPrompt,
        }),
      });
      const payload = (await response.json()) as { asset?: CreativeAsset; error?: string };
      if (!response.ok || !payload.asset) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setSelectedAsset(payload.asset);
      await loadAssets(filter);
      setMessage("Scheda salvata");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Salvataggio fallito");
    } finally {
      setBusy(false);
    }
  }

  async function uploadReferences(files: FileList | File[]) {
    if (!selectedAsset || files.length === 0) return;
    setBusy(true);
    try {
      let current = selectedAsset;
      for (const [index, file] of Array.from(files).entries()) {
        if (!file.type.startsWith("image/")) {
          throw new Error("La libreria accetta reference immagine");
        }
        const body = new FormData();
        body.append("file", file, file.name);
        const uploadResponse = await fetch(`${bridgeUrl}/api/assets/upload`, {
          method: "POST",
          body,
        });
        const uploadPayload = (await uploadResponse.json()) as {
          asset?: Omit<MediaAsset, "uid" | "audio_mode">;
          error?: string;
        };
        if (!uploadResponse.ok || !uploadPayload.asset) {
          throw new Error(uploadPayload.error ?? `Upload HTTP ${uploadResponse.status}`);
        }
        const roles = ["primary", "face", "full_body", "side", "back", "detail"];
        const referenceResponse = await fetch(
          `${bridgeUrl}/api/library/${selectedAsset.id}/references`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              file: uploadPayload.asset.file,
              name: uploadPayload.asset.name,
              label: file.name,
              role: current.referenceCount === 0 && index === 0
                ? "primary"
                : roles[Math.min(current.referenceCount, roles.length - 1)],
              width: uploadPayload.asset.width,
              height: uploadPayload.asset.height,
            }),
          },
        );
        const referencePayload = (await referenceResponse.json()) as {
          asset?: CreativeAsset;
          error?: string;
        };
        if (!referenceResponse.ok || !referencePayload.asset) {
          throw new Error(referencePayload.error ?? `Bridge HTTP ${referenceResponse.status}`);
        }
        current = referencePayload.asset;
      }
      setSelectedAsset(current);
      await loadAssets(filter);
      setMessage(`${files.length} reference aggiunte`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import fallito");
    } finally {
      setBusy(false);
    }
  }

  async function removeReference(referenceId: string) {
    setBusy(true);
    try {
      const response = await fetch(
        `${bridgeUrl}/api/library-references/${referenceId}/delete`,
        { method: "POST" },
      );
      const payload = (await response.json()) as { asset?: CreativeAsset; error?: string };
      if (!response.ok || !payload.asset) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setSelectedAsset(payload.asset);
      await loadAssets(filter);
      setMessage("Reference rimossa");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rimozione fallita");
    } finally {
      setBusy(false);
    }
  }

  async function runKrea(dryRun: boolean) {
    if (!selectedAsset) return;
    setBusy(true);
    try {
      await saveAsset();
      const response = await fetch(
        `${bridgeUrl}/api/library/${selectedAsset.id}/krea/${dryRun ? "dry-run" : "generate"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: selectedAsset.generationPrompt }),
        },
      );
      const payload = (await response.json()) as {
        asset?: CreativeAsset;
        prompt?: string;
        apiNodeCount?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      if (dryRun) {
        setMessage(`Krea 2 pronto: ${payload.apiNodeCount} nodi, nessun render avviato`);
      } else if (payload.asset) {
        setSelectedAsset(payload.asset);
        setMessage("Sheet Krea 2 inviata a ComfyUI");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Krea 2 non disponibile");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAsset() {
    if (!selectedAsset || !window.confirm(`Eliminare “${selectedAsset.name}” dalla libreria?`)) return;
    setBusy(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/library/${selectedAsset.id}/delete`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
      setSelectedId("");
      setSelectedAsset(null);
      await loadAssets(filter);
      setMessage("Asset eliminato dalla libreria");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Eliminazione fallita");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="library-panel">
      <div className="library-heading">
        <div>
          <span className="section-index">KREA 2</span>
          <h2>Personaggi e oggetti</h2>
          <p>{message}</p>
        </div>
        <span className={`krea-status ${kreaReady ? "ready" : "offline"}`}>
          {kreaReady === null ? "Verifica Krea 2…" : kreaReady ? "Krea 2 pronto" : "Krea 2 incompleto"}
        </span>
      </div>

      <div className="library-create">
        <label>
          <span>Tipo</span>
          <select value={newKind} onChange={(event) => setNewKind(event.target.value as "character" | "object") }>
            <option value="character">Personaggio</option>
            <option value="object">Oggetto</option>
          </select>
        </label>
        <label>
          <span>Nome</span>
          <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Es. Kael, spada solare…" />
        </label>
        <label>
          <span>Descrizione identitaria</span>
          <input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Aspetto, materiali, dettagli invarianti…" />
        </label>
        <button disabled={busy || !newName.trim()} onClick={() => void createAsset()} type="button">+ Crea</button>
      </div>

      <div className="library-layout">
        <aside className="library-browser">
          <div className="library-filters">
            {(["all", "character", "object"] as const).map((value) => (
              <button
                className={filter === value ? "active" : ""}
                key={value}
                onClick={() => {
                  setFilter(value);
                  void loadAssets(value);
                }}
                type="button"
              >
                {value === "all" ? "Tutti" : value === "character" ? "Personaggi" : "Oggetti"}
              </button>
            ))}
          </div>
          <div className="library-grid">
            {assets.map((asset) => (
              <button
                className={`library-card ${selectedId === asset.id ? "active" : ""}`}
                key={asset.id}
                onClick={() => setSelectedId(asset.id)}
                type="button"
              >
                <div>
                  {asset.hero ? (
                    <img alt="" src={`${bridgeUrl}${asset.hero.mediaPath}`} />
                  ) : (
                    <span>{asset.kind === "character" ? "◎" : "◇"}</span>
                  )}
                </div>
                <strong>{asset.name}</strong>
                <small>{asset.referenceCount} reference · {asset.status}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="asset-editor">
          {selectedAsset ? (
            <>
              <div className="asset-editor-head">
                <div>
                  <span>{selectedAsset.kind === "character" ? "PERSONAGGIO" : "OGGETTO"}</span>
                  <h3>{selectedAsset.name}</h3>
                </div>
                <div>
                  <button disabled={busy} onClick={() => void saveAsset()} type="button">Salva</button>
                  <button className="danger" disabled={busy} onClick={() => void deleteAsset()} type="button">Elimina</button>
                </div>
              </div>

              <div className="asset-fields">
                <label>
                  <span>Nome</span>
                  <input value={selectedAsset.name} onChange={(event) => setSelectedAsset({ ...selectedAsset, name: event.target.value })} />
                </label>
                <label>
                  <span>Descrizione identitaria</span>
                  <textarea value={selectedAsset.description} onChange={(event) => setSelectedAsset({ ...selectedAsset, description: event.target.value })} />
                </label>
                <label>
                  <span>Prompt Krea 2</span>
                  <textarea value={selectedAsset.generationPrompt} onChange={(event) => setSelectedAsset({ ...selectedAsset, generationPrompt: event.target.value })} placeholder="Dettagli visivi da mantenere identici nelle quattro viste" />
                </label>
              </div>

              <div
                className="reference-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void uploadReferences(event.dataTransfer.files);
                }}
              >
                <strong>Trascina qui le reference</strong>
                <span>Volto, figura intera, profilo e dettagli · massimo 12 immagini</span>
                <label>
                  Scegli immagini
                  <input accept="image/*" multiple onChange={(event) => void uploadReferences(event.target.files ?? [])} type="file" />
                </label>
              </div>

              <div className="reference-grid">
                {(selectedAsset.references ?? []).map((reference) => (
                  <article key={reference.id}>
                    <button className="reference-open" onClick={() => setPreviewReference(reference)} type="button">
                      <img alt={reference.label} src={`${bridgeUrl}${reference.mediaPath}`} />
                      <span>Ingrandisci</span>
                    </button>
                    <div>
                      <strong>{reference.label}</strong>
                      <span>{reference.role.replace("_", " ")} · {reference.source}</span>
                      <a download href={`${bridgeUrl}${reference.mediaPath}${reference.mediaPath.includes("?") ? "&" : "?"}download=1`}>Scarica originale</a>
                    </div>
                    <button className="reference-remove" disabled={busy} onClick={() => void removeReference(reference.id)} type="button" aria-label={`Rimuovi ${reference.label}`}>×</button>
                  </article>
                ))}
              </div>

              <div className="krea-actions">
                <div>
                  <strong>Character/Object Sheet</strong>
                  <span>4 viste coerenti · 1536×1024 · 8 step · nessun LoRA</span>
                </div>
                <button disabled={busy || !selectedAsset.generationPrompt.trim()} onClick={() => void runKrea(true)} type="button">Verifica</button>
                <button disabled={busy || !kreaReady || !selectedAsset.generationPrompt.trim()} onClick={() => void runKrea(false)} type="button">
                  {selectedAsset.status === "generating" ? "In generazione…" : "Genera con Krea 2"}
                </button>
                <button
                  disabled={!selectedAsset.references?.length}
                  onClick={() => onUseReferences(selectedAsset, selectedAsset.references ?? [])}
                  type="button"
                >
                  Usa nel video →
                </button>
              </div>

              {(selectedAsset.generations?.length ?? 0) > 0 && (
                <div className="generation-log">
                  {selectedAsset.generations!.slice(0, 4).map((generation) => (
                    <span key={generation.id}>
                      Krea {generation.status} · seed {generation.seed}
                      {generation.error ? ` · ${generation.error}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="asset-editor-empty">Crea o seleziona un personaggio o un oggetto</div>
          )}
        </section>
      </div>
      {previewReference && (
        <div className="reference-lightbox" onMouseDown={() => setPreviewReference(null)} role="dialog" aria-modal="true" aria-label={previewReference.label}>
          <div onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><strong>{previewReference.label}</strong><span>{previewReference.role.replace("_", " ")}</span></div>
              <div>
                <a download href={`${bridgeUrl}${previewReference.mediaPath}${previewReference.mediaPath.includes("?") ? "&" : "?"}download=1`}>⇩ Scarica</a>
                <button onClick={() => setPreviewReference(null)} type="button">×</button>
              </div>
            </header>
            <img alt={previewReference.label} src={`${bridgeUrl}${previewReference.mediaPath}`} />
          </div>
        </div>
      )}
    </section>
  );
}

function SetupWizard({ status }: { status: SetupStatus }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [settings, setSettings] = useState(status.defaults);
  const [message, setMessage] = useState("Collega H3 Studio alla tua ComfyUI locale.");
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  const outputDirMissing = !settings.comfyOutputDir.trim()
    || settings.comfyOutputDir.includes("comfy-output-not-configured");
  const setupBlockingMessage = password.length < 10
    ? `La password deve contenere almeno 10 caratteri (${password.length}/10).`
    : password !== confirmPassword
      ? "Le due password non coincidono."
      : outputDirMissing
        ? "Indica la cartella output reale della tua ComfyUI."
        : null;

  async function completeSetup() {
    if (password !== confirmPassword) {
      setMessage("Le due password non coincidono");
      return;
    }
    setSaving(true);
    setMessage("Salvataggio configurazione…");
    try {
      const response = await fetch(`${bridgeUrl}/api/setup`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, settings }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setRestartRequired(true);
      setMessage(payload.message ?? "Configurazione completata");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Configurazione fallita");
    } finally {
      setSaving(false);
    }
  }

  if (restartRequired) {
    return (
      <main className="setup-shell">
        <section className="setup-card setup-complete">
          <span className="setup-mark">✓</span>
          <p className="section-index">SETUP COMPLETATO</p>
          <h1>H3 Studio è configurato</h1>
          <p>{message}</p>
          <strong>Chiudi le due console H3 Studio e rilancia START_H3_STUDIO.bat.</strong>
        </section>
      </main>
    );
  }

  const workflowSelect = (role: WorkflowCatalogItem["role"], key: keyof InstallSettings) => (
    <label>
      <span>Workflow {role === "video" ? "Video" : role === "fast" ? "FAST" : role === "image_edit" ? "Flux Klein Edit" : role === "image_anima" ? "Anima" : role === "image_minimax" ? "MiniMax H3 Image" : "Krea"}</span>
      <select
        value={String(settings[key])}
        onChange={(event) => setSettings({ ...settings, [key]: event.target.value })}
      >
        {status.workflowCatalog.filter((item) => item.role === role).map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>
    </label>
  );

  return (
    <main className="setup-shell">
      <section className="setup-card">
        <header>
          <span className="brand setup-brand">H3</span>
          <div><p className="section-index">PRIMO AVVIO</p><h1>Configura H3 Studio</h1></div>
        </header>
        <p className="setup-intro">Crea l’accesso Admin e indica la ComfyUI già installata. La password viene salvata soltanto come hash locale.</p>
        <div className="setup-grid">
          <label>
            <span>Password Admin</span>
            <input autoComplete="new-password" minLength={10} onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
            <small>{password.length < 10 ? `${password.length}/10 caratteri` : "Password valida"}</small>
          </label>
          <label>
            <span>Ripeti password</span>
            <input autoComplete="new-password" minLength={10} onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} />
          </label>
          <label>
            <span>URL ComfyUI</span>
            <input onChange={(event) => setSettings({ ...settings, comfyUrl: event.target.value })} placeholder="http://127.0.0.1:8188" value={settings.comfyUrl} />
          </label>
          <label>
            <span>Cartella output ComfyUI</span>
            <input onChange={(event) => setSettings({ ...settings, comfyOutputDir: event.target.value })} placeholder="C:\\ComfyUI\\output" value={settings.comfyOutputDir} />
          </label>
          {workflowSelect("video", "videoWorkflowId")}
          {workflowSelect("fast", "fastWorkflowId")}
          {workflowSelect("image", "imageWorkflowId")}
          {workflowSelect("image_edit", "imageEditWorkflowId")}
          {workflowSelect("image_anima", "imageAnimaWorkflowId")}
          {workflowSelect("image_minimax", "imageMinimaxWorkflowId")}
          <label>
            <span>FFmpeg</span>
            <input onChange={(event) => setSettings({ ...settings, ffmpegPath: event.target.value })} placeholder="ffmpeg oppure percorso completo" value={settings.ffmpegPath} />
          </label>
        </div>
        <footer>
          <p className={setupBlockingMessage ? "setup-validation" : undefined}>{setupBlockingMessage ?? message}</p>
          <button disabled={saving || setupBlockingMessage !== null} onClick={() => void completeSetup()} type="button">
            {saving ? "Configurazione…" : "Completa configurazione"}
          </button>
        </footer>
      </section>
    </main>
  );
}

function AdminPanel() {
  const [data, setDataState] = useState<EngineAdminResponse | null>(null);
  const dataRef = useRef<EngineAdminResponse | null>(null);
  const [installData, setInstallData] = useState<InstallAdminResponse | null>(null);
  const [message, setMessage] = useState("Caricamento configurazione…");
  const [saveNotice, setSaveNotice] = useState<{
    kind: "saving" | "success" | "error";
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [llmBusyPid, setLlmBusyPid] = useState<number | null>(null);
  const [llmRuntime, setLlmRuntime] = useState<AdminLlmRuntimeStatus | null>(null);
  const [loginRequired, setLoginRequired] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");

  function setData(
    value:
      | EngineAdminResponse
      | null
      | ((current: EngineAdminResponse | null) => EngineAdminResponse | null),
  ) {
    const next = typeof value === "function" ? value(dataRef.current) : value;
    // Keep the authoritative Admin snapshot synchronous so Save never sends
    // values from the previous render (models, CFG, steps or LoRAs).
    dataRef.current = next;
    setDataState(next);
  }

  async function loadSettings() {
    setMessage("Aggiornamento liste da ComfyUI…");
    try {
      const [engineResponse, installResponse] = await Promise.all([
        fetch(`${bridgeUrl}/api/admin/engine-settings`, { cache: "no-store", credentials: "include" }),
        fetch(`${bridgeUrl}/api/admin/install-settings`, { cache: "no-store", credentials: "include" }),
      ]);
      if (engineResponse.status === 401 || installResponse.status === 401) {
        setLoginRequired(true);
        setMessage("Inserisci la password Admin");
        return;
      }
      const enginePayload = (await engineResponse.json()) as EngineAdminResponse & { error?: string };
      const installPayload = (await installResponse.json()) as InstallAdminResponse & { error?: string };
      if (!engineResponse.ok) throw new Error(enginePayload.error ?? `Bridge HTTP ${engineResponse.status}`);
      if (!installResponse.ok) throw new Error(installPayload.error ?? `Bridge HTTP ${installResponse.status}`);

      let llmStatus: AdminLlmRuntimeStatus | null = null;
      let llmNotice = "";
      try {
        const llmResponse = await fetch(`${bridgeUrl}/api/admin/llm-runtime`, {
          cache: "no-store",
          credentials: "include",
        });
        if (llmResponse.status === 401) {
          setLoginRequired(true);
          setMessage("Inserisci la password Admin");
          return;
        }
        if (llmResponse.status === 404) {
          llmNotice = "Controllo LLM disponibile dopo il riavvio del bridge";
        } else {
          const llmPayload = (await llmResponse.json()) as { status?: AdminLlmRuntimeStatus; error?: string };
          if (!llmResponse.ok || !llmPayload.status) {
            throw new Error(llmPayload.error ?? `Bridge HTTP ${llmResponse.status}`);
          }
          llmStatus = llmPayload.status;
        }
      } catch (error) {
        llmNotice = error instanceof Error
          ? `Controllo LLM non disponibile: ${error.message}`
          : "Controllo LLM non disponibile";
      }
      const pairedPddFile = preferredPddFileForModel(
        enginePayload.settings.fast.model,
        enginePayload.capabilities.pddFiles,
      );
      if (pairedPddFile) {
        enginePayload.settings.fast = {
          ...enginePayload.settings.fast,
          pddFile: pairedPddFile,
        };
      }
      dataRef.current = enginePayload;
      setData(enginePayload);
      setInstallData(installPayload);
      setLlmRuntime(llmStatus);
      setLoginRequired(false);
      setMessage(llmNotice || "Liste, workflow e configurazione aggiornati da ComfyUI");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Caricamento fallito");
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  async function login() {
    setSaving(true);
    setMessage("Accesso…");
    try {
      const response = await fetch(`${bridgeUrl}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Accesso non riuscito");
      setAdminPassword("");
      setLoginRequired(false);
      await loadSettings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Accesso non riuscito");
    } finally {
      setSaving(false);
    }
  }

  function loraSlots(engine: "h3" | "fast" | "krea" | "anima") {
    const current = data?.settings[engine].loras ?? [];
    return Array.from({ length: 3 }, (_, index) => current[index] ?? { name: "", strength: 1 });
  }

  function updateLora(
    engine: "h3" | "fast" | "krea" | "anima",
    index: number,
    field: keyof EngineLoraSlot,
    value: string | number,
  ) {
    if (!data) return;
    const loras = loraSlots(engine);
    loras[index] = { ...loras[index], [field]: value };
    setData({
      ...data,
      settings: {
        ...data.settings,
        [engine]: { ...data.settings[engine], loras },
      },
    });
  }

  function updateFastModel(model: string) {
    if (!data) return;
    const pddFile = preferredPddFileForModel(model, data.capabilities.pddFiles);
    if (!pddFile) return;
    setData({
      ...data,
      settings: {
        ...data.settings,
        fast: { ...data.settings.fast, model, pddFile },
      },
    });
  }

  function updateAnimaModel(model: string) {
    const current = dataRef.current ?? data;
    if (!current) return;
    const next = {
      ...current,
      settings: {
        ...current.settings,
        anima: { ...current.settings.anima, model },
      },
    };
    // React may defer a functional state updater until after a rapid Save click.
    // Keep the authoritative ref synchronous with the select event.
    dataRef.current = next;
    setData(next);
  }

  async function saveSettings(manageBusy = true) {
    if (!data) return false;
    const settingsToSave = dataRef.current?.settings ?? data.settings;
    if (manageBusy) setSaving(true);
    setMessage("Salvataggio…");
    setSaveNotice({ kind: "saving", text: "Salvataggio Engine in corso…" });
    try {
      const response = await fetch(`${bridgeUrl}/api/admin/engine-settings`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settingsToSave),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        settings?: EngineAdminResponse["settings"];
      };
      if (!response.ok || !payload.settings) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      const verifyResponse = await fetch(`${bridgeUrl}/api/admin/engine-settings`, {
        cache: "no-store",
        credentials: "include",
      });
      const verified = (await verifyResponse.json()) as EngineAdminResponse & { error?: string };
      if (!verifyResponse.ok || !verified.settings) {
        throw new Error(verified.error ?? "Impossibile verificare le impostazioni appena salvate");
      }
      if (JSON.stringify(verified.settings) !== JSON.stringify(payload.settings)) {
        throw new Error("Il bridge non ha persistito tutte le impostazioni Engine");
      }
      setData((current) => {
        if (!current) return current;
        const next = { ...current, settings: verified.settings };
        dataRef.current = next;
        return next;
      });
      const successMessage = `Engine verificati e salvati · Anima ${verified.settings.anima.steps} step / CFG ${verified.settings.anima.cfg} · Flux ${verified.settings.imageEdit.steps} / CFG ${verified.settings.imageEdit.cfg} · Krea ${verified.settings.krea.steps} step`;
      setMessage(successMessage);
      setSaveNotice({ kind: "success", text: successMessage });
      return true;
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "Salvataggio fallito";
      setMessage(failureMessage);
      setSaveNotice({ kind: "error", text: `Salvataggio Engine fallito: ${failureMessage}` });
      return false;
    } finally {
      if (manageBusy) setSaving(false);
    }
  }

  async function saveInstallSettings(manageBusy = true) {
    if (!installData) return false;
    if (manageBusy) setSaving(true);
    setMessage("Salvataggio collegamento e workflow…");
    try {
      const response = await fetch(`${bridgeUrl}/api/admin/install-settings`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(installData.settings),
      });
      const payload = (await response.json()) as { error?: string; message?: string; settings?: InstallSettings };
      if (!response.ok || !payload.settings) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setInstallData({ ...installData, settings: payload.settings });
      setMessage(payload.message ?? "Configurazione salvata");
      return true;
    } catch (error) {
      const failureMessage = error instanceof Error
        ? error.message
        : "Salvataggio installazione fallito";
      setMessage(failureMessage);
      setSaveNotice({
        kind: "error",
        text: `Salvataggio collegamento/workflow fallito: ${failureMessage}`,
      });
      return false;
    } finally {
      if (manageBusy) setSaving(false);
    }
  }

  async function saveAllSettings() {
    if (!data || !installData || saving) return;
    setSaving(true);
    setMessage("Salvataggio completo in corso…");
    setSaveNotice({ kind: "saving", text: "Salvataggio completo in corso…" });
    try {
      if (!await saveSettings(false)) return;
      if (!await saveInstallSettings(false)) return;
      const current = dataRef.current;
      const successMessage = current
        ? `Tutto salvato e verificato · Anima ${current.settings.anima.steps} step / CFG ${current.settings.anima.cfg} · Flux ${current.settings.imageEdit.steps} / CFG ${current.settings.imageEdit.cfg} · Krea ${current.settings.krea.steps} step`
        : "Engine, collegamento e workflow salvati e verificati";
      setMessage(successMessage);
      setSaveNotice({ kind: "success", text: successMessage });
    } finally {
      setSaving(false);
    }
  }

  async function restartServer() {
    if (restarting) return;
    setRestarting(true);
    setMessage("Riavvio del bridge H3…");
    try {
      const response = await fetch(`${bridgeUrl}/api/admin/server/restart`, {
        method: "POST",
        credentials: "include",
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setMessage("Bridge in riavvio · attendo la riconnessione…");
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        try {
          const health = await fetch(`${bridgeUrl}/api/health`, { cache: "no-store" });
          if (health.ok) {
            window.location.reload();
            return;
          }
        } catch {
          // Il bridge non è ancora tornato online.
        }
      }
      setMessage("Riavvio avviato; ricarica la pagina fra qualche secondo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Riavvio non riuscito");
    } finally {
      setRestarting(false);
    }
  }

  async function refreshLlmStatus(silent = false) {
    if (!silent) setMessage("Controllo processi LLM e VRAM…");
    try {
      const response = await fetch(`${bridgeUrl}/api/admin/llm-runtime`, {
        cache: "no-store",
        credentials: "include",
      });
      const payload = (await response.json()) as { status?: AdminLlmRuntimeStatus; error?: string };
      if (!response.ok || !payload.status) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setLlmRuntime(payload.status);
      if (!silent) {
        setMessage(payload.status.processes.length > 0
          ? `${payload.status.processes.length} processo/i LLM attivo/i`
          : "Nessun processo llama-server attivo");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Stato LLM non disponibile");
    }
  }

  async function unloadLlm(pid: number) {
    const confirmed = window.confirm(
      `Terminare llama-server PID ${pid}?\n\nIl modello LLM verrà scaricato dalla VRAM. ComfyUI resterà attiva, ma anche un modello aperto in LM Studio dovrà essere ricaricato al prossimo utilizzo.`,
    );
    if (!confirmed) return;
    setLlmBusyPid(pid);
    setMessage(`Scaricamento LLM PID ${pid}…`);
    try {
      const response = await fetch(`${bridgeUrl}/api/admin/llm-runtime/unload`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pid }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
        after?: AdminLlmRuntimeStatus;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      if (payload.after) setLlmRuntime(payload.after);
      setMessage(payload.message ?? "LLM scaricato");
      window.setTimeout(() => void refreshLlmStatus(true), 1_000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "LLM non scaricato");
      await refreshLlmStatus(true);
    } finally {
      setLlmBusyPid(null);
    }
  }

  async function logout() {
    await fetch(`${bridgeUrl}/api/auth/logout`, { method: "POST", credentials: "include" });
    setData(null);
    setInstallData(null);
    setLoginRequired(true);
    setMessage("Sessione Admin chiusa");
  }

  const fastModels = data?.capabilities.models.filter(isOfficialFastPddModel) ?? [];
  const h3Models = data
    ? compatibleEngineOptions(
        data.capabilities.models,
        data.settings.h3.model,
        /h3|fl2va|ref2va/i,
      )
    : [];
  const kreaModels = data
    ? compatibleEngineOptions(
        data.capabilities.models,
        data.settings.krea.model,
        /krea2|krea.*(?:turbo|redmix)/i,
      )
    : [];
  const imageEditModels = data
    ? compatibleEngineOptions(
        data.capabilities.models,
        data.settings.imageEdit.model,
        /flux.*2.*klein|klein.*flux|unstable.*f2k|snofs/i,
      )
    : [];
  const animaModels = data
    ? compatibleEngineOptions(
        data.capabilities.models,
        data.settings.anima.model,
        /(?:anima|nova.*am)/i,
      )
    : [];
  const kreaTextEncoders = data
    ? compatibleEngineOptions(
        data.capabilities.textEncoders,
        data.settings.krea.encoder,
        /qwen.*(?:vl|vision)/i,
      )
    : [];
  const imageEditTextEncoders = data
    ? compatibleEngineOptions(
        data.capabilities.textEncoders,
        data.settings.imageEdit.encoder,
        /qwen[_-]?3[_-]?(?:4b|8b)|qwen.*(?:4b|8b)/i,
      )
    : [];
  const animaTextEncoders = data
    ? compatibleEngineOptions(
        data.capabilities.textEncoders,
        data.settings.anima.encoder,
        /anima|qwen.*(?:06b|0[._-]?6b)/i,
      )
    : [];
  const kreaVaes = data
    ? compatibleEngineOptions(
        data.capabilities.vaes,
        data.settings.krea.vae,
        /qwen.*image.*vae/i,
      )
    : [];
  const imageEditVaes = data
    ? compatibleEngineOptions(
        data.capabilities.vaes,
        data.settings.imageEdit.vae,
        /flux.*2.*vae|flux2.*vae/i,
      )
    : [];
  const animaVaes = data
    ? compatibleEngineOptions(
        data.capabilities.vaes,
        data.settings.anima.vae,
        /qwen.*image.*vae/i,
      )
    : [];
  const selectedFastPair = data
    ? fastPddPairForModel(data.settings.fast.model)
    : null;
  const compatibleFastPddFiles = data
    ? compatiblePddFilesForModel(
        data.settings.fast.model,
        data.capabilities.pddFiles,
      )
    : [];

  if (loginRequired) {
    return (
      <section className="admin-panel admin-login-panel">
        <div className="admin-login-card">
          <span className="section-index">AREA PROTETTA</span>
          <h2>Accesso Admin</h2>
          <p>Le generazioni restano disponibili; configurazione, modelli e workflow richiedono la password locale.</p>
          <input
            autoComplete="current-password"
            autoFocus
            onChange={(event) => setAdminPassword(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void login(); }}
            placeholder="Password Admin"
            type="password"
            value={adminPassword}
          />
          <button disabled={saving || !adminPassword} onClick={() => void login()} type="button">Accedi</button>
          <small>{message}</small>
        </div>
      </section>
    );
  }

  return (
    <section className="admin-panel">
      <div className="admin-heading">
        <div>
          <span className="section-index">ADMIN</span>
          <h2>Engine</h2>
          <p>Modelli e LoRA realmente disponibili nella ComfyUI collegata.</p>
        </div>
        <span className={data?.workflow.ready ? "admin-ready" : "admin-warning"}>
          {data?.workflow.ready ? "Workflow pronto" : "Workflow non pronto"}
        </span>
      </div>

      {saveNotice && (
        <div className={`admin-save-notice admin-save-notice-${saveNotice.kind}`} role="status">
          <span>{saveNotice.text}</span>
          {saveNotice.kind !== "saving" && (
            <button aria-label="Chiudi avviso salvataggio" onClick={() => setSaveNotice(null)} type="button">×</button>
          )}
        </div>
      )}

      {data ? (
        <>
          {installData && (
            <section className="admin-install-section">
              <div className="admin-subheading">
                <div><span>INSTALLAZIONE</span><h3>ComfyUI e workflow associati</h3></div>
                <div className="admin-server-actions">
                  <button disabled={saving || restarting} onClick={() => void saveAllSettings()} type="button">
                    {saving ? "Salvataggio…" : "Salva tutto"}
                  </button>
                  <button className="secondary" disabled={saving || restarting} onClick={() => void restartServer()} type="button">
                    {restarting ? "Riavvio…" : "↻ Riavvia server"}
                  </button>
                </div>
              </div>
              <div className="admin-llm-runtime">
                <div className="admin-llm-summary">
                  <div>
                    <span>MEMORIA LLM</span>
                    <strong>{llmRuntime?.processes.length ? `${llmRuntime.processes.length} llama-server attivo/i` : "Nessun llama-server attivo"}</strong>
                    <small>
                      {llmRuntime?.gpu
                        ? `VRAM GPU: ${(llmRuntime.gpu.usedMiB / 1024).toFixed(1)} / ${(llmRuntime.gpu.totalMiB / 1024).toFixed(1)} GB`
                        : "VRAM non disponibile"}
                    </small>
                  </div>
                  <button className="secondary" disabled={llmBusyPid !== null} onClick={() => void refreshLlmStatus()} type="button">
                    ↻ Aggiorna stato
                  </button>
                </div>
                {llmRuntime?.processes.map((process) => (
                  <div className="admin-llm-process" key={process.pid}>
                    <div><strong>{process.name}</strong><small>PID {process.pid} · Planner H3 o modello aperto in LM Studio</small></div>
                    <button className="danger" disabled={llmBusyPid !== null} onClick={() => void unloadLlm(process.pid)} type="button">
                      {llmBusyPid === process.pid ? "Scaricamento…" : "Libera VRAM LLM"}
                    </button>
                  </div>
                ))}
                <p>Termina soltanto il PID llama-server scelto. ComfyUI e il bridge H3 Studio restano in esecuzione.</p>
              </div>
              <div className="admin-install-grid">
                <label>
                  <span>URL server ComfyUI</span>
                  <input value={installData.settings.comfyUrl} onChange={(event) => setInstallData({ ...installData, settings: { ...installData.settings, comfyUrl: event.target.value } })} />
                </label>
                <label>
                  <span>Cartella output ComfyUI</span>
                  <input value={installData.settings.comfyOutputDir} onChange={(event) => setInstallData({ ...installData, settings: { ...installData.settings, comfyOutputDir: event.target.value } })} />
                </label>
                {([
                  ["video", "videoWorkflowId", "Workflow Video"],
                  ["fast", "fastWorkflowId", "Workflow FAST"],
                  ["image", "imageWorkflowId", "Workflow Krea"],
                  ["image_edit", "imageEditWorkflowId", "Workflow Flux Klein Edit"],
                  ["image_anima", "imageAnimaWorkflowId", "Workflow Anima"],
                  ["image_minimax", "imageMinimaxWorkflowId", "Workflow MiniMax H3 Image"],
                ] as const).map(([role, key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <select value={installData.settings[key]} onChange={(event) => setInstallData({ ...installData, settings: { ...installData.settings, [key]: event.target.value } })}>
                      {installData.workflowCatalog.filter((item) => item.role === role).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                ))}
                <label>
                  <span>FFmpeg</span>
                  <input value={installData.settings.ffmpegPath} onChange={(event) => setInstallData({ ...installData, settings: { ...installData.settings, ffmpegPath: event.target.value } })} />
                </label>
              </div>
              <div className="dependency-list">
                {installData.dependencies.map((dependency) => (
                  <article className={dependency.installed ? "dependency-ready" : "dependency-missing"} key={dependency.id}>
                    <span>{dependency.installed ? "✓" : "!"}</span>
                    <div>
                      <strong>{dependency.label}</strong>
                      <small>{dependency.requiredFor?.join(" · ") ?? dependency.kind}</small>
                      {dependency.folder && (
                        <small>
                          models/{dependency.folder}: {dependency.filenames?.join(" oppure ")}
                        </small>
                      )}
                      {dependency.notes && <small>{dependency.notes}</small>}
                    </div>
                    {dependency.url && <a href={dependency.url} rel="noreferrer" target="_blank">Apri</a>}
                  </article>
                ))}
              </div>
            </section>
          )}
          <div className="engine-workflows">
            <div className="workflow-card">
              <span>Workflow video H3</span>
              <strong>{data.workflow.source.split("\\").at(-1)}</strong>
              <code>{data.workflow.apiPrompt}</code>
              <small>
                Catturato {data.workflow.capturedAt ? new Date(data.workflow.capturedAt).toLocaleString("it-IT") : "—"}
              </small>
            </div>
            <div className="workflow-card">
              <span>Workflow FAST Alibaba</span>
              <strong>{data.fastWorkflow.ready ? "PDD-Acc 8-step pronto" : "Riavvio ComfyUI richiesto"}</strong>
              <code>{data.fastWorkflow.apiPromptPath}</code>
              <small>{data.fastWorkflow.recipe}</small>
              {data.fastWorkflow.error && <small className="workflow-error">{data.fastWorkflow.error}</small>}
            </div>
            <div className="workflow-card">
              <span>Workflow Krea</span>
              <strong>{data.kreaWorkflow.source.split("\\").at(-1)}</strong>
              <code>{data.kreaWorkflow.source}</code>
              <small>Usato per character e object sheet</small>
            </div>
            <div className="workflow-card">
              <span>Workflow Flux Klein Edit</span>
              <strong>{data.imageEditWorkflow.source.split("\\").at(-1)}</strong>
              <code>{data.imageEditWorkflow.source}</code>
              <small>Image edit multi-reference, fino a quattro input</small>
            </div>
            <div className="workflow-card">
              <span>Workflow MiniMax H3 Image</span>
              <strong>{data.minimaxImageWorkflow.source.split("\\").at(-1)}</strong>
              <code>{data.minimaxImageWorkflow.source}</code>
              <small>T2I, I2I e Reference fino a nove immagini</small>
            </div>
          </div>

          <div className="engine-config-grid">
            <article className="engine-config-card">
              <div className="engine-config-heading">
                <div>
                  <span>VIDEO ENGINE</span>
                  <h3>MiniMax H3</h3>
                </div>
                <b>{data.settings.h3.loras.filter((slot) => slot.name).length}/3 LoRA</b>
              </div>
              <div className="admin-form engine-core-form">
                <label>
                  <span>Modello H3</span>
                  <select
                    value={data.settings.h3.model}
                    onChange={(event) => setData({
                      ...data,
                      settings: {
                        ...data.settings,
                        h3: { ...data.settings.h3, model: event.target.value },
                      },
                    })}
                  >
                    {h3Models.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <div className="engine-fixed-recipe">
                  <span>Preset standard</span>
                  <strong>8 / 12 / 20 / 30 step</strong>
                  <small>Sampler e parametri del workflow H3 originale</small>
                </div>
              </div>
              <div className="engine-lora-stack">
                {loraSlots("h3").map((slot, index) => (
                  <div className="engine-lora-row" key={index}>
                    <span>{index + 1}</span>
                    <select
                      aria-label={`LoRA H3 ${index + 1}`}
                      value={slot.name}
                      onChange={(event) => updateLora("h3", index, "name", event.target.value)}
                    >
                      <option value="">Nessun LoRA</option>
                      {data.capabilities.loras.map((lora) => <option key={lora} value={lora}>{lora}</option>)}
                    </select>
                    <input
                      aria-label={`Strength LoRA H3 ${index + 1}`}
                      disabled={!slot.name}
                      min="-2"
                      max="2"
                      step="0.05"
                      type="number"
                      value={slot.strength}
                      onChange={(event) => updateLora("h3", index, "strength", Number(event.target.value))}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="engine-config-card fast-engine-card">
              <div className="engine-config-heading">
                <div>
                  <span>FAST ENGINE</span>
                  <h3>Alibaba PDD-Acc</h3>
                </div>
                <b>8 STEP · {data.settings.fast.loras.filter((slot) => slot.name).length}/3 LoRA</b>
              </div>
              <div className="admin-form fast-engine-form">
                <label>
                  <span>Modello FAST H3</span>
                  <select
                    value={data.settings.fast.model}
                    onChange={(event) => updateFastModel(event.target.value)}
                  >
                    {!fastModels.includes(data.settings.fast.model) && (
                      <option value={data.settings.fast.model}>{data.settings.fast.model} · da installare</option>
                    )}
                    {fastModels.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <label>
                  <span>Acceleratore PDD</span>
                  <select
                    value={data.settings.fast.pddFile}
                    disabled={compatibleFastPddFiles.length === 0}
                    onChange={(event) => setData({
                      ...data,
                      settings: {
                        ...data.settings,
                        fast: { ...data.settings.fast, pddFile: event.target.value },
                      },
                    })}
                  >
                    {!compatibleFastPddFiles.includes(data.settings.fast.pddFile) && (
                      <option value={data.settings.fast.pddFile}>
                        {data.settings.fast.pddFile} · da installare
                      </option>
                    )}
                    {compatibleFastPddFiles.map((file) => <option key={file} value={file}>{file}</option>)}
                  </select>
                  <small>
                    Patch {selectedFastPair?.family.toUpperCase() ?? "—"} auto-abbinata al modello
                  </small>
                </label>
                <div className="engine-fixed-recipe fast-recipe">
                  <span>Ricetta bloccata</span>
                  <strong>Euler · CFG 1 · shift 12/3</strong>
                  <small>Sigmas PDD, strength 1, modello non-pruned, nessun Turbo/distill/cache</small>
                </div>
              </div>
              <div className="engine-lora-stack">
                {loraSlots("fast").map((slot, index) => (
                  <div className="engine-lora-row" key={index}>
                    <span>{index + 1}</span>
                    <select
                      aria-label={`LoRA FAST ${index + 1}`}
                      value={slot.name}
                      onChange={(event) => updateLora("fast", index, "name", event.target.value)}
                    >
                      <option value="">Nessun LoRA creativo</option>
                      {data.capabilities.loras.filter(isFastCreativeLora).map((lora) => <option key={lora} value={lora}>{lora}</option>)}
                    </select>
                    <input
                      aria-label={`Strength LoRA FAST ${index + 1}`}
                      disabled={!slot.name}
                      min="-2"
                      max="2"
                      step="0.05"
                      type="number"
                      value={slot.strength}
                      onChange={(event) => updateLora("fast", index, "strength", Number(event.target.value))}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="engine-config-card">
              <div className="engine-config-heading">
                <div>
                  <span>IMAGE ENGINE</span>
                  <h3>Krea 2</h3>
                </div>
                <b>{data.settings.krea.loras.filter((slot) => slot.name).length}/3 LoRA</b>
              </div>
              <div className="admin-form krea-engine-form">
                <label>
                  <span>Modello Krea</span>
                  <select value={data.settings.krea.model} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, krea: { ...data.settings.krea, model: event.target.value } },
                  })}>
                    {kreaModels.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <label>
                  <span>Text encoder</span>
                  <select value={data.settings.krea.encoder} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, krea: { ...data.settings.krea, encoder: event.target.value } },
                  })}>
                    {kreaTextEncoders.map((encoder) => <option key={encoder} value={encoder}>{encoder}</option>)}
                  </select>
                </label>
                <label>
                  <span>VAE</span>
                  <select value={data.settings.krea.vae} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, krea: { ...data.settings.krea, vae: event.target.value } },
                  })}>
                    {kreaVaes.map((vae) => <option key={vae} value={vae}>{vae}</option>)}
                  </select>
                </label>
                <label>
                  <span>Step Krea</span>
                  <input
                    min="4"
                    max="40"
                    step="1"
                    type="number"
                    value={data.settings.krea.steps}
                    onChange={(event) => setData({
                      ...data,
                      settings: { ...data.settings, krea: { ...data.settings.krea, steps: Number(event.target.value) } },
                    })}
                  />
                </label>
              </div>
              <div className="engine-lora-stack">
                {loraSlots("krea").map((slot, index) => (
                  <div className="engine-lora-row" key={index}>
                    <span>{index + 1}</span>
                    <select
                      aria-label={`LoRA Krea ${index + 1}`}
                      value={slot.name}
                      onChange={(event) => updateLora("krea", index, "name", event.target.value)}
                    >
                      <option value="">Nessun LoRA</option>
                      {data.capabilities.loras.map((lora) => <option key={lora} value={lora}>{lora}</option>)}
                    </select>
                    <input
                      aria-label={`Strength LoRA Krea ${index + 1}`}
                      disabled={!slot.name}
                      min="-2"
                      max="2"
                      step="0.05"
                      type="number"
                      value={slot.strength}
                      onChange={(event) => updateLora("krea", index, "strength", Number(event.target.value))}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="engine-config-card anima-engine-card">
              <div className="engine-config-heading">
                <div>
                  <span>ANIME IMAGE ENGINE</span>
                  <h3>Anima</h3>
                </div>
                <b>{data.settings.anima.loras.filter((slot) => slot.name).length}/3 LoRA</b>
              </div>
              <div className="admin-form anima-engine-form">
                <label>
                  <span>Modello Anima / Nova AM</span>
                  <select value={data.settings.anima.model} onChange={(event) => updateAnimaModel(event.target.value)}>
                    {animaModels.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <label>
                  <span>Text encoder</span>
                  <select value={data.settings.anima.encoder} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, anima: { ...data.settings.anima, encoder: event.target.value } },
                  })}>
                    {animaTextEncoders.map((encoder) => <option key={encoder} value={encoder}>{encoder}</option>)}
                  </select>
                </label>
                <label>
                  <span>VAE</span>
                  <select value={data.settings.anima.vae} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, anima: { ...data.settings.anima, vae: event.target.value } },
                  })}>
                    {animaVaes.map((vae) => <option key={vae} value={vae}>{vae}</option>)}
                  </select>
                </label>
                <label>
                  <span>Step Anima</span>
                  <input min="4" max="40" step="1" type="number" value={data.settings.anima.steps} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, anima: { ...data.settings.anima, steps: Number(event.target.value) } },
                  })} />
                </label>
                <label>
                  <span>CFG</span>
                  <input min="0" max="20" step="0.1" type="number" value={data.settings.anima.cfg} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, anima: { ...data.settings.anima, cfg: Number(event.target.value) } },
                  })} />
                </label>
                <p className="image-edit-profile-note">Profilo locale consigliato: anima_turboV10 · 8 step · CFG 1 · Euler/simple. Con il modello base ufficiale puoi usare 30 step / CFG 4 oppure aggiungere il Turbo LoRA dal profilo.</p>
              </div>
              <div className="engine-lora-stack">
                {loraSlots("anima").map((slot, index) => (
                  <div className="engine-lora-row" key={index}>
                    <span>{index + 1}</span>
                    <select
                      aria-label={`LoRA Anima ${index + 1}`}
                      value={slot.name}
                      onChange={(event) => updateLora("anima", index, "name", event.target.value)}
                    >
                      <option value="">Nessun LoRA</option>
                      {data.capabilities.loras.map((lora) => <option key={lora} value={lora}>{lora}</option>)}
                    </select>
                    <input
                      aria-label={`Strength LoRA Anima ${index + 1}`}
                      disabled={!slot.name}
                      min="-2"
                      max="2"
                      step="0.05"
                      type="number"
                      value={slot.strength}
                      onChange={(event) => updateLora("anima", index, "strength", Number(event.target.value))}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="engine-config-card image-edit-engine-card">
              <div className="engine-config-heading">
                <div>
                  <span>IMAGE EDIT ENGINE</span>
                  <h3>Flux.2 Klein</h3>
                </div>
                <b>{data.settings.imageEdit.steps} STEP</b>
              </div>
              <div className="admin-form image-edit-engine-form">
                <label>
                  <span>Modello Flux.2 Klein</span>
                  <select value={data.settings.imageEdit.model} onChange={(event) => {
                    const model = event.target.value;
                    const encoder = preferredFlux2Encoder(
                      model,
                      imageEditTextEncoders,
                      data.settings.imageEdit.encoder,
                    );
                    setData({
                      ...data,
                      settings: { ...data.settings, imageEdit: { ...data.settings.imageEdit, model, encoder } },
                    });
                  }}>
                    {imageEditModels.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <label>
                  <span>Text encoder</span>
                  <select value={data.settings.imageEdit.encoder} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, imageEdit: { ...data.settings.imageEdit, encoder: event.target.value } },
                  })}>
                    {imageEditTextEncoders.map((encoder) => <option key={encoder} value={encoder}>{encoder}</option>)}
                  </select>
                </label>
                <label>
                  <span>VAE</span>
                  <select value={data.settings.imageEdit.vae} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, imageEdit: { ...data.settings.imageEdit, vae: event.target.value } },
                  })}>
                    {imageEditVaes.map((vae) => <option key={vae} value={vae}>{vae}</option>)}
                  </select>
                </label>
                <label>
                  <span>Step Flux Klein</span>
                  <input min="4" max="40" step="1" type="number" value={data.settings.imageEdit.steps} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, imageEdit: { ...data.settings.imageEdit, steps: Number(event.target.value) } },
                  })} />
                </label>
                <label>
                  <span>CFG</span>
                  <input min="0" max="20" step="0.1" type="number" value={data.settings.imageEdit.cfg} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, imageEdit: { ...data.settings.imageEdit, cfg: Number(event.target.value) } },
                  })} />
                </label>
                <label>
                  <span>Attention backend</span>
                  <select value={data.settings.imageEdit.attentionBackend} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, imageEdit: { ...data.settings.imageEdit, attentionBackend: event.target.value as EngineAdminResponse["settings"]["imageEdit"]["attentionBackend"] } },
                  })}>
                    <option value="auto">Auto</option>
                    {data.capabilities.imageAttentionBackends.includes("pytorch attention") && <option value="pytorch attention">PyTorch</option>}
                    {data.capabilities.imageAttentionBackends.includes("comfy kitchen attention") && <option value="comfy kitchen attention">Comfy Kitchen</option>}
                  </select>
                </label>
                <label className="engine-checkbox image-edit-cache-toggle">
                  <input checked={data.settings.imageEdit.kvCacheEnabled} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, imageEdit: { ...data.settings.imageEdit, kvCacheEnabled: event.target.checked } },
                  })} type="checkbox" />
                  <span><strong>Flux KV Cache (sperimentale)</strong><small>Accelera edit multi-reference; disattivabile in caso di incompatibilità</small></span>
                </label>
                <p className="image-edit-profile-note">Profilo consigliato: Klein 4B usa Qwen 3 4B; Klein 9B e SNOFS usano Qwen 3 8B. Il selettore abbina automaticamente l’encoder · Flux2 VAE · 4 step / CFG 1.</p>
              </div>
            </article>

            <article className="engine-config-card audio-engine-card">
              <div className="engine-config-heading">
                <div><span>VOICE</span><h3>Higgs Audio v3 TTS</h3></div>
                <b className={data.audioStudio?.tts.ready ? "admin-ready" : "admin-warning"}>{data.audioStudio?.tts.ready ? "PRONTO" : "SETUP"}</b>
              </div>
              <div className="admin-form image-edit-engine-form">
                <label><span>Cartella Higgs Audio Studio</span><input value={data.settings.tts.root} onChange={(event) => setData({ ...data, settings: { ...data.settings, tts: { ...data.settings.tts, root: event.target.value } } })} /></label>
                <label><span>Voce predefinita</span><select value={data.settings.tts.voice} onChange={(event) => setData({ ...data, settings: { ...data.settings, tts: { ...data.settings.tts, voice: event.target.value } } })}>{[...new Set([data.settings.tts.voice, ...(data.audioStudio?.tts.voices ?? [])])].filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label><span>Temperature</span><input min="0.05" max="2" step="0.05" type="number" value={data.settings.tts.temperature} onChange={(event) => setData({ ...data, settings: { ...data.settings, tts: { ...data.settings.tts, temperature: Number(event.target.value) } } })} /></label>
                <label><span>Top P</span><input min="0.01" max="1" step="0.01" type="number" value={data.settings.tts.topP} onChange={(event) => setData({ ...data, settings: { ...data.settings, tts: { ...data.settings.tts, topP: Number(event.target.value) } } })} /></label>
                <label><span>Top K</span><input min="1" max="500" step="1" type="number" value={data.settings.tts.topK} onChange={(event) => setData({ ...data, settings: { ...data.settings, tts: { ...data.settings.tts, topK: Number(event.target.value) } } })} /></label>
                <label><span>Velocità</span><input min="0.5" max="2" step="0.05" type="number" value={data.settings.tts.speed} onChange={(event) => setData({ ...data, settings: { ...data.settings, tts: { ...data.settings.tts, speed: Number(event.target.value) } } })} /></label>
                <label><span>Token massimi</span><input min="256" max="8192" step="256" type="number" value={data.settings.tts.maxNewTokens} onChange={(event) => setData({ ...data, settings: { ...data.settings, tts: { ...data.settings.tts, maxNewTokens: Number(event.target.value) } } })} /></label>
                <p className="image-edit-profile-note">Higgs viene avviato in un processo isolato solo durante la sintesi e terminato sempre dopo output, errore o Stop. Supporta cloning one-shot da Libreria.</p>
              </div>
            </article>

            <article className="engine-config-card audio-engine-card">
              <div className="engine-config-heading">
                <div><span>MUSIC</span><h3>MiniMax Music 3</h3></div>
                <b className={data.audioStudio?.music.ready ? "admin-ready" : "admin-warning"}>{data.audioStudio?.music.ready ? "PRONTO" : "SETUP"}</b>
              </div>
              <div className="admin-form image-edit-engine-form">
                <label><span>Modello DiT</span><select value={data.settings.music.model} onChange={(event) => setData({ ...data, settings: { ...data.settings, music: { ...data.settings.music, model: event.target.value } } })}>{compatibleEngineOptions(data.capabilities.models, data.settings.music.model, /minimax.*music/i).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label><span>Text encoder</span><select value={data.settings.music.encoder} onChange={(event) => setData({ ...data, settings: { ...data.settings, music: { ...data.settings.music, encoder: event.target.value } } })}>{compatibleEngineOptions(data.capabilities.textEncoders, data.settings.music.encoder, /minimax.*music/i).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label><span>VAE / DAV</span><select value={data.settings.music.vae} onChange={(event) => setData({ ...data, settings: { ...data.settings, music: { ...data.settings.music, vae: event.target.value } } })}>{compatibleEngineOptions(data.capabilities.vaes, data.settings.music.vae, /minimax.*music|music.*dav/i).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label><span>Step</span><input min="4" max="40" step="1" type="number" value={data.settings.music.steps} onChange={(event) => setData({ ...data, settings: { ...data.settings, music: { ...data.settings.music, steps: Number(event.target.value) } } })} /></label>
                <label><span>CFG</span><input min="0.1" max="10" step="0.1" type="number" value={data.settings.music.cfg} onChange={(event) => setData({ ...data, settings: { ...data.settings, music: { ...data.settings.music, cfg: Number(event.target.value) } } })} /></label>
                <label className="admin-inline-check"><input checked={data.settings.music.tiledDecode} onChange={(event) => setData({ ...data, settings: { ...data.settings, music: { ...data.settings.music, tiledDecode: event.target.checked } } })} type="checkbox" /><span>Decode audio tiled (consigliato)</span></label>
                <p className="image-edit-profile-note">Workflow nativo ComfyUI: caption + lyrics strutturate, fino a 6 minuti. Decode tiled attivo per contenere la VRAM.</p>
              </div>
            </article>

            <article className="engine-config-card audio-engine-card">
              <div className="engine-config-heading">
                <div><span>VOICE CONVERSION</span><h3>audio.cpp · Seed-VC</h3></div>
                <b className={data.audioStudio?.voiceConversion.ready ? "admin-ready" : "admin-warning"}>{data.audioStudio?.voiceConversion.ready ? "PRONTO" : "SETUP"}</b>
              </div>
              <div className="admin-form image-edit-engine-form">
                <label><span>Cartella audio.cpp</span><input value={data.settings.voiceConversion.root} onChange={(event) => setData({ ...data, settings: { ...data.settings, voiceConversion: { ...data.settings.voiceConversion, root: event.target.value } } })} /></label>
                <label><span>Modello separazione vocale</span><input value={data.settings.voiceConversion.separatorModel} onChange={(event) => setData({ ...data, settings: { ...data.settings, voiceConversion: { ...data.settings.voiceConversion, separatorModel: event.target.value } } })} /></label>
                <label><span>Modello Seed-VC</span><input value={data.settings.voiceConversion.seedVcModel} onChange={(event) => setData({ ...data, settings: { ...data.settings, voiceConversion: { ...data.settings.voiceConversion, seedVcModel: event.target.value } } })} /></label>
                <label><span>Backend</span><select value={data.settings.voiceConversion.backend} onChange={(event) => setData({ ...data, settings: { ...data.settings, voiceConversion: { ...data.settings.voiceConversion, backend: event.target.value as "cuda" | "cpu" } } })}><option value="cuda">CUDA</option><option value="cpu">CPU</option></select></label>
                <label><span>Step Seed-VC</span><input min="10" max="100" step="1" type="number" value={data.settings.voiceConversion.steps} onChange={(event) => setData({ ...data, settings: { ...data.settings, voiceConversion: { ...data.settings.voiceConversion, steps: Number(event.target.value) } } })} /></label>
                <label className="admin-inline-check"><input checked={data.settings.voiceConversion.f0Condition} onChange={(event) => setData({ ...data, settings: { ...data.settings, voiceConversion: { ...data.settings.voiceConversion, f0Condition: event.target.checked } } })} type="checkbox" /><span>Preserva melodia e intonazione (F0)</span></label>
                <label className="admin-inline-check"><input checked={data.settings.voiceConversion.autoF0Adjust} onChange={(event) => setData({ ...data, settings: { ...data.settings, voiceConversion: { ...data.settings.voiceConversion, autoF0Adjust: event.target.checked } } })} type="checkbox" /><span>Adatta automaticamente il registro vocale</span></label>
                <p className="image-edit-profile-note">Pipeline locale: BS-RoFormer separa voce e base, Seed-VC trasferisce soltanto il timbro, poi FFmpeg ricrea un WAV stereo. Ogni modello viene scaricato dalla VRAM all’uscita del relativo processo.</p>
              </div>
            </article>

            <article className="engine-config-card chat-engine-card">
              <div className="engine-config-heading">
                <div>
                  <span>LOCAL AI</span>
                  <h3>LLM Vision Chat</h3>
                </div>
                <b className={data.capabilities.chatRuntime.ready ? "admin-ready" : "admin-warning"}>
                  {data.capabilities.chatRuntime.ready ? data.capabilities.chatRuntime.loaded ? "CARICATO" : "PRONTO" : "SETUP"}
                </b>
              </div>
              <div className="admin-form image-edit-engine-form">
                <label>
                  <span>Modello LLM GGUF</span>
                  <select value={data.settings.chat.model} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, chat: { ...data.settings.chat, model: event.target.value } },
                  })}>
                    {compatibleEngineOptions(data.capabilities.chatModels, data.settings.chat.model, /\.gguf$/i).map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <label>
                  <span>Projector vision mmproj</span>
                  <select value={data.settings.chat.projector} onChange={(event) => setData({
                    ...data,
                    settings: { ...data.settings, chat: { ...data.settings.chat, projector: event.target.value } },
                  })}>
                    {compatibleEngineOptions(data.capabilities.chatProjectors, data.settings.chat.projector, /mmproj.*\.gguf$/i).map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <label><span>Contesto</span><input min="2048" max="262144" step="1024" type="number" value={data.settings.chat.nCtx} onChange={(event) => setData({ ...data, settings: { ...data.settings, chat: { ...data.settings.chat, nCtx: Number(event.target.value) } } })} /></label>
                <label><span>Layer GPU (-1 = tutti)</span><input min="-1" max="200" step="1" type="number" value={data.settings.chat.nGpuLayers} onChange={(event) => setData({ ...data, settings: { ...data.settings, chat: { ...data.settings.chat, nGpuLayers: Number(event.target.value) } } })} /></label>
                <label><span>Thread CPU</span><input min="1" max="128" step="1" type="number" value={data.settings.chat.nThreads} onChange={(event) => setData({ ...data, settings: { ...data.settings, chat: { ...data.settings.chat, nThreads: Number(event.target.value) } } })} /></label>
                <label><span>Token risposta</span><input min="128" max="8192" step="128" type="number" value={data.settings.chat.maxNewTokens} onChange={(event) => setData({ ...data, settings: { ...data.settings, chat: { ...data.settings.chat, maxNewTokens: Number(event.target.value) } } })} /></label>
                <label><span>Temperature</span><input min="0" max="2" step="0.05" type="number" value={data.settings.chat.temperature} onChange={(event) => setData({ ...data, settings: { ...data.settings, chat: { ...data.settings.chat, temperature: Number(event.target.value) } } })} /></label>
                <label><span>Top P</span><input min="0.01" max="1" step="0.01" type="number" value={data.settings.chat.topP} onChange={(event) => setData({ ...data, settings: { ...data.settings, chat: { ...data.settings.chat, topP: Number(event.target.value) } } })} /></label>
                <p className="image-edit-profile-note">
                  {data.capabilities.chatRuntime.ready
                    ? `llama.cpp ${data.capabilities.chatRuntime.version ?? "rilevato"} · il modello resta in cache durante la conversazione e viene scaricato automaticamente prima dei render.`
                    : `Runtime non pronto: ${data.capabilities.chatRuntime.error ?? "installa il nodo incluso e riavvia ComfyUI"}`}
                </p>
              </div>
            </article>
          </div>

          <div className="admin-footer">
            <span>
              {message} · {data.capabilities.models.length} modelli · {data.capabilities.loras.length} LoRA
            </span>
            <div>
              <button className="secondary" disabled={saving} onClick={() => void loadSettings()} type="button">
                Aggiorna liste
              </button>
              <button className="secondary" disabled={saving} onClick={() => void logout()} type="button">
                Esci Admin
              </button>
              <button disabled={saving} onClick={() => void saveAllSettings()} type="button">
                {saving ? "Salvataggio…" : "Salva tutto"}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="admin-loading">{message}</div>
      )}
    </section>
  );
}

function StudioApp() {
  const [activeView, setActiveView] = useState<"chat" | "studio" | "projects" | "montages" | "characters" | "library" | "admin">("studio");
  const [studioMediaMode, setStudioMediaMode] = useState<"video" | "image" | "audio">("video");
  const [audioResetToken, setAudioResetToken] = useState(0);
  const [audioStudioJobId, setAudioStudioJobId] = useState<string | null>(null);
  const [imageResetToken, setImageResetToken] = useState(0);
  const [imageStudioHandoff, setImageStudioHandoff] = useState<{
    token: number;
    references: ImageStudioIncomingReference[];
    jobId?: string | null;
  } | null>(null);
  const [libraryInitialKind, setLibraryInitialKind] = useState<"all" | "character" | "object">("all");
  const [montageTarget, setMontageTarget] = useState<{ projectId: string; timelineId: string } | null>(null);
  const [studioProjects, setStudioProjects] = useState<ProjectSummary[]>([]);
  const [studioProjectId, setStudioProjectId] = useState("");
  const [projectJobs, setProjectJobs] = useState<RemoteJob[]>([]);
  const [sourceJobId, setSourceJobId] = useState<string | null>(null);
  const [muteDiegetic, setMuteDiegetic] = useState(false);
  const [muteNonDiegetic, setMuteNonDiegetic] = useState(false);
  const [qualityMode, setQualityMode] = useState<QualityMode>("fast");
  const [turboEnabled, setTurboEnabled] = useState(true);
  const [candidateCount, setCandidateCount] = useState(4);
  const [shotCount, setShotCount] = useState(1);
  const [duration, setDuration] = useState<5 | 10 | 15>(10);
  const [megapixels, setMegapixels] = useState<Megapixels>(0.5);
  const [mode, setMode] = useState<StudioMode>("t2v");
  const [aspectFormat, setAspectFormat] = useState("16:9 landscape");
  const [seedMode, setSeedMode] = useState<SeedMode>("random");
  const [seedValue, setSeedValue] = useState("1024");
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [referenceRoles, setReferenceRoles] = useState("AUTO");
  const [keyframePositions, setKeyframePositions] = useState("AUTO");
  const [uploadingAssets, setUploadingAssets] = useState(false);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [mediaPickerBusy, setMediaPickerBusy] = useState(false);
  const [mediaLibraryAssets, setMediaLibraryAssets] = useState<CreativeAsset[]>([]);
  const [mediaExternalAssets, setMediaExternalAssets] = useState<ExternalMediaAsset[]>([]);
  const [mediaRecentJobs, setMediaRecentJobs] = useState<RemoteJob[]>([]);
  const [mediaProjectImageJobs, setMediaProjectImageJobs] = useState<ImagePickerJob[]>([]);
  const [mediaReusableImageJobs, setMediaReusableImageJobs] = useState<ImagePickerJob[]>([]);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const mediaPickerLoadedProjectRef = useRef<string | null>(null);
  const mediaPickerLoadGenerationRef = useRef(0);
  const latestJobRestoreRef = useRef(false);
  const studioProjectIdRef = useRef(studioProjectId);
  studioProjectIdRef.current = studioProjectId;
  useEffect(() => {
    if (!mediaPickerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMediaPickerOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [mediaPickerOpen]);
  const [prompt, setPrompt] = useState(
    "A brilliant fantasy wizard faces a colossal golden dragon above a sunlit mountain citadel. Fast cinematic action, sweeping camera moves, magical shields and spectacular elemental attacks.",
  );
  const [selected, setSelected] = useState<number | null>(1);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [currentJobMegapixels, setCurrentJobMegapixels] = useState<Megapixels>(0.5);
  const [postprocessContract, setPostprocessContract] = useState(0);
  const [pendingUpscaleRequest, setPendingUpscaleRequest] =
    useState<PendingUpscaleRequest | null>(null);
  const [regenerateTarget, setRegenerateTarget] = useState<{
    candidateId?: number;
    prompt: string;
  } | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [connection, setConnection] = useState<{
    state: ConnectionState;
    label: string;
    detail: string | null;
  }>({
    state: "checking",
    label: "Connessione in corso",
    detail: null,
  });
  const [fastSteps, setFastSteps] = useState(8);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const candidateGridRef = useRef<HTMLDivElement>(null);
  const upscaleCancelRef = useRef<HTMLButtonElement>(null);
  const upscaleConfirmRef = useRef<HTMLButtonElement>(null);
  const upscaleTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!pendingUpscaleRequest) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = upscaleTriggerRef.current;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() =>
      upscaleCancelRef.current?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingUpscaleRequest(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus();
      });
    };
  }, [pendingUpscaleRequest]);

  const visibleCandidates = candidates.slice(0, candidateCount);
  const playableCandidates = visibleCandidates.filter(
    (candidate) => candidate.status === "ready" && candidate.mediaPath,
  ).length;
  const mediaGeneratedImages = useMemo(() => {
    const seen = new Set<string>();
    const collected: GeneratedImagePickerItem[] = [];
    const append = (jobs: ImagePickerJob[]) => {
      for (const job of jobs) {
        for (const candidate of job.candidates) {
          if (candidate.status !== "ready" || !candidate.output) continue;
          const key = `${job.id}-${candidate.index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const linkedToProject = (candidate.projectLinks ?? []).some((link) =>
            typeof link === "string" ? link === studioProjectId : link.projectId === studioProjectId,
          );
          collected.push({
            job,
            candidate: { ...candidate, output: candidate.output },
            sameProject: linkedToProject || job.originProjectId === studioProjectId,
          });
        }
      }
    };
    append(mediaProjectImageJobs);
    append(mediaReusableImageJobs);
    return collected;
  }, [mediaProjectImageJobs, mediaReusableImageJobs, studioProjectId]);
  const mediaProjectGeneratedImages = mediaGeneratedImages.filter((item) => item.sameProject);
  const mediaOtherGeneratedImages = mediaGeneratedImages.filter((item) => !item.sameProject);
  const promptMentionOptions = useMemo(() => {
    const query = mentionState?.query ?? "";
    const seen = new Set<string>();
    const loaded = mediaAssets.flatMap((asset) => {
      if (!asset.mention || seen.has(asset.mention)) return [];
      seen.add(asset.mention);
      return [{
        kind: "loaded" as const,
        label: asset.mention,
        detail: asset.caption ?? asset.name,
        previewKind: asset.kind,
        previewPath: mediaPreviewPath(asset),
        asset,
      }];
    });
    const library = mediaLibraryAssets.map((asset) => ({
      kind: "library" as const,
      label: mentionBase(asset.name),
      detail: `${asset.kind === "character" ? "Personaggio" : "Oggetto"} · ${asset.referenceCount} reference`,
      previewKind: "picture" as const,
      previewPath: asset.hero?.mediaPath,
      asset,
    }));
    const external = mediaExternalAssets.map((asset) => ({
      kind: "external" as const,
      label: mentionBase(asset.originalName),
      detail: `Esterno · ${asset.originProjectName ?? "condiviso"}`,
      previewKind: asset.kind,
      previewPath: asset.mediaPath,
      asset,
    }));
    const images = mediaGeneratedImages.map((item) => ({
      kind: "image" as const,
      label: mentionBase(`immagine_${item.job.id.slice(0, 8)}_${item.candidate.index}`),
      detail: `${item.job.originProjectName ?? "Immagine generata"} · candidato ${item.candidate.index}`,
      previewKind: "picture" as const,
      previewPath: item.candidate.output.mediaPath,
      ...item,
    }));
    const videos = mediaRecentJobs.flatMap((job) =>
      job.candidates
        .filter((candidate) => candidate.output)
        .map((candidate) => ({
          kind: "video" as const,
          label: mentionBase(`video_${job.id.slice(0, 8)}_${candidate.index}`),
          detail: `${job.projectName ?? "Senza progetto"} · ${job.request.durationSeconds * (job.request.shotCount ?? 1)}s`,
          previewKind: "video" as const,
          previewPath: candidate.output!.mediaPath,
          job,
          candidate,
        })),
    );
    return [...loaded, ...external, ...images, ...library, ...videos]
      .filter((item) => !query || `${item.label} ${item.detail}`.toLowerCase().includes(query))
      .slice(0, 12);
  }, [mediaAssets, mediaExternalAssets, mediaGeneratedImages, mediaLibraryAssets, mediaRecentJobs, mentionState?.query]);
  const modeConfig = modes.find((item) => item.value === mode) ?? modes[0];
  const effectiveSteps =
    qualityMode === "fast"
      ? fastSteps
      : qualityMode === "min"
        ? 12
        : qualityMode === "med"
          ? 20
          : 30;
  const generationPreset: GenerationPreset =
    qualityMode === "fast"
      ? turboEnabled ? "fast" : "8"
      : qualityMode === "min"
        ? "12"
        : qualityMode === "med"
          ? "20"
          : "30";

  function selectGenerationPreset(preset: GenerationPreset) {
    if (preset === "fast") {
      setQualityMode("fast");
      setTurboEnabled(true);
      return;
    }
    setTurboEnabled(false);
    setQualityMode(
      preset === "8" ? "fast" : preset === "12" ? "min" : preset === "20" ? "med" : "max",
    );
  }
  const estimatedCredits = useMemo(
    () =>
      Math.ceil(
        10 *
          (effectiveSteps / 4) *
          (duration / 5) *
          shotCount *
          (megapixels / 0.5) *
          candidateCount *
          modeConfig.factor,
      ),
    [candidateCount, duration, effectiveSteps, megapixels, modeConfig.factor, shotCount],
  );
  const estimatedSeconds = useMemo(
    () =>
      Math.round(
        28 +
          172 *
            (duration / 5) *
            shotCount *
            (megapixels / 0.5) *
            (effectiveSteps / 8) *
            candidateCount,
      ),
    [candidateCount, duration, effectiveSteps, megapixels, shotCount],
  );
  const estimatedTimeLabel = useMemo(() => {
    const minimumMinutes = Math.max(1, Math.round((estimatedSeconds * 0.85) / 60));
    const maximumMinutes = Math.max(
      minimumMinutes,
      Math.round((estimatedSeconds * 1.3) / 60),
    );
    return `${minimumMinutes}–${maximumMinutes} min`;
  }, [estimatedSeconds]);

  const studioProject = studioProjects.find(item => item.id === studioProjectId) ?? null;

  async function loadStudioProjects(preferredId?: string | null) {
    let response = await fetch(`${bridgeUrl}/api/projects`, { cache: "no-store" });
    let payload = (await response.json()) as { projects?: ProjectSummary[]; project?: ProjectDetail; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    let loaded = payload.projects ?? [];
    if (loaded.length === 0) {
      response = await fetch(`${bridgeUrl}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Progetto senza titolo" }),
      });
      payload = (await response.json()) as { project?: ProjectDetail; error?: string };
      if (!response.ok || !payload.project) throw new Error(payload.error ?? "Creazione progetto iniziale fallita");
      loaded = [payload.project];
    }
    setStudioProjects(loaded);
    setStudioProjectId(current => {
      const wanted = preferredId ?? current;
      return wanted && loaded.some(item => item.id === wanted) ? wanted : loaded[0]?.id ?? "";
    });
    return loaded;
  }

  async function createStudioProject() {
    const name = window.prompt("Nome del nuovo progetto", "Nuovo progetto")?.trim();
    if (!name) return;
    try {
      const response = await fetch(`${bridgeUrl}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = (await response.json()) as { project?: ProjectDetail; error?: string };
      if (!response.ok || !payload.project) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      await loadStudioProjects(payload.project.id);
      setRunMessage(`Progetto “${payload.project.name}” creato`);
      beginNewGeneration(payload.project.id);
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "Creazione progetto fallita");
    }
  }

  function beginNewGeneration(projectId?: string) {
    if (!projectId) {
      void createStudioProject();
      return;
    }
    setStudioMediaMode("video");
    setStudioProjectId(projectId);
    setSourceJobId(null);
    setCurrentJobId(null);
    setPendingUpscaleRequest(null);
    setActiveJobId(null);
    setIsRunning(false);
    setSelected(null);
    setPrompt("");
    setMediaAssets([]);
    setReferenceRoles("AUTO");
    setKeyframePositions("AUTO");
    setMode("t2v");
    setCandidates(initialCandidates.map((candidate) => ({ ...candidate })));
    setComposerExpanded(true);
    setActiveView("studio");
    setRunMessage("Nuova generazione pronta");
  }

  async function loadProjectJobs(id: string) {
    if (!id) { setProjectJobs([]); return; }
    const query = new URLSearchParams({ limit: "30", projectId: id });
    const response = await fetch(`${bridgeUrl}/api/jobs?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as { jobs?: RemoteJob[] };
    setProjectJobs(payload.jobs ?? []);
  }

  function openJob(job: RemoteJob, restored = false) {
    setStudioMediaMode("video");
    setPendingUpscaleRequest(null);
    setCurrentJobId(job.id);
    setPrompt(job.request.prompt);
    setCandidateCount(job.request.candidateCount);
    setShotCount(job.request.shotCount ?? 1);
    setDuration(job.request.durationSeconds);
    setMegapixels(job.request.megapixels);
    setCurrentJobMegapixels(job.request.megapixels);
    setAspectFormat(job.request.aspectFormat);
    setMode(uiModeByGeneration[job.request.generationMode] ?? "t2v");
    setSeedMode(
      job.request.seedMode ??
        (job.request.seed === undefined ? "random" : "base"),
    );
    setQualityMode(job.request.qualityMode ?? "fast");
    setTurboEnabled(job.engine.profile === "fast");
    if (job.request.seed !== undefined) {
      setSeedValue(String(job.request.seed));
    }
    try {
      const restoredAssets = JSON.parse(job.request.mediaState ?? "[]");
      if (Array.isArray(restoredAssets)) {
        const normalized: MediaAsset[] = [];
        for (const raw of restoredAssets as MediaAsset[]) {
          normalized.push({
            ...raw,
            caption: raw.caption ?? raw.name.replace(/\.[^.]+$/, ""),
            mention: raw.mention ?? uniqueMention(raw.name, normalized),
          });
        }
        setMediaAssets(normalized);
      } else {
        setMediaAssets([]);
      }
    } catch {
      setMediaAssets([]);
    }
    setReferenceRoles(job.request.referenceRoles ?? "AUTO");
    setKeyframePositions(job.request.keyframePositions ?? "AUTO");
    setMuteDiegetic(Boolean(job.request.muteDiegetic));
    setMuteNonDiegetic(Boolean(job.request.muteNonDiegetic));
    setSourceJobId(job.sourceJobId ?? job.request.sourceJobId ?? null);
    if (job.projectId ?? job.request.projectId) {
      setStudioProjectId((job.projectId ?? job.request.projectId)!);
    }
    setSelected(job.selectedCandidateIndex);
    setCandidates(
      job.candidates.map((remote) => {
        const status: CandidateStatus =
          remote.status === "prepared" ? "submitted" : remote.status;
        return {
          id: remote.index,
          progress:
            typeof remote.progress === "number"
              ? remote.progress
              : status === "ready"
                ? 100
                : 0,
          seed: remote.seed,
          status,
          promptId: remote.promptId ?? undefined,
          mediaPath: remote.output?.mediaPath ?? null,
          phaseLabel: remote.phaseLabel,
          error: remote.error,
          progressExact: remote.progressExact ?? status === "ready",
          processingSeconds: remote.processingSeconds,
          variants: (job.variants ?? []).filter(
            (variant) => variant.sourceCandidateIndex === remote.index,
          ),
          activeVariantId: null,
        };
      }),
    );

    const variantActive = (job.variants ?? []).some(
      (variant) => variant.status !== "ready" && variant.status !== "failed",
    );
    const active =
      ["prepared", "submitted", "running"].includes(job.status) || variantActive;
    setIsRunning(active);
    setActiveJobId(active ? job.id : null);
    setRunMessage(
      restored
        ? `Ultimo job ${job.id.slice(0, 8)} ripristinato dal database`
        : `Job ${job.id.slice(0, 8)} aperto dalla cronologia`,
    );
    setActiveView("studio");
  }

  async function openChatMediaInStudio(kind: "video" | "image" | "audio", jobId: string) {
    if (kind === "video") {
      setRunMessage(`Apertura del job ${jobId.slice(0, 8)} dalla Chat…`);
      try {
        const response = await fetch(`${bridgeUrl}/api/jobs/${jobId}`, { cache: "no-store" });
        const payload = await response.json() as { job?: RemoteJob; error?: string };
        if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
        openJob(payload.job);
        setRunMessage(`Job ${jobId.slice(0, 8)} aperto dalla Chat`);
      } catch (error) {
        setRunMessage(error instanceof Error ? error.message : "Video Chat non disponibile");
      }
      return;
    }
    if (kind === "image") {
      setImageStudioHandoff({ token: Date.now(), references: [], jobId });
    } else {
      setAudioStudioJobId(jobId);
      setAudioResetToken((current) => current + 1);
    }
    setStudioMediaMode(kind);
    setActiveView("studio");
    setRunMessage(`Job ${jobId.slice(0, 8)} aperto dalla Chat`);
  }

  useEffect(() => {
    void loadStudioProjects().catch(error =>
      setRunMessage(error instanceof Error ? error.message : "Progetti non disponibili"),
    );
  }, []);

  useEffect(() => {
    void loadProjectJobs(studioProjectId);
  }, [studioProjectId, currentJobId, activeJobId]);

  useEffect(() => {
    let disposed = false;

    const checkConnection = async () => {
      try {
        const response = await fetch(`${bridgeUrl}/api/health`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);

        const health = (await response.json()) as BridgeHealthPayload;
        if (disposed) return;

        setPostprocessContract(
          typeof health.bridge?.postprocessContract === "number"
            ? health.bridge.postprocessContract
            : 0,
        );
        if (typeof health.fastEngine?.steps === "number") {
          setFastSteps(health.fastEngine.steps);
        }
        if (!health.comfyui?.connected) {
          setConnection({
            state: "comfy-offline",
            label: "ComfyUI offline",
            detail: health.comfyui?.error ?? "Bridge online, ComfyUI non raggiungibile",
          });
          return;
        }

        const running = health.comfyui.queue?.running ?? 0;
        const pending = health.comfyui.queue?.pending ?? 0;
        const queueLabel =
          running + pending > 0 ? ` · ${running} attivi · ${pending} in coda` : "";

        setConnection({
          state: "connected",
          label: `ComfyUI connesso${queueLabel}`,
          detail: null,
        });
      } catch (error) {
        if (disposed) return;
        setPostprocessContract(0);
        setConnection({
          state: "bridge-offline",
          label: "Bridge offline",
          detail: error instanceof Error ? error.message : "Bridge non raggiungibile",
        });
      }
    };

    void checkConnection();
    const timer = window.setInterval(() => void checkConnection(), 5000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (
      connection.state !== "connected" ||
      latestJobRestoreRef.current ||
      currentJobId
    ) return;
    let disposed = false;
    latestJobRestoreRef.current = true;
    const restoreLatestJob = async () => {
      try {
        const response = await fetch(`${bridgeUrl}/api/jobs?limit=1`, {
          cache: "no-store",
        });
        if (!response.ok) {
          latestJobRestoreRef.current = false;
          return;
        }
        const payload = (await response.json()) as { jobs?: RemoteJob[] };
        const job = payload.jobs?.[0];
        if (!job || disposed) return;
        openJob(job, true);
      } catch {
        latestJobRestoreRef.current = false;
        // La pagina resta utilizzabile anche se non esiste ancora una cronologia.
      }
    };
    void restoreLatestJob();
    return () => {
      disposed = true;
    };
  }, [connection.state, currentJobId]);

  useEffect(() => {
    if (!activeJobId) return;
    let disposed = false;
    const poll = async () => {
      try {
        const response = await fetch(`${bridgeUrl}/api/jobs/${activeJobId}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
        const payload = (await response.json()) as { job: RemoteJob };
        if (disposed) return;
        setCandidates((current) =>
          current.map((candidate) => {
            const remote = payload.job.candidates.find((item) => item.index === candidate.id);
            if (!remote) return candidate;
            const variants = (payload.job.variants ?? []).filter(
              (variant) => variant.sourceCandidateIndex === candidate.id,
            );
            const remoteStatus: CandidateStatus =
              remote.status === "prepared" ? "submitted" : remote.status;
            const progress =
              typeof remote.progress === "number"
                ? remote.progress
                : remote.status === "ready"
                  ? 100
                  : 0;
            return {
              ...candidate,
              seed: remote.seed,
              promptId: remote.promptId,
              status: remoteStatus,
              progress,
              mediaPath: remote.output?.mediaPath ?? null,
              phaseLabel: remote.phaseLabel,
              error: remote.error,
              progressExact: remote.progressExact ?? remote.status === "ready",
              processingSeconds: remote.processingSeconds,
              variants,
              activeVariantId: candidate.activeVariantId && variants.some(
                (variant) => variant.id === candidate.activeVariantId,
              )
                ? candidate.activeVariantId
                : null,
            };
          }),
        );
        const variantActive = (payload.job.variants ?? []).some(
          (variant) => variant.status !== "ready" && variant.status !== "failed",
        );
        if (
          (payload.job.status === "completed" || payload.job.status === "partial") &&
          !variantActive
        ) {
          setIsRunning(false);
          setActiveJobId(null);
          setRunMessage(
            (payload.job.variants?.length ?? 0) > 0
              ? "Post-process completato"
              : payload.job.status === "completed"
                ? "Generazione completata"
                : "Generazione completata con errori",
          );
        } else if (variantActive) {
          setIsRunning(true);
        }
      } catch (error) {
        if (!disposed) setRunMessage(error instanceof Error ? error.message : "Monitoraggio fallito");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeJobId]);

  async function startGeneration() {
    const generationMode = generationModeByUi[mode];
    const pictureCount = mediaAssets.filter((asset) => asset.kind === "picture").length;
    const videoCount = mediaAssets.filter((asset) => asset.kind === "video").length;
    if (
      (generationMode === "I2V" || generationMode === "KEYFRAMES") &&
      pictureCount === 0
    ) {
      setRunMessage("Carica almeno un'immagine per questa modalità.");
      return;
    }
    if (
      (generationMode === "VIDEO EXTENSION" ||
        generationMode === "VIDEO EDITING") &&
      videoCount === 0
    ) {
      setRunMessage("Scegli una clip o carica un video sorgente.");
      return;
    }
    if (
      generationMode === "R2V" &&
      mediaAssets.length === 0
    ) {
      setRunMessage("Reference richiede almeno un'immagine, video o audio.");
      return;
    }
    const numericSeed = Number(seedValue);
    if (
      seedMode !== "random" &&
      (seedValue.trim() === "" ||
        !Number.isSafeInteger(numericSeed) ||
        numericSeed < 0 ||
        numericSeed > 9_007_199_254_740_000)
    ) {
      setRunMessage("Inserisci un seed intero valido tra 0 e 9007199254740000.");
      return;
    }
    setSelected(null);
    setCurrentJobId(null);
    setRunMessage("Invio a ComfyUI…");
    setCandidates(
      Array.from({ length: 4 }, (_, index) => ({
        id: index + 1,
        progress: 0,
        seed: 0,
        status: (index < candidateCount ? "submitted" : "idle") as CandidateStatus,
      })),
    );
    setIsRunning(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: resolvePromptMentions(prompt, mediaAssets),
          candidateCount,
          shotCount,
          durationSeconds: duration,
          megapixels,
          generationMode,
          aspectFormat,
          seedMode,
          qualityMode,
          turboEnabled,
          seed: seedMode === "random" ? undefined : numericSeed,
          mediaState:
            generationMode === "T2V" ? "[]" : JSON.stringify(mediaAssets),
          referenceRoles: buildReferenceRoles(mediaAssets, referenceRoles),
          keyframePositions,
          sourceVideoAudio: "AUTO",
          projectId: studioProjectId || null,
          sourceJobId,
          muteDiegetic,
          muteNonDiegetic,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        job?: { id: string; candidates: Array<{ index: number; seed: number; promptId: string }> };
      };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setCandidates((current) => current.map((candidate) => {
        const queued = payload.job!.candidates.find((item) => item.index === candidate.id);
        return queued
          ? { ...candidate, seed: queued.seed, promptId: queued.promptId, status: candidate.id === 1 ? "rendering" : "queued", progress: 0, progressExact: false, phaseLabel: candidate.id === 1 ? "Inviato a ComfyUI" : "In coda" }
          : candidate;
      }));
      setCurrentJobId(payload.job.id);
      setCurrentJobMegapixels(megapixels);
      setActiveJobId(payload.job.id);
      setRunMessage(`Job ${payload.job.id.slice(0, 8)} inviato a ComfyUI`);
      setComposerExpanded(false);
      window.requestAnimationFrame(() =>
        candidateGridRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        }),
      );
    } catch (error) {
      setIsRunning(false);
      setRunMessage(error instanceof Error ? error.message : "Invio fallito");
    }
  }

  async function cancelActiveRun() {
    if (!activeJobId || isCancelling) return;
    setIsCancelling(true);
    setRunMessage("Interruzione del run in corso…");
    try {
      const response = await fetch(`${bridgeUrl}/api/jobs/${activeJobId}/cancel`, {
        method: "POST",
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setRunMessage("Run interrotto");
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "Interruzione fallita");
    } finally {
      setIsCancelling(false);
    }
  }

  function appendCreativePreset(text: string) {
    setPrompt((current) => {
      const trimmed = current.trim();
      if (trimmed.toLowerCase().includes(text.toLowerCase())) return current;
      return `${trimmed}${trimmed ? "\n\n" : ""}Camera/style directive: ${text}.`;
    });
  }

  async function loadMediaPicker() {
    const loadGeneration = ++mediaPickerLoadGenerationRef.current;
    const requestedProjectId = studioProjectId;
    setMediaPickerBusy(true);
    mediaPickerLoadedProjectRef.current = requestedProjectId;
    setMediaProjectImageJobs([]);
    try {
      const projectImageQuery = new URLSearchParams({ limit: "200" });
      if (studioProjectId) projectImageQuery.set("projectId", studioProjectId);
      const reusableImageQuery = new URLSearchParams({ limit: "200" });
      const [
        libraryResponse,
        jobsResponse,
        projectImagesResponse,
        reusableImagesResponse,
        externalResponse,
      ] = await Promise.all([
        fetch(`${bridgeUrl}/api/library`, { cache: "no-store" }),
        fetch(`${bridgeUrl}/api/jobs?limit=200`, { cache: "no-store" }),
        studioProjectId
          ? fetch(`${bridgeUrl}/api/image-jobs?${projectImageQuery.toString()}`, { cache: "no-store" })
          : Promise.resolve(null),
        fetch(`${bridgeUrl}/api/image-jobs?${reusableImageQuery.toString()}`, { cache: "no-store" }),
        fetch(`${bridgeUrl}/api/external-media`, { cache: "no-store" }),
      ]);
      const libraryPayload = (await libraryResponse.json()) as { assets?: CreativeAsset[] };
      const jobsPayload = (await jobsResponse.json()) as { jobs?: RemoteJob[] };
      const projectImagesPayload = projectImagesResponse
        ? ((await projectImagesResponse.json()) as { jobs?: ImagePickerJob[] })
        : { jobs: [] as ImagePickerJob[] };
      const reusableImagesPayload = (await reusableImagesResponse.json()) as { jobs?: ImagePickerJob[] };
      const externalPayload = (await externalResponse.json()) as { assets?: ExternalMediaAsset[] };
      if (
        loadGeneration !== mediaPickerLoadGenerationRef.current ||
        requestedProjectId !== studioProjectIdRef.current
      ) return;
      if (libraryResponse.ok) setMediaLibraryAssets(libraryPayload.assets ?? []);
      if (jobsResponse.ok) setMediaRecentJobs(jobsPayload.jobs ?? []);
      if (projectImagesResponse?.ok) setMediaProjectImageJobs(projectImagesPayload.jobs ?? []);
      if (reusableImagesResponse.ok) setMediaReusableImageJobs(reusableImagesPayload.jobs ?? []);
      if (externalResponse.ok) setMediaExternalAssets(externalPayload.assets ?? []);
    } catch (error) {
      if (loadGeneration === mediaPickerLoadGenerationRef.current) {
        setRunMessage(error instanceof Error ? error.message : "Libreria media non disponibile");
      }
    } finally {
      if (loadGeneration === mediaPickerLoadGenerationRef.current) setMediaPickerBusy(false);
    }
  }

  function insertPromptMention(mention: string) {
    const tag = `@${mention}`;
    let caret = prompt.length + tag.length + 1;
    setPrompt((current) => {
      if (mentionState) {
        caret = mentionState.start + tag.length;
        return `${current.slice(0, mentionState.start)}${tag}${current.slice(mentionState.end)}`;
      }
      const separator = current && !/\s$/.test(current) ? " " : "";
      caret = current.length + separator.length + tag.length;
      return `${current}${separator}${tag}`;
    });
    setMentionState(null);
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(caret, caret);
    });
  }

  function insertMediaInPrompt(index: number) {
    const token = mediaToken(mediaAssets, index);
    const textarea = promptRef.current;
    const start = textarea?.selectionStart ?? prompt.length;
    const end = textarea?.selectionEnd ?? start;
    let caret = start + token.length;
    setPrompt((current) => {
      const before = current.slice(0, start);
      const after = current.slice(end);
      const prefix = before && !/\s$/.test(before) ? " " : "";
      const suffix = after && !/^\s/.test(after) ? " " : "";
      caret = before.length + prefix.length + token.length;
      return `${before}${prefix}${token}${suffix}${after}`;
    });
    setMentionState(null);
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(caret, caret);
    });
  }

  function handlePromptChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    const caret = event.target.selectionStart;
    setPrompt(value);
    const match = value.slice(0, caret).match(/@([^\s@]*)$/);
    if (!match) {
      setMentionState(null);
      return;
    }
    setMentionState({ start: caret - match[0].length, end: caret, query: match[1].toLowerCase() });
    if (mediaPickerLoadedProjectRef.current !== studioProjectId) {
      void loadMediaPicker();
    }
  }

  async function addLibraryAsset(summary: CreativeAsset) {
    setMediaPickerBusy(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/library/${summary.id}`, { cache: "no-store" });
      const payload = (await response.json()) as { asset?: CreativeAsset; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      const references = payload.asset.references ?? [];
      if (!references.length) throw new Error(`“${summary.name}” non contiene immagini`);
      const mention = uniqueMention(summary.name, mediaAssets);
      const available = Math.max(0, 18 - mediaAssets.length);
      const additions = references.slice(0, available).map((reference) => ({
        kind: "picture" as const,
        file: reference.file,
        name: reference.name,
        caption: summary.name,
        mention,
        mediaPath: reference.mediaPath,
        libraryAssetId: summary.id,
        referenceRole: reference.role,
        width: reference.width,
        height: reference.height,
        audio_mode: "off" as const,
        uid: crypto.randomUUID(),
      }));
      setMediaAssets((current) => [...current, ...additions].slice(0, 18));
      if (mode === "t2v") setMode("reference");
      insertPromptMention(mention);
      setMediaPickerOpen(false);
      setRunMessage(`${additions.length} viste di “${summary.name}” collegate senza nuovo upload`);
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "Asset non disponibile");
    } finally {
      setMediaPickerBusy(false);
    }
  }

  function addGeneratedImage(item: GeneratedImagePickerItem) {
    if (mediaAssets.length >= 18) {
      setRunMessage("Puoi collegare al massimo 18 media");
      return;
    }
    const { job, candidate } = item;
    const name = `Immagine ${job.id.slice(0, 8)} · candidato ${candidate.index}`;
    const mention = uniqueMention(name, mediaAssets);
    setMediaAssets((current) => [
      ...current,
      {
        kind: "picture" as const,
        file: imageReferenceFile(candidate.output),
        name,
        caption: job.prompt.slice(0, 180),
        mention,
        mediaPath: candidate.output.mediaPath,
        referenceRole: imageCandidateTag(candidate, studioProjectId),
        width: candidate.output.width ?? job.width,
        height: candidate.output.height ?? job.height,
        audio_mode: "off" as const,
        uid: crypto.randomUUID(),
      },
    ].slice(0, 18));
    if (mode === "t2v") setMode("reference");
    insertPromptMention(mention);
    setMediaPickerOpen(false);
    setRunMessage(
      item.sameProject
        ? "Immagine del progetto collegata senza nuovo upload"
        : `Immagine di “${job.originProjectName ?? "un altro progetto"}” riutilizzata senza nuovo upload`,
    );
  }

  function addRecentVideo(job: RemoteJob, candidate: RemoteJob["candidates"][number]) {
    if (!candidate.output) return;
    setStudioMediaMode("video");
    const url = new URL(candidate.output.mediaPath, bridgeUrl);
    const filename = url.searchParams.get("filename") ?? candidate.output.filename;
    const subfolder = url.searchParams.get("subfolder") ?? "";
    const type = url.searchParams.get("type") ?? "output";
    const file = `${subfolder ? `${subfolder}/` : ""}${filename} [${type}]`;
    const name = `Video ${job.id.slice(0, 8)} · candidato ${candidate.index}`;
    const mention = uniqueMention(name, mediaAssets);
    setMediaAssets((current) => [
      ...current,
      {
        kind: "video" as const,
        file,
        name,
        caption: job.request.prompt.slice(0, 180),
        mention,
        mediaPath: candidate.output!.mediaPath,
        has_audio: true,
        audio_mode: "paired" as const,
        uid: crypto.randomUUID(),
      },
    ].slice(0, 18));
    if (mode === "t2v") setMode("reference");
    insertPromptMention(mention);
    setMediaPickerOpen(false);
    setActiveView("studio");
    setRunMessage("Video della libreria inviato allo Studio come allegato");
  }

  function addExternalMedia(asset: ExternalMediaAsset) {
    const existing = mediaAssets.find(
      (item) => item.externalMediaId === asset.id || item.file === asset.file,
    );
    if (existing) {
      if (existing.mention) insertPromptMention(existing.mention);
      setMediaPickerOpen(false);
      setActiveView("studio");
      setRunMessage(`“${asset.originalName}” è già collegato allo Studio`);
      return;
    }
    if (mediaAssets.length >= 18) {
      setRunMessage("Puoi collegare al massimo 18 media");
      return;
    }
    const mention = uniqueMention(asset.originalName, mediaAssets);
    setMediaAssets((current) => [
      ...current,
      {
        kind: asset.kind,
        file: asset.file,
        name: asset.name,
        caption: asset.originalName.replace(/\.[^.]+$/, ""),
        mention,
        mediaPath: asset.mediaPath,
        externalMediaId: asset.id,
        origin: "external" as const,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        has_audio: asset.hasAudio,
        audio_mode:
          asset.kind === "video"
            ? "paired" as const
            : asset.kind === "audio"
              ? "standalone" as const
              : "off" as const,
        audio_role: asset.kind === "audio" ? "reference_audio" as const : undefined,
        uid: crypto.randomUUID(),
      },
    ].slice(0, 18));
    if (mode === "t2v") setMode("reference");
    insertPromptMention(mention);
    setMediaPickerOpen(false);
    setActiveView("studio");
    setRunMessage(`Media esterno “${asset.originalName}” collegato senza nuovo upload`);
  }

  async function uploadAssetFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploadingAssets(true);
    try {
      const uploaded: MediaAsset[] = [];
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file, file.name);
        const query = studioProjectId
          ? `?${new URLSearchParams({ projectId: studioProjectId }).toString()}`
          : "";
        const response = await fetch(`${bridgeUrl}/api/assets/upload${query}`, {
          method: "POST",
          body,
        });
        const payload = (await response.json()) as {
          asset?: Omit<MediaAsset, "uid" | "audio_mode">;
          external?: ExternalMediaAsset;
          error?: string;
        };
        if (!response.ok || !payload.asset) {
          throw new Error(payload.error ?? `Upload HTTP ${response.status}`);
        }
        uploaded.push({
          ...payload.asset,
          audio_mode:
            payload.asset.kind === "video"
              ? "paired"
              : payload.asset.kind === "audio"
                ? "standalone"
                : "off",
          audio_role: payload.asset.kind === "audio" ? "reference_audio" : undefined,
          uid: crypto.randomUUID(),
        });
        if (payload.external) {
          setMediaExternalAssets((current) => [
            payload.external!,
            ...current.filter((item) => item.id !== payload.external!.id),
          ]);
        }
      }
      setMediaAssets((current) => {
        const next = [...current];
        for (const asset of uploaded) {
          next.push({
            ...asset,
            caption: asset.name.replace(/\.[^.]+$/, ""),
            mention: uniqueMention(asset.name, next),
          });
        }
        return next.slice(0, 18);
      });
      setRunMessage(`${uploaded.length} asset caricati e salvati in Libreria come Esterni`);
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "Upload fallito");
    } finally {
      setUploadingAssets(false);
    }
  }

  function prepareVideoOperation(
    mediaPath: string,
    filename: string,
    operation: "continue" | "edit" | "reference",
    context?: { projectId?: string | null; sourceJobId?: string | null },
  ) {
    setStudioMediaMode("video");
    setPrompt("");
    const url = new URL(mediaPath, bridgeUrl);
    const outputFilename = url.searchParams.get("filename") ?? filename;
    const subfolder = url.searchParams.get("subfolder") ?? "";
    const type = url.searchParams.get("type") ?? "output";
    const annotated = `${subfolder ? `${subfolder}/` : ""}${outputFilename} [${type}]`;
    setMediaAssets([
      {
        kind: "video",
        file: annotated,
        name: filename,
        caption: filename.replace(/\.[^.]+$/, ""),
        mention: uniqueMention(filename, []),
        mediaPath,
        has_audio: true,
        audio_mode: "paired",
        uid: crypto.randomUUID(),
      },
    ]);
    setMode(operation);
    if (operation === "edit") {
      // Video Edit always uses the configured standard H3/Hybrid engine. The
      // FAST PDD profile is intentionally reserved for preview generation.
      setQualityMode("fast");
      setTurboEnabled(false);
    }
    setSourceJobId(context?.sourceJobId ?? currentJobId);
    if (context?.projectId) setStudioProjectId(context.projectId);
    setActiveView("studio");
    setRunMessage(
      operation === "continue"
        ? "Clip sorgente pronta: descrivi soltanto la nuova continuazione; il vecchio prompt non viene riutilizzato"
        : operation === "edit"
          ? "Clip sorgente pronta per un edit non distruttivo"
          : "Clip aggiunta come riferimento video",
    );
  }

  function prepareClipOperation(
    clip: ProjectClip,
    operation: "continue" | "edit" | "reference",
  ) {
    prepareVideoOperation(
      clip.output.mediaPath,
      clip.output.filename,
      operation,
      { projectId: clip.projectId, sourceJobId: clip.sourceJobId },
    );
  }

  function useCreativeReferences(
    asset: CreativeAsset,
    references: CreativeReference[],
  ) {
    setStudioMediaMode("video");
    const selectedReferences = references.slice(0, 12);
    const mention = uniqueMention(asset.name, mediaAssets);
    setMediaAssets(
      selectedReferences.map((reference) => ({
        kind: "picture" as const,
        file: reference.file,
        name: reference.name,
        caption: asset.name,
        mention,
        mediaPath: reference.mediaPath,
        libraryAssetId: asset.id,
        referenceRole: reference.role,
        width: reference.width,
        height: reference.height,
        audio_mode: "off" as const,
        uid: crypto.randomUUID(),
      })),
    );
    setReferenceRoles(
      selectedReferences
        .map(
          (reference, index) =>
            `Picture ${index + 1} = ${asset.name}, ${reference.role.replace("_", " ")}`,
        )
        .join("; "),
    );
    setMode("reference");
    insertPromptMention(mention);
    setActiveView("studio");
    setRunMessage(
      `${selectedReferences.length} reference di “${asset.name}” caricate nello Studio`,
    );
  }

  function sendAssetImagesToStudio(images: AssetLibraryImage[]) {
    const selectedImages = images.slice(0, 4);
    if (!selectedImages.length) return;
    const videoAttachments: MediaAsset[] = [];
    const imageReferences: ImageStudioIncomingReference[] = [];
    for (const [index, image] of selectedImages.entries()) {
      const mention = uniqueMention(image.name, videoAttachments);
      videoAttachments.push({
        kind: "picture",
        file: image.file,
        name: image.name,
        caption: image.detail.slice(0, 180),
        mention,
        mediaPath: image.mediaPath,
        referenceRole: image.tag === "untagged" ? undefined : image.tag,
        width: image.width,
        height: image.height,
        audio_mode: "off",
        uid: crypto.randomUUID(),
      });
      imageReferences.push({
        file: image.file,
        name: image.name,
        width: image.width,
        height: image.height,
        mediaPath: image.mediaPath,
        role: index === 0 ? "base" : "other",
      });
    }
    setMediaAssets(videoAttachments);
    setReferenceRoles(buildReferenceRoles(videoAttachments, "AUTO"));
    setMode("reference");
    setSourceJobId(null);
    setImageStudioHandoff({
      token: Date.now(),
      references: imageReferences,
      jobId: null,
    });
    setImageResetToken((current) => current + 1);
    setActiveView("studio");
    setRunMessage(
      `${selectedImages.length} immagini inviate allo Studio: disponibili in Video Reference e Immagini Edit`,
    );
  }

  function sendImageReferenceToVideo(reference: ImageStudioIncomingReference) {
    const name = reference.name?.trim() || reference.file.split(/[\\/]/).at(-1) || "Reference immagine";
    const attachment: MediaAsset = {
      kind: "picture",
      file: reference.file,
      name,
      caption: name.replace(/\.[^.]+$/, ""),
      mention: uniqueMention(name, []),
      mediaPath: reference.mediaPath,
      referenceRole: reference.role,
      width: reference.width,
      height: reference.height,
      audio_mode: "off",
      uid: crypto.randomUUID(),
    };
    setStudioMediaMode("video");
    setMediaAssets([attachment]);
    setReferenceRoles(buildReferenceRoles([attachment], "AUTO"));
    setMode("reference");
    setSourceJobId(null);
    setPrompt("");
    setMediaPickerOpen(false);
    setActiveView("studio");
    setRunMessage(`“${name}” inviata al tab Video come Picture 1 · modalità Reference`);
  }

  function controlCandidateVideos(action: "play" | "pause" | "restart") {
    const videos = Array.from(
      candidateGridRef.current?.querySelectorAll("video") ?? [],
    );
    if (videos.length === 0) return;
    if (action === "pause") {
      videos.forEach((video) => video.pause());
      return;
    }
    const selectedVideo =
      videos.find(
        (video) => Number(video.dataset.candidateIndex) === selected,
      ) ?? videos[0];
    const targetTime = action === "restart" ? 0 : selectedVideo.currentTime;
    videos.forEach((video) => {
      video.currentTime = targetTime;
      void video.play();
    });
  }

  async function selectCandidate(candidateId: number) {
    if (!currentJobId) {
      setRunMessage("Job corrente non identificato");
      return;
    }
    try {
      const response = await fetch(
        `${bridgeUrl}/api/jobs/${currentJobId}/select`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateIndex: candidateId }),
        },
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setSelected(candidateId);
      setRunMessage(`Candidato ${candidateId} selezionato e salvato`);
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "Selezione fallita");
    }
  }

  async function regenerateVideo(promptOverride: string) {
    if (!currentJobId || isRunning) return;
    const candidateId = regenerateTarget?.candidateId;
    setIsRunning(true);
    setRunMessage(candidateId === undefined
      ? "Rigenerazione batch con nuovi seed…"
      : `Rigenerazione candidato ${candidateId} con un nuovo seed…`);
    try {
      const response = await fetch(`${bridgeUrl}/api/jobs/${currentJobId}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(candidateId === undefined ? {} : { candidateIndex: candidateId }),
          prompt: promptOverride,
        }),
      });
      const payload = (await response.json()) as { job?: RemoteJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setProjectJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]);
      openJob(payload.job);
      setRegenerateTarget(null);
      setRunMessage(candidateId === undefined
        ? `Nuovo batch ${payload.job.id.slice(0, 8)} avviato con seed nuovi`
        : `Nuovo candidato ${payload.job.id.slice(0, 8)} avviato con un seed nuovo`);
    } catch (error) {
      setIsRunning(false);
      setRunMessage(error instanceof Error ? error.message : "Rigenerazione video non avviata");
    }
  }

  function requireUpdatedPostprocessContract() {
    if (postprocessContract >= 2) return true;
    setRunMessage("Bridge non aggiornato: riavvia H3 Studio");
    return false;
  }

  function requestCandidateUpscale(
    candidateId: number,
    targetMegapixels: UpscaleTargetMegapixels,
    trigger: HTMLButtonElement,
  ) {
    if (!currentJobId) {
      setRunMessage("Apri prima un job completato");
      return;
    }
    upscaleTriggerRef.current = trigger;
    setPendingUpscaleRequest({
      jobId: currentJobId,
      candidateId,
      sourceMegapixels: canonicalVideoMegapixels(currentJobMegapixels),
      targetMegapixels,
    });
  }

  function confirmCandidateUpscale() {
    const request = pendingUpscaleRequest;
    if (!request || !requireUpdatedPostprocessContract()) return;
    if (request.jobId !== currentJobId) {
      setPendingUpscaleRequest(null);
      setRunMessage("Il job corrente è cambiato: riapri la conferma Upscale");
      return;
    }
    const candidate = candidates.find((item) => item.id === request.candidateId);
    const variantBusy = candidate?.variants?.some(
      (variant) => variant.status !== "ready" && variant.status !== "failed",
    );
    if (!candidate || candidate.status !== "ready" || variantBusy) {
      setPendingUpscaleRequest(null);
      setRunMessage("Il candidato non è più disponibile per Upscale");
      return;
    }
    setPendingUpscaleRequest(null);
    void runCandidateVariant(
      request.candidateId,
      "upscale",
      { targetMegapixels: request.targetMegapixels },
    );
  }

  async function runCandidateVariant(
    candidateId: number,
    kind: VariantKind,
    options: {
      sourceVariantId?: string;
      targetMegapixels?: UpscaleTargetMegapixels;
    } = {},
  ) {
    if (!currentJobId) {
      setRunMessage("Apri prima un job completato");
      return;
    }
    const requiresUpdatedContract =
      kind === "upscale" ||
      kind === "face_upscale" ||
      Boolean(options.sourceVariantId);
    if (requiresUpdatedContract && !requireUpdatedPostprocessContract()) return;
    const requestedLabel = variantLabel(kind, options.targetMegapixels);
    setRunMessage(`Avvio ${requestedLabel} sul candidato ${candidateId}…`);
    try {
      const response = await fetch(
        `${bridgeUrl}/api/jobs/${currentJobId}/candidates/${candidateId}/variants`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind,
            ...(options.sourceVariantId
              ? { sourceVariantId: options.sourceVariantId }
              : {}),
            ...(options.targetMegapixels
              ? { targetMegapixels: options.targetMegapixels }
              : {}),
          }),
        },
      );
      const payload = (await response.json()) as {
        variant?: CandidateVariant;
        error?: string;
      };
      if (!response.ok || !payload.variant) {
        throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      }
      setCandidates((current) => current.map((candidate) =>
        candidate.id === candidateId
          ? {
              ...candidate,
              variants: [payload.variant!, ...(candidate.variants ?? [])],
              activeVariantId: payload.variant!.id,
            }
          : candidate,
      ));
      setActiveJobId(currentJobId);
      setIsRunning(true);
      setRunMessage(
        `${variantLabel(payload.variant.kind, payload.variant.targetMegapixels)} in coda · la versione selezionata resta disponibile`,
      );
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "Post-process non avviato");
    }
  }

  function applyCandidateDeletion(
    jobId: string,
    candidateId: number,
    result: CandidateDeletionResult,
  ) {
    const removeFromJobs = (jobs: RemoteJob[]) => jobs.flatMap((job) => {
      if (job.id !== jobId) return [job];
      const remaining = job.candidates.filter(
        (candidate) => candidate.index !== candidateId,
      );
      return result.jobDeleted ? [] : [{
        ...job,
        candidates: remaining,
        selectedCandidateIndex:
          job.selectedCandidateIndex === candidateId
            ? null
            : job.selectedCandidateIndex,
      }];
    });
    setProjectJobs(removeFromJobs);
    setMediaRecentJobs(removeFromJobs);
    if (currentJobId === jobId) {
      setCandidates((current) => current.filter(
        (candidate) => candidate.id !== candidateId,
      ));
      if (selected === candidateId) setSelected(null);
      if (result.jobDeleted) {
        setCurrentJobId(null);
        setActiveJobId(null);
        setIsRunning(false);
      }
    }
    setRunMessage(
      `Video eliminato · ${result.removedClips} clip rimosse dai montaggi` +
        (result.warnings.length ? ` · ${result.warnings.join(" · ")}` : ""),
    );
    void loadStudioProjects(studioProjectId);
  }

  async function deleteCurrentCandidate(candidateId: number) {
    if (!currentJobId) return;
    if (!window.confirm(
      "Eliminare definitivamente questo video? Verrà rimosso anche da tutti i montaggi e saranno cancellate le sue varianti Face/Upscale.",
    )) return;
    setRunMessage(`Eliminazione candidato ${candidateId}…`);
    try {
      const result = await requestCandidateDeletion(currentJobId, candidateId);
      applyCandidateDeletion(currentJobId, candidateId, result);
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "Eliminazione fallita");
    }
  }

  return (
    <main className="studio-shell">
      <aside className="rail" aria-label="Navigazione principale">
        <a className="brand" href="#" aria-label="H3 Studio home">
          H3
        </a>
        <nav className="rail-nav">
          <button className={`rail-item ${activeView === "chat" ? "active" : ""}`} onClick={() => setActiveView("chat")} type="button">
            <span className="rail-icon">✦</span>
            Chat
          </button>
          <button className={`rail-item ${activeView === "studio" ? "active" : ""}`} onClick={() => setActiveView("studio")} type="button">
            <span className="rail-icon">◆</span>
            Studio
          </button>
          <button
            className={`rail-item ${activeView === "projects" ? "active" : ""}`}
            onClick={() => setActiveView("projects")}
            type="button"
          >
            <span className="rail-icon">▦</span>
            Progetti
          </button>
          <button
            className={`rail-item ${activeView === "montages" ? "active" : ""}`}
            onClick={() => setActiveView("montages")}
            type="button"
          >
            <span className="rail-icon">≋</span>
            Montaggi
          </button>
          <button
            className={`rail-item ${activeView === "characters" ? "active" : ""}`}
            onClick={() => {
              setLibraryInitialKind("all");
              setActiveView("characters");
            }}
            type="button"
          >
            <span className="rail-icon">◉</span>
            Assets
          </button>
          <button
            className={`rail-item ${activeView === "library" ? "active" : ""}`}
            onClick={() => {
              setActiveView("library");
            }}
            type="button"
          >
            <span className="rail-icon">▣</span>
            Libreria
          </button>
        </nav>
        <button className={`rail-item admin-entry ${activeView === "admin" ? "active" : ""}`} onClick={() => setActiveView("admin")} type="button">
          <span className="rail-icon">⌘</span>
          Admin
        </button>
        <a
          className="rail-item source-entry"
          href="https://github.com/emanuelealbertosi/h3-studio"
          rel="noreferrer"
          target="_blank"
          title="Codice sorgente e licenza AGPL-3.0-only"
        >
          <span className="rail-icon">&lt;/&gt;</span>
          Sorgente
        </a>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">
              {activeView === "projects"
                ? "Archivio locale"
                : activeView === "montages"
                  ? "Editor non distruttivo"
                : activeView === "library"
                  ? "Media riutilizzabili"
                : activeView === "characters"
                  ? "Immagini riutilizzabili"
                  : activeView === "chat"
                    ? `Conversazione / ${studioProject?.name ?? "Caricamento…"}`
                    : `Progetto / ${studioProject?.name ?? "Caricamento…"}`}
            </div>
            <h1>
              {activeView === "admin"
                ? "Amministrazione"
                : activeView === "projects"
                  ? "Progetti"
                  : activeView === "montages"
                    ? "Montaggi"
                  : activeView === "library"
                    ? "Libreria"
                  : activeView === "characters"
                    ? "Assets"
                  : activeView === "chat"
                    ? "Chat"
                    : studioMediaMode === "image" ? "Immagine 01" : studioMediaMode === "audio" ? "Audio 01" : "Shot 01"}
            </h1>
          </div>
          <div className="topbar-actions">
            {(activeView === "studio" || activeView === "chat") && (
              <div className="topbar-project-switcher">
                {activeView === "studio" && <div className="studio-media-toggle" aria-label="Tipo di generazione">
                  <button className={studioMediaMode === "video" ? "active" : ""} onClick={() => setStudioMediaMode("video")} type="button">▶ Video</button>
                  <button className={studioMediaMode === "image" ? "active" : ""} onClick={() => setStudioMediaMode("image")} type="button">▧ Immagini</button>
                  <button className={studioMediaMode === "audio" ? "active" : ""} onClick={() => setStudioMediaMode("audio")} type="button">♫ Audio</button>
                </div>}
                <label>
                  <span>Progetto</span>
                  <select value={studioProjectId} onChange={(event) => {
                    setStudioProjectId(event.target.value);
                    setSourceJobId(null);
                    setImageStudioHandoff(null);
                    setAudioStudioJobId(null);
                  }}>
                    {studioProjects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </label>
                {activeView === "studio" && <button onClick={() => {
                  if (studioMediaMode === "video") beginNewGeneration(studioProjectId);
                  else if (studioMediaMode === "image") {
                    setImageStudioHandoff(null);
                    setImageResetToken((current) => current + 1);
                  } else {
                    setAudioStudioJobId(null);
                    setAudioResetToken((current) => current + 1);
                  }
                }} type="button">{studioMediaMode === "video" ? "Nuovo shot" : studioMediaMode === "image" ? "Nuova immagine" : "Nuovo audio"}</button>}
                <button onClick={() => void createStudioProject()} title="Crea un nuovo progetto" type="button">＋</button>
              </div>
            )}
            <div
              className={`connection-pill ${connection.state}`}
              title={connection.detail ?? undefined}
            >
              <span className="connection-dot" />
              {connection.label}
            </div>
            <div className="credit-pill">
              <span>Crediti</span>
              <strong>500</strong>
            </div>
            <button className="avatar" type="button" aria-label="Profilo utente">
              EM
            </button>
          </div>
        </header>

        <div className={`content ${activeView === "chat" ? "chat-content" : ""}`}>
          <div hidden={activeView !== "studio" || studioMediaMode !== "image"}>
            <ImageStudioPanel
              bridgeUrl={bridgeUrl}
              incomingReferences={imageStudioHandoff?.references}
              initialJobId={imageStudioHandoff?.jobId}
              key={`${imageResetToken}-${imageStudioHandoff?.token ?? 0}`}
              projectId={studioProjectId}
              onUseAsVideoReference={sendImageReferenceToVideo}
              projectName={studioProject?.name}
              projects={studioProjects}
            />
          </div>
          <div hidden={activeView !== "studio" || studioMediaMode !== "audio"}>
            <AudioStudioPanel
              bridgeUrl={bridgeUrl}
              initialJobId={audioStudioJobId}
              key={`${studioProjectId}-${audioResetToken}`}
              projectId={studioProjectId}
              projectName={studioProject?.name}
            />
          </div>
          {activeView === "admin" ? (
            <AdminPanel />
          ) : activeView === "projects" ? (
            <HistoryPanel
              onOpen={(job) => openJob(job)}
              onUseClip={(clip, operation) => prepareClipOperation(clip, operation)}
              onNewGeneration={(projectId) => beginNewGeneration(projectId)}
            />
          ) : activeView === "montages" ? (
            <MontagesPanel
              initialProjectId={montageTarget?.projectId}
              initialTimelineId={montageTarget?.timelineId}
              onUseClip={(clip, operation) => prepareClipOperation(clip, operation)}
            />
          ) : activeView === "characters" ? (
            <AssetLibraryPanel
              initialKind={libraryInitialKind}
              onSendToStudio={sendAssetImagesToStudio}
            />
          ) : activeView === "library" ? (
            <MediaLibraryPanel
              onUseExternal={addExternalMedia}
              onUseImage={(image) => sendAssetImagesToStudio([image])}
              onUseReferences={useCreativeReferences}
              onUseVideo={addRecentVideo}
              onVideoDeleted={applyCandidateDeletion}
              onOpenMontage={(projectId, timelineId) => {
                setMontageTarget({ projectId, timelineId });
                setActiveView("montages");
              }}
            />
          ) : activeView === "chat" ? (
            <ChatPanel
              bridgeUrl={bridgeUrl}
              onOpenStudio={(kind, jobId) => void openChatMediaInStudio(kind, jobId)}
              onSelectProject={(projectId) => {
                setStudioProjectId(projectId);
                setSourceJobId(null);
                setImageStudioHandoff(null);
                setAudioStudioJobId(null);
              }}
              projectId={studioProjectId}
              projectName={studioProject?.name}
              projects={studioProjects}
            />
          ) : (
          <>

          {studioMediaMode === "video" && (
          <>
          <section
            className={`composer ${composerExpanded ? "expanded" : "collapsed"}`}
            aria-labelledby="composer-title"
          >
            <div className="composer-heading">
              <div>
                <span className="section-index">02</span>
                <h2 id="composer-title">Crea i candidati</h2>
              </div>
              <div className="composer-heading-actions">
                <span className="autosave">Salvataggio automatico</span>
                <button
                  aria-controls="composer-settings"
                  aria-expanded={composerExpanded}
                  className="composer-toggle"
                  onClick={() => setComposerExpanded((current) => !current)}
                  type="button"
                >
                  {composerExpanded ? "Riduci" : "Impostazioni"}
                  <span aria-hidden="true">{composerExpanded ? "⌄" : "⌃"}</span>
                </button>
              </div>
            </div>

            <div className="composer-body" id="composer-settings">
            {sourceJobId && (
              <span className="continuation-link composer-continuation">
                Continuazione di <code>{sourceJobId.slice(0, 8)}</code>
                <button aria-label="Rimuovi relazione con la sorgente" onClick={() => setSourceJobId(null)} type="button">×</button>
              </span>
            )}
            <label className="prompt-field">
              <span>Descrivi la scena</span>
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={handlePromptChange}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMentionState(null);
                }}
                rows={2}
              />
              {mentionState && (
                <div className="mention-menu" role="listbox" aria-label="Media disponibili">
                  <div className="mention-menu-head">
                    <strong>Inserisci un riferimento</strong>
                    <span>Caricati · Esterni · Immagini · Libreria · Video recenti</span>
                  </div>
                  {mediaPickerBusy && !promptMentionOptions.length ? (
                    <span className="mention-empty">Caricamento media…</span>
                  ) : promptMentionOptions.length ? (
                    promptMentionOptions.map((item, index) => (
                      <button
                        key={`${item.kind}-${item.label}-${index}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          if (item.kind === "loaded") insertPromptMention(item.label);
                          else if (item.kind === "external") addExternalMedia(item.asset);
                          else if (item.kind === "image") addGeneratedImage(item);
                          else if (item.kind === "library") void addLibraryAsset(item.asset);
                          else addRecentVideo(item.job, item.candidate);
                        }}
                        aria-selected="false"
                        role="option"
                        type="button"
                      >
                        <div className="mention-thumbnail" aria-hidden="true">
                          {item.previewKind === "picture" && item.previewPath ? (
                            <img alt="" src={`${bridgeUrl}${item.previewPath}`} />
                          ) : item.previewKind === "video" && item.previewPath ? (
                            <video muted playsInline preload="metadata" src={`${bridgeUrl}${item.previewPath}#t=0.1`} />
                          ) : item.previewKind === "audio" ? (
                            <span>♪</span>
                          ) : (
                            <span>{item.kind === "library" ? "◇" : "●"}</span>
                          )}
                        </div>
                        <div className="mention-copy"><strong>@{item.label}</strong><small>{item.detail}</small></div>
                        <i>{item.kind === "loaded" ? "Caricato" : item.kind === "external" ? "Esterno" : item.kind === "image" ? "Immagine" : item.kind === "library" ? "Libreria" : "Video"}</i>
                      </button>
                    ))
                  ) : (
                    <span className="mention-empty">Nessun media corrispondente</span>
                  )}
                </div>
              )}
              <span className="prompt-hint">Scrivi @ per richiamare media e personaggi. H3 Studio convertirà automaticamente i nomi in Picture/Video corretti.</span>
            </label>

            <div className="creative-toolbar" aria-label="Preset creativi">
              {creativePresets.map((group) => (
                <fieldset key={group.label}>
                  <legend>{group.label}</legend>
                  <div>
                    {group.items.map((item) => (
                      <button
                        key={item.label}
                        onClick={() => appendCreativePreset(item.text)}
                        title={item.text}
                        type="button"
                      >
                        <span>{item.icon}</span>
                        {item.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>

            <div className="control-grid">
              <label className="select-control">
                <span>Modalità</span>
                <select
                  value={mode}
                  onChange={(event) => {
                    const nextMode = event.target.value as StudioMode;
                    setMode(nextMode);
                    if (nextMode === "edit") {
                      setQualityMode("fast");
                      setTurboEnabled(false);
                    }
                    if (nextMode === "t2v" && aspectFormat === KEEP_SOURCE_ASPECT_FORMAT) {
                      setAspectFormat("16:9 landscape");
                    }
                    if (nextMode !== "continue" && nextMode !== "edit") setSourceJobId(null);
                  }}
                >
                  {modes.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="select-control">
                <span>Formato</span>
                <select
                  value={aspectFormat}
                  onChange={(event) => setAspectFormat(event.target.value)}
                >
                  {sourceAspectLabel(mode) && (
                    <option value={KEEP_SOURCE_ASPECT_FORMAT}>{sourceAspectLabel(mode)}</option>
                  )}
                  {aspectFormats.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="segmented-control">
                <legend>Generazioni</legend>
                <div>
                  {[1, 2, 3, 4].map((value) => (
                    <button
                      className={candidateCount === value ? "selected" : ""}
                      key={value}
                      onClick={() => setCandidateCount(value)}
                      type="button"
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="select-control">
                <span>Shot (clip concatenate)</span>
                <select
                  onChange={(event) => setShotCount(Number(event.target.value))}
                  value={shotCount}
                >
                  {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
                    <option key={value} value={value}>
                      {value} shot
                    </option>
                  ))}
                </select>
                <small>{shotCount > 1 ? `Durata totale indicativa: ${shotCount * duration}s` : "Il workflow standard genera un solo shot."}</small>
              </label>

              <fieldset className="segmented-control">
                <legend>Durata per shot</legend>
                <div>
                  {[5, 10, 15].map((value) => (
                    <button
                      className={duration === value ? "selected" : ""}
                      key={value}
                      onClick={() => {
                        const nextDuration = value as 5 | 10 | 15;
                        setDuration(nextDuration);
                        if (nextDuration === 15 && megapixels > 0.7) {
                          setMegapixels(0.7);
                          setRunMessage("A 15 secondi la qualità massima è 0.7 MP.");
                        }
                      }}
                      type="button"
                    >
                      {value}s
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="segmented-control quality-control">
                <legend>Qualità</legend>
                <div>
                  {[
                    { value: 0.5, label: "MIN", detail: "0.5 MP" },
                    { value: 0.7, label: "MID", detail: "0.7 MP" },
                    { value: 0.98, label: "MAX", detail: "0.98 MP" },
                  ].map((item) => (
                    <button
                      className={megapixels === item.value ? "selected" : ""}
                      disabled={duration === 15 && item.value > 0.7}
                      key={item.value}
                      onClick={() => setMegapixels(item.value as Megapixels)}
                      title={duration === 15 && item.value > 0.7 ? "Non disponibile a 15 secondi" : undefined}
                      type="button"
                    >
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </button>
                  ))}
                </div>
                {duration === 15 && (
                  <small className="duration-resolution-note">15 s supporta al massimo 0.7 MP.</small>
                )}
              </fieldset>
            </div>

            <div className="engine-quality-row">
              <fieldset className="segmented-control quality-control">
                <legend>Preset generazione</legend>
                <div>
                  {[
                    { value: "fast", label: "FAST", detail: "PDD · 8" },
                    { value: "8", label: "8", detail: "standard" },
                    { value: "12", label: "12", detail: "standard" },
                    { value: "20", label: "20", detail: "standard" },
                    { value: "30", label: "30", detail: "standard" },
                  ].map((item) => (
                    <button
                      className={generationPreset === item.value ? "selected" : ""}
                      disabled={mode === "edit" && item.value === "fast"}
                      key={item.value}
                      onClick={() => selectGenerationPreset(item.value as GenerationPreset)}
                      title={
                        mode === "edit" && item.value === "fast"
                          ? "Edit usa il modello H3 standard/Hybrid; PDD FAST non è disponibile"
                          : undefined
                      }
                      type="button"
                    >
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="seed-row">
              <fieldset className="segmented-control seed-mode-control">
                <legend>Seed candidati</legend>
                <div>
                  {[
                    { value: "random", label: "Random" },
                    { value: "base", label: "Base +1" },
                    { value: "fixed", label: "Bloccato" },
                  ].map((item) => (
                    <button
                      className={seedMode === item.value ? "selected" : ""}
                      key={item.value}
                      onClick={() => setSeedMode(item.value as SeedMode)}
                      type="button"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="seed-input">
                <span>Valore seed</span>
                <input
                  disabled={seedMode === "random"}
                  inputMode="numeric"
                  max="9007199254740000"
                  min="0"
                  onChange={(event) => setSeedValue(event.target.value)}
                  type="number"
                  value={seedValue}
                />
              </label>
              <p>
                {seedMode === "random"
                  ? "Un seed casuale diverso per ogni candidato."
                  : seedMode === "base"
                    ? "Il primo usa il valore indicato; gli altri avanzano di +1."
                    : "Tutti i candidati usano lo stesso seed."}
              </p>
            </div>

            <fieldset className="audio-policy">
              <legend>Audio generato</legend>
              <label>
                <input checked={muteDiegetic} onChange={event => setMuteDiegetic(event.target.checked)} type="checkbox" />
                <span><strong>Muta diegetico</strong><small>dialoghi, ambiente e suoni presenti nella scena</small></span>
              </label>
              <label>
                <input checked={muteNonDiegetic} onChange={event => setMuteNonDiegetic(event.target.checked)} type="checkbox" />
                <span><strong>Muta non diegetico</strong><small>musica, score e voice-over esterni alla scena</small></span>
              </label>
              <p>
                {muteDiegetic && muteNonDiegetic
                  ? "Il workflow chiederà un output completamente silenzioso."
                  : "Questi interruttori guidano H3 nel prompt. Il mixer dei Montaggi controlla invece le tracce reali."}
              </p>
            </fieldset>

            {mode !== "t2v" && (
              <div className="asset-panel">
                <div className="asset-panel-heading">
                  <div>
                    <strong>Asset della modalità</strong>
                    <span>
                      {mode === "i2v"
                        ? "Picture 1 diventa il frame iniziale."
                        : mode === "keyframes"
                          ? "Le immagini seguono l’ordine della timeline keyframe."
                          : mode === "continue"
                            ? "Video 1 viene continuato; l’output contiene solo il nuovo segmento."
                            : mode === "edit"
                              ? "Video 1 è la sorgente dell’edit non distruttivo; i video lunghi vengono divisi automaticamente in blocchi."
                              : "Immagini, video e audio vengono usati come riferimenti."}
                    </span>
                  </div>
                  <div className="asset-source-actions">
                    <button
                      onClick={() => {
                        const opening = !mediaPickerOpen;
                        setMediaPickerOpen(opening);
                        if (opening) void loadMediaPicker();
                      }}
                      type="button"
                    >
                      ▧ Scegli dalla libreria
                    </button>
                    <label className="asset-upload">
                      {uploadingAssets ? "Caricamento…" : "+ Carica nuovo"}
                      <input
                        accept="image/*,video/*,audio/*"
                        disabled={uploadingAssets}
                        multiple
                        onChange={(event) => {
                          void uploadAssetFiles(event.currentTarget.files);
                          event.currentTarget.value = "";
                        }}
                        type="file"
                      />
                    </label>
                  </div>
                </div>

                <div className="asset-list">
                  {mediaAssets.length === 0 ? (
                    <span className="asset-empty">Nessun asset collegato</span>
                  ) : (
                    mediaAssets.map((asset, index) => (
                      <article className="media-asset-card" key={asset.uid}>
                        <div className="media-asset-preview">
                          {asset.kind === "picture" ? (
                            <img alt={asset.caption || asset.name} src={`${bridgeUrl}${mediaPreviewPath(asset)}`} />
                          ) : asset.kind === "video" ? (
                            <video muted playsInline preload="metadata" src={`${bridgeUrl}${mediaPreviewPath(asset)}`} />
                          ) : (
                            <span>♪</span>
                          )}
                          <i>{mediaToken(mediaAssets, index)}</i>
                        </div>
                        <div className="media-asset-body">
                          <div><strong>@{asset.mention}</strong><small>{asset.name}</small></div>
                          <label>
                            <span>Didascalia / come usarlo</span>
                            <input
                              onChange={(event) => setMediaAssets((current) => current.map((item) =>
                                item.uid === asset.uid ? { ...item, caption: event.target.value } : item
                              ))}
                              placeholder="Es. Elara, personaggio principale; mantieni identità e abito"
                              value={asset.caption ?? ""}
                            />
                          </label>
                          {asset.kind === "audio" && mediaAssets
                            .slice(0, index + 1)
                            .filter((item) => item.kind === "audio").length === 1 && (
                            <label className="audio-routing-role">
                              <span>Uso di Audio 1</span>
                              <select
                                onChange={(event) => {
                                  const audioRole = event.target.value as AudioRoutingRole;
                                  setMediaAssets((current) => current.map((item) =>
                                    item.uid === asset.uid
                                      ? { ...item, audio_role: audioRole }
                                      : item
                                  ));
                                  if (audioRole === "music_video_lipsync") {
                                    if (
                                      mode !== "i2v" &&
                                      mode !== "reference" &&
                                      mediaAssets.some((item) => item.kind === "picture")
                                    ) {
                                      setMode("i2v");
                                    }
                                    setTurboEnabled(false);
                                    if (asset.duration && asset.duration > 0) {
                                      setShotCount(Math.min(
                                        12,
                                        Math.max(1, Math.ceil(asset.duration / duration)),
                                      ));
                                    }
                                    setRunMessage(
                                      "Audio lipsync: in I2V Picture 1 resta il frame iniziale; la traccia viene sincronizzata e conservata identica. Turbo disattivato.",
                                    );
                                  }
                                }}
                                value={asset.audio_role ?? "reference_audio"}
                              >
                                <option value="reference_audio">Reference audio H3</option>
                                <option value="voice_ref">Riferimento voce / timbro</option>
                                <option value="exact_soundtrack">Soundtrack esatto</option>
                                <option value="exact_soundtrack_plus_h3_sfx">Soundtrack esatto + SFX H3</option>
                                <option value="music_video_lipsync">Audio esatto + lip-sync (I2V/R2V)</option>
                                <option value="ignore">Ignora Audio 1</option>
                              </select>
                              {asset.audio_role === "music_video_lipsync" && (
                                <small>
                                  La traccia parlata o musicale viene divisa per shot e preservata identica. In I2V Picture 1 è il frame iniziale esatto; in Reference resta un riferimento visivo.
                                </small>
                              )}
                              {asset.audio_role === "voice_ref" && (
                                <small>
                                  Usa soltanto voce e timbro dell’audio. Scrivi nel prompt le parole da pronunciare: H3 genera il nuovo dialogo e il relativo lip-sync. Funziona con I2V, Keyframes e Reference.
                                </small>
                              )}
                            </label>
                          )}
                          {shotCount > 1 && (
                            <div className="shot-schedule">
                              <span>Presenza negli shot</span>
                              <div>
                                <button
                                  className={!asset.shotUsage || asset.shotUsage === "auto" ? "selected" : ""}
                                  onClick={() => setMediaAssets((current) => current.map((item) =>
                                    item.uid === asset.uid ? { ...item, shotUsage: "auto" } : item
                                  ))}
                                  type="button"
                                >Auto</button>
                                <button
                                  className={asset.shotUsage === "all" ? "selected" : ""}
                                  onClick={() => setMediaAssets((current) => current.map((item) =>
                                    item.uid === asset.uid ? { ...item, shotUsage: "all" } : item
                                  ))}
                                  type="button"
                                >Tutti</button>
                                {Array.from({ length: shotCount }, (_, shotIndex) => shotIndex + 1).map((shot) => (
                                  <button
                                    className={Array.isArray(asset.shotUsage) && asset.shotUsage.includes(shot) ? "selected" : ""}
                                    key={shot}
                                    onClick={() => setMediaAssets((current) => current.map((item) => {
                                      if (item.uid !== asset.uid) return item;
                                      const selected = Array.isArray(item.shotUsage) ? item.shotUsage : [];
                                      const next = selected.includes(shot)
                                        ? selected.filter((value) => value !== shot)
                                        : [...selected, shot].sort((a, b) => a - b);
                                      return { ...item, shotUsage: next.length ? next : "auto" };
                                    }))}
                                    type="button"
                                  >{shot}</button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="media-asset-actions">
                          <button
                            onClick={() => insertMediaInPrompt(index)}
                            title={`Inserisci ${mediaToken(mediaAssets, index)} nel prompt`}
                            type="button"
                          >
                            Inserisci
                          </button>
                          <button
                            aria-label={"Rimuovi " + asset.name}
                            className="remove"
                            onClick={() =>
                              setMediaAssets((current) =>
                                current.filter((_, itemIndex) => itemIndex !== index),
                              )
                            }
                            type="button"
                          >
                            ×
                          </button>
                        </div>
                      </article>
                    ))
                  )}
                </div>

                {mediaPickerOpen && typeof document !== "undefined" && createPortal((
                  <div
                    className="media-picker-backdrop"
                    onMouseDown={(event) => {
                      if (event.target === event.currentTarget) setMediaPickerOpen(false);
                    }}
                    role="presentation"
                  >
                  <div aria-modal="true" className="media-library-picker media-library-modal" role="dialog">
                    <div className="media-picker-heading">
                      <div><strong>Libreria media</strong><span>Aggiungi senza ricaricare file già disponibili</span></div>
                      <button onClick={() => setMediaPickerOpen(false)} type="button">×</button>
                    </div>
                    {mediaPickerBusy && !mediaLibraryAssets.length && !mediaExternalAssets.length && !mediaGeneratedImages.length && !mediaRecentJobs.length ? (
                      <span className="media-picker-empty">Caricamento…</span>
                    ) : (
                      <>
                        <div className="media-picker-section">
                          <strong>Esterni</strong>
                          <div className="media-picker-grid external-media">
                            {mediaExternalAssets.map((asset) => (
                              <button key={asset.id} onClick={() => addExternalMedia(asset)} type="button">
                                <div>
                                  {asset.kind === "picture" ? (
                                    <img alt="" src={`${bridgeUrl}${asset.mediaPath}`} />
                                  ) : asset.kind === "video" ? (
                                    <video muted playsInline preload="metadata" src={`${bridgeUrl}${asset.mediaPath}`} />
                                  ) : (
                                    <span>♪</span>
                                  )}
                                </div>
                                <strong>{asset.originalName}</strong>
                                <small>Esterno · {asset.originProjectName ?? "Condiviso"}</small>
                              </button>
                            ))}
                            {!mediaExternalAssets.length && <span className="media-picker-empty">Nessun media esterno caricato</span>}
                          </div>
                        </div>
                        <div className="media-picker-section">
                          <strong>Immagini del progetto</strong>
                          <div className="media-picker-grid generated-images">
                            {mediaProjectGeneratedImages.map((item) => (
                              <button
                                key={`${item.job.id}-${item.candidate.index}`}
                                onClick={() => addGeneratedImage(item)}
                                title={item.job.prompt}
                                type="button"
                              >
                                <div><img alt="" src={`${bridgeUrl}${item.candidate.output.mediaPath}`} /></div>
                                <strong>{item.job.originProjectName ?? "Immagine generata"}</strong>
                                <small>{item.job.id.slice(0, 8)} · candidato {item.candidate.index}</small>
                              </button>
                            ))}
                            {!mediaProjectGeneratedImages.length && <span className="media-picker-empty">Nessuna immagine generata in questo progetto</span>}
                          </div>
                        </div>
                        <div className="media-picker-section">
                          <strong>Altre immagini generate</strong>
                          <div className="media-picker-grid generated-images reusable-images">
                            {mediaOtherGeneratedImages.map((item) => (
                              <button
                                key={`${item.job.id}-${item.candidate.index}`}
                                onClick={() => addGeneratedImage(item)}
                                title={item.job.prompt}
                                type="button"
                              >
                                <div><img alt="" src={`${bridgeUrl}${item.candidate.output.mediaPath}`} /></div>
                                <strong>{item.job.originProjectName ?? "Altro progetto"}</strong>
                                <small>{item.job.id.slice(0, 8)} · candidato {item.candidate.index}</small>
                              </button>
                            ))}
                            {!mediaOtherGeneratedImages.length && <span className="media-picker-empty">Nessun’altra immagine riutilizzabile</span>}
                          </div>
                        </div>
                        <div className="media-picker-section">
                          <strong>Personaggi e oggetti</strong>
                          <div className="media-picker-grid">
                            {mediaLibraryAssets.map((asset) => (
                              <button key={asset.id} onClick={() => void addLibraryAsset(asset)} type="button">
                                <div>{asset.hero ? <img alt="" src={`${bridgeUrl}${asset.hero.mediaPath}`} /> : <span>◇</span>}</div>
                                <strong>{asset.name}</strong>
                                <small>{asset.referenceCount} reference</small>
                              </button>
                            ))}
                            {!mediaLibraryAssets.length && <span className="media-picker-empty">Nessun asset nella libreria</span>}
                          </div>
                        </div>
                        <div className="media-picker-section">
                          <strong>Video recenti</strong>
                          <div className="media-picker-grid recent-videos">
                            {mediaRecentJobs.flatMap((job) => job.candidates.filter((candidate) => candidate.output).map((candidate) => (
                              <button key={`${job.id}-${candidate.index}`} onClick={() => addRecentVideo(job, candidate)} type="button">
                                <div><video muted playsInline preload="metadata" src={`${bridgeUrl}${candidate.output!.mediaPath}`} /></div>
                                <strong>{job.projectName ?? "Senza progetto"}</strong>
                                <small>{job.id.slice(0, 8)} · candidato {candidate.index}</small>
                              </button>
                            )))}
                            {!mediaRecentJobs.some((job) => job.candidates.some((candidate) => candidate.output)) && <span className="media-picker-empty">Nessun video completato</span>}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  </div>
                ), document.body)}

                {mode === "keyframes" && (
                  <label className="asset-text-input">
                    <span>Posizioni keyframe</span>
                    <input
                      onChange={(event) => setKeyframePositions(event.target.value)}
                      placeholder="AUTO oppure 0%, 50%, 100%"
                      value={keyframePositions}
                    />
                  </label>
                )}

              </div>
            )}
            </div>

            <div className="composer-footer">
              <div className="preset-note">
                <span className="fast-badge">{generationPreset === "fast" ? "FAST" : `${effectiveSteps} STEP`}</span>
                {generationPreset === "fast" ? "Alibaba PDD-Acc · 8 step" : `H3 standard · ${effectiveSteps} step`} · {shotCount > 1 ? `${shotCount} shot × ${duration}s ≈ ${shotCount * duration}s` : `${duration}s`} · {formatMegapixels(megapixels)} MP
              </div>
              <div className="generation-cta">
                <div>
                  <span>Costo · tempo stimato</span>
                  <strong>{estimatedCredits} crediti · {estimatedTimeLabel}</strong>
                </div>
                <button disabled={isRunning || !studioProjectId} onClick={startGeneration} type="button">
                  {isRunning ? "Generazione in corso" : `Genera ${candidateCount} candidati`}
                </button>
              </div>
            </div>
            {runMessage && <div className="run-message">{runMessage}</div>}
          </section>

          {projectJobs.length > 0 && (
            <section className="project-batches" aria-label="Batch del progetto corrente">
              <div>
                <span className="section-index">BATCH DEL PROGETTO</span>
                <strong>{studioProject?.name}</strong>
                <small>I batch precedenti restano qui anche dopo Continua o Edita.</small>
              </div>
              <div className="project-batch-strip">
                {projectJobs.map(job => {
                  const preview = job.candidates.find(candidate => candidate.index === job.selectedCandidateIndex)?.output
                    ?? job.candidates.find(candidate => candidate.output)?.output;
                  return (
                    <button className={job.id === currentJobId ? "active" : ""} key={job.id} onClick={() => openJob(job)} type="button">
                      {preview ? <video muted playsInline preload="metadata" src={`${bridgeUrl}${preview.mediaPath}`} /> : <span>In coda</span>}
                      <i>{job.sourceJobId ? "↳ " : ""}{job.id.slice(0, 8)}</i>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section className="results" aria-labelledby="results-title">
            <div className="results-heading">
              <div>
                <span className="section-index">01</span>
                <h2 id="results-title">Candidati</h2>
                <span className="result-count">{visibleCandidates.length}</span>
              </div>
              <div className="results-tools">
                {playableCandidates > 1 && (
                  <div className="sync-controls" aria-label="Confronto sincronizzato">
                    <button onClick={() => controlCandidateVideos("play")} type="button">▶ Tutti</button>
                    <button onClick={() => controlCandidateVideos("pause")} type="button">Pausa</button>
                    <button onClick={() => controlCandidateVideos("restart")} type="button">↺ Da capo</button>
                  </div>
                )}
                {currentJobId && !isRunning && candidates.some((candidate) => candidate.status === "ready" || candidate.status === "failed") && (
                  <button className="regenerate-button" onClick={() => setRegenerateTarget({ prompt })} type="button">↻ Rigenera batch</button>
                )}
                <div className="queue-status">
                  <span className={isRunning ? "pulse" : ""} />
                  {isRunning ? "Coda attiva" : "Coda pronta"}
                </div>
                {isRunning && activeJobId && (
                  <button
                    className="stop-run-button"
                    disabled={isCancelling}
                    onClick={() => void cancelActiveRun()}
                    type="button"
                  >
                    {isCancelling ? "Interruzione…" : "■ Interrompi"}
                  </button>
                )}
              </div>
            </div>

            <div className={`candidate-grid count-${Math.max(1, visibleCandidates.length)}`} ref={candidateGridRef}>
              {visibleCandidates.map((candidate) => {
                const isReady = candidate.status === "ready";
                const isFailed = candidate.status === "failed";
                const isSelected = selected === candidate.id;
                const variants = candidate.variants ?? [];
                const readyVariants = variants.filter(
                  (variant) => variant.status === "ready",
                );
                const activeVariant = readyVariants.find(
                  (variant) =>
                    variant.id === candidate.activeVariantId,
                );
                const displayMediaPath = activeVariant?.output?.mediaPath ?? candidate.mediaPath;
                const activeMegapixels = candidateVersionMegapixels(
                  currentJobMegapixels,
                  activeVariant,
                  variants,
                );
                const availableUpscaleTargets = upscaleTargets.filter(
                  (target) => target > activeMegapixels,
                );
                const canUseActiveAsFaceSource =
                  !activeVariant || activeVariant.kind === "upscale";
                const faceSourceLabel = activeVariant
                  ? variantLabel(activeVariant.kind, activeVariant.targetMegapixels)
                  : "Originale";
                const variantBusy = variants.some(
                  (variant) => variant.status !== "ready" && variant.status !== "failed",
                );
                const activePostprocess = variants.find(
                  (variant) => variant.status !== "ready" && variant.status !== "failed",
                );
                const candidateProcessingTime = formatProcessingTimeLabel(
                  candidate.processingSeconds,
                );
                const terminalProcessingTime =
                  isReady || isFailed
                    ? formatProcessingTimeLabel(
                        activeVariant
                          ? activeVariant.processingSeconds
                          : candidate.processingSeconds,
                      )
                    : null;
                return (
                  <article
                    className={`candidate-card ${isReady ? "ready" : isFailed ? "failed" : "processing"} ${isSelected ? "chosen" : ""}`}
                    key={candidate.id}
                  >
                    <div className={`video-surface visual-${candidate.id}`}>
                      <div className="video-noise" />
                      {!isReady && <div className="video-blur" />}
                      {activePostprocess && (
                        <div className="variant-run-banner" role="status">
                          <span className="pulse" />
                          <strong>{variantLabel(activePostprocess.kind, activePostprocess.targetMegapixels)}</strong>
                          <small>
                            {activePostprocess.phaseLabel ?? "Post-process in corso"}
                            {typeof activePostprocess.progress === "number"
                              ? ` · ${activePostprocess.progress}%`
                              : ""}
                          </small>
                        </div>
                      )}

                      {isReady ? (
                        <>
                          {displayMediaPath ? (
                            <video
                              controls
                              data-candidate-index={candidate.id}
                              playsInline
                              preload="metadata"
                              src={`${bridgeUrl}${displayMediaPath}`}
                            />
                          ) : (
                            <div className="progress-overlay"><span>Output pronto in ComfyUI</span></div>
                          )}
                          <div className="video-time">00:{duration.toString().padStart(2, "0")}</div>
                          {isSelected && <div className="selected-label">Scelto</div>}
                        </>
                      ) : (
                        <div className="progress-overlay" role="status">
                          <span className="candidate-label">Candidato {candidate.id}</span>
                          <strong className={isFailed ? "failure-mark" : undefined}>
                            {isFailed ? "!" : candidate.progressExact ? `${candidate.progress}%` : "—"}
                          </strong>
                          <span>{formatStatus(candidate)}</span>
                          {!isFailed && (
                            <div className={`progress-track ${!candidate.progressExact && candidate.status !== "queued" && candidate.status !== "idle" ? "indeterminate" : ""}`}>
                              <i style={candidate.progressExact ? { width: `${candidate.progress}%` } : undefined} />
                            </div>
                          )}
                        </div>
                      )}
                      {(isReady || isFailed) && (
                        <button
                          aria-label={`Elimina candidato ${candidate.id}`}
                          className="video-trash-button"
                          disabled={variantBusy}
                          onClick={() => void deleteCurrentCandidate(candidate.id)}
                          title={isFailed ? "Elimina esecuzione fallita" : "Elimina video e rimuovilo dai montaggi"}
                          type="button"
                        >
                          🗑
                        </button>
                      )}
                    </div>

                    <footer className="candidate-footer">
                      <div>
                        <strong>Candidato {candidate.id}</strong>
                        <span>
                          {activeVariant
                            ? `${variantLabel(activeVariant.kind, activeVariant.targetMegapixels)} · Seed ${candidate.seed}`
                            : candidate.seed
                              ? `Originale · Seed ${candidate.seed}`
                              : "Seed al lancio"}
                          {terminalProcessingTime ? ` · ${terminalProcessingTime}` : ""}
                        </span>
                      </div>
                      {isReady ? (
                        <div className="candidate-actions candidate-variant-actions">
                          <div className="variant-switch" aria-label="Versione video e sorgente post-process">
                            <button
                              className={!activeVariant ? "active" : ""}
                              onClick={() => setCandidates((current) => current.map((item) =>
                                item.id === candidate.id ? { ...item, activeVariantId: null } : item,
                              ))}
                              type="button"
                            >
                              Originale
                              {candidateProcessingTime ? ` · ${candidateProcessingTime}` : ""}
                            </button>
                            {readyVariants.map((variant) => {
                              const variantProcessingTime = formatProcessingTimeLabel(
                                variant.processingSeconds,
                              );
                              return (
                                <button
                                  className={candidate.activeVariantId === variant.id ? "active" : ""}
                                  key={variant.id}
                                  onClick={() => setCandidates((current) => current.map((item) =>
                                    item.id === candidate.id ? { ...item, activeVariantId: variant.id } : item,
                                  ))}
                                  type="button"
                                >
                                  {variantLabel(variant.kind, variant.targetMegapixels)}
                                  {variantProcessingTime ? ` · ${variantProcessingTime}` : ""}
                                </button>
                              );
                            })}
                          </div>
                          {variants.filter((variant) => variant.status !== "ready").map((variant) => {
                            const failedProcessingTime =
                              variant.status === "failed"
                                ? formatProcessingTimeLabel(variant.processingSeconds)
                                : null;
                            return (
                              <span className={`variant-status ${variant.status}`} key={variant.id}>
                                {variantLabel(variant.kind, variant.targetMegapixels)} · {variant.phaseLabel ?? variant.error ?? variant.status}
                                {failedProcessingTime ? ` · ${failedProcessingTime}` : ""}
                              </span>
                            );
                          })}
                          <div className="postprocess-source">
                            <span>Sorgente Face</span>
                            <strong>
                              {canUseActiveAsFaceSource
                                ? `${faceSourceLabel} · ${activeMegapixels} MP`
                                : "Seleziona Originale o Upscale"}
                            </strong>
                          </div>
                          <div className="postprocess-actions">
                            <button
                              disabled={variantBusy || !canUseActiveAsFaceSource}
                              onClick={() => void runCandidateVariant(
                                candidate.id,
                                "face",
                                activeVariant ? { sourceVariantId: activeVariant.id } : {},
                              )}
                              title={
                                canUseActiveAsFaceSource
                                  ? `Applica Face Refiner a ${faceSourceLabel}`
                                  : "Face può partire solo da Originale o da una variante Upscale"
                              }
                              type="button"
                            >
                              Face
                            </button>
                            {availableUpscaleTargets.map((target) => (
                              <button
                                disabled={variantBusy}
                                key={target}
                                onClick={(event) => requestCandidateUpscale(
                                  candidate.id,
                                  target,
                                  event.currentTarget,
                                )}
                                title={
                                  target === 2
                                    ? "Crea direttamente dall’originale una variante a 2 MP · più lento e molto più pesante in VRAM"
                                    : "Crea direttamente dall’originale una variante a 1 MP"
                                }
                                type="button"
                              >
                                Upscale {target} MP
                              </button>
                            ))}
                            {availableUpscaleTargets.length === 0 && (
                              <span className="upscale-limit">Upscale: target massimo raggiunto</span>
                            )}
                          </div>
                          <div className="candidate-primary-actions">
                            <button
                              className={isSelected ? "primary-action selected" : "primary-action"}
                              onClick={() => void selectCandidate(candidate.id)}
                              type="button"
                            >
                              {isSelected ? "Selezionato" : "Scegli"}
                            </button>
                            <button
                              disabled={!displayMediaPath}
                              onClick={() =>
                                displayMediaPath &&
                                prepareVideoOperation(
                                  displayMediaPath,
                                  "candidate_" + candidate.id + ".mp4",
                                  "continue",
                                  { projectId: studioProjectId, sourceJobId: currentJobId },
                                )
                              }
                              type="button"
                            >
                              Continua
                            </button>
                            <button
                              disabled={!displayMediaPath}
                              onClick={() =>
                                displayMediaPath &&
                                prepareVideoOperation(
                                  displayMediaPath,
                                  "candidate_" + candidate.id + ".mp4",
                                  "edit",
                                  { projectId: studioProjectId, sourceJobId: currentJobId },
                                )
                              }
                              type="button"
                            >
                              Edita
                            </button>
                            <button className="regenerate-action" disabled={isRunning} onClick={() => setRegenerateTarget({ candidateId: candidate.id, prompt })} type="button">
                              ↻ Rigenera
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="waiting-label">{formatStatus(candidate)}</span>
                      )}
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
          </>
          )}
          </>
          )}
        </div>
      </section>
      {regenerateTarget && <RegenerateDialog
        busy={isRunning}
        initialPrompt={regenerateTarget.prompt}
        key={`${currentJobId ?? "video"}:${regenerateTarget.candidateId ?? "batch"}`}
        mediaLabel={regenerateTarget.candidateId === undefined ? "batch video" : `video ${regenerateTarget.candidateId}`}
        onCancel={() => { if (!isRunning) setRegenerateTarget(null); }}
        onConfirm={regenerateVideo}
        scopeLabel={regenerateTarget.candidateId === undefined ? `${candidateCount} candidati` : `Candidato ${regenerateTarget.candidateId}`}
      />}
      {pendingUpscaleRequest && (
        <div
          className="upscale-confirm-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPendingUpscaleRequest(null);
            }
          }}
        >
          <section
            aria-describedby="upscale-confirm-warning"
            aria-labelledby="upscale-confirm-title"
            aria-modal="true"
            className="upscale-confirm-dialog"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusableControls = [
                upscaleCancelRef.current,
                upscaleConfirmRef.current,
              ].filter(
                (control): control is HTMLButtonElement =>
                  Boolean(control && !control.disabled),
              );
              const first = focusableControls[0];
              const last = focusableControls[focusableControls.length - 1];
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            role="dialog"
          >
            <header>
              <span aria-hidden="true">↗</span>
              <div>
                <small>Conferma richiesta</small>
                <h2 id="upscale-confirm-title">
                  Upscale a {pendingUpscaleRequest.targetMegapixels} MP
                </h2>
              </div>
            </header>
            <div className="upscale-confirm-route" aria-label="Riepilogo Upscale">
              <div>
                <span>Target</span>
                <strong>{pendingUpscaleRequest.targetMegapixels} MP</strong>
              </div>
              <div>
                <span>Sorgente</span>
                <strong>
                  Candidato {pendingUpscaleRequest.candidateId} · Originale{" "}
                  {pendingUpscaleRequest.sourceMegapixels} MP
                </strong>
              </div>
            </div>
            <div className="upscale-confirm-warning">
              <strong>Tempo e VRAM</strong>
              <p id="upscale-confirm-warning">
                {pendingUpscaleRequest.targetMegapixels === 2
                  ? "Il render a 2 MP richiede sensibilmente più tempo ed è molto più pesante in VRAM. Una GPU già al limite può esaurire la memoria."
                  : "L’upscale può richiedere diversi minuti e usa VRAM aggiuntiva. Evita altre elaborazioni GPU durante il render."}
              </p>
            </div>
            {postprocessContract < 2 && (
              <div
                className="upscale-confirm-bridge-alert"
                id="upscale-confirm-bridge-alert"
                role="alert"
              >
                <strong>Upscale non disponibile</strong>
                <p>
                  Bridge non aggiornato: riavvia H3 Studio, quindi riapri questa
                  conferma.
                </p>
              </div>
            )}
            <footer className="upscale-confirm-actions">
              <button
                onClick={() => setPendingUpscaleRequest(null)}
                ref={upscaleCancelRef}
                type="button"
              >
                Annulla
              </button>
              <button
                className="confirm"
                disabled={postprocessContract < 2}
                onClick={confirmCandidateUpscale}
                ref={upscaleConfirmRef}
                type="button"
              >
                Conferma Upscale {pendingUpscaleRequest.targetMegapixels} MP
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

export default function Home() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState("");

  function loadSetupStatus() {
    setError("");
    fetch(`${bridgeUrl}/api/setup/status`, { cache: "no-store", credentials: "include" })
      .then(async (response) => {
        const payload = (await response.json()) as SetupStatus & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
        setStatus(payload);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Bridge non disponibile"));
  }

  useEffect(() => {
    void loadSetupStatus();
  }, []);

  if (error) {
    return (
      <main className="setup-shell">
        <section className="setup-card setup-complete">
          <p className="section-index">BRIDGE NON RAGGIUNGIBILE</p>
          <h1>H3 Studio non è ancora pronto</h1>
          <p>{error}</p>
          <button onClick={loadSetupStatus} type="button">Riprova</button>
        </section>
      </main>
    );
  }
  if (!status) return <main className="setup-shell"><span className="setup-spinner">H3</span></main>;
  if (status.setupRequired) return <SetupWizard status={status} />;
  return <StudioApp />;
}

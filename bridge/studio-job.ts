import { randomUUID } from "node:crypto";
import type { ComfyApiNode, ComfyApiPrompt, ComfyClient } from "./comfy-client.js";
import type { WorkflowStore } from "./workflow-store.js";
import type {
  ResolvedEngineSettings,
  RuntimeSettings,
  RuntimeSettingsStore,
} from "./runtime-settings.js";
import type { ComfyProgressTracker } from "./comfy-progress.js";
import type { JobRepository } from "./job-repository.js";
import { buildLtx25Prompt } from "./ltx25-workflow.js";
import type { SamRuntimeControl } from "./sam-runtime-control.js";
import type { LlmProviderService } from "./llm-provider.js";
import { injectRemoteVideoPlan, planH3Video } from "./video-prompt-planner.js";
import {
  normalizeJobLoraOverrides,
  resolveJobLoras,
  type JobLoraOverride,
} from "../lib/job-loras.js";

const MAX_SEED = 9_007_199_254_740_000;
const BASE_SECONDS_5S_05MP = 172;

function isH3SamplerClass(value: string | null | undefined) {
  return value === "H3ReferenceMemorySampler" ||
    value === "H3MusicVideoReferenceMemorySampler";
}
const PLANNER_COLD_SECONDS = 28;
const ASPECT_FORMATS = [
  "keep source aspect",
  "16:9 landscape",
  "9:16 portrait",
  "1:1 square",
  "4:3 landscape",
  "3:4 portrait",
  "3:2 landscape",
  "2:3 portrait",
  "21:9 ultrawide",
  "9:21 vertical ultrawide",
  "5:4 landscape",
  "4:5 portrait",
] as const;
const GENERATION_MODES = [
  "T2V",
  "I2V",
  "R2V",
  "KEYFRAMES",
  "VIDEO EXTENSION",
  "VIDEO EDITING",
] as const;
const AUDIO_ROUTING_ROLES = [
  "reference_audio",
  "voice_ref",
  "ignore",
  "exact_soundtrack",
  "exact_soundtrack_plus_h3_sfx",
  "music_video_lipsync",
] as const;
const EFFECTIVE_SHOT_SECONDS: Record<5 | 10 | 15 | 20, number> = {
  5: 123 / 24,
  10: 242 / 24,
  15: 362 / 24,
  20: 482 / 24,
};
const EDIT_SOURCE_STRIDE_SECONDS: Record<5 | 10 | 15 | 20, number> = {
  5: 122 / 24,
  10: 242 / 24,
  15: 360 / 24,
  20: 480 / 24,
};
const MAX_SOURCE_VIDEO_SECONDS = 180;

type AspectFormat = (typeof ASPECT_FORMATS)[number];
export type GenerationMode = (typeof GENERATION_MODES)[number];
export type SeedMode = "random" | "base" | "fixed";
export type QualityMode = "fast" | "min" | "med" | "max";
export type AudioRoutingRole = (typeof AUDIO_ROUTING_ROLES)[number];
export type VideoEngine = "h3" | "ltx25";

export type StudioJobRequest = {
  videoEngine: VideoEngine;
  prompt: string;
  candidateCount: 1 | 2 | 3 | 4;
  shotCount: number;
  durationSeconds: 5 | 10 | 15 | 20;
  megapixels: 0.5 | 0.7 | 0.98 | 1.5 | 2;
  generationMode: GenerationMode;
  aspectFormat: AspectFormat;
  seedMode: SeedMode;
  qualityMode: QualityMode;
  turboEnabled: boolean;
  seed?: number;
  mediaState: string;
  referenceRoles: string;
  keyframePositions: string;
  sourceVideoAudio: "AUTO" | "IGNORE" | "REFERENCE" | "REUSE";
  projectId: string | null;
  sourceJobId: string | null;
  muteDiegetic: boolean;
  muteNonDiegetic: boolean;
  inpaintTarget: string;
  inpaintMaskGrow: number;
  inpaintStartSeconds: number;
  inpaintEndSeconds: number;
  loraOverrides?: JobLoraOverride[];
};

export type PreparedCandidate = {
  index: number;
  seed: number;
  filenamePrefix: string;
  prompt: ComfyApiPrompt;
};

export type StudioJob = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  sourceJobId: string | null;
  status:
    | "prepared"
    | "submitted"
    | "partial"
    | "running"
    | "completed"
    | "failed";
  createdAt: string;
  selectedCandidateIndex: number | null;
  engine: ResolvedEngineSettings;
  request: StudioJobRequest & { promptLength: number };
  candidates: Array<{
    index: number;
    seed: number;
    displayName: string | null;
    filenamePrefix: string;
    promptId: string | null;
    queueNumber: number | null;
    status:
      | "prepared"
      | "submitted"
      | "queued"
      | "rendering"
      | "ready"
      | "failed";
    processingSeconds: number | null;
    output: MediaOutput | null;
    error: string | null;
  }>;
};

export type MediaOutput = {
  filename: string;
  subfolder: string;
  type: "input" | "output" | "temp";
  format: string;
  mediaPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonePrompt(prompt: ComfyApiPrompt): ComfyApiPrompt {
  return structuredClone(prompt);
}

function uniqueNode(prompt: ComfyApiPrompt, classType: string): ComfyApiNode {
  const matches = Object.values(prompt).filter(
    (node) => node.class_type === classType,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Firma workflow non valida: atteso un nodo ${classType}, trovati ${matches.length}`,
    );
  }
  return matches[0];
}

function uniqueNodeEntry(
  prompt: ComfyApiPrompt,
  classType: string,
): [string, ComfyApiNode] {
  const matches = Object.entries(prompt).filter(
    ([, node]) => node.class_type === classType,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Firma workflow non valida: atteso un nodo ${classType}, trovati ${matches.length}`,
    );
  }
  return matches[0];
}

function audioRoutingFromMediaState(mediaState: string) {
  const items = JSON.parse(mediaState || "[]") as Array<Record<string, unknown>>;
  const audio = items.find((item) => item.kind === "audio");
  const requested = typeof audio?.audio_role === "string"
    ? audio.audio_role
    : "reference_audio";
  const role = AUDIO_ROUTING_ROLES.includes(requested as AudioRoutingRole)
    ? requested as AudioRoutingRole
    : "reference_audio";
  const duration = typeof audio?.duration === "number" && Number.isFinite(audio.duration)
    ? audio.duration
    : null;
  return { role, duration };
}

function requireInput(node: ComfyApiNode, input: string) {
  if (!(input in node.inputs)) {
    throw new Error(
      `Firma workflow non valida: ${node.class_type}.${input} non trovato`,
    );
  }
}

function normalizeMediaState(value: unknown) {
  const raw = typeof value === "string" ? value : "[]";
  let items: unknown;
  try {
    items = JSON.parse(raw || "[]");
  } catch {
    throw new Error("mediaState non contiene JSON valido");
  }
  if (!Array.isArray(items) || items.length > 18) {
    throw new Error("mediaState deve contenere al massimo 18 asset");
  }
  let pictures = 0;
  let videos = 0;
  let audios = 0;
  for (const item of items) {
    if (!isRecord(item)) throw new Error("Asset media non valido");
    if (item.kind === "picture") pictures += 1;
    else if (item.kind === "video") videos += 1;
    else if (item.kind === "audio") audios += 1;
    else throw new Error("Tipo asset non supportato");
    const file = typeof item.file === "string" ? item.file.trim() : "";
    const clean = file.replace(/ \[(input|output|temp)\]$/i, "");
    if (
      !file ||
      /^[a-z]:/i.test(clean) ||
      clean.startsWith("/") ||
      clean.startsWith("\\") ||
      clean.split(/[\\/]+/).includes("..")
    ) {
      throw new Error("Percorso asset non valido");
    }
  }
  if (pictures > 9 || videos > 3 || audios > 3) {
    throw new Error("Troppi asset per gli slot MiniMax H3");
  }
  return { json: JSON.stringify(items), pictures, videos, audios };
}

function normalizeRequest(value: unknown): StudioJobRequest {
  if (!isRecord(value)) throw new Error("Body JSON mancante");
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (prompt.length < 3 || prompt.length > 20_000) {
    throw new Error("Il prompt deve contenere da 3 a 20.000 caratteri");
  }

  const candidateCount = Number(value.candidateCount);
  if (![1, 2, 3, 4].includes(candidateCount)) {
    throw new Error("candidateCount deve essere 1, 2, 3 o 4");
  }

  let shotCount = value.shotCount === undefined ? 1 : Number(value.shotCount);
  if (!Number.isInteger(shotCount) || shotCount < 1 || shotCount > 12) {
    throw new Error("shotCount deve essere un intero da 1 a 12");
  }

  const durationSeconds = Number(value.durationSeconds);
  if (durationSeconds !== 5 && durationSeconds !== 10 && durationSeconds !== 15 && durationSeconds !== 20) {
    throw new Error("durationSeconds deve essere 5, 10, 15 oppure 20");
  }

  const requestedMegapixels = Number(value.megapixels);
  if (![0.5, 0.7, 0.98, 1, 1.5, 2].includes(requestedMegapixels)) {
    throw new Error("megapixels deve essere 0.5, 0.7, 0.98, 1.5 oppure 2");
  }
  const megapixels = requestedMegapixels === 1 ? 0.98 : requestedMegapixels;
  let videoEngine: VideoEngine;
  if (value.videoEngine === undefined) videoEngine = "h3";
  else if (value.videoEngine === "h3" || value.videoEngine === "ltx25") {
    videoEngine = value.videoEngine;
  } else {
    throw new Error("videoEngine deve essere h3 oppure ltx25");
  }
  const generationMode =
    typeof value.generationMode === "string"
      ? value.generationMode.toUpperCase()
      : "T2V";
  if (!GENERATION_MODES.includes(generationMode as GenerationMode)) {
    throw new Error("Modalità di generazione non supportata");
  }

  const aspectFormat =
    typeof value.aspectFormat === "string"
      ? value.aspectFormat
      : "16:9 landscape";
  if (!ASPECT_FORMATS.includes(aspectFormat as AspectFormat)) {
    throw new Error("aspectFormat non è supportato dal nodo H3");
  }
  if (aspectFormat === "keep source aspect" && generationMode === "T2V") {
    throw new Error("Mantieni proporzioni sorgente richiede una modalità con Picture o Video");
  }

  const requestedSeed = value.seed === undefined ? undefined : Number(value.seed);
  const seedMode: SeedMode =
    value.seedMode === "base" || value.seedMode === "fixed"
      ? value.seedMode
      : "random";
  const qualityMode: QualityMode =
    value.qualityMode === "min" ||
    value.qualityMode === "med" ||
    value.qualityMode === "max"
      ? value.qualityMode
      : "fast";
  if (videoEngine === "h3" && durationSeconds === 20) {
    throw new Error("MiniMax H3 supporta shot da 5, 10 o 15 secondi; 20 secondi è disponibile con LTX 2.5");
  }
  if (videoEngine === "h3" && megapixels > 0.98) {
    throw new Error("MiniMax H3 video supporta al massimo 0.98 MP");
  }
  if (videoEngine === "h3" && durationSeconds === 15 && megapixels > 0.7) {
    throw new Error("A 15 secondi MiniMax H3 supporta al massimo 0.7 MP");
  }
  if (videoEngine === "ltx25" && qualityMode === "max" && megapixels > 0.98) {
    throw new Error("LTX Quality usa una base massima di 0.98 MP e produce circa 4 MP dopo upscale latent x2");
  }
  if (
    requestedSeed !== undefined &&
    (!Number.isSafeInteger(requestedSeed) || requestedSeed < 0)
  ) {
    throw new Error("seed deve essere un intero sicuro maggiore o uguale a zero");
  }
  if (seedMode !== "random" && requestedSeed === undefined) {
    throw new Error("Inserisci un seed per la modalità base o bloccata");
  }

  const media = normalizeMediaState(value.mediaState);
  const mediaItems = JSON.parse(media.json) as Array<Record<string, unknown>>;
  const audioRouting = audioRoutingFromMediaState(media.json);
  if (
    aspectFormat === "keep source aspect" &&
    media.pictures + media.videos < 1
  ) {
    throw new Error("Mantieni proporzioni sorgente richiede almeno una Picture o un Video");
  }
  if (generationMode === "I2V" && media.pictures < 1) {
    throw new Error("I2V richiede almeno una Picture");
  }
  if (generationMode === "KEYFRAMES" && media.pictures < 1) {
    throw new Error("Keyframes richiede almeno una Picture");
  }
  if (
    (generationMode === "VIDEO EXTENSION" ||
      generationMode === "VIDEO EDITING") &&
    media.videos < 1
  ) {
    throw new Error("Continue/Edit richiede almeno un Video");
  }
  if (
    (generationMode === "VIDEO EXTENSION" ||
      generationMode === "VIDEO EDITING") &&
    mediaItems.some(
      (item) =>
        item.kind === "video" &&
        typeof item.duration === "number" &&
        item.duration > MAX_SOURCE_VIDEO_SECONDS + 0.5,
    )
  ) {
    throw new Error(
      `Continue/Edit nello Studio accetta video fino a ${MAX_SOURCE_VIDEO_SECONDS} secondi`,
    );
  }
  if (generationMode === "VIDEO EDITING") {
    const sourceDuration = mediaItems.find(
      (item) => item.kind === "video" && typeof item.duration === "number",
    )?.duration;
    if (typeof sourceDuration === "number" && sourceDuration > 0) {
      const requiredShots = Math.max(
        1,
        Math.ceil(sourceDuration / EDIT_SOURCE_STRIDE_SECONDS[durationSeconds]),
      );
      if (requiredShots > 12) {
        const supportedSeconds = Math.floor(
          12 * EDIT_SOURCE_STRIDE_SECONDS[durationSeconds],
        );
        throw new Error(
          `Con blocchi da ${durationSeconds}s, Edit supporta circa ${supportedSeconds}s di sorgente. Scegli blocchi da 15s oppure accorcia il video.`,
        );
      }
      shotCount = requiredShots;
    }
  }
  if (
    generationMode === "R2V" &&
    media.pictures + media.videos + media.audios < 1
  ) {
    throw new Error("Reference richiede almeno un asset");
  }
  if (audioRouting.role === "music_video_lipsync") {
    if (generationMode !== "I2V" && generationMode !== "R2V") {
      throw new Error(
        "Audio esatto + lip-sync richiede I2V oppure Reference",
      );
    }
    if (audioRouting.duration && audioRouting.duration > 0) {
      shotCount = Math.ceil(
        audioRouting.duration / EFFECTIVE_SHOT_SECONDS[durationSeconds],
      );
      if (shotCount > 12) {
        throw new Error(
          "La traccia richiede più di 12 shot: scegli shot da 15s o accorcia l’audio",
        );
      }
    }
  }

  const referenceRoles =
    typeof value.referenceRoles === "string"
      ? value.referenceRoles.trim().slice(0, 4_000) || "AUTO"
      : "AUTO";
  const keyframePositions =
    typeof value.keyframePositions === "string"
      ? value.keyframePositions.trim().slice(0, 500) || "AUTO"
      : "AUTO";
  const sourceVideoAudio =
    value.sourceVideoAudio === "IGNORE" ||
    value.sourceVideoAudio === "REFERENCE" ||
    value.sourceVideoAudio === "REUSE"
      ? value.sourceVideoAudio
      : "AUTO";
  const inpaintTarget = typeof value.inpaintTarget === "string"
    ? value.inpaintTarget.replace(/\s+/g, " ").trim().slice(0, 240)
    : "";
  const inpaintMaskGrow = Math.min(
    96,
    Math.max(0, Math.round(Number(value.inpaintMaskGrow ?? 8) / 4) * 4),
  );
  const inpaintStartSeconds = Math.min(
    MAX_SOURCE_VIDEO_SECONDS,
    Math.max(0, Number(value.inpaintStartSeconds ?? 0) || 0),
  );
  const inpaintEndSeconds = Math.min(
    MAX_SOURCE_VIDEO_SECONDS,
    Math.max(0, Number(value.inpaintEndSeconds ?? 0) || 0),
  );
  if (inpaintTarget && generationMode !== "VIDEO EDITING") {
    throw new Error("Il masking è disponibile soltanto in Video editing H3");
  }
  if (
    inpaintEndSeconds > 0 &&
    inpaintEndSeconds <= inpaintStartSeconds
  ) {
    throw new Error("La fine dell'intervallo masking deve essere successiva all'inizio");
  }
  const loraOverrides = normalizeJobLoraOverrides(value.loraOverrides);
  if (videoEngine === "ltx25" && loraOverrides?.some((item) => item.enabled)) {
    throw new Error("I LoRA per esecuzione sono disponibili con MiniMax H3; LTX 2.5 richiede adattatori compatibili dedicati");
  }

  if (
    videoEngine === "ltx25" &&
    generationMode !== "T2V" &&
    generationMode !== "I2V"
  ) {
    throw new Error("LTX 2.5 supporta per ora Text to video e Image to video");
  }
  if (videoEngine === "ltx25") {
    if (shotCount !== 1) throw new Error("LTX 2.5 genera un solo segmento per job");
    if (generationMode === "I2V" && (media.pictures !== 1 || media.videos > 0 || media.audios > 0)) {
      throw new Error("I2V LTX 2.5 richiede esattamente una Picture e nessun Video/Audio");
    }
    if (generationMode === "T2V" && media.pictures + media.videos + media.audios > 0) {
      throw new Error("T2V LTX 2.5 non usa media allegati");
    }
  }
  const normalizeOptionalId = (input: unknown) => {
    if (input === undefined || input === null || input === "") return null;
    if (typeof input !== "string" || input.trim().length > 80) {
      throw new Error("Identificatore progetto o sorgente non valido");
    }
    return input.trim();
  };

  return {
    videoEngine,
    prompt,
    candidateCount: candidateCount as 1 | 2 | 3 | 4,
    shotCount,
    durationSeconds: durationSeconds as 5 | 10 | 15 | 20,
    megapixels: megapixels as 0.5 | 0.7 | 0.98 | 1.5 | 2,
    generationMode: generationMode as GenerationMode,
    aspectFormat: aspectFormat as AspectFormat,
    seedMode,
    qualityMode,
    turboEnabled: false,
    seed: requestedSeed,
    mediaState: media.json,
    referenceRoles,
    keyframePositions,
    sourceVideoAudio,
    projectId: normalizeOptionalId(value.projectId),
    sourceJobId: normalizeOptionalId(value.sourceJobId),
    muteDiegetic: value.muteDiegetic === true,
    muteNonDiegetic: value.muteNonDiegetic === true,
    inpaintTarget,
    inpaintMaskGrow,
    inpaintStartSeconds,
    inpaintEndSeconds,
    loraOverrides,
  };
}

function audioPolicyPrompt(request: StudioJobRequest) {
  let prompt = request.prompt;
  if (request.generationMode === "I2V") {
    prompt += "\n\nI2V CONTINUITY LOCK: Use Picture 1 as the exact opening frame. Preserve the same subject identity, face, body, hair, outfit, colors, environment, composition and visual style. Animate only the action explicitly requested. Do not introduce an unrequested cut, camera-angle change, outfit change, scene change or new subject.";
  }
  if (request.generationMode === "VIDEO EXTENSION") {
    prompt += "\n\nSEAMLESS START: Begin from the exact final state of Video 1 and preserve visual and motion continuity through the first second. No cut, scene reset, teleport or pose reset. Then transition naturally into the requested action and camera direction.";
  }
  if (request.generationMode === "VIDEO EDITING" && request.inpaintTarget) {
    prompt += `\n\nMASKED VIDEO EDIT: modify only the tracked region described as "${request.inpaintTarget}". Preserve every pixel outside that subject region, including camera, framing, background, lighting and all other people. Apply the requested transformation consistently across time without replacing the whole shot. The user's current request is the complete and exclusive edit specification: do not infer, continue, restore or add any transformation, action, age change, wardrobe change, nudity, subject or story detail that is not explicitly requested in the current prompt.`;
  }
  if (!request.muteDiegetic && !request.muteNonDiegetic) return prompt;
  const directive = request.muteDiegetic && request.muteNonDiegetic
    ? "AUDIO POLICY: produce complete silence. No dialogue, voices, sound effects, ambience, music, score or narration."
    : request.muteDiegetic
      ? "AUDIO POLICY: mute all diegetic scene audio, including dialogue, voices, ambience and sound effects. Generate only explicitly requested non-diegetic music, score or narration."
      : "AUDIO POLICY: mute all non-diegetic audio, including music, score and narration. Generate only natural diegetic dialogue, ambience and sound effects occurring inside the scene.";
  return `${prompt}\n\n${directive}`;
}

function randomSeed() {
  return Math.floor(Math.random() * MAX_SEED);
}

function sourceContextFromRequest(request: StudioJobRequest) {
  if (request.generationMode !== "VIDEO EXTENSION") return null;
  const items = JSON.parse(request.mediaState || "[]") as Array<Record<string, unknown>>;
  const sourceVideo = items.find(
    (item) => item.kind === "video" && typeof item.file === "string",
  );
  const file = typeof sourceVideo?.file === "string" ? sourceVideo.file : "";
  const pathMatch = file.match(
    /(?:^|[\\/])H3_STUDIO[\\/]([^\\/]+)[\\/]candidate_(\d+)_/i,
  );
  const sourceJobId = pathMatch?.[1] ?? request.sourceJobId;
  const candidateIndex = pathMatch ? Number(pathMatch[2]) : 1;
  if (
    !sourceJobId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sourceJobId,
    ) ||
    !Number.isInteger(candidateIndex) ||
    candidateIndex < 1 ||
    candidateIndex > 4
  ) {
    return null;
  }
  return {
    prefix: `video/H3_STUDIO_CONTEXT/${sourceJobId}/latent`,
    candidateIndex,
  };
}

export function findVideoOutput(outputs: unknown): MediaOutput | null {
  if (!isRecord(outputs)) return null;
  for (const nodeOutput of Object.values(outputs)) {
    if (!isRecord(nodeOutput)) continue;
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!isRecord(item) || typeof item.filename !== "string") continue;
        const format = typeof item.format === "string" ? item.format : "";
        if (!format.startsWith("video/") && !/\.(mp4|webm|mov)$/i.test(item.filename)) {
          continue;
        }
        const type =
          item.type === "input" || item.type === "temp" ? item.type : "output";
        const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
        const query = new URLSearchParams({
          filename: item.filename,
          subfolder,
          type,
        });
        return {
          filename: item.filename,
          subfolder,
          type,
          format: format || "video/mp4",
          mediaPath: `/api/media?${query.toString()}`,
        };
      }
    }
  }
  return null;
}

function configureEngineLoras(node: ComfyApiNode, settings: ResolvedEngineSettings) {
  const slots = Object.entries(node.inputs)
    .filter(([name, value]) => /^lora_\d+$/.test(name) && isRecord(value))
    .sort(([left], [right]) => Number(left.slice(5)) - Number(right.slice(5)));
  if (slots.length < settings.loras.length) {
    throw new Error(
      `Il workflow offre ${slots.length} slot LoRA, ma l'Engine ne richiede ${settings.loras.length}`,
    );
  }
  slots.forEach(([, raw], index) => {
    const value = raw as Record<string, unknown>;
    const configured = settings.loras[index];
    if (!configured) {
      value.on = false;
      return;
    }
    value.lora = configured.name;
    value.on = configured.strength !== 0;
    value.strength = configured.strength;
  });
}

function resolveEngineSettings(
  request: StudioJobRequest,
  runtimeSettings: RuntimeSettings,
): ResolvedEngineSettings {
  const steps =
    request.qualityMode === "fast"
      ? 8
      : request.qualityMode === "min"
      ? 12
      : request.qualityMode === "med"
        ? 20
        : 30;
  const loras = resolveJobLoras(runtimeSettings.h3.loras, request.loraOverrides);
  const firstLora = loras[0];
  return {
    family: "h3",
    profile: "standard",
    model: runtimeSettings.h3.model,
    pddFile: null,
    loras,
    lora: firstLora?.name ?? "",
    loraStrength: firstLora?.strength ?? 0,
    steps,
  };
}

function historyExecutionError(entry: { status?: Record<string, unknown> } | undefined) {
  const messages = entry?.status?.messages;
  if (!Array.isArray(messages)) return null;
  for (const message of [...messages].reverse()) {
    if (!Array.isArray(message) || message[0] !== "execution_error" || !isRecord(message[1])) continue;
    const detail = message[1];
    const raw = typeof detail.exception_message === "string"
      ? detail.exception_message
      : typeof detail.exception_type === "string"
        ? detail.exception_type
        : "Esecuzione ComfyUI fallita";
    if (/all masks are empty|nothing to crop/i.test(raw)) {
      return "SAM3 non ha riconosciuto l’elemento descritto nel video. Prova un nome più semplice e specifico, per esempio: vestito, donna, capelli o automobile.";
    }
    return raw.slice(0, 1_000);
  }
  return null;
}

function attachH3Masking(
  prompt: ComfyApiPrompt,
  sampler: ComfyApiNode,
  routerId: string,
  request: StudioJobRequest,
) {
  if (request.generationMode !== "VIDEO EDITING" || !request.inpaintTarget) return;
  const highest = Math.max(
    0,
    ...Object.keys(prompt)
      .map((value) => Number(value))
      .filter(Number.isFinite),
  );
  const loaderId = String(highest + 1);
  const segmentId = String(highest + 2);
  const propagateId = String(highest + 3);
  const outputId = String(highest + 4);
  prompt[loaderId] = {
    class_type: "LoadSAM3Model",
    inputs: { precision: "auto", compile: false },
    _meta: { title: "H3 Studio — SAM3" },
  };
  prompt[segmentId] = {
    class_type: "SAM3VideoSegmentation",
    inputs: {
      prompt_mode: "text",
      video_frames: [routerId, 7],
      text_prompt: sam3TargetPrompt(request.inpaintTarget),
      frame_idx: 0,
      score_threshold: 0.2,
    },
    _meta: { title: "H3 Studio — trova il soggetto" },
  };
  prompt[propagateId] = {
    class_type: "SAM3Propagate",
    inputs: {
      sam3_model_config: [loaderId, 0],
      video_state: [segmentId, 0],
      start_frame: 0,
      end_frame: -1,
      direction: "forward",
    },
    _meta: { title: "H3 Studio — traccia la maschera" },
  };
  prompt[outputId] = {
    class_type: "SAM3VideoOutput",
    inputs: {
      masks: [propagateId, 0],
      video_state: [propagateId, 2],
      scores: [propagateId, 1],
      obj_id: -1,
      plot_all_masks: true,
    },
    _meta: { title: "H3 Studio — maschera tracciata" },
  };
  sampler.inputs.studio_inpaint_mask = [outputId, 0];
  sampler.inputs.studio_inpaint_grow = request.inpaintMaskGrow;
  sampler.inputs.studio_inpaint_start_seconds = request.inpaintStartSeconds;
  sampler.inputs.studio_inpaint_end_seconds = request.inpaintEndSeconds;
  sampler.inputs.studio_inpaint_crop_mode = "tracked";
  sampler.inputs.studio_inpaint_crop_scale = 1.5;
  sampler.inputs.studio_inpaint_feather = 24;
}

function sam3TargetPrompt(value: string) {
  const target = value.replace(/\s+/g, " ").trim();
  const normalized = target.toLocaleLowerCase("it-IT");
  const aliases: Array<[RegExp, string]> = [
    [/\b(?:vestito|abito)\b.*\b(?:donna|ragazza|signora)\b|\b(?:donna|ragazza|signora)\b.*\b(?:vestito|abito)\b/i, "the dress worn by the woman"],
    [/\b(?:vestito|abito)\b/i, "the dress"],
    [/\b(?:maglietta|camicia|camicetta|top)\b/i, "the shirt"],
    [/\b(?:pantaloni|jeans)\b/i, "the pants"],
    [/\b(?:giacca|cappotto)\b/i, "the jacket"],
    [/\b(?:capelli|chioma)\b/i, "the hair"],
    [/\b(?:viso|faccia|volto)\b/i, "the face"],
    [/\b(?:donna|ragazza|signora)\b/i, "the woman"],
    [/\b(?:uomo|ragazzo|signore)\b/i, "the man"],
    [/\b(?:auto|automobile|macchina)\b/i, "the car"],
    [/\b(?:cane)\b/i, "the dog"],
    [/\b(?:gatto)\b/i, "the cat"],
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1] ?? target;
}

function resolveLtx25EngineSettings(
  runtimeSettings: RuntimeSettings,
  qualityMode: QualityMode,
): ResolvedEngineSettings {
  return {
    family: "ltx25",
    profile: "standard",
    model: runtimeSettings.ltx25.model,
    encoder: runtimeSettings.ltx25.encoder,
    videoVae: runtimeSettings.ltx25.videoVae,
    audioVae: runtimeSettings.ltx25.audioVae,
    upscaler: runtimeSettings.ltx25.upscaler,
    cfg: runtimeSettings.ltx25.cfg,
    sampler: runtimeSettings.ltx25.sampler,
    pddFile: null,
    loras: [],
    lora: "",
    loraStrength: 0,
    steps: qualityMode === "max" ? 11 : 8,
  };
}

export function prepareStudioJob(
  sourcePrompt: ComfyApiPrompt,
  rawRequest: unknown,
  runtimeSettings: RuntimeSettings,
  jobId: string = randomUUID(),
  excludedSeeds: ReadonlySet<number> = new Set(),
) {
  const request = normalizeRequest(rawRequest);
  if (request.videoEngine === "ltx25") {
    const engineSettings = resolveLtx25EngineSettings(runtimeSettings, request.qualityMode);
    const baseSeed = request.seed ?? randomSeed();
    const randomSeeds = new Set<number>();
    const candidates: PreparedCandidate[] = [];
    for (let index = 1; index <= request.candidateCount; index += 1) {
      let candidateSeed: number;
      if (request.seedMode === "fixed") candidateSeed = baseSeed;
      else if (request.seedMode === "base") candidateSeed = (baseSeed + index - 1) % MAX_SEED;
      else {
        do candidateSeed = randomSeed();
        while (randomSeeds.has(candidateSeed) || excludedSeeds.has(candidateSeed));
        randomSeeds.add(candidateSeed);
      }
      const filenamePrefix = `video/H3_STUDIO_LTX25/${jobId}/candidate_${index}`;
      candidates.push({
        index,
        seed: candidateSeed,
        filenamePrefix,
        prompt: buildLtx25Prompt(
          request,
          runtimeSettings.ltx25,
          candidateSeed,
          filenamePrefix,
        ),
      });
    }
    return { jobId, request, candidates, engineSettings };
  }
  const resolvedEngine = resolveEngineSettings(request, runtimeSettings);
  const baseSeed = request.seed ?? randomSeed();
  const randomSeeds = new Set<number>();
  const candidates: PreparedCandidate[] = [];
  const sourceContext = sourceContextFromRequest(request);

  for (let index = 1; index <= request.candidateCount; index += 1) {
    const prompt = clonePrompt(sourcePrompt);
    const requestNode = uniqueNode(prompt, "H3AIOAutopromptRequest");
    const sampler = uniqueNode(prompt, "H3ReferenceMemorySampler");
    const [routerId] = uniqueNodeEntry(prompt, "H3AIOGenerationRouter");
    const audioRouting = audioRoutingFromMediaState(request.mediaState);
    const size = uniqueNode(prompt, "H3AspectMegapixelSize");
    const saver = uniqueNode(prompt, "H3SaveContinuation");
    const media = uniqueNode(prompt, "MiniMaxH3MediaLoader");
    const loras = uniqueNode(prompt, "Power Lora Loader (rgthree)");
    const model = uniqueNode(prompt, "H3ModelLoaderAny");
    const shift = uniqueNode(prompt, "MiniMaxH3SigmaShift");

    for (const input of [
      "generation_mode",
      "natural_prompt",
      "reference_roles",
      "shot_count",
      "max_auto_shots",
      "shot_seconds",
      "llm_media_context",
      "context_resolution",
      "audio_1_role",
      "keyframe_positions",
      "source_video_audio",
    ]) {
      requireInput(requestNode, input);
    }
    for (const input of ["seed", "steps"]) requireInput(sampler, input);
    for (const input of ["megapixels", "aspect_format", "size_mode"]) {
      requireInput(size, input);
    }
    requireInput(saver, "filename_prefix");
    requireInput(saver, "prepend_source_video");
    requireInput(media, "media_state");

    let candidateSeed: number;
    if (request.seedMode === "fixed") {
      candidateSeed = baseSeed;
    } else if (request.seedMode === "base") {
      candidateSeed = (baseSeed + index - 1) % MAX_SEED;
    } else {
      do {
        candidateSeed = randomSeed();
      } while (randomSeeds.has(candidateSeed) || excludedSeeds.has(candidateSeed));
      randomSeeds.add(candidateSeed);
    }
    const filenamePrefix = `video/H3_STUDIO/${jobId}/candidate_${index}`;

    requestNode.inputs.generation_mode = request.generationMode;
    requestNode.inputs.natural_prompt = audioPolicyPrompt(request);
    requestNode.inputs.reference_roles = request.referenceRoles;
    requestNode.inputs.shot_count =
      request.generationMode === "VIDEO EDITING" ? 0 : request.shotCount;
    requestNode.inputs.max_auto_shots =
      request.generationMode === "VIDEO EDITING" ? 12 : request.shotCount;
    requestNode.inputs.shot_seconds = request.durationSeconds;
    requestNode.inputs.llm_media_context = "OFF - text only";
    requestNode.inputs.context_resolution = 512;
    requestNode.inputs.audio_1_role = audioRouting.role;
    requestNode.inputs.keyframe_positions = request.keyframePositions;
    requestNode.inputs.source_video_audio = request.sourceVideoAudio;
    sampler.inputs.seed = candidateSeed;
    requireInput(model, "model_name");
    sampler.inputs.steps = resolvedEngine.steps;
    sampler.inputs.studio_context_prefix =
      `video/H3_STUDIO_CONTEXT/${jobId}/latent`;
    sampler.inputs.studio_context_clip_index = index;
    sampler.inputs.studio_source_context_prefix = sourceContext?.prefix ?? "";
    sampler.inputs.studio_source_context_clip_index =
      sourceContext?.candidateIndex ?? 0;
    const keepSourceAspect = request.aspectFormat === "keep source aspect";
    size.inputs.size_mode = keepSourceAspect
      ? "source aspect + megapixels"
      : "megapixels + format";
    size.inputs.megapixels = request.megapixels;
    size.inputs.aspect_format = keepSourceAspect
      ? "16:9 landscape"
      : request.aspectFormat;
    if (
      keepSourceAspect &&
      (request.generationMode === "VIDEO EXTENSION" ||
        request.generationMode === "VIDEO EDITING")
    ) {
      delete size.inputs.picture_1;
    }
    saver.inputs.filename_prefix = filenamePrefix;
    saver.inputs.prepend_source_video = false;
    media.inputs.media_state =
      request.generationMode === "T2V" ? "[]" : request.mediaState;
    model.inputs.model_name = resolvedEngine.model;
    configureEngineLoras(loras, resolvedEngine);
    attachH3Masking(prompt, sampler, routerId, request);
    if (audioRouting.role === "music_video_lipsync") {
      sampler.class_type = "H3MusicVideoReferenceMemorySampler";
      sampler.inputs.soundtrack = [routerId, 17];
      sampler.inputs.audio_output_mode = "original_soundtrack";
      sampler.inputs.trim_to_soundtrack = true;
      delete sampler.inputs.keyframe_plan;
      delete sampler.inputs.pdd_acc_file;
      delete sampler.inputs.studio_context_prefix;
      delete sampler.inputs.studio_context_clip_index;
      delete sampler.inputs.studio_source_context_prefix;
      delete sampler.inputs.studio_source_context_clip_index;
    }

    candidates.push({
      index,
      seed: candidateSeed,
      filenamePrefix,
      prompt,
    });
  }

  return { jobId, request, candidates, engineSettings: resolvedEngine };
}

export function estimateExecutionTime(
  request: StudioJobRequest,
  engineSettings: ResolvedEngineSettings,
) {
  if (request.videoEngine === "ltx25") {
    const centralSeconds = Math.round(
      95 * (request.durationSeconds / 5) * (request.megapixels / 0.5) * request.candidateCount,
    );
    return {
      centralSeconds,
      minimumSeconds: Math.max(45, Math.round(centralSeconds * 0.75)),
      maximumSeconds: Math.round(centralSeconds * 1.5),
      basis: "ltx25-initial-estimate" as const,
    };
  }
  const centralSeconds = Math.round(
    PLANNER_COLD_SECONDS +
      BASE_SECONDS_5S_05MP *
        (request.durationSeconds / 5) *
        request.shotCount *
        (request.megapixels / 0.5) *
        (engineSettings.steps / 8) *
        request.candidateCount,
  );
  return {
    centralSeconds,
    minimumSeconds: Math.max(60, Math.round(centralSeconds * 0.85)),
    maximumSeconds: Math.round(centralSeconds * 1.3),
    basis: "history-local-plus-cold-planner" as const,
  };
}

export function publicDryRun(
  prepared: ReturnType<typeof prepareStudioJob>,
) {
  const settings = prepared.engineSettings;
  const estimatedExecution = estimateExecutionTime(prepared.request, settings);
  const mediaAssetCount = (
    JSON.parse(prepared.request.mediaState || "[]") as unknown[]
  ).length;
  return {
    ok: true,
    dryRun: true,
    jobId: prepared.jobId,
    videoEngine: prepared.request.videoEngine,
    preset: prepared.request.qualityMode.toUpperCase(),
    generationMode: prepared.request.generationMode,
    durationSeconds: prepared.request.durationSeconds,
    shotCount: prepared.request.shotCount,
    megapixels: prepared.request.megapixels,
    steps: settings.steps,
    profile: settings.profile,
    fastPdd: settings.profile === "fast",
    pddFile: settings.pddFile,
    turbo: false,
    model: settings.model,
    lora: settings.lora,
    loraStrength: settings.loraStrength,
    loras: settings.loras,
    aspectFormat: prepared.request.aspectFormat,
    seedMode: prepared.request.seedMode,
    mediaAssetCount,
    keyframePositions: prepared.request.keyframePositions,
    projectId: prepared.request.projectId,
    sourceJobId: prepared.request.sourceJobId,
    audioRoutingRole: audioRoutingFromMediaState(prepared.request.mediaState).role,
    muteDiegetic: prepared.request.muteDiegetic,
    muteNonDiegetic: prepared.request.muteNonDiegetic,
    continuationOnly: prepared.request.videoEngine === "h3" &&
      prepared.candidates.every(
        (candidate) =>
          uniqueNode(candidate.prompt, "H3SaveContinuation").inputs
            .prepend_source_video === false,
      ),
    promptLength: prepared.request.prompt.length,
    estimatedExecution,
    candidates: prepared.candidates.map((candidate) => ({
      index: candidate.index,
      seed: candidate.seed,
      filenamePrefix: candidate.filenamePrefix,
      apiNodeCount: Object.keys(candidate.prompt).length,
    })),
  };
}

export class StudioJobService {
  private readonly samPromptIds = new Set<string>();
  private readonly releasedSamPrompts = new Set<string>();
  private samReleaseQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly comfy: ComfyClient,
    private readonly workflowStore: WorkflowStore,
    private readonly runtimeSettings: RuntimeSettingsStore,
    private readonly progressTracker: ComfyProgressTracker,
    private readonly jobs: JobRepository,
    private readonly samRuntime?: SamRuntimeControl,
    private readonly llm?: LlmProviderService,
  ) {
    this.progressTracker.onNode(({ promptId, classType }) => {
      if (
        this.samPromptIds.has(promptId) &&
        isH3SamplerClass(classType)
      ) {
        return this.releaseSamPrompt(promptId);
      }
    });
    this.progressTracker.onTerminal(({ promptId }) => {
      if (this.samPromptIds.has(promptId)) return this.releaseSamPrompt(promptId);
    });
  }

  private promptUsesSam(prompt: ComfyApiPrompt) {
    return Object.values(prompt).some((node) =>
      /^(?:LoadSAM3Model|SAM3VideoSegmentation|SAM3Propagate|SAM3VideoOutput)$/i
        .test(node.class_type)
    );
  }

  private registerSamPrompt(promptId: string, prompt: ComfyApiPrompt) {
    if (!this.promptUsesSam(prompt)) return;
    this.samPromptIds.add(promptId);
    this.releasedSamPrompts.delete(promptId);
  }

  private async releaseSamPrompt(promptId: string) {
    if (!this.samRuntime || !this.samPromptIds.has(promptId) || this.releasedSamPrompts.has(promptId)) return;
    const release = this.samReleaseQueue.catch(() => undefined).then(async () => {
      if (this.releasedSamPrompts.has(promptId)) return;
      const queue = await this.comfy.queueState().catch(() => null);
      const anotherSamPromptIsRunning = queue
        ? [...queue.runningPromptIds].some(
            (runningId) => runningId !== promptId && this.samPromptIds.has(runningId),
          )
        : false;
      if (!anotherSamPromptIsRunning) await this.samRuntime?.release();
      this.releasedSamPrompts.add(promptId);
    });
    this.samReleaseQueue = release;
    await release;
  }
  async prepare(
    rawRequest: unknown,
    excludedSeeds: ReadonlySet<number> = new Set(),
    runtimeOverride?: RuntimeSettings,
    compilePlanner = false,
  ) {
    const wantsMasking = isRecord(rawRequest) &&
      rawRequest.videoEngine !== "ltx25" &&
      rawRequest.generationMode === "VIDEO EDITING" &&
      typeof rawRequest.inpaintTarget === "string" &&
      rawRequest.inpaintTarget.trim().length > 0;
    if (wantsMasking) {
      const requiredClasses = [
        "LoadSAM3Model",
        "SAM3VideoSegmentation",
        "SAM3Propagate",
        "SAM3VideoOutput",
        "MVEx_MaskToLatentSpace",
        "MVEx_SubjectCrop",
        "MVEx_SubjectUncrop",
      ] as const;
      const [nodeInfo, samplerInfo] = await Promise.all([
        Promise.all(requiredClasses.map(async (className) => {
          const info = await this.comfy.objectInfo(className).catch(() => null);
          return [className, isRecord(info) && isRecord(info[className])] as const;
        })),
        this.comfy.objectInfo("H3ReferenceMemorySampler").catch(() => null),
      ]);
      const missing = nodeInfo
        .filter(([, available]) => !available)
        .map(([className]) => className as string);
      const sampler = samplerInfo?.H3ReferenceMemorySampler;
      const input = isRecord(sampler) && isRecord(sampler.input) ? sampler.input : null;
      const optional = input && isRecord(input.optional) ? input.optional : null;
      if (!optional || !("studio_inpaint_crop_mode" in optional)) {
        missing.push("H3ReferenceMemorySampler (MaskVid crop/uncrop)");
      }
      if (missing.length) {
        throw new Error(`Masking H3 non pronto: mancano ${missing.join(", ")}. Installa le dipendenze dalla pagina Admin e riavvia ComfyUI.`);
      }
    }
    const [sourcePrompt, runtimeSettings] = await Promise.all([
      isRecord(rawRequest) && rawRequest.videoEngine === "ltx25"
        ? Promise.resolve({} as ComfyApiPrompt)
        : this.workflowStore.loadApiPrompt(),
      runtimeOverride ?? this.runtimeSettings.get(),
    ]);
    if (isRecord(rawRequest) && rawRequest.videoEngine === "ltx25") {
      const installedModels = await this.comfy.models("diffusion_models");
      const installedEncoders = await this.comfy.models("text_encoders");
      const installedVaes = await this.comfy.models("vae");
      const installedUpscalers = await this.comfy.modelFiles("latent_upscale_models");
      const missing = [
        installedModels.includes(runtimeSettings.ltx25.model) ? null : runtimeSettings.ltx25.model,
        installedEncoders.includes(runtimeSettings.ltx25.encoder) ? null : runtimeSettings.ltx25.encoder,
        installedVaes.includes(runtimeSettings.ltx25.videoVae) ? null : runtimeSettings.ltx25.videoVae,
        installedVaes.includes(runtimeSettings.ltx25.audioVae) ? null : runtimeSettings.ltx25.audioVae,
        rawRequest.qualityMode === "max" && !installedUpscalers.includes(runtimeSettings.ltx25.upscaler)
          ? runtimeSettings.ltx25.upscaler
          : null,
      ].filter((item): item is string => Boolean(item));
      if (missing.length) {
        throw new Error(`LTX 2.5 non pronto: mancano ${missing.join(", ")}`);
      }
    }
    const prepared = prepareStudioJob(
      sourcePrompt,
      rawRequest,
      runtimeSettings,
      randomUUID(),
      excludedSeeds,
    );
    if (
      compilePlanner &&
      prepared.request.videoEngine === "h3" &&
      runtimeSettings.planner.backend !== "local"
    ) {
      if (!this.llm) throw new Error("Provider Planner remoto non configurato");
      try {
        const plan = await planH3Video(this.llm, prepared.request);
        for (const candidate of prepared.candidates) {
          injectRemoteVideoPlan(candidate.prompt, plan.response);
        }
      } finally {
        if (runtimeSettings.planner.backend === "auto") {
          await this.llm.unloadLocal();
        }
      }
    }
    if (prepared.engineSettings.loras.length) {
      const installedLoras = await this.comfy.models("loras");
      const missing = prepared.engineSettings.loras.find((lora) => !installedLoras.includes(lora.name));
      if (missing) throw new Error(`LoRA non installato: ${missing.name}`);
    }
    return { prepared };
  }

  async submit(rawRequest: unknown) {
    const { prepared } = await this.prepare(rawRequest, new Set(), undefined, true);
    return this.submitPrepared(prepared);
  }

  async regenerate(jobId: string, candidateIndex?: number, promptValue?: unknown) {
    const original = this.jobs.get(jobId);
    if (!original) throw new Error("Job video da rigenerare non trovato");
    if (
      candidateIndex !== undefined &&
      !original.candidates.some((candidate) => candidate.index === candidateIndex)
    ) {
      throw new Error("Candidato video da rigenerare non trovato");
    }
    const candidateCount = candidateIndex === undefined
      ? original.request.candidateCount
      : 1;
    const prompt = promptValue === undefined
      ? original.request.prompt
      : typeof promptValue === "string"
        ? promptValue.trim()
        : "";
    if (prompt.length < 3 || prompt.length > 20_000) {
      throw new Error("Il prompt video deve contenere da 3 a 20.000 caratteri");
    }
    const currentSettings = await this.runtimeSettings.get();
    const preservedSettings: RuntimeSettings = original.engine.family === "ltx25"
      ? {
          ...currentSettings,
          ltx25: {
            model: original.engine.model || currentSettings.ltx25.model,
            encoder: original.engine.encoder || currentSettings.ltx25.encoder,
            videoVae: original.engine.videoVae || currentSettings.ltx25.videoVae,
            audioVae: original.engine.audioVae || currentSettings.ltx25.audioVae,
            upscaler: original.engine.upscaler || currentSettings.ltx25.upscaler,
            steps: 8,
            cfg: original.engine.cfg,
            sampler: original.engine.sampler,
          },
        }
      : {
          ...currentSettings,
          h3: {
            model: original.engine.model,
            loras: original.engine.loras,
            steps: original.engine.steps,
          },
        };
    const { prepared } = await this.prepare(
      {
        ...original.request,
        prompt,
        candidateCount,
        seedMode: "random",
        seed: undefined,
      },
      new Set(original.candidates.map((candidate) => candidate.seed)),
      preservedSettings,
      true,
    );
    return this.submitPrepared(prepared);
  }

  private async submitPrepared(
    prepared: ReturnType<typeof prepareStudioJob>,
  ) {
    this.jobs.createPrepared(prepared, prepared.engineSettings);
    let submittedCount = 0;

    try {
      for (const candidate of prepared.candidates) {
        const queued = await this.comfy.queuePrompt(
          candidate.prompt,
          `h3-studio-${prepared.jobId}`,
        );
        this.progressTracker.register(queued.promptId, candidate.prompt);
        this.registerSamPrompt(queued.promptId, candidate.prompt);
        this.jobs.markQueued(
          prepared.jobId,
          candidate.index,
          queued.promptId,
          queued.queueNumber,
        );
        submittedCount += 1;
      }
    } catch (error) {
      this.jobs.updateJobStatus(
        prepared.jobId,
        submittedCount > 0 ? "partial" : "failed",
      );
      throw error;
    }

    this.jobs.updateJobStatus(prepared.jobId, "submitted");
    return this.jobs.get(prepared.jobId);
  }

  async get(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const [history, queue] = await Promise.all([
      this.comfy.history(200),
      this.comfy.queueState(),
    ]);
    const candidates = job.candidates.map((candidate) => {
      if (!candidate.promptId) {
        return {
          ...candidate,
          phase: "prepared",
          phaseLabel: "Non ancora inviato",
          progress: null,
          progressExact: false,
        };
      }
      const entry = history[candidate.promptId];
      const statusString =
        entry && isRecord(entry.status) && typeof entry.status.status_str === "string"
          ? entry.status.status_str
          : null;
      const output = entry ? findVideoOutput(entry.outputs) : candidate.output;
      const executionError = historyExecutionError(entry);
      const liveProgress = this.progressTracker.get(candidate.promptId);
      const currentNodeClass = this.progressTracker.nodeClass(
        candidate.promptId,
        liveProgress?.currentNode,
      );
      if (
        this.samPromptIds.has(candidate.promptId) &&
        (isH3SamplerClass(currentNodeClass) ||
          liveProgress?.phase === "completed" ||
          liveProgress?.phase === "failed" ||
          statusString === "success" ||
          statusString === "error")
      ) {
        void this.releaseSamPrompt(candidate.promptId).catch(() => undefined);
      }
      let status = candidate.status;
      if (statusString === "success" && output) status = "ready";
      else if (statusString === "error" || liveProgress?.phase === "failed") {
        status = "failed";
      }
      else if (queue.runningPromptIds.has(candidate.promptId)) status = "rendering";
      else if (queue.pendingPromptIds.has(candidate.promptId)) status = "queued";

      this.jobs.updateCandidate(job.id, candidate.index, status, output);
      if (status === "failed" && executionError) {
        this.jobs.failCandidate(job.id, candidate.index, executionError);
      }
      const terminal = status === "ready" || status === "failed";
      const failureError = candidate.error ?? executionError;
      return {
        ...candidate,
        status,
        output,
        error: status === "failed" ? failureError : candidate.error,
        phase:
          status === "ready"
            ? "completed"
            : status === "failed"
              ? "failed"
              : liveProgress?.phase ?? status,
        phaseLabel:
          status === "ready"
            ? "Completato"
            : status === "failed"
              ? failureError ?? "Esecuzione fallita"
              : liveProgress?.phaseLabel ??
          (status === "queued"
            ? "In coda"
            : status === "rendering"
              ? "ComfyUI in esecuzione"
              : "Inviato a ComfyUI"),
        progress:
          status === "ready"
            ? 100
            : status === "failed"
              ? null
              : liveProgress?.progress ?? null,
        progressExact: terminal ? status === "ready" : liveProgress?.exact ?? false,
      };
    });

    const completed = candidates.filter(
      (candidate) => candidate.status === "ready" || candidate.status === "failed",
    ).length;
    const status: StudioJob["status"] =
      completed === candidates.length
        ? candidates.some((candidate) => candidate.status === "failed")
          ? "partial"
          : "completed"
        : "running";
    this.jobs.updateJobStatus(job.id, status);
    return {
      ...job,
      status,
      completed,
      candidates,
    };
  }

  async cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Job non trovato");
    const active = job.candidates.filter(
      (candidate) => candidate.status !== "ready" && candidate.status !== "failed",
    );
    await this.comfy.cancelPrompts(
      active.flatMap((candidate) => candidate.promptId ? [candidate.promptId] : []),
    );
    for (const candidate of active) {
      this.jobs.failCandidate(jobId, candidate.index, "Interrotto su richiesta");
    }
    if (active.length > 0) {
      this.jobs.updateJobStatus(
        jobId,
        job.candidates.some((candidate) => candidate.status === "ready") ? "partial" : "failed",
      );
    }
    return this.get(jobId);
  }

  async recover() {
    let recovered = 0;
    for (const candidate of this.jobs.recoverableCandidates()) {
      try {
        const prompt = JSON.parse(candidate.api_prompt_json) as ComfyApiPrompt;
        this.progressTracker.register(candidate.prompt_id, prompt);
        recovered += 1;
      } catch {
        // A malformed historical snapshot must not prevent bridge startup.
      }
    }
    return recovered;
  }

  async list(limit = 20, projectId?: string | null) {
    const jobs = await Promise.all(
      this.jobs.listIds(limit, projectId).map((jobId) => this.get(jobId)),
    );
    return jobs.filter((job): job is NonNullable<typeof job> => job !== null);
  }

  async selectCandidate(jobId: string, candidateIndex: number) {
    if (!Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4) {
      throw new Error("Indice candidato non valido");
    }
    const job = await this.get(jobId);
    if (!job) throw new Error("Job non trovato");
    const candidate = job.candidates.find(
      (item) => item.index === candidateIndex,
    );
    if (!candidate || candidate.status !== "ready" || !candidate.output) {
      throw new Error("Puoi selezionare soltanto un candidato completato");
    }
    this.jobs.selectCandidate(jobId, candidateIndex);
    return this.jobs.get(jobId);
  }
}

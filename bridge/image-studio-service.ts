import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  CHARACTER_TURNAROUND_FORMAT,
  composeImagePrompt,
  isImageCompositionPreset,
} from "../lib/image-composition.js";
import type {
  ComfyApiPrompt,
  ComfyClient,
  ComfyHistoryEntry,
} from "./comfy-client.js";
import {
  type ImageJobMode,
  ImageJobRepository,
  type ImageJobReferenceInput,
  type ImageProjectTag,
  type ImageReferenceRole,
  type ImageSeedMode,
  type PreparedImageJob,
} from "./image-job-repository.js";
import {
  assertImageDimensions,
  buildAnimaGeneratePrompt,
  buildFlux2KleinEditPrompt,
  buildKreaGeneratePrompt,
  buildMiniMaxH3ImagePrompt,
  DEFAULT_MINIMAX_H3_IMAGE_SETTINGS,
  IMAGE_API_MAX_PIXELS,
  IMAGE_EDIT_MAX_REFERENCES,
  IMAGE_UI_TARGET_MAX_PIXELS,
  MINIMAX_H3_IMAGE_MAX_REFERENCES,
} from "./image-workflow-builder.js";
import type { RuntimeSettings, RuntimeSettingsStore } from "./runtime-settings.js";
import type { ComfyProgressTracker } from "./comfy-progress.js";

const MAX_SEED = 9_007_199_254_740_000;
const referenceRoles = new Set<ImageReferenceRole>([
  "base",
  "subject",
  "style",
  "pose",
  "background",
  "other",
]);
const projectTags = new Set<ImageProjectTag>([
  "untagged",
  "character",
  "object",
  "background",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomSeed() {
  return Math.floor(Math.random() * MAX_SEED);
}

function normalizeFile(value: unknown) {
  const file = typeof value === "string"
    ? value.trim().replaceAll(String.fromCharCode(92), "/")
    : "";
  const suffix = [" [input]", " [output]", " [temp]"].find((candidate) =>
    file.toLowerCase().endsWith(candidate),
  );
  const clean = suffix ? file.slice(0, -suffix.length) : file;
  if (
    !file ||
    file.length > 1_024 ||
    /^[a-z]:/i.test(clean) ||
    clean.startsWith("/") ||
    clean.split("/").includes("..")
  ) {
    throw new Error("Percorso reference immagine non valido");
  }
  return file;
}

function normalizeReference(
  value: unknown,
  index: number,
): ImageJobReferenceInput {
  if (!isRecord(value)) throw new Error(`Reference ${index + 1} non valida`);
  const file = normalizeFile(value.file);
  const suffix = [" [input]", " [output]", " [temp]"].find((candidate) =>
    file.toLowerCase().endsWith(candidate),
  );
  const clean = suffix ? file.slice(0, -suffix.length) : file;
  const fallbackName = clean.slice(clean.lastIndexOf("/") + 1);
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim().slice(0, 240)
      : fallbackName;
  const requestedRole = typeof value.role === "string" ? value.role : "";
  const role = referenceRoles.has(requestedRole as ImageReferenceRole)
    ? (requestedRole as ImageReferenceRole)
    : index === 0
      ? "base"
      : "other";
  const width = value.width === undefined || value.width === null
    ? null
    : Number(value.width);
  const height = value.height === undefined || value.height === null
    ? null
    : Number(value.height);
  if (width !== null && (!Number.isInteger(width) || width <= 0)) {
    throw new Error(`Larghezza reference ${index + 1} non valida`);
  }
  if (height !== null && (!Number.isInteger(height) || height <= 0)) {
    throw new Error(`Altezza reference ${index + 1} non valida`);
  }
  return { file, name, role, width, height };
}

export function normalizeImageRequest(value: unknown) {
  if (!isRecord(value)) throw new Error("Body immagine mancante");
  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  if (!projectId) throw new Error("Seleziona un progetto");
  const imageMode = value.mode === "edit"
    ? "edit"
    : value.mode === "anima"
      ? "anima"
      : "generate";
  const imageEngine = value.engine === "minimax" ? "minimax" : "default";
  // The persisted DB mode remains backward compatible; the engine snapshot
  // distinguishes Anima jobs from ordinary Krea generations.
  const mode: ImageJobMode = imageMode === "edit" ? "edit" : "generate";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (prompt.length < 3 || prompt.length > 20_000) {
    throw new Error("Il prompt immagine deve contenere da 3 a 20.000 caratteri");
  }
  const compositionPreset = value.compositionPreset === undefined
    ? "free"
    : isImageCompositionPreset(value.compositionPreset)
      ? value.compositionPreset
      : null;
  if (!compositionPreset) throw new Error("Preset di composizione immagine non valido");
  const isCharacterTurnaround = compositionPreset === "character-turnaround";
  const effectivePrompt = composeImagePrompt(prompt, compositionPreset);
  if (effectivePrompt.length > 20_000) {
    throw new Error("Il prompt effettivo non può superare 20.000 caratteri");
  }
  if (
    !isCharacterTurnaround &&
    value.effectivePrompt !== undefined &&
    (typeof value.effectivePrompt !== "string" ||
      value.effectivePrompt.trim() !== effectivePrompt)
  ) {
    throw new Error("Il prompt effettivo non corrisponde al preset selezionato");
  }
  const candidateCount = Number(value.candidateCount);
  if (![1, 2, 3, 4].includes(candidateCount)) {
    throw new Error("candidateCount deve essere 1, 2, 3 o 4");
  }
  // The bridge is authoritative for the turnaround canvas. Older browser
  // bundles can still submit their previous square dimensions and prompt;
  // normalize both before graph construction and persistence.
  const width = isCharacterTurnaround
    ? CHARACTER_TURNAROUND_FORMAT.width
    : Number(value.width);
  const height = isCharacterTurnaround
    ? CHARACTER_TURNAROUND_FORMAT.height
    : Number(value.height);
  assertImageDimensions(width, height);
  const aspectFormat = isCharacterTurnaround
    ? CHARACTER_TURNAROUND_FORMAT.aspectFormat
    : typeof value.aspectFormat === "string" && value.aspectFormat.trim()
      ? value.aspectFormat.trim().slice(0, 60)
      : `${width}:${height}`;
  const seedMode: ImageSeedMode =
    value.seedMode === "base" || value.seedMode === "fixed"
      ? value.seedMode
      : "random";
  const requestedSeed =
    value.seed === undefined || value.seed === null || value.seed === ""
      ? null
      : Number(value.seed);
  if (
    requestedSeed !== null &&
    (!Number.isSafeInteger(requestedSeed) ||
      requestedSeed < 0 ||
      requestedSeed >= MAX_SEED)
  ) {
    throw new Error("Il seed immagine deve essere un intero sicuro maggiore o uguale a zero");
  }
  if (seedMode !== "random" && requestedSeed === null) {
    throw new Error("Inserisci un seed per la modalità base o bloccata");
  }
  const rawReferences = value.references === undefined ? [] : value.references;
  if (!Array.isArray(rawReferences)) throw new Error("Le reference devono essere un array");
  const referenceLimit = imageEngine === "minimax"
    ? MINIMAX_H3_IMAGE_MAX_REFERENCES
    : IMAGE_EDIT_MAX_REFERENCES;
  if (rawReferences.length > referenceLimit) {
    throw new Error(imageEngine === "minimax"
      ? "MiniMax H3 Image supporta al massimo 9 reference"
      : "Flux.2 Klein Edit supporta al massimo 4 reference");
  }
  if (imageMode === "edit" && rawReferences.length === 0) {
    throw new Error("La modalità Edit richiede almeno una reference");
  }
  if (imageMode !== "edit" && rawReferences.length > 0) {
    throw new Error("Le reference si usano in modalità Edit");
  }
  const references = rawReferences.map(normalizeReference);
  const requestedTag = typeof value.tag === "string" ? value.tag : "";
  const tag = projectTags.has(requestedTag as ImageProjectTag)
    ? (requestedTag as ImageProjectTag)
    : "untagged";
  return {
    projectId,
    mode,
    imageMode,
    imageEngine,
    prompt,
    effectivePrompt,
    compositionPreset,
    candidateCount: candidateCount as 1 | 2 | 3 | 4,
    width,
    height,
    aspectFormat,
    seedMode,
    requestedSeed,
    references,
    tag,
  };
}

function findImageOutput(entry: ComfyHistoryEntry) {
  if (!isRecord(entry.outputs)) return null;
  for (const output of Object.values(entry.outputs)) {
    if (!isRecord(output)) continue;
    for (const value of Object.values(output)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!isRecord(item) || typeof item.filename !== "string") continue;
        if (!/\.(png|jpe?g|webp)$/i.test(item.filename)) continue;
        const type: "input" | "output" | "temp" =
          item.type === "input" || item.type === "temp" ? item.type : "output";
        return {
          filename: item.filename,
          subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
          type,
          format:
            typeof item.format === "string" && item.format.startsWith("image/")
              ? item.format
              : "image/png",
        };
      }
    }
  }
  return null;
}

function objectInfoContains(value: unknown, className: string) {
  return isRecord(value) && isRecord(value[className]);
}

function objectInfoOptions(
  value: unknown,
  className: string,
  inputName: string,
) {
  if (!isRecord(value) || !isRecord(value[className])) return [];
  const input = value[className].input;
  if (!isRecord(input) || !isRecord(input.required)) return [];
  const descriptor = input.required[inputName];
  if (!Array.isArray(descriptor) || !Array.isArray(descriptor[0])) return [];
  return descriptor[0].filter((item): item is string => typeof item === "string");
}

async function readWorkflowTemplate(filePath: string): Promise<ComfyApiPrompt> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "file non leggibile";
    throw new Error(`Workflow immagini non disponibile: ${detail}`);
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("Il workflow immagini selezionato non contiene un prompt API valido");
  }
  for (const [id, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.class_type !== "string" || !isRecord(value.inputs)) {
      throw new Error(`Nodo ${id} non valido nel workflow immagini selezionato`);
    }
  }
  return parsed as ComfyApiPrompt;
}

export class ImageStudioService {
  constructor(
    private readonly comfy: ComfyClient,
    private readonly repository: ImageJobRepository,
    private readonly runtimeSettings: RuntimeSettingsStore,
    private readonly generateWorkflowPath: string,
    private readonly editWorkflowPath: string,
    private readonly animaWorkflowPath: string,
    private readonly minimaxWorkflowPath: string,
    private readonly progressTracker?: ComfyProgressTracker,
  ) {}

  async prepare(
    value: unknown,
    excludedSeeds: ReadonlySet<number> = new Set(),
    runtimeOverride?: RuntimeSettings,
  ): Promise<PreparedImageJob> {
    const request = normalizeImageRequest(value);
    const [settings, workflowTemplate] = await Promise.all([
      runtimeOverride ?? this.runtimeSettings.get(),
      readWorkflowTemplate(
        request.imageEngine === "minimax"
          ? this.minimaxWorkflowPath
          : request.imageMode === "edit"
            ? this.editWorkflowPath
          : request.imageMode === "anima"
            ? this.animaWorkflowPath
            : this.generateWorkflowPath,
      ),
    ]);
    const id = randomUUID();
    const baseSeed = request.requestedSeed ?? randomSeed();
    const usedRandomSeeds = new Set<number>();
    const minimaxSettings = {
      model: settings.h3.model,
      ...DEFAULT_MINIMAX_H3_IMAGE_SETTINGS,
    };
    const engine = request.imageEngine === "minimax"
      ? {
          kind: "minimax-h3-image" as const,
          model: minimaxSettings.model,
          encoder: minimaxSettings.encoder,
          vae: minimaxSettings.vae,
          steps: 8,
          cfg: 1,
          sampler: "er_sde",
          scheduler: "sgm_uniform",
          compositionPreset: request.compositionPreset,
          effectivePrompt: request.effectivePrompt,
          imageMode: request.references.length === 0
            ? "t2i" as const
            : request.references.length === 1
              ? "i2i" as const
              : "reference" as const,
          turboLora: minimaxSettings.turboLora,
          turboStrength: minimaxSettings.turboStrength,
          detailLora: minimaxSettings.detailLora,
          detailStrength: minimaxSettings.detailStrength,
          preserveStrength: minimaxSettings.preserveStrength,
          loras: [
            { name: minimaxSettings.turboLora, strength: minimaxSettings.turboStrength },
            { name: minimaxSettings.detailLora, strength: minimaxSettings.detailStrength },
          ],
        }
      : request.imageMode === "edit"
      ? {
          kind: "flux2-klein-edit" as const,
          model: settings.imageEdit.model,
          encoder: settings.imageEdit.encoder,
          vae: settings.imageEdit.vae,
          steps: settings.imageEdit.steps,
          cfg: settings.imageEdit.cfg,
          sampler: "euler",
          scheduler: "flux2",
          kvCacheEnabled: settings.imageEdit.kvCacheEnabled,
          attentionBackend: settings.imageEdit.attentionBackend,
          compositionPreset: request.compositionPreset,
          effectivePrompt: request.effectivePrompt,
        }
      : request.imageMode === "anima"
        ? {
            kind: "anima" as const,
            model: settings.anima.model,
            encoder: settings.anima.encoder,
            vae: settings.anima.vae,
            steps: settings.anima.steps,
            cfg: settings.anima.cfg,
            sampler: "euler",
            scheduler: "simple",
            compositionPreset: request.compositionPreset,
            effectivePrompt: request.effectivePrompt,
            loras: settings.anima.loras,
          }
        : {
          kind: "krea" as const,
          model: settings.krea.model,
          encoder: settings.krea.encoder,
          vae: settings.krea.vae,
          steps: settings.krea.steps,
          cfg: 1,
          sampler: "er_sde",
          scheduler: "simple",
          compositionPreset: request.compositionPreset,
          effectivePrompt: request.effectivePrompt,
          loras: settings.krea.loras,
        };
    const candidates = Array.from({ length: request.candidateCount }, (_, offset) => {
      const index = offset + 1;
      let seed: number;
      if (request.seedMode === "fixed") seed = baseSeed;
      else if (request.seedMode === "base") seed = (baseSeed + offset) % MAX_SEED;
      else {
        do seed = randomSeed();
        while (usedRandomSeeds.has(seed) || excludedSeeds.has(seed));
        usedRandomSeeds.add(seed);
      }
      const filenamePrefix =
        `images/H3_STUDIO/projects/${request.projectId}/${request.imageMode}_${id.slice(0, 8)}_c${index}`;
      const apiPrompt = request.imageEngine === "minimax"
        ? buildMiniMaxH3ImagePrompt({
            prompt: request.effectivePrompt,
            seed,
            width: request.width,
            height: request.height,
            filenamePrefix,
            settings: minimaxSettings,
            references: request.references,
            template: workflowTemplate,
          })
        : request.imageMode === "edit"
          ? buildFlux2KleinEditPrompt({
            prompt: request.effectivePrompt,
            seed,
            width: request.width,
            height: request.height,
            filenamePrefix,
            settings: settings.imageEdit,
            references: request.references,
            template: workflowTemplate,
          })
        : request.imageMode === "anima"
          ? buildAnimaGeneratePrompt({
              prompt: request.effectivePrompt,
              seed,
              width: request.width,
              height: request.height,
              filenamePrefix,
              settings: settings.anima,
              template: workflowTemplate,
            })
          : buildKreaGeneratePrompt({
            prompt: request.effectivePrompt,
            seed,
            width: request.width,
            height: request.height,
            filenamePrefix,
            settings: settings.krea,
            template: workflowTemplate,
          });
      return { index, seed, filenamePrefix, apiPrompt };
    });
    return {
      id,
      originProjectId: request.projectId,
      mode: request.mode,
      prompt: request.prompt,
      effectivePrompt: request.effectivePrompt,
      compositionPreset: request.compositionPreset,
      candidateCount: request.candidateCount,
      aspectFormat: request.aspectFormat,
      width: request.width,
      height: request.height,
      seedMode: request.seedMode,
      requestedSeed: request.requestedSeed,
      tag: request.tag,
      engine,
      references: request.references,
      candidates,
    };
  }

  async dryRun(value: unknown) {
    const prepared = await this.prepare(value);
    return {
      ok: true,
      dryRun: true,
      job: {
        ...prepared,
        candidates: prepared.candidates.map((candidate) => ({
          index: candidate.index,
          seed: candidate.seed,
          filenamePrefix: candidate.filenamePrefix,
          apiNodeCount: Object.keys(candidate.apiPrompt).length,
        })),
      },
    };
  }

  async submit(value: unknown) {
    const prepared = await this.prepare(value);
    return this.submitPrepared(prepared);
  }

  async regenerate(jobId: string, candidateIndex?: number, promptValue?: unknown) {
    const original = this.repository.get(jobId);
    if (!original) throw new Error("Job immagine da rigenerare non trovato");
    const sourceCandidate = candidateIndex === undefined
      ? original.candidates[0]
      : original.candidates.find((candidate) => candidate.index === candidateIndex);
    if (!sourceCandidate) throw new Error("Candidato immagine da rigenerare non trovato");
    const prompt = promptValue === undefined
      ? original.prompt
      : typeof promptValue === "string"
        ? promptValue.trim()
        : "";
    if (prompt.length < 3 || prompt.length > 20_000) {
      throw new Error("Il prompt immagine deve contenere da 3 a 20.000 caratteri");
    }
    const originLink = sourceCandidate.projectLinks.find(
      (link) => link.projectId === original.originProjectId,
    );
    const mode = original.engine.kind === "anima" ? "anima" : original.mode;
    const imageEngine = original.engine.kind === "minimax-h3-image" ? "minimax" : "default";
    const currentSettings = await this.runtimeSettings.get();
    const preservedSettings: RuntimeSettings = original.engine.kind === "minimax-h3-image"
      ? {
          ...currentSettings,
          h3: { ...currentSettings.h3, model: original.engine.model },
        }
      : original.engine.kind === "anima"
      ? {
          ...currentSettings,
          anima: {
            model: original.engine.model,
            encoder: original.engine.encoder,
            vae: original.engine.vae,
            steps: original.engine.steps,
            cfg: original.engine.cfg,
            loras: original.engine.loras ?? [],
          },
        }
      : original.engine.kind === "flux2-klein-edit"
        ? {
            ...currentSettings,
            imageEdit: {
              model: original.engine.model,
              encoder: original.engine.encoder,
              vae: original.engine.vae,
              steps: original.engine.steps,
              cfg: original.engine.cfg,
              kvCacheEnabled: original.engine.kvCacheEnabled ?? currentSettings.imageEdit.kvCacheEnabled,
              attentionBackend: original.engine.attentionBackend ?? currentSettings.imageEdit.attentionBackend,
            },
          }
        : {
            ...currentSettings,
            krea: {
              model: original.engine.model,
              encoder: original.engine.encoder,
              vae: original.engine.vae,
              steps: original.engine.steps,
              loras: original.engine.loras ?? [],
            },
          };
    const prepared = await this.prepare(
      {
        projectId: original.originProjectId,
        mode,
        engine: imageEngine,
        prompt,
        compositionPreset: original.compositionPreset,
        candidateCount: candidateIndex === undefined ? original.candidateCount : 1,
        aspectFormat: original.aspectFormat,
        width: original.width,
        height: original.height,
        seedMode: "random",
        references: mode === "edit" ? original.references : [],
        tag: originLink?.tag ?? "untagged",
      },
      new Set(original.candidates.map((candidate) => candidate.seed)),
      preservedSettings,
    );
    return this.submitPrepared(prepared);
  }

  private async submitPrepared(prepared: PreparedImageJob) {
    this.repository.createPrepared(prepared);
    for (const candidate of prepared.candidates) {
      try {
        const queued = await this.comfy.queuePrompt(
          candidate.apiPrompt,
          `h3-studio-image-${prepared.id}-${candidate.index}`,
        );
        this.repository.markQueued(
          prepared.id,
          candidate.index,
          queued.promptId,
          queued.queueNumber,
        );
        this.progressTracker?.register(
          queued.promptId,
          candidate.apiPrompt,
          "image",
        );
      } catch (error) {
        this.repository.markCandidateStatus(
          prepared.id,
          candidate.index,
          "failed",
          null,
          error instanceof Error ? error.message : "Invio immagine a ComfyUI fallito",
        );
      }
    }
    return this.present(this.repository.get(prepared.id)!);
  }

  async sync() {
    const pending = this.repository.pendingCandidates();
    if (pending.length === 0) return 0;
    const [history, queue] = await Promise.all([
      this.comfy.history(200),
      this.comfy.queueState(),
    ]);
    for (const candidate of pending) {
      if (!candidate.prompt_id) continue;
      const entry = history[candidate.prompt_id];
      const output = entry ? findImageOutput(entry) : null;
      if (output) {
        this.repository.markCandidateStatus(
          candidate.job_id,
          candidate.candidate_index,
          "ready",
          output,
        );
        continue;
      }
      if (queue.runningPromptIds.has(candidate.prompt_id)) {
        this.repository.markCandidateStatus(
          candidate.job_id,
          candidate.candidate_index,
          "running",
        );
        continue;
      }
      if (queue.pendingPromptIds.has(candidate.prompt_id)) {
        this.repository.markCandidateStatus(
          candidate.job_id,
          candidate.candidate_index,
          "queued",
        );
        continue;
      }
      const status = entry?.status;
      if (isRecord(status) && status.status_str === "error") {
        this.repository.markCandidateStatus(
          candidate.job_id,
          candidate.candidate_index,
          "failed",
          null,
          "ComfyUI ha interrotto la generazione immagine",
        );
        continue;
      }
      if (
        isRecord(status) &&
        (status.status_str === "success" || status.status_str === "completed")
      ) {
        this.repository.markCandidateStatus(
          candidate.job_id,
          candidate.candidate_index,
          "failed",
          null,
          "ComfyUI ha completato il prompt senza produrre un output immagine",
        );
        continue;
      }
      if (
        !entry &&
        Date.now() - Date.parse(candidate.updated_at) > 30_000
      ) {
        this.repository.markCandidateStatus(
          candidate.job_id,
          candidate.candidate_index,
          "failed",
          null,
          "Il prompt non è più presente nella coda o nella history ComfyUI",
        );
      }
    }
    return pending.length;
  }

  async recover() {
    for (const candidate of this.repository.pendingCandidates()) {
      if (!candidate.prompt_id) continue;
      try {
        this.progressTracker?.register(
          candidate.prompt_id,
          JSON.parse(candidate.api_prompt_json),
          "image",
        );
      } catch {
        // A malformed historical prompt must not block bridge startup.
      }
    }
    return this.sync().catch(() => 0);
  }

  async get(jobId: string) {
    await this.sync().catch(() => undefined);
    const job = this.repository.get(jobId);
    return job ? this.present(job) : null;
  }

  async list(limit: number, projectId?: string | null) {
    await this.sync().catch(() => undefined);
    return this.repository.list(limit, projectId).map((job) => this.present(job));
  }

  async cancel(jobId: string) {
    if (!this.repository.get(jobId)) return null;
    await this.comfy.cancelPrompts(this.repository.promptIds(jobId));
    this.repository.markCancelled(jobId);
    const job = this.repository.get(jobId);
    return job ? this.present(job) : null;
  }

  select(jobId: string, candidateIndex: number) {
    return this.present(this.repository.select(jobId, candidateIndex));
  }

  linkProject(
    jobId: string,
    candidateIndex: number,
    projectId: string,
    tag: ImageProjectTag,
  ) {
    if (!projectTags.has(tag)) throw new Error("Tag immagine non valido");
    return this.present(
      this.repository.linkProject(jobId, candidateIndex, projectId, tag),
    );
  }

  unlinkProject(jobId: string, candidateIndex: number, projectId: string) {
    return this.present(
      this.repository.unlinkProject(jobId, candidateIndex, projectId),
    );
  }

  deleteCandidate(jobId: string, candidateIndex: number) {
    return this.repository.deleteCandidate(jobId, candidateIndex);
  }

  async summary() {
    const settings = await this.runtimeSettings.get();
    return {
      generate: {
        kind: "krea",
        model: settings.krea.model,
        steps: settings.krea.steps,
      },
      edit: {
        kind: "flux2-klein-edit",
        ...settings.imageEdit,
        maxReferences: IMAGE_EDIT_MAX_REFERENCES,
      },
      anima: {
        kind: "anima",
        ...settings.anima,
      },
      minimax: {
        kind: "minimax-h3-image",
        model: settings.h3.model,
        ...DEFAULT_MINIMAX_H3_IMAGE_SETTINGS,
        maxReferences: MINIMAX_H3_IMAGE_MAX_REFERENCES,
      },
      limits: {
        uiTargetMaxPixels: IMAGE_UI_TARGET_MAX_PIXELS,
        apiMaxPixels: IMAGE_API_MAX_PIXELS,
        sizeMultiple: 16,
      },
      storage: this.repository.stats(),
    };
  }

  async attentionBackends() {
    const info = await this.comfy.objectInfo("ModelAttentionBackend");
    return objectInfoOptions(info, "ModelAttentionBackend", "attention");
  }

  async status() {
    const settings = await this.runtimeSettings.get();
    const classNames = [
      "UNETLoader",
      "CLIPLoader",
      "VAELoader",
      "CLIPTextEncode",
      "ConditioningZeroOut",
      "EmptyLatentImage",
      "EmptyFlux2LatentImage",
      "RandomNoise",
      "CFGGuider",
      "KSamplerSelect",
      "Flux2Scheduler",
      "SamplerCustomAdvanced",
      "KSampler",
      "VAEDecode",
      "SaveImage",
      "LoadImage",
      "ImageScaleToTotalPixels",
      "VAEEncode",
      "ReferenceLatent",
      "FluxKVCache",
      "ModelAttentionBackend",
      "LoraLoaderModelOnly",
      "H3ImagePrepare",
      "H3ImageSamplingPreset",
      "H3ImageDecode",
      "H3ImageFrameSelector",
      "BasicGuider",
    ];
    const [models, encoders, vaes, loras, ...nodeInfo] = await Promise.all([
      this.comfy.modelFiles("diffusion_models"),
      this.comfy.modelFiles("text_encoders"),
      this.comfy.modelFiles("vae"),
      this.comfy.modelFiles("loras"),
      ...classNames.map((className) =>
        this.comfy.objectInfo(className).catch(() => null),
      ),
    ]);
    const editNodeChecks = Object.fromEntries(
      classNames.map((className, index) => [
        className,
        objectInfoContains(nodeInfo[index], className),
      ]),
    );
    const editCoreNodeChecks = Object.fromEntries(
      Object.entries(editNodeChecks).filter(([className]) =>
        className !== "FluxKVCache" && className !== "ModelAttentionBackend",
      ),
    );
    const kvCacheNodeAvailable = editNodeChecks.FluxKVCache === true;
    const attentionNodeAvailable = editNodeChecks.ModelAttentionBackend === true;
    const attentionBackendOptions = objectInfoOptions(
      nodeInfo[classNames.indexOf("ModelAttentionBackend")],
      "ModelAttentionBackend",
      "attention",
    );
    const generateChecks = {
      workflow: existsSync(this.generateWorkflowPath),
      model: models.includes(settings.krea.model),
      encoder: encoders.includes(settings.krea.encoder),
      vae: vaes.includes(settings.krea.vae),
      loras: settings.krea.loras.every((slot) => loras.includes(slot.name)),
    };
    const animaCoreClasses = [
      "UNETLoader",
      "CLIPLoader",
      "VAELoader",
      "CLIPTextEncode",
      "EmptyLatentImage",
      "KSampler",
      "VAEDecode",
      "SaveImage",
    ];
    const animaNodeChecks = Object.fromEntries(
      animaCoreClasses.map((className) => [
        className,
        objectInfoContains(
          nodeInfo[classNames.indexOf(className)],
          className,
        ),
      ]),
    );
    const animaChecks = {
      workflow: existsSync(this.animaWorkflowPath),
      model: models.includes(settings.anima.model),
      encoder: encoders.includes(settings.anima.encoder),
      vae: vaes.includes(settings.anima.vae),
      loras: settings.anima.loras.every((slot) => loras.includes(slot.name)),
      nodes: Object.values(animaNodeChecks).every(Boolean),
    };
    const minimaxCoreClasses = [
      "UNETLoader",
      "LoraLoaderModelOnly",
      "CLIPLoader",
      "VAELoader",
      "LoadImage",
      "H3ImagePrepare",
      "H3ImageSamplingPreset",
      "RandomNoise",
      "BasicGuider",
      "SamplerCustomAdvanced",
      "H3ImageDecode",
      "H3ImageFrameSelector",
      "SaveImage",
    ];
    const minimaxNodeChecks = Object.fromEntries(
      minimaxCoreClasses.map((className) => [
        className,
        objectInfoContains(nodeInfo[classNames.indexOf(className)], className),
      ]),
    );
    const minimaxDefaults = DEFAULT_MINIMAX_H3_IMAGE_SETTINGS;
    const minimaxChecks = {
      workflow: existsSync(this.minimaxWorkflowPath),
      model: models.includes(settings.h3.model),
      encoder: encoders.includes(minimaxDefaults.encoder),
      vae: vaes.includes(minimaxDefaults.vae),
      turboLora: loras.includes(minimaxDefaults.turboLora),
      detailLora: loras.includes(minimaxDefaults.detailLora),
      nodes: Object.values(minimaxNodeChecks).every(Boolean),
    };
    const editChecks = {
      workflow: existsSync(this.editWorkflowPath),
      model: models.includes(settings.imageEdit.model),
      encoder: encoders.includes(settings.imageEdit.encoder),
      vae: vaes.includes(settings.imageEdit.vae),
      nodes: Object.values(editCoreNodeChecks).every(Boolean),
      kvCache:
        !settings.imageEdit.kvCacheEnabled || kvCacheNodeAvailable,
      attentionBackend:
        settings.imageEdit.attentionBackend === "auto" ||
        attentionBackendOptions.includes(settings.imageEdit.attentionBackend),
    };
    return {
      ready: Object.values(generateChecks).every(Boolean) &&
        Object.values(editChecks).every(Boolean) &&
        Object.values(animaChecks).every(Boolean) &&
        Object.values(minimaxChecks).every(Boolean),
      generate: {
        ready: Object.values(generateChecks).every(Boolean),
        checks: generateChecks,
        engine: settings.krea,
        workflow: this.generateWorkflowPath,
      },
      edit: {
        ready: Object.values(editChecks).every(Boolean),
        checks: {
          ...editChecks,
          nodeClasses: editCoreNodeChecks,
          kvCacheNodeAvailable,
          kvCacheEnabled: settings.imageEdit.kvCacheEnabled,
          attentionNodeAvailable,
          attentionBackendOptions,
          attentionBackend: settings.imageEdit.attentionBackend,
        },
        engine: settings.imageEdit,
        workflow: this.editWorkflowPath,
        referenceLimit: IMAGE_EDIT_MAX_REFERENCES,
      },
      anima: {
        ready: Object.values(animaChecks).every(Boolean),
        checks: { ...animaChecks, nodeClasses: animaNodeChecks },
        engine: settings.anima,
        workflow: this.animaWorkflowPath,
      },
      minimax: {
        ready: Object.values(minimaxChecks).every(Boolean),
        checks: { ...minimaxChecks, nodeClasses: minimaxNodeChecks },
        engine: {
          model: settings.h3.model,
          ...minimaxDefaults,
        },
        workflow: this.minimaxWorkflowPath,
        referenceLimit: MINIMAX_H3_IMAGE_MAX_REFERENCES,
      },
      capabilities: {
        models: [...new Set(models)].sort(),
        textEncoders: [...new Set(encoders)].sort(),
        vaes: [...new Set(vaes)].sort(),
        loras: [...new Set(loras)].sort(),
        uiTargetMaxPixels: IMAGE_UI_TARGET_MAX_PIXELS,
        apiMaxPixels: IMAGE_API_MAX_PIXELS,
        sizeMultiple: 16,
      },
      storage: this.repository.stats(),
    };
  }

  private present(job: NonNullable<ReturnType<ImageJobRepository["get"]>>) {
    return {
      ...job,
      mode: job.engine.kind === "anima" ? "anima" : job.mode,
      candidates: job.candidates.map((candidate) => {
        const progress = candidate.promptId
          ? this.progressTracker?.get(candidate.promptId)
          : null;
        return {
          ...candidate,
          phase: progress?.phase ?? null,
          phaseLabel: progress?.phaseLabel ?? null,
          progress: progress?.progress ?? null,
          progressExact: progress?.exact ?? false,
        };
      }),
    };
  }
}

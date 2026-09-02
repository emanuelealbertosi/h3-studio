import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createReadStream, statSync } from "node:fs";
import { readFile, rm, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { ComfyClient } from "./comfy-client.js";
import { ComfyAdmissionController, isComfyBusyError } from "./comfy-admission.js";
import { config } from "./config.js";
import { WorkflowStore } from "./workflow-store.js";
import { publicDryRun, StudioJobService } from "./studio-job.js";
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettingsStore } from "./runtime-settings.js";
import { ComfyProgressTracker } from "./comfy-progress.js";
import { JobRepository } from "./job-repository.js";
import { ProjectRepository } from "./project-repository.js";
import { TimelineExportService } from "./timeline-export.js";
import { CreativeLibraryRepository } from "./creative-library-repository.js";
import { ExternalMediaRepository } from "./external-media-repository.js";
import { KreaAssetService } from "./krea-asset-service.js";
import { CandidateVariantRepository } from "./candidate-variant-repository.js";
import { PostprocessService } from "./postprocess-service.js";
import { AdminAuthService } from "./admin-auth.js";
import { assertLtx25AssetCompatibility } from "./ltx25-compatibility.js";
import {
  ImageJobRepository,
  type ImageProjectTag,
} from "./image-job-repository.js";
import { ImageStudioService } from "./image-studio-service.js";
import { ChatRepository } from "./chat-repository.js";
import { ChatService } from "./chat-service.js";
import { AudioJobRepository } from "./audio-job-repository.js";
import { AudioStudioService } from "./audio-studio-service.js";
import { PromptPlannerService } from "./prompt-planner.js";
import { LlmRuntimeControl } from "./llm-runtime-control.js";
import { LoraCatalogService } from "./lora-catalog.js";
import { SamRuntimeControl } from "./sam-runtime-control.js";
import { LlmProviderService, PlannerSecretStore } from "./llm-provider.js";
import {
  InstallSettingsStore,
  WORKFLOW_CATALOG,
  workflowPath,
} from "./install-settings.js";

const app = Fastify({
  logger: {
    level: process.env.H3_LOG_LEVEL?.trim() || "info",
  },
});

const installSettingsStore = new InstallSettingsStore(config.dataDir, {
  comfyUrl: config.comfyUrl,
  comfyOutputDir: config.comfyOutputDir,
  videoWorkflowId: "h3-aio-ultra",
  fastWorkflowId: "h3-fast-alibaba-pdd",
  imageWorkflowId: "krea2-character-sheet",
  imageEditWorkflowId: "flux2-klein-edit-core",
  imageAnimaWorkflowId: "anima-t2i-core",
  imageMinimaxWorkflowId: "minimax-h3-image-aio",
  ffmpegPath: config.ffmpegPath,
});
let installSettings = await installSettingsStore.get();

function scheduleBridgeRestart() {
  const helperPath = path.resolve("scripts", "restart-bridge-helper.mjs");
  const launchArguments = JSON.stringify([
    ...process.execArgv,
    ...process.argv.slice(1),
  ]);
  const helper = spawn(
    process.execPath,
    [
      helperPath,
      String(process.pid),
      process.execPath,
      process.cwd(),
      launchArguments,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  helper.unref();

  setTimeout(() => {
    const hardExit = setTimeout(() => process.exit(0), 3_000);
    hardExit.unref();
    void app.close().finally(() => process.exit(0));
  }, 500).unref();
}
const comfy = new ComfyClient(installSettings.comfyUrl, config.comfyTimeoutMs);
const comfyAdmission = new ComfyAdmissionController(comfy);
const loraCatalog = new LoraCatalogService(config.dataDir, installSettings.comfyOutputDir);
const workflowStore = new WorkflowStore(
  workflowPath(config.workflowOutputDir, installSettings.videoWorkflowId),
  config.workflowOutputDir,
);
const runtimeSettings = new RuntimeSettingsStore(config.dataDir);
const plannerSecrets = new PlannerSecretStore(config.dataDir);
const llmProvider = new LlmProviderService(comfy, runtimeSettings, plannerSecrets);
const promptPlanner = new PromptPlannerService(llmProvider);
const llmRuntime = new LlmRuntimeControl();
const samRuntime = new SamRuntimeControl();
const progressTracker = new ComfyProgressTracker(installSettings.comfyUrl);
progressTracker.start();
const jobRepository = new JobRepository(config.dataDir);
const adminAuth = new AdminAuthService(jobRepository.databasePath);
const projectRepository = new ProjectRepository(jobRepository.databasePath);
const creativeLibrary = new CreativeLibraryRepository(jobRepository.databasePath);
const externalMedia = new ExternalMediaRepository(jobRepository.databasePath);
const audioJobRepository = new AudioJobRepository(jobRepository.databasePath);
const imageJobRepository = new ImageJobRepository(jobRepository.databasePath);
const variantRepository = new CandidateVariantRepository(jobRepository.databasePath);
const kreaAssets = new KreaAssetService(
  comfy,
  creativeLibrary,
  workflowPath(config.workflowOutputDir, installSettings.imageWorkflowId),
  runtimeSettings,
);
const imageStudio = new ImageStudioService(
  comfy,
  imageJobRepository,
  runtimeSettings,
  workflowPath(config.workflowOutputDir, installSettings.imageWorkflowId),
  workflowPath(config.workflowOutputDir, installSettings.imageEditWorkflowId),
  workflowPath(config.workflowOutputDir, installSettings.imageAnimaWorkflowId),
  workflowPath(config.workflowOutputDir, installSettings.imageMinimaxWorkflowId),
  progressTracker,
);
const timelineExport = new TimelineExportService(
  comfy,
  config.dataDir,
  installSettings.ffmpegPath,
);
const studioJobs = new StudioJobService(
  comfy,
  workflowStore,
  runtimeSettings,
  progressTracker,
  jobRepository,
  samRuntime,
  llmProvider,
);
const audioStudio = new AudioStudioService(
  comfy,
  audioJobRepository,
  runtimeSettings,
  llmProvider,
  progressTracker,
  externalMedia,
  installSettings.comfyOutputDir,
  config.dataDir,
  installSettings.ffmpegPath,
);
const recoveredAudio = await audioStudio.recover();
const chatRepository = new ChatRepository(jobRepository.databasePath);
const chat = new ChatService(
  comfy,
  chatRepository,
  runtimeSettings,
  llmProvider,
  studioJobs,
  imageStudio,
  audioStudio,
);
const recoveredCandidates = await studioJobs.recover();
const postprocess = new PostprocessService(
  comfy,
  progressTracker,
  jobRepository,
  variantRepository,
  installSettings.comfyOutputDir,
);
const recoveredVariants = await postprocess.recover();
const recoveredImages = await imageStudio.recover();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function executionErrorStatus(error: unknown, fallback = 400) {
  return isComfyBusyError(error) ? 409 : fallback;
}


type ManagedComfyFile = { filename: string; subfolder: string; type: string };

function externalMediaFile(value: string): ManagedComfyFile | null {
  const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(value.trim());
  const normalized = (match?.[1] ?? value).replace(/\\/g, "/");
  const filename = path.posix.basename(normalized);
  const subfolder = path.posix.dirname(normalized);
  if (!filename || filename === "." || filename === "..") return null;
  return {
    filename,
    subfolder: subfolder === "." ? "" : subfolder,
    type: match?.[2] ?? "input",
  };
}

async function removeComfyManagedFiles(files: ManagedComfyFile[]) {
  const outputRoot = path.resolve(installSettings.comfyOutputDir);
  const comfyRoot = path.dirname(outputRoot);
  const roots = {
    input: path.resolve(comfyRoot, "input"),
    output: outputRoot,
    temp: path.resolve(comfyRoot, "temp"),
  } as const;
  const warnings: string[] = [];
  const unique = new Set<string>();
  let removedFiles = 0;
  for (const file of files) {
    if (file.type !== "input" && file.type !== "output" && file.type !== "temp") {
      warnings.push(`Tipo file ignorato: ${file.filename}`);
      continue;
    }
    const root = roots[file.type];
    const target = path.resolve(root, file.subfolder, file.filename);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative) || unique.has(target)) {
      if (!unique.has(target)) warnings.push(`Percorso ignorato: ${file.filename}`);
      continue;
    }
    unique.add(target);
    try {
      await unlink(target);
      removedFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`File non rimosso: ${file.filename}`);
      }
    }
  }
  return { removedFiles, warnings };
}

async function removeComfyOutputFiles(files: ManagedComfyFile[]) {
  return removeComfyManagedFiles(files.filter((file) => file.type === "output"));
}

async function removeProjectExports(projectId: string) {
  const root = path.resolve(config.dataDir, "exports");
  const target = path.resolve(root, projectId);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { removed: false, warning: "Cartella export non rimossa: percorso non valido" };
  }
  try {
    await rm(target, { recursive: true, force: true });
    return { removed: true, warning: null };
  } catch {
    return { removed: false, warning: "Cartella export non rimossa" };
  }
}

async function deleteChatMedia(conversationId: string) {
  const references = chat.mediaJobs(conversationId);
  const videoJobs: Array<NonNullable<Awaited<ReturnType<typeof studioJobs.get>>>> = [];
  const imageJobs: Array<NonNullable<Awaited<ReturnType<typeof imageStudio.get>>>> = [];
  const audioJobs: Array<NonNullable<Awaited<ReturnType<typeof audioStudio.get>>>> = [];

  for (const reference of references) {
    if (reference.kind === "video") {
      const job = await studioJobs.get(reference.jobId);
      if (!job) continue;
      if (job.candidates.some((candidate) => !["ready", "failed"].includes(candidate.status))) {
        throw new Error("Attendi o interrompi i video della Chat prima di eliminarne anche i media");
      }
      const variants = await postprocess.listForJob(job.id);
      if (variants.some((variant) => !["ready", "failed"].includes(variant.status))) {
        throw new Error("Attendi la fine di Face/Upscale prima di eliminare i media della Chat");
      }
      videoJobs.push(job);
      continue;
    }
    if (reference.kind === "audio") {
      const job = await audioStudio.get(reference.jobId);
      if (!job) continue;
      if (["prepared", "queued", "loading", "running", "finalizing"].includes(job.status)) {
        throw new Error("Attendi o interrompi gli audio della Chat prima di eliminarne anche i media");
      }
      audioJobs.push(job);
      continue;
    }
    const job = await imageStudio.get(reference.jobId);
    if (!job) continue;
    if (job.candidates.some((candidate) => !["ready", "failed", "cancelled"].includes(candidate.status))) {
      throw new Error("Attendi o interrompi le immagini della Chat prima di eliminarne anche i media");
    }
    imageJobs.push(job);
  }

  const files: Array<{ filename: string; subfolder: string; type: string }> = [];
  let removedClips = 0;
  for (const job of videoJobs) {
    for (const candidate of [...job.candidates].sort((left, right) => right.index - left.index)) {
      const deleted = jobRepository.deleteCandidate(job.id, candidate.index);
      removedClips += deleted.removedClips;
      files.push(...deleted.files);
    }
  }
  for (const job of imageJobs) {
    for (const candidate of [...job.candidates].sort((left, right) => right.index - left.index)) {
      const deleted = imageStudio.deleteCandidate(job.id, candidate.index);
      files.push(...deleted.files);
    }
  }
  for (const job of audioJobs) {
    const deleted = await audioStudio.delete(job.id);
    if (deleted.deleted.output) files.push({
      filename: deleted.deleted.output.filename,
      subfolder: deleted.deleted.output.subfolder,
      type: deleted.deleted.output.type,
    });
    if (deleted.externalMediaId) {
      try { externalMedia.delete(deleted.externalMediaId); } catch { /* already removed */ }
    }
  }
  const storage = await removeComfyOutputFiles(files);
  return {
    removedJobs: videoJobs.length + imageJobs.length + audioJobs.length,
    removedClips,
    ...storage,
  };
}

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || config.webOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin non autorizzata"), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
});

await app.register(websocket);

app.addContentTypeParser(
  /^multipart\/form-data/i,
  { parseAs: "buffer", bodyLimit: 512 * 1024 * 1024 },
  (_request, body, done) => done(null, body),
);

function setAdminSession(reply: FastifyReply, token: string) {
  reply.header("set-cookie", adminAuth.sessionCookie(token));
}

app.get("/api/setup/status", async (request) => ({
  ok: true,
  setupRequired: !adminAuth.isConfigured(),
  authenticated: adminAuth.isAuthenticated(request.headers.cookie),
  defaults: installSettings,
  workflowCatalog: WORKFLOW_CATALOG,
}));

app.post<{ Body: { password?: unknown; settings?: unknown } }>(
  "/api/setup",
  async (request, reply) => {
    try {
      if (adminAuth.isConfigured()) {
        return reply.status(409).send({ ok: false, error: "H3 Studio è già configurato" });
      }
      const saved = await installSettingsStore.update(request.body?.settings);
      adminAuth.createPassword(String(request.body?.password ?? ""));
      installSettings = saved;
      setAdminSession(reply, adminAuth.createSession());
      return {
        ok: true,
        setupRequired: false,
        restartRequired: true,
        message: "Configurazione salvata. Riavvia H3 Studio per applicare ComfyUI e workflow.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Configurazione iniziale non valida";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{ Body: { password?: unknown } }>("/api/auth/login", async (request, reply) => {
  if (!adminAuth.isConfigured()) {
    return reply.status(428).send({ ok: false, error: "Completa prima la configurazione iniziale" });
  }
  if (!adminAuth.verifyPassword(String(request.body?.password ?? ""))) {
    return reply.status(401).send({ ok: false, error: "Password Admin errata" });
  }
  setAdminSession(reply, adminAuth.createSession());
  return { ok: true };
});

app.post("/api/auth/logout", async (request, reply) => {
  adminAuth.revoke(request.headers.cookie);
  reply.header("set-cookie", adminAuth.clearCookie());
  return { ok: true };
});

app.get("/api/auth/session", async (request) => ({
  ok: true,
  setupRequired: !adminAuth.isConfigured(),
  authenticated: adminAuth.isAuthenticated(request.headers.cookie),
}));

app.addHook("onRequest", async (request, reply) => {
  if (
    request.url.startsWith("/api/admin/") &&
    !adminAuth.isAuthenticated(request.headers.cookie)
  ) {
    return reply.status(401).send({ ok: false, error: "Accesso Admin richiesto" });
  }
});

app.get("/api/health", async () => {
  const [comfyui, workflow, engineSettings, imageSummary, audioSummary] = await Promise.all([
    comfy.health(),
    workflowStore.status(),
    runtimeSettings.get(),
    imageStudio.summary(),
    audioStudio.status(),
  ]);

  return {
    ok: comfyui.connected,
    bridge: {
      status: "online" as const,
      version: "0.1.0",
      postprocessContract: 2,
      upscaleTargets: [1, 2] as const,
      processingSeconds: true,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    comfyui,
    workflow,
    engineSettings,
    fastEngine: engineSettings.fast,
    standardEngine: engineSettings.h3,
    imageStudio: imageSummary,
    audioStudio: audioSummary,
    progressEvents: {
      connected: progressTracker.connected,
    },
    storage: {
      ...jobRepository.stats(),
      recoveredCandidates,
      variants: variantRepository.count(),
      recoveredVariants,
      recoveredImages,
      recoveredAudio,
      audioJobs: audioJobRepository.count(),
      externalMedia: externalMedia.count(),
    },
    checkedAt: new Date().toISOString(),
  };
});

app.get("/api/workflow/status", async () => workflowStore.status());

app.get("/api/external-media", async () => ({
  ok: true,
  assets: externalMedia.list(),
}));

app.post<{ Params: { mediaId: string }; Body: { name?: string } }>(
  "/api/external-media/:mediaId/rename",
  async (request, reply) => {
    try {
      return { ok: true, asset: externalMedia.rename(request.params.mediaId, request.body?.name) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rinomina media esterno fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{ Params: { mediaId: string } }>(
  "/api/external-media/:mediaId/delete",
  async (request, reply) => {
    try {
      externalMedia.delete(request.params.mediaId);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rimozione media esterno fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{ Querystring: { projectId?: string } }>("/api/assets/upload", async (request, reply) => {
  try {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return reply.status(400).send({ ok: false, error: "Upload multipart richiesto" });
    }
    const body = request.body;
    if (!(body instanceof Buffer) || body.byteLength === 0) {
      return reply.status(400).send({ ok: false, error: "File mancante" });
    }
    const projectId = request.query.projectId?.trim() || null;
    if (projectId && !projectRepository.get(projectId)) {
      return reply.status(404).send({ ok: false, error: "Progetto non trovato" });
    }
    const uploaded = await comfy.uploadMedia(body, contentType);
    const external = externalMedia.upsert(uploaded, projectId);
    return reply.status(201).send({
      ok: true,
      asset: {
        ...uploaded,
        kind: external.kind,
        file: external.file,
        name: external.name,
        original: external.originalName,
        size: external.size,
        duration: external.duration,
        has_audio: external.hasAudio,
        width: external.width,
        height: external.height,
        mediaPath: external.mediaPath,
        externalMediaId: external.id,
        origin: external.origin,
      },
      external,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post("/api/workflow/capture", async (_request, reply) => {
  try {
    const result = await workflowStore.captureLatest(comfy);
    if (!result.captured) reply.status(409);
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Errore sconosciuto di cattura";
    app.log.error(error, "Cattura workflow Studio Backend fallita");
    return reply.status(500).send({
      captured: false,
      error: message,
    });
  }
});

app.post("/api/jobs/dry-run", async (request, reply) => {
  try {
    const { prepared } = await studioJobs.prepare(request.body);
    return publicDryRun(prepared);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Richiesta non valida";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post("/api/jobs", async (request, reply) => {
  try {
    const job = await comfyAdmission.run("generazione video", async () => {
      await comfy.chatUnload().catch(() => undefined);
      return studioJobs.submit(request.body);
    });
    return reply.status(202).send({ ok: true, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invio job fallito";
    app.log.error(error, "Invio job H3 Studio fallito");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { jobId: string };
  Body: { candidateIndex?: number; prompt?: unknown };
}>("/api/jobs/:jobId/regenerate", async (request, reply) => {
  try {
    const rawIndex = request.body?.candidateIndex;
    const candidateIndex = rawIndex === undefined ? undefined : Number(rawIndex);
    if (
      candidateIndex !== undefined &&
      (!Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4)
    ) {
      return reply.status(400).send({ ok: false, error: "Candidato video non valido" });
    }
    const job = await comfyAdmission.run("rigenerazione video", async () => {
      await comfy.chatUnload().catch(() => undefined);
      return studioJobs.regenerate(
        request.params.jobId,
        candidateIndex,
        request.body?.prompt,
      );
    });
    return reply.status(202).send({
      ok: true,
      job: { ...job, variants: [] },
      scope: candidateIndex === undefined ? "batch" : "candidate",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rigenerazione video fallita";
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
  const job = await studioJobs.get(request.params.jobId);
  if (!job) return reply.status(404).send({ ok: false, error: "Job non trovato" });
  return {
    ok: true,
    job: { ...job, variants: await postprocess.listForJob(job.id) },
  };
});

app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/cancel", async (request, reply) => {
  try {
    await postprocess.cancelForJob(request.params.jobId);
    const job = await studioJobs.cancel(request.params.jobId);
    if (!job) return reply.status(404).send({ ok: false, error: "Job non trovato" });
    return {
      ok: true,
      job: { ...job, variants: await postprocess.listForJob(job.id) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Interruzione fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get<{ Querystring: { limit?: string; projectId?: string } }>("/api/jobs", async (request) => {
  const limit = Number.parseInt(request.query.limit ?? "20", 10);
  const jobs = await studioJobs.list(limit, request.query.projectId?.trim() || null);
  return {
    ok: true,
    jobs: await Promise.all(jobs.map(async (job) => ({
      ...job,
      variants: await postprocess.listForJob(job.id),
    }))),
  };
});

app.get("/api/prompt-planner/capabilities", async (_request, reply) => {
  try {
    return { ok: true, planner: await promptPlanner.status() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt Compiler non disponibile";
    return reply.status(503).send({ ok: false, error: message });
  }
});

app.get("/api/lora-options", async (_request, reply) => {
  try {
    const [settings, loras] = await Promise.all([
      runtimeSettings.get(),
      comfy.models("loras"),
    ]);
    const [catalog, catalogStatus] = await Promise.all([
      loraCatalog.forAvailable(loras),
      loraCatalog.status(),
    ]);
    return {
      ok: true,
      available: [...new Set(loras)].sort(),
      catalog,
      catalogStatus,
      global: {
        videoH3: settings.h3.loras,
        imageH3: settings.h3.loras,
        krea: settings.krea.loras,
        fluxEdit: [],
        qwenEdit: [],
        anima: settings.anima.loras,
      },
      maxPerJob: 5,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Elenco LoRA non disponibile";
    return reply.status(503).send({ ok: false, error: message });
  }
});

app.get("/api/admin/lora-catalog", async (request, reply) => {
  if (!adminAuth.isAuthenticated(request.headers.cookie)) {
    return reply.status(401).send({ ok: false, error: "Accesso Admin richiesto" });
  }
  return { ok: true, catalog: await loraCatalog.status() };
});

app.post("/api/admin/lora-catalog/refresh", async (request, reply) => {
  if (!adminAuth.isAuthenticated(request.headers.cookie)) {
    return reply.status(401).send({ ok: false, error: "Accesso Admin richiesto" });
  }
  try {
    const result = await loraCatalog.scan((message) => app.log.info(message));
    return {
      ok: true,
      catalog: await loraCatalog.status(),
      scanned: result.files.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Catalogo LoRA non aggiornato";
    app.log.error(error, "Aggiornamento catalogo LoRA fallito");
    return reply.status(502).send({ ok: false, error: message });
  }
});

app.post("/api/prompt-planner", async (request, reply) => {
  try {
    const plan = await comfyAdmission.run(
      "preparazione prompt LLM",
      () => promptPlanner.plan(request.body),
    );
    return reply.status(200).send({ ok: true, plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt Compiler non disponibile";
    app.log.error(error, "Compilazione prompt LLM fallita");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.get("/api/image-jobs/capabilities", async (_request, reply) => {
  try {
    return { ok: true, imageStudio: await imageStudio.status() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Motori immagine non disponibili";
    return reply.status(503).send({ ok: false, error: message });
  }
});

app.post("/api/image-jobs/dry-run", async (request, reply) => {
  try {
    return await imageStudio.dryRun(request.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Richiesta immagine non valida";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post("/api/image-jobs", async (request, reply) => {
  try {
    const job = await comfyAdmission.run("generazione immagine", async () => {
      await comfy.chatUnload().catch(() => undefined);
      return imageStudio.submit(request.body);
    });
    return reply.status(202).send({ ok: true, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invio immagine fallito";
    app.log.error(error, "Invio job immagine H3 Studio fallito");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.get("/api/audio-jobs/capabilities", async (_request, reply) => {
  try {
    return { ok: true, audioStudio: await audioStudio.status() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Motori audio non disponibili";
    return reply.status(503).send({ ok: false, error: message });
  }
});

app.post("/api/audio-jobs", async (request, reply) => {
  try {
    const job = await comfyAdmission.run(
      "generazione audio",
      () => audioStudio.submit(request.body),
    );
    return reply.status(202).send({ ok: true, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invio audio fallito";
    app.log.error(error, "Invio job audio H3 Studio fallito");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.post("/api/audio-jobs/transcribe-reference", async (request, reply) => {
  try {
    const transcription = await comfyAdmission.run(
      "trascrizione audio",
      () => audioStudio.transcribeReference(request.body),
    );
    return reply.status(200).send({ ok: true, transcription });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trascrizione reference non disponibile";
    app.log.error(error, "Trascrizione reference TTS fallita");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.post("/api/audio-jobs/music-plan", async (request, reply) => {
  try {
    const plan = await comfyAdmission.run(
      "pianificazione musica LLM",
      () => audioStudio.planMusic(request.body),
    );
    return reply.status(200).send({ ok: true, plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Music Planner non disponibile";
    app.log.error(error, "Pianificazione musicale LLM fallita");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.post("/api/audio-jobs/speech-track-plan", async (request, reply) => {
  try {
    const plan = await comfyAdmission.run(
      "pianificazione parlato LLM",
      () => audioStudio.planSpeechTrack(request.body),
    );
    return reply.status(200).send({
      ok: true,
      plan,
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Planner Parlato → brano non disponibile";
    app.log.error(error, "Pianificazione Parlato → brano fallita");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.get<{ Querystring: { limit?: string; projectId?: string } }>(
  "/api/audio-jobs",
  async (request) => ({
    ok: true,
    jobs: await audioStudio.list(
      Number.parseInt(request.query.limit ?? "50", 10),
      request.query.projectId?.trim() || null,
    ),
  }),
);

app.get<{ Params: { jobId: string } }>("/api/audio-jobs/:jobId", async (request, reply) => {
  const job = await audioStudio.get(request.params.jobId);
  if (!job) return reply.status(404).send({ ok: false, error: "Job audio non trovato" });
  return { ok: true, job };
});

app.post<{ Params: { jobId: string } }>("/api/audio-jobs/:jobId/cancel", async (request, reply) => {
  try {
    const job = await audioStudio.cancel(request.params.jobId);
    if (!job) return reply.status(404).send({ ok: false, error: "Job audio non trovato" });
    return { ok: true, job };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Interruzione audio fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.delete<{ Params: { jobId: string } }>("/api/audio-jobs/:jobId", async (request, reply) => {
  try {
    const result = await audioStudio.delete(request.params.jobId);
    const storage = result.deleted.output
      ? await removeComfyOutputFiles([{
          filename: result.deleted.output.filename,
          subfolder: result.deleted.output.subfolder,
          type: result.deleted.output.type,
        }])
      : { removedFiles: 0, warnings: [] as string[] };
    if (result.externalMediaId) {
      try { externalMedia.delete(result.externalMediaId); } catch { /* already removed */ }
    }
    return { ok: true, ...storage };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Eliminazione audio fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get("/api/chat/status", async () => ({ ok: true, chat: await chat.status() }));

app.get<{ Querystring: { projectId?: string } }>(
  "/api/chat/conversations",
  async (request) => ({
    ok: true,
    conversations: chat.conversations(request.query.projectId?.trim() || null),
  }),
);

app.post<{
  Params: { projectId: string };
  Body: { title?: unknown };
}>("/api/chat/:projectId/conversations", async (request, reply) => {
  try {
    return {
      ok: true,
      conversation: chat.createConversation(request.params.projectId, request.body?.title),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversazione Chat non creata";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get<{ Params: { conversationId: string } }>(
  "/api/chat/conversations/:conversationId",
  async (request, reply) => {
    try {
      return { ok: true, ...chat.conversation(request.params.conversationId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Conversazione Chat non disponibile";
      return reply.status(404).send({ ok: false, error: message });
    }
  },
);

app.patch<{
  Params: { conversationId: string };
  Body: { title?: unknown };
}>("/api/chat/conversations/:conversationId", async (request, reply) => {
  try {
    return {
      ok: true,
      conversation: chat.renameConversation(request.params.conversationId, request.body?.title),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversazione Chat non rinominata";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.put<{
  Params: { conversationId: string };
  Body: { prompt?: unknown; enabled?: unknown };
}>("/api/chat/conversations/:conversationId/system-prompt", async (request, reply) => {
  try {
    return {
      ok: true,
      conversation: chat.updateSystemPrompt(
        request.params.conversationId,
        request.body?.prompt,
        request.body?.enabled,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "System prompt non salvato";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { conversationId: string };
  Body: { content?: unknown; attachments?: unknown; route?: unknown };
}>("/api/chat/conversations/:conversationId/messages", async (request, reply) => {
  try {
    const conversation = chat.conversation(request.params.conversationId).conversation;
    return {
      ok: true,
      ...(await comfyAdmission.run(
        "messaggio Chat",
        () => chat.send(conversation.projectId, request.body ?? {}, conversation.id),
      )),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Messaggio Chat fallito";
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { conversationId: string };
  Body: { messageId?: unknown; prompt?: unknown; lyrics?: unknown };
}>("/api/chat/conversations/:conversationId/regenerate", async (request, reply) => {
  try {
    const messageId = typeof request.body?.messageId === "string"
      ? request.body.messageId.trim()
      : "";
    if (!messageId) {
      return reply.status(400).send({ ok: false, error: "Messaggio Chat mancante" });
    }
    return {
      ok: true,
      ...(await comfyAdmission.run(
        "rigenerazione dalla Chat",
        () => chat.regenerateConversationAction(
          request.params.conversationId,
          messageId,
          request.body?.prompt,
          request.body?.lyrics,
        ),
      )),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rigenerazione Chat fallita";
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.delete<{
  Params: { conversationId: string };
}>("/api/chat/conversations/:conversationId/messages", async (request, reply) => {
  try {
    const conversation = chat.conversation(request.params.conversationId).conversation;
    return {
      ok: true,
      ...chat.clear(conversation.projectId, conversation.id),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Messaggi Chat non cancellati";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.delete<{
  Params: { conversationId: string };
  Body: { preserveMedia?: unknown };
}>("/api/chat/conversations/:conversationId", async (request, reply) => {
  try {
    const preserveMedia = request.body?.preserveMedia !== false;
    const media = preserveMedia
      ? { removedJobs: 0, removedClips: 0, removedFiles: 0, warnings: [] as string[] }
      : await deleteChatMedia(request.params.conversationId);
    const conversation = chat.deleteConversation(request.params.conversationId);
    return { ok: true, conversation, preserveMedia, ...media };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversazione Chat non eliminata";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get<{ Params: { projectId: string } }>(
  "/api/chat/:projectId",
  async (request, reply) => {
    try {
      return {
        ok: true,
        messages: chat.list(request.params.projectId),
        memory: chat.memory(request.params.projectId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chat non disponibile";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Params: { projectId: string };
  Body: { content?: unknown; attachments?: unknown; route?: unknown };
}>("/api/chat/:projectId/messages", async (request, reply) => {
  try {
    return {
      ok: true,
      ...(await comfyAdmission.run(
        "messaggio Chat",
        () => chat.send(request.params.projectId, request.body ?? {}),
      )),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Messaggio Chat fallito";
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.delete<{ Params: { projectId: string } }>(
  "/api/chat/:projectId",
  async (request, reply) => {
    try {
      return { ok: true, ...chat.clear(request.params.projectId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chat non cancellata";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Params: { jobId: string };
  Body: { candidateIndex?: number; prompt?: unknown };
}>("/api/image-jobs/:jobId/regenerate", async (request, reply) => {
  try {
    const rawIndex = request.body?.candidateIndex;
    const candidateIndex = rawIndex === undefined ? undefined : Number(rawIndex);
    if (
      candidateIndex !== undefined &&
      (!Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4)
    ) {
      return reply.status(400).send({ ok: false, error: "Candidato immagine non valido" });
    }
    const job = await comfyAdmission.run("rigenerazione immagine", async () => {
      await comfy.chatUnload().catch(() => undefined);
      return imageStudio.regenerate(
        request.params.jobId,
        candidateIndex,
        request.body?.prompt,
      );
    });
    return reply.status(202).send({
      ok: true,
      job,
      scope: candidateIndex === undefined ? "batch" : "candidate",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rigenerazione immagine fallita";
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.get<{ Querystring: { limit?: string; projectId?: string } }>(
  "/api/image-jobs",
  async (request) => ({
    ok: true,
    jobs: await imageStudio.list(
      Number.parseInt(request.query.limit ?? "20", 10),
      request.query.projectId?.trim() || null,
    ),
  }),
);

app.get<{ Params: { jobId: string } }>("/api/image-jobs/:jobId", async (request, reply) => {
  const job = await imageStudio.get(request.params.jobId);
  if (!job) return reply.status(404).send({ ok: false, error: "Job immagine non trovato" });
  return { ok: true, job };
});

app.post<{ Params: { jobId: string } }>(
  "/api/image-jobs/:jobId/cancel",
  async (request, reply) => {
    try {
      const job = await imageStudio.cancel(request.params.jobId);
      if (!job) return reply.status(404).send({ ok: false, error: "Job immagine non trovato" });
      return { ok: true, job };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Interruzione immagine fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Params: { jobId: string };
  Body: { candidateIndex?: number };
}>("/api/image-jobs/:jobId/select", async (request, reply) => {
  try {
    return {
      ok: true,
      job: imageStudio.select(request.params.jobId, Number(request.body?.candidateIndex)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Selezione immagine fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{ Params: { jobId: string; candidateIndex: string }; Body: { name?: string } }>(
  "/api/image-jobs/:jobId/candidates/:candidateIndex/rename",
  async (request, reply) => {
    try {
      const candidateIndex = Number(request.params.candidateIndex);
      if (!Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4) {
        return reply.status(400).send({ ok: false, error: "Candidato immagine non valido" });
      }
      return { ok: true, job: imageJobRepository.renameCandidate(request.params.jobId, candidateIndex, request.body?.name) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rinomina immagine fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{ Params: { jobId: string; candidateIndex: string } }>(
  "/api/image-jobs/:jobId/candidates/:candidateIndex/delete",
  async (request, reply) => {
    try {
      const candidateIndex = Number(request.params.candidateIndex);
      if (!Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4) {
        return reply.status(400).send({ ok: false, error: "Candidato immagine non valido" });
      }
      const deleted = imageStudio.deleteCandidate(request.params.jobId, candidateIndex);
      const storage = await removeComfyOutputFiles(deleted.files);
      return {
        ok: true,
        jobDeleted: deleted.jobDeleted,
        job: deleted.jobDeleted
          ? null
          : await imageStudio.get(request.params.jobId),
        removedFiles: storage.removedFiles,
        warnings: storage.warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Eliminazione immagine fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.put<{
  Params: { jobId: string; candidateIndex: string; projectId: string };
  Body: { tag?: ImageProjectTag };
}>(
  "/api/image-jobs/:jobId/candidates/:candidateIndex/projects/:projectId",
  async (request, reply) => {
    try {
      return {
        ok: true,
        job: imageStudio.linkProject(
          request.params.jobId,
          Number(request.params.candidateIndex),
          request.params.projectId,
          request.body?.tag ?? "untagged",
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Condivisione immagine fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.delete<{
  Params: { jobId: string; candidateIndex: string; projectId: string };
}>(
  "/api/image-jobs/:jobId/candidates/:candidateIndex/projects/:projectId",
  async (request, reply) => {
    try {
      return {
        ok: true,
        job: imageStudio.unlinkProject(
          request.params.jobId,
          Number(request.params.candidateIndex),
          request.params.projectId,
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rimozione condivisione fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Params: { jobId: string; candidateIndex: string };
  Body: {
    kind?: string;
    sourceVariantId?: string | null;
    targetMegapixels?: number;
  };
}>("/api/jobs/:jobId/candidates/:candidateIndex/variants", async (request, reply) => {
  try {
    const variant = await comfyAdmission.run("post-process video", async () => {
      await comfy.chatUnload().catch(() => undefined);
      return postprocess.create(
        request.params.jobId,
        Number(request.params.candidateIndex),
        request.body?.kind,
        request.body?.sourceVariantId,
        request.body?.targetMegapixels,
      );
    });
    return reply.status(202).send({ ok: true, variant });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Post-process non avviato";
    app.log.error(error, "Avvio variante candidato fallito");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.get<{ Params: { jobId: string; candidateIndex: string } }>(
  "/api/jobs/:jobId/candidates/:candidateIndex/variants",
  async (request) => ({
    ok: true,
    variants: (await postprocess.listForJob(request.params.jobId)).filter(
      (item) => item.sourceCandidateIndex === Number(request.params.candidateIndex),
    ),
  }),
);

app.post<{ Params: { jobId: string; candidateIndex: string }; Body: { name?: string } }>(
  "/api/jobs/:jobId/candidates/:candidateIndex/rename",
  async (request, reply) => {
    try {
      const candidateIndex = Number(request.params.candidateIndex);
      if (!Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4) {
        return reply.status(400).send({ ok: false, error: "Candidato video non valido" });
      }
      return { ok: true, job: jobRepository.renameCandidate(request.params.jobId, candidateIndex, request.body?.name) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rinomina video fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{ Params: { jobId: string; candidateIndex: string } }>(
  "/api/jobs/:jobId/candidates/:candidateIndex/delete",
  async (request, reply) => {
    try {
      const candidateIndex = Number(request.params.candidateIndex);
      if (!Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4) {
        return reply.status(400).send({ ok: false, error: "Candidato non valido" });
      }
      const deleted = jobRepository.deleteCandidate(request.params.jobId, candidateIndex);
      const storage = await removeComfyOutputFiles(deleted.files);
      return {
        ok: true,
        jobDeleted: deleted.jobDeleted,
        removedClips: deleted.removedClips,
        removedFiles: storage.removedFiles,
        warnings: storage.warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Eliminazione video fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Params: { jobId: string };
  Body: { projectId?: string | null };
}>("/api/jobs/:jobId/project", async (request, reply) => {
  try {
    const projectId = request.body?.projectId?.trim() || null;
    if (projectId && !projectRepository.get(projectId)) {
      return reply.status(404).send({ ok: false, error: "Progetto non trovato" });
    }
    return {
      ok: true,
      job: jobRepository.assignProject(request.params.jobId, projectId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Associazione fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get("/api/projects", async () => ({
  ok: true,
  projects: projectRepository.list(),
}));

app.get<{ Querystring: { kind?: "character" | "object" } }>(
  "/api/library",
  async (request, reply) => {
    try {
      await kreaAssets.sync();
      return { ok: true, assets: creativeLibrary.list(request.query.kind) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Libreria non disponibile";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Body: {
    kind?: "character" | "object";
    name?: string;
    description?: string;
    generationPrompt?: string;
  };
}>("/api/library", async (request, reply) => {
  try {
    return reply.status(201).send({
      ok: true,
      asset: creativeLibrary.create(request.body ?? {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Creazione asset fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get<{ Params: { assetId: string } }>(
  "/api/library/:assetId",
  async (request, reply) => {
    await kreaAssets.sync().catch(() => undefined);
    const asset = creativeLibrary.get(request.params.assetId);
    if (!asset) return reply.status(404).send({ ok: false, error: "Asset non trovato" });
    return { ok: true, asset };
  },
);

app.post<{
  Params: { assetId: string };
  Body: { name?: string; description?: string; generationPrompt?: string };
}>("/api/library/:assetId", async (request, reply) => {
  try {
    return {
      ok: true,
      asset: creativeLibrary.update(request.params.assetId, request.body ?? {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aggiornamento fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{ Params: { assetId: string } }>(
  "/api/library/:assetId/delete",
  async (request, reply) => {
    try {
      creativeLibrary.delete(request.params.assetId);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Eliminazione fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Params: { assetId: string };
  Body: {
    file?: string;
    name?: string;
    label?: string;
    role?: string;
    width?: number | null;
    height?: number | null;
  };
}>("/api/library/:assetId/references", async (request, reply) => {
  try {
    return reply.status(201).send({
      ok: true,
      asset: creativeLibrary.addReference(request.params.assetId, {
        ...request.body,
        source: "upload",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reference non aggiunta";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{ Params: { referenceId: string } }>(
  "/api/library-references/:referenceId/delete",
  async (request, reply) => {
    try {
      return {
        ok: true,
        asset: creativeLibrary.removeReference(request.params.referenceId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rimozione fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.get("/api/krea/status", async (_request, reply) => {
  try {
    return { ok: true, krea: await kreaAssets.status() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Krea 2 non disponibile";
    return reply.status(503).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { assetId: string };
  Body: { prompt?: string; seed?: number };
}>("/api/library/:assetId/krea/dry-run", async (request, reply) => {
  try {
    return kreaAssets.dryRun(request.params.assetId, request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dry-run Krea 2 fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { assetId: string };
  Body: { prompt?: string; seed?: number };
}>("/api/library/:assetId/krea/generate", async (request, reply) => {
  try {
    return reply.status(202).send({
      ok: true,
      asset: await comfyAdmission.run(
        "generazione Krea",
        () => kreaAssets.submit(request.params.assetId, request.body ?? {}),
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generazione Krea 2 fallita";
    app.log.error(error, "Invio character/object sheet Krea 2 fallito");
    return reply.status(executionErrorStatus(error)).send({ ok: false, error: message });
  }
});

app.post<{ Body: { name?: string } }>("/api/projects", async (request, reply) => {
  try {
    return reply.status(201).send({
      ok: true,
      project: projectRepository.create(request.body?.name),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Creazione progetto fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get<{ Params: { projectId: string } }>(
  "/api/projects/:projectId",
  async (request, reply) => {
    const project = projectRepository.get(request.params.projectId);
    if (!project) {
      return reply.status(404).send({ ok: false, error: "Progetto non trovato" });
    }
    return { ok: true, project };
  },
);

app.delete<{ Params: { projectId: string } }>(
  "/api/projects/:projectId",
  async (request, reply) => {
    try {
      const plan = projectRepository.deletionPlan(request.params.projectId);
      const busyCount = plan.busy.video + plan.busy.image + plan.busy.audio;
      if (busyCount > 0) {
        return reply.status(409).send({
          ok: false,
          error: `Interrompi prima le generazioni attive del progetto: ${plan.busy.video} video, ${plan.busy.image} immagini, ${plan.busy.audio} audio`,
        });
      }

      const files: ManagedComfyFile[] = [];
      let removedClips = 0;
      for (const candidate of plan.videoCandidates) {
        const deleted = jobRepository.deleteCandidate(candidate.job_id, candidate.candidate_index);
        removedClips += deleted.removedClips;
        files.push(...deleted.files);
      }
      for (const candidate of plan.imageCandidates) {
        const deleted = imageStudio.deleteCandidate(candidate.job_id, candidate.candidate_index);
        files.push(...deleted.files);
      }

      const externalIds = new Set(plan.externalMedia.map((media) => media.id));
      for (const jobId of plan.audioJobs) {
        const deleted = await audioStudio.delete(jobId);
        const preserveOutput = Boolean(
          deleted.externalMediaId && !externalIds.has(deleted.externalMediaId),
        );
        if (deleted.deleted.output && !preserveOutput) {
          files.push({
            filename: deleted.deleted.output.filename,
            subfolder: deleted.deleted.output.subfolder,
            type: deleted.deleted.output.type,
          });
        }
      }
      for (const media of plan.externalMedia) {
        const descriptor = externalMediaFile(media.file);
        if (descriptor) files.push(descriptor);
        try { externalMedia.delete(media.id); } catch { /* eliminato insieme al job audio */ }
      }

      const deletion = projectRepository.delete(request.params.projectId);
      const [storage, exports] = await Promise.all([
        removeComfyManagedFiles(files),
        removeProjectExports(request.params.projectId),
      ]);
      const warnings = [
        ...storage.warnings,
        ...(exports.warning ? [exports.warning] : []),
      ];
      return {
        ok: true,
        deletion: {
          ...deletion,
          removedVideoJobs: new Set(plan.videoCandidates.map((item) => item.job_id)).size,
          removedVideoCandidates: plan.videoCandidates.length,
          removedImageCandidates: plan.imageCandidates.length,
          removedAudioJobs: plan.audioJobs.length,
          removedExternalMedia: plan.externalMedia.length,
          removedClips,
          removedFiles: storage.removedFiles,
          removedExports: exports.removed,
          preserved: plan.preserved,
          warnings,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Eliminazione progetto fallita";
      return reply.status(message === "Progetto non trovato" ? 404 : 400).send({ ok: false, error: message });
    }
  },
);

app.get<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/timelines",
  async (request, reply) => {
    const project = projectRepository.get(request.params.projectId);
    if (!project) return reply.status(404).send({ ok: false, error: "Progetto non trovato" });
    return { ok: true, project, timelines: projectRepository.listTimelines(request.params.projectId) };
  },
);

app.post<{
  Params: { projectId: string };
  Body: { name?: string };
}>("/api/projects/:projectId/timelines", async (request, reply) => {
  try {
    return reply.status(201).send({
      ok: true,
      timeline: projectRepository.createTimeline(request.params.projectId, request.body?.name),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Creazione montaggio fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get<{ Params: { timelineId: string } }>(
  "/api/timelines/:timelineId",
  async (request, reply) => {
    const timeline = projectRepository.getTimeline(request.params.timelineId);
    if (!timeline) return reply.status(404).send({ ok: false, error: "Montaggio non trovato" });
    return { ok: true, timeline };
  },
);

app.post<{
  Params: { timelineId: string };
  Body: {
    name?: string;
    externalAudioFile?: string | null;
    externalAudioName?: string | null;
    originalAudioGain?: number;
    externalAudioGain?: number;
    externalAudioLoop?: boolean;
  };
}>("/api/timelines/:timelineId", async (request, reply) => {
  try {
    return {
      ok: true,
      timeline: projectRepository.updateTimeline(request.params.timelineId, request.body ?? {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aggiornamento montaggio fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { timelineId: string; position: string };
  Body: {
    file?: string | null; name?: string; sourceDuration?: number | null;
    startTime?: number; trimStart?: number; trimEnd?: number | null; gain?: number;
    muted?: boolean; solo?: boolean; loop?: boolean; fadeIn?: number; fadeOut?: number;
  };
}>("/api/timelines/:timelineId/audio-tracks/:position", async (request, reply) => {
  try {
    return {
      ok: true,
      timeline: projectRepository.upsertAudioTrack(
        request.params.timelineId,
        request.params.position,
        request.body ?? {},
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aggiornamento traccia audio fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.delete<{ Params: { timelineId: string } }>(
  "/api/timelines/:timelineId",
  async (request, reply) => {
    try {
      return {
        ok: true,
        deletion: projectRepository.deleteTimeline(request.params.timelineId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Eliminazione montaggio fallita";
      return reply.status(404).send({ ok: false, error: message });
    }
  },
);
app.post<{
  Params: { timelineId: string };
  Body: { jobId?: string; candidateIndex?: number; label?: string; variantId?: string | null };
}>("/api/timelines/:timelineId/clips", async (request, reply) => {
  try {
    return reply.status(201).send({
      ok: true,
      timeline: projectRepository.addClipToTimeline(
        request.params.timelineId,
        String(request.body?.jobId ?? ""),
        Number(request.body?.candidateIndex),
        request.body?.label,
        request.body?.variantId,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aggiunta clip fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { projectId: string };
  Body: { jobId?: string; candidateIndex?: number; label?: string; variantId?: string | null };
}>("/api/projects/:projectId/clips", async (request, reply) => {
  try {
    const project = projectRepository.addClip(
      request.params.projectId,
      String(request.body?.jobId ?? ""),
      Number(request.body?.candidateIndex),
      request.body?.label,
      request.body?.variantId,
    );
    return reply.status(201).send({ ok: true, project });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aggiunta clip fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { clipId: string };
  Body: { position?: number };
}>("/api/project-clips/:clipId/reorder", async (request, reply) => {
  try {
    const timeline = projectRepository.reorderClip(
      request.params.clipId,
      request.body?.position,
    );
    return {
      ok: true,
      project: timeline,
      timeline,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Riordino clip fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.delete<{ Params: { clipId: string } }>(
  "/api/project-clips/:clipId",
  async (request, reply) => {
    try {
      const timeline = projectRepository.removeClip(request.params.clipId);
      return { ok: true, timeline };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rimozione clip fallita";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{
  Params: { clipId: string };
  Body: {
    trimStart?: number; trimEnd?: number; volume?: number; variantId?: string | null;
    cropX?: number; cropY?: number; cropZoom?: number;
  };
}>("/api/project-clips/:clipId/trim", async (request, reply) => {
  try {
    const timeline = projectRepository.updateClip(request.params.clipId, request.body ?? {});
    return { ok: true, timeline };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aggiornamento clip fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { clipId: string };
  Body: { targetProjectId?: string; targetTimelineId?: string };
}>("/api/project-clips/:clipId/copy", async (request, reply) => {
  try {
    const timeline = projectRepository.copyClip(
      request.params.clipId,
      String(request.body?.targetTimelineId ?? request.body?.targetProjectId ?? ""),
    );
    return reply.status(201).send({
      ok: true,
      project: timeline,
      timeline,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Copia clip fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Params: { clipId: string };
  Body: { targetProjectId?: string; targetTimelineId?: string };
}>("/api/project-clips/:clipId/move", async (request, reply) => {
  try {
    const timeline = projectRepository.moveClip(
      request.params.clipId,
      String(request.body?.targetTimelineId ?? request.body?.targetProjectId ?? ""),
    );
    return {
      ok: true,
      project: timeline,
      timeline,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Spostamento clip fallito";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/export",
  async (request, reply) => {
    try {
      const project = projectRepository.get(request.params.projectId);
      if (!project) {
        return reply.status(404).send({ ok: false, error: "Progetto non trovato" });
      }
      const firstTimeline = project.timelines[0]
        ? projectRepository.getTimeline(project.timelines[0].id)
        : null;
      if (!firstTimeline) {
        return reply.status(400).send({ ok: false, error: "Il progetto non contiene montaggi" });
      }
      const exported = await timelineExport.export(firstTimeline);
      return { ok: true, export: exported };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Export fallito";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.post<{ Params: { timelineId: string } }>(
  "/api/timelines/:timelineId/export",
  async (request, reply) => {
    try {
      const timeline = projectRepository.getTimeline(request.params.timelineId);
      if (!timeline) return reply.status(404).send({ ok: false, error: "Montaggio non trovato" });
      return { ok: true, export: await timelineExport.export(timeline) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Export fallito";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.get<{ Params: { projectId: string; filename: string } }>(
  "/api/exports/:projectId/:filename",
  async (request, reply) => {
    const base = path.resolve(config.dataDir, "exports", request.params.projectId);
    const target = path.resolve(base, path.basename(request.params.filename));
    if (!target.startsWith(base + path.sep)) {
      return reply.status(400).send({ ok: false, error: "Percorso export non valido" });
    }
    let stat;
    try {
      stat = statSync(target);
    } catch {
      return reply.status(404).send({ ok: false, error: "Export non trovato" });
    }
    const range = request.headers.range;
    reply.header("accept-ranges", "bytes");
    reply.header("content-type", "video/mp4");
    reply.header(
      "content-disposition",
      "attachment; filename*=UTF-8''" +
        encodeURIComponent(path.basename(request.params.filename)),
    );
    reply.header("cache-control", "private, max-age=3600");
    if (!range) {
      reply.header("content-length", stat.size);
      return reply.send(createReadStream(target));
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return reply.status(416).send();
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return reply.status(416).send();
    reply.status(206);
    reply.header("content-length", end - start + 1);
    reply.header("content-range", `bytes ${start}-${end}/${stat.size}`);
    return reply.send(createReadStream(target, { start, end }));
  },
);

app.post<{
  Params: { jobId: string };
  Body: { candidateIndex?: number };
}>("/api/jobs/:jobId/select", async (request, reply) => {
  try {
    const job = await studioJobs.selectCandidate(
      request.params.jobId,
      Number(request.body?.candidateIndex),
    );
    return { ok: true, job };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Selezione fallita";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.get<{
  Querystring: {
    filename?: string;
    subfolder?: string;
    type?: "input" | "output" | "temp";
    download?: string;
  };
}>("/api/media", async (request, reply) => {
  const { filename, subfolder = "", type = "output", download } = request.query;
  if (!filename || !["input", "output", "temp"].includes(type)) {
    return reply.status(400).send({ ok: false, error: "Media non valido" });
  }
  const response = await comfy.mediaResponse(
    filename,
    subfolder,
    type,
    request.headers.range,
  );
  reply.status(response.status);
  for (const header of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
  ]) {
    const value = response.headers.get(header);
    if (value) reply.header(header, value);
  }
  if (download === "1") {
    reply.header(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}`,
    );
  }
  if (!response.body) return reply.send();
  return reply.send(
    Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
  );
});

async function engineSettingsPayload() {
  const [settings, models, loras, textEncoders, vaes, latentUpscalers, llmFiles, chatRuntime, workflow, imageAttentionBackends, audioStatus, plannerStatus] = await Promise.all([
    runtimeSettings.get(),
    comfy.models("diffusion_models"),
    comfy.models("loras"),
    comfy.modelFiles("text_encoders"),
    comfy.modelFiles("vae"),
    comfy.modelFiles("latent_upscale_models").catch((): string[] => []),
    comfy.modelFiles("llm").catch((): string[] => []),
    comfy.chatStatus().catch(() => null),
    workflowStore.status(),
    imageStudio.attentionBackends().catch((): string[] => []),
    audioStudio.status().catch(() => null),
    llmProvider.status("planner").catch(() => null),
  ]);
  return {
    ok: true,
    workflow: {
      source: workflow.sourceWorkflow,
      apiPrompt: workflow.apiPromptPath,
      capturedAt: workflow.capturedAt,
      ready: workflow.ready,
    },
    kreaWorkflow: {
      source: workflowPath(config.workflowOutputDir, installSettings.imageWorkflowId),
    },
    imageEditWorkflow: {
      source: workflowPath(config.workflowOutputDir, installSettings.imageEditWorkflowId),
    },
    animaWorkflow: {
      source: workflowPath(config.workflowOutputDir, installSettings.imageAnimaWorkflowId),
    },
    minimaxImageWorkflow: {
      source: workflowPath(config.workflowOutputDir, installSettings.imageMinimaxWorkflowId),
    },
    settings,
    audioStudio: audioStatus,
    defaults: DEFAULT_RUNTIME_SETTINGS,
    capabilities: {
      models: [...new Set(models)].sort(),
      loras: [...new Set(loras)].sort(),
      textEncoders: [...new Set(textEncoders)].sort(),
      vaes: [...new Set(vaes)].sort(),
      latentUpscalers: [...new Set(latentUpscalers)].sort(),
      chatModels: [...new Set(chatRuntime?.models ?? llmFiles.filter((file) => /\.gguf$/i.test(file) && !/mmproj/i.test(file)))].sort(),
      chatProjectors: [...new Set(chatRuntime?.projectors ?? llmFiles.filter((file) => /mmproj.*\.gguf$/i.test(file)))].sort(),
      chatRuntime: chatRuntime ? {
        ready: chatRuntime.ready,
        loaded: chatRuntime.loaded,
        version: chatRuntime.runtimeVersion ?? null,
        error: chatRuntime.error ?? null,
      } : { ready: false, loaded: false, version: null, error: "Nodo H3 Studio Chat non caricato: riavvia ComfyUI" },
      planner: plannerStatus ?? {
        ready: false,
        backend: "local",
        configuredBackend: settings.planner.backend,
        model: settings.chat.model,
        baseUrl: null,
        apiKeyConfigured: false,
        fallbackLocal: false,
        error: "Planner non disponibile",
      },
      imageAttentionBackends,
      stepRange: { min: 4, max: 40 },
    },
  };
}

async function dependencyStatus() {
  const manifest = JSON.parse(
    await readFile(path.join(config.workflowOutputDir, "dependencies.json"), "utf8"),
  ) as {
    items: Array<{
      id: string;
      label: string;
      kind: "custom_node" | "model";
      requiredClasses?: string[];
      folder?:
        | "pdd_acc"
        | "diffusion_models"
        | "text_encoders"
        | "vae"
        | "loras"
        | "latent_upscale_models"
        | "llm"
        | "ultralytics_bbox";
      filenames?: string[];
      url?: string;
      requiredFor?: string[];
      notes?: string;
    }>;
  };
  return Promise.all(manifest.items.map(async (item) => {
    if (item.kind === "custom_node") {
      const checks = await Promise.all((item.requiredClasses ?? []).map(async (className) => {
        const info = await comfy.objectInfo(className).catch(() => null);
        return { className, installed: isRecord(info) && isRecord(info[className]) };
      }));
      return { ...item, installed: checks.every((check) => check.installed), checks };
    }
    const files = item.folder
      ? await comfy.modelFiles(item.folder).catch((): string[] => [])
      : [];
    const fileChecks = (item.filenames ?? []).map((filename) => ({
      filename,
      installed: files.includes(filename),
    }));
    const classChecks = await Promise.all((item.requiredClasses ?? []).map(async (className) => {
      const info = await comfy.objectInfo(className).catch(() => null);
      return { className, installed: isRecord(info) && isRecord(info[className]) };
    }));
    return {
      ...item,
      installed:
        fileChecks.some((check) => check.installed) &&
        classChecks.every((check) => check.installed),
      checks: [...classChecks, ...fileChecks],
    };
  }));
}

app.get("/api/admin/install-settings", async () => ({
  ok: true,
  settings: installSettings,
  workflowCatalog: WORKFLOW_CATALOG,
  dependencies: await dependencyStatus(),
}));

app.put("/api/admin/install-settings", async (request, reply) => {
  try {
    installSettings = await installSettingsStore.update(request.body);
    return {
      ok: true,
      settings: installSettings,
      restartRequired: true,
      message: "Configurazione salvata. Premi Riavvia server per applicarla al bridge H3.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Configurazione installazione non valida";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post("/api/admin/server/restart", async () => {
  scheduleBridgeRestart();
  return {
    ok: true,
    message: "Riavvio del bridge H3 avviato. ComfyUI resta in esecuzione.",
  };
});
app.get("/api/admin/llm-runtime", async (request, reply) => {
  if (!adminAuth.isAuthenticated(request.headers.cookie)) {
    return reply.status(401).send({ ok: false, error: "Accesso Admin richiesto" });
  }
  return { ok: true, status: await llmRuntime.status() };
});

app.put<{
  Body: { apiKey?: unknown; clear?: unknown };
}>("/api/admin/planner-secret", async (request, reply) => {
  if (!adminAuth.isAuthenticated(request.headers.cookie)) {
    return reply.status(401).send({ ok: false, error: "Accesso Admin richiesto" });
  }
  try {
    if (request.body?.clear === true) await plannerSecrets.clear();
    else await plannerSecrets.set(request.body?.apiKey);
    return {
      ok: true,
      apiKeyConfigured: await plannerSecrets.has(),
      message: request.body?.clear === true
        ? "Chiave API Planner rimossa"
        : "Chiave API Planner salvata nel bridge",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chiave API non salvata";
    return reply.status(400).send({ ok: false, error: message });
  }
});

app.post<{
  Body: { baseUrl?: unknown; model?: unknown; apiKey?: unknown };
}>("/api/admin/planner-test", async (request, reply) => {
  if (!adminAuth.isAuthenticated(request.headers.cookie)) {
    return reply.status(401).send({ ok: false, error: "Accesso Admin richiesto" });
  }
  try {
    return await llmProvider.testRemote(request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Test Planner remoto fallito";
    return reply.status(502).send({ ok: false, error: message });
  }
});

app.post<{ Body: { pid?: unknown } }>(
  "/api/admin/llm-runtime/unload",
  async (request, reply) => {
    if (!adminAuth.isAuthenticated(request.headers.cookie)) {
      return reply.status(401).send({ ok: false, error: "Accesso Admin richiesto" });
    }
    const pid = Number(request.body?.pid);
    try {
      const before = await llmRuntime.status();
      if (!before.processes.some((process) => process.pid === pid)) {
        throw new Error("Il PID scelto non è un processo llama-server attivo");
      }
      await comfy.chatUnload().catch(() => undefined);
      const afterComfyUnload = await llmRuntime.status();
      const result = afterComfyUnload.processes.some((process) => process.pid === pid)
        ? await llmRuntime.terminate(pid)
        : { before, after: afterComfyUnload, terminatedPid: pid };
      return {
        ok: true,
        ...result,
        message: "LLM scaricato: terminato llama-server PID " + pid + ". ComfyUI è rimasta attiva.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "LLM non scaricato";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

app.put<{ Body: { currentPassword?: unknown; nextPassword?: unknown } }>(
  "/api/admin/password",
  async (request, reply) => {
    try {
      adminAuth.updatePassword(
        String(request.body?.currentPassword ?? ""),
        String(request.body?.nextPassword ?? ""),
      );
      reply.header("set-cookie", adminAuth.clearCookie());
      return { ok: true, message: "Password aggiornata. Accedi nuovamente." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Password non aggiornata";
      return reply.status(400).send({ ok: false, error: message });
    }
  },
);

async function saveEngineSettings(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply.status(400).send({ ok: false, error: "Configurazione mancante" });
    }
    const h3 = (body as { h3?: unknown }).h3;
    const fast = (body as { fast?: unknown }).fast;
    const krea = (body as { krea?: unknown }).krea;
    const currentSettings = await runtimeSettings.get();
    const ltx25 =
      (body as { ltx25?: unknown }).ltx25 ?? currentSettings.ltx25;
    const imageEdit =
      (body as { imageEdit?: unknown }).imageEdit ?? currentSettings.imageEdit;
    const anima =
      (body as { anima?: unknown }).anima ?? currentSettings.anima;
    const chatSettings =
      (body as { chat?: unknown }).chat ?? currentSettings.chat;
    const plannerSettings =
      (body as { planner?: unknown }).planner ?? currentSettings.planner;
    const tts = (body as { tts?: unknown }).tts ?? currentSettings.tts;
    const music = (body as { music?: unknown }).music ?? currentSettings.music;
    const voiceConversion = (body as { voiceConversion?: unknown }).voiceConversion
      ?? currentSettings.voiceConversion;
    if (
      typeof h3 !== "object" || h3 === null || Array.isArray(h3) ||
      typeof fast !== "object" || fast === null || Array.isArray(fast) ||
      typeof ltx25 !== "object" || ltx25 === null || Array.isArray(ltx25) ||
      typeof krea !== "object" || krea === null || Array.isArray(krea) ||
      typeof imageEdit !== "object" || imageEdit === null || Array.isArray(imageEdit) ||
      typeof anima !== "object" || anima === null || Array.isArray(anima)
      || typeof chatSettings !== "object" || chatSettings === null || Array.isArray(chatSettings)
      || typeof plannerSettings !== "object" || plannerSettings === null || Array.isArray(plannerSettings)
      || typeof tts !== "object" || tts === null || Array.isArray(tts)
      || typeof music !== "object" || music === null || Array.isArray(music)
      || typeof voiceConversion !== "object" || voiceConversion === null || Array.isArray(voiceConversion)
    ) {
      return reply.status(400).send({ ok: false, error: "Configurazione H3, LTX 2.5, Krea, Anima o Chat mancante" });
    }
    assertLtx25AssetCompatibility(ltx25);
    const [models, loras, textEncoders, vaes, latentUpscalers, llmFiles, chatRuntime] = await Promise.all([
      comfy.models("diffusion_models"),
      comfy.models("loras"),
      comfy.modelFiles("text_encoders"),
      comfy.modelFiles("vae"),
      comfy.modelFiles("latent_upscale_models").catch((): string[] => []),
      comfy.modelFiles("llm").catch((): string[] => []),
      comfy.chatStatus().catch(() => null),
    ]);
    if (!models.includes(String((h3 as { model?: unknown }).model ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Modello H3 non installato" });
    }
    if (!models.includes(String((krea as { model?: unknown }).model ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Modello Krea non installato" });
    }
    if (!textEncoders.includes(String((krea as { encoder?: unknown }).encoder ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Text encoder Krea non installato" });
    }
    if (!vaes.includes(String((krea as { vae?: unknown }).vae ?? ""))) {
      return reply.status(400).send({ ok: false, error: "VAE Krea non installata" });
    }
    if (!models.includes(String((imageEdit as { model?: unknown }).model ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Modello Flux.2 Klein Edit non installato" });
    }
    if (!textEncoders.includes(String((imageEdit as { encoder?: unknown }).encoder ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Text encoder Flux.2 Klein Edit non installato" });
    }
    if (!vaes.includes(String((imageEdit as { vae?: unknown }).vae ?? ""))) {
      return reply.status(400).send({ ok: false, error: "VAE Flux.2 Klein Edit non installata" });
    }
    if (!models.includes(String((anima as { model?: unknown }).model ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Modello Anima non installato" });
    }
    if (!textEncoders.includes(String((anima as { encoder?: unknown }).encoder ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Text encoder Anima non installato" });
    }
    if (!vaes.includes(String((anima as { vae?: unknown }).vae ?? ""))) {
      return reply.status(400).send({ ok: false, error: "VAE Anima non installata" });
    }
    if (!latentUpscalers.includes(String((ltx25 as { upscaler?: unknown }).upscaler ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Latent upscaler LTX Quality non installato" });
    }
    const availableChatModels = [
      ...new Set(
        chatRuntime?.models ??
          llmFiles.filter((file) => /\.gguf$/i.test(file) && !/mmproj/i.test(file)),
      ),
    ];
    const availableChatProjectors = [
      ...new Set(
        chatRuntime?.projectors ??
          llmFiles.filter((file) => /mmproj.*\.gguf$/i.test(file)),
      ),
    ];
    const plannerBackend = String(
      (plannerSettings as { backend?: unknown }).backend ?? "local",
    );
    const plannerUseForChat =
      (plannerSettings as { useForChat?: unknown }).useForChat === true;
    const localChatRequired = plannerBackend !== "remote" || !plannerUseForChat;
    if (localChatRequired && !availableChatModels.includes(String((chatSettings as { model?: unknown }).model ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Modello LLM Chat non installato" });
    }
    if (localChatRequired && !availableChatProjectors.includes(String((chatSettings as { projector?: unknown }).projector ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Projector mmproj Chat non installato" });
    }
    if (!models.includes(String((music as { model?: unknown }).model ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Modello MiniMax Music non installato" });
    }
    if (!textEncoders.includes(String((music as { encoder?: unknown }).encoder ?? ""))) {
      return reply.status(400).send({ ok: false, error: "Text encoder MiniMax Music non installato" });
    }
    if (!vaes.includes(String((music as { vae?: unknown }).vae ?? ""))) {
      return reply.status(400).send({ ok: false, error: "VAE MiniMax Music non installata" });
    }
    const requestedAttention = String(
      (imageEdit as { attentionBackend?: unknown }).attentionBackend ?? "auto",
    );
    if (
      requestedAttention !== "auto" &&
      !(await imageStudio.attentionBackends().catch((): string[] => [])).includes(
        requestedAttention,
      )
    ) {
      return reply.status(400).send({
        ok: false,
        error: "Attention backend non disponibile in ComfyUI: " + requestedAttention,
      });
    }
    const requestedLoras = [
      ...(((h3 as { loras?: unknown }).loras as Array<{ name?: unknown }> | undefined) ?? []),
      ...(((krea as { loras?: unknown }).loras as Array<{ name?: unknown }> | undefined) ?? []),
      ...(((anima as { loras?: unknown }).loras as Array<{ name?: unknown }> | undefined) ?? []),
    ].map((slot) => String(slot?.name ?? "")).filter(Boolean);
    const missingLora = requestedLoras.find((name) => !loras.includes(name));
    if (missingLora) {
      return reply.status(400).send({ ok: false, error: `LoRA non installato: ${missingLora}` });
    }
    const settings = await runtimeSettings.update({
      ...body,
      imageEdit,
      anima,
      chat: chatSettings,
      planner: plannerSettings,
      tts,
      music,
      voiceConversion,
    });
    return { ok: true, settings };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Impostazioni non valide";
    return reply.status(400).send({ ok: false, error: message });
  }
}

app.get("/api/admin/engine-settings", engineSettingsPayload);
app.put("/api/admin/engine-settings", saveEngineSettings);
// Alias temporanei per client H3 Studio precedenti.
app.get("/api/admin/fast-settings", engineSettingsPayload);
app.put("/api/admin/fast-settings", saveEngineSettings);

app.addHook("onClose", async () => {
  progressTracker.stop();
  adminAuth.close();
  audioJobRepository.close();
  imageJobRepository.close();
  chatRepository.close();
  variantRepository.close();
  projectRepository.close();
  jobRepository.close();
});

app.get("/api/events", { websocket: true }, (socket) => {
  let closed = false;

  const sendHealth = async () => {
    if (closed || socket.readyState !== socket.OPEN) return;
    const payload = await comfy.health();
    socket.send(JSON.stringify({ type: "health", payload }));
  };

  void sendHealth();
  const timer = setInterval(() => void sendHealth(), 5000);

  socket.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.status(500).send({
    ok: false,
    error: "Errore interno del bridge H3 Studio",
  });
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `H3 Studio Bridge pronto su http://${config.host}:${config.port}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

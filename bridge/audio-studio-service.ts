import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComfyApiPrompt, ComfyHistoryEntry } from "./comfy-client.js";
import type { ComfyClient } from "./comfy-client.js";
import type { ComfyProgressTracker } from "./comfy-progress.js";
import { AudioJobRepository, type AudioOutput } from "./audio-job-repository.js";
import type { ExternalMediaRepository } from "./external-media-repository.js";
import type { RuntimeSettingsStore } from "./runtime-settings.js";

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
  if (start < 0 || end <= start) throw new Error("Gemma non ha restituito il piano musicale JSON");
  return JSON.parse(source.slice(start, end + 1)) as unknown;
}

export function normalizeMusicPlan(raw: string, expectedInstrumental: boolean): MusicPlan {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) throw new Error("Piano musicale Gemma non valido");
  const caption = typeof parsed.caption === "string" ? parsed.caption.trim().slice(0, 10_000) : "";
  const lyrics = typeof parsed.lyrics === "string" ? parsed.lyrics.trim().slice(0, 30_000) : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 1_000) : "";
  if (caption.length < 20) throw new Error("Gemma ha prodotto una descrizione musicale troppo breve");
  if (!expectedInstrumental && lyrics.length < 10) throw new Error("Gemma non ha prodotto le lyrics richieste");
  return {
    caption,
    lyrics: expectedInstrumental ? "" : lyrics,
    instrumental: expectedInstrumental,
    summary: summary || "Piano musicale preparato da Gemma.",
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

  constructor(
    private readonly comfy: ComfyClient,
    private readonly repository: AudioJobRepository,
    private readonly runtimeSettings: RuntimeSettingsStore,
    private readonly progressTracker: ComfyProgressTracker,
    private readonly externalMedia: ExternalMediaRepository,
    private readonly comfyOutputDir: string,
    private readonly dataDir: string,
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
        throw new Error(response.error ?? "Gemma non ha preparato il brano");
      }
      return normalizeMusicPlan(response.text, instrumental);
    } finally {
      await this.comfy.chatUnload().catch(() => undefined);
    }
  }

  async submit(value: unknown) {
    if (!isRecord(value)) throw new Error("Richiesta audio non valida");
    const kind = value.kind === "tts" || value.kind === "music" ? value.kind : null;
    if (!kind) throw new Error("Scegli TTS oppure Musica");
    const projectId = text(value.projectId, "Progetto", 1, 100);
    const settings = await this.runtimeSettings.get();
    if (kind === "tts") {
      const prompt = text(value.text, "Testo TTS", 1, 20_000);
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

    const caption = text(value.caption, "Descrizione musica", 3, 10_000);
    const lyrics = typeof value.lyrics === "string" ? value.lyrics.trim().slice(0, 30_000) : "";
    const durationSeconds = boundedNumber(value.durationSeconds ?? 30, "Durata", 5, 360);
    const musicSeed = seed(value.seed);
    const idHint = randomUUID().slice(0, 8);
    const apiPrompt = buildMusicPrompt({
      caption, lyrics, durationSeconds, seed: musicSeed, ...settings.music,
      filenamePrefix: `H3_STUDIO_AUDIO/music_${projectId}_${idHint}`,
    });
    const job = this.repository.create({
      projectId, kind, prompt: caption, lyrics, durationSeconds, seed: musicSeed,
      settings: { ...settings.music, engine: "minimax-music-3", apiPrompt },
    });
    try {
      await this.comfy.chatUnload().catch(() => undefined);
      const queued = await this.comfy.queuePrompt(apiPrompt, `h3-studio-audio-${job.id}`);
      this.repository.update(job.id, {
        status: "queued", phaseLabel: "In coda su ComfyUI", progress: null,
        promptId: queued.promptId, queueNumber: queued.queueNumber, error: null,
      });
      this.progressTracker.register(queued.promptId, apiPrompt, "audio");
    } catch (error) {
      this.repository.update(job.id, {
        status: "failed", phaseLabel: "Invio musica fallito", progress: null,
        error: error instanceof Error ? error.message : "Invio MiniMax Music fallito",
      });
    }
    return this.repository.get(job.id)!;
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
    return target;
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
    const controller = new AbortController();
    try {
      this.repository.update(jobId, { status: "loading", phaseLabel: "Scaricamento modelli ComfyUI", progress: 2, error: null });
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
          ...(referencePath ? { references: [{ audio_path: referencePath, text: job.referenceText || undefined }] } : {}),
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
      await writeFile(path.join(folder, filename), bytes);
      const output: Omit<AudioOutput, "file" | "mediaPath"> = { filename, subfolder, type: "output", format: "audio/wav" };
      const external = this.externalMedia.upsert({
        kind: "audio", file: `${subfolder}/${filename} [output]`, name: filename,
        original: filename, size: bytes.byteLength, has_audio: true,
      }, job.projectId);
      this.repository.update(jobId, {
        status: "ready", phaseLabel: "Voce pronta · modello scaricato", progress: 100,
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
        const absolute = path.join(this.comfyOutputDir, output.subfolder, output.filename);
        const size = await stat(absolute).then((value) => value.size).catch(() => null);
        const external = this.externalMedia.upsert({
          kind: "audio", file: `${output.subfolder ? `${output.subfolder}/` : ""}${output.filename} [${output.type}]`,
          name: output.filename, original: output.filename, size, duration: job.durationSeconds, has_audio: true,
        }, job.projectId);
        this.repository.update(job.id, { status: "ready", phaseLabel: "Musica pronta", progress: 100, output, externalMediaId: external.id, error: null });
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

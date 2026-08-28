import type { ComfyClient } from "./comfy-client.js";
import {
  ChatRepository,
  type ChatActionRecord,
  type ChatAttachment,
} from "./chat-repository.js";
import type { ImageStudioService } from "./image-studio-service.js";
import type { AudioStudioService } from "./audio-studio-service.js";
import type { RuntimeSettingsStore } from "./runtime-settings.js";
import type { StudioJobService } from "./studio-job.js";

type PlannedAction = {
  type: "generate_video" | "generate_image" | "edit_image" | "generate_anima" | "generate_tts" | "generate_music";
  prompt: string;
  videoMode?: "T2V" | "I2V" | "R2V" | "VIDEO EXTENSION" | "VIDEO EDITING";
  aspect?: "16:9" | "9:16" | "1:1";
  durationSeconds?: number;
  instrumental?: boolean;
  lyrics?: string;
};

type ChatRoute = "auto" | "video" | "krea" | "anima" | "edit" | "tts" | "music";

const RECENT_MESSAGE_COUNT = 10;
const COMPACTION_TRIGGER_COUNT = 16;
const COMPACTION_BATCH_COUNT = 18;
const MAX_MEMORY_CHARACTERS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAttachment(value: unknown): ChatAttachment {
  if (!isRecord(value)) throw new Error("Allegato Chat non valido");
  const kind = value.kind === "video" || value.kind === "audio" ? value.kind : "picture";
  const file = typeof value.file === "string" ? value.file.trim() : "";
  const clean = file.replace(/ \[(input|output|temp)\]$/i, "");
  if (!file || /^[a-z]:/i.test(clean) || clean.startsWith("/") || clean.split(/[\\/]+/).includes("..")) {
    throw new Error("Percorso allegato Chat non valido");
  }
  const name = typeof value.name === "string" && value.name.trim()
    ? value.name.trim().slice(0, 240)
    : clean.split(/[\\/]/).at(-1) ?? "Media";
  const numberOrNull = (input: unknown) => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return {
    kind,
    file,
    name,
    mediaPath: typeof value.mediaPath === "string" && value.mediaPath.startsWith("/api/media?")
      ? value.mediaPath.slice(0, 2_000)
      : undefined,
    width: numberOrNull(value.width),
    height: numberOrNull(value.height),
    duration: numberOrNull(value.duration),
    hasAudio: value.hasAudio === true || value.has_audio === true,
    remembered: value.remembered === true,
  };
}

const MEDIA_RECALL_PATTERN = /(?:\b(?:questa|quella|questo|quello)\s+(?:immagine|foto|video|audio)\b|\b(?:l['’]?immagine|la\s+foto|il\s+video|l['’]?audio)\b|\b(?:modifical[ao]|edit(?:ala|alo)|animala|animalo|usala|usalo|continualo|estendilo|trasformala|trasformalo)\b|\bpartendo\s+da\s+(?:questa|quella|questo|quello)\b|\b(?:this|that)\s+(?:image|picture|video|audio)\b|\b(?:edit|animate|use|continue|extend|transform)\s+it\b)/i;

export function shouldRecallMedia(content: string) {
  return MEDIA_RECALL_PATTERN.test(content);
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM non ha restituito il piano JSON richiesto");
  return JSON.parse(source.slice(start, end + 1)) as unknown;
}

function normalizeActionType(value: unknown): Pick<PlannedAction, "type" | "videoMode"> | null {
  const token = typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
  const direct = new Set<PlannedAction["type"]>([
    "generate_video", "generate_image", "edit_image", "generate_anima", "generate_tts", "generate_music",
  ]);
  if (direct.has(token as PlannedAction["type"])) {
    return { type: token as PlannedAction["type"] };
  }
  const aliases: Record<string, Pick<PlannedAction, "type" | "videoMode">> = {
    video: { type: "generate_video" },
    create_video: { type: "generate_video" },
    video_editing: { type: "generate_video", videoMode: "VIDEO EDITING" },
    edit_video: { type: "generate_video", videoMode: "VIDEO EDITING" },
    modify_video: { type: "generate_video", videoMode: "VIDEO EDITING" },
    video_extension: { type: "generate_video", videoMode: "VIDEO EXTENSION" },
    extend_video: { type: "generate_video", videoMode: "VIDEO EXTENSION" },
    continue_video: { type: "generate_video", videoMode: "VIDEO EXTENSION" },
    image_to_video: { type: "generate_video", videoMode: "I2V" },
    reference_to_video: { type: "generate_video", videoMode: "R2V" },
    create_image: { type: "generate_image" },
    image_editing: { type: "edit_image" },
    generate_anime: { type: "generate_anima" },
    tts: { type: "generate_tts" },
    speech: { type: "generate_tts" },
    music: { type: "generate_music" },
  };
  return aliases[token] ?? null;
}

export function normalizePlan(text: string): { reply: string; title: string | null; action: PlannedAction | null } {
  const parsed = extractJson(text);
  if (!isRecord(parsed)) throw new Error("Piano Chat non valido");
  const reply = typeof parsed.reply === "string" ? parsed.reply.trim().slice(0, 12_000) : "";
  const title = typeof parsed.title === "string" && parsed.title.trim()
    ? parsed.title.replace(/\s+/g, " ").trim().slice(0, 80)
    : null;
  if (!reply) throw new Error("Risposta Chat vuota");
  if (parsed.action === null || parsed.action === undefined) return { reply, title, action: null };
  if (!isRecord(parsed.action)) throw new Error("Azione Chat non valida");
  const normalizedType = normalizeActionType(parsed.action.type);
  const prompt = typeof parsed.action.prompt === "string" ? parsed.action.prompt.trim() : "";
  if (!normalizedType || prompt.length < 3 || prompt.length > 20_000) {
    throw new Error("LLM ha proposto un'azione non valida");
  }
  const videoMode = ["T2V", "I2V", "R2V", "VIDEO EXTENSION", "VIDEO EDITING"].includes(String(parsed.action.videoMode))
    ? parsed.action.videoMode as PlannedAction["videoMode"]
    : normalizedType.videoMode;
  const aspect = parsed.action.aspect === "9:16" || parsed.action.aspect === "1:1"
    ? parsed.action.aspect
    : "16:9";
  const requestedDuration = Number(parsed.action.durationSeconds);
  const durationSeconds = Number.isFinite(requestedDuration)
    ? Math.min(360, Math.max(5, Math.round(requestedDuration)))
    : undefined;
  const instrumental = parsed.action.instrumental !== false;
  const lyrics = typeof parsed.action.lyrics === "string"
    ? parsed.action.lyrics.trim().slice(0, 30_000)
    : undefined;
  return { reply, title, action: { type: normalizedType.type, prompt, videoMode, aspect, durationSeconds, instrumental, lyrics } };
}

const EXPLICIT_INSTRUMENTAL_PATTERN = /\b(?:strumentale|instrumental|senza\s+(?:voce|voci|cantato)|no\s+vocals?|without\s+vocals?)\b/i;
const VOCAL_MUSIC_PATTERN = /\b(?:canta(?:ta|to|re|nte)?|cantato|cantata|cantante|voce|voci|vocale|vocals?|singer|singing|lyrics?|testo\s+(?:cantato|della\s+canzone)|ritornello|chorus)\b/i;

export function musicInstrumentalIntent(request: string): boolean | null {
  if (EXPLICIT_INSTRUMENTAL_PATTERN.test(request)) return true;
  if (VOCAL_MUSIC_PATTERN.test(request)) return false;
  return null;
}

export function extractRequestedLyrics(request: string) {
  const contextual = request.match(/(?:dice|canta|cantando|testo|lyrics?|parole)\s*(?:che\s+dice)?\s*[:=-]?\s*["“«]([^"”»]{1,30000})["”»]/i)?.[1];
  if (contextual?.trim()) return contextual.trim();
  const quoted = [...request.matchAll(/["“«]([^"”»]{1,30000})["”»]/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return VOCAL_MUSIC_PATTERN.test(request) && quoted.length ? quoted.join("\n") : "";
}

export function preserveMusicIntent(action: PlannedAction | null, request: string) {
  if (action?.type !== "generate_music") return action;
  const detected = musicInstrumentalIntent(request);
  const instrumental = detected ?? action.instrumental ?? true;
  const preservedLyrics = action.lyrics?.trim() || extractRequestedLyrics(request);
  return {
    ...action,
    instrumental,
    lyrics: instrumental ? "" : preservedLyrics,
  };
}

function normalizeRoute(value: unknown): ChatRoute {
  return value === "video" || value === "krea" || value === "anima" || value === "edit" || value === "tts" || value === "music"
    ? value
    : "auto";
}

export function routeAction(action: PlannedAction | null, route: ChatRoute) {
  if (!action || route === "auto") return action;
  const forcedType = route === "video"
    ? "generate_video"
    : route === "krea"
      ? "generate_image"
      : route === "anima"
        ? "generate_anima"
        : route === "edit"
          ? "edit_image"
          : route === "tts"
            ? "generate_tts"
            : "generate_music";
  return { ...action, type: forcedType } as PlannedAction;
}

function routeInstruction(route: ChatRoute) {
  if (route === "auto") {
    return "ROUTE_OVERRIDE=auto. Infer the engine using the routing rules.";
  }
  const action = route === "video"
    ? "generate_video"
    : route === "krea"
      ? "generate_image"
      : route === "anima"
        ? "generate_anima"
        : route === "edit"
          ? "edit_image"
          : route === "tts"
            ? "generate_tts"
            : "generate_music";
  return `ROUTE_OVERRIDE=${route}. If and only if the user explicitly requests media creation, use action type ${action}. The selector alone never authorizes a render.`;
}

function contextCharacterBudget(nCtx: number) {
  return Math.min(60_000, Math.max(14_000, Math.trunc(nCtx * 2.2)));
}

function recentMessagesWithinBudget<T extends { content: string }>(messages: T[], budget: number) {
  const selected: T[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = message.content.length + 80;
    if (selected.length >= 1 && used + cost > budget) break;
    selected.unshift(message);
    used += cost;
  }
  return selected;
}

function outputFile(output: { filename: string; subfolder?: string | null; type?: string | null }) {
  const path = [output.subfolder ?? "", output.filename].filter(Boolean).join("/");
  return `${path} [${output.type ?? "output"}]`;
}

const CHAT_SYSTEM_PROMPT = `You are H3 Studio, a concise Italian-speaking creative assistant and a safe workflow router.
Always return exactly one JSON object and no markdown:
{"reply":"natural Italian reply","title":"concise 3-7 word Italian conversation title","action":null}
or
{"reply":"Italian confirmation","title":"concise 3-7 word Italian conversation title","action":{"type":"generate_video|generate_image|edit_image|generate_anima|generate_tts|generate_music","prompt":"complete media prompt or exact TTS script","videoMode":"T2V|I2V|R2V|VIDEO EXTENSION|VIDEO EDITING","aspect":"16:9|9:16|1:1","durationSeconds":30,"instrumental":true,"lyrics":"exact requested words to sing or empty string"}}

Only create an action when the user explicitly asks to generate, animate, continue or edit media. Questions and ordinary conversation use action:null.
The title describes the main topic, never starts with "Chat" and never contains quotation marks.
For video default to 10 seconds, one candidate, 0.5 MP and the FAST 8-step engine; these execution values are enforced by the server and must not be invented in JSON.
Use generate_anima for anime, manga, illustration, drawing or cartoon-style still images, including the Italian words disegno, illustrazione, anime, manga and cartone. Use generate_image for photographic or general Krea still images. Use edit_image only with attached pictures. Use I2V when one attached picture is the start frame, R2V for broader references, VIDEO EXTENSION for continuing an attached video, and VIDEO EDITING for editing one. Video editing and extension still use action type generate_video; never invent video_editing, edit_video or continue_video action types.
Use generate_tts when the user asks for speech, narration, dubbing, reading or voice cloning. For TTS, prompt is the exact text to speak in the requested language, not an English description. An attached Audio 1 is the voice reference and is transcribed automatically.
Use generate_music when the user asks for a song, soundtrack, instrumental or music. Put the musical request in prompt, set durationSeconds when requested (default 30), and set instrumental:false whenever singing, a singer, a voice, vocals, lyrics or words to sing are requested. For a vocal song, copy every user-supplied lyric verbatim into lyrics, preserving its language and wording; never translate, summarize or omit quoted words. Use lyrics:"" only for instrumental music or when the user did not supply exact words.
Write rich, production-ready prompts in English except the exact spoken TTS script. When attachments are present, refer to them as Picture 1, Picture 2, Video 1 or Audio 1 in attachment order. Never invent file paths, model names, LoRAs, workflow nodes or numeric engine settings.`;

const MEMORY_SYSTEM_PROMPT = `You maintain compact long-term memory for one H3 Studio creative project.
Return plain Italian text only, no JSON and no markdown. Merge the existing memory with the transcript.
Preserve stable user preferences, accepted decisions, character/object identities, continuity details, named assets, chosen engines, successful settings and unresolved tasks.
Discard greetings, repetition, failed guesses and obsolete values when a newer decision supersedes them.
Be factual and concise. Never invent information. Maximum 3500 characters.`;

export class ChatService {
  constructor(
    private readonly comfy: ComfyClient,
    private readonly repository: ChatRepository,
    private readonly runtimeSettings: RuntimeSettingsStore,
    private readonly studioJobs: StudioJobService,
    private readonly imageStudio: ImageStudioService,
    private readonly audioStudio: AudioStudioService,
  ) {}

  conversations(projectId?: string | null) {
    return this.repository.listConversations(projectId);
  }
  createConversation(projectId: string, title?: unknown) {
    return this.repository.createConversation(projectId, title);
  }
  renameConversation(conversationId: string, title: unknown) {
    return this.repository.renameConversation(conversationId, title);
  }
  conversation(conversationId: string) {
    const conversation = this.repository.getConversation(conversationId);
    if (!conversation) throw new Error("Conversazione Chat non trovata");
    return {
      conversation,
      messages: this.repository.list(conversation.projectId, conversation.id),
      memory: this.repository.memoryStatus(conversation.projectId, conversation.id),
    };
  }
  list(projectId: string, conversationId?: string | null) {
    return this.repository.list(projectId, conversationId);
  }
  memory(projectId: string, conversationId?: string | null) {
    return this.repository.memoryStatus(projectId, conversationId);
  }
  clear(projectId: string, conversationId?: string | null) {
    return this.repository.clear(projectId, conversationId);
  }
  mediaJobs(conversationId: string) {
    return this.repository.mediaJobs(conversationId);
  }
  deleteConversation(conversationId: string) {
    return this.repository.deleteConversation(conversationId);
  }

  async regenerateConversationAction(
    conversationId: string,
    messageId: string,
    promptValue: unknown,
    lyricsValue?: unknown,
  ) {
    const conversation = this.repository.getConversation(conversationId);
    if (!conversation) throw new Error("Conversazione Chat non trovata");
    const source = this.repository.get(messageId);
    if (
      !source ||
      source.conversationId !== conversation.id ||
      source.role !== "assistant" ||
      source.action?.status !== "started" ||
      !source.action.jobId
    ) {
      throw new Error("Generazione Chat da rigenerare non trovata");
    }
    const prompt = typeof promptValue === "string" ? promptValue.trim() : "";
    if (prompt.length < 3 || prompt.length > 20_000) {
      throw new Error("Il prompt deve contenere da 3 a 20.000 caratteri");
    }
    await this.comfy.chatUnload().catch(() => undefined);
    const job = source.action.type === "generate_video"
      ? await this.studioJobs.regenerate(source.action.jobId, 1, prompt)
      : source.action.type === "generate_tts" || source.action.type === "generate_music"
        ? await this.audioStudio.regenerate(source.action.jobId, prompt, lyricsValue)
        : await this.imageStudio.regenerate(source.action.jobId, 1, prompt);
    if (!job?.id) throw new Error("Rigenerazione non avviata");
    const assistant = this.repository.add({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      role: "assistant",
      content: "Rigenerazione avviata con un nuovo seed.",
      action: {
        type: source.action.type,
        prompt,
        jobId: job.id,
        status: "started",
      },
    });
    return {
      conversation: this.repository.getConversation(conversation.id),
      messages: this.repository.list(conversation.projectId, conversation.id),
      memory: this.repository.memoryStatus(conversation.projectId, conversation.id),
      assistant,
    };
  }

  async status() {
    const [settings, runtime] = await Promise.all([
      this.runtimeSettings.get(),
      this.comfy.chatStatus().catch((error) => ({
        ok: false,
        ready: false,
        loaded: false,
        models: [] as string[],
        projectors: [] as string[],
        error: error instanceof Error ? error.message : "Nodo Chat non disponibile",
      })),
    ]);
    return { ...runtime, settings: settings.chat };
  }

  async send(projectId: string, value: unknown, conversationId?: string | null) {
    if (!isRecord(value)) throw new Error("Messaggio Chat mancante");
    const conversation = this.repository.ensureConversation(projectId, conversationId);
    const content = typeof value.content === "string" ? value.content.trim() : "";
    if (content.length < 1 || content.length > 20_000) {
      throw new Error("Il messaggio deve contenere da 1 a 20.000 caratteri");
    }
    const rawAttachments = value.attachments === undefined ? [] : value.attachments;
    if (!Array.isArray(rawAttachments) || rawAttachments.length > 8) {
      throw new Error("Puoi allegare al massimo 8 media alla Chat");
    }
    const providedAttachments = rawAttachments.map(normalizeAttachment);
    const rememberedAttachments = providedAttachments.length === 0 && shouldRecallMedia(content)
      ? await this.recallLatestMedia(projectId, conversation.id)
      : [];
    const attachments = providedAttachments.length ? providedAttachments : rememberedAttachments;
    const reusedAttachments = rememberedAttachments.length > 0;
    const route = normalizeRoute(value.route);
    this.repository.add({
      projectId, conversationId: conversation.id, role: "user", content, attachments,
    });
    const settings = (await this.runtimeSettings.get()).chat;
    await this.compactContext(projectId, conversation.id, settings).catch(() => undefined);
    const context = this.repository.context(projectId, conversation.id);
    const history = recentMessagesWithinBudget(
      context.messages,
      contextCharacterBudget(settings.nCtx) - context.summary.length,
    );
    const modelMessages = [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "system", content: routeInstruction(route) },
      ...(context.summary
        ? [{ role: "system", content: `PROJECT_MEMORY:\n${context.summary}` }]
        : []),
      ...history.map((message) => ({
        role: message.role,
        content: message.attachments.length
          ? `${message.content}\n\n[Media associati: ${message.attachments.map((item, index) => `${item.kind === "picture" ? "Picture" : item.kind === "video" ? "Video" : "Audio"} ${index + 1}: ${item.name}`).join("; ")}]`
          : message.content,
      })),
    ];
    let rawText = "";
    try {
      const response = await this.comfy.chatGenerate({
        model: settings.model,
        projector: settings.projector,
        n_ctx: settings.nCtx,
        n_gpu_layers: settings.nGpuLayers,
        n_threads: settings.nThreads,
        max_tokens: settings.maxNewTokens,
        temperature: settings.temperature,
        top_p: settings.topP,
        messages: modelMessages,
        images: attachments.filter((item) => item.kind === "picture").map((item) => item.file).slice(0, 4),
      });
      if (!response.ok || !response.text) throw new Error(response.error ?? "LLM non ha risposto");
      rawText = response.text;
      const parsedPlan = normalizePlan(rawText);
      const routedAction = routeAction(parsedPlan.action, route);
      const plan = { ...parsedPlan, action: preserveMusicIntent(routedAction, content) };
      this.repository.maybeAutoTitle(conversation.id, plan.title ?? content);
      const action = plan.action ? await this.executeAction(projectId, plan.action, attachments, content) : null;
      const assistant = this.repository.add({
        projectId,
        conversationId: conversation.id,
        role: "assistant",
        content: plan.reply,
        action,
      });
      return {
        conversation: this.repository.getConversation(conversation.id),
        messages: this.repository.list(projectId, conversation.id),
        memory: this.repository.memoryStatus(projectId, conversation.id),
        reusedAttachments,
        assistant,
      };
    } catch (error) {
      await this.comfy.chatUnload().catch(() => undefined);
      this.repository.maybeAutoTitle(conversation.id, content);
      const message = error instanceof Error ? error.message : "Chat locale non disponibile";
      const assistant = this.repository.add({
        projectId,
        conversationId: conversation.id,
        role: "assistant",
        content: `Non sono riuscito a completare la richiesta: ${message}`,
        status: "failed",
        error: rawText ? `${message} · Risposta grezza: ${rawText.slice(0, 500)}` : message,
      });
      return {
        conversation: this.repository.getConversation(conversation.id),
        messages: this.repository.list(projectId, conversation.id),
        memory: this.repository.memoryStatus(projectId, conversation.id),
        reusedAttachments,
        assistant,
      };
    }
  }

  private async compactContext(
    projectId: string,
    conversationId: string,
    settings: Awaited<ReturnType<RuntimeSettingsStore["get"]>>["chat"],
  ) {
    const context = this.repository.context(projectId, conversationId);
    const totalCharacters = context.messages.reduce((sum, message) => sum + message.content.length, 0);
    if (
      context.messages.length <= COMPACTION_TRIGGER_COUNT &&
      totalCharacters <= contextCharacterBudget(settings.nCtx)
    ) return this.repository.memoryStatus(projectId, conversationId);

    const compactableCount = Math.min(
      COMPACTION_BATCH_COUNT,
      Math.max(0, context.messages.length - RECENT_MESSAGE_COUNT),
    );
    if (!compactableCount) return this.repository.memoryStatus(projectId, conversationId);
    const compactable = context.messages.slice(0, compactableCount);
    const transcript = compactable.map((message) => {
      const action = message.action
        ? `\n[Azione ${message.action.type}: ${message.action.prompt.slice(0, 1_200)}]`
        : "";
      return `${message.role === "user" ? "UTENTE" : "ASSISTENTE"}: ${message.content.slice(0, 2_500)}${action}`;
    }).join("\n\n");
    const response = await this.comfy.chatGenerate({
      model: settings.model,
      projector: settings.projector,
      n_ctx: settings.nCtx,
      n_gpu_layers: settings.nGpuLayers,
      n_threads: settings.nThreads,
      max_tokens: Math.min(1_024, settings.maxNewTokens),
      temperature: 0.1,
      top_p: 0.9,
      messages: [
        { role: "system", content: MEMORY_SYSTEM_PROMPT },
        {
          role: "user",
          content: `MEMORIA ESISTENTE:\n${context.summary || "(vuota)"}\n\nNUOVA TRASCRIZIONE:\n${transcript}`,
        },
      ],
      images: [],
    });
    if (!response.ok || !response.text?.trim()) {
      throw new Error(response.error ?? "Compattazione memoria non disponibile");
    }
    const summary = response.text.trim().slice(0, MAX_MEMORY_CHARACTERS);
    const throughSequence = compactable.at(-1)?.sequence ?? context.sequence;
    return this.repository.updateMemory(projectId, conversationId, summary, throughSequence);
  }

  private async recallLatestMedia(projectId: string, conversationId: string) {
    for (const source of this.repository.recentMediaSources(projectId, conversationId)) {
      const action = source.action;
      if (action?.status === "started" && action.jobId) {
        if (action.type === "generate_tts" || action.type === "generate_music") {
          const job = await this.audioStudio.get(action.jobId).catch(() => null);
          if (job?.output) {
            return [{
              kind: "audio" as const,
              file: job.output.file,
              name: `Audio ${job.id.slice(0, 8)} · ${job.kind === "tts" ? "voce" : "musica"}`,
              mediaPath: job.output.mediaPath,
              duration: job.durationSeconds,
              hasAudio: true,
              remembered: true,
            }];
          }
        } else if (action.type === "generate_video") {
          const job = await this.studioJobs.get(action.jobId).catch(() => null);
          const candidate = job?.candidates.find((item) =>
            item.index === job.selectedCandidateIndex && item.status === "ready" && item.output,
          ) ?? job?.candidates.find((item) => item.status === "ready" && item.output);
          if (job && candidate?.output) {
            return [{
              kind: "video" as const,
              file: outputFile(candidate.output),
              name: `Video ${job.id.slice(0, 8)} · candidato ${candidate.index}`,
              mediaPath: candidate.output.mediaPath,
              duration: job.request.durationSeconds,
              hasAudio: true,
              remembered: true,
            }];
          }
        } else {
          const job = await this.imageStudio.get(action.jobId).catch(() => null);
          const candidate = job?.candidates.find((item) =>
            item.index === job.selectedCandidateIndex && item.status === "ready" && item.output,
          ) ?? job?.candidates.find((item) => item.status === "ready" && item.output);
          if (job && candidate?.output) {
            return [{
              kind: "picture" as const,
              file: outputFile(candidate.output),
              name: `Immagine ${job.id.slice(0, 8)} · candidato ${candidate.index}`,
              mediaPath: candidate.output.mediaPath,
              width: job.width,
              height: job.height,
              remembered: true,
            }];
          }
        }
      }
      if (source.attachments.length) {
        return source.attachments.slice(0, 8).map((attachment) => ({
          ...attachment,
          remembered: true,
        }));
      }
    }
    return [];
  }

  private async executeAction(
    projectId: string,
    plan: PlannedAction,
    attachments: ChatAttachment[],
    originalRequest?: string,
  ): Promise<ChatActionRecord> {
    try {
      if (plan.type === "generate_music") {
        const durationSeconds = plan.durationSeconds ?? 30;
        const musicPlan = await this.audioStudio.planMusic({
          idea: originalRequest?.trim() || plan.prompt,
          instrumental: plan.instrumental !== false,
          durationSeconds,
          lyrics: plan.lyrics,
        });
        const job = await this.audioStudio.submit({
          kind: "music", projectId, caption: musicPlan.caption, lyrics: musicPlan.lyrics, durationSeconds,
        });
        return { type: plan.type, prompt: musicPlan.caption, jobId: job?.id, status: "started" };
      }
      if (plan.type === "generate_tts") {
        await this.comfy.chatUnload().catch(() => undefined);
        const reference = attachments.find((item) => item.kind === "audio");
        const job = await this.audioStudio.submit({
          kind: "tts", projectId, text: plan.prompt,
          referenceFile: reference?.file,
        });
        return { type: plan.type, prompt: plan.prompt, jobId: job?.id, status: "started" };
      }
      await this.comfy.chatUnload();
      if (plan.type === "generate_video") {
        const pictures = attachments.filter((item) => item.kind === "picture");
        const videos = attachments.filter((item) => item.kind === "video");
        let generationMode = plan.videoMode ?? "T2V";
        if (generationMode === "T2V" && pictures.length) generationMode = "I2V";
        if ((generationMode === "VIDEO EXTENSION" || generationMode === "VIDEO EDITING") && !videos.length) {
          generationMode = pictures.length ? "I2V" : "T2V";
        }
        if (generationMode === "I2V" && !pictures.length) generationMode = "T2V";
        const mediaState = generationMode === "T2V" ? [] : attachments;
        const job = await this.studioJobs.submit({
          projectId,
          prompt: plan.prompt,
          candidateCount: 1,
          durationSeconds: 10,
          megapixels: 0.5,
          generationMode,
          aspectFormat: plan.aspect === "9:16" ? "9:16 portrait" : plan.aspect === "1:1" ? "1:1 square" : "16:9 landscape",
          seedMode: "random",
          qualityMode: "fast",
          turboEnabled: true,
          mediaState: JSON.stringify(mediaState),
          referenceRoles: "AUTO",
          keyframePositions: "AUTO",
          sourceVideoAudio: "AUTO",
          muteDiegetic: false,
          muteNonDiegetic: false,
        });
        return { type: plan.type, prompt: plan.prompt, jobId: job?.id, status: "started" };
      }
      const imageMode = plan.type === "edit_image" ? "edit" : plan.type === "generate_anima" ? "anima" : "generate";
      const imageReferences = attachments.filter((item) => item.kind === "picture").slice(0, 4);
      if (imageMode === "edit" && !imageReferences.length) throw new Error("L'edit richiede almeno una immagine allegata");
      const vertical = plan.aspect === "9:16";
      const square = plan.aspect === "1:1";
      const width = square ? 1024 : vertical ? 768 : 1344;
      const height = square ? 1024 : vertical ? 1344 : 768;
      const job = await this.imageStudio.submit({
        projectId,
        mode: imageMode,
        prompt: plan.prompt,
        compositionPreset: "free",
        candidateCount: 1,
        aspectFormat: plan.aspect ?? "16:9",
        width,
        height,
        seedMode: "random",
        references: imageMode === "edit" ? imageReferences.map((item, index) => ({
          file: item.file,
          name: item.name,
          width: item.width ?? null,
          height: item.height ?? null,
          role: index === 0 ? "base" : "other",
        })) : [],
        tag: "untagged",
      });
      return { type: plan.type, prompt: plan.prompt, jobId: job?.id, status: "started" };
    } catch (error) {
      return {
        type: plan.type,
        prompt: plan.prompt,
        status: "failed",
        error: error instanceof Error ? error.message : "Avvio azione fallito",
      };
    }
  }
}

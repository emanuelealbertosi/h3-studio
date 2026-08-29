import type { ComfyClient } from "./comfy-client.js";
import {
  ChatRepository,
  type ChatActionRecord,
  type ChatAttachment,
} from "./chat-repository.js";
import type { ImageStudioService } from "./image-studio-service.js";
import type { AudioStudioService } from "./audio-studio-service.js";
import type { RuntimeSettingsStore } from "./runtime-settings.js";
import type { AudioRoutingRole, GenerationMode, StudioJobService } from "./studio-job.js";

type PlannedAction = {
  type: "generate_video" | "generate_image" | "generate_minimax_image" | "edit_image" | "generate_anima" | "generate_tts" | "generate_music";
  prompt: string;
  videoMode?: "T2V" | "I2V" | "R2V" | "KEYFRAMES" | "VIDEO EXTENSION" | "VIDEO EDITING";
  aspect?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  durationSeconds?: number;
  imageSteps?: 8 | 12 | 20 | 30;
  imageMegapixels?: 0.5 | 0.7 | 0.98 | 2;
  instrumental?: boolean;
  lyrics?: string;
  maskTarget?: string;
  maskStartSeconds?: number;
  maskEndSeconds?: number;
};

type ChatRoute = "auto" | "video" | "krea" | "minimax" | "anima" | "edit" | "tts" | "music";

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

const MEDIA_RECALL_PATTERN = /(?:\b(?:questa|quella|questo|quello|queste|quelle)\s+(?:immagin[ei]|foto|video|audio)\b|\b(?:(?:questa|quella|questo|quello|queste|quelle)\s+)?(?:ultim[oaie]?|precedent[ei])\s+(?:immagin[ei]|foto|video|audio)\b|\b(?:l['’]?immagine|le\s+immagini|la\s+foto|le\s+foto|il\s+video|l['’]?audio)\b|\b(?:modifical[oa]|modificale|edit(?:ala|alo|ale)|animala|animalo|animale|usala|usalo|usale|continualo|estendilo|trasformala|trasformalo|trasformale)\b|\bpartendo\s+da\s+(?:questa|quella|questo|quello|queste|quelle)\b|\b(?:this|that|these|those|last|previous)\s+(?:images?|pictures?|videos?|audio)\b|\b(?:edit|animate|use|continue|extend|transform)\s+(?:it|them)\b)/i;

export function shouldRecallMedia(content: string) {
  return MEDIA_RECALL_PATTERN.test(content);
}

const VIDEO_DURATION_CUE = /\b(?:second[io]|sec(?:onds?)?|minut[oi]|min(?:utes?)?)\b|\d+(?:[.,]\d+)?\s*[sm]\b/i;

export function extractRequestedVideoDuration(content: string) {
  const text = String(content ?? "");
  const minutes = text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:minut[oi]|min(?:utes?)?)\b/i);
  if (minutes) return Math.round(Number(minutes[1].replace(",", ".")) * 60);
  const seconds = text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:second[io]|sec(?:onds?)?|s)\b/i);
  return seconds ? Math.round(Number(seconds[1].replace(",", "."))) : null;
}

export function resolveChatVideoTiming(requestedDuration?: number) {
  const requested = requestedDuration === undefined
    ? 10
    : Math.max(5, Math.round(requestedDuration));
  if (requested <= 5) return { shotCount: 1, durationSeconds: 5 as const, totalSeconds: 5 };
  if (requested <= 10) return { shotCount: 1, durationSeconds: 10 as const, totalSeconds: 10 };
  if (requested <= 15) return { shotCount: 1, durationSeconds: 15 as const, totalSeconds: 15 };
  if (requested <= 120) {
    const shotCount = Math.ceil(requested / 10);
    return { shotCount, durationSeconds: 10 as const, totalSeconds: shotCount * 10 };
  }
  if (requested <= 180) {
    const shotCount = Math.ceil(requested / 15);
    return { shotCount, durationSeconds: 15 as const, totalSeconds: shotCount * 15 };
  }
  throw new Error("La Chat video supporta al massimo 180 secondi (12 shot da 15s)");
}

const I2V_INTENT_PATTERN = /(?:\b(?:anima(?:re|zione|la|lo)?|animate)\b.{0,100}\b(?:immagine|foto|image|picture)\b|\b(?:trasforma(?:re|la|lo)?|turn)\b.{0,100}\b(?:immagine|foto|image|picture)\b.{0,60}\b(?:video|filmato)\b|\b(?:video|filmato)\b.{0,100}\b(?:da|from|partendo\s+da|starting\s+from)\b.{0,100}\b(?:immagine|foto|image|picture)\b)/i;
const LIP_SYNC_AUDIO_INTENT_PATTERN = /\b(?:lip[\s-]?sync|sincron(?:izza(?:re)?|izzato|izzazione)\s+(?:il\s+)?(?:labbra|labiale|bocca)|(?:fall[oa]|rendil[oa]|fai\s+(?:la|il|lo))\s+(?:parlare|cantare)|(?:parla|dice|pronuncia|recita|canta)\b.{0,120}\b(?:audio|voce|dialogo|traccia)|(?:audio|voce|dialogo|traccia)\b.{0,120}\b(?:parlare|cantare|labbra|labiale|bocca))\b/i;
const VOICE_TIMBRE_VIDEO_PATTERN = /\b(?:solo\s+come\s+(?:riferimento\s+(?:di\s+)?)?(?:voce|timbro)|(?:riferimento|reference)\s+(?:di\s+)?(?:voce|vocale|timbro)|(?:voce|timbro)\s+(?:di|dell['’]?)\s*(?:quest[oa]|audio|traccia)|(?:con|usando|usa|utilizza)\s+(?:questa|la|questo|il)\s+(?:voce|timbro)|stessa\s+voce|voice\s+(?:reference|identity|timbre)|same\s+voice)\b/i;
const EXACT_AUDIO_VIDEO_PATTERN = /\b(?:audio\s+esatto|traccia\s+esatta|preserva\s+(?:esattamente|identic[oa])\s+(?:quest[oa]\s+)?(?:audio|traccia)|(?:usa|riproduci|pronuncia|recita|fai\s+dire)\b.{0,100}\b(?:esattamente|identic[oa]|integralmente)\b.{0,100}\b(?:audio|traccia|allegat[oa])|(?:esattamente|identic[oa]|integralmente)\b.{0,100}\b(?:audio|traccia)\s+(?:in\s+)?allegat[oa])\b/i;
const REFERENCE_VIDEO_INTENT_PATTERN = /\b(?:come\s+(?:riferimento|reference)|as\s+(?:a\s+)?reference|reference|riferimento|ispirati\s+(?:a|alla|al))\b/i;
const KEEP_SOURCE_ASPECT_PATTERN = /\b(?:mantieni|conserva|preserva)\s+(?:(?:il|le)\s+)?(?:formato|aspect\s+ratio|proporzioni)|\bkeep\s+(?:the\s+)?(?:aspect\s+ratio|format)\b/i;
const KEYFRAME_INTENT_PATTERN = /\b(?:key[\s-]?frames?|fotogramm[io]\s+chiave|(?:primo|iniziale|ultimo|finale|intermedi(?:[oae])?)\s+(?:frame|fotogramm[io])|(?:frame|fotogramm[io])\s+(?:iniziale|finale|intermedi(?:[oae])?))\b/i;
const FIRST_KEYFRAME_PATTERN = /\b(?:(?:primo|iniziale)\s+(?:frame|fotogramma)|(?:frame|fotogramma)\s+iniziale|first\s+(?:frame|keyframe))\b/i;
const LAST_KEYFRAME_PATTERN = /\b(?:(?:ultimo|finale)\s+(?:frame|fotogramma)|(?:frame|fotogramma)\s+finale|last\s+(?:frame|keyframe)|end\s+frame)\b/i;
const INTERMEDIATE_KEYFRAME_PATTERN = /\b(?:intermedi(?:[oae])?|intermediate|middle)\s*(?:frame|fotogramm[io]|key[\s-]?frames?)?|\b(?:frame|fotogramm[io]|key[\s-]?frames?)\s+intermedi(?:[oae])?\b/i;

function formatKeyframePercent(value: number) {
  const rounded = Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export function resolveChatKeyframePositions(content: string, pictureCount: number, totalSeconds: number) {
  const count = Math.max(0, Math.min(9, Math.trunc(pictureCount)));
  if (count < 1) return "AUTO";
  const text = String(content ?? "");
  const defaults = count === 1
    ? [FIRST_KEYFRAME_PATTERN.test(text) ? 0 : INTERMEDIATE_KEYFRAME_PATTERN.test(text) ? 50 : LAST_KEYFRAME_PATTERN.test(text) ? 100 : 0]
    : Array.from({ length: count }, (_, index) => INTERMEDIATE_KEYFRAME_PATTERN.test(text)
      ? ((index + 1) * 100) / (count + 1)
      : (index * 100) / (count - 1));

  const listedPercentages = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)]
    .map((match) => Number(match[1].replace(",", ".")))
    .filter(Number.isFinite);
  if (listedPercentages.length === count) {
    return listedPercentages.map(formatKeyframePercent).join(", ");
  }

  const positions = [...defaults];
  const labeled = /(?:picture|immagine|foto)\s*([1-9])\s*(?:al|a|at|=|:)\s*(?:(secondo|second|time)\s*)?(\d+(?:[.,]\d+)?)\s*(%|s|sec(?:onds?)?|second[io])?/gi;
  for (const match of text.matchAll(labeled)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= count) continue;
    const value = Number(match[3].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const seconds = Boolean(match[2]) || Boolean(match[4] && match[4] !== "%");
    positions[index] = seconds
      ? totalSeconds > 0 ? (value / totalSeconds) * 100 : 0
      : value;
  }
  return positions.map(formatKeyframePercent).join(", ");
}

export function resolveChatVideoMode(
  content: string,
  proposed: PlannedAction["videoMode"],
  pictureCount: number,
  videoCount: number,
  audioCount: number,
) {
  const requested = proposed ?? "T2V";
  if ((requested === "VIDEO EXTENSION" || requested === "VIDEO EDITING") && videoCount > 0) {
    return requested;
  }
  if (pictureCount > 0 && (requested === "KEYFRAMES" || KEYFRAME_INTENT_PATTERN.test(content))) {
    return "KEYFRAMES" as const;
  }
  if (REFERENCE_VIDEO_INTENT_PATTERN.test(content) && pictureCount + videoCount + audioCount > 0) {
    return "R2V" as const;
  }
  if (
    pictureCount > 0 &&
    audioCount > 0 &&
    (requested === "I2V" || I2V_INTENT_PATTERN.test(content) || LIP_SYNC_AUDIO_INTENT_PATTERN.test(content))
  ) {
    return "I2V" as const;
  }
  if (
    audioCount > 0 &&
    (pictureCount === 0 || requested === "R2V") &&
    (requested === "T2V" || requested === "I2V" || requested === "R2V")
  ) {
    return "R2V" as const;
  }
  if (pictureCount > 0 && I2V_INTENT_PATTERN.test(content)) return "I2V" as const;
  if (requested === "R2V" && pictureCount + videoCount + audioCount > 0) return "R2V" as const;
  if (pictureCount > 0 && (requested === "T2V" || requested === "I2V")) return "I2V" as const;
  if ((requested === "VIDEO EXTENSION" || requested === "VIDEO EDITING") && videoCount === 0) {
    return pictureCount > 0 ? "I2V" as const : "T2V" as const;
  }
  if (requested === "I2V" && pictureCount === 0) return "T2V" as const;
  if (requested === "KEYFRAMES" && pictureCount === 0) return "T2V" as const;
  return requested;
}

export function resolveChatVideoAudioRole(
  content: string,
  generationMode: GenerationMode,
  audioCount: number,
): AudioRoutingRole {
  if (audioCount < 1) return "reference_audio";
  const text = String(content ?? "");
  if (
    (generationMode === "I2V" ||
      generationMode === "KEYFRAMES" ||
      generationMode === "R2V") &&
    VOICE_TIMBRE_VIDEO_PATTERN.test(text)
  ) {
    return "voice_ref";
  }
  if (
    (generationMode === "I2V" || generationMode === "R2V") &&
    (EXACT_AUDIO_VIDEO_PATTERN.test(text) ||
      LIP_SYNC_AUDIO_INTENT_PATTERN.test(text))
  ) {
    return "music_video_lipsync";
  }
  return generationMode === "I2V"
    ? "music_video_lipsync"
    : "reference_audio";
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
    "generate_video", "generate_image", "generate_minimax_image", "edit_image", "generate_anima", "generate_tts", "generate_music",
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
    keyframes: { type: "generate_video", videoMode: "KEYFRAMES" },
    keyframe_video: { type: "generate_video", videoMode: "KEYFRAMES" },
    create_image: { type: "generate_image" },
    minimax_image: { type: "generate_minimax_image" },
    h3_image: { type: "generate_minimax_image" },
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
  const videoMode = ["T2V", "I2V", "R2V", "KEYFRAMES", "VIDEO EXTENSION", "VIDEO EDITING"].includes(String(parsed.action.videoMode))
    ? parsed.action.videoMode as PlannedAction["videoMode"]
    : normalizedType.videoMode;
  const aspect = ["16:9", "9:16", "1:1", "4:3", "3:4"].includes(String(parsed.action.aspect))
    ? parsed.action.aspect as PlannedAction["aspect"]
    : "16:9";
  const requestedDuration = Number(parsed.action.durationSeconds);
  const durationSeconds = Number.isFinite(requestedDuration)
    ? Math.min(360, Math.max(5, Math.round(requestedDuration)))
    : undefined;
  const instrumental = parsed.action.instrumental !== false;
  const lyrics = typeof parsed.action.lyrics === "string"
    ? parsed.action.lyrics.trim().slice(0, 30_000)
    : undefined;
  const requestedImageSteps = Number(parsed.action.imageSteps);
  const imageSteps = [8, 12, 20, 30].includes(requestedImageSteps)
    ? requestedImageSteps as PlannedAction["imageSteps"]
    : undefined;
  const rawImageMegapixels = Number(parsed.action.imageMegapixels);
  const requestedImageMegapixels = rawImageMegapixels === 1 ? 0.98 : rawImageMegapixels;
  const imageMegapixels = [0.5, 0.7, 0.98, 2].includes(requestedImageMegapixels)
    ? requestedImageMegapixels as PlannedAction["imageMegapixels"]
    : undefined;
  const maskTarget = typeof parsed.action.maskTarget === "string"
    ? parsed.action.maskTarget.replace(/\s+/g, " ").trim().slice(0, 240)
    : undefined;
  const maskStartSeconds = Number.isFinite(Number(parsed.action.maskStartSeconds))
    ? Math.max(0, Number(parsed.action.maskStartSeconds))
    : undefined;
  const maskEndSeconds = Number.isFinite(Number(parsed.action.maskEndSeconds))
    ? Math.max(0, Number(parsed.action.maskEndSeconds))
    : undefined;
  return { reply, title, action: { type: normalizedType.type, prompt, videoMode, aspect, durationSeconds, imageSteps, imageMegapixels, instrumental, lyrics, maskTarget, maskStartSeconds, maskEndSeconds } };
}

export function resolveChatImageH3Settings(
  request: string,
  plannedSteps?: number,
  plannedMegapixels?: number,
) {
  const explicitSteps = String(request).match(/\b(8|12|20|30)\s*(?:step|steps|passi)\b/i);
  const explicitMegapixels = String(request).match(/\b(0[.,]5|0[.,]7|0[.,]98|1(?:[.,]0)?|2(?:[.,]0)?)\s*(?:mp|megapixel)\b/i);
  const stepNumber = explicitSteps ? Number(explicitSteps[1]) : Number(plannedSteps);
  const mpNumber = explicitMegapixels
    ? Number(explicitMegapixels[1].replace(",", "."))
    : Number(plannedMegapixels);
  const normalizedMp = mpNumber === 1 ? 0.98 : mpNumber;
  return {
    steps: ([8, 12, 20, 30].includes(stepNumber) ? stepNumber : 20) as 8 | 12 | 20 | 30,
    megapixels: ([0.5, 0.7, 0.98, 2].includes(normalizedMp) ? normalizedMp : 0.98) as 0.5 | 0.7 | 0.98 | 2,
  };
}

export function resolveChatImageAspect(request: string, planned?: PlannedAction["aspect"]) {
  const explicit = String(request).match(/\b(16\s*:\s*9|9\s*:\s*16|1\s*:\s*1|4\s*:\s*3|3\s*:\s*4)\b/);
  return (explicit?.[1]?.replace(/\s+/g, "") as PlannedAction["aspect"] | undefined) ?? planned ?? "16:9";
}

export function resolveChatVideoAspectFormat(
  request: string,
  generationMode: GenerationMode,
  planned?: PlannedAction["aspect"],
) {
  const canKeepSourceAspect = [
    "I2V",
    "KEYFRAMES",
    "VIDEO EXTENSION",
    "VIDEO EDITING",
  ].includes(generationMode);
  if (canKeepSourceAspect && KEEP_SOURCE_ASPECT_PATTERN.test(String(request))) {
    return "keep source aspect" as const;
  }
  const aspect = resolveChatImageAspect(request, planned);
  return aspect === "9:16"
    ? "9:16 portrait" as const
    : aspect === "1:1"
      ? "1:1 square" as const
      : aspect === "4:3"
        ? "4:3 landscape" as const
        : aspect === "3:4"
          ? "3:4 portrait" as const
          : "16:9 landscape" as const;
}

export function inferVideoInpaintTarget(request: string) {
  const text = String(request ?? "");
  const direct = text.match(
    /\b(?:cambia|modifica|sostituisci|rimuovi|trasforma|colora|change|modify|replace|remove|transform|recolor)\s+(?:soltanto\s+|solo\s+|only\s+)?(?:il\s+|la\s+|lo\s+|l['’]\s*|the\s+)?([^,.;!?]{2,100})/i,
  )?.[1];
  if (direct) {
    return direct
      .replace(/\b(?:in|con|into|with)\b[\s\S]*$/i, "")
      .replace(/\b(?:quando|after|before|dopo|prima)\b[\s\S]*$/i, "")
      .trim()
      .slice(0, 240);
  }
  return "soggetto principale";
}

const EXPLICIT_INSTRUMENTAL_PATTERN = /\b(?:strumentale|instrumental|senza\s+(?:voce|voci|cantato)|no\s+vocals?|without\s+vocals?)\b/i;
const VOCAL_MUSIC_PATTERN = /\b(?:canta(?:ta|to|re|nte)?|cantato|cantata|cantante|voce|voci|vocale|vocals?|singer|singing|lyrics?|testo\s+(?:cantato|della\s+canzone)|ritornello|chorus)\b/i;
const VOICE_COVER_PATTERN = /\b(?:(?:con|usando|usa|utilizza)\s+(?:la\s+)?mia\s+voce|col\s+mio\s+timbro|(?:con|usando|usa|utilizza)\s+(?:la\s+)?(?:voce|audio|timbro)\s+allegat[oa]|con\s+quest[oa]\s+(?:voce|audio|timbro)|fammi\s+cantare|clona(?:re)?\s+(?:la\s+)?(?:mia\s+)?voce|voice\s+cover|my\s+voice|voice\s+reference|timbro\s+(?:dell['’]?audio|allegato))\b/i;

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

const ANGRY_SPEECH_PATTERN = /\b(?:arrabbiat[oaie]?|furios[oaie]?|rabbia|anger|angry|furious|gridando|urla(?:ndo)?|shout(?:ing)?)\b/i;

export function resolveChatTtsText(plannedText: string, request: string) {
  const sourceRequest = String(request ?? "");
  const contextual = sourceRequest.match(/(?:dice|dica|dire|pronuncia|recita|legge|says?|speak(?:s|ing)?|read(?:s|ing)?)\b[^"“«]{0,120}["“«]([^"”»]{1,20000})["”»]/i)?.[1];
  const quoted = [...sourceRequest.matchAll(/["“«]([^"”»]{1,20000})["”»]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .at(-1);
  const tagged = [...String(plannedText ?? "").matchAll(/<d>\s*(?:\[[^\]]+\]\s*)?([\s\S]*?)\s*<\/d>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join(" ");
  const speech = contextual?.trim() || quoted || tagged || String(plannedText ?? "").trim();
  const existingTokens = String(plannedText ?? "").match(/^(?:\s*<\|(?:emotion|style|prosody|sfx):[^>]+\|>\s*)+/i)?.[0].trim() ?? "";
  const styleTokens = existingTokens || (ANGRY_SPEECH_PATTERN.test(sourceRequest)
    ? "<|emotion:anger|> <|style:shouting|>"
    : "");
  return [styleTokens, speech].filter(Boolean).join(" ");
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
  return value === "video" || value === "krea" || value === "minimax" || value === "anima" || value === "edit" || value === "tts" || value === "music"
    ? value
    : "auto";
}

export function routeAction(action: PlannedAction | null, route: ChatRoute) {
  if (!action || route === "auto") return action;
  const forcedType = route === "video"
    ? "generate_video"
    : route === "krea"
      ? "generate_image"
      : route === "minimax"
        ? "generate_minimax_image"
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
      : route === "minimax"
        ? "generate_minimax_image"
      : route === "anima"
        ? "generate_anima"
        : route === "edit"
          ? "edit_image"
          : route === "tts"
            ? "generate_tts"
            : "generate_music";
  return `ROUTE_OVERRIDE=${route}. If and only if the user explicitly requests media creation, use action type ${action}. The selector alone never authorizes a render.`;
}

const EXPLICIT_MINIMAX_IMAGE_PATTERN = /(?:\b(?:usa|usando|con|tramite|motore)\s+(?:il\s+)?(?:minimax|h3)\b|\b(?:minimax|h3)\s+(?:per|image|immagine|foto)\b)/i;

export function preserveMiniMaxImageIntent(action: PlannedAction | null, request: string, route: ChatRoute = "auto") {
  if (!action) return action;
  if (route === "minimax") return { ...action, type: "generate_minimax_image" } as PlannedAction;
  if (route !== "auto" || !EXPLICIT_MINIMAX_IMAGE_PATTERN.test(request)) return action;
  if (!["generate_image", "edit_image", "generate_anima", "generate_minimax_image"].includes(action.type)) return action;
  return { ...action, type: "generate_minimax_image" } as PlannedAction;
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
{"reply":"Italian confirmation","title":"concise 3-7 word Italian conversation title","action":{"type":"generate_video|generate_image|generate_minimax_image|edit_image|generate_anima|generate_tts|generate_music","prompt":"complete media prompt or exact TTS script","videoMode":"T2V|I2V|R2V|KEYFRAMES|VIDEO EXTENSION|VIDEO EDITING","aspect":"16:9|9:16|1:1|4:3|3:4","durationSeconds":10,"imageSteps":20,"imageMegapixels":0.98,"instrumental":true,"lyrics":"exact requested words to sing or empty string","maskTarget":"short noun phrase to track for VIDEO EDITING","maskStartSeconds":0,"maskEndSeconds":0}}

Only create an action when the user explicitly asks to generate, animate, continue or edit media. Questions and ordinary conversation use action:null.
The title describes the main topic, never starts with "Chat" and never contains quotation marks.
For video default to 10 seconds, one candidate, 0.5 MP and the FAST 8-step engine. When the user explicitly requests a total video duration, preserve it in durationSeconds; the server converts it into up to 12 H3 shots. Do not invent a duration that the user did not request.
Use generate_anima for anime, manga, illustration, drawing or cartoon-style still images, including the Italian words disegno, illustrazione, anime, manga and cartone. Use generate_image for photographic or general Krea still images. Use edit_image only with attached pictures and Flux Klein as the default editor. Use generate_minimax_image only when the user explicitly requests Image H3, MiniMax or H3 for a still image: no attached pictures means T2I, one picture means I2I, and two to nine pictures mean Reference. For Image H3 preserve an explicitly requested aspect, imageSteps (8, 12, 20 or 30) and imageMegapixels (0.5, 0.7, 0.98 or 2); defaults are 20 steps and 0.98 MP. Use I2V when one attached picture is the start frame, R2V for broader video references, KEYFRAMES when attached pictures are requested as first, intermediate, final or timed video frames, VIDEO EXTENSION for continuing an attached video, and VIDEO EDITING for inpainting one attached video. For VIDEO EDITING always set maskTarget to the shortest concrete noun phrase SAM3 must track, for example "vestito della donna", while prompt must retain the requested temporal event such as "when she snaps her fingers". Use maskStartSeconds/maskEndSeconds only when the user gives explicit times; zero means the whole clip. Preserve Picture attachment order for KEYFRAMES; the server calculates percentages from explicit times or distributes them automatically. Video editing and extension still use action type generate_video; never invent video_editing, edit_video or continue_video action types.
Use generate_tts when the user asks for speech, narration, dubbing, reading or voice cloning. For TTS, prompt is the exact text to speak in the requested language, not an English description. An attached Audio 1 is the voice reference and is transcribed automatically.
For a video in which a visible subject must speak or sing to an attached audio track, use I2V when Picture 1 must be the exact opening frame. The server preserves Audio 1 as the authoritative soundtrack and injects synchronized slices while H3 animates the mouth and performance. Use R2V only when the picture is a broader identity/style reference rather than the opening frame, or when a reference video is required. Do not reinterpret the attached track as a mere voice-timbre reference. State that the visible subject physically performs the audible track with natural lip synchronization and stops mouth motion when speech or singing ends; never invent or transcribe words that were not provided as text.
Use generate_music when the user asks for a song, soundtrack, instrumental or music. Put the musical request in prompt, set durationSeconds when requested (default 30), and set instrumental:false whenever singing, a singer, a voice, vocals, lyrics or words to sing are requested. For a vocal song, copy every user-supplied lyric verbatim into lyrics, preserving its language and wording; never translate, summarize or omit quoted words. Use lyrics:"" only for instrumental music or when the user did not supply exact words.
When the user asks for a song sung with an attached voice reference, still use generate_music with instrumental:false. Preserve the attached Audio 1: the server will route it through singing voice conversion after MiniMax Music.
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
        images: [],
      });
      if (!response.ok || !response.text) throw new Error(response.error ?? "LLM non ha risposto");
      rawText = response.text;
      const parsedPlan = normalizePlan(rawText);
      const routedAction = preserveMiniMaxImageIntent(routeAction(parsedPlan.action, route), content, route);
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
              duration: job.request.durationSeconds * job.request.shotCount,
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
        const voiceReference = attachments.find((item) => item.kind === "audio");
        const voiceCover = Boolean(voiceReference && VOICE_COVER_PATTERN.test(originalRequest ?? ""));
        const musicPlan = await this.audioStudio.planMusic({
          idea: originalRequest?.trim() || plan.prompt,
          instrumental: voiceCover ? false : plan.instrumental !== false,
          durationSeconds,
          lyrics: plan.lyrics,
        });
        const job = await this.audioStudio.submit({
          kind: voiceCover ? "voice_cover" : "music",
          projectId,
          caption: musicPlan.caption,
          lyrics: musicPlan.lyrics,
          durationSeconds,
          referenceFile: voiceReference?.file,
        });
        return { type: plan.type, prompt: musicPlan.caption, jobId: job?.id, status: "started" };
      }
      if (plan.type === "generate_tts") {
        await this.comfy.chatUnload().catch(() => undefined);
        const reference = attachments.find((item) => item.kind === "audio");
        const ttsText = resolveChatTtsText(plan.prompt, originalRequest ?? "");
        const job = await this.audioStudio.submit({
          kind: "tts", projectId, text: ttsText,
          referenceFile: reference?.file,
        });
        return { type: plan.type, prompt: ttsText, jobId: job?.id, status: "started" };
      }
      await this.comfy.chatUnload();
      if (plan.type === "generate_video") {
        const requestText = originalRequest ?? "";
        const explicitDuration = extractRequestedVideoDuration(requestText);
        const timing = resolveChatVideoTiming(
          explicitDuration ?? (VIDEO_DURATION_CUE.test(requestText)
            ? plan.durationSeconds
            : undefined),
        );
        const pictures = attachments.filter((item) => item.kind === "picture");
        const videos = attachments.filter((item) => item.kind === "video");
        const audios = attachments.filter((item) => item.kind === "audio");
        const generationMode = resolveChatVideoMode(
          requestText, plan.videoMode, pictures.length, videos.length, audios.length,
        );
        const audioRole = resolveChatVideoAudioRole(
          requestText, generationMode, audios.length,
        );
        let audioIndex = 0;
        const routedAttachments = attachments.map((attachment) => {
          if (attachment.kind !== "audio") return attachment;
          audioIndex += 1;
          return audioIndex === 1
            ? { ...attachment, audio_role: audioRole }
            : attachment;
        });
        const mediaState = generationMode === "T2V" ? [] : routedAttachments;
        const keyframePositions = generationMode === "KEYFRAMES"
          ? resolveChatKeyframePositions(requestText, pictures.length, timing.totalSeconds)
          : "AUTO";
        const job = await this.studioJobs.submit({
          projectId,
          prompt: plan.prompt,
          candidateCount: 1,
          shotCount: timing.shotCount,
          durationSeconds: timing.durationSeconds,
          megapixels: 0.5,
          generationMode,
          aspectFormat: resolveChatVideoAspectFormat(
            requestText,
            generationMode,
            plan.aspect,
          ),
          seedMode: "random",
          qualityMode: "fast",
          // Chat is deliberately predictable: it always uses the configured
          // standard H3/Hybrid engine at 8 steps. PDD remains an explicit
          // Studio-only FAST choice.
          turboEnabled: false,
          mediaState: JSON.stringify(mediaState),
          referenceRoles: "AUTO",
          keyframePositions,
          sourceVideoAudio: "AUTO",
          muteDiegetic: false,
          muteNonDiegetic: false,
          inpaintTarget:
            generationMode === "VIDEO EDITING"
              ? plan.maskTarget || inferVideoInpaintTarget(requestText)
              : "",
          inpaintMaskGrow: 8,
          inpaintStartSeconds: plan.maskStartSeconds ?? 0,
          inpaintEndSeconds: plan.maskEndSeconds ?? 0,
        });
        return { type: plan.type, prompt: plan.prompt, jobId: job?.id, status: "started" };
      }
      const minimaxImage = plan.type === "generate_minimax_image";
      const availablePictures = attachments.filter((item) => item.kind === "picture");
      const imageMode = plan.type === "edit_image" || (minimaxImage && availablePictures.length > 0) ? "edit" : plan.type === "generate_anima" ? "anima" : "generate";
      const imageReferences = availablePictures.slice(0, minimaxImage ? 9 : 4);
      if (imageMode === "edit" && !imageReferences.length) throw new Error("L'edit richiede almeno una immagine allegata");
      const imageRequestText = originalRequest ?? "";
      const aspect = resolveChatImageAspect(imageRequestText, plan.aspect);
      const h3Settings = resolveChatImageH3Settings(
        imageRequestText,
        plan.imageSteps,
        plan.imageMegapixels,
      );
      const [ratioWidth, ratioHeight] = aspect === "9:16"
        ? [9, 16]
        : aspect === "1:1"
          ? [1, 1]
          : aspect === "4:3"
            ? [4, 3]
            : aspect === "3:4"
              ? [3, 4]
              : [16, 9];
      const ratio = ratioWidth / ratioHeight;
      const h3Area = h3Settings.megapixels * 1024 * 1024;
      const width = minimaxImage
        ? Math.max(64, Math.round(Math.sqrt(h3Area * ratio) / 32) * 32)
        : aspect === "1:1" ? 1024 : aspect === "9:16" || aspect === "3:4" ? 768 : 1344;
      const height = minimaxImage
        ? Math.max(64, Math.round(Math.sqrt(h3Area / ratio) / 32) * 32)
        : aspect === "1:1" ? 1024 : aspect === "9:16" || aspect === "3:4" ? 1344 : 768;
      const job = await this.imageStudio.submit({
        projectId,
        mode: imageMode,
        engine: minimaxImage ? "minimax" : "default",
        prompt: plan.prompt,
        compositionPreset: "free",
        candidateCount: 1,
        aspectFormat: aspect,
        width,
        height,
        h3Steps: minimaxImage ? h3Settings.steps : undefined,
        h3Megapixels: minimaxImage ? h3Settings.megapixels : undefined,
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

import type { ComfyApiPrompt } from "./comfy-client.js";
import type { LlmProviderService } from "./llm-provider.js";
import type { StudioJobRequest } from "./studio-job.js";

function mediaCounts(mediaState: string) {
  const items = JSON.parse(mediaState || "[]") as Array<{
    kind?: unknown;
    audio_role?: unknown;
  }>;
  const firstAudio = items.find((item) => item.kind === "audio");
  return {
    pictures: items.filter((item) => item.kind === "picture").length,
    videos: items.filter((item) => item.kind === "video").length,
    audios: items.filter((item) => item.kind === "audio").length,
    audioRole: typeof firstAudio?.audio_role === "string"
      ? firstAudio.audio_role
      : "reference_audio",
  };
}

function extractJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Il Planner remoto non ha restituito JSON");
  const text = fenced.slice(start, end + 1);
  const value = JSON.parse(text) as { mode?: unknown; shots?: unknown };
  if (!Array.isArray(value.shots) || value.shots.length < 1) {
    throw new Error("Il Planner remoto ha restituito un piano senza shot");
  }
  return { text, value };
}

const EXTERNAL_SOUNDTRACK_ROLES = new Set([
  "music_video_lipsync",
  "exact_soundtrack",
  "exact_soundtrack_plus_h3_sfx",
]);

function modeTaskTypes(mode: StudioJobRequest["generationMode"], audioRole: string) {
  const required: Record<StudioJobRequest["generationMode"], string> = {
    T2V: "",
    I2V: "",
    R2V: "reference generation",
    KEYFRAMES: "keyframe completion",
    "VIDEO EXTENSION": "video continuation",
    "VIDEO EDITING": "video editing",
  };
  const values = required[mode] ? [required[mode]] : [];
  if (audioRole === "voice_ref" || audioRole === "reference_audio") {
    values.push("audio reference");
  }
  return values;
}

export function validateRemoteVideoPlan(raw: string, request: StudioJobRequest) {
  const { text, value } = extractJson(raw);
  if (String(value.mode ?? "").toUpperCase() !== request.generationMode) {
    throw new Error("Il Planner remoto ha restituito una modalita video diversa");
  }
  if ((value.shots as unknown[]).length !== request.shotCount) {
    throw new Error(
      `Il Planner remoto ha restituito ${(value.shots as unknown[]).length} clip invece di ${request.shotCount}`,
    );
  }
  const media = mediaCounts(request.mediaState);
  const forceNoMusic = request.muteNonDiegetic || EXTERNAL_SOUNDTRACK_ROLES.has(media.audioRole);
  const fullReferenceMode = request.generationMode !== "T2V" && request.generationMode !== "I2V";
  let changed = false;
  for (const [index, rawShot] of (value.shots as unknown[]).entries()) {
    if (!rawShot || typeof rawShot !== "object" || Array.isArray(rawShot)) {
      throw new Error(`Il Planner remoto ha restituito uno shot ${index + 1} non valido`);
    }
    const shot = rawShot as Record<string, unknown>;
    if (typeof shot.description !== "string" || !shot.description.trim()) {
      throw new Error(`Il Planner remoto ha restituito uno shot ${index + 1} senza descrizione`);
    }
    if (forceNoMusic && String(shot.music ?? "N/A").trim().toUpperCase() !== "N/A") {
      shot.music = "N/A";
      changed = true;
    }
    if (request.muteDiegetic && String(shot.soundscape ?? "N/A").trim().toUpperCase() !== "N/A") {
      shot.soundscape = "N/A";
      changed = true;
    }
    const description = shot.description;
    if (media.audioRole === "music_video_lipsync") {
      const replaced = description.replace(/<\s*Audio\s+1\s*>/gi, "<Soundtrack>");
      const synchronized = /<\s*Soundtrack\s*>/i.test(replaced)
        ? replaced
        : `${replaced.trim()} Visible action and performance remain synchronized to <Soundtrack>.`;
      if (synchronized !== description) {
        shot.description = synchronized;
        changed = true;
      }
      if (fullReferenceMode && JSON.stringify(shot.active_ref_audios) !== "[]") {
        shot.active_ref_audios = [];
        changed = true;
      }
    } else if (
      media.audioRole === "ignore" ||
      media.audioRole === "exact_soundtrack" ||
      media.audioRole === "exact_soundtrack_plus_h3_sfx"
    ) {
      const replaced = description.replace(
        /<\s*Audio\s+1\s*>/gi,
        media.audioRole === "ignore" ? "the ignored source audio" : "the externally muxed soundtrack",
      );
      if (replaced !== description) {
        shot.description = replaced;
        changed = true;
      }
      if (fullReferenceMode && JSON.stringify(shot.active_ref_audios) !== "[]") {
        shot.active_ref_audios = [];
        changed = true;
      }
    } else if (fullReferenceMode && (media.audioRole === "voice_ref" || media.audioRole === "reference_audio")) {
      const mutedVoice = media.audioRole === "voice_ref" && request.muteDiegetic;
      if (mutedVoice) {
        const replaced = description.replace(/<\s*Audio\s+1\s*>/gi, "the muted source voice");
        if (replaced !== description) {
          shot.description = replaced;
          changed = true;
        }
      }
      const scheduled = !mutedVoice && /<\s*Audio\s+1\s*>/i.test(description) ? [1] : [];
      if (JSON.stringify(shot.active_ref_audios) !== JSON.stringify(scheduled)) {
        shot.active_ref_audios = scheduled;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(value) : text;
}

export function injectRemoteVideoPlan(prompt: ComfyApiPrompt, response: string) {
  const entries = Object.entries(prompt).filter(([, node]) =>
    node.class_type === "H3AIOComposerPreValidator"
  );
  if (entries.length !== 1) {
    throw new Error("Workflow H3 incompatibile: pre-validatore planner non trovato");
  }
  entries[0][1].inputs.llm_response = response;
}

export async function planH3Video(
  llm: LlmProviderService,
  request: StudioJobRequest,
) {
  const media = mediaCounts(request.mediaState);
  const baseMode = request.generationMode === "T2V" || request.generationMode === "I2V";
  const taskTypes = modeTaskTypes(
    request.generationMode,
    request.muteDiegetic && media.audioRole === "voice_ref" ? "ignore" : media.audioRole,
  );
  const schema = baseMode
    ? `{"mode":"${request.generationMode}","continuity_bible":"immutable visual facts","shots":[{"description":"[Shot 1] ...","soundscape":"...","music":"..."}]}`
    : `{"mode":"${request.generationMode}","subject_definitions":"...","task_types":${JSON.stringify(taskTypes)},"summary":"...","retention_analysis":"...","style":"...","shots":[{"description":"[Shot 1] ...","soundscape":"...","music":"N/A","active_ref_images":[1],"active_ref_videos":[1],"active_ref_audios":[1]}]}`;
  const routedAudioRule: Record<string, string> = {
    music_video_lipsync: "Audio 1 is the authoritative external soundtrack routed by the sampler, not a normal H3 reference. In every clip cite the literal marker <Soundtrack> and describe visible mouth activity, rests and performance synchronized to what is actually audible. Never invent or transcribe words, never use the marker <Audio 1>, and set every active_ref_audios array to [].",
    exact_soundtrack: "Audio 1 is added only during final mux. Never bind it as an H3 reference, never use the marker <Audio 1>, never add audio reference or audio reuse to task_types, and set every active_ref_audios array to [].",
    exact_soundtrack_plus_h3_sfx: "Audio 1 is added only during final mux. Never bind it as an H3 reference, never use the marker <Audio 1>, never add audio reference or audio reuse to task_types, and set every active_ref_audios array to []. If diegetic sound is enabled, generate only scene effects and ambience.",
    voice_ref: request.muteDiegetic
      ? "Audio 1 supplies voice identity only, but diegetic audio is muted: do not generate dialogue or voices, do not use <Audio 1>, omit audio reference/audio reuse from task_types, and set every active_ref_audios array to []."
      : "Audio 1 supplies voice identity only. Preserve newly requested dialogue verbatim inside <d>[Language] ...</d>, describe exact lip synchronization, use the marker <Audio 1> only while the subject speaks, and include audio reference in task_types.",
    ignore: "Ignore Audio 1 completely. Never use the marker <Audio 1>, never add audio reference or audio reuse to task_types, and set every active_ref_audios array to [].",
    reference_audio: "Use the marker <Audio 1> only where the request needs this H3 audio reference, include audio reference in task_types, and schedule active_ref_audios:[1] exactly in those clips.",
  };
  const audioRule = [
    routedAudioRule[media.audioRole] ?? routedAudioRule.reference_audio,
    request.muteNonDiegetic || EXTERNAL_SOUNDTRACK_ROLES.has(media.audioRole)
      ? "Every music field must be N/A."
      : "Use generated music only when requested; otherwise use N/A.",
    `Reference schedules use only valid one-based indexes: Picture 1..${media.pictures}, Video 1..${media.videos}, Audio 1..${media.audios}.`,
  ].join(" ");
  const soundRule = request.muteDiegetic
    ? "Every soundscape field must be N/A."
    : "Describe synchronized diegetic sound, or N/A when silence is requested.";
  const modeRule: Record<StudioJobRequest["generationMode"], string> = {
    T2V: "Generate entirely from text and ignore loaded media.",
    I2V: "Picture 1 is the exact opening frame. Preserve every visible fact and continue forward without an unrequested cut or reframing.",
    R2V: "Use only the supplied references and the stated role map. Never invent unseen reference attributes.",
    KEYFRAMES: "Picture 1..N are concrete timeline keyframes in loader order. Reach all of them at the configured positions.",
    "VIDEO EXTENSION": "Continue Video 1 from its exact final frame without restarting it.",
    "VIDEO EDITING": "Video 1 is the direct temporal source. Preserve timing, composition and all unspecified content exactly.",
  };
  const response = await llm.generate({
    purpose: "planner",
    maxTokens: 8_192,
    temperature: 0.1,
    topP: 0.9,
    messages: [
      {
        role: "system",
        content: `You are the strict MiniMax H3 production planner for H3 Studio.
Return exactly one valid JSON object, without Markdown, comments or trailing commas.
Write production prompts in English, but preserve dialogue, lyrics and visible text verbatim in their original language.
Create exactly the requested number of generated clips. Each shots[].description must begin with exactly [Shot 1] and must cover the full clip duration.
Inside each clip use chronological prose and optional internal [Shot N] timestamps only when the user explicitly requests cuts or multiple camera setups.
Descriptions must be concrete: composition, visible subjects, environment, action and body mechanics, camera behavior, light, secondary motion and a stable ending.
For T2V and I2V continuity_bible is mandatory and must contain immutable recurring visual facts, never actions.
For reference modes define every used asset conservatively, include a retention analysis, and use only valid one-based active reference indexes.
Never add characters, objects, transformations, camera cuts or dialogue the user did not request.
Follow the supplied JSON schema exactly.`,
      },
      {
        role: "user",
        content: [
          `MODE: ${request.generationMode}`,
          `CLIPS: exactly ${request.shotCount}`,
          `SECONDS_PER_CLIP: ${request.durationSeconds}`,
          `AVAILABLE: ${media.pictures} pictures, ${media.videos} videos, ${media.audios} audio files`,
          `REFERENCE_ROLES: ${request.referenceRoles}`,
          `KEYFRAME_POSITIONS: ${request.keyframePositions}`,
          `SOURCE_VIDEO_AUDIO: ${request.sourceVideoAudio}`,
          `MODE_RULE: ${modeRule[request.generationMode]}`,
          `AUDIO_RULES: ${soundRule} ${audioRule}`,
          `JSON_SCHEMA: ${schema}`,
          `USER_REQUEST:\n${request.prompt}`,
        ].join("\n\n"),
      },
    ],
  });
  if (!response.ok || !response.text?.trim()) {
    throw new Error(response.error ?? "Planner video remoto non disponibile");
  }
  return {
    response: validateRemoteVideoPlan(response.text, request),
    backend: response.backend,
    fallbackUsed: response.fallbackUsed,
  };
}

# -*- coding: utf-8 -*-
"""MiniMax Music3 -> H3 Reference Memory music-video helpers.

This module is intentionally additive. Existing H3 samplers keep their exact
inputs and behaviour; the music-video sampler adds a different soundtrack
reference slice to every shot and exposes both H3's jointly generated audio
and the untouched Music3 waveform for the final mux.
"""

import copy
import json
import math
import os
import re
from datetime import datetime

from . import h3_multishot_refs as h3_refs
from .h3_reference_memory import H3ReferenceMemorySampler
from .h3_multishot_utils import (
    H3MultishotSampler,
    _MasterFrameStore,
    _auto_ctx,
    _auto_measure_begin,
    _auto_measure_end,
    _parse_script,
    _xfade_audio,
)


VALID_SHOT_SECONDS = (5, 10, 15, 20, 25, 30)
SHOT_FRAMES = {5: 124, 10: 243, 15: 362, 20: 481, 25: 600, 30: 719}
SECTION_KEYS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)

PICTURE_1_IDENTITY_LOCK = (
    "<Subject 1> is exactly the person shown in <Picture 1>; preserve the "
    "same face, gender presentation, body and hair throughout. Preserve the "
    "wardrobe from <Picture 1> unless another active reference is explicitly "
    "assigned as the costume or outfit for this shot."
)

PICTURE_1_H3_GENERATED_VOCAL_LOCK = (
    "[joint audio-video generation] <Subject 1> (S1) generates and performs "
    "the exact lyrics provided in the dialogue block, in the explicitly stated language, "
    "using <Soundtrack> as the musical foundation. Use <VoiceReference> only "
    "as the vocal timbre and voice-identity reference; never copy its spoken "
    "words, accent language or linguistic content. The jointly generated "
    "voice, mouth shapes, syllables, breathing and facial performance remain "
    "precisely synchronized. During intentional instrumental gaps and rests, "
    "the lips return naturally to rest while body movement may continue."
)

PICTURE_1_SOUNDTRACK_ACTIVITY_LOCK = (
    "[audio reference] <Subject 1> follows the actual audible state of "
    "<Soundtrack>. Only while a lead vocal is clearly audible, <Subject 1> "
    "performs it with precise lip synchronization, matching the audible "
    "syllables, phrasing, breaths and emotional delivery. During every "
    "instrumental passage, vocal pause, silent gap or breath without "
    "phonation, <Subject 1> immediately stops articulating; the lips return "
    "to a natural resting position while body movement and facial expression "
    "may continue with the music. Never invent mouth articulation from text "
    "when no vocal is audible in <Soundtrack>."
)

PICTURE_1_CONTINUOUS_LIPSYNC_LOCK = (
    "[audio reference] <Subject 1> performs the audible lead vocal from "
    "<Soundtrack> throughout this performance shot with precise synchronized "
    "mouth shapes, syllable timing, breathing and facial performance."
)

PICTURE_1_NO_LIPSYNC_LOCK = (
    "<Subject 1> does not sing or lip-sync in this shot. The mouth remains "
    "naturally at rest except for ordinary non-verbal facial expression, "
    "while movement may continue in time with <Soundtrack>."
)


def _snap_shot_seconds(value):
    value = int(round(float(value)))
    return min(VALID_SHOT_SECONDS, key=lambda candidate: abs(candidate - value))


def _close_unbalanced_json_suffix(text):
    """Close only trailing JSON containers that are otherwise well nested."""
    pairs = {"{": "}", "[": "]"}
    stack = []
    in_string = False
    escaped = False

    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char in pairs:
            stack.append(char)
        elif char in ("}", "]"):
            if not stack or pairs[stack[-1]] != char:
                return text
            stack.pop()

    if in_string or not stack:
        return text
    return text + "".join(pairs[char] for char in reversed(stack))


def _extract_json(text):
    text = str(text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.I | re.S)
    if fence:
        text = fence.group(1).strip()

    candidates = [text]
    start = text.find("{")
    end = max(text.rfind("}"), text.rfind("]"))
    if start >= 0 and end > start:
        extracted = text[start:end + 1]
        if extracted != text:
            candidates.append(extracted)

    first_error = None
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as error:
            if first_error is None:
                first_error = error

        repaired = _close_unbalanced_json_suffix(candidate)
        if repaired != candidate:
            try:
                result = json.loads(repaired)
                missing = len(repaired) - len(candidate)
                print(
                    "[H3JSON] repaired %d missing trailing JSON closer(s)."
                    % missing)
                return result
            except json.JSONDecodeError:
                pass

    if first_error is not None:
        raise first_error
    raise ValueError(
        "LLM did not return valid project JSON. Use temperature 0 and "
        "keep the supplied planner instruction unchanged.")


def _section_text(value):
    if isinstance(value, list):
        return "\n".join(
            str(item).strip() for item in value if str(item).strip())
    return str(value or "").strip()


def _normalise_music_audio_markers(value):
    """Replace planner-facing legacy audio markers with routed placeholders."""
    if isinstance(value, dict):
        return {
            key: _normalise_music_audio_markers(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_normalise_music_audio_markers(item) for item in value]
    if isinstance(value, str):
        return re.sub(
            r"<Audio\s*1>", "<VoiceReference>", value,
            flags=re.I)
    return value



def _music_debug_base(filename_prefix):
    """Return a unique, output-root-contained path without an extension."""
    import folder_paths

    output_root = os.path.realpath(folder_paths.get_output_directory())
    raw = str(filename_prefix or "H3_MUSIC_VIDEO_DEBUG/llm_plan")
    parts = [
        re.sub(r"[^\w. -]+", "_", part, flags=re.UNICODE).strip(" .")
        for part in raw.replace("\\", "/").split("/")
        if part.strip() not in ("", ".", "..")
    ]
    if not parts:
        parts = ["H3_MUSIC_VIDEO_DEBUG", "llm_plan"]
    stem = parts[-1] or "llm_plan"
    folder = os.path.realpath(os.path.join(output_root, *parts[:-1]))
    if os.path.commonpath([output_root, folder]) != output_root:
        raise ValueError("Debug output path must remain inside ComfyUI/output.")
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return os.path.join(folder, "%s_%s" % (stem, stamp))


def _write_music_debug(base_path, suffix, text):
    path = base_path + suffix
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(str(text or ""))
        if text and not str(text).endswith("\n"):
            handle.write("\n")
    return path


_LANGUAGE_ALIASES = (
    ("Italian", ("italian", "italiano", "italiana")),
    ("English", ("english", "inglese")),
    ("Spanish", ("spanish", "español", "spagnolo")),
    ("French", ("french", "français", "francese")),
    ("German", ("german", "deutsch", "tedesco")),
    ("Portuguese", ("portuguese", "português", "portoghese")),
    ("Japanese", ("japanese", "日本語", "giapponese")),
    ("Korean", ("korean", "한국어", "coreano")),
    ("Chinese", ("chinese", "中文", "cinese")),
    ("Turkish", ("turkish", "türkçe", "turco")),
    ("Arabic", ("arabic", "العربية", "arabo")),
    ("Russian", ("russian", "русский", "russo")),
)


def _resolve_lyrics_language(data, caption, lyrics, override):
    override = str(override or "auto_from_plan").strip()
    if override and override != "auto_from_plan":
        return override

    declared = _section_text(data.get("lyrics_language"))
    haystack = "\n".join((declared, str(caption), str(lyrics))).lower()
    for canonical, aliases in _LANGUAGE_ALIASES:
        if any(alias.lower() in haystack for alias in aliases):
            return canonical
    return "Original language"


def _clean_lyric_lines(lyrics):
    lines = []
    for raw_line in str(lyrics or "").splitlines():
        line = raw_line.strip()
        if not line or re.fullmatch(r"\[[^\]]+\]", line):
            continue
        lines.append(line)
    return lines


def _assign_lyrics_to_vocal_shots(shots, lyrics, language):
    """Put every exact lyric line into one and only one vocal shot."""
    result = copy.deepcopy(list(shots))
    vocal_indices = [
        index for index, shot in enumerate(result)
        if isinstance(shot, dict) and _visible_vocal_performance(
            shot, shot.get("detailed_description"))
    ]
    lines = _clean_lyric_lines(lyrics)
    if not lines or not vocal_indices:
        return result

    total_lines = len(lines)
    total_shots = len(vocal_indices)
    for order, shot_index in enumerate(vocal_indices):
        start = round(order * total_lines / total_shots)
        end = round((order + 1) * total_lines / total_shots)
        assigned = lines[start:end]
        shot = result[shot_index]
        if not assigned:
            shot["vocal_performance"] = False
            continue

        lyric_text = "\n".join(assigned)
        lyric_block = "<d>[%s] %s</d>" % (language, lyric_text)
        detail = _section_text(shot.get("detailed_description"))
        # LLM may place several timed <d> blocks in a shot. Remove all of
        # those provisional assignments first, then append one canonical
        # parser-owned block. Previously the first replacement was deleted by
        # the cleanup regex immediately afterwards, leaving H3 no lyrics.
        detail = re.sub(
            r"\s*<d>.*?</d>", "", detail,
            flags=re.I | re.S).rstrip()
        detail = (
            detail + "\n"
            "<Subject 1> (S1) sings these exact words in %s, without "
            "translation, substitution or invented syllables:\n%s"
            % (language, lyric_block)
        )
        shot["detailed_description"] = detail
        shot["assigned_lyrics"] = lyric_text
        shot["lyrics_language"] = language
    return result


def _soundtrack_driven_dialogue(text):
    """Remove guessed lyric timing that was planned before Music3 existed."""
    return re.sub(
        r"<d>.*?</d>",
        "the currently audible lead-vocal phrase in <Soundtrack>",
        str(text or ""),
        flags=re.I | re.S,
    )


def _visible_vocal_performance(shot, detailed_description):
    explicit = shot.get("vocal_performance")
    if isinstance(explicit, bool):
        return explicit
    if isinstance(explicit, str):
        value = explicit.strip().lower()
        if value in ("true", "yes", "on", "singing", "performance"):
            return True
        if value in ("false", "no", "off", "instrumental", "narrative"):
            return False

    # Legacy plans did not have vocal_performance. Infer only from an action
    # explicitly assigned to Subject 1 inside the visual description. Merely
    # mentioning a vocal, lyrics or soundtrack elsewhere must not animate the
    # reference person's mouth.
    detail = str(detailed_description or "")
    subject_action = re.compile(
        r"(?is)(?:<Subject\s*1>|lead performer|lead singer|the performer)"
        r".{0,180}?\b(?:sing(?:s|ing)?|lip[- ]?sync(?:s|ing)?|performs?\s+"
        r"(?:the\s+)?(?:lead\s+)?vocal)\b"
    )
    return bool(subject_action.search(detail))


def _shot_to_prompt(shot, lip_sync_mode="h3_generate_vocals"):
    if isinstance(shot, str):
        text = shot.strip()
        missing = [
            key for key in SECTION_KEYS
            if not re.search(r"(?mi)^\s*%s\s*:" % re.escape(key), text)]
        if missing:
            raise ValueError(
                "A video shot is missing full-reference sections: %s"
                % ", ".join(missing))
        return text
    if not isinstance(shot, dict):
        raise ValueError("Every shots[] entry must be an object or a string.")
    missing = [
        key for key in SECTION_KEYS if not _section_text(shot.get(key))]
    if missing:
        raise ValueError(
            "A video shot is missing full-reference fields: %s"
            % ", ".join(missing))
    active = shot.get("active_pictures")
    if active is None:
        # Accept the early planner-field spelling as a compatibility alias.
        active = shot.get("active_picture_references", [])
    if isinstance(active, str):
        active = [int(v) for v in re.findall(r"\d+", active)]
    active = sorted({int(v) for v in (active or []) if int(v) > 0})
    sections = {
        key: _section_text(shot[key])
        for key in SECTION_KEYS
    }
    if 1 in active:
        # The local GGUF planner is deliberately text-only and cannot inspect
        # Picture 1. Add a deterministic identity rule after planning so an
        # invented gender, costume or character archetype cannot silently
        # replace the actual reference subject. The exact marker also keeps
        # Picture 1 bound in every reference-enabled shot.
        sections["subject_definitions"] = (
            PICTURE_1_IDENTITY_LOCK + "\n" +
            sections["subject_definitions"]
        )
        sections["retention_analysis"] = (
            "<Picture 1>: fully_preserved - identity source for <Subject 1>.\n"
            + sections["retention_analysis"]
        )
        visible_vocal = _visible_vocal_performance(
            shot, sections["detailed_description"])
        if visible_vocal and lip_sync_mode != "off":
            if lip_sync_mode == "soundtrack_activity":
                sections["summary"] = (
                    "<Soundtrack> supplies the actual audible lead-vocal "
                    "timing for this shot.\n" + sections["summary"]
                )
                sections["detailed_description"] = (
                    _soundtrack_driven_dialogue(
                        sections["detailed_description"])
                )
                lip_lock = PICTURE_1_SOUNDTRACK_ACTIVITY_LOCK
            elif lip_sync_mode == "h3_generate_vocals":
                sections["summary"] = (
                    "H3 jointly generates the exact dialogue-block lead vocal and its "
                    "synchronized visual performance over <Soundtrack>.\n" +
                    sections["summary"]
                )
                lip_lock = PICTURE_1_H3_GENERATED_VOCAL_LOCK
            else:
                sections["summary"] = (
                    "<Soundtrack> supplies the lead-vocal timing for this "
                    "continuous performance shot.\n" + sections["summary"]
                )
                lip_lock = PICTURE_1_CONTINUOUS_LIPSYNC_LOCK
            sections["detailed_description"] = (
                lip_lock + "\n" +
                sections["detailed_description"]
            )
        elif not visible_vocal or lip_sync_mode == "off":
            sections["detailed_description"] = (
                PICTURE_1_NO_LIPSYNC_LOCK + "\n" +
                sections["detailed_description"]
            )
    lines = []
    if active:
        lines.append(
            "__H3_ACTIVE_PICTURES__: " + ",".join(map(str, active)))
    elif (shot.get("active_pictures") is not None
          or shot.get("active_picture_references") is not None):
        lines.append("__H3_ACTIVE_PICTURES__: none")
    for key in SECTION_KEYS:
        lines.append("%s:\n%s" % (key, sections[key]))
    return "\n\n".join(lines)


class H3MusicVideoPromptKit:
    """Build the strict LLM planning request and H3 grid parameters."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "creative_brief": ("STRING", {
                "multiline": True,
                "default": "A performance-led music video with coherent visual storytelling.",
                "tooltip": "Describe song, story, performer, locations and how each reference should be used."}),
            "reference_roles": ("STRING", {
                "multiline": True,
                "default": "<Picture 1> defines the lead performer. Describe any other active pictures here without inventing their appearance.",
                "tooltip": "Semantic map for Picture 1..9. The LLM cannot infer disconnected images by itself."}),
            "lyrics_or_dialogue": ("STRING", {
                "multiline": True,
                "default": "AUTO: write suitable lyrics in the language requested by the creative brief.",
                "tooltip": "Exact lyrics, lyric idea, or AUTO. Exact supplied words must be preserved."}),
            "song_seconds": ("INT", {
                "default": 60, "min": 5, "max": 360, "step": 5}),
            "shot_seconds": ("INT", {
                "default": 10, "min": 5, "max": 15, "step": 5}),
            "picture_count": ("INT", {
                "default": 1, "min": 0, "max": 9, "step": 1}),
        }}

    RETURN_TYPES = ("STRING", "INT", "INT", "FLOAT")
    RETURN_NAMES = (
        "planner_request", "planned_shots",
        "frames_per_shot", "song_seconds")
    FUNCTION = "build"
    CATEGORY = "utils/minimax/music video"
    DESCRIPTION = (
        "Creates the strict one-call LLM request for Music3 plus H3 "
        "full-reference shot prompts.")

    def build(self, creative_brief, reference_roles, lyrics_or_dialogue,
              song_seconds, shot_seconds, picture_count):
        shot_seconds = _snap_shot_seconds(shot_seconds)
        shot_count = int(math.ceil(float(song_seconds) / shot_seconds))
        request = """Create ONE MiniMax Music3 + MiniMax H3 music-video project.
Return valid JSON only, without Markdown, comments, or trailing commas, using exactly:
{{
  "music_caption": "Global Metadata: ...\\n\\nVocal Details: ...\\n\\nArrangement: ...",
  "lyrics": "[Intro]...\\n[Verse]...\\n[Chorus]...\\n[Outro]...",
  "lyrics_language": "Italian",
  "shots": [
    {{
      "active_pictures": [1],
      "vocal_performance": true,
      "subject_definitions": "...",
      "summary": "[reference generation + audio reference] ...",
      "retention_analysis": "...",
      "detailed_description": "...",
      "overall_soundscape": "...",
      "non_diegetic_music": "..."
    }}
  ]
}}

Hard requirements:
- Write exactly {shot_count} shots; each is about {shot_seconds} seconds.
- Every shots[] object is an independent complete H3 full-reference prompt with all six fields.
- Write prompt prose in English. Preserve supplied lyrics/dialogue and visible text in their original language.
- Use stable <Subject N> identities. Use only <Picture 1>..<Picture {picture_count}> that are actually active for that shot.
- When <Picture 1> defines the lead performer, never infer or invent gender, age, ethnicity, face, body, hair, wardrobe, hood, mask or accessories. Refer to the person neutrally as <Subject 1> or the lead performer unless the user explicitly supplied an attribute in the creative brief or reference-role map. Picture 1 alone defines visible identity.
- Every shot with Picture 1 active must preserve its identity. Preserve Picture 1 wardrobe unless another active reference is explicitly assigned as the costume or outfit.
- Keep Music3 vocal descriptions gender-neutral unless the user explicitly requests a vocal gender or voice type. Do not let an invented vocal persona redefine the visible performer.
- Put selected one-based image numbers in active_pictures. Do not reveal a character before the story calls for it.
- Use <Soundtrack> as the synchronized song slice in every shot. Define it in subject_definitions, use [audio reference] in summary, mark it as reference in retention_analysis, and cite it where beat/performance/lip movement is synchronized.
- Never write a literal <Audio N> marker. Use <VoiceReference> only for the optional voice-timbre identity reference and <Soundtrack> only for the generated song slice. Never use <VoiceReference> as lyrics, language, timing or musical content.
- Set vocal_performance to true only when <Subject 1> visibly sings in that shot; set it to false for narrative, cutaway, instrumental or listening shots.
- Set lyrics_language to the exact requested language using an English language name such as Italian, English, Japanese or Korean.
- For a visible singer, distribute the intended lyrics across the performance shots and place the exact words for each shot inside <d>[Language] ...</d>. The deterministic parser will verify and replace these assignments from the global lyrics before H3 runs.
- H3 may jointly generate those vocals and matching mouth motion over the musical reference. Never assume that vocals fill an entire shot: explicitly keep the lips naturally at rest during intentional instrumental passages and vocal pauses.
- The final master can select either H3-generated audio or the original Music3 waveform. Do not conflate those two modes.
- In detailed_description, first establish style, then [Shot 1] with no timestamp. Additional camera cuts inside that clip use increasing timestamps below {shot_seconds}. Keep final framing suitable for continuity into the next generated clip.
- Music caption uses three detailed sections: Global Metadata, Vocal Details, Arrangement.
- Lyrics use executable section tags such as [Intro], [Verse], [Chorus], [Bridge], [Instrumental], [Outro].

CREATIVE BRIEF:
{creative_brief}

REFERENCE ROLE MAP ({picture_count} picture inputs enabled):
{reference_roles}

LYRICS OR DIALOGUE:
{lyrics_or_dialogue}
""".format(
            shot_count=shot_count,
            shot_seconds=shot_seconds,
            picture_count=picture_count,
            creative_brief=str(creative_brief).strip(),
            reference_roles=str(reference_roles).strip(),
            lyrics_or_dialogue=str(lyrics_or_dialogue).strip(),
        )
        return (
            request, shot_count, SHOT_FRAMES[shot_seconds],
            float(song_seconds))


class H3ExternalSongPromptKit(H3MusicVideoPromptKit):
    """Build an H3 plan whose length is derived from an input song."""

    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()["required"]
        return {"required": {
            "creative_brief": inputs["creative_brief"],
            "reference_roles": inputs["reference_roles"],
            "lyrics_or_dialogue": inputs["lyrics_or_dialogue"],
            "soundtrack": ("AUDIO", {
                "tooltip": "Any complete song. Its waveform determines the "
                           "number of H3 shots and the exact final duration."}),
            "shot_seconds": inputs["shot_seconds"],
            "picture_count": inputs["picture_count"],
        }}

    RETURN_TYPES = ("STRING", "INT", "INT", "FLOAT", "INT", "AUDIO")
    RETURN_NAMES = (
        "planner_request", "planned_shots", "frames_per_shot",
        "song_seconds", "target_frames", "soundtrack")
    FUNCTION = "build_external"
    DESCRIPTION = (
        "Reads an external song, calculates the required 5/10/15-second H3 "
        "clips including the one-frame memory overlap, and builds the LLM "
        "planning request.")

    def build_external(self, creative_brief, reference_roles,
                       lyrics_or_dialogue, soundtrack, shot_seconds,
                       picture_count):
        wav, sample_rate = _normalise_audio(soundtrack)
        sample_count = int(wav.shape[-1])
        if sample_rate <= 0 or sample_count <= 0:
            raise ValueError("The external soundtrack is empty or invalid.")
        duration = sample_count / float(sample_rate)
        shot_seconds = _snap_shot_seconds(shot_seconds)
        frames_per_shot = SHOT_FRAMES[shot_seconds]
        target_frames = max(1, int(math.ceil(duration * 24.0)))
        frame_step = max(1, frames_per_shot - 1)
        shot_count = max(
            1, int(math.ceil(max(0, target_frames - 1) / frame_step)))

        request, _count, _frames, _seconds = super().build(
            creative_brief, reference_roles, lyrics_or_dialogue,
            shot_count * shot_seconds, shot_seconds, picture_count)
        request = request.replace(
            "Create ONE MiniMax Music3 + MiniMax H3 music-video project.",
            "Create ONE MiniMax H3 music-video plan for the supplied external "
            "soundtrack.")
        request = request.replace(
            "The final master can select either H3-generated audio or the "
            "original Music3 waveform. Do not conflate those two modes.",
            "The supplied external soundtrack is the final master audio. Do "
            "not recreate, rewrite, translate or replace it. H3 receives the "
            "matching synchronized slice in every generated clip.")
        request = request.replace(
            "Music3 soundtrack slice", "external soundtrack slice")
        request += (
            "\nEXTERNAL SOUNDTRACK TIMING:\n"
            "- Exact detected duration: %.6f seconds.\n"
            "- Generate exactly %d H3 clips; the last clip will be trimmed to "
            "the song endpoint.\n"
            "- Treat audible vocals, silences, instrumental passages, rhythm "
            "and language in <Soundtrack> as authoritative.\n"
            "- If exact lyrics were not supplied, never invent visible or "
            "lip-readable words; plan mouth activity from the soundtrack.\n"
            % (duration, shot_count)
        )
        return (
            request, shot_count, frames_per_shot, float(duration),
            target_frames, soundtrack)


class H3MusicVideoPlanParser:
    """Validate LLM JSON and turn shots into the existing --- script form."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "llm_response": ("STRING", {"forceInput": True}),
                "planned_shots": (
                    "INT", {"forceInput": True, "min": 1, "max": 72}),
            },
            "optional": {
                "vocal_profile": (
                    ["auto_from_shots", "male", "female"],
                    {
                        "default": "auto_from_shots",
                        "tooltip": "Deterministic Music3 lead-vocal lock. Auto "
                                   "infers it from the H3 shot descriptions; "
                                   "male/female overrides LLM completely.",
                    }),
                "lip_sync_mode": (
                    ["h3_generate_vocals", "soundtrack_activity",
                     "continuous", "off"],
                    {
                        "default": "h3_generate_vocals",
                        "tooltip": "h3_generate_vocals keeps planned <d> "
                                   "lyrics so H3 can jointly create singing "
                                   "and mouth motion. soundtrack_activity is "
                                   "for vocals already present in Music3. "
                                   "continuous preserves the legacy all-shot "
                                   "behavior; off keeps lips at rest.",
                    }),
                "save_debug_plan": ("BOOLEAN", {
                    "default": True,
                    "label_on": "save LLM/H3 prompts ON",
                    "label_off": "save LLM/H3 prompts OFF",
                    "tooltip": "Save LLM's raw response before validation, "
                               "then the validated JSON and exact final H3 "
                               "script under ComfyUI/output."}),
                "debug_filename_prefix": ("STRING", {
                    "default": "H3_MUSIC_VIDEO_DEBUG/llm_plan",
                    "tooltip": "Output-relative folder and filename prefix."}),
                "lyrics_language": (
                    ["auto_from_plan", "Italian", "English", "Spanish",
                     "French", "German", "Portuguese", "Japanese",
                     "Korean", "Chinese", "Turkish", "Arabic", "Russian"],
                    {
                        "default": "auto_from_plan",
                        "tooltip": "Language tag forced into every exact <d> "
                                   "lyrics block sent to H3. Auto reads the "
                                   "LLM plan and music caption.",
                    }),
            },
        }

    RETURN_TYPES = (
        "STRING", "STRING", "STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = (
        "music_caption", "lyrics", "video_script",
        "project_json", "shot_count", "debug_base_path")
    FUNCTION = "parse"
    CATEGORY = "utils/minimax/music video"
    DESCRIPTION = (
        "Strictly validates the LLM plan before any expensive Music3 or H3 "
        "generation begins.")

    @staticmethod
    def _infer_vocal_profile(shots):
        text = json.dumps(shots, ensure_ascii=False).lower()
        male = len(re.findall(
            r"\b(?:male lead|male performer|male singer|adult male|adult man|"
            r"man sings|baritone|tenor|masculine voice|\bhe\b|\bhis\b)",
            text))
        female = len(re.findall(
            r"\b(?:female lead|female performer|female singer|adult female|"
            r"adult woman|woman sings|soprano|contralto|feminine voice|"
            r"\bshe\b|\bher\b)",
            text))
        if male > female:
            return "male"
        if female > male:
            return "female"
        return None

    @staticmethod
    def _force_vocal_profile(caption, profile):
        if profile == "male":
            details = (
                "Vocal Details: Solo adult male lead vocal with a clearly "
                "masculine, natural baritone-to-tenor timbre, expressive "
                "phrasing, clean diction and consistent vocal identity."
            )
        elif profile == "female":
            details = (
                "Vocal Details: Solo adult female lead vocal with a clearly "
                "feminine, natural alto-to-soprano timbre, expressive "
                "phrasing, clean diction and consistent vocal identity."
            )
        else:
            return caption
        pattern = re.compile(
            r"(?ims)^\s*Vocal Details\s*:.*?(?=^\s*Arrangement\s*:|\Z)")
        if pattern.search(caption):
            return pattern.sub(details + "\n\n", caption, count=1).strip()
        return (details + "\n\n" + caption).strip()

    def parse(self, llm_response, planned_shots,
              vocal_profile="auto_from_shots",
              lip_sync_mode="h3_generate_vocals",
              save_debug_plan=True,
              debug_filename_prefix="H3_MUSIC_VIDEO_DEBUG/llm_plan",
              lyrics_language="auto_from_plan"):
        debug_base = ""
        if save_debug_plan:
            try:
                debug_base = _music_debug_base(debug_filename_prefix)
                raw_path = _write_music_debug(
                    debug_base, "_01_llm_raw.txt", llm_response)
                print(
                    "[H3MusicVideoDebug] raw LLM response saved: %s"
                    % raw_path,
                    flush=True)
            except Exception as exc:
                print(
                    "[H3MusicVideoDebug] raw save failed: %s" % exc,
                    flush=True)
                debug_base = ""
        data = _extract_json(llm_response)
        caption = _section_text(data.get("music_caption"))
        lyrics = _section_text(data.get("lyrics"))
        shots = data.get("shots")
        if (not caption or not lyrics
                or not isinstance(shots, list) or not shots):
            raise ValueError(
                "Project JSON needs non-empty music_caption, lyrics and shots[].")
        if len(shots) < planned_shots:
            raise ValueError(
                "LLM returned %d shots but %d were requested. "
                "Increase max_new_tokens."
                % (len(shots), planned_shots))
        shots = _normalise_music_audio_markers(
            copy.deepcopy(shots[:planned_shots]))
        lip_sync_mode = str(lip_sync_mode or "h3_generate_vocals")
        resolved_language = _resolve_lyrics_language(
            data, caption, lyrics, lyrics_language)
        if lip_sync_mode == "h3_generate_vocals":
            shots = _assign_lyrics_to_vocal_shots(
                shots, lyrics, resolved_language)
        prompts = [
            _shot_to_prompt(shot, lip_sync_mode=lip_sync_mode)
            for shot in shots
        ]
        resolved_vocal = str(vocal_profile or "auto_from_shots")
        if resolved_vocal == "auto_from_shots":
            # The requested singer profile is often stated only in the music
            # caption, while shots may use neutral pronouns. Inspect both.
            resolved_vocal = self._infer_vocal_profile({
                "music_caption": caption,
                "shots": shots,
            })
        if resolved_vocal in ("male", "female"):
            caption = self._force_vocal_profile(
                caption, resolved_vocal)
            print(
                "[H3MusicVideo] Music3 vocal profile locked to %s."
                % resolved_vocal,
                flush=True)
        clean = dict(data)
        clean["music_caption"] = caption
        clean["resolved_vocal_profile"] = (
            resolved_vocal or "from_plan")
        clean["lip_sync_mode"] = lip_sync_mode
        clean["lyrics_language"] = resolved_language
        clean["shots"] = shots
        clean["planned_shots"] = planned_shots
        project_json = json.dumps(
            clean, ensure_ascii=False, indent=2)
        if debug_base:
            try:
                _write_music_debug(
                    debug_base, "_02_validated_project.json", project_json)
                _write_music_debug(
                    debug_base, "_03_final_h3_script.txt",
                    "\n\n---\n\n".join(prompts))
                _write_music_debug(
                    debug_base, "_04_music_caption.txt", caption)
                _write_music_debug(
                    debug_base, "_05_lyrics.txt", lyrics)
                print(
                    "[H3MusicVideoDebug] complete prompt bundle saved: %s_*"
                    % debug_base,
                    flush=True)
            except Exception as exc:
                print(
                    "[H3MusicVideoDebug] parsed bundle save failed: %s"
                    % exc,
                    flush=True)
        return (
            caption,
            lyrics,
            "\n\n---\n\n".join(prompts),
            project_json,
            planned_shots,
            debug_base,
        )


def _normalise_audio(audio):
    wav = audio["waveform"]
    if wav.ndim == 2:
        wav = wav.unsqueeze(0)
    wav = wav[:1]
    if wav.shape[1] == 1:
        wav = wav.repeat(1, 2, 1)
    elif wav.shape[1] > 2:
        wav = wav[:, :2]
    return wav, int(audio["sample_rate"])


def _audio_slice(audio, start_seconds, duration_seconds):
    import torch
    wav, sr = _normalise_audio(audio)
    start = max(0, int(round(start_seconds * sr)))
    count = max(1, int(round(duration_seconds * sr)))
    part = wav[..., start:start + count]
    if part.shape[-1] < count:
        part = torch.nn.functional.pad(
            part, (0, count - part.shape[-1]))
    return {"waveform": part, "sample_rate": sr}


def _clone_with_soundtrack(bank, audio_vae, soundtrack_slice):
    clone = h3_refs.RefBank()
    clone.items = list(bank.items)
    clone.blocks = list(bank.blocks)
    clone.n_images = bank.n_images
    clone.labels = list(bank.labels)
    clone.img_rows = bank.img_rows
    clone.audio_rows = bank.audio_rows
    clone.legacy_voice_only = False
    audio_number = 1 + sum(
        1 for marker, _source in clone.labels
        if marker.startswith("<Audio "))
    latent, ref_audio_t, seconds = h3_refs._encode_ref_audio(
        audio_vae, soundtrack_slice, max_seconds=15)
    clone.items.append({"type": "audio"})
    clone.blocks.append({
        "kind": "audio",
        "ref_audio_t": ref_audio_t,
        "audio_latent": latent,
    })
    clone.audio_rows += ref_audio_t * 2
    clone.labels.append((
        "<Audio %d>" % audio_number,
        "Music3 soundtrack slice (%.2fs)" % seconds,
    ))
    return clone, audio_number


def _master_soundtrack(audio, frame_count):
    import torch
    wav, sr = _normalise_audio(audio)
    wanted = max(1, int(round(frame_count * sr / 24.0)))
    wav = wav[..., :wanted]
    if wav.shape[-1] < wanted:
        wav = torch.nn.functional.pad(
            wav, (0, wanted - wav.shape[-1]))
    return {"waveform": wav.cpu(), "sample_rate": sr}


_HYBRID_DEMUCS = None


def _load_hybrid_demucs():
    """Load the bundled torchaudio Hybrid Demucs model from ComfyUI models."""
    global _HYBRID_DEMUCS
    if _HYBRID_DEMUCS is not None:
        return _HYBRID_DEMUCS
    import torch
    import folder_paths
    from torchaudio.pipelines import HDEMUCS_HIGH_MUSDB_PLUS

    model_path = os.path.join(
        folder_paths.models_dir,
        "audio_separator",
        "hdemucs_high_trained.pt",
    )
    if not os.path.isfile(model_path):
        raise FileNotFoundError(
            "Hybrid vocal mix needs %s. Download torchaudio's "
            "HDEMUCS_HIGH_MUSDB_PLUS weights there first." % model_path)
    bundle = HDEMUCS_HIGH_MUSDB_PLUS
    demucs = bundle._model_factory_func()
    state = torch.load(model_path, map_location="cpu", weights_only=True)
    demucs.load_state_dict(state)
    demucs.eval()
    _HYBRID_DEMUCS = (
        demucs,
        int(bundle.sample_rate),
        list(demucs.sources),
    )
    print(
        "[H3HybridMix] Hybrid Demucs loaded from %s" % model_path,
        flush=True)
    return _HYBRID_DEMUCS


def _resample_waveform(waveform, source_rate, target_rate):
    if int(source_rate) == int(target_rate):
        return waveform
    from torchaudio.functional import resample
    return resample(waveform, int(source_rate), int(target_rate))


def _fit_audio_length(waveform, wanted):
    import torch
    waveform = waveform[..., :wanted]
    if waveform.shape[-1] < wanted:
        waveform = torch.nn.functional.pad(
            waveform, (0, wanted - waveform.shape[-1]))
    return waveform


def _hybrid_music3_h3_mix(
        original_audio, h3_audio, base_gain_db=-1.5, vocal_gain_db=2.0,
        separator_device="cpu_safe", remove_music3_vocals=True,
        chunk_seconds=10.0, overlap_seconds=0.5):
    """Mix a clean Music3 accompaniment with the isolated H3 vocal stem."""
    import torch

    demucs, separator_rate, sources = _load_hybrid_demucs()
    requested_cuda = str(separator_device) == "cuda_fast"
    device = torch.device(
        "cuda" if requested_cuda and torch.cuda.is_available() else "cpu")
    music_wav, music_rate = _normalise_audio(original_audio)
    h3_wav, h3_rate = _normalise_audio(h3_audio)
    music_sep = _resample_waveform(
        music_wav.float().cpu(), music_rate, separator_rate)
    h3_sep = _resample_waveform(
        h3_wav.float().cpu(), h3_rate, separator_rate)
    total = max(music_sep.shape[-1], h3_sep.shape[-1])
    music_sep = _fit_audio_length(music_sep, total)
    h3_sep = _fit_audio_length(h3_sep, total)
    pair = torch.cat((music_sep, h3_sep), dim=0)

    # Normalize each source independently, as recommended for Hybrid Demucs.
    means = pair.mean(dim=(1, 2), keepdim=True)
    scales = pair.std(dim=(1, 2), keepdim=True).clamp_min(1e-6)
    normalized = (pair - means) / scales
    segment = max(1, int(round(float(chunk_seconds) * separator_rate)))
    overlap = max(0, int(round(float(overlap_seconds) * separator_rate)))
    overlap = min(overlap, segment // 2)
    hop = max(1, segment - overlap)
    separated = torch.zeros(
        (2, len(sources), 2, total), dtype=torch.float32)
    weights = torch.zeros(total, dtype=torch.float32)

    print(
        "[H3HybridMix] separating Music3 base + H3 vocal on %s "
        "(%.2fs, chunks %.1fs)"
        % (device, total / separator_rate, float(chunk_seconds)),
        flush=True)
    try:
        demucs.to(device)
        with torch.inference_mode():
            start = 0
            while start < total:
                end = min(total, start + segment)
                count = end - start
                chunk = normalized[..., start:end]
                if count < segment:
                    chunk = torch.nn.functional.pad(
                        chunk, (0, segment - count))
                prediction = demucs(chunk.to(device))[..., :count].cpu()
                prediction = prediction * scales[:, None]
                window = torch.ones(count, dtype=torch.float32)
                fade = min(overlap, count // 2)
                if fade > 0:
                    phase = torch.linspace(0.0, math.pi / 2.0, fade)
                    if start > 0:
                        window[:fade] = torch.sin(phase).square()
                    if end < total:
                        window[-fade:] = torch.cos(phase).square()
                separated[..., start:end] += (
                    prediction * window.view(1, 1, 1, -1))
                weights[start:end] += window
                start += hop
    finally:
        if device.type == "cuda":
            demucs.to("cpu")
            torch.cuda.empty_cache()
    separated /= weights.clamp_min(1e-6).view(1, 1, 1, -1)

    vocal_index = sources.index("vocals")
    h3_vocal = separated[1, vocal_index]
    if remove_music3_vocals:
        instrumental_indices = [
            index for index, name in enumerate(sources)
            if name != "vocals"]
        music_base = separated[0, instrumental_indices].sum(dim=0)
    else:
        music_base = music_sep[0]

    music_base = _resample_waveform(
        music_base, separator_rate, music_rate)
    h3_vocal = _resample_waveform(
        h3_vocal, separator_rate, music_rate)
    wanted = music_wav.shape[-1]
    music_base = _fit_audio_length(music_base, wanted).unsqueeze(0)
    h3_vocal = _fit_audio_length(h3_vocal, wanted).unsqueeze(0)
    base_gain = 10.0 ** (float(base_gain_db) / 20.0)
    vocal_gain = 10.0 ** (float(vocal_gain_db) / 20.0)
    mixed = music_base * base_gain + h3_vocal * vocal_gain
    peak = float(mixed.abs().max().item())
    limiter_gain = min(1.0, 0.98 / max(peak, 1e-9))
    mixed = mixed * limiter_gain
    print(
        "[H3HybridMix] master ready: base %.1f dB, vocal %+.1f dB, "
        "limiter %.3f, Music3 vocals removed=%s"
        % (float(base_gain_db), float(vocal_gain_db), limiter_gain,
           bool(remove_music3_vocals)),
        flush=True)
    return {"waveform": mixed.cpu(), "sample_rate": music_rate}


class H3MusicVideoReferenceMemorySampler(H3MultishotSampler):
    """Reference-memory sampler with a time-aligned Music3 ref per shot."""

    @classmethod
    def INPUT_TYPES(cls):
        base = H3ReferenceMemorySampler.INPUT_TYPES()
        required = dict(base["required"])
        required["soundtrack"] = ("AUDIO", {
            "tooltip": "Complete Music3 song. A synchronized slice becomes "
                       "<Soundtrack> in every shot. Both H3-generated audio "
                       "and the original waveform remain available."})
        optional = dict(base.get("optional", {}))
        optional["audio_output_mode"] = (
            ["h3_generated", "original_soundtrack",
             "soundtrack_base_plus_h3_vocal", "original_music3",
             "music3_base_plus_h3_vocal"],
            {
                "default": "h3_generated",
                "tooltip": "h3_generated keeps the audio jointly generated "
                           "by H3, including any new synchronized singing. "
                           "original_music3 preserves the untouched Music3 "
                           "waveform and discards H3's generated audio. "
                           "music3_base_plus_h3_vocal removes vocals from "
                           "Music3, isolates the cloned H3 vocal from the "
                           "complete multishot master, and mixes both.",
            },
        )
        optional["hybrid_base_gain_db"] = ("FLOAT", {
            "default": -1.5, "min": -18.0, "max": 6.0, "step": 0.5,
            "tooltip": "Backing-track gain for hybrid mode."})
        optional["hybrid_vocal_gain_db"] = ("FLOAT", {
            "default": 2.0, "min": -18.0, "max": 12.0, "step": 0.5,
            "tooltip": "Isolated cloned-vocal gain for hybrid mode."})
        optional["hybrid_separator_device"] = (
            ["cpu_safe", "cuda_fast"], {
                "default": "cpu_safe",
                "tooltip": "CPU is VRAM-safe after a long H3 render. CUDA "
                           "is faster but may need several free GB."})
        optional["hybrid_remove_music3_vocals"] = ("BOOLEAN", {
            "default": True,
            "tooltip": "ON removes any singer Music3 accidentally created, "
                       "leaving its instrumental stems as the base."})
        optional["trim_to_soundtrack"] = ("BOOLEAN", {
            "default": False,
            "label_on": "trim master to soundtrack ON",
            "label_off": "legacy full clips OFF",
            "tooltip": "ON trims frames and every audio output to the exact "
                       "duration of the supplied soundtrack. OFF preserves "
                       "the legacy whole-shot behavior."})
        return {
            "required": required,
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "AUDIO", "AUDIO")
    RETURN_NAMES = (
        "master_frames", "selected_soundtrack", "shots_rendered",
        "h3_generated_soundtrack", "original_music3_soundtrack")
    FUNCTION = "run"
    CATEGORY = "sampling/minimax/music video"
    DESCRIPTION = (
        "H3 Reference + Memory with a different synchronized Music3 "
        "reference-audio slice in every shot.")

    def run(self, model, clip, video_vae, audio_vae, script, shot_count,
            width, height, frames_per_shot, seed, steps, soundtrack,
            seed_per_shot=False, memory_frames=2, anchor_frames=1,
            start_image=None, voice_ref=None,
            sampler_name="res_multistep", scheduler="simple",
            ref_image_0=None, ref_image_1=None, ref_image_2=None,
            ref_image_3=None, ref_audio_0=None, ref_audio_1=None,
            ref_video_0=None, ref_video_audio_0=None,
            ref_image_size="match", stream_to_disk=False,
            ref_image_4=None, ref_image_5=None, ref_image_6=None,
            ref_image_7=None, ref_image_8=None,
            audio_output_mode="h3_generated",
            hybrid_base_gain_db=-1.5, hybrid_vocal_gain_db=2.0,
            hybrid_separator_device="cpu_safe",
            hybrid_remove_music3_vocals=True,
            trim_to_soundtrack=False):
        import torch
        import node_helpers
        from comfy_extras import nodes_custom_sampler as ncs
        from comfy_extras import nodes_minimax_h3 as mmh3
        from comfy_extras.nodes_audio import vae_decode_audio
        import comfy.model_management as model_management

        # All upstream work (LLM and Music3) is complete once this method
        # receives its AUDIO tensor. Free their loaded weights before encoding
        # references or asking H3 to load. The H3 patcher objects passed here
        # remain valid and are loaded again on demand by ComfyUI.
        try:
            model_management.unload_all_models()
            model_management.soft_empty_cache()
            print(
                "[H3MusicVideo] upstream LLM/Music3 models unloaded before H3.",
                flush=True)
        except Exception as exc:
            print(
                "[H3MusicVideo] upstream model purge skipped: %s" % exc,
                flush=True)

        audio_output_mode = str(audio_output_mode or "h3_generated")
        original_modes = {"original_music3", "original_soundtrack"}
        hybrid_modes = {
            "music3_base_plus_h3_vocal",
            "soundtrack_base_plus_h3_vocal",
        }
        if audio_output_mode in hybrid_modes and voice_ref is None:
            raise ValueError(
                "music3_base_plus_h3_vocal requires voice_ref. Load a clean "
                "voice sample and enable use_voice_ref in the router.")

        base_bank = h3_refs.build_ref_bank(
            video_vae, audio_vae, width, height, frames_per_shot,
            ref_image_size,
            ref_images=(
                ref_image_0, ref_image_1, ref_image_2, ref_image_3,
                ref_image_4, ref_image_5, ref_image_6, ref_image_7,
                ref_image_8),
            voice_ref=voice_ref,
            ref_audios=(ref_audio_0, ref_audio_1),
            ref_video=ref_video_0,
            ref_video_audio=ref_video_audio_0)

        shots = _parse_script(script)
        n = shot_count if shot_count > 0 else len(shots)
        shots = shots[:n]
        while len(shots) < n:
            shots.append(shots[-1])
        sigmas = ncs.BasicScheduler().get_sigmas(
            model, scheduler, steps, 1.0)[0]
        sampler = ncs.KSamplerSelect().get_sampler(sampler_name)[0]
        frame_store = _MasterFrameStore(
            torch, stream_to_disk, n * frames_per_shot, width, height)
        h3_audio_parts = []
        h3_sample_rate = None
        history = []
        anchor = start_image[:1] if start_image is not None else None

        for shot_index, raw_prompt in enumerate(shots):
            filtered_bank, prompt, _active = h3_refs.prepare_shot_bank(
                base_bank, raw_prompt)
            master_start_frame = shot_index * (frames_per_shot - 1)
            start_seconds = master_start_frame / 24.0
            ref_seconds = frames_per_shot / 24.0
            song_slice = _audio_slice(
                soundtrack, start_seconds, ref_seconds)
            shot_bank, audio_number = _clone_with_soundtrack(
                filtered_bank, audio_vae, song_slice)
            voice_marker = next((
                marker for marker, source in shot_bank.labels
                if str(source).startswith("voice_ref")
            ), None)
            prompt = prompt.replace(
                "<VoiceReference>",
                voice_marker or ("<Audio %d>" % audio_number))
            prompt = prompt.replace(
                "<Soundtrack>", "<Audio %d>" % audio_number)

            memory_context = []
            if anchor is not None and anchor_frames > 0:
                memory_context.append(anchor)
            if history:
                take = memory_frames if memory_frames > 0 else 1
                memory_context.extend(history[-take:])
            memory_images = [
                mmh3._resize(frame[:1], width, height, "disabled")
                for frame in memory_context]
            continuation = history[-1] if history else anchor
            print(
                "[H3MusicVideo] shot %d/%d, song %.3f-%.3fs, "
                "<Soundtrack>=<Audio %d>, voice=%s, memory=%d, refs=%d"
                % (
                    shot_index + 1, n, start_seconds,
                    start_seconds + ref_seconds, audio_number,
                    voice_marker or "none",
                    len(memory_images), len(shot_bank.blocks)),
                flush=True)

            latent, frame_count = mmh3._empty_av_latent(
                width, height, frames_per_shot)
            keyframes = []
            if continuation is not None:
                keyframes.append({
                    "resolved_frame_index": 0,
                    "image": mmh3._resize(
                        continuation[:1], width, height, "disabled"),
                })
            items = H3ReferenceMemorySampler._reference_memory_items(
                shot_bank, memory_images)
            tokens = clip.tokenize(prompt, minimax_ref_items=items)
            conditioning = clip.encode_from_tokens_scheduled(tokens)
            if keyframes:
                for keyframe in keyframes:
                    keyframe["latent"] = video_vae.encode(
                        keyframe.pop("image"))
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {
                        "minimax_keyframes": keyframes,
                        "minimax_frame_count": frame_count,
                    })
            conditioning = node_helpers.conditioning_set_values(
                conditioning, {"minimax_refs": shot_bank.blocks})

            te_device = getattr(clip.patcher, "load_device", None)
            dit_device = getattr(model, "load_device", None)
            if (te_device is None or dit_device is None
                    or str(te_device) == str(dit_device)):
                try:
                    clip.patcher.model.to(
                        model_management.text_encoder_offload_device())
                    device = model_management.get_torch_device()
                    model_management.free_memory(
                        model_management.get_total_memory(device) * 0.9,
                        device)
                    model_management.soft_empty_cache()
                except Exception as exc:
                    print(
                        "[H3MusicVideo] TE eviction skipped: %s" % exc,
                        flush=True)

            guider = ncs.BasicGuider().get_guider(
                model, conditioning)[0]
            shot_seed = seed + shot_index if seed_per_shot else seed
            noise = ncs.RandomNoise().get_noise(shot_seed)[0]
            _auto_ctx["refsig"] = "%s+m%d" % (
                shot_bank.signature(), len(memory_images))
            measurement = _auto_measure_begin()
            try:
                output, denoised = ncs.SamplerCustomAdvanced().sample(
                    noise, guider, sampler, sigmas, latent)
            finally:
                _auto_measure_end(measurement, model)
                _auto_ctx["refsig"] = ""

            samples = output["samples"]
            if getattr(samples, "is_nested", False):
                samples = samples.unbind()[0]
            images = video_vae.decode(samples)
            if images.ndim == 5:
                images = images.reshape(
                    -1, images.shape[-3], images.shape[-2],
                    images.shape[-1])
            h3_audio = vae_decode_audio(audio_vae, output)
            h3_sample_rate = h3_audio["sample_rate"]
            h3_waveform = h3_audio["waveform"]
            if anchor is None and anchor_frames > 0:
                anchor = images[:1].clone()
            history.append(images[-1:].clone())
            if len(history) > 8:
                history.pop(0)
            if shot_index > 0:
                images = images[1:]
                audio_trim = int(round(h3_sample_rate / 24.0))
                h3_waveform = h3_waveform[..., audio_trim:]
            frame_store.append(images)
            h3_audio_parts.append(h3_waveform.cpu())
            if stream_to_disk:
                del images, samples, output, denoised, noise, guider
                del conditioning, latent, tokens, memory_images, keyframes
                del shot_bank, song_slice, h3_audio, h3_waveform

        master = frame_store.finish()
        source_wav, source_rate = _normalise_audio(soundtrack)
        source_samples = int(source_wav.shape[-1])
        source_seconds = source_samples / float(source_rate)
        if trim_to_soundtrack:
            wanted_frames = max(1, int(math.ceil(source_seconds * 24.0)))
            master = master[:min(wanted_frames, master.shape[0])]
            original_audio = {
                "waveform": source_wav[..., :source_samples].cpu(),
                "sample_rate": source_rate,
            }
        else:
            original_audio = _master_soundtrack(soundtrack, master.shape[0])

        h3_master_waveform = _xfade_audio(
            h3_audio_parts, h3_sample_rate)
        if trim_to_soundtrack:
            wanted_h3_samples = max(
                1, int(round(source_seconds * h3_sample_rate)))
            h3_master_waveform = h3_master_waveform[..., :wanted_h3_samples]
        h3_master_audio = {
            "waveform": h3_master_waveform,
            "sample_rate": h3_sample_rate,
        }
        if audio_output_mode in original_modes:
            selected_audio = original_audio
        elif audio_output_mode in hybrid_modes:
            try:
                model_management.unload_all_models()
                model_management.soft_empty_cache()
            except Exception as exc:
                print(
                    "[H3HybridMix] H3 purge skipped: %s" % exc,
                    flush=True)
            selected_audio = _hybrid_music3_h3_mix(
                original_audio,
                h3_master_audio,
                base_gain_db=hybrid_base_gain_db,
                vocal_gain_db=hybrid_vocal_gain_db,
                separator_device=hybrid_separator_device,
                remove_music3_vocals=hybrid_remove_music3_vocals,
            )
        else:
            selected_audio = h3_master_audio
        print(
            "[H3MusicVideo] done: %d shots, %d frames (%.2fs); final mux "
            "audio=%s. H3-generated and original source audio are both "
            "available as separate outputs."
            % (n, master.shape[0], master.shape[0] / 24.0,
               audio_output_mode),
            flush=True)
        return (
            master,
            selected_audio,
            n,
            h3_master_audio,
            original_audio,
        )


NODE_CLASS_MAPPINGS = {
    "H3MusicVideoPromptKit": H3MusicVideoPromptKit,
    "H3ExternalSongPromptKit": H3ExternalSongPromptKit,
    "H3MusicVideoPlanParser": H3MusicVideoPlanParser,
    "H3MusicVideoReferenceMemorySampler":
        H3MusicVideoReferenceMemorySampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3MusicVideoPromptKit":
        "H3 MUSIC VIDEO - Brief + Planner Request",
    "H3ExternalSongPromptKit":
        "H3 MUSIC VIDEO - External Song + Auto Duration",
    "H3MusicVideoPlanParser":
        "H3 MUSIC VIDEO - Validate LLM Plan",
    "H3MusicVideoReferenceMemorySampler":
        "H3 MUSIC VIDEO - Reference + Memory + Synced Song",
}

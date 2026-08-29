# -*- coding: utf-8 -*-
"""AIO media routing and LLM autoprompting for MiniMax H3."""
import json
import os
from datetime import datetime

from .h3_music_video import _extract_json, _snap_shot_seconds, SHOT_FRAMES
from .h3_prompt_builders import build_it2v_scripts, build_r2v_script
from .h3_internal_timestamps import (
    collapse_planned_clips,
    ensure_internal_timestamps,
)

_CONTEXT_MODES = (
    "OFF - text only", "IMAGES", "IMAGES + VIDEO",
    "ALL + AUDIO METADATA")
_AUDIO_ROLES = (
    "reference_audio", "voice_ref", "ignore", "exact_soundtrack",
    "exact_soundtrack_plus_h3_sfx", "music_video_lipsync")
_GENERATION_MODES = (
    "T2V", "I2V", "R2V", "KEYFRAMES",
    "VIDEO EXTENSION", "VIDEO EDITING")
_FULL_REFERENCE_MODES = {
    "R2V", "KEYFRAMES", "VIDEO EXTENSION", "VIDEO EDITING"}
_VIDEO_AUDIO_POLICIES = ("AUTO", "IGNORE", "REFERENCE", "REUSE")


def _first(image):
    if image is None:
        return None
    return image.unsqueeze(0) if image.ndim == 3 else image[:1]


def _sample(images, count):
    if images is None or count <= 0:
        return []
    if images.ndim == 3:
        images = images.unsqueeze(0)
    total = int(images.shape[0])
    count = min(int(count), total)
    if count <= 1:
        return [images[:1]]
    indices = [round(i * (total - 1) / (count - 1)) for i in range(count)]
    return [images[index:index + 1] for index in indices]


def _letterbox(image, size):
    import torch
    import torch.nn.functional as functional
    image = _first(image)
    if image is None:
        return None
    image = image.float().permute(0, 3, 1, 2)
    height, width = int(image.shape[-2]), int(image.shape[-1])
    scale = min(float(size) / max(height, 1), float(size) / max(width, 1))
    new_h = max(1, int(round(height * scale)))
    new_w = max(1, int(round(width * scale)))
    image = functional.interpolate(
        image, size=(new_h, new_w), mode="bilinear", align_corners=False)
    canvas = torch.zeros(
        (1, image.shape[1], size, size), dtype=image.dtype,
        device=image.device)
    top, left = (size - new_h) // 2, (size - new_w) // 2
    canvas[..., top:top + new_h, left:left + new_w] = image
    return canvas.permute(0, 2, 3, 1).contiguous()


def _ensure_stereo_audio(audio, label="audio"):
    """Return a Comfy AUDIO dict with exactly two channels.

    MiniMax H3 uses stereo reference conditioning more reliably. Preserve real
    stereo, duplicate mono to L/R, and fold multichannel sources to a stable
    stereo pair without mutating the loader-owned input dictionary.
    """
    if audio is None:
        return None
    waveform = audio.get("waveform")
    if waveform is None:
        return audio
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0).unsqueeze(0)
    elif waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    channels = int(waveform.shape[-2])
    if channels == 1:
        waveform = waveform.repeat_interleave(2, dim=-2)
    elif channels > 2:
        waveform = waveform.mean(dim=-2, keepdim=True).repeat_interleave(
            2, dim=-2)
    if channels != 2:
        print("[H3AIO] %s normalized %dch -> stereo." % (
            label, channels), flush=True)
    result = dict(audio)
    result["waveform"] = waveform.contiguous()
    return result


def _audio_info(audio, label):
    if audio is None:
        return None
    waveform = audio.get("waveform")
    rate = int(audio.get("sample_rate", 0) or 0)
    if waveform is None or rate <= 0:
        return "%s: connected, unreadable metadata" % label
    samples = int(waveform.shape[-1])
    channels = int(waveform.shape[-2]) if waveform.ndim >= 2 else 1
    return "%s: %.3fs, %d Hz, %d channel(s)" % (
        label, samples / float(rate), rate, channels)


def _media_inputs():
    values = {
        "picture_%d" % index: ("IMAGE", {"lazy": True})
        for index in range(1, 10)}
    values.update({
        "video_1": ("IMAGE", {"lazy": True}),
        "video_2": ("IMAGE", {"lazy": True}),
        "video_3": ("IMAGE", {"lazy": True}),
        "video_audio_1": ("AUDIO", {"lazy": True}),
        "video_audio_2": ("AUDIO", {"lazy": True}),
        "video_audio_3": ("AUDIO", {"lazy": True}),
        "audio_1": ("AUDIO", {"lazy": True}),
        "audio_2": ("AUDIO", {"lazy": True}),
        "audio_3": ("AUDIO", {"lazy": True}),
    })
    return values


def _needed_media(mode, kwargs):
    mode = str(mode).upper()
    if mode == "I2V":
        names = ["picture_1"]
    elif mode in _FULL_REFERENCE_MODES:
        names = ["picture_%d" % i for i in range(1, 10)]
        names += ["video_%d" % i for i in range(1, 4)]
        names += ["video_audio_%d" % i for i in range(1, 4)]
        names += ["audio_%d" % i for i in range(1, 4)]
    else:
        names = []
    return [name for name in names
            if name in kwargs and kwargs[name] is None]


class H3AIOAutopromptRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "generation_mode": (_GENERATION_MODES, {
                    "default": "T2V"}),
                "natural_prompt": ("STRING", {
                    "multiline": True,
                    "default": "Describe the complete video in ordinary language. Include duration or number of clips only when exact control is needed."}),
                "reference_roles": ("STRING", {
                    "multiline": True,
                    "default": "AUTO: infer conservative roles from the prompt and optional visual context. Never invent identity details not visible in the references."}),
                "shot_count": ("INT", {
                    "default": 0, "min": 0, "max": 24, "step": 1,
                    "tooltip": "0 lets LLM choose; positive enforces exactly."}),
                "max_auto_shots": ("INT", {
                    "default": 6, "min": 1, "max": 24, "step": 1}),
                "shot_seconds": ("INT", {
                    "default": 10, "min": 5, "max": 30, "step": 5,
                    "tooltip": "5/10/15s are standard H3 presets. 20/25/30s "
                               "are experimental single-pass durations and "
                               "may require much more VRAM or fail."}),
                "llm_media_context": (_CONTEXT_MODES, {
                    "default": _CONTEXT_MODES[0],
                    "tooltip": "Audio is metadata only: DaSiWa has no AUDIO input."}),
                "r2v_picture1_as_start": ("BOOLEAN", {
                    "default": False,
                    "label_on": "Picture 1 also starts video",
                    "label_off": "references only"}),
                "audio_1_role": (_AUDIO_ROLES, {
                    "default": "reference_audio"}),
                "video_context_frames": ("INT", {
                    "default": 4, "min": 1, "max": 12, "step": 1}),
                "context_resolution": ("INT", {
                    "default": 512, "min": 256, "max": 1024, "step": 64}),
                "keyframe_positions": ("STRING", {
                    "default": "AUTO",
                    "tooltip": "KEYFRAMES only. AUTO spaces Picture 1..N over the complete master. Or use one global position per Picture, e.g. 0%, 25%, 60%, 100%."}),
                "source_video_audio": (_VIDEO_AUDIO_POLICIES, {
                    "default": "AUTO",
                    "tooltip": "For VIDEO EXTENSION/EDITING: AUTO references audio on extension and reuses it on editing."}),
            },
            "optional": _media_inputs(),
        }

    RETURN_TYPES = (
        "STRING", "IMAGE", "STRING", "INT", "INT", "INT",
        "BOOLEAN", "STRING", "STRING", "BOOLEAN", "STRING", "STRING")
    RETURN_NAMES = (
        "planner_request", "context_images", "generation_mode",
        "shot_seconds", "max_shots", "available_pictures",
        "picture1_as_start", "audio_1_role", "media_manifest",
        "exact_shots", "keyframe_positions", "source_video_audio")
    FUNCTION = "build"
    CATEGORY = "utils/minimax/aio"

    @classmethod
    def check_lazy_status(cls, generation_mode, **kwargs):
        return _needed_media(generation_mode, kwargs)

    def build(self, generation_mode, natural_prompt, reference_roles,
              shot_count, max_auto_shots, shot_seconds, llm_media_context,
              r2v_picture1_as_start, audio_1_role, video_context_frames,
              context_resolution, keyframe_positions="AUTO",
              source_video_audio="AUTO", **media):
        import math
        import torch
        mode = str(generation_mode).upper()
        shot_seconds = _snap_shot_seconds(shot_seconds)
        max_shots = int(shot_count) if int(shot_count) > 0 else int(max_auto_shots)
        exact_shots = bool(int(shot_count) > 0)
        pictures = [media.get("picture_%d" % i) for i in range(1, 10)]
        pictures = [value for value in pictures if value is not None]
        videos = [media.get("video_%d" % i) for i in range(1, 4)]
        videos = [value for value in videos if value is not None]
        audios = [media.get("audio_%d" % i) for i in range(1, 4)]
        video_audios = [media.get("video_audio_%d" % i) for i in range(1, 4)]

        if mode == "I2V" and not pictures:
            raise ValueError("I2V requires Picture 1 in Fantastic H3 Media Loader.")
        if mode == "KEYFRAMES" and not pictures:
            raise ValueError(
                "KEYFRAMES requires at least Picture 1 in Fantastic H3 Media Loader.")
        if mode in ("VIDEO EXTENSION", "VIDEO EDITING") and not videos:
            raise ValueError(
                "%s requires Video 1 in Fantastic H3 Media Loader." % mode)
        if (mode == "R2V" and not pictures and not videos
                and not any(x is not None for x in audios + video_audios)):
            raise ValueError("R2V selected but Fantastic H3 Media Loader is empty.")

        if mode == "VIDEO EDITING":
            source_frames = int(videos[0].shape[0])
            frames_per_clip = SHOT_FRAMES[shot_seconds]
            if frames_per_clip > 360:
                # Reference video input is limited to exactly 15.0s at 24fps.
                # The H3 15s output preset has 362 frames (~15.08s), so use
                # contiguous 360-frame source chunks for VIDEO EDITING.
                stride = 360
                needed = max(
                    1, int(math.ceil(source_frames / float(stride))))
            else:
                stride = frames_per_clip - 1
                needed = max(
                    1, int(math.ceil(
                        max(source_frames - 1, 0) / float(stride))))
            if int(shot_count) == 0:
                if needed > int(max_auto_shots):
                    raise ValueError(
                        "VIDEO EDITING needs %d generated clips to cover "
                        "Video 1. Raise max_auto_shots from %d to at least %d."
                        % (needed, int(max_auto_shots), needed))
                max_shots = needed
                exact_shots = True
            elif int(shot_count) != needed:
                raise ValueError(
                    "VIDEO EDITING needs exactly %d clips at %ds to preserve "
                    "Video 1 duration (%d frames). Set shot_count=0 for AUTO "
                    "or set it to %d." %
                    (needed, shot_seconds, source_frames, needed))

        policy = str(source_video_audio).upper()
        if policy not in _VIDEO_AUDIO_POLICIES:
            policy = "AUTO"
        manifest = [
            "Generation mode: %s" % mode,
            "Detected pictures: %d" % len(pictures),
            "Detected reference videos: %d" % len(videos),
            "Picture 1 also used as R2V start: %s" %
            bool(r2v_picture1_as_start),
            "Audio 1 routing role: %s" % audio_1_role,
            "Source video audio policy: %s" % policy,
        ]
        if mode == "KEYFRAMES":
            manifest.append(
                "Picture 1..%d are concrete global-timeline keyframes in "
                "loader order; schedule=%s." %
                (len(pictures), str(keyframe_positions).strip() or "AUTO"))
        elif mode == "VIDEO EXTENSION":
            manifest.append(
                "<Video 1> is continued from its exact last decoded frame.")
        elif mode == "VIDEO EDITING":
            manifest.append(
                "<Video 1> is the direct editing source; generated duration "
                "follows its frame count.")
        for index in range(len(pictures)):
            manifest.append("<Picture %d> is available." % (index + 1))
        for index in range(len(videos)):
            manifest.append("<Video %d> is available." % (index + 1))

        context_mode = str(llm_media_context)
        visual_items, visual_labels = [], []
        if context_mode != _CONTEXT_MODES[0]:
            if mode == "I2V" and pictures:
                visual_items.append(pictures[0])
                visual_labels.append(
                    "attached visual 1 = I2V start / Picture 1")
            elif mode in _FULL_REFERENCE_MODES:
                for index, image in enumerate(pictures):
                    visual_items.append(image)
                    role = (
                        "concrete keyframe"
                        if mode == "KEYFRAMES" else "reference")
                    visual_labels.append(
                        "attached visual %d = <Picture %d> (%s)" %
                        (len(visual_items), index + 1, role))
                if context_mode in (_CONTEXT_MODES[2], _CONTEXT_MODES[3]):
                    for video_index, video in enumerate(videos):
                        for frame_index, frame in enumerate(
                                _sample(video, video_context_frames)):
                            visual_items.append(frame)
                            visual_labels.append(
                                "attached visual %d = frame %d from <Video %d>"
                                % (len(visual_items), frame_index + 1,
                                   video_index + 1))
        if context_mode == _CONTEXT_MODES[3]:
            for index, audio in enumerate(audios):
                info = _audio_info(audio, "<Audio %d>" % (index + 1))
                if info:
                    manifest.append(info)
            for index, audio in enumerate(video_audios):
                info = _audio_info(
                    audio, "soundtrack of <Video %d>" % (index + 1))
                if info:
                    manifest.append(info)

        prepared = [
            _letterbox(item, int(context_resolution))
            for item in visual_items]
        prepared = [item for item in prepared if item is not None]
        context_images = torch.cat(prepared, dim=0) if prepared else None
        manifest.extend(visual_labels)
        manifest_text = "\n".join(manifest)
        shot_rule = (
            "Write exactly 1 generated clip. Never return a second top-level "
            "clip; express scene changes as timed internal [Shot N] markers "
            "inside that single clip."
            if int(max_shots) == 1 else
            "Write exactly %d generated clips." % int(max_shots)
            if exact_shots else
            "Choose 1 to %d clips, using the smallest useful count. If the "
            "user states total duration, divide by %d seconds and round up."
            % (max_shots, shot_seconds))
        if mode in ("T2V", "I2V"):
            schema = ('{"mode":"%s","continuity_bible":"...",'
                      '"shots":[{"description":"...",'
                      '"soundscape":"...","music":"..."}]}' % mode)
        else:
            schema = ('{"mode":"%s","subject_definitions":"...",'
                      '"task_types":["reference generation"],"summary":"...",'
                      '"retention_analysis":"...","style":"...","shots":'
                      '[{"description":"...","soundscape":"...",'
                      '"music":"N/A","active_ref_images":[1],'
                      '"active_ref_videos":[1],"active_ref_audios":[1]}]}' % mode)

        operation_rules = {
            "T2V": (
                "Generate only from text. Ignore every loaded media asset."),
            "I2V": (
                "Picture 1 is the exact opening frame of generated clip 1. "
                "Later clips continue only from memory."),
            "R2V": (
                "Use loaded assets as references. Picture 1 is a concrete "
                "opening frame only when the dedicated switch is enabled."),
            "KEYFRAMES": (
                "Picture 1..N are concrete frames on the complete output "
                "timeline, in loader order. Describe believable motion or "
                "intentional cuts that reach every keyframe at its scheduled "
                "position. They are keyframes, not ordinary character "
                "references."),
            "VIDEO EXTENSION": (
                "Continue Video 1 from its exact final frame. The first "
                "generated frame must preserve that boundary and then move "
                "forward; do not restart or summarize the source video."),
            "VIDEO EDITING": (
                "The target is a direct edited version of Video 1. Preserve "
                "its temporal order unless the user explicitly asks for "
                "structural changes."),
        }
        media_rule = (
            "Inspect attached visuals conservatively in manifest order."
            if prepared else
            "No visual tensor is sent to LLM. Use text and role map only; "
            "do not claim visual inspection.")
        role = str(audio_1_role)
        if role == "music_video_lipsync":
            audio_rule = (
                "Audio 1 is the authoritative complete song for a synchronized "
                "music video. In every shot description use the literal marker "
                "<Soundtrack> for the currently audible time-aligned song slice. "
                "When vocals are audible, describe precise visible lip movement, "
                "breathing and performance synchronized to <Soundtrack>; do not "
                "invent, quote or transcribe lyrics. Set active_ref_audios to an "
                "empty array because the dedicated sampler injects the correct "
                "slice itself. Set every music field to N/A: the original song is "
                "preserved unchanged as the final soundtrack, not regenerated by H3.")
        elif role == "exact_soundtrack_plus_h3_sfx":
            audio_rule = (
                "Audio 1 is added only after H3 generation. H3 must generate "
                "diegetic sound effects and ambience only: set every music "
                "field to N/A; do not put <Audio 1> in subject_definitions, "
                "retention_analysis, shot descriptions or task_types. You "
                "may preserve explicit user timestamps for visual rhythm, "
                "but never generate or describe a music track.")
        elif role == "exact_soundtrack":
            audio_rule = (
                "Audio 1 is added only in the final mux and is not an H3 "
                "reference. Set every music field to N/A and do not bind "
                "<Audio 1> in the generated H3 plan.")
        else:
            audio_rule = (
                "Follow the Audio 1 routing role in the media manifest.")
        request = """Create a MiniMax H3 multishot plan from an ordinary-language request.
Return valid JSON only, with no Markdown, comments or trailing commas.

MODE: {mode}
EACH GENERATED CLIP: {seconds} seconds ({frames} H3 frames)
SHOT POLICY: {shot_rule}
JSON SCHEMA: {schema}
MODE-SPECIFIC RULE: {operation_rule}

Rules:
- shots[] are separate generated clips joined through frame memory.
- Every description MUST start with exactly [Shot 1] and Shot 1 MUST NOT have a timestamp.
- For T2V/I2V, continuity_bible is mandatory: write one compact, immutable visual paragraph describing every recurring character or creature (apparent age, face, hair, build, clothing, materials, exact colors), signature props, environment, time of day, lighting, palette and capture style. Use concrete visible facts only; never put actions, camera moves, shot numbers, dialogue or audio in it.
- Treat each generated clip as independently encoded. Repeat the same exact continuity_bible wording in every clip where those elements remain present; the parser also injects it automatically. Never shorten a named subject to a generic label such as "the wizard", "the woman" or "the dragon" without preserving its defining visual traits.
- Do not over-compress the descriptions. For a 10-second clip, normally use about 90-150 English words for the visual description: preserve the immutable details, then describe chronological action, readable body mechanics, camera movement, secondary motion, lighting interaction and a stable final composition. Scale this detail budget sensibly for shorter or longer clips; do not overload the available duration.
- End each generated clip on a stable composition suitable for the next clip. Never restart later clips from the original input image.
- T2V/I2V descriptions contain visuals, action, camera and timing; soundscape is diegetic audio; music is non-diegetic music or N/A.
- Write soundscape as 1-3 complete sentences. Use music=N/A only when no audience-only score is wanted or when the audio routing rule requires it; otherwise describe instruments, tempo, dynamics and continuity across clips.
- Full-reference modes use stable <Subject N>, <Picture N>, <Video N> and <Audio N> labels. active_ref_images, active_ref_videos and active_ref_audios list only the references physically needed in that generated clip. Obey every explicit generated-clip schedule in REFERENCE ROLE MAP exactly; AUTO entries are assigned to the smallest useful set of clips, while REQUIRED entries stay active in every clip.
- task_types may only be keyframe completion, reference generation, video editing, video continuation, audio reuse, audio reference.
- KEYFRAMES must use keyframe completion. VIDEO EXTENSION must use video continuation. VIDEO EDITING must use video editing. The validator enforces these choices.
- Audio metadata is not transcription and must never be treated as heard lyrics or speech.
- {audio_rule}
- {media_rule}

NATURAL USER REQUEST:
{natural}

REFERENCE ROLE MAP:
{roles}

MEDIA MANIFEST:
{manifest}
""".format(
            mode=mode, seconds=shot_seconds, frames=SHOT_FRAMES[shot_seconds],
            shot_rule=shot_rule, schema=schema,
            operation_rule=operation_rules[mode], audio_rule=audio_rule,
            media_rule=media_rule,
            natural=str(natural_prompt).strip(),
            roles=str(reference_roles).strip(), manifest=manifest_text)
        return (
            request, context_images, mode, shot_seconds, max_shots,
            len(pictures), bool(r2v_picture1_as_start),
            str(audio_1_role), manifest_text, exact_shots,
            str(keyframe_positions).strip() or "AUTO", policy)

class H3AIOPlanParser:
    """Validate LLM JSON through the existing exact H3 formatters."""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "llm_response": ("STRING", {"forceInput": True}),
                "generation_mode": ("STRING", {"forceInput": True}),
                "shot_seconds": ("INT", {"forceInput": True}),
                "max_shots": ("INT", {"forceInput": True}),
                "available_pictures": ("INT", {"forceInput": True}),
                "picture1_as_start": ("BOOLEAN", {"forceInput": True}),
                "exact_shots": ("BOOLEAN", {"forceInput": True}),
            },
            "optional": {
                "source_video_audio": ("STRING", {"forceInput": True}),
                "save_debug_plan": ("BOOLEAN", {
                    "default": True,
                    "label_on": "save LLM plan ON",
                    "label_off": "save LLM plan OFF"}),
                "debug_filename_prefix": ("STRING", {
                    "default": "H3_AIO_AUTOPROMPT_DEBUG/plan"}),
            },
        }

    RETURN_TYPES = ("STRING", "INT", "INT", "STRING")
    RETURN_NAMES = (
        "script", "shot_count", "frames_per_shot", "validated_json")
    FUNCTION = "parse"
    CATEGORY = "utils/minimax/aio"

    def parse(self, llm_response, generation_mode, shot_seconds, max_shots,
              available_pictures, picture1_as_start, exact_shots,
              source_video_audio="AUTO", save_debug_plan=True,
              debug_filename_prefix="H3_AIO_AUTOPROMPT_DEBUG/plan"):
        mode = str(generation_mode).upper()
        data = _extract_json(llm_response)
        if not isinstance(data, dict):
            raise ValueError("LLM must return one JSON object.")
        returned_mode = str(data.get("mode") or mode).upper()
        if returned_mode != mode:
            raise ValueError(
                "LLM returned mode %s but the router is %s."
                % (returned_mode, mode))
        shots = data.get("shots")
        if not isinstance(shots, list) or not shots:
            raise ValueError("LLM JSON requires a non-empty shots array.")
        if len(shots) > int(max_shots):
            if int(max_shots) == 1:
                shots, collapse_note = collapse_planned_clips(
                    shots, shot_seconds)
                data["shots"] = shots
                print(
                    "[H3AIO] monoshot auto-fix: %s" % collapse_note,
                    flush=True)
            else:
                raise ValueError(
                    "LLM returned %d clips; current limit is %d."
                    % (len(shots), int(max_shots)))
        if exact_shots and len(shots) != int(max_shots):
            raise ValueError(
                "shot_count requires exactly %d clips, but LLM returned %d."
                % (int(max_shots), len(shots)))

        continuity_bible = ""
        if mode in ("T2V", "I2V"):
            continuity_bible = " ".join(
                str(data.get("continuity_bible") or "").split())
            if not continuity_bible:
                raise ValueError(
                    "%s LLM JSON requires a non-empty continuity_bible."
                    % mode)
            # Keep the repeated lock detailed but bounded so it cannot crowd
            # the clip-specific action out of the H3 text context.
            continuity_bible = continuity_bible[:1600].rstrip()

        cleaned = []
        for index, shot in enumerate(shots):
            if not isinstance(shot, dict):
                raise ValueError("shots[%d] is not an object." % index)
            description = str(shot.get("description") or "").strip()
            if not description:
                raise ValueError("shots[%d].description is empty." % index)
            description, timestamps_changed, timestamp_note = (
                ensure_internal_timestamps(description, shot_seconds))
            if timestamps_changed:
                print(
                    "[H3AIO] clip %d timestamp auto-fix: %s"
                    % (index + 1, timestamp_note), flush=True)
            if continuity_bible:
                marker = "[Shot 1]"
                if description.startswith(marker):
                    body = description[len(marker):].lstrip()
                    description = (
                        marker + " Continuity lock: " +
                        continuity_bible.rstrip(" .") + ". " + body)
                else:
                    description = (
                        marker + " Continuity lock: " +
                        continuity_bible.rstrip(" .") + ". " + description)
            item = {
                "description": description,
                "soundscape": str(
                    shot.get("soundscape") or "N/A").strip(),
                "music": str(shot.get("music") or "N/A").strip(),
            }
            if mode in _FULL_REFERENCE_MODES:
                active = shot.get("active_ref_images")
                if mode == "KEYFRAMES":
                    active = []
                elif not isinstance(active, list):
                    active = list(range(1, int(available_pictures) + 1))
                valid = set()
                for value in active:
                    try:
                        number = int(value)
                    except (TypeError, ValueError):
                        continue
                    if 1 <= number <= int(available_pictures):
                        valid.add(number)
                item["active_ref_images"] = sorted(valid)
                for field in ("active_ref_videos", "active_ref_audios"):
                    active_media = shot.get(field)
                    if not isinstance(active_media, list):
                        active_media = [1, 2, 3]
                    valid_media = set()
                    for value in active_media:
                        try:
                            number = int(value)
                        except (TypeError, ValueError):
                            continue
                        if 1 <= number <= 3:
                            valid_media.add(number)
                    item[field] = sorted(valid_media)
            cleaned.append(item)

        if mode in ("T2V", "I2V"):
            state = {
                "version": 1, "kind": "it2v",
                "t2v_shots": cleaned, "i2v_shots": cleaned}
            t2v, i2v, count = build_it2v_scripts(json.dumps(state))
            script = t2v if mode == "T2V" else i2v
            validated = {
                "mode": mode,
                "continuity_bible": continuity_bible,
                "shots": cleaned,
            }
        else:
            allowed = {
                "keyframe completion", "reference generation",
                "video editing", "video continuation",
                "audio reuse", "audio reference"}
            llm_types = data.get("task_types")
            if not isinstance(llm_types, list):
                llm_types = []
            llm_types = [value for value in llm_types if value in allowed]
            llm_audio_types = [
                value for value in llm_types
                if value in ("audio reuse", "audio reference")]

            if mode == "KEYFRAMES":
                task_types = ["keyframe completion"] + llm_audio_types
            elif mode == "VIDEO EXTENSION":
                task_types = ["video continuation"]
                if int(available_pictures) > 0:
                    task_types.append("reference generation")
                task_types += llm_audio_types
            elif mode == "VIDEO EDITING":
                task_types = ["video editing"]
                if int(available_pictures) > 0:
                    task_types.append("reference generation")
                task_types += llm_audio_types
            else:
                task_types = llm_types or ["reference generation"]
                if picture1_as_start:
                    for value in (
                            "keyframe completion", "reference generation"):
                        if value not in task_types:
                            task_types.append(value)

            policy = str(source_video_audio).upper()
            if mode in ("VIDEO EXTENSION", "VIDEO EDITING"):
                task_types = [
                    value for value in task_types
                    if value not in ("audio reuse", "audio reference")]
                if policy == "AUTO":
                    policy = (
                        "REFERENCE"
                        if mode == "VIDEO EXTENSION" else "REUSE")
                if policy == "REFERENCE":
                    task_types.append("audio reference")
                elif policy == "REUSE":
                    task_types.append("audio reuse")
            task_types = list(dict.fromkeys(task_types))

            state = {
                "version": 1,
                "kind": "r2v",
                "subject_definitions": str(
                    data.get("subject_definitions") or "").strip(),
                "task_types": task_types,
                "summary": str(data.get("summary") or "").strip(),
                "retention_analysis": str(
                    data.get("retention_analysis") or "").strip(),
                "style": str(data.get("style") or "").strip(),
                "shots": cleaned,
            }
            for key in (
                    "subject_definitions", "summary", "retention_analysis"):
                if not state[key]:
                    raise ValueError(
                        "%s LLM JSON requires non-empty %s." % (mode, key))
            script, count = build_r2v_script(json.dumps(state))
            validated = dict(state)
            validated["mode"] = mode

        shot_seconds = _snap_shot_seconds(shot_seconds)
        validated_json = json.dumps(
            validated, ensure_ascii=False, indent=2)
        if save_debug_plan:
            try:
                import folder_paths
                base = str(
                    debug_filename_prefix or
                    "H3_AIO_AUTOPROMPT_DEBUG/plan")
                base = base.replace("\\", "/").strip("/")
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
                path = os.path.join(
                    folder_paths.get_output_directory(),
                    "%s_%s.json" % (base, stamp))
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(validated_json)
                print("[H3AIO] validated plan saved: %s" % path, flush=True)
            except Exception as exc:
                print("[H3AIO] debug save skipped: %s" % exc, flush=True)
        return script, count, SHOT_FRAMES[shot_seconds], validated_json

class H3AIOGenerationRouter:
    """Route one validated script and compact Fantastic-loader media."""
    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "keyframe_positions": ("STRING", {"forceInput": True}),
            "source_video_audio": ("STRING", {"forceInput": True}),
        }
        optional.update(_media_inputs())
        return {
            "required": {
                "script": ("STRING", {"forceInput": True, "lazy": True}),
                "generation_mode": ("STRING", {"forceInput": True}),
                "picture1_as_start": ("BOOLEAN", {"forceInput": True}),
                "audio_1_role": ("STRING", {"forceInput": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = (
        "STRING", "IMAGE", "AUDIO",
        "IMAGE", "IMAGE", "IMAGE", "IMAGE",
        "IMAGE", "AUDIO", "AUDIO", "AUDIO",
        "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE",
        "H3_KEYFRAME_PLAN", "AUDIO")
    RETURN_NAMES = (
        "script", "start_image", "voice_ref",
        "ref_image_0", "ref_image_1", "ref_image_2", "ref_image_3",
        "ref_video_0", "ref_video_audio_0", "ref_audio_0", "ref_audio_1",
        "ref_image_4", "ref_image_5", "ref_image_6", "ref_image_7",
        "ref_image_8", "keyframe_plan", "exact_soundtrack")
    FUNCTION = "route"
    CATEGORY = "utils/minimax/aio"

    @classmethod
    def check_lazy_status(cls, generation_mode, **kwargs):
        needed = []
        if kwargs.get("script") is None:
            needed.append("script")
        needed.extend(_needed_media(generation_mode, kwargs))
        if (str(kwargs.get("audio_1_role", "")) in (
                "exact_soundtrack", "exact_soundtrack_plus_h3_sfx",
                "music_video_lipsync")
                and kwargs.get("audio_1") is None):
            needed.append("audio_1")
        return needed

    @staticmethod
    def _route_generic_audio(audios, role):
        voice = None
        generic = list(audios)
        if str(role) == "voice_ref" and generic:
            voice = generic.pop(0)
        elif str(role) in (
                "ignore", "exact_soundtrack",
                "exact_soundtrack_plus_h3_sfx",
                "music_video_lipsync") and generic:
            generic.pop(0)
        generic = (generic + [None, None])[:2]
        return voice, generic

    def route(self, script, generation_mode, picture1_as_start,
              audio_1_role, keyframe_positions="AUTO",
              source_video_audio="AUTO", **media):
        mode = str(generation_mode).upper()
        pictures = [media.get("picture_%d" % i) for i in range(1, 10)]
        pictures = [value for value in pictures if value is not None]
        videos = [media.get("video_%d" % i) for i in range(1, 4)]
        videos = [value for value in videos if value is not None]
        video_audios = [
            media.get("video_audio_%d" % i) for i in range(1, 4)]
        video_audios = [
            _ensure_stereo_audio(value, "Video Audio %d" % (index + 1))
            for index, value in enumerate(video_audios) if value is not None]
        audios = [media.get("audio_%d" % i) for i in range(1, 4)]
        audios = [
            _ensure_stereo_audio(value, "Audio %d" % (index + 1))
            for index, value in enumerate(audios) if value is not None]
        exact_soundtrack = (
            audios[0]
            if str(audio_1_role) in (
                "exact_soundtrack", "exact_soundtrack_plus_h3_sfx",
                "music_video_lipsync") and audios
            else None)

        if mode == "T2V":
            print("[H3AIO] mode=T2V; all media ignored.", flush=True)
            return (script, None, None) + (None,) * 14 + (exact_soundtrack,)
        if mode == "I2V":
            if not pictures:
                raise ValueError(
                    "I2V requires Picture 1 in Fantastic H3 Media Loader.")
            print(
                "[H3AIO] mode=I2V; Picture 1 is the start frame.",
                flush=True)
            return ((script, pictures[0], None) + (None,) * 14
                    + (exact_soundtrack,))

        voice, generic = self._route_generic_audio(audios, audio_1_role)
        if mode == "KEYFRAMES":
            if not pictures:
                raise ValueError(
                    "KEYFRAMES requires at least Picture 1.")
            plan = {
                "images": pictures,
                "positions": str(keyframe_positions).strip() or "AUTO",
            }
            print(
                "[H3AIO] mode=KEYFRAMES; %d concrete anchor(s), "
                "schedule=%s." % (len(pictures), plan["positions"]),
                flush=True)
            return (
                script, None, voice,
                None, None, None, None,
                None, None, generic[0], generic[1],
                None, None, None, None, None, plan, exact_soundtrack)

        if mode not in ("R2V", "VIDEO EXTENSION", "VIDEO EDITING"):
            raise ValueError("Unknown generation mode: %s" % mode)
        if mode in ("VIDEO EXTENSION", "VIDEO EDITING") and not videos:
            raise ValueError("%s requires Video 1." % mode)
        if (mode == "R2V" and not pictures and not videos
                and not audios and not video_audios):
            raise ValueError("R2V selected but no references are loaded.")

        refs = (pictures + [None] * 9)[:9]
        video = videos[0] if videos else None
        if mode == "VIDEO EXTENSION":
            start = video[-1:]
        elif mode == "VIDEO EDITING":
            start = None
        else:
            start = (
                pictures[0]
                if pictures and picture1_as_start else None)

        policy = str(source_video_audio).upper()
        if policy == "AUTO":
            policy = (
                "REFERENCE" if mode == "VIDEO EXTENSION"
                else "REUSE" if mode == "VIDEO EDITING"
                else "REFERENCE")
        video_audio = (
            video_audios[0]
            if video is not None and video_audios and policy != "IGNORE"
            else None)
        print(
            "[H3AIO] mode=%s; pictures=%d video=%s video_audio=%s(%s) "
            "voice=%s reference_audio=%d start=%s"
            % (mode, len(pictures), video is not None,
               video_audio is not None, policy, voice is not None,
               sum(value is not None for value in generic),
               start is not None),
            flush=True)
        operation_plan = (
            {"mode": mode}
            if mode in ("VIDEO EXTENSION", "VIDEO EDITING") else None)
        return (
            script, start, voice,
            refs[0], refs[1], refs[2], refs[3],
            video, video_audio, generic[0], generic[1],
            refs[4], refs[5], refs[6], refs[7], refs[8],
            operation_plan, exact_soundtrack)


class H3AIOFinalAudioRouter:
    """Choose H3 audio, exact Audio 1, or exact Audio 1 mixed with H3 SFX."""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "h3_generated_audio": ("AUDIO",),
            },
            "optional": {
                "exact_soundtrack": ("AUDIO",),
                "audio_mode": ("STRING", {"forceInput": True}),
                "h3_sfx_gain": ("FLOAT", {
                    "default": 0.30, "min": 0.0, "max": 1.0,
                    "step": 0.05}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("final_audio",)
    FUNCTION = "route"
    CATEGORY = "utils/minimax/aio"

    @staticmethod
    def _normalise_waveform(audio):
        wave = audio["waveform"]
        if wave.ndim == 1:
            wave = wave.unsqueeze(0).unsqueeze(0)
        elif wave.ndim == 2:
            wave = wave.unsqueeze(0)
        return wave.float()

    @classmethod
    def _mix_exact_with_h3(cls, exact, h3, gain):
        import torch
        import torch.nn.functional as functional

        exact_wave = cls._normalise_waveform(exact)
        h3_wave = cls._normalise_waveform(h3)
        exact_rate = int(exact["sample_rate"])
        h3_rate = int(h3["sample_rate"])
        if h3_rate != exact_rate:
            new_length = max(
                1, int(round(h3_wave.shape[-1] * exact_rate / h3_rate)))
            h3_wave = functional.interpolate(
                h3_wave, size=new_length, mode="linear",
                align_corners=False)
        exact_wave = exact_wave[:1]
        h3_wave = h3_wave[:1].to(
            device=exact_wave.device, dtype=exact_wave.dtype)
        channels = max(exact_wave.shape[1], h3_wave.shape[1])
        if exact_wave.shape[1] != channels:
            exact_wave = exact_wave.mean(dim=1, keepdim=True).expand(
                -1, channels, -1)
        if h3_wave.shape[1] != channels:
            h3_wave = h3_wave.mean(dim=1, keepdim=True).expand(
                -1, channels, -1)
        target_length = max(exact_wave.shape[-1], h3_wave.shape[-1])
        if exact_wave.shape[-1] < target_length:
            exact_wave = functional.pad(
                exact_wave, (0, target_length - exact_wave.shape[-1]))
        else:
            exact_wave = exact_wave[..., :target_length]
        if h3_wave.shape[-1] < target_length:
            h3_wave = functional.pad(
                h3_wave, (0, target_length - h3_wave.shape[-1]))
        else:
            h3_wave = h3_wave[..., :target_length]
        mixed = exact_wave + h3_wave * float(gain)
        peak = mixed.abs().amax()
        if torch.isfinite(peak) and peak.item() > 0.999:
            mixed = mixed * (0.999 / peak)
        return {"waveform": mixed, "sample_rate": exact_rate}

    def route(self, h3_generated_audio, exact_soundtrack=None,
              audio_mode="reference_audio", h3_sfx_gain=0.30):
        mode = str(audio_mode)
        if (exact_soundtrack is not None
                and mode == "exact_soundtrack_plus_h3_sfx"):
            print(
                "[H3AIO] final mux mixes exact Audio 1 + H3 SFX "
                "(gain %.2f)." % float(h3_sfx_gain), flush=True)
            return (_ensure_stereo_audio(self._mix_exact_with_h3(
                exact_soundtrack, h3_generated_audio, h3_sfx_gain),
                "final mixed audio"),)
        if exact_soundtrack is not None:
            print(
                "[H3AIO] final mux uses Audio 1 exact soundtrack; "
                "H3-generated audio is discarded.", flush=True)
            return (_ensure_stereo_audio(exact_soundtrack, "final exact soundtrack"),)
        print("[H3AIO] final mux uses H3-generated audio.", flush=True)
        return (_ensure_stereo_audio(h3_generated_audio, "final H3 audio"),)


NODE_CLASS_MAPPINGS = {
    "H3AIOAutopromptRequest": H3AIOAutopromptRequest,
    "H3AIOPlanParser": H3AIOPlanParser,
    "H3AIOGenerationRouter": H3AIOGenerationRouter,
    "H3AIOFinalAudioRouter": H3AIOFinalAudioRouter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "H3AIOAutopromptRequest": "H3 AIO - Natural Prompt + Media Context",
    "H3AIOPlanParser": "H3 AIO - Validate LLM Plan",
    "H3AIOGenerationRouter": "H3 AIO - Mode + Media Router",
    "H3AIOFinalAudioRouter": "H3 AIO - Final Audio (H3 or Exact Audio 1)",
}

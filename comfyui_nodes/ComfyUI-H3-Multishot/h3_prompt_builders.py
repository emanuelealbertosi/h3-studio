# -*- coding: utf-8 -*-
"""Structured, dynamic prompt builders for H3 multishot workflows.

The browser UI stores only user-authored content as JSON. These nodes add the
strict MiniMax H3 section names, local [Shot 1] marker, I2V anchor and multishot
--- separators at execution time.
"""
import json
import re


_I2V_ANCHOR = (
    "For the target video, at 0.00 seconds into the target video, "
    "<Picture 1> (from [Shot 1]) is fully referenced."
)
_TASK_TYPES = (
    "keyframe completion",
    "reference generation",
    "video editing",
    "video continuation",
    "audio reuse",
    "audio reference",
)

_REF_DIRECTIVES = {
    "active_ref_images": "__H3_ACTIVE_PICTURES__:",
    "active_ref_videos": "__H3_ACTIVE_VIDEOS__:",
    "active_ref_audios": "__H3_ACTIVE_AUDIOS__:",
}
_MAX_REF_IMAGES = 9
_MAX_REF_MEDIA = 3

_IT2V_DEFAULT = json.dumps({
    "version": 1,
    "kind": "it2v",
    "t2v_shots": [{
        "description": "",
        "soundscape": "",
        "music": "N/A",
    }],
    "i2v_shots": [{
        "description": "",
        "soundscape": "",
        "music": "N/A",
    }],
}, ensure_ascii=False, separators=(",", ":"))

_R2V_DEFAULT = json.dumps({
    "version": 1,
    "kind": "r2v",
    "subject_definitions": "",
    "task_types": ["reference generation"],
    "summary": "",
    "retention_analysis": "",
    "style": "",
    "shots": [{
        "description": "",
        "soundscape": "",
        "music": "N/A",
        "active_ref_images": list(range(1, _MAX_REF_IMAGES + 1)),
        "active_ref_videos": list(range(1, _MAX_REF_MEDIA + 1)),
        "active_ref_audios": list(range(1, _MAX_REF_MEDIA + 1)),
    }],
}, ensure_ascii=False, separators=(",", ":"))


def _strip_heading(value, *headings):
    """Accept pasted complete sections without duplicating their heading."""
    text = str(value or "").strip()
    for heading in headings:
        text = re.sub(
            rf"^\s*{re.escape(heading)}\s*:\s*", "", text,
            count=1, flags=re.IGNORECASE)
    return text.strip()


def _normalise_shots(raw_shots):
    if not isinstance(raw_shots, list):
        raw_shots = []
    shots = []
    for raw in raw_shots[:64]:
        if not isinstance(raw, dict):
            raw = {}
        shot = {
            "description": str(raw.get("description") or ""),
            "soundscape": str(raw.get("soundscape") or ""),
            "music": str(raw.get("music") or "N/A"),
        }
        # Missing means legacy behaviour: every connected image stays active.
        # An explicit list enables the new per-shot reference schedule.
        if "active_ref_images" in raw:
            selected = raw.get("active_ref_images")
            if selected is None:
                selected = list(range(1, _MAX_REF_IMAGES + 1))
            elif not isinstance(selected, list):
                selected = []
            shot["active_ref_images"] = sorted({
                int(item) for item in selected
                if str(item).isdigit()
                and 1 <= int(item) <= _MAX_REF_IMAGES
            })
        for field in ("active_ref_videos", "active_ref_audios"):
            if field not in raw:
                continue
            selected = raw.get(field)
            if selected is None:
                selected = list(range(1, _MAX_REF_MEDIA + 1))
            elif not isinstance(selected, list):
                selected = []
            shot[field] = sorted({
                int(item) for item in selected
                if str(item).isdigit()
                and 1 <= int(item) <= _MAX_REF_MEDIA
            })
        shots.append(shot)
    if not shots:
        shots.append({"description": "", "soundscape": "", "music": "N/A"})
    return shots


def _load_state(state_json, kind):
    try:
        state = json.loads(state_json or "{}")
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"H3 {kind} prompt-builder state is invalid JSON: {exc}") from exc
    if not isinstance(state, dict):
        raise ValueError(f"H3 {kind} prompt-builder state must be a JSON object")

    if kind == "I/T2V":
        # Legacy states used one shared shots array. Keep accepting it so old
        # workflows behave exactly as before while new workflows can edit T2V
        # and I2V independently.
        legacy = state.get("shots")
        state["t2v_shots"] = _normalise_shots(
            state.get("t2v_shots", legacy))
        state["i2v_shots"] = _normalise_shots(
            state.get("i2v_shots", legacy))
    else:
        state["shots"] = _normalise_shots(state.get("shots"))
    return state


def _classic_blocks(script):
    """Split a free-form classic script exactly like the multishot sampler."""
    text = str(script or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []
    return [
        block.strip() for block in re.split(r"\n[ \t]*---[ \t]*(?:\n|$)", text)
        if block.strip()
    ][:64]


def _classic_script(state, key):
    """Return normalized classic text while preserving all authored content."""
    return "\n---\n".join(_classic_blocks(state.get(key)))


def _local_shot_description(value):
    text = _strip_heading(
        value, "integrated_multimodal_description", "detailed_description")
    if re.match(r"^\s*\[Shot\s+\d+\]", text, flags=re.IGNORECASE):
        return text
    return f"[Shot 1] {text}".rstrip()


def _base_block(shot, anchored):
    description = _local_shot_description(shot.get("description"))
    soundscape = _strip_heading(
        shot.get("soundscape"), "overall_soundscape")
    music = _strip_heading(
        shot.get("music"), "non_diegetic_music") or "N/A"
    body = (
        f"integrated_multimodal_description: {description}\n\n"
        f"overall_soundscape: {soundscape}\n\n"
        f"non_diegetic_music: {music}"
    )
    return f"{_I2V_ANCHOR}\n\n{body}" if anchored else body


def build_it2v_scripts(state_json):
    """Return independent T2V/I2V scripts and the largest shot count."""
    state = _load_state(state_json, "I/T2V")
    if state.get("editor_mode") == "classic":
        t2v = _classic_script(state, "classic_t2v_script")
        i2v = _classic_script(state, "classic_i2v_script")
        if not t2v or not i2v:
            raise ValueError(
                "H3 classic I/T2V mode requires both the T2V and I2V text boxes")
        return t2v, i2v, max(
            len(_classic_blocks(t2v)), len(_classic_blocks(i2v)))
    t2v_shots = state["t2v_shots"]
    i2v_shots = state["i2v_shots"]
    # Pure T2V starts without a keyframe. Every later segment is chained I2V.
    t2v = "\n---\n".join(
        _base_block(shot, anchored=index > 0)
        for index, shot in enumerate(t2v_shots))
    # External-start I2V and every continuation segment use the exact anchor.
    i2v = "\n---\n".join(
        _base_block(shot, anchored=True) for shot in i2v_shots)
    return t2v, i2v, max(len(t2v_shots), len(i2v_shots))


def _summary_line(state, summary_override=None):
    summary = _strip_heading(
        state.get("summary") if summary_override is None else summary_override,
        "summary")
    # The task prefix is derived from validated router state, never trusted
    # from LLM prose. This prevents an incorrect prefix from surviving after
    # the parser has corrected task_types.
    summary = re.sub(r"^\s*\[[^\]]+\]\s*", "", summary, count=1)
    selected = state.get("task_types")
    if not isinstance(selected, list):
        selected = []
    selected = [item for item in _TASK_TYPES if item in selected]
    if not selected:
        selected = ["reference generation"]
    prefix = f"[{' + '.join(selected)}]"
    return f"{prefix} {summary}".rstrip()


def _has_reference_entry(value, label):
    return bool(re.search(
        rf"(?i)(?:^|\s){re.escape(label)}(?:\s|\(|:)", str(value or "")))


def _reference_lines(value):
    """Normalize compact LLM prose to the official one-entry-per-line form."""
    text = str(value or "").strip()
    text = re.sub(
        r"\s+(?=<(?:Subject|Picture|Video|Audio)\s+\d+>\s+(?:is|\())",
        "\n", text, flags=re.IGNORECASE)
    return [line.strip() for line in text.splitlines() if line.strip()]


def _append_reference_entry(value, label, entry, prepend=False):
    lines = _reference_lines(value)
    if not _has_reference_entry("\n".join(lines), label):
        lines.insert(0, entry) if prepend else lines.append(entry)
    return "\n".join(lines)


def _editing_description(value):
    text = str(value or "").strip()
    if "<Video 1>" in text:
        return text
    marker = re.search(r"\[Shot\s+1\]", text, flags=re.IGNORECASE)
    clause = (
        " Using the exact corresponding temporal segment of <Video 1> as "
        "the editing source, preserve its timing, motion, camera behavior, "
        "spatial continuity and every unspecified visible attribute.")
    if marker:
        return text[:marker.end()] + clause + " " + text[marker.end():].lstrip()
    return "[Shot 1]" + clause + " " + text


def _official_reference_contract(state, subjects, retention, description):
    """Fill mandatory full-reference relationships deterministically."""
    task_types = set(state.get("task_types") or [])
    if "video editing" in task_types:
        subjects = _append_reference_entry(
            subjects, "<Video 1>",
            "<Video 1> is the source video for the target video edit.",
            prepend=True)
        retention = _append_reference_entry(
            retention, "<Video 1>",
            "<Video 1> (source timeline and temporal structure): "
            "fully_preserved - preserve its timing, motion, cuts, camera "
            "behavior and spatial continuity except for changes explicitly "
            "requested by the user.",
            prepend=True)
        description = _editing_description(description)

    if "video continuation" in task_types:
        subjects = _append_reference_entry(
            subjects, "<Video 1>",
            "<Video 1> is the source video continued by the target video.",
            prepend=True)
        retention = _append_reference_entry(
            retention, "<Video 1>",
            "<Video 1> (final source state): fully_preserved - the target "
            "continues from its exact ending state without restarting it.",
            prepend=True)

    if "audio reuse" in task_types:
        subjects = _append_reference_entry(
            subjects, "<Audio 1>",
            "<Audio 1> is the synchronized audio track of <Video 1> and is "
            "reused in the target video.")
        retention = _append_reference_entry(
            retention, "<Audio 1>",
            "<Audio 1>: fully_copy - the synchronized source audio is reused "
            "1:1 as the target video's complete final audio track.")
    elif "audio reference" in task_types:
        subjects = _append_reference_entry(
            subjects, "<Audio 1>",
            "<Audio 1> is the synchronized audio reference associated with "
            "<Video 1>.")
        retention = _append_reference_entry(
            retention, "<Audio 1>",
            "<Audio 1>: reference - its audible continuity guides the target "
            "without copying the original signal.")

    return subjects, retention, description


def _reference_entries(value):
    """Split one-reference-per-line prose, including compact legacy prose."""
    text = str(value or "").strip()
    text = re.sub(
        r"\s+(?=<(?:Subject|Picture|Video|Audio)\s+\d+>\s+is\b)",
        "\n", text, flags=re.IGNORECASE)
    return [line.strip() for line in text.splitlines() if line.strip()]


def _scheduled_sections(state, shot, selected):
    """Remove inactive visual references from this shot's global sections."""
    active = set(selected)
    inactive_pictures = set(range(1, _MAX_REF_IMAGES + 1)) - active
    inactive_subjects = set()
    kept_subjects = []
    picture_pattern = re.compile(r"<Picture\s+(\d+)>", re.IGNORECASE)
    subject_pattern = re.compile(r"<Subject\s+(\d+)>", re.IGNORECASE)

    for entry in _reference_entries(state.get("subject_definitions")):
        pictures = {int(value) for value in picture_pattern.findall(entry)}
        if pictures and pictures.isdisjoint(active):
            inactive_subjects.update(
                int(value) for value in subject_pattern.findall(entry))
            continue
        kept_subjects.append(entry)

    kept_retention = []
    for entry in _reference_entries(state.get("retention_analysis")):
        pictures = {int(value) for value in picture_pattern.findall(entry)}
        subjects = {int(value) for value in subject_pattern.findall(entry)}
        if pictures.intersection(inactive_pictures):
            continue
        if subjects.intersection(inactive_subjects):
            continue
        kept_retention.append(entry)

    description = str(shot.get("description") or "").strip()
    if inactive_subjects:
        inactive_pattern = re.compile(
            r"<Subject\s+(?:%s)>" % "|".join(
                str(value) for value in sorted(inactive_subjects)),
            re.IGNORECASE)
        # Negative mentions such as "<Subject 1> is not visible" still prime
        # the model. Drop the complete sentence whenever that subject's image
        # has been disabled for this shot.
        sentences = re.split(r"(?<=[.!?])\s+", description)
        description = " ".join(
            sentence for sentence in sentences
            if not inactive_pattern.search(sentence)).strip()

    task_types = set(state.get("task_types") or [])
    if "video editing" in task_types:
        summary = (
            "The target video is an edited version of <Video 1>. "
            "This segment uses only the active references selected for this "
            "shot and follows the edit described in [Shot 1].")
    elif "video continuation" in task_types:
        summary = (
            "The target video continues <Video 1> using only the active "
            "references selected for this shot and follows the action "
            "described in [Shot 1].")
    else:
        summary = (
            "The target segment uses only the active references selected for "
            "this shot and follows the action described in [Shot 1].")

    return (
        "\n".join(kept_subjects),
        "\n".join(kept_retention),
        description,
        summary,
    )


def _r2v_block(state, shot):
    selected = shot.get("active_ref_images")
    directive_lines = []
    if isinstance(selected, list):
        selected = sorted({
            int(value) for value in selected
            if 1 <= int(value) <= _MAX_REF_IMAGES
        })
    scheduled = (
        isinstance(selected, list)
        and selected != list(range(1, _MAX_REF_IMAGES + 1)))
    if scheduled:
        subjects, retention, raw_description, summary = _scheduled_sections(
            state, shot, selected)
        directive_lines.append(
            _REF_DIRECTIVES["active_ref_images"]
            + (",".join(str(value) for value in selected) or "none"))
    else:
        subjects = _strip_heading(
            state.get("subject_definitions"), "subject_definitions")
        retention = _strip_heading(
            state.get("retention_analysis"), "retention_analysis")
        raw_description = shot.get("description")
        summary = None

    for field in ("active_ref_videos", "active_ref_audios"):
        media_selected = shot.get(field)
        if not isinstance(media_selected, list):
            continue
        media_selected = sorted({
            int(value) for value in media_selected
            if 1 <= int(value) <= _MAX_REF_MEDIA
        })
        directive_lines.append(
            _REF_DIRECTIVES[field]
            + (",".join(str(value) for value in media_selected) or "none"))

    subjects, retention, raw_description = _official_reference_contract(
        state, subjects, retention, raw_description)
    style = str(state.get("style") or "").strip()
    if "video editing" in set(state.get("task_types") or []):
        preservation_lock = (
            "Source-video preservation lock: preserve exactly every visible "
            "identity, face, body, wardrobe, prop, environment, lighting, "
            "composition and camera attribute from the corresponding frame of "
            "<Video 1> unless the user explicitly requests that attribute to "
            "change; never reinterpret unspecified source details.")
        style = " ".join(part for part in (preservation_lock, style) if part)
    description = _local_shot_description(raw_description)
    detail = "\n".join(part for part in (style, description) if part)
    soundscape = _strip_heading(
        shot.get("soundscape"), "overall_soundscape")
    music = _strip_heading(
        shot.get("music"), "non_diegetic_music") or "N/A"
    directive = "\n".join(directive_lines)
    if directive:
        directive += "\n"
    return directive + (
        f"subject_definitions:\n{subjects}\n\n"
        f"summary:\n{_summary_line(state, summary)}\n\n"
        f"retention_analysis:\n{retention}\n\n"
        f"detailed_description:\n{detail}\n\n"
        f"overall_soundscape:\n{soundscape}\n\n"
        f"non_diegetic_music:\n{music}"
    )

def build_r2v_script(state_json):
    """Return a full six-section reference prompt for every multishot segment."""
    state = _load_state(state_json, "R2V")
    if state.get("editor_mode") == "classic":
        script = _classic_script(state, "classic_r2v_script")
        if not script:
            raise ValueError("H3 classic R2V mode requires a non-empty text box")
        return script, len(_classic_blocks(script))
    script = "\n---\n".join(
        _r2v_block(state, shot) for shot in state["shots"])
    return script, len(state["shots"])


class H3IT2VShotPromptBuilder:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "state_json": ("STRING", {
                "default": _IT2V_DEFAULT,
                "multiline": False,
                "dynamicPrompts": False,
                "hidden": True,
                "tooltip": "Serialized by the structured shot editor.",
            }),
        }}

    RETURN_TYPES = ("STRING", "STRING", "INT")
    RETURN_NAMES = ("t2v_script", "i2v_script", "shot_count")
    FUNCTION = "build"
    CATEGORY = "conditioning/minimax"

    def build(self, state_json):
        return build_it2v_scripts(state_json)


class H3R2VShotPromptBuilder:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "state_json": ("STRING", {
                "default": _R2V_DEFAULT,
                "multiline": False,
                "dynamicPrompts": False,
                "hidden": True,
                "tooltip": "Serialized by the structured reference editor.",
            }),
        }}

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("reference_script", "shot_count")
    FUNCTION = "build"
    CATEGORY = "conditioning/minimax"

    def build(self, state_json):
        return build_r2v_script(state_json)


NODE_CLASS_MAPPINGS = {
    "H3IT2VShotPromptBuilder": H3IT2VShotPromptBuilder,
    "H3R2VShotPromptBuilder": H3R2VShotPromptBuilder,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3IT2VShotPromptBuilder": "H3 I/T2V Prompt Builder (+ shots)",
    "H3R2VShotPromptBuilder": "H3 R2V Prompt Builder (+ shots)",
}

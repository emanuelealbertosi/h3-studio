# -*- coding: utf-8 -*-
"""Normalize MiniMax H3 internal-shot markers and timestamps."""
import re


SHOT_TAG = re.compile(
    r"\[\s*Shot\s+(\d+)\s*\]"
    r"(?:\s+At\s+(\d{1,2}):(\d{2})\.(\d{3}))?",
    flags=re.IGNORECASE)


def timestamp_seconds(match):
    if match.group(2) is None:
        return None
    return (
        int(match.group(2)) * 60
        + int(match.group(3))
        + int(match.group(4)) / 1000.0)


def _format_timestamp(value):
    milliseconds = max(0, int(round(float(value) * 1000.0)))
    minutes, remainder = divmod(milliseconds, 60000)
    seconds, millis = divmod(remainder, 1000)
    return "%02d:%02d.%03d" % (minutes, seconds, millis)


def ensure_internal_timestamps(description, duration_seconds):
    """Return an H3 description with deterministic internal-shot timecodes."""
    text = str(description or "").strip()
    duration = max(0.002, float(duration_seconds))
    matches = list(SHOT_TAG.finditer(text))
    if not matches:
        return ("[Shot 1] " + text).strip(), True, "added [Shot 1]"

    valid = True
    previous = -1.0
    for order, match in enumerate(matches, start=1):
        number = int(match.group(1))
        stamp = timestamp_seconds(match)
        if number != order:
            valid = False
        if order == 1:
            if stamp is not None:
                valid = False
        elif stamp is None or stamp <= previous or stamp >= duration:
            valid = False
        if stamp is not None:
            previous = stamp

    if valid:
        return text, False, "timestamps already valid"

    count = len(matches)
    replacement_index = 0

    def replace(_match):
        nonlocal replacement_index
        replacement_index += 1
        if replacement_index == 1:
            return "[Shot 1]"
        stamp = min(
            duration - 0.001,
            duration * float(replacement_index - 1) / float(count))
        return "[Shot %d] At %s" % (
            replacement_index, _format_timestamp(stamp))

    fixed = SHOT_TAG.sub(replace, text)
    return fixed, True, "normalized %d internal shot marker(s)" % count


def flatten_monoshot_markers(description):
    """Keep one continuous Shot 1 while preserving later timed action beats.

    A single-shot I2V plan must not silently turn into a cut or a new camera
    setup. Remove only the extra structural markers; their prose and explicit
    timestamps remain available as chronological action within Shot 1.
    """
    text = str(description or "").strip()
    matches = list(SHOT_TAG.finditer(text))
    if len(matches) <= 1:
        return text, False, "single continuous shot already valid"

    first = matches[0]
    if int(first.group(1)) != 1:
        return text, False, "first internal marker is not Shot 1"

    removed = 0

    def replace(match):
        nonlocal removed
        if match.start() == first.start():
            return "[Shot 1]"
        removed += 1
        stamp = timestamp_seconds(match)
        return " At %s" % _format_timestamp(stamp) if stamp is not None else " Then"

    flattened = SHOT_TAG.sub(replace, text)
    flattened = re.sub(r"[ \t]+", " ", flattened)
    return flattened.strip(), True, (
        "flattened %d extra internal shot marker(s) into action beats" % removed)


def _internal_segments(description):
    """Return the prose belonging to each internal Shot marker."""
    text = str(description or "").strip()
    matches = list(SHOT_TAG.finditer(text))
    if not matches:
        return [text] if text else []

    prefix = text[:matches[0].start()].strip()
    segments = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end():end].strip(" \t\r\n,;")
        if index == 0 and prefix:
            body = (prefix + " " + body).strip()
        if body:
            segments.append(body)
    return segments


def collapse_planned_clips(shots, duration_seconds):
    """Collapse several top-level LLM clips into one timed H3 clip."""
    valid = [shot for shot in shots if isinstance(shot, dict)]
    if not valid:
        return shots, "no valid clips to collapse"

    segments = []
    for shot in valid:
        segments.extend(_internal_segments(shot.get("description")))
    if not segments:
        return shots, "no non-empty clip descriptions to collapse"

    marked = " ".join(
        "[Shot %d] %s" % (index, segment)
        for index, segment in enumerate(segments, start=1))
    description, _changed, _note = ensure_internal_timestamps(
        marked, duration_seconds)

    merged = dict(valid[0])
    merged["description"] = description

    for field in ("soundscape", "music"):
        values = []
        for shot in valid:
            value = str(shot.get(field) or "N/A").strip()
            if value and value.upper() != "N/A" and value not in values:
                values.append(value)
        merged[field] = " Then: ".join(values) if values else "N/A"

    for reference_field in (
            "active_ref_images", "active_ref_videos", "active_ref_audios"):
        if not any(reference_field in shot for shot in valid):
            continue
        references = set()
        for shot in valid:
            for value in shot.get(reference_field) or []:
                try:
                    references.add(int(value))
                except (TypeError, ValueError):
                    continue
        merged[reference_field] = sorted(references)

    return [merged], (
        "collapsed %d top-level clips into 1 clip with %d timed internal shots"
        % (len(valid), len(segments)))

# -*- coding: utf-8 -*-
"""Small, deterministic repairs for recurring planner JSON mistakes."""
import json
import re


_JSON_STRING = r'"(?:\\.|[^"\\])*"'
_SPLIT_DESCRIPTION = re.compile(
    r'(?P<prefix>"description"\s*:\s*)'
    r'(?P<first>%s)\s*,\s*'
    r'(?P<orphan>%s)\s*,'
    r'(?=\s*"(?:soundscape|music|active_ref_images|active_ref_videos|active_ref_audios)"\s*:)' % (
        _JSON_STRING, _JSON_STRING),
    flags=re.DOTALL)
_SHOT_START = re.compile(r"^\s*\[\s*Shot\s+\d+\s*\]", re.IGNORECASE)


def repair_split_description(value):
    """Merge a stray ``"[Shot N] ..."`` back into ``description``.

    Some local LLMs close the description after a continuity paragraph and
    emit the actual Shot text as a second, keyless JSON string.  The repair is
    deliberately narrow: it only runs between ``description`` and one of the
    known following shot fields, and only when the orphan starts with a Shot
    marker.
    """
    text = str(value or "")
    changed = False

    def replace(match):
        nonlocal changed
        try:
            first = json.loads(match.group("first"))
            orphan = json.loads(match.group("orphan"))
        except (TypeError, ValueError, json.JSONDecodeError):
            return match.group(0)
        if not isinstance(first, str) or not isinstance(orphan, str):
            return match.group(0)
        if not _SHOT_START.match(orphan):
            return match.group(0)
        changed = True
        merged = (first.rstrip() + " " + orphan.lstrip()).strip()
        return match.group("prefix") + json.dumps(
            merged, ensure_ascii=False) + ","

    return _SPLIT_DESCRIPTION.sub(replace, text), changed

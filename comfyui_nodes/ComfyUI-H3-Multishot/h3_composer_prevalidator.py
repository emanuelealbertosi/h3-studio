# -*- coding: utf-8 -*-
"""Deterministic pre-validation for LLM-authored MiniMax H3 AIO plans.

Independent implementation: no third-party prompt-composer source is included.
The existing H3AIOPlanParser remains the final authority after this preflight.
"""
import copy
import json
import re

from .h3_music_video import _extract_json as _extract_h3_json
from .h3_internal_timestamps import (
    SHOT_TAG as _SHOT_TAG,
    collapse_planned_clips,
    ensure_internal_timestamps,
    timestamp_seconds as _timestamp_seconds,
)
from .h3_json_repair import repair_split_description

_FULL_REFERENCE_MODES = {
    "R2V", "KEYFRAMES", "VIDEO EXTENSION", "VIDEO EDITING"}

_PICTURE_TAG = re.compile(r"<\s*Picture\s+(\d+)\s*>", re.IGNORECASE)
_NO_CUT = re.compile(
    r"\b(?:senza\s+(?:stacchi|tagli)|piano\s+sequenza|"
    r"no\s+cuts?|without\s+cuts?|single\s+take|one\s+continuous\s+shot|"
    r"continuous\s+take|unbroken\s+shot)\b",
    flags=re.IGNORECASE)


def _extract_json_object(value):
    try:
        data = _extract_h3_json(value)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        repaired, changed = repair_split_description(value)
        if changed:
            try:
                data = _extract_h3_json(repaired)
                print(
                    "[H3Composer] repaired a split description/Shot field "
                    "in planner JSON.", flush=True)
            except (TypeError, ValueError, json.JSONDecodeError) as second_error:
                raise ValueError(
                    "Composer pre-validator repaired a split description but "
                    "the remaining plan JSON is invalid: %s" % second_error
                ) from second_error
        else:
            raise ValueError(
                "Composer pre-validator could not recover the complete plan "
                "JSON: %s" % error) from error
    if not isinstance(data, dict):
        raise ValueError(
            "Composer pre-validator requires one complete JSON object.")
    return data


def _natural_request(planner_request):
    text = str(planner_request or "")
    match = re.search(
        r"NATURAL USER REQUEST:\s*(.*?)\s*REFERENCE ROLE MAP:",
        text, flags=re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else text



def _one_take(description):
    """Turn internal cut markers into timed beats in one continuous shot."""
    text = str(description or "").strip()
    matches = list(_SHOT_TAG.finditer(text))
    if not matches:
        return "[Shot 1] One continuous unbroken shot with no cuts. " + text

    def replace(match):
        number = int(match.group(1))
        if number == 1:
            return ""
        if match.group(2) is not None:
            stamp = "%02d:%02d.%s" % (
                int(match.group(2)), int(match.group(3)), match.group(4))
            return " At %s, continuing in the same unbroken shot," % stamp
        return " Then, continuing in the same unbroken shot,"

    text = _SHOT_TAG.sub(replace, text)
    text = re.sub(r"\s+", " ", text).strip(" ,")
    return "[Shot 1] One continuous unbroken shot with no cuts. " + text


class H3AIOComposerPreValidator:
    """Preflight and conservatively repair a LLM H3 plan."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "llm_response": ("STRING", {"forceInput": True}),
                "planner_request": ("STRING", {"forceInput": True}),
                "generation_mode": ("STRING", {"forceInput": True}),
                "shot_seconds": ("INT", {"forceInput": True}),
                "max_shots": ("INT", {"forceInput": True}),
                "available_pictures": ("INT", {"forceInput": True}),
                "exact_shots": ("BOOLEAN", {"forceInput": True}),
                "repair_mode": ((
                    "SAFE AUTO-FIX", "REPORT ONLY", "STRICT"), {
                        "default": "SAFE AUTO-FIX"}),
                "cut_policy": ((
                    "AUTO FROM REQUEST", "KEEP LLM", "ONE TAKE PER CLIP"), {
                        "default": "AUTO FROM REQUEST"}),
                "reference_policy": ((
                    "CONTINUITY UNION", "KEEP LLM", "ALL CONNECTED"), {
                        "default": "CONTINUITY UNION"}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "BOOLEAN")
    RETURN_NAMES = (
        "prevalidated_json", "composer_report", "issue_count", "changed")
    FUNCTION = "prevalidate"
    CATEGORY = "utils/minimax/aio"
    OUTPUT_NODE = True

    def prevalidate(
            self, llm_response, planner_request, generation_mode,
            shot_seconds, max_shots, available_pictures, exact_shots,
            repair_mode="SAFE AUTO-FIX", cut_policy="AUTO FROM REQUEST",
            reference_policy="CONTINUITY UNION"):
        original = _extract_json_object(llm_response)
        data = copy.deepcopy(original)
        mode = str(generation_mode or "").upper().strip()
        seconds = max(1, int(shot_seconds))
        maximum = max(1, int(max_shots))
        picture_count = max(0, int(available_pictures))
        auto_fix = repair_mode == "SAFE AUTO-FIX"
        issues, fixes = [], []

        returned_mode = str(data.get("mode") or mode).upper().strip()
        if returned_mode != mode:
            issues.append(
                "ERROR: plan mode %s conflicts with router mode %s."
                % (returned_mode, mode))
            if auto_fix:
                data["mode"] = mode
                fixes.append("Router mode enforced: %s." % mode)

        shots = data.get("shots")
        if not isinstance(shots, list) or not shots:
            raise ValueError(
                "Composer pre-validation failed: shots must be a non-empty array.")
        if len(shots) > maximum:
            if auto_fix and maximum == 1:
                returned_count = len(shots)
                shots, collapse_note = collapse_planned_clips(
                    shots, seconds)
                data["shots"] = shots
                issues.append(
                    "WARNING: the planner returned %d clips for monoshot mode."
                    % returned_count)
                fixes.append(collapse_note + ".")
            else:
                issues.append(
                    "ERROR: %d clips exceed the configured maximum of %d."
                    % (len(shots), maximum))
        if bool(exact_shots) and len(shots) != maximum:
            issues.append(
                "ERROR: exact clip count is %d but the plan contains %d."
                % (maximum, len(shots)))

        natural = _natural_request(planner_request)
        wants_one_take = bool(_NO_CUT.search(natural))
        force_one_take = cut_policy == "ONE TAKE PER CLIP"
        auto_one_take = (
            cut_policy == "AUTO FROM REQUEST" and wants_one_take)

        duration_match = re.search(
            r"\b(?:in\s+)?1\s+(?:scena|scene|clip|shot)\b.{0,24}?"
            r"(\d+)\s*(?:s|sec|secondi|seconds?)\b",
            natural, flags=re.IGNORECASE | re.DOTALL)
        if duration_match and len(shots) > 1:
            issues.append(
                "WARNING: the request mentions one %ss scene, but the plan "
                "contains %d clips (%ds total)."
                % (duration_match.group(1), len(shots), len(shots) * seconds))

        union_refs = set()
        for index, shot in enumerate(shots):
            if not isinstance(shot, dict):
                issues.append(
                    "ERROR: clips[%d] is not an object." % (index + 1))
                continue
            description = str(shot.get("description") or "").strip()
            if not description:
                issues.append(
                    "ERROR: clip %d has an empty description." % (index + 1))
                continue

            if auto_fix:
                fixed_description, timestamps_changed, timestamp_note = (
                    ensure_internal_timestamps(description, seconds))
                if timestamps_changed:
                    shot["description"] = fixed_description
                    description = fixed_description
                    fixes.append(
                        "Clip %d internal timestamps repaired: %s."
                        % (index + 1, timestamp_note))

            tags = list(_SHOT_TAG.finditer(description))
            internal_count = max(1, len(tags))
            if internal_count > 1:
                issues.append(
                    "INFO: clip %d contains %d internal camera shots."
                    % (index + 1, internal_count))
            if wants_one_take and internal_count > 1:
                issues.append(
                    "WARNING: clip %d requests no cuts but contains %d Shot tags."
                    % (index + 1, internal_count))

            previous_time = -1.0
            expected_number = 1
            for tag in tags:
                number = int(tag.group(1))
                timestamp = _timestamp_seconds(tag)
                if number != expected_number:
                    issues.append(
                        "WARNING: clip %d Shot numbering jumps from %d to %d."
                        % (index + 1, expected_number, number))
                    expected_number = number
                expected_number += 1
                if number == 1 and timestamp is not None:
                    issues.append(
                        "WARNING: clip %d Shot 1 must not have a timestamp."
                        % (index + 1))
                if number > 1 and timestamp is None:
                    issues.append(
                        "WARNING: clip %d Shot %d has no timestamp."
                        % (index + 1, number))
                if timestamp is not None:
                    if timestamp <= previous_time:
                        issues.append(
                            "ERROR: clip %d timestamps are not increasing."
                            % (index + 1))
                    if timestamp >= seconds:
                        issues.append(
                            "ERROR: clip %d timestamp %.3fs is outside its %ds duration."
                            % (index + 1, timestamp, seconds))
                    previous_time = timestamp

            if (force_one_take or auto_one_take) and internal_count > 1:
                if auto_fix:
                    shot["description"] = _one_take(description)
                    fixes.append(
                        "Clip %d internal cuts converted to continuous timed beats."
                        % (index + 1))

            for picture in _PICTURE_TAG.findall(description):
                number = int(picture)
                if number > picture_count:
                    issues.append(
                        "ERROR: clip %d references unavailable Picture %d."
                        % (index + 1, number))

            if mode in _FULL_REFERENCE_MODES and mode != "KEYFRAMES":
                raw_refs = shot.get("active_ref_images")
                if not isinstance(raw_refs, list):
                    issues.append(
                        "WARNING: clip %d has no valid active_ref_images list."
                        % (index + 1))
                    refs = set(range(1, picture_count + 1))
                else:
                    refs = set()
                    for value in raw_refs:
                        try:
                            number = int(value)
                        except (TypeError, ValueError):
                            continue
                        if 1 <= number <= picture_count:
                            refs.add(number)
                    if len(refs) != len(raw_refs):
                        issues.append(
                            "WARNING: clip %d contains invalid/duplicate active references."
                            % (index + 1))
                union_refs.update(refs)
                if auto_fix and reference_policy == "ALL CONNECTED":
                    shot["active_ref_images"] = list(
                        range(1, picture_count + 1))
                elif auto_fix:
                    shot["active_ref_images"] = sorted(refs)

        if mode in _FULL_REFERENCE_MODES and mode != "KEYFRAMES":
            active_sets = []
            for shot in shots:
                if isinstance(shot, dict):
                    active_sets.append(tuple(
                        shot.get("active_ref_images") or []))
            if len(set(active_sets)) > 1:
                issues.append(
                    "WARNING: active reference sets change between clips; "
                    "identity or wardrobe continuity may drift.")
            if auto_fix and reference_policy == "CONTINUITY UNION":
                stable = sorted(union_refs)
                if not stable and picture_count:
                    stable = list(range(1, picture_count + 1))
                for shot in shots:
                    if isinstance(shot, dict):
                        shot["active_ref_images"] = stable
                if active_sets and any(
                        tuple(stable) != value for value in active_sets):
                    fixes.append(
                        "Active references unified across all clips: %s."
                        % (stable or "none"))

        if auto_fix and (
                "Audio 1 is added only" in str(planner_request)
                or "set every music field to N/A" in str(planner_request)):
            changed_music = False
            for shot in shots:
                if (isinstance(shot, dict)
                        and str(shot.get("music") or "N/A").strip().upper()
                        != "N/A"):
                    shot["music"] = "N/A"
                    changed_music = True
            if changed_music:
                fixes.append(
                    "Music fields set to N/A for external soundtrack routing.")

        output_data = data if auto_fix else original
        output_json = json.dumps(output_data, ensure_ascii=False, indent=2)
        changed = output_data != original
        error_count = sum(item.startswith("ERROR:") for item in issues)
        warning_count = sum(item.startswith("WARNING:") for item in issues)
        info_count = sum(item.startswith("INFO:") for item in issues)
        report_lines = [
            "H3 COMPOSER PRE-VALIDATION",
            "Mode: %s | clips: %d x %ds = %ds | pictures: %d"
            % (mode, len(shots), seconds, len(shots) * seconds, picture_count),
            "Issues: %d error(s), %d warning(s), %d info | fixes: %d"
            % (error_count, warning_count, info_count, len(fixes)),
        ]
        if issues:
            report_lines.extend(["", "CHECKS"])
            report_lines.extend("- " + item for item in issues)
        if fixes:
            report_lines.extend(["", "AUTO-FIXES"])
            report_lines.extend("- " + item for item in fixes)
        if not issues and not fixes:
            report_lines.append(
                "PASS: no structural inconsistency detected.")
        report = "\n".join(report_lines)

        print("[H3ComposerPreValidator]\n%s" % report, flush=True)
        if repair_mode == "STRICT" and error_count:
            raise ValueError(report)
        return {
            "ui": {"text": [report]},
            "result": (output_json, report, len(issues), bool(changed)),
        }


NODE_CLASS_MAPPINGS = {
    "H3AIOComposerPreValidator": H3AIOComposerPreValidator,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "H3AIOComposerPreValidator": "H3 AIO - Composer Pre-Validation",
}

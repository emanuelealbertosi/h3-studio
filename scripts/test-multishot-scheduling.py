import importlib.util
import json
from pathlib import Path


root = Path(__file__).resolve().parents[1]
nodes = root / "comfyui_nodes" / "ComfyUI-H3-Multishot"


def load(name):
    spec = importlib.util.spec_from_file_location(name, nodes / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builders = load("h3_prompt_builders")
refs = load("h3_multishot_refs")
timestamps = load("h3_internal_timestamps")

flattened, changed, note = timestamps.flatten_monoshot_markers(
    "[Shot 1] The woman turns. [Shot 2] At 00:02.500 She raises a hand.")
assert changed is True
assert "[Shot 2]" not in flattened
assert flattened.startswith("[Shot 1]")
assert "At 00:02.500 She raises a hand." in flattened
assert "flattened 1 extra" in note

state = {
    "version": 1,
    "kind": "r2v",
    "subject_definitions": "<Subject 1> is depicted in <Picture 2>.",
    "task_types": ["reference generation"],
    "summary": "scheduled references",
    "retention_analysis": "Retain <Picture 2>, <Video 1> and <Audio 2>.",
    "style": "cinematic",
    "shots": [{
        "description": "[Shot 1] <Subject 1> reacts to <Video 1> while <Audio 2> plays.",
        "soundscape": "Reference sound.",
        "music": "N/A",
        "active_ref_images": [2],
        "active_ref_videos": [],
        "active_ref_audios": [2],
    }],
}
script, count = builders.build_r2v_script(json.dumps(state))
assert count == 1
assert "__H3_ACTIVE_PICTURES__:2" in script
assert "__H3_ACTIVE_VIDEOS__:none" in script
assert "__H3_ACTIVE_AUDIOS__:2" in script

bank = refs.RefBank()
bank.items = [
    {"type": "image"}, {"type": "image"},
    {"type": "audio"}, {"type": "video"}, {"type": "audio"},
]
bank.blocks = [
    {"kind": "image", "latent_h": 2, "latent_w": 2},
    {"kind": "image", "latent_h": 2, "latent_w": 2},
    {"kind": "video_audio", "latent_t": 2, "latent_h": 2,
     "latent_w": 2, "ref_audio_t": 2},
    {"kind": "audio", "ref_audio_t": 2},
]
bank.labels = [
    ("<Picture 1>", "picture one"),
    ("<Picture 2>", "picture two"),
    ("<Audio 1>", "video soundtrack"),
    ("<Video 1>", "video one"),
    ("<Audio 2>", "standalone audio"),
]
bank.n_images = 2

filtered, clean, requested = refs.prepare_shot_bank(bank, script)
assert requested == {"Picture": [2], "Video": [], "Audio": [2]}
assert len(filtered.blocks) == 2
assert filtered.n_images == 1
assert [label for label, _source in filtered.labels] == [
    "<Picture 1>", "<Audio 1>"]
assert "__H3_ACTIVE_" not in clean
assert "<Picture 1>" in clean
assert "<Audio 1>" in clean
assert "<Video 1>" not in clean

print("H3 Studio 12-shot scheduling and physical reference filtering passed.")

editing_state = {
    "version": 1,
    "kind": "r2v",
    "subject_definitions": "<Subject 1> is the person visible in <Video 1>.",
    "task_types": ["video editing", "audio reuse"],
    "summary": "[reference generation] Change only the requested garment.",
    "retention_analysis": "<Subject 1>: fully_preserved - preserve identity.",
    "style": "Natural live-action footage.",
    "shots": [{
        "description": "[Shot 1] The garment changes while all other details remain stable.",
        "soundscape": "The original synchronized soundtrack continues.",
        "music": "N/A",
        "active_ref_images": [],
        "active_ref_videos": [1],
        "active_ref_audios": [1],
    }],
}
editing_script, editing_count = builders.build_r2v_script(
    json.dumps(editing_state))
assert editing_count == 1
assert "[video editing + audio reuse]" in editing_script
assert "[reference generation]" not in editing_script
assert "<Video 1> is the source video for the target video edit." in editing_script
assert "<Video 1> (source timeline and temporal structure): fully_preserved" in editing_script
assert "<Audio 1> is the synchronized audio track of <Video 1>" in editing_script
assert "<Audio 1>: fully_copy" in editing_script
assert "Using the exact corresponding temporal segment of <Video 1>" in editing_script
assert "Source-video preservation lock:" in editing_script

print("H3 official full-reference editing contract hardening passed.")

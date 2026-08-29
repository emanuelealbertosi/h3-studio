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

# -*- coding: utf-8 -*-
"""Reference conditioning shared by every shot of a multishot render.

`MiniMaxH3ReferenceToVideo` builds reference conditioning for ONE clip. It does
three things at once (comfy_extras/nodes_minimax_h3.py:210):

  1. VAE-encodes each reference into a `minimax_refs` payload block, whose rows
     are packed into the sequence and re-read at EVERY sampling step;
  2. presents the same references to the tokenizer as `<Picture i>` /
     `<Video k>` / `<Audio j>` labels followed by the Qwen3-VL vision tokens;
  3. hands both to the DiT on one conditioning.

The multishot sampler needs the SAME references on every shot, so this module
splits (1) from (2): `build_ref_bank()` runs once per render and does the
expensive encode; the sampler then reuses `bank.blocks` verbatim for each shot
and only re-runs the tokenizer, which it has to do anyway for the shot's prompt.

WHY THE ORDER IN `bank.items` IS LORE-BEARING
---------------------------------------------
Nothing binds a `<Picture i>` label to a payload block by name or index. The
tokenizer assigns ordinals POSITIONALLY, by counting image items as it walks
the list (comfy/text_encoders/minimax.py:153-175), and the packed layout
assigns each ref block its RoPE slot by walking `minimax_refs` in order
(comfy/ldm/minimax/model.py:324-367). The two lists agree only because they are
built in the same native order: images, video (soundtrack first), standalone
audio.

When real reference inputs are present, chain keyframes are intentionally NOT
added to this tokenizer list. They are merged payload-side by H3AVBank, exactly
like the already measured `H3KeyframeInject` path; this keeps every reference
marker stable on every shot. The sole exception is the pre-existing
`voice_ref`-only mode: it retains the historical `[keyframe, voice audio]`
presentation byte-for-byte so saved workflows do not change behaviour.
"""

import math
import re

MAX_REF_IMAGES = 9
MAX_REF_AUDIOS = 2
REF_AUDIO_MAX_SECONDS = 15      # ref rows cost time on EVERY step
REF_VIDEO_MAX_SECONDS = 15


def _encode_ref_audio(audio_vae, audio, max_seconds=REF_AUDIO_MAX_SECONDS):
    """AUDIO dict -> ([1, 32, 2, T] latent, T).

    Stricter than the native node's encoder in two ways the pack learned the
    hard way: mono is widened to stereo (a 1-channel waveform crashes the
    packed layout) and the tail past `max_seconds` is dropped, because every
    reference row is re-read at every sampling step.
    """
    import torch  # noqa: F401  (imported for callers that pass tensors)

    wav = audio["waveform"]
    if wav.ndim == 2:
        wav = wav.unsqueeze(0)
    wav = wav[:1]
    if wav.shape[1] == 1:
        wav = wav.repeat(1, 2, 1)
    elif wav.shape[1] > 2:
        wav = wav[:, :2]
    sr = int(audio["sample_rate"])
    vae_sr = getattr(audio_vae, "audio_sample_rate", 32000)
    if sr != vae_sr:
        import torchaudio
        wav = torchaudio.functional.resample(wav, sr, vae_sr)
        sr = vae_sr
    limit = int(max_seconds * sr)
    if wav.shape[-1] > limit:
        wav = wav[..., :limit]
    z = audio_vae.encode(wav.movedim(1, -1))          # [1, 32, 2, T]
    return z, z.shape[-1], wav.shape[-1] / float(sr)


def _ref_image_canvas(w, h, width, height, ref_image_size):
    """Reference canvas, mirroring nodes_minimax_h3.py:220-228."""
    from comfy_extras import nodes_minimax_h3 as mmh3
    if ref_image_size == "match":
        # aspect-preserving scale (down only) to the generation's pixel area
        scale = min(1.0, math.sqrt((width * height) / (w * h)))
    else:
        scale = min(1.0, mmh3.REF_IMAGE_SHORT_EDGE / min(w, h))
    m = mmh3.CANVAS_MULTIPLE
    return (max(m, round(w * scale / m) * m),
            max(m, round(h * scale / m) * m))


def _rows_per_frame(latent_h, latent_w):
    """Packed rows one latent frame contributes (2x2 patch grid)."""
    return ((latent_h + 1) // 2) * ((latent_w + 1) // 2)


class RefBank:
    """Encoded references, ready to ride every shot.

    `items` is the tokenizer presentation for the references ONLY - the shot's
    chain keyframe is spliced in by `compose_shot_items`. `blocks` is the
    `minimax_refs` payload in the matching order.
    """

    def __init__(self):
        self.items = []
        self.blocks = []
        self.n_images = 0        # how many <Picture> slots the refs consume
        self.labels = []         # (marker, source) for the log
        self.img_rows = 0        # packed rows the visual refs add
        self.audio_rows = 0      # packed rows the audio refs add
        self.legacy_voice_only = False

    def __bool__(self):
        return bool(self.blocks)

    @property
    def keyframe_picture_index(self):
        """The <Picture i> ordinal the chain keyframe will land on."""
        return self.n_images + 1

    def signature(self):
        """Compact tag for the auto-reserve cache key.

        Reference rows lengthen the packed sequence, so a shape that carries
        references needs a bigger activation pool than the same shape without
        them. The auto-reserve key is built from the target latent shape alone
        (h3_multishot_utils._auto_key), which cannot see that difference - a
        no-ref measurement would be replayed as an under-reserve on a ref run
        and thrash. Folding this into the key keeps the two calibrations apart.
        Empty when there are no refs, so existing cache entries still hit.
        """
        if not self.blocks:
            return ""
        return "r%d+%d" % (self.img_rows, self.audio_rows)

    def marker_map(self):
        lines = ["[H3Refs] marker binding for every shot:"]
        for marker, src in self.labels:
            lines.append("  %-12s %s" % (marker, src))
        return "\n".join(lines)


_ACTIVE_REFERENCE_RES = {
    "Picture": re.compile(
        r"(?m)^\s*__H3_ACTIVE_PICTURES__\s*:\s*([^\r\n]+)\s*$"),
    "Video": re.compile(
        r"(?m)^\s*__H3_ACTIVE_VIDEOS__\s*:\s*([^\r\n]+)\s*$"),
    "Audio": re.compile(
        r"(?m)^\s*__H3_ACTIVE_AUDIOS__\s*:\s*([^\r\n]+)\s*$"),
}
_REFERENCE_MARKER_RE = re.compile(
    r"<(Picture|Video|Audio)\s+(\d+)>", re.IGNORECASE)


def _recount_rows(bank):
    """Recompute reserve metadata after selecting a subset of image refs."""
    bank.img_rows = 0
    bank.audio_rows = 0
    for block in bank.blocks:
        kind = block.get("kind")
        if kind == "image":
            bank.img_rows += _rows_per_frame(
                block["latent_h"], block["latent_w"])
        elif kind in ("video", "video_audio"):
            bank.img_rows += (
                int(block.get("latent_t", 0))
                * _rows_per_frame(block["latent_h"], block["latent_w"]))
        bank.audio_rows += int(block.get("ref_audio_t", 0)) * 2


def prepare_shot_bank(bank, prompt):
    """Apply hidden per-shot Picture/Video/Audio schedules before Qwen.

    Legacy prompts contain no directive and return the original bank exactly.
    Reference-video soundtracks are one physical ``video_audio`` block, so the
    paired Video/Audio labels are selected together when either side is active.
    """
    text = str(prompt or "")
    requested = {}
    for category, pattern in _ACTIVE_REFERENCE_RES.items():
        match = pattern.search(text)
        if match is None:
            continue
        raw = match.group(1).strip().lower()
        text = pattern.sub("", text, count=1).lstrip()
        requested[category] = [] if raw in ("", "none", "off") else sorted({
            int(value) for value in re.findall(r"\d+", raw)
            if int(value) > 0
        })
    if not requested:
        return bank, text, None
    if not bank:
        return bank, text, requested

    groups = []
    item_offset = 0
    label_offset = 0
    for block in bank.blocks:
        item_count = 2 if block.get("kind") == "video_audio" else 1
        groups.append((
            list(bank.items[item_offset:item_offset + item_count]),
            block,
            list(bank.labels[label_offset:label_offset + item_count]),
        ))
        item_offset += item_count
        label_offset += item_count
    if item_offset != len(bank.items) or label_offset != len(bank.labels):
        print(
            "[H3Refs] reference schedule skipped: bank layout is not "
            "recognized (%d items, %d blocks, %d labels)."
            % (len(bank.items), len(bank.blocks), len(bank.labels)),
            flush=True)
        return bank, text, requested

    selected_groups = []
    for items, block, labels in groups:
        votes = []
        for marker, _source in labels:
            match = _REFERENCE_MARKER_RE.fullmatch(marker.strip())
            if match is None:
                votes.append(True)
                continue
            category = match.group(1).title()
            ordinal = int(match.group(2))
            votes.append(
                True if category not in requested
                else ordinal in requested[category])
        if any(votes):
            selected_groups.append((items, block, labels))

    shot_bank = RefBank()
    shot_bank.legacy_voice_only = bank.legacy_voice_only
    counters = {"Picture": 0, "Video": 0, "Audio": 0}
    mapping = {}
    for items, block, labels in selected_groups:
        shot_bank.items.extend(items)
        shot_bank.blocks.append(block)
        for marker, source in labels:
            match = _REFERENCE_MARKER_RE.fullmatch(marker.strip())
            if match is None:
                shot_bank.labels.append((marker, source))
                continue
            category = match.group(1).title()
            old_ordinal = int(match.group(2))
            counters[category] += 1
            new_ordinal = counters[category]
            mapping[(category, old_ordinal)] = new_ordinal
            shot_bank.labels.append((
                "<%s %d>" % (category, new_ordinal),
                "%s [source %s %d]" % (
                    source, category, old_ordinal)))
    shot_bank.n_images = counters["Picture"]
    _recount_rows(shot_bank)

    def replace_reference(match_obj):
        category = match_obj.group(1).title()
        old_ordinal = int(match_obj.group(2))
        new_ordinal = mapping.get((category, old_ordinal))
        if new_ordinal is not None:
            return "<%s %d>" % (category, new_ordinal)
        return "the omitted inactive %s reference" % category.lower()

    text = _REFERENCE_MARKER_RE.sub(replace_reference, text)
    print(
        "[H3Refs] per-shot reference filter: %s -> %d block(s), "
        "%d Picture / %d Video / %d Audio marker(s)."
        % (requested, len(shot_bank.blocks), counters["Picture"],
           counters["Video"], counters["Audio"]),
        flush=True)
    return shot_bank, text, requested

def build_ref_bank(video_vae, audio_vae, width, height, length,
                   ref_image_size="match",
                   ref_images=(), voice_ref=None, ref_audios=(),
                   ref_video=None, ref_video_audio=None):
    """Encode every reference ONCE for the whole render.

    Emission order matches the native reference node:
        ref images -> ref video (+ soundtrack) -> voice_ref -> extra ref audios
    """
    from comfy_extras import nodes_minimax_h3 as mmh3

    bank = RefBank()
    ref_images = tuple(ref_images or ())
    ref_audios = tuple(ref_audios or ())
    bank.legacy_voice_only = (
        voice_ref is not None
        and not any(img is not None for img in ref_images)
        and ref_video is None
        and not any(audio is not None for audio in ref_audios))

    for i, img in enumerate(ref_images):
        if img is None:
            continue
        h, w = img.shape[1], img.shape[2]
        tw, th = _ref_image_canvas(w, h, width, height, ref_image_size)
        resized = mmh3._resize(img[:1], tw, th, "disabled")
        z = video_vae.encode(resized)
        lh, lw = th // 16, tw // 16
        bank.items.append({"type": "image", "data": resized})
        bank.blocks.append({"kind": "image", "latent_h": lh, "latent_w": lw,
                            "latent": z})
        bank.n_images += 1
        bank.img_rows += _rows_per_frame(lh, lw)
        bank.labels.append(("<Picture %d>" % bank.n_images,
                            "ref_image_%d (%dx%d)" % (i, tw, th)))

    n_audio = 0
    if ref_video is not None:
        vh, vw = ref_video.shape[1], ref_video.shape[2]
        cw, ch = mmh3.adapt_canvas(vw, vh)
        if vw * vh < cw * ch:
            m = mmh3.CANVAS_MULTIPLE
            cw = max(m, round(vw / m) * m)
            ch = max(m, round(vh / m) * m)
        frames = mmh3._resize(ref_video, cw, ch, "disabled")
        # Match the native reference node: a ref video never outlives the
        # generated shot. The 15-second ceiling is a second safety bound for
        # nonstandard long-shot workflows.
        cap = min(mmh3.align_frame_count(max(5, length)),
                  mmh3.align_frame_count(
                      REF_VIDEO_MAX_SECONDS * mmh3.FPS))
        if frames.shape[0] > cap:
            frames = frames[:cap]
        n = frames.shape[0]
        if n < 5:
            raise ValueError(
                "H3 reference videos need at least 5 frames (~0.2s at 24 fps); "
                "got %d" % n)
        while n % 17 != 5:
            n -= 1
        frames = frames[:n]
        z = video_vae.encode(frames)

        audio_latent, ref_audio_t = None, 0
        if ref_video_audio is not None:
            audio_latent, ref_audio_t, secs = _encode_ref_audio(
                audio_vae, ref_video_audio)
            # the soundtrack gets its own <Audio j> label, emitted before <Video k>
            n_audio += 1
            bank.items.append({"type": "audio"})
            bank.audio_rows += ref_audio_t * 2
            bank.labels.append(("<Audio %d>" % n_audio,
                                "ref_video_audio (%.1fs)" % secs))

        # Qwen sees the reference video at 2 fps with timestamps
        sample_idx = list(range(0, frames.shape[0], mmh3.FPS // 2))
        bank.items.append({"type": "video", "data": frames[sample_idx],
                           "timestamps": [i / 2.0 for i in range(len(sample_idx))]})
        lh, lw = ch // 16, cw // 16
        bank.blocks.append({"kind": "video_audio" if ref_audio_t else "video",
                            "latent_t": z.shape[2], "latent_h": lh,
                            "latent_w": lw, "ref_audio_t": ref_audio_t,
                            "latent": z, "audio_latent": audio_latent})
        bank.img_rows += z.shape[2] * _rows_per_frame(lh, lw)
        bank.labels.append(("<Video 1>", "ref_video (%df @ %dx%d)"
                            % (n, cw, ch)))

    audio_sources = []
    if voice_ref is not None:
        audio_sources.append((voice_ref, "voice_ref"))
    for i, audio in enumerate(ref_audios):
        if audio is not None:
            audio_sources.append((audio, "ref_audio_%d" % i))
    for audio, src in audio_sources:
        z, rt, secs = _encode_ref_audio(audio_vae, audio)
        n_audio += 1
        bank.items.append({"type": "audio"})
        bank.blocks.append({"kind": "audio", "ref_audio_t": rt,
                            "audio_latent": z})
        bank.audio_rows += rt * 2
        bank.labels.append(("<Audio %d>" % n_audio, "%s (%.1fs)" % (src, secs)))

    return bank


def compose_shot_items(bank, keyframe_images):
    """Tokenizer presentation for one shot.

    Real reference runs mirror native ref2va: only references are presented to
    Qwen, while H3AVBank adds the shot's chain keyframe payload-side. The old
    voice-only feature predates image references and presented its chain frame
    to Qwen, so that one case deliberately retains the old item order.
    """
    if bank.legacy_voice_only:
        keyframes = [{"type": "image", "data": im}
                     for im in keyframe_images]
        return keyframes + list(bank.items)
    return list(bank.items)


def estimated_extra_rows(bank):
    """Packed rows the references add to every step, for the VRAM log."""
    return bank.img_rows + bank.audio_rows


class H3MultishotModeRouter:
    """Route prompt and optional media from two mode checkboxes.

    The two booleans intentionally form four useful modes:
      start OFF + refs OFF -> T2V
      start ON  + refs OFF -> I2V
      start OFF + refs ON  -> R2V
      start ON  + refs ON  -> I2V + R2V

    Prompt editors stay outside this node in the workflow, so the ordinary
    three-section and full-reference six-section formats remain visually
    separate and easy to edit.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "use_start_image": ("BOOLEAN", {
                    "default": False,
                    "label_on": "I2V start ON",
                    "label_off": "T2V start OFF",
                    "tooltip": "Pass start_image and select the I2V prompt."}),
                "use_references": ("BOOLEAN", {
                    "default": True,
                    "label_on": "references ON",
                    "label_off": "references OFF",
                    "tooltip": "Pass every reference and select the R2V prompt."}),
                "ref_image_count": ("INT", {
                    "default": 1, "min": 0, "max": MAX_REF_IMAGES, "step": 1,
                    "tooltip": "How many ref_image slots to evaluate and pass."}),
                "use_ref_video": ("BOOLEAN", {
                    "default": False,
                    "label_on": "reference video ON",
                    "label_off": "reference video OFF"}),
                "use_voice_ref": ("BOOLEAN", {
                    "default": False,
                    "label_on": "voice_ref ON",
                    "label_off": "voice_ref OFF"}),
                "use_video_audio": ("BOOLEAN", {
                    "default": False,
                    "label_on": "video soundtrack ON",
                    "label_off": "video soundtrack OFF",
                    "tooltip": "Used only when reference video is also ON."}),
                "ref_audio_count": ("INT", {
                    "default": 0, "min": 0, "max": 2, "step": 1,
                    "tooltip": "How many additional ref_audio slots to pass."}),
                "t2v_script": ("STRING", {
                    "forceInput": True, "lazy": True}),
                "i2v_script": ("STRING", {
                    "forceInput": True, "lazy": True}),
                "reference_script": ("STRING", {
                    "forceInput": True, "lazy": True}),
            },
            "optional": {
                "start_image": ("IMAGE", {"lazy": True}),
                "voice_ref": ("AUDIO", {"lazy": True}),
                "ref_image_0": ("IMAGE", {"lazy": True}),
                "ref_image_1": ("IMAGE", {"lazy": True}),
                "ref_image_2": ("IMAGE", {"lazy": True}),
                "ref_image_3": ("IMAGE", {"lazy": True}),
                "ref_video_0": ("IMAGE", {"lazy": True}),
                "ref_video_audio_0": ("AUDIO", {"lazy": True}),
                "ref_audio_0": ("AUDIO", {"lazy": True}),
                "ref_audio_1": ("AUDIO", {"lazy": True}),
                "ref_image_4": ("IMAGE", {"lazy": True}),
                "ref_image_5": ("IMAGE", {"lazy": True}),
                "ref_image_6": ("IMAGE", {"lazy": True}),
                "ref_image_7": ("IMAGE", {"lazy": True}),
                "ref_image_8": ("IMAGE", {"lazy": True}),
            },
        }

    RETURN_TYPES = (
        "STRING", "IMAGE", "AUDIO",
        "IMAGE", "IMAGE", "IMAGE", "IMAGE",
        "IMAGE", "AUDIO", "AUDIO", "AUDIO",
        "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = (
        "script", "start_image", "voice_ref",
        "ref_image_0", "ref_image_1", "ref_image_2", "ref_image_3",
        "ref_video_0", "ref_video_audio_0", "ref_audio_0", "ref_audio_1",
        "ref_image_4", "ref_image_5", "ref_image_6", "ref_image_7",
        "ref_image_8")
    FUNCTION = "route"
    CATEGORY = "utils/minimax"
    DESCRIPTION = (
        "Two-checkbox T2V / I2V / R2V / I2V+R2V selector. It also chooses the "
        "matching prompt editor and lazily skips loaders not used by that mode.")

    @classmethod
    def check_lazy_status(cls, use_start_image, use_references,
                          ref_image_count, use_ref_video, use_voice_ref,
                          use_video_audio, ref_audio_count,
                          **kwargs):
        needed = []
        prompt_name = (
            "reference_script" if use_references
            else ("i2v_script" if use_start_image else "t2v_script"))
        if kwargs.get(prompt_name) is None:
            needed.append(prompt_name)

        if (use_start_image and "start_image" in kwargs
                and kwargs["start_image"] is None):
            needed.append("start_image")

        if use_references:
            names = [
                f"ref_image_{i}" for i in range(ref_image_count)]
            if use_ref_video:
                names.append("ref_video_0")
            if use_voice_ref:
                names.append("voice_ref")
            if use_ref_video and use_video_audio:
                names.append("ref_video_audio_0")
            names.extend(
                f"ref_audio_{i}" for i in range(ref_audio_count))
            for name in names:
                if name in kwargs and kwargs[name] is None:
                    needed.append(name)
        return needed

    def route(self, use_start_image, use_references,
              ref_image_count, use_ref_video, use_voice_ref,
              use_video_audio, ref_audio_count,
              t2v_script, i2v_script, reference_script,
              start_image=None, voice_ref=None,
              ref_image_0=None, ref_image_1=None,
              ref_image_2=None, ref_image_3=None,
              ref_video_0=None, ref_video_audio_0=None,
              ref_audio_0=None, ref_audio_1=None,
              ref_image_4=None, ref_image_5=None, ref_image_6=None,
              ref_image_7=None, ref_image_8=None):
        if use_references:
            script = reference_script
            mode = "I2V + R2V" if use_start_image else "R2V"
            refs = (
                voice_ref if use_voice_ref else None,
                ref_image_0 if ref_image_count >= 1 else None,
                ref_image_1 if ref_image_count >= 2 else None,
                ref_image_2 if ref_image_count >= 3 else None,
                ref_image_3 if ref_image_count >= 4 else None,
                ref_video_0 if use_ref_video else None,
                ref_video_audio_0
                    if use_ref_video and use_video_audio else None,
                ref_audio_0 if ref_audio_count >= 1 else None,
                ref_audio_1 if ref_audio_count >= 2 else None,
                ref_image_4 if ref_image_count >= 5 else None,
                ref_image_5 if ref_image_count >= 6 else None,
                ref_image_6 if ref_image_count >= 7 else None,
                ref_image_7 if ref_image_count >= 8 else None,
                ref_image_8 if ref_image_count >= 9 else None)
            if (ref_image_count == 0 and not use_ref_video
                    and not use_voice_ref and ref_audio_count == 0):
                print("[H3ModeRouter] WARNING: reference mode selected but "
                      "all reference types are disabled.", flush=True)
        else:
            script = i2v_script if use_start_image else t2v_script
            mode = "I2V" if use_start_image else "T2V"
            refs = (None,) * 14

        start = start_image if use_start_image else None
        print(f"[H3ModeRouter] mode={mode}; selected "
              f"{'reference' if use_references else ('I2V' if use_start_image else 'T2V')} "
              f"script.", flush=True)
        return (script, start) + refs

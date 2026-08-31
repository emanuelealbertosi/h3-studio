# -*- coding: utf-8 -*-
"""Combined MiniMax H3 reference bank and long-form frame memory.

This module adds a new sampler instead of changing the existing Reference or
Memory samplers. Explicit reference images keep stable <Picture i> ordinals;
internal memory frames are appended only to the text encoder visual context.
"""

from . import h3_multishot_refs as h3_refs
from .h3_interior_patch import ensure_interior_keyframes
from .h3_keyframes import _parse_positions
from .h3_multishot_utils import (
    H3MultishotSampler,
    _MasterFrameStore,
    _auto_ctx,
    _auto_measure_begin,
    _auto_measure_end,
    _parse_script,
    _xfade_audio,
)


class H3StudioInpaintStatus:
    """Expose SAM3 checkpoint readiness through ComfyUI object_info."""

    @classmethod
    def INPUT_TYPES(cls):
        import os
        import folder_paths
        model_dir = os.path.join(folder_paths.base_path, "models", "sam3")
        state = "ready" if any(os.path.isfile(os.path.join(model_dir, name))
                               for name in ("sam3.safetensors", "sam3.pt")) \
            else "missing"
        return {"required": {"state": ([state], {"default": state})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("state",)
    FUNCTION = "report"
    CATEGORY = "MiniMax H3/Studio"

    def report(self, state):
        return (str(state),)


def _build_global_keyframe_plan(plan, shot_count, frames_per_shot):
    """Map global master-timeline anchors to local per-shot positions."""
    if not plan:
        return {}, ""
    images = [image for image in plan.get("images", []) if image is not None]
    if not images:
        return {}, ""
    total_frames = int(shot_count) * (int(frames_per_shot) - 1) + 1
    positions = str(plan.get("positions") or "AUTO").strip()
    if not positions or positions.upper().startswith("AUTO"):
        if len(images) == 1:
            indexes = [0]
        else:
            indexes = [
                int(round(i * (total_frames - 1) / (len(images) - 1)))
                for i in range(len(images))]
        positions = ", ".join(
            "%.4g%%" % (100.0 * index / max(total_frames - 1, 1))
            for index in indexes)
    else:
        indexes = _parse_positions(positions, total_frames)
    if len(indexes) != len(images):
        raise ValueError(
            "H3 AIO keyframes: %d Picture(s) loaded but %d position(s) "
            "resolved from '%s'. Use AUTO or provide exactly one position "
            "per Picture." % (len(images), len(indexes), positions))
    if len(set(indexes)) != len(indexes):
        raise ValueError(
            "H3 AIO keyframes: two positions resolve to the same master "
            "frame. Move them farther apart or use AUTO.")

    assignments = {}
    stride = int(frames_per_shot) - 1
    notes = []
    for picture_number, (image, global_index) in enumerate(
            sorted(zip(images, indexes), key=lambda item: item[1]), 1):
        shot_index = min(int(global_index) // stride, int(shot_count) - 1)
        local_index = int(global_index) - shot_index * stride
        assignments.setdefault(shot_index, []).append(
            (local_index, image, int(global_index)))
        notes.append(
            "Picture %d -> master frame %d (clip %d frame %d)" %
            (picture_number, global_index, shot_index + 1, local_index))

    interior = [
        local for values in assignments.values()
        for local, _image, _global in values
        if local not in (0, int(frames_per_shot) - 1)]
    if interior:
        patched, message = ensure_interior_keyframes()
        if not patched:
            raise ValueError(
                "H3 AIO keyframes need the interior positional patch: %s" %
                message)
    return assignments, positions + " | " + "; ".join(notes)


def _slice_audio_for_frames(audio, start_frame, end_frame, fps=24):
    """Slice an AUDIO dict on the same frame timeline as a source video."""
    if audio is None:
        return None
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 0) or 0)
    if waveform is None or sample_rate <= 0:
        return audio
    start_sample = max(
        0, int(round(float(start_frame) * sample_rate / fps)))
    end_sample = min(
        int(waveform.shape[-1]),
        int(round(float(end_frame) * sample_rate / fps)))
    if end_sample <= start_sample:
        return None
    return {
        "waveform": waveform[..., start_sample:end_sample],
        "sample_rate": sample_rate,
    }

class H3ReferenceMemorySampler(H3MultishotSampler):
    """References plus persistent opening and recent shot-end frame memory."""

    @classmethod
    def INPUT_TYPES(cls):
        base = H3MultishotSampler.INPUT_TYPES()
        required = dict(base["required"])
        required["memory_frames"] = ("INT", {
            "default": 2, "min": 0, "max": 6, "step": 1,
            "tooltip": "Recent shot-end frames shown to the text encoder. "
                       "0 keeps only normal latest-frame chaining; 2 is "
                       "recommended for long-form continuity."})
        required["anchor_frames"] = ("INT", {
            "default": 1, "min": 0, "max": 2, "step": 1,
            "tooltip": "Persistent opening anchor shown to every later shot. "
                       "0 disables it; 1 is recommended. An external I2V "
                       "start image becomes the anchor when supplied."})
        optional = dict(base.get("optional", {}))
        optional["keyframe_plan"] = ("H3_KEYFRAME_PLAN",)
        optional["studio_upscale"] = ("BOOLEAN", {
            "default": False,
            "tooltip": "H3 Studio final render: sample low, upscale the H3 "
                       "video latent, then run a short high-resolution refine."})
        optional["studio_upscale_model"] = ("STRING", {
            "default": "minimax_h3_latent_upscaler_3d_fp16.safetensors"})
        optional["studio_upscale_source_ratio"] = ("FLOAT", {
            "default": 0.60, "min": 0.40, "max": 0.90, "step": 0.05,
            "tooltip": "Linear size of the low-resolution first pass. "
                       "0.60 means 36% of the final pixels."})
        optional["studio_upscale_refine_steps"] = ("INT", {
            "default": 3, "min": 0, "max": 4, "step": 1,
            "tooltip": "High-resolution refinement steps after latent upscale. "
                       "3 is the recommended balanced final-render value."})
        optional["studio_upscale_precision"] = (["fp16", "bf16", "fp32"], {
            "default": "fp16"})
        optional["pdd_acc_file"] = ("STRING", {
            "default": "",
            "tooltip": "H3 Studio FAST only. Official Alibaba PDD-Acc file "
                       "from models/pdd_acc. When set, the sampler is locked "
                       "to 8 NFE, Euler, trained PDD sigmas, strengths 1/1 and "
                       "strict on-grid validation."})
        optional["external_motion_context_length"] = ([
            "22", "5", "39", "56", "OFF"], {
                "default": "22",
                "tooltip": "VIDEO EXTENSION only. Pin this many consecutive "
                           "tail frames from the external source so clip 1 "
                           "continues real motion instead of a single still. "
                           "22 is the near-seamless default."})
        optional["studio_context_prefix"] = ("STRING", {
            "default": "",
            "tooltip": "H3 Studio internal cache path for this candidate's "
                       "native video/audio latent."})
        optional["studio_context_clip_index"] = ("INT", {
            "default": 0, "min": 0, "max": 9999, "step": 1})
        optional["studio_source_context_prefix"] = ("STRING", {
            "default": "",
            "tooltip": "H3 Studio internal cache path of the candidate "
                       "being continued."})
        optional["studio_source_context_clip_index"] = ("INT", {
            "default": 0, "min": 0, "max": 9999, "step": 1})
        optional["studio_inpaint_mask"] = ("MASK", {
            "tooltip": "Tracked pixel-space mask for conservative H3 video "
                       "inpainting. H3 Studio supplies this from SAM3."})
        optional["studio_inpaint_grow"] = ("INT", {
            "default": 8, "min": 0, "max": 96, "step": 4,
            "tooltip": "Grow the tracked mask in source pixels before H3 "
                       "latent reduction. 8 is a conservative default."})
        optional["studio_inpaint_start_seconds"] = ("FLOAT", {
            "default": 0.0, "min": 0.0, "max": 180.0, "step": 0.1,
            "tooltip": "Optional first second to repaint. 0 starts at the "
                       "beginning."})
        optional["studio_inpaint_end_seconds"] = ("FLOAT", {
            "default": 0.0, "min": 0.0, "max": 180.0, "step": 0.1,
            "tooltip": "Optional final second to repaint. 0 uses the end "
                       "of the source clip."})
        optional["studio_inpaint_crop_mode"] = ([
            "tracked", "combined", "zoomed"], {
                "default": "tracked",
                "tooltip": "MaskVid crop planner. Tracked is the stable "
                           "default; combined keeps one static crop."})
        optional["studio_inpaint_crop_scale"] = ("FLOAT", {
            "default": 1.5, "min": 1.0, "max": 4.0, "step": 0.05,
            "tooltip": "Padding around the tracked subject before H3."})
        optional["studio_inpaint_feather"] = ("INT", {
            "default": 24, "min": 0, "max": 128, "step": 4,
            "tooltip": "Inward blend width when the edited crop is pasted "
                       "back onto the original frames."})
        return {
            "required": required,
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("master_frames", "master_audio", "shots_rendered")
    FUNCTION = "run"
    CATEGORY = "sampling/minimax"
    DESCRIPTION = (
        "AIO T2V/I2V/R2V multishot sampler with explicit references, "
        "persistent opening anchor and recent shot-end frame memory.")

    @staticmethod
    def _reference_memory_items(bank, memory_images):
        """Append encoder-only memory without renumbering explicit refs."""
        memory_items = [
            {"type": "image", "data": image}
            for image in memory_images
        ]
        if bank.legacy_voice_only:
            return memory_items + list(bank.items)
        # Real ref images stay first: ref_image_0 is always <Picture 1>.
        return list(bank.items) + memory_items

    def run(self, model, clip, video_vae, audio_vae, script, shot_count,
            width, height, frames_per_shot, seed, steps,
            seed_per_shot=False, memory_frames=2, anchor_frames=1,
            start_image=None, voice_ref=None,
            sampler_name="res_multistep", scheduler="simple",
            ref_image_0=None, ref_image_1=None, ref_image_2=None,
            ref_image_3=None, ref_audio_0=None, ref_audio_1=None,
            ref_video_0=None, ref_video_audio_0=None,
            ref_image_size="match", stream_to_disk=False,
            ref_image_4=None, ref_image_5=None, ref_image_6=None,
            ref_image_7=None, ref_image_8=None, keyframe_plan=None,
            studio_upscale=False,
            studio_upscale_model="minimax_h3_latent_upscaler_3d_fp16.safetensors",
            studio_upscale_source_ratio=0.60,
            studio_upscale_refine_steps=3,
            studio_upscale_precision="fp16",
            pdd_acc_file="", external_motion_context_length="22",
            studio_context_prefix="", studio_context_clip_index=0,
            studio_source_context_prefix="",
            studio_source_context_clip_index=0,
            studio_inpaint_mask=None, studio_inpaint_grow=8,
            studio_inpaint_start_seconds=0.0,
            studio_inpaint_end_seconds=0.0,
            studio_inpaint_crop_mode="tracked",
            studio_inpaint_crop_scale=1.5,
            studio_inpaint_feather=24):
        import torch
        import node_helpers
        from comfy_extras import nodes_custom_sampler as ncs
        from comfy_extras import nodes_minimax_h3 as mmh3
        from comfy_extras.nodes_audio import vae_decode_audio
        import comfy.model_management as model_management
        import comfy.nested_tensor
        import nodes as comfy_nodes

        target_width = int(width)
        target_height = int(height)
        studio_upscale = bool(studio_upscale)
        if studio_upscale:
            ratio = min(0.90, max(0.40, float(studio_upscale_source_ratio)))
            width = max(256, int(round(target_width * ratio / 32.0)) * 32)
            height = max(256, int(round(target_height * ratio / 32.0)) * 32)
            print(
                "[H3ReferenceMemory] Studio latent final render: first pass "
                "%dx%d -> target %dx%d, refine=%d step(s)." % (
                    width, height, target_width, target_height,
                    int(studio_upscale_refine_steps)),
                flush=True)

        operation_mode = str(
            (keyframe_plan or {}).get("mode") or "").upper()
        inpaint_enabled = (
            operation_mode == "VIDEO EDITING"
            and studio_inpaint_mask is not None)
        original_ref_video = ref_video_0
        inpaint_bboxes = None
        if inpaint_enabled:
            if bool(studio_upscale):
                raise ValueError(
                    "Masking H3 non supporta il latent upscale: scegli una "
                    "risoluzione H3 nativa fino a 0.98 MP.")
            crop_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(
                "MVEx_SubjectCrop")
            if crop_cls is None:
                raise RuntimeError(
                    "MVEx_SubjectCrop non disponibile. Installa "
                    "MaskVidExperiments e riavvia ComfyUI.")
            crop_mode = str(studio_inpaint_crop_mode or "tracked").lower()
            crop_scale = min(
                4.0, max(1.0, float(studio_inpaint_crop_scale)))
            aspect_ratio = float(width) / max(1.0, float(height))
            mode = {
                "mode": crop_mode,
                "crop_scale": crop_scale,
                "aspect_ratio": aspect_ratio,
            }
            if crop_mode != "combined":
                mode.update({
                    "padding": "firm",
                    "prefer": "stillness",
                    "seamless_loop": False,
                })
            cropped = crop_cls.execute(
                original_images=original_ref_video,
                masks=studio_inpaint_mask,
                mode=mode,
                divisible_by=32,
                upscale_megapixels=0.0,
            )
            ref_video_0 = cropped[0]
            studio_inpaint_mask = cropped[1]
            inpaint_bboxes = cropped[2]
            print(
                "[H3ReferenceMemory] MaskVid %s crop: %dx%d source -> "
                "%dx%d work crop, scale=%.2f." % (
                    crop_mode,
                    int(original_ref_video.shape[2]),
                    int(original_ref_video.shape[1]),
                    int(ref_video_0.shape[2]), int(ref_video_0.shape[1]),
                    crop_scale),
                flush=True)
        ref_images = (
            ref_image_0, ref_image_1, ref_image_2, ref_image_3,
            ref_image_4, ref_image_5, ref_image_6, ref_image_7,
            ref_image_8)

        def operation_video_segment(shot_index):
            if ref_video_0 is None:
                return None, None
            total = int(ref_video_0.shape[0])
            if operation_mode == "VIDEO EDITING":
                requested = int(frames_per_shot)
                # H3 emits 362 frames for its nominal 15s preset, while a
                # reference video is capped at 360 frames (15.0s at 24fps).
                # Use contiguous source chunks only for that boundary case.
                if requested > 360:
                    source_stride = 360
                    segment_frames = 360
                else:
                    source_stride = requested - 1
                    segment_frames = requested
                start = int(shot_index) * source_stride
                if start >= total:
                    raise ValueError(
                        "VIDEO EDITING clip %d starts beyond Video 1 (%d "
                        "source frames). Reduce shot_count." %
                        (shot_index + 1, total))
                end = min(total, start + segment_frames)
            elif operation_mode == "VIDEO EXTENSION":
                end = total
                start = max(0, end - min(int(frames_per_shot), 360))
            else:
                return ref_video_0, ref_video_audio_0

            segment = ref_video_0[start:end]
            if int(segment.shape[0]) < 5:
                pad = segment[-1:].repeat(
                    5 - int(segment.shape[0]), 1, 1, 1)
                segment = torch.cat((segment, pad), dim=0)
            segment_audio = _slice_audio_for_frames(
                ref_video_audio_0, start, end)
            print(
                "[H3ReferenceMemory] %s source slice for clip %d: "
                "frames %d..%d of %d."
                % (operation_mode, shot_index + 1, start,
                   max(start, end - 1), total),
                flush=True)
            return segment, segment_audio

        def operation_mask_segment(shot_index):
            """Slice the SAM3 mask on the exact same source timeline."""
            if not inpaint_enabled:
                return None
            mask = studio_inpaint_mask
            total = int(mask.shape[0])
            requested = int(frames_per_shot)
            if requested > 360:
                source_stride = 360
                segment_frames = 360
            else:
                source_stride = requested - 1
                segment_frames = requested
            start = int(shot_index) * source_stride
            end = min(total, start + segment_frames)
            if start >= total:
                raise ValueError(
                    "H3 Studio inpaint mask ends before clip %d." %
                    (shot_index + 1))
            segment = mask[start:end].clone()
            if int(segment.shape[0]) < 5:
                segment = torch.cat((
                    segment,
                    segment[-1:].repeat(
                        5 - int(segment.shape[0]), 1, 1)), dim=0)

            active_start = max(
                0, int(round(float(studio_inpaint_start_seconds) * 24.0)))
            requested_end = float(studio_inpaint_end_seconds)
            active_end = (
                max(active_start, int(round(requested_end * 24.0)))
                if requested_end > 0 else total)
            local_start = max(0, active_start - start)
            local_end = min(int(segment.shape[0]), active_end - start)
            if local_start > 0:
                segment[:local_start] = 0
            if local_end < int(segment.shape[0]):
                segment[max(0, local_end):] = 0
            if local_end <= 0 or local_start >= int(segment.shape[0]):
                segment.zero_()
            return segment

        def operation_original_segment(shot_index, requested_count=None):
            """Original full frames matching a VIDEO EDITING source slice."""
            if original_ref_video is None:
                return None
            total = int(original_ref_video.shape[0])
            requested = int(frames_per_shot)
            if requested > 360:
                source_stride, segment_frames = 360, 360
            else:
                source_stride, segment_frames = requested - 1, requested
            start = int(shot_index) * source_stride
            end = min(total, start + segment_frames)
            segment = original_ref_video[start:end]
            wanted = int(requested_count or segment.shape[0])
            if int(segment.shape[0]) < wanted:
                segment = torch.cat((segment, segment[-1:].repeat(
                    wanted - int(segment.shape[0]), 1, 1, 1)), dim=0)
            return segment[:wanted]

        def operation_bbox_segment(shot_index, requested_count):
            if inpaint_bboxes is None:
                return None
            requested = int(frames_per_shot)
            source_stride = 360 if requested > 360 else requested - 1
            segment_frames = 360 if requested > 360 else requested
            start = int(shot_index) * source_stride
            end = min(len(inpaint_bboxes), start + segment_frames)
            values = list(inpaint_bboxes[start:end])
            if not values:
                raise ValueError(
                    "MaskVid crop plan ends before clip %d." %
                    (shot_index + 1))
            while len(values) < int(requested_count):
                values.append(values[-1])
            return values[:int(requested_count)]

        initial_video, initial_video_audio = operation_video_segment(0)
        # VIDEO EXTENSION is a continuation boundary, not a reference-video
        # generation task. Feeding the complete source clip back through
        # minimax_refs makes H3 free to replay/reinterpret it and is the main
        # behavioural difference from an internal multishot boundary. Match
        # shot 2+ semantics instead: the exact final frame is supplied below
        # both as frame-0 keyframe and encoder memory, while ordinary Picture
        # references remain in the bank. Source audio may still be used as an
        # audio-only reference so soundtrack continuity is not lost.
        external_motion_enabled = (
            operation_mode == "VIDEO EXTENSION"
            and str(external_motion_context_length).upper() != "OFF")
        extension_audio = (
            initial_video_audio
            if operation_mode == "VIDEO EXTENSION"
            and not external_motion_enabled else None)
        bank_video = (
            None if operation_mode == "VIDEO EXTENSION" or inpaint_enabled
            else initial_video)
        bank_video_audio = (
            None if operation_mode == "VIDEO EXTENSION" or inpaint_enabled
            else initial_video_audio)
        bank = h3_refs.build_ref_bank(
            video_vae, audio_vae, width, height, frames_per_shot,
            ref_image_size,
            ref_images=ref_images,
            voice_ref=voice_ref,
            ref_audios=(ref_audio_0, ref_audio_1, extension_audio),
            ref_video=bank_video,
            ref_video_audio=bank_video_audio)
        if operation_mode == "VIDEO EXTENSION":
            print(
                "[H3ReferenceMemory] VIDEO EXTENSION uses boundary memory "
                "instead of source-video reference conditioning.",
                flush=True)
        _auto_ctx["refsig"] = ""
        if bank:
            print(bank.marker_map(), flush=True)
            print(
                "[H3ReferenceMemory] %d explicit reference block(s) add ~%d "
                "packed rows to every step." % (
                    len(bank.blocks), h3_refs.estimated_extra_rows(bank)),
                flush=True)
            if bank.n_images:
                print(
                    "[H3ReferenceMemory] explicit images retain "
                    "<Picture 1..%d>; internal memory follows them and needs "
                    "no prompt marker." % bank.n_images,
                    flush=True)

        shots = _parse_script(script)
        n = shot_count if shot_count > 0 else len(shots)
        if len(shots) > n:
            print(
                "[H3ReferenceMemory] dropping %d extra prompt(s) "
                "(shot_count=%d)." % (len(shots) - n, n),
                flush=True)
            shots = shots[:n]
        while len(shots) < n:
            print(
                "[H3ReferenceMemory] shot %d continues the last prompt."
                % (len(shots) + 1),
                flush=True)
            shots.append(shots[-1])

        guide_by_shot, guide_summary = _build_global_keyframe_plan(
            keyframe_plan, n, frames_per_shot)
        if guide_by_shot:
            print(
                "[H3ReferenceMemory] global keyframe guidance: %s" %
                guide_summary,
                flush=True)

        pdd_acc_file = str(pdd_acc_file or "").strip()
        if pdd_acc_file:
            pdd_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(
                "MiniMaxH3PDDAccApply")
            if pdd_cls is None:
                raise RuntimeError(
                    "MiniMaxH3PDDAccApply is not registered. Restart ComfyUI "
                    "after installing ComfyUI-MiniMax-H3-PDD-Acc.")
            model, sigmas, pdd_info = pdd_cls().apply(
                model=model,
                pdd_file=pdd_acc_file,
                nfe="8",
                lora_strength=1.0,
                head_strength=1.0,
                on_off_grid="error",
            )
            steps = 8
            sampler_name = "euler"
            print(
                "[H3ReferenceMemory] FAST Alibaba PDD-Acc: %s\n%s" %
                (pdd_acc_file, pdd_info),
                flush=True)
            if studio_upscale and int(studio_upscale_refine_steps) > 0:
                print(
                    "[H3ReferenceMemory] FAST PDD uses trained boundary "
                    "sigmas; disabling the off-grid high-resolution refine "
                    "after latent upscale.",
                    flush=True)
                studio_upscale_refine_steps = 0
        else:
            sigmas = ncs.BasicScheduler().get_sigmas(
                model, scheduler, steps, 1.0)[0]
        sampler = ncs.KSamplerSelect().get_sampler(sampler_name)[0]
        store_width = (
            int(original_ref_video.shape[2]) if inpaint_enabled
            else target_width if studio_upscale else width)
        store_height = (
            int(original_ref_video.shape[1]) if inpaint_enabled
            else target_height if studio_upscale else height)
        frame_store = _MasterFrameStore(
            torch, stream_to_disk, n * frames_per_shot,
            store_width, store_height)
        audio_parts = []
        sample_rate = None
        history = []
        # Optional controller supplied by H3ReferenceMotionMemorySampler.
        # Keeping the hook here lets the original node retain its exact public
        # interface and behaviour while the motion-aware subclass can reuse
        # the same AIO loop and its in-memory previous-shot latent.
        motion_controller = getattr(
            self, "_motion_context_controller", None)
        if external_motion_enabled and motion_controller is None:
            # Unlike an in-run multishot boundary, a separate Continue job no
            # longer owns the source sampler latent. Motion Context therefore
            # pins a consecutive decoded source tail instead of guessing its
            # direction from one last-frame still.
            from .h3_motion_memory import _InRunMotionContext
            motion_controller = _InRunMotionContext(
                str(external_motion_context_length),
                int(external_motion_context_length), 17)
            motion_controller.set_external(
                ref_video_0, ref_video_audio_0, audio_vae)
            source_prefix = str(studio_source_context_prefix or "").strip()
            source_index = int(studio_source_context_clip_index or 0)
            if source_prefix and source_index > 0:
                load_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(
                    "MiniMaxH3MotionContextLoadLatent")
                if load_cls is None:
                    print(
                        "[H3ReferenceMemory] native Studio context loader is "
                        "not registered; using decoded source fallback.",
                        flush=True)
                else:
                    try:
                        source_latent = load_cls().load(
                            source_prefix, source_index)[0]
                        motion_controller.set_external_latent(source_latent)
                        print(
                            "[H3ReferenceMemory] loaded native Studio AV "
                            "context %s slot %d."
                            % (source_prefix, source_index),
                            flush=True)
                    except Exception as exc:
                        print(
                            "[H3ReferenceMemory] native Studio AV context "
                            "unavailable (%s); using decoded source fallback."
                            % exc,
                            flush=True)
        anchor = start_image[:1] if start_image is not None else None
        if anchor is not None:
            suffix = (
                " and persistent opening anchor."
                if anchor_frames > 0 else ".")
            print(
                "[H3ReferenceMemory] I2V start image set as frame-0 keyframe"
                + suffix,
                flush=True)

        for shot_index, prompt in enumerate(shots):
            if operation_mode == "VIDEO EDITING" and shot_index > 0:
                edit_video, edit_audio = operation_video_segment(shot_index)
                bank = h3_refs.build_ref_bank(
                    video_vae, audio_vae, width, height, frames_per_shot,
                    ref_image_size,
                    ref_images=ref_images,
                    voice_ref=voice_ref,
                    ref_audios=(ref_audio_0, ref_audio_1),
                    ref_video=edit_video,
                    ref_video_audio=edit_audio)
                if bank:
                    print(bank.marker_map(), flush=True)
            if operation_mode == "VIDEO EXTENSION":
                # The boundary frame is a keyframe/memory item, not a numbered
                # reference-video block. Avoid leaving a dangling <Video 1>
                # marker in the structured prompt after removing that block.
                prompt = prompt.replace(
                    "<Video 1>", "the supplied previous-shot boundary")
            shot_bank, prompt, _active_pictures = (
                h3_refs.prepare_shot_bank(bank, prompt))
            memory_context = []
            external_boundary = (
                operation_mode == "VIDEO EXTENSION" and shot_index == 0)
            if anchor is not None and (
                    anchor_frames > 0 or external_boundary):
                memory_context.append(anchor)
            if history:
                take = memory_frames if memory_frames > 0 else 1
                memory_context.extend(history[-take:])
            memory_images = [
                mmh3._resize(frame[:1], width, height, "disabled")
                for frame in memory_context
            ]
            continuation = history[-1] if history else anchor

            print(
                "[H3ReferenceMemory] shot %d/%d (%df @ %dx%d) | "
                "memory=%d (anchor=%s, recent=%d) | refs=%d | guides=%d"
                % (
                    shot_index + 1, n, frames_per_shot, width, height,
                    len(memory_images),
                    "yes" if anchor is not None and anchor_frames > 0
                    else "no",
                    min(memory_frames, len(history))
                    if memory_frames > 0 else min(1, len(history)),
                    len(shot_bank.blocks),
                    len(guide_by_shot.get(shot_index, []))),
                flush=True)

            latent, frame_count = mmh3._empty_av_latent(
                width, height, frames_per_shot)
            if inpaint_enabled:
                edit_video, edit_audio = operation_video_segment(shot_index)
                source_frames = mmh3._resize(
                    edit_video, width, height, "disabled")
                source_video_latent = video_vae.encode(source_frames)
                streams = list(latent["samples"].unbind())

                def fit_stream(value, target, temporal_dim):
                    """Crop/pad an encoded source without resampling content."""
                    value = value.to(device=target.device, dtype=target.dtype)
                    for dim in range(2, value.ndim):
                        wanted = int(target.shape[dim])
                        current = int(value.shape[dim])
                        if current > wanted:
                            value = value.narrow(dim, 0, wanted)
                        elif current < wanted:
                            edge = value.select(dim, max(0, current - 1)).unsqueeze(dim)
                            repeats = [1] * value.ndim
                            repeats[dim] = wanted - current
                            value = torch.cat((value, edge.repeat(*repeats)), dim=dim)
                    return value

                streams[0] = fit_stream(source_video_latent, streams[0], 2)
                if edit_audio is not None:
                    source_audio_latent, _ = mmh3._encode_ref_audio(
                        audio_vae, edit_audio)
                    streams[1] = fit_stream(source_audio_latent, streams[1], 3)
                latent["samples"] = comfy.nested_tensor.NestedTensor(
                    tuple(streams))

                pixel_mask = operation_mask_segment(shot_index)
                mask_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(
                    "MVEx_MaskToLatentSpace")
                if mask_cls is None:
                    raise RuntimeError(
                        "MVEx_MaskToLatentSpace non disponibile. Installa "
                        "MaskVidExperiments e riavvia ComfyUI.")
                reduced = mask_cls.execute(
                    masks=pixel_mask,
                    compression={"compression": "auto"},
                    spatial_method="max",
                    temporal_method="max",
                    grow_spatial=max(0, int(studio_inpaint_grow)),
                    grow_temporal=0,
                    vae=video_vae,
                )[0]
                mask = reduced[None, None].to(
                    device=streams[0].device, dtype=streams[0].dtype)
                mask = torch.nn.functional.interpolate(
                    mask,
                    size=tuple(int(v) for v in streams[0].shape[-3:]),
                    mode="nearest")
                mask = mask.expand_as(streams[0])
                latent["noise_mask"] = comfy.nested_tensor.NestedTensor((
                    mask,
                    torch.zeros_like(streams[1]),
                ))
                print(
                    "[H3ReferenceMemory] VIDEO INPAINT clip %d/%d: "
                    "source latent + SAM3 mask, grow=%d px, active %.1f..%s s."
                    % (
                        shot_index + 1, n, int(studio_inpaint_grow),
                        float(studio_inpaint_start_seconds),
                        ("end" if float(studio_inpaint_end_seconds) <= 0
                         else "%.1f" % float(studio_inpaint_end_seconds))),
                    flush=True)
            keyframe_map = {}
            guide_context = []
            if continuation is not None:
                keyframe_image = mmh3._resize(
                    continuation[:1], width, height, "disabled")
                keyframe_map[0] = {
                    "resolved_frame_index": 0,
                    "image": keyframe_image,
                }
            for local_index, guide_image, _global_index in guide_by_shot.get(
                    shot_index, []):
                resize_mode = "disabled" if local_index == 0 else "center"
                resized_guide = mmh3._resize(
                    guide_image[:1], width, height, resize_mode)
                keyframe_map[int(local_index)] = {
                    "resolved_frame_index": int(local_index),
                    "image": resized_guide,
                }
                guide_context.append(resized_guide)
            keyframes = [
                keyframe_map[index] for index in sorted(keyframe_map)]

            marker_guides = []
            if keyframe_plan and keyframe_plan.get("images"):
                marker_guides = [
                    mmh3._resize(image[:1], width, height, "center")
                    for image in keyframe_plan["images"]
                    if image is not None]
            # In KEYFRAMES mode Picture ordinals must follow loader order.
            # Internal memory comes afterwards and needs no prompt marker.
            encoder_context = (
                marker_guides + memory_images
                if marker_guides else memory_images + guide_context)
            if shot_bank:
                items = self._reference_memory_items(
                    shot_bank, encoder_context)
                tokens = clip.tokenize(
                    prompt, minimax_ref_items=items)
            else:
                # Same API path as the original Memory sampler without refs.
                tokens = clip.tokenize(prompt, images=encoder_context)
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
            if shot_bank:
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"minimax_refs": shot_bank.blocks})

            motion_trim_frames = 0
            if motion_controller is not None:
                conditioning, motion_trim_frames = motion_controller.apply(
                    conditioning, video_vae, latent, shot_index)

            te_device = getattr(clip.patcher, "load_device", None)
            dit_device = getattr(model, "load_device", None)
            if (te_device is not None and dit_device is not None
                    and str(te_device) != str(dit_device)):
                if shot_index == 0:
                    print(
                        "[H3ReferenceMemory] TE on %s, DiT on %s - "
                        "separate devices, TE stays resident."
                        % (te_device, dit_device),
                        flush=True)
            else:
                try:
                    clip.patcher.model.to(
                        model_management.text_encoder_offload_device())
                except Exception as exc:
                    print(
                        "[H3ReferenceMemory] TE offload skipped: %s" % exc,
                        flush=True)
                try:
                    device = model_management.get_torch_device()
                    model_management.free_memory(
                        model_management.get_total_memory(device) * 0.9,
                        device)
                    model_management.soft_empty_cache()
                    free_gb = (
                        model_management.get_free_memory(device) / (1024 ** 3))
                    print(
                        "[H3ReferenceMemory] TE evicted; %.1f GB free for DiT"
                        % free_gb,
                        flush=True)
                except Exception as exc:
                    print(
                        "[H3ReferenceMemory] VRAM purge skipped: %s" % exc,
                        flush=True)

            guider = ncs.BasicGuider().get_guider(
                model, conditioning)[0]
            shot_seed = (
                seed + shot_index if seed_per_shot else seed)
            noise = ncs.RandomNoise().get_noise(shot_seed)[0]
            signature = shot_bank.signature() if shot_bank else ""
            motion_signature = ""
            if motion_controller is not None and motion_trim_frames > 0:
                motion_signature = "+mc%d+a%d" % (
                    int(motion_trim_frames),
                    int(motion_controller.audio_context_length))
            _auto_ctx["refsig"] = "%s+m%d%s" % (
                signature, len(memory_images), motion_signature)
            measurement = _auto_measure_begin()
            sample_succeeded = False
            try:
                output, denoised = ncs.SamplerCustomAdvanced().sample(
                    noise, guider, sampler, sigmas, latent)
                sample_succeeded = True
            finally:
                # Failed/OOM runs report allocator peaks that include the
                # failed allocation. Learning those values poisons future
                # auto-reserve decisions, so only successful samples train it.
                if sample_succeeded:
                    _auto_measure_end(measurement, model)
                _auto_ctx["refsig"] = ""

            if studio_upscale:
                upscaler_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(
                    "MinimaxH3LatentUpscaler3D")
                if upscaler_cls is None:
                    raise RuntimeError(
                        "MinimaxH3LatentUpscaler3D is not registered. Restart "
                        "ComfyUI after installing the latent upscaler node.")
                streams = list(output["samples"].unbind())
                video_latent = {"samples": streams[0]}
                upscale_result = upscaler_cls.execute(
                    latent=video_latent,
                    model_name=str(studio_upscale_model),
                    mode={
                        "mode": "target dimensions",
                        "width": target_width,
                        "height": target_height,
                    },
                    align=32,
                    keep_proportion=True,
                    device="cuda",
                    precision=str(studio_upscale_precision),
                )
                streams[0] = upscale_result[0]["samples"]
                refined_latent = dict(output)
                refined_latent["samples"] = comfy.nested_tensor.NestedTensor(
                    tuple(streams))
                refined_latent["noise_mask"] = comfy.nested_tensor.NestedTensor((
                    torch.ones_like(streams[0]),
                    torch.zeros_like(streams[1]),
                ))

                refine_steps = min(
                    4, max(0, int(studio_upscale_refine_steps)))
                if refine_steps:
                    schedules = {
                        1: [0.3158, 0.0],
                        2: [0.6316, 0.3158, 0.0],
                        3: [0.9035, 0.6316, 0.3158, 0.0],
                        4: [0.9035, 0.8000, 0.6316, 0.3158, 0.0],
                    }
                    refine_sigmas = torch.tensor(
                        schedules[refine_steps], dtype=torch.float32)
                    refine_noise = ncs.RandomNoise().get_noise(shot_seed)[0]
                    output, denoised = ncs.SamplerCustomAdvanced().sample(
                        refine_noise, guider, sampler, refine_sigmas,
                        refined_latent)
                    del refine_noise, refine_sigmas
                else:
                    output = refined_latent
                print(
                    "[H3ReferenceMemory] Studio latent final render complete "
                    "for clip %d/%d." % (shot_index + 1, n),
                    flush=True)

            if motion_controller is not None:
                motion_controller.capture(output, shot_index)

            context_prefix = str(studio_context_prefix or "").strip()
            context_index = int(studio_context_clip_index or 0)
            if context_prefix and context_index > 0 and shot_index == n - 1:
                save_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(
                    "MiniMaxH3MotionContextSaveLatent")
                if save_cls is None:
                    print(
                        "[H3ReferenceMemory] native Studio context saver is "
                        "not registered; candidate video will still finish.",
                        flush=True)
                else:
                    try:
                        latent_path = save_cls().save(
                            output, context_prefix, context_index)[0]
                        print(
                            "[H3ReferenceMemory] saved native Studio AV "
                            "context: %s" % latent_path,
                            flush=True)
                    except Exception as exc:
                        print(
                            "[H3ReferenceMemory] native Studio context save "
                            "failed; candidate video will still finish: %s"
                            % exc,
                            flush=True)

            samples = output["samples"]
            if getattr(samples, "is_nested", False):
                samples = samples.unbind()[0]
            images = video_vae.decode(samples)
            if images.ndim == 5:
                images = images.reshape(
                    -1, images.shape[-3], images.shape[-2], images.shape[-1])
            audio = vae_decode_audio(audio_vae, output)
            visual_overlap = None
            if (motion_controller is not None
                    and motion_trim_frames > 0
                    and getattr(motion_controller, "crossfade_frames", 0) > 0):
                overlap = min(
                    int(motion_trim_frames),
                    int(motion_controller.crossfade_frames),
                    int(images.shape[0]))
                if overlap > 0:
                    start = int(motion_trim_frames) - overlap
                    visual_overlap = images[start:int(motion_trim_frames)].clone()
            if motion_controller is not None and motion_trim_frames > 0:
                images, audio = motion_controller.trim(
                    images, audio, motion_trim_frames)
            sample_rate = audio["sample_rate"]
            waveform = audio["waveform"]

            # Continuity is tracked in crop space. Only after decoding do we
            # paste the edited subject back onto exact original source frames.
            history_image = images
            if inpaint_enabled:
                uncrop_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(
                    "MVEx_SubjectUncrop")
                if uncrop_cls is None:
                    raise RuntimeError(
                        "MVEx_SubjectUncrop non disponibile. Installa "
                        "MaskVidExperiments e riavvia ComfyUI.")
                frame_count_out = int(images.shape[0])
                original_segment = operation_original_segment(
                    shot_index, frame_count_out)
                bbox_segment = operation_bbox_segment(
                    shot_index, frame_count_out)
                mask_segment = operation_mask_segment(shot_index)
                if int(mask_segment.shape[0]) < frame_count_out:
                    mask_segment = torch.cat((
                        mask_segment,
                        mask_segment[-1:].repeat(
                            frame_count_out - int(mask_segment.shape[0]),
                            1, 1)), dim=0)
                images = uncrop_cls.execute(
                    cropped_images=images,
                    original_images=original_segment,
                    bboxes=bbox_segment,
                    feather=max(0, int(studio_inpaint_feather)),
                    cropped_masks=mask_segment[:frame_count_out],
                )[0]
                print(
                    "[H3ReferenceMemory] MaskVid uncrop clip %d/%d: "
                    "outside-mask pixels restored from source." %
                    (shot_index + 1, n),
                    flush=True)

            if anchor is None and anchor_frames > 0:
                anchor = images[:1].detach().to("cpu").clone()
                print(
                    "[H3ReferenceMemory] persistent opening anchor captured "
                    "from shot 1 frame 1.",
                    flush=True)
            history.append(history_image[-1:].detach().to("cpu").clone())
            if len(history) > 8:
                history.pop(0)

            trim_boundary = (
                shot_index > 0
                or (operation_mode == "VIDEO EXTENSION" and shot_index == 0))
            if trim_boundary and motion_trim_frames <= 0:
                images = images[1:]
                trim = int(round(sample_rate / 24.0))
                waveform = waveform[..., trim:]
            if visual_overlap is not None:
                blended = frame_store.blend_tail(visual_overlap)
                print(
                    "[H3ReferenceMotionMemory] clip %d: linear video "
                    "overlap blended across %d frame(s)." %
                    (shot_index + 1, blended),
                    flush=True)
            frame_store.append(images)
            audio_parts.append(waveform.detach().to("cpu"))

            # The frame store and audio list now own CPU copies. Always drop
            # per-shot GPU intermediates, even in the normal RAM-output mode;
            # otherwise clip N remains live while clip N+1 is sampled and VRAM
            # grows until a later clip OOMs.
            del images, history_image, samples, output, audio, waveform, denoised
            del noise, guider, conditioning, latent, tokens, visual_overlap
            del memory_images, memory_context, keyframes, guide_context
            del marker_guides, encoder_context
            if shot_index + 1 < n:
                model_management.soft_empty_cache()

        master = frame_store.finish()
        master_waveform = _xfade_audio(audio_parts, sample_rate)
        if operation_mode == "VIDEO EDITING" and original_ref_video is not None:
            source_frames = int(original_ref_video.shape[0])
            master = master[:source_frames]
            source_samples = int(round(
                source_frames * float(sample_rate) / 24.0))
            master_waveform = master_waveform[..., :source_samples]
            print(
                "[H3ReferenceMemory] VIDEO EDITING trimmed to source "
                "duration: %d frames (%.3fs)." %
                (source_frames, source_frames / 24.0),
                flush=True)
        print(
            "[H3ReferenceMemory] done: %d shots, %d frames (~%.1fs)."
            % (n, master.shape[0], master.shape[0] / 24.0),
            flush=True)
        return (
            master,
            {"waveform": master_waveform, "sample_rate": sample_rate},
            n,
        )


NODE_CLASS_MAPPINGS = {
    "H3ReferenceMemorySampler": H3ReferenceMemorySampler,
    "H3StudioInpaintStatus": H3StudioInpaintStatus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3ReferenceMemorySampler": "H3 Reference + Memory (one node)",
    "H3StudioInpaintStatus": "H3 Studio Inpaint Status",
}

"""Painter MiniMax To Video: first/last-frame hard anchor + reference-to-video (based on PainterMiniMaxRefToVideo2).

Adds first/last-frame inputs on top of PainterMiniMaxRefToVideo2:
- first_frame / last_frame hard-anchor the first/last frames (via minimax_keyframes / cond segment)
- reference images (internally uploaded, up to 9, tags <Picture 1>~<Picture 9> unchanged)
- reference videos / audios (external, tags <Video k> / <Audio j> unchanged)
- first/last frame tag = number of reference images + 1 / + 2 (with 9 reference images -> <Picture 10> / <Picture 11>)

First/last frames are hard-anchored, so they take effect regardless of whether <Picture N>
appears in the prompt; their tag numbers can be arbitrary as long as they do not clash with
the reference image tags.

Second-pass conditioning (upscaled_positive output):
A "scale" parameter scales width/height (snapped to 32px) and re-encodes the first/last
frames at the upscaled size, so a second-pass sampling after a latent upscaler can use
first/last-frame conditioning whose latents match the upscaled latent dimensions (the
low-res keyframe latents would otherwise mismatch and crash). Set "scale" equal to the
latent upscaler's scale.

Principle (two runtime patches, no official file on disk is modified):
Patch 1 (extra_conds overwrite bug): cond_video_latents is overwritten by the refs branch,
    so first/last frame latents are lost -> patched to concatenate instead.
Patch 2 (PackedLayout position misalignment bug): when keyframes and refs coexist, the cond
    segment's time position does not shift with the refs' cursor push, so the first/last
    frames and the video are misaligned on the time axis and cannot be hard-anchored ->
    patched to offset the cond segment's time position by refs_offset to realign.
Both patches only take effect when keyframes and refs coexist; pure fl2va / pure ref2va
are unaffected.
"""

import json
import os

import torch
import torchaudio
import numpy as np
from PIL import Image, ImageOps

import nodes
import folder_paths
import comfy.model_management
import comfy.nested_tensor
import comfy.model_base
import comfy.utils
import node_helpers
import comfy.ldm.minimax.model as minimax_model

from comfy_api.latest import io


REF_CANVAS_MULTIPLE = 32
FPS = 24
AUDIO_LATENT_FPS = 40


def align_frame_count(n):
    while n % 17 != 5:
        n += 1
    return n


def video_latent_t(frame_count):
    return 2 if frame_count <= 5 else ((frame_count - 5) // 17) * 5 + 2


def temporal_shape(length):
    frame_count = align_frame_count(max(5, length))
    duration = frame_count / FPS
    return frame_count, video_latent_t(frame_count), round(duration * AUDIO_LATENT_FPS)


def _resize(image, width, height, crop):
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)


def _empty_av_latent(width, height, length, batch_size=1):
    frame_count, latent_t, audio_t = temporal_shape(length)

    video = torch.zeros(
        [batch_size, 24, latent_t, height // 16, width // 16],
        device=comfy.model_management.intermediate_device(),
    )

    audio = torch.zeros(
        [batch_size, 32, 2, audio_t],
        device=comfy.model_management.intermediate_device(),
    )

    return {"samples": comfy.nested_tensor.NestedTensor((video, audio))}, frame_count


def _load_uploaded_ref_image(file_info):
    """Load a reference image from uploaded file info dict.

    Accepts either a dict {"filename": ..., "subfolder": ..., "type": ...}
    or a plain filename string.
    """
    if isinstance(file_info, str):
        try:
            file_info = json.loads(file_info)
        except (json.JSONDecodeError, TypeError):
            file_info = {"filename": file_info}

    if not isinstance(file_info, dict):
        return None

    filename = file_info.get("filename", "")
    subfolder = file_info.get("subfolder", "")
    file_type = file_info.get("type", "input")

    if not filename:
        return None

    image_path = None
    if file_type == "input":
        base_dir = folder_paths.get_input_directory()
        image_path = os.path.join(base_dir, subfolder, filename) if subfolder else os.path.join(base_dir, filename)
    else:
        full_name = os.path.join(subfolder, filename) if subfolder else filename
        image_path = folder_paths.get_full_path(file_type, full_name)

    if not image_path or not os.path.isfile(image_path):
        return None

    img = Image.open(image_path)
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


# ---------------- Patch 1: extra_conds overwrite bug ----------------
def _apply_extra_conds_patch():
    if not hasattr(comfy.model_base, "MiniMaxH3"):
        print("[PainterMiniMaxToVideo] WARNING: MiniMaxH3 not found, extra_conds patch skipped")
        return
    f = comfy.model_base.MiniMaxH3.extra_conds
    if getattr(f, "_minimax_kfref_patched", False):
        return
    orig = f

    def patched_extra_conds(self, **kwargs):
        out = orig(self, **kwargs)
        keyframes = kwargs.get("minimax_keyframes")
        refs = kwargs.get("minimax_refs")
        if keyframes and refs:
            payload = out["minimax_payload"].cond
            payload["cond_video_latents"] = (
                [kf["latent"] for kf in keyframes]
                + [r["latent"] for r in refs if "latent" in r]
            )
        return out

    patched_extra_conds._minimax_kfref_patched = True
    comfy.model_base.MiniMaxH3.extra_conds = patched_extra_conds


# ---------------- Patch 2: PackedLayout position misalignment bug ----------------
def _refs_time_offset(refs):
    """Recompute how much the PackedLayout refs branch pushes the cursor (must match its internal logic)."""
    off = 0.0
    for blk in refs:
        kind = blk["kind"]
        if kind == "image":
            off += 1.0
        elif kind == "audio":
            off += float(blk["ref_audio_t"])
        elif kind in ("video", "video_audio"):
            off += max(float(blk["ref_audio_t"]), sum(minimax_model._video_t_spans(blk["latent_t"])))
    return off


def _apply_layout_patch():
    if not hasattr(minimax_model, "PackedLayout"):
        print("[PainterMiniMaxToVideo] WARNING: PackedLayout not found, layout patch skipped")
        return
    f = minimax_model.PackedLayout.__init__
    if getattr(f, "_minimax_kfref_layout_patched", False):
        return
    orig = f

    def patched_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
                     keyframes=None, refs=None, frame_count=None):
        orig(self, text_len, latent_t, latent_h, latent_w, audio_t,
             keyframes=keyframes, refs=refs, frame_count=frame_count)
        if keyframes and refs:
            off = _refs_time_offset(refs)
            if off:
                for a, b, kind in self.segments:
                    if kind == "cond":
                        self.position_ids[a:b, 0] += off

    patched_init._minimax_kfref_layout_patched = True
    minimax_model.PackedLayout.__init__ = patched_init


_apply_extra_conds_patch()
_apply_layout_patch()


class PainterMiniMaxToVideo(io.ComfyNode):
    """First/last-frame hard anchor + reference-to-video (internal ref images + external video/audio + first/last frames)."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PainterMiniMaxToVideo",
            description="First/last-frame hard anchor + reference-to-video. Reference images <Picture 1..9>, videos <Video k>, audios <Audio j>; first/last frames are hard-anchored (tags come after reference images, <Picture 10>/<Picture 11> with 9 reference images). 'scale' produces an upscaled_positive conditioning for second-pass sampling.",
            display_name="Painter MiniMax To Video",
            category="model/conditioning/minimax",
            inputs=[
                io.Clip.Input("clip"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Int.Input(
                    "width",
                    default=1376,
                    min=32,
                    max=nodes.MAX_RESOLUTION,
                    step=32,
                ),
                io.Int.Input(
                    "height",
                    default=768,
                    min=32,
                    max=nodes.MAX_RESOLUTION,
                    step=32,
                ),
                io.Int.Input(
                    "length",
                    default=124,
                    min=5,
                    max=3600,
                    step=17,
                    tooltip="Frame count at 24 fps, (124 = ~5s, trained range is ~124-362)",
                ),
                io.Int.Input(
                    "ref_max_size",
                    default=1536,
                    min=32,
                    max=4096,
                    step=32,
                    tooltip="Reference max long edge. Reference images and videos are scaled down (never up) so the longest side fits this value, then snapped to 32px.",
                ),
                io.Image.Input(
                    "first_frame",
                    optional=True,
                    tooltip="First frame hard anchor (video starts exactly from this frame, tag comes after reference images)",
                ),
                io.Image.Input(
                    "last_frame",
                    optional=True,
                    tooltip="Last frame hard anchor (video ends exactly at this frame, tag comes after reference images)",
                ),
                io.String.Input(
                    "ref_image_files",
                    default="[]",
                    multiline=False,
                    tooltip="Internal: JSON array of uploaded reference image file info (managed by frontend upload area)",
                ),
                io.Autogrow.Input(
                    "ref_videos",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Image.Input(
                            "ref_video",
                            tooltip="Reference video frames at 24 fps (2-15s)",
                        ),
                        prefix="ref_video_",
                        min=0,
                        max=3,
                    ),
                ),
                io.Autogrow.Input(
                    "ref_video_audios",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Audio.Input(
                            "ref_video_audio",
                            tooltip="Soundtrack of the same-numbered reference video",
                        ),
                        prefix="ref_video_audio_",
                        min=0,
                        max=3,
                    ),
                ),
                io.Autogrow.Input(
                    "ref_audios",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Audio.Input(
                            "ref_audio",
                            tooltip="Standalone reference audio",
                        ),
                        prefix="ref_audio_",
                        min=0,
                        max=3,
                    ),
                ),
                io.Float.Input(
                    "scale",
                    default=1.0,
                    min=1.0,
                    max=4.0,
                    step=0.1,
                    tooltip="Upscale factor for the second-pass conditioning. First/last frames are re-encoded at width*scale x height*scale (snapped to 32px). Set equal to the latent upscaler's scale so upscaled_positive matches the upscaled latent.",
                ),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(),
                io.Conditioning.Output(display_name="upscaled_positive"),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.Int.Output(display_name="length"),
                io.String.Output(display_name="prompt"),
            ],
        )

    @staticmethod
    def _encode_ref_audio(audio_vae, audio):
        waveform = audio["waveform"]
        sr = audio["sample_rate"]
        vae_sr = getattr(audio_vae, "audio_sample_rate", 32000)

        if sr != vae_sr:
            waveform = torchaudio.functional.resample(waveform, sr, vae_sr)

        z = audio_vae.encode(waveform[:1].movedim(1, -1))
        return z, z.shape[-1]

    @classmethod
    def execute(
        cls,
        clip,
        vae,
        audio_vae,
        prompt,
        width,
        height,
        length,
        ref_max_size=1536,
        first_frame=None,
        last_frame=None,
        ref_image_files="[]",
        ref_videos=None,
        ref_video_audios=None,
        ref_audios=None,
        scale=1.0,
    ) -> io.NodeOutput:
        latent, frame_count = _empty_av_latent(width, height, length)

        ref_items = []
        ref_blocks = []

        # --- Load internally uploaded reference images ---
        try:
            files_list = json.loads(ref_image_files) if isinstance(ref_image_files, str) else ref_image_files
        except (json.JSONDecodeError, TypeError):
            files_list = []

        if isinstance(files_list, list):
            for file_info in files_list:
                if not file_info:
                    continue
                img = _load_uploaded_ref_image(file_info)
                if img is None:
                    continue
                h, w = img.shape[1], img.shape[2]
                scale_ratio = min(1.0, ref_max_size / max(w, h))

                tw = max(
                    REF_CANVAS_MULTIPLE,
                    round(w * scale_ratio / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
                )
                th = max(
                    REF_CANVAS_MULTIPLE,
                    round(h * scale_ratio / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
                )

                resized = _resize(img[:1], tw, th, "disabled")
                z = vae.encode(resized)

                ref_items.append({"type": "image", "data": resized})
                ref_blocks.append(
                    {
                        "kind": "image",
                        "latent_h": th // 16,
                        "latent_w": tw // 16,
                        "latent": z,
                    }
                )

        # --- External reference videos ---
        ref_video_audios = ref_video_audios or {}

        for name, video_frames in (ref_videos or {}).items():
            if video_frames is None:
                continue

            soundtrack = ref_video_audios.get(
                "ref_video_audio_" + name.rsplit("_", 1)[-1]
            )

            vh, vw = video_frames.shape[1], video_frames.shape[2]
            scale_ratio = min(1.0, ref_max_size / max(vw, vh))

            cw = max(
                REF_CANVAS_MULTIPLE,
                round(vw * scale_ratio / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
            )
            ch = max(
                REF_CANVAS_MULTIPLE,
                round(vh * scale_ratio / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
            )

            frames = _resize(video_frames, cw, ch, "disabled")

            if frames.shape[0] > frame_count:
                frames = frames[:frame_count]

            n = frames.shape[0]

            if n < 5:
                raise ValueError(
                    "MiniMax H3 reference videos need at least 5 frames (~0.2s at 24 fps)"
                )

            while n % 17 != 5:
                n -= 1

            frames = frames[:n]
            z = vae.encode(frames)

            audio_latent, ref_audio_t = (None, 0)

            if soundtrack is not None:
                audio_latent, ref_audio_t = cls._encode_ref_audio(audio_vae, soundtrack)
                ref_items.append({"type": "audio"})

            sample_idx = list(range(0, frames.shape[0], FPS // 2))
            qwen_frames = frames[sample_idx]

            ref_items.append(
                {
                    "type": "video",
                    "data": qwen_frames,
                    "timestamps": [i / 2.0 for i in range(len(sample_idx))],
                }
            )

            ref_blocks.append(
                {
                    "kind": "video_audio" if ref_audio_t else "video",
                    "latent_t": z.shape[2],
                    "latent_h": ch // 16,
                    "latent_w": cw // 16,
                    "ref_audio_t": ref_audio_t,
                    "latent": z,
                    "audio_latent": audio_latent,
                }
            )

        # --- External reference audios ---
        for audio in (ref_audios or {}).values():
            if audio is None:
                continue

            audio_latent, ref_audio_t = cls._encode_ref_audio(audio_vae, audio)

            ref_items.append({"type": "audio"})
            ref_blocks.append(
                {
                    "kind": "audio",
                    "ref_audio_t": ref_audio_t,
                    "audio_latent": audio_latent,
                }
            )

        # --- First/last frame hard anchor (placed after ref images/videos/audios, tags auto-numbered after reference images) ---
        up_width = max(32, round(width * scale / 32) * 32)
        up_height = max(32, round(height * scale / 32) * 32)
        is_scaled = (up_width != width) or (up_height != height)

        keyframes_low = []
        keyframes_high = []
        if first_frame is not None:
            img_low = _resize(first_frame[:1], width, height, "disabled")
            keyframes_low.append({"resolved_frame_index": 0, "image": img_low})
            ref_items.append({"type": "image", "data": img_low})
            if is_scaled:
                img_high = _resize(first_frame[:1], up_width, up_height, "disabled")
                keyframes_high.append({"resolved_frame_index": 0, "image": img_high})
        if last_frame is not None:
            img_low = _resize(last_frame[:1], width, height, "center")
            keyframes_low.append({"resolved_frame_index": frame_count - 1, "image": img_low})
            ref_items.append({"type": "image", "data": img_low})
            if is_scaled:
                img_high = _resize(last_frame[:1], up_width, up_height, "center")
                keyframes_high.append({"resolved_frame_index": frame_count - 1, "image": img_high})

        for kf in keyframes_low:
            kf["latent"] = vae.encode(kf.pop("image"))
        if is_scaled:
            for kf in keyframes_high:
                kf["latent"] = vae.encode(kf.pop("image"))
        else:
            keyframes_high = keyframes_low

        tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
        cond = clip.encode_from_tokens_scheduled(tokens)

        values_low = {}
        if ref_blocks:
            values_low["minimax_refs"] = ref_blocks
        if keyframes_low:
            values_low["minimax_keyframes"] = keyframes_low
            values_low["minimax_frame_count"] = frame_count
        cond_low = node_helpers.conditioning_set_values(cond, values_low) if values_low else cond

        values_high = {}
        if ref_blocks:
            values_high["minimax_refs"] = ref_blocks
        if keyframes_high:
            values_high["minimax_keyframes"] = keyframes_high
            values_high["minimax_frame_count"] = frame_count
        cond_high = node_helpers.conditioning_set_values(cond, values_high) if values_high else cond

        return io.NodeOutput(cond_low, latent, cond_high, width, height, length, prompt)


NODE_CLASS_MAPPINGS = {
    "PainterMiniMaxToVideo": PainterMiniMaxToVideo
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterMiniMaxToVideo": "Painter MiniMax To Video"
}

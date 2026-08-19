"""Painter MiniMax FL2VA: first/last-frame (fl2va) + reference audio timbre node.

(Migrated from minimax_h3_fl2va_audio.py, renamed PainterMiniMaxFL2VA, and added to the
ComfyUI-PainterNodes package.)

Adds a reference audio input on top of the official MiniMaxH3ImageToVideo, so the
generated voice follows the timbre/style of the given reference audio.

Principle:
- first/last frame -> minimax_keyframes (fl2va hard anchor, cond segment)
- reference audio -> audio block in minimax_refs -> cond_audio_latents (ref_audio segment)
- The two coexist in the underlying PackedLayout, but the official implementation has
  two bugs that require two runtime patches:

Patch 1 (extra_conds overwrite bug):
  cond_video_latents is shared by the keyframes / refs branches; the refs branch
  overwrites the keyframes value. An audio-only ref has no "latent" key, which
  overwrites cond_video_latents with an empty list -> first/last frame latents lost.
  -> patched to concatenate keyframes + refs.

Patch 2 (PackedLayout position misalignment bug, root cause):
  keyframes' cond-segment time positions start from text_len (first frame text_len /
  last frame text_len + video span), but the refs branch pushes cursor by refs_offset
  (audio pushes ref_audio_t, image pushes 1, video pushes its span), so the target
  video segment shifts back while the cond segment stays put -> first/last frames and
  the video are misaligned on the time axis, RoPE positions no longer match, and
  attention cannot hard-anchor the first/last frames (degrades to "identity only").
  -> patched to offset the cond segment's time position by refs_offset after __init__.

Both patches do not modify official files on disk and only take effect when keyframes
and refs coexist; pure fl2va / pure ref2va are unaffected.

Tag numbering (reference in prompt):
    <Picture 1> = first frame (if provided)
    <Picture 2> = last frame (if provided; last frame becomes <Picture 1> when no first frame)
    <Audio 1> = reference audio (timbre)
"""

import torch
import torchaudio

import nodes
import node_helpers
import comfy.model_management
import comfy.nested_tensor
import comfy.model_base
import comfy.utils
import comfy.ldm.minimax.model as minimax_model

from comfy_api.latest import io


CANVAS_MULTIPLE = 32
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
    video = torch.zeros([batch_size, 24, latent_t, height // 16, width // 16],
                        device=comfy.model_management.intermediate_device())
    audio = torch.zeros([batch_size, 32, 2, audio_t],
                        device=comfy.model_management.intermediate_device())
    return {"samples": comfy.nested_tensor.NestedTensor((video, audio))}, frame_count


# ---------------- Patch 1: extra_conds overwrite bug ----------------
def _apply_extra_conds_patch():
    if not hasattr(comfy.model_base, "MiniMaxH3"):
        print("[PainterMiniMaxFL2VA] WARNING: MiniMaxH3 not found, extra_conds patch skipped")
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


# ---------------- Patch 2: PackedLayout position misalignment bug (root cause) ----------------
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
        print("[PainterMiniMaxFL2VA] WARNING: PackedLayout not found, layout patch skipped")
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
                # Offset the cond segment (first/last frame) time position by refs_offset
                # to realign it with the target video segment (already pushed by refs).
                for a, b, kind in self.segments:
                    if kind == "cond":
                        self.position_ids[a:b, 0] += off

    patched_init._minimax_kfref_layout_patched = True
    minimax_model.PackedLayout.__init__ = patched_init


_apply_extra_conds_patch()
_apply_layout_patch()


class PainterMiniMaxFL2VA(io.ComfyNode):
    """First/last-frame (fl2va) + reference audio timbre node."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PainterMiniMaxFL2VA",
            display_name="Painter MiniMax FL2VA",
            category="model/conditioning/minimax",
            description="First/last frame hard anchor (fl2va) + reference audio timbre. The voice follows <Audio 1> timbre; write the lines in the prompt.",
            inputs=[
                io.Clip.Input("clip"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Int.Input("width", default=1344, min=32, max=nodes.MAX_RESOLUTION, step=32),
                io.Int.Input("height", default=768, min=32, max=nodes.MAX_RESOLUTION, step=32),
                io.Int.Input("length", default=124, min=5, max=3600, step=17),
                io.Image.Input("first_frame", optional=True, tooltip="First frame hard anchor (<Picture 1>)"),
                io.Image.Input("last_frame", optional=True, tooltip="Last frame hard anchor (<Picture 2>; becomes <Picture 1> when no first frame)"),
                io.Autogrow.Input("ref_audios", optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Audio.Input("ref_audio", tooltip="Reference audio (timbre/style, <Audio 1> and up)"),
                        prefix="ref_audio_", min=0, max=3)),
            ],
            outputs=[io.Conditioning.Output(display_name="positive"), io.Latent.Output()],
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
    def execute(cls, clip, vae, audio_vae, prompt, width, height, length,
                first_frame=None, last_frame=None, ref_audios=None) -> io.NodeOutput:
        latent, frame_count = _empty_av_latent(width, height, length)

        # 1) first/last frame (fl2va hard anchor) -- presentation kept separate from latent
        keyframes = []
        ref_items = []
        if first_frame is not None:
            img = _resize(first_frame[:1], width, height, "disabled")
            keyframes.append({"resolved_frame_index": 0, "image": img})
            ref_items.append({"type": "image", "data": img})
        if last_frame is not None:
            img = _resize(last_frame[:1], width, height, "center")
            keyframes.append({"resolved_frame_index": frame_count - 1, "image": img})
            ref_items.append({"type": "image", "data": img})

        # 2) reference audio (timbre)
        ref_blocks = []
        for audio in (ref_audios or {}).values():
            if audio is None:
                continue
            audio_latent, ref_audio_t = cls._encode_ref_audio(audio_vae, audio)
            ref_items.append({"type": "audio"})
            ref_blocks.append({"kind": "audio", "ref_audio_t": ref_audio_t, "audio_latent": audio_latent})

        # 3) first/last frame latents (presentation already saved into ref_items)
        for kf in keyframes:
            kf["latent"] = vae.encode(kf.pop("image"))

        # 4) tokenize + conditioning
        tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
        cond = clip.encode_from_tokens_scheduled(tokens)
        values = {}
        if ref_blocks:
            values["minimax_refs"] = ref_blocks
        if keyframes:
            values["minimax_keyframes"] = keyframes
            values["minimax_frame_count"] = frame_count
        if values:
            cond = node_helpers.conditioning_set_values(cond, values)
        return io.NodeOutput(cond, latent)


NODE_CLASS_MAPPINGS = {
    "PainterMiniMaxFL2VA": PainterMiniMaxFL2VA
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterMiniMaxFL2VA": "Painter MiniMax FL2VA"
}

"""MiniMax H3 Reference to Video node (standalone).

Prompt + reference images / videos / audio -> conditioning + AV latent.
Reference tags: <Picture i> / <Video k> / <Audio j>.
"""

import torch
import torchaudio

import nodes
import comfy.model_management
import comfy.nested_tensor
import comfy.utils
import node_helpers

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


class PainterMiniMaxRefToVideo(io.ComfyNode):
    """ref2va: prompt + reference images / videos / audio -> conditioning + AV latent."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PainterMiniMaxRefToVideo",
            description="Reference conditioning for MiniMax H3. Use <Picture i> / <Video k> / <Audio j> tags when prompting.",
            display_name="Painter MiniMax Ref To Video",
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
                io.Autogrow.Input(
                    "ref_images",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Image.Input(
                            "ref_image",
                            tooltip="Reference image (downscaled to ref_max_size long edge if larger, never upscaled)",
                        ),
                        prefix="ref_image_",
                        min=0,
                        max=9,
                    ),
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
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(),
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
        ref_images=None,
        ref_videos=None,
        ref_video_audios=None,
        ref_audios=None,
    ) -> io.NodeOutput:
        latent, frame_count = _empty_av_latent(width, height, length)

        ref_items = []
        ref_blocks = []

        for img in (ref_images or {}).values():
            if img is None:
                continue

            h, w = img.shape[1], img.shape[2]
            scale = min(1.0, ref_max_size / max(w, h))

            tw = max(
                REF_CANVAS_MULTIPLE,
                round(w * scale / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
            )
            th = max(
                REF_CANVAS_MULTIPLE,
                round(h * scale / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
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

        ref_video_audios = ref_video_audios or {}

        for name, video_frames in (ref_videos or {}).items():
            if video_frames is None:
                continue

            soundtrack = ref_video_audios.get(
                "ref_video_audio_" + name.rsplit("_", 1)[-1]
            )

            vh, vw = video_frames.shape[1], video_frames.shape[2]
            scale = min(1.0, ref_max_size / max(vw, vh))

            cw = max(
                REF_CANVAS_MULTIPLE,
                round(vw * scale / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
            )
            ch = max(
                REF_CANVAS_MULTIPLE,
                round(vh * scale / REF_CANVAS_MULTIPLE) * REF_CANVAS_MULTIPLE,
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

        tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
        cond = clip.encode_from_tokens_scheduled(tokens)

        if ref_blocks:
            cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": ref_blocks})

        return io.NodeOutput(cond, latent, width, height, length, prompt)


NODE_CLASS_MAPPINGS = {
    "PainterMiniMaxRefToVideo": PainterMiniMaxRefToVideo
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterMiniMaxRefToVideo": "Painter MiniMax Ref To Video"
}

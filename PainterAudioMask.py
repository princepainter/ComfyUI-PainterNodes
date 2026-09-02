import json
import numpy as np
import torch


class PainterAudioMask:
    """
    Draw a 0..1 mask curve over an audio waveform and export a 1D
    time-axis mask tensor for MiniMax H3 partial audio regeneration.

    The mask is described by JSON control points [{t: seconds, v: 0..1}]
    drawn on the waveform in the node UI. At execution time the points are
    linearly interpolated (np.interp) and resampled to
    `total_frames = round(duration * 40)` because the MiniMax H3 audio
    latent runs at a fixed 40 frames per second.

    Semantics (matching MiniMax H3 `audio_denoise_mask`):
      v = 0.0  -> keep the original audio (no regeneration)
      v = 1.0  -> fully regenerate from the prompt
      v in (0,1) -> partial blend strength

    With no control points the mask is all zeros (keep everything).
    """

    FRAME_RATE = 40.0  # MiniMax H3 audio latent frames per second

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # mask_points is populated by the JS side from the drawn
                # curve; it is a JSON array of {t, v} control points.
                "mask_points": ("STRING", {"default": "[]", "multiline": False}),
                "duration": ("FLOAT", {
                    "default": 10.0,
                    "min": 0.1,
                    "max": 1000.0,
                    "step": 0.1,
                }),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "build_mask"
    CATEGORY = "audio/mask"
    OUTPUT_NODE = False

    def build_mask(self, mask_points="[]", duration=10.0):
        total_frames = max(1, int(round(float(duration) * self.FRAME_RATE)))

        try:
            raw = json.loads(mask_points) if (mask_points and mask_points.strip()) else []
        except Exception:
            raw = []

        if not raw:
            return (torch.zeros(1, 1, total_frames),)

        pts = []
        for p in raw:
            t = float(p.get("t", 0.0))
            v = float(p.get("v", 0.0))
            pts.append((t, v))
        pts.sort(key=lambda x: x[0])

        times = [p[0] for p in pts]
        values = [min(1.0, max(0.0, p[1])) for p in pts]

        # Extend the endpoints so the whole [0, duration] range is defined.
        if times[0] > 0.0:
            times.insert(0, 0.0)
            values.insert(0, values[0])
        if times[-1] < float(duration):
            times.append(float(duration))
            values.append(values[-1])

        frame_times = np.linspace(0.0, float(duration), total_frames)
        mask_np = np.interp(frame_times, times, values)

        mask = torch.from_numpy(mask_np.astype(np.float32)).reshape(1, 1, total_frames)
        return (mask,)

    @classmethod
    def IS_CHANGED(cls, mask_points="[]", duration=10.0):
        return f"{mask_points}|{duration}"


NODE_CLASS_MAPPINGS = {
    "PainterAudioMask": PainterAudioMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterAudioMask": "Painter Audio Mask",
}

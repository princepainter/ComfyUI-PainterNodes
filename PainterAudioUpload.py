import os
import torch
import folder_paths


class PainterAudioUpload:
    """
    Audio upload and record node with waveform visualization and visual trim.

    Provides an in-node widget that lets the user:
      - Upload an audio file (mp3 / wav / flac / ogg / m4a / webm).
      - Record audio directly from the browser microphone.
      - View the waveform and drag-select a region to trim.
      - Mute, loop and rewind / forward during playback.

    The selected trim range is stored in hidden widgets and applied at
    execution time, so the original file on disk is never modified.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # All three are regular required widgets (not hidden) so
                # their values are reliably included in the prompt payload
                # in ComfyUI v3. The JS side collapses them visually via
                # computeSize so they don't show in the node UI.
                "audio_filename": ("STRING", {"default": ""}),
                "trim_start": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 99999.0,
                    "step": 0.01,
                }),
                "trim_end": ("FLOAT", {
                    "default": -1.0,
                    "min": -1.0,
                    "max": 99999.0,
                    "step": 0.01,
                }),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "load_audio"
    CATEGORY = "audio/input"
    OUTPUT_NODE = False

    def load_audio(self, audio_filename="", trim_start=0.0, trim_end=-1.0):
        if not audio_filename:
            # Distinguish "user forgot to upload" vs. "user trimmed but the
            # file was lost" so the user knows what to do.
            had_trim = (
                (trim_start not in (None, 0, 0.0))
                or (trim_end not in (None, -1, -1.0))
            )
            if had_trim:
                raise ValueError(
                    "PainterAudioUpload: trim range is set but no audio file "
                    "is associated. The previous upload may have been cleared. "
                    "Right-click the node and choose 'Clear audio' to reset, "
                    "then upload the file again."
                )
            raise ValueError(
                "PainterAudioUpload: no audio has been uploaded or recorded. "
                "Use the upload or microphone button in the node first."
            )

        input_dir = folder_paths.get_input_directory()
        file_path = None
        candidates = [
            os.path.join(input_dir, audio_filename),
            audio_filename if os.path.isabs(audio_filename) else None,
        ]
        for c in candidates:
            if c and os.path.exists(c):
                file_path = c
                break
        if file_path is None:
            raise FileNotFoundError(
                f"PainterAudioUpload: audio file not found in input dir: {audio_filename}"
            )

        import torchaudio  # imported lazily so the node loads even if torchaudio is missing

        try:
            wav, sr = torchaudio.load(str(file_path))
        except Exception as exc:
            try:
                import soundfile as sf
                data, sr = sf.read(str(file_path), always_2d=True)
                wav = torch.from_numpy(data.T).float()
            except Exception as inner:
                raise RuntimeError(
                    f"PainterAudioUpload: failed to decode audio file {file_path}: {exc}"
                ) from inner

        if wav.dim() == 1:
            wav = wav.unsqueeze(0)
        if wav.dim() == 2:
            wav = wav.unsqueeze(0)
        wav = wav.float()

        total_samples = wav.shape[-1]
        if total_samples <= 0:
            raise RuntimeError("PainterAudioUpload: audio file is empty.")

        if trim_end is None or trim_end < 0:
            end_sample = total_samples
        else:
            end_sample = int(round(float(trim_end) * sr))
        start_sample = int(round(float(trim_start) * sr))
        start_sample = max(0, min(start_sample, total_samples - 1))
        end_sample = max(start_sample + 1, min(end_sample, total_samples))

        trimmed = wav[..., start_sample:end_sample]

        return ({"waveform": trimmed, "sample_rate": int(sr)},)

    @classmethod
    def IS_CHANGED(cls, audio_filename="", trim_start=0.0, trim_end=-1.0):
        return f"{audio_filename}|{trim_start}|{trim_end}"


NODE_CLASS_MAPPINGS = {
    "PainterAudioUpload": PainterAudioUpload,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterAudioUpload": "Painter Audio Upload",
}

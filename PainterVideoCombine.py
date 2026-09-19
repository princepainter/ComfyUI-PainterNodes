import os
import subprocess
import urllib.parse
import numpy as np
import folder_paths
import tempfile
import soundfile as sf
from comfy.utils import ProgressBar
import json
from PIL import Image

try:
    import imageio_ffmpeg
    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    ffmpeg_path = "ffmpeg"


class PainterVideoCombine:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE", ),
                "frame_rate": ("FLOAT", {"default": 24, "min": 1, "max": 240, "step": 0.1, "display": "number"}),
                "format": (["video/h264-mp4", "video/webm", "image/gif"],),
                "filename_prefix": ("STRING", {"default": "Video"}),
                "save_workflow_info": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "audio": ("AUDIO",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID"
            }
        }

    RETURN_TYPES = ("INT", "FLOAT")
    RETURN_NAMES = ("frame_count", "frame_rate")
    OUTPUT_NODE = True
    CATEGORY = "Painter/Video"
    FUNCTION = "combine_video"

    def combine_video(self, images, frame_rate, format, filename_prefix="Painter", save_workflow_info=True, audio=None,
                      prompt=None, extra_pnginfo=None, unique_id=None):
        pbar = ProgressBar(len(images))
        output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, images[0].shape[1], images[0].shape[0]
        )

        ext = "mp4" if "mp4" in format else ("webm" if "webm" in format else "gif")
        file_name = f"{filename}_{counter:05}_.{ext}"
        file_path = os.path.join(full_output_folder, file_name)

        abs_output_dir = os.path.abspath(output_dir)
        abs_file_path = os.path.abspath(file_path)
        if not abs_file_path.startswith(abs_output_dir + os.sep) and abs_file_path != abs_output_dir:
            raise ValueError("Output path must be within ComfyUI output directory")

        video_metadata = {}
        if save_workflow_info:
            if prompt is not None:
                video_metadata["prompt"] = json.dumps(prompt)
            if extra_pnginfo is not None:
                for x in extra_pnginfo:
                    video_metadata[x] = extra_pnginfo[x]

        images_np = images.cpu().numpy()
        if not np.isfinite(images_np).all():
            images_np = np.nan_to_num(images_np, nan=0.0, posinf=1.0, neginf=0.0)
        images_np = np.clip(images_np, 0, 1)
        images_np = (images_np * 255).astype(np.uint8)
        n, h, w, c = images_np.shape
        w, h = (w // 2) * 2, (h // 2) * 2

        video_duration = n / frame_rate

        args = [
            ffmpeg_path, "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(frame_rate), "-i", "-"
        ]

        audio_temp_path = None
        audio_duration = 0.0
        if audio is not None:
            try:
                wav_tensor = audio['waveform']
                wav_data = wav_tensor[0].cpu().numpy().transpose() if len(wav_tensor.shape) == 3 else wav_tensor.cpu().numpy().transpose()
                audio_duration = wav_data.shape[0] / audio['sample_rate']

                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_audio:
                    sf.write(temp_audio.name, wav_data, audio['sample_rate'], format='WAV')
                    audio_temp_path = temp_audio.name

                args += ["-i", audio_temp_path]
            except Exception as e:
                print(f"Warning: Audio processing failed: {e}")

        if ext == "mp4":
            args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "faster"]
            if audio_temp_path:
                args += ["-c:a", "aac"]
        elif ext == "webm":
            args += ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0"]
            if audio_temp_path:
                args += ["-c:a", "libvorbis"]
        else:
            args += ["-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"]

        if audio_temp_path:
            # 音轨必须"不短于"画面，否则下面的 -shortest 会把最后一帧画面切掉。
            # video_duration = n / frame_rate 只保留 3 位小数，除不尽时会被截短
            # （例：17 帧 / 24fps = 0.70833 -> atrim 到 0.708），-shortest 就在
            # 0.708s 收尾，最后一帧被丢。多垫一帧再交给 -shortest 裁，画面一帧
            # 不少，音轨长度仍然等于画面长度。
            eps = 1.0 / float(frame_rate)
            safe_duration = video_duration + eps
            if audio_duration < video_duration:
                pad_duration = video_duration - audio_duration + eps
                args += ["-af", f"apad=pad_dur={pad_duration:.6f},"
                                f"atrim=duration={safe_duration:.6f}"]
            else:
                args += ["-af", f"atrim=duration={safe_duration:.6f}"]

            args += ["-shortest"]

        metadata_path = None
        if video_metadata:
            try:
                metadata = json.dumps(video_metadata)
                metadata = metadata.replace("\\", "\\\\")
                metadata = metadata.replace(";", "\\;")
                metadata = metadata.replace("#", "\\#")
                metadata = metadata.replace("=", "\\=")
                metadata = metadata.replace("\n", "\\\n")
                metadata = "comment=" + metadata

                metadata_path = os.path.join(tempfile.gettempdir(), f"painter_metadata_{unique_id}.txt")
                with open(metadata_path, "w", encoding="utf-8") as f:
                    f.write(";FFMETADATA1\n")
                    f.write(metadata)

                args = args[:1] + ["-i", metadata_path] + args[1:] + ["-metadata", "creation_time=now"]
            except Exception as e:
                print(f"Warning: Metadata processing failed: {e}")

        args.append(file_path)

        with tempfile.NamedTemporaryFile(mode='wb', suffix='.raw', delete=False) as temp_video:
            temp_video_path = temp_video.name

            for i, frame in enumerate(images_np):
                temp_video.write(frame[:h, :w, :].tobytes())
                pbar.update(1)

            temp_video.flush()
            os.fsync(temp_video.fileno())

        try:
            with open(temp_video_path, 'rb') as f:
                process = subprocess.Popen(
                    args,
                    stdin=f,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )

                stdout, stderr = process.communicate(timeout=60)

                if process.returncode != 0:
                    error_msg = stderr.decode('utf-8', errors='ignore')
                    raise RuntimeError(f"FFmpeg failed:\n{error_msg}")

            print(f"Video created!: {n} frames, {w}x{h}, {frame_rate}fps -> {file_name}")

        finally:
            if os.path.exists(temp_video_path):
                os.remove(temp_video_path)

            if audio_temp_path and os.path.exists(audio_temp_path):
                os.remove(audio_temp_path)

            if metadata_path and os.path.exists(metadata_path):
                os.remove(metadata_path)

        ui_filename = urllib.parse.quote(file_name, safe='')
        ui_subfolder = urllib.parse.quote(subfolder, safe='') if subfolder else subfolder

        return {
            "ui": {"painter_output": [{"filename": ui_filename, "subfolder": ui_subfolder, "type": "output"}]},
            "result": (int(n), float(frame_rate))
        }


NODE_CLASS_MAPPINGS = {
    "PainterVideoCombine": PainterVideoCombine
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterVideoCombine": "Painter Video Combine"
}

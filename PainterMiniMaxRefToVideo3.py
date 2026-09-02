"""MiniMax H3 Reference to Video node v2 (internal reference image upload).

Prompt + reference images (uploaded internally) / videos / audio -> conditioning + AV latent.
Reference tags: <Picture i> / <Video k> / <Audio j>.
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
import comfy.utils
import node_helpers

from comfy_api.latest import io


REF_CANVAS_MULTIPLE = 32
FPS = 24
AUDIO_LATENT_FPS = 40


DEFAULT_OPT_TEMPLATE = (
    "你是 MiniMax H3 视频生成模型的专业提示词工程师。请把用户手写的简单提示词，重写为 H3 全参考（Ref2VA）六段标准提示词。\n"
    "\n"
    "# 严格输出格式（章节标题必须用以下英文单词独占一行，正文用中文撰写，台词用 <d>[语言] ...</d> 保留原语言）\n"
    "\n"
    "subject_definitions:\n"
    "<Subject 1> 是 <Picture 1> 中的[人物/环境/物体描述]。\n"
    "<Subject 2> 是 <Picture 2> 中的[... ]。\n"
    "... （每个可复用主体一行；参考图只在主体定义里引用，不单列 <Picture N> 行）\n"
    "\n"
    "summary:\n"
    "[reference generation] 一段中文概述目标视频的镜头流程、出现的主体，以及参考图/参考视频/参考音频如何被使用。\n"
    "\n"
    "retention_analysis:\n"
    "<Subject 1> (appears in [Shot 1]): fully_preserved - 保留哪些外观特征。\n"
    "<Subject 2> (appears in [Shot 2]): partially_preserved - 哪些特征被改动。\n"
    "... （每个 <Subject N> 一行，使用 fully_preserved / partially_preserved / attribute_transfer / weak_reference 之一）\n"
    "\n"
    "detailed_description:\n"
    "[Shot 1] 用一两句话给出整体视觉风格（电影写实 / 中国古风 / 3D 等）与首帧构图。\n"
    "[Shot 1] 中全景建立[环境]。<Subject 1> ...，<Subject 2> ...。镜头/动作/声音/对白...\n"
    "[Shot 2] At 00:02.000, 切到[运镜]。<Subject ...> ...。\n"
    "... （按播放顺序逐镜头；每个镜头覆盖：构图、主体外貌与位置、环境光照、动作与状态变化、运镜、声音、对白；生成类约 350-500 中文字）\n"
    "\n"
    "overall_soundscape:\n"
    "概括全片环境声与物理音效（风声、脚步声、器物碰撞等）。\n"
    "\n"
    "non_diegetic_music:\n"
    "描述仅观众可闻的背景音乐（乐器/节奏/起伏）。用户明确说不要音乐/不要 BGM 时，输出 N/A。\n"
    "\n"
    "# 标签与标记规则\n"
    "- <Subject N>：可复用主体（人物/环境/服装/道具/风格）。\n"
    "- <Picture N>：仅当参考图本身作为某个镜头的首帧/关键帧/尾帧时才单列；否则只在主体定义里引用。\n"
    "- <Video N>：当参考视频作为编辑源或时间结构来源时使用。\n"
    "- <Audio N>：当参考音频被直接复制或音色被引用时使用。\n"
    "- 对白/歌词必须用 <d>[原始语言] ...</d> 包裹，例如 <d>[中文] 你好。</d>。\n"
    "- 镜头格式：[Shot 1] 无时间戳；[Shot 2] At MM:SS.mmm（两位小数）。\n"
    "- 说话人编号：(S1) (S2) 按目标视频中实际发声顺序编号，同一说话人跨镜头复用同一编号。\n"
    "\n"
    "# retention_analysis 关系标记（固定英文）\n"
    "- fully_preserved 完全保留\n"
    "- partially_preserved 部分保留\n"
    "- attribute_transfer 属性转移到另一主体\n"
    "- weak_reference 仅保留风格/氛围相似\n"
    "\n"
    "# 必须遵守\n"
    "- 严格保留用户原始意图：目标时长、镜头切换、台词内容、无音乐/无字幕要求。\n"
    "- 节点内有参考图时，仔细观察并在 subject_definitions 与 detailed_description 中描述锁定的外观细节（身份、面容、发型、服装、道具、场景），并在 retention_analysis 中标 fully_preserved。\n"
    "- 节点外有参考视频/音频时，将它们的角色与内容纳入重写（这些外部媒体的画面/声音会出现在最终视频里）。\n"
    "- 只输出重写后的提示词正文，不要前言、不要解释、不要 markdown 标题/加粗/列表符号（**、##、###、---、-、* 全部禁用）。所有章节标题就是上面那六个英文单词独占一行。\n"
)


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

    # NOTE: "input" is NOT registered in folder_names_and_paths, so
    # folder_paths.get_full_path("input", ...) always returns None.
    # Use get_input_directory() directly instead.
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


class PainterMiniMaxRefToVideo3(io.ComfyNode):
    """ref2va v3: prompt + internally uploaded reference images / external videos / audio -> conditioning + AV latent.
    Adds a button-driven prompt-optimizer (Ollama HTTP API) and an "original prompt" view."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PainterMiniMaxRefToVideo3",
            description="Reference conditioning for MiniMax H3 (v3: internal image upload + button-driven prompt optimizer). Use <Picture i> / <Video k> / <Audio j> tags when prompting.",
            display_name="Painter MiniMax Ref To Video 3",
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
                io.Boolean.Input(
                    "enable_prompt_optimize",
                    default=True,
                    tooltip="显示提示词优化选项。开启后下方显示模型/接口/模板等设置；关闭则隐藏下方选项保持节点简洁。提示词优化始终可用——点击提示词编辑器右下角的 ✦ 按钮即可触发 Ollama 优化，无需先打开本开关。",
                ),
                io.String.Input(
                    "opt_model",
                    default="qwen3.8-27b:latest",
                    tooltip="用于优化提示词的 Ollama 模型名（需已 pull，支持 vision）。",
                ),
                io.String.Input(
                    "opt_api_url",
                    default="http://127.0.0.1:11434",
                    tooltip="Ollama HTTP API 根地址，自动追加 /api/chat。",
                ),
                io.Int.Input(
                    "opt_max_length",
                    default=1024,
                    min=64,
                    max=8192,
                    step=64,
                    tooltip="优化提示词最大生成 token 数（num_predict）。",
                ),
                io.String.Input(
                    "opt_template",
                    multiline=True,
                    default=DEFAULT_OPT_TEMPLATE,
                    tooltip="发给 Ollama 的 system 提示词（按 h3 skill 重写为 ref2va 六段格式）。可按需修改。",
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
        ref_image_files="[]",
        ref_videos=None,
        ref_video_audios=None,
        ref_audios=None,
        enable_prompt_optimize=False,
        opt_model="qwen3.8-27b:latest",
        opt_api_url="http://127.0.0.1:11434",
        opt_max_length=1024,
        opt_template=DEFAULT_OPT_TEMPLATE,
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

        # --- External reference videos ---
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

        tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
        cond = clip.encode_from_tokens_scheduled(tokens)

        if ref_blocks:
            cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": ref_blocks})

        return io.NodeOutput(cond, latent, width, height, length, prompt)


NODE_CLASS_MAPPINGS = {
    "PainterMiniMaxRefToVideo3": PainterMiniMaxRefToVideo3
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterMiniMaxRefToVideo3": "Painter MiniMax Ref To Video 3"
}


# ============================================================================
# /painter/optimize_prompt — Ollama prompt-optimizer route
# ============================================================================

import asyncio as _asyncio
import base64
import io as _io
import json as _json
import threading as _threading
import urllib.error as _urllib_error
import urllib.request as _urllib_request
from concurrent.futures import ThreadPoolExecutor as _ThreadPoolExecutor

from PIL import Image as _PILImage


_OPT_IMAGE_MAX_SIDE = 1280
_OPT_IMAGE_QUALITY = 88


def _opt_image_to_base64(file_info):
    """Load an uploaded ref-image and return (base64, mime) or (None, None)."""
    if not isinstance(file_info, dict):
        return None, None
    filename = file_info.get("filename", "")
    if not filename:
        return None, None
    subfolder = file_info.get("subfolder", "")
    file_type = file_info.get("type", "input")

    image_path = None
    if file_type == "input":
        base_dir = folder_paths.get_input_directory()
        image_path = os.path.join(base_dir, subfolder, filename) if subfolder else os.path.join(base_dir, filename)
    else:
        full_name = os.path.join(subfolder, filename) if subfolder else filename
        image_path = folder_paths.get_full_path(file_type, full_name)

    if not image_path or not os.path.isfile(image_path):
        return None, None

    try:
        img = _PILImage.open(image_path)
        img = ImageOps.exif_transpose(img).convert("RGB")
        w, h = img.size
        longest = max(w, h)
        if longest > _OPT_IMAGE_MAX_SIDE:
            scale = _OPT_IMAGE_MAX_SIDE / float(longest)
            new_w = max(8, int(round(w * scale)))
            new_h = max(8, int(round(h * scale)))
            img = img.resize((new_w, new_h), _PILImage.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=_OPT_IMAGE_QUALITY)
        return base64.b64encode(buf.getvalue()).decode("ascii"), "image/jpeg"
    except Exception:
        return None, None


def _opt_call_ollama(api_url, model, template, prompt, images_b64, max_length, timeout=180):
    """Call Ollama /api/chat with vision images + system template. Returns the assistant text."""
    base = (api_url or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("Ollama API URL is empty")
    url = base + "/api/chat"

    user_msg = {"role": "user", "content": prompt or ""}
    if images_b64:
        user_msg["images"] = images_b64

    payload = {
        "model": model or "qwen3.8-27b:latest",
        "messages": [
            {"role": "system", "content": template or ""},
            user_msg,
        ],
        "stream": False,
        "think": False,
        "options": {
            "num_predict": int(max_length),
            "temperature": 0.4,
            "num_ctx": 8192,
        },
    }

    req = _urllib_request.Request(
        url,
        data=_json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with _urllib_request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    data = _json.loads(raw)

    if isinstance(data, dict) and isinstance(data.get("message"), dict):
        content = data["message"].get("content", "")
        if isinstance(content, str):
            text = content
        else:
            text = "".join(
                item.get("text", "") for item in content if isinstance(item, dict)
            )
        text = text.strip()
        if text:
            return text

    raise RuntimeError("Ollama returned an empty response")


def _ollama_list_loaded(api_url, timeout=10):
    """Return the set of model names currently loaded in Ollama (via /api/ps)."""
    base = (api_url or "").strip().rstrip("/")
    if not base:
        return set()
    url = base + "/api/ps"
    try:
        req = _urllib_request.Request(url)
        with _urllib_request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        data = _json.loads(raw)
    except Exception:
        return set()
    names = set()
    if isinstance(data, dict):
        for m in data.get("models", []) or []:
            if not isinstance(m, dict):
                continue
            for key in ("name", "model"):
                v = m.get(key)
                if isinstance(v, str) and v:
                    names.add(v.strip())
    return names


def _ollama_unload(api_url, model, timeout=60):
    """Unload a model from Ollama by issuing a minimal generate with keep_alive=0.

    keep_alive=0 tells Ollama to drop the model from memory as soon as the
    request finishes. A 1-token generate is the smallest request that reliably
    triggers the keep-alive teardown path.
    """
    base = (api_url or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("Ollama API URL is empty")
    url = base + "/api/generate"
    payload = {
        "model": model or "qwen3.8-27b:latest",
        "prompt": " ",
        "stream": False,
        "keep_alive": 0,
        "options": {"num_predict": 1},
    }
    req = _urllib_request.Request(
        url,
        data=_json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with _urllib_request.urlopen(req, timeout=timeout) as resp:
        resp.read()


def _register_optimizer_route():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False

    routes = getattr(getattr(PromptServer, "instance", None), "routes", None)
    if routes is None:
        return False
    if getattr(_register_optimizer_route, "_registered", False):
        return True

    executor = _ThreadPoolExecutor(max_workers=2, thread_name_prefix="painter-optimizer")

    @routes.post("/painter/optimize_prompt")
    async def _optimize(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

        prompt = str(payload.get("prompt") or "")
        template = str(payload.get("template") or "")
        model = str(payload.get("model") or "qwen3.8-27b:latest").strip()
        api_url = str(payload.get("api_url") or "http://127.0.0.1:11434").strip()
        try:
            max_length = max(64, min(8192, int(payload.get("max_length") or 1024)))
        except Exception:
            max_length = 1024
        raw_images = payload.get("images") if isinstance(payload.get("images"), list) else []

        # External ref-media (videos / audios wired into the node) — send a
        # text summary to qwen so it knows external sources are available,
        # even when we cannot embed their bytes here.
        external_summary = str(payload.get("external_media_summary") or "").strip()
        if external_summary:
            prompt = (prompt + "\n\n" + external_summary).strip()

        if not prompt.strip():
            return web.json_response({"ok": False, "error": "Prompt is empty"}, status=400)

        # 点 ✦ 优化时，先把 ComfyUI 已加载模型从显存卸载，给 Ollama 腾空间，
        # 避免 Ollama 加载 qwen 时爆显存。
        try:
            comfy.model_management.unload_all_models()
            comfy.model_management.soft_empty_cache(force=True)
        except Exception:
            pass

        images_b64 = []
        seen = set()
        for item in raw_images[:9]:
            b64 = None
            if isinstance(item, dict):
                inline = item.get("base64")
                if isinstance(inline, str) and inline:
                    b64 = inline
                else:
                    b64, _mime = _opt_image_to_base64(item)
                    if b64:
                        key = (item.get("filename", ""), item.get("subfolder", ""))
                        if key in seen:
                            continue
                        seen.add(key)
            if b64:
                images_b64.append(b64)

        try:
            loop = _asyncio.get_event_loop()
            text = await loop.run_in_executor(
                executor,
                _opt_call_ollama,
                api_url,
                model,
                template,
                prompt,
                images_b64,
                max_length,
            )
            # 优化完成，立即把 Ollama 模型从显存卸载，把显存还给后续 ComfyUI 工作流。
            try:
                await loop.run_in_executor(executor, _ollama_unload, api_url, model)
            except Exception:
                pass
            return web.json_response({"ok": True, "prompt": text})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)[:1000]}, status=500)

    @routes.post("/painter/unload_ollama")
    async def _unload(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        model = str(payload.get("model") or "qwen3.8-27b:latest").strip()
        api_url = str(payload.get("api_url") or "http://127.0.0.1:11434").strip()
        try:
            loaded = _ollama_list_loaded(api_url)
            if model in loaded:
                loop = _asyncio.get_event_loop()
                await loop.run_in_executor(executor, _ollama_unload, api_url, model)
                return web.json_response({"ok": True, "unloaded": True, "model": model})
            return web.json_response({"ok": True, "unloaded": False, "model": model})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)[:1000]}, status=500)

    _register_optimizer_route._registered = True
    return True


def _wait_for_optimizer_route_ready():
    if _register_optimizer_route():
        return
    for _ in range(2400):
        if _register_optimizer_route():
            return
        _threading.Event().wait(0.05)


try:
    _register_optimizer_route()
except Exception:
    pass

_threading.Thread(target=_wait_for_optimizer_route_ready, daemon=True, name="PainterOptimizeRoute").start()

import math

import torch
from typing_extensions import override

import comfy.model_management
import comfy.utils
import node_helpers
from comfy_api.latest import ComfyExtension, io


# Qwen Image 2.1 latent: 64 通道 / 16 倍空间下采样（comfy.latent_formats.QwenImage21）
LATENT_CHANNELS = 64
LATENT_SCALE = 16
# 视觉塔 1 个 token = 32px = 2x2 个 latent 网格，所以所有尺寸都对齐到 32 的倍数
ALIGN = 32


def _align32(value):
    return max(ALIGN, round(value / ALIGN) * ALIGN)


def _zero_out(conditioning):
    """负向条件：文本 embedding 与 pooled 置零，其余附加项（reference_latents / image_slots / attention_mask）原样保留。

    这样负向分支与正向分支的序列结构完全一致，CFG 的差异只落在文本上。
    """
    out = []
    for t in conditioning:
        d = t[1].copy()
        # Qwen 的 pooled_output 可能带键但值为 None，不能直接 zeros_like
        pooled = d.get("pooled_output", None)
        if pooled is not None:
            d["pooled_output"] = torch.zeros_like(pooled)
        out.append([torch.zeros_like(t[0]), d])
    return out


class PainterQwenImage21(io.ComfyNode):
    """Qwen Image 2.1 编辑节点。

    一次输出 positive / negative / latent：
    - 参考图缩放一次、两路复用：视觉塔拿白底合成后的 RGB，VAE 拿原图（保留 alpha）
    - 所有参考图等比缩放到与输出画布同量级的面积（32 对齐、绝不裁剪），
      因此竖屏参考图也能输出横屏画布而不会丢内容（裁切会让模型认不出参考对象）
    - 输出尺寸由 width / height 独立控制，与参考图比例无关（替代官方的 resolution 参数）
    - 负向条件由正向条件零化得到，无需负向提示词输入
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PainterQwenImage21",
            display_name="Painter Qwen Image 2.1",
            category="advanced/conditioning",
            description=(
                "Qwen Image 2.1 编辑条件节点：输出 positive / negative / latent。"
                "参考图同时供文本编码器的视觉塔与 VAE 使用，负向条件由正向条件零化得到，"
                "无需输入负向提示词。输出尺寸由 width / height 精确控制（32 倍数对齐）。"
            ),
            inputs=[
                io.Clip.Input("clip"),
                io.Vae.Input(
                    "vae",
                    tooltip="Qwen Image 2.1 专用 VAE（64 通道 / 16 倍下采样）。参考图会以 latent 形式拼进 DiT 序列，"
                            "编辑保真度最高。注意：不是旧版 qwen_image_vae（那种 16 通道的属于 2509/2511/2512）。",
                ),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Autogrow.Input(
                    "images",
                    template=io.Autogrow.TemplateNames(
                        io.Image.Input("image"),
                        names=[f"image_{i}" for i in range(1, 17)],
                        min=0,
                    ),
                    tooltip="参考图，最多 16 张。每张都等比缩放到与输出画布同量级的面积，绝不裁剪（裁掉内容模型就认不出参考对象了），"
                            "所以竖屏参考图也能输出横屏画面。每张图只取第 1 帧。",
                ),
                io.Int.Input(
                    "width", default=1024, min=32, max=4096, step=32,
                    tooltip="输出宽度，必须是 32 的倍数（视觉塔 1 个 token = 2x2 个 latent 网格，非 32 倍数会破坏像素对齐）。"
                            "与参考图比例无关：参考图只等比缩放、不裁剪。",
                ),
                io.Int.Input(
                    "height", default=1024, min=32, max=4096, step=32,
                    tooltip="输出高度，必须是 32 的倍数。与参考图比例无关：参考图只等比缩放、不裁剪。",
                ),
                io.Int.Input("batch_size", default=1, min=1, max=64),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(
                    display_name="latent",
                    tooltip="width x height / 16 的空白 latent，与参考图网格对齐，直接接采样器，不要换成别的尺寸。",
                ),
            ],
        )

    @classmethod
    def execute(cls, clip, vae=None, prompt="", images=None, width=1024, height=1024, batch_size=1) -> io.NodeOutput:
        images = images or {}
        ref_latents = []
        images_vl = []

        def _order(name):
            try:
                return int(name.rsplit("_", 1)[-1])
            except (ValueError, IndexError):
                return 0

        names = [n for n in sorted(images, key=_order) if images[n] is not None]

        target_w = _align32(width) if width > 0 else 0
        target_h = _align32(height) if height > 0 else 0
        area = 0

        for i, name in enumerate(names):
            image = images[name][:1]  # 每张参考图只取第 1 帧
            samples = image.movedim(-1, 1)
            src_w, src_h = samples.shape[3], samples.shape[2]

            if i == 0:
                # width / height 没给值时跟随第 1 张参考图的尺寸
                if target_w <= 0 or target_h <= 0:
                    target_w, target_h = _align32(src_w), _align32(src_h)
                area = target_w * target_h

            # 所有参考图一视同仁：等比缩放到与输出画布同量级的面积，绝不裁剪（裁掉内容模型就认不出来了）。
            # 面积基准取 target_w x target_h 而不是 max(w, h)^2 —— 后者会把竖图放大到超过画布面积，
            # 参考图 token 反而比目标还多，白白拖慢采样。
            ratio = src_w / src_h
            out_w = _align32(math.sqrt(area * ratio))
            out_h = _align32(math.sqrt(area / ratio))

            if (out_w, out_h) == (src_w, src_h):
                s = image
            else:
                s = comfy.utils.common_upscale(samples, out_w, out_h, "lanczos", "disabled").movedim(1, -1)

            rgb = s[:, :, :, :3]
            if s.shape[-1] > 3:
                # 视觉塔看白底合成后的图，alpha 信息由 VAE 那一路保留
                alpha = s[:, :, :, 3:]
                rgb = rgb * alpha + (1.0 - alpha)
            images_vl.append(rgb)
            if vae is not None:
                ref_latents.append(vae.encode(s))

        if target_w <= 0 or target_h <= 0:
            target_w, target_h = 1024, 1024

        # 接了 VAE：视觉占位 token 由文本编码器删除并记录 image_slots，图像改由 DiT 内的 latent 拼接提供；
        # 没接 VAE：保留视觉 token，图像只通过文本编码器条件
        keep_vision = len(ref_latents) == 0
        positive = clip.encode_from_tokens_scheduled(
            clip.tokenize(prompt, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)
        )
        negative = _zero_out(positive)

        if len(ref_latents) > 0:
            positive = node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True)
            negative = node_helpers.conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True)

        latent = torch.zeros(
            [batch_size, LATENT_CHANNELS, target_h // LATENT_SCALE, target_w // LATENT_SCALE],
            device=comfy.model_management.intermediate_device(),
        )
        return io.NodeOutput(positive, negative, {"samples": latent})


class PainterQwenExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            PainterQwenImage21,
        ]


async def comfy_entrypoint() -> PainterQwenExtension:
    return PainterQwenExtension()


NODE_CLASS_MAPPINGS = {
    "PainterQwenImage21": PainterQwenImage21
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterQwenImage21": "Painter Qwen Image 2.1"
}

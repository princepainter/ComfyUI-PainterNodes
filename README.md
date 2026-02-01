

<a name="中文"></a>
## 本节点包由 绘画小子 制作

### 📖 简介

## **Painter Nodes** 是一个为 ComfyUI 设计的综合性自定义节点合集，专为高级图像和视频生成工作流打造。本插件目前包集成了 24 个强大的节点（后续新增节点都会放进此整合包），涵盖图生视频、文生图、图片编辑、音频驱动视频生成、提示词管理、显存优化等功能。

## ✨更新动态：
 2026-2-1更新：
 
 新增PainterS2Vplus节点：实现WAN2.2-S2V模型视频对口型

-----------------------------------------

### ✨ 功能特性

| 类别 | 节点 | 说明 |
|------|------|------|
| **提示词** | PainterPrompt | 多提示词管理，支持列表 |
| **图生视频** | PainterI2V, PainterI2VAdvanced | Wan2.2 图生视频，修复慢动作问题 |
| **音频驱动** | PainterAI2V, PainterAV2V | 音频驱动视频生成 (InfiniteTalk) |
| **采样器** | PainterSampler, PainterSamplerLTXV | 高级双模型和 LTXV 采样器 |
| **LTXV** | PainterLTX2V, PainterLTX2VPlus | LTXV 潜空间生成，支持帧控制 |
| **帧生成视频** | PainterFLF2V, PainterMultiF2V, PainterLongVideo | 首尾帧/多帧/长视频生成 |
| **图像编辑** | PainterFluxImageEdit, PainterQwenImageEditPlus | Flux/Qwen 图像编辑，动态输入 |
| **显存管理** | PainterVRAM | GPU 显存管理工具 |
| **视频处理** | PainterVideoCombine, PainterVideoUpscale, PainterVideoInfo | 视频处理工具 |
| **图像工具** | PainterFrameCount, PainterImageLoad, PainterImageFromBatch, PainterCombineFromBatch | 图像工具集 |
| **音频工具** | PainterAudioLength, PainterAudioCut | 音频处理工具 |

### 🚀 安装方法

#### 方法 1：手动安装

1. 从 Releases 页面下载最新版本
2. 将 `Painter-Nodes` 文件夹解压到 ComfyUI 的 custom_nodes 目录：
   ```
   ComfyUI/
   └── custom_nodes/
       └── Painter-Nodes/
         
   ```

3. 安装依赖：
   ```bash
   cd ComfyUI/custom_nodes/Painter-Nodes
   pip install -r requirements.txt
   ```

4. 重启 ComfyUI

#### 方法 2：ComfyUI-Manager（即将推出）

在 ComfyUI-Manager 中搜索 "Painter Nodes" 直接安装。

### 📋 环境要求

```
soundfile>=0.12.1
numpy>=1.21.0
```

### 🎯 使用方法

每个节点的介绍可以去看我主页该节点单独页面。很简单，自己尝试尝试。如果对你有用，请给我点一颗星星，多谢🙏

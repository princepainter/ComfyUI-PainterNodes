

<a name="中文"></a>
## 本节点包由 绘画小子 制作

此节点包中的部分节点参考了comfy官方节点部分代码以及kijai和VHS节点的部分代码，在此表示感谢🙏 此节点包完全开源免费使用

### 📖 简介

## **Painter Nodes** 是一个为 ComfyUI 设计的综合性自定义节点合集，专为高级图像和视频生成工作流打造。本插件目前包集成了多个强大的节点（后续新增节点都会放进此整合包），涵盖图生视频、文生视频，视频编辑，视频配音，参考生视频，文生图、图片编辑、音频驱动视频生成、视频对口型等功能。

## ✨更新日志：


 2026-8-13更新

 新增优化版MiniMaxRefToVideo2节点，参考图全部节点内部上传，更直观清晰。参考音频和视频用的情况不多，依然从外部输入。其他用法相同：可以对提示词按minimax H3官方skill进行格式化，效果很不错！使用方法示例：选择素材直接@：@图片1 @音频1 @视频1   第3.5秒开始切镜：切镜3.5+空格   台词：【台词内容】+空格 
 
<img width="1439" height="1559" alt="image" src="https://github.com/user-attachments/assets/9a3531eb-79c3-4781-8a68-333108f1f311" />

 2026-8-9更新

 新增优化版MiniMaxRefToVideo节点，可以对提示词按minimax H3官方skill进行格式化，效果很不错！使用方法示例：选择素材直接@：@图片1 @音频1 @视频1   第3.5秒开始切镜：切镜3.5+空格   台词：【台词内容】+空格 
 
<img width="2190" height="1473" alt="image" src="https://github.com/user-attachments/assets/d29ad9e0-b30f-4f93-ac2d-e0e0ed643af0" />









 2026-7-8更新

 新增PainterLTX2Vomni节点，可以对bernini生成的无声视频进行配音对口型，效果非常不错！值得尝试！节点同时支持文生视频，图生视频，首尾帧生视频，参考生视频等多种任务（相关工作流见项目下workflows文件夹）

 2026-7-2更新
 
 新增PainterV2AV节点，可以用ltx2.3对wan2.2生成的无声视频进行高清+配音，wan2.2的动态，LTX2.3生声音，结合两者优点，等于给wan2.2插上翅膀，音画同出，速度很快，效果不错，值得尝试。（相关工作流见项目下workflows文件夹）

 2026-2-10更新

 新增PainterHumoAI2V节点，实现wan2.2+Humo 音频驱动图生视频，音频驱动图生首尾帧视频 以及 音频驱动文生视频（把图片接入断开，同时将高燥模型和lora更换为WAN2.2 T2V 高燥模型和lora即是文生有声视频），可自定义音频说话帧率（建议16~30）效果不错，建议尝试（相关工作流见项目下workflows文件夹）

 2026-2-9更新
 
新增PainterHumoAV2V节点，实现Humo模型2步采样进行视频对口型功能，可自定义音频说话帧率（建议16~30），效果不错，建议尝试（工作流见项目下workflows文件夹）

 
 2026-2-1更新：
 
 新增PainterS2Vplus节点：实现WAN2.2-S2V模型视频2步采样对口型功能，比infinitetalk更快速度视频对口型（工作流见项目下workflows文件夹）

 2026-1-31更新：
 
 升级PainterQwenImageEdit节点： 支持自定义编辑图片数量，最多10图编辑，支持文生图，支持遮罩编辑，编辑图片像素无偏移，支持批次设定

 2026-1-30更新：
 
升级PainterFluxImageEdit节点： 支持自定义编辑图片数量，最多10图编辑，支持文生图，支持遮罩编辑，编辑图片像素无偏移，支持批次设定（支持QWEN edit模型）
 
 
 
-----------------------------------------

### ✨ 功能特性

请自行探索

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

#### 方法 2：ComfyUI-Manager

在 ComfyUI-Manager 中搜索 "PainterNodes" 直接安装。

### 📋 环境要求

```
soundfile>=0.12.1
numpy>=1.21.0
```

### 🎯 使用方法

每个节点的介绍可以去看我主页该节点单独页面。很简单，自己尝试尝试。如果对你有用，请给我点一颗星星，多谢🙏

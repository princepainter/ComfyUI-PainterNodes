NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

def _register_module(module):
    NODE_CLASS_MAPPINGS.update(getattr(module, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}))

try:
    from . import PainterPrompt
    _register_module(PainterPrompt)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterPrompt: {e}")

try:
    from . import PainterI2V
    _register_module(PainterI2V)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterI2V: {e}")

try:
    from . import PainterI2VAdvanced
    _register_module(PainterI2VAdvanced)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterI2VAdvanced: {e}")

try:
    from . import PainterAI2V
    _register_module(PainterAI2V)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterAI2V: {e}")

try:
    from . import PainterAV2V
    _register_module(PainterAV2V)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterAV2V: {e}")

try:
    from . import PainterVideoCombine
    _register_module(PainterVideoCombine)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterVideoCombine: {e}")

try:
    from . import PainterVideoInfo
    _register_module(PainterVideoInfo)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterVideoInfo: {e}")

try:
    from . import PainterVideoUpscale
    _register_module(PainterVideoUpscale)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterVideoUpscale: {e}")

try:
    from . import PainterVRAM
    _register_module(PainterVRAM)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterVRAM: {e}")

try:
    from . import PainterStringCleaner
    _register_module(PainterStringCleaner)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterStringCleaner: {e}")

try:
    from . import PainterFrameRateConverter
    _register_module(PainterFrameRateConverter)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterFrameRateConverter: {e}")

try:
    from . import PainterFrameExtractor
    _register_module(PainterFrameExtractor)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterFrameExtractor: {e}")

try:
    from . import PainterLTX2Vomni
    _register_module(PainterLTX2Vomni)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterLTX2Vomni: {e}")

try:
    from . import PainterLTXomni2
    _register_module(PainterLTXomni2)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterLTXomni2: {e}")

try:
    from . import PainterV2AV
    _register_module(PainterV2AV)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterV2AV: {e}")

try:
    from . import PainterImageConcat
    _register_module(PainterImageConcat)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterImageConcat: {e}")

try:
    from . import PainterResizeImages
    _register_module(PainterResizeImages)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterResizeImages: {e}")

try:
    from . import PainterFluxImageEdit
    _register_module(PainterFluxImageEdit)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterFluxImageEdit: {e}")

try:
    from . import PainterQwenImageEdit
    _register_module(PainterQwenImageEdit)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterQwenImageEdit: {e}")

try:
    from . import PainterAudioCut
    _register_module(PainterAudioCut)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterAudioCut: {e}")

try:
    from . import PainterBerniniUpscale
    _register_module(PainterBerniniUpscale)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterBerniniUpscale: {e}")

try:
    from . import PainterCombineFromBatch
    _register_module(PainterCombineFromBatch)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterCombineFromBatch: {e}")

try:
    from . import PainterFLF2V
    _register_module(PainterFLF2V)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterFLF2V: {e}")

try:
    from . import PainterHumoAI2V
    _register_module(PainterHumoAI2V)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterHumoAI2V: {e}")

try:
    from . import PainterHumoAV2V
    _register_module(PainterHumoAV2V)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterHumoAV2V: {e}")

try:
    from . import PainterImageFromBatch
    _register_module(PainterImageFromBatch)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterImageFromBatch: {e}")

try:
    from . import PainterLongVideo
    _register_module(PainterLongVideo)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterLongVideo: {e}")

try:
    from . import PainterS2Vplus
    _register_module(PainterS2Vplus)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterS2Vplus: {e}")

try:
    from . import PainterTextOverlay
    _register_module(PainterTextOverlay)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterTextOverlay: {e}")

try:
    from . import PainterMiniMaxRefToVideo
    _register_module(PainterMiniMaxRefToVideo)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterMiniMaxRefToVideo: {e}")

try:
    from . import PainterMiniMaxRefToVideo2
    _register_module(PainterMiniMaxRefToVideo2)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterMiniMaxRefToVideo2: {e}")


try:
    from . import PainterMinimaxH3LatentUpscaler
    _register_module(PainterMinimaxH3LatentUpscaler)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterMinimaxH3LatentUpscaler: {e}")

try:
    from . import MiniMaxH3Turbo
    _register_module(MiniMaxH3Turbo)
except Exception as e:
    print(f"[PainterNodes] Failed to import MiniMaxH3Turbo: {e}")

try:
    from . import PainterPromptRewriter
    _register_module(PainterPromptRewriter)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterPromptRewriter: {e}")

try:
    from . import PainterAudioUpload
    _register_module(PainterAudioUpload)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterAudioUpload: {e}")

print(f"\033[92m[PainterNodes] Loaded {len(NODE_CLASS_MAPPINGS)} nodes successfully!\033[0m")

__version__ = "1.4.0"
WEB_DIRECTORY = "./web/js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]

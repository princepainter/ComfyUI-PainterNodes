NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

def _register_module(module):
    NODE_CLASS_MAPPINGS.update(getattr(module, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}))

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
    from . import PainterVRAM
    _register_module(PainterVRAM)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterVRAM: {e}")

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
    from . import PainterFLF2V
    _register_module(PainterFLF2V)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterFLF2V: {e}")

try:
    from . import PainterImageFromBatch
    _register_module(PainterImageFromBatch)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterImageFromBatch: {e}")

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
    from . import PainterMiniMaxRefToVideo3
    _register_module(PainterMiniMaxRefToVideo3)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterMiniMaxRefToVideo3: {e}")

try:
    from . import PainterMiniMaxRefToVideo6
    _register_module(PainterMiniMaxRefToVideo6)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterMiniMaxRefToVideo6: {e}")

try:
    from . import PainterMinimaxH3LatentUpscaler
    _register_module(PainterMinimaxH3LatentUpscaler)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterMinimaxH3LatentUpscaler: {e}")

try:
    from . import PainterAudioUpload
    _register_module(PainterAudioUpload)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterAudioUpload: {e}")

try:
    from . import PainterAudioMask
    _register_module(PainterAudioMask)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterAudioMask: {e}")

try:
    from . import PainterSigmasGraph
    _register_module(PainterSigmasGraph)
except Exception as e:
    print(f"[PainterNodes] Failed to import PainterSigmasGraph: {e}")



print(f"\033[92m[PainterNodes] Loaded {len(NODE_CLASS_MAPPINGS)} nodes successfully!\033[0m")

__version__ = "1.4.2"
WEB_DIRECTORY = "./web/js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]

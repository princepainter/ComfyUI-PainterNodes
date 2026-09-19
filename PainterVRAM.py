"""PainterVRAM - tune ComfyUI's extra VRAM reservation at runtime.

Two modes:
  manual - reserve exactly the given GB value.
  auto   - measure what the GPU is currently using and reserve that plus the
           given GB on top, so ComfyUI stops trying to occupy the whole card.

Auto mode needs a way to read GPU memory. NVML (pynvml) is preferred, with a
torch fallback so the node still works on machines where NVML is unavailable.

Measurement has to happen *after* the optional cleanup below, otherwise
ComfyUI's own loaded models get folded into the "already in use" figure and the
resulting reservation ends up far too large.
"""

import gc
import random

from comfy import model_management

GB = 1024 ** 3
LOG = "[PainterVRAM]"

# Private RNG so the refresh jitter never disturbs the global random stream.
_jitter = random.Random()


# ------------------------------------------------------------------ probing --

_nvml = None
_nvml_error = "not probed"


def _probe_nvml():
    """Import and initialise NVML, tolerating every failure mode.

    Catching only ImportError is not enough here: a missing or mismatched
    driver DLL can surface as OSError during import, and on a machine without
    an NVIDIA card nvmlInit() raises its own error type. Either one would take
    the whole node pack down at load time, so both steps stay guarded.
    """
    global _nvml, _nvml_error
    try:
        import pynvml
    except Exception as exc:
        _nvml_error = "import failed (%s)" % exc
        return
    try:
        pynvml.nvmlInit()
    except Exception as exc:
        _nvml_error = "nvmlInit failed (%s)" % exc
        return
    _nvml = pynvml
    _nvml_error = None


_probe_nvml()


def _read_gpu_mem():
    """Return (total_gb, used_gb) for device 0, or (None, None) when unknown."""
    if _nvml is not None:
        try:
            handle = _nvml.nvmlDeviceGetHandleByIndex(0)
            info = _nvml.nvmlDeviceGetMemoryInfo(handle)
            return info.total / GB, info.used / GB
        except Exception as exc:
            print("%s NVML query failed (%s), trying torch" % (LOG, exc))

    try:
        import torch
        free, total = torch.cuda.mem_get_info()
        return total / GB, (total - free) / GB
    except Exception as exc:
        print("%s no GPU memory source available (%s)" % (LOG, exc))
        return None, None


# ------------------------------------------------------------------ writing --

def _write_reserved(gb):
    """Push the reservation into ComfyUI, and into DynamicVRAM when active.

    model_management.extra_reserved_memory() re-reads the module global on
    every call, so a plain assignment covers the classic budget and is the one
    path with unambiguous units (bytes).

    DynamicVRAM is the catch: it keeps its own headroom inside comfy-aimdo and
    never looks at that global, so the assignment alone has no visible effect
    while it is enabled. The comfy-aimdo value is in bytes too, and feeding
    both is what ComfyUI itself does with --reserve-vram at boot.
    """
    reserved_bytes = int(max(0.0, gb) * GB)
    model_management.EXTRA_RESERVED_VRAM = reserved_bytes

    try:
        from comfy import memory_management as comfy_mm
        if not getattr(comfy_mm, "aimdo_enabled", False):
            return

        import comfy_aimdo.control as aimdo
        if getattr(aimdo, "lib", None) is None:
            return

        aimdo.set_simple_vram_headroom(reserved_bytes)
        print("%s DynamicVRAM headroom synced" % LOG)
    except Exception as exc:
        # EXTRA_RESERVED_VRAM is already written, so this is not fatal.
        print("%s DynamicVRAM headroom not synced (%s)" % (LOG, exc))


def _resolve_reserved(reserved, mode, auto_max):
    """Turn the widget values into the GB figure that will actually be reserved."""
    if mode != "auto":
        gb = max(0.0, reserved)
        print("%s manual reservation: %.2f GB" % (LOG, gb))
        return gb

    total, used = _read_gpu_mem()
    if total is None:
        gb = max(0.0, reserved)
        print("%s auto unavailable, falling back to %.2f GB" % (LOG, gb))
        return gb

    gb = max(0.0, used + reserved)
    if 0.0 < auto_max < gb:
        print("%s auto result %.2f GB capped at %.2f GB" % (LOG, gb, auto_max))
        gb = auto_max

    print("%s auto reservation: %.2f GB (card %.2f GB, in use %.2f GB, margin %.2f GB)"
          % (LOG, gb, total, used, reserved))
    return gb


# -------------------------------------------------------------------- node --

class AlwaysEqualProxy(str):
    def __eq__(self, _):
        return True

    def __ne__(self, _):
        return False


any_type = AlwaysEqualProxy("*")


class PainterVRAM:
    """Reserve GPU memory headroom for other applications before a run."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reserved": ("FLOAT", {
                    "default": 0.6,
                    "min": -2.0,
                    "max": 64.0,
                    "step": 0.1,
                    "display": "reserved (GB)"
                }),
                "mode": (["manual", "auto"], {
                    "default": "auto",
                    "display": "Mode"
                }),
                "clean_gpu_before": ("BOOLEAN", {"default": True}),
                "auto_max": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 64.0,
                    "step": 0.1,
                    "display": "auto cap (GB, 0 = off)"
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": -1,
                    "max": 1125899906842624,
                    "display": "seed (-1 = refresh every run)"
                }),
            },
            "optional": {
                "anything": (any_type, {})
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO"
            }
        }

    RETURN_TYPES = (any_type, "FLOAT")
    RETURN_NAMES = ("output", "reserved_gb")
    OUTPUT_NODE = True
    FUNCTION = "apply"
    CATEGORY = "VRAM"
    DESCRIPTION = ("Sets ComfyUI's extra VRAM reservation. Auto mode reserves "
                   "whatever the GPU already uses plus the margin, so other "
                   "applications keep their memory.")

    @classmethod
    def IS_CHANGED(cls, seed=0, **kwargs):
        # Auto mode is derived from live VRAM usage, so a cached result goes
        # stale as soon as anything else on the machine changes. A negative
        # seed opts into recomputing on every run.
        return _jitter.random() if seed < 0 else seed

    def apply(self, reserved, mode="auto", clean_gpu_before=True,
              auto_max=0.0, seed=0, anything=None, unique_id=None,
              extra_pnginfo=None):
        if clean_gpu_before:
            print("%s releasing cached GPU memory first" % LOG)
            gc.collect()
            model_management.unload_all_models()
            model_management.soft_empty_cache()

        gb = _resolve_reserved(reserved, mode, auto_max)
        _write_reserved(gb)
        print("%s EXTRA_RESERVED_VRAM = %.2f GB" % (LOG, gb))

        from comfy_execution.graph import ExecutionBlocker
        output = anything if anything is not None else ExecutionBlocker(None)
        return (output, round(gb, 2))


NODE_CLASS_MAPPINGS = {
    "PainterVRAM": PainterVRAM
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterVRAM": "Painter VRAM"
}

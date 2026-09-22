"""Size settings helper: aspect ratio + fixed resolution table + duration in seconds.

Frozen from the "size settings" subgraph used by the MiniMax H3 reference-to-video
workflow. Outputs width / height / aligned frame count.

Frame count rule (same as the original subgraph, 24 fps aligned to 17k + 5):
    n = max(5, round(duration * 24))
    frames = n + (5 - (n % 17)) % 17
"""

FPS = 24
ALIGN_BASE = 17
ALIGN_OFFSET = 5

ASPECT_LANDSCAPE = "16:9 (Widescreen)"
ASPECT_PORTRAIT = "9:16 (Portrait)"

ASPECT_RATIOS = [ASPECT_LANDSCAPE, ASPECT_PORTRAIT]

RESOLUTIONS_LANDSCAPE = [
    "512*288",
    "800*448",
    "960*544",
    "1024*576",
    "1280*736",
    "1376*768",
    "1536*864",
    "1600*896",
    "1920*1088",
]

RESOLUTIONS_PORTRAIT = []
for _item in RESOLUTIONS_LANDSCAPE:
    _w, _h = _item.split("*")
    RESOLUTIONS_PORTRAIT.append(_h + "*" + _w)

DEFAULT_LANDSCAPE = "1376*768"
DEFAULT_PORTRAIT = "768*1376"

DURATION_DEFAULT = 5.0
DURATION_STEP = 1.0

ALL_RESOLUTIONS = RESOLUTIONS_LANDSCAPE + RESOLUTIONS_PORTRAIT

PRESET_TABLE = {
    ASPECT_LANDSCAPE: dict(zip(RESOLUTIONS_LANDSCAPE, RESOLUTIONS_LANDSCAPE)),
    ASPECT_PORTRAIT: dict(zip(RESOLUTIONS_LANDSCAPE, RESOLUTIONS_PORTRAIT)),
}

DEFAULT_TABLE = {
    ASPECT_LANDSCAPE: DEFAULT_LANDSCAPE,
    ASPECT_PORTRAIT: DEFAULT_PORTRAIT,
}


def parse_resolution(text):
    """Parse a 'W*H' string, returns (width, height) or (0, 0) when invalid."""
    if not isinstance(text, str):
        return (0, 0)
    cleaned = text.strip().replace("x", "*").replace("X", "*").replace(" ", "")
    parts = cleaned.split("*")
    if len(parts) != 2:
        return (0, 0)
    try:
        width = int(parts[0])
        height = int(parts[1])
    except ValueError:
        return (0, 0)
    if width <= 0 or height <= 0:
        return (0, 0)
    return (width, height)


def resolve_resolution(aspect_ratio, resolution):
    """Return (width, height) matching the requested aspect ratio.

    A value picked for the other orientation is flipped instead of rejected, so
    the outputs always agree with the selected aspect ratio.
    """
    width, height = parse_resolution(resolution)
    if width == 0:
        fallback = DEFAULT_TABLE.get(aspect_ratio, DEFAULT_LANDSCAPE)
        width, height = parse_resolution(fallback)

    if aspect_ratio == ASPECT_PORTRAIT:
        if width > height:
            width, height = height, width
    else:
        if height > width:
            width, height = height, width
    return (width, height)


def aligned_frames(duration):
    """Seconds -> frame count aligned to 24 fps and 17k + 5."""
    try:
        seconds = float(duration)
    except (TypeError, ValueError):
        seconds = 0.0
    count = max(ALIGN_OFFSET, int(round(seconds * FPS)))
    count = count + (ALIGN_OFFSET - (count % ALIGN_BASE)) % ALIGN_BASE
    return int(count)


class PainterSizeSettings:
    """Size settings for MiniMax H3: aspect ratio, fixed resolutions, duration."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (
                    ASPECT_RATIOS,
                    {"default": ASPECT_LANDSCAPE},
                ),
                "resolution": (
                    ALL_RESOLUTIONS,
                    {"default": DEFAULT_LANDSCAPE},
                ),
                "duration": (
                    "FLOAT",
                    {
                        "default": DURATION_DEFAULT,
                        "min": 0.1,
                        "max": 120.0,
                        "step": DURATION_STEP,
                        "display": "number",
                    },
                ),
            }
        }

    RETURN_TYPES = ("INT", "INT", "INT")
    RETURN_NAMES = ("width", "height", "num_frames")
    OUTPUT_TOOLTIPS = (
        "Frame width in pixels",
        "Frame height in pixels",
        "Frame count derived from the duration (24 fps, aligned to 17k + 5)",
    )
    FUNCTION = "select"
    CATEGORY = "Painter/Utils"
    DESCRIPTION = (
        "Size settings for MiniMax H3. Aspect ratio picks the resolution list "
        "(landscape or portrait), duration is in seconds and converts to a frame "
        "count aligned to 24 fps (17k + 5). Outputs width, height and num_frames."
    )

    def select(self, aspect_ratio, resolution, duration):
        width, height = resolve_resolution(aspect_ratio, resolution)
        frames = aligned_frames(duration)
        return (width, height, frames)


NODE_CLASS_MAPPINGS = {
    "PainterSizeSettings": PainterSizeSettings,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterSizeSettings": "Painter H3 Size Settings",
}

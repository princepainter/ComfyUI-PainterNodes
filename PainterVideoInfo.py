class VideoInfoSource:
    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "video": ("VHS_VIDEOINFO",),
                    }
                }

    CATEGORY = "VideoInfo"

    RETURN_TYPES = ("FLOAT","INT", "INT", "INT")
    RETURN_NAMES = (
        "fps🟡",
        "Frame_count🟡",
        "width🟡",
        "height🟡",
    )
    FUNCTION = "get_video_info"

    def get_video_info(self, video):
        keys = ["fps", "frame_count", "width", "height"]
        
        source_info = []

        for key in keys:
            source_info.append(video[f"source_{key}"])

        return (*source_info,)


class VideoInfoLoaded:
    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "video": ("VHS_VIDEOINFO",),
                    }
                }

    CATEGORY = "VideoInfo"

    RETURN_TYPES = ("FLOAT","INT", "INT", "INT")
    RETURN_NAMES = (
        "fps🟢",
        "Frame_count🟢",
        "width🟢",
        "height🟢",
    )
    FUNCTION = "get_video_info"

    def get_video_info(self, video):
        keys = ["fps", "frame_count", "width", "height"]
        
        loaded_info = []

        for key in keys:
            loaded_info.append(video[f"loaded_{key}"])

        return (*loaded_info,)


NODE_CLASS_MAPPINGS = {
    "VideoInfoSource": VideoInfoSource,
    "VideoInfoLoaded": VideoInfoLoaded,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoInfoSource": "VideoInfoSource",
    "VideoInfoLoaded": "VideoInfoLoaded",
}


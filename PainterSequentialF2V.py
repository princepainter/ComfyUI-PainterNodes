import torch
import comfy.utils
import comfy.model_management
import nodes
import node_helpers


class PainterSequentialF2V:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "segment_index": ("INT", {"default": 0, "min": 0, "max": 999}),
                "num_segments": ("INT", {"default": 3, "min": 1, "max": 100}),
                "frames_per_segment": ("INT", {"default": 81, "min": 1, "max": 1000, "step": 4}),
                "width": ("INT", {"default": 832, "min": 16, "max": nodes.MAX_RESOLUTION, "step": 16}),
                "height": ("INT", {"default": 480, "min": 16, "max": nodes.MAX_RESOLUTION, "step": 16}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
            },
            "optional": {
                "start_image": ("IMAGE",),
                "end_image": ("IMAGE",),
                "previous_video": ("IMAGE",),
                "positive": ("LIST",),
                "negative": ("LIST",),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "INT")
    RETURN_NAMES = ("positive", "negative", "latent", "current_index")
    FUNCTION = "generate_segment"
    CATEGORY = "Painter/Wan"

    def preprocess_image(self, image, target_width, target_height):
        """Resize image to target dimensions"""
        if image is None:
            return None
        
        current_h, current_w = image.shape[1], image.shape[2]
        
        if current_h == target_height and current_w == target_width:
            return image
        
        image_processed = image.movedim(-1, 1)
        image_processed = comfy.utils.common_upscale(
            image_processed, target_width, target_height, "lanczos", "center"
        )
        image_processed = image_processed.movedim(1, -1)
        
        return image_processed

    def generate_segment(self, clip, vae, segment_index, num_segments, frames_per_segment,
                        width, height, batch_size, start_image=None, end_image=None,
                        previous_video=None, positive=None, negative=None):
        
        if positive is None or segment_index >= len(positive):
            raise ValueError(f"segment_index {segment_index} out of range for positive list length {len(positive) if positive else 0}")
        
        prompt = positive[segment_index]
        
        neg_prompt = ""
        if negative is not None and segment_index < len(negative):
            neg_prompt = negative[segment_index]
        
        device = comfy.model_management.intermediate_device()
        length = frames_per_segment
        
        # Determine and preprocess first frame
        if segment_index == 0:
            if start_image is None:
                raise ValueError("start_image is required for segment 0")
            first_frame = self.preprocess_image(start_image[0:1], width, height).to(device)
        else:
            if previous_video is None or previous_video.shape[0] == 0:
                raise ValueError(f"previous_video is required for segment {segment_index}")
            first_frame = previous_video[-1:].to(device)
            if first_frame.shape[1] != height or first_frame.shape[2] != width:
                first_frame = self.preprocess_image(first_frame, width, height)
        
        # Build image canvas - initialize with gray (0.5)
        image = torch.ones((length, height, width, 3), device=device) * 0.5
        
        # Handle start frame
        if first_frame is not None:
            image[:first_frame.shape[0]] = first_frame
        
        # Handle end frame for last segment
        is_last_segment = (segment_index == num_segments - 1)
        has_end_frame = is_last_segment and end_image is not None
        
        end_frame_shape_0 = 0
        if has_end_frame:
            end_frame = self.preprocess_image(end_image[0:1], width, height).to(device)
            image[-end_frame.shape[0]:] = end_frame
            end_frame_shape_0 = end_frame.shape[0]
        
        # VAE encode
        concat_latent_image = vae.encode(image[:, :, :, :3])
        
        # Calculate latent dims
        spacial_scale = vae.spacial_compression_encode()
        latent_width = width // spacial_scale
        latent_height = height // spacial_scale
        latent_length = ((length - 1) // 4) + 1
        
        # Create mask - reference official WanFirstLastFrameToVideo implementation
        mask = torch.ones((1, 1, latent_length * 4, latent_height, latent_width), device=device)
        
        # Protect start frame (first_frame.shape[0] frames + 3 frames buffer for compression alignment)
        if first_frame is not None:
            mask[:, :, :first_frame.shape[0] + 3] = 0.0
        
        # Protect end frame - use exact frame count like official implementation
        if has_end_frame and end_frame_shape_0 > 0:
            mask[:, :, -end_frame_shape_0:] = 0.0
        
        # Reshape mask to match latent format [1, 4, latent_length, H, W]
        mask = mask.view(1, mask.shape[2] // 4, 4, mask.shape[3], mask.shape[4]).transpose(1, 2)
        
        # Empty latent
        latent = torch.zeros([batch_size, vae.latent_channels, latent_length, latent_height, latent_width], device=device)
        
        # Encode conditioning
        tokens = clip.tokenize(prompt)
        positive_cond = clip.encode_from_tokens_scheduled(tokens)
        positive_final = node_helpers.conditioning_set_values(positive_cond, {
            "concat_latent_image": concat_latent_image,
            "concat_mask": mask
        })
        
        neg_tokens = clip.tokenize(neg_prompt)
        negative_cond = clip.encode_from_tokens_scheduled(neg_tokens)
        negative_final = node_helpers.conditioning_set_values(negative_cond, {
            "concat_latent_image": concat_latent_image,
            "concat_mask": mask
        })
        
        return (positive_final, negative_final, {"samples": latent}, segment_index)


NODE_CLASS_MAPPINGS = {
    "PainterSequentialF2V": PainterSequentialF2V,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PainterSequentialF2V": "Painter Sequential F2V",
}

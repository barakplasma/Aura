"""Aura's Replicate input contract, shared by every predictor in this project.

Both CPU models take the same inputs as untapped/glance-qwen3-vl-4b
(question, question_type, options_json, image or image_base64) so Aura's
`replicate` adapter serves all of them. Keeping the validation here means the
two predictors can't drift apart on what they accept.
"""

import base64
import binascii
import io
import json
from pathlib import Path

from PIL import Image

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_OPTIONS = 20


def resolve_options(question_type: str, options_json: str) -> list[str]:
    """The option labels to score, in order."""
    if question_type == "yes_no":
        return ["Yes", "No"]
    if question_type != "choice":
        raise ValueError("question_type must be yes_no or choice")
    try:
        options = json.loads(options_json or "[]")
    except json.JSONDecodeError as exc:
        raise ValueError("options_json must be valid JSON") from exc
    if not isinstance(options, list) or not 2 <= len(options) <= MAX_OPTIONS or any(
        not isinstance(option, str) or not option.strip() for option in options
    ):
        raise ValueError(f"options_json must be an array of 2-{MAX_OPTIONS} non-empty strings")
    options = [option.strip() for option in options]
    if len(set(options)) != len(options):
        raise ValueError("options_json labels must be unique")
    return options


def decode_image(data: str) -> Image.Image:
    """Plain base64 or a data: URI -> an RGB image."""
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image_base64 is not valid base64") from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image_base64 must decode to 1 byte-5 MB")
    return Image.open(io.BytesIO(raw)).convert("RGB")


def prepare_inputs(question, image, image_base64, question_type, options_json):
    """Validate one prediction's inputs; returns (options, picture)."""
    if not question.strip():
        raise ValueError("question is required")
    if image is None and not image_base64:
        raise ValueError("Provide image or image_base64")
    options = resolve_options(question_type, options_json)
    if image is not None:
        if Path(image).stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError("image must be 5 MB or smaller")
        picture = Image.open(image).convert("RGB")
    else:
        picture = decode_image(image_base64)
    return options, picture

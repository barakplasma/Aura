"""CPU prototype for Qwen3-VL-2B with Aura's Replicate input shape."""

import base64
import binascii
import io
import json
import re
import time

from cog import BasePredictor, Input, Path
from loguru import logger
from PIL import Image

MODEL_ID = "Qwen/Qwen3-VL-2B-Instruct-GGUF"
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def resolve_options(question_type: str, options_json: str) -> list[str]:
    if question_type == "yes_no":
        return ["Yes", "No"]
    if question_type != "choice":
        raise ValueError("question_type must be yes_no or choice")
    try:
        options = json.loads(options_json or "[]")
    except json.JSONDecodeError as exc:
        raise ValueError("options_json must be valid JSON") from exc
    if not isinstance(options, list) or not 2 <= len(options) <= 20 or any(
        not isinstance(option, str) or not option.strip() for option in options
    ):
        raise ValueError("options_json must be an array of 2-20 non-empty strings")
    options = [option.strip() for option in options]
    if len(set(options)) != len(options):
        raise ValueError("options_json labels must be unique")
    return options


def decode_image(data: str) -> Image.Image:
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image_base64 is not valid base64") from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image_base64 must decode to 1 byte-5 MB")
    return Image.open(io.BytesIO(raw)).convert("RGB")


def parse_answer(text: str, options: list[str]) -> str:
    """Accept an exact option, quoted option, or leading option letter."""
    cleaned = text.strip()
    for option in options:
        if cleaned.casefold() == option.casefold():
            return option
    for option in options:
        if re.search(rf"(?<!\w){re.escape(option)}(?!\w)", cleaned, re.IGNORECASE):
            return option
    match = re.match(r"\s*([A-T])(?=$|[).:\s])", cleaned, re.IGNORECASE)
    if match:
        index = ord(match.group(1).upper()) - ord("A")
        if index < len(options):
            return options[index]
    raise ValueError(f"model did not return a listed choice: {cleaned[:160]!r}")


class Predictor(BasePredictor):
    def setup(self) -> None:
        import torch
        from transformers import pipeline

        torch.set_num_threads(4)
        logger.info("setup: loading {} on CPU; torch={}", MODEL_ID, torch.__version__)
        self.pipe = pipeline(
            "image-text-to-text",
            model=MODEL_ID,
            device="cpu",
            dtype=torch.bfloat16,
        )
        logger.info("setup: Qwen3-VL-2B ready")

    def run(
        self,
        question: str = Input(description="Question about the image"),
        image: Path = Input(description="JPEG, PNG, or WebP image", default=None),
        image_base64: str = Input(description="Base64 image for API clients", default=""),
        question_type: str = Input(choices=["yes_no", "choice"], default="yes_no"),
        options_json: str = Input(description="JSON array of answer choices", default="[]"),
        state: str = Input(description="Optional scene context", default=""),
    ) -> dict:
        started = time.monotonic()
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
        labels = "\n".join(f"{chr(65 + i)}. {item}" for i, item in enumerate(options))
        prompt = (
            f"{state.strip()}\n" if state.strip() else ""
        ) + f"{question.strip()}\nChoose exactly one option and answer with its letter only:\n{labels}\nAnswer:"
        messages = [{"role": "user", "content": [
            {"type": "image", "image": picture},
            {"type": "text", "text": prompt},
        ]}]
        logger.info("prediction: Qwen3-VL start; type={} options={} image={}x{}", question_type, len(options), picture.width, picture.height)
        result = self.pipe(text=messages, max_new_tokens=16, do_sample=False)
        generated = result[0]["generated_text"]
        if isinstance(generated, list):
            generated = generated[-1].get("content", "") if generated else ""
        elif isinstance(generated, str) and "Answer:" in generated:
            generated = generated.rsplit("Answer:", 1)[-1]
        answer = parse_answer(str(generated), options)
        logger.info("prediction: Qwen3-VL done in {:.2f}s; answer={!r}", time.monotonic() - started, answer)
        return {
            "answer": answer,
            # Unlike decider, Qwen isn't trained with a calibrated option
            # readout. Leave these absent rather than manufacture a score.
            "confidence": None,
            "probabilities": [],
        }

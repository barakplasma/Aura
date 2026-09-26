"""CPU prototype for Mapika/decider-2b-vision."""

import base64
import binascii
import io
import json
import time

import torch
from cog import BasePredictor, Input, Path
from decider.infer import Example, Q
from decider.vision import VisionDecisionModel
from loguru import logger
from PIL import Image

MODEL_ID = "Mapika/decider-2b-vision"
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


class Predictor(BasePredictor):
    def setup(self) -> None:
        torch.set_num_threads(4)
        logger.info("setup: loading {} on CPU; torch={}", MODEL_ID, torch.__version__)
        self.model = VisionDecisionModel(MODEL_ID, grad_ckpt=False).eval()
        logger.info("setup: decider-2b-vision ready on CPU")

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
        example = Example(state.strip(), [Q(question.strip(), options, 0)])
        logger.info("prediction: decider start; type={} options={} image={}x{}", question_type, len(options), picture.width, picture.height)
        with torch.inference_mode():
            inputs = self.model.prepare([(picture, example)])
            probabilities = torch.softmax(self.model.slot_logits(inputs), dim=-1)[0, :len(options)]
        values = [float(value) for value in probabilities.cpu().tolist()]
        ranked = [{"label": label, "probability": value} for label, value in zip(options, values)]
        best = max(ranked, key=lambda item: item["probability"])
        logger.info("prediction: decider done in {:.2f}s; answer={!r}; confidence={:.4f}", time.monotonic() - started, best["label"], best["probability"])
        return {"answer": best["label"], "confidence": best["probability"], "probabilities": ranked}

"""CPU prototype for Mapika/decider-2b-vision."""

import time
from typing import Optional

import torch
from cog import BasePredictor, Input, Path
from decider.infer import Example, Q
from decider.vision import VisionDecisionModel
from loguru import logger

from aura_io import prepare_inputs

MODEL_ID = "Mapika/decider-2b-vision"


class Predictor(BasePredictor):
    def setup(self) -> None:
        torch.set_num_threads(4)
        logger.info("setup: loading {} on CPU; torch={}", MODEL_ID, torch.__version__)
        self.model = VisionDecisionModel(MODEL_ID, grad_ckpt=False).eval()
        logger.info("setup: decider-2b-vision ready on CPU")

    # The input signature is Aura's Replicate contract. Cog reads it from this
    # file to build the model's schema, so each predictor spells it out;
    # aura_io.prepare_inputs() holds the shared validation behind it.
    # jscpd:ignore-start
    def run(
        self,
        question: str = Input(description="Question about the image"),
        image: Optional[Path] = Input(description="JPEG, PNG, or WebP image", default=None),
        image_base64: str = Input(description="Base64 image for API clients", default=""),
        question_type: str = Input(choices=["yes_no", "choice"], default="yes_no"),
        options_json: str = Input(description="JSON array of answer choices", default="[]"),
        state: str = Input(description="Optional scene context", default=""),
    ) -> dict:
        started = time.monotonic()
        # jscpd:ignore-end
        options, picture = prepare_inputs(question, image, image_base64, question_type, options_json)
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

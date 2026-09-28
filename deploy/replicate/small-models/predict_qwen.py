"""CPU prototype for Qwen3-VL-2B with Aura's Replicate input shape."""

import re
import time
from typing import Optional

from cog import BasePredictor, Input, Path
from loguru import logger

from aura_io import prepare_inputs

MODEL_ID = "Qwen/Qwen3-VL-2B-Instruct-GGUF"


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

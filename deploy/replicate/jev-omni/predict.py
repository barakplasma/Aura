"""Jev-Omni on Replicate: one image + one typed question -> a probability per option.

Input and output mirror untapped/glance-qwen3-vl-4b, so Aura's `replicate`
dialect adapter talks to both unchanged: `question`, `question_type`
(yes_no | choice), `options_json`, and the image as `image` or
`image_base64`; out comes {answer, confidence, probabilities: [{label,
probability}]}.
"""
import base64
import binascii
import hashlib
import importlib
import json
import pathlib
import sys
import tempfile

from cog import BasePredictor, Input, Path

# From the repo's own sha256.json at the pinned revision. jev_omni.py is imported as
# code and head.pt is deserialised, so both are checked before use.
EXPECTED_SHA256 = {
    "jev_omni.py": "11d761b0b6cefc8aac29757f43af4b2b02af8f9b6c6dad19834c0b14538180f0",
    "head.pt": "8c81edecd733f7db327604803c14cf9ecbee53d2af055eeb09f78b64bcbf2638",
}
YES_NO = ["Yes", "No"]
MAX_OPTIONS = 20  # the model card: quality above 20 options is not established
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def resolve_options(question_type: str, options_json: str) -> list[str]:
    """The option labels to score, in order."""
    if question_type == "yes_no":
        return list(YES_NO)
    if question_type != "choice":
        raise ValueError("question_type must be yes_no or choice.")
    try:
        options = json.loads(options_json or "[]")
    except json.JSONDecodeError as err:
        raise ValueError(f"options_json is not valid JSON: {err}") from err
    if not isinstance(options, list) or not all(isinstance(o, str) and o.strip() for o in options):
        raise ValueError("options_json must be a JSON array of non-empty strings.")
    options = [o.strip() for o in options]
    if len(set(options)) != len(options):
        raise ValueError("options_json labels must be unique.")
    if not 2 <= len(options) <= MAX_OPTIONS:
        raise ValueError(f"choice questions need 2-{MAX_OPTIONS} options.")
    return options


def decode_image_base64(data: str) -> bytes:
    """Plain base64 or a data: URI -> image bytes."""
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ValueError("image_base64 is not valid base64.") from err
    if not raw:
        raise ValueError("image_base64 is empty.")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image must be 5 MB or smaller.")
    return raw


def format_output(probabilities: dict[str, float], options: list[str]) -> dict:
    """Replicate output, shaped like untapped/glance-qwen3-vl-4b's."""
    ranked = [{"label": o, "probability": float(probabilities[o])} for o in options]
    best = max(ranked, key=lambda r: r["probability"])
    return {"answer": best["label"], "confidence": best["probability"], "probabilities": ranked}


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verification_drift(got: dict[str, float], reference: dict[str, float]) -> float:
    return max(abs(got[label] - p) for label, p in reference.items())


class Predictor(BasePredictor):
    def setup(self) -> None:
        import torch
        import transformers
        from transformers import AutoConfig, AutoProcessor

        # The Cog image build downloads this pinned snapshot into the image;
        # never wait for the multi-GB Hub transfer during prediction startup.
        path = pathlib.Path("/opt/jev-omni")
        if not path.is_dir():
            raise RuntimeError(f"Baked Jev-Omni snapshot is missing: {path}")
        for name, expected in EXPECTED_SHA256.items():
            actual = sha256_file(path / name)
            if actual != expected:
                raise RuntimeError(f"{name} sha256 {actual} != pinned {expected}")

        # The upstream loader (load_jev_omni) always fetches the latest
        # revision; assemble the same pieces from the pinned snapshot instead.
        sys.path.insert(0, str(path))
        jev_omni = importlib.import_module("jev_omni")
        config = AutoConfig.from_pretrained(path)
        model = getattr(transformers, config.architectures[0]).from_pretrained(
            path, dtype=torch.bfloat16, device_map="cuda").eval()
        decision = json.loads((path / "decision_config.json").read_text())
        head = jev_omni._Head256(decision["hidden_size"]).to("cuda").eval()
        head.load_state_dict(torch.load(path / "head.pt", map_location="cuda", weights_only=True))
        _, decoder = jev_omni._find_backbone(model)
        self.classifier = jev_omni.JevOmni(model, head, AutoProcessor.from_pretrained(path), decoder, "cuda")
        self._verify(path)

    def _verify(self, path: pathlib.Path) -> None:
        """Refuse to serve if a reference case drifts: catches a wrong torch/transformers stack."""
        verification = json.loads((path / "verification.json").read_text())
        tolerance = max(0.05, 2 * float(verification.get("worst_abs_diff", 0.02)))
        for case, reference in zip(verification["cases"], verification["reference"]):
            drift = verification_drift(self.classifier.predict(**case)["probabilities"], reference)
            if drift > tolerance:
                raise RuntimeError(f"verification drift {drift:.3f} on {case['question']!r}")

    def run(
        self,
        question: str = Input(description="Question about the image, e.g. 'Is a package on the doormat?'"),
        image: Path = Input(description="JPEG, PNG, or WebP image", default=None),
        image_base64: str = Input(description="Base64-encoded image (plain or data: URI) for API clients", default=""),
        question_type: str = Input(description="yes_no or choice", choices=["yes_no", "choice"], default="yes_no"),
        options_json: str = Input(description="JSON array of choice labels (choice only)", default="[]"),
        state: str = Input(description="Optional text context about the scene", default=""),
    ) -> dict:
        if not question.strip():
            raise ValueError("question is required.")
        options = resolve_options(question_type, options_json)
        if image is not None:
            if pathlib.Path(image).stat().st_size > MAX_IMAGE_BYTES:
                raise ValueError("image must be 5 MB or smaller.")
            result = self.classifier.predict(state=state, question=question, options=options,
                                             media=str(image), modality="image")
        elif image_base64:
            raw = decode_image_base64(image_base64)
            with tempfile.NamedTemporaryFile(suffix=".img") as tmp:
                tmp.write(raw)
                tmp.flush()
                result = self.classifier.predict(state=state, question=question, options=options,
                                                 media=tmp.name, modality="image")
        else:
            raise ValueError("Provide image or image_base64.")
        return format_output(result["probabilities"], options)

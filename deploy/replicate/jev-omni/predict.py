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
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

from cog import BasePredictor, Input, Path

MODEL_ID = "akhilaaa3/Jev-Omni"
REVISION = "5addda86ddee081a68fb067477ea100c221b8917"
# Everything the pinned loader reads; model.safetensors alone is ~24 GB.
WEIGHT_FILES = [
    "config.json", "generation_config.json", "model.safetensors", "processor_config.json",
    "tokenizer.json", "tokenizer_config.json", "chat_template.jinja",
    "decision_config.json", "head.pt", "jev_omni.py", "verification.json",
]
WEIGHTS_DIR = pathlib.Path("/src/weights")
# From the repo's own sha256.json at REVISION. jev_omni.py is imported as
# code and head.pt is deserialised, so both are checked before use.
EXPECTED_SHA256 = {
    "jev_omni.py": "11d761b0b6cefc8aac29757f43af4b2b02af8f9b6c6dad19834c0b14538180f0",
    "head.pt": "8c81edecd733f7db327604803c14cf9ecbee53d2af055eeb09f78b64bcbf2638",
}
YES_NO = ["Yes", "No"]
MAX_OPTIONS = 20  # the model card: quality above 20 options is not established
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def log(message: str) -> None:
    """Write an immediately flushed, timestamped line to Replicate's logs."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[{now}] {message}", flush=True)


def directory_file_sizes(path: pathlib.Path) -> dict[str, int]:
    if not path.exists():
        return {}
    return {str(p.relative_to(path)): p.stat().st_size for p in path.rglob("*") if p.is_file()}


def format_bytes(size: int) -> str:
    return f"{size / (1024 ** 3):.2f} GiB ({size:,} bytes)"


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


def weights_manifest(dest: pathlib.Path) -> str:
    """pget multifile manifest: one "URL DEST" line per file at the pinned revision."""
    base = f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}"
    return "".join(f"{base}/{name} {dest / name}\n" for name in WEIGHT_FILES)


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
        setup_started = time.monotonic()
        log(f"setup: starting Jev-Omni {MODEL_ID}@{REVISION}")
        log(f"setup: Python {sys.version.split()[0]}, PID {os.getpid()}, weights directory {WEIGHTS_DIR}")
        import torch
        import transformers
        from transformers import AutoConfig, AutoProcessor

        log(f"setup: torch {torch.__version__}, transformers {transformers.__version__}")
        log(f"setup: CUDA available={torch.cuda.is_available()}, device_count={torch.cuda.device_count()}")
        if torch.cuda.is_available():
            for index in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(index)
                log(f"setup: CUDA device {index}: {props.name}, memory={format_bytes(props.total_memory)}")

        # Baking the ~24 GB checkpoint into the image makes one layer too big
        # for r8.im (413 from its CDN), so setup fetches the pinned files with
        # pget, Replicate's parallel downloader, which is much faster than
        # snapshot_download. A warm container that already has them skips it.
        path = WEIGHTS_DIR
        path.mkdir(parents=True, exist_ok=True)
        existing = directory_file_sizes(path)
        missing = [name for name in WEIGHT_FILES if not (path / name).is_file()]
        expected_count = len(WEIGHT_FILES)
        log(f"weights: pinned manifest has {expected_count} files; {len(missing)} missing, {expected_count - len(missing)} present")
        if existing:
            log("weights: existing files: " + ", ".join(f"{name}={format_bytes(size)}" for name, size in sorted(existing.items())))
        disk = shutil.disk_usage(path)
        log(f"weights: disk free={format_bytes(disk.free)}, total={format_bytes(disk.total)}")
        if missing:
            manifest = weights_manifest(path)
            log("weights: pget will fetch: " + ", ".join(missing))
            log(f"weights: starting pget multifile for {len(missing)} files; manifest revision={REVISION}")
            download_started = time.monotonic()
            try:
                # Inherit stdout/stderr so pget's own progress and errors appear
                # directly in Replicate's prediction logs. Periodic snapshots
                # below remain useful if pget emits no progress for a long time.
                process = subprocess.Popen(["pget", "multifile", "-"], stdin=subprocess.PIPE, text=True)
                assert process.stdin is not None
                try:
                    process.stdin.write(manifest)
                except BrokenPipeError:
                    # Capture the actual pget exit status instead of masking an
                    # early startup failure with a generic broken-pipe error.
                    return_code = process.wait()
                    raise RuntimeError(f"pget exited while reading its manifest (exit_code={return_code})")
                finally:
                    process.stdin.close()
                last_report = download_started
                previous_total = sum(directory_file_sizes(path).values())
                while process.poll() is None:
                    time.sleep(30)
                    now = time.monotonic()
                    if now - last_report >= 30 and process.poll() is None:
                        snapshot = directory_file_sizes(path)
                        total = sum(snapshot.values())
                        elapsed = now - download_started
                        interval = now - last_report
                        rate = max(0, total - previous_total) / interval if interval else 0
                        log(f"weights: pget still running after {elapsed / 60:.1f} min; observed files={len(snapshot)}/{expected_count}, bytes={format_bytes(total)}, recent rate={rate / (1024 ** 2):.2f} MiB/s")
                        if snapshot:
                            log("weights: progress by file: " + ", ".join(f"{name}={format_bytes(size)}" for name, size in sorted(snapshot.items())))
                        disk = shutil.disk_usage(path)
                        log(f"weights: disk free={format_bytes(disk.free)}")
                        last_report = now
                        previous_total = total
                return_code = process.returncode
                elapsed = time.monotonic() - download_started
                if return_code != 0:
                    log(f"weights: pget FAILED exit_code={return_code} after {elapsed / 60:.1f} min")
                    raise subprocess.CalledProcessError(return_code, ["pget", "multifile", "-"])
                snapshot = directory_file_sizes(path)
                log(f"weights: pget completed in {elapsed / 60:.1f} min; files={len(snapshot)}/{expected_count}, total={format_bytes(sum(snapshot.values()))}")
                for name, size in sorted(snapshot.items()):
                    log(f"weights: downloaded {name}: {format_bytes(size)}")
            except Exception as err:
                elapsed = time.monotonic() - download_started
                log(f"weights: download raised {type(err).__name__} after {elapsed / 60:.1f} min: {err}")
                snapshot = directory_file_sizes(path)
                log("weights: files present at failure: " + (", ".join(f"{name}={format_bytes(size)}" for name, size in sorted(snapshot.items())) or "none"))
                raise
        else:
            log("weights: all manifest files already exist; skipping pget")
        for name, expected in EXPECTED_SHA256.items():
            hash_started = time.monotonic()
            log(f"integrity: hashing {name} ({format_bytes((path / name).stat().st_size)})")
            actual = sha256_file(path / name)
            if actual != expected:
                log(f"integrity: FAILED {name}: got sha256={actual}, expected={expected}")
                raise RuntimeError(f"{name} sha256 {actual} != pinned {expected}")
            log(f"integrity: verified {name} sha256={actual} in {time.monotonic() - hash_started:.1f}s")

        # The upstream loader (load_jev_omni) always fetches the latest
        # revision; assemble the same pieces from the pinned snapshot instead.
        sys.path.insert(0, str(path))
        load_started = time.monotonic()
        log("model: importing pinned Jev-Omni implementation and reading config")
        jev_omni = importlib.import_module("jev_omni")
        config = AutoConfig.from_pretrained(path)
        log(f"model: loading architecture={config.architectures[0]} on CUDA with BF16")
        model = getattr(transformers, config.architectures[0]).from_pretrained(
            path, dtype=torch.bfloat16, device_map="cuda").eval()
        log(f"model: base weights loaded in {time.monotonic() - load_started:.1f}s")
        decision = json.loads((path / "decision_config.json").read_text())
        log("model: loading decision head and processor")
        head = jev_omni._Head256(decision["hidden_size"]).to("cuda").eval()
        head.load_state_dict(torch.load(path / "head.pt", map_location="cuda", weights_only=True))
        _, decoder = jev_omni._find_backbone(model)
        self.classifier = jev_omni.JevOmni(model, head, AutoProcessor.from_pretrained(path), decoder, "cuda")
        log(f"model: initialization complete in {time.monotonic() - load_started:.1f}s; running verification")
        verify_started = time.monotonic()
        self._verify(path)
        log(f"setup: ready; verification took {time.monotonic() - verify_started:.1f}s, total setup {time.monotonic() - setup_started:.1f}s")

    def _verify(self, path: pathlib.Path) -> None:
        """Refuse to serve if a reference case drifts: catches a wrong torch/transformers stack."""
        verification = json.loads((path / "verification.json").read_text())
        tolerance = max(0.05, 2 * float(verification.get("worst_abs_diff", 0.02)))
        log(f"verification: {len(verification['cases'])} reference cases, allowed drift={tolerance:.3f}")
        for case, reference in zip(verification["cases"], verification["reference"]):
            case_started = time.monotonic()
            drift = verification_drift(self.classifier.predict(**case)["probabilities"], reference)
            log(f"verification: question={case['question']!r}, drift={drift:.3f}, elapsed={time.monotonic() - case_started:.1f}s")
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
        run_started = time.monotonic()
        log(f"prediction: started question_type={question_type}, image={'file' if image is not None else 'base64' if image_base64 else 'missing'}, state_chars={len(state)}")
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
        output = format_output(result["probabilities"], options)
        log(f"prediction: completed in {time.monotonic() - run_started:.2f}s, answer={output['answer']!r}, confidence={output['confidence']:.4f}")
        return output

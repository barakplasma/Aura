"""Jev-Omni on Replicate: one image + one typed question -> a probability per option.

Input and output mirror untapped/glance-qwen3-vl-4b, so Aura's `replicate`
dialect adapter talks to both unchanged: `question`, `question_type`
(yes_no | choice), `options_json`, and the image as `image` or
`image_base64`; out comes {answer, confidence, probabilities: [{label,
probability}]}.
"""
import base64
import binascii
import codecs
import hashlib
import importlib
import json
import os
import pathlib
import re
import selectors
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from loguru import logger

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
EXPECTED_FILE_SIZES = {"model.safetensors": 23_919_549_408}
PGET_TIMEOUT_SECONDS = 8 * 60
PGET_HEARTBEAT_SECONDS = 30
PGET_COMMAND = [
    "pget", "--force", "--log-level", "info", "--concurrency", "8", "--chunk-size", "16M",
    "--max-conn-per-host", "8",
    "--connect-timeout", "10s", "--retries", "1", "multifile", "-",
]


def directory_file_sizes(path: pathlib.Path) -> dict[str, int]:
    if not path.exists():
        return {}
    return {str(p.relative_to(path)): p.stat().st_size for p in path.rglob("*") if p.is_file()}


def format_bytes(size: int) -> str:
    return f"{size / (1024 ** 3):.2f} GiB ({size:,} bytes)"


def run_pget(path: pathlib.Path, manifest: str, timeout_seconds: int = PGET_TIMEOUT_SECONDS,
             command: list[str] | None = None) -> None:
    """Run pget while forwarding child output through Cog's prediction logger."""
    path.mkdir(parents=True, exist_ok=True)
    argv = command or PGET_COMMAND
    started = time.monotonic()
    logger.info("weights: launching pget; hard_timeout={}s", timeout_seconds)
    pget_env = os.environ.copy()
    pget_env["PGET_MAX_CONCURRENT_FILES"] = "1"
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, bufsize=0, env=pget_env)
    selector = selectors.DefaultSelector()
    assert process.stdin is not None and process.stdout is not None
    selector.register(process.stdout, selectors.EVENT_READ)
    pending = bytearray()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    last_heartbeat = started
    previous_bytes = sum(directory_file_sizes(path).values())

    def emit_bytes(data: bytes, final: bool = False) -> None:
        pending.extend(data)
        while True:
            separators = [i for i in (pending.find(b"\n"), pending.find(b"\r")) if i >= 0]
            if not separators:
                break
            end = min(separators)
            line = bytes(pending[:end])
            del pending[:end + 1]
            # Consume a paired CRLF as one terminator.
            if line.endswith(b"\r"):
                line = line[:-1]
            message = decoder.decode(line, final=False).strip()
            if message:
                logger.info("pget: {}", re.sub(r"(https?://[^?\s]+)\?[^\s]+", r"\1?<query redacted>", message))
        if len(pending) >= 4096 or (final and pending):
            message = decoder.decode(bytes(pending), final=final).strip()
            pending.clear()
            if message:
                logger.info("pget: {}", re.sub(r"(https?://[^?\s]+)\?[^\s]+", r"\1?<query redacted>", message))

    try:
        try:
            process.stdin.write(manifest.encode())
            process.stdin.close()
        except BrokenPipeError:
            process.stdin.close()
            code = process.wait()
            emit_bytes(process.stdout.read() or b"", final=True)
            raise RuntimeError(f"pget exited while reading the manifest (exit_code={code})")

        eof = False
        while process.poll() is None or not eof:
            elapsed = time.monotonic() - started
            if process.poll() is None and elapsed >= timeout_seconds:
                logger.warning("weights: pget deadline reached after {:.1f}s; terminating child", elapsed)
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise TimeoutError(f"pget exceeded its {timeout_seconds}s hard deadline")

            wait = min(1.0, max(0.0, timeout_seconds - elapsed)) if process.poll() is None else 0
            events = selector.select(wait)
            for key, _ in events:
                data = os.read(key.fileobj.fileno(), 65536)
                if data:
                    emit_bytes(data)
                else:
                    selector.unregister(key.fileobj)
                    eof = True
                    emit_bytes(b"", final=True)

            now = time.monotonic()
            if now - last_heartbeat >= PGET_HEARTBEAT_SECONDS:
                snapshot = directory_file_sizes(path)
                total_bytes = sum(snapshot.values())
                interval = now - last_heartbeat
                rate = max(0, total_bytes - previous_bytes) / interval if interval else 0
                disk = shutil.disk_usage(path)
                logger.info("weights: pget heartbeat elapsed={:.0f}s files_observed={} bytes_written={} recent_file_growth={:.2f} MiB/s disk_free={}", now - started, len(snapshot), format_bytes(total_bytes), rate / (1024 ** 2), format_bytes(disk.free))
                if snapshot:
                    for name, size in sorted(snapshot.items()):
                        logger.info("weights: file_progress {}={}", name, format_bytes(size))
                previous_bytes = total_bytes
                last_heartbeat = now

        return_code = process.wait()
        elapsed = time.monotonic() - started
        if return_code:
            raise subprocess.CalledProcessError(return_code, argv)
        logger.info("weights: pget exited successfully after {:.1f}s", elapsed)
    except BaseException:
        if process.poll() is None:
            process.kill()
            process.wait()
        raise
    finally:
        selector.close()
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.stdout:
            process.stdout.close()


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


def weights_manifest(dest: pathlib.Path, files: list[str] | None = None) -> str:
    """pget multifile manifest: one "URL DEST" line per file at the pinned revision."""
    base = f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}"
    return "".join(f"{base}/{name} {dest / name}\n" for name in files or WEIGHT_FILES)


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
        # Replicate doesn't bill setup time. Keep weight downloads and model
        # loading out of the billed prediction, then replay their logs in run().
        self.classifier = None
        self._init_error = None
        self._init_lock = threading.Lock()
        self._startup_logs = []
        sink_id = logger.add(lambda message: self._startup_logs.append(message.record["message"]),
                             format="{message}", level="INFO")
        try:
            self._ensure_ready()
        finally:
            logger.remove(sink_id)
        logger.info("setup: Jev-Omni {}@{} ready; startup details will be included in prediction logs", MODEL_ID, REVISION)

    def _ensure_ready(self) -> None:
        if self.classifier is not None:
            return
        if self._init_error is not None:
            raise RuntimeError(f"model initialization previously failed; automatic retry disabled: {self._init_error}") from self._init_error
        with self._init_lock:
            if self.classifier is not None:
                return
            if self._init_error is not None:
                raise RuntimeError(f"model initialization previously failed; automatic retry disabled: {self._init_error}") from self._init_error
            init_started = time.monotonic()
            source_hash = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()[:12]
            logger.info("init: begin revision={}, predictor_sha256={}, replicate_version={}, pid={}, python={}", REVISION, source_hash, os.getenv("REPLICATE_VERSION_ID", "unknown"), os.getpid(), sys.version.split()[0])
            try:
                import torch
                import transformers
                from transformers import AutoConfig, AutoProcessor

                logger.info("init: torch={}, transformers={}, cuda_available={}, device_count={}", torch.__version__, transformers.__version__, torch.cuda.is_available(), torch.cuda.device_count())
                if not torch.cuda.is_available():
                    raise RuntimeError("CUDA is required; refusing to download/load Jev-Omni without a CUDA GPU")
                for index in range(torch.cuda.device_count()):
                    props = torch.cuda.get_device_properties(index)
                    logger.info("init: CUDA device {}: {}, memory={}", index, props.name, format_bytes(props.total_memory))

                path = WEIGHTS_DIR
                path.mkdir(parents=True, exist_ok=True)
                existing = directory_file_sizes(path)
                missing = [
                    name for name in WEIGHT_FILES
                    if not (path / name).is_file()
                    or (name in EXPECTED_FILE_SIZES and (path / name).stat().st_size != EXPECTED_FILE_SIZES[name])
                ]
                logger.info("weights: revision={}; manifest_files={}, missing={}, present={}", REVISION, len(WEIGHT_FILES), len(missing), len(WEIGHT_FILES) - len(missing))
                if existing:
                    logger.info("weights: existing files: {}", ", ".join(f"{name}={format_bytes(size)}" for name, size in sorted(existing.items())))
                disk = shutil.disk_usage(path)
                logger.info("weights: disk_free={}, disk_total={}", format_bytes(disk.free), format_bytes(disk.total))
                if missing:
                    logger.info("weights: pget manifest files: {}", ", ".join(missing))
                    try:
                        run_pget(path, weights_manifest(path, missing))
                    except Exception as err:
                        logger.exception("weights: download failed ({})", type(err).__name__)
                        snapshot = directory_file_sizes(path)
                        logger.info("weights: files present after failure: {}", ", ".join(f"{name}={format_bytes(size)}" for name, size in sorted(snapshot.items())) or "none")
                        raise
                else:
                    logger.info("weights: all manifest files already exist; skipping pget")

                incomplete = [
                    name for name in WEIGHT_FILES
                    if not (path / name).is_file()
                    or (name in EXPECTED_FILE_SIZES and (path / name).stat().st_size != EXPECTED_FILE_SIZES[name])
                ]
                if incomplete:
                    raise RuntimeError(f"download did not produce complete pinned files: {incomplete}")

                for name, expected in EXPECTED_SHA256.items():
                    hash_started = time.monotonic()
                    logger.info("integrity: hashing {} ({})", name, format_bytes((path / name).stat().st_size))
                    actual = sha256_file(path / name)
                    if actual != expected:
                        logger.error("integrity: FAILED {}: got sha256={}, expected={}", name, actual, expected)
                        raise RuntimeError(f"{name} sha256 {actual} != pinned {expected}")
                    logger.info("integrity: verified {} sha256={} in {:.1f}s", name, actual, time.monotonic() - hash_started)

                # The upstream loader fetches latest; load only the pinned snapshot.
                sys.path.insert(0, str(path))
                load_started = time.monotonic()
                logger.info("model: importing pinned implementation and reading config")
                jev_omni = importlib.import_module("jev_omni")
                config = AutoConfig.from_pretrained(path)
                logger.info("model: loading architecture={} on CUDA with BF16", config.architectures[0])
                model = getattr(transformers, config.architectures[0]).from_pretrained(
                    path, dtype=torch.bfloat16, device_map="cuda").eval()
                logger.info("model: base weights loaded in {:.1f}s", time.monotonic() - load_started)
                decision = json.loads((path / "decision_config.json").read_text())
                logger.info("model: loading decision head and processor")
                head = jev_omni._Head256(decision["hidden_size"]).to("cuda").eval()
                head.load_state_dict(torch.load(path / "head.pt", map_location="cuda", weights_only=True))
                _, decoder = jev_omni._find_backbone(model)
                classifier = jev_omni.JevOmni(model, head, AutoProcessor.from_pretrained(path), decoder, "cuda")
                logger.info("model: initialized in {:.1f}s; checking reference predictions", time.monotonic() - load_started)
                verify_started = time.monotonic()
                self._verify(path, classifier)
                self.classifier = classifier
                logger.info("init: ready; verification={:.1f}s, total={:.1f}s", time.monotonic() - verify_started, time.monotonic() - init_started)
            except BaseException as err:
                self.classifier = None
                self._init_error = err
                logger.exception("init: FAILED after {:.1f}s ({})", time.monotonic() - init_started, type(err).__name__)
                raise

    def _verify(self, path: pathlib.Path, classifier) -> None:
        """Refuse to serve if a reference case drifts: catches a wrong torch/transformers stack."""
        verification = json.loads((path / "verification.json").read_text())
        tolerance = max(0.05, 2 * float(verification.get("worst_abs_diff", 0.02)))
        logger.info("verification: {} reference cases, allowed drift={:.3f}", len(verification["cases"]), tolerance)
        for case, reference in zip(verification["cases"], verification["reference"]):
            case_started = time.monotonic()
            drift = verification_drift(classifier.predict(**case)["probabilities"], reference)
            logger.info("verification: question={!r}, drift={:.3f}, elapsed={:.1f}s", case["question"], drift, time.monotonic() - case_started)
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
        logger.info("prediction: started question_type={}, image={}, state_chars={}", question_type, "file" if image is not None else "base64" if image_base64 else "missing", len(state))
        if self._startup_logs:
            logger.info("startup: replaying {} setup log records", len(self._startup_logs))
            for message in self._startup_logs:
                logger.info("startup: {}", message)
            self._startup_logs.clear()
        if not question.strip():
            raise ValueError("question is required.")
        options = resolve_options(question_type, options_json)
        raw = None
        if image is None:
            if not image_base64:
                raise ValueError("Provide image or image_base64.")
            raw = decode_image_base64(image_base64)
        if image is not None and pathlib.Path(image).stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError("image must be 5 MB or smaller.")
        self._ensure_ready()
        if image is not None:
            result = self.classifier.predict(state=state, question=question, options=options,
                                             media=str(image), modality="image")
        elif image_base64:
            with tempfile.NamedTemporaryFile(suffix=".img") as tmp:
                assert raw is not None
                tmp.write(raw)
                tmp.flush()
                result = self.classifier.predict(state=state, question=question, options=options,
                                                 media=tmp.name, modality="image")
        output = format_output(result["probabilities"], options)
        logger.info("prediction: completed in {:.2f}s, answer={!r}, confidence={:.4f}", time.monotonic() - run_started, output["answer"], output["confidence"])
        return output

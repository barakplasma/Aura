"""Unit tests for the pure helpers in predict.py (no GPU, no cog, no weights).

Run: python3 -m unittest deploy/replicate/jev-omni/test_predict.py
"""
import base64
import importlib.util
import io
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

from loguru import logger

# predict.py imports cog, which only exists inside the Cog image; stub the
# three names it uses so the pure helpers load anywhere.
if "cog" not in sys.modules:
    cog = types.ModuleType("cog")
    cog.BasePredictor = object
    cog.Path = pathlib.Path
    cog.Input = lambda default=None, **_: default
    sys.modules["cog"] = cog

spec = importlib.util.spec_from_file_location("predict", pathlib.Path(__file__).with_name("predict.py"))
predict = importlib.util.module_from_spec(spec)
spec.loader.exec_module(predict)


class ResolveOptions(unittest.TestCase):
    def test_yes_no_ignores_options_json(self):
        self.assertEqual(predict.resolve_options("yes_no", '["a","b"]'), ["Yes", "No"])

    def test_choice_keeps_order_and_trims(self):
        self.assertEqual(predict.resolve_options("choice", '[" courier", "family ", "nobody"]'),
                         ["courier", "family", "nobody"])

    def test_choice_rejects_bad_input(self):
        for bad in ["not json", '"x"', '["only"]', '["a","a"]', '["a",""]', "[1,2]",
                    str([f"o{i}" for i in range(21)]).replace("'", '"')]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                predict.resolve_options("choice", bad)

    def test_unknown_question_type(self):
        with self.assertRaises(ValueError):
            predict.resolve_options("score", "[]")


class DecodeImage(unittest.TestCase):
    def test_plain_and_data_uri(self):
        raw = b"\xff\xd8\xff jpeg bytes"
        b64 = base64.b64encode(raw).decode()
        self.assertEqual(predict.decode_image_base64(b64), raw)
        self.assertEqual(predict.decode_image_base64("data:image/jpeg;base64," + b64), raw)

    def test_rejects_garbage_empty_and_oversize(self):
        for bad in ["!!!not base64!!!", "", base64.b64encode(b"x" * (predict.MAX_IMAGE_BYTES + 1)).decode()]:
            with self.subTest(n=len(bad)), self.assertRaises(ValueError):
                predict.decode_image_base64(bad)


class FormatOutput(unittest.TestCase):
    def test_matches_glance_replicate_shape(self):
        out = predict.format_output({"Yes": 0.93, "No": 0.07}, ["Yes", "No"])
        self.assertEqual(out["answer"], "Yes")
        self.assertAlmostEqual(out["confidence"], 0.93)
        self.assertEqual([p["label"] for p in out["probabilities"]], ["Yes", "No"])

    def test_verification_drift(self):
        self.assertAlmostEqual(predict.verification_drift({"a": 0.5, "b": 0.5}, {"a": 0.4, "b": 0.6}), 0.1)


class WeightsManifest(unittest.TestCase):
    def test_one_pinned_line_per_file(self):
        lines = predict.weights_manifest(pathlib.Path("/w")).splitlines()
        self.assertEqual(len(lines), len(predict.WEIGHT_FILES))
        for line, name in zip(lines, predict.WEIGHT_FILES):
            url, dest = line.split(" ")
            self.assertEqual(url, f"https://huggingface.co/akhilaaa3/Jev-Omni/resolve/{predict.REVISION}/{name}")
            self.assertEqual(dest, f"/w/{name}")

    def test_covers_hashed_files(self):
        self.assertTrue(set(predict.EXPECTED_SHA256) <= set(predict.WEIGHT_FILES))


class PgetLogging(unittest.TestCase):
    def test_child_output_is_relayed_through_loguru(self):
        sink = io.StringIO()
        sink_id = logger.add(sink, format="{message}", level="INFO")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                predict.run_pget(
                    pathlib.Path(tmp),
                    "https://example.com/weight /tmp/weight\n",
                    timeout_seconds=5,
                    command=[sys.executable, "-c", "import os,sys; sys.stdin.read(); sys.stdout.write('first progress\\rsecond progress\\r\\nmax_files=' + os.getenv('PGET_MAX_CONCURRENT_FILES', 'missing') + '\\nredirect_url=https://cdn.example/weights?signature=secret url=https://hf.example/weights\\n'); sys.stderr.write('stderr detail\\n'); sys.stdout.flush(); sys.stderr.flush()"],
                )
            self.assertIn("pget: first progress", sink.getvalue())
            self.assertIn("pget: second progress", sink.getvalue())
            self.assertIn("pget: max_files=1", sink.getvalue())
            self.assertIn("pget: stderr detail", sink.getvalue())
            self.assertIn("?<query redacted>", sink.getvalue())
            self.assertNotIn("signature=secret", sink.getvalue())
        finally:
            logger.remove(sink_id)

    def test_hard_deadline_terminates_silent_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(TimeoutError):
                predict.run_pget(
                    pathlib.Path(tmp), "manifest\n", timeout_seconds=0.1,
                    command=[sys.executable, "-c", "import sys,time; sys.stdin.read(); time.sleep(10)"],
                )

    def test_manifest_can_target_only_missing_files(self):
        line = predict.weights_manifest(pathlib.Path("/w"), ["model.safetensors"])
        self.assertEqual(
            line,
            f"https://huggingface.co/{predict.MODEL_ID}/resolve/{predict.REVISION}/model.safetensors /w/model.safetensors\n",
        )

    def test_initialization_failure_disables_automatic_retries(self):
        predictor = predict.Predictor()
        predictor.classifier = None
        predictor._init_error = RuntimeError("synthetic failure")
        with self.assertRaisesRegex(RuntimeError, "automatic retry disabled"):
            predictor._ensure_ready()

    def test_setup_trace_is_replayed_into_prediction_logs(self):
        predictor = predict.Predictor()
        with mock.patch.object(predictor, "_ensure_ready", side_effect=lambda: logger.info("weights ready")):
            predictor.setup()
        sink = io.StringIO()
        sink_id = logger.add(sink, format="{message}", level="INFO")
        try:
            with self.assertRaisesRegex(ValueError, "question is required"):
                predictor.run(question="", image_base64="")
        finally:
            logger.remove(sink_id)
        self.assertIn("startup: weights ready", sink.getvalue())

    def test_invalid_image_is_rejected_before_prediction_work(self):
        predictor = predict.Predictor()
        with mock.patch.object(predictor, "_ensure_ready"):
            predictor.setup()
        with mock.patch.object(predictor, "_ensure_ready", side_effect=AssertionError("should not initialize")):
            with self.assertRaisesRegex(ValueError, "valid base64"):
                predictor.run(question="What is shown?", image_base64="not base64")


if __name__ == "__main__":
    unittest.main()

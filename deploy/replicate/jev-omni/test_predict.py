"""Unit tests for the pure helpers in predict.py (no GPU, no cog, no weights).

Run: python3 -m unittest deploy/replicate/jev-omni/test_predict.py
"""
import base64
import importlib.util
import pathlib
import sys
import types
import unittest

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


if __name__ == "__main__":
    unittest.main()

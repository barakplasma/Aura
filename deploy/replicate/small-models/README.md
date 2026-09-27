# CPU Replicate prototypes

These endpoints are experimental CPU ports of the two small vision models
being considered for Aura. They use Replicate's `cpu` hardware class (4 vCPU,
8 GB RAM), not the 2 GB `cpu-small` class. They are not published yet: first
run the model-specific smoke tests on a Replicate worker and check cold-start
and warm latency. Neither endpoint should be treated as calibrated until its
scores are compared with the upstream implementation.

Both expose `question`, `image`, `image_base64`, `question_type`, and
`options_json`. Decider returns calibrated option probabilities. Qwen returns
the selected answer only; its `confidence` is null and `probabilities` is
empty, because inventing a calibrated score from a generative response would
be misleading.

The original BF16 weights are about 4.1 GB for decider-2b-vision. A CPU
worker may fit that with low context and one request at a time, but there is
little RAM margin; if it OOMs or is too slow, use a GPU-backed endpoint or a
GGUF/llama.cpp port after confirming its multimodal scoring preserves the
decider readout. Qwen3-VL-2B is loaded from the official Q4_K_M GGUF plus its
Q8 vision projector, about 1.56 GB of weights; it is the stronger CPU-fit
candidate.

## Layout and push

One Cog project, two models: `predict_decider.py` and `predict_qwen.py` share
Aura's input contract and its validation through `aura_io.py`, and each has its
own config (`cog.decider.yaml`, `cog.qwen.yaml`) and requirements file.

```sh
cd deploy/replicate/small-models
cog push -f cog.decider.yaml r8.im/barakplasma/decider-2b-vision
cog push -f cog.qwen.yaml r8.im/barakplasma/qwen3-vl-2b
```

`.github/workflows/replicate-small-models.yml` runs exactly that when this
directory changes. It first creates `barakplasma/decider-2b-vision` and
`barakplasma/qwen3-vl-2b` as public CPU models if they don't exist:
Replicate's hardware is fixed when a model is created.

## Evaluation for Aura

Use the same fixed camera frames and identical yes/no alert questions in Aura's
Eval screen. Include positive and negative examples, small/occluded objects,
lighting changes, and repeated frames. Record accuracy, false-alert rate,
miss rate, p50/p95 latency, cold-start time, and per-run cost separately.
Compare against Aura's current browser default (SmolVLM2-500M) and the
manual-only Qwen3-VL-2B browser model. Decider is not currently a browser
model; it needs a verified Transformers.js export before that comparison.

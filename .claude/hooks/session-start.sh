#!/bin/bash
# SessionStart hook for Claude Code on the web: install everything `npm test`,
# `npm run build` and `npm run lint` need, so a fresh cloud session can run
# them straight away. Local sessions are left alone.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# `npm install` rather than `npm ci`: it reuses the node_modules the container
# caches after this hook, so later sessions only fetch what changed.
# --onnxruntime-node-install=skip: onnxruntime-node (a transitive dependency
# of @huggingface/transformers) downloads native binaries from GitHub in its
# postinstall, which fails behind the web sandbox's proxy. Those are extra
# execution-provider binaries (e.g. CUDA); the CPU ones ship inside the npm
# package, so Node-side scripts such as dev-tokenizer-probe.mjs still work.
# Only that one download is skipped; every other install script still runs.
npm install --no-audit --no-fund --onnxruntime-node-install=skip

# djlint (the HTML linter `npm run lint:html` and MegaLinter use) is Python.
if ! command -v djlint >/dev/null 2>&1; then
  pip install --quiet --disable-pip-version-check djlint
fi

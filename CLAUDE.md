# CLAUDE.md

Guidance for working in this repo. Read this before changing code.

## What Aura is

An **automated visual monitoring PWA** that runs entirely in the browser. A phone/webcam streams frames; each scan cycle calls a vision model with a **detection** prompt and, if the alert fires, an **action** prompt that generates a spoken announcement. Two scan engines, chosen via `aura.engine`:

- **PROVIDER** (default) — an OpenAI-compatible vision model (Cerebras, OpenAI, Groq, a local server, etc.), called with the user's own API key — no backend, no secrets.
- **BROWSER** — a small vision-language model run entirely client-side via Transformers.js/WebGPU. No key, no server, no CORS; the frame never leaves the device. The model is picked from a table (`lib/browser-models.js`); the reference device is a Pixel 10 in Chrome. See `lib/browser-engine.js` and `src/workers/ml.worker.js`.

Both return the exact same result shape from `scanClient()` / `scanBrowser()`, so `useMonitor`, telemetry, history, and the eval screen don't care which one is active.

```text
camera frame → 640x480 JPEG → detection call (user's provider + model)
                                     |
                         triggered AND confidence ≥ threshold ?
                          no |                    | yes
                             ▼                    ▼
                       "Watching…"          action call (user's provider)
                                            → speak + vibrate + flash + log + webhook
```

## Architecture

React SPA built with esbuild (`scripts/build-react.js`): `src/main.jsx` → minified,
code-split ESM bundles in `public/assets/` (with linked sourcemaps). `src/aura.css`
is copied to `public/aura.css` by the build — edit the `src/` copy only.

| Path                              | Role                                                                                                                       |
|-----------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `src/App.jsx`                     | Screen routing, settings (localStorage), demo-mode state, camera stage mode                                                |
| `src/components/MonitorStage.jsx` | Always-mounted `<video>`/`<canvas>` stage — full / collapsed / PiP / parked modes so scanning survives tab switches        |
| `src/screens/`                    | MissionScreen, MonitorScreen (controls panel), HistoryScreen, OptimizeScreen + EvalScreen (lazy-loaded), SettingsScreen    |
| `src/hooks/useMonitor.js`         | Camera capture + scan loop + alert delivery + telemetry                                                                    |
| `src/aura.css`                    | Dark "tactical" theme + responsive layout (portrait/landscape breakpoints)                                                 |
| `src/monitoring.js`               | Initializes Bugsink (Sentry-compatible) error tracking; imported first in `main.jsx`                                       |
| `public/index.html`               | Tiny shell: mounts `#root`, loads `assets/app.js`                                                                          |
| `public/feedback.js`              | Web Speech + Web Vibration                                                                                                 |
| `lib/aura.js`                     | PROVIDER engine: `scanClient()` calls the configured provider directly, `fetchModels()` lists models                       |
| `lib/monitor.js`                  | Pure functions: prompt builders, JSON parsers, usage normalization (used by aura.js + browser-engine.js + tests)           |
| `lib/browser-engine.js`           | BROWSER engine facade: `scanBrowser()`, owns `src/workers/ml.worker.js`'s lifecycle; re-exports the model table            |
| `lib/browser-models.js`           | `BROWSER_MODELS` table + `pickBrowserModel()` / `probeBrowserEnv()` — pure, Node-testable, no Worker or DOM                |
| `src/workers/ml.worker.js`        | Runs the selected VLM via Transformers.js/WebGPU — the ONLY file that imports `@huggingface/transformers`                  |
| `lib/model-size.js`               | Best-effort total download size for a BROWSER model (Hub file-tree lookup), used only by ml.worker.js                      |
| `lib/download-progress.js`        | Aggregates per-file download progress into one running, monotonic percentage, used only by ml.worker.js                    |
| `lib/demo.js`                     | Demo mode: deterministic simulated scans (never emits webhooks)                                                            |
| `lib/eval.js`                     | Prompt-evaluation engine: expands the image × model × prompt matrix, runs detection-only scans, scores results             |
| `lib/eval-store.js`               | IndexedDB persistence for eval sample images + last run (async adapter, in-memory impl for tests)                          |
| `lib/training-store.js`           | localStorage persistence for training examples/artifacts (no ax import)                                                    |
| `lib/training.js`                 | ax/GEPA optimization — only ever loaded via dynamic `import()`                                                             |
| `test/`                           | Unit tests for monitor.js/browser-engine.js/browser-models.js/model-size.js/download-progress.js helpers, demo.js, and scanClient validation |

Two dependencies are kept out of the main bundle by the same pattern — a
module that's never statically reachable from `App.jsx`, only loaded lazily
or from within a dedicated worker:

- `@ax-llm/ax`: nothing statically imported by `App.jsx` may import
  `lib/training.js` (that's why the training-example store is a separate
  module, `lib/training-store.js`) — `OptimizeScreen.jsx` reaches it only via
  a dynamic `import()`.
- `@huggingface/transformers`: only `src/workers/ml.worker.js` may import it.
  `lib/browser-engine.js` (statically imported — it's the BROWSER engine's
  main-thread facade) talks to that worker purely by `postMessage`, spawned
  from a plain script URL (`assets/ml.worker.js`, resolved against
  `document.baseURI`) — never `new URL(import.meta.url, ...)`, which would
  make esbuild inline the worker's whole dependency graph into the main
  bundle. `scripts/build-react.js` builds it as a second, separate esbuild
  entry point for exactly this reason. After any change here, verify with
  `npm run build && grep -c '@huggingface/transformers' public/assets/app.js`
  — it must be `0`.

## Commands

```bash
npm run build             # esbuild: minify + code-split src/ → public/assets/
npm run dev               # npx serve public → http://localhost:3000
npm test                  # node --test
npm run deploy            # Build + gh-pages -d public
```

## Provider format

Users configure three fields in the UI, stored in localStorage:

- `aura.baseUrl` — e.g. `https://api.cerebras.ai/v1` or `http://localhost:11434/v1`
- `aura.apiKey` — user's provider API key; **blank is valid** (local servers need none)
- `aura.model` — model name, e.g. `gemma-4-31b`

`scanClient()` calls `POST {baseUrl}/chat/completions` with the OpenAI schema.
`fetchModels()` calls `GET {baseUrl}/models` to list available models.
Base URL + model are what "configured" means — never gate the UI on the API key.
`Authorization` is omitted entirely when the key is blank.

## Conventions

- ES modules, React 19 + JSX in `src/`, plain browser JS in `lib/`, 2-space indent.
- Match the surrounding comment density and naming.
- All AI logic must be browser-compatible (uses `fetch`, `AbortController`, no Node APIs).
- After changing the engine, add/extend a test in `test/`.
- A BROWSER model is a **row in `lib/browser-models.js`, not a branch**. transformers.js
  is not consistent across VLM families — processor argument order, chat-template
  shape, which options are per-call vs. read off the image processor's own config —
  so those differences travel to the worker as a `recipe` on the `load` message.
  Adding a model means adding a row; if it needs a `if (modelId.includes(...))` in
  `ml.worker.js`, the descriptor is missing a field.
- A row's `promptProfile` decides which prompts it gets: `json` models take the same
  `buildDetectionPrompt()`/`buildActionPrompt()` as the PROVIDER engine; `compact`
  models (SmolVLM2 256M) get the short positional prompts, because handed a JSON
  schema they paraphrase it back rather than answering it.
- A row is only `autoSelectable` if `pickBrowserModel()` may hand it to someone who
  never opened Settings. Anything whose download needs a deliberate yes stays
  `false` and is picked manually.
- There is no silent mock: a misconfigured or unreachable provider throws. A blank
  API key is *not* misconfiguration — it's the normal local-server setup, and the
  request goes out for real. Demo mode is the only simulated path: explicit opt-in
  (TRY DEMO on the Monitor screen), isolated in `lib/demo.js`, clearly bannered
  while active, and never fires webhooks.
- Don't commit secrets. The API key stays in the user's localStorage.
- `public/sw.js` is **generated** by `npm run build` (and gitignored — it isn't in
  a fresh clone until you build) — edit `scripts/sw-template.js`.
  It caches the app shell only, so the PWA boots offline against a local model. It
  must never intercept anything but same-origin `GET`s: provider calls and webhooks
  always go straight to the network.
- Most of `public/assets/*.js` is committed build output (unlike `sw.js`), but
  `public/assets/ml.worker.js`(`.map`) and `public/ort/` are gitignored like
  `sw.js` — both the CI deploy workflow and `npm run dev` build fresh, so
  nothing depends on them being committed, and the minified worker bundle
  happens to embed a Hugging Face gist URL whose hex id collides with
  GitHub's secret-scanning pattern for a Mistral API key, which blocks the
  push outright. Run `npm run build` after cloning before `npm run dev` if
  you're not using the `predev` hook that already does this.

## Limitations

- Provider must support OpenAI-compatible `/v1/chat/completions` with vision. JSON
  mode is preferred but optional — a server that rejects `response_format` gets one
  retry without it, remembered for the session.
- Provider must support CORS (most do, incl. Cerebras, Groq). Local servers need it
  switched on: `OLLAMA_ORIGINS`, `llama-server --cors`.
- An HTTPS deployment can't reliably reach `http://localhost` (Chrome's Private
  Network Access preflight) — offline use means serving the app locally too.
- iOS Safari has no Vibration API — haptics disabled there.
- Speech/vibration require a secure context (HTTPS or localhost).
- Cost is estimated from token usage returned by the provider (always `0` for BROWSER).
- BROWSER engine: needs WebGPU for a usable cadence (falls back to WASM, which is
  10-30s/scan). Even the best row in the table is not a substitute for a strong
  cloud model — the eval screen exists to measure that trade-off.
- ORT's default WebGPU device uses the spec *minimum* limits (128 MB
  `maxStorageBufferBindingSize`), and transformers.js doesn't raise them.
  `ml.worker.js`'s `useAdapterLimits()` requests a device with the adapter's own
  limits before the first session, or a larger model silently drops to WASM and
  looks like "no WebGPU here". It must stay ahead of the first `from_pretrained`,
  and reading `env.backends.onnx.webgpu.device` is itself device-creating — don't.
- Prompt optimization (OPTIMIZE screen) is PROVIDER-only. `@ax-llm/ax` drives HTTP
  providers and cannot reach a model running inside the page, so `App.jsx` hides
  the screen and `useMonitor` withholds the GEPA artifact when `aura.engine` is
  `browser`. Few-shot examples still apply — `lib/training-store.js` imports no ax.

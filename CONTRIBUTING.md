# Contributing to Aura

Everything with a command in it lives here: running Aura yourself, pointing it at a
model, hacking on it, shipping it. For *what Aura is for*, see
[README.md](./README.md); for architecture and conventions, see
[CLAUDE.md](./CLAUDE.md).

Aura is a static PWA — a React SPA built with esbuild into `public/`. There is no
backend, no database and no server-side anything, which makes the dev loop short.

## Prerequisites

- **Node.js ≥ 18** (the repo's CI uses 20). Nothing else.
- A browser with camera access. For the in-browser engine, one with **WebGPU**
  (Chrome on desktop or Android); without it that engine falls back to WASM and
  gets much slower.
- A secure context: speech and vibration need HTTPS *or* `localhost`.

## Quick start

```bash
npm install
npm run build              # esbuild: minify + code-split src/ → public/assets/
npm run dev                # → http://localhost:3000  (predev rebuilds for you)
npm test                   # node --test
```

Run `npm run build` at least once after cloning. Three things under `public/` are
**generated and gitignored**, so a fresh clone doesn't have them until you build:
`public/sw.js`, `public/assets/ml.worker.js(.map)` and `public/ort/`. The `predev`
hook covers this if you go straight to `npm run dev`.

| Command          | What it does                                                                                                                            |
|------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `npm run build`  | Builds `src/main.jsx` and `src/workers/ml.worker.js`, copies `src/aura.css` and ONNX Runtime's WASM files, generates the service worker |
| `npm run dev`    | Serves `public/` (rebuilds first via `predev`)                                                                                          |
| `npm test`       | Unit tests for the pure `lib/` helpers — no DOM, no network                                                                             |
| `npm run deploy` | Builds and pushes `public/` to the `gh-pages` branch                                                                                    |

## Pointing it at a model

Aura needs an inference source before it will do anything. Pick one.

### A hosted provider

In **Settings → Provider**:

1. **Base URL** — the OpenAI-compatible endpoint, e.g. `https://api.cerebras.ai/v1`
2. **API key** — your key. It's stored in `localStorage` and sent only to that base
   URL. Blank is valid (see local servers below).
3. **Model** — press **FETCH MODELS** to list what the endpoint offers
   (`GET /v1/models`), or type a name.

Any API implementing `POST /v1/chat/completions` with vision works: Cerebras,
OpenAI, Groq, Together, Fireworks, OpenRouter, a gateway of your own. Two
requirements the provider has to meet:

- **CORS**, since the browser calls it directly. Most hosted providers allow it.
- JSON mode is *preferred, not required* — a server that rejects `response_format`
  gets one automatic retry without it, remembered for the session.

### No key at all: demo mode

Press **TRY DEMO** on the Monitor screen for deterministic simulated scans. It
exercises the camera, speech, vibration and alert log with no provider configured,
never fires webhooks, and is bannered while active. It is the only simulated path in
the app — a misconfigured real provider throws rather than pretending.

### A local server

Any local OpenAI-compatible server with vision works; it just has to allow
cross-origin requests from wherever the app is served:

```bash
# Ollama
ollama pull qwen2.5vl
OLLAMA_ORIGINS='*' ollama serve                  # → http://localhost:11434/v1

# llama.cpp
llama-server -m your-vision-model.gguf --cors    # → http://localhost:8080/v1

# LM Studio — load a vision model, start the local server,
# and enable CORS in the server settings.        → http://localhost:1234/v1
```

Then in **Settings → Provider** press the **OLLAMA** / **LM STUDIO** / **LLAMA.CPP**
preset (which also zeroes the cost rate), **leave the API key blank** — no
`Authorization` header is sent when it's empty — and **FETCH MODELS**.

Two gotchas:

- Prefer `localhost` or `127.0.0.1` over `0.0.0.0` in the base URL; browsers block
  `0.0.0.0` as a request target.
- **Serve the app locally too.** The HTTPS GitHub Pages deployment can't reliably
  reach `http://localhost`: Chrome gates requests from a public HTTPS page to a
  local server behind a Private Network Access preflight that these servers don't
  answer. Running both on the same machine avoids the problem entirely.

### In the browser itself

In **Settings → Provider**, switch **ENGINE** to **BROWSER**, then
**DOWNLOAD / LOAD** the model. Progress is shown; weights are cached by the browser
afterwards, so it happens once, and works offline after that. **TEST ON CURRENT
FRAME** runs a single scan before you arm; **CLEAR MODEL CACHE** frees the weights.

The model is picked from a table (`lib/browser-models.js`) based on what the device
can actually run — the default is LFM2.5-VL 450M, with FastVLM 0.5B as an opt-in
upgrade and SmolVLM2 256M as the no-WebGPU floor. Cost is always `$0`; there's no
provider to bill. Nothing about the scan leaves the device — the only network
traffic is the one-time model download from Hugging Face.

Use the **Evaluate** screen to compare it against your hosted provider on your own
sample frames before trusting it for a given camera.

## Running fully offline

`npm run build` generates `public/sw.js`, a service worker that precaches the app
shell (HTML, CSS, icons, every JS chunk) so the installed PWA boots with the network
off. It only ever intercepts same-origin `GET` requests — provider calls and webhooks
always go straight to the network and are never cached. Each build stamps a new
version, so a redeploy replaces the cached shell on the next visit.

Combine the cached shell with either the BROWSER engine or a local server and Aura
runs with no internet at all.

One cosmetic caveat: UI fonts come from Google Fonts, so offline they fall back to
system monospace and sans-serif. Layout is unaffected — only the typeface changes.

## Leaving it armed for hours

Aura is meant to be propped on a shelf and left running, and tries to survive the
usual interruptions. What it recovers from depends on the platform:

- **Backgrounding (app switch, lock screen, a phone call).** With **KEEP SCREEN ON**
  (Settings → Camera, on by default) Aura holds a screen wake lock while armed, so an
  Android screen won't dim and lock. If the tab is hidden anyway the browser throttles
  the scan loop without stopping it, and the status line says so; returning to the tab
  fires an immediate scan if the gap overran. If the OS reclaims the camera, Aura
  detects the lost or muted track and reconnects, retrying three times before giving
  up with "Camera lost — tap ARM to retry".
- **A reload** (a killed PWA, a pull-to-refresh, a redeploy) loses the live stream —
  nothing can carry a `MediaStream` across a page load. What survives is the decision
  to be armed: if the app was armed within the last 12 hours, a **RESUME MONITORING**
  banner re-arms in one tap. One tap and not automatic, because `getUserMedia` and
  speech synthesis both need a real user gesture on Safari. Alert history, missed
  frames and FALSE POSITIVE/NEGATIVE marks persist to IndexedDB as they happen
  (capped at 200 alerts and 4 recent frames), so they're intact either way.
- **iOS Safari cannot be made to background-monitor.** Safari suspends camera access
  for hidden pages and there is no Wake Lock workaround; a locked or backgrounded
  iPhone stops scanning, full stop. Speech is also blocked on a re-arm until the next
  tap, and the Vibration API doesn't exist there at all.

## Project layout

```text
src/
  main.jsx                Entry point (imports monitoring.js first)
  App.jsx                 Screen routing, settings, demo mode, camera stage mode
  aura.css                Dark "tactical" theme (edit this copy, not public/aura.css)
  monitoring.js           Bugsink (Sentry-compatible) error tracking
  components/             MonitorStage (always-mounted video/canvas), NavRail, ...
  screens/                Mission, Monitor, History, Optimize, Eval, Settings
  hooks/useMonitor.js     Camera capture + scan loop + alert delivery + telemetry
  workers/ml.worker.js    Runs the in-browser VLM — the ONLY file importing
                          @huggingface/transformers (kept out of the main bundle)
lib/
  aura.js                 PROVIDER engine: scanClient(), fetchModels()
  browser-engine.js       BROWSER engine facade: scanBrowser(), worker lifecycle
  browser-models.js       Model table + device-based picker (pure, testable)
  monitor.js              Prompt builders, JSON parsers, usage normalization
  eval.js / eval-store.js Prompt evaluation matrix + IndexedDB persistence
  training.js             ax/GEPA optimization (only ever dynamically imported)
  ...                     demo, scheduler, stats, alert-store, frame, keepalive
public/                   Deployed as-is: index.html, aura.css, icons, assets/
scripts/
  build-react.js          esbuild build + service worker generation
  sw-template.js          Source of the generated public/sw.js
  gen-icons.js            PWA icon generation
test/                     node --test unit tests for the pure lib/ helpers
docs/                     Design documents (PRDs) for the larger features
```

## Conventions worth knowing before you open a PR

Full details are in [CLAUDE.md](./CLAUDE.md) — the short version:

- ES modules, React 19 + JSX in `src/`, plain browser JS in `lib/`, 2-space indent.
  Match the surrounding comment density and naming.
- Everything in `lib/` must be browser-compatible (`fetch`, `AbortController`, no
  Node APIs) and, where it's pure, testable under `node --test` with no DOM.
- **Two dependencies must stay out of the main bundle**: `@huggingface/transformers`
  (only `src/workers/ml.worker.js` may import it) and `@ax-llm/ax` (only reachable
  through a dynamic `import()` of `lib/training.js`). After touching either area:

  ```bash
  npm run build && grep -c '@huggingface/transformers' public/assets/app.js   # must be 0
  ```

- An in-browser model is **a row in `lib/browser-models.js`, not a branch**. If a new
  model needs an `if (modelId.includes(...))` in `ml.worker.js`, the descriptor is
  missing a field.
- After changing an engine, add or extend a test in `test/`.
- Edit `src/aura.css` and `scripts/sw-template.js` — `public/aura.css` and
  `public/sw.js` are generated.
- Don't commit secrets. API keys stay in the user's `localStorage`.

## Tests and linting

```bash
npm test                   # the whole suite; fast, no network
```

CI runs the same tests plus [MegaLinter](https://megalinter.io) on every push. The
linter reports findings in a PR comment rather than failing the build
(`DISABLE_ERRORS: true` in `.mega-linter.yml`), but please read it — markdown, YAML,
JSON, CSS and GitHub Actions are all checked, and it auto-commits formatting fixes on
pushes to the repo's own branches.

## Deploying

Pushing to `main` triggers the GitHub Actions workflow in
`.github/workflows/deploy.yml`, which runs the tests, builds, and publishes `public/`
to GitHub Pages.

To deploy manually from a working copy:

```bash
npm run deploy             # build + gh-pages -d public
```

Then set **GitHub Pages → Source: gh-pages branch** in the repository settings.

## Proposing something larger

Features that change the scan loop, add a model family or touch persistence get a
short PRD in [`docs/`](./docs) first — see the existing ones for the shape (problem,
goals, non-goals, design with diagrams, telemetry, settings, files, tests,
acceptance). It's much cheaper to argue about a design in markdown than in a
half-finished branch.

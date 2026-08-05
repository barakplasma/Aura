# CLAUDE.md

Guidance for working in this repo. Read this before changing code.

## What Aura is

An **automated visual monitoring PWA** that runs entirely in the browser. A phone/webcam streams frames; each scan cycle calls an OpenAI-compatible vision model (Cerebras, OpenAI, Groq, etc.) with a **detection** prompt and, if the alert fires, an **action** prompt that generates a spoken announcement. The user provides their own API key — no backend, no secrets.

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

| Path                              | Role                                                                                                                    |
|-----------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| `src/App.jsx`                     | Screen routing, settings (localStorage), demo-mode state, camera stage mode                                             |
| `src/components/MonitorStage.jsx` | Always-mounted `<video>`/`<canvas>` stage — full / collapsed / PiP / parked modes so scanning survives tab switches     |
| `src/screens/`                    | MissionScreen, MonitorScreen (controls panel), HistoryScreen, OptimizeScreen + EvalScreen (lazy-loaded), SettingsScreen |
| `src/hooks/useMonitor.js`         | Camera capture + scan loop + alert delivery + telemetry                                                                 |
| `src/aura.css`                    | Dark "tactical" theme + responsive layout (portrait/landscape breakpoints)                                              |
| `src/monitoring.js`               | Initializes Bugsink (Sentry-compatible) error tracking; imported first in `main.jsx`                                    |
| `public/index.html`               | Tiny shell: mounts `#root`, loads `assets/app.js`                                                                       |
| `public/feedback.js`              | Web Speech + Web Vibration                                                                                              |
| `lib/aura.js`                     | Browser engine: `scanClient()` calls provider directly, `fetchModels()` lists models                                    |
| `lib/monitor.js`                  | Pure functions: prompt builders, JSON parsers, usage normalization (used by aura.js + tests)                            |
| `lib/demo.js`                     | Demo mode: deterministic simulated scans (never emits webhooks)                                                         |
| `lib/eval.js`                     | Prompt-evaluation engine: expands the image × model × prompt matrix, runs detection-only scans, scores results          |
| `lib/eval-store.js`               | IndexedDB persistence for eval sample images + last run (async adapter, in-memory impl for tests)                       |
| `lib/training-store.js`           | localStorage persistence for training examples/artifacts (no ax import)                                                 |
| `lib/training.js`                 | ax/GEPA optimization — only ever loaded via dynamic `import()`                                                          |
| `test/`                           | Unit tests for monitor.js helpers, demo.js, and scanClient validation                                                   |

Keep `@ax-llm/ax` out of the main bundle: nothing statically imported by `App.jsx`
may import `lib/training.js` (that's why the store is a separate module).

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
- Cost is estimated from token usage returned by the provider.

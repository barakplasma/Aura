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

| Path                              | Role                                                                                                                |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `src/App.jsx`                     | Screen routing, settings (localStorage), demo-mode state, camera stage mode                                         |
| `src/components/MonitorStage.jsx` | Always-mounted `<video>`/`<canvas>` stage — full / collapsed / PiP / parked modes so scanning survives tab switches |
| `src/screens/`                    | MissionScreen, MonitorScreen (controls panel), HistoryScreen, OptimizeScreen and EvalScreen (lazy-loaded), SettingsScreen |
| `src/hooks/useMonitor.js`         | Camera capture + scan loop + alert delivery + telemetry                                                             |
| `src/aura.css`                    | Dark "tactical" theme + responsive layout (portrait/landscape breakpoints)                                          |
| `src/monitoring.js`               | Initializes Bugsink (Sentry-compatible) error tracking; imported first in `main.jsx`                                |
| `public/index.html`               | Tiny shell: mounts `#root`, loads `assets/app.js`                                                                   |
| `public/feedback.js`              | Web Speech + Web Vibration                                                                                          |
| `lib/aura.js`                     | Browser engine: `scanClient()` calls provider directly, `fetchModels()` lists models                                |
| `lib/eval.js`                     | Pure prompt/model evaluation engine: matrix expansion, run loop, scoring                                            |
| `lib/eval-store.js`               | IndexedDB persistence for eval images and last run, with injectable test adapter                                    |
| `lib/monitor.js`                  | Pure functions: prompt builders, JSON parsers, usage normalization (used by aura.js + tests)                        |
| `lib/demo.js`                     | Demo mode: deterministic simulated scans (never emits webhooks)                                                     |
| `lib/training-store.js`           | localStorage persistence for training examples/artifacts (no ax import)                                             |
| `lib/training.js`                 | ax/GEPA optimization — only ever loaded via dynamic `import()`                                                      |
| `test/`                           | Unit tests for monitor.js helpers, demo.js, and scanClient validation                                               |

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

- `aura.baseUrl` — e.g. `https://api.cerebras.ai/v1`
- `aura.apiKey` — user's provider API key
- `aura.model` — model name, e.g. `gemma-4-31b`

`scanClient()` calls `POST {baseUrl}/chat/completions` with the OpenAI schema.
`fetchModels()` calls `GET {baseUrl}/models` to list available models.

## Conventions

- ES modules, React 19 + JSX in `src/`, plain browser JS in `lib/`, 2-space indent.
- Match the surrounding comment density and naming.
- All AI logic must be browser-compatible (uses `fetch`, `AbortController`, no Node APIs).
- After changing the engine, add/extend a test in `test/`.
- No API key means `scanClient()` throws — there is no silent mock. Demo mode is
  explicit opt-in (TRY DEMO on the Monitor screen), isolated in `lib/demo.js`,
  clearly bannered while active, and never fires webhooks.
- Don't commit secrets. The API key stays in the user's localStorage.
- Don't add an offline service worker — the app needs the network for API calls.

## Limitations

- Provider must support OpenAI-compatible `/v1/chat/completions` with vision + `response_format: json_object`.
- Provider must support CORS (most do, incl. Cerebras, Groq).
- iOS Safari has no Vibration API — haptics disabled there.
- Speech/vibration require a secure context (HTTPS or localhost).
- Cost is estimated from token usage returned by the provider.

# CLAUDE.md

Guidance for working in this repo. Read this before changing code.

## What Aura is

An **automated visual monitoring PWA** that runs entirely in the browser. A phone/webcam streams frames; each scan cycle calls an OpenAI-compatible vision model (Cerebras, OpenAI, Groq, etc.) with a **detection** prompt and, if the alert fires, an **action** prompt that generates a spoken announcement. The user provides their own API key — no backend, no secrets.

```
camera frame → 640x480 JPEG → detection call (user's provider + model)
                                     |
                         triggered AND confidence ≥ threshold ?
                          no |                    | yes
                             ▼                    ▼
                       "Watching…"          action call (user's provider)
                                            → speak + vibrate + flash + log + webhook
```

## Architecture

| Path | Role |
|---|---|
| `public/index.html` | MD3 Material Design UI with web components |
| `public/app.js` | Camera capture + scan loop + alert delivery + telemetry |
| `public/aura.bundle.js` | Bundled engine: `scanClient()`, `fetchModels()`, training |
| `public/material.bundle.js` | Bundled MD3 web components |
| `public/material-theme.css` | MD3 dark theme tokens + custom styles |
| `public/feedback.js` | Web Speech + Web Vibration |
| `lib/aura.js` | Browser engine: `scanClient()` calls provider directly, `fetchModels()` lists models |
| `lib/monitor.js` | Pure functions: prompt builders, JSON parsers, usage normalization (used by aura.js + tests) |
| `lib/training.js` | ax/GEPA example management and optimization |
| `test/monitor.test.js` | Unit tests for pure functions in monitor.js |

## Commands

```bash
npm run build             # Build material bundle + aura bundle
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

- ES modules, vanilla browser JS (no framework), 2-space indent.
- Match the surrounding comment density and naming.
- All AI logic must be browser-compatible (uses `fetch`, `AbortController`, no Node APIs).
- After changing the engine, add/extend a test in `test/monitor.test.js`.
- The mock path (no API key) cycles through normal/alert states deterministically.
- Don't commit secrets. The API key stays in the user's localStorage.
- Don't add an offline service worker — the app needs the network for API calls.

## Limitations

- Provider must support OpenAI-compatible `/v1/chat/completions` with vision + `response_format: json_object`.
- Provider must support CORS (most do, incl. Cerebras, Groq).
- iOS Safari has no Vibration API — haptics disabled there.
- Speech/vibration require a secure context (HTTPS or localhost).
- Cost is estimated from token usage returned by the provider.

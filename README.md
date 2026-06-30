# Aura

**Team Members:** @barakplasma

**Live app:** [barakplasma.github.io/Aura](https://barakplasma.github.io/Aura/) &nbsp;·&nbsp; **Repo:** [github.com/barakplasma/Aura](https://github.com/barakplasma/Aura)

Aura turns any phone or laptop webcam into an automated visual monitor. Bring your own API key from any OpenAI-compatible vision provider (Cerebras, OpenAI, Groq, Together, etc.) and set a mission — what to watch for. Aura runs a two-stage detect→act loop entirely in the browser.

```
camera frame → 640×480 JPEG → detection call (your provider + model)
                                      |
                               triggered ?
                           no  |         |  yes
                               ▼         ▼
                         "Watching…"   action call → speak + vibrate + flash + webhook
```

No backend. Your API key stays in localStorage and goes directly to the provider.

## Quick start

```bash
npm install && npm run build
npx serve public        # → http://localhost:3000
```

Or just open the [live app](https://barakplasma.github.io/Aura/) — no install needed.

## Usage

1. **Settings** — enter Base URL (e.g. `https://api.cerebras.ai/v1`), API key, and model (or click Fetch Models)
2. **Mission** — describe what to watch for and what to announce on alert
3. **Monitor** → press **ARM SENTRY** — camera starts, scan loop runs

No API key → mock mode cycles through normal/alert states so you can test speech, vibration, webhook, and history without any backend.

## Features

| | |
|---|---|
| **Any vision provider** | OpenAI-compatible `/v1/chat/completions` — Cerebras, Groq, Together, Fireworks, OpenAI, etc. |
| **Model discovery** | Fetches model list from `GET /v1/models` |
| **Example-driven triggers** | Add detection examples in Optimize; the model learns when to fire — no manual threshold tuning |
| **ax/GEPA optimization** | Optimize detection/action prompts from your examples with one click |
| **Text-to-speech** | Web Speech API — speaks the action prompt aloud on alert |
| **Vibration** | Web Vibration API (disabled on iOS Safari) |
| **Webhook** | POST/GET/PUT/PATCH to any URL with custom headers and JSON schema |
| **Alert history** | Last 20 alerts with timestamp and confidence |
| **Cost tracking** | Cumulative token count and estimated cost |
| **PWA** | Installable on mobile home screen, works offline in mock mode |

## Project layout

```
src/                        React source
  App.jsx                   Root — settings state + screen routing
  main.jsx                  Entry point
  aura.css                  DC dark theme (IBM Plex Mono, amber/green palette)
  hooks/useMonitor.js       Camera, scan loop, alert delivery
  components/               TopBar, NavRail
  screens/                  Mission / Monitor / History / Optimize / Settings
lib/
  aura.js                   scanClient(), fetchModels() — browser AI engine
  monitor.js                Pure functions: prompt builders, parsers, normalizers
  training.js               ax/GEPA example management and optimization
public/                     Static site (what gets deployed)
  index.html                React host page
  app.bundle.js             Built React app
  aura.css                  Dark theme
  feedback.js               Speech + vibration (Web APIs)
scripts/
  build-react.js            esbuild: src/main.jsx → public/app.bundle.js
test/
  monitor.test.js           Unit tests (node --test)
```

## Scripts

```bash
npm run build     # esbuild → public/app.bundle.js
npm run dev       # build + serve public/
npm test          # unit tests
npm run deploy    # build + push to gh-pages
```

## Responsible use

Aura points a camera at people. Only use it where you're authorised to record, inform people they're being monitored, and don't rely on it for safety-critical enforcement — it's an LLM making best-effort judgements from a single frame.

## License

GPL-3.0 — see [LICENSE](./LICENSE).

# Aura

**Team Members:** @barakplasma


**GitHub Repository:** [github.com/barakplasma/Aura](https://github.com/barakplasma/Aura)

Aura turns any phone or laptop with a webcam into an automated visual monitor. You provide your own API key and model from any OpenAI-compatible provider (Cerebras, OpenAI, Groq, Together, etc.). Set a mission prompt (what to watch for) and an action prompt (what to say via text-to-speech or send via webhook), and Aura runs a two-stage detect→act loop in your browser.

**No backend required.** This is a pure static PWA — your API key is stored in your browser's localStorage and sent directly to the provider. Nothing is proxied through a server.

```
[ camera frame ] → 640x480 JPEG → detection call (your provider + model)
                                       |
                          triggered AND confidence ≥ threshold ?
                           no |                       | yes
                              ▼                       ▼
                        "Watching…"              action call (your provider)
                                                 → speak + vibrate + flash + webhook
```

Most cycles are detection-only; the second call happens only on a real alert.

## Quick start

### 1. Host the app

Serve the `public/` directory with any static server:

```bash
npm install
npm run build
npx serve public
# → http://localhost:3000
```

### 2. Configure a provider

Open the app, then:

1. **Base URL** — the OpenAI-compatible API endpoint, e.g. `https://api.cerebras.ai/v1`
2. **API Key** — your provider key (stored in localStorage, never sent anywhere else)
3. **Model** — click **Fetch Models** to list available models, or type one manually

Supported providers include Cerebras, OpenAI, Groq, Together, Fireworks, and any API that implements the OpenAI `/v1/chat/completions` format with vision support.

### 3. Start monitoring

Enter a **Mission** (what to watch for) and **Action** (what to announce on alert), adjust sensitivity, and press **Start**. The first scan fires on the next tick.

### Features

| Feature | How |
|---|---|
| **Provider config** | Base URL, API key, model — any OpenAI-compatible vision model |
| **Model discovery** | Fetches available models from `GET /v1/models` |
| **Alert sensitivity** | Slider (10–95% confidence threshold) |
| **Scan interval** | 2–30 seconds |
| **Text-to-speech** | Built-in Web Speech API |
| **Vibration** | Web Vibration API (not available on iOS Safari) |
| **Webhook** | POST/GET/PUT/PATCH to any URL with custom headers and JSON body |
| **Training** | Add detection/action examples, optimize with ax/GEPA |
| **Cost tracking** | Cumulative token count and estimated cost |
| **PWA** | Installable on mobile home screen |

### No API key? No problem.

With no API key, Aura runs in **mock mode** — it cycles between normal/alert states so you can test the camera, speech, vibration, webhook, and alert log without any backend calls.

## Project layout

```
public/                   Static site (deploy this directory)
  index.html              MD3 UI with material web components
  app.js                  Camera capture + scan loop + alert delivery
  aura.bundle.js          Bundled engine (scanClient, training)
  material.bundle.js      Bundled @material/web components
  material-theme.css      MD3 dark theme + custom styles
  feedback.js             Speech + vibration feedback
  manifest.webmanifest    PWA manifest
  icons/                  Generated PWA icons
lib/
  aura.js                 Browser engine: scanClient(), fetchModels()
  monitor.js              Pure functions used by aura.js (prompts, parsers) + tests
  training.js             ax/GEPA example management and optimization
scripts/
  build-aura.js           esbuild: lib/aura.js → public/aura.bundle.js
  build-material.js       esbuild: @material/web → public/material.bundle.js
  gen-icons.js            Generate PWA icons (run manually if needed)
test/
  monitor.test.js         Unit tests (node --test)
```

## Scripts

```bash
npm run build             # Build material bundle + aura bundle
npm run dev               # Serve public/ locally
npm test                  # Unit tests
npm run deploy            # Build + push to gh-pages branch
```

## Deploy to GitHub Pages

Push to `main` → the included GitHub Actions workflow builds and deploys `public/` to GitHub Pages automatically.

Or deploy manually:
```bash
npm run deploy
```

Then enable **GitHub Pages → Source: gh-pages branch** in your repo settings.

## A note on responsible use

Aura points a camera at people and reacts automatically. Use it only where you're allowed to record, tell people they're being monitored, and don't rely on it for safety-critical enforcement — it's an LLM making best-effort judgements from a single frame.

## License

GPL-3.0 — see [LICENSE](./LICENSE).

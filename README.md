# Aura

**Team Members:** @barakplasma


**GitHub Repository:** [github.com/barakplasma/Aura](https://github.com/barakplasma/Aura)

Aura turns any phone or laptop with a webcam into an automated visual monitor. You provide your own API key and model from any OpenAI-compatible provider (Cerebras, OpenAI, Groq, Together, etc.). Set a mission prompt (what to watch for) and an action prompt (what to say via text-to-speech or send via webhook), and Aura runs a two-stage detect→act loop in your browser.

**No backend required.** This is a pure static PWA — your API key is stored in your browser's localStorage and sent directly to the provider. Nothing is proxied through a server.

```text
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

| Feature               | How                                                             |
|-----------------------|-----------------------------------------------------------------|
| **Provider config**   | Base URL, API key, model — any OpenAI-compatible vision model   |
| **Model discovery**   | Fetches available models from `GET /v1/models`                  |
| **Alert sensitivity** | Slider (10–95% confidence threshold)                            |
| **Scan interval**     | 2–30 seconds                                                    |
| **Text-to-speech**    | Built-in Web Speech API                                         |
| **Vibration**         | Web Vibration API (not available on iOS Safari)                 |
| **Webhook**           | POST/GET/PUT/PATCH to any URL with custom headers and JSON body |
| **Training**          | Add detection/action examples, optimize with ax/GEPA            |
| **Cost tracking**     | Cumulative token count and estimated cost                       |
| **PWA**               | Installable on mobile home screen                               |

### No API key? No problem

Two options, depending on what you want:

- **Demo mode** — press **TRY DEMO** on the Monitor screen for deterministic simulated scans, so you can test the camera, speech, vibration, and alert log with no provider at all. It never fires webhooks and is bannered while active.
- **A local model** — point Aura at an inference server on your own machine and leave the API key blank. See below.

## Run fully offline

Aura can run with no internet at all: the app shell is cached by a service worker, and inference happens on a model running locally. Nothing leaves your machine.

### 1. Start a local OpenAI-compatible server

Any server with vision support works. It must allow cross-origin requests from wherever the app is served:

```bash
# Ollama
ollama pull qwen2.5vl
OLLAMA_ORIGINS='*' ollama serve            # → http://localhost:11434/v1

# llama.cpp
llama-server -m your-vision-model.gguf --cors   # → http://localhost:8080/v1

# LM Studio — load a vision model, start the local server,
# and enable CORS in the server settings.  → http://localhost:1234/v1
```

### 2. Serve the app locally

```bash
npm install && npm run build
npx serve public          # → http://localhost:3000
```

Serving the app locally isn't optional for real offline use. The HTTPS GitHub Pages deployment can't reliably reach `http://localhost` — Chrome gates requests from a public HTTPS page to a local server behind a Private Network Access preflight that these servers don't answer. Run both on the same machine and that whole problem disappears.

### 3. Configure and arm

In **Settings → Provider**, click the **OLLAMA** / **LM STUDIO** / **LLAMA.CPP** preset (this also zeroes the cost rate), **leave API KEY blank**, and press **FETCH MODELS**. No `Authorization` header is sent when the key is empty. Set a mission, pick scan mode **MAX**, and arm.

Prefer `localhost` or `127.0.0.1` over `0.0.0.0` in the base URL — browsers block `0.0.0.0` as a request target.

### Offline app shell

`npm run build` generates `public/sw.js` (a build artifact, not checked in), a service worker that precaches the app shell
(HTML, CSS, icons, and every JS chunk) so the installed PWA boots with the network fully off.
It only ever intercepts same-origin `GET` requests — provider calls and webhooks always go
straight to the network, and are never cached. Each build stamps a new version, so a redeploy
replaces the cached shell on the next visit.

One cosmetic caveat: the UI fonts come from Google Fonts, so offline they fall back to the system monospace and sans-serif. Everything remains legible and correctly laid out — only the typeface changes.

## Project layout

```text
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

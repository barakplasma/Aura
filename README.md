# Aura

**Team Members:** <@352130433745551383>

**GitHub Repository:** [github.com/barakplasma/Aura](https://github.com/barakplasma/Aura)

Aura turns any phone or laptop with a webcam into an automated visual monitor in your environment powered by Gemma 4 vision using a simple webapp (on Cerebras for near-realtime detections and actions). The user sets a mission prompt (what to watch for) and an action prompt (what to say via text to speech, or what to send via webhook), and Aura runs a two-stage detect→act loop: frame → detection call → if triggered, action call → speaks alert aloud, vibrates, flashes, fires webhook. Built with history so that it can say or do anything according to mission parameters. Built on Cloudflare Workers + Hono, with a vanilla-JS PWA client served by Workers Static Assets for minimum latency globally.

---

## How it works

```
[ camera frame ] -> [ 640x480 JPEG (~40%) ] -> POST /api/scan { mission, action, threshold }
                                                        |
                                          DETECTION call (Gemma 4 on Cerebras)
                                          {triggered, confidence, reason}
                                                        |
                              triggered AND confidence >= threshold ?
                                       no |                 | yes
                                          v                 v
                                   "Watching…"        ACTION call (Gemma 4)
                                                      {message}  -> speak + vibrate + flash + webhook
```

Most cycles are detection-only; the second (action) call happens only on a real
alert, so steady-state cost stays low. Detection history is carried forward so
Gemma can act on temporal context — not just a single frame.

## Project layout

```
src/index.js              Cloudflare Worker (Hono): POST /api/scan + /api/health
lib/monitor.js            Detection + action prompts, Cerebras calls, parsing, mock
public/index.html         Mission/action/webhook prompts, sensitivity + cadence, alert log
public/app.js             Camera capture + scan loop + alert delivery + webhook dispatch
public/feedback.js        Web Speech announcement + Web Vibration alert
public/manifest.webmanifest
scripts/gen-icons.js      Regenerates PWA icons (no image deps)
.github/workflows/deploy.yml  CI deploy via cloudflare/wrangler-action
test/monitor.test.js      Unit tests for the monitor engine (node --test)
```

Aura runs on **Cloudflare Workers** with **Hono**. The client in `/public` is
served by Workers Static Assets; `run_worker_first = ["/api/*"]` routes only API
calls to the Worker. The Cerebras API key stays server-side as a Worker secret.

## Run it

```bash
npm install
npm run dev            # wrangler dev → http://localhost:8787 (mock mode without a key)

# Live inference:
cp .dev.vars.example .dev.vars   # set CEREBRAS_API_KEY
npm run dev

# Deploy:
npx wrangler deploy
npx wrangler secret put CEREBRAS_API_KEY
```

With no `CEREBRAS_API_KEY`, the monitor runs in **mock mode** — it cycles between
"normal" and "alert" so you can see the speech, vibration, and alert log working
offline. The camera, Vibration, and Speech APIs need a **secure context**
(`localhost` in dev, or the `https://*.workers.dev` URL once deployed).

## Runtime controls

- **Mission** / **Action** prompts (free-form, persisted).
- **Webhook URL, method, headers, action prompt, and body JSON schema** for
  sending alerts to any endpoint (ntfy.sh, custom APIs, etc.).
- **Alert sensitivity** (10–95%): the confidence the detection must reach to fire.
  Higher = fewer false alarms.
- **Scan every N seconds** (2–30 s): cadence, and your main cost dial.
- **Speak alerts** / **Vibrate on alert** toggles; a **Test vibration** button
  (note: iOS Safari has no Vibration API — it's disabled there).
- **Live cost**: each scan reports Cerebras token `usage`; telemetry shows
  cumulative **Tokens** and **Est. cost** from an editable **$/1M tokens** rate.

### Tests

```bash
npm test
```

## A note on responsible use

Aura points a camera at people and reacts automatically. Use it only where you're
allowed to record, tell people they're being monitored, and don't rely on it for
safety-critical enforcement — it's an LLM making best-effort judgements from a
single frame, and it will sometimes be wrong in both directions.

## License

GPL-3.0 — see [LICENSE](./LICENSE).

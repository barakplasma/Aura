# Aura

**An automated visual monitor powered by Gemma vision — on any phone, zero install.**

Point a phone (or webcam) at a scene, give it a **mission** in plain language, and
Aura watches the camera and **acts** when the condition you described happens.

- **Mission prompt** — what to watch for: *"Alert if someone is loitering near the
  front door,"* *"Alert if my son leaves his desk or stops doing homework,"*
  *"Alert if anyone runs on the pool deck or dives in the shallow end."*
- **Action prompt** — what to announce when it triggers: *"Firmly tell the person
  they're being recorded and to leave,"* *"Tell him to get back to his homework,"*
  *"Tell the swimmer to stop running."*

Each scan cycle, Gemma decides whether the alert condition is met and how
confident it is. If it fires (and clears your **sensitivity threshold**), Aura
runs the action prompt and **speaks the announcement aloud** (plus a vibration and
an on-screen flash). It's a security guard, a homework monitor, or a lifeguard —
defined entirely by two prompts.

It runs **Google DeepMind's Gemma vision model on Cerebras' wafer-scale engine**,
so each scan is fast and cheap enough to run continuously.

---

## How it works

```
[ camera frame ] -> [ 640x480 JPEG (~40%) ] -> POST /api/scan { mission, action, threshold }
                                                        |
                                          DETECTION call (Gemma)
                                          {triggered, confidence, reason}
                                                        |
                              triggered AND confidence >= threshold ?
                                       no |                 | yes
                                          v                 v
                                   "Watching…"        ACTION call (Gemma)
                                                      {message}  -> speak + vibrate + log
```

Most cycles are detection-only; the second (action) call happens only on a real
alert, so steady-state cost stays low.

## Project layout

```
src/index.js              Cloudflare Worker (Hono): POST /api/scan + /api/health
lib/monitor.js            Detection + action prompts, Cerebras calls, parsing, mock
public/index.html         Mission/action prompts, sensitivity + cadence, alert log
public/app.js             Camera capture + scan loop + alert delivery
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

### Continuous deployment

`.github/workflows/deploy.yml` deploys on every push to `main` via
[`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action).
Add a `CLOUDFLARE_API_TOKEN` repo secret (*Workers Scripts: Edit*); add a
`CEREBRAS_API_KEY` repo secret to run live (it's synced to the Worker after
deploy). Optional `CLOUDFLARE_ACCOUNT_ID` if the token sees more than one account.

## Runtime controls

- **Mission** / **Action** prompts (free-form, persisted).
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

# CLAUDE.md

Guidance for working in this repo. Read this before changing code.

## What Aura is

An **automated visual monitoring platform**. A phone/webcam streams frames to a
Cloudflare Worker; each scan cycle Gemma (on Cerebras) runs a **detection** call
and, only if the alert condition fires, an **action** call that produces a spoken
announcement. It's configured entirely by two free-form prompts — a *mission*
(what to watch for) and an *action* (what to say) — plus a confidence threshold.
Think security guard / homework monitor / lifeguard, defined by prompts.

> History: this started as a "spatial guidance for the blind" PRD and was pivoted
> hard. Ignore any guidance/describe framing you find in old commits — the current
> product is the monitor. Don't reintroduce spatial/guide/describe code.

## Architecture

```
camera frame ─► 640x480 JPEG (~q0.4) ─► POST /api/scan {mission, action, image, threshold}
                                              │
                                  DETECTION call (Gemma)  {triggered, confidence, reason}
                                              │
                            triggered AND confidence ≥ threshold ?
                              no │                         │ yes
                                 ▼                         ▼
                            "Watching…"            ACTION call (Gemma) {message}
                                                   → speak + vibrate + flash + log
```

Detection-only on quiet cycles; the second call happens only on a real alert, so
steady-state cost stays low. ~564 tokens/detection in practice.

- **Runtime:** Cloudflare Workers + **Hono** (`hono/tiny`). Static client in
  `/public` is served by Workers Static Assets; `run_worker_first = ["/api/*"]`
  routes only API calls to the Worker.
- **Inference:** Cerebras OpenAI-compatible chat completions, model `gemma-4-31b`,
  `response_format: json_object`. Key is a Worker **secret** (`CEREBRAS_API_KEY`),
  never shipped to the client.
- **Mock mode:** with no API key, `scan()` returns a deterministic mock that
  cycles normal/alert states so the whole UI works offline and in tests.

## File map

| Path | Role |
| --- | --- |
| `src/index.js` | Hono Worker: `POST /api/scan`, `GET /api/health` |
| `lib/monitor.js` | Engine: prompts, Cerebras calls, JSON parsing, usage, mock |
| `public/index.html` | UI: mission/action prompts, sensitivity + cadence, alert log |
| `public/app.js` | Camera capture + scan loop + alert delivery + telemetry |
| `public/feedback.js` | Web Speech announcement + Web Vibration alert |
| `public/styles.css` / `manifest.webmanifest` / `icons/` | Client assets |
| `lib`-less config: `wrangler.toml` | Worker + assets config, non-secret vars |
| `test/monitor.test.js` | Unit tests for the engine (`node --test`) |
| `.github/workflows/deploy.yml` | CI deploy via `cloudflare/wrangler-action` |
| `scripts/gen-icons.js` | Regenerates PWA icons (no image deps) |

`lib/monitor.js` is the heart. `scan({mission, action, image, threshold, env})`
orchestrates detection → conditional action and returns
`{triggered, confidence, reason, message, mode, usage}`.

## Commands

```bash
npm test                 # node --test (the locator/monitor engine)
npm run dev              # wrangler dev → http://localhost:8787 (mock w/o key)
npx wrangler deploy --dry-run   # validate bundle locally
npx wrangler deploy             # deploy (CI normally does this)
```

For live inference locally: `cp .dev.vars.example .dev.vars` and set
`CEREBRAS_API_KEY`.

## Gotchas — read these, they have bitten us

- **No `process` at module top level.** The Workers runtime has no `process`; a
  top-level `process.env.X` throws `ReferenceError` *at deploy/validation time*
  (and `wrangler --dry-run` will NOT catch it, because Node has `process`). Read
  config inside a function, guarded: `typeof process !== 'undefined' && process.env`.
  Worker env (vars/secrets) comes from the Hono `c.env` binding, passed as `env`
  to `scan()` → `getConfig(env)`. Keep `DEFAULT_*` constants as plain literals.
- **`--dry-run` ≠ deploy.** It bundles but doesn't run the Worker in workerd, so
  runtime-only errors (like the above) slip through. The real check is a deploy.
- **Strict JSON, defensively parsed.** Models are told to return raw minified
  JSON, but `isolateJsonObject()` strips fences/prose and extracts the outermost
  `{...}`. New model outputs should go through `normalizeDetection` /
  `parseAction` so a bad frame can't crash the loop.
- **No `navigator.vibrate` on iOS Safari.** Vibration is feature-detected
  (`canVibrate`); haptics are disabled there with a UI note. Test on Android.
- **Speech/vibration require a secure context** (`https://` or `localhost`) and a
  user gesture to start (the Start button covers this).
- **Discard post-Stop results.** The scan loop checks `state.running` after each
  `await` so a request that resolves after Stop can't speak/buzz/log.
- **Cost telemetry** comes from Cerebras `usage`; `normalizeUsage` derives totals.
  Keep returning `usage` from any new inference path or the cost readout breaks.

## Deployment / CI

- Push to `main` → `.github/workflows/deploy.yml` runs `npm ci` → `npm test` →
  `wrangler deploy` → `wrangler secret put CEREBRAS_API_KEY` (guarded; skipped if
  the repo secret is absent, leaving the Worker in mock mode).
- Required repo secret: `CLOUDFLARE_API_TOKEN` (*Workers Scripts: Edit*).
  Optional `CLOUDFLARE_ACCOUNT_ID`, `CEREBRAS_API_KEY`.
- The action is pinned to **wrangler v4** so `run_worker_first` is honored.
- Live: https://aura.barakplasma.workers.dev — `GET /api/health` reports
  `{mode: "live" | "mock"}`.

## Conventions

- ES modules, vanilla browser JS (no framework on the client), 2-space indent.
- Match the surrounding comment density and naming. Keep the client dependency-free.
- After changing the engine, add/extend a test in `test/monitor.test.js`.
- Don't commit secrets or `.dev.vars`. Don't add an offline service worker — the
  app is useless without the network, so a cache only serves a broken shell.
- This repo is GPL-3.0.

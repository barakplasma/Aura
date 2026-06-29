# AGENTS.md

How to work on Aura: what it is, how to add features, and how to ship them.
For deeper conventions and the gotchas that have bitten us, see **[CLAUDE.md](./CLAUDE.md)**.

## What the app does

Aura turns a phone/webcam into an **automated visual monitor**. You give it two
free-form prompts and a sensitivity, press Start, and it watches the camera:

- **Mission prompt** — what to watch for (*"alert if someone loiters near the door"*).
- **Action prompt** — what to announce when it happens (*"tell them to leave"*).
- **Sensitivity** — the confidence the detection must reach to fire.

Each scan cycle runs a two-stage loop on Gemma (hosted on Cerebras):

```
frame → POST /api/scan {mission, action, image, threshold}
         │
         ├─ DETECTION call → {triggered, confidence, reason}
         │
         └─ if triggered AND confidence ≥ threshold:
              ACTION call → {message}  →  phone speaks it + vibrates + flashes + logs
```

Quiet cycles are detection-only (~564 tokens); the action call runs only on a
real alert. With no API key it runs a deterministic **mock** so the whole UI and
test suite work offline.

**Stack:** Cloudflare Workers + Hono (`hono/tiny`); vanilla-JS PWA client served
by Workers Static Assets; Cerebras `gemma-4-31b` with `response_format: json_object`.

### Where things live

| Path | Role |
| --- | --- |
| `src/index.js` | Hono Worker routes: `POST /api/scan`, `GET /api/health` |
| `lib/monitor.js` | Engine: prompts, Cerebras calls, JSON parsing, usage, mock |
| `public/index.html` | UI markup (prompts, sliders, toggles, telemetry, alert log) |
| `public/app.js` | Camera capture + scan loop + alert delivery + telemetry |
| `public/feedback.js` | Web Speech announcement + Web Vibration alert |
| `public/styles.css` | Styles (mobile-first + a `≥820px` desktop layout) |
| `test/monitor.test.js` | Engine unit tests (`node --test`) |
| `wrangler.toml` | Worker + static-assets config, non-secret vars |
| `.github/workflows/deploy.yml` | CI deploy on push to `main` |

## How to add a feature

Pick the recipe that matches. Keep the client dependency-free and ES-module; add
or extend a test whenever you touch `lib/monitor.js`.

### A) Tune model behavior (prompts / temperature)
Everything is in `lib/monitor.js`:
- Prompts: `buildDetectionPrompt()` / `buildActionPrompt()`.
- Temperatures: `DETECTION_TEMPERATURE` / `ACTION_TEMPERATURE` constants.
- Output shape: enforce it in `normalizeDetection` / `parseAction` (defensive —
  the model can drift). Always route raw text through `isolateJsonObject()`.

### B) Add a runtime control (slider / toggle / field)
1. Add the element in `public/index.html` (give it an `id`).
2. Register it in the `els` map in `public/app.js`.
3. In `setupControls()`: restore from `localStorage`, wire an `input`/`change`
   listener that updates `state` and persists, and reflect it in the UI.
4. Read `state.<yourSetting>` where the loop/scan uses it.
   (Examples to copy: the threshold and "scan every N s" sliders.)

### C) Add or change an inference path / endpoint
1. In `lib/monitor.js`: add a prompt builder, a parser (via `isolateJsonObject`
   + a `normalize*` validator), and an exported async function that calls
   `callGemma(...)`. **Always return a `usage` object** (use `normalizeUsage` /
   `sumUsage`) or the cost readout breaks. Add a **mock branch** for the no-key path.
2. In `src/index.js`: add a Hono route that validates the body, calls your
   function with `env: c.env`, and returns `{ ...result, latencyMs }`.
3. In `public/app.js`: call it from the loop and feed results into the UI /
   `feedback.js`.
4. Add tests in `test/monitor.test.js` (parser coercion + the mock path).

### Local checks before pushing
```bash
npm test                      # node --test
npx wrangler deploy --dry-run # bundles & validates config (NOT a full runtime check)
npm run dev                   # wrangler dev → http://localhost:8787 (mock unless .dev.vars set)
```
> `--dry-run` runs under Node, so it will NOT catch Workers-runtime errors (e.g.
> top-level `process` use). Treat a real deploy as the final check. See CLAUDE.md.

## How to deploy

Deployment is **push-to-`main` → GitHub Actions**. As an agent you develop on the
feature branch, open a PR, and merging is what ships it.

1. Branch off the latest `main`, commit your change.
2. Push the branch and open a PR against `main`.
3. On merge, `.github/workflows/deploy.yml` runs:
   `npm ci` → `npm test` → `wrangler deploy` (wrangler v4) →
   `wrangler secret put CEREBRAS_API_KEY` (guarded; skipped if the secret is absent).
4. Verify the live Worker:
   ```bash
   curl -s https://aura.barakplasma.workers.dev/api/health      # → {"mode":"live"}
   # optional live scan:
   curl -s -X POST https://aura.barakplasma.workers.dev/api/scan \
     -H 'Content-Type: application/json' \
     -d '{"mission":"...","action":"...","image":"data:image/png;base64,...","threshold":60}'
   ```

### Secrets & config
- Repo secrets (GitHub → Settings → Secrets): **`CLOUDFLARE_API_TOKEN`**
  (*Workers Scripts: Edit*) is required; **`CEREBRAS_API_KEY`** enables live
  inference; **`CLOUDFLARE_ACCOUNT_ID`** is optional.
- Non-secret config (`CEREBRAS_BASE_URL`, `CEREBRAS_MODEL`) lives in
  `wrangler.toml [vars]` and reaches the Worker via the Hono `c.env` binding.
- Local live inference: copy `.dev.vars.example` → `.dev.vars`, set the key.
  Never commit `.dev.vars`.

### Manual deploy (if needed)
```bash
npx wrangler deploy
npx wrangler secret put CEREBRAS_API_KEY
```

## Guardrails
- Don't reintroduce the old spatial-guidance / scene-describe code — the product
  is the monitor now.
- Don't add an offline service worker (the app is useless without network).
- It points a camera at people and reacts automatically: only deploy where
  recording is allowed, disclose monitoring, and don't treat LLM judgements from
  a single frame as safety-critical.

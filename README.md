# Aura

**Low-Latency Haptic & Audio Spatial Guidance for the Visually Impaired**

Aura turns an ordinary Android phone into a closed-loop spatial guidance engine —
**zero install, no native app, no extra hardware.** Open a URL in Chrome, name an
object ("water bottle"), and the phone vibrates and speaks to steer your hand
directly onto it.

The whole idea hinges on one thing: **latency**. A cloud VLM round-trip of
1.5–3 s means a moving hand overshoots the target by ~1 m before feedback
arrives. Aura runs **Google DeepMind's Gemma vision model on Cerebras'
wafer-scale engine (>1,500 tokens/sec)** to collapse the vision-to-feedback loop
into something that matches human kinetic reaction time.

---

## How it works

```
[ HTML5 camera frame ]  ->  [ 640x480 JPEG q~0.4 ]  ->  POST /api/locate
                                                              |
                                                              v
                                  [ Cerebras · Gemma vision · strict JSON ]
                                                              |
                       found / x / y / action  <--------------+
                                  |
          +-----------------------+-----------------------+
          v                                               v
   off-center                                        centered
   Web Speech API: "Left" / "Right" / ...     Web Vibration API: solid pulse
   Web Vibration API: rapid dual-pulse        (haptics tighten as you close in)
```

- **Camera** — `getUserMedia` (rear camera) drawn to a hidden `<canvas>`,
  constrained to 640×480 and JPEG-compressed (~40%) before upload.
- **Inference** — the backend forwards the frame to Cerebras and enforces
  *correct-by-construction* spatial JSON
  (`{found, x, y, action}` on a normalized 0–100 grid). The API key stays
  server-side.
- **Haptics** — `navigator.vibrate([400])` for a locked target;
  `navigator.vibrate([100,50,100])` dual-pulse when off-center, with the cadence
  tightening as the target nears center.
- **Voice** — `SpeechSynthesisUtterance` at `rate = 1.4`, and the queue is
  `cancel()`-ed before every cue so audio always reflects the *latest* frame
  rather than a backlog.
- **Frame dropping** — only one inference request is ever in flight; new frames
  are dropped while waiting, keeping the loop real-time under network jitter.

## Project layout

```
src/index.js              Cloudflare Worker (Hono): /api/locate + /api/health
lib/locator.js            Cerebras call, strict JSON parsing/validation, mock fallback
wrangler.toml             Worker + static-assets config (serves /public, run_worker_first)
public/index.html         Accessible, large-tap-target UI
public/app.js             Camera capture + inference loop + telemetry
public/feedback.js        Web Vibration + Web Speech driver (throttled/de-duped)
public/manifest.webmanifest  Web app manifest (installable on Android Chrome)
scripts/gen-icons.js      Regenerates PWA icons (no image deps)
.github/workflows/deploy.yml  CI deploy via cloudflare/wrangler-action
test/locator.test.js      Unit tests for the locator (node --test)
```

Aura runs on **Cloudflare Workers** with **Hono**. The client in `/public` is
served by Workers Static Assets; `run_worker_first = ["/api/*"]` routes only API
calls to the Hono Worker, which is the Cerebras orchestration layer.

There is no service worker / offline cache: the app is non-functional without
network (every frame needs inference), so offline support would be pointless.
The web manifest is kept so it's still installable on Android Chrome.

## Run it

```bash
npm install

# Local dev (Workers runtime via Miniflare). Mock mode unless a key is set —
# the locator returns a converging spiral so the full UX works without a key.
npm run dev            # wrangler dev → http://localhost:8787

# Live Cerebras inference locally: put CEREBRAS_API_KEY in .dev.vars
cp .dev.vars.example .dev.vars   # then set CEREBRAS_API_KEY

# Manual deploy to Cloudflare:
npx wrangler deploy
# Then set the secret for live inference (otherwise mock mode):
npx wrangler secret put CEREBRAS_API_KEY
```

The camera, Vibration, and Speech APIs require a **secure context** —
`localhost` in dev, or the `https://*.workers.dev` URL once deployed.

### Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` deploys on every push to `main` (and on manual
dispatch) via [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action).
Add one repository secret:

- **`CLOUDFLARE_API_TOKEN`** — a token with *Workers Scripts: Edit*
  (the "Edit Cloudflare Workers" template works).
- *(optional)* `CLOUDFLARE_ACCOUNT_ID` — only if the token can see more than one
  account; an account-scoped token is auto-detected.

If a `CEREBRAS_API_KEY` repo secret is present, the workflow pushes it as a
Worker secret (in a guarded step after deploy, so the script exists first) and
the Worker runs live. If it's absent, that step is skipped and the Worker stays
in mock mode.

### Configuration

| Variable             | Where                          | Purpose                          |
| -------------------- | ------------------------------ | -------------------------------- |
| `CEREBRAS_API_KEY`   | secret (`.dev.vars` / dashboard) | Enables live inference (unset → mock). |
| `CEREBRAS_BASE_URL`  | `[vars]` in wrangler.toml       | Inference endpoint.              |
| `CEREBRAS_MODEL`     | `[vars]` in wrangler.toml       | Vision model id.                 |

### Tests

```bash
npm test
```

## Demo mode (the side-by-side)

The UI has a **"Demo: simulate slow GPU"** toggle. Flip it on to inject ~2 s of
artificial latency on top of each result — recreating the standard-cloud
failure mode (overshoot, knocked-over cup). Flip it off to feel the Cerebras
loop track your hand in real time. That contrast is the 60-second demo.

## Accessibility notes

- Voice input for the target (`SpeechRecognition`) plus a text fallback.
- `aria-live` status region announces guidance/state changes.
- Large, high-contrast touch targets; skip link; semantic landmarks.
- Voice and haptics are independently toggleable.

## License

GPL-3.0 — see [LICENSE](./LICENSE).

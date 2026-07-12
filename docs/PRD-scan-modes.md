# PRD — Scan-timing modes, camera selection, provider-config reliability

Status: approved · Owner: barakplasma · Scope: `src/` + `lib/` + `test/`

## Problem

The scan loop has exactly one knob: **SCAN EVERY** (fixed 2–30 s gap after each
scan completes, `src/hooks/useMonitor.js`). That single dial can't express the
real trade-off space:

- On a **local model** (Ollama, LM Studio) inference is free — the operator
  wants the freshest possible image, as many frames as the model can chew.
- On a **cloud provider** the operator wants a hard budget: "spend at most
  $0.25/hour" or "upload at most 50 MB/hour on mobile data", and let the app
  derive the cadence.
- A slow or hung request should be **discarded after a max TTL** and replaced
  by a scan of a *fresh* frame — a stale answer about a stale image is worthless
  for monitoring.

Two adjacent problems ride along:

1. **Camera selection** — capture is hardcoded to `facingMode: environment`.
   No front camera, no external USB camera, no way to pick between multiple
   rear lenses. (Stretch: monitor the operator's own screen via screen share.)
2. **False "provider isn't set" warning** — operators with a configured key
   get bounced to Settings (nav 05) before Mission/Monitor (nav 01/02). Root
   cause: the pre-React app wrote `aura.*` localStorage values as **raw
   strings**; the React app reads them through `useLocalStorage`
   (@uidotdev/usehooks), which `JSON.parse`s with **no try/catch**. Legacy
   values like `csk-…` fail to parse, so the stored config is invisible and
   the "NO API KEY CONFIGURED" callout fires spuriously.

## Scan-timing modes

Scheduling stays **strictly serial** — one scan in flight, the frame is
captured at send time, so *image freshness ≈ scan duration*. Modes only change
the **gap** inserted after a scan completes:

```
capture fresh frame → detection call → (alert path) → compute gap by mode → wait → repeat
                          |
                 no response by TTL? → abort, discard, next cycle per mode
```

New setting `aura.scanMode`:

| Mode | Gap after scan completes | Knobs | Best for |
|---|---|---|---|
| `interval` (default — today's behavior) | fixed `scanEvery` seconds | SCAN EVERY, number + unit (s/m/h), 1s to many hours | predictable cadence, cheap cloud |
| `max` | ~0 (250 ms floor so the UI/browser can breathe) | none — no forced timeout | local AI — freshest image, max frame rate |
| `budget` | derived from spend/data caps (below) | $/hour cap, optional MB/hour cap | cloud within a cost or mobile-data budget |

### Budget math

Maintain per-session EMAs (α = 0.3) of **tokens per scan** (from provider
`usage`), **request payload bytes per scan** (JPEG data-URL length × ¾ + fixed
prompt overhead), and **scan duration**.

```
costPerScan   = emaTokensPerScan × rate / 1e6          # rate = $/1M tokens (existing setting)
gapFromCost   = max(0, 3600e3 × costPerScan / budgetPerHour − emaScanDurationMs)
gapFromNet    = max(0, 3600e3 × emaBytesPerScan / (mbPerHour × 1e6) − emaScanDurationMs)
gapMs         = max(gapFromCost, gapFromNet)           # most restrictive cap wins
```

- **Bootstrap:** until the first usage sample lands, fall back to the
  `scanEvery` gap.
- **No usage data:** a provider that returns no token usage can't be
  cost-capped — surface a status warning and behave like `interval`.
  The network cap still works (payload size is measured client-side).

### Request timeout — fully automatic, no operator setting

The per-request timeout is derived entirely from this session's own latency
history: **mean + 3 standard deviations** of observed successful response
times, floored at a small safety minimum so ordinary variance never kills a
scan mid-flight. Before the first sample lands there's no distribution to
derive from, so that one request gets a generous fixed default. There is no
operator-facing ceiling — no REQUEST TIMEOUT / MAX SCAN AGE slider.

**`max` mode is the one exception: no forced timeout at all.** A scan runs to
completion (or is cancelled by Stop) and the next one starts immediately
after — the whole point of `max` is the highest frame rate the model can
sustain, so an artificial TTL would only throw away in-flight work. Every
other mode still applies the auto-tuned bound above. On a timeout the next
cycle starts per the mode's gap and always captures a **fresh frame**; the
timed-out response is never delivered.

### Engine shape

- `lib/scheduler.js` (new, pure, node-testable like `lib/stats.js`):
  `computeGapMs(mode, knobs, sample)` + `emaUpdate(prev, value, alpha)`.
- `useMonitor.js` reschedule block calls the scheduler instead of reading
  `scanEvery` directly; tracks the three EMAs per session.
- Unit tests in `test/scheduler.test.js` (gap math per mode, floor, caps,
  most-restrictive-wins, bootstrap, EMA behavior).

### Telemetry

Monitor screen gains: effective **scans/hr** (from cycle period EMA) and
projected **$/hr** (costPerScan × scans/hr). The existing SCAN CYCLE progress
bar keeps working — its "waiting" estimate is the computed gap.

### Settings UI

SCAN TIMING section becomes a 3-way mode selector; each mode shows only its
knobs:

- `interval` → SCAN EVERY number input + unit select (seconds/minutes/hours)
- `max` → no knobs — just a hint explaining there's no forced timeout
- `budget` → MAX $/HOUR input, MAX MB/HOUR input (blank = off), plus the
  existing COST RATE input it depends on

## Camera selection

- New settings: `aura.cameraFacing` (`'environment'` default, `'user'` for
  front) and `aura.cameraDeviceId` (`''` = auto by facing).
- Constraint logic: `deviceId: { exact }` when a device is chosen, else
  `facingMode: { ideal }`.
- Settings → new **CAMERA** section: FRONT/BACK toggle + device dropdown from
  `navigator.mediaDevices.enumerateDevices()`. Device labels are blank until
  camera permission is granted — a DETECT CAMERAS button requests a throwaway
  stream first, then enumerates.
- Quick **flip** button on the MonitorStage overlay. Switching while armed
  restarts the stream (stop tracks → re-acquire → reattach) without stopping
  the scan loop; extract an `acquireStream()` helper in `useMonitor.js`.

## Ultra-budget mode: motion-gated scanning (researched, follow-up)

Run cheap client-side change detection every 1–2 s and only fire the paid AI
request when the scene actually changed. Research verdict: **no library
needed** — a downscaled canvas diff beats every packaged option.

- **Detector:** draw the video to a dedicated hidden 64×48 canvas
  (`getContext('2d', { willReadFrequently: true })` — never the GPU-backed
  capture canvas), grayscale, per-pixel diff against the last **AI-scanned**
  frame with a noise floor (~24/255). Sub-millisecond per check on phones;
  the downscale itself averages away sensor grain.
- **False-trigger defenses:** subtract the mean-brightness delta before
  thresholding (auto-exposure/white-balance swings are the #1 false-motion
  source), and require the change to persist across two consecutive checks.
- **Heartbeat:** differencing misses slow, gradual change (smoke haze, a pot
  boiling over) — always send the AI a frame every N minutes (default 5,
  user-settable) regardless of motion.
- **Reference hygiene:** rebase the reference frame on every AI scan, camera
  flip, and source switch — otherwise drift makes it fire always or never.
- **Scheduler interplay:** the motion check ticks fast; `computeGapMs` still
  floors the *AI* cadence, and skip-counts feed telemetry so scans/hr and
  $/hr reflect actual AI calls.
- **Shape:** pure `lib/motion.js` (`toGray`, `motionScore`, `isSceneChanged`)
  + `test/motion.test.js` fixtures (noise must not trigger, global brightness
  shift must not trigger, 10%-area block change must trigger). ~200–250 LOC
  total.
- **Library options rejected:** pixelmatch (maintained but replaces only
  ~25 lines), ssim.js (dormant), tracking.js / diff-cam-engine (abandoned,
  2016-era). OpenCV.js MOG2 (~10 MB WASM, lazy-loadable) is the escalation
  path only if field noise defeats the simple diff.

## Screen-share source (low priority)

`aura.videoSource`: `'camera' | 'screen'`. Screen mode uses
`getDisplayMedia({ video: true })`, drawn aspect-fit onto the existing
640×480 capture canvas. Caveats (documented in UI hint):

- Browsers require a fresh user gesture per share — it cannot auto-restore
  on ARM like the camera can.
- Effectively desktop-only; mobile browsers barely support it.
- When the user stops sharing (`track.onended`), monitoring must stop cleanly.

## Provider-config reliability

- One-time migration at boot (in `src/main.jsx`, **before** React renders,
  logic in a pure `lib/settings-migrate.js`): for every `aura.*` key whose
  value fails `JSON.parse`, rewrite it as `JSON.stringify(rawValue)`. Legacy
  v1 configs become readable; the false "provider isn't set" warning dies.
- Known limitation (not fixable client-side): iOS installed-PWA localStorage
  is partitioned from the Safari tab — config entered in one does not appear
  in the other.

## Settings keys (all `aura.*`, localStorage)

| Key | Default | New? |
|---|---|---|
| `scanMode` | `'interval'` | ✔ |
| `scanEveryValue` | `5` | ✔ (replaces `scanEvery`) |
| `scanEveryUnit` | `'s'` | ✔ |
| `budgetPerHour` | `'0.10'` | ✔ |
| `networkMbPerHour` | `''` (off) | ✔ |
| `cameraFacing` | `'environment'` | ✔ |
| `cameraDeviceId` | `''` (auto) | ✔ |
| `videoSource` | `'camera'` | ✔ (stretch) |

## Out of scope

- Parallel/pipelined scans (multiple requests in flight).
- True power measurement — the network/cost caps are the proxy.
- Provider presets / multi-provider switching (separate feature).
- Cross-device config sync.

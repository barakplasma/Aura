# AGENTS.md

How to work on Aura: what it is, how to add features, and how to ship them.
For deeper conventions see **CLAUDE.md**.

## What the app does

Aura turns a phone/webcam into an **automated visual monitor** — entirely in the browser with no backend. The user provides their own API key + model from any OpenAI-compatible provider.

- **Mission prompt** — what to watch for.
- **Action prompt** — what to announce when it happens.
- **Sensitivity** — confidence threshold (10–95%) for firing alerts.

Each scan cycle:
```
frame → scanClient() → detection call → if triggered: action call → speak + vibrate + flash + webhook
```

## Where things live

| Path | Role |
|---|---|
| `public/index.html` | Material Design 3 UI with web components |
| `public/app.js` | Camera capture + scan loop + alert delivery + telemetry |
| `public/aura.bundle.js` | Bundled browser engine |
| `public/material.bundle.js` | Bundled MD3 web components |
| `public/material-theme.css` | MD3 dark theme |
| `public/feedback.js` | Speech + vibration feedback |
| `lib/aura.js` | Browser engine: `scanClient()`, `fetchModels()` |
| `lib/monitor.js` | Pure prompt/parser functions (used by aura.js + tests) |
| `lib/training.js` | ax/GEPA example management and optimization |
| `test/monitor.test.js` | Unit tests |

## How to add a feature

### A) Tune model behavior (prompts / temperature)
Edit `lib/monitor.js`:
- Prompts: `buildDetectionPrompt()` / `buildActionPrompt()`.
- Temperatures: constants in `lib/aura.js` (`0.5`/`0.9`).
- Output parsing: `normalizeDetection` / `parseAction` in `lib/monitor.js`.

### B) Add a runtime control (slider / switch / text field)
1. Add the MD3 web component in `public/index.html` (give it an `id`).
2. Register it in the `els` map in `public/app.js`.
3. In `setupControls()`: restore from `localStorage`, wire event listeners, update state/UI.
4. Read `state.<yourSetting>` where the loop uses it.

### C) Add a new inference path
1. In `lib/aura.js`: add the call in `scanClient()` using the provider config pattern.
2. Wire it into `public/app.js`.
3. Add pure-function tests in `test/monitor.test.js` if parsers are involved.

## Local checks before pushing
```bash
npm test
npm run build
npm run dev    # verify in browser at http://localhost:3000
```

## Deployment

Push to `main` → GitHub Actions builds and deploys `public/` to GitHub Pages.

Manual deploy:
```bash
npm run deploy
```
Then enable Pages in repo settings → Source: `gh-pages` branch.

## Guardrails
- No backend code — everything must work as a static site.
- User's API key must never be sent anywhere except directly to their chosen provider.
- Camera points at people: only deploy where recording is allowed.
- Don't add an offline service worker.

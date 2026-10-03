// The monitor's result model (docs/PRD-ux-redesign.md, "The verdict card").
//
// useMonitor used to pass fourteen differently-shaped sentences to
// setStatus(); the UI could only print them. Every one of those sentences is
// now built here, next to a structured record of what happened, so the UI
// renders the record and `text` stays as the aria-live announcement.
//
//   verdict = {
//     state:      'idle' | 'starting' | 'watching' | 'alert' | 'degraded' |
//                 'error' | 'stopped' | 'background',
//     text:       the legacy one-line status (aria-live),
//     headline:   the alert message, or the reason while watching,
//     reason:     the detection reason (the "why" fold), or null,
//     confidence: 0-100 or null,   threshold: 0-100,
//     latencyMs:  number or null,  engine: 'provider' | 'browser' | 'decision' | null,
//     note:       { kind, text, detail } | null,   // fallback / announcer / budget
//     entryId:    id of the alert / recent-frame history entry this scan
//                 produced, or null (no frame kept, or not a scan),
//     error:      { message, fixField } | null,    // fixField names the setting that cures it
//     at:         epoch ms,
//   }
//
// Pure: the clock is injected, so whole transitions run under `node --test`.

function make(state, text, extra = {}, now = Date.now) {
  return {
    state,
    text,
    headline: text,
    reason: null,
    confidence: null,
    threshold: 0,
    latencyMs: null,
    engine: null,
    note: null,
    entryId: null,
    error: null,
    ...extra,
    at: now(),
  };
}

function failure(text, message, fixField = null, now) {
  return make('error', text, { error: { message, fixField } }, now);
}

// What a degraded scan tells the operator. `detail` is the raw error, kept
// whole for the sheet behind the note chip.
function noteFor(result) {
  if (result.fallbackReason) {
    return {
      kind: 'fallback',
      text: 'Decision model failed — the provider answered',
      detail: result.fallbackReason,
    };
  }
  if (result.announceError) {
    return { kind: 'announcer', text: 'Announcer failed — the template spoke', detail: result.announceError };
  }
  return null;
}

// The legacy suffix, byte for byte, so `text` never drifts from what it was.
function noteSuffix(result) {
  if (result.fallbackReason) return ` · decision model failed (${result.fallbackReason}); the provider answered`;
  if (result.announceError) return ` · announcer failed (${result.announceError})`;
  return '';
}

/** A finished scan: alert, watching, or watching-with-degradation. */
export function fromScan(result, { engine = null, threshold = 0, entryId = null, now = Date.now } = {}) {
  const note = noteFor(result);
  const common = {
    reason: result.reason ?? null,
    confidence: Number.isFinite(result.confidence) ? result.confidence : null,
    threshold,
    latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    engine,
    note,
    entryId,
  };
  if (result.triggered) {
    const headline = result.message || result.reason;
    return make('alert', `⚠ ALERT — ${headline}${noteSuffix(result)}`, { ...common, headline }, now);
  }
  return make(
    note ? 'degraded' : 'watching',
    `Watching — ${result.reason}${noteSuffix(result)}`,
    { ...common, headline: result.reason },
    now,
  );
}

const NOT_CONFIGURED = {
  browser: ['Pick a BROWSER MODEL in Settings, or use Demo Mode.', 'browserModel'],
  decision: ['Pick a DECISION model (and its server URL if self-hosted, or account ID for Cloudflare) in Settings, or use Demo Mode.', 'decisionModel'],
  provider: ['Set a provider Base URL and model in Settings, or use Demo Mode.', 'baseUrl'],
};

export const verdicts = {
  idle: (now) => make('idle', 'Configure a provider and press Start.', {}, now),
  starting: (source, now) =>
    make('starting', source === 'screen' ? 'Requesting screen share…' : 'Starting camera…', {}, now),
  loading: (label, pct, now) => make('starting', `Loading ${label} — ${pct}%`, {}, now),
  monitoring: (engine, threshold = 0, now) =>
    make('watching', 'Monitoring…', { engine, threshold }, now),
  stopped: (now) => make('stopped', 'Stopped.', {}, now),
  background: (now) => make('background', 'Background — scans throttled by the browser.', {}, now),
  reconnecting: ({ hidden, attempt, total }, now) =>
    make(
      'starting',
      hidden
        ? 'Camera paused in background — resumes on return.'
        : `Camera lost — reconnecting (${attempt}/${total})…`,
      {},
      now,
    ),
  budgetFallback: (engine, now) =>
    make(
      'degraded',
      'Budget mode: provider returns no token usage — using interval cadence. Set a MB/HOUR cap to throttle by data instead.',
      {
        engine,
        note: {
          kind: 'budget',
          text: 'Budget mode fell back to interval cadence',
          detail: 'The provider returned no token usage, so cost cannot be capped. Set a MB/hour cap to throttle by data instead.',
        },
      },
      now,
    ),

  notConfigured(engine, now) {
    const [text, field] = NOT_CONFIGURED[engine] || NOT_CONFIGURED.provider;
    return failure(text, text, field, now);
  },
  needMission: (now) => {
    const text = 'Describe the mission (what to watch for) first.';
    return failure(text, text, 'mission', now);
  },
  sourceUnavailable: (source, message, now) =>
    failure(`${source === 'screen' ? 'Screen share' : 'Camera'} unavailable: ${message}`, message, 'videoSource', now),
  cameraLost: (message, now) => failure(`Camera lost — tap ARM to retry. (${message})`, message, null, now),
  cameraSwitchFailed: (message, now) => failure(`Camera switch failed: ${message}`, message, null, now),
  scanError: (message, now) => failure(`Error: ${message}`, message, null, now),
};

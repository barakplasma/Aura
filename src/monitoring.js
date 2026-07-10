// Error tracking via Bugsink (https://bugsink.com), which speaks the Sentry
// wire protocol — so we use the standard @sentry/browser SDK.
//
// The DSN below is a *public* client identifier, the same kind that ships in
// every Sentry-instrumented frontend; it is not a secret and is safe to commit.
// The user's provider API key never reaches Bugsink: it lives in localStorage
// and travels only in the Authorization header, which the SDK does not capture.
//
// We deliberately keep this to plain error reporting — no performance tracing
// or session replay integrations — because Bugsink ingests errors only, and
// omitting them keeps the main bundle small.
import * as Sentry from '@sentry/browser';

Sentry.init({
  dsn: 'https://1b4075f67e00411896ae35506159ebe2@barakplasma.bugsink.com/4',
  // Don't attach PII (IP address, cookies, request bodies) to events.
  sendDefaultPii: false,
});

export { Sentry };

// The request/response half of the raw CDP clients the dev harnesses use
// (dev-ep-watch.mjs, dev-latency-ladder.mjs). Every call gets an id, an entry
// in `waiting` and a deadline, so a starved target rejects instead of parking
// the harness until its outer timeout kills it.

/** A send(method, params, ms) bound to one socket and its pending map. */
export function cdpSender(ws, waiting, defaultMs) {
  let id = 0;
  return (method, params = {}, ms = defaultMs) => {
    const mid = ++id;
    return new Promise((ok, fail) => {
      waiting.set(mid, { ok, fail });
      setTimeout(() => {
        if (waiting.delete(mid)) fail(new Error(`${method} timed out after ${ms}ms`));
      }, ms);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  };
}

/** Settle the pending call a CDP message answers; false when it's an event. */
export function settleReply(waiting, d) {
  if (!d.id || !waiting.has(d.id)) return false;
  const { ok, fail } = waiting.get(d.id);
  waiting.delete(d.id);
  if (d.error) fail(new Error(d.error.message));
  else ok(d.result);
  return true;
}

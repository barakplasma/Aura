// Dev-only alert sink for on-device testing. Run on the host, expose it to the
// phone with: adb reverse tcp:8099 tcp:8099, then point the app's Alert screen
// WEBHOOK URL at http://localhost:8099/.
//
// Why: verifying that a phone-side alert actually fired meant reading
// IndexedDB over CDP and trusting the screen. This takes the app's own POST,
// logs exactly what it sent, and answers 200 so the app records delivery —
// the same contract the ntfy path is exercised against.
import { createServer } from "node:http";

const port = Number(process.env.PORT || 8099);
const t0 = Date.now();

createServer((req, res) => {
  const at = ((Date.now() - t0) / 1000).toFixed(1);
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let summary = body.slice(0, 400);
    try {
      const j = JSON.parse(body);
      const copy = { ...j };
      for (const k of Object.keys(copy)) {
        const v = typeof copy[k] === "string" ? copy[k] : "";
        if (v.startsWith('data:') || v.length > 120) copy[k] = '<' + v.length + ' chars>';
      }
      summary = JSON.stringify(copy);
    } catch {
      /* not JSON — log the raw head */
    }
    console.log(`+${at}s ${req.method} ${req.url} ${Buffer.byteLength(body)}B ${summary}`);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end('{"ok":true}');
  });
}).listen(port, "0.0.0.0", () => console.log(`dev webhook sink on :${port}`));

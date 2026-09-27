#!/usr/bin/env node
// Dev instrument: the aura-relay Traefik config, verified end to end without
// a cluster. Starts a fake Replicate (answers 401 and echoes the bearer it
// received, like the real API rejecting a fake token), runs a real Traefik
// binary with deploy/aura-relay/traefik-local.yml (the file-provider twin of
// the chart's IngressRoute + Middlewares), then runs scripts/relay-probe.mjs
// against it.
//
// Usage: TRAEFIK=/path/to/traefik node scripts/dev-relay-local.mjs
//   (Traefik v3 — a release binary from github.com/traefik/traefik works.)

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const TRAEFIK = process.env.TRAEFIK || "traefik";
const ORIGIN = "https://barakplasma.github.io";
const work = mkdtempSync(path.join(tmpdir(), "aura-relay-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let forwarded = 0;
const upstream = http.createServer((req, res) => {
  forwarded += 1;
  req.resume();
  req.on("end", () => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ title: "Unauthenticated", detail: `saw ${req.headers.authorization || "no token"}`, status: 401 }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

// A free port for Traefik's entrypoint.
const probe = http.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));

const dynamic = readFileSync(path.join(ROOT, "deploy/aura-relay/traefik-local.yml"), "utf8")
  .replaceAll("__HOST__", "localhost")
  .replaceAll("__ORIGIN__", ORIGIN)
  .replaceAll("__UPSTREAM__", upstreamUrl);
writeFileSync(path.join(work, "dynamic.yml"), dynamic);
writeFileSync(path.join(work, "traefik.yml"), [
  "entryPoints:",
  "  web:",
  `    address: "127.0.0.1:${port}"`,
  "providers:",
  "  file:",
  `    filename: ${path.join(work, "dynamic.yml")}`,
  "log:",
  "  level: ERROR",
].join("\n"));

const traefik = spawn(TRAEFIK, [`--configFile=${path.join(work, "traefik.yml")}`], { stdio: ["ignore", "inherit", "inherit"] });
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await sleep(200);
  up = await fetch(`http://localhost:${port}/`).then(() => true, () => false);
}
if (!up) {
  traefik.kill();
  throw new Error(`Traefik did not come up on :${port}`);
}

const probeRun = spawn(process.execPath, [path.join(ROOT, "scripts/relay-probe.mjs"), `http://localhost:${port}{path}`, "--origin", ORIGIN], {
  stdio: "inherit",
});
const code = await new Promise((r) => probeRun.on("exit", r));
console.log(`\nfake upstream saw ${forwarded} forwarded requests`);
traefik.kill();
upstream.close();
process.exitCode = code;

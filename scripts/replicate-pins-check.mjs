#!/usr/bin/env node
// Do the Replicate versions pinned in lib/decision-models.js still accept
// what Aura sends? Aura only ever sends `image_base64`; a version built from
// a predictor whose `image` is a bare `Path` (not `Optional[Path]`) lists
// `image` as required, and Replicate answers 422 "image is required" before
// a prediction exists — every DECISION scan fails and leaves no run behind.
// Run this after every `cog push` and pin the new hash:
//
//   REPLICATE_API_TOKEN=r8_... node scripts/replicate-pins-check.mjs
//
// Read-only: version metadata only, no prediction, nothing billed. Exits
// non-zero when a pinned version would reject Aura's request, and warns when
// a newer push exists that the table doesn't pin yet.

import { DECISION_MODELS } from "../lib/decision-models.js";

const token = process.env.REPLICATE_API_TOKEN;
if (!token) {
  console.error("REPLICATE_API_TOKEN is required (read-only: only version metadata is fetched).");
  process.exit(2);
}

// What toRequest() in lib/decision.js puts in `input` for a yes/no question.
const SENT = ["question", "question_type", "image_base64"];

async function api(path) {
  const resp = await fetch(`https://api.replicate.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status} ${(await resp.text()).slice(0, 120)}`);
  return resp.json();
}

let failed = false;
for (const [id, row] of Object.entries(DECISION_MODELS)) {
  if (row.dialect !== "replicate") continue;
  const model = `/v1/models/${row.replicateModel}`;
  try {
    const [pinned, versions] = await Promise.all([api(`${model}/versions/${row.version}`), api(`${model}/versions`)]);
    const input = pinned.openapi_schema?.components?.schemas?.Input || {};
    const required = input.required || [];
    const props = Object.keys(input.properties || {});
    const problems = [];
    if (required.includes("image")) problems.push('"image" is required — the predictor needs Optional[Path]');
    for (const field of SENT) if (!props.includes(field)) problems.push(`no "${field}" input`);
    if (row.acceptsState && !props.includes("state")) problems.push('acceptsState but no "state" input');
    const latest = versions.results?.[0]?.id;
    const stale = latest && latest !== row.version;
    const ok = problems.length === 0;
    failed ||= !ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${row.replicateModel}@${row.version.slice(0, 8)}${problems.length ? `  — ${problems.join("; ")}` : ""}`);
    if (stale) console.log(`      newer push exists: ${latest} (${versions.results[0].created_at})`);
  } catch (err) {
    failed = true;
    console.log(`FAIL  ${id}  ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);

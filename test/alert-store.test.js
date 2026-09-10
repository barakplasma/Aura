import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAlertStore,
  createMemoryAdapter,
  ALERTS_CAP,
  MISSED_CAP,
} from "../lib/alert-store.js";

function makeAlert(id, atMs) {
  return {
    id,
    at: new Date(atMs).toISOString(),
    time: new Date(atMs).toLocaleTimeString(),
    conf: 80,
    message: `alert ${id}`,
    reason: "",
    image: null,
  };
}

test("alerts round-trip and list newest first", async () => {
  const store = createAlertStore(createMemoryAdapter());
  await store.addAlert(makeAlert(1, 1000));
  await store.addAlert(makeAlert(2, 2000));
  await store.addAlert(makeAlert(3, 3000));
  const list = await store.listAlerts();
  assert.deepEqual(list.map((a) => a.id), [3, 2, 1]);
});

test("alerts evict the oldest entry once past the cap", async () => {
  const store = createAlertStore(createMemoryAdapter());
  for (let i = 0; i < ALERTS_CAP; i++) {
    await store.addAlert(makeAlert(i, i * 1000));
  }
  let list = await store.listAlerts();
  assert.equal(list.length, ALERTS_CAP);

  // One more insert pushes the store over the cap — the oldest (id 0) goes.
  await store.addAlert(makeAlert(ALERTS_CAP, ALERTS_CAP * 1000));
  list = await store.listAlerts();
  assert.equal(list.length, ALERTS_CAP);
  assert.ok(!list.some((a) => a.id === 0));
  assert.ok(list.some((a) => a.id === ALERTS_CAP));
  // Still newest first.
  assert.equal(list[0].id, ALERTS_CAP);
});

test("missed frames cap at MISSED_CAP and evict oldest first", async () => {
  const store = createAlertStore(createMemoryAdapter());
  for (let i = 0; i < MISSED_CAP + 2; i++) {
    await store.addMissed({
      id: i,
      at: new Date(i * 1000).toISOString(),
      time: "t",
      reason: "no alert",
      conf: null,
      image: "data:image/jpeg;base64,AAA",
    });
  }
  const list = await store.listMissed();
  assert.equal(list.length, MISSED_CAP);
  // The two oldest (0, 1) should have been evicted.
  assert.ok(!list.some((m) => m.id === 0));
  assert.ok(!list.some((m) => m.id === 1));
  assert.deepEqual(
    list.map((m) => m.id),
    [MISSED_CAP + 1, MISSED_CAP, MISSED_CAP - 1, MISSED_CAP - 2],
  );
});

test("marks survive alongside the alert/missed entry they review", async () => {
  const store = createAlertStore(createMemoryAdapter());
  await store.addAlert(makeAlert(1, 1000));
  await store.setMark(1, "false-positive");
  await store.setMark(2, "false-negative");

  const marks = await store.listMarks();
  assert.deepEqual(marks, { 1: "false-positive", 2: "false-negative" });

  // A mark on an id that later scrolls out of the capped alert window still
  // reports back — it's a separate store, not derived from the alert list.
  for (let i = 3; i < ALERTS_CAP + 3; i++) {
    await store.addAlert(makeAlert(i, i * 1000));
  }
  const alerts = await store.listAlerts();
  assert.ok(!alerts.some((a) => a.id === 1)); // evicted
  assert.equal((await store.listMarks())[1], "false-positive"); // mark remains
});

test("clearAll empties alerts, missed, and marks together", async () => {
  const store = createAlertStore(createMemoryAdapter());
  await store.addAlert(makeAlert(1, 1000));
  await store.addMissed({ id: 2, at: new Date(2000).toISOString(), time: "t", reason: "", conf: null, image: "x" });
  await store.setMark(1, "false-positive");

  await store.clearAll();

  assert.deepEqual(await store.listAlerts(), []);
  assert.deepEqual(await store.listMissed(), []);
  assert.deepEqual(await store.listMarks(), {});
});

test("alert-store imports in Node without an indexedDB global (lazy adapter)", () => {
  // Regression guard: creating the store (with its default IDB adapter) must
  // not touch the indexedDB global until an operation actually runs.
  assert.equal(typeof globalThis.indexedDB, "undefined");
  const store = createAlertStore();
  assert.equal(typeof store.listAlerts, "function");
});

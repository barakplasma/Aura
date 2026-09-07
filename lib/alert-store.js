// Aura alert-history store — IndexedDB persistence for alerts, recent
// non-alert ("missed") frames, and FALSE POSITIVE/NEGATIVE marks, so a reload
// doesn't wipe out an armed session's history. Adapter plumbing (real +
// in-memory) is shared with lib/eval-store.js via lib/idb-store.js.

import {
  createMemoryAdapter as createSharedMemoryAdapter,
  createIndexedDbAdapter as createSharedIndexedDbAdapter,
} from "./idb-store.js";

const DB_NAME = "aura-history";
const DB_VERSION = 1;
const ALERTS = "alerts";
const MISSED = "missed";
const MARKS = "marks";

// Alert JPEGs run 30-60KB each; these caps keep the store well inside the
// default origin quota regardless of how long a session runs.
export const ALERTS_CAP = 200;
export const MISSED_CAP = 4;

export function createMemoryAdapter() {
  return createSharedMemoryAdapter([ALERTS, MISSED, MARKS]);
}

export function createIndexedDbAdapter() {
  return createSharedIndexedDbAdapter({
    dbName: DB_NAME,
    version: DB_VERSION,
    storeNames: [ALERTS, MISSED, MARKS],
  });
}

// Newest-first by `at` (an ISO timestamp) — `time` on these records is a
// locale string and not sortable. Ties (same millisecond) fall back to `id`
// so ordering stays deterministic.
function byNewestFirst(a, b) {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

export function createAlertStore(adapter = createIndexedDbAdapter()) {
  // Insert a record and evict the oldest entries once the store exceeds cap.
  async function addCapped(store, record, cap) {
    await adapter.put(store, record);
    const all = await adapter.getAll(store);
    if (all.length <= cap) return;
    const oldestFirst = all.slice().sort((a, b) => byNewestFirst(b, a));
    const excess = oldestFirst.slice(0, all.length - cap);
    await Promise.all(excess.map((rec) => adapter.delete(store, rec.id)));
  }

  return {
    async listAlerts() {
      const all = await adapter.getAll(ALERTS);
      return all.sort(byNewestFirst);
    },
    async addAlert(record) {
      await addCapped(ALERTS, record, ALERTS_CAP);
    },
    async listMissed() {
      const all = await adapter.getAll(MISSED);
      return all.sort(byNewestFirst);
    },
    async addMissed(record) {
      await addCapped(MISSED, record, MISSED_CAP);
    },
    // Marks are keyed by the id of the alert/missed entry they review, so a
    // FALSE POSITIVE/NEGATIVE mark survives reload alongside the training
    // example it wrote, and stays attached even if the alert itself later
    // scrolls out of the capped window.
    async setMark(id, kind) {
      await adapter.put(MARKS, { id, kind, at: new Date().toISOString() });
    },
    async listMarks() {
      const all = await adapter.getAll(MARKS);
      const byId = {};
      for (const m of all) byId[m.id] = m.kind;
      return byId;
    },
    async clearAll() {
      await Promise.all([
        adapter.clear(ALERTS),
        adapter.clear(MISSED),
        adapter.clear(MARKS),
      ]);
    },
  };
}

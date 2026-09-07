// Aura alert-history store — IndexedDB persistence for alerts, recent
// non-alert ("missed") frames, and FALSE POSITIVE/NEGATIVE marks, so a reload
// doesn't wipe out an armed session's history. Same async-adapter shape as
// lib/eval-store.js: a real IndexedDB adapter plus an exported
// createMemoryAdapter() so tests (node --test, no IndexedDB) can swap one in.

const DB_NAME = "aura-history";
const DB_VERSION = 1;
const ALERTS = "alerts";
const MISSED = "missed";
const MARKS = "marks";

// Alert JPEGs run 30-60KB each; these caps keep the store well inside the
// default origin quota regardless of how long a session runs.
export const ALERTS_CAP = 200;
export const MISSED_CAP = 4;

// Map-backed adapter with the same async surface as the IndexedDB one.
export function createMemoryAdapter() {
  const stores = { [ALERTS]: new Map(), [MISSED]: new Map(), [MARKS]: new Map() };
  const table = (name) => {
    const t = stores[name];
    if (!t) throw new Error(`Unknown store: ${name}`);
    return t;
  };
  return {
    async getAll(store) {
      return [...table(store).values()];
    },
    async get(store, key) {
      return table(store).get(key) ?? null;
    },
    async put(store, record) {
      table(store).set(record.id, record);
    },
    async delete(store, key) {
      table(store).delete(key);
    },
    async clear(store) {
      table(store).clear();
    },
  };
}

// Lazy: never touches the indexedDB global at creation time, so this module
// (and createAlertStore's default) imports cleanly under Node.
export function createIndexedDbAdapter() {
  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const store of [ALERTS, MISSED, MARKS]) {
            if (!db.objectStoreNames.contains(store)) {
              db.createObjectStore(store, { keyPath: "id" });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  function tx(store, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const req = fn(db.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }
  return {
    getAll: (store) => tx(store, "readonly", (os) => os.getAll()),
    get: (store, key) =>
      tx(store, "readonly", (os) => os.get(key)).then((v) => v ?? null),
    put: (store, record) => tx(store, "readwrite", (os) => os.put(record)),
    delete: (store, key) => tx(store, "readwrite", (os) => os.delete(key)),
    clear: (store) => tx(store, "readwrite", (os) => os.clear()),
  };
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

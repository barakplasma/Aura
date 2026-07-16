// Aura eval store — IndexedDB persistence for sample images and the last
// evaluation run. Images are 640×480 JPEG data URLs (30-60KB each), too big
// for the ~5MB localStorage quota shared with every other aura.* key, so
// they live in their own IndexedDB database. Written against a tiny async
// adapter so tests (node --test, no IndexedDB) can swap in an in-memory
// implementation.

const DB_NAME = "aura-eval";
const DB_VERSION = 1;
const IMAGES = "images";
const RUNS = "runs";

export function makeId(prefix) {
  // Date.now() alone can collide when a multi-file upload lands several
  // records in the same millisecond — add a short random suffix.
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// Map-backed adapter with the same async surface as the IndexedDB one.
export function createMemoryAdapter() {
  const stores = { [IMAGES]: new Map(), [RUNS]: new Map() };
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
// (and createEvalStore's default) imports cleanly under Node.
export function createIndexedDbAdapter() {
  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IMAGES)) {
            db.createObjectStore(IMAGES, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(RUNS)) {
            db.createObjectStore(RUNS, { keyPath: "id" });
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

export function createEvalStore(adapter = createIndexedDbAdapter()) {
  return {
    async listImages() {
      const all = await adapter.getAll(IMAGES);
      return all.sort((a, b) => a.createdAt - b.createdAt);
    },
    async addImage({ dataUrl, source }) {
      const record = {
        id: makeId("img"),
        dataUrl,
        expected: null, // optional label: null = unlabeled
        source: source || "upload",
        createdAt: Date.now(),
      };
      await adapter.put(IMAGES, record);
      return record;
    },
    async setImageExpected(id, expected) {
      const rec = await adapter.get(IMAGES, id);
      if (!rec) return null;
      const next = { ...rec, expected };
      await adapter.put(IMAGES, next);
      return next;
    },
    async removeImage(id) {
      await adapter.delete(IMAGES, id);
    },
    async clearImages() {
      await adapter.clear(IMAGES);
    },
    // Only the most recent run is kept — enough to survive tab switches and
    // page reloads without growing unbounded.
    async saveLastRun(run) {
      await adapter.put(RUNS, { ...run, id: "last" });
    },
    async getLastRun() {
      return adapter.get(RUNS, "last");
    },
  };
}

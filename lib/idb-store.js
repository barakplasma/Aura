// Shared IndexedDB adapter plumbing for lib/eval-store.js and
// lib/alert-store.js — both need the same tiny async surface (get/getAll/
// put/delete/clear) over a fixed set of keyPath:"id" object stores, backed
// either by real IndexedDB or, for tests (node --test, no IndexedDB), an
// in-memory Map. Pulled out once two call sites needed the identical logic.

// Map-backed adapter with the same async surface as the IndexedDB one.
export function createMemoryAdapter(storeNames) {
  const stores = Object.fromEntries(storeNames.map((name) => [name, new Map()]));
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

// Lazy: never touches the indexedDB global at creation time, so callers stay
// importable under Node before this is ever invoked.
export function createIndexedDbAdapter({ dbName, version, storeNames }) {
  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const store of storeNames) {
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

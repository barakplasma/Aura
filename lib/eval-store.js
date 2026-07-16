const DB_NAME = "aura-eval";
const DB_VERSION = 1;

export function createEvalStore({
  imagesAdapter = createIndexedDbAdapter("images"),
  runsAdapter = createIndexedDbAdapter("runs"),
} = {}) {
  return {
    listImages: () => imagesAdapter.getAll(),
    getImage: (id) => imagesAdapter.get(id),
    putImage: (image) => imagesAdapter.put(image),
    deleteImage: (id) => imagesAdapter.delete(id),
    clearImages: () => imagesAdapter.clear(),
    saveLastRun: (run) => runsAdapter.put({ ...run, id: "last" }),
    getLastRun: () => runsAdapter.get("last"),
    clearLastRun: () => runsAdapter.delete("last"),
  };
}

export function createMemoryAdapter(initial = []) {
  const map = new Map(initial.map((entry) => [entry.id, entry]));
  return {
    async getAll() {
      return Array.from(map.values());
    },
    async get(id) {
      return map.get(id) || null;
    },
    async put(value) {
      map.set(value.id, value);
      return value;
    },
    async delete(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}

export function createIndexedDbAdapter(storeName) {
  return {
    async getAll() {
      return request(storeName, "readonly", (store) => store.getAll());
    },
    async get(id) {
      const value = await request(storeName, "readonly", (store) => store.get(id));
      return value || null;
    },
    async put(value) {
      await request(storeName, "readwrite", (store) => store.put(value));
      return value;
    },
    async delete(id) {
      await request(storeName, "readwrite", (store) => store.delete(id));
    },
    async clear() {
      await request(storeName, "readwrite", (store) => store.clear());
    },
  };
}

function openDb() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available."));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("runs")) {
        db.createObjectStore("runs", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function request(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("IndexedDB transaction aborted."));
    };
  });
}

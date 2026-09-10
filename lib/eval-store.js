// Aura eval store — IndexedDB persistence for sample images and the last
// evaluation run. Images are 640×480 JPEG data URLs (30-60KB each), too big
// for the ~5MB localStorage quota shared with every other aura.* key, so
// they live in their own IndexedDB database. Adapter plumbing (real +
// in-memory) is shared with lib/alert-store.js via lib/idb-store.js.

import {
  createMemoryAdapter as createSharedMemoryAdapter,
  createIndexedDbAdapter as createSharedIndexedDbAdapter,
} from "./idb-store.js";

const DB_NAME = "aura-eval";
const DB_VERSION = 1;
const IMAGES = "images";
const RUNS = "runs";

export function makeId(prefix) {
  // Date.now() alone can collide when a multi-file upload lands several
  // records in the same millisecond — add a short random suffix.
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function createMemoryAdapter() {
  return createSharedMemoryAdapter([IMAGES, RUNS]);
}

export function createIndexedDbAdapter() {
  return createSharedIndexedDbAdapter({
    dbName: DB_NAME,
    version: DB_VERSION,
    storeNames: [IMAGES, RUNS],
  });
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

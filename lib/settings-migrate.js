// One-time boot migration for legacy provider config.
//
// The pre-React app wrote `aura.*` localStorage values as raw strings; the
// React app reads them through @uidotdev/usehooks, which JSON.parses with no
// try/catch, so a legacy value like `csk-…` throws and the stored config goes
// invisible (spurious "provider isn't set" warning). This rewrites any `aura.*`
// value that fails JSON.parse as its JSON-stringified form so it round-trips.
//
// Takes a Storage-like object (getItem/setItem/key/length) so it's testable
// with a plain stub in Node. Returns the number of keys migrated.
export function migrateLegacySettings(storage) {
  if (!storage || typeof storage.key !== "function") return 0;
  // Snapshot the keys first — rewriting entries mid-iteration by index is
  // fragile across Storage implementations.
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith("aura.")) keys.push(k);
  }
  let migrated = 0;
  for (const k of keys) {
    const raw = storage.getItem(k);
    if (raw == null) continue;
    try {
      JSON.parse(raw);
    } catch {
      storage.setItem(k, JSON.stringify(raw));
      migrated++;
    }
  }
  return migrated;
}

// One-time migration: the old `aura.scanEvery` setting (plain seconds) was
// replaced by `aura.scanEveryValue` + `aura.scanEveryUnit` (number + unit, so
// the UI can express 1s..12h+). Without this, an operator's saved cadence
// (e.g. 30s, set deliberately for cost control) would silently revert to the
// 5s default on upgrade — seed the new keys from the legacy value instead.
// Must run after migrateLegacySettings so `aura.scanEvery` is valid JSON.
export function migrateScanEveryKey(storage) {
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  )
    return false;
  if (storage.getItem("aura.scanEveryValue") != null) return false;
  const raw = storage.getItem("aura.scanEvery");
  if (raw == null) return false;
  let seconds;
  try {
    seconds = Number(JSON.parse(raw));
  } catch {
    seconds = Number(raw);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  storage.setItem("aura.scanEveryValue", JSON.stringify(seconds));
  storage.setItem("aura.scanEveryUnit", JSON.stringify("s"));
  return true;
}

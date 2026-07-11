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
  if (!storage || typeof storage.key !== 'function') return 0;
  // Snapshot the keys first — rewriting entries mid-iteration by index is
  // fragile across Storage implementations.
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith('aura.')) keys.push(k);
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

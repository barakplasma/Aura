// Initialize error tracking before anything else so early failures are caught.
import './monitoring.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { migrateLegacySettings, migrateScanEveryKey } from '../lib/settings-migrate.js';

// One-time migration BEFORE React reads localStorage: legacy v1 configs stored
// aura.* values as raw strings, which useLocalStorage's JSON.parse rejects.
// Then seed the new SCAN EVERY number+unit keys from the old single value —
// must run after the JSON-wrap migration above.
try {
  if (typeof localStorage !== 'undefined') {
    migrateLegacySettings(localStorage);
    migrateScanEveryKey(localStorage);
  }
} catch {}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Offline app shell — lets the installed PWA boot with no internet at all,
// which is what makes a local inference server (Ollama, LM Studio, llama.cpp)
// usable off-grid. './sw.js' resolves against the document base, so it works
// both at the GitHub Pages sub-path and at a localhost root. The worker never
// touches provider or webhook requests (see scripts/sw-template.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

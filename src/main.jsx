// Initialize error tracking before anything else so early failures are caught.
import './monitoring.js';
import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import '@ionic/react/css/padding.css';
import '@ionic/react/css/flex-utils.css';
import './ionic.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setupIonicReact } from '@ionic/react';
import App from './App.jsx';
import { migrateLegacySettings, migrateScanEveryKey, migrateBrowserModelKey, migrateLegacyRate } from '../lib/settings-migrate.js';

// Ionic's React integration must be initialized before the first web component
// renders. Without it a mobile browser can show partially-upgraded custom
// elements, especially after a cached deployment is refreshed.
setupIonicReact({ mode: 'md' });

// One-time migration BEFORE React reads localStorage: legacy v1 configs stored
// aura.* values as raw strings, which useLocalStorage's JSON.parse rejects.
// Then seed the new SCAN EVERY number+unit keys from the old single value —
// must run after the JSON-wrap migration above.
try {
  if (typeof localStorage !== 'undefined') {
    migrateLegacySettings(localStorage);
    migrateScanEveryKey(localStorage);
    migrateBrowserModelKey(localStorage);
    migrateLegacyRate(localStorage);
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
    // Always check the deployed worker itself from the network. This prevents a
    // cached old worker from pairing an old app.js with a newer stylesheet.
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

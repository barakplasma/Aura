// Initialize error tracking before anything else so early failures are caught.
import './monitoring.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { migrateLegacySettings } from '../lib/settings-migrate.js';

// One-time migration BEFORE React reads localStorage: legacy v1 configs stored
// aura.* values as raw strings, which useLocalStorage's JSON.parse rejects.
try {
  if (typeof localStorage !== 'undefined') migrateLegacySettings(localStorage);
} catch {}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

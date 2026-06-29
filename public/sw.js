// Aura service worker.
//
// Caches the app shell so the UI loads instantly and works offline (the app
// itself still needs network for inference, but the shell is install-free and
// resilient). Inference requests (/api/*) always go to the network.

const CACHE = 'aura-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/feedback.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never cache inference / health calls.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for the app shell: always pick up the latest version when
  // online (avoids the "stuck on an old cache" trap), and fall back to the
  // cached shell when offline. Successful responses refresh the cache.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

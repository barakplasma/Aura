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

  // Cache-first for the app shell, falling back to network.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});

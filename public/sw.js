// Aura offline app shell.
//
// GENERATED FILE — edit scripts/sw-template.js, then `npm run build`.
// The build injects the version stamp and the precache list below.
//
// This worker exists so the app boots with no internet at all, which only
// makes sense paired with a local inference server (Ollama, LM Studio,
// llama.cpp). It therefore caches the *shell only* and must never come
// between the app and a provider: anything that isn't a same-origin GET is
// left entirely alone, so `POST /chat/completions`, `GET /models` on another
// origin, and webhooks all go straight to the network.

const VERSION = "2b193f4eec2b";
const CACHE = `aura-shell-${VERSION}`;
const PRECACHE = [
  "index.html",
  "aura.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "assets/app.js",
  "assets/chunk-EvalScreen-Z6WOJ4T2.js",
  "assets/chunk-OptimizeScreen-IPBEXIHJ.js",
  "assets/chunk-chunk-7P5N73KK.js",
  "assets/chunk-chunk-ATZ3CM6O.js",
  "assets/chunk-chunk-NQYSPNR6.js",
  "assets/chunk-chunk-Q5DOJI7H.js",
  "assets/chunk-training-AFEB23P6.js",
];

// Same-origin absolute URLs for the precached shell, so lookups are exact.
const precached = new Set(
  PRECACHE.map((p) => new URL(p, self.registration.scope).href),
);

self.addEventListener("install", (event) => {
  // Deliberately no skipWaiting(): a new worker stays waiting until every tab
  // is gone. Swapping mid-session would let activate() delete the hashed
  // chunks a running monitor still needs to lazy-load.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("aura-shell-") && n !== CACHE)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a redeploy is picked up promptly, falling
  // back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(
        async () =>
          (await caches.match(
            new URL("index.html", self.registration.scope).href,
          )) || Response.error(),
      ),
    );
    return;
  }

  // Precached shell assets: cache first. Safe even for the unhashed app.js,
  // because every build regenerates this file with a new VERSION, which
  // triggers a fresh install and a fresh copy of everything.
  if (precached.has(url.href)) {
    event.respondWith(caches.match(url.href).then((hit) => hit || fetch(req)));
    return;
  }

  // Everything else same-origin (e.g. sourcemaps): network, cache as fallback.
  event.respondWith(
    fetch(req).catch(async () => (await caches.match(req)) || Response.error()),
  );
});

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

const VERSION = "__VERSION__";
const CACHE = `aura-shell-${VERSION}`;
const PRECACHE = __PRECACHE__;

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

// Opt-in only: the page's "update available" prompt (see src/main.jsx) posts
// this after the operator explicitly asks to reload now. A waiting worker
// never skips on its own — only an explicit user action interrupts a
// possibly-running monitor session.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
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

// Chrome treats a dedicated-worker script like a nested browsing context: when
// the document is COEP-isolated, the *response* for `assets/ml.worker.js` must
// itself declare `Cross-Origin-Embedder-Policy` (CORP alone is not enough), or
// the fetch dies with `ERR_BLOCKED_BY_RESPONSE` /
// `coep-frame-resource-needs-coep-header`. A worker-script load failure
// surfaces as an ErrorEvent with an empty message, so all the app can report is
// "Browser engine worker crashed: no message" — which is how this hid.
//
// Stamp both headers on every same-origin response we hand back, not just
// navigations: cache-first hits are constructed Responses, which is exactly
// where the proof otherwise goes missing.
function isolate(resp) {
  // Call sites pass either a Response or the Promise that resolves to one.
  if (resp && typeof resp.then === "function") return resp.then(isolate);
  if (!resp || !resp.body) return resp;
  const headers = new Headers(resp.headers);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a redeploy is picked up promptly, falling
  // back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        let resp;
        try {
          resp = await fetch(req);
        } catch {
          resp = await caches.match(
            new URL("index.html", self.registration.scope).href,
          );
        }
        if (!resp) return Response.error();
        // Cross-origin isolation, injected here because most places this app
        // is hosted cannot send it: GitHub Pages has no header configuration,
        // and `serve` (the dev loop) sends none either. Without isolation the
        // browser withholds SharedArrayBuffer, and ONNX Runtime then loads
        // `ort-wasm-simd-threaded.asyncify.wasm` — the single-threaded CPU
        // build — instead of the `jsep` build that can hold a WebGPU session.
        // That is why the BROWSER engine ran on one core with a GPU attached.
        // A synthetic response's headers count for isolation, so a service
        // worker is the only portable way to get GPU inference on Pages.
        //
        // COEP `require-corp` makes every cross-origin subresource prove it is
        // CORS-readable. Model weights come from the Hugging Face CDN, which
        // sends `Access-Control-Allow-Origin: *`; nothing else is loaded
        // cross-origin (see public/index.html: local CSS, icons, manifest).
        return isolate(
          new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: {
              ...Object.fromEntries(resp.headers.entries()),
              "Cross-Origin-Opener-Policy": "same-origin",
              "Cross-Origin-Embedder-Policy": "require-corp",
            },
          }),
        );
      })(),
    );
    return;
  }

  // Precached shell assets: cache first. Safe even for the unhashed app.js,
  // because every build regenerates this file with a new VERSION, which
  // triggers a fresh install and a fresh copy of everything.
  if (precached.has(url.href)) {
    event.respondWith(
      caches
        .match(url.href)
        .then((hit) => (hit ? isolate(hit) : isolate(fetch(req))))
        .catch(() => isolate(fetch(req))),
    );
    return;
  }

  // ONNX Runtime's WASM binary for the BROWSER engine — ~20MB, only needed
  // once someone actually turns that engine on, so it's cached on first use
  // (put-on-fetch) rather than precached at install time on every visit.
  // Same cache-first shape as the precached shell above, just deferred.
  if (url.pathname.includes("/ort/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          isolate(
            hit ||
              fetch(req).then((resp) => {
                if (resp.ok) caches.open(CACHE).then((cache) => cache.put(req, resp.clone()));
                return resp;
              }),
          ),
      ),
    );
    return;
  }

  // Everything else same-origin (e.g. sourcemaps, and the ORT loader bundles
  // the worker imports by relative URL): network, cache as fallback. Stamped
  // too — a script fetched by the worker needs the same COEP proof, and this
  // branch is where a newly added asset lands before it is precached.
  event.respondWith(
    isolate(fetch(req)).catch(async () => (await caches.match(req)) || Response.error()),
  );
});

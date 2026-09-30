// Static file server for the Aura PWA, run by the homelab behind Traefik
// (homelab-manifests/apps/aura). Traefik routes; this only serves files.
//
// Two rules matter beyond serving bytes:
//   - Updates are automatic (sw.js skipWaiting), so the browser must always
//     revalidate sw.js and the shell — a cached sw.js would freeze the app on
//     an old build. Only content-hashed chunks and the ORT binaries are
//     cached long.
//   - Cross-origin isolation (COOP/COEP) on every response, so even the very
//     first load is isolated; the service worker stamps it on afterwards.
package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

func handler(root string) http.Handler {
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Write([]byte("ok\n"))
			return
		}
		h := w.Header()
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Cache-Control", cacheControl(r.URL.Path))
		files.ServeHTTP(w, r)
	})
}

// cacheControl: hashed chunks and ORT binaries never change under the same
// name; everything else (sw.js, index.html, the unhashed app.js, manifest) is
// revalidated on every load — cheap, since unchanged files answer 304.
func cacheControl(path string) string {
	name := path[strings.LastIndex(path, "/")+1:]
	if strings.HasPrefix(path, "/ort/") || strings.HasPrefix(name, "chunk-") {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}

func main() {
	root := os.Getenv("AURA_ROOT")
	if root == "" {
		root = "/srv"
	}
	addr := os.Getenv("AURA_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("serving %s on %s", root, addr)
	log.Fatal(http.ListenAndServe(addr, handler(root)))
}

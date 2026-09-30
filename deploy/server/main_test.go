package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandler(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"index.html": "<html>", "sw.js": "//sw", "assets/chunk-ABC.js": "x"} {
		p := filepath.Join(dir, name)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	srv := httptest.NewServer(handler(dir))
	defer srv.Close()

	cases := []struct{ path, cache string }{
		{"/", "no-cache"},
		{"/sw.js", "no-cache"},
		{"/assets/chunk-ABC.js", "public, max-age=31536000, immutable"},
	}
	for _, c := range cases {
		resp, err := http.Get(srv.URL + c.path)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("%s: %v %v", c.path, err, resp)
		}
		if got := resp.Header.Get("Cache-Control"); got != c.cache {
			t.Errorf("%s cache = %q, want %q", c.path, got, c.cache)
		}
		if resp.Header.Get("Cross-Origin-Embedder-Policy") != "require-corp" ||
			resp.Header.Get("Cross-Origin-Opener-Policy") != "same-origin" {
			t.Errorf("%s missing isolation headers", c.path)
		}
	}
	if resp, _ := http.Get(srv.URL + "/healthz"); resp.StatusCode != 200 {
		t.Errorf("healthz = %d", resp.StatusCode)
	}
	if resp, _ := http.Get(srv.URL + "/nope"); resp.StatusCode != 404 {
		t.Errorf("unknown path = %d, want 404", resp.StatusCode)
	}
}

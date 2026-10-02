import { useEffect } from "react";

// Key read back by App.jsx after the reload an update causes, so an armed
// monitor carries on by itself instead of waiting for a RESUME tap.
export const UPDATED_FLAG = "aura.updatedReload";

// How often a long-lived tab asks the network whether a new build exists. A
// page that is never navigated would otherwise never notice a deploy.
const CHECK_EVERY_MS = 10 * 60 * 1000;

// Updates install themselves: sw.js (see scripts/sw-template.js) calls
// skipWaiting() on install, and this hook reloads the page as soon as the new
// worker takes control — no prompt. An armed monitor survives that: the flag
// below makes App.jsx resume it straight after the reload.
//
// The reload on `controllerchange` is also load-bearing on the very first
// visit, when the fresh worker's clients.claim() takes over an uncontrolled
// page: COOP/COEP (cross-origin isolation, hence threaded WASM and the
// WebGPU-capable ORT build) are stamped on by the service worker, so a page it
// didn't serve is never isolated. That first reload is not an update and sets
// no flag.
export function useServiceWorkerUpdate() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    const hadController = Boolean(navigator.serviceWorker.controller);
    let registration = null;
    let reloaded = false;

    function onControllerChange() {
      if (reloaded) return;
      reloaded = true;
      if (hadController) {
        try { sessionStorage.setItem(UPDATED_FLAG, "1"); } catch { /* private mode */ }
      }
      window.location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const check = () => { registration?.update().catch(() => {}); };
    navigator.serviceWorker.getRegistration().then((r) => { registration = r; check(); });
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(check, CHECK_EVERY_MS);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);
}

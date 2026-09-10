import { useCallback, useEffect, useState } from "react";

// Surfaces a "new version installed" banner and drives the reload once the
// operator accepts it. sw.js (see scripts/sw-template.js) deliberately never
// calls skipWaiting() on its own — a new worker sits in `registration.waiting`
// until every tab is closed, so an armed monitor session never has its
// hashed chunks pulled out from under it mid-scan. Reloading here is the
// explicit, user-initiated exception to that: we post SKIP_WAITING only after
// a click, then reload once the new worker actually takes over.
export function useServiceWorkerUpdate() {
  const [waitingWorker, setWaitingWorker] = useState(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    let cancelled = false;

    function watch(registration) {
      if (!registration || cancelled) return;
      // An update finished installing on a previous visit and is still
      // waiting (the operator never accepted it, or closed the tab first).
      if (registration.waiting) setWaitingWorker(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // 'installed' with an existing controller means this is a genuine
          // update — the very first install on a fresh visit has no
          // controller yet and shouldn't prompt anything.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            setWaitingWorker(installing);
          }
        });
      });
    }

    navigator.serviceWorker.getRegistration().then(watch);

    // Fires once the accepted update actually takes control — reload then,
    // not before, so the new worker (and its fresh cache) is what serves the
    // reloaded page.
    let reloaded = false;
    function onControllerChange() {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const reloadToUpdate = useCallback(() => {
    waitingWorker?.postMessage({ type: "SKIP_WAITING" });
  }, [waitingWorker]);

  return { updateAvailable: Boolean(waitingWorker), reloadToUpdate };
}

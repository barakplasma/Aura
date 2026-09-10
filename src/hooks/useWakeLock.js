import { useEffect, useRef, useState } from "react";

// Requests a screen wake lock while `active` is true, releasing it when
// `active` flips false or on unmount. The browser itself releases the lock
// whenever the page is hidden, so this re-acquires it on
// visibilitychange → visible while still active — that's the documented
// pattern for the Wake Lock API, not optional.
//
// Unsupported browsers and a rejected request (low battery mode, permissions
// policy) are handled the same way: no lock, a one-time `hint` string, and
// arming is never blocked on it.
export function useWakeLock(active) {
  const [held, setHeld] = useState(false);
  const [hint, setHint] = useState("");
  const sentinelRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;

    if (!("wakeLock" in navigator)) {
      setHint("Keep the screen on — this browser can't hold a wake lock.");
      return undefined;
    }

    let cancelled = false;

    async function acquire() {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        setHeld(true);
        setHint("");
        sentinel.addEventListener("release", () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
          setHeld(false);
        });
      } catch {
        setHint("Keep the screen on — this browser can't hold a wake lock.");
        setHeld(false);
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible" && !sentinelRef.current) {
        acquire();
      }
    }

    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (sentinelRef.current) {
        sentinelRef.current.release().catch(() => {});
        sentinelRef.current = null;
      }
      setHeld(false);
    };
  }, [active]);

  return { held, hint };
}

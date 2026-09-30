import { useEffect, useState } from 'react';

const SCAN_STATES = new Set(['alert', 'watching', 'degraded']);

// The last few scan outcomes, for the dot row on the verdict card. Lives above
// the Watch screen so leaving the tab doesn't forget them.
export function useRecentVerdicts(verdict, size = 5) {
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    // 'watching' also names the "Monitoring…" lifecycle text; only a verdict
    // that carries a reason is a scan result.
    if (!SCAN_STATES.has(verdict.state) || verdict.reason == null) return;
    setRecent((r) => [...r, { state: verdict.state, at: verdict.at, entryId: verdict.entryId }].slice(-size));
  }, [verdict, size]);
  return recent;
}

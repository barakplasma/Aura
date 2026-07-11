import ProgressBar, { progressLabel } from '../components/ProgressBar.jsx';

// ms → compact human string ("850ms" / "1.4s"), "OFF" when there's no forced
// timeout (MAX mode), or "—" when unknown (no samples yet).
function fmtMs(ms) {
  if (ms === Infinity) return 'OFF';
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Controls panel for the monitor tab. The camera preview itself lives in
// MonitorStage (mounted at app level) so it survives tab switches.
export default function MonitorScreen({ running, telemetry, progress, stats, onToggle, hasApiKey, demoMode, onStartDemo, onOpenSettings }) {
  const showProgress = running && progress && progress.phase !== 'idle';
  return (
    <div className="screen-monitor">
      <div className="monitor-panel">
        <div className="panel-label">DETECTION</div>
        <div className="panel-row">
          <span className="panel-k">CONF</span>
          <span className="panel-v amber">{telemetry.confidence}%</span>
        </div>
        <div className="panel-row">
          <span className="panel-k">LATENCY</span>
          <span className="panel-v">{telemetry.latency}ms</span>
        </div>
        <div className="panel-row">
          <span className="panel-k">ENGINE</span>
          <span className="panel-v">{telemetry.mode}</span>
        </div>
        <div className="panel-row">
          <span className="panel-k">TOKENS</span>
          <span className="panel-v">{telemetry.tokens}</span>
        </div>
        <div className="panel-row">
          <span className="panel-k" title="Effective throughput from the cycle-period EMA">SCANS/HR</span>
          <span className="panel-v">{telemetry.scansPerHr}</span>
        </div>
        <div className="panel-row">
          <span className="panel-k" title="Projected spend at the current cadence">EST $/HR</span>
          <span className="panel-v amber">${telemetry.costPerHr}</span>
        </div>
      </div>

      {showProgress && (
        <div className="monitor-panel">
          <div className="panel-label">SCAN CYCLE</div>
          <ProgressBar phase={progress.phase} pct={progress.pct} label={progressLabel(progress)} />
        </div>
      )}

      <div className="monitor-panel">
        <div className="panel-label">FRAME TIMING</div>
        <div className="panel-row">
          <span className="panel-k">MEDIAN</span>
          <span className="panel-v">{fmtMs(stats.p50)}</span>
        </div>
        <div className="panel-row">
          <span className="panel-k">P90</span>
          <span className="panel-v">{fmtMs(stats.p90)}</span>
        </div>
        <div className="panel-row">
          <span className="panel-k" title="Auto-tuned to mean + 1 stddev of this session's latencies. Off in MAX mode.">TIMEOUT</span>
          <span className="panel-v amber">{fmtMs(stats.timeoutMs)}</span>
        </div>
        <div className="panel-row">
          <span className="panel-k">SAMPLES</span>
          <span className="panel-v">{stats.count}</span>
        </div>
      </div>

      {!hasApiKey && !demoMode && !running && (
        <div className="setup-callout">
          <div className="panel-label">NO API KEY CONFIGURED</div>
          <p className="setup-text">Add a provider key to start monitoring, or try a simulated demo.</p>
          <div className="btn-row">
            <button className="dc-btn" onClick={onOpenSettings}>OPEN SETTINGS</button>
            <button className="dc-btn outline" onClick={onStartDemo}>TRY DEMO</button>
          </div>
        </div>
      )}
      <button
        id="toggle"
        className={`arm-btn ${running ? 'armed' : ''}`}
        onClick={onToggle}
        aria-pressed={running}
      >
        {running ? '■ DISARM' : '▶ ARM SENTRY'}
      </button>
    </div>
  );
}

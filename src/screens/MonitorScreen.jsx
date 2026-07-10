// Controls panel for the monitor tab. The camera preview itself lives in
// MonitorStage (mounted at app level) so it survives tab switches.
export default function MonitorScreen({ running, telemetry, onToggle, hasApiKey, demoMode, onStartDemo, onOpenSettings }) {
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

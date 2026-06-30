export default function MonitorScreen({ videoRef, canvasRef, running, status, dotClass, flashActive, telemetry, onToggle }) {
  return (
    <div className="screen screen-monitor">
      <div className="monitor-viewport">
        <video ref={videoRef} id="video" className="camera-feed" playsInline muted autoPlay />
        <canvas ref={canvasRef} id="canvas" width="640" height="480" hidden />
        <div className={`flash-overlay ${flashActive ? 'on' : ''}`} />
        <div className="scan-line" />
        <div className="monitor-status-bar">
          <span className={`status-dot ${dotClass}`} />
          <span className="monitor-status-text" role="status" aria-live="polite">{status}</span>
        </div>
      </div>
      <div className="monitor-sidebar">
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
        <button
          id="toggle"
          className={`arm-btn ${running ? 'armed' : ''}`}
          onClick={onToggle}
          aria-pressed={running}
        >
          {running ? '■ DISARM' : '▶ ARM SENTRY'}
        </button>
      </div>
    </div>
  );
}

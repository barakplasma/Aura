export default function TopBar({ dotClass, telemetry, model }) {
  const statusLabel = dotClass === 'live' ? 'ACTIVE' : dotClass === 'mock' ? 'MOCK' : 'STANDBY';
  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <span className="app-logo">◈ AURA</span>
        <span className={`status-badge ${dotClass}`} aria-label={`Status: ${statusLabel}`}>
          {statusLabel}
        </span>
      </div>
      <div className="top-bar-right">
        {model && <span className="telem-pair"><span className="telem-k">MODEL</span><span className="telem-v">{model.split('/').pop()}</span></span>}
        <span className="telem-pair"><span className="telem-k">LAT</span><span className="telem-v">{telemetry.latency}ms</span></span>
        <span className="telem-pair"><span className="telem-k">CONF</span><span className="telem-v">{telemetry.confidence}%</span></span>
        <span className="telem-pair"><span className="telem-k">COST</span><span className="telem-v">${telemetry.cost}</span></span>
      </div>
    </header>
  );
}

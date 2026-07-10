// The camera stage — always mounted at app level so the <video> keeps its
// stream (and scanning keeps running) when the user navigates between tabs.
// The stageMode class picks the presentation:
//   stage-full      Monitor tab, preview expanded
//   stage-collapsed Monitor tab, preview hidden (thin status strip)
//   stage-pip       other tab while armed — floating mini thumbnail
//   stage-parked    other tab, idle — fully hidden (no capture running)
export default function MonitorStage({ videoRef, canvasRef, stageMode, flashActive, dotClass, status, collapsed, onToggleCollapse, onTap }) {
  const pip = stageMode === 'stage-pip';
  return (
    <div
      className={`monitor-stage ${stageMode}`}
      onClick={pip ? onTap : undefined}
      role={pip ? 'button' : undefined}
      aria-label={pip ? 'Return to monitor' : undefined}
    >
      <video ref={videoRef} id="video" className="camera-feed" playsInline muted autoPlay />
      <canvas ref={canvasRef} id="canvas" width="640" height="480" hidden />
      <div className={`flash-overlay ${flashActive ? 'on' : ''}`} />
      <div className="scan-line" />
      <div className="monitor-status-bar">
        <span className={`status-dot ${dotClass}`} />
        <span className="monitor-status-text" role="status" aria-live="polite">{status}</span>
        <button className="preview-toggle" onClick={onToggleCollapse} aria-pressed={collapsed}>
          {collapsed ? '▣ SHOW CAM' : '▢ HIDE CAM'}
        </button>
      </div>
    </div>
  );
}

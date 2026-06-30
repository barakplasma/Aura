export default function MissionScreen({ mission, setMission, action, setAction, speech, setSpeech, haptics, setHaptics, onNavigateMonitor, onNavigateOptimize }) {
  return (
    <div className="screen screen-mission">
      <div className="screen-header">
        <span className="screen-title">MISSION PARAMETERS</span>
      </div>

      <div className="form-group">
        <label className="field-label">WATCH FOR</label>
        <textarea
          id="mission"
          className="dc-textarea"
          rows={3}
          value={mission}
          onChange={e => setMission(e.target.value)}
          placeholder="e.g. Alert if someone is loitering near the front door."
        />
      </div>

      <div className="form-group">
        <label className="field-label">ON ALERT — ANNOUNCE</label>
        <textarea
          id="action"
          className="dc-textarea"
          rows={3}
          value={action}
          onChange={e => setAction(e.target.value)}
          placeholder="e.g. Firmly tell the person they are being recorded and to leave."
        />
      </div>

      <div className="form-group">
        <label className="field-label">ALERT RESPONSES</label>
        <div className="toggle-row">
          <label className="toggle-label">
            <input
              id="speech-toggle"
              type="checkbox"
              className="dc-checkbox"
              checked={speech}
              onChange={e => setSpeech(e.target.checked)}
            />
            <span>SPEAK ALERTS</span>
          </label>
          <label className="toggle-label">
            <input
              id="haptics-toggle"
              type="checkbox"
              className="dc-checkbox"
              checked={haptics}
              onChange={e => setHaptics(e.target.checked)}
            />
            <span>VIBRATE</span>
          </label>
        </div>
      </div>

      <div className="examples-hint">
        <span className="hint-icon">◈</span>
        <span>
          The model decides when to trigger based on your mission and examples.{' '}
          <button className="link-btn" onClick={onNavigateOptimize}>Add examples →</button>
        </span>
      </div>

      <button className="dc-btn primary wide" onClick={onNavigateMonitor}>
        ▶ DEPLOY &amp; ARM
      </button>
    </div>
  );
}

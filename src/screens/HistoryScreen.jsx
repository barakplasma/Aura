// Alert history + review. Every alert keeps the exact frame it fired on so the
// operator can eyeball it and, if it was wrong, mark it a FALSE POSITIVE — that
// writes a "don't fire on this" training example. A few recent non-alert frames
// are also kept so a genuine miss can be marked a FALSE NEGATIVE ("should have
// fired").
export default function HistoryScreen({ alerts, missed, markedIds, onMarkExample }) {
  const marked = markedIds || {};
  const missedFrames = missed || [];
  return (
    <div className="screen screen-history">
      <div className="screen-header">
        <span className="screen-title">ALERT HISTORY</span>
        <span className="screen-subtitle">{alerts.length} event{alerts.length !== 1 ? 's' : ''}</span>
      </div>

      {alerts.length === 0 ? (
        <div className="empty-state">NO EVENTS LOGGED</div>
      ) : (
        <ul id="alert-log" className="alert-log" aria-live="polite">
          {alerts.map(a => (
            <li key={a.id} className="alert-row">
              {a.image && <img className="alert-thumb" src={a.image} alt="Frame that triggered this alert" />}
              <div className="alert-body">
                <div className="alert-line">
                  <span className="alert-time">{a.time}</span>
                  {a.conf != null && <span className="alert-conf amber">{a.conf}%</span>}
                  <span className="alert-msg">{a.message}</span>
                </div>
                {a.reason && a.reason !== a.message && <div className="alert-reason">{a.reason}</div>}
                <div className="alert-actions">
                  {marked[a.id] ? (
                    <span className="mark-done">✓ SAVED AS EXAMPLE</span>
                  ) : (
                    <button className="mark-btn" onClick={() => onMarkExample(a, 'false-positive')}>
                      ✗ FALSE POSITIVE
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {missedFrames.length > 0 && (
        <>
          <div className="screen-header history-subhead">
            <span className="screen-title">RECENT FRAMES</span>
            <span className="screen-subtitle">no alert — mark a miss</span>
          </div>
          <ul className="alert-log" aria-label="Recent non-alert frames">
            {missedFrames.map(m => (
              <li key={m.id} className="alert-row">
                <img className="alert-thumb" src={m.image} alt="Recent frame with no alert" />
                <div className="alert-body">
                  <div className="alert-line">
                    <span className="alert-time">{m.time}</span>
                    <span className="alert-msg dim">{m.reason || 'No alert.'}</span>
                  </div>
                  <div className="alert-actions">
                    {marked[m.id] ? (
                      <span className="mark-done">✓ SAVED AS EXAMPLE</span>
                    ) : (
                      <button className="mark-btn" onClick={() => onMarkExample(m, 'false-negative')}>
                        ⚑ MISSED — SHOULD ALERT
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

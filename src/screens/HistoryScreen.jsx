export default function HistoryScreen({ alerts }) {
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
              <span className="alert-time">{a.time}</span>
              {a.conf != null && <span className="alert-conf amber">{a.conf}%</span>}
              <span className="alert-msg">{a.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

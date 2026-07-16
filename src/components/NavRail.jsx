import { memo } from 'react';

const SCREENS = [
  { id: 'mission', label: 'MISSION', num: '01' },
  { id: 'monitor', label: 'MONITOR', num: '02' },
  { id: 'history', label: 'HISTORY', num: '03' },
  { id: 'optimize', label: 'OPTIMIZE', num: '04' },
  { id: 'eval', label: 'EVAL', num: '05' },
  { id: 'settings', label: 'SETTINGS', num: '06' },
];

// Memoized — per-scan telemetry updates re-render App, but the rail only
// cares about navigation state.
function NavRail({ screen, setScreen }) {
  return (
    <nav className="nav-rail">
      {SCREENS.map(s => (
        <button
          key={s.id}
          className={`nav-item ${screen === s.id ? 'active' : ''}`}
          onClick={() => setScreen(s.id)}
        >
          <span className="nav-num">{s.num}</span>
          <span className="nav-label">{s.label}</span>
        </button>
      ))}
    </nav>
  );
}

export default memo(NavRail);

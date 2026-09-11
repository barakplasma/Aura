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
//
// `hidden` is a list of screen ids to leave out. The numbers stay attached to
// the screen rather than being recomputed from the visible subset, so
// OPTIMIZE disappearing doesn't renumber EVAL and SETTINGS under the
// operator's fingers.
function NavRail({ screen, setScreen, hidden }) {
  const visible = hidden?.length ? SCREENS.filter(s => !hidden.includes(s.id)) : SCREENS;
  return (
    <nav className="nav-rail">
      {visible.map(s => (
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

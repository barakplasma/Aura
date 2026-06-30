const SCREENS = [
  { id: 'mission', label: 'MISSION', num: '01' },
  { id: 'monitor', label: 'MONITOR', num: '02' },
  { id: 'history', label: 'HISTORY', num: '03' },
  { id: 'optimize', label: 'OPTIMIZE', num: '04' },
  { id: 'settings', label: 'SETTINGS', num: '05' },
];

export default function NavRail({ screen, setScreen }) {
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

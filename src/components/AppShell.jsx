import { Bell, Eye, FlaskConical, Radio, Settings } from 'lucide-react';
import { cn } from '../ui/cn.js';
import { Chip } from '../ui/chip.jsx';

// Four destinations. Lab is a rail item on desktop and lives behind Setup on
// a phone, where three big tabs beat four small ones.
const DESTINATIONS = [
  { id: 'watch', label: 'Watch', Icon: Eye },
  { id: 'alerts', label: 'Alerts', Icon: Bell },
  { id: 'setup', label: 'Setup', Icon: Settings },
  { id: 'lab', label: 'Lab', Icon: FlaskConical, railOnly: true },
];

const CHIP = {
  live: ['ok', 'Active'],
  demo: ['warn', 'Demo'],
  browser: ['ok', 'Active'],
};

function NavButton({ dest, active, onSelect, rail }) {
  const { id, label, Icon } = dest;
  return (
    <button
      type="button"
      data-nav={id}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(id)}
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-1 text-xs font-semibold',
        rail ? 'min-h-16 w-full flex-none' : 'min-h-14',
        active ? 'text-accent' : 'text-text-dim',
      )}
    >
      <Icon className="size-6" aria-hidden />
      {label}
    </button>
  );
}

// Layout below 700 px: header, then the stage above the panel, tab bar last.
// 700 px and up: stage and panel side by side. 1100 px and up: a rail replaces
// the tab bar. `children` (the stage, then a panel or a screen) sit in one
// <main>, in a stable order, so the camera <video> is never remounted.
export default function AppShell({ screen, onNavigate, dotClass, children }) {
  const [tone, label] = CHIP[dotClass] || ['neutral', 'Standby'];
  // Lab has no phone tab: it highlights Setup, which links to it.
  const phoneActive = screen === 'lab' ? 'setup' : screen;
  return (
    <div data-ui="" className="flex min-h-0 flex-1 bg-bg-0">
      <nav className="hidden w-18 shrink-0 flex-col border-r border-border bg-bg-1 pt-2 xl:flex" aria-label="Main">
        {DESTINATIONS.map((d) => (
          <NavButton key={d.id} dest={d} rail active={screen === d.id} onSelect={onNavigate} />
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 [@media(height<500px)]:hidden items-center justify-between border-b border-border bg-bg-1 px-4">
          <span className="text-xl font-semibold">Aura</span>
          <Chip tone={tone}><Radio className="size-4" aria-hidden />{label}</Chip>
        </header>
        <main
          className={cn(
            'min-h-0 flex-1',
            screen === 'watch'
              ? 'grid grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[55%_minmax(0,1fr)] md:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_400px]'
              : 'flex flex-col',
          )}
        >
          {children}
        </main>
        <nav className="flex shrink-0 border-t border-border bg-bg-1 pb-[env(safe-area-inset-bottom)] xl:hidden" aria-label="Main">
          {DESTINATIONS.filter((d) => !d.railOnly).map((d) => (
            <NavButton key={d.id} dest={d} active={phoneActive === d.id} onSelect={onNavigate} />
          ))}
        </nav>
      </div>
    </div>
  );
}

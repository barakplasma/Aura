import { IonIcon, IonLabel, IonTabBar, IonTabButton } from '@ionic/react';
import { flask, home, list, notifications, settings, speedometer } from 'ionicons/icons';
const SCREENS = [
  { id: 'monitor', label: 'Monitor', icon: home }, { id: 'mission', label: 'Mission', icon: list },
  { id: 'history', label: 'Alerts', icon: notifications }, { id: 'settings', label: 'Settings', icon: settings },
  { id: 'optimize', label: 'Tune', icon: flask }, { id: 'eval', label: 'Eval', icon: speedometer },
];

// Memoized — per-scan telemetry updates re-render App, but the rail only
// cares about navigation state.
//
// `hidden` is a list of screen ids to leave out. The numbers stay attached to
// the screen rather than being recomputed from the visible subset, so
// OPTIMIZE disappearing doesn't renumber EVAL and SETTINGS under the
// operator's fingers.
function NavRail({ screen, setScreen, hidden }) {
  return <IonTabBar slot="bottom" selectedTab={screen}>{SCREENS.map(s => <IonTabButton key={s.id} tab={s.id} selected={screen === s.id} onClick={() => setScreen(s.id)}><IonIcon icon={s.icon} /><IonLabel>{s.label}</IonLabel></IonTabButton>)}</IonTabBar>;
}
export default NavRail;

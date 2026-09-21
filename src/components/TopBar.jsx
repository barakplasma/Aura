import { IonBadge, IonButtons, IonChip, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/react';
import { radioButtonOn } from 'ionicons/icons';
export default function TopBar({ dotClass }) {
  const label = dotClass === 'live' ? 'Active' : dotClass === 'demo' ? 'Demo' : 'Standby';
  return <IonHeader><IonToolbar><IonTitle>Aura</IonTitle><IonButtons slot="end"><IonChip color={dotClass === 'live' ? 'success' : dotClass === 'demo' ? 'warning' : 'medium'}><IonIcon icon={radioButtonOn} /><IonBadge color="transparent">{label}</IonBadge></IonChip></IonButtons></IonToolbar></IonHeader>;
}

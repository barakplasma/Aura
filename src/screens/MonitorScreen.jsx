import {
  IonButton, IonCard, IonCardContent, IonContent,
} from '@ionic/react';

export default function MonitorScreen({
  running, onToggle, providerReady, engine,
  demoMode, onStartDemo, onOpenSettings,
}) {
  return <IonContent className="aura-page monitor-content">
    {!providerReady && !demoMode && !running && <IonCard className="notice"><IonCardContent>
      <strong>Finish setup to monitor</strong>
      <p>{engine === 'browser'
        ? 'Download a browser model in Settings.'
        : 'Choose a provider and vision model in Settings, or try the demo.'}</p>
      <IonButton fill="outline" onClick={onOpenSettings}>Open settings</IonButton>
      <IonButton fill="clear" onClick={onStartDemo}>Try demo</IonButton>
    </IonCardContent></IonCard>}

    <div className="wide-action monitor-action">
      <IonButton id="toggle" expand="block" size="large" color={running ? 'danger' : 'primary'} onClick={onToggle} aria-pressed={running}>
        {running ? 'Disarm monitoring' : 'Arm monitoring'}
      </IonButton>
    </div>
  </IonContent>;
}

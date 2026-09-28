import { IonButton, IonContent, IonItem, IonList, IonNote, IonTextarea, IonToggle } from '@ionic/react';
import { missionToQuestion } from '../../lib/decision.js';

export default function MissionScreen({
  mission, setMission, action, setAction, speech, setSpeech, haptics, setHaptics,
  onDeployAndArm, onNavigateOptimize,
  engine,
}) {
  const isDecision = engine === 'decision';
  // What the next scan will actually ask — always this mission's own
  // yes/no template (lib/decision.js missionToQuestion); nothing to write
  // or keep in sync separately.
  const active = isDecision ? missionToQuestion({ mission }) : null;

  return <IonContent className="aura-page">
    <h1 className="page-heading">Set your mission</h1>
    <p className="page-subtitle">Describe what Aura should notice and how it should respond.</p>
    <IonList inset>
      <IonItem><IonTextarea label="Watch for" labelPlacement="stacked" value={mission} onIonInput={e => setMission(e.detail.value || '')} placeholder="Alert if someone is loitering near the front door." autoGrow /></IonItem>
      <IonItem><IonTextarea label="On alert, announce" labelPlacement="stacked" value={action} onIonInput={e => setAction(e.detail.value || '')} placeholder="Tell the person they are being recorded and to leave." autoGrow /></IonItem>
      <IonItem><IonToggle checked={speech} onIonChange={e => setSpeech(e.detail.checked)}>Speak alerts</IonToggle></IonItem>
      <IonItem><IonToggle checked={haptics} onIonChange={e => setHaptics(e.detail.checked)}>Vibrate</IonToggle></IonItem>
    </IonList>
    {isDecision && <IonNote className="ion-padding">
      The decision model answers one yes/no question per frame, built from "Watch for" above:
      <br /><strong id="decision-active-question">{active.question}</strong>
    </IonNote>}
    {!isDecision && <IonNote className="ion-padding">Improve detection with examples in <IonButton fill="clear" size="small" onClick={onNavigateOptimize}>Optimize</IonButton>.</IonNote>}
    <div className="wide-action"><IonButton expand="block" size="large" onClick={onDeployAndArm}>Deploy &amp; arm</IonButton></div>
  </IonContent>;
}

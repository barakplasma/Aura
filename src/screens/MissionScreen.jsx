import { useState } from 'react';
import { IonButton, IonContent, IonItem, IonList, IonNote, IonTextarea, IonToggle } from '@ionic/react';
import { compileDecisionQuestion } from '../../lib/aura.js';
import { missionToQuestion } from '../../lib/decision.js';

export default function MissionScreen({
  mission, setMission, action, setAction, speech, setSpeech, haptics, setHaptics,
  onDeployAndArm, onNavigateOptimize,
  engine, decisionQuestion, setDecisionQuestion, decisionCompiled, setDecisionCompiled,
  baseUrl, apiKey, model,
}) {
  const [compiling, setCompiling] = useState(false);
  const [compileMsg, setCompileMsg] = useState('');
  const isDecision = engine === 'decision';
  // What the next scan will actually ask: explicit, else compiled for this
  // exact mission, else the template (lib/decision.js missionToQuestion).
  const active = isDecision ? missionToQuestion({ mission, explicit: decisionQuestion, compiled: decisionCompiled }) : null;

  // One chat call per mission edit, never per scan.
  async function handleCompile() {
    setCompiling(true);
    setCompileMsg('');
    try {
      setDecisionCompiled(await compileDecisionQuestion({ baseUrl, model, apiKey, mission }));
      setCompileMsg((decisionQuestion || '').trim() ? 'Compiled — clear the question field above to use it.' : 'Compiled.');
    } catch (err) {
      setCompileMsg(`Compile failed: ${err.message}`);
    } finally {
      setCompiling(false);
    }
  }

  return <IonContent className="aura-page">
    <h1 className="page-heading">Set your mission</h1>
    <p className="page-subtitle">Describe what Aura should notice and how it should respond.</p>
    <IonList inset>
      <IonItem><IonTextarea label="Watch for" labelPlacement="stacked" value={mission} onIonInput={e => setMission(e.detail.value || '')} placeholder="Alert if someone is loitering near the front door." autoGrow /></IonItem>
      {isDecision && <IonItem><IonTextarea id="decision-question" label="Decision question (yes = alert)" labelPlacement="stacked" value={decisionQuestion} onIonInput={e => setDecisionQuestion(e.detail.value || '')} placeholder="Is a person standing at the front door?" autoGrow /></IonItem>}
      <IonItem><IonTextarea label="On alert, announce" labelPlacement="stacked" value={action} onIonInput={e => setAction(e.detail.value || '')} placeholder="Tell the person they are being recorded and to leave." autoGrow /></IonItem>
      <IonItem><IonToggle checked={speech} onIonChange={e => setSpeech(e.detail.checked)}>Speak alerts</IonToggle></IonItem>
      <IonItem><IonToggle checked={haptics} onIonChange={e => setHaptics(e.detail.checked)}>Vibrate</IonToggle></IonItem>
    </IonList>
    {isDecision && <IonNote className="ion-padding">
      The decision model answers one yes/no question per frame.
      Asking: <strong id="decision-active-question">{active.question}</strong> ({active.source}).{' '}
      <IonButton fill="clear" size="small" disabled={compiling || !baseUrl || !model || !mission.trim()} onClick={handleCompile}>
        {compiling ? 'Compiling…' : 'Compile from mission'}
      </IonButton>
      {!(baseUrl && model) && ' Compiling needs a provider in Settings.'}
      {compileMsg && <> {compileMsg}</>}
    </IonNote>}
    {!isDecision && <IonNote className="ion-padding">Improve detection with examples in <IonButton fill="clear" size="small" onClick={onNavigateOptimize}>Optimize</IonButton>.</IonNote>}
    <div className="wide-action"><IonButton expand="block" size="large" onClick={onDeployAndArm}>Deploy &amp; arm</IonButton></div>
  </IonContent>;
}

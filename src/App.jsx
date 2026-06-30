import { useState, useRef } from 'react';
import { useLocalStorage } from '@uidotdev/usehooks';
import { getExamples, getOptimizedArtifact } from '../lib/aura.js';
import { useMonitor } from './hooks/useMonitor.js';
import TopBar from './components/TopBar.jsx';
import NavRail from './components/NavRail.jsx';
import MissionScreen from './screens/MissionScreen.jsx';
import MonitorScreen from './screens/MonitorScreen.jsx';
import HistoryScreen from './screens/HistoryScreen.jsx';
import OptimizeScreen from './screens/OptimizeScreen.jsx';
import SettingsScreen from './screens/SettingsScreen.jsx';

export default function App() {
  const [screen, setScreen] = useState('monitor');

  // Settings — persisted via localStorage (JSON-serialized by @uidotdev/usehooks)
  const [baseUrl, setBaseUrl] = useLocalStorage('aura.baseUrl', 'https://api.cerebras.ai/v1');
  const [apiKey, setApiKey] = useLocalStorage('aura.apiKey', '');
  const [model, setModel] = useLocalStorage('aura.model', '');
  const [mission, setMission] = useLocalStorage('aura.mission', '');
  const [action, setAction] = useLocalStorage('aura.action', '');
  const [scanEvery, setScanEvery] = useLocalStorage('aura.scanEvery', 5);
  const [rate, setRate] = useLocalStorage('aura.rate', '0.10');
  const [speech, setSpeech] = useLocalStorage('aura.speech', true);
  const [haptics, setHaptics] = useLocalStorage('aura.haptics', true);
  const [webhookUrl, setWebhookUrl] = useLocalStorage('aura.webhookUrl', '');
  const [webhookMethod, setWebhookMethod] = useLocalStorage('aura.webhookMethod', 'POST');
  const [webhookHeaders, setWebhookHeaders] = useLocalStorage('aura.webhookHeaders', '');
  const [webhookAction, setWebhookAction] = useLocalStorage('aura.webhookAction', '');
  const [webhookSchema, setWebhookSchema] = useLocalStorage('aura.webhookSchema', '');

  // Live settings ref — updated every render so tick() sees current values without stale closures
  const settingsRef = useRef({});
  settingsRef.current = {
    baseUrl, apiKey, model, mission, action,
    threshold: 0, scanEvery, rate,
    speech, haptics,
    webhookUrl, webhookMethod, webhookHeaders, webhookAction, webhookSchema,
    examples: getExamples(),
    optimizedInstruction: getOptimizedArtifact()?.program?.instruction,
  };

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const { running, status, dotClass, flashActive, telemetry, alerts, start, stop } = useMonitor({ settingsRef, videoRef, canvasRef });

  function handleToggle() {
    if (running) stop();
    else start();
  }

  function handleStatusMsg(msg) {
    // Used by SettingsScreen to surface transient messages
    console.info('[aura]', msg);
  }

  return (
    <div className="app">
      <TopBar dotClass={dotClass} telemetry={telemetry} model={model} />
      <div className="app-body">
        <NavRail screen={screen} setScreen={setScreen} />
        <main className="main-content">
          {screen === 'mission' && (
            <MissionScreen
              mission={mission} setMission={setMission}
              action={action} setAction={setAction}
              speech={speech} setSpeech={setSpeech}
              haptics={haptics} setHaptics={setHaptics}
              onNavigateMonitor={() => setScreen('monitor')}
              onNavigateOptimize={() => setScreen('optimize')}
            />
          )}
          {screen === 'monitor' && (
            <MonitorScreen
              videoRef={videoRef} canvasRef={canvasRef}
              running={running} status={status}
              dotClass={dotClass} flashActive={flashActive}
              telemetry={telemetry}
              onToggle={handleToggle}
            />
          )}
          {screen === 'history' && (
            <HistoryScreen alerts={alerts} />
          )}
          {screen === 'optimize' && (
            <OptimizeScreen />
          )}
          {screen === 'settings' && (
            <SettingsScreen
              baseUrl={baseUrl} setBaseUrl={setBaseUrl}
              apiKey={apiKey} setApiKey={setApiKey}
              model={model} setModel={setModel}
              scanEvery={scanEvery} setScanEvery={setScanEvery}
              rate={rate} setRate={setRate}
              webhookUrl={webhookUrl} setWebhookUrl={setWebhookUrl}
              webhookMethod={webhookMethod} setWebhookMethod={setWebhookMethod}
              webhookHeaders={webhookHeaders} setWebhookHeaders={setWebhookHeaders}
              webhookAction={webhookAction} setWebhookAction={setWebhookAction}
              webhookSchema={webhookSchema} setWebhookSchema={setWebhookSchema}
              onStatusMsg={handleStatusMsg}
            />
          )}
        </main>
      </div>
    </div>
  );
}

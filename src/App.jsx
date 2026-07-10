import { useState, useRef, lazy, Suspense } from 'react';
import { useLocalStorage } from '@uidotdev/usehooks';
import { useMonitor } from './hooks/useMonitor.js';
import TopBar from './components/TopBar.jsx';
import NavRail from './components/NavRail.jsx';
import MonitorStage from './components/MonitorStage.jsx';
import MissionScreen from './screens/MissionScreen.jsx';
import MonitorScreen from './screens/MonitorScreen.jsx';
import HistoryScreen from './screens/HistoryScreen.jsx';
import SettingsScreen from './screens/SettingsScreen.jsx';

// Lazy — keeps the optimizer screen (and, transitively, @ax-llm/ax) out of
// the initial bundle.
const OptimizeScreen = lazy(() => import('./screens/OptimizeScreen.jsx'));

export default function App() {
  const [screen, setScreen] = useState('monitor');
  // Session-only on purpose: a reload always exits demo mode.
  const [demoMode, setDemoMode] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorage('aura.previewCollapsed', false);

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
    speech, haptics, demo: demoMode,
    webhookUrl, webhookMethod, webhookHeaders, webhookAction, webhookSchema,
  };

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const { running, status, dotClass, flashActive, telemetry, alerts, start, stop } = useMonitor({ settingsRef, videoRef, canvasRef });

  function handleToggle() {
    if (running) stop();
    else start();
  }

  function handleStartDemo() {
    setDemoMode(true);
    // start() reads the settings ref before the re-render lands, so flip the
    // demo flag on the ref directly too.
    settingsRef.current.demo = true;
    start();
  }

  function handleExitDemo() {
    if (running) stop();
    setDemoMode(false);
  }

  function handleStatusMsg(msg) {
    // Used by SettingsScreen to surface transient messages
    console.info('[aura]', msg);
  }

  // How the always-mounted camera stage presents itself (see MonitorStage).
  const stageMode = screen === 'monitor'
    ? (previewCollapsed ? 'stage-collapsed' : 'stage-full')
    : (running ? 'stage-pip' : 'stage-parked');

  return (
    <div className="app">
      <TopBar dotClass={dotClass} telemetry={telemetry} model={model} />
      {demoMode && (
        <div className="demo-banner" role="status">
          <span>▲ DEMO MODE — simulated alerts · no API calls · webhooks disabled</span>
          <button className="demo-exit-btn" onClick={handleExitDemo}>EXIT DEMO</button>
        </div>
      )}
      <div className="app-body">
        <NavRail screen={screen} setScreen={setScreen} />
        <main className={`main-content ${screen === 'monitor' ? 'monitor-layout' : ''}`}>
          <MonitorStage
            videoRef={videoRef} canvasRef={canvasRef}
            stageMode={stageMode} flashActive={flashActive}
            dotClass={dotClass} status={status}
            collapsed={previewCollapsed}
            onToggleCollapse={() => setPreviewCollapsed(c => !c)}
            onTap={() => setScreen('monitor')}
          />
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
              running={running}
              telemetry={telemetry}
              onToggle={handleToggle}
              hasApiKey={Boolean(apiKey)}
              demoMode={demoMode}
              onStartDemo={handleStartDemo}
              onOpenSettings={() => setScreen('settings')}
            />
          )}
          {screen === 'history' && (
            <HistoryScreen alerts={alerts} />
          )}
          {screen === 'optimize' && (
            <Suspense fallback={<div className="screen"><p className="status-msg">Loading optimizer…</p></div>}>
              <OptimizeScreen />
            </Suspense>
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

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
const EvalScreen = lazy(() => import('./screens/EvalScreen.jsx'));

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
  const [scanMode, setScanMode] = useLocalStorage('aura.scanMode', 'interval');
  const [scanEveryValue, setScanEveryValue] = useLocalStorage('aura.scanEveryValue', 5);
  const [scanEveryUnit, setScanEveryUnit] = useLocalStorage('aura.scanEveryUnit', 's');
  const [budgetPerHour, setBudgetPerHour] = useLocalStorage('aura.budgetPerHour', '0.10');
  const [networkMbPerHour, setNetworkMbPerHour] = useLocalStorage('aura.networkMbPerHour', '');
  const [rate, setRate] = useLocalStorage('aura.rate', '0.10');
  const [cameraFacing, setCameraFacing] = useLocalStorage('aura.cameraFacing', 'environment');
  const [cameraDeviceId, setCameraDeviceId] = useLocalStorage('aura.cameraDeviceId', '');
  const [videoSource, setVideoSource] = useLocalStorage('aura.videoSource', 'camera');
  const [speech, setSpeech] = useLocalStorage('aura.speech', true);
  const [haptics, setHaptics] = useLocalStorage('aura.haptics', true);
  const [webhookUrl, setWebhookUrl] = useLocalStorage('aura.webhookUrl', '');
  const [webhookMethod, setWebhookMethod] = useLocalStorage('aura.webhookMethod', 'POST');
  const [webhookHeaders, setWebhookHeaders] = useLocalStorage('aura.webhookHeaders', '');
  const [webhookAction, setWebhookAction] = useLocalStorage('aura.webhookAction', '');
  const [webhookSchema, setWebhookSchema] = useLocalStorage('aura.webhookSchema', '');

  // SCAN EVERY is entered as a number + unit (1s .. 12h+) and converted to
  // seconds for the scheduler, which only deals in seconds.
  const SCAN_EVERY_UNIT_SECONDS = { s: 1, m: 60, h: 3600 };
  const scanEvery = (parseFloat(scanEveryValue) || 0) * (SCAN_EVERY_UNIT_SECONDS[scanEveryUnit] || 1);

  // Live settings ref — updated every render so tick() sees current values without stale closures
  const settingsRef = useRef({});
  settingsRef.current = {
    baseUrl, apiKey, model, mission, action,
    threshold: 0, scanMode, scanEvery, budgetPerHour, networkMbPerHour, rate,
    cameraFacing, cameraDeviceId, videoSource,
    speech, haptics, demo: demoMode,
    webhookUrl, webhookMethod, webhookHeaders, webhookAction, webhookSchema,
  };

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const { running, status, dotClass, flashActive, telemetry, alerts, missed, progress, stats, markedIds, markExample, captureFrame, start, stop, switchCamera } = useMonitor({ settingsRef, videoRef, canvasRef });

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

  // Eval-screen frame capture — only meaningful while the video element has
  // a live frame (same readiness gate the scan loop uses).
  function handleCaptureEvalFrame() {
    const v = videoRef.current;
    return v && v.readyState >= 2 ? captureFrame() : null;
  }

  function handleFlipCamera() {
    const next = cameraFacing === 'environment' ? 'user' : 'environment';
    setCameraFacing(next);
    // An explicit device pick would override facingMode — clear it on flip.
    setCameraDeviceId('');
    // switchCamera() reads the settings ref before the re-render lands, so
    // update the ref directly too (same pattern as handleStartDemo).
    settingsRef.current.cameraFacing = next;
    settingsRef.current.cameraDeviceId = '';
    switchCamera();
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
            dotClass={dotClass} status={status} progress={progress}
            collapsed={previewCollapsed}
            onToggleCollapse={() => setPreviewCollapsed(c => !c)}
            onTap={() => setScreen('monitor')}
            videoSource={videoSource}
            running={running}
            onFlipCamera={handleFlipCamera}
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
              progress={progress}
              stats={stats}
              onToggle={handleToggle}
              hasApiKey={Boolean(apiKey)}
              demoMode={demoMode}
              onStartDemo={handleStartDemo}
              onOpenSettings={() => setScreen('settings')}
            />
          )}
          {screen === 'history' && (
            <HistoryScreen alerts={alerts} missed={missed} markedIds={markedIds} onMarkExample={markExample} />
          )}
          {screen === 'optimize' && (
            <Suspense fallback={<div className="screen"><p className="status-msg">Loading optimizer…</p></div>}>
              <OptimizeScreen />
            </Suspense>
          )}
          {screen === 'eval' && (
            <Suspense fallback={<div className="screen"><p className="status-msg">Loading evaluation…</p></div>}>
              <EvalScreen
                baseUrl={baseUrl}
                apiKey={apiKey}
                rate={rate}
                configuredModel={model}
                mission={mission}
                captureFrame={handleCaptureEvalFrame}
                monitorRunning={running}
              />
            </Suspense>
          )}
          {screen === 'settings' && (
            <SettingsScreen
              baseUrl={baseUrl} setBaseUrl={setBaseUrl}
              apiKey={apiKey} setApiKey={setApiKey}
              model={model} setModel={setModel}
              scanMode={scanMode} setScanMode={setScanMode}
              scanEveryValue={scanEveryValue} setScanEveryValue={setScanEveryValue}
              scanEveryUnit={scanEveryUnit} setScanEveryUnit={setScanEveryUnit}
              budgetPerHour={budgetPerHour} setBudgetPerHour={setBudgetPerHour}
              networkMbPerHour={networkMbPerHour} setNetworkMbPerHour={setNetworkMbPerHour}
              rate={rate} setRate={setRate}
              videoSource={videoSource} setVideoSource={setVideoSource}
              cameraFacing={cameraFacing} setCameraFacing={setCameraFacing}
              cameraDeviceId={cameraDeviceId} setCameraDeviceId={setCameraDeviceId}
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

import { useState, useRef, lazy, Suspense } from 'react';
import { useLocalStorage } from '@uidotdev/usehooks';
import { useMonitor } from './hooks/useMonitor.js';
import { resumeWindowOpen } from '../lib/keepalive.js';
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

// A RESUME MONITORING offer stays valid for this long after arming — long
// enough to cover an overnight run interrupted by a reload, short enough that
// a session armed days ago doesn't nag forever.
const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

export default function App() {
  const [screen, setScreen] = useState('monitor');
  // Session-only on purpose: a reload always exits demo mode.
  const [demoMode, setDemoMode] = useState(false);
  // Dismissing the resume banner is session-only too — it only needs to stop
  // nagging for the rest of this page load; aura.armed itself is cleared so a
  // later reload within the window doesn't bring it back.
  const [resumeDismissed, setResumeDismissed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorage('aura.previewCollapsed', false);
  // Transient provider messages (model fetch results/failures) shown in Settings.
  const [statusMsg, setStatusMsg] = useState('');

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
  const [keepScreenOn, setKeepScreenOn] = useLocalStorage('aura.keepScreenOn', true);
  // Written by handleStart/handleStop, read once at boot to offer RESUME.
  const [armed, setArmed] = useLocalStorage('aura.armed', false);
  const [armedAt, setArmedAt] = useLocalStorage('aura.armedAt', 0);

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

  const { running, status, dotClass, flashActive, telemetry, alerts, missed, progress, stats, markedIds, markExample, clearHistory, captureFrame, start, stop, switchCamera, wakeLockHeld } = useMonitor({ settingsRef, videoRef, canvasRef, demoMode, keepScreenOn });

  // Wraps the hook's start()/stop() so an ordinary ARM/DISARM also persists
  // the armed flag a reload needs to offer RESUME. Demo mode bypasses this
  // (see handleStartDemo) — it isn't meant to survive a reload anyway. Only
  // persists on an actual arm — a rejected/misconfigured start() (bad
  // provider, no mission, camera denied) must not leave a phantom RESUME
  // offer for a session that never ran.
  async function handleStart() {
    const armedOk = await start();
    if (armedOk) {
      setArmed(true);
      setArmedAt(Date.now());
    }
  }

  function handleStop() {
    setArmed(false);
    stop();
  }

  function handleToggle() {
    if (running) handleStop();
    else handleStart();
  }

  function handleResume() {
    setResumeDismissed(true);
    handleStart();
  }

  function handleDismissResume() {
    setResumeDismissed(true);
    setArmed(false);
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
    // Surfaced in the Settings PROVIDER section — a failed model fetch against
    // a local server (CORS, server down) is otherwise invisible to the user.
    console.info('[aura]', msg);
    setStatusMsg(msg);
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

  // A session armed before a reload (OS kill, redeploy, pull-to-refresh) gets
  // a one-tap RESUME offer instead of silently staying disarmed — but only
  // while the window is still open and only until the operator has answered.
  const showResumeBanner = !running && !demoMode && !resumeDismissed
    && armed && resumeWindowOpen(armedAt, Date.now(), RESUME_WINDOW_MS);

  return (
    <div className="app">
      <TopBar dotClass={dotClass} telemetry={telemetry} model={model} />
      {demoMode && (
        <div className="demo-banner" role="status">
          <span>▲ DEMO MODE — simulated alerts · no API calls · webhooks disabled</span>
          <button className="demo-exit-btn" onClick={handleExitDemo}>EXIT DEMO</button>
        </div>
      )}
      {showResumeBanner && (
        <div className="demo-banner resume-banner" role="status">
          <span>⟳ RESUME MONITORING — an armed session was interrupted by a reload</span>
          <div className="btn-row resume-banner-actions">
            <button className="demo-exit-btn" onClick={handleResume}>RESUME</button>
            <button className="demo-exit-btn" onClick={handleDismissResume}>DISMISS</button>
          </div>
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
            wakeLockHeld={wakeLockHeld}
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
              providerReady={Boolean(baseUrl && model)}
              demoMode={demoMode}
              onStartDemo={handleStartDemo}
              onOpenSettings={() => setScreen('settings')}
            />
          )}
          {screen === 'history' && (
            <HistoryScreen alerts={alerts} missed={missed} markedIds={markedIds} onMarkExample={markExample} onClearHistory={clearHistory} />
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
              keepScreenOn={keepScreenOn} setKeepScreenOn={setKeepScreenOn}
              webhookUrl={webhookUrl} setWebhookUrl={setWebhookUrl}
              webhookMethod={webhookMethod} setWebhookMethod={setWebhookMethod}
              webhookHeaders={webhookHeaders} setWebhookHeaders={setWebhookHeaders}
              webhookAction={webhookAction} setWebhookAction={setWebhookAction}
              webhookSchema={webhookSchema} setWebhookSchema={setWebhookSchema}
              statusMsg={statusMsg}
              onStatusMsg={handleStatusMsg}
            />
          )}
        </main>
      </div>
    </div>
  );
}

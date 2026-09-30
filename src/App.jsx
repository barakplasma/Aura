import { useState, useRef, lazy, Suspense } from 'react';
import { useLocalStorage } from '@uidotdev/usehooks';
import { useMonitor } from './hooks/useMonitor.js';
import { useServiceWorkerUpdate } from './hooks/useServiceWorkerUpdate.js';
import { useRecentVerdicts } from './hooks/useRecentVerdicts.js';
import { BROWSER_MODELS, DEFAULT_BROWSER_MODEL, DEFAULT_DETECTOR_MODEL } from '../lib/browser-engine.js';
import { pricingKey, resolvePricing, resolveDecisionPricing } from '../lib/pricing.js';
import { isEngineConfigured } from '../lib/providers.js';
import { DEFAULT_DECISION_MODEL, DEFAULT_RELAY_URL, getDecisionModel } from '../lib/decision-models.js';
import { resumeWindowOpen } from '../lib/keepalive.js';
import AppShell from './components/AppShell.jsx';
import Stage from './components/Stage.jsx';
import WatchScreen from './screens/WatchScreen.jsx';
import LabScreen from './screens/LabScreen.jsx';
import { Button } from './ui/button.jsx';
import { Toast } from './ui/toast.jsx';
import { prefillFromEntry } from '../lib/training-store.js';
import AlertsScreen from './screens/AlertsScreen.jsx';
import SetupScreen from './screens/SetupScreen.jsx';

// Lazy — keeps the optimizer screen (and, transitively, @ax-llm/ax) out of
// the initial bundle.
const OptimizeScreen = lazy(() => import('./screens/OptimizeScreen.jsx'));
const EvalScreen = lazy(() => import('./screens/EvalScreen.jsx'));

// A line of explanation where a screen would be (a chunk still loading, or a
// screen that doesn't apply to the current engine).
function Notice({ children }) {
  return <p className="min-h-0 flex-1 overflow-y-auto bg-bg-0 p-4 text-sm text-text-dim">{children}</p>;
}

// A RESUME MONITORING offer stays valid for this long after arming — long
// enough to cover an overnight run interrupted by a reload, short enough that
// a session armed days ago doesn't nag forever.
const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

export default function App() {
  // 'watch' | 'alerts' | 'setup' | 'lab' — docs/PRD-ux-redesign.md.
  const [screen, setScreen] = useState('watch');
  const [labTab, setLabTab] = useState('tune');
  // "Send to Lab" hands the Examples form a history entry to start from; a
  // recent-scan dot on Watch hands Alerts an entry to open.
  const [labPrefill, setLabPrefill] = useState(null);
  const [alertFocus, setAlertFocus] = useState(null);
  // Session-only on purpose: a reload always exits demo mode.
  const [demoMode, setDemoMode] = useState(false);
  // Dismissing the resume banner is session-only too — it only needs to stop
  // nagging for the rest of this page load; aura.armed itself is cleared so a
  // later reload within the window doesn't bring it back.
  const [resumeDismissed, setResumeDismissed] = useState(false);
  // Same idea for the update banner: dismissing just stops it nagging for
  // this page load. The waiting worker itself isn't going anywhere, so the
  // next reload (or the next visit) offers it again.
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorage('aura.previewCollapsed', false);

  // Settings — persisted via localStorage (JSON-serialized by @uidotdev/usehooks)
  const [baseUrl, setBaseUrl] = useLocalStorage('aura.baseUrl', 'https://api.cerebras.ai/v1');
  const [apiKey, setApiKey] = useLocalStorage('aura.apiKey', '');
  const [model, setModel] = useLocalStorage('aura.model', '');
  const [engine, setEngine] = useLocalStorage('aura.engine', 'provider');
  const [browserModel, setBrowserModel] = useLocalStorage('aura.browserModel', DEFAULT_BROWSER_MODEL);
  // Which in-browser runtime answers BROWSER-engine scans: 'auto' |
  // 'transformers' | 'chrome-ai' (resolved in lib/browser-engine.js).
  const [browserRuntime, setBrowserRuntime] = useLocalStorage('aura.browserRuntime', 'auto');
  // DECISION engine (docs/PRD-decision-engine.md). The key is the user's OWN
  // (their Replicate token, or their self-hosted server's key) and never
  // leaves this browser except to the endpoint it's for.
  const [decisionModel, setDecisionModel] = useLocalStorage('aura.decisionModel', DEFAULT_DECISION_MODEL);
  const [decisionUrl, setDecisionUrl] = useLocalStorage('aura.decisionUrl', DEFAULT_RELAY_URL);
  const [decisionKey, setDecisionKey] = useLocalStorage('aura.decisionKey', '');
  // 'provider' | 'browser' | 'template' — who words a fired alert.
  const [decisionAnnouncer, setDecisionAnnouncer] = useLocalStorage('aura.decisionAnnouncer', 'provider');
  // Re-run a failed decision on the PROVIDER engine (only when one is set up).
  const [decisionFallback, setDecisionFallback] = useLocalStorage('aura.decisionFallback', true);
  const [mission, setMission] = useLocalStorage('aura.mission', '');
  // Minimum confidence for an alert to fire. 0 = anything the model reports.
  const [threshold, setThreshold] = useLocalStorage('aura.threshold', 0);
  const [action, setAction] = useLocalStorage('aura.action', '');
  const [scanMode, setScanMode] = useLocalStorage('aura.scanMode', 'interval');
  const [scanEveryValue, setScanEveryValue] = useLocalStorage('aura.scanEveryValue', 5);
  const [scanEveryUnit, setScanEveryUnit] = useLocalStorage('aura.scanEveryUnit', 's');
  const [budgetPerHour, setBudgetPerHour] = useLocalStorage('aura.budgetPerHour', '0.10');
  const [networkMbPerHour, setNetworkMbPerHour] = useLocalStorage('aura.networkMbPerHour', '');
  const [pricingOverrides, setPricingOverrides] = useLocalStorage('aura.pricingOverrides', {});
  const [cameraFacing, setCameraFacing] = useLocalStorage('aura.cameraFacing', 'environment');
  const [cameraDeviceId, setCameraDeviceId] = useLocalStorage('aura.cameraDeviceId', '');
  const [videoSource, setVideoSource] = useLocalStorage('aura.videoSource', 'camera');
  const [captureSize, setCaptureSize] = useLocalStorage('aura.captureSize', '640x480');
  const [customCaptureWidth, setCustomCaptureWidth] = useLocalStorage('aura.customCaptureWidth', '640');
  const [customCaptureHeight, setCustomCaptureHeight] = useLocalStorage('aura.customCaptureHeight', '480');
  const [speech, setSpeech] = useLocalStorage('aura.speech', true);
  const [haptics, setHaptics] = useLocalStorage('aura.haptics', true);
  const [webhookUrl, setWebhookUrl] = useLocalStorage('aura.webhookUrl', '');
  const [webhookMethod, setWebhookMethod] = useLocalStorage('aura.webhookMethod', 'POST');
  const [webhookHeaders, setWebhookHeaders] = useLocalStorage('aura.webhookHeaders', '');
  const [webhookAction, setWebhookAction] = useLocalStorage('aura.webhookAction', '');
  const [webhookSchema, setWebhookSchema] = useLocalStorage('aura.webhookSchema', '');
  const [webhookIncludeImage, setWebhookIncludeImage] = useLocalStorage('aura.webhookIncludeImage', false);
  const [keepScreenOn, setKeepScreenOn] = useLocalStorage('aura.keepScreenOn', true);
  // Object gate (docs/PRD-object-gate.md) — a local detector decides whether
  // the vision model runs at all. Off by default: it changes when scans happen.
  const [objectGate, setObjectGate] = useLocalStorage('aura.objectGate', false);
  const [objectModel, setObjectModel] = useLocalStorage('aura.objectModel', DEFAULT_DETECTOR_MODEL);
  const [objectGateEveryS, setObjectGateEveryS] = useLocalStorage('aura.objectGateEveryS', 2);
  const [objectClasses, setObjectClasses] = useLocalStorage('aura.objectClasses', '');
  const [objectWakeOn, setObjectWakeOn] = useLocalStorage('aura.objectWakeOn', 'added,removed');
  const [objectMoveFrac, setObjectMoveFrac] = useLocalStorage('aura.objectMoveFrac', 0.15);
  const [objectSens, setObjectSens] = useLocalStorage('aura.objectSens', 'medium');
  const [heartbeatMin, setHeartbeatMin] = useLocalStorage('aura.heartbeatMin', 5);
  const [objectPromptContext, setObjectPromptContext] = useLocalStorage('aura.objectPromptContext', false);
  const [vlmIdleEvictMin, setVlmIdleEvictMin] = useLocalStorage('aura.vlmIdleEvictMin', 10);
  // Written by handleStart/handleStop, read once at boot to offer RESUME.
  const [armed, setArmed] = useLocalStorage('aura.armed', false);
  const [armedAt, setArmedAt] = useLocalStorage('aura.armedAt', 0);

  // SCAN EVERY is entered as a number + unit (1s .. 12h+) and converted to
  // seconds for the scheduler, which only deals in seconds.
  const SCAN_EVERY_UNIT_SECONDS = { s: 1, m: 60, h: 3600 };
  const scanEvery = (parseFloat(scanEveryValue) || 0) * (SCAN_EVERY_UNIT_SECONDS[scanEveryUnit] || 1);

  // "Configured" means a model is selected for BROWSER, or a base URL + model
  // for PROVIDER — never gate on the API key (see CLAUDE.md's provider format).
  const providerReady = isEngineConfigured({ engine, browserModel, baseUrl, model, decisionModel, decisionUrl });
  // The optimizer is @ax-llm/ax end to end, and ax only talks to HTTP
  // providers — it cannot drive a model running inside this page. So on the
  // BROWSER engine the screen is not just useless, it would quietly optimize
  // prompts against a provider the operator isn't using. Hide it, and don't
  // apply an artifact trained elsewhere to local scans (see useMonitor).
  // Same on DECISION: GEPA tunes chat prompts, and a classifier has none.
  const axAvailable = engine !== 'browser' && engine !== 'decision';
  // BROWSER and local engines resolve to free pricing, while remote providers
  // use the catalogued model rate or a scoped operator override.
  const pricingOverride = pricingOverrides[pricingKey(baseUrl, model)];
  const providerPricing = resolvePricing({ baseUrl, model, engine: 'provider', override: pricingOverride });
  const pricing = engine === 'decision'
    ? resolveDecisionPricing({ row: getDecisionModel(decisionModel), providerPricing })
    : resolvePricing({ baseUrl, model, engine, override: pricingOverride });

  // Live settings ref — updated every render so tick() sees current values without stale closures
  const settingsRef = useRef({});
  settingsRef.current = {
    baseUrl, apiKey, model, mission, action,
    engine, browserModel, browserRuntime,
    decisionModel, decisionUrl, decisionKey, decisionAnnouncer, decisionFallback,
    threshold, scanMode, scanEvery, budgetPerHour, networkMbPerHour, pricing,
    cameraFacing, cameraDeviceId, videoSource,
    captureSize: captureSize === 'custom' ? `${customCaptureWidth}x${customCaptureHeight}` : captureSize,
    speech, haptics, demo: demoMode,
    webhookUrl, webhookMethod, webhookHeaders, webhookAction, webhookSchema, webhookIncludeImage,
    objectGate, objectModel, objectGateEveryS, objectClasses, objectWakeOn,
    objectMoveFrac, objectSens, heartbeatMin, objectPromptContext, vlmIdleEvictMin,
  };

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const { running, verdict, dotClass, flashActive, telemetry, alerts, missed, progress, stats, markedIds, markExample, clearHistory, captureFrame, start, stop, switchCamera, wakeLockHeld } = useMonitor({ settingsRef, videoRef, canvasRef, demoMode, keepScreenOn });
  const recent = useRecentVerdicts(verdict);
  const { updateAvailable, reloadToUpdate } = useServiceWorkerUpdate();

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

  function handleDismissUpdate() {
    setUpdateDismissed(true);
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

  function handleSendToLab(entry, { isAlert }) {
    setLabPrefill(prefillFromEntry(entry, { isAlert, mission }));
    setLabTab('tune');
    setScreen('lab');
  }

  function handleOpenEntry(id) {
    setAlertFocus(id);
    setScreen('alerts');
  }

  // How the always-mounted camera stage presents itself (see Stage).
  const stageMode = screen === 'watch'
    ? (previewCollapsed ? 'collapsed' : 'full')
    : (running ? 'pip' : 'parked');

  // Which model answers, for the verdict card's engine chip.
  const modelLabel = engine === 'browser'
    ? BROWSER_MODELS[browserModel]?.label
    : engine === 'decision'
      ? getDecisionModel(decisionModel)?.label
      : model;

  const optimizeNote = (
    <Notice>
      Prompt optimization needs the PROVIDER engine. It runs GEPA against an
      OpenAI-compatible chat endpoint — neither the in-browser model nor a
      DECISION classifier is one. Switch engines in Setup to use it.
    </Notice>
  );

  // A session armed before a reload (OS kill, redeploy, pull-to-refresh) gets
  // a one-tap RESUME offer instead of silently staying disarmed — but only
  // while the window is still open and only until the operator has answered.
  const showResumeBanner = !running && !demoMode && !resumeDismissed
    && armed && resumeWindowOpen(armedAt, Date.now(), RESUME_WINDOW_MS);

  const showUpdateBanner = updateAvailable && !updateDismissed;

  // What the Setup cards read and write, in one place instead of a hundred props.
  const settingsView = {
    engine,
    browserModel,
    browserRuntime,
    decisionModel,
    decisionUrl,
    decisionKey,
    decisionAnnouncer,
    decisionFallback,
    baseUrl,
    apiKey,
    model,
    mission,
    scanMode,
    scanEveryValue,
    scanEveryUnit,
    budgetPerHour,
    networkMbPerHour,
    videoSource,
    captureSize,
    customCaptureWidth,
    customCaptureHeight,
    cameraFacing,
    cameraDeviceId,
    keepScreenOn,
    speech,
    haptics,
    webhookUrl,
    webhookMethod,
    webhookHeaders,
    webhookAction,
    webhookSchema,
    webhookIncludeImage,
    objectGate,
    objectModel,
    objectGateEveryS,
    objectClasses,
    objectWakeOn,
    objectMoveFrac,
    objectSens,
    heartbeatMin,
    objectPromptContext,
    vlmIdleEvictMin,
  };
  const settingsSetters = {
    engine: setEngine,
    browserModel: setBrowserModel,
    browserRuntime: setBrowserRuntime,
    decisionModel: setDecisionModel,
    decisionUrl: setDecisionUrl,
    decisionKey: setDecisionKey,
    decisionAnnouncer: setDecisionAnnouncer,
    decisionFallback: setDecisionFallback,
    baseUrl: setBaseUrl,
    apiKey: setApiKey,
    model: setModel,
    mission: setMission,
    scanMode: setScanMode,
    scanEveryValue: setScanEveryValue,
    scanEveryUnit: setScanEveryUnit,
    budgetPerHour: setBudgetPerHour,
    networkMbPerHour: setNetworkMbPerHour,
    videoSource: setVideoSource,
    captureSize: setCaptureSize,
    customCaptureWidth: setCustomCaptureWidth,
    customCaptureHeight: setCustomCaptureHeight,
    cameraFacing: setCameraFacing,
    cameraDeviceId: setCameraDeviceId,
    keepScreenOn: setKeepScreenOn,
    speech: setSpeech,
    haptics: setHaptics,
    webhookUrl: setWebhookUrl,
    webhookMethod: setWebhookMethod,
    webhookHeaders: setWebhookHeaders,
    webhookAction: setWebhookAction,
    webhookSchema: setWebhookSchema,
    webhookIncludeImage: setWebhookIncludeImage,
    objectGate: setObjectGate,
    objectModel: setObjectModel,
    objectGateEveryS: setObjectGateEveryS,
    objectClasses: setObjectClasses,
    objectWakeOn: setObjectWakeOn,
    objectMoveFrac: setObjectMoveFrac,
    objectSens: setObjectSens,
    heartbeatMin: setHeartbeatMin,
    objectPromptContext: setObjectPromptContext,
    vlmIdleEvictMin: setVlmIdleEvictMin,
  };

  return (
    <div className="flex h-dvh flex-col">
      <Toast open={demoMode} tone="warn" message="Demo mode — simulated alerts, no API calls." actions={[{ text: 'Exit', onClick: handleExitDemo }]} />
      <Toast open={showResumeBanner} message="Monitoring was interrupted by a reload." actions={[{ text: 'Resume', onClick: handleResume }, { text: 'Dismiss', onClick: handleDismissResume }]} />
      <Toast open={showUpdateBanner} message="A new version is ready." actions={[{ text: 'Update', onClick: reloadToUpdate }, { text: 'Later', onClick: handleDismissUpdate }]} />
      <AppShell screen={screen} onNavigate={setScreen} dotClass={dotClass}>
        <Stage
          videoRef={videoRef} canvasRef={canvasRef}
          mode={stageMode} flashActive={flashActive}
          running={running} demoMode={demoMode} videoSource={videoSource}
          wakeLockHeld={wakeLockHeld}
          onToggleCollapse={() => setPreviewCollapsed(c => !c)}
          onFlipCamera={handleFlipCamera}
          onDemo={handleStartDemo}
          onReturn={() => setScreen('watch')}
        />
        {screen === 'watch' && (
          <WatchScreen
            verdict={verdict} recent={recent} running={running} progress={progress} telemetry={telemetry}
            engine={engine} modelLabel={modelLabel} providerReady={providerReady} demoMode={demoMode}
            onToggle={handleToggle} onDemo={handleStartDemo}
            onOpenSetup={() => setScreen('setup')}
            onOpenLab={() => { setLabTab('tune'); setScreen('lab'); }}
            onOpenEntry={handleOpenEntry}
            mission={mission} setMission={setMission}
            action={action} setAction={setAction}
            speech={speech} setSpeech={setSpeech}
            haptics={haptics} setHaptics={setHaptics}
            threshold={threshold} setThreshold={setThreshold}
          />
        )}
        {screen === 'alerts' && (
          <AlertsScreen
            alerts={alerts} missed={missed} markedIds={markedIds}
            onMarkExample={markExample} onClearHistory={clearHistory}
            onSendToLab={handleSendToLab}
            focusId={alertFocus} onFocusHandled={() => setAlertFocus(null)}
          />
        )}
        {screen === 'lab' && (
          <LabScreen tab={labTab} setTab={setLabTab}>
            {labTab === 'tune' && (
              axAvailable ? (
                <Suspense fallback={<Notice>Loading optimizer…</Notice>}>
                  <OptimizeScreen prefill={labPrefill} onPrefillUsed={() => setLabPrefill(null)} mission={mission} />
                </Suspense>
              ) : optimizeNote
            )}
            {labTab === 'eval' && (
              <Suspense fallback={<Notice>Loading evaluation…</Notice>}>
                <EvalScreen
                  baseUrl={baseUrl}
                  apiKey={apiKey}
                  pricingOverrides={pricingOverrides}
                  configuredModel={model}
                  mission={mission}
                  decision={{ decisionModel, decisionUrl, decisionKey }}
                  captureFrame={handleCaptureEvalFrame}
                  monitorRunning={running}
                />
              </Suspense>
            )}
          </LabScreen>
        )}
        {screen === 'setup' && (
          <SetupScreen
            s={settingsView} set={settingsSetters}
            captureFrame={handleCaptureEvalFrame}
            onOpenLab={() => setScreen('lab')}
            // On DECISION the token rates shown are the provider's (it
            // announces and falls back); the decision rate rides along.
            pricing={engine === 'decision' ? { ...providerPricing, perSecond: pricing.perSecond } : pricing}
            pricingOverride={pricingOverride}
            onSetPricingOverride={(override) => setPricingOverrides((current) => ({ ...current, [pricingKey(baseUrl, model)]: override }))}
            onResetPricingOverride={() => setPricingOverrides((current) => {
              const next = { ...current };
              delete next[pricingKey(baseUrl, model)];
              return next;
            })}
          />
        )}
      </AppShell>
    </div>
  );
}

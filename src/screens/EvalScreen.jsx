import { useState, useEffect, useCallback } from 'react';
import { useLocalStorage } from '@uidotdev/usehooks';
import { fetchModels, scanClient, isLocalBaseUrl } from '../../lib/aura.js';
import {
  expandMatrix, runEvalMatrix, summarizeResults,
  BROWSER_MODEL_PREFIX, CHROME_AI_MODEL_ID, DECISION_MODEL_PREFIX,
} from '../../lib/eval.js';
import { pricingKey, resolvePricing, resolveDecisionPricing } from '../../lib/pricing.js';
import { scanDecision, missionToQuestion } from '../../lib/decision.js';
import { DECISION_MODELS, getDecisionModel, isDecisionConfigured } from '../../lib/decision-models.js';
import { createEvalStore, makeId } from '../../lib/eval-store.js';
import { scanBrowser, probeChromeAI, DEFAULT_BROWSER_MODEL, BROWSER_MODELS } from '../../lib/browser-engine.js';
import { reportUnexpectedError } from '../../lib/handled-errors.js';
import ProgressBar from '../components/ProgressBar.jsx';
import { reportHandledError } from '../monitoring.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Field } from '../ui/field.jsx';
import { Select } from '../ui/input.jsx';
import { Status } from '../ui/status.jsx';
import ModelPicker from '../lab/ModelPicker.jsx';
import PromptVariants from '../lab/PromptVariants.jsx';
import ResultsTable from '../lab/ResultsTable.jsx';
import SampleImages from '../lab/SampleImages.jsx';

const store = createEvalStore();

// In-browser rows are only offered when WebGPU is present — the eval screen's
// own way of measuring "is the on-device model good enough for my mission"
// without ever running it on a phone with no GPU. (The model-id prefixes live
// in lib/eval.js.)
const hasWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);

// Routes a cell's scan to the BROWSER engine (either runtime), a DECISION
// model, or the configured provider, depending on which kind of model id it
// carries — everything else about the call (mission, image, threshold,
// signal) is the same either way.
async function scanForEval(params, decision) {
  if (params.model.startsWith(DECISION_MODEL_PREFIX)) {
    return scanDecision({
      modelId: params.model.slice(DECISION_MODEL_PREFIX.length),
      url: decision.decisionUrl,
      account: decision.decisionAccount,
      apiKey: decision.decisionKey || undefined,
      question: missionToQuestion({ mission: params.mission }),
      image: params.image,
      threshold: 0,
      requestTimeout: params.requestTimeout,
      signal: params.signal,
    });
  }
  if (params.model.startsWith(BROWSER_MODEL_PREFIX)) {
    return scanBrowser({
      ...params,
      // Pinned: a `browser:<key>` row must run ITS model through
      // Transformers.js. Left to auto-resolve, a Chrome-AI-capable browser
      // would run every row on Gemini Nano and corrupt the whole matrix.
      runtime: 'transformers',
      model: params.model.slice(BROWSER_MODEL_PREFIX.length),
    });
  }
  if (params.model === CHROME_AI_MODEL_ID) {
    return scanBrowser({ ...params, model: DEFAULT_BROWSER_MODEL, runtime: 'chrome-ai' });
  }
  return scanClient(params);
}

// Sample images are normalized to the same frame the live monitor sends.
const FRAME_W = 640;
const FRAME_H = 480;

// Module-scope active run — survives screen unmount (the chunk stays loaded),
// so tabbing away mid-run doesn't kill or orphan the evaluation. Only the
// CANCEL button aborts; unmount just detaches the listener.
let activeRun = null; // { controller, total, done, run, listeners: Set }

function notifyActiveRun() {
  if (!activeRun) return;
  for (const listener of [...activeRun.listeners]) listener();
}

// Letterbox an uploaded file onto a 640×480 black canvas (aspect-fit, same
// treatment as screen-share frames in useMonitor) and encode as JPEG.
async function fileToFrameDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext('2d');
    const scale = Math.min(FRAME_W / bitmap.width, FRAME_H / bitmap.height);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    ctx.drawImage(bitmap, (FRAME_W - dw) / 2, (FRAME_H - dh) / 2, dw, dh);
    return canvas.toDataURL('image/jpeg', 0.5);
  } finally {
    bitmap.close?.();
  }
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function EvalScreen({
  baseUrl, apiKey, pricingOverrides, configuredModel, mission, captureFrame, monitorRunning, decision = {},
}) {
  const [images, setImages] = useState([]);
  const [variants, setVariants] = useLocalStorage('aura.eval.variants', []);
  const [selectedModels, setSelectedModels] = useLocalStorage('aura.eval.models', []);
  const [modelList, setModelList] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [statusMsg, setStatusMsg] = useState('');
  const [runView, setRunView] = useState(null);   // displayed run record
  const [progress, setProgress] = useState(null); // { done, total } while running

  // In-browser model rows offered in the matrix. Transformers.js rows need
  // WebGPU; the Chrome built-in AI row appears only when the feature probe
  // says this browser can actually take image input through it.
  const [chromeAICapable, setChromeAICapable] = useState(false);
  useEffect(() => {
    let live = true;
    probeChromeAI().then((probe) => {
      if (live) setChromeAICapable(probe.imageCapable && probe.availability === 'available');
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const browserEvalModelIds = [
    // Rows with a knownIssue (measured "does not finish") would just burn an eval slot
    // on a run that never completes.
    ...(hasWebGpu
      ? Object.keys(BROWSER_MODELS)
          .filter((k) => !BROWSER_MODELS[k].knownIssue)
          .map((k) => `${BROWSER_MODEL_PREFIX}${k}`)
      : []),
    ...(chromeAICapable ? [CHROME_AI_MODEL_ID] : []),
    // Decision rows that share the configured one's endpoint — so the same
    // relay/server URL and the same key are valid for each of them.
    ...(isDecisionConfigured(decision)
      ? Object.keys(DECISION_MODELS)
          .filter((k) => DECISION_MODELS[k].upstream === getDecisionModel(decision.decisionModel).upstream)
          .map((k) => `${DECISION_MODEL_PREFIX}${k}`)
      : []),
  ];

  // Pull the current state of the module-level run (or the persisted last
  // run) into React state. Registered as the active run's listener.
  const syncFromActive = useCallback(() => {
    if (activeRun) {
      setRunView({ ...activeRun.run, results: [...activeRun.run.results] });
      setProgress({ done: activeRun.done, total: activeRun.total });
    } else {
      setProgress(null);
      store.getLastRun().then((r) => { if (r) setRunView(r); });
    }
  }, []);

  useEffect(() => {
    store.listImages().then(setImages);
    syncFromActive();
    activeRun?.listeners.add(syncFromActive);
    return () => activeRun?.listeners.delete(syncFromActive);
  }, [syncFromActive]);

  // ----- Sample images -----

  async function handleFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    const added = [];
    for (const file of files) {
      try {
        const dataUrl = await fileToFrameDataUrl(file);
        added.push(await store.addImage({ dataUrl, source: 'upload' }));
      } catch (err) {
        setStatusMsg(`Could not read ${file.name}: ${err.message}`);
      }
    }
    if (added.length) setImages((imgs) => [...imgs, ...added]);
  }

  async function handleCapture() {
    const dataUrl = captureFrame?.();
    if (!dataUrl) {
      setStatusMsg('Start monitoring first — the camera stage must be live to capture a frame.');
      return;
    }
    const record = await store.addImage({ dataUrl, source: 'camera' });
    setImages((imgs) => [...imgs, record]);
  }

  // Cycle the optional label: unlabeled → should trigger → should stay clear.
  async function handleCycleExpected(img) {
    const next = img.expected === null ? true : img.expected === true ? false : null;
    const updated = await store.setImageExpected(img.id, next);
    if (updated) setImages((imgs) => imgs.map((i) => (i.id === img.id ? updated : i)));
  }

  async function handleRemoveImage(id) {
    await store.removeImage(id);
    setImages((imgs) => imgs.filter((i) => i.id !== id));
  }

  // ----- Prompt variants -----

  function handleAddVariant() {
    setVariants([
      ...variants,
      {
        id: makeId('pv'),
        name: `Variant ${variants.length + 1}`,
        // First variant starts from the live mission so the baseline is
        // always in the comparison.
        mission: variants.length === 0 ? (mission || '') : '',
        instruction: '',
      },
    ]);
  }

  function handleVariantChange(id, field, value) {
    setVariants(variants.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  }

  function handleRemoveVariant(id) {
    setVariants(variants.filter((v) => v.id !== id));
  }

  // ----- Models -----

  async function handleFetchModels() {
    if (!baseUrl) {
      setStatusMsg('Configure the provider Base URL in Settings first.');
      return;
    }
    setFetchingModels(true);
    try {
      const list = await fetchModels(baseUrl, apiKey);
      setModelList(list);
      setStatusMsg(`Found ${list.length} models.`);
    } catch (err) {
      setStatusMsg(`Fetch failed: ${err.message}. You can add a model name manually.`);
    } finally {
      setFetchingModels(false);
    }
  }

  function toggleModel(m) {
    setSelectedModels(
      selectedModels.includes(m)
        ? selectedModels.filter((x) => x !== m)
        : [...selectedModels, m],
    );
  }

  // The list shows fetched models plus anything already selected
  // (manual entries, or models the provider no longer lists) plus the
  // BROWSER engine's own model(s), when WebGPU is available.
  const visibleModels = [
    ...new Set([
      ...modelList,
      ...selectedModels,
      // The model the monitor runs on is always on offer, whatever else is listed.
      ...(configuredModel ? [configuredModel] : []),
      ...browserEvalModelIds,
    ]),
  ];

  // ----- Run -----

  const usableVariants = variants.filter((v) => (v.mission || '').trim());
  const totalCalls = images.length * selectedModels.length * usableVariants.length;
  const running = Boolean(activeRun);
  // A run made up entirely of in-browser or decision models needs no provider.
  const isLocalModelId = (m) =>
    m.startsWith(BROWSER_MODEL_PREFIX) || m === CHROME_AI_MODEL_ID || m.startsWith(DECISION_MODEL_PREFIX);
  const needsProvider = selectedModels.some((m) => !isLocalModelId(m));
  const blockers = [];
  // No API key blocker — a local provider needs none.
  if (needsProvider && !baseUrl) blockers.push('provider Base URL (Settings)');
  if (!images.length) blockers.push('sample images');
  if (!usableVariants.length) blockers.push('a prompt variant with a mission');
  if (!selectedModels.length) blockers.push('a model');

  async function handleRun() {
    if (running || blockers.length) return;
    const imagesById = Object.fromEntries(images.map((i) => [i.id, i]));
    const variantsById = Object.fromEntries(usableVariants.map((v) => [v.id, v]));
    const cells = expandMatrix({
      imageIds: images.map((i) => i.id),
      models: selectedModels,
      variants: usableVariants,
    });
    const controller = new AbortController();
    const run = {
      at: Date.now(),
      baseUrl,
      models: [...selectedModels],
      // Snapshots — immune to later edits of variants and labels.
      variants: usableVariants.map((v) => ({ ...v })),
      imageIds: images.map((i) => i.id),
      expectedByImage: Object.fromEntries(images.map((i) => [i.id, i.expected])),
      results: [],
      durationMs: 0,
      cancelled: false,
    };
    activeRun = { controller, total: cells.length, done: 0, run, listeners: new Set([syncFromActive]) };
    setStatusMsg('');
    notifyActiveRun();

    const started = performance.now();
    const results = await runEvalMatrix({
      baseUrl,
      apiKey,
      cells,
      imagesById,
      variantsById,
      concurrency,
      requestTimeout: 60,
      signal: controller.signal,
      scanFn: (params) => scanForEval(params, { ...decision, mission }),
      onResult: (result, done) => {
        if (result.status === 'error') {
          reportUnexpectedError(new Error(result.error), reportHandledError, {
            area: 'prompt-evaluation',
            model: result.model,
            inference: result.model.startsWith(BROWSER_MODEL_PREFIX)
              ? 'in-browser'
              : result.model.startsWith(DECISION_MODEL_PREFIX) ? 'decision-endpoint'
              : isLocalBaseUrl(baseUrl) ? 'local-provider' : 'cloud-provider',
          });
        }
        if (!activeRun) return;
        activeRun.run.results.push(result);
        activeRun.done = done;
        notifyActiveRun();
      },
    });
    run.results = results;
    run.durationMs = Math.round(performance.now() - started);
    run.cancelled = controller.signal.aborted;
    try {
      await store.saveLastRun(run);
    } catch (err) {
      console.warn('[aura] failed to persist eval run', err);
    }
    const listeners = activeRun?.listeners || new Set();
    activeRun = null;
    for (const listener of [...listeners]) listener();
  }

  function handleCancel() {
    activeRun?.controller.abort();
  }

  function handleExport() {
    if (runView) downloadJson(runView, `aura-eval-${runView.at || Date.now()}.json`);
  }

  // ----- Results table data -----

  const summary = runView
    ? summarizeResults(runView.results, runView.expectedByImage, (evalModel) => (
        evalModel.startsWith(DECISION_MODEL_PREFIX)
          ? resolveDecisionPricing({ row: getDecisionModel(evalModel.slice(DECISION_MODEL_PREFIX.length)) })
          : resolvePricing({
              baseUrl,
              model: evalModel,
              override: pricingOverrides?.[pricingKey(baseUrl, evalModel)],
            })
      ))
    : null;
  const imageById = Object.fromEntries(images.map((i) => [i.id, i]));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg-0 p-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h1 className="px-1 text-3xl font-semibold">Evaluate</h1>

        <SampleImages
          images={images}
          monitorRunning={monitorRunning}
          onFiles={handleFiles}
          onCapture={handleCapture}
          onCycleExpected={handleCycleExpected}
          onRemove={handleRemoveImage}
        />
        <PromptVariants
          variants={variants}
          usableCount={usableVariants.length}
          onAdd={handleAddVariant}
          onChange={handleVariantChange}
          onRemove={handleRemoveVariant}
        />
        <ModelPicker
          models={visibleModels}
          selected={selectedModels}
          onToggle={toggleModel}
          onAddManual={(m) => { if (!selectedModels.includes(m)) setSelectedModels([...selectedModels, m]); }}
          onFetch={handleFetchModels}
          fetching={fetchingModels}
        />

        <Card className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Run</h2>
          <p className="text-sm text-text-dim">
            {images.length} images × {usableVariants.length} prompts × {selectedModels.length} models = {totalCalls} detection calls
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Concurrency" htmlFor="eval-concurrency">
              <Select id="eval-concurrency" className="w-24" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
            {!running && <Button id="eval-run-btn" disabled={blockers.length > 0} onClick={handleRun}>Run eval</Button>}
            {running && <Button variant="outline" onClick={handleCancel}>Cancel</Button>}
          </div>
          {blockers.length > 0 && !running && <Status>Missing: {blockers.join(', ')}.</Status>}
          {running && progress && (
            <ProgressBar
              phase="processing"
              pct={progress.total ? (progress.done / progress.total) * 100 : null}
              label={`Scanning ${progress.done}/${progress.total}`}
            />
          )}
        </Card>

        {runView && <ResultsTable run={runView} summary={summary} imageById={imageById} onExport={handleExport} />}

        <Status id="eval-status" tone="warn" className="px-1">{statusMsg}</Status>
      </div>
    </div>
  );
}

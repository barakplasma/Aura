import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocalStorage } from '@uidotdev/usehooks';
import { fetchModels } from '../../lib/aura.js';
import { expandMatrix, comboKey, runEvalMatrix, summarizeResults } from '../../lib/eval.js';
import { createEvalStore, makeId } from '../../lib/eval-store.js';
import ProgressBar from '../components/ProgressBar.jsx';

const store = createEvalStore();

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
  baseUrl, apiKey, rate, configuredModel, mission, captureFrame, monitorRunning,
}) {
  const [images, setImages] = useState([]);
  const [variants, setVariants] = useLocalStorage('aura.eval.variants', []);
  const [selectedModels, setSelectedModels] = useLocalStorage('aura.eval.models', []);
  const [modelList, setModelList] = useState([]);
  const [manualModel, setManualModel] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [statusMsg, setStatusMsg] = useState('');
  const [runView, setRunView] = useState(null);   // displayed run record
  const [progress, setProgress] = useState(null); // { done, total } while running
  const fileInputRef = useRef(null);

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
    if (!baseUrl || !apiKey) {
      setStatusMsg('Configure the provider Base URL and API key in Settings first.');
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

  function handleAddManualModel() {
    const m = manualModel.trim();
    if (!m) return;
    if (!selectedModels.includes(m)) setSelectedModels([...selectedModels, m]);
    setManualModel('');
  }

  // The checkbox list shows fetched models plus anything already selected
  // (manual entries, or models the provider no longer lists).
  const visibleModels = [...new Set([...modelList, ...selectedModels])];
  if (visibleModels.length === 0 && configuredModel) visibleModels.push(configuredModel);

  // ----- Run -----

  const usableVariants = variants.filter((v) => (v.mission || '').trim());
  const totalCalls = images.length * selectedModels.length * usableVariants.length;
  const running = Boolean(activeRun);
  const blockers = [];
  if (!apiKey) blockers.push('API key (Settings)');
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
      onResult: (result, done) => {
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

  const runCombos = runView
    ? runView.models.flatMap((m) => runView.variants.map((v) => ({ model: m, variant: v, key: comboKey(m, v.id) })))
    : [];
  const cellByKey = new Map();
  if (runView) {
    for (const r of runView.results) {
      cellByKey.set(`${r.imageId}|${comboKey(r.model, r.variantId)}`, r);
    }
  }
  const summary = runView
    ? summarizeResults(runView.results, runView.expectedByImage, rate)
    : null;
  const imageById = Object.fromEntries(images.map((i) => [i.id, i]));

  // One footer row per metric — the combo lookup is shared so the three
  // aggregate rows don't repeat it.
  function renderAggRow(label, renderAgg) {
    return (
      <tr className="eval-agg-row">
        <td className="eval-row-head">{label}</td>
        {runCombos.map((c) => {
          const agg = summary.combos.find((x) => x.model === c.model && x.variantId === c.variant.id);
          return <td key={c.key} className="eval-cell">{renderAgg(agg)}</td>;
        })}
      </tr>
    );
  }

  function expectedBadge(expected) {
    if (expected === true) return <span className="eval-expected trig">EXPECT TRIG</span>;
    if (expected === false) return <span className="eval-expected clear">EXPECT CLEAR</span>;
    return <span className="eval-expected none">UNLABELED</span>;
  }

  function renderCell(imageId, combo) {
    const r = cellByKey.get(`${imageId}|${combo.key}`);
    if (!r) return <td key={combo.key} className="eval-cell">—</td>;
    if (r.status === 'error') {
      return <td key={combo.key} className="eval-cell eval-cell-error" title={r.error}>ERR</td>;
    }
    if (r.status === 'cancelled') {
      return <td key={combo.key} className="eval-cell">—</td>;
    }
    const expected = runView.expectedByImage?.[imageId];
    const labeled = expected === true || expected === false;
    const match = labeled ? Boolean(r.triggered) === expected : null;
    const cls = match === null ? '' : match ? ' eval-cell-match' : ' eval-cell-mismatch';
    return (
      <td key={combo.key} className={`eval-cell${cls}`} title={r.reason || ''}>
        <span className={r.triggered ? 'eval-trig' : 'eval-clear'}>
          {r.triggered ? 'TRIG' : 'clear'} {Math.round(r.confidence)}
        </span>
        <span className="eval-latency">{(r.latencyMs / 1000).toFixed(1)}s</span>
      </td>
    );
  }

  return (
    <div className="screen screen-eval">
      <div className="screen-header">
        <span className="screen-title">PROMPT EVALUATION</span>
      </div>

      <div className="settings-section">
        <div className="section-label">SAMPLE IMAGES ({images.length})</div>
        <div className="btn-row">
          <button className="dc-btn" onClick={() => fileInputRef.current?.click()}>+ UPLOAD</button>
          <button className="dc-btn outline" onClick={handleCapture} title={monitorRunning ? '' : 'Start monitoring to capture from the camera'}>
            ⦿ CAPTURE FRAME
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={handleFiles} />
        </div>
        <div className="eval-thumb-grid">
          {images.map((img) => (
            <div key={img.id} className="eval-thumb">
              <img src={img.dataUrl} alt={`sample ${img.source}`} />
              <button className="eval-thumb-label" onClick={() => handleCycleExpected(img)} title="Cycle expected outcome: unlabeled → trigger → clear">
                {expectedBadge(img.expected)}
              </button>
              <button className="eval-thumb-del" onClick={() => handleRemoveImage(img.id)} title="Remove image">×</button>
            </div>
          ))}
          {images.length === 0 && <p className="status-msg">No sample images yet. Upload photos or capture frames of the scenes you want to test.</p>}
        </div>
      </div>

      <div className="settings-section">
        <div className="section-label">PROMPT VARIANTS ({usableVariants.length})</div>
        {variants.map((v, idx) => (
          <div key={v.id} className="eval-variant">
            <div className="inline-row">
              <input
                className="dc-input eval-variant-name"
                value={v.name}
                onChange={(e) => handleVariantChange(v.id, 'name', e.target.value)}
                placeholder={`Variant ${idx + 1}`}
              />
              <button className="train-del-btn" onClick={() => handleRemoveVariant(v.id)} title="Remove variant">×</button>
            </div>
            <textarea
              className="dc-textarea"
              rows={2}
              value={v.mission}
              onChange={(e) => handleVariantChange(v.id, 'mission', e.target.value)}
              placeholder="Mission — what to watch for"
            />
            <textarea
              className="dc-textarea"
              rows={1}
              value={v.instruction}
              onChange={(e) => handleVariantChange(v.id, 'instruction', e.target.value)}
              placeholder="Optional extra instruction (advanced)"
            />
          </div>
        ))}
        <div className="btn-row">
          <button className="dc-btn" onClick={handleAddVariant}>+ ADD VARIANT</button>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-label">MODELS ({selectedModels.length} SELECTED)</div>
        <div className="btn-row">
          <button className="dc-btn" disabled={fetchingModels} onClick={handleFetchModels}>
            {fetchingModels ? 'FETCHING…' : 'FETCH MODELS'}
          </button>
        </div>
        <div className="eval-model-list">
          {visibleModels.map((m) => (
            <label key={m} className="toggle-label eval-model-item">
              <input
                type="checkbox"
                className="dc-checkbox"
                checked={selectedModels.includes(m)}
                onChange={() => toggleModel(m)}
              />
              <span>{m}</span>
            </label>
          ))}
        </div>
        <div className="inline-row">
          <input
            className="dc-input"
            value={manualModel}
            onChange={(e) => setManualModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddManualModel(); }}
            placeholder="Add model name manually"
          />
          <button className="dc-btn outline" onClick={handleAddManualModel}>ADD</button>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-label">RUN</div>
        <p className="status-msg">
          {images.length} images × {usableVariants.length} prompts × {selectedModels.length} models = {totalCalls} detection calls
        </p>
        <div className="inline-row">
          <div className="form-group">
            <label className="field-label">CONCURRENCY</label>
            <select className="dc-select" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="btn-row">
            {!running && (
              <button className="dc-btn" disabled={blockers.length > 0} onClick={handleRun}>RUN EVAL</button>
            )}
            {running && (
              <button className="dc-btn outline" onClick={handleCancel}>CANCEL</button>
            )}
          </div>
        </div>
        {blockers.length > 0 && !running && (
          <p className="status-msg">Missing: {blockers.join(', ')}.</p>
        )}
        {running && progress && (
          <ProgressBar
            phase="processing"
            pct={progress.total ? (progress.done / progress.total) * 100 : null}
            label={`SCANNING ${progress.done}/${progress.total}`}
          />
        )}
      </div>

      {runView && (
        <div className="settings-section">
          <div className="section-label">
            RESULTS — {new Date(runView.at).toLocaleString()}{runView.cancelled ? ' (CANCELLED)' : ''}
          </div>
          <div className="eval-table-wrap">
            <table className="eval-table">
              <thead>
                <tr>
                  <th rowSpan={2}>IMAGE</th>
                  {runView.models.map((m) => (
                    <th key={m} colSpan={runView.variants.length} className="eval-model-head">{m}</th>
                  ))}
                </tr>
                <tr>
                  {runCombos.map((c) => (
                    <th key={c.key} className="eval-variant-head" title={c.variant.mission}>{c.variant.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runView.imageIds.map((imageId) => (
                  <tr key={imageId}>
                    <td className="eval-row-head">
                      {imageById[imageId]
                        ? <img src={imageById[imageId].dataUrl} alt="sample" className="eval-row-thumb" />
                        : <span className="eval-row-missing">removed</span>}
                      {expectedBadge(runView.expectedByImage?.[imageId] ?? null)}
                    </td>
                    {runCombos.map((c) => renderCell(imageId, c))}
                  </tr>
                ))}
                {summary && (
                  <>
                    {renderAggRow('ACCURACY', (agg) =>
                      agg?.labeled ? `${agg.labeled.correct}/${agg.labeled.n} (${Math.round(agg.labeled.accuracy * 100)}%)` : '—')}
                    {renderAggRow('AVG LATENCY', (agg) =>
                      agg?.meanLatencyMs != null ? `${(agg.meanLatencyMs / 1000).toFixed(1)}s` : '—')}
                    {renderAggRow('TOKENS / COST', (agg) =>
                      agg ? `${agg.totalTokens} · $${agg.estCost.toFixed(4)}${agg.errorCount ? ` · ${agg.errorCount} err` : ''}` : '—')}
                  </>
                )}
              </tbody>
            </table>
          </div>
          {summary && (
            <p className="status-msg">
              Total: {summary.totals.totalTokens} tokens · ~${summary.totals.estCost.toFixed(4)}
              {summary.totals.errorCount ? ` · ${summary.totals.errorCount} errors` : ''}
            </p>
          )}
          <div className="btn-row">
            <button className="dc-btn outline" onClick={handleExport}>EXPORT JSON</button>
          </div>
        </div>
      )}

      {statusMsg && (
        <p className="status-msg" role="status" aria-live="polite">{statusMsg}</p>
      )}
    </div>
  );
}

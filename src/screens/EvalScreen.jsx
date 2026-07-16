import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalStorage } from "@uidotdev/usehooks";
import { fetchModels } from "../../lib/aura.js";
import { createEvalStore } from "../../lib/eval-store.js";
import {
  comboKey,
  expandMatrix,
  runEvalMatrix,
  summarizeResults,
} from "../../lib/eval.js";
import ProgressBar from "../components/ProgressBar.jsx";

const CAPTURE_W = 640;
const CAPTURE_H = 480;
const JPEG_QUALITY = 0.5;
const store = createEvalStore();

let activeRun = null;

export default function EvalScreen({
  baseUrl,
  apiKey,
  rate,
  configuredModel,
  mission,
  captureFrame,
  monitorRunning,
}) {
  const [images, setImages] = useState([]);
  const [variants, setVariants] = useLocalStorage("aura.eval.variants", []);
  const [selectedModels, setSelectedModels] = useLocalStorage(
    "aura.eval.models",
    configuredModel ? [configuredModel] : [],
  );
  const [providerModels, setProviderModels] = useState([]);
  const [manualModel, setManualModel] = useState("");
  const [status, setStatus] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [lastRun, setLastRun] = useState(null);
  const [activeSnapshot, setActiveSnapshot] = useState(() =>
    snapshotActiveRun(),
  );
  const fileRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    let alive = true;
    mountedRef.current = true;
    store
      .listImages()
      .then((list) => {
        if (alive) setImages(sortImages(list));
      })
      .catch((err) => {
        if (alive) setStatus(`Image store failed: ${err.message}`);
      });
    if (!activeRun) {
      store
        .getLastRun()
        .then((run) => {
          if (alive && run) setLastRun(run);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (selectedModels.length === 0 && configuredModel) {
      setSelectedModels([configuredModel]);
    }
  }, [configuredModel, selectedModels.length, setSelectedModels]);

  useEffect(() => {
    if (!activeRun) return undefined;
    const listener = (next) => setActiveSnapshot(next);
    activeRun.listeners.add(listener);
    setActiveSnapshot(snapshotActiveRun());
    return () => {
      if (activeRun) activeRun.listeners.delete(listener);
    };
  }, []);

  const imagesById = useMemo(
    () => Object.fromEntries(images.map((image) => [image.id, image])),
    [images],
  );
  const runRecord = activeSnapshot ? activeSnapshot.run : lastRun;
  const runResults = runRecord?.results || [];
  const combos = useMemo(() => {
    const models = runRecord?.models || [];
    const runVariants = runRecord?.variants || [];
    return models.flatMap((model) =>
      runVariants.map((variant) => ({
        model,
        variant,
        key: comboKey(model, variant.id),
      })),
    );
  }, [runRecord]);
  const resultByCell = useMemo(
    () =>
      new Map(
        runResults.map((result) => [
          `${result.imageId}|${comboKey(result.model, result.variantId)}`,
          result,
        ]),
      ),
    [runResults],
  );
  const expectedByImage = useMemo(
    () => Object.fromEntries(images.map((image) => [image.id, image.expected])),
    [images],
  );
  const summary = useMemo(
    () =>
      summarizeResults(
        runResults,
        runRecord?.expectedByImage || expectedByImage,
        rate,
      ),
    [expectedByImage, rate, runRecord?.expectedByImage, runResults],
  );
  const summaryByCombo = useMemo(
    () =>
      new Map(
        summary.combos.map((combo) => [
          comboKey(combo.model, combo.variantId),
          combo,
        ]),
      ),
    [summary],
  );
  const usableVariantCount = variants.filter((variant) =>
    (variant.mission || "").trim(),
  ).length;
  const callCount = images.length * usableVariantCount * selectedModels.length;
  const disabledReason = getDisabledReason({
    apiKey,
    images,
    variants,
    selectedModels,
  });
  const running = Boolean(activeSnapshot && !activeSnapshot.finished);
  const progressPct = activeSnapshot?.total
    ? Math.round((activeSnapshot.done / activeSnapshot.total) * 100)
    : 0;

  async function refreshImages() {
    const list = await store.listImages();
    setImages(sortImages(list));
  }

  async function handleFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;
    setStatus(
      `Importing ${files.length} image${files.length === 1 ? "" : "s"}...`,
    );
    try {
      for (const file of files) {
        const dataUrl = await fileToJpegDataUrl(file);
        await store.putImage(newImage(dataUrl, "upload"));
      }
      setStatus(
        `Imported ${files.length} image${files.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      await refreshImages();
    }
  }

  async function handleCapture() {
    if (!monitorRunning) {
      setStatus("Start monitoring first, then capture a frame.");
      return;
    }
    const dataUrl = captureFrame();
    if (!dataUrl) {
      setStatus("Camera frame is not ready yet.");
      return;
    }
    await store.putImage(newImage(dataUrl, "camera"));
    await refreshImages();
    setStatus("Captured frame.");
  }

  async function updateImageExpected(image, expected) {
    await store.putImage({ ...image, expected });
    await refreshImages();
  }

  async function deleteImage(id) {
    await store.deleteImage(id);
    await refreshImages();
  }

  function addVariant() {
    setVariants([
      ...variants,
      {
        id: `var_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: `Variant ${variants.length + 1}`,
        mission: variants.length === 0 ? mission || "" : "",
        instruction: "",
      },
    ]);
  }

  function updateVariant(id, patch) {
    setVariants(
      variants.map((variant) =>
        variant.id === id ? { ...variant, ...patch } : variant,
      ),
    );
  }

  function deleteVariant(id) {
    setVariants(variants.filter((variant) => variant.id !== id));
  }

  async function handleFetchModels() {
    if (!baseUrl || !apiKey) {
      setStatus("Enter a provider Base URL and API key in Settings first.");
      return;
    }
    setFetchingModels(true);
    try {
      const list = await fetchModels(baseUrl, apiKey);
      setProviderModels(list);
      setStatus(`Found ${list.length} models.`);
    } catch (err) {
      setStatus(`Fetch failed: ${err.message}. Type a model name manually.`);
    } finally {
      setFetchingModels(false);
    }
  }

  function toggleModel(model) {
    if (selectedModels.includes(model)) {
      setSelectedModels(selectedModels.filter((m) => m !== model));
    } else {
      setSelectedModels([...selectedModels, model]);
    }
  }

  function addManualModel() {
    const model = manualModel.trim();
    if (!model) return;
    setSelectedModels(
      selectedModels.includes(model)
        ? selectedModels
        : [...selectedModels, model],
    );
    setManualModel("");
  }

  async function handleRun() {
    if (disabledReason) {
      setStatus(disabledReason);
      return;
    }
    const usableVariants = variants
      .filter((variant) => (variant.mission || "").trim())
      .map((variant) => ({ ...variant }));
    const runModels = [...selectedModels];
    const cells = expandMatrix({
      imageIds: images.map((image) => image.id),
      models: runModels,
      variants: usableVariants,
    });
    const controller = new AbortController();
    const run = {
      id: "last",
      at: new Date().toISOString(),
      baseUrl,
      models: runModels,
      variants: usableVariants,
      imageIds: images.map((image) => image.id),
      expectedByImage,
      results: [],
      durationMs: 0,
      cancelled: false,
    };
    activeRun = {
      controller,
      total: cells.length,
      done: 0,
      run,
      startedAt: performance.now(),
      listeners: new Set(),
    };
    setLastRun(run);
    setActiveSnapshot(snapshotActiveRun());
    setStatus("Eval running...");

    try {
      const results = await runEvalMatrix({
        baseUrl,
        apiKey,
        cells,
        imagesById,
        variantsById: Object.fromEntries(
          usableVariants.map((variant) => [variant.id, variant]),
        ),
        concurrency,
        requestTimeout: 60,
        signal: controller.signal,
        onResult: (result, done) => {
          activeRun.run.results = [...activeRun.run.results, result];
          activeRun.done = done;
          if (mountedRef.current) setActiveSnapshot(snapshotActiveRun());
          notifyActiveRun();
        },
      });
      run.results = results;
      run.durationMs = Math.round(performance.now() - activeRun.startedAt);
      run.cancelled = controller.signal.aborted;
      await store.saveLastRun(run);
      if (mountedRef.current) {
        setLastRun(run);
        setStatus(
          run.cancelled
            ? "Eval cancelled. Partial results saved."
            : "Eval complete.",
        );
      }
    } catch (err) {
      if (mountedRef.current) setStatus(`Eval failed: ${err.message}`);
    } finally {
      const listeners = activeRun?.listeners;
      const finishedSnapshot = snapshotActiveRun(true);
      activeRun = null;
      listeners?.forEach((listener) => listener(finishedSnapshot));
      if (mountedRef.current) setActiveSnapshot(null);
    }
  }

  function handleCancel() {
    if (!activeRun) return;
    activeRun.controller.abort();
    activeRun.run.cancelled = true;
    setActiveSnapshot(snapshotActiveRun());
    notifyActiveRun();
  }

  function exportJson() {
    if (!runRecord) return;
    const blob = new Blob([JSON.stringify(runRecord, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aura-eval-${runRecord.at || "run"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  return (
    <div className="screen screen-eval">
      <div className="screen-header">
        <span className="screen-title">EVAL</span>
        <span className="screen-subtitle">PROMPTS X MODELS X IMAGES</span>
      </div>

      <section className="settings-section">
        <div className="section-label">SAMPLE IMAGES</div>
        <input
          ref={fileRef}
          className="hidden-file"
          type="file"
          accept="image/*"
          multiple
          onChange={handleFiles}
        />
        <div className="btn-row">
          <button className="dc-btn" onClick={() => fileRef.current?.click()}>
            + UPLOAD
          </button>
          <button className="dc-btn outline" onClick={handleCapture}>
            CAPTURE FRAME
          </button>
        </div>
        <div className="eval-thumb-grid">
          {images.map((image) => (
            <div key={image.id} className="eval-thumb">
              <img src={image.dataUrl} alt="" />
              <div className="eval-thumb-meta">
                <span>{image.source.toUpperCase()}</span>
                <button
                  className="train-del-btn"
                  onClick={() => deleteImage(image.id)}
                >
                  x
                </button>
              </div>
              <div className="mode-segments eval-label-toggle">
                {[
                  [null, "-"],
                  [true, "TRIG"],
                  [false, "CLEAR"],
                ].map(([value, label]) => (
                  <button
                    key={label}
                    className={`mode-segment eval-label-option ${image.expected === value ? "active" : ""}`}
                    onClick={() => updateImageExpected(image, value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-label">PROMPT VARIANTS</div>
        {variants.map((variant) => (
          <div key={variant.id} className="eval-variant">
            <div className="inline-row eval-variant-head">
              <input
                className="dc-input"
                value={variant.name || ""}
                onChange={(e) =>
                  updateVariant(variant.id, { name: e.target.value })
                }
                placeholder="Variant name"
              />
              <button
                className="dc-btn outline"
                onClick={() => deleteVariant(variant.id)}
              >
                DELETE
              </button>
            </div>
            <div className="form-group">
              <label className="field-label">MISSION</label>
              <textarea
                className="dc-textarea"
                rows={3}
                value={variant.mission || ""}
                onChange={(e) =>
                  updateVariant(variant.id, { mission: e.target.value })
                }
                placeholder="What to watch for"
              />
            </div>
            <div className="form-group">
              <label className="field-label">OPTIONAL INSTRUCTION</label>
              <input
                className="dc-input"
                value={variant.instruction || ""}
                onChange={(e) =>
                  updateVariant(variant.id, { instruction: e.target.value })
                }
                placeholder="Extra detector instruction"
              />
            </div>
          </div>
        ))}
        <button className="dc-btn" onClick={addVariant}>
          + ADD VARIANT
        </button>
      </section>

      <section className="settings-section">
        <div className="section-label">MODELS</div>
        <div className="btn-row">
          <button
            className="dc-btn"
            disabled={fetchingModels}
            onClick={handleFetchModels}
          >
            {fetchingModels ? "FETCHING..." : "FETCH MODELS"}
          </button>
        </div>
        {providerModels.length > 0 && (
          <div className="eval-model-list">
            {providerModels.map((model) => (
              <label key={model} className="toggle-label">
                <input
                  type="checkbox"
                  className="dc-checkbox"
                  checked={selectedModels.includes(model)}
                  onChange={() => toggleModel(model)}
                />
                <span>{model}</span>
              </label>
            ))}
          </div>
        )}
        <div className="inline-row">
          <input
            className="dc-input"
            value={manualModel}
            onChange={(e) => setManualModel(e.target.value)}
            placeholder="Manual model name"
          />
          <button className="dc-btn outline" onClick={addManualModel}>
            ADD
          </button>
        </div>
        {selectedModels.length > 0 && (
          <p className="status-msg">Selected: {selectedModels.join(", ")}</p>
        )}
      </section>

      <section className="settings-section">
        <div className="section-label">RUN</div>
        <div className="inline-row">
          <div className="form-group">
            <label className="field-label">CONCURRENCY</label>
            <select
              className="dc-select"
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              disabled={running}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <p className="status-msg eval-call-count">
            {images.length} images x {usableVariantCount} variants x{" "}
            {selectedModels.length} models = {callCount} calls
          </p>
        </div>
        <p className="status-msg">
          Estimated max cost from returned tokens at $
          {parseFloat(rate || 0).toFixed(4)} / 1M tokens.
        </p>
        {running && (
          <ProgressBar
            phase="processing"
            pct={progressPct}
            label={`${activeSnapshot.done}/${activeSnapshot.total} CELLS`}
          />
        )}
        <div className="btn-row">
          <button
            className="dc-btn primary"
            disabled={running || Boolean(disabledReason)}
            onClick={handleRun}
          >
            RUN
          </button>
          <button
            className="dc-btn outline"
            disabled={!running}
            onClick={handleCancel}
          >
            CANCEL
          </button>
          <button
            className="dc-btn outline"
            disabled={!runRecord}
            onClick={exportJson}
          >
            EXPORT JSON
          </button>
        </div>
        {disabledReason && <p className="status-msg">{disabledReason}</p>}
        {status && (
          <p className="status-msg" role="status" aria-live="polite">
            {status}
          </p>
        )}
      </section>

      <section className="settings-section">
        <div className="section-label">RESULTS</div>
        {runRecord ? (
          <div className="eval-table-wrap">
            <table className="eval-table">
              <thead>
                <tr>
                  <th rowSpan="2" className="eval-sticky-col">
                    IMAGE
                  </th>
                  {runRecord.models.map((model) => (
                    <th key={model} colSpan={runRecord.variants.length}>
                      {model}
                    </th>
                  ))}
                </tr>
                <tr>
                  {combos.map(({ key, variant }) => (
                    <th key={key}>{variant.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runRecord.imageIds.map((imageId) => {
                  const image = imagesById[imageId];
                  const expected = runRecord.expectedByImage?.[imageId];
                  return (
                    <tr key={imageId}>
                      <th className="eval-sticky-col">
                        {image?.dataUrl && (
                          <img
                            className="eval-row-thumb"
                            src={image.dataUrl}
                            alt=""
                          />
                        )}
                        <span>{labelText(expected)}</span>
                      </th>
                      {combos.map(({ key }) => {
                        const result = resultByCell.get(`${imageId}|${key}`);
                        return (
                          <td
                            key={key}
                            className={cellClass(result, expected)}
                            title={result?.reason || result?.error || ""}
                          >
                            {formatCell(result)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr className="eval-agg-row">
                  <th className="eval-sticky-col eval-agg-heading">ACCURACY</th>
                  {combos.map(({ key }) => {
                    const combo = summaryByCombo.get(key);
                    return (
                      <td key={key} className="eval-agg-cell">
                        {combo?.labeled
                          ? `${Math.round(combo.labeled.accuracy * 100)}%`
                          : "-"}
                      </td>
                    );
                  })}
                </tr>
                <tr className="eval-agg-row">
                  <th className="eval-sticky-col eval-agg-heading">LATENCY</th>
                  {combos.map(({ key }) => {
                    const combo = summaryByCombo.get(key);
                    return (
                      <td key={key} className="eval-agg-cell">
                        {combo?.meanLatencyMs != null
                          ? `${combo.meanLatencyMs}ms`
                          : "-"}
                      </td>
                    );
                  })}
                </tr>
                <tr className="eval-agg-row">
                  <th className="eval-sticky-col eval-agg-heading">
                    TOKENS / COST
                  </th>
                  {combos.map(({ key }) => {
                    const combo = summaryByCombo.get(key);
                    return (
                      <td key={key} className="eval-agg-cell">
                        {combo
                          ? `${combo.totalTokens} / $${combo.estCost.toFixed(4)}`
                          : "-"}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="status-msg">No eval results yet.</p>
        )}
      </section>
    </div>
  );
}

function notifyActiveRun() {
  const snapshot = snapshotActiveRun();
  activeRun?.listeners.forEach((listener) => listener(snapshot));
}

function snapshotActiveRun(finished = false) {
  if (!activeRun) return null;
  return {
    total: activeRun.total,
    done: activeRun.done,
    run: activeRun.run,
    finished,
  };
}

function sortImages(images) {
  return [...images].sort((a, b) => a.createdAt - b.createdAt);
}

function newImage(dataUrl, source) {
  return {
    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    dataUrl,
    expected: null,
    source,
    createdAt: Date.now(),
  };
}

function getDisabledReason({ apiKey, images, variants, selectedModels }) {
  if (!apiKey) return "Configure an API key in Settings first.";
  if (images.length === 0) return "Add at least one sample image.";
  if (
    variants.filter((variant) => (variant.mission || "").trim()).length === 0
  ) {
    return "Add at least one prompt variant with a mission.";
  }
  if (selectedModels.length === 0) return "Select or add at least one model.";
  return "";
}

function labelText(expected) {
  if (expected === true) return "TRIG";
  if (expected === false) return "CLEAR";
  return "-";
}

function cellClass(result, expected) {
  if (
    !result ||
    result.status !== "ok" ||
    (expected !== true && expected !== false)
  ) {
    return "";
  }
  return result.triggered === expected
    ? "eval-cell-match"
    : "eval-cell-mismatch";
}

function formatCell(result) {
  if (!result) return "...";
  if (result.status === "cancelled") return "CANCEL";
  if (result.status === "error") return "ERR";
  const verdict = result.triggered ? "TRIG" : "clear";
  const confidence = Number.isFinite(result.confidence)
    ? Math.round(result.confidence)
    : "-";
  const latency = Number.isFinite(result.latencyMs)
    ? `${result.latencyMs}ms`
    : "-";
  return `${verdict} ${confidence} / ${latency}`;
}

async function fileToJpegDataUrl(file) {
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = CAPTURE_W;
  canvas.height = CAPTURE_H;
  const ctx = canvas.getContext("2d");
  const scale = Math.min(CAPTURE_W / img.width, CAPTURE_H / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CAPTURE_W, CAPTURE_H);
  ctx.drawImage(img, (CAPTURE_W - dw) / 2, (CAPTURE_H - dh) / 2, dw, dh);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.name}.`));
    };
    img.src = url;
  });
}

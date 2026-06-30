import { useState, useCallback } from 'react';
import { getExamples, addExample, removeExample, clearExamples, runDetectionOptimization, runActionOptimization } from '../../lib/aura.js';

export default function OptimizeScreen() {
  const [trainType, setTrainType] = useState('detection');
  const [examples, setExamples] = useState(() => getExamples());
  const [trainStatus, setTrainStatus] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [trainApikey, setTrainApikey] = useState('');

  // Detection form
  const [trainMission, setTrainMission] = useState('');
  const [trainScene, setTrainScene] = useState('');
  const [trainTriggered, setTrainTriggered] = useState(false);
  const [trainConfidence, setTrainConfidence] = useState(80);
  const [trainReason, setTrainReason] = useState('');

  // Action form
  const [trainInstruction, setTrainInstruction] = useState('');
  const [trainContext, setTrainContext] = useState('');
  const [trainMessage, setTrainMessage] = useState('');

  const refresh = useCallback(() => setExamples(getExamples()), []);

  function handleAdd() {
    let ex;
    if (trainType === 'detection') {
      if (!trainMission.trim()) { setTrainStatus('Mission is required.'); return; }
      ex = { type: 'detection', mission: trainMission.trim(), sceneDescription: trainScene.trim(), triggered: trainTriggered, confidence: trainConfidence, reason: trainReason.trim() };
    } else {
      if (!trainInstruction.trim()) { setTrainStatus('Instruction is required.'); return; }
      ex = { type: 'action', instruction: trainInstruction.trim(), context: trainContext.trim(), message: trainMessage.trim() };
    }
    addExample(ex);
    refresh();
    setTrainStatus('Example added.');
    if (trainType === 'detection') { setTrainMission(''); setTrainScene(''); setTrainTriggered(false); setTrainConfidence(80); setTrainReason(''); }
    else { setTrainInstruction(''); setTrainContext(''); setTrainMessage(''); }
    setTimeout(() => setTrainStatus(s => s === 'Example added.' ? '' : s), 2000);
  }

  function handleClear() {
    clearExamples();
    refresh();
    setTrainStatus('All examples cleared.');
  }

  async function runOpt(type) {
    if (!trainApikey.trim()) { setTrainStatus('Enter a Cerebras API key for optimization.'); return; }
    const exList = getExamples().filter(ex => ex.type === type);
    if (exList.length < 2) { setTrainStatus(`Need at least 2 ${type} examples.`); return; }
    setOptimizing(true);
    setTrainStatus(`Optimizing ${type}… this may take a minute.`);
    try {
      const fn = type === 'detection' ? runDetectionOptimization : runActionOptimization;
      const result = await fn({ apiKey: trainApikey.trim(), examples: exList });
      setTrainStatus(`${type} optimization done! Best score: ${result.bestScore?.toFixed(2) || '?'}`);
    } catch (err) {
      setTrainStatus(`Optimization failed: ${err.message}`);
    } finally {
      setOptimizing(false);
    }
  }

  return (
    <div className="screen screen-optimize">
      <div className="screen-header">
        <span className="screen-title">OPTIMIZE / TRAINING</span>
      </div>

      <div className="form-group">
        <label className="field-label">EXAMPLE TYPE</label>
        <select
          id="train-type"
          className="dc-select"
          value={trainType}
          onChange={e => setTrainType(e.target.value)}
        >
          <option value="detection">Detection</option>
          <option value="action">Action</option>
        </select>
      </div>

      {trainType === 'detection' ? (
        <div id="train-detection-fields">
          <div className="form-group">
            <label className="field-label">MISSION PROMPT</label>
            <input id="train-mission" className="dc-input" value={trainMission} onChange={e => setTrainMission(e.target.value)} placeholder="What to watch for" />
          </div>
          <div className="form-group">
            <label className="field-label">SCENE DESCRIPTION</label>
            <textarea id="train-scene" className="dc-textarea" rows={2} value={trainScene} onChange={e => setTrainScene(e.target.value)} placeholder="What the camera sees" />
          </div>
          <div className="inline-row">
            <label className="toggle-label">
              <input id="train-triggered" type="checkbox" className="dc-checkbox" checked={trainTriggered} onChange={e => setTrainTriggered(e.target.checked)} />
              <span>TRIGGERED</span>
            </label>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="field-label">CONFIDENCE</label>
              <input id="train-confidence" className="dc-input" type="number" min="0" max="100" value={trainConfidence} onChange={e => setTrainConfidence(Number(e.target.value))} />
            </div>
          </div>
          <div className="form-group">
            <label className="field-label">EXPECTED REASON</label>
            <input id="train-reason" className="dc-input" value={trainReason} onChange={e => setTrainReason(e.target.value)} placeholder="Why it triggered" />
          </div>
        </div>
      ) : (
        <div id="train-action-fields">
          <div className="form-group">
            <label className="field-label">ACTION INSTRUCTION</label>
            <input id="train-instruction" className="dc-input" value={trainInstruction} onChange={e => setTrainInstruction(e.target.value)} placeholder="What to say or do" />
          </div>
          <div className="form-group">
            <label className="field-label">DETECTION CONTEXT</label>
            <input id="train-context" className="dc-input" value={trainContext} onChange={e => setTrainContext(e.target.value)} placeholder="What was detected" />
          </div>
          <div className="form-group">
            <label className="field-label">EXPECTED MESSAGE</label>
            <textarea id="train-message" className="dc-textarea" rows={2} value={trainMessage} onChange={e => setTrainMessage(e.target.value)} placeholder="What should be announced" />
          </div>
        </div>
      )}

      <div className="btn-row">
        <button id="train-add-btn" className="dc-btn" onClick={handleAdd}>+ ADD EXAMPLE</button>
        <button id="train-clear-btn" className="dc-btn outline" onClick={handleClear}>CLEAR ALL</button>
      </div>

      <ul id="train-example-list" className="train-example-list">
        {examples.map(ex => (
          <li key={ex.id} className="train-example-item">
            <span className="example-label">
              {ex.type === 'detection'
                ? `det: "${(ex.mission || '').slice(0, 40)}" → ${ex.triggered ? 'T' : 'F'}/${ex.confidence}`
                : `act: "${(ex.instruction || '').slice(0, 40)}"`}
            </span>
            <button className="train-del-btn" onClick={() => { removeExample(ex.id); refresh(); }}>×</button>
          </li>
        ))}
      </ul>

      <details className="optimize-section">
        <summary className="optimize-summary">OPTIMIZATION</summary>
        <div className="form-group">
          <label className="field-label">CEREBRAS API KEY (FOR TRAINING)</label>
          <input
            id="train-apikey"
            type="password"
            className="dc-input"
            value={trainApikey}
            onChange={e => setTrainApikey(e.target.value)}
          />
        </div>
        <div className="btn-row">
          <button id="train-opt-detection" className="dc-btn" disabled={optimizing} onClick={() => runOpt('detection')}>OPTIMIZE DETECTION</button>
          <button id="train-opt-action" className="dc-btn" disabled={optimizing} onClick={() => runOpt('action')}>OPTIMIZE ACTION</button>
        </div>
      </details>

      {trainStatus && (
        <p id="train-status" className="status-msg" role="status" aria-live="polite">{trainStatus}</p>
      )}
    </div>
  );
}

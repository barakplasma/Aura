// "Test on current frame" — the Setup wizard's proof that an engine is
// configured, not just filled in (docs/PRD-ux-redesign.md, "Setup as a
// wizard"). One detection pass on the frame the stage is showing, through the
// same scan function the live loop uses, so a green test means a real scan
// would work.
//
// Threshold 0 and no action/webhook: the point is "does this engine answer",
// so nothing is gated on confidence and no announcement or webhook leg runs.
// DECISION runs with no fallback on purpose — a fallback would let the
// provider answer and hide a broken decision endpoint, which is the thing
// being tested.
//
// The scan functions are injected: the browser ones pull in the worker and
// fetch, and this module stays pure enough for `node --test`.

import { fromScan } from './verdict.js';
import { missionToQuestion } from './decision.js';

// What to look for when no mission has been written yet.
export const TEST_MISSION = 'anything unusual, unsafe, or noteworthy';

// A Replicate worker can be cold for minutes, and a test is worth waiting for.
const DECISION_TEST_TIMEOUT_S = 300;
const PROVIDER_TEST_TIMEOUT_S = 60;

export const NO_FRAME = 'Arm the monitor first — the camera has to be live so there is a frame to test.';

/**
 * @param {object} args
 * @param {object} args.settings  the live settings (engine, provider/browser/decision fields, mission)
 * @param {string|null} args.frame  a JPEG data URL/base64 from the stage, or null
 * @param {{provider: Function, browser: Function, decision: Function}} args.scans
 * @returns {Promise<{ verdict: object, result: object, engine: string }>}
 * @throws {Error} with a message fit to show inline
 */
export async function runFrameTest({ settings, frame, scans, signal, onProgress, now }) {
  if (!frame) throw new Error(NO_FRAME);
  const engine = settings.engine === 'browser' || settings.engine === 'decision' ? settings.engine : 'provider';
  const mission = (settings.mission || '').trim() || TEST_MISSION;

  let result;
  if (engine === 'browser') {
    result = await scans.browser({
      model: settings.browserModel || undefined,
      runtime: settings.browserRuntime || 'auto',
      mission,
      image: frame,
      threshold: 0,
      signal,
      onProgress,
    });
  } else if (engine === 'decision') {
    result = await scans.decision({
      modelId: settings.decisionModel,
      url: settings.decisionUrl,
      account: settings.decisionAccount,
      apiKey: settings.decisionKey || undefined,
      mission,
      question: missionToQuestion({ mission }),
      image: frame,
      threshold: 0,
      requestTimeout: DECISION_TEST_TIMEOUT_S,
      signal,
    });
  } else {
    result = await scans.provider({
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey,
      mission,
      image: frame,
      threshold: 0,
      requestTimeout: PROVIDER_TEST_TIMEOUT_S,
      signal,
    });
  }
  return { verdict: fromScan(result, { engine, threshold: 0, now }), result, engine };
}

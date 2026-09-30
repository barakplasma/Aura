import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { DETECTOR_MODELS, DEFAULT_DETECTOR_MODEL, detectorModelKeys } from '../../lib/browser-engine.js';
import { suggestClasses } from '../../lib/detector-models.js';
import { parseWakeOn, WAKE_KINDS } from '../../lib/object-gate.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.jsx';
import { Field } from '../ui/field.jsx';
import { Input, NumberInput, Select } from '../ui/input.jsx';
import { Segmented } from '../ui/segmented.jsx';
import { Slider } from '../ui/slider.jsx';
import { Toggle } from '../ui/toggle.jsx';

const SENSITIVITY = ['low', 'medium', 'high'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const cap = (word) => word[0].toUpperCase() + word.slice(1);

// One folded row: a title, the current value while shut, the controls open.
function Item({ title, summary, children }) {
  return (
    <Collapsible className="border-t border-border first:border-t-0">
      <CollapsibleTrigger data-advanced-item={title} className="flex min-h-14 w-full items-center gap-3 text-left">
        <span className="flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-xs text-text-dim">{summary}</span>
        </span>
        <ChevronDown className="size-4 shrink-0" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function gateSummary(s, detectorKey) {
  if (!s.objectGate) return 'Off — every scan calls the vision model';
  const wake = [...parseWakeOn(s.objectWakeOn)].join(', ') || 'nothing';
  return `On · ${DETECTOR_MODELS[detectorKey].label} · check every ${s.objectGateEveryS}s · wake on ${wake}`;
}

function captureSummary(s) {
  const size = s.captureSize === 'custom' ? `${s.customCaptureWidth}x${s.customCaptureHeight}` : s.captureSize;
  return `${size.replace('x', ' × ')}${s.captureSize === 'custom' ? ' (custom)' : ''}`;
}

function pricingSummary(pricing, override) {
  if (pricing?.source === 'free') return 'Free — a local engine';
  if (override) return `Manual · in ${override.inputRate ?? '—'} / out ${override.outputRate ?? '—'} $/1M tokens`;
  if (pricing?.source === 'unavailable') return 'No catalogue price — enter rates to enable the $ cap';
  return `Automatic · in ${pricing?.inputRate ?? '—'} / out ${pricing?.outputRate ?? '—'} $/1M tokens`;
}

function ObjectGate({ s, set, detectorKey, hasWebGpu }) {
  const wakeSet = parseWakeOn(s.objectWakeOn);
  const suggested = useMemo(() => suggestClasses(s.mission), [s.mission]);
  return (
    <>
      <Toggle
        id="object-gate-toggle"
        label="Wake on object changes only"
        checked={s.objectGate}
        onChange={set.objectGate}
        hint="Runs a tiny detector (a few MB, on this device) between scans and only calls the vision model when the set of objects in frame actually changes. Cuts GPU load and cost by one to two orders of magnitude on a scene that mostly sits still."
      />
      {s.objectGate && (
        <>
          <Field
            label="Detector"
            htmlFor="object-model"
            hint={<>
              YOLO26 (COCO-80), downloaded once and cached. Licensed AGPL-3.0 by{' '}
              <a className="underline" href="https://www.ultralytics.com/license" target="_blank" rel="noreferrer">Ultralytics</a>.
              {!hasWebGpu && DETECTOR_MODELS[detectorKey]?.requiresWebGpu &&
                ' This row wants WebGPU, which this browser does not report — it will run on WASM instead.'}
            </>}
          >
            <Select id="object-model" value={detectorKey} onChange={(e) => set.objectModel(e.target.value)}>
              {detectorModelKeys().map((key) => (
                <option key={key} value={key}>{DETECTOR_MODELS[key].label} · {DETECTOR_MODELS[key].sizeLabel}</option>
              ))}
            </Select>
          </Field>
          <Field label="Check every (seconds)" htmlFor="object-gate-every" hint="Seconds between gate checks. Detection latency is about twice this.">
            <NumberInput id="object-gate-every" min="0.5" step="0.5" value={s.objectGateEveryS} onChange={(e) => set.objectGateEveryS(e.target.value)} />
          </Field>
          <Field
            label="Watch classes"
            htmlFor="object-classes"
            hint="Comma-separated. Changes to anything else are ignored, which is where most of the saving comes from — and where a false negative would come from, so keep it wide."
          >
            <Input id="object-classes" type="text" value={s.objectClasses} placeholder="blank = all 80 COCO classes" onChange={(e) => set.objectClasses(e.target.value)} />
            {suggested.length > 0 && (
              <div>
                <Button id="object-classes-suggest" variant="outline" onClick={() => set.objectClasses(suggested.join(', '))}>
                  Use {suggested.join(', ')}
                </Button>
              </div>
            )}
          </Field>
          <Field
            label="Wake on"
            hint="Moved re-triggers while something already in frame keeps moving — right for a driveway, wrong for a doorbell, so it is off by default."
          >
            {WAKE_KINDS.map((kind) => (
              <Toggle
                key={kind}
                id={`wake-${kind}`}
                label={cap(kind)}
                checked={wakeSet.has(kind)}
                onChange={(on) => {
                  const next = new Set(wakeSet);
                  if (on) next.add(kind); else next.delete(kind);
                  set.objectWakeOn([...next].join(','));
                }}
              />
            ))}
          </Field>
          {wakeSet.has('moved') && (
            <Field
              label={`Movement threshold: ${Math.round(Number(s.objectMoveFrac) * 100)}%`}
              htmlFor="object-move-frac"
              hint="Of the frame, measured since the last scan rather than the last check — so a slow walker still trips it."
            >
              <Slider id="object-move-frac" min={0.02} max={0.5} step={0.01} value={[Number(s.objectMoveFrac)]} onValueChange={([v]) => set.objectMoveFrac(v)} />
            </Field>
          )}
          <Field
            label="Sensitivity"
            hint="Confidence and persistence needed before an object counts as arrived or gone. High reacts in one check and wakes the model more often."
          >
            <Segmented label="Gate sensitivity" value={s.objectSens} onChange={set.objectSens} options={SENSITIVITY} />
          </Field>
          <Field
            label="Heartbeat every (minutes)"
            htmlFor="heartbeat-min"
            hint="A full scan runs this often no matter what the gate says — the detector knows 80 object classes and nothing about smoke, a left-on stove, or a wilting plant. 0 disables it, which makes those things invisible."
          >
            <NumberInput id="heartbeat-min" min="0" step="1" value={s.heartbeatMin} onChange={(e) => set.heartbeatMin(e.target.value)} />
          </Field>
          <Toggle
            id="object-prompt-context"
            label="Add objects to the prompt"
            checked={s.objectPromptContext}
            onChange={set.objectPromptContext}
            hint={'Tells the vision model what the detector saw ("person x1, backpack x1"). Helps a small model a lot; changes the prompt, so saved eval runs stop being comparable.'}
          />
        </>
      )}
    </>
  );
}

function PricingFields({ s, pricing, pricingOverride, onSetPricingOverride, onResetPricingOverride }) {
  function setManualRate(field, value) {
    const other = field === 'inputRate' ? 'outputRate' : 'inputRate';
    const fallback = pricingOverride?.[other] ?? pricing?.[other] ?? '';
    onSetPricingOverride({ ...pricingOverride, [field]: value, [other]: fallback });
  }
  const source = pricing?.source;
  return (
    <>
      {s.engine === 'decision' && Number.isFinite(pricing?.perSecond) && (
        <p className="text-xs text-text-dim">
          Decision model: {pricing.perSecond > 0
            ? `$${pricing.perSecond} per second of predict time (Replicate's public hardware rate), billed to your own account.`
            : 'free — your own server.'}
          {' '}The token rates below price the provider&apos;s announcements and fallbacks.
        </p>
      )}
      <p className="text-xs text-text-dim">
        {source === 'unavailable'
          ? 'No catalogue price found. Enter both rates to enable the dollar budget cap.'
          : source === 'manual'
            ? 'Manual override for this provider and model.'
            : `${pricing?.estimated ? 'Upstream estimate' : 'Automatic'} price from ${source === 'openrouter' ? 'OpenRouter' : source === 'free' ? 'the local engine' : 'llm-prices'}${pricing?.updatedAt ? ` (${pricing.updatedAt})` : ''}.`}
      </p>
      {source !== 'free' && (
        <div className="flex flex-wrap gap-2">
          <Field label="Input $/1M tokens" htmlFor="input-rate">
            <NumberInput id="input-rate" min="0" step="0.0001" placeholder={`${pricing?.inputRate ?? '—'}`} value={pricingOverride?.inputRate ?? ''} onChange={(e) => setManualRate('inputRate', e.target.value)} />
          </Field>
          <Field label="Output $/1M tokens" htmlFor="output-rate">
            <NumberInput id="output-rate" min="0" step="0.0001" placeholder={`${pricing?.outputRate ?? '—'}`} value={pricingOverride?.outputRate ?? ''} onChange={(e) => setManualRate('outputRate', e.target.value)} />
          </Field>
          {pricingOverride && <div className="self-end"><Button variant="outline" onClick={onResetPricingOverride}>Use auto</Button></div>}
        </div>
      )}
    </>
  );
}

// Everything an operator touches once a year, each folded to a one-line value.
export default function AdvancedCard({ s, set, pricing, pricingOverride, onSetPricingOverride, onResetPricingOverride }) {
  const detectorKey = s.objectModel && DETECTOR_MODELS[s.objectModel] ? s.objectModel : DEFAULT_DETECTOR_MODEL;
  const hasWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  return (
    <Card className="flex flex-col" data-setup-card="advanced">
      <h2 className="mb-2 text-xl font-semibold">Advanced</h2>
      <Item title="Object gate" summary={gateSummary(s, detectorKey)}>
        <ObjectGate s={s} set={set} detectorKey={detectorKey} hasWebGpu={hasWebGpu} />
      </Item>
      <Item title="Scan image size" summary={captureSummary(s)}>
        <Field label="Size" htmlFor="capture-size" hint="Smaller images use less upload data and may reduce model tokens. Small details may be harder to detect.">
          <Select id="capture-size" value={s.captureSize} onChange={(e) => set.captureSize(e.target.value)}>
            <option value="640x480">640 × 480 (default)</option>
            <option value="512x384">512 × 384</option>
            <option value="320x240">320 × 240</option>
            <option value="1280x720">1280 × 720 (HD)</option>
            <option value="1920x1080">1920 × 1080 (Full HD)</option>
            <option value="custom">Custom</option>
          </Select>
        </Field>
        {s.captureSize === 'custom' && (
          <Field label="Custom size" hint="64–4096 pixels per side, 8 MP maximum. New camera capture requests apply when you next arm; encoding changes on the next scan.">
            <div className="flex items-center gap-2">
              <NumberInput id="custom-capture-width" aria-label="Width" min="64" max="4096" value={s.customCaptureWidth} onChange={(e) => set.customCaptureWidth(e.target.value)} />
              <span>×</span>
              <NumberInput id="custom-capture-height" aria-label="Height" min="64" max="4096" value={s.customCaptureHeight} onChange={(e) => set.customCaptureHeight(e.target.value)} />
            </div>
          </Field>
        )}
      </Item>
      <Item title="Model pricing" summary={pricingSummary(pricing, pricingOverride)}>
        <PricingFields s={s} pricing={pricing} pricingOverride={pricingOverride} onSetPricingOverride={onSetPricingOverride} onResetPricingOverride={onResetPricingOverride} />
      </Item>
      <Item title="Keep screen on" summary={s.keepScreenOn ? 'On' : 'Off'}>
        <Toggle
          id="keep-screen-on-toggle"
          label="Keep screen on while armed"
          checked={s.keepScreenOn}
          onChange={set.keepScreenOn}
          hint={`Holds a screen wake lock while armed so the phone doesn't sleep and freeze the camera.${wakeLockSupported ? '' : ' This browser has no Wake Lock API — the screen may still sleep regardless.'}`}
        />
      </Item>
      {s.engine === 'browser' && (
        <Item title="Unload model when idle" summary={Number(s.vlmIdleEvictMin) > 0 ? `After ${s.vlmIdleEvictMin} min` : 'Never'}>
          <Field
            label="Minutes"
            htmlFor="vlm-idle-evict"
            hint="Minutes of no scans before the vision model is dropped from GPU memory. Weights stay cached, so waking it costs a second or two rather than a download. 0 = never."
          >
            <NumberInput id="vlm-idle-evict" min="0" step="1" value={s.vlmIdleEvictMin} onChange={(e) => set.vlmIdleEvictMin(e.target.value)} />
          </Field>
        </Item>
      )}
    </Card>
  );
}

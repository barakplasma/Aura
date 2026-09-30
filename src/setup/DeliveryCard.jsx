import { useState } from 'react';
import { testVibration, canVibrate } from '../../public/feedback.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.jsx';
import { Field, Textarea } from '../ui/field.jsx';
import { Input, Select } from '../ui/input.jsx';
import { Status } from '../ui/status.jsx';
import { Toggle } from '../ui/toggle.jsx';
import { ChevronDown } from 'lucide-react';

// How an alert reaches you: speech, vibration, and a webhook (ntfy, Home
// Assistant, anything that takes an HTTP request).
export default function DeliveryCard({ s, set }) {
  const [vibe, setVibe] = useState('');
  const [hook, setHook] = useState(null);

  function handleWebhookTest() {
    const url = (s.webhookUrl || '').trim();
    if (!url) { setHook({ tone: 'danger', text: 'No URL configured.' }); return; }
    let headers = { 'Content-Type': 'application/json' };
    try {
      const custom = JSON.parse((s.webhookHeaders || '').trim() || '{}');
      if (custom && typeof custom === 'object') headers = { ...headers, ...custom };
    } catch {
      setHook({ tone: 'danger', text: 'Headers are not valid JSON — sending without them.' });
    }
    const body = JSON.stringify({ event: 'test', timestamp: new Date().toISOString(), message: 'Aura webhook test.' });
    // no-cors: the response is opaque, so "sent" is all that can be reported.
    fetch(url, { method: s.webhookMethod || 'POST', headers, body, signal: AbortSignal.timeout(5000), mode: 'no-cors' }).catch(() => {});
    setHook((h) => h?.tone === 'danger' ? h : { tone: 'ok', text: 'Test sent.' });
    setTimeout(() => setHook((h) => h?.text === 'Test sent.' ? null : h), 3000);
  }

  return (
    <Card className="flex flex-col gap-4" data-setup-card="delivery">
      <h2 className="text-xl font-semibold">Delivery</h2>
      <Toggle id="setup-speech" label="Speak alerts" checked={s.speech} onChange={set.speech} />
      <div className="flex flex-col gap-2">
        <Toggle id="setup-haptics" label="Vibrate" checked={s.haptics} onChange={set.haptics} />
        <div className="flex flex-wrap items-center gap-3">
          <Button id="vibe-test" variant="outline" disabled={!canVibrate} onClick={() => { testVibration(); setVibe('Buzzing now — feel that?'); }}>
            Test vibration
          </Button>
          {!canVibrate && <span className="text-xs text-text-dim">Vibration is not supported on this browser/device (e.g. iOS Safari).</span>}
        </div>
        <Status id="vibe-status">{vibe}</Status>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-base font-semibold">Webhook</h3>
        <Field label="URL" htmlFor="webhook-url">
          <Input id="webhook-url" type="url" value={s.webhookUrl} onChange={(e) => set.webhookUrl(e.target.value)} placeholder="https://ntfy.sh/mytopic" />
        </Field>
        <div className="flex items-end gap-2">
          <Field label="Method" htmlFor="webhook-method" className="flex-1">
            <Select id="webhook-method" value={s.webhookMethod} onChange={(e) => set.webhookMethod(e.target.value)}>
              {['POST', 'GET', 'PUT', 'PATCH'].map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </Field>
          <Button id="webhook-test" variant="outline" onClick={handleWebhookTest}>Test</Button>
        </div>
        <Status id="webhook-status" tone={hook?.tone}>{hook?.text}</Status>

        <Collapsible>
          <CollapsibleTrigger className="flex min-h-11 items-center gap-1 text-sm font-semibold">
            <ChevronDown className="size-4" aria-hidden />Webhook body &amp; headers
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-4 pt-2">
            <Field label="Headers (JSON)" htmlFor="webhook-headers">
              <Textarea id="webhook-headers" value={s.webhookHeaders} onChange={(e) => set.webhookHeaders(e.target.value)} placeholder='{"Authorization": "Bearer tk_xxxx"}' />
            </Field>
            <Field label="Body action prompt" htmlFor="webhook-action">
              <Textarea id="webhook-action" value={s.webhookAction} onChange={(e) => set.webhookAction(e.target.value)} placeholder="e.g. Include the alert reason, confidence level, and a timestamp." />
            </Field>
            <Field label="Body JSON schema (optional)" htmlFor="webhook-schema">
              <Textarea id="webhook-schema" rows={3} value={s.webhookSchema} onChange={(e) => set.webhookSchema(e.target.value)} placeholder='{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}' />
            </Field>
            <Toggle
              id="webhook-include-image"
              label="Attach latest frame to ntfy alerts"
              hint="For hosted ntfy topic URLs (https://ntfy.sh/topic). Aura uploads the alert JPEG with the generated alert text."
              checked={s.webhookIncludeImage}
              onChange={set.webhookIncludeImage}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Card>
  );
}

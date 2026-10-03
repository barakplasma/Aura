import { useState } from 'react';
import {
  DECISION_MODELS, RELAY_PRESETS, relayPresetFor, decisionModelKeys, defaultDecisionUrl,
  getDecisionModel, usesRelay, vendorFor, isAccountId, DEFAULT_DECISION_MODEL,
} from '../../lib/decision-models.js';
import { decisionTarget } from '../../lib/decision.js';
import { Button } from '../ui/button.jsx';
import { Field } from '../ui/field.jsx';
import { Input, Select } from '../ui/input.jsx';
import { SecretInput } from '../ui/secret-input.jsx';
import { Segmented } from '../ui/segmented.jsx';
import { Status } from '../ui/status.jsx';
import { Toggle } from '../ui/toggle.jsx';

const ANNOUNCERS = [
  { id: 'provider', label: 'Provider' },
  { id: 'browser', label: 'In-browser' },
  { id: 'template', label: 'Template' },
];

// DECISION engine, step 2 (docs/PRD-decision-engine.md): which typed-decision
// model, the relay (or self-hosted server) URL, the Cloudflare account ID when
// the row's URL needs one, the user's OWN key, who words a
// fired alert, and whether a failed decision falls back to the provider.
export default function DecisionFields({ s, set }) {
  const [keyNote, setKeyNote] = useState('');
  const rowKey = getDecisionModel(s.decisionModel) ? s.decisionModel : DEFAULT_DECISION_MODEL;
  const row = DECISION_MODELS[rowKey];
  const relayed = usesRelay(row);
  const vendor = vendorFor(row);
  const providerConfigured = Boolean(s.baseUrl && s.model);

  // Switching between a hosted row and a self-hosted one changes where the
  // key goes, so the key is dropped — a Replicate token must never reach
  // someone's llama-server, nor its key reach Replicate. Rows on the same
  // upstream keep both the URL and the key.
  function selectRow(key) {
    const next = DECISION_MODELS[key];
    if (next.upstream !== row.upstream) {
      set.decisionUrl(defaultDecisionUrl(next));
      if (s.decisionKey) {
        set.decisionKey('');
        setKeyNote('Switched decision endpoint — key cleared. Enter the key for the new endpoint.');
      }
    }
    set.decisionModel(key);
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Decision model"
        htmlFor="decision-model-select"
        hint={<>
          {row.note}
          {row.benchmark && (
            <> Benchmark: {row.benchmark.summary} (<a className="underline" href={row.benchmark.source} target="_blank" rel="noreferrer">source</a>, read {row.benchmark.readOn}).</>
          )}
        </>}
      >
        <Select id="decision-model-select" value={rowKey} onChange={(e) => selectRow(e.target.value)}>
          {decisionModelKeys().map((key) => (
            <option key={key} value={key}>{DECISION_MODELS[key].label}</option>
          ))}
        </Select>
      </Field>

      <Field
        label={relayed ? 'CORS relay' : 'Server URL'}
        htmlFor="decision-url"
        hint={relayed ? (
          <>
            A browser can&apos;t call {vendor.name} directly (no CORS), so requests go through a relay that
            only adds CORS headers. <code>{'{path}'}</code>, <code>{'{url}'}</code> and <code>{'{url:encoded}'}</code> are
            filled in per request. <strong>Your token and camera frames pass through the relay</strong> on
            the way to {vendor.name} — use your own relay if you&apos;d rather no one else sees them.
          </>
        ) : (
          <>
            Your own <code>/v1/systemone</code> server, called directly. It must allow this page&apos;s origin
            (<code>--cors-origins</code>); frames stay on your infrastructure.
          </>
        )}
      >
        <Input
          id="decision-url"
          value={s.decisionUrl}
          onChange={(e) => set.decisionUrl(e.target.value)}
          placeholder={relayed ? 'https://relay.example{path}' : 'http://localhost:54100'}
        />
        {relayed && (
          <div className="flex flex-wrap gap-2">
            {RELAY_PRESETS.map((p) => (
              <Button key={p.id} variant={s.decisionUrl === p.url ? 'primary' : 'outline'} onClick={() => set.decisionUrl(p.url)}>
                {p.label}
              </Button>
            ))}
          </div>
        )}
        {relayed && relayPresetFor(s.decisionUrl) && <Status>{relayPresetFor(s.decisionUrl).note}</Status>}
      </Field>

      {row.needsAccount && (
        <Field
          label="Cloudflare account ID"
          htmlFor="decision-account"
          hint={<>
            The 32-character ID from your Cloudflare dashboard (Workers AI › Use REST API). It is part of the
            request URL — each scan is sent to:{' '}
            <code className="break-all">
              {decisionTarget(row, { url: s.decisionUrl, account: isAccountId(s.decisionAccount) ? s.decisionAccount.trim() : 'ACCOUNT_ID' })}
            </code>
          </>}
        >
          <Input
            id="decision-account"
            value={s.decisionAccount}
            onChange={(e) => set.decisionAccount(e.target.value)}
            placeholder="0123456789abcdef0123456789abcdef"
          />
          {s.decisionAccount && !isAccountId(s.decisionAccount) && (
            <Status tone="warn">An account ID is 32 hex characters.</Status>
          )}
        </Field>
      )}

      <Field
        label={relayed ? `Your ${vendor.name} token` : 'Server API key'}
        htmlFor="decision-key"
        hint={relayed
          ? `Your own token, billed to your own ${vendor.name} account. Stored in this browser; the relay forwards it and keeps nothing.`
          : 'Leave blank for a server started without --api-key.'}
      >
        <SecretInput
          id="decision-key"
          value={s.decisionKey}
          onChange={(e) => { set.decisionKey(e.target.value); setKeyNote(''); }}
          placeholder={relayed ? vendor.tokenPlaceholder : 'blank if the server needs none'}
        />
        <Status tone="warn">{keyNote}</Status>
      </Field>

      <Field
        label="Announcer"
        hint={<>
          Decision models return probabilities, not words. When an alert fires, the
          {s.decisionAnnouncer === 'provider' && ' provider below writes the announcement (one chat call, only when fired).'}
          {s.decisionAnnouncer === 'browser' && ' in-browser model writes it on this device.'}
          {s.decisionAnnouncer === 'template' && ' mission\'s "on alert, announce" text is spoken as written.'}
          {s.decisionAnnouncer === 'provider' && !providerConfigured && ' No provider is configured yet, so the template is used.'}
          {' '}If the announcer fails, the template speaks — the alert itself is never dropped.
        </>}
      >
        <Segmented label="Announcer" value={s.decisionAnnouncer} onChange={set.decisionAnnouncer} options={ANNOUNCERS} />
      </Field>

      <Toggle
        id="decision-fallback-toggle"
        label="Fall back to the provider"
        checked={s.decisionFallback}
        onChange={set.decisionFallback}
        hint={`A cold start, outage or rejected key re-runs that scan on the provider below${providerConfigured ? '' : ' (none configured yet, so this has no effect)'}.`}
      />

      {row.calibrated === false && (
        <Status tone="warn">This model returns no probabilities: confidence is 100 or 0 from its answer.</Status>
      )}
    </div>
  );
}

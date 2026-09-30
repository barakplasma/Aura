import { useEffect, useState } from 'react';
import { fetchModels, isLocalBaseUrl, sameOrigin } from '../../lib/aura.js';
import { PROVIDER_PRESETS, providerForUrl, benchmarkNote } from '../../lib/providers.js';
import { reportHandledError } from '../monitoring.js';
import { Button } from '../ui/button.jsx';
import { Combobox } from '../ui/combobox.jsx';
import { Field } from '../ui/field.jsx';
import { Input } from '../ui/input.jsx';
import { SecretInput } from '../ui/secret-input.jsx';
import { Status } from '../ui/status.jsx';

const PRESET_OPTIONS = PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label, group: p.group }));

// PROVIDER engine, step 2: preset, base URL, key, model. Also the optional
// announcer/fallback provider under the DECISION engine. Feedback that used to
// be one screen-wide status line now sits beside the field that caused it.
export default function ProviderFields({ s, set }) {
  const [models, setModels] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [modelNote, setModelNote] = useState(null);
  const [keyNote, setKeyNote] = useState('');
  const [query, setQuery] = useState(() => providerForUrl(s.baseUrl)?.label || '');
  useEffect(() => { setQuery(providerForUrl(s.baseUrl)?.label || ''); }, [s.baseUrl]);

  const isLocal = isLocalBaseUrl(s.baseUrl);
  const urlError = s.baseUrl && !/^https?:\/\//i.test(s.baseUrl.trim())
    ? 'Enter a full URL starting with http:// or https://'
    : null;

  // No API-key guard: a local server lists its models without one.
  async function handleFetch() {
    if (!s.baseUrl) { setModelNote({ tone: 'danger', text: 'Enter a Base URL first.' }); return; }
    setFetching(true);
    try {
      const list = await fetchModels(s.baseUrl, s.apiKey, { visionOnly: true });
      setModels(list);
      if (list.length > 0 && !s.model) set.model(list[0]);
      setModelNote({
        tone: 'ok',
        text: list.length > 0
          ? `Found ${list.length} image-capable models — tap the model field to choose.`
          : 'The server lists no image-capable models. You can type a model name.',
      });
    } catch (err) {
      reportHandledError(err, { area: 'fetch-models', inference: isLocal ? 'local-provider' : 'cloud-provider' });
      setModelNote({ tone: 'danger', text: `Fetch failed: ${err.message}. You can type a model name manually.` });
    } finally {
      setFetching(false);
    }
  }

  // Switching providers drops the stored key. Keeping it would send one
  // provider's credential to another endpoint on the very next request —
  // a Cerebras key to localhost, or an OpenAI key to Cerebras. Re-picking the
  // provider that's already configured leaves the key alone.
  function selectPreset(option) {
    const preset = PROVIDER_PRESETS.find((p) => p.id === option.value);
    if (!preset) return;
    if (s.apiKey && !sameOrigin(s.baseUrl, preset.url)) {
      set.apiKey('');
      setKeyNote(`Switched provider — API key cleared. Enter ${preset.label}'s key if it needs one.`);
    }
    set.baseUrl(preset.url);
    setQuery(preset.label);
    setModels(preset.models || []);
    if (!s.model && preset.models?.[0]) set.model(preset.models[0]);
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Provider preset"
        htmlFor="provider-preset"
        hint="10 local and 10 remote OpenAI-compatible providers. Presets include only vision-ready model suggestions where known."
      >
        <Combobox
          id="provider-preset"
          value={query}
          onChange={setQuery}
          onSelect={selectPreset}
          options={PRESET_OPTIONS}
          selectedValue={providerForUrl(s.baseUrl)?.id}
          placeholder="Search local and remote providers"
        />
      </Field>

      <Field
        label="Base URL"
        htmlFor="provider-baseurl"
        error={urlError}
        hint={isLocal ? (
          <>
            Local server — allow this page&apos;s origin in its CORS config
            (<code>OLLAMA_ORIGINS=&apos;*&apos;</code> for Ollama, <code>--cors</code> for llama-server).
            Prefer <code>localhost</code> or <code>127.0.0.1</code>: browsers block <code>0.0.0.0</code> as a request target.
          </>
        ) : undefined}
      >
        <Input id="provider-baseurl" type="url" value={s.baseUrl} onChange={(e) => set.baseUrl(e.target.value)} placeholder="https://api.cerebras.ai/v1" />
      </Field>

      <Field
        label="API key"
        htmlFor="provider-apikey"
        hint="Leave blank for a local server (Ollama, LM Studio, llama.cpp) that needs no key — no Authorization header is sent."
      >
        <SecretInput id="provider-apikey" value={s.apiKey} onChange={(e) => { set.apiKey(e.target.value); setKeyNote(''); }} placeholder="blank for a local server" />
        <Status tone="warn">{keyNote}</Status>
      </Field>

      <Field label="Model" htmlFor="provider-model" hint={benchmarkNote(s.model) || undefined}>
        <div className="flex gap-2">
          <Combobox
            id="provider-model"
            className="flex-1"
            value={s.model}
            onChange={set.model}
            onSelect={(o) => set.model(o.value)}
            options={models.map((m) => ({ value: m, label: m }))}
            selectedValue={s.model}
            placeholder="Search or enter a vision model"
          />
          <Button id="fetch-models-btn" variant="outline" disabled={fetching} onClick={handleFetch}>
            {fetching ? 'Fetching…' : 'Fetch models'}
          </Button>
        </div>
        <Status id="provider-status" tone={modelNote?.tone}>{modelNote?.text}</Status>
      </Field>
    </div>
  );
}

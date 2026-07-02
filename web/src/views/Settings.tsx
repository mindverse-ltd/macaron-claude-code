import { useEffect, useState } from 'react';
import { api, type PublicSettings, type Provider } from '../lib/api';
import { useToast } from '../components/Toast';

const PROVIDER_OPTIONS: Array<{ value: Provider; label: string; sub: string }> = [
  {
    value: 'anthropic',
    label: 'Anthropic (default)',
    sub: "Uses your Claude Code login — Opus 4.7 by default.",
  },
  {
    value: 'macaron',
    label: 'Macaron',
    sub: 'Routes the SDK through Macaron\'s Anthropic-compatible endpoint. Needs an API key below.',
  },
];

export function Settings() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [macaronKey, setMacaronKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setProvider(s.provider);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const macaron = settings?.providers.macaron;
  const dirty =
    (settings && provider !== settings.provider) || macaronKey.length > 0;
  const macaronReady = provider !== 'macaron' || (settings?.providers.macaron.configured || macaronKey.length > 0);

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const patch: Parameters<typeof api.saveSettings>[0] = { provider };
      if (macaronKey.length > 0) {
        patch.providers = { macaron: { apiKey: macaronKey } };
      }
      const next = await api.saveSettings(patch);
      setSettings(next);
      setProvider(next.provider);
      setMacaronKey('');
      toast('Settings saved');
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <section className="view">
        <div className="ti-error">error: {error}</div>
      </section>
    );
  }
  if (!settings) {
    return (
      <section className="view">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="view settings-view">
      <header>
        <h1>Settings</h1>
        <p>Configure the LLM provider Claude Code sessions should route through.</p>
      </header>

      <div className="settings-section">
        <h2 className="sec-title">Provider</h2>
        <div className="settings-providers">
          {PROVIDER_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`settings-provider-card${provider === opt.value ? ' active' : ''}`}
            >
              <input
                type="radio"
                name="provider"
                value={opt.value}
                checked={provider === opt.value}
                onChange={() => setProvider(opt.value)}
              />
              <div>
                <div className="settings-provider-label">{opt.label}</div>
                <div className="settings-provider-sub">{opt.sub}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h2 className="sec-title">Macaron</h2>
        <p className="muted">Endpoint is fixed to Macaron's b200 host. Only the API key is configurable.</p>
        <div className="settings-field">
          <label htmlFor="macaron-base">Endpoint</label>
          <input
            id="macaron-base"
            type="text"
            className="settings-input"
            value={macaron?.base ?? ''}
            readOnly
            disabled
          />
        </div>
        <div className="settings-field">
          <label htmlFor="macaron-model">Model</label>
          <input
            id="macaron-model"
            type="text"
            className="settings-input"
            value={macaron?.model ?? ''}
            readOnly
            disabled
          />
        </div>
        <div className="settings-field">
          <label htmlFor="macaron-key">API key</label>
          <div className="settings-input-row">
            <input
              id="macaron-key"
              type={showKey ? 'text' : 'password'}
              className="settings-input"
              placeholder={macaron?.configured ? '••••••••  (saved — leave blank to keep)' : 'Paste your Macaron API key'}
              value={macaronKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setMacaronKey(e.target.value)}
            />
            <button
              type="button"
              className="ghost small"
              onClick={() => setShowKey((v) => !v)}
              disabled={macaronKey.length === 0 && !macaron?.configured}
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          {macaron?.configured ? (
            <p className="settings-hint ok">Key saved. Leave the field blank to keep the current key.</p>
          ) : (
            <p className="settings-hint">No key on file. Macaron provider will fail until you save one.</p>
          )}
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="primary"
          onClick={save}
          disabled={!dirty || saving || !macaronReady}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {provider === 'macaron' && !macaronReady && (
          <span className="muted">Add a Macaron API key before switching provider.</span>
        )}
      </div>
    </section>
  );
}

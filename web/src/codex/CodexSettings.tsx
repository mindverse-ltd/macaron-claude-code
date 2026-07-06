import { useEffect, useState } from 'react';
import { codexApi, type PublicCodexProvider } from './api';

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const SANDBOX = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const APPROVAL = ['never', 'on-request', 'on-failure', 'untrusted'] as const;
const WIRE = ['responses', 'chat'] as const;

export function CodexSettings() {
  const [p, setP] = useState<PublicCodexProvider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    codexApi.config().then((c) => setP(c.provider)).catch(() => {});
  }, []);

  if (!p) return <div className="cx-settings">Loading…</div>;

  const set = <K extends keyof PublicCodexProvider>(k: K, v: PublicCodexProvider[K]) => {
    setP({ ...p, [k]: v });
  };

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const patch: Partial<PublicCodexProvider> & { apiKey?: string } = {
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        wireApi: p.wireApi,
        modelProvider: p.modelProvider,
        reasoningEffort: p.reasoningEffort,
        sandboxMode: p.sandboxMode,
        approvalPolicy: p.approvalPolicy,
        webSearchEnabled: p.webSearchEnabled,
        contextWindow: p.contextWindow,
        autoCompactTokenLimit: p.autoCompactTokenLimit,
        disableResponseStorage: p.disableResponseStorage,
      };
      if (apiKey) patch.apiKey = apiKey;
      const r = await codexApi.saveConfig(patch);
      setP(r.provider);
      setApiKey('');
      setMsg('Saved.');
    } catch (e) {
      setMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cx-settings">
      <h1>Codex Settings</h1>
      <div className="cx-settings-sub">These map to Codex CLI's config.toml. The runner passes them via <code>--config key=value</code>.</div>

      <div className="cx-settings-section">
        <h2>Provider</h2>
        <div className="cx-field-row">
          <div className="cx-field">
            <label>Name</label>
            <input value={p.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="cx-field">
            <label>Provider ID</label>
            <input value={p.modelProvider} onChange={(e) => set('modelProvider', e.target.value)} />
            <small>Recorded in rollout metadata as `model_provider`.</small>
          </div>
        </div>

        <div className="cx-field">
          <label>Base URL</label>
          <input value={p.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://pi-api-cn.macaron.xin" />
        </div>

        <div className="cx-field">
          <label>API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={p.configured ? '••••••• (leave blank to keep current)' : 'Paste your bearer token'}
          />
        </div>

        <div className="cx-field-row">
          <div className="cx-field">
            <label>Model</label>
            <input value={p.model} onChange={(e) => set('model', e.target.value)} />
          </div>
          <div className="cx-field">
            <label>Wire API</label>
            <select value={p.wireApi} onChange={(e) => set('wireApi', e.target.value as 'responses' | 'chat')}>
              {WIRE.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="cx-settings-section">
        <h2>Agent behavior</h2>
        <div className="cx-field-row">
          <div className="cx-field">
            <label>Reasoning effort</label>
            <select value={p.reasoningEffort} onChange={(e) => set('reasoningEffort', e.target.value as PublicCodexProvider['reasoningEffort'])}>
              {REASONING.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="cx-field">
            <label>Sandbox</label>
            <select value={p.sandboxMode} onChange={(e) => set('sandboxMode', e.target.value as PublicCodexProvider['sandboxMode'])}>
              {SANDBOX.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="cx-field">
            <label>Approval policy</label>
            <select value={p.approvalPolicy} onChange={(e) => set('approvalPolicy', e.target.value as PublicCodexProvider['approvalPolicy'])}>
              {APPROVAL.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>

        <div className="cx-field cx-toggle">
          <input id="cx-web" type="checkbox" checked={p.webSearchEnabled} onChange={(e) => set('webSearchEnabled', e.target.checked)} />
          <label htmlFor="cx-web">Enable web search tool</label>
        </div>
        <div className="cx-field cx-toggle">
          <input id="cx-drs" type="checkbox" checked={p.disableResponseStorage} onChange={(e) => set('disableResponseStorage', e.target.checked)} />
          <label htmlFor="cx-drs">Disable response storage on server</label>
        </div>
      </div>

      <div className="cx-settings-section">
        <h2>Context</h2>
        <div className="cx-field-row">
          <div className="cx-field">
            <label>Context window (tokens)</label>
            <input type="number" value={p.contextWindow} onChange={(e) => set('contextWindow', Number(e.target.value))} />
          </div>
          <div className="cx-field">
            <label>Auto-compact at</label>
            <input type="number" value={p.autoCompactTokenLimit} onChange={(e) => set('autoCompactTokenLimit', Number(e.target.value))} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="cx-save" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {msg && <span style={{ color: 'var(--cx-text-muted)', fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}

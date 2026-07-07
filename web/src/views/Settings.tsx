import { useEffect, useState } from 'react';
import { api, type PublicSettings, type PublicCustomProvider, type ProviderInput } from '../lib/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';

const BLANK_INPUT: ProviderInput = { name: '', endpoint: '', model: '', apiKey: '' };

export function Settings() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [error, setError] = useState('');
  // Editor state — either editing an existing provider (id set) or creating
  // a new one (id === null). null = editor closed.
  const [editing, setEditing] = useState<
    | null
    | { id: string | null; draft: ProviderInput; existingConfigured: boolean }
  >(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => setError((e as Error).message));
  }, []);

  const activate = async (providerId: string) => {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await api.setActiveProvider(providerId));
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () =>
    setEditing({ id: null, draft: { ...BLANK_INPUT }, existingConfigured: false });

  const openEdit = (p: PublicCustomProvider) =>
    setEditing({
      id: p.id,
      draft: { name: p.name, endpoint: p.endpoint, model: p.model, apiKey: '' },
      existingConfigured: p.configured,
    });

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    if (!d.name.trim()) return toast('name is required');
    if (!d.endpoint.trim()) return toast('endpoint is required');
    if (!d.model.trim()) return toast('model is required');
    if (editing.id === null && !d.apiKey?.trim()) return toast('API key is required for a new provider');
    setBusy(true);
    try {
      if (editing.id === null) {
        const r = await api.addProvider({
          name: d.name.trim(),
          endpoint: d.endpoint.trim(),
          model: d.model.trim(),
          apiKey: (d.apiKey || '').trim(),
        });
        setSettings(r.settings);
        toast(`added "${d.name.trim()}"`);
      } else {
        const patch: Partial<ProviderInput> = {
          name: d.name.trim(),
          endpoint: d.endpoint.trim(),
          model: d.model.trim(),
        };
        // Empty key = keep existing on server (matches placeholder text).
        if ((d.apiKey || '').trim().length > 0) patch.apiKey = d.apiKey!.trim();
        setSettings(await api.updateProvider(editing.id, patch));
        toast(`updated "${d.name.trim()}"`);
      }
      setEditing(null);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: PublicCustomProvider) => {
    const ok = await confirm({
      title: 'Delete provider?',
      body: (
        <>
          <code>{p.name}</code>
          <div className="confirm-sub">
            Removes it from <code>~/.claude/macaron-config.json</code>. If it's currently active, the provider falls back to Anthropic default. Cannot be undone.
          </div>
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setSettings(await api.deleteProvider(p.id));
      toast(`deleted "${p.name}"`);
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleYolo = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: 'Enable YOLO mode?',
        body: (
          <>
            <div className="confirm-sub">
              Every SDK subprocess will run with <code>permissionMode: 'bypassPermissions'</code> — <strong>all tool calls auto-approve</strong>, no permission prompts in the WebUI. This applies to every session, regardless of the per-session permission picker.
            </div>
            <div className="confirm-sub">
              Recommended only when you trust the workspace and model. Turn off anytime to restore per-session control.
            </div>
          </>
        ),
        confirmLabel: 'Enable',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      setSettings(await api.setYoloMode(next));
      toast(next ? 'YOLO mode on — all permissions bypassed' : 'YOLO mode off');
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleFollowups = async (next: boolean) => {
    setBusy(true);
    try {
      setSettings(await api.setFollowupSuggestions(next));
      toast(next ? 'follow-up suggestions on' : 'follow-up suggestions off');
    } catch (e) {
      toast(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
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

  const active = settings.activeProviderId;

  return (
    <section className="view settings-view">
      <header>
        <h1>Settings</h1>
        <p>Manage the Anthropic-compatible LLM providers Claude Code sessions can route through. One is active at a time.</p>
      </header>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Providers</h2>
          <button className="primary small" onClick={openCreate} disabled={busy || editing !== null}>
            + Add provider
          </button>
        </div>

        <div className="prov-list">
          {settings.builtins.map((b) => (
            <label
              key={b.id}
              className={`prov-card${active === b.id ? ' active' : ''}`}
            >
              <input
                type="radio"
                name="provider"
                checked={active === b.id}
                onChange={() => activate(b.id)}
                disabled={busy}
              />
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{b.name}</span>
                  <span className="prov-tag">built-in</span>
                  {b.detectedEndpoint && (
                    <span className="prov-tag ok">env override detected</span>
                  )}
                </div>
                <div className="prov-card-sub">{b.description}</div>
                {b.detectedEndpoint && (
                  <div className="prov-card-sub">
                    <code>ANTHROPIC_BASE_URL={b.detectedEndpoint}</code>
                  </div>
                )}
              </div>
            </label>
          ))}

          {settings.customProviders.map((p) => (
            <label
              key={p.id}
              className={`prov-card${active === p.id ? ' active' : ''}`}
            >
              <input
                type="radio"
                name="provider"
                checked={active === p.id}
                onChange={() => p.configured && activate(p.id)}
                disabled={busy || !p.configured}
              />
              <div className="prov-card-body">
                <div className="prov-card-head">
                  <span className="prov-name">{p.name}</span>
                  <span className={`prov-tag ${p.configured ? 'ok' : 'bad'}`}>
                    {p.configured ? 'key saved' : 'no key'}
                  </span>
                </div>
                <div className="prov-card-sub">
                  <code>{p.endpoint}</code>
                  <span className="prov-model">· {p.model}</span>
                </div>
              </div>
              <div className="prov-card-actions">
                <button
                  type="button"
                  className="ghost small"
                  onClick={(e) => { e.preventDefault(); openEdit(p); }}
                  disabled={busy || editing !== null}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost small prov-danger"
                  onClick={(e) => { e.preventDefault(); void remove(p); }}
                  disabled={busy || editing !== null}
                >
                  Delete
                </button>
              </div>
            </label>
          ))}

          {settings.customProviders.length === 0 && (
            <p className="muted" style={{ padding: '10px 4px' }}>
              No custom providers yet. Click "+ Add provider" to add one.
            </p>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Permissions</h2>
        </div>
        <label className={`prov-card yolo-card${settings.yoloMode ? ' active' : ''}`}>
          <input
            type="checkbox"
            checked={settings.yoloMode}
            onChange={(e) => void toggleYolo(e.target.checked)}
            disabled={busy}
          />
          <div className="prov-card-body">
            <div className="prov-card-head">
              <span className="prov-name">YOLO mode</span>
              <span className={`prov-tag ${settings.yoloMode ? 'ok' : 'bad'}`}>
                {settings.yoloMode ? 'on — all tools auto-approve' : 'off'}
              </span>
            </div>
            <div className="prov-card-sub">
              Bypass <code>permissionMode</code> for every session. The SDK launches with <code>--allow-dangerously-skip-permissions</code> + <code>--permission-mode bypassPermissions</code>, so <strong>no tool call will prompt you</strong> — including file edits, shell commands, and <code>render_ui</code>.
            </div>
            <div className="prov-card-sub">
              Off (default): each session's permission picker (<kbd>Shift</kbd>+<kbd>Tab</kbd>) is respected.
            </div>
          </div>
        </label>
      </div>

      <div className="settings-section">
        <div className="settings-row-head">
          <h2 className="sec-title">Suggestions</h2>
        </div>
        <label className={`prov-card${settings.followupSuggestions ? ' active' : ''}`}>
          <input
            type="checkbox"
            checked={settings.followupSuggestions}
            onChange={(e) => void toggleFollowups(e.target.checked)}
            disabled={busy}
          />
          <div className="prov-card-body">
            <div className="prov-card-head">
              <span className="prov-name">Follow-up questions</span>
              <span className={`prov-tag ${settings.followupSuggestions ? 'ok' : 'bad'}`}>
                {settings.followupSuggestions ? 'on' : 'off'}
              </span>
            </div>
            <div className="prov-card-sub">
              After a clean Claude turn, run one extra throwaway model call to suggest next questions. Off by default because it spends tokens.
            </div>
          </div>
        </label>
      </div>

      {editing && (
        <div className="settings-section prov-editor">
          <h2 className="sec-title">
            {editing.id === null ? 'Add provider' : 'Edit provider'}
          </h2>
          <ProviderForm
            draft={editing.draft}
            existingConfigured={editing.existingConfigured}
            isNew={editing.id === null}
            onChange={(patch) =>
              setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))
            }
          />
          <div className="settings-actions">
            <button className="primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : editing.id === null ? 'Create' : 'Save'}
            </button>
            <button className="ghost" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProviderForm({
  draft,
  existingConfigured,
  isNew,
  onChange,
}: {
  draft: ProviderInput;
  existingConfigured: boolean;
  isNew: boolean;
  onChange: (patch: Partial<ProviderInput>) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  return (
    <>
      <div className="settings-field">
        <label htmlFor="p-name">Name</label>
        <input
          id="p-name"
          className="settings-input"
          value={draft.name}
          placeholder="e.g. Macaron, OpenRouter, My server"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>
      <div className="settings-field">
        <label htmlFor="p-endpoint">Endpoint (Anthropic-compatible)</label>
        <input
          id="p-endpoint"
          className="settings-input"
          value={draft.endpoint}
          placeholder="https://…/v1"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => onChange({ endpoint: e.target.value })}
        />
        <p className="settings-hint">Must expose <code>/v1/messages</code>. Claude Code SDK will POST to it.</p>
      </div>
      <div className="settings-field">
        <label htmlFor="p-model">Model</label>
        <input
          id="p-model"
          className="settings-input"
          value={draft.model}
          placeholder="e.g. macaron-0.6, claude-opus-4-7"
          onChange={(e) => onChange({ model: e.target.value })}
        />
      </div>
      <div className="settings-field">
        <label htmlFor="p-key">API key</label>
        <div className="settings-input-row">
          <input
            id="p-key"
            type={showKey ? 'text' : 'password'}
            className="settings-input"
            value={draft.apiKey || ''}
            placeholder={existingConfigured ? '••••••••  (saved — leave blank to keep)' : 'Paste your API key'}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange({ apiKey: e.target.value })}
          />
          <button
            type="button"
            className="ghost small"
            onClick={() => setShowKey((v) => !v)}
            disabled={!draft.apiKey && !existingConfigured}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        {isNew ? (
          <p className="settings-hint">Required.</p>
        ) : existingConfigured ? (
          <p className="settings-hint ok">Key saved. Leave blank to keep the current one.</p>
        ) : (
          <p className="settings-hint">No key on file yet.</p>
        )}
      </div>
    </>
  );
}

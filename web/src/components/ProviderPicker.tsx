// Small provider-selection chip shown in the Session input toolbar. Reads
// the current active provider from /api/settings on mount and PUTs the new
// choice to /api/settings/active when the user picks a different one.
//
// Only "usable" providers appear in the dropdown: the built-in System
// default, plus any custom provider whose key is configured. If the user
// wants to add/edit/delete providers they still go to the Settings page.

import { useEffect, useState } from 'react';
import { api, type PublicSettings } from '../lib/api';
import { useToast } from './Toast';

export function ProviderPicker() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {/* ignore — chip stays disabled */});
  }, []);

  const options: Array<{ id: string; label: string }> = [];
  if (settings) {
    for (const b of settings.builtins) options.push({ id: b.id, label: b.name });
    for (const p of settings.customProviders) {
      if (p.configured) options.push({ id: p.id, label: p.name });
    }
  }

  const activeId = settings?.activeProviderId || '';
  const activeLabel = options.find((o) => o.id === activeId)?.label || '…';

  const onChange = async (id: string) => {
    if (!settings || busy) return;
    const prevId = settings.activeProviderId;
    setSettings({ ...settings, activeProviderId: id });
    setBusy(true);
    try {
      setSettings(await api.setActiveProvider(id));
    } catch (e) {
      setSettings({ ...settings, activeProviderId: prevId });
      toast(`switch failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-chip" title={`Provider · ${activeLabel}`}>
      <svg
        className="provider-chip-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
      <span className="provider-chip-label">{activeLabel}</span>
      <svg
        className="provider-chip-caret"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <select
        className="provider-chip-select"
        value={activeId}
        disabled={!settings || busy}
        onChange={(e) => void onChange(e.target.value)}
        aria-label="Provider"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

import type { Route } from './+types/connect';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { useState, useEffect } from 'react';
import { ArrowRight } from 'lucide-react';
import { baseOptions } from '@/lib/layout.shared';
import { submit, onRestore } from '@/lib/connect-state';

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Connect · Macaron' },
    { name: 'description', content: 'Open a Macaron WebUI running on your machine or behind a public tunnel.' },
  ];
}

export default function Connect() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  // If the browser restores this page from the BFCache after a Back (e.g. the
  // user opened the WebUI then navigated back), wipe any token that the cached
  // DOM would otherwise show.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) { const s = onRestore({ url, token, error }); setUrl(s.url); setToken(s.token); }
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [url, token, error]);

  const go = () => {
    const { state, navigate } = submit(url, token, window.location.origin);
    setUrl(state.url);
    setToken(state.token);
    setError(state.error);
    if (navigate) window.location.assign(navigate); // full navigation to the server's own WebUI — no token kept here
  };

  return (
    <HomeLayout {...baseOptions()}>
      <div className="p-4 flex flex-col items-center justify-center text-center flex-1">
        <div className="w-full max-w-md text-left">
          <h1 className="text-xl font-bold mb-1 text-center">Connect to a Macaron server</h1>
          <p className="text-fd-muted-foreground mb-6 text-center text-sm">
            Start a Macaron server on your machine, then paste its URL here to open its WebUI on this device.
          </p>

          <label className="block text-sm font-medium mb-1">Server URL</label>
          <input
            className="w-full rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm mb-1"
            placeholder="localhost:7878  ·  https://xxxx.trycloudflare.com/?token=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
            autoFocus
          />
          <p className="text-xs text-fd-muted-foreground mb-4">
            Local server defaults: Claude on <code>localhost:7878</code>, Codex on <code>localhost:7979</code>.
          </p>

          <label className="block text-sm font-medium mb-1">Access token <span className="text-fd-muted-foreground font-normal">(optional if the link already has one)</span></label>
          <input
            className="w-full rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm mb-4"
            placeholder="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          />

          {error && <p className="text-sm text-fd-destructive mb-4">{error}</p>}

          <button
            type="button"
            className="w-full inline-flex items-center justify-center gap-2 text-sm bg-fd-primary text-fd-primary-foreground rounded-full font-medium px-4 py-2.5"
            onClick={go}
          >
            Open WebUI <ArrowRight className="size-4" />
          </button>

          <p className="text-xs text-fd-muted-foreground mt-4 text-center">
            This page only redirects to the server you name — your token is never stored here and never leaves your browser except in the link you open.
          </p>
        </div>
      </div>
    </HomeLayout>
  );
}

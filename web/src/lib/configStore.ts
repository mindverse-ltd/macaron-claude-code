// Tiny store that fetches /api/config once at load and exposes the result
// (mainly whether the Macaron API is configured — used by ChatModel picker
// and the top-of-app banner). Falls back to `configured: true` when the fetch
// fails so we don't block Claude features on a transient network hiccup.

import { useEffect, useState } from 'react';
import { api, type ConfigResponse } from './api';

let cached: ConfigResponse['macaron'] | null = null;
let inflight: Promise<ConfigResponse['macaron']> | null = null;
const listeners = new Set<(m: ConfigResponse['macaron']) => void>();

async function load(): Promise<ConfigResponse['macaron']> {
  if (inflight) return inflight;
  inflight = api.config()
    .then((r) => {
      cached = r.macaron;
      listeners.forEach((cb) => cb(cached!));
      return cached!;
    })
    .catch(() => {
      // On transient failure, assume configured so we don't block features.
      cached = { base: '', model: '', configured: true };
      return cached;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useMacaronConfig(): ConfigResponse['macaron'] | null {
  const [state, setState] = useState<ConfigResponse['macaron'] | null>(cached);
  useEffect(() => {
    if (cached) { setState(cached); }
    else { void load().then(setState); }
    const cb = (m: ConfigResponse['macaron']) => setState(m);
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);
  return state;
}

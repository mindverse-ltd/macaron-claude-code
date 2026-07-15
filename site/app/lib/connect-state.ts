// The Connect page's state transitions, factored out of the React component so
// they can be unit-tested directly (reject, success-navigation, BFCache restore,
// and the no-navigation guarantee on any rejection). The component is a thin
// shell that renders this state and performs the one side effect — navigation.
import { buildTarget } from './connect-target';
import { stripToken } from './strip-token';

export type ConnectState = { url: string; token: string; error: string };

// The result of pressing "Open WebUI": the next input state, plus a `navigate`
// target that is set ONLY on success. On any rejection `navigate` is undefined
// (no navigation happens) and the token is scrubbed from both fields.
export type SubmitResult = { state: ConnectState; navigate?: string };

export function submit(url: string, token: string, selfOrigin: string): SubmitResult {
  const r = buildTarget(url, token, selfOrigin);
  if ('error' in r) {
    // Rejected: never navigate, and never leave the secret in a visible input.
    return { state: { url: stripToken(url), token: '', error: r.error } };
  }
  return { state: { url: stripToken(url), token: '', error: '' }, navigate: r.href };
}

// What the inputs become when the page is restored from the BFCache after a Back.
export function onRestore(state: ConnectState): ConnectState {
  return { url: stripToken(state.url), token: '', error: state.error };
}

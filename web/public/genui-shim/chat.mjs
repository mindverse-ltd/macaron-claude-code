// $macaron/chat shim — lets a sandboxed render_ui widget post a message back into
// the chat, as if the user typed it (driving the next assistant turn). Mirrors
// macaron-genui-demo's $macaron/chat / sendUserMessage. The host registers a
// dispatcher on globalThis['$macaron/chat'] (see Session.tsx); the preview
// renders inline (not an iframe) so it shares globalThis with the host. No active
// bridge = no-op + warn, matching display-only widget semantics.
const dispatch = (payload) => {
  const bridge = globalThis['$macaron/chat'];
  if (!bridge) { console.warn('[genui-shim/chat] no active chat bridge; message dropped'); return; }
  bridge(payload);
};

export function sendUserMessage(input) {
  if (typeof input === 'string') return dispatch({ text: input });
  if (input && typeof input === 'object' && typeof input.text === 'string') return dispatch({ text: input.text, data: input.data });
  throw new TypeError('sendUserMessage expects a string or { text, data? }');
}

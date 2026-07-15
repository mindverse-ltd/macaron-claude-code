// Remove EVERY `token` query param from what the user pasted, so a rejected or
// completed attempt never leaves the secret visible in the URL input. Falls
// back to string surgery when the value isn't a parseable URL (e.g. a bare host
// or a malformed `:bad` port) — that path must still strip all occurrences.
export function stripToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed);
  try {
    const u = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (!u.searchParams.has('token')) return raw;
    u.searchParams.delete('token'); // removes all occurrences
    return hasScheme ? u.toString() : u.toString().replace(/^https:\/\//, '');
  } catch {
    // Split off the query, drop every token=... pair, reattach what's left.
    const hash = trimmed.indexOf('#');
    const head = hash === -1 ? trimmed : trimmed.slice(0, hash);
    const frag = hash === -1 ? '' : trimmed.slice(hash);
    const q = head.indexOf('?');
    if (q === -1) return trimmed;
    const pairs = head.slice(q + 1).split('&').filter((p) => p && !/^token=/i.test(p));
    return head.slice(0, q) + (pairs.length ? '?' + pairs.join('&') : '') + frag;
  }
}

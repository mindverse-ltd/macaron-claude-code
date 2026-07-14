// Normalize a pasted tunnel URL (+ optional token) into a safe same-origin
// jump target `<https-origin>/?token=<t>`. This is the whole security surface
// of the connector, so it fails closed: only a scheme-less input is assumed
// https, any explicit non-https scheme or userinfo is rejected, and the path
// is always forced to root so a token can never ride along to an unexpected
// host or path. See MAC-8578 / EVE's review on PR #144.

export type BuildResult = { href: string } | { error: string };

// Matches a leading URI scheme per RFC 3986 (`scheme ":"`). If present we parse
// as-is and validate; only when it's absent do we assume https and prepend it —
// so `ftp://x` is rejected as non-https, not silently turned into a bare host.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function buildTarget(rawUrl: string, rawToken: string): BuildResult {
  const input = rawUrl.trim();
  if (!input) return { error: 'Paste the tunnel URL first.' };

  let parsed: URL;
  try {
    parsed = new URL(HAS_SCHEME.test(input) ? input : `https://${input}`);
  } catch {
    return { error: 'That does not look like a valid URL.' };
  }

  if (parsed.protocol !== 'https:') return { error: 'Use the https:// tunnel URL — an access token over http is unsafe.' };
  if (parsed.username || parsed.password) return { error: 'Remove the user:pass@ part from the URL.' };

  // A token typed into the field wins; otherwise keep one already in the URL.
  const token = rawToken.trim() || parsed.searchParams.get('token') || '';
  // Force root: origin drops any pathname/query/hash, so the token can only
  // land on `<origin>/`, never a deeper path or a different host.
  const base = new URL('/', parsed.origin);
  if (token) base.searchParams.set('token', token);
  return { href: base.toString() };
}

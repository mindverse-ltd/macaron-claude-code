import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTarget } from './connect-target.ts';

// Table-driven coverage of every normalization branch EVE flagged on PR #144:
// bare host, https + path/query/hash, http, other schemes, userinfo, token in
// URL vs field override, and token encoding.
const cases: Array<{ name: string; url: string; token: string; expect: { href: string } | { error: true } }> = [
  { name: 'bare host + field token', url: 'x.trycloudflare.com', token: 'tok9', expect: { href: 'https://x.trycloudflare.com/?token=tok9' } },
  { name: 'bare host, no token', url: 'x.trycloudflare.com', token: '', expect: { href: 'https://x.trycloudflare.com/' } },
  { name: 'https root + url token kept', url: 'https://x.trycloudflare.com/?token=abc123', token: '', expect: { href: 'https://x.trycloudflare.com/?token=abc123' } },
  { name: 'https + deep path is forced to root', url: 'https://tunnel.test/deep/path?token=url-token', token: '', expect: { href: 'https://tunnel.test/?token=url-token' } },
  { name: 'https + path + hash dropped', url: 'https://tunnel.test/a/b#frag', token: 'k', expect: { href: 'https://tunnel.test/?token=k' } },
  { name: 'field token overrides url token', url: 'https://x.test/?token=inurl', token: 'field-wins', expect: { href: 'https://x.test/?token=field-wins' } },
  { name: 'token is url-encoded', url: 'https://x.test/', token: 'a b/c+d', expect: { href: 'https://x.test/?token=a+b%2Fc%2Bd' } },
  { name: 'http is rejected', url: 'http://x.test/?token=abc', token: '', expect: { error: true } },
  { name: 'ftp scheme is rejected (not treated as bare host)', url: 'ftp://tunnel.test/share?token=url-token', token: '', expect: { error: true } },
  { name: 'ws scheme is rejected', url: 'ws://tunnel.test/', token: '', expect: { error: true } },
  { name: 'userinfo is rejected', url: 'https://user:pass@tunnel.test/path?token=url-token', token: '', expect: { error: true } },
  { name: 'username-only is rejected', url: 'https://user@tunnel.test/', token: '', expect: { error: true } },
  { name: 'empty input is rejected', url: '', token: '', expect: { error: true } },
  { name: 'whitespace-only input is rejected', url: '   ', token: '', expect: { error: true } },
  { name: 'garbage is rejected', url: 'not a url ::::', token: 'x', expect: { error: true } },
];

for (const c of cases) {
  test(c.name, () => {
    const r = buildTarget(c.url, c.token);
    if ('error' in c.expect) {
      assert.ok('error' in r, `expected an error for ${JSON.stringify(c.url)}, got ${JSON.stringify(r)}`);
    } else {
      assert.deepEqual(r, c.expect);
    }
  });
}

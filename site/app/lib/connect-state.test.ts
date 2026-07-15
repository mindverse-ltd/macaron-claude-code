import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submit, onRestore } from './connect-state.ts';

const SELF = 'https://docs.example.com';

// These lock the route/component-layer behavior EVE asked for beyond the pure
// buildTarget negatives: reject (no navigation, token scrubbed), success
// (navigation + token scrubbed from inputs), BFCache restore, and the
// no-navigation guarantee on every rejection path.

test('reject: never navigates and scrubs the token from both fields', () => {
  const r = submit('http://127.attacker.invalid:7878/?token=EVE_BYPASS', 'EVE_FIELD', SELF);
  assert.equal(r.navigate, undefined);            // NO navigation
  assert.equal(r.state.token, '');                // field token gone
  assert.ok(!/token=/i.test(r.state.url));        // url token stripped
  assert.ok(!r.state.url.includes('EVE_BYPASS'));
  assert.ok(r.state.error.length > 0);
});

test('reject: self-origin (with trailing dot) does not navigate', () => {
  const r = submit('https://docs.example.com./?token=EVE_SELF_DOT', 'EVE_FIELD', SELF);
  assert.equal(r.navigate, undefined);
  assert.equal(r.state.token, '');
  assert.ok(!r.state.url.includes('EVE_SELF_DOT'));
});

test('reject: malformed URL with duplicate tokens scrubs all of them', () => {
  const r = submit('http://public.example:bad/?token=EVE_DUP_FIRST&token=EVE_DUP_SECOND', '', SELF);
  assert.equal(r.navigate, undefined);
  assert.ok(!/token=/i.test(r.state.url));
  assert.ok(!r.state.url.includes('EVE_DUP_SECOND'));
});

test('success: navigates to the built href and clears the inputs', () => {
  const r = submit('localhost:7878', 'field-tok', SELF);
  assert.equal(r.navigate, 'http://localhost:7878/?token=field-tok');
  assert.equal(r.state.token, '');                // no token left in the field
  assert.equal(r.state.error, '');
});

test('success: url-token is honored and scrubbed from the visible input', () => {
  const r = submit('https://tunnel.test/?token=url-tok', '', SELF);
  assert.equal(r.navigate, 'https://tunnel.test/?token=url-tok');
  assert.ok(!/token=/i.test(r.state.url));        // input no longer shows the token
});

test('BFCache restore: strips url token and clears the field token', () => {
  const s = onRestore({ url: 'https://tunnel.test/?token=EVE_BACK', token: 'EVE_FIELD', error: '' });
  assert.ok(!/token=/i.test(s.url));
  assert.equal(s.token, '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { structure } from 'fumadocs-core/mdx-plugins/remark-structure';
import { initAdvancedSearch } from 'fumadocs-core/search/server';
import { buildIndex, sanitizeSearchText } from './search-index';

// Unit: the sanitizer strips markdown/entity artifacts WITHOUT mangling
// technical identifiers. The old regex stack turned `MACARON_CODEX_TRANSPORT`
// into `MACARONCODEXTRANSPORT` by treating intraword `_` as emphasis — the mdast
// pass must not.
test('sanitizeSearchText strips markup but preserves identifiers', () => {
  assert.equal(sanitizeSearchText('`mcx` is not a fork'), 'mcx is not a fork');
  assert.equal(sanitizeSearchText('published as **mcc** (the launcher)'), 'published as mcc (the launcher)');
  assert.equal(sanitizeSearchText('mcx&#x60; and &#x2A;*mcc*&#x2A;'), 'mcx and mcc');
  assert.equal(sanitizeSearchText('see [Usage](/docs/usage) now'), 'see Usage now');
  assert.equal(sanitizeSearchText('a &amp; b &lt; c'), 'a & b < c');
  // Underscored identifiers survive byte-for-byte (regression for the P1 leak).
  for (const id of ['MACARON_CODEX_TRANSPORT', 'MACARON_AUTH_TOKEN', 'permission_request', 'SEARCH_HL_OPEN', 'codex_approval_request']) {
    assert.equal(sanitizeSearchText(id), id, `identifier ${id} must survive sanitizing`);
    assert.equal(sanitizeSearchText(`sets \`${id}\` at boot`), `sets ${id} at boot`);
  }
  // Serialized MDX flow-component tags are removed, not left as searchable text.
  assert.equal(sanitizeSearchText('App shell. </Step> </Steps>'), 'App shell.');
  assert.equal(sanitizeSearchText('\\<Tabs items=\\{[1]}> <Tab value="x">'), '');
  // A `>` inside an attribute value or JSX expression must not end the tag early
  // — the old `/<[^>]*>/` regex left `B">` / `b"]}>` residue behind.
  assert.equal(sanitizeSearchText('Body <Callout title="A > B">inner</Callout> tail'), 'Body inner tail');
  assert.equal(sanitizeSearchText('<Tabs items={["a > b"]}>content</Tabs>'), 'content');
  // A bare `<` in prose (not a tag open) is left intact.
  assert.equal(sanitizeSearchText('when c < d holds'), 'when c < d holds');
});

const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../content/docs');

function mdxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return mdxFiles(full);
    return e.name.endsWith('.mdx') ? [full] : [];
  });
}

// Build the SAME index the production /api/search route builds: feed each real
// MDX file through structure() (fumadocs' extractor) + the production buildIndex,
// then hand the records to Orama via initAdvancedSearch — the exact engine
// createFromSource() uses. `source` itself can't load here (it relies on Vite's
// import.meta.glob), so we reconstruct page-shaped inputs and drive buildIndex
// directly. This exercises the real sanitizer→Orama wiring, not just the string.
async function productionSearch() {
  const pages = mdxFiles(DOCS_DIR).map((file) => {
    const structuredData = structure(readFileSync(file, 'utf8'));
    const url = '/' + path.relative(DOCS_DIR, file).replace(/\.mdx$/, '');
    return { url, data: { title: url, description: undefined, structuredData } };
  });
  const indexes = await Promise.all(pages.map((p) => buildIndex(p as Parameters<typeof buildIndex>[0])));
  return initAdvancedSearch({ language: 'english', indexes });
}

test('production index: underscored identifiers stay searchable, corrupted forms miss', async () => {
  const server = await productionSearch();

  // Real Orama queries: the true identifier hits, the underscore-stripped
  // corruption the old sanitizer produced returns nothing.
  for (const id of ['MACARON_CODEX_TRANSPORT', 'MACARON_AUTH_TOKEN', 'MACARON_ENGINE', 'permission_request']) {
    const hits = await server.search(id);
    assert.ok(hits.length > 0, `query "${id}" should hit the production index`);
    const corrupted = await server.search(id.replace(/_/g, ''));
    assert.equal(corrupted.length, 0, `corrupted "${id.replace(/_/g, '')}" must not hit`);
  }
});

test('production index: result summaries carry no markup', async () => {
  const server = await productionSearch();

  // Every returned summary must be clean prose — no backticks, no HTML entities,
  // no serialized MDX/JSX tags. (Orama's own <mark> highlight is added at query
  // time and is not doc content, so exclude it before scanning.)
  const leaky = /`|&#x?[0-9a-fA-F]+;|<\/?[A-Za-z][^>]*>/;
  for (const q of ['MACARON_CODEX_TRANSPORT', 'permission_request', 'render_ui', 'relay', 'launcher']) {
    for (const r of await server.search(q)) {
      const summary = (r.content ?? '').replace(/<\/?mark>/g, '');
      assert.ok(!leaky.test(summary), `summary for "${q}" leaked markup: ${summary.slice(0, 100)}`);
    }
  }
});

// Tag-shaped queries — the agreed semantics. Orama tokenizes on word boundaries
// and drops punctuation, so a query like `</Step>` reduces to the natural word
// "step" and CAN match prose that legitimately says "step". The guarantee is NOT
// "a tag-shaped query returns zero results" (unenforceable, and undesirable — the
// word "step" is real content); it is that the *serialized tag itself never
// entered the index*: no result summary contains the literal tag markup, and the
// tag as a contiguous token is absent.
test('production index: serialized MDX tags never enter the index', async () => {
  const server = await productionSearch();

  for (const tag of ['</Step>', '</Steps>', '<Tabs', '</Tab>', '<Callout', '<TypeTable']) {
    for (const r of await server.search(tag)) {
      const summary = r.content ?? '';
      assert.ok(!summary.includes(tag), `result for "${tag}" contains the literal tag: ${summary.slice(0, 100)}`);
      assert.ok(!/<\/?[A-Za-z][^>]*>/.test(summary.replace(/<\/?mark>/g, '')), `result for "${tag}" contains tag markup`);
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { structure } from 'fumadocs-core/mdx-plugins/remark-structure';
import { initAdvancedSearch } from 'fumadocs-core/search/server';
import { oramaStaticClient } from 'fumadocs-core/search/client/orama-static';
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
  // structure() serializes a component tag with markdown escapes (`\<Tabs …>`);
  // the tag (and its attribute expression) is stripped, body text kept.
  assert.equal(sanitizeSearchText('\\<Tabs items=\\{[1]}> a</Tabs>'), 'a');

  // Adversarial cases (EVE, round 4) — the scanner must confirm a complete, legal
  // tag before deleting, and honour escaped quotes, entities, template literals,
  // HTML/MDX comments and fragments:
  // A `>` inside an attribute value or a JSX expression must not end the tag early
  // (the old `/<[^>]*>/` regex left `B">` / `b"]}>` behind).
  assert.equal(sanitizeSearchText('Body <Callout title="A > B">inner</Callout> tail'), 'Body inner tail');
  assert.equal(sanitizeSearchText('<Tabs items={["a > b"]}>content</Tabs>'), 'content');
  // Entity-escaped quote inside an attribute, and a `}`/`>` inside a template
  // literal expression — attribute residue must not leak into the body text.
  assert.equal(sanitizeSearchText('<Callout title="A &quot; > B">quoteneedle</Callout>'), 'quoteneedle');
  assert.equal(sanitizeSearchText('<X value={`a } > b`}>templateneedle</X>'), 'templateneedle');
  // HTML comment, MDX expression comment, and fragment shorthand.
  assert.equal(sanitizeSearchText('before <!-- secret --> visible'), 'before visible');
  assert.equal(sanitizeSearchText('{/* hidden */}shown'), 'shown');
  assert.equal(sanitizeSearchText('<>content</>'), 'content');
  // Compact comparisons and a code-span TypeScript generic must stay searchable —
  // a bare `<`/`>` with no complete tag is NOT markup.
  assert.equal(sanitizeSearchText('when c < d holds'), 'when c < d holds');
  assert.equal(sanitizeSearchText('when alpha<beta remains searchable'), 'when alpha<beta remains searchable');
  assert.equal(sanitizeSearchText('when a<b && c>d holds'), 'when a<b && c>d holds');
  assert.equal(sanitizeSearchText('returns `<T>(value)` => value'), 'returns <T>(value) => value');
});

// EVE round 5 — the adversarial cases must run through the SAME path production
// does: raw MDX → structure() → sanitize. Fumadocs splits a flow component around
// any nested heading, so the sanitizer sees standalone opening/closing RESIDUE
// chunks (`\<Tabs items=\{[…]}>`, a lone `</Tabs>`, a `<>`/`</>` fragment boundary)
// that are not valid MDX on their own — exactly what a hand-fed complete
// `<X>…</X>` string never exercises. Each raw sample below is chosen so structure()
// emits such a residue; the guarantee is that no needle-adjacent markup survives.
test('real structure() split chunks: residue never leaks, prose survives', () => {
  const clean = (raw: string) => structure(raw).contents.map((c) => sanitizeSearchText(c.content));

  // A template literal in a `<Tabs items={…}>` attribute, split off as its own
  // opening-tag chunk by the nested heading. The old CommonMark fallback dropped
  // the backticks before the scanner ran, so `LEAKNEEDLE, c]}>` leaked.
  const tabs = clean('<Tabs items={[`a } > LEAKNEEDLE`, `c`]}>\n\n## Sub heading\n\nbodytext\n\n</Tabs>');
  assert.ok(!tabs.some((t) => /LEAKNEEDLE|]}>|<Tabs/.test(t)), `tabs residue leaked: ${JSON.stringify(tabs)}`);
  assert.ok(tabs.includes('bodytext'), 'tabs body text must survive');

  // A fragment `<>`/`</>` boundary split around a heading — the opener/closer are
  // pure markup and must not surface, but the body between them stays.
  const frag = clean('<>\n\n## Inner\n\nvisiblebody\n\n</>');
  assert.ok(!frag.some((t) => /<>|<\/>|<\/?[A-Za-z]/.test(t)), `fragment markup leaked: ${JSON.stringify(frag)}`);
  assert.ok(frag.includes('visiblebody'), 'fragment body must survive');

  // A NUMERIC quote entity inside a JSX attribute (`&#34;` / `&#x22;`). Decoding it
  // pre-scan (as the old code did for all numeric entities) ended the attribute
  // early and leaked `B">numericneedle`; it must stay encoded until after the tag.
  for (const ent of ['&#34;', '&#x22;']) {
    const callout = clean(`<Callout title="A ${ent} > B">numericneedle</Callout>`);
    assert.ok(!callout.some((t) => /B">|<Callout|&#/.test(t)), `numeric quote leaked (${ent}): ${JSON.stringify(callout)}`);
    assert.ok(callout.includes('numericneedle'), `callout body must survive (${ent})`);
  }

  // structure() escapes prose punctuation it must protect: `\<T>` (a generic) and
  // `\{name\}` are escaped LITERALS, not components. The old global
  // unescapeJsxPunctuation turned `\<T>` into a tag and deleted it — the visible
  // text must survive with the `<`/`{` intact.
  assert.deepEqual(clean('returns \\<T>(value) => value'), ['returns <T>(value) => value']);
  assert.deepEqual(clean('literal \\{name\\}'), ['literal {name}']);
});

// EVE round 6 — escaped-quote / template edge cases via real structure() split
// chunks, plus boundary fidelity the earlier rounds missed.
test('real structure() split chunks: escaped quotes, generic defaults, OOB entities', () => {
  const clean = (raw: string) => structure(raw).contents.map((c) => sanitizeSearchText(c.content));

  // A backslash-escaped backtick inside the template, and a backslash-escaped quote
  // inside the JS expression string: the quote/template state machine must treat `\`
  // as an escape and not end the string early, so the whole `<Tabs …>` opener
  // residue (lossily serialized by structure()) is removed, needle and all.
  const esc1 = clean('<Tabs items={[`a \\` } > ESCAPEDLEAK`, `c`]}>\n\n## H\n\nbody\n\n</Tabs>');
  assert.ok(!esc1.some((t) => /ESCAPEDLEAK|]}>|<Tabs/.test(t)), `escaped-backtick residue leaked: ${JSON.stringify(esc1)}`);
  assert.ok(esc1.includes('body'), 'escaped-backtick body must survive');
  const esc2 = clean('<Tabs items={["a \\" > ESCAPEQUOTE", "c"]}>\n\n## H\n\nbody\n\n</Tabs>');
  assert.ok(!esc2.some((t) => /ESCAPEQUOTE|]}>|<Tabs/.test(t)), `escaped-quote residue leaked: ${JSON.stringify(esc2)}`);
  assert.ok(esc2.includes('body'), 'escaped-quote body must survive');

  // A TypeScript generic with a DEFAULT type: the `=` is a type-param default, NOT
  // a JSX attribute — an attribute name is a separate identifier after whitespace
  // (`<Tabs items=`), whereas `<T =` sits right on the tag/param name. Every default
  // form must survive verbatim: bare word, quoted string, object, and template
  // literal (EVE round 7's three build-time samples + the round-6 bare word).
  assert.deepEqual(clean('type Box\\<T = string> keeps VALUE'), ['type Box<T = string> keeps VALUE']);
  assert.deepEqual(clean('type Box\\<T = "DEFAULTNEEDLE"> keeps VALUE'), ['type Box<T = "DEFAULTNEEDLE"> keeps VALUE']);
  assert.deepEqual(clean('type Box\\<T = { x: string }> keeps OBJNEEDLE'), ['type Box<T = { x: string }> keeps OBJNEEDLE']);
  // The template-literal default's backticks are stripped as code-span punctuation,
  // but the type text (and searchable needle) must remain.
  const tpl = clean('type Box\\<T = `x`> keeps TPLNEEDLE');
  assert.ok(tpl.every((t) => /T = x> keeps TPLNEEDLE/.test(t)) && !tpl.some((t) => /<Box|]}>/.test(t)), `template default mangled: ${JSON.stringify(tpl)}`);

  // Compound (multi-param) and constrained generics: a top-level `,` or an `extends`
  // clause marks a TYPE PARAMETER LIST, so its `=` are default-type assignments, NOT
  // JSX attributes — every needle must survive and stay searchable.
  assert.deepEqual(clean('type Pair\\<T = string, U = "MULTIPARAMDEFAULTNEEDLE"> keeps MULTIPROSEKEEP'), ['type Pair<T = string, U = "MULTIPARAMDEFAULTNEEDLE"> keeps MULTIPROSEKEEP']);
  assert.deepEqual(clean('type Box\\<T extends Foo = "CONSTRAINTDEFAULTNEEDLE"> keeps CONSTRAINTPROSEKEEP'), ['type Box<T extends Foo = "CONSTRAINTDEFAULTNEEDLE"> keeps CONSTRAINTPROSEKEEP']);

  // A spread JSX attribute (`{...x}`) is unmistakably a component even without a
  // `name=` — its split opener residue must be stripped, not left as searchable markup.
  const spread = clean('<Panel {...SPREADATTRNEEDLE}>\n\n## H\n\nbodytext\n\n</Panel>');
  assert.ok(!spread.some((t) => /SPREADATTRNEEDLE|<Panel|\.\.\./.test(t)), `spread opener residue leaked: ${JSON.stringify(spread)}`);
  assert.ok(spread.includes('bodytext'), 'spread component body must survive');

  // A spread attribute with whitespace inside the braces (`{ ...x }`) is still a
  // spread — the residue must be stripped, not left searchable.
  const spreadWs = clean('<Panel { ...SPREADSPACENEEDLE }>\n\n## H\n\nspacebody\n\n</Panel>');
  assert.ok(!spreadWs.some((t) => /SPREADSPACENEEDLE|<Panel|\.\.\./.test(t)), `whitespace-spread residue leaked: ${JSON.stringify(spreadWs)}`);
  assert.ok(spreadWs.includes('spacebody'), 'whitespace-spread body must survive');

  // A JSX prop literally NAMED `extends` must still strip as a component (its `={…}`
  // is a real attribute), NOT be mistaken for a generic `extends` constraint.
  const extendsProp = clean('<Panel extends={["EXTENDSATTRNEEDLE", "x"]}>\n\n## H\n\nextbody\n\n</Panel>');
  assert.ok(!extendsProp.some((t) => /EXTENDSATTRNEEDLE|<Panel|extends=/.test(t)), `extends-prop opener leaked: ${JSON.stringify(extendsProp)}`);
  assert.ok(extendsProp.includes('extbody'), 'extends-prop body must survive');

  // TypeScript type-param modifiers (`const` / `out` / `in`) with a default type: the
  // modifier sits between `<` and the param name, so the `=` is still a default, not a
  // JSX attribute — the whole generic must survive verbatim and stay searchable.
  assert.deepEqual(clean('function f\\<const T = "CONSTDEFAULTNEEDLE">() keeps CONSTPROSEKEEP'), ['function f<const T = "CONSTDEFAULTNEEDLE">() keeps CONSTPROSEKEEP']);
  assert.deepEqual(clean('type Producer\\<out T = "OUTDEFAULTNEEDLE"> keeps OUTPROSEKEEP'), ['type Producer<out T = "OUTDEFAULTNEEDLE"> keeps OUTPROSEKEEP']);
  assert.deepEqual(clean('type Consumer\\<in T = "INDEFAULTNEEDLE"> keeps INPROSEKEEP'), ['type Consumer<in T = "INDEFAULTNEEDLE"> keeps INPROSEKEEP']);

  // Whitespace between tag tokens includes NEWLINES, not just space/tab: a spread or an
  // attribute broken across lines is still a component opener and must be stripped.
  const nlSpread = clean('<Panel {\n  ...NLSPREADNEEDLE\n}>\n\n## H\n\nnlbody\n\n</Panel>');
  assert.ok(!nlSpread.some((t) => /NLSPREADNEEDLE|<Panel/.test(t)), `newline-spread residue leaked: ${JSON.stringify(nlSpread)}`);
  assert.ok(nlSpread.includes('nlbody'), 'newline-spread body must survive');
  const nlAttr = clean('<Panel\n  title={"EXTNLNEEDLE"}>\n\n## H\n\nattrnlbody\n\n</Panel>');
  assert.ok(!nlAttr.some((t) => /EXTNLNEEDLE|<Panel/.test(t)), `newline-attr residue leaked: ${JSON.stringify(nlAttr)}`);
  assert.ok(nlAttr.includes('attrnlbody'), 'newline-attr body must survive');

  // Boolean `extends` prop (no `=`) is still a JSX attribute, so the opener is a
  // component — not a generic constraint. The whole opener must be stripped.
  const boolExt = clean('<Panel extends config={{ key: "BOOLEXTNEEDLE" }}>\n\n## H\n\nboolbody\n\n</Panel>');
  assert.ok(!boolExt.some((t) => /BOOLEXTNEEDLE|<Panel|extends/.test(t)), `boolean-extends opener leaked: ${JSON.stringify(boolExt)}`);
  assert.ok(boolExt.includes('boolbody'), 'boolean-extends body must survive');

  // A lowercase JSX element whose NAME happens to be `out`/`in`/`const` (a real DOM-ish
  // tag) with an attribute is a component — the tag name is glued to `<` but the `<` is
  // NOT preceded by an identifier, so it strips. The needle must not enter the index.
  for (const [tag, needle] of [['out', 'OUTTAGNEEDLE'], ['in', 'INTAGNEEDLE'], ['const', 'CONSTTAGNEEDLE']]) {
    const lc = clean(`<${tag} T={["${needle}"]}>\n\n## H\n\n${tag}body\n\n</${tag}>`);
    assert.ok(!lc.some((t) => new RegExp(`${needle}|<${tag}`).test(t)), `lowercase <${tag}> opener leaked: ${JSON.stringify(lc)}`);
    assert.ok(lc.includes(`${tag}body`), `lowercase <${tag}> body must survive`);
  }

  // A namespaced JSX attribute (`ns:prop={…}`) is a real attribute — the opener strips.
  const nsAttr = clean('<Panel ns:prop={["NSNEEDLE"]}>\n\n## H\n\nnsbody\n\n</Panel>');
  assert.ok(!nsAttr.some((t) => /NSNEEDLE|<Panel|ns:prop/.test(t)), `namespaced-attr opener leaked: ${JSON.stringify(nsAttr)}`);
  assert.ok(nsAttr.includes('nsbody'), 'namespaced-attr body must survive');

  // An out-of-range numeric entity is not a real code point: String.fromCodePoint
  // would throw and abort the index build, so it must be kept as literal text.
  assert.deepEqual(clean('literal \\&#9999999999; KEEP'), ['literal &#9999999999; KEEP']);

  // An HTML-comment LITERAL inside a code span is visible content, not markup — the
  // comment strip must be code-span aware and leave it intact.
  assert.deepEqual(clean('show `<!-- KEEPNEEDLE -->` tail'), ['show <!-- KEEPNEEDLE --> tail']);
  // A real HTML comment OUTSIDE code is still dropped.
  assert.deepEqual(clean('before <!-- secret --> visible'), ['before visible']);
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

// True route-level wiring: load the BUILT `/api/search` artifact (produced by
// routes/search.ts → createFromSource(source, { buildIndex }) → server.staticGET)
// and query it through fumadocs' own client, oramaStaticClient — the exact code
// path the browser search box uses. This is the end-to-end check the earlier
// rounds lacked: delete the buildIndex wiring in routes/search.ts, or let the
// sanitizer regress, and this test fails because the served database changes.
// Skips (does not fail) when the site hasn't been built yet — `pnpm build` runs
// before it in verify/CI.
const BUILT_INDEX = path.resolve(DOCS_DIR, '../../build/client/api/search');

test('built /api/search: real Orama client honours the contract', async (t) => {
  if (!existsSync(BUILT_INDEX)) {
    // Under the repo build→test chain (`pnpm verify`, which builds first) a missing
    // artifact is a HARD failure — that is the route-wiring regression gate. A bare
    // `pnpm test` with no prior build still skips, so local unit runs stay cheap.
    if (process.env.REQUIRE_BUILT_INDEX) assert.fail('REQUIRE_BUILT_INDEX set but build/client/api/search is missing — `/api/search` route or its buildIndex wiring did not emit the static index');
    t.skip('run `pnpm build` (or `pnpm verify`) first — no build/client/api/search to load');
    return;
  }
  const exported = readFileSync(BUILT_INDEX, 'utf8');
  // oramaStaticClient fetches `${from}` and load()s it into Orama; shim fetch to
  // serve the on-disk artifact so no dev server is needed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('/api/search') ? new Response(exported, { headers: { 'content-type': 'application/json' } }) : realFetch(url as never)) as typeof fetch;
  try {
    const client = oramaStaticClient({ from: 'http://test.local/api/search' });

    for (const id of ['MACARON_CODEX_TRANSPORT', 'MACARON_AUTH_TOKEN', 'permission_request']) {
      const hits = await client.search(id);
      assert.ok(Array.isArray(hits) && hits.length > 0, `built index: "${id}" should hit`);
      const corrupted = await client.search(id.replace(/_/g, ''));
      assert.ok(Array.isArray(corrupted) && corrupted.length === 0, `built index: corrupted "${id.replace(/_/g, '')}" must miss`);
      for (const r of hits) {
        const summary = (r.content ?? '').replace(/<\/?mark>/g, '');
        assert.ok(!/`|&#x?[0-9a-fA-F]+;|<\/?[A-Za-z][^>]*>/.test(summary), `built index summary leaked markup: ${summary.slice(0, 100)}`);
      }
    }
    // Tag-shaped query: may match the natural word ("step"), but no served summary
    // ever contains the literal serialized tag.
    for (const tag of ['</Step>', '<Tabs', '<Callout']) {
      for (const r of await client.search(tag)) {
        assert.ok(!(r.content ?? '').includes(tag), `built index: result for "${tag}" contains the literal tag`);
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

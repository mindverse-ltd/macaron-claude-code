import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { structure } from 'fumadocs-core/mdx-plugins/remark-structure';
import { initAdvancedSearch } from 'fumadocs-core/search/server';
import { oramaStaticClient } from 'fumadocs-core/search/client/orama-static';
import { buildIndex, sanitizeSearchText, pairResidues } from './search-index';

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
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

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
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

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

  // Non-glued TS generics and comparisons — the `<` follows whitespace, `>`, `)` or
  // chunk start, so a glued/non-glued heuristic would wrongly strip them. The real
  // TypeScript grammar keeps every one verbatim and searchable:
  //   - an arrow-function type-param list with a default,
  //   - a call-site type-argument list,
  //   - a chained comparison, and
  //   - a `$`-suffixed / non-ASCII identifier default.
  assert.deepEqual(clean('const identity = \\<T, U = "ARROWNEEDLE">(x) => x keeps ARROWPROSEKEEP'), ['const identity = <T, U = "ARROWNEEDLE">(x) => x keeps ARROWPROSEKEEP']);
  assert.deepEqual(clean('factory()\\<T, CALLNEEDLE>() keeps CALLPROSEKEEP'), ['factory()<T, CALLNEEDLE>() keeps CALLPROSEKEEP']);
  assert.deepEqual(clean('alpha \\<beta && gamma> delta keeps CMPPROSEKEEP'), ['alpha <beta && gamma> delta keeps CMPPROSEKEEP']);
  assert.deepEqual(clean('type $Box\\<T$ = "DOLLARNEEDLE"> keeps DOLLARPROSEKEEP'), ['type $Box<T$ = "DOLLARNEEDLE"> keeps DOLLARPROSEKEEP']);

  // A COMPLETE JSX element sitting flush against surrounding prose (`prefix<Panel …>body
  // </Panel>suffix`) — structure() serializes it as a glued escaped opener. The opener +
  // its attribute must not enter the index; the prose and the component body survive.
  const glued = clean('prefix<Panel items={["ADJACENTNEEDLE"]}>bodyX</Panel>suffix');
  assert.ok(!glued.some((t) => /ADJACENTNEEDLE|<Panel|items=/.test(t)), `glued JSX opener leaked: ${JSON.stringify(glued)}`);
  assert.ok(glued.some((t) => /prefix/.test(t) && /suffix/.test(t) && /bodyX/.test(t)), `glued JSX prose/body must survive: ${JSON.stringify(glued)}`);

  // A multiline JSX element whose terminating `>` sits ALONE on its own line: structure()
  // splits it into an unclosed opener chunk, a lone `>` chunk, and the body. The opener
  // residue (attribute needle) must never reach the index; the body must survive.
  const mlGt = clean('<Panel\n  items={["MLGTNEEDLE"]}\n>\n\nmlgtbody\n\n</Panel>');
  assert.ok(!mlGt.some((t) => /MLGTNEEDLE|<Panel|items=/.test(t)), `multiline gt-own-line opener leaked: ${JSON.stringify(mlGt)}`);
  assert.ok(mlGt.includes('mlgtbody'), 'multiline gt-own-line body must survive');

  // Round 12 — the TS oracle must accept type-ARGUMENTS and comparison expressions, not
  // just type-PARAMETER lists: `keyof` / qualified names in call type args, an `instanceof`
  // relational compare, and a standalone whole-chunk generic. None may lose its needle.
  assert.deepEqual(clean('factory()<keyof KEYOFARGNEEDLE>() keeps KEYOFKEEP'), ['factory()<keyof KEYOFARGNEEDLE>() keeps KEYOFKEEP']);
  assert.deepEqual(clean('factory()<ns.QUALIFIEDARGNEEDLE>() keeps QUALKEEP'), ['factory()<ns.QUALIFIEDARGNEEDLE>() keeps QUALKEEP']);
  assert.deepEqual(clean('alpha<beta instanceof COMPARISONNEEDLE>delta keeps CMPNEEDLE'), ['alpha<beta instanceof COMPARISONNEEDLE>delta keeps CMPNEEDLE']);
  assert.deepEqual(clean('<T, U = "STANDALONEGENERICNEEDLE">'), ['<T, U = "STANDALONEGENERICNEEDLE">']);
  // A compact `alpha<needle remains body` — the old unclosed-esc fallback swallowed the tail.
  assert.deepEqual(clean('when alpha<COMPACTLESSNEEDLE remains COMPACTBODY'), ['when alpha<COMPACTLESSNEEDLE remains COMPACTBODY']);

  // A lowercase modifier tag (`out` / `in` / `const`) is BOTH a valid TS type-param list and
  // a valid JSX element; the `attr={…}` disambiguator must strip it as component residue.
  for (const tag of ['out', 'in', 'const']) {
    const needle = `${tag.toUpperCase()}TAGNEEDLE`;
    const lc = clean(`<${tag} T={["${needle}"]}>\n\n## H\n\n${tag}body\n\n</${tag}>`);
    assert.ok(!lc.some((t) => new RegExp(`${needle}|<${tag}`).test(t)), `lowercase <${tag}> opener leaked: ${JSON.stringify(lc)}`);
    assert.ok(lc.includes(`${tag}body`), `<${tag}> body must survive: ${JSON.stringify(lc)}`);
  }

  // JSX names / attributes with `_`, `$` or a non-ASCII letter (structure() escapes a
  // leading `_` as `\_`): the opener + attr must be stripped, the component body survives.
  for (const [tag, needle] of [['$Panel', 'DOLLARTAGLEAK'], ['_Panel', 'USTAGLEAK'], ['ÉPanel', 'UNITAGLEAK']]) {
    const t = clean(`<${tag} x={["${needle}"]}>\n\n## H\n\n${needle}body\n\n</${tag}>`);
    assert.ok(!t.some((s) => new RegExp(`${needle}"|<.?${tag.replace('$', '\\$')}`).test(s)), `unicode/underscore tag leaked: ${JSON.stringify(t)}`);
    assert.ok(t.some((s) => s.includes(`${needle}body`)), `body must survive: ${JSON.stringify(t)}`);
  }
  // A glued JSX opener with an underscored attribute name — the attr must not leak, prose survives.
  const usAttr = clean('pre<Panel _private={["USATTRLEAK"]}>gbody</Panel>suf');
  assert.ok(!usAttr.some((t) => /USATTRLEAK|_private=/.test(t)), `underscore-attr opener leaked: ${JSON.stringify(usAttr)}`);
  assert.ok(usAttr.some((t) => /pre/.test(t) && /gbody/.test(t) && /suf/.test(t)), `underscore-attr prose/body must survive: ${JSON.stringify(usAttr)}`);
  // A lossy template/quote attribute opener with a VISIBLE body+suffix: the body and suffix
  // must survive (the old `!closed && esc` rule swallowed everything to end-of-chunk).
  const lossy = clean('prefix<Panel title={`a "b" c`}>visiblebody</Panel>suffix');
  assert.ok(!lossy.some((t) => /<Panel|title=/.test(t)), `lossy opener leaked: ${JSON.stringify(lossy)}`);
  assert.ok(lossy.some((t) => /prefix/.test(t) && /visiblebody/.test(t) && /suffix/.test(t)), `lossy body/suffix must survive: ${JSON.stringify(lossy)}`);

  // An out-of-range numeric entity is not a real code point: String.fromCodePoint
  // would throw and abort the index build, so it must be kept as literal text.
  assert.deepEqual(clean('literal \\&#9999999999; KEEP'), ['literal &#9999999999; KEEP']);

  // An HTML-comment LITERAL inside a code span is visible content, not markup — the
  // comment strip must be code-span aware and leave it intact.
  assert.deepEqual(clean('show `<!-- KEEPNEEDLE -->` tail'), ['show <!-- KEEPNEEDLE --> tail']);
  // A real HTML comment OUTSIDE code is still dropped.
  assert.deepEqual(clean('before <!-- secret --> visible'), ['before visible']);
});

// EVE round 13 — re-converge the JSX/TS decision on a cross-chunk signal instead of a
// per-chunk oracle union. structure() emits a closing residue for every real flow component
// but never for a TS generic, so positional residue pairing (pairResidues) is the authority
// that separates genuinely-ambiguous openers (`<out disabled>` component vs `<out T = "x">`
// generic) that BOTH grammars accept. Each raw sample is fed through real structure() with the
// page-wide paired-position set, exactly as buildIndex does.
test('real structure() cross-chunk closer pairing: lossy openers, ambiguous keywords, own-line >', () => {
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

  // Blocker 1 — a glued opener whose attribute holds an escaped quote / escaped template
  // backtick is serialized lossily by structure() (the `\` is dropped), desyncing the quote
  // scan. The attribute needle must miss, but the VISIBLE body and the suffix must survive.
  const lossyQuote = clean('prefix<Panel title="a \\" b">visiblebodyA</Panel>suffixA');
  assert.ok(!lossyQuote.some((t) => /<Panel|title=/.test(t)), `lossy-quote opener leaked: ${JSON.stringify(lossyQuote)}`);
  assert.ok(lossyQuote.some((t) => /prefix/.test(t) && /visiblebodyA/.test(t) && /suffixA/.test(t)), `lossy-quote body/suffix must survive: ${JSON.stringify(lossyQuote)}`);
  const lossyTpl = clean('prefix<Panel title={`a \\` b`}>visiblebodyB</Panel>suffixB');
  assert.ok(!lossyTpl.some((t) => /<Panel|title=/.test(t)), `lossy-template opener leaked: ${JSON.stringify(lossyTpl)}`);
  assert.ok(lossyTpl.some((t) => /prefix/.test(t) && /visiblebodyB/.test(t) && /suffixB/.test(t)), `lossy-template body/suffix must survive: ${JSON.stringify(lossyTpl)}`);

  // Blocker 2 — ambiguous keyword/qualified openers that BOTH grammars accept. Each has a
  // real `</Name>` closer in the page, so cross-chunk pairing strips it as a component; the
  // attribute needle must not enter the index, the body survives.
  for (const [open, close, needle, body] of [
    ['<out disabled>', '</out>', 'OUTDISABLEDNEEDLE', 'outbodyX'],
    ['<in title="INTITLENEEDLE">', '</in>', 'INTITLENEEDLE', 'inbodyX'],
    ['<Panel instanceof={["PANELINSTNEEDLE"]}>', '</Panel>', 'PANELINSTNEEDLE', 'instbodyX'],
    ['<ns.Qualified prop={["NSQUALNEEDLE"]}>', '</ns.Qualified>', 'NSQUALNEEDLE', 'qualbodyX'],
  ] as const) {
    const r = clean(`${open}\n\n## H ${needle === 'OUTDISABLEDNEEDLE' ? '' : needle}\n\n${body}\n\n${close}`);
    assert.ok(!r.some((t) => new RegExp(`${needle}|instanceof=|ns\\.Qualified`).test(t)), `ambiguous opener ${open} leaked: ${JSON.stringify(r)}`);
    assert.ok(r.some((t) => t.includes(body)), `ambiguous opener ${open} body must survive: ${JSON.stringify(r)}`);
  }
  // A whole-chunk `<const dataÉ="x">` (Unicode attribute name, no page closer): grammatically
  // this is a VALID TS variance/modifier generic — identical in shape to `<const T = "x">` —
  // so no grammar oracle can tell it apart from prose. Deleting a real generic is the worse
  // failure, so it is KEPT searchable rather than stripped as a speculative component.
  const constUni = clean('<const dataÉ="CONSTUNINEEDLE">\n\n## H\n\nconstunibody\n\n</const>');
  assert.ok(constUni.some((t) => /CONSTUNINEEDLE/.test(t)), `const-unicode generic must stay searchable: ${JSON.stringify(constUni)}`);
  assert.ok(constUni.some((t) => t.includes('constunibody')), `const-unicode body must survive: ${JSON.stringify(constUni)}`);

  // Blocker 2 reverse — a genuinely-VALID no-space generic default (`<in T = "…">`) has NO
  // page closer, is not JSX-valid-only, and is prose: the needle must stay searchable.
  assert.deepEqual(clean('type Consumer\\<in T = "INGENERICMISS"> keeps INGENERICKEEP'), ['type Consumer<in T = "INGENERICMISS"> keeps INGENERICKEEP']);

  // Blocker 3 — an own-line `>` split opener with a STRING / BOOLEAN attribute (not just an
  // expression/spread body) must still be recognized and its residue stripped.
  const ownLineString = clean('<Panel title="OWNLINESTRNEEDLE"\n>\n\nownlinestrbody\n\n</Panel>');
  assert.ok(!ownLineString.some((t) => /OWNLINESTRNEEDLE|<Panel|title=/.test(t)), `own-line string opener leaked: ${JSON.stringify(ownLineString)}`);
  assert.ok(ownLineString.includes('ownlinestrbody'), `own-line string body must survive: ${JSON.stringify(ownLineString)}`);
  const ownLineBool = clean('<Panel disabled\n>\n\nownlineboolbody\n\n</Panel>');
  assert.ok(!ownLineBool.some((t) => /<Panel|disabled/.test(t)), `own-line boolean opener leaked: ${JSON.stringify(ownLineBool)}`);
  assert.ok(ownLineBool.includes('ownlineboolbody'), `own-line boolean body must survive: ${JSON.stringify(ownLineBool)}`);

  // Blocker 4 — no-attribute paired tags whose NAME starts with `$` / `_` / a non-ASCII
  // letter (including `µ`, outside the old `À-￿` range) are components, paired by a page
  // closer. The literal opener must not enter the index; the body survives.
  for (const [tag, body] of [['$Panel', 'dollarpairbody'], ['_Panel', 'uspairbody'], ['ÉPanel', 'unipairbody'], ['µPanel', 'mupairbody']] as const) {
    const r = clean(`<${tag}>\n\n## H\n\n${body}\n\n</${tag}>`);
    assert.ok(!r.some((s) => new RegExp(`<${tag.replace('$', '\\$')}`).test(s)), `no-attr paired <${tag}> leaked: ${JSON.stringify(r)}`);
    assert.ok(r.some((s) => s.includes(body)), `no-attr paired <${tag}> body must survive: ${JSON.stringify(r)}`);
  }
});

// EVE round 14 — real-chain reproductions the page-level closer-NAME set (round 13) got wrong.
// The pairing is now POSITIONAL, hierarchy- and code-span-aware, name scanning is by Unicode
// code point (astral + namespaced), and the whole-chunk `standalone` tie-break is gone.
test('real structure() positional pairing: lossy > recovery, code-span closers, prose generics, astral names', () => {
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

  // Blocker 1 — an escaped-quote / template attribute that itself CONTAINS a `>`: the scan must
  // not treat that inner `>` as the tag end. Glued opener → body + suffix survive; chunk-start
  // opener → whole opener (and its needle) dropped, the body survives.
  const gq = clean('prefix<Panel title="a \\" > b QUOTEATTRNEEDLE">visiblebodyA</Panel>suffixA');
  assert.ok(!gq.some((t) => /QUOTEATTRNEEDLE|<Panel|title=/.test(t)), `glued quote>-attr leaked: ${JSON.stringify(gq)}`);
  assert.ok(gq.some((t) => /prefix/.test(t) && /visiblebodyA/.test(t) && /suffixA/.test(t)), `glued quote>-attr body/suffix lost: ${JSON.stringify(gq)}`);
  const gt = clean('prefix<Panel title={`a } > b TPLATTRNEEDLE`}>visiblebodyB</Panel>suffixB');
  assert.ok(!gt.some((t) => /TPLATTRNEEDLE|<Panel|title=/.test(t)), `glued template>-attr leaked: ${JSON.stringify(gt)}`);
  assert.ok(gt.some((t) => /prefix/.test(t) && /visiblebodyB/.test(t) && /suffixB/.test(t)), `glued template>-attr body/suffix lost: ${JSON.stringify(gt)}`);
  const cs = clean('<Panel title="a \\" > b CSNEEDLE">\n\n## H\n\ncsbody\n\n</Panel>');
  assert.ok(!cs.some((t) => /CSNEEDLE|<Panel|title=/.test(t)), `chunk-start quote>-attr leaked: ${JSON.stringify(cs)}`);
  assert.ok(cs.includes('csbody'), `chunk-start quote>-attr body lost: ${JSON.stringify(cs)}`);

  // Blocker 2 — a code-span `` `</T>` `` literal in one chunk must NOT pair off (and delete) a
  // real `<T, U = …>` generic / inline `<in>…</in>` prose in another section.
  assert.ok(clean('`</T>`\n\n## H\n\ntype X\\<T, U="CODECLOSERNEEDLE"> here').some((t) => t.includes('CODECLOSERNEEDLE')), 'code-span closer wrongly deleted a real generic');
  assert.ok(clean('a <in>x</in> b\n\n## H\n\ntype P\\<in T="INLINEINNEEDLE"> here').some((t) => t.includes('INLINEINNEEDLE')), 'inline <in> pairing wrongly deleted a cross-section modifier generic');

  // Blocker 3 — a whole-chunk prose generic with a modifier default (`out`/`in`/`const`) must
  // NOT be deleted by any standalone tie-break — the needle stays searchable.
  assert.deepEqual(clean('type Producer\\<out T = "OUTWHOLENEEDLE">'), ['type Producer<out T = "OUTWHOLENEEDLE">']);
  assert.deepEqual(clean('type Consumer\\<in T = "INWHOLENEEDLE">'), ['type Consumer<in T = "INWHOLENEEDLE">']);
  assert.deepEqual(clean('function f\\<const T = "CONSTWHOLENEEDLE">'), ['function f<const T = "CONSTWHOLENEEDLE">']);

  // Blocker 4 — astral (`𐐀`, a surrogate pair) and namespaced (`ns:tag`) paired tags: the name
  // scan must read whole code points and include `:`, so opener/attr/closer are all removed.
  const astral = clean('<𐐀Panel x={["ASTRALNEEDLE"]}>\n\n## H\n\nastralbody\n\n</𐐀Panel>');
  assert.ok(!astral.some((t) => /ASTRALNEEDLE|𐐀Panel/.test(t)), `astral tag leaked: ${JSON.stringify(astral)}`);
  assert.ok(astral.includes('astralbody'), `astral body lost: ${JSON.stringify(astral)}`);
  const nsColon = clean('<ns:tag x={["NSCOLONNEEDLE"]}>\n\n## H\n\nnscolonbody\n\n</ns:tag>');
  assert.ok(!nsColon.some((t) => /NSCOLONNEEDLE|ns:tag/.test(t)), `namespaced-colon tag leaked: ${JSON.stringify(nsColon)}`);
  assert.ok(nsColon.includes('nscolonbody'), `namespaced-colon body lost: ${JSON.stringify(nsColon)}`);

  // Positional hierarchy — a same-name nested split (`<AoutÉ>…<BinÉ>…</BinÉ>…</AoutÉ>`) pairs by
  // nesting depth, so both openers' attribute needles are stripped and both bodies survive.
  const nested = clean('<AoutÉ x={["OUTERN"]}>\n\n## H\n\n<BinÉ y={["INNERN"]}>\n\n### H2\n\ninnerbody\n\n</BinÉ>\n\nmidbody\n\n</AoutÉ>');
  assert.ok(!nested.some((t) => /OUTERN|INNERN|AoutÉ|BinÉ/.test(t)), `nested residue leaked: ${JSON.stringify(nested)}`);
  assert.ok(nested.some((t) => t.includes('innerbody')) && nested.some((t) => t.includes('midbody')), `nested bodies lost: ${JSON.stringify(nested)}`);
});

// EVE round 15 — the exact real-chain counterexamples that survived round 14: a lossy
// `>`-inside-`{…}` recovery that cut inside the attribute, a same-name inner generic in a
// component body that the pairing stack mispaired, and a bare `<out/in/const T="x">` generic
// wrongly emptied by the standalone `hasAttrShape` strip. Each is fed through real structure().
test('real structure() round-15: lossy-expression recovery, same-name inner generic, bare modifier generics', () => {
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

  // Blocker 1 — the lossy `>` lives INSIDE an `items={[…]}` expression: recovery must find the
  // real tag end at brace-depth 0, not the `>` hiding in the attribute. A paired chunk-start
  // opener, a glued chunk-start opener, and a template variant all keep body/suffix, drop needle.
  const e1p = clean('<Tabs items={["a \\" > LOSSYQUOTEATTRNEEDLE", "c"]}>\n\n## H\n\nbodyE1\n\n</Tabs>');
  assert.ok(!e1p.some((t) => /LOSSYQUOTEATTRNEEDLE|items=|<Tabs/.test(t)), `lossy-expr paired leaked: ${JSON.stringify(e1p)}`);
  assert.ok(e1p.includes('bodyE1'), `lossy-expr paired body lost: ${JSON.stringify(e1p)}`);
  const e1g = clean('prefix <Tabs items={["a \\" > CHUNKSTARTNEEDLE"]}>visbody</Tabs>suf');
  assert.ok(!e1g.some((t) => /CHUNKSTARTNEEDLE|items=|<Tabs/.test(t)), `lossy-expr glued leaked: ${JSON.stringify(e1g)}`);
  assert.ok(e1g.some((t) => /prefix/.test(t) && /visbody/.test(t) && /suf/.test(t)), `lossy-expr glued body/suffix lost: ${JSON.stringify(e1g)}`);
  const e1t = clean('<Tabs items={[`a \\` > TPLLEAKNEEDLE`, `c`]}>\n\n## H\n\nbodyTPL\n\n</Tabs>');
  assert.ok(!e1t.some((t) => /TPLLEAKNEEDLE|items=|<Tabs/.test(t)), `lossy-expr template leaked: ${JSON.stringify(e1t)}`);
  assert.ok(e1t.includes('bodyTPL'), `lossy-expr template body lost: ${JSON.stringify(e1t)}`);

  // Blocker 2 — a component body contains a SAME-NAME generic type-argument list
  // (`factory()\<𐐀Panel, INNER>()`). The pairing stack must not treat `<Name, …>` (a top-level
  // `,` right after the name = a TS type-arg list) as an opener, or the outer `</Name>` pops the
  // inner generic and deletes it. The inner needle stays searchable; the outer opener strips.
  for (const [name, outer, inner] of [
    ['𐐀Panel', 'OUTERE2', 'INNERGENERIC'],
    ['$Panel', 'OUTDOLLAR', 'INNERDOLLAR'],
    ['_Panel', 'OUTUS', 'INNERUS'],
    ['ns.Qualified', 'OUTNSQ', 'INNERNSQ'],
  ] as const) {
    const r = clean(`<${name} x={["${outer}"]}>\n\n## H\n\nfactory()\\<${name}, ${inner}>()\n\n</${name}>`);
    assert.ok(!r.some((t) => t.includes(outer)), `inner-generic ${name}: outer opener leaked: ${JSON.stringify(r)}`);
    assert.ok(r.some((t) => t.includes(inner)), `inner-generic ${name}: inner generic wrongly deleted: ${JSON.stringify(r)}`);
    assert.ok(r.some((t) => t.includes('factory')), `inner-generic ${name}: body prose lost: ${JSON.stringify(r)}`);
  }

  // Blocker 3 — a bare `<out/in/const T="x">` (no-space attribute form) is a VALID TS
  // variance/modifier generic, not a component: it must stay searchable even standalone. The
  // grammatically-identical `<const dataÉ="x">` is likewise kept (a real generic must never be
  // deleted on speculation), which the round-14 test wrongly asserted the other way.
  assert.deepEqual(clean('\\<out T="OUTNOSPACE">'), ['<out T="OUTNOSPACE">']);
  assert.deepEqual(clean('\\<in T="INNOSPACE">'), ['<in T="INNOSPACE">']);
  assert.deepEqual(clean('\\<const T="CONSTNOSPACE">'), ['<const T="CONSTNOSPACE">']);
  assert.ok(clean('lead\n\n## H\n\n\\<out T="WHOLEOUTNOSPACE">').some((t) => t.includes('WHOLEOUTNOSPACE')), 'whole-chunk bare out-generic wrongly deleted');
});

// EVE round 16 — the pairing exemption and the lossy `>`-recovery must key on SYNTACTIC ROLE, not
// on a name-comma special case. Two real-chain P1s:
//  G1 — any same-name TS construct GLUED inside a component's body (a bare type argument
//       `seed()\<Name>()`, a constrained generic `\<Name extends …>`, a comparison `a\<Name`, a
//       nested first-param `\<Name\<U>>`) must NOT enter the pairing stack, or the outer `</Name>`
//       pops the in-body generic instead of the real opener → the generic is deleted and the outer
//       markup leaks. The round-15 fix only exempted a name-followed-by-comma (`<Name, U>`).
//  G2 — the lossy `>`-recovery brace/bracket depth must ignore brackets inside the corrupted
//       attribute string: a string-internal `}]` must not drop depth to 0 at a `>` still inside the
//       attribute (attribute residue would leak as fake suffix). A cross-chunk paired opener whose
//       corrupted attribute hides such a `}]` is stripped whole, not cut at scanTag's false `>`.
test('real structure() round-16: syntactic-role pairing exemption, string-aware lossy recovery', () => {
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

  // G1 — every same-name in-body generic role, across the names structure() can't consume so it
  // emits opener/closer residue (`$Panel`, `_Panel`, astral `𐐀Panel`). The inner needle stays
  // searchable, the outer opener attribute (`OUT`) never leaks, and the body prose survives.
  for (const name of ['$Panel', '_Panel', '𐐀Panel'] as const) {
    const forms = [
      { role: 'bare', body: `seed${name}NEEDLE()\\<${name}>()`, needle: `seed${name}NEEDLE` },
      { role: 'constrained', body: `seed()\\<${name} extends ${name}CONSTR>()`, needle: `${name}CONSTR` },
      { role: 'comparison', body: `if (${name}COMP\\<${name}) run()`, needle: `${name}COMP` },
      { role: 'nested-first-param', body: `seed()\\<${name}\\<${name}NEST>>()`, needle: `${name}NEST` },
    ];
    for (const { role, body, needle } of forms) {
      const r = clean(`<${name} x={["OUT${name}"]}>\n\n## H\n\n${body}\n\n</${name}>`);
      assert.ok(r.some((t) => t.includes(needle)), `${role} ${name}: in-body generic wrongly deleted: ${JSON.stringify(r)}`);
      assert.ok(!r.some((t) => t.includes(`OUT${name}`)), `${role} ${name}: outer opener attribute leaked: ${JSON.stringify(r)}`);
    }
  }

  // A real inline component GLUED to prose in ONE chunk (`prefix<Panel …>body</Panel>suffix`) still
  // pairs and strips — its own closer sits in the same chunk, so it is not mistaken for an in-body
  // generic. Its lossy attribute (dropped `\` on the escaped quote) must not leak.
  const inline = clean('prefix<Panel title="a \\" INLINELEAK">inlinebody</Panel>suffix');
  assert.ok(!inline.some((t) => /INLINELEAK|title=|<Panel/.test(t)), `inline component leaked: ${JSON.stringify(inline)}`);
  assert.ok(inline.some((t) => /prefix/.test(t) && /inlinebody/.test(t) && /suffix/.test(t)), `inline component body/suffix lost: ${JSON.stringify(inline)}`);

  // G2 — a cross-chunk paired opener whose corrupted `items={[…]}` attribute hides a string-internal
  // `}]` (which naively drops scanTag's depth to 0 at a `>` still inside the string). The whole
  // opener chunk is stripped, so no attribute residue (`STRLEAK`) leaks as fake suffix; body survives.
  const g2q = clean('<$Panel items={["a \\" }] > STRLEAK"]}>\n\n## H\n\nbodyG2q\n\n</$Panel>');
  assert.ok(!g2q.some((t) => /STRLEAK|items=|<\$Panel/.test(t)), `G2 quote residue leaked: ${JSON.stringify(g2q)}`);
  assert.ok(g2q.includes('bodyG2q'), `G2 quote body lost: ${JSON.stringify(g2q)}`);
  const g2t = clean('<$Panel a={`x \\` }] > TPLLEAK`}>\n\n## H\n\nbodyG2t\n\n</$Panel>');
  assert.ok(!g2t.some((t) => /TPLLEAK|a={|<\$Panel/.test(t)), `G2 template residue leaked: ${JSON.stringify(g2t)}`);
  assert.ok(g2t.includes('bodyG2t'), `G2 template body lost: ${JSON.stringify(g2t)}`);
});

// EVE round 17 — two residual P1s the round-16 fixes did not cover, plus her positive/negative
// bracket matrix:
//  P1 — a GLUED custom-name inline component (`prefix<$Panel>body</$Panel>suffix`) is serialized by
//       structure() as two escaped tags in ONE chunk; the round-16 `inBodyGeneric` guard wrongly
//       filtered the escaped CLOSING tag too (a closer never has a further closer after it), so the
//       opener never popped, `pairResidues` returned {}, and the literal `<$Panel>` / attribute
//       reached Orama. Reproduces for `$`, `_`, astral, and namespaced names (each escaped
//       differently by structure() — `\_Panel`, astral surrogate pair, `ns.Qualified`).
//  P1 — the round-16 bracket-pollution fix only handled STANDALONE / cross-chunk openers; a GLUED
//       inline lossy opener still leaked. structure() escapes every OPENING bracket (`\{`, `\[`) —
//       string-content ones included — but leaves closes bare, so the depth scan is fooled: an
//       unbalanced `}]` / `]}` / `}}` / `]]` in the corrupted attribute string cuts EARLY (attr
//       residue leaks as fake suffix) and an unbalanced `{ [` / `[ {` / `{{` / `[[` cuts NEVER
//       (body + suffix swallowed). Anchoring on the in-chunk `</Name>` (escape-free) fixes both
//       directions and keeps the visible body/suffix.
test('real structure() round-17: glued custom-name pairing, glued inline bracket matrix', () => {
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

  // P1 #1 — glued custom-name inline component pairs and strips: markup gone, body/suffix kept, and a
  // string attribute needle does not leak. Across the names structure() escapes distinctly.
  for (const name of ['$Panel', '_Panel', '𐐀Panel', 'ns.Qualified'] as const) {
    const tag = name.replace('.', '');
    const bare = clean(`prefix<${name}>VIS${tag}BODY</${name}>suffix`);
    assert.ok(bare.some((t) => t.includes(`VIS${tag}BODY`) && /prefix/.test(t) && /suffix/.test(t)), `glued ${name}: body/suffix lost: ${JSON.stringify(bare)}`);
    assert.ok(!bare.some((t) => /[<>]/.test(t)), `glued ${name}: markup leaked: ${JSON.stringify(bare)}`);
    const attr = clean(`prefix<${name} title="LEAK${tag}ATTR">bd${tag}</${name}>suffix`);
    assert.ok(!attr.some((t) => new RegExp(`LEAK${tag}ATTR|title=|<${name.replace('.', '\\.').replace('$', '\\$')}`).test(t)), `glued-attr ${name}: opener/attr leaked: ${JSON.stringify(attr)}`);
    assert.ok(attr.some((t) => t.includes(`bd${tag}`) && /prefix/.test(t) && /suffix/.test(t)), `glued-attr ${name}: body/suffix lost: ${JSON.stringify(attr)}`);
  }

  // P1 #2 — glued inline lossy opener with EVE's bracket matrix. Closes-heavy sets (`}]`, `]}`, `}}`,
  // `]]`) must not leak the attribute residue as fake suffix; opens-heavy sets (`{ [`, `[ {`, `{{`,
  // `[[`) must not swallow the body/suffix. All keep the in-chunk body + suffix, drop the needle. The
  // `]}` case (dropped quote rebalances the consumed span) is recovered by the targeted double-close
  // signature `]}>` — distinct from an honest single body `]>`, so it strips without touching prose.
  for (const b of ['}]', ']}', '}}', ']]']) {
    const needle = `GLUE${b.replace(/}/g, 'C').replace(/]/g, 'S')}`;
    const r = clean(`prefix<Panel items={["a \\" ${b} > ${needle}", "c"]}>BODYX</Panel>SUFFIXX`);
    assert.ok(!r.some((t) => new RegExp(`${needle}|items=|<Panel`).test(t)), `bracket ${b} leaked: ${JSON.stringify(r)}`);
    assert.ok(r.some((t) => /BODYX/.test(t) && /SUFFIXX/.test(t)), `bracket ${b} body/suffix lost: ${JSON.stringify(r)}`);
  }
  for (const b of ['{ [', '[ {', '{{', '[[']) {
    const r = clean(`prefix<Panel items={["a \\" ${b} x", "c"]}>BODYSW</Panel>SUFFIXSW`);
    assert.ok(!r.some((t) => /items=|<Panel/.test(t)), `bracket ${b} residue leaked: ${JSON.stringify(r)}`);
    assert.ok(r.some((t) => /BODYSW/.test(t) && /SUFFIXSW/.test(t)), `bracket ${b} body/suffix swallowed: ${JSON.stringify(r)}`);
  }
  // Template (escaped-backtick) variants of both directions — the lossy backtick desyncs even the
  // code-span skip, so the fix must key on the in-chunk closer, not on pairing.
  const tl = clean('prefix<Tabs items={[`a \\` }] > TPLLEAKG`, `c`]}>visbody</Tabs>suf');
  assert.ok(!tl.some((t) => /TPLLEAKG|items=|<Tabs/.test(t)), `template-leak leaked: ${JSON.stringify(tl)}`);
  assert.ok(tl.some((t) => /visbody/.test(t) && /suf/.test(t)), `template-leak body/suffix lost: ${JSON.stringify(tl)}`);
  const tsw = clean('prefix<Tabs items={[`a \\` { [ x`, `c`]}>visbody</Tabs>suf');
  assert.ok(!tsw.some((t) => /items=|<Tabs/.test(t)), `template-swallow residue leaked: ${JSON.stringify(tsw)}`);
  assert.ok(tsw.some((t) => /visbody/.test(t) && /suf/.test(t)), `template-swallow body/suffix swallowed: ${JSON.stringify(tsw)}`);
});

// EVE round 18 — three residual P1s the round-17 closer-anchor recovery introduced or missed:
//  P1 — the round-17 anchor (last `>` before the in-chunk closer) ran UNCONDITIONALLY on every glued
//       opener, on the false premise that a component's visible body carries no tag punctuation. A
//       legal `<Panel>LEFT > RIGHT</Panel>` (comparison, code span, entity, or a nested inline tag)
//       lost everything before the last body `>`. The anchor must fire ONLY on a CONFIRMED-DESYNC
//       opener: scanTag never closed, or the region between its `>` and the closer is unbalanced.
//  P1 — the anchor's closer search ran on RAW text with a plain `</Name>`, so a custom name structure()
//       escapes per-char (`</\_Panel>`) was never found and the lossy `_`/`$`/astral/namespaced ×
//       bracket-pollution cross matrix leaked/​swallowed. The closer regex must tolerate the escaping.
//  P1 — `inBodyGeneric`'s own-closer probe matched a `</Name>` INSIDE a `` `…` `` code span, so a glued
//       in-body generic (`factory()<$Panel<INNER594>>()` next to `` `</$Panel>` ``) looked like a real
//       inline component, entered the stack, and stole the outer real closer. The probe must skip code.
test('real structure() round-18: desync-gated anchor, custom-name × bracket matrix, code-span fake closer', () => {
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

  // P1 #1 — a glued component whose visible body legitimately contains tag punctuation keeps ALL of it.
  const gt = clean('prefix<Panel>LEFT594 > RIGHT594</Panel>SUF594');
  assert.ok(gt.some((t) => /LEFT594/.test(t) && /RIGHT594/.test(t) && /SUF594/.test(t)), `body-gt lost: ${JSON.stringify(gt)}`);
  const nested = clean('prefix<Panel><Inner>INNER594</Inner>OUTER594</Panel>SUF594');
  assert.ok(nested.some((t) => /INNER594/.test(t) && /OUTER594/.test(t) && /SUF594/.test(t)), `nested lost: ${JSON.stringify(nested)}`);
  assert.ok(!nested.some((t) => /<\/?(Panel|Inner)/.test(t)), `nested markup leaked: ${JSON.stringify(nested)}`);
  const cs = clean('prefix<Panel>`x > y`594 KEEP594</Panel>SUF594');
  assert.ok(cs.some((t) => /KEEP594/.test(t) && /SUF594/.test(t)) && !cs.some((t) => /<Panel>/.test(t)), `codespan-body lost: ${JSON.stringify(cs)}`);

  // P1 #2 — custom name × bracket pollution, both directions, must not leak (closes-heavy) or swallow
  // (opens-heavy). Exercises the escape-tolerant closer search that plain `</Name>` missed. Both `}]`
  // and the span-rebalancing `]}` are covered — the latter by the targeted `]}>` double-close signature.
  for (const name of ['$Panel', '_Panel', '𐐀Panel', 'ns.Qualified'] as const) {
    const tag = name.replace('.', '');
    const opener = `<${name}`;
    for (const b of ['}]', ']}']) {
      const r = clean(`prefix<${name} items={["a \\" ${b} > L${tag}ATTR", "c"]}>B${tag}VIS</${name}>S${tag}SUF`).join(' ');
      assert.ok(!r.includes(`L${tag}ATTR`) && !r.includes('items=') && !r.includes(opener), `${name} ${b} leaked: ${JSON.stringify(r)}`);
      assert.ok(r.includes(`B${tag}VIS`) && r.includes(`S${tag}SUF`), `${name} ${b} body/suffix lost: ${JSON.stringify(r)}`);
    }
    for (const b of ['{ [', '[[']) {
      const r = clean(`prefix<${name} items={["a \\" ${b} x", "c"]}>B${tag}SW</${name}>S${tag}SW`).join(' ');
      assert.ok(!r.includes('items=') && !r.includes(opener), `${name} ${b} residue leaked: ${JSON.stringify(r)}`);
      assert.ok(r.includes(`B${tag}SW`) && r.includes(`S${tag}SW`), `${name} ${b} body/suffix swallowed: ${JSON.stringify(r)}`);
    }
  }

  // P1 #3 — a same-name generic glued in the body, with a code-span fake closer `` `</$Panel>` `` in
  // the SAME chunk, must not disturb pairing: the outer real closer pairs with the outer opener, and
  // the in-body nested generic's text survives.
  const p3 = clean('<$Panel x={["OUT594"]}>\n\n## H\n\nfactory()<$Panel<INNER594>>() and `</$Panel>`\n\n</$Panel>');
  assert.ok(p3.some((t) => /INNER594/.test(t)), `p3 nested generic text lost: ${JSON.stringify(p3)}`);
});

// EVE round 19 — three residual P1s the round-18 fixes mis-handled, all rooted in unreliable heuristics:
//  P1 — round-18's `balancedBody` judged opener desync from WHOLE-BODY quote+bracket balance, which
//       misfires both ways: a visible-body apostrophe (`don't`) reads as an unclosed quote and a clean
//       `<Panel>LEFT don't > RIGHT</Panel>` gets re-anchored (LEFT lost), while a masking body quote can
//       re-balance a genuinely lossy attribute so its residue leaks. Fixed by deciding desync from
//       OPENER-LOCAL signals only — the opener is escaped (`tag.esc`; structure() only corrupts a `{…}`
//       attribute opener) AND scanTag never closed or the post-`>` region is BRACKET-unbalanced (quotes
//       ignored entirely, so a body apostrophe / masking quote can't sway it).
//  P1 — round-18's `inBodyGeneric` treated "no in-chunk closer" as the only generic tell, so a glued
//       generic FOLLOWED by a real same-name inline component in the SAME chunk (`factory()<$Panel<GEN>>()
//       then <$Panel>INNER</$Panel>`) found the inline's closer and got stacked, stealing the outer real
//       closer. Fixed by keying on the unambiguous hierarchy tell: a nested `<` type-argument inside the
//       opener's own tag body marks a generic regardless of any later inline closer.
//  P1 — round-18's code-span skip used `indexOf(fence)`, which is not CommonMark: a `` `…` `` double
//       backtick span with an inner single backtick closed early (real closer leaked, body lost), and an
//       escaped literal backtick (`` \` ``) was read as an unterminated fence that swallowed the real
//       closer after it. Fixed with a CommonMark-correct `codeSpanEnd` (exact-length close; escaped /
//       unterminated run is literal, not a fence) shared by every code-span skip.
test('real structure() round-19: opener-local desync, hierarchy attribution, CommonMark code spans', () => {
  const clean = (raw: string) => {
    const chunks = structure(raw).contents.map((c) => c.content);
    const paired = pairResidues(chunks);
    return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired));
  };

  // P1 #1 — a bare opener's visible body with an apostrophe (false unclosed-quote) keeps ALL its text;
  // a genuinely lossy attribute whose residue a later body quote could "re-balance" still gets stripped.
  const apos = clean("prefix<Panel>LEFT52 don't compare > RIGHT52</Panel>SUF52").join(' ');
  assert.ok(/LEFT52/.test(apos) && /RIGHT52/.test(apos) && /SUF52/.test(apos), `apostrophe body lost: ${apos}`);
  const mask = clean('prefix<Panel items={["a \\" }] > MASKLEAK52", "c"]}>BODY52 " QUOTE52</Panel>SUF52').join(' ');
  assert.ok(!mask.includes('MASKLEAK52') && !mask.includes('items='), `masked attr leaked: ${mask}`);
  assert.ok(/BODY52/.test(mask) && /QUOTE52/.test(mask) && /SUF52/.test(mask), `masked-case body/suffix lost: ${mask}`);

  // P1 #2 — a glued same-name generic FOLLOWED by a real inline component in the same chunk: the generic
  // is attributed by its nested `<` type-arg (not stacked), the inline pairs, and both texts survive.
  for (const name of ['$Panel', '_Panel', '𐐀Panel', 'ns.Qualified'] as const) {
    const tag = name.replace('.', '');
    const r = clean(`<${name} x={["O52"]}>\n\nfactory()<${name}<GEN${tag}52>>() then <${name}>INNER${tag}52</${name}>\n\n</${name}>`).join(' ');
    assert.ok(r.includes(`GEN${tag}52`), `${name}: generic type-arg lost: ${r}`);
    assert.ok(r.includes(`INNER${tag}52`), `${name}: inline body lost: ${r}`);
  }

  // P1 #3 — CommonMark code spans. A double-backtick span with an inner single backtick keeps its full
  // content and does not leak the surrounding tags; an escaped literal backtick is NOT a fence, so the
  // real closer after it is still stripped (bare opener/closer must not survive).
  const db = clean('prefix<$Panel>``ALPHA52 ` > </$Panel> FAKE52`` BODY52</$Panel>SUF52').join(' ');
  assert.ok(/ALPHA52/.test(db) && /BODY52/.test(db) && /SUF52/.test(db), `double-backtick body lost: ${db}`);
  const eb = clean('prefix<$Panel>text \\` > </$Panel> KEEP52</$Panel>SUF52').join(' ');
  assert.ok(/KEEP52/.test(eb) && /SUF52/.test(eb), `escaped-backtick body lost: ${eb}`);
  assert.ok(!/<\/?\$?Panel>/.test(eb), `escaped-backtick left bare tag markup: ${eb}`);
});

// EVE round 21 — the round-20 fixes stood but its tests were invalid: the generics sat inside inline
// code spans (`pairResidues` skips those) and the bare form was `continue`-skipped, so none exercised
// the real pairing path. These drive the ACTUAL structure() → buildIndex() → Orama chain with the
// generic in live prose, assert BOTH directions of the same-name ambiguity, and pin the opener-local
// recovery (honest body kept, lossy attribute dropped) — the exact reproductions from EVE's review.
test('real structure() round-21: hierarchy-decided generics, opener-local recovery, code-span parity', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r21', data: { title: '/r21', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;
  const clean = (raw: string) => { const chunks = structure(raw).contents.map((c) => c.content); const paired = pairResidues(chunks); return chunks.map((c, ci) => sanitizeSearchText(c, ci, paired)); };

  // P1 #1a — a same-name generic PRECEDING a real same-name inline, in live prose (NOT a code span, so
  // pairResidues actually sees it). Hierarchy must keep the generic: positional nearest-pop hands the
  // one closer to the INNER real inline; the leading generic stays. Both identifiers must index.
  for (const decl of ['<$BareGeneric21>', '<$Panel extends CONSTR21>', '<$Panel = DEF21>', '<$Panel, U extends COMPOUND21>']) {
    const tag = decl.match(/[A-Z0-9]+21/)?.[0] ?? 'BareGeneric21';
    const raw = `flow prefix factory()${decl}() then <$Panel>INLINE21${tag}</$Panel> tail`;
    assert.ok((await hits(raw, tag)) > 0, `generic "${tag}" 0-hit (wrongly deleted by inline closer)`);
    assert.ok((await hits(raw, `INLINE21${tag}`)) > 0, `inline body for "${tag}" 0-hit`);
  }

  // P1 #1b — the REVERSE: a real inline JSX component whose `extends`-shaped prop parses as TS must NOT
  // be mistaken for a generic. It has its own same-name closer, so it stacks, pairs, and strips — the
  // literal opener markup must never reach the index (an attribute-value query must miss).
  const revRaw = 'prefix <$Panel extends LEAKPROP21>REALBODY21</$Panel> REALSUF21';
  const rev = clean(revRaw).join(' ');
  assert.ok(!/LEAKPROP21|<\$Panel|extends/.test(rev), `real inline JSX leaked opener markup: ${rev}`);
  assert.ok(/REALBODY21/.test(rev) && /REALSUF21/.test(rev), `real inline body/suffix lost: ${rev}`);
  assert.equal(await hits(revRaw, 'LEAKPROP21'), 0, 'attribute-value query must miss the stripped opener');

  // P1 #2 — recovery is OPENER-LOCAL only. A HONEST opener whose visible body carries `arr[i]>0` (an
  // unbalanced `[` and a stray `>`) must keep its whole body — the old `/[\]}]{1,2}>/` body scan
  // false-fired on `]>` and deleted everything before it. And a genuinely lossy dropped-quote attribute
  // (whose consumed span is bracket-desynced) is still stripped, even with whitespace before the real `>`.
  const honest = 'prefix <Panel mode={{ a: 1 }} title="SAFE21">ATTRLEFT21 arr[i]>0 ATTRRIGHT21</Panel>ATTRSUF21';
  for (const q of ['ATTRLEFT21', 'ATTRRIGHT21', 'ATTRSUF21']) assert.ok((await hits(honest, q)) > 0, `honest body "${q}" 0-hit (false desync)`);
  const lossyWs = clean('p<Panel items={["msk \\" > ATTRLEAKADV21", "c"]}   >BODYW21</Panel>SUFW21').join(' ');
  assert.ok(!/ATTRLEAKADV21|items=/.test(lossyWs), `lossy ws-tag-end attribute leaked: ${lossyWs}`);
  assert.ok(/BODYW21/.test(lossyWs) && /SUFW21/.test(lossyWs), `lossy ws-tag-end body/suffix lost: ${lossyWs}`);

  // P1 #3 — code-span escape by consecutive-backslash PARITY. An EVEN backslash run before a backtick is
  // a real span opener; a constrained generic just before it must survive (the span is verbatim, not a
  // fence that exposes a fake closer). A split closer (`</` + span + `$SplitPanel>`) must not reassemble.
  const even = 'text <$Panel extends EVENSLASHKEEP21> x \\\\`noise </$Panel>` more';
  assert.ok((await hits(even, 'EVENSLASHKEEP21')) > 0, `even-slash: generic 0-hit`);
  const split = 'g <$Panel extends SPLITGENKEEP21> then </`noise`$SplitPanel> tail';
  assert.ok((await hits(split, 'SPLITGENKEEP21')) > 0, `split-closer: generic 0-hit`);
});

// EVE round 22 — the full-chunk-sequence hierarchy the per-chunk `hasCloserLater` proxy missed. Pairing
// now runs a two-level stack (local per-chunk inline, global cross-chunk flow) over the whole ordered
// chunk stream. These drive the real structure() → buildIndex() → Orama chain with EVE's exact reals.
test('real structure() round-22: outer/generic/inline hierarchy, cross-chunk flow, balanced-lossy contract', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r22', data: { title: '/r22', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // P1 #1 — a REAL enclosing same-name flow component (`<$Panel …>…</$Panel>`) whose body holds an
  // in-body generic AND a real same-name inline. The inner inline closer pops the inline; the OUTER
  // closer must pop the OUTER opener (cross-chunk), never the mid-body generic. Both chunk-start and
  // glued generic positions, across all five generic roles — 10 cases, every generic needle must index.
  const forms = {
    bare: '<$Panel>',
    constrained: '<$Panel extends GEN22C>',
    default: '<$Panel = GEN22D>',
    compound: '<$Panel, U extends GEN22P>',
    comparison: 'val <$Panel extends GEN22M>',
  } as const;
  for (const [role, decl] of Object.entries(forms)) {
    const needle = decl.match(/GEN22[A-Z]/)?.[0];
    for (const [pos, body] of [['chunkstart', `${decl}() then <$Panel>INLINE22${role}</$Panel>`], ['glued', `factory()${decl}() then <$Panel>INLINE22${role}</$Panel>`]] as const) {
      const raw = `<$Panel title="OUTER22">\n\n## H22\n\n${body}\n\n</$Panel>`;
      if (needle) assert.ok((await hits(raw, needle)) > 0, `${role}/${pos}: generic "${needle}" 0-hit (outer closer mispaired)`);
      assert.ok((await hits(raw, `INLINE22${role}`)) > 0, `${role}/${pos}: inline body 0-hit`);
      assert.equal(await hits(raw, 'OUTER22'), 0, `${role}/${pos}: outer opener attribute leaked`);
    }
  }

  // P1 #2 — a real flow JSX component whose body carries a heading, so structure() splits it into
  // opener / body / closer chunks. The glued opener sees no closer in ITS chunk but IS paired by its
  // real later-chunk closer (global stack) — never mistaken for a generic. Its attribute must not index.
  const cross = 'prefix <$Panel extends CROSSATTR22>\n\n## Head22\n\nbody22\n\n</$Panel>';
  assert.equal(await hits(cross, 'CROSSATTR22'), 0, 'cross-chunk flow opener attribute leaked (misjudged as generic)');
  assert.ok((await hits(cross, 'body22')) > 0, 'cross-chunk flow body lost');

  // P1 #3 — the restored balanced-lossy `]}` contract: a dropped quote-backslash rebalances the
  // opener-local consumed span, but the leaked attribute's real close doubles onto the tag `>` as `]}>`.
  // The attribute needle must NOT index (markup out), while body/suffix are preserved.
  const lucky = 'prefix<Panel items={["a \\" ]} > LUCKYATTR22", "c"]}>LUCKYBODY22</Panel>LUCKYSUF22';
  assert.equal(await hits(lucky, 'LUCKYATTR22'), 0, 'balanced-lossy ]} attribute leaked into Orama');
  assert.ok((await hits(lucky, 'LUCKYBODY22')) > 0 && (await hits(lucky, 'LUCKYSUF22')) > 0, 'balanced-lossy body/suffix lost');
});

// EVE round 23 — the flow-vs-generic decision no longer keys on "opener ends the chunk", and lossy
// `>`-recovery no longer scans the visible body or relies on a double-close signature. Each case drives
// the real structure() → buildIndex() → Orama chain with EVE's exact reals from the round-22 review.
test('real structure() round-23: whole-chunk/compact generics, intro/nested flow, single-close recovery', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r23', data: { title: '/r23', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // P1 #1 — a whole-chunk in-body generic (`factory()\<$Panel extends ENDCONSTR22>`) that ALSO ends its
  // chunk, and a compact one (`when alpha\<$Panel remains COMPACTKEEP22`), inside a real same-name outer
  // flow component. The outer closer must NOT pair off the mid-body generic; the generic needle stays.
  const endconstr = '<$Panel attr="OUTER23">\n\n## H\n\nfactory()<$Panel extends ENDCONSTR22>\n\n</$Panel>';
  assert.ok((await hits(endconstr, 'ENDCONSTR22')) > 0, 'whole-chunk generic wrongly deleted by outer closer');
  assert.equal(await hits(endconstr, 'OUTER23'), 0, 'endconstr outer opener attribute leaked');
  const compact = '<$Panel attr="OUTER23">\n\n## H\n\nwhen alpha<$Panel remains COMPACTKEEP22\n\n</$Panel>';
  assert.ok((await hits(compact, 'COMPACTKEEP22')) > 0, 'compact generic wrongly deleted by outer closer');

  // P1 #2 — a real flow component with INTRO text before its heading (`prefix<$Panel>FLOWINTRO22`) and a
  // CONTINUOUSLY NESTED flow-opener chunk (`<$Outer><$Inner>`): both openers must pair by their real
  // later-chunk closers (not misjudged as generics), so no markup indexes but the intro/body survive.
  const intro = 'prefix<$Panel>FLOWINTRO22\n\n## H\n\nbody23\n\n</$Panel>';
  assert.ok((await hits(intro, 'FLOWINTRO22')) > 0 && (await hits(intro, 'prefix')) > 0, 'flow intro text lost');
  assert.equal(await hits(intro, 'Panel'), 0, 'flow-intro opener markup leaked');
  const nested = '<$Outer>\n\n<$Inner>\n\n## H\n\nnestbody23\n\n</$Inner>\n\n</$Outer>';
  assert.ok((await hits(nested, 'nestbody23')) > 0, 'nested-flow body lost');
  assert.equal(await hits(nested, 'Outer'), 0, 'continuous nested flow opener markup leaked');

  // P1 #3 — recovery must not scan the visible body: an honest code span `` `arr[i]}>0` `` keeps its text
  // (no fake double-close trigger), and a SINGLE-close lossy JSX expression opener (`… } > SINGLELEAK22`,
  // not just array `]}`) still strips, needle out, body/suffix preserved.
  const codespan = 'LEFTCODE22 `arr[i]}>0` more23';
  assert.ok((await hits(codespan, 'LEFTCODE22')) > 0 && (await hits(codespan, 'more23')) > 0, 'code-span honest body lost to recovery');
  const single = 'prefix<$Panel value={fn("a \\" } > SINGLELEAK22", x)}>\n\n## H\n\nsinglebody23\n\n</$Panel>';
  assert.equal(await hits(single, 'SINGLELEAK22'), 0, 'single-close lossy attribute leaked into Orama');
  assert.ok((await hits(single, 'singlebody23')) > 0 && (await hits(single, 'prefix')) > 0, 'single-close body/prefix lost');
});

// EVE round 24 — the flow-vs-generic decision is now BIDIRECTIONAL (a same-name generic INSIDE an open
// same-name flow is in-body content, never flow), and the cross-chunk opener strip boundary comes from the
// opener's OWN scan (never the whole chunk's `lastIndexOf('>')`, which ate honest intro containing a `>`).
// Each case drives the real structure() → buildIndex() → Orama chain with EVE's exact round-23 reals.
test('real structure() round-24: bidirectional generic classification, opener-local strip boundary', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r24', data: { title: '/r24', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // P1 #1 — a generic-shaped FLOW opener (`prefix<$Panel extends FLOWATTR23>INTROKEEP23`) with NO same-name
  // flow already open must pair by its real later closer: its opener markup drops but the intro survives.
  const flowattr = 'prefix<$Panel extends FLOWATTR23>INTROKEEP23\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(flowattr, 'INTROKEEP23')) > 0 && (await hits(flowattr, 'prefix')) > 0, 'generic-shaped flow intro lost');
  assert.equal(await hits(flowattr, 'Panel'), 0, 'generic-shaped flow opener markup leaked');

  // P1 #2 — the SAME classifier, reversed: a same-name generic (`type Box<$Panel extends IDENTGEN23>`) or a
  // chunk-start unclosed compact generic (`<$Panel remains STARTCOMPACT23`) INSIDE an open same-name flow is
  // in-body technical prose — the outer closer must not pair it off, so the needle survives.
  const identgen = '<$Panel attr="x">\n\n## H\n\nHere type Box<$Panel extends IDENTGEN23> is technical prose.\n\n</$Panel>';
  assert.ok((await hits(identgen, 'IDENTGEN23')) > 0, 'same-name in-body generic wrongly deleted by outer closer');
  const startcompact = '<$Panel attr="x">\n\n## H\n\n<$Panel remains STARTCOMPACT23\n\n</$Panel>';
  assert.ok((await hits(startcompact, 'STARTCOMPACT23')) > 0, 'chunk-start unclosed in-body generic wrongly stripped');

  // P1 #3 — the cross-chunk opener strip boundary must come from the opener's own scan, NOT the whole chunk's
  // `lastIndexOf('>')`. A paired opener whose visible intro carries an honest comparison (`arr[i]>0`) or a
  // code span (`` `arr[i]}>0` ``) keeps that intro; a single-close LOSSY opener still strips, needle out.
  const cmp = '<$Panel>LEFT arr[i]>0 RIGHT\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(cmp, 'LEFT')) > 0 && (await hits(cmp, 'RIGHT')) > 0, 'paired-opener comparison intro lost to lastIndexOf strip');
  const codespan = '<$Panel>LEFT `arr[i]}>0` RIGHT\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(codespan, 'LEFT')) > 0 && (await hits(codespan, 'arr')) > 0 && (await hits(codespan, 'RIGHT')) > 0, 'paired-opener code-span intro lost to lastIndexOf strip');
  const single = 'prefix<$Panel value={fn("a \\" } > SINGLELEAK24", x)}>\n\n## H\n\nsinglebody24\n\n</$Panel>';
  assert.equal(await hits(single, 'SINGLELEAK24'), 0, 'single-close lossy attribute leaked into Orama');
  assert.ok((await hits(single, 'singlebody24')) > 0 && (await hits(single, 'prefix')) > 0, 'single-close body/prefix lost');
});

// EVE round 25 — pairing runs on the REAL hierarchy (no `sameOpen` name-set guessing): a prior technical
// generic, a later same-name real flow, and a same-name NESTED flow each pair by their actual level. The
// lossy strip boundary is opener-LOCAL (a double-close-glued-`>` past the fake early `>`, code-span aware —
// never a whole-chunk scan), and the `()` desync no longer misjudges JS lexical contexts (regex, comment).
test('real structure() round-25: real-hierarchy pairing, opener-local lossy boundary, lexical-safe desync', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r25', data: { title: '/r25', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // P1 #1 — a PRIOR technical generic (`<$Panel extends STALEGEN24>`) then a LATER real same-name flow: the
  // lone `</$Panel>` pops the nearer flow by LIFO, so the stale generic stays kept and the flow markup drops.
  // Holds for a bare (`<$Panel>`) and an attr'd (`<$Panel attr="x">`) real opener alike.
  const staleThenFlow = 'Technical type <$Panel extends STALEGEN24>.\n\nprefix<$Panel>FLOWINTRO24\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(staleThenFlow, 'STALEGEN24')) > 0 && (await hits(staleThenFlow, 'FLOWINTRO24')) > 0, 'stale generic or later-flow intro lost');
  const staleThenAttr = 'Technical type <$Panel extends STALEGEN24>.\n\nprefix<$Panel attr="x">REALATTR24\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(staleThenAttr, 'STALEGEN24')) > 0 && (await hits(staleThenAttr, 'REALATTR24')) > 0, 'stale generic or attr-flow intro lost');
  assert.equal(await hits(staleThenAttr, 'attr'), 0, 'real attr-flow opener attribute leaked');

  // P1 #1 (nested) — a same-name flow NESTED inside a same-name flow, the inner opener generic-shaped
  // (`<$Panel extends INNERATTR24>`): both `</$Panel>` closers pop both levels, so no opener attribute leaks.
  const nested = '<$Panel a="1">\n\ntop\n\n<$Panel extends INNERATTR24>\n\n## H\n\ninner\n\n</$Panel>\n\nmid\n\n</$Panel>';
  assert.ok((await hits(nested, 'top')) > 0 && (await hits(nested, 'inner')) > 0 && (await hits(nested, 'mid')) > 0, 'nested-flow body lost');
  assert.equal(await hits(nested, 'INNERATTR24'), 0, 'nested-flow inner opener attribute leaked');

  // P1 #2 — a LOSSY opener's cleanup boundary stays confined to the opener: it stops at the double-close
  // glued to `>` (`)}>`) just past the fake early `>`, so honest intro AFTER it survives — a comparison
  // (`arr[i]>0`) and a code span (`` `arr[i]}>0` ``, whose literal `]}>` the code-span-aware scan skips).
  const lossyCmp = 'prefix<$Panel value={fn("a \\" } > x", y)}>LEFT25 arr[i]>0 RIGHT25\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(lossyCmp, 'LEFT25')) > 0 && (await hits(lossyCmp, 'arr')) > 0 && (await hits(lossyCmp, 'RIGHT25')) > 0, 'lossy+comparison intro lost');
  assert.equal(await hits(lossyCmp, 'value'), 0, 'lossy opener attribute leaked past its own boundary');
  const lossyCode = 'prefix<$Panel value={fn("a \\" } > x", y)}>LEFTCODE25 `arr[i]}>0` RIGHTCODE25\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(lossyCode, 'LEFTCODE25')) > 0 && (await hits(lossyCode, 'RIGHTCODE25')) > 0, 'lossy+code-span intro lost');
  assert.equal(await hits(lossyCode, 'value'), 0, 'lossy opener attribute leaked past a code span');

  // P1 #3 — the desync test must not misjudge JS lexical contexts: a regex `/(/` and a comment `/* ( */`
  // inside an honest attribute are NOT unbalanced parens, so the opener is clean and the intro survives.
  const regexAttr = 'prefix<$Panel pattern={/\\(/}>LEFT25 arr[i]>0 RIGHT25\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(regexAttr, 'LEFT25')) > 0 && (await hits(regexAttr, 'arr')) > 0 && (await hits(regexAttr, 'RIGHT25')) > 0, 'regex-attr opener misjudged lossy, intro eaten');
  const commentAttr = 'prefix<$Panel x={/* ( */ 1}>LEFT25 arr[i]>0 RIGHT25\n\n## H\n\nbody\n\n</$Panel>';
  assert.ok((await hits(commentAttr, 'LEFT25')) > 0 && (await hits(commentAttr, 'arr')) > 0 && (await hits(commentAttr, 'RIGHT25')) > 0, 'comment-attr opener misjudged lossy, intro eaten');
});

// EVE round 26 — the full chunk sequence decides an ambiguous same-name opener's role: a lone outer
// closer prefers the DEFINITE flow over a nearer standalone technical generic (so the generic survives),
// while balanced closers still pair a real generic-shaped NESTED flow. The lossy strip stays opener-local
// and lexical-safe: a clean bare opener never runs the double-close hunt (its honest MDX-expression intro
// `{arr[i]}>0` survives); a leaked string attribute (dropped `\"`) is cut at its dangling `">`; and a
// regex `/[}>]/` or comment `/* } > */` inside an honest `{…}` attribute is lexed, not miscounted.
test('real structure() round-26: hierarchy role, opener-local lossy boundary, lexical-safe scan', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r26', data: { title: '/r26', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // P1 #1 — a STANDALONE same-name technical generic inside a DEFINITE outer flow (one outer closer) is
  // in-body prose: the lone closer pops the definite outer, the generic stays unpaired → kept. The exact
  // reverse of the NESTED case below, which is byte-identical but has a SECOND closer.
  const standalone = '<$Panel a="1">HEAD body\n\n## H\n\n<$Panel extends STANDALONEKEEP25>\n\n## H2\n\ntail\n\n</$Panel>';
  assert.ok((await hits(standalone, 'STANDALONEKEEP25')) > 0, 'standalone in-body generic wrongly deleted by outer closer');
  const nested = '<$Panel a="1">\n\ntop\n\n<$Panel extends INNERATTR25>\n\n## H\n\ninner\n\n</$Panel>\n\nmid\n\n</$Panel>';
  assert.ok((await hits(nested, 'top')) > 0 && (await hits(nested, 'inner')) > 0 && (await hits(nested, 'mid')) > 0, 'nested-flow body lost');
  assert.equal(await hits(nested, 'INNERATTR25'), 0, 'nested-flow inner opener attribute leaked');

  // P1 #2 — a CLEAN bare opener whose visible intro carries an honest MDX expression (`{arr[i]}>0`, whose
  // literal `]}>` a lossy scan would mistake for a leaked attribute close) keeps that intro intact.
  const mdxExpr = 'pre<$Panel>LEFTEXPR25 {arr[i]}>0 RIGHTEXPR25\n\n## H\n\ntail\n\n</$Panel>';
  assert.ok((await hits(mdxExpr, 'LEFTEXPR25')) > 0 && (await hits(mdxExpr, 'RIGHTEXPR25')) > 0, 'clean-opener MDX-expression intro eaten by double-close hunt');

  // P1 #3 — a leaked STRING attribute (structure() dropped its `\"`, so scanTag desyncs and stops at a
  // fake `>` inside the string) is cut at its dangling `">`, needle gone; an honest quoted/apostrophe
  // intro after a balanced opener is NOT misfired (its quotes are balanced at every glued `">`).
  const strAttr = '<$Panel title="a \\" > STRINGATTR25">LEFTSTR body\n\n## H\n\ntail\n\n</$Panel>';
  assert.equal(await hits(strAttr, 'STRINGATTR25'), 0, 'leaked string attribute survived past its dangling close');
  assert.ok((await hits(strAttr, 'LEFTSTR')) > 0, 'string-attr visible body lost');
  const honestQuote = '<$Panel a="1">He said "hi there" LEFTQ arr[i]>0 RIGHTQ\n\n## H\n\ntail\n\n</$Panel>';
  assert.ok((await hits(honestQuote, 'LEFTQ')) > 0 && (await hits(honestQuote, 'RIGHTQ')) > 0, 'honest quoted intro misfired the dangling-close cut');

  // P1 #4 — a regex `/[}>]/` or comment `/* } > */` inside an honest `{…}` attribute holds literal
  // `}` / `>` that scanTag must lex (not count), so the attribute markup drops and the body survives.
  const regexAttr = 'pre<$Panel pattern={/[}>]REGEXATTR25/}>BODYREGEX intro\n\n## H\n\ntail\n\n</$Panel>';
  assert.equal(await hits(regexAttr, 'REGEXATTR25'), 0, 'regex-attr markup leaked (brace/gt miscounted)');
  assert.ok((await hits(regexAttr, 'BODYREGEX')) > 0, 'regex-attr body lost');
  const commentAttr = 'pre<$Panel x={/* } > COMMENTATTR25 */ 1}>BODYCOMMENT intro\n\n## H\n\ntail\n\n</$Panel>';
  assert.equal(await hits(commentAttr, 'COMMENTATTR25'), 0, 'comment-attr markup leaked (brace/gt miscounted)');
  assert.ok((await hits(commentAttr, 'BODYCOMMENT')) > 0, 'comment-attr body lost');
});

// EVE round 27 — one lexical-safe opener scanner (lossyOpenerEnd) resolves EVERY same-name flow-opener
// boundary: a clean opener stops at its real `>` (honest MDX-expr / balanced-quote intro survives), while
// each lossy shape is recovered from the opener's OWN residue — no visible-intro scan, no forked
// `lastIndexOf` heuristic for the leaked-attribute case. Covers the two disjoint lossy tells (odd-`"`
// quote leak, even-`"` bracket leak incl. a `}`/division inside an attr string) plus the apostrophe body
// that must not be mistaken for a quote leak.
test('real structure() round-27: unified lexical-safe opener boundary across lossy shapes', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r27', data: { title: '/r27', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // Clean attributed opener — its honest MDX-expression intro `{arr[i]}>0` must survive (no lossy tell).
  const attrMdx = 'prefix<$Panel a="1">LEFTATTR26 {arr[i]}>0 RIGHTATTR26\n\n## H\n\nt\n\n</$Panel>';
  assert.ok((await hits(attrMdx, 'LEFTATTR26')) > 0 && (await hits(attrMdx, 'RIGHTATTR26')) > 0, 'clean attributed opener ate its MDX-expression intro');
  // Clean attributed opener with a BALANCED quote pair in the body (`" > "`) — quotes stay even, no cut.
  const balQuote = '<$Panel a="1">LEFTBALQ26 " > " RIGHTBALQ26\n\n## H\n\nt\n\n</$Panel>';
  assert.ok((await hits(balQuote, 'LEFTBALQ26')) > 0 && (await hits(balQuote, 'RIGHTBALQ26')) > 0, 'balanced-quote body misfired the dangling-close cut');
  // BRACKET leak with EVEN quotes — a `}` closes an attr expression early; division after the string
  // operand must not be read as a regex, and the leaked `}>` is recovered so the intro survives.
  const division = '<$Panel value={"} > DIVLEAK27" / 2}>LEFTDIV27 body\n\n## H\n\nt\n\n</$Panel>';
  assert.equal(await hits(division, 'DIVLEAK27'), 0, 'division-in-attr leaked past the fake early >');
  assert.ok((await hits(division, 'LEFTDIV27')) > 0, 'division-case visible body lost');
  // QUOTE leak whose body carries an apostrophe (`it's`) — the lone `'` must NOT flip the `"`-parity tell.
  const apos = '<$Panel title="it\'s \\" > APOSLEAK27">LEFTAP27 body\n\n## H\n\nt\n\n</$Panel>';
  assert.equal(await hits(apos, 'APOSLEAK27'), 0, 'apostrophe body defeated the quote-leak tell, attribute leaked');
  assert.ok((await hits(apos, 'LEFTAP27')) > 0, 'apostrophe-case visible body lost');
});

// EVE round 28 — the exact real-Orama counterexamples from the final review, made non-skippable:
// (1) lossyOpenerEnd stays lexically safe over the WHOLE residue — a regex/comment inside an attr and a
//     code span in the body never miscount, and an honest `{arr[i]}>0` intro survives.
// (2) cross- and same-chunk lossy openers share ONE boundary path — a dropped-quote same-chunk opener is
//     cut at its own `">`, and an extra honest `"` in a cross-chunk body cannot rebalance parity and leak.
// (3) pairing is true LIFO with no remote-generic search: a lone technical generic stays searchable while
//     the real flow markup is stripped, and a nested flow + trailing technical generic both resolve.
// (4) `/` after a `}` object-literal operand is division, not a regex.
test('real structure() round-28: lexical-safe opener span, unified LIFO pairing, division after }', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r28', data: { title: '/r28', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // (1) REGATTR27 — a regex `/[}>]/` inside an honest attr expression must not be read as a leaked close;
  // the clean opener's MDX-expression intro `{arr[i]}>0` survives and the attr needle never indexes.
  const reg = 'pre<$Panel pattern={/[}>]REGATTR27/}>LEFTREG27 {arr[i]}>0 RIGHTREG27\n\n## H\n\nt\n\n</$Panel>';
  assert.equal(await hits(reg, 'REGATTR27'), 0, 'regex-in-attr miscounted as a leaked close');
  assert.ok((await hits(reg, 'LEFTREG27')) > 0 && (await hits(reg, 'arr')) > 0 && (await hits(reg, 'RIGHTREG27')) > 0, 'regex-attr clean intro eaten');
  // comment variant — `/* } > … */` inside an attr is equally inert.
  const cmt = 'pre<$Panel x={/* } > CMTATTR27 */ 1}>LEFTCMT27 {arr[i]}>0 RIGHTCMT27\n\n## H\n\nt\n\n</$Panel>';
  assert.equal(await hits(cmt, 'CMTATTR27'), 0, 'comment-in-attr miscounted as a leaked close');
  assert.ok((await hits(cmt, 'LEFTCMT27')) > 0, 'comment-attr clean intro eaten');

  // (2) same-chunk dropped-quote leak — the opener + its inline closer + suffix share one chunk; the
  // leaked attribute must be cut at its dangling `">` and never index, body/suffix survive.
  const sc = '<$Panel title="a \\" > LEAKSAME27">BODYKEEP27</$Panel> suffix';
  assert.equal(await hits(sc, 'LEAKSAME27'), 0, 'same-chunk dropped-quote attribute leaked');
  assert.ok((await hits(sc, 'BODYKEEP27')) > 0, 'same-chunk lossy body lost');
  // cross-chunk parity — an extra honest `"` in the split body must NOT rebalance the opener's quote
  // parity and re-expose the attr needle.
  const par = '<$Panel title="a \\" > PARLEAK27">\n\n## H\n\nbody with " honest quote\n\n</$Panel>';
  assert.equal(await hits(par, 'PARLEAK27'), 0, 'cross-chunk body quote rebalanced parity, attribute leaked');

  // (3) STALELOCAL27 — a lone technical generic (no closer of its own) before a real flow stays searchable
  // as prose while the real flow's markup is stripped (identical contract to round-26 STANDALONEKEEP25).
  const stale = 'Technical <$Panel extends STALELOCAL27>. prefix<$Panel>FLOWINTRO27\n\n## H\n\nb\n\n</$Panel>';
  assert.ok((await hits(stale, 'STALELOCAL27')) > 0, 'lone technical generic wrongly deleted by the real flow closer');
  assert.ok((await hits(stale, 'FLOWINTRO27')) > 0, 'real flow intro lost');
  // nested flow + a trailing technical generic — the nested opener attr is stripped, the trailing generic
  // (`type Box<$Panel extends TECHKEEP27>`, no closer of its own) stays searchable.
  const nest = '<$Panel a="1">\n\ntop\n\n<$Panel extends INNERATTR27>\n\n## H\n\ninner\n\n</$Panel>\n\ntype Box<$Panel extends TECHKEEP27> = $Panel;\n\n</$Panel>';
  assert.equal(await hits(nest, 'INNERATTR27'), 0, 'nested-flow inner opener attribute leaked');
  assert.ok((await hits(nest, 'TECHKEEP27')) > 0, 'trailing technical generic wrongly deleted');
  assert.ok((await hits(nest, 'top')) > 0 && (await hits(nest, 'inner')) > 0, 'nested-flow body lost');

  // (4) object-literal division — `{a:1} / 2` after a `}` operand is division, so the opener closes at its
  // real `>` and the visible intro survives (no run-to-end that empties the chunk).
  const od = '<$Panel value={{a:1} / 2}>BODYOBJDIV27 intro\n\n## H\n\nt\n\n</$Panel>';
  assert.ok((await hits(od, 'BODYOBJDIV27')) > 0, 'division after } object-literal operand emptied the chunk');
});

// EVE round 29 — the final review's 4 exact P1s, made non-skippable:
// (1) the generic-flow budget must have NO encounter-order bias — a leading GLUED technical generic must
//     not steal the lone surplus closer that belongs to a later STANDALONE real generic-shaped flow (and
//     vice-versa when the order is reversed).
// (2) lossyOpenerEnd is OPENER-LOCAL — an honest body `">` / `'>` after a CLEAN attributed opener must
//     not be mistaken for a leaked close (its span glues `">`, never `" >`).
// (3) single-quote lossy attributes are recovered exactly like double-quote ones (same-chunk & cross).
// (4) the lossy forward recovery is regex/comment lexical-safe — a `)}>` / `}>` inside a regex or comment
//     in the leaked attribute is not a real boundary.
test('real structure() round-29: budget order-independence, opener-local & quote-consistent lossy recovery', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r29', data: { title: '/r29', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // (1) budget order-independence — a leading glued technical generic must keep (searchable) while the
  // later standalone real flow claims the lone closer (its markup drops); then the reversed order.
  const first = 'Technical <$Panel extends STALEFIRST28>.\n\n<$Panel extends REALFLOWATTR28>\n\n## H\n\nBODYKEEP28\n\n</$Panel>';
  assert.ok((await hits(first, 'STALEFIRST28')) > 0, 'leading glued generic stole the later flow closer (order bias)');
  assert.equal(await hits(first, 'REALFLOWATTR28'), 0, 'later standalone real flow markup leaked (budget starved)');
  assert.ok((await hits(first, 'BODYKEEP28')) > 0, 'real flow body lost');
  const rev = '<$Panel extends REALFLOWATTR28>\n\n## H\n\nBODYKEEP28\n\n</$Panel>\n\nTechnical <$Panel extends STALESECOND28>.';
  assert.equal(await hits(rev, 'REALFLOWATTR28'), 0, 'leading standalone real flow markup leaked (reversed order)');
  assert.ok((await hits(rev, 'STALESECOND28')) > 0, 'trailing glued technical generic wrongly deleted (reversed order)');

  // (2) opener-local — a CLEAN attributed opener whose visible body carries an honest `">` must survive.
  const cross = '<$Panel a="1">LEFTCROSSQ28 text "> RIGHTCROSSQ28\n\n## H\n\ntail\n\n</$Panel>';
  assert.ok((await hits(cross, 'LEFTCROSSQ28')) > 0 && (await hits(cross, 'RIGHTCROSSQ28')) > 0, 'honest body `">` mistaken for a leaked close');

  // (3) single-quote lossy — same-chunk inline and cross-chunk flow both strip the leaked attribute.
  const sqSame = "<$Panel title='a \\' > LEAKSQ28'>BODYSQ28</$Panel> suffix";
  assert.equal(await hits(sqSame, 'LEAKSQ28'), 0, 'single-quote same-chunk lossy attribute leaked');
  assert.ok((await hits(sqSame, 'BODYSQ28')) > 0, 'single-quote same-chunk body lost');
  const sqCross = "<$Panel title='a \\' > LEAKSQCROSS28'>\n\n## H\n\nbodySqCross\n\n</$Panel>";
  assert.equal(await hits(sqCross, 'LEAKSQCROSS28'), 0, 'single-quote cross-chunk lossy attribute leaked');
  assert.ok((await hits(sqCross, 'bodySqCross')) > 0, 'single-quote cross-chunk body lost');

  // (4) regex/comment lexical-safe forward recovery — a `)}>` inside a regex (and a comment) in the leaked
  // attribute is not the real boundary; the real `)}>` after it is.
  const reg = '<$Panel value={fn("a \\" } > LEAKREG28", /[)}>]/.test(REGTAIL28))}>BODYREG28</$Panel> suffix';
  assert.equal(await hits(reg, 'LEAKREG28'), 0, 'regex-in-attr leaked attribute survived');
  assert.equal(await hits(reg, 'REGTAIL28'), 0, 'regex body content leaked (miscounted as boundary)');
  assert.ok((await hits(reg, 'BODYREG28')) > 0, 'regex-case visible body lost');
  const cmt = '<$Panel value={fn("a \\" } > LEAKCMT28", /* )}> */ 1)}>BODYCMT28</$Panel> suffix';
  assert.equal(await hits(cmt, 'LEAKCMT28'), 0, 'comment-in-attr leaked attribute survived');
  assert.ok((await hits(cmt, 'BODYCMT28')) > 0, 'comment-case visible body lost');
});

// EVE round 30 — the final review's 5 exact real-Orama P1s, made non-skippable:
// (1) the generic-flow budget must have NO encounter-order bias even for GLUED→GLUED: a leading glued
//     technical generic must keep (searchable) while the LATER same-name glued real flow claims the lone
//     closer — pure LIFO nearest-pop, the first opener must not greedily exhaust the budget.
// (1b) a bare TS instantiation in prose (`type Box<$Panel> holds`) is NOT a residue opener and must not
//     be counted against a later real same-name flow's closer budget (it would starve and leak the flow).
// (2) lossyOpenerEnd is OPENER-LOCAL: a CLEAN attributed opener whose honest body carries a `"> ` (with a
//     space before the quote) or a `"}> ` must NOT be mistaken for a leaked attribute close.
// (3) the dropped-quote first-segment recovery is regex/comment lexical-safe — a `">` inside a
//     `pattern={/">/}` regex in the leaked attribute is not the real close; the tag's real `>` is.
test('real structure() round-30: glued budget LIFO, prose instantiation, opener-local & regex-safe recovery', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r30', data: { title: '/r30', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // (1) glued→glued budget order-independence — the leading glued technical generic keeps; the later
  // glued real flow claims the lone closer (its markup drops); the intro and body survive.
  const glued = 'Technical <$Panel extends STALEGLUED29>.\n\nprefix<$Panel extends REALGLUED29>INTROKEEP29\n\n## H\n\nBODYKEEP29\n\n</$Panel>';
  assert.ok((await hits(glued, 'STALEGLUED29')) > 0, 'leading glued generic stole the later flow closer (order bias)');
  assert.equal(await hits(glued, 'REALGLUED29'), 0, 'later glued real flow markup leaked (budget starved)');
  assert.ok((await hits(glued, 'INTROKEEP29')) > 0 && (await hits(glued, 'BODYKEEP29')) > 0, 'real flow intro/body lost');

  // (1b) a bare TS instantiation in prose (`type Box<$Panel> holds`) is not a residue opener — the later
  // real same-name flow still pairs with the lone closer (its markup drops), and the prose token survives.
  const inst = 'Bare type Box<$Panel> holds.\n\n<$Panel extends REALFLOWATTRX>\n\n## H\n\nBODYX\n\n</$Panel>';
  assert.equal(await hits(inst, 'REALFLOWATTRX'), 0, 'real flow markup leaked (prose instantiation stole the closer)');
  assert.ok((await hits(inst, 'Box')) > 0 && (await hits(inst, 'BODYX')) > 0, 'prose instantiation token or flow body lost');

  // (2) opener-local — a CLEAN attributed opener whose honest body carries a `"> ` (space before the
  // quote) or a `"}> ` must survive; neither is a leaked attribute close.
  const spaced = '<$Panel a="1" >LEFTWSDQ29 text "> RIGHTWSDQ29\n\n## H\n\ntail\n\n</$Panel>';
  assert.ok((await hits(spaced, 'LEFTWSDQ29')) > 0 && (await hits(spaced, 'RIGHTWSDQ29')) > 0, 'honest body `"> ` mistaken for a leaked close');
  const brace = '<$Panel a="1">LEFTBRACE29 text "}> RIGHTBRACE29\n\n## H\n\ntail\n\n</$Panel>';
  assert.ok((await hits(brace, 'LEFTBRACE29')) > 0 && (await hits(brace, 'RIGHTBRACE29')) > 0, 'honest body `"}> ` mistaken for a leaked bracket close');

  // (3) dropped-quote first-segment recovery is regex-safe — a `">` inside a `pattern={/">/}` regex is not
  // the real close; the leaked attribute and the regex body never index, the tag's real `>` ends it.
  const reg = '<$Panel title="a \\" > LEAKQ29" pattern={/">/.test(REGQ29)}>BODYQ29</$Panel>';
  assert.equal(await hits(reg, 'LEAKQ29'), 0, 'dropped-quote leaked attribute survived');
  assert.equal(await hits(reg, 'REGQ29'), 0, 'regex body content leaked (matched the fake `">`)');
  assert.ok((await hits(reg, 'BODYQ29')) > 0, 'regex-case visible body lost');
});

test('real structure() round-31: opener-provable roles only — no chunk-end/body-first-char guessing, recovery gated on opener lossiness', async () => {
  const oramaFor = async (raw: string) => {
    const index = await buildIndex({ url: '/r31', data: { title: '/r31', description: undefined, structuredData: structure(raw) } } as Parameters<typeof buildIndex>[0]);
    return initAdvancedSearch({ language: 'english', indexes: [index] });
  };
  const hits = async (raw: string, q: string) => (await (await oramaFor(raw)).search(q)).length;

  // (A) A glued technical generic whose `>` lands at the CHUNK END (`type Box<$Panel>` on its own line, nothing
  // after the `>`) is prose, not a residue: its token survives AND — critically — it must not be counted as an
  // opener that claims the lone same-name closer. The old code auto-realed any glued opener sitting at chunk end,
  // so the later real `<$Panel …>` flow lost the closer and leaked its markup. Grammar (operand-position parse)
  // now decides the role. RED on old head: `REALCLOSE` markup leaked; GREEN now.
  const gen = 'type Box<$Panel>\n\nGENTOK\n\n<$Panel extends REALCLOSE>\n\n## H\n\nBODYEND\n\n</$Panel>';
  assert.ok((await hits(gen, 'GENTOK')) > 0, 'chunk-end technical generic token dropped');
  assert.equal(await hits(gen, 'REALCLOSE'), 0, 'real flow markup leaked (chunk-end generic stole the closer)');
  assert.ok((await hits(gen, 'BODYEND')) > 0, 'real flow body lost');

  // (A2/A3/A4) A real flow opener whose body starts with whitespace / a digit / punctuation must still drop
  // its markup — the old code auto-realed an opener when its body-first char was outside a whitelist, guessing
  // the role from the first content byte. Grammar-only: these are genuine flow residues, markup drops, body keeps.
  const space = '<FLOWSPACE30 a="1">   visible space intro\n\n## H\n\nbody-space\n\n</FLOWSPACE30>';
  assert.equal(await hits(space, 'FLOWSPACE30'), 0, 'whitespace-intro flow markup leaked');
  assert.ok((await hits(space, 'visible')) > 0 && (await hits(space, 'body-space')) > 0, 'whitespace-intro flow content lost');
  const digit = '<FLOWDIGIT30 a="1">7 visible digit intro\n\n## H\n\nbody-digit\n\n</FLOWDIGIT30>';
  assert.equal(await hits(digit, 'FLOWDIGIT30'), 0, 'digit-intro flow markup leaked');
  assert.ok((await hits(digit, 'visible')) > 0 && (await hits(digit, 'body-digit')) > 0, 'digit-intro flow content lost');
  const punct = '<FLOWPUNCT30 a="1">! visible punct intro\n\n## H\n\nbody-punct\n\n</FLOWPUNCT30>';
  assert.equal(await hits(punct, 'FLOWPUNCT30'), 0, 'punct-intro flow markup leaked');
  assert.ok((await hits(punct, 'visible')) > 0 && (await hits(punct, 'body-punct')) > 0, 'punct-intro flow content lost');

  // (B) A CLEAN attributed opener with a legitimate trailing space before its `>` (`a="1" >`) is not lossy —
  // quote recovery must not scan its visible body. Both single- and double-quoted forms keep their body tokens.
  const dq = '<$Panel a="1" >LEFTTRAIL30 body RIGHTTRAIL30\n\n## H\n\ntail\n\n</$Panel>';
  assert.ok((await hits(dq, 'LEFTTRAIL30')) > 0 && (await hits(dq, 'RIGHTTRAIL30')) > 0, 'clean trailing-space (double-quote) body scanned as leaked');
  const sq = "<$Panel a='1' >LEFTTRAILSQ body RIGHTTRAILSQ\n\n## H\n\ntail\n\n</$Panel>";
  assert.ok((await hits(sq, 'LEFTTRAILSQ')) > 0 && (await hits(sq, 'RIGHTTRAILSQ')) > 0, 'clean trailing-space (single-quote) body scanned as leaked');

  // (C) A CLEAN expression attribute (`b={x}`) is not lossy — bracket recovery must not fire on it. The old
  // code, on seeing a later `"}> ` / `]> ` sequence in the visible body, treated the whole opener as a leaked
  // bracket attribute and swallowed everything up to that body `>`, dropping the intro. RED on old head:
  // `EATBR` intro eaten; GREEN now (recovery only fires when the opener itself is bracket-desynced).
  const expr = '<$Panel b={x}>EATBR arr "}> AFTERBR text\n\n## H\n\ntail\n\n</$Panel>';
  assert.ok((await hits(expr, 'EATBR')) > 0, 'clean expression-attr intro eaten by spurious bracket recovery');
  assert.ok((await hits(expr, 'AFTERBR')) > 0, 'clean expression-attr trailing body lost');
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

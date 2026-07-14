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

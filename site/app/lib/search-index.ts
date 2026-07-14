import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import type { Nodes } from 'mdast';
import ts from 'typescript';
import type { source } from './source';

type Page = (typeof source)['$inferPage'];

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// structure() encodes the two markdown-punctuation characters it needs to protect
// as NUMERIC entities: backtick (`&#x60;`) and asterisk (`&#x2A;`). Decode ONLY
// those two BEFORE the parse, so a decoded `*mcc*` is re-read as emphasis instead
// of surfacing literally. Every other entity — crucially a quote (`&#34;` / `&#x22;`
// / `&quot;`) that lives inside a JSX attribute — is left encoded here: decoding it
// up front would end an attribute string early and leak the tag's tail (`B">…`).
// The survivors are decoded post-parse (decodeContentEntities), as plain content.
function decodeMarkdownPunctEntities(input: string): string {
  return input.replace(/&#x0*(60|2[aA]);|&#0*(96|42);/g, (m) => (/60|96/.test(m) ? '`' : '*'));
}

// Decode the entities that are just content once tags are gone: named ones plus
// any leftover numeric. Runs AFTER the tag scanner and parse, so a decoded `<`/`>`
// is a searchable character, never re-interpreted as markup. An out-of-range or
// otherwise invalid numeric entity (`&#9999999999;`) is NOT a real code point —
// String.fromCodePoint would throw and abort the whole index build, so keep such a
// malformed entity as its literal source text instead.
function decodeContentEntities(input: string): string {
  const fromCode = (n: number, raw: string) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);
  return input
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => NAMED_ENTITIES[name] ?? name)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => fromCode(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => fromCode(parseInt(dec, 10), m));
}

// Node types whose *own value* is markup, never searchable prose: raw HTML, MDX
// `{…}` expressions (including `{/* comments */}`), and ESM import/export lines.
// JSX element nodes (mdxJsxTextElement / mdxJsxFlowElement) are NOT dropped —
// their tag + attributes contribute no text, but their CHILDREN are the component
// body, which is real content (`<Callout>inner</Callout>` → `inner`).
const DROP_NODE_TYPES = new Set(['html', 'mdxFlowExpression', 'mdxTextExpression', 'mdxjsEsm']);

// Collect visible text from an mdast/mdxast tree, skipping markup-only nodes and
// recursing through JSX elements to keep their body text. Never inspects raw `<`
// runs by hand, so an intraword `_` or a `<`/`>` inside prose is untouched.
function nodeText(node: Nodes): string {
  if (DROP_NODE_TYPES.has(node.type)) return '';
  if ('children' in node && node.children.length > 0) return node.children.map(nodeText).join('');
  return 'value' in node ? node.value : '';
}

// structure() serializes a component tag it can't render into a chunk of plain text,
// and — because Fumadocs splits a flow component around any nested heading — often into
// a STANDALONE opening/closing residue that is not valid MDX on its own (`\<Tabs …>`, a
// lone `</Tabs>`, a `<>` / `</>` fragment boundary). The MDX parser throws on those, so
// they must be removed here, BEFORE the parse, WITHOUT touching a searchable `<` in prose.
//
// The genuinely ambiguous case — `<out disabled>` / `<const dataÉ="x">` / `<in title="x">`
// — is a valid JSX element AND a valid TS generic at the SAME time, so no per-chunk grammar
// oracle can separate the two. structure() hands us a stronger signal: whenever it splits a
// flow component around a nested heading it emits BOTH an opener residue and a matching closer
// residue, but never a closer for a TS generic. `pairResidues` walks the page's chunk stream in
// order with a POSITIONAL, hierarchy-aware stack (a closer pops the nearest matching opener,
// like real nesting) and is code-span aware, so a literal `` `</T>` `` in prose can't pair off
// and delete an unrelated generic in another chunk. A positionally-paired opener is a confirmed
// component. Falling back to structural signals for the unpaired remainder:
//   - a `</Name>` / self-closing / fragment residue is always markup,
//   - an opener that is JSX-valid but not TS-valid is a split flow component,
//   - a lossy attributed opener filling its whole chunk (structure() dropped its closer's
//     escaping so it never paired) is a component too,
//   - everything else (a bare `<T>`, an `a<b` comparison, a `<T, U = …>` generic) is prose.
// The scan is code-span, quote, template-literal, brace and entity aware, so a `>` hiding
// inside an attribute string / `{…}` / `` `…` `` can't end a tag early.
// A JSX/TS name may start with a letter, `_`, `$` or any Unicode ID_Start, and continue with
// those plus digits / `.` / `:` / `-`. structure() markdown-escapes a leading/embedded `_` as
// `\_`, and an astral identifier spans two UTF-16 units — the *Len helpers report how many
// SOURCE chars one logical name char spans (0 when it isn't one), using codePointAt so a full
// Unicode code point (not a lone surrogate) is tested against ID_Start.
const NAME_START = /[\p{ID_Start}$_]/u;
const NAME_CONT = /[\p{ID_Continue}$.:-]/u;
const cpLen = (c: number) => (c > 0xffff ? 2 : 1);
const nameLen = (re: RegExp, text: string, p: number) => {
  const esc = text[p] === '\\';
  const c = text.codePointAt(p + (esc ? 1 : 0));
  return c !== undefined && re.test(String.fromCodePoint(c)) ? (esc ? 1 : 0) + cpLen(c) : 0;
};

type Tag = { esc: boolean; lt: number; closing: boolean; name: string; nameEnd: number; end: number; selfClose: boolean; closed: boolean };

// Try to read a tag opener/closer starting at `i`. Returns null if `i` isn't a `<` / `\<`
// followed by a JSX name start. Scans to the terminating `>` at brace depth 0, honoring
// quotes / template literals / structure()'s markdown-escaped punctuation so a `>` hidden
// inside an attribute value can't end the tag early. `closed` is false when the `>` never
// arrives (a multiline opener split across chunks, or a lossy-serialized attribute).
function scanTag(text: string, i: number): Tag | null {
  const esc = text[i] === '\\' && text[i + 1] === '<';
  const lt = esc ? i + 1 : i;
  if (text[lt] !== '<') return null;
  const closing = text[lt + 1] === '/';
  const nameAt = lt + 1 + (closing ? 1 : 0);
  if (nameLen(NAME_START, text, nameAt) === 0) return null;
  let j = nameAt, nl: number;
  while ((nl = nameLen(NAME_CONT, text, j)) > 0) j += nl;
  const name = deEscape(text.slice(nameAt, j));
  let quote = '', brace = 0, closed = false, selfClose = false, k = j;
  while (k < text.length) {
    const ch = text[k];
    if (quote) {
      if (ch === '\\') { k += 2; continue; } // escaped char inside a string/template
      if (ch === quote) quote = '';
      k++; continue;
    }
    if (ch === '\\' && /[<>{}[\]]/.test(text[k + 1] ?? '')) { // structure()'s markdown-escaped punctuation
      const p = text[k + 1];
      if (p === '{') brace++; else if (p === '}' && brace > 0) brace--;
      k += 2; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    else if (ch === '/' && !brace && text[k + 1] === '>') selfClose = true;
    else if (ch === '>' && !brace) { k++; closed = true; break; }
    k++;
  }
  return { esc, lt, closing, name, nameEnd: j, end: k, selfClose, closed };
}

// Walk the page's ordered chunk stream and pair opener residues with their closers using a
// positional, hierarchy-aware stack: a `</Name>` pops the nearest still-open `<Name>` (so real
// nesting is respected), not a name-set membership test. Code-span aware, so a `` `</T>` ``
// literal in prose never pairs. Returns the set of `chunkIndex:offset` positions that are
// confirmed component tags (both the opener and its matched closer).
export function pairResidues(chunks: string[]): Set<string> {
  const paired = new Set<string>();
  const stack: { name: string; key: string }[] = [];
  chunks.forEach((text, ci) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '`') { let f = 0; while (text[i + f] === '`') f++; const e = text.indexOf(text.slice(i, i + f), i + f); i = e === -1 ? text.length : e + f; continue; }
      const tag = scanTag(text, i);
      if (!tag) { i++; continue; }
      // Only a STANDALONE residue opener enters the pairing stack. structure() emits a flow
      // component's opener/closer residue as its own chunk (leading `\` aside), whereas a `\<Name …>`
      // GLUED to preceding code in the same text run is a TS construct structure() escaped as prose —
      // a type-argument (`factory()\<Name>()`), a constrained generic (`\<Name extends …>`), a
      // comparison (`a\<Name`) or a nested first-param (`\<Name\<U>>`). Pushing such a same-named
      // in-body generic lets the outer `</Name>` pop IT instead of the real opener, deleting the
      // generic and leaking the outer markup. Skip a glued ESCAPED OPENER UNLESS its own matching
      // closer sits later in THIS chunk — a real inline component (`prefix\<Panel …>b\</Panel>suffix`)
      // carries its closer in-chunk, but an in-body generic never does (its `</Name>` is elsewhere).
      // A CLOSING tag is never a generic, so it must always pair (else a glued `\</$Panel>` whose
      // suffix has no further closer would be skipped and its opener never pops).
      const glued = text.slice(0, tag.esc ? tag.lt - 1 : tag.lt).trim() !== '';
      const inBodyGeneric = glued && tag.esc && !tag.closing && !rawCloserRe(tag.name).test(outsideCode(text.slice(tag.closed ? tag.end : tag.nameEnd)));
      if (!tag.selfClose && !inBodyGeneric) {
        if (tag.closing) { for (let s = stack.length - 1; s >= 0; s--) if (stack[s].name === tag.name) { paired.add(stack[s].key); paired.add(`${ci}:${tag.lt}`); stack.length = s; break; } }
        else stack.push({ name: tag.name, key: `${ci}:${tag.lt}` });
      }
      i = tag.closed ? tag.end : tag.nameEnd;
    }
  });
  return paired;
}

function stripComponentResidue(text: string, chunkIndex: number, paired: Set<string>): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // A code span is verbatim: copy `…` runs (matching the opening fence length)
    // untouched so a `<version>` or `<T>` generic inside code is never scanned.
    if (c === '`') {
      let f = 0; while (text[i + f] === '`') f++;
      const fence = text.slice(i, i + f);
      const end = text.indexOf(fence, i + f);
      const stop = end === -1 ? text.length : end + f;
      out += text.slice(i, stop); i = stop; continue;
    }
    // Fragment boundaries `<>` / `</>` (possibly escaped `\<>`): pure markup, drop.
    const frag = /^\\?<\/?>/.exec(text.slice(i));
    if (frag) { out += ' '; i += frag[0].length; continue; }
    // An HTML comment (`<!-- … -->`) reached HERE is outside any code span (a code
    // span was copied verbatim by the branch above), so it is real markup — drop it.
    // A `<!-- … -->` INSIDE a code span never gets here, so its literal text stays.
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); out += ' '; i = e === -1 ? text.length : e + 3; continue; }
    const tag = scanTag(text, i);
    if (!tag) { out += c; i++; continue; }
    let { esc, closed, end: k } = tag;
    const { lt, closing, selfClose } = tag;
    const isPaired = paired.has(`${chunkIndex}:${lt}`); // positionally matched with a closer → component
    const glued = out.trim() !== ''; // real prose precedes this `<` in the same chunk
    // A positionally-paired opener whose closer lives in ANOTHER chunk is a genuine cross-chunk
    // flow residue — structure() emitted the whole opener (name + attributes) as its own standalone
    // chunk. Its corrupted attribute can hide a `}]` that drops scanTag's brace depth to 0 at a `>`
    // still inside the attribute string, so scanTag's `>` position is untrustworthy: the whole chunk
    // is markup, strip it to end. (When the closer is in THIS chunk the tag is a self-contained
    // inline element — `\<Tabs …> body </Tabs>` — so fall through to keep its body.)
    const closerRe = rawCloserRe(tag.name);
    const closerInChunk = closerRe.test(text.slice(k));
    const closerAfter = text.slice(tag.nameEnd).search(closerRe); // matching `</Name>` (escape-tolerant), offset relative to nameEnd
    if (isPaired && !glued && !closing && !selfClose && !closerInChunk) { i = text.length; out = out.trimEnd(); continue; }
    // Lossy `>`-recovery for a GLUED opener whose matching `</Name>` sits LATER IN THIS CHUNK.
    // structure() can drop the escaping backslash of a quote/template inside an opener's attribute,
    // desyncing scanTag's quote tracking. structure() markdown-escapes EVERY opening bracket (`\{`,
    // `\[`) — structural AND string-content alike — but leaves closes bare, so a brace/bracket-depth
    // scan is fooled by unbalanced brackets inside the corrupted attribute STRING: `items={["a }] > x"]}>`
    // under-counts and scanTag cuts EARLY at the string-internal `>` (attr residue leaks as fake suffix),
    // while `items={["a { [ x"]}>` over-counts so scanTag never closes (body+suffix swallowed).
    // Re-anchor the real `>` to the LAST `>` before that closer — but ONLY for a CONFIRMED-DESYNC
    // opener: scanTag never reached the closer (`!closed`), or the region it left between its `>` and
    // the closer is UNBALANCED (leaked string/bracket residue). A clean glued opener's visible body can
    // legitimately hold a `>` (`LEFT > RIGHT`), an entity, or a nested inline tag — re-anchoring it would
    // delete that body, so leave scanTag's honest `>` untouched.
    if (glued && !closing && !selfClose && closerAfter !== -1 && (!closed || !balancedBody(text.slice(k, tag.nameEnd + closerAfter)))) {
      const gt = text.lastIndexOf('>', tag.nameEnd + closerAfter);
      if (gt > tag.nameEnd) { k = gt + 1; closed = true; }
    }
    // Fallback brace/bracket-depth recovery for a GLUED or non-escaped opener with no in-chunk closer
    // to anchor on — cut at the first `>` OUTSIDE any `{…}`/`[…]` expression past the tag name. A
    // STANDALONE escaped lossy opener has no real suffix in its own chunk (the desynced quotes let the
    // hunt stop at a `>` still inside the corrupted attribute string and expose fake suffix), so leave
    // it unclosed and let the escaped strip-to-end branch drop it.
    if (!closed && (!esc || glued)) {
      let depth = 0;
      for (let m = tag.nameEnd; m < text.length; m++) {
        const ch = text[m];
        if (ch === '\\' && /[{}[\]]/.test(text[m + 1] ?? '')) { const p = text[m + 1]; if (p === '{' || p === '[') depth++; else if (depth > 0) depth--; m++; continue; }
        if (ch === '{' || ch === '[') depth++;
        else if ((ch === '}' || ch === ']') && depth > 0) depth--;
        else if (ch === '>' && depth === 0) { k = m + 1; closed = true; break; }
      }
    }
    // The opener body is the tag name + attributes, up to (not including) the closing `>`.
    const body = text.slice(lt + 1, closed ? k - 1 : k).replace(/\/\s*$/, '');
    const standalone = !glued && (!closed || text.slice(k).trim() === ''); // opener fills its whole chunk
    const isComponent = !closing && !selfClose && (isPaired || opensJsxElement(body));
    // An UNCLOSED escaped opener is split-flow residue (strip to end) when it is a paired
    // component, its body carries a JSX `attr={…}` / `{...spread}`, or the body is JSX-valid
    // but not TS (`Panel disabled`, `Panel title="x"` — an own-line-`>` split opener whose `>`
    // lives in the next chunk). The JSX-valid tell only applies when NOT glued to prose: a
    // glued `alpha\<Needle remains …` is a `<` comparison, kept verbatim. A standalone prose
    // generic (`\<T, U = "x">`, which is closed) or a compact comparison matches none below.
    if (!closed && esc && (isPaired || looksLikeOpener(body) || (!glued && opensJsxElement(body)))) { i = text.length; out = out.trimEnd(); continue; }
    if (closed && (closing || selfClose || isComponent)) { out += ' '; i = k; continue; }
    // An opener body carrying an unambiguous JSX `attr={…}` / `{...spread}` shape is a
    // component — a JSX expression attribute is never a TS generic default (`= value`), so this
    // wins even when the mangled body also parses as TS (`<out T={[…]}>` reads `out` as a
    // variance modifier). Strip just the opener, keeping the visible body + suffix — covers
    // glued lossy openers (`title={a \ b}`) and whole-chunk attributed residue alike.
    if (closed && looksLikeOpener(body)) { out += ' '; i = k; continue; }
    // A whole-chunk `tagName attr="…"` string attribute (`<const dataÉ="x">`): shape-identical
    // to a generic default with a variance modifier (`<in T="x">`), so only a component when it
    // is NOT glued to prose. But a bare `<out T="x">` / `<in T="x">` / `<const T="x">` is ALSO a
    // valid TS variance/modifier generic — keep those (they must stay searchable), and only drop
    // the ones the TS grammar rejects (`<const dataÉ="x">`, whose `dataÉ` is not a type param).
    if (closed && standalone && hasAttrShape(body) && !isTsGeneric(body)) { out += ' '; i = k; continue; }
    // KEEP: this `<…>` is prose (a TS generic / type-argument / comparison / placeholder).
    // A multi-token body (`keyof X`, `T, U = …`, `a instanceof B`), a qualified name
    // (`ns.Member`), a nested type-argument (`Foo<Bar` — body carries a `<`) or a nested
    // generic CLOSE (`Bar` in `Foo<Bar>>`, the char past `>` is another `>`) parses as a JSX
    // element downstream and would be silently dropped, so emit its `<` as `&lt;`
    // (decodeContentEntities restores a searchable `<`). A bare single-name opener (`<T>`,
    // `<version>`, and residual `<Step>` component markup) keeps the old literal path — the
    // parser drops the stray tag, matching prior behavior.
    if (closed && (/[\s,=<]|\.[A-Za-z_$]/.test(deEscape(body).trim()) || text[k] === '>')) { out += '&lt;'; i = lt + 1; continue; }
    out += c; i++;
  }
  return out;
}

// Classify a `<…>` opener body (everything after `<` up to but excluding the closing `>`,
// tag name included) as a JSX ELEMENT (strip) or as TypeScript / prose (keep), using the
// REAL grammars. This is the fallback for openers the caller could NOT settle by positional
// residue pairing (no matching closer at a matching nesting level):
//   - The TypeScript parser decides whether the body is legal TS: a type-PARAMETER list
//     (`type _<B> = 0;`), a call's type ARGUMENTS (`f<B>();`, covering `keyof X` / `ns.Q`),
//     or a relational expression (`x = a<B>b;`, covering `a instanceof B`). Any clean → TS.
//   - The MDX grammar decides whether the body is a valid JSX opening element.
//   - A body that is JSX-valid but NOT valid TS is unambiguously a component (`{...spread}`,
//     `attr={…}`). A genuinely-ambiguous body that BOTH grammars accept (`out disabled`) is
//     left to the caller's positional pairing / lossy-chunk fallback, so here it counts as TS
//     (not a component) and is kept — a whole-chunk prose generic must never be deleted.
// structure() markdown-escapes JSX punctuation (`\<`, `\{`, `\_`, …); undo every such escape
// for the grammar probes (the caller still deletes from the original text).
// Does the opener body parse as legal TypeScript — a type-parameter list, a call's type
// arguments, or a relational expression? Any clean parse → it is TS/prose, never a component.
function isTsGeneric(body: string): boolean {
  const inner = deEscape(body).replace(/\s+/g, ' ').trim();
  // `parseDiagnostics` is TS-internal (not on the public SourceFile type) but is the
  // cheapest syntactic-error signal without a full Program — cast to reach it.
  const clean = (src: string) => ((ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS) as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length === 0;
  return clean(`type _<${inner}> = 0;`) || clean(`f<${inner}>();`) || clean(`x = a<${inner}>b;`);
}

function opensJsxElement(body: string): boolean {
  const inner = deEscape(body).replace(/\s+/g, ' ').trim();
  if (isTsGeneric(body)) return false; // valid TS → prose, keep
  try {
    let jsx = false;
    const walk = (n: { type: string; children?: unknown[] }) => { if (n.type.startsWith('mdxJsx')) jsx = true; for (const ch of (n.children ?? []) as typeof n[]) walk(ch); };
    walk(fromMarkdown(`<${inner} />`, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] }) as never);
    return jsx && !isTsGeneric(body); // JSX-shaped and NOT valid TS → unambiguous component
  } catch {
    return false;
  }
}

// Undo structure()'s markdown escaping of ANY punctuation (`\<`, `\{`, `\_`, `\-`, …) —
// a `\` before a non-alphanumeric, non-space char — so the grammar probes and opener
// sniff see the real tag text.
function deEscape(s: string): string {
  return s.replace(/\\([^0-9A-Za-z\s])/g, '$1');
}

// A `</Name>` closer regex tolerant of structure()'s per-char markdown escaping (`</\_Panel>`,
// `</\$Panel>`), so a custom-name closer is located directly in RAW text and its match offsets
// stay in raw space — no deEscape/offset remapping needed. Iterates code points (astral-safe).
function rawCloserRe(name: string): RegExp {
  const body = [...name].map((c) => '\\\\?' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`</${body}\\s*>`);
}

// Blank out code-span regions so a `</Name>` inside `` `…` `` isn't counted when probing whether
// a glued opener carries its own closer later in the chunk (else a fake code-span closer makes an
// in-body generic look like a real inline component and mispairs with the outer closer).
function outsideCode(text: string): string {
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '`') { let f = 0; while (text[i + f] === '`') f++; const e = text.indexOf(text.slice(i, i + f), i + f); i = e === -1 ? text.length : e + f; continue; }
    out += text[i++];
  }
  return out;
}

// Does a candidate body region (between scanTag's `>` and the real closer) carry balanced quotes
// and brackets? A CLEAN component body is visible prose — balanced, possibly with a stray `>`. A
// LOSSY opener whose corrupted attribute leaked past scanTag's fake `>` exposes unbalanced string /
// bracket residue (`… "c"]}`). Used ONLY to gate the closer anchor so it never re-cuts a clean
// glued opener's real body (which may legitimately contain `>`, entities, nested inline tags).
function balancedBody(seg: string): boolean {
  let quote = '', depth = 0;
  for (let m = 0; m < seg.length; m++) {
    const ch = seg[m];
    if (ch === '\\') { m++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { if (depth === 0) return false; depth--; }
  }
  return quote === '' && depth === 0;
}

// Unambiguous JSX-opener body: an `attr={…}` JSX expression or a `{...spread}`. Neither can
// be a TS generic default (those are `= value`, never `attr={…}`), so a body with either is a
// component regardless of what else it parses as. A plain `tagName attr="…"` string attribute
// is NOT here — it is shape-identical to a generic default with a modifier (`<in T="x">`), so
// the caller disambiguates it via `glued` (prose context) instead.
function looksLikeOpener(body: string): boolean {
  const inner = deEscape(body);
  return /[\w$]+=\{/.test(inner) || /\{\s*\.\.\./.test(inner);
}

// A `tagName attrName="…"` (or `={…}`) attribute shape: a fresh identifier after the tag name
// and whitespace, then a value attached to `=` with no surrounding space. This shape is shared
// by a JSX string attribute (`<Panel title="x">`) and a TS generic default with a variance
// modifier (`<in T="x">`), so the caller only treats it as a component when NOT glued to prose.
function hasAttrShape(body: string): boolean {
  return /^[^\s,<]+\s+[\p{ID_Continue}$.:-]+=["'{]/u.test(deEscape(body).trim());
}

// structuredData chunks carry raw markdown (inline-code backticks, **bold**,
// [text](url) links) plus, for content nested in MDX flow components, serialized
// tag residue like `</Step>` / `\<Tabs items=\{…}>` / `<>`. The previous regex
// stack destroyed technical identifiers — a generic `_…_` emphasis rule stripped
// the underscores out of `MACARON_CODEX_TRANSPORT`, `permission_request`, etc.
//
// Pipeline:
//  1. decodeMarkdownPunctEntities — decode ONLY structure()'s `&#x60;`/`&#x2A;`
//     (backtick/asterisk) so `*mcc*` re-reads as emphasis; leave attribute-quote
//     entities encoded so they can't end a JSX attribute early.
//  2. stripComponentResidue — remove standalone component residue (closing tags,
//     fragments, attributed/self-closing openers) that would otherwise throw the
//     MDX parser or leak, WITHOUT touching a prose `<T>` / `a<b` / code-span tag.
//  3. Parse the cleaned chunk into a real MDX AST and read text off the nodes, so
//     classification happens in the grammar, not by guessing on flattened text:
//       - CommonMark never treats intraword `_` as emphasis → identifiers survive.
//       - A `{/* … */}` comment / ESM line is an expression/esm node → dropped.
//       - A code-span generic (`` `<T>` ``) or compact comparison (`alpha<beta`)
//         is inlineCode/text → preserved verbatim.
//  4. Any chunk still not valid MDX (residual escapes, odd fragments) falls back to
//     a CommonMark parse; step 2 already removed the component markup, so nothing
//     tag-shaped remains to mis-handle.
export function sanitizeSearchText(input: string, chunkIndex = 0, paired: Set<string> = pairResidues([input])): string {
  // stripComponentResidue removes component markup — including HTML comments — with
  // code-span awareness, so a `<!-- … -->` literal inside `` `…` `` survives while a
  // real comment outside code is dropped. It runs on the raw (still entity-encoded)
  // chunk so a `>` hidden in an attribute entity can't end a tag early. `paired` is the
  // page-wide set of positionally-matched residue offsets so an opener split away from
  // its closer into another chunk is still recognized as a component.
  const cleaned = stripComponentResidue(decodeMarkdownPunctEntities(input), chunkIndex, paired);
  let text: string;
  try {
    text = nodeText(fromMarkdown(cleaned, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] }));
  } catch {
    text = toString(fromMarkdown(cleaned), { includeHtml: false }).replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
  }
  return decodeContentEntities(text)
    // Drop stray backticks the AST left as literal text (a lone/unpaired `,
    // e.g. from a decoded `&#x60;`). Only backticks — never `_` or word chars —
    // so identifiers are untouched.
    .replace(/`+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Custom buildIndex passed to createFromSource: same shape as fumadocs' default
// extractor, but every heading and content chunk is sanitized so the static
// search JSON holds clean prose instead of markdown/entities.
export async function buildIndex(page: Page) {
  const structuredData = await page.data.structuredData;
  // Pair residue openers/closers once over the ORDERED content chunk stream so an opener
  // that structure() split away from its closer into a later chunk is still recognized.
  const contents = structuredData.contents.map((c) => c.content);
  const paired = pairResidues(contents);
  return {
    id: page.url,
    title: page.data.title ?? '',
    description: page.data.description,
    url: page.url,
    structuredData: {
      headings: structuredData.headings.map((h) => ({ ...h, content: sanitizeSearchText(h.content) })),
      contents: structuredData.contents.map((c, ci) => ({ ...c, content: sanitizeSearchText(c.content, ci, paired) })),
    },
  };
}

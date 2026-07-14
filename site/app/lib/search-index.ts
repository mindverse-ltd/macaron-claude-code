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
  // Two stacks decide the real hierarchy on the COMPLETE chunk stream. `global` pairs a FLOW
  // component's opener with its closer ACROSS chunks; `local` (rebuilt per chunk) pairs an INLINE
  // component within one chunk. The distinction is structure()'s own serialization: it emits a flow
  // opener as a chunk that ENDS at the opener's `>` (heading/body/closer become later chunks), whereas
  // an in-body TS generic (`factory()\<$Panel extends GEN>()`, `a\<$Panel>b`) and a self-contained
  // inline element (`\<$Panel>x\</$Panel>`) both sit MID-chunk with more text after the `>`. So a
  // closer pops the nearest same-name LOCAL opener first (real inline nesting), then the GLOBAL one
  // (flow). An unclosed leftover opener joins `global` ONLY if its `>` ended its chunk — the flow
  // signature; a mid-chunk leftover is an in-body generic and is dropped from pairing entirely, so a
  // later flow closer can never reach past it to mispair (EVE's outer→generic→inline→outer-closer
  // case) and a cross-chunk flow JSX opener is still paired by its real later-chunk closer (never
  // mistaken for a generic just because THIS chunk holds no closer). Code-span aware throughout.
  const global: { name: string; key: string }[] = [];
  chunks.forEach((text, ci) => {
    const local: { name: string; key: string; endsChunk: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
      if (text[i] === '`') { const cs = codeSpanEnd(text, i); if (cs !== -1) { i = cs; continue; } }
      const tag = scanTag(text, i);
      if (!tag) { i++; continue; }
      if (!tag.selfClose) {
        if (tag.closing) {
          let popped = false;
          for (let s = local.length - 1; s >= 0; s--) if (local[s].name === tag.name) { paired.add(local[s].key); paired.add(`${ci}:${tag.lt}`); local.length = s; popped = true; break; }
          if (!popped) for (let s = global.length - 1; s >= 0; s--) if (global[s].name === tag.name) { paired.add(global[s].key); paired.add(`${ci}:${tag.lt}`); global.length = s; break; }
        } else {
          // Whether a leftover opener is FLOW (eligible for a later-chunk closer via `global`) vs an in-body
          // TS generic depends on three position-independent signals, since neither position nor `>`-ends-chunk
          // alone separates every case (structure() emits `factory()\<$Panel extends GEN>` — a generic that
          // ends its chunk — and `prefix \<$Panel extends CROSSATTR>` — a flow opener whose body reads as TS):
          //   G — the body is a MULTI-TOKEN valid TS generic (`$Panel extends GEN`, `T, U = …`); content only.
          //   C — the `<` is glued to a CALL/INDEX/nested-generic RESULT (`factory()<…>`, `a[i]<…>`,
          //       `Foo<Bar<X>>`): the char before is `)`/`]`/`>`. Such a `<` is a type-argument, never a fresh
          //       element (an identifier or whitespace before `<` is instead a flow opener / a `<` comparison).
          //   E — the opener's `>` ENDS the chunk (nothing but whitespace after it) — the clean flow signature.
          // A call-glued opener (C) is an in-body type-arg (kept, never pairs). A fresh-started generic-bodied
          // opener (G) is FLOW only when it ends the chunk (EVE's CROSSATTR); otherwise it is an in-body generic.
          // A fresh-started non-generic opener that CLOSED (a real element `<$Panel>`, `{...spread}`) is FLOW;
          // an unclosed one is only FLOW when its span is lossy (structure() dropped an attribute escape).
          const glued = text.slice(0, tag.esc ? tag.lt - 1 : tag.lt).trim() !== '';
          const inner = deEscape(text.slice(tag.lt + 1, tag.closed ? tag.end - 1 : tag.end)).trim();
          const generic = /[\s,=]/.test(inner) && isTsGeneric(inner);
          const callGlued = /[)\]>]$/.test(text.slice(0, tag.esc ? tag.lt - 1 : tag.lt));
          const endsChunk = tag.closed && text.slice(tag.end).trim() === '';
          const lossy = tag.closed ? bracketDesync(text.slice(tag.nameEnd, tag.end)) : !glued;
          const flow = lossy || (!callGlued && (generic ? endsChunk : tag.closed));
          local.push({ name: tag.name, key: `${ci}:${tag.lt}`, endsChunk: flow });
        }
      }
      i = tag.closed ? tag.end : tag.nameEnd;
    }
    for (const o of local) if (o.endsChunk) global.push({ name: o.name, key: o.key });
  });
  return paired;
}

function stripComponentResidue(text: string, chunkIndex: number, paired: Set<string>): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // A code span is verbatim: copy the whole `…` run (CommonMark-correct fence — exact-length
    // close, escaped `` \` `` is literal not a fence) untouched so a `<version>` or `<T>` generic
    // inside code is never scanned. A lone escaped/unterminated backtick is NOT a span, so it
    // falls through as an ordinary character and the real tag after it is still processed.
    if (c === '`') {
      const stop = codeSpanEnd(text, i);
      if (stop !== -1) { out += text.slice(i, stop); i = stop; continue; }
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
    // A positionally-paired opener whose closer lives in ANOTHER chunk is a genuine cross-chunk FLOW
    // opener residue: structure() split the component around a nested heading, so it
    // emitted the WHOLE opening tag (name + all attributes) as this chunk while body and closer became
    // LATER chunks. `isPaired` (a real `</Name>` residue matched it in another chunk) confirms it, and
    // `closerAfter === -1` confirms NO closer lives in THIS chunk (so it is not a self-contained inline
    // element). Strip from `<` to the LAST `>` in this chunk — a lossy attribute (structure() dropped a
    // quote/bracket escape) makes scanTag stop at a FAKE early `>` still inside the attribute string
    // (`… } > SINGLELEAK", x)}>`, `… ]} > LUCKY", "c"]}>`), but the tag's REAL `>` is always the last one;
    // a clean opener (`\<$Panel>FLOWINTRO`) has a single `>`, so last == k and its intro survives. This
    // needs NO visible-body scan, so an honest code span `` `arr[i]}>0` `` in a DIFFERENT chunk is untouched.
    // A whole-chunk `<const dataÉ="x">` / `<out T="x">` is shape-identical to a valid TS generic, stays
    // UNpaired, and is kept by the grammar branches below.
    const closerRe = rawCloserRe(tag.name);
    const closerAfter = text.slice(tag.nameEnd).search(closerRe); // matching `</Name>` (escape-tolerant), offset relative to nameEnd
    if (isPaired && !closing && !selfClose && closerAfter === -1) {
      const lastGt = text.lastIndexOf('>');
      out += ' '; i = lastGt >= k - 1 ? lastGt + 1 : k;
      continue;
    }
    // Lossy `>`-recovery for a GLUED opener whose matching `</Name>` sits LATER IN THIS CHUNK.
    // structure() can drop the escaping backslash of a quote/template inside an opener's attribute,
    // desyncing scanTag's quote tracking. structure() markdown-escapes EVERY opening bracket (`\{`,
    // `\[`) — structural AND string-content alike — but leaves closes bare, so a brace/bracket-depth
    // scan is fooled by unbalanced brackets inside the corrupted attribute STRING: `items={["a }] > x"]}>`
    // under-counts and scanTag cuts EARLY at the string-internal `>` (attr residue leaks as fake suffix),
    // while `items={["a { [ x"]}>` over-counts so scanTag never closes (body+suffix swallowed). A dropped
    // string-quote backslash (`title="a \" b"` → `title="a " b"`) desyncs the quote state the same way.
    // The desync is decided from OPENER-LOCAL signals only, NEVER whole-body balance (a body apostrophe /
    // stray `[` / lone `]` defeats that — EVE's `<Panel …>LEFT [ compare > RIGHT` honest-opener case):
    //   (a) the OPENER'S OWN attribute span (what scanTag consumed, `nameEnd..k`) is quote- and
    //       bracket-unbalanced — catches `!closed`, the dropped-quote case, and mismatched `}]`; a clean
    //       opener's span is balanced (`mode=\{\{ a }} title="x">`) even when the body carries a stray `[`.
    //   (b) the span rebalanced by luck (`]}` closes `\[\{` in order) but scanTag stopped at a FAKE `>`,
    //       leaving the attribute's REAL structural close glued to the true tag end as `]}>` / `}]>` /
    //       `]]>` / `}}>` residue before the closer. structure() never emits a DOUBLE bare close-then-`>`
    //       in honest body: body opens are escaped `\[` / `\{`, and their closes are bare and single, so
    //       an honest `arr\[i]>0` yields a lone `]>` (never `]}>`). Only a leaked attribute's real
    //       structural close (`\{\["…"]}` → `]}`) doubles onto the tag `>`, so a run of TWO closes
    //       immediately before a `>` (optionally across whitespace: `]}   >`) is unambiguous leaked
    //       opener serialization. This IS an after-`k` read, but a TARGETED double-close signature, not a
    //       whole-body balance scan — a single body `]>` / `>` can never match it (EVE's `arr[i]>0`).
    // On a confirmed-lossy opener, re-anchor to the LAST `>` before the closer and strip directly (the
    // mangled residue is ungrammatical, so grammar classification below would wrongly KEEP it as prose).
    const attrLeak = /[\]}]{2}\s*>/.test(text.slice(k, tag.nameEnd + closerAfter));
    if (glued && esc && !closing && !selfClose && closerAfter !== -1 && (!closed || bracketDesync(text.slice(tag.nameEnd, k)) || attrLeak)) {
      const gt = text.lastIndexOf('>', tag.nameEnd + closerAfter);
      if (gt > tag.nameEnd) { out += ' '; i = gt + 1; continue; }
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

// End of a CommonMark code span opened at `i` (a backtick run of length N): the index just PAST
// the first later run of EXACTLY N backticks. Returns -1 when `i` isn't a span opener — the run is
// backslash-escaped (`` \` `` is a literal backtick, not a fence) or never closes (an unterminated
// run is literal text, not a span). This is the single source of truth for every code-span skip so
// a `</Name>` / generic inside `` `…` `` (including a `` `` ` `` `` double-backtick span) is never
// mistaken for markup, and a lone escaped backtick never swallows the real tag that follows it.
function codeSpanEnd(text: string, i: number): number {
  if (text[i] !== '`') return -1;
  // CommonMark escaping is per-backslash: only an ODD run of backslashes before the backtick escapes
  // it. `\` ` is literal (not a span), but `\\` ` is an escaped backslash then a REAL span opener —
  // checking only text[i-1] would wrongly reject the latter and expose the span's contents to markup.
  let b = 0; while (text[i - 1 - b] === '\\') b++;
  if (b % 2 === 1) return -1;
  let n = 0; while (text[i + n] === '`') n++;
  for (let j = i + n; j < text.length; ) {
    if (text[j] === '`') { let m = 0; while (text[j + m] === '`') m++; if (m === n) return j + m; j += m; }
    else j++;
  }
  return -1;
}

// A `</Name>` closer regex tolerant of structure()'s per-char markdown escaping (`</\_Panel>`,
// `</\$Panel>`), so a custom-name closer is located directly in RAW text and its match offsets
// stay in raw space — no deEscape/offset remapping needed. Iterates code points (astral-safe).
function rawCloserRe(name: string): RegExp {
  const body = [...name].map((c) => '\\\\?' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`</${body}\\s*>`);
}

// Is the OPENER'S OWN attribute span (what scanTag consumed between the tag name and its landing
// `>`) bracket-desynced — the reliable local tell that structure() corrupted the opener? A clean
// opener's attribute span is quote- and bracket-balanced (`mode=\{\{ a }} title="x"`); a lossy one
// is not: structure() markdown-escapes every OPENING bracket (`\{`, `\[`) but leaves closes bare,
// and a dropped string-quote backslash (`"a \" b"` → `"a " b"`) desyncs the quotes so scanTag ends
// early at a fake `>` inside the corrupted attribute, leaving unmatched / mismatched brackets. This
// is a quote-AWARE, TYPE-checked bracket stack over the OPENER span ONLY (never the visible body —
// the caller passes `nameEnd..k`, so a body apostrophe / stray `[` can't misfire, EVE's round-18 &
// round-20 counterexamples). `{`/`[` must close with the matching `}`/`]`; a leftover open bracket,
// a mismatch, or an unterminated quote all mark desync.
function bracketDesync(seg: string): boolean {
  const stack: string[] = [];
  let quote = '';
  for (let m = 0; m < seg.length; m++) {
    let ch = seg[m];
    if (ch === '\\') { ch = seg[m + 1] ?? ''; m++; if (quote) continue; }
    else if (quote) { if (ch === quote) quote = ''; continue; }
    else if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}') { if (stack.pop() !== '{') return true; }
    else if (ch === ']') { if (stack.pop() !== '[') return true; }
  }
  return stack.length !== 0 || quote !== '';
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

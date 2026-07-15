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
  let quote = '', brace = 0, closed = false, selfClose = false, k = j, prevSig = '';
  while (k < text.length) {
    const ch = text[k];
    if (quote) {
      if (ch === '\\') { k += 2; continue; } // escaped char inside a string/template
      if (ch === quote) { quote = ''; prevSig = '"'; } // a closed string is an OPERAND: a following `/` is division, not a regex
      k++; continue;
    }
    // Inside a `{…}` expression, a `/` starts a comment or (when not a division operator) a regex
    // literal whose body can hold literal `}` / `>` (`pattern=\{/\[}>]/}`). Skip those runs so their
    // punctuation can't be mistaken for the expression/tag close — structure() preserves the `{…}`
    // intact, so this stays deterministic. A `/` after an operand (ident / `)` / `]` / `}` — a closed
    // object or block literal, `\{{w:1}/2\}` — or a string) is division, NOT a regex.
    if (brace > 0 && ch === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k + 2); k = e === -1 ? text.length : e + 2; continue; }
    if (brace > 0 && ch === '/' && text[k + 1] === '/') { const e = text.indexOf('\n', k + 2); k = e === -1 ? text.length : e; continue; }
    if (brace > 0 && ch === '/' && !/[\w$)\]}"'`]/.test(prevSig)) {
      let m = k + 1, cls = false;
      for (; m < text.length; m++) { const r = text[m]; if (r === '\\') { m++; continue; } if (r === '[') cls = true; else if (r === ']') cls = false; else if (r === '/' && !cls) break; }
      k = m + 1; prevSig = '/'; continue;
    }
    if (ch === '\\' && /[<>{}[\]]/.test(text[k + 1] ?? '')) { // structure()'s markdown-escaped punctuation
      const p = text[k + 1];
      if (p === '{') brace++; else if (p === '}' && brace > 0) brace--;
      k += 2; prevSig = p; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    else if (ch === '/' && !brace && text[k + 1] === '>') selfClose = true;
    else if (ch === '>' && !brace) { k++; closed = true; break; }
    if (!/\s/.test(ch)) prevSig = ch;
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
  // component within one chunk. A closer pops the NEAREST same-name opener (LOCAL first, then GLOBAL) —
  // real LIFO nesting, never a name-set membership test — so a prior stale generic left on `global`
  // is out-competed by the real flow opener that sits nearer the closer (EVE's `STALEGEN24` →
  // `FLOWINTRO24` case: the lone `</$Panel>` pops the nearer flow, the stale generic stays unpaired
  // → kept). Each global entry records whether it is a DEFINITE flow (a bare/attr opener — a real
  // component) or a TENTATIVE one (a generic-shaped opener that MIGHT be a stale in-body generic):
  // only a DEFINITE same-name flow being open makes a later same-name generic in-body content (so the
  // flow's own closer can't reach past it — EVE's `IDENTGEN23`), while a tentative generic never
  // poisons a subsequent real flow's classification. Code-span aware throughout.
  const global: { name: string; key: string; definite: boolean; generic: boolean }[] = [];
  // Per-name generic-flow budget: a generic-SHAPED opener (`\<$Panel extends X>`) is a real nested
  // flow only if a same-name closer is left over after every NON-generic opener (a real component)
  // has claimed one. STANDALONEKEEP25 (one component + one standalone generic + ONE closer) and its
  // byte-identical nested sibling (SAME openers + TWO closers) are indistinguishable by position
  // under pure LIFO — the surplus closer is the only honest signal. So count `closers − nonGeneric
  // openers` per name; only that many generic-shaped openers may stack as flow, the rest stay prose.
  const closers = new Map<string, number>(), nonGenericOpeners = new Map<string, number>();
  chunks.forEach((text) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '`') { const cs = codeSpanEnd(text, i); if (cs !== -1) { i = cs; continue; } }
      const tag = scanTag(text, i);
      if (!tag) { i++; continue; }
      if (!tag.selfClose) {
        if (tag.closing) closers.set(tag.name, (closers.get(tag.name) ?? 0) + 1);
        else {
          const inner = deEscape(text.slice(tag.lt + 1, tag.closed ? tag.end - 1 : tag.end)).trim();
          if (!(/[\s,=]/.test(inner) && isTsGeneric(inner))) nonGenericOpeners.set(tag.name, (nonGenericOpeners.get(tag.name) ?? 0) + 1);
        }
      }
      i = tag.closed ? tag.end : tag.nameEnd;
    }
  });
  const genericFlowBudget = new Map<string, number>();
  for (const [name, c] of closers) genericFlowBudget.set(name, c - (nonGenericOpeners.get(name) ?? 0));
  chunks.forEach((text, ci) => {
    const local: { name: string; key: string; endsChunk: boolean; definite: boolean; generic: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
      if (text[i] === '`') { const cs = codeSpanEnd(text, i); if (cs !== -1) { i = cs; continue; } }
      const tag = scanTag(text, i);
      if (!tag) { i++; continue; }
      if (!tag.selfClose) {
        if (tag.closing) {
          // A closer pops the TOPMOST same-name opener by true LIFO within ONE stack — LOCAL first (an
          // inline pair closes in its chunk), else GLOBAL. No generic/non-generic preference and no
          // reaching past a nearer same-name opener: which generic-shaped openers are even eligible to
          // stack is already settled at push time by genericFlowBudget, so pairing is pure position.
          const pop = (stack: { name: string; key: string }[]) => {
            for (let s = stack.length - 1; s >= 0; s--) if (stack[s].name === tag.name) { paired.add(stack[s].key); paired.add(`${ci}:${tag.lt}`); stack.splice(s, 1); return true; }
            return false;
          };
          pop(local) || pop(global);
        } else {
          // Classify a leftover opener as one of: DEFINITE flow (a real component — bare `\<$Panel>` or
          // attr'd `\<$Panel a="1">`), a TENTATIVE flow (a generic-SHAPED opener `\<$Panel extends X>` when
          // no same-name flow is open — could be a real generic-shaped flow OR a stale in-body generic; a
          // later closer decides by LIFO nearest-pop), or IN-BODY prose (never stacked — call-glued, or a
          // generic while a DEFINITE same-name flow is already open). No decision keys on whether the
          // opener's `>` ends its chunk (structure() emits both a generic that ends its chunk and a flow
          // opener with trailing intro that way).
          const beforeLt = text.slice(0, tag.esc ? tag.lt - 1 : tag.lt);
          const glued = beforeLt.trim() !== '';
          const inner = deEscape(text.slice(tag.lt + 1, tag.closed ? tag.end - 1 : tag.end)).trim();
          const generic = /[\s,=]/.test(inner) && isTsGeneric(inner);
          const callGlued = /[)\]>]$/.test(beforeLt); // `)`/`]`/`>` before `<` ⇒ a type-argument, never a fresh element
          const lossy = tag.closed ? bracketDesync(text.slice(tag.nameEnd, tag.end)) : !glued;
          const flowOpen = global.some((g) => g.name === tag.name && g.definite) || local.some((l) => l.name === tag.name && l.endsChunk && l.definite);
          const trailing = tag.closed && text.slice(tag.end).trim() !== ''; // content after the opener's `>` in THIS chunk
          // A same-name opener while a DEFINITE flow is open is IN-BODY prose when it is GLUED (a
          // mid-sentence generic, `Box\<$Panel extends IDENTGEN23>`), UNCLOSED (`\<$Panel remains
          // STARTCOMPACT23`, structure() split its `>` away), or a CLOSED generic with more content
          // trailing in its own chunk (`\<$Panel extends GEN22C>() then …` — a real flow opener stands
          // ALONE in its chunk, structure() splits it around the nested heading). A STANDALONE, CLOSED
          // same-name opener is instead a real NESTED flow (`\<$Panel extends INNERATTR24>` on its own
          // line) that must pair by LIFO. `generic` alone never forces in-body — that would swallow a
          // generic-shaped nested flow opener.
          const inBody = callGlued || (flowOpen && (glued || !tag.closed || (generic && trailing)));
          const definite = !generic && !glued && (tag.closed || lossy); // bare/attr'd real component, not generic-shaped
          // A STANDALONE generic-shaped opener stacks as flow only while a same-name closer remains
          // surplus (see genericFlowBudget) — otherwise it is a lone technical generic (no closer of
          // its own) and stays prose so a real component's closer isn't stolen by pure LIFO.
          const genericFlow = !inBody && generic && tag.closed && (genericFlowBudget.get(tag.name) ?? 0) > 0;
          if (genericFlow) genericFlowBudget.set(tag.name, (genericFlowBudget.get(tag.name) ?? 0) - 1);
          const flow = !inBody && (definite || lossy || (generic ? genericFlow : tag.closed));
          // A same-name UNCLOSED in-body generic reads as a JSX opener to the per-chunk grammar (`\<$Panel
          // remains STARTCOMPACT23` = two bare attrs) and would be wrongly stripped by stripComponentResidue,
          // which has no cross-chunk flow context. Record it as a `keep:` position so sanitize preserves it.
          // Closed in-body generics (`\<$Panel extends IDENTGEN23>`, call-glued `factory()\<$Panel<G>>()`) are
          // already kept by sanitize's grammar fallback — don't `keep:` them, that would truncate nested `<…>`.
          if (inBody && !tag.closed) paired.add(`keep:${ci}:${tag.lt}`);
          // In-body prose (a glued/trailing same-name generic while a flow is open) is NOT a pairing
          // candidate — pushing it lets a later same-name closer mis-pop it (LIFO nearest) and leave
          // the real outer flow unpaired (EVE's `LOCALKEEP26`: generic + outer closer share a chunk).
          if (!inBody) local.push({ name: tag.name, key: `${ci}:${tag.lt}`, endsChunk: flow, definite, generic });
        }
      }
      i = tag.closed ? tag.end : tag.nameEnd;
    }
    for (const o of local) if (o.endsChunk) global.push({ name: o.name, key: o.key, definite: o.definite, generic: o.generic });
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
    // A same-name UNCLOSED in-body TS generic that pairResidues recognized as flow-INTERNAL content
    // (`\<$Panel remains STARTCOMPACT23` inside an open same-name flow) — keep it verbatim; the per-chunk
    // grammar below can't see the cross-chunk flow context and would wrongly strip it as a fresh opener.
    if (paired.has(`keep:${chunkIndex}:${lt}`)) { out += deEscape(text.slice(lt)); i = text.length; continue; }
    const glued = out.trim() !== ''; // real prose precedes this `<` in the same chunk
    // A positionally-paired opener whose closer lives in ANOTHER chunk is a genuine cross-chunk FLOW
    // opener residue: structure() split the component around a nested heading, so it
    // emitted the WHOLE opening tag (name + all attributes) as this chunk while body and closer became
    // LATER chunks. `isPaired` (a real `</Name>` residue matched it in another chunk) confirms it, and
    // `closerAfter === -1` confirms NO closer lives in THIS chunk (so it is not a self-contained inline
    // element). Strip ONLY the opener tag, using a boundary from the OPENER'S OWN scan — never the whole
    // chunk's `lastIndexOf('>')`, which eats honest intro that itself contains a `>` (a comparison
    // `\<$Panel>LEFT arr\[i]>0 RIGHT`, a code span `` `arr[i]}>0` ``, a nested-opener intro). For a CLEAN
    // opener scanTag's `>` (`k`) is the real tag end, so strip `[lt, k)` and the visible intro after it
    // survives. A LOSSY opener (structure() dropped an attribute escape, so scanTag stopped at a FAKE early
    // `>` still inside the corrupted `\{…}` expression, `… } > SINGLELEAK", x)}>`) has its REAL end at the
    // attribute expression's structural close GLUED to the tag `>` — a `}>` / `]}>` / `)}>` at/after `k`.
    // That glued close is unambiguous leaked-attribute serialization (structure() escapes opening brackets
    // but leaves closes bare, so an honest intro `>` is a BARE comparison preceded by an alnum/space — `arr\[i]>0`
    // — never a structural close glued to `>`). Searching FROM `k` skips the fake early `>` and stops at the
    // first real glued close, so honest intro AFTER it (including a later code span) survives. This reads
    // only the opener's own serialized residue, never the visible body.
    const closerRe = rawCloserRe(tag.name);
    const closerAfter = text.slice(tag.nameEnd).search(closerRe); // matching `</Name>` (escape-tolerant), offset relative to nameEnd
    if (isPaired && !closing && !selfClose && closerAfter === -1) {
      // A paired cross-chunk FLOW opener (structure() split the component around a nested heading, so the
      // whole opening tag is this chunk and the closer lives LATER). Strip the opener only, deriving the
      // boundary from lossyOpenerEnd's lexical-safe scan of the opener's OWN residue — a clean opener
      // ends at `k` (visible intro survives), a lossy one recovers past the leaked attribute close.
      const gc = lossyOpenerEnd(text, tag.nameEnd, k);
      out += ' '; i = gc === -1 ? k : gc;
      continue;
    }
    // Same recovery when the matching `</Name>` sits LATER IN THIS CHUNK (an inline opener whose close
    // was not split off) — GLUED to prose or at the CHUNK START alike (cross/same-chunk share one path).
    // lossyOpenerEnd handles the UNDER-count / dropped-quote / double-close leaks (scanTag stopped at a
    // fake early `>`); it returns -1 for a clean inline tag AND for the OVER-count swallow case
    // (`items={["a { [ x"]}>` — unbalanced opens so scanTag never closed and ran to end, `k` past the
    // closer). That swallow case can't be reached by a forward-from-`k` scan, so it falls through to the
    // closer-anchored recovery below: re-anchor to the LAST `>` before the in-chunk closer. Gated on the
    // opener span being genuinely desynced so a clean inline tag is left to the grammar classifier.
    if (esc && !closing && !selfClose && closerAfter !== -1) {
      const gc = lossyOpenerEnd(text, tag.nameEnd, k);
      if (gc !== -1) { out += ' '; i = gc; continue; }
      if (!closed || bracketDesync(text.slice(tag.nameEnd, k))) {
        const gt = text.lastIndexOf('>', tag.nameEnd + closerAfter);
        if (gt > tag.nameEnd) { out += ' '; i = gt + 1; continue; }
      }
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

// The single lexical-safe boundary scanner for a same-name FLOW opener whose scanTag `>` (`k`) may be
// FAKE. structure() escapes EVERY opening bracket (`\{`, `\[`) and leaves EVERY close bare, and it can
// drop the backslash of a `\"` inside a string attribute — either way an opener's REAL end can leak
// PAST `k`. Two mutually-exclusive tells over the opener residue (from `nameEnd`) each enable ONE branch
// of a forward scan from `k`; a clean opener trips neither and this returns -1 so `k` stays the boundary
// and the visible intro survives:
//   • QUOTE leak (ODD unescaped `"`) — a dropped `\"` (`title="a \" > X"` → `title="a " > X"`) desyncs
//     the quotes; the string's real close leaks as a `">` glued to the true tag `>`.
//   • BRACKET leak (EVEN `"`) — a `\{…}` attribute expression leaked a close (`value=\{x } > X / 2}>`).
//     A quote-aware bracket count (escaped-open `\{`/`\[` = +1, bare `}`/`]` = −1) going NEGATIVE marks it.
// BOTH the tell pre-count and the forward scan are LEXICALLY SAFE: a regex literal `/…/`, a `/* … */` /
// `// …` comment inside a `{…}` attribute, and a code span `` `…` `` are skipped, so a literal `}` / `]`
// / `>` / quote in `pattern={/[}>]/}` or `x={/* } */ 1}` never miscounts. A DOUBLE structural close
// glued to `>` (`)}>` / `]}>` / `}}>`) is an unambiguous leak in either branch. `}` after a closed
// string / object operand is division, not a regex — matched by regexEnd's operand awareness.
function lossyOpenerEnd(text: string, nameEnd: number, k: number): number {
  const seg = text.slice(nameEnd);
  let sq = '', quoteCount = 0, bnet = 0, bracketLeak = false, prevSig = '';
  for (let m = 0; m < seg.length; m++) {
    const ch = seg[m];
    if (sq) { if (ch === '\\') { m++; continue; } if (ch === '"') quoteCount++; if (ch === sq) { sq = ''; prevSig = '"'; } continue; }
    if (ch === '\\') { const n = seg[m + 1]; if (n === '{' || n === '[') { bnet++; prevSig = n; } m++; continue; } // structure()'s escaped opening bracket
    if (ch === '`') { const cs = codeSpanEnd(seg, m); if (cs !== -1) { m = cs - 1; prevSig = '`'; continue; } }
    if (ch === '/' && seg[m + 1] === '*') { const e = seg.indexOf('*/', m + 2); m = e === -1 ? seg.length : e + 1; continue; }
    if (ch === '/' && seg[m + 1] === '/') { const e = seg.indexOf('\n', m + 2); m = e === -1 ? seg.length : e; continue; }
    if (ch === '/' && !/[\w$)\]}"'`]/.test(prevSig)) { const e = regexEnd(seg, m); if (e !== -1) { m = e - 1; prevSig = '/'; continue; } } // regex only after a non-operand
    if (ch === '"') quoteCount++;
    if (ch === '"' || ch === "'" || ch === '`') { sq = ch; continue; }
    if (ch === '}' || ch === ']') { bnet--; if (bnet < 0) bracketLeak = true; }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  const oddQuote = quoteCount % 2 === 1;
  if (!oddQuote && !bracketLeak) return -1;
  let depth = 0, parity = 0, q = '';
  for (let m = k; m < text.length; m++) {
    const ch = text[m];
    if (ch === '`') { const cs = codeSpanEnd(text, m); if (cs !== -1) { m = cs - 1; continue; } }
    const dbl = /^[)\]}]{2}\s*>/.exec(text.slice(m)); if (dbl) return m + dbl[0].length; // double structural close glued to `>` — unambiguous leak in either branch
    if (ch === '\\') { const n = text[m + 1]; if (n === '{' || n === '[') depth++; m++; continue; }
    if (oddQuote && ch === '"') { const cq = /^"\s*>/.exec(text.slice(m)); if (parity === 0 && cq) return m + cq[0].length; parity ^= 1; continue; }
    if (bracketLeak && q) { if (ch === q) q = ''; continue; }
    if (bracketLeak && (ch === '"' || ch === "'" || ch === '`')) { q = ch; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (bracketLeak && (ch === '}' || ch === ']')) { depth--; const cb = /^[}\]]\s*>/.exec(text.slice(m)); if (depth < 0 && cb) return m + cb[0].length; }
  }
  return -1;
}

// End of a `/…/` regex literal opened at `p` (the `/`), or -1 if it doesn't close on the line. Skips an
// escaped `\/` and a `/` inside a `[…]` char class. Used to keep a regex body's literal `}` / `>` /
// quotes from being counted as structure — mirrors scanTag's own regex skip.
function regexEnd(s: string, p: number): number {
  let cls = false;
  for (let m = p + 1; m < s.length; m++) { const r = s[m]; if (r === '\\') { m++; continue; } if (r === '\n') return -1; if (r === '[') cls = true; else if (r === ']') cls = false; else if (r === '/' && !cls) return m + 1; }
  return -1;
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
// a mismatch, or an unterminated quote all mark desync. Parens are intentionally NOT tracked — a
// regex `/(/` or comment `/* ( */` inside an honest attribute would otherwise read as unbalanced.
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

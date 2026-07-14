import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import type { Nodes } from 'mdast';
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

// structure() serializes a component tag it can't render into a chunk of plain
// text, and — because Fumadocs splits a flow component around any nested heading —
// often into a STANDALONE opening/closing residue that is not valid MDX on its own
// (`\<Tabs items=\{[…]}>`, a lone `</Tabs>`, a `<>` / `</>` fragment boundary). The
// MDX parser throws on those, so they must be removed here, BEFORE the parse, by a
// scanner that deletes ONLY a confirmed component residue and never a searchable
// `<` in prose. The distinction structure() hands us:
//   - A real component tag is escaped (`\<Tabs …>`) only when it carries markdown-
//     significant punctuation, but is ALWAYS one of: a closing tag (`</Name>`), a
//     fragment boundary (`<>` / `</>`), a self-closing tag (`<Name … />`), or an
//     opening tag with attributes. A bare `<T>` / `<version>` placeholder in prose
//     has none of those and is kept verbatim.
//   - A `` `<T>` `` inside a code span, or an `a<b` comparison, is never a tag.
// The scan is code-span, quote, template-literal, brace and entity aware, so a `>`
// hiding inside an attribute string / `{…}` expression / `` `…` `` template can't
// end a tag early, and an encoded quote (`&#34;`) inside an attribute is opaque.
function stripComponentResidue(text: string): string {
  const isNameChar = (c: string | undefined) => !!c && /[A-Za-z0-9._-]/.test(c);
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
    // A tag opener: `<` or escaped `\<`, then optional `/`, then a JSX name start.
    const esc = c === '\\' && text[i + 1] === '<';
    const lt = esc ? i + 1 : i;
    const opensTag = text[lt] === '<' && (text[lt + 1] === '/' ? /[A-Za-z]/.test(text[lt + 2] ?? '') : /[A-Za-z]/.test(text[lt + 1] ?? ''));
    if (!opensTag) { out += c; i++; continue; }
    const closing = text[lt + 1] === '/';
    let j = lt + 1;
    if (closing) j++;
    while (isNameChar(text[j])) j++;
    // Decide JSX element (strip) vs TS-generic / comparison prose (keep) from the char
    // immediately before the logical `<` (before the backslash for an escaped `\<`). A
    // TS generic or an `a<b` comparison is GLUED to a preceding identifier (`Box<T…>`,
    // `f<const T…>`, `Producer<out T…>`, `alpha<beta`); a JSX element's `<` always follows
    // whitespace, a `>`, or the chunk start. A glued opener is therefore never a component
    // — keep it verbatim, with no per-syntax special-casing of modifiers / `extends` /
    // defaults. Only a NON-glued opener can be a component, and it is one iff it carries
    // ANY non-whitespace content after the tag name (anything but `>` / `/>`): that single
    // rule covers spreads, namespaced props, boolean props and newline-broken attributes.
    const glued = isNameChar(text[i - 1]) || (text[i - 1] === '\\' && isNameChar(text[i - 2]));
    // Scan to the terminating `>` at brace depth 0. structure() markdown-escapes the JSX
    // punctuation (`\{`, `\[`, `\<`), so a `\{` counts as a brace; inside a quote / template
    // a `\`-escape hides the next char, so a `\"` / escaped backtick / a `>` hidden in an
    // attribute string / `{…}` expression / `` `…` `` template can't end the tag early.
    // sawContent flags any non-whitespace tag body (an attribute of any shape) — the only
    // thing that turns a non-glued opener into a component.
    let quote = '', brace = 0, closed = false, selfClose = false, sawContent = false;
    let k = j;
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
        sawContent = true; k += 2; continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; sawContent = true; }
      else if (ch === '{') { brace++; sawContent = true; }
      else if (ch === '}' && brace > 0) brace--;
      else if (ch === '/' && !brace && text[k + 1] === '>') selfClose = true;
      else if (ch === '>' && !brace) { k++; closed = true; break; }
      else if (!/\s/.test(ch)) sawContent = true;
      k++;
    }
    // A non-glued opener carrying any attribute is a component; a glued opener is prose.
    const attributed = !glued && sawContent;
    // structure()'s residue serialization is LOSSY inside an attribute string: a JS
    // `\"` loses its backslash while a template's closing backtick gains one (`\``),
    // so quote tracking cannot always find the closing `>`. But an ESCAPED opener
    // (`\<Name …`) is only ever emitted for a split component residue whose body is
    // in OTHER chunks — the whole chunk is markup. So when such an attributed opener
    // fails to close cleanly, fall back to its last `>`. A NON-escaped inline
    // `<Callout title="A > B">inner</Callout>` is kept whole by structure(), tracks
    // cleanly, and keeps its body — it never takes this branch.
    if (!closed && esc && attributed) { const last = text.lastIndexOf('>'); if (last > lt) { k = last + 1; closed = true; } }
    // Delete only a COMPLETE residue that is unambiguously a component: closed, and
    // either a closing tag, self-closing, or an opener that carried attributes. A
    // bare `<Name>` / `<version>` opener with no attributes is a prose placeholder —
    // keep the literal `<` and move on one char.
    if (closed && (closing || selfClose || attributed)) { out += ' '; i = k; continue; }
    out += c; i++;
  }
  return out;
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
export function sanitizeSearchText(input: string): string {
  // stripComponentResidue removes component markup — including HTML comments — with
  // code-span awareness, so a `<!-- … -->` literal inside `` `…` `` survives while a
  // real comment outside code is dropped. It runs on the raw (still entity-encoded)
  // chunk so a `>` hidden in an attribute entity can't end a tag early.
  const cleaned = stripComponentResidue(decodeMarkdownPunctEntities(input));
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
  return {
    id: page.url,
    title: page.data.title ?? '',
    description: page.data.description,
    url: page.url,
    structuredData: {
      headings: structuredData.headings.map((h) => ({ ...h, content: sanitizeSearchText(h.content) })),
      contents: structuredData.contents.map((c) => ({ ...c, content: sanitizeSearchText(c.content) })),
    },
  };
}

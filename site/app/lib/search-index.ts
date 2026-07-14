import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import type { Nodes } from 'mdast';
import type { source } from './source';

type Page = (typeof source)['$inferPage'];

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// Decode the NUMERIC entities fumadocs' structure() emits for markdown
// punctuation (`&#x60;` → `, `&#x2A;` → *) BEFORE the parse, so a decoded `*mcc*`
// is re-read as emphasis instead of surfacing literally. Named entities are left
// alone here: decoding `&quot;` / `&lt;` up front would corrupt JSX attribute
// quoting (`<Callout title="A &quot; > B">`); they're decoded post-parse instead,
// where they're just content characters.
function decodeNumericEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function decodeNamedEntities(input: string): string {
  return input.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => NAMED_ENTITIES[name] ?? name);
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

// structure() serializes a component tag it can't render with markdown escapes —
// `<Tabs items={…}>` comes out as `\<Tabs items=\{…}>`. Under a real MDX parse
// that `\<` is an *escaped literal* `<`, so the tag survives as plain text. Undo
// the escaping on the JSX punctuation set so the tag parses (or, if the chunk is
// a mid-element fragment, is caught by the confirmed-tag fallback below).
function unescapeJsxPunctuation(input: string): string {
  return input.replace(/\\([<>{}[\]])/g, '$1');
}

// Fallback for chunks that aren't valid standalone MDX (a lone `</Step>`, an
// unclosed `<Tabs items={…}>` fragment structure() split off, a bare `<T>` in
// prose that the MDX parser rejects). EVE's requirement: confirm a COMPLETE,
// well-formed tag before deleting anything — never delete on a bare `<` that has
// no closing `>`. So only strip a run that is a real tag: `<`, optional `/`, a
// tag name, then quote/brace/template-aware attributes, then a `>` at brace
// depth 0. An unterminated or non-tag `<` (`a<b && c>d`, `alpha<beta`) is kept
// verbatim, so compact comparisons and TypeScript generics stay searchable.
function stripConfirmedTags(text: string): string {
  const isName = (c: string | undefined) => !!c && /[A-Za-z0-9._-]/.test(c);
  const isAttrStart = (c: string | undefined) => !!c && /[A-Za-z_{>/]/.test(c);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const opensTag = text[i] === '<' && (text[i + 1] === '/' ? /[A-Za-z]/.test(text[i + 2] ?? '') : /[A-Za-z]/.test(text[i + 1] ?? ''));
    if (!opensTag) { out += text[i++]; continue; }
    let j = i + 1;
    if (text[j] === '/') j++;
    while (isName(text[j])) j++;
    // After the tag name the next non-space must continue a tag (an attribute,
    // `>`, or a self-closing `/`). `<b && c>` fails here → kept as prose.
    let k = j;
    while (text[k] === ' ' || text[k] === '\t') k++;
    if (!isAttrStart(text[k])) { out += text[i++]; continue; }
    let quote = '';
    let brace = 0;
    let closed = false;
    while (j < text.length) {
      const ch = text[j];
      if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') brace++;
      else if (ch === '}' && brace > 0) brace--;
      else if (ch === '>' && brace === 0) { j++; closed = true; break; }
      j++;
    }
    if (!closed) { out += text[i++]; continue; } // unterminated → keep literal `<`
    out += ' ';
    i = j;
  }
  return out;
}

// structuredData chunks carry raw markdown (inline-code backticks, **bold**,
// [text](url) links) plus, for content nested in MDX flow components, serialized
// tag residue like `</Step>` / `<Tabs items={…}>`. The previous regex stack
// destroyed technical identifiers — a generic `_…_` emphasis rule stripped the
// underscores out of `MACARON_CODEX_TRANSPORT`, `permission_request`, etc.
//
// Parse the chunk into a real MDX AST (micromark-extension-mdxjs) and read text
// off the nodes, so classification happens in the grammar rather than by guessing
// on flattened text:
//  - CommonMark never treats intraword `_` as emphasis → identifiers survive.
//  - A JSX element (`<Callout title="A > B">inner</Callout>`, `<Tabs items={[…]}>`)
//    is one node: its tag/attrs/expressions contribute no text (a `>` inside an
//    attribute or `{…}` can't leak), while its body children stay searchable.
//  - `{/* … */}` comments and ESM lines are expression/esm nodes → dropped whole.
//  - A code-span generic (`` `<T>` ``) or a compact comparison (`alpha<beta`) is
//    plain text/inlineCode → preserved verbatim.
// A chunk that structure() split mid-element (a lone `</Step>`, a bare `<T>` in
// prose) is not valid MDX and throws; the fallback CommonMark parse + confirmed-
// tag scanner handles those without ever cutting on an unterminated `<`.
export function sanitizeSearchText(input: string): string {
  // HTML comments aren't valid MDX (MDX uses `{/* */}`), and a CommonMark html
  // block swallows the rest of the line — strip them up front so trailing prose
  // survives. Unambiguous delimiters, so no quote/brace bookkeeping needed.
  const decoded = unescapeJsxPunctuation(decodeNumericEntities(input)).replace(/<!--[\s\S]*?-->/g, ' ');
  let text: string;
  try {
    text = nodeText(fromMarkdown(decoded, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] }));
  } catch {
    const commonmark = toString(fromMarkdown(decoded), { includeHtml: false }).replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
    text = stripConfirmedTags(commonmark);
  }
  return decodeNamedEntities(text)
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

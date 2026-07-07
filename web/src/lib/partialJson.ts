// Tolerant partial-JSON helpers for streaming JSON from LLMs.
// - extractPartialCode: pull a single string field from an in-progress blob
//   (Claude streams tool_input as `accumulated`); returns '' until it starts.
// - parseFollowups: parse a streaming JSON array of question strings, dropping
//   any element that isn't a fully-closed string so chips never render half-typed.

import { Allow, parse } from 'partial-json';

export function extractPartialCode(raw: string, field = 'code'): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`);
  const m = re.exec(raw);
  if (!m) return '';
  return m[1]
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}

// partial-json with Allow.ARR completes an unclosed array but drops any element
// that isn't a fully-closed string — so a chip appears only once its question
// is whole, never half-typed. Mirrors free-chat's iterateSuggestion.
// We scan every '[' rather than the first one: the model's reply is relayed
// verbatim, so a non-Anthropic provider may prefix the array with prose that
// itself contains a bracket (a markdown link, a citation) — locking onto the
// first '[' would parse that and permanently yield nothing for the whole turn.
export function parseFollowups(raw: string): string[] {
  for (let i = raw.indexOf('['); i >= 0; i = raw.indexOf('[', i + 1)) {
    try {
      const parsed = parse(raw.slice(i), Allow.ARR);
      if (!Array.isArray(parsed)) continue;
      const items = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 5);
      if (items.length) return items;
    } catch {
      /* not the array's bracket — try the next one */
    }
  }
  return [];
}

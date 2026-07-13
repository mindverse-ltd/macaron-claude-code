import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RENDER_UI_INSTRUCTIONS, RENDER_UI_TOOL_DESCRIPTION } from './macaron-render-tool.js';

// These are prompt-contract tests, not model evals: a live model turn needs a
// configured provider we don't have in CI. They lock the trigger/anti-trigger
// boundaries from EVE's review so a future prompt edit can't silently
// reintroduce the two conflicts (report vs. code/debug text; form vs. binary
// confirmation). The behavioral matrix (3-choice/2-field -> form, research ->
// report, yes-no/code-walkthrough -> text) must be re-run against a real
// provider before relying on runtime behavior.

const both = [RENDER_UI_INSTRUCTIONS, RENDER_UI_TOOL_DESCRIPTION];

test('form trigger requires 3+ options, not binary', () => {
  for (const p of both) assert.match(p, /3\+ discrete options/, 'form trigger must say 3+ options, not 2+');
});

test('binary confirmation stays text', () => {
  for (const p of both) assert.match(p, /binary confirmation/i);
});

test('report trigger is scoped to structured research / data findings', () => {
  for (const p of both) assert.match(p, /structured research|data findings/i);
});

test('code/debug explanation is explicitly text, even multi-section', () => {
  // The overlap EVE flagged: report trigger must not swallow debug/error analysis.
  assert.match(RENDER_UI_INSTRUCTIONS, /error\/failure analysis/i);
  assert.match(RENDER_UI_TOOL_DESCRIPTION, /error\/failure analysis/i);
  assert.match(RENDER_UI_TOOL_DESCRIPTION, /even when it runs long|even when multi-section/i);
});

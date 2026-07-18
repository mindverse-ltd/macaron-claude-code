import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHeader } from '../src/lib/toolHeader';

test('Bash header prefers description over the raw command', () => {
  assert.equal(toolHeader('Bash', { command: 'ls -la', description: 'List files' }), 'List files');
});

test('Bash header falls back to the command when description is missing', () => {
  assert.equal(toolHeader('Bash', { command: 'ls -la' }), 'ls -la');
});

test('Bash header falls back to the command when description is empty', () => {
  assert.equal(toolHeader('Bash', { command: 'ls -la', description: '' }), 'ls -la');
});

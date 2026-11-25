import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { createClaudeModel, DEFAULT_CLAUDE_MODEL } from '../src/claude.js';

function fakeClient(result) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            finalMessage: async () => {
              if (result instanceof Error) throw result;
              return result;
            },
          };
        },
      },
    },
  };
}

test('claude model: Opus 5.5 by default, room for thinking, no temperature, text joined', async () => {
  const client = fakeClient({
    model: DEFAULT_CLAUDE_MODEL,
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '{"a":' },
      { type: 'text', text: '1}' },
    ],
  });
  const m = createClaudeModel({}, { client });
  const out = await m.generate({ system: 'sys', user: 'hi', maxTokens: 700, temperature: 0.4 });
  assert.deepEqual({ text: out.text, model: out.model }, { text: '{"a":1}', model: DEFAULT_CLAUDE_MODEL });
  assert.equal(typeof out.costUsd, 'number', 'each answer carries its Anthropic cost');
  const p = client.calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.max_tokens, 16_000);
  assert.equal(p.temperature, undefined);
  assert.equal(p.thinking, undefined);
  assert.equal(p.fallbacks, 'default');
  assert.equal(p.system, 'sys');
});

test('claude model: a refusal is an error, not empty text', async () => {
  const m = createClaudeModel({}, { client: fakeClient({ model: 'x', stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }) });
  await assert.rejects(m.generate({ user: 'x' }), /declined \(cyber\)/);
});

test('claude model: overload is marked capacity so generateWithPatience retries it', async () => {
  const overloaded = new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error' } }, 'Overloaded', new Headers());
  const m = createClaudeModel({}, { client: fakeClient(overloaded) });
  await assert.rejects(m.generate({ user: 'x' }), (err) => err.kind === 'capacity');
});

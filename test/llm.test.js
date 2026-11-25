import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateWithPatience } from '../src/llm.js';

// A model whose first calls fail with `message`, then answers.
function flaky(failures, message = 'c0mpute: This operation was aborted') {
  let calls = 0;
  return {
    models: ['a', 'b'],
    get calls() {
      return calls;
    },
    async generate() {
      calls++;
      if (calls <= failures) throw new Error(message);
      return { text: 'ok', model: 'b' };
    },
  };
}

test('a timeout that used up the whole patience window is still retried once', async () => {
  const model = flaky(1);
  const out = await generateWithPatience(model, { user: 'x' }, { patienceMs: 0 });
  assert.equal(out.text, 'ok');
  assert.equal(model.calls, 2);
});

test('minAttempts: 1 keeps the old fail-fast behaviour (live call answers)', async () => {
  const model = flaky(1);
  await assert.rejects(generateWithPatience(model, { user: 'x' }, { patienceMs: 0, minAttempts: 1 }), /aborted/);
  assert.equal(model.calls, 1);
});

test('a non-capacity error is never retried', async () => {
  const model = flaky(1, 'bad request');
  await assert.rejects(generateWithPatience(model, { user: 'x' }, { patienceMs: 0 }), /bad request/);
  assert.equal(model.calls, 1);
});

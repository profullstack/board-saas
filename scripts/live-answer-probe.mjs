// Measure how fast a live spoken answer comes back from each fast model (needs ANTHROPIC_API_KEY).
//   node --env-file=<app.env> scripts/live-answer-probe.mjs
import { createClaudeModel } from '../src/claude.js';
import { memberAnswer, quickAnswer } from '../src/qa.js';

const model = createClaudeModel(process.env);
const ctx = { brief: { decision: 'Who should my next hire be?', options: ['A video editor', 'A salesperson', 'No hire yet'], constraints: ['$3,000 a month'] } };
const item = { from: 'Anthony', text: 'What does hiring a video editor do to our cash runway?' };
for (const id of [...model.liveModels, model.models[0]]) {
  const t = Date.now();
  try {
    const out = await quickAnswer({ ...model, liveModels: [id], models: [id] }, { system: 'Answer in at most 3 short spoken sentences.', user: item.text, maxTokens: 300 }, { timeoutMs: 30_000 });
    console.log(`${id}: ${((Date.now() - t) / 1000).toFixed(1)} s -> ${out.text.slice(0, 140)}`);
  } catch (e) {
    console.log(`${id}: FAILED after ${((Date.now() - t) / 1000).toFixed(1)} s: ${e.status ?? ''} ${e.message}`);
  }
}
const t = Date.now();
const a = await memberAnswer(model, 'cfo', item, ctx, { timeoutMs: 20_000 });
console.log(`memberAnswer (cfo persona, default chain): ${((Date.now() - t) / 1000).toFixed(1)} s on ${a.model}: ${a.text}`);

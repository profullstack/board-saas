// The only model we call is c0mpute, through @profullstack/ai-providers' C0mputeProvider
// used directly (no router), so a paid provider cannot be reached by construction: there is
// no OpenAI or Anthropic code path in this app. If c0mpute does not answer, the meeting
// fails with the real error and the credit is returned. We never fake an answer.
import { C0mputeProvider } from '@profullstack/ai-providers';
import { extractJson } from './validate.js';

// The c0mpute CPU house model first: it runs on most nodes, with reasoning off, so it is the
// one that answers when the network is busy. The 9B lives on few nodes and queues behind them.
const DEFAULT_MODELS = [
  'huihui_ai/qwen3.5-abliterated:4b',
  'qwen3:4b',
  'eriktonon/qwen3.8-uncensored:9b',
];

export function createModel(env = process.env) {
  const listed = (env.C0MPUTE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const models = listed.length ? listed : DEFAULT_MODELS;
  const provider = new C0mputeProvider({
    apiKey: env.C0MPUTE_API_KEY,
    baseUrl: env.C0MPUTE_URL || undefined,
    models,
    concurrency: Number(env.C0MPUTE_CONCURRENCY) || 5,
    timeoutMs: Number(env.C0MPUTE_TIMEOUT_MS) || 540_000,
    stallMs: Number(env.C0MPUTE_STALL_MS) || 120_000,
  });
  return {
    name: 'c0mpute',
    models,
    generate: (req) => provider.generate(req),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One text call with patience for the network: a capacity error (no node, Infernet
 * redeploying, a stall) is retried with backoff until `patienceMs` has passed.
 * Anything else is thrown as is.
 */
export async function generateWithPatience(model, req, { patienceMs = 10 * 60_000, log = () => {} } = {}) {
  const started = Date.now();
  let wait = 3_000;
  for (let attempt = 1; ; attempt++) {
    try {
      // After a busy answer, lead with the next model: a different set of nodes serves it.
      const lead = model.models?.length ? model.models[(attempt - 1) % model.models.length] : null;
      return await model.generate(lead ? { ...req, models: { c0mpute: lead } } : req);
    } catch (err) {
      const capacity =
        err?.kind === 'capacity' ||
        err?.status === 503 ||
        err?.status === 504 ||
        /terminated|fetch failed|ECONN|socket|busy|no free node|no node|aborted|timed? ?out/i.test(String(err?.message));
      if (!capacity || Date.now() - started + wait > patienceMs) throw err;
      log(`c0mpute busy (${err?.message ?? err}); retry ${attempt} in ${Math.round(wait / 1000)}s on ${model.models?.[attempt % (model.models?.length || 1)] ?? 'the next node'}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }
}

/**
 * Ask for JSON, validate it, and retry once on bad JSON with the error spelled out.
 * Returns { value, model, raw }. Throws BadJsonError after the retry fails.
 */
export async function askJson(model, { system, user, maxTokens, validate, log = () => {}, patienceMs }) {
  let lastError = '';
  let lastRaw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? user
        : `${user}\n\nYour previous reply could not be used: ${lastError}. Reply again with ONLY the JSON object, no prose, no code fences.`;
    const out = await generateWithPatience(model, { system, user: prompt, maxTokens, temperature: 0.4 }, { log, patienceMs });
    lastRaw = out.text;
    let parsed;
    try {
      parsed = extractJson(out.text);
    } catch (e) {
      lastError = `it was not valid JSON (${e.message})`;
      log(`bad JSON on attempt ${attempt}: ${lastError}`);
      continue;
    }
    const v = validate(parsed);
    if (v.ok) return { value: v.value, model: out.model, raw: out.text };
    lastError = v.error;
    log(`invalid JSON on attempt ${attempt}: ${lastError}`);
  }
  const err = new Error(`the model's JSON was still invalid after one retry: ${lastError}`);
  err.code = 'bad_json';
  err.raw = lastRaw.slice(0, 2000);
  throw err;
}

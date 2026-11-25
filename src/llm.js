// The only model we call is c0mpute, through @profullstack/ai-providers' C0mputeProvider
// used directly (no router), so a paid provider cannot be reached by construction: there is
// no OpenAI or Anthropic code path in this app. If c0mpute does not answer, the meeting
// fails with the real error and the credit is returned. We never fake an answer.
import { C0mputeProvider } from '@profullstack/ai-providers';
import { extractJson } from './validate.js';

// The 9B first, for quality: it answers in about 7-14 s on the network's funded GPU (a Vast RTX
// 3060), and the 4B models gave shallow minutes (a "strongest dissent" that agreed with the
// majority). The 4B CPU house models are the fallback when the 9B is busy or no node serves it.
const DEFAULT_MODELS = [
  'eriktonon/qwen3.8-uncensored:9b',
  'huihui_ai/qwen3.5-abliterated:4b',
  'qwen3:4b',
];

// Two calls at a time by default: the one 9B GPU runs two jobs in parallel (Ollama
// NUM_PARALLEL=2) and also writes OutreachGraph's emails, so five parallel round-1 calls would
// queue behind each other on it, spill onto CPU nodes at minutes per answer, and starve
// OutreachGraph. C0MPUTE_CONCURRENCY overrides it.
const DEFAULT_CONCURRENCY = 2;

export function createModel(env = process.env) {
  const listed = (env.C0MPUTE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const models = listed.length ? listed : DEFAULT_MODELS;
  const provider = new C0mputeProvider({
    apiKey: env.C0MPUTE_API_KEY,
    baseUrl: env.C0MPUTE_URL || undefined,
    models,
    concurrency: Number(env.C0MPUTE_CONCURRENCY) || DEFAULT_CONCURRENCY,
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
 * redeploying, a stall, a timeout) is retried with backoff until `patienceMs` has passed.
 * Anything else is thrown as is.
 *
 * `minAttempts` capacity errors are always retried, whatever the clock says: a call that
 * waited for a local slot and then ran into the provider's own timeout used up the whole
 * patience window in one go, and failing there lost a meeting to a single slow node
 * (miKsO4WDcfvaoF7U, 2026-11-25: ~90 s waiting for a slot + 540 s timeout > 600 s).
 */
export async function generateWithPatience(model, req, { patienceMs = 20 * 60_000, minAttempts = 2, log = () => {} } = {}) {
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
      if (!capacity || (attempt >= minAttempts && Date.now() - started + wait > patienceMs)) throw err;
      log(`c0mpute busy (${err?.message ?? err}); retry ${attempt} in ${Math.round(wait / 1000)}s on ${model.models?.[attempt % (model.models?.length || 1)] ?? 'the next node'}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }
}

const JSON_ATTEMPTS = 3;

/**
 * Ask for JSON, validate it, and retry up to twice on bad JSON with the error spelled out
 * (the 9B misses the shape about one reply in ten, and one retry still lost whole meetings).
 * Returns { value, model, raw }. Throws BadJsonError after the retries fail.
 */
export async function askJson(model, { system, user, maxTokens, validate, log = () => {}, patienceMs }) {
  let lastError = '';
  let lastRaw = '';
  for (let attempt = 1; attempt <= JSON_ATTEMPTS; attempt++) {
    const prompt =
      attempt === 1
        ? user
        : `${user}\n\nYour previous reply could not be used: ${lastError}. Reply again with ONLY the JSON object, no prose, no code fences.`;
    const t0 = Date.now();
    const out = await generateWithPatience(model, { system, user: prompt, maxTokens, temperature: 0.4 }, { log, patienceMs });
    log(`answered by ${out.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    lastRaw = out.text;
    let parsed;
    try {
      parsed = extractJson(out.text);
    } catch (e) {
      lastError = `it was not valid JSON (${e.message})`;
      log(`bad JSON on attempt ${attempt}: ${lastError} tail=${JSON.stringify(out.text.slice(-160))}`);
      continue;
    }
    // On the last attempt validators relax their consistency checks (and label what they can)
    // instead of losing the whole meeting; shape errors still fail.
    const v = validate(parsed, { attempt, final: attempt === JSON_ATTEMPTS });
    if (v.ok) return { value: v.value, model: out.model, raw: out.text };
    lastError = v.error;
    log(`invalid JSON on attempt ${attempt}: ${lastError}`);
  }
  const err = new Error(`the model's JSON was still invalid after ${JSON_ATTEMPTS - 1} retries: ${lastError}`);
  err.code = 'bad_json';
  err.raw = lastRaw.slice(0, 2000);
  throw err;
}

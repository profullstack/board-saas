// Two models. Free meetings (the first meeting per email) run on c0mpute, through
// @profullstack/ai-providers' C0mputeProvider used directly. Paid and admin meetings run on
// Claude Opus 5.5 (Anthropic API) when ANTHROPIC_API_KEY is set (Anthony, 2026-11-25: "claude
// do board meetings in claude with opus5.5", "add c0mpute for free tier"). If Anthropic refuses
// the key or has no credit, a paid meeting finishes on c0mpute rather than failing, and the
// meeting says which model ran it. A meeting no model can finish fails with the real error and
// its credit is returned. We never fake an answer.
import Anthropic from '@anthropic-ai/sdk';
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

export const CLAUDE_MODEL = 'claude-opus-5-5';

/** Anthropic list prices per million tokens (claude-api skill, cached 2026-11-03). */
export const CLAUDE_PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
});

/** What one response cost Anthropic-side, in USD, from its usage block. */
export function claudeCostUsd(usage, model = CLAUDE_MODEL) {
  if (!usage) return 0;
  const p = CLAUDE_PRICES[model] ?? CLAUDE_PRICES[CLAUDE_MODEL];
  const n = (k) => Number(usage[k]) || 0;
  return (n('input_tokens') * p.input + n('output_tokens') * p.output + n('cache_read_input_tokens') * p.cacheRead + n('cache_creation_input_tokens') * p.cacheWrite) / 1e6;
}

/**
 * Claude Opus 5.5 for paid meetings, through the official SDK. Adaptive thinking
 * is on by default on this model and it takes no temperature, so neither is sent;
 * effort is high (the model's default is medium). Server-side refusal fallbacks are
 * on. Each answer carries `usage` and `costUsd` so a meeting can be billed at cost.
 * `fallback` (the c0mpute model) answers when Anthropic refuses the key or has no
 * credit, so a paying customer still gets a meeting; that step costs nothing.
 */
export function createPaidModel(env = process.env, fallback = null, { client = null, log = console.log } = {}) {
  if (!env.ANTHROPIC_API_KEY && !client) return null;
  const model = env.BOARD_PAID_MODEL || CLAUDE_MODEL;
  const anthropic = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: Number(env.ANTHROPIC_TIMEOUT_MS) || 300_000, maxRetries: 2 });
  async function claude(req) {
    let res;
    try {
      res = await anthropic.beta.messages.create({
        model,
        max_tokens: Math.max(16_000, req.maxTokens || 0),
        output_config: { effort: env.BOARD_PAID_EFFORT || 'high' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages?.length ? req.messages : [{ role: 'user', content: req.user }],
      });
    } catch (e) {
      const status = e?.status;
      const billing =
        e instanceof Anthropic.AuthenticationError ||
        e instanceof Anthropic.PermissionDeniedError ||
        (e instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(String(e.message)));
      const capacity =
        e instanceof Anthropic.RateLimitError ||
        e instanceof Anthropic.InternalServerError ||
        e instanceof Anthropic.APIConnectionError ||
        status === 529;
      throw Object.assign(new Error(`Anthropic ${status ?? ''}: ${e?.message ?? e}`.trim()), { status, kind: billing ? 'billing' : capacity ? 'capacity' : 'invalid' });
    }
    if (res.stop_reason === 'refusal') {
      throw Object.assign(new Error(`the model declined this brief (${res.stop_details?.category ?? 'refusal'})`), { kind: 'invalid' });
    }
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const servedBy = res.model || model;
    const costUsd = claudeCostUsd(res.usage, servedBy);
    if (!text.trim()) throw Object.assign(new Error('Anthropic sent back an empty answer'), { kind: 'capacity', costUsd });
    return { text, model: servedBy, usage: res.usage, costUsd };
  }
  return {
    name: 'claude',
    models: [model],
    async generate(req) {
      try {
        return await claude(req);
      } catch (e) {
        if (e.kind === 'billing' && fallback) {
          log(`paid model refused (${e.message}); this step runs on c0mpute instead`);
          const { models: _ignored, ...rest } = req;
          return fallback.generate(rest);
        }
        throw e;
      }
    },
  };
}

/** Wrap a model so every answer's cost is added to `meter` ({ costUsd, calls, models }). */
export function metered(model, meter) {
  if (!model) return model;
  return {
    ...model,
    async generate(req) {
      const out = await model.generate(req);
      meter.calls += 1;
      meter.costUsd += Number(out?.costUsd) || 0;
      if (out?.model) meter.models[out.model] = (meter.models[out.model] || 0) + 1;
      return out;
    },
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

// Board meetings on Claude (Anthropic Messages API). Same shape as the c0mpute model in
// llm.js: { name, models, generate({ system, user, maxTokens }) -> { text, model } }, so
// askJson / generateWithPatience work unchanged. c0mpute stays for free-tier meetings.
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/** Anthropic list prices per million tokens (claude-api skill, cached 2026-11-03). */
export const CLAUDE_PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
});

/** Fast models for spoken Q&A, tried in order before the main model (BOARD_LIVE_MODELS, "off" for none). */
export const DEFAULT_LIVE_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
export function liveModelsFrom(env = process.env) {
  const raw = env.BOARD_LIVE_MODELS;
  if (raw === undefined || raw === '') return DEFAULT_LIVE_MODELS;
  if (/^(off|none|0)$/i.test(raw.trim())) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Server-side refusal fallbacks exist for these; Haiku has none (the request would be refused).
const HAS_FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable)/;

/** What one answer cost at Anthropic, in USD, from its usage block (billed at the model that served it). */
export function claudeCostUsd(usage, model = DEFAULT_CLAUDE_MODEL) {
  if (!usage) return 0;
  const p = CLAUDE_PRICES[model] ?? CLAUDE_PRICES[DEFAULT_CLAUDE_MODEL];
  const n = (k) => Number(usage[k]) || 0;
  return (n('input_tokens') * p.input + n('output_tokens') * p.output + n('cache_read_input_tokens') * p.cacheRead + n('cache_creation_input_tokens') * p.cacheWrite) / 1e6;
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

export function createClaudeModel(env = process.env, { client } = {}) {
  const modelId = env.BOARD_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const effort = env.BOARD_CLAUDE_EFFORT || 'medium';
  const anthropic = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return {
    name: 'claude',
    models: [modelId],
    liveModels: liveModelsFrom(env).filter((m) => m !== modelId),
    async generate(req) {
      try {
        // req.model picks another Claude for this call (the fast live models); req.fast is a
        // spoken answer: low effort, thinking off where the model allows it, no SDK retries
        // (the caller moves on to the next model instead of waiting out a 429).
        const id = req.model || modelId;
        const fast = !!req.fast;
        const thinking = fast && /^claude-haiku-5-5/.test(id) ? { thinking: { type: 'disabled' } } : fast && /^claude-sonnet-5-5/.test(id) ? { thinking: { type: 'between_tools' } } : {};
        const fallbacks = HAS_FALLBACKS.test(id) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {};
        // Thinking is always on for Opus 5.5 and is billed out of max_tokens, so the
        // callers' small output budgets (220-700) would truncate the answer: give it room.
        // Streaming keeps a large max_tokens clear of HTTP timeouts.
        const stream = anthropic.beta.messages.stream(
          {
            model: id,
            max_tokens: fast ? Math.max(2_000, req.maxTokens ?? 0) : Math.max(16_000, req.maxTokens ?? 0),
            output_config: { effort: fast ? 'low' : effort },
            ...thinking,
            ...fallbacks,
            ...(req.system ? { system: req.system } : {}),
            messages: [{ role: 'user', content: req.user }],
          },
          fast ? { maxRetries: 0, ...(req.signal ? { signal: req.signal } : {}) } : req.signal ? { signal: req.signal } : undefined,
        );
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'refusal') {
          const err = new Error(`claude declined (${msg.stop_details?.category ?? 'no category'})`);
          err.code = 'refusal';
          throw err;
        }
        const text = msg.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        // usage + costUsd let a pay-as-you-go meeting be charged at Anthropic cost + 20%.
        return { text, model: msg.model, usage: msg.usage, costUsd: claudeCostUsd(msg.usage, msg.model) };
      } catch (err) {
        // Overload, rate limits, 5xx and dropped connections are worth waiting out:
        // generateWithPatience retries anything marked capacity.
        if (
          err instanceof Anthropic.RateLimitError ||
          err instanceof Anthropic.InternalServerError ||
          err instanceof Anthropic.APIConnectionError ||
          (err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503))
        ) {
          err.kind = 'capacity';
        }
        throw err;
      }
    },
  };
}

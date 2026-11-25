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
});

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
    async generate(req) {
      try {
        // Thinking is always on for Opus 5.5 and is billed out of max_tokens, so the
        // callers' small output budgets (220-700) would truncate the answer: give it room.
        // Streaming keeps a large max_tokens clear of HTTP timeouts.
        const stream = anthropic.beta.messages.stream({
          model: modelId,
          max_tokens: Math.max(16_000, req.maxTokens ?? 0),
          output_config: { effort },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.user }],
        });
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

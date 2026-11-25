// Board meetings on Claude (Anthropic Messages API). Same shape as the c0mpute model in
// llm.js: { name, models, generate({ system, user, maxTokens }) -> { text, model } }, so
// askJson / generateWithPatience work unchanged. c0mpute stays for free-tier meetings.
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

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
        return { text, model: msg.model };
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

// Questions to the board while it meets: who answers, how fast, and who asked.
//
// Live answers have to come back in seconds, so they run on a fast model (BOARD_LIVE_MODELS,
// Haiku then Sonnet by default) with a short timeout and no backoff: a 429 or a slow answer moves
// straight on to the next model. Every model call of a meeting shares one small per-meeting
// limiter, with a slot kept free for live answers, so a meeting can never 429 itself by firing
// five rounds and five answers at once (live 2026-11-25: five parallel answers to one question,
// each retried for minutes, and the founder waited 5-10 minutes and left).
import { EXPERTS, nameOf, persona } from './experts.js';
import { clip } from './speech.js';

export const QA_MODES = Object.freeze(['realtime', 'queued']);

/** 'realtime' (default) or 'queued'; anything else is a 400 at the API. */
export function parseQaMode(v) {
  if (v === undefined || v === null || v === '') return 'realtime';
  const s = String(v).trim().toLowerCase();
  if (!QA_MODES.includes(s)) {
    const e = new Error('qa_mode must be "realtime" or "queued"');
    e.status = 400;
    throw e;
  }
  return s;
}

// ---------------------------------------------------------------- names

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** True for anything that is an id rather than a name: a uuid, a long hex run, a long token. */
export function looksLikeId(s) {
  const t = String(s ?? '').trim();
  if (!t) return true;
  if (UUID.test(t)) return true;
  if (/^[0-9a-f]{12,}$/i.test(t)) return true;
  if (/^[\w-]{16,}$/.test(t) && /\d/.test(t)) return true;
  if (/^(did|user|usr|participant|agent|guest)[:_-][\w:-]+$/i.test(t)) return true;
  return false;
}

/** A display name fit to be spoken, or null. Never returns an id. */
export function safeName(s) {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return t && !looksLikeId(t) ? t : null;
}

/** Whatever text is about to be spoken or written: any uuid left in it becomes "someone". */
export const scrubIds = (text) => String(text ?? '').replace(new RegExp(UUID.source, 'gi'), 'someone');

/** The meeting owner's name from their account: the c0mpute profile name, else a plain email name. */
export function ownerNameOf(acct) {
  if (!acct) return null;
  const c = safeName(acct.c0mpute_name);
  if (c && !/^your c0mpute account$/i.test(c) && !/^did:/i.test(c)) return c;
  const local = String(acct.email ?? '').split('@')[0].split('+')[0];
  if (/@coinpay\.invalid$/i.test(acct.email ?? '') || !/^[a-z]{2,20}$/i.test(local)) return null;
  return local[0].toUpperCase() + local.slice(1).toLowerCase();
}

/**
 * Who a human on the call is, by name. `roster` is PairUX's poll roster (kind=human rows with
 * display_name, and identity/user_id when PairUX exposes them). Order: the roster row whose id
 * matches the LiveKit identity; the only human on the call; the name LiveKit gave, if it is a
 * name; the meeting owner; "the founder".
 */
export function resolveName({ identity, rawName, roster = [], ownerName = null }) {
  const humans = roster.filter((p) => p && (p.kind === undefined || p.kind === 'human'));
  const hit = identity ? humans.find((p) => [p.id, p.identity, p.user_id, p.livekit_identity].includes(identity)) : null;
  const named = (p) => safeName(p?.display_name);
  if (hit && named(hit)) return named(hit);
  const withNames = humans.filter(named);
  if (withNames.length === 1) return named(withNames[0]);
  return safeName(rawName) || safeName(ownerName) || 'the founder';
}

// ---------------------------------------------------------------- routing

const RULES = [
  ['cfo', /\b(cash|money|cost|price|pricing|revenue|margin|runway|budget|afford|profit|burn|payback|roi|invest|fund|spend)|\$/g],
  ['growth', /\b(market|customer|audience|acquisition|growth|channel|brand|launch|sales|funnel|traffic|seo|users?|signups?|content)/g],
  ['operator', /\b(hire|hiring|team|process|system|delegat|ops\b|operation|execut|tool|automat|build|ship|staff)/g],
  ['founder-time', /\b(time|hours|burnout|focus|week|energy|my day|calendar|family|tired|balance)\b/g],
  ['contrarian', /\b(risk|wrong|worst|fail|downside|reverse|alternative|why not|devil|mistake|instead)\b/g],
];
const EVERYONE = /\b(everyone|everybody|all of you|each of you|the board|whole board)\b/;

/** How strongly a question touches each member's ground (count of keyword hits). */
export function scoreMembers(q) {
  const t = String(q).toLowerCase();
  const out = {};
  for (const [id, re] of RULES) out[id] = (t.match(re) ?? []).length;
  return out;
}

/** The old router: a member id or 'all' (kept for the report's routed_to and older callers). */
export function routeByKeywords(q) {
  if (EVERYONE.test(String(q).toLowerCase())) return 'all';
  const s = scoreMembers(q);
  for (const [id] of RULES) if (s[id]) return id;
  return 'all';
}

/**
 * ONE voice answers a live question: the member it touches most (a tie goes to whoever is
 * speaking now), or the chair when it touches nobody or asks the whole board.
 */
export function pickResponder(q, { current = null } = {}) {
  if (EVERYONE.test(String(q).toLowerCase())) return 'chair';
  const s = scoreMembers(q);
  const best = Math.max(...Object.values(s));
  if (!best) return 'chair';
  const tied = Object.keys(s).filter((k) => s[k] === best);
  return tied.includes(current) ? current : tied[0];
}

/** The members a group answer goes round: the ones the question touches (2 to `max`). */
export function relevantMembers(q, { max = 3, min = 2 } = {}) {
  const s = scoreMembers(q);
  const ranked = Object.keys(s)
    .filter((k) => s[k] > 0)
    .sort((a, b) => s[b] - s[a]);
  for (const pad of ['contrarian', 'cfo', 'operator', 'growth', 'founder-time']) if (ranked.length < min && !ranked.includes(pad)) ranked.push(pad);
  return ranked.slice(0, max);
}

/**
 * Queued mode: which waiting question the chair takes now. A host's bump wins, then votes,
 * then relevance to whoever just spoke, then the oldest.
 */
export function pickQuestion(items, { current = null } = {}) {
  const open = items.filter((q) => q.status === 'queued');
  if (!open.length) return null;
  const score = (q) => (q.bumped ? 1e6 + (q.bumped_at ?? 0) / 1e9 : 0) + (q.votes || 0) * 100 + (current ? (scoreMembers(q.text)[current] || 0) * 10 : 0);
  return open.sort((a, b) => score(b) - score(a) || String(a.at).localeCompare(String(b.at)))[0];
}

// ---------------------------------------------------------------- the limiter

/**
 * At most `max` model calls at once for a meeting; board work (rounds) may hold at most
 * max - reserve of them, so a live answer always finds a slot within one call's time. Live
 * waiters go first.
 */
export function createLimiter({ max = 3, reserve = 1 } = {}) {
  let active = 0;
  const waiting = { live: [], board: [] };
  const cap = (lane) => (lane === 'live' ? max : Math.max(1, max - reserve));
  const pump = () => {
    for (const lane of ['live', 'board']) {
      while (waiting[lane].length && active < cap(lane)) {
        active++;
        waiting[lane].shift()();
      }
    }
  };
  return {
    max,
    get active() {
      return active;
    },
    get waiting() {
      return waiting.live.length + waiting.board.length;
    },
    async run(fn, lane = 'board') {
      const l = lane === 'live' ? 'live' : 'board';
      if (active < cap(l) && !waiting.live.length && !(l === 'board' && waiting.board.length)) active++;
      else await new Promise((r) => waiting[l].push(r));
      try {
        return await fn();
      } finally {
        active--;
        pump();
      }
    },
  };
}

/** The same model with every call going through `limiter` in `lane`. */
export function limitedModel(model, limiter, lane = 'board') {
  if (!model || !limiter) return model;
  return { ...model, generate: (req) => limiter.run(() => model.generate(req), lane) };
}

// ---------------------------------------------------------------- fast answers

const strip = (t) => String(t ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

/**
 * One short spoken answer, fast: tries each of model.liveModels then the main model, each with
 * what is left of `timeoutMs`; any error (429, overload, timeout) moves on at once.
 * -> { text, model, ms } or throws the last error.
 */
export async function quickAnswer(model, req, { timeoutMs = 20_000, limiter = null, log = () => {} } = {}) {
  const main = model.models?.[0] ?? null;
  const ids = [...new Set([...(model.liveModels ?? []), main])];
  const t0 = Date.now();
  const until = t0 + timeoutMs;
  let last = null;
  for (let i = 0; i < ids.length; i++) {
    const left = until - Date.now();
    if (left < 1000) break;
    const id = ids[i];
    const isMain = id === main && !(model.liveModels ?? []).includes(id);
    // The fast models get a share of the window so a stall still leaves time for the next one.
    const budget = i < ids.length - 1 ? Math.min(left, Math.round(timeoutMs * 0.4)) : left;
    const ac = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`no answer in ${Math.round(budget / 1000)} s`);
        e.kind = 'timeout';
        ac.abort(e);
        reject(e);
      }, budget);
    });
    try {
      const call = () => model.generate({ ...req, ...(id && !isMain ? { model: id } : {}), fast: true, signal: ac.signal });
      const out = await Promise.race([limiter ? limiter.run(call, 'live') : call(), timeout]);
      const text = strip(out?.text);
      if (!text) throw new Error('empty answer');
      return { ...out, text, model: out?.model ?? id, ms: Date.now() - t0 };
    } catch (e) {
      last = e;
      log(`voice: ${id ?? 'model'} could not answer live (${e?.status ?? ''} ${e?.message ?? e}); ${i < ids.length - 1 ? 'trying the next model' : 'giving up'}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new Error('no model answered in time');
}

const who = (item) => (item.from && item.from !== 'the founder' ? item.from : 'the founder');

function context(ctx) {
  const b = ctx.brief;
  return `The decision: ${b.decision}\nOptions: ${(b.options ?? []).join('; ')}\nConstraints: ${(b.constraints ?? []).join('; ') || 'none stated'}`;
}

/** What `role` says to one question, in at most `sentences` spoken sentences. */
export async function memberAnswer(model, role, item, ctx, { sentences = 3, words = 70, others = null, timeoutMs, limiter, log } = {}) {
  const verdict = role === 'chair' ? null : ctx.verdicts?.find?.((v) => v.expert === role);
  const out = await quickAnswer(
    model,
    {
      system: `${persona(role)}\n\nYou are on a live voice call with ${who(item)} and the rest of the board. Answer in plain spoken English, at most ${sentences} short sentences, no lists, no markdown, no preamble. Speak to ${who(item)} by name at most once.`,
      user: `${context(ctx)}${verdict ? `\nYour verdict so far: ${verdict.call}` : ''}${others ? `\nWhat the others just said:\n${others}` : ''}\n\n${who(item)} asks: ${item.text}\n\nAnswer directly.`,
      maxTokens: 300,
      temperature: 0.4,
    },
    { timeoutMs, limiter, log },
  );
  return { ...out, text: clip(scrubIds(out.text), words) };
}

/**
 * A group answer (queued mode): each relevant member gives one or two sentences, then the chair
 * sums up in one line. The members run in parallel through the limiter's live lane (so at most
 * its size at once). onAnswer(answer) fires in board order as each is ready, so speaking can
 * start before the last one is back. -> { answers: [{expert, text}], summary }
 */
export async function groupAnswer(model, item, ctx, { members = relevantMembers(item.text), timeoutMs = 20_000, limiter = null, log = () => {}, onAnswer = async () => {} } = {}) {
  const jobs = members.map((r) =>
    memberAnswer(model, r, item, ctx, { sentences: 2, words: 45, timeoutMs, limiter, log }).then(
      (a) => ({ expert: r, text: a.text, model: a.model }),
      (e) => ({ expert: r, text: null, error: e.message }),
    ),
  );
  const answers = [];
  for (const j of jobs) {
    const a = await j;
    answers.push(a);
    if (a.text) await onAnswer(a);
  }
  const good = answers.filter((a) => a.text);
  let summary = null;
  if (good.length) {
    try {
      const s = await quickAnswer(
        model,
        {
          system: `${persona('chair')}\n\nYou chair a live voice call. Sum up the board's answer in ONE spoken sentence, plain English, no markdown.`,
          user: `${context(ctx)}\n\n${who(item)} asked: ${item.text}\n\nThe members said:\n${good.map((a) => `${nameOf(a.expert)}: ${a.text}`).join('\n')}\n\nYour one-line summary:`,
          maxTokens: 150,
          temperature: 0.3,
        },
        { timeoutMs: Math.min(timeoutMs, 12_000), limiter, log },
      );
      summary = clip(scrubIds(s.text), 35);
    } catch (e) {
      log(`voice: no summary for the group answer (${e.message})`);
    }
  }
  return { answers, summary };
}

/** The member short names the chair speaks. */
export const SHORT = { chair: 'the chair', cfo: 'CFO', growth: 'Growth', operator: 'Operator', 'founder-time': 'Founder-Time', contrarian: 'Contrarian' };
export const MEMBER_IDS = EXPERTS.map((e) => e.id);

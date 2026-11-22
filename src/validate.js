// Every model answer is JSON, validated per round. Validators return { ok, value, error }:
// value is the cleaned object (trimmed strings, ids normalized), error says what is wrong
// in words the model can act on when it is asked to try again.
import { EXPERT_IDS } from './experts.js';

/** Pull the first JSON object out of a model reply (fences, prose and <think> blocks around it). */
export function extractJson(text) {
  let s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no JSON object in the reply');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('the JSON object is not closed');
}

const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : []);

/** Match "The CFO", "CFO", "founder_time" etc. to a board id. */
export function normalizeId(v) {
  const s = str(v).toLowerCase().replace(/^the\s+/, '').replace(/[_\s]+/g, '-');
  if (EXPERT_IDS.includes(s)) return s;
  if (s.includes('cfo')) return 'cfo';
  if (s.includes('growth')) return 'growth';
  if (s.includes('operator') || s.includes('coo')) return 'operator';
  if (s.includes('founder') || s.includes('time')) return 'founder-time';
  if (s.includes('contrarian') || s.includes('investor')) return 'contrarian';
  return null;
}

const fail = (error) => ({ ok: false, error });

export function validateBriefCheck(o) {
  if (!o || typeof o !== 'object') return fail('reply must be a JSON object');
  const decision = str(o.decision);
  const options = strList(o.options);
  const constraints = strList(o.constraints);
  const missing = strList(o.missing)
    .map((m) => m.toLowerCase())
    .filter((m) => ['decision', 'options', 'constraints'].includes(m));
  if (!decision) missing.includes('decision') || missing.push('decision');
  if (options.length < 2) missing.includes('options') || missing.push('options');
  if (!constraints.length) missing.includes('constraints') || missing.push('constraints');
  return { ok: true, value: { decision, options, constraints, missing: [...new Set(missing)] } };
}

export function validateVerdict(o, expectedId) {
  if (!o || typeof o !== 'object') return fail('reply must be a JSON object');
  const call = str(o.call);
  const reasons = strList(o.reasons);
  const watch_out = str(o.watch_out ?? o.watchOut ?? o['watch-out']);
  if (!call) return fail('"call" is missing or empty');
  if (reasons.length < 2) return fail('"reasons" must be an array of 3 strings');
  if (!watch_out) return fail('"watch_out" is missing or empty');
  return { ok: true, value: { expert: expectedId, call, reasons: reasons.slice(0, 3), watch_out } };
}

function relList(v, self) {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => ({ with: normalizeId(r?.with ?? r?.expert ?? r?.id), why: str(r?.why ?? r?.reason) }))
    .filter((r) => r.with && r.with !== self && r.why);
}

export function validateDebate(o, expectedId) {
  if (!o || typeof o !== 'object') return fail('reply must be a JSON object');
  const position = str(o.position);
  const reply = str(o.reply);
  if (!position) return fail('"position" is missing or empty');
  if (!reply) return fail('"reply" is missing or empty');
  const agrees = relList(o.agrees, expectedId);
  const disagrees = relList(o.disagrees, expectedId);
  const changed_mind = o.changed_mind === true || o.changed_mind === 'true';
  return { ok: true, value: { expert: expectedId, agrees, disagrees, changed_mind, position, reply } };
}

export function validateMinutes(o) {
  if (!o || typeof o !== 'object') return fail('reply must be a JSON object');
  const majority = str(o.majority);
  const recommendation = str(o.recommendation);
  const question = str(o.question);
  const title = str(o.title);
  const clashes = (Array.isArray(o.clashes) ? o.clashes : [])
    .map((c) => ({ topic: str(c?.topic), sides: str(c?.sides), crux: str(c?.crux) }))
    .filter((c) => c.topic && (c.sides || c.crux));
  const dissent = { expert: normalizeId(o.dissent?.expert), argument: str(o.dissent?.argument) };
  if (!majority) return fail('"majority" is missing or empty');
  if (!recommendation) return fail('"recommendation" is missing or empty');
  if (!question) return fail('"question" is missing or empty');
  if (!clashes.length) return fail('"clashes" must list 2 to 4 objects with topic, sides and crux');
  if (!dissent.expert || !dissent.argument) return fail('"dissent" must be {"expert":"<id>","argument":"..."}');
  return { ok: true, value: { title, majority, clashes: clashes.slice(0, 4), dissent, recommendation, question } };
}

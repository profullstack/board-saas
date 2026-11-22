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
  const balanced = balancedObject(s, start);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      /* try the repair below */
    }
  }
  const end = s.lastIndexOf('}');
  if (end > start) {
    try {
      return JSON.parse(repairJson(s.slice(start, end + 1)));
    } catch (e) {
      const closed = closeCleanEnding(s.slice(start));
      if (closed) return closed;
      throw e;
    }
  }
  const closed = closeCleanEnding(s.slice(start));
  if (closed) return closed;
  throw new Error('the JSON object is not closed');
}

/**
 * The 9B sometimes stops right after the last value's final sentence and never writes the
 * closing `"}` (seen live 2026-11-22: `..."watch_out":"... before day one.`). When the open
 * string ends a sentence (. ! ? maybe followed by a closing quote or paren), or the text ends
 * on a complete value, close the string and every open array and object. A reply cut off
 * mid-sentence is still refused.
 */
function closeCleanEnding(s) {
  const body = repairJson(s).trimEnd();
  let inStr = false;
  let esc = false;
  const stack = [];
  for (const c of body) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  if (!stack.length) return null;
  let out = body;
  if (inStr) {
    if (!/[.!?][)'’”]?$/.test(out)) return null;
    out += '"';
  } else if (!/(["\]}\d]|true|false|null)$/.test(out)) return null;
  out += stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function balancedObject(s, start) {
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
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Fix the mistakes small models make in JSON without changing what they said: a double
 * quote inside a string value (escaped when the next non-space character could not follow
 * a closing quote), raw newlines and tabs inside strings, and trailing commas.
 */
export function repairJson(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  let strStart = 0;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === '"') {
        inStr = true;
        strStart = out.length;
      } else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        const want = c === '}' ? '{' : '[';
        if (stack.at(-1) !== want) {
          // "key": inside an array already closed it, or the model closed something never opened.
          if (c === '}' && stack.at(-1) === '[') {
            stack.pop();
            out += ']';
          } else continue;
        }
        stack.pop();
      }
      out += c;
      continue;
    }
    if (esc) {
      esc = false;
      out += c;
    } else if (c === '\\') {
      esc = true;
      out += c;
    } else if (c === '\n') out += '\\n';
    else if (c === '\r') continue;
    else if (c === '\t') out += '\\t';
    else if (c === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = s[j];
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        inStr = false;
        if (next === ':' && stack.at(-1) === '[') {
          // A key inside an array: the model forgot to close the array before it.
          const comma = out.lastIndexOf(',', strStart);
          if (comma >= 0) {
            out = `${out.slice(0, comma)}]${out.slice(comma)}`;
            stack.pop();
          }
        }
        out += c;
      } else out += '\\"';
    } else out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
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

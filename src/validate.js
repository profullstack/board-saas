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

/**
 * Round 1. With ctx.options (the brief's options, two or more) the verdict also names the
 * option its call picks, so round 2 can tell whether a member held or switched.
 */
export function validateVerdict(o, expectedId, { options = [], final = false } = {}) {
  if (!o || typeof o !== 'object') return fail('reply must be a JSON object');
  const call = str(o.call);
  const reasons = splitLabelledReasons(strList(o.reasons));
  const watch_out = str(o.watch_out ?? o.watchOut ?? o['watch-out']);
  if (!call) return fail('"call" is missing or empty');
  if (reasons.length < 2) return fail('"reasons" must be an array of 3 strings');
  if (!watch_out) return fail('"watch_out" is missing or empty');
  const picked = pickOption(o.option, call, options, final, 'call');
  if (picked.error) return fail(picked.error);
  return { ok: true, value: { expert: expectedId, call, option: picked.option, reasons: reasons.slice(0, 3), watch_out } };
}

/** The option a call or position picks: the declared number, else what its words say. */
function pickOption(declaredRaw, text, options, final, what) {
  if (options.length < 2) return { option: null };
  const declared = parseOption(declaredRaw, options);
  const read = inferOption(text, options);
  const option = declared ?? read;
  if (!final) {
    if (option == null) return { error: `"option" must be the number (1-${options.length}) of the option your ${what} picks` };
    if (declared != null && read != null && declared !== read)
      return { error: `your ${what} reads as option ${read} (${options[read - 1]}) but "option" says ${declared} (${options[declared - 1]}); make them agree` };
  }
  return { option };
}

/**
 * The 9B sometimes writes all three framework-labelled reasons into one string ("Document
 * before you delegate: ... Time audit: ... Automate then delegate: ..."), seen live
 * 2026-11-22. Split one string at each sentence end followed by a "Label: " so the words stay
 * the same; anything past the third piece stays with the third.
 */
function splitLabelledReasons(reasons) {
  if (reasons.length !== 1) return reasons;
  const parts = reasons[0].split(/(?<=[.!?])\s+(?=[A-Z][A-Za-z'’ -]{2,40}:\s)/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return reasons;
  return parts.length > 3 ? [parts[0], parts[1], parts.slice(2).join(' ')] : parts;
}

function relList(v, self) {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => ({ with: normalizeId(r?.with ?? r?.expert ?? r?.id), why: str(r?.why ?? r?.reason) }))
    .filter((r) => r.with && r.with !== self && r.why);
}

/**
 * Round 2. ctx = { options, verdict: this member's round-1 verdict, final: last attempt }. A
 * member holds its round-1 option unless it says it changed its mind and names whose argument
 * did it; the Contrarian must steelman the case against the majority. Seen live 2026-11-22
 * (meeting xfUDZiOdvoH3rbvr): the Contrarian went from grandfathering to raising for all with
 * changed_mind:false. On the last attempt an unflagged switch is labelled as a change of mind
 * (changed_mind_inferred) rather than failing the whole meeting.
 */
export function validateDebate(o, expectedId, { options = [], verdict = null, final = false } = {}) {
  if (!o || typeof o !== 'object') return fail('reply must be a JSON object');
  const position = str(o.position);
  const reply = str(o.reply);
  if (!position) return fail('"position" is missing or empty');
  if (!reply) return fail('"reply" is missing or empty');
  const agrees = relList(o.agrees, expectedId);
  const disagrees = relList(o.disagrees, expectedId);
  let changed_mind = o.changed_mind === true || o.changed_mind === 'true';
  const changed_by = parseChangedBy(o.changed_by, expectedId);
  const steelman = str(o.steelman);
  const picked = pickOption(o.option, position, options, final, 'final position');
  if (picked.error) return fail(picked.error);
  const { option } = picked;
  let inferred = false;
  const was = verdict?.option ?? null;
  if (was != null && option != null && option !== was && !changed_mind) {
    if (!final)
      return fail(
        `your round-1 call was option ${was} (${options[was - 1]}): '${verdict.call}'. Your position now picks option ${option} (${options[option - 1]}) but "changed_mind" is false. Either hold option ${was} and restate it as your position, or set "changed_mind" to true and fill "changed_by" with the member whose specific argument changed your mind`,
      );
    changed_mind = true;
    inferred = true;
  }
  if (changed_mind && !changed_by && !inferred && !final)
    return fail(
      '"changed_mind" is true, so "changed_by" must be {"with":"<id of the member whose argument changed your mind>","argument":"<that argument>"}; if nobody changed your mind, set "changed_mind" to false and keep your round-1 call',
    );
  if (expectedId === 'contrarian' && wordCount(steelman) < 10 && !final)
    return fail('"steelman" must be the strongest case against the majority view, at least two sentences, even if you partly agree with the majority');
  const value = { expert: expectedId, agrees, disagrees, changed_mind, position, option, reply };
  if (changed_mind && changed_by) value.changed_by = changed_by;
  if (inferred) value.changed_mind_inferred = true;
  if (steelman) value.steelman = steelman;
  return { ok: true, value };
}

/**
 * The minutes. ctx = { verdicts, debate, options, final }. Every clash names the members on
 * its sides; the dissent comes from a member who argued against the majority (or the
 * Contrarian's steelman when the board is unanimous), quotes that member's own words, and
 * argues their case without leaning back to the majority. Seen live 2026-11-22: empty sides on
 * every clash and a dissent that ended by arguing for the majority.
 */
export function validateMinutes(o, { verdicts = null, debate = null, options = [], final = false } = {}) {
  if (!o || typeof o !== 'object') return fail('reply must be a JSON object');
  const majority = str(o.majority);
  const recommendation = str(o.recommendation);
  const question = str(o.question);
  const title = str(o.title);
  let clashes = (Array.isArray(o.clashes) ? o.clashes : [])
    .map((c) => {
      const sides = sidesText(c?.sides || sidesFromParts(c));
      return { topic: str(c?.topic), sides, crux: str(c?.crux), members: membersMentioned(sides) };
    })
    .filter((c) => c.topic && (c.sides || c.crux));
  const d = o.dissent && typeof o.dissent === 'object' ? o.dissent : {};
  const dissent = { expert: normalizeId(d.expert ?? d.member ?? d.id), quote: str(d.quote), argument: str(d.argument) };
  if (!majority) return fail('"majority" is missing or empty');
  if (!recommendation) return fail('"recommendation" is missing or empty');
  if (!question) return fail('"question" is missing or empty');
  if (!clashes.length) return fail('"clashes" must list 2 to 4 objects with topic, sides and crux');
  const unnamed = clashes.filter((c) => c.members.length < 2);
  if (unnamed.length) {
    if (!final)
      return fail(
        `every clash must fill "sides" with the members on each side, by name, e.g. "The CFO and The Operator vs The Contrarian Investor"; these clashes do not: ${unnamed.map((c) => `'${c.topic}'`).join(', ')}`,
      );
    if (unnamed.length < clashes.length) clashes = clashes.filter((c) => c.members.length >= 2);
  }
  if (!dissent.expert || !dissent.argument) return fail('"dissent" must be {"expert":"<id>","quote":"<their words>","argument":"..."}');
  if (verdicts && debate && !final) {
    const { candidates } = dissentCandidates(verdicts, debate, options);
    if (!candidates.includes(dissent.expert))
      return fail(`the strongest dissent must come from a member who argued against the majority: ${candidates.join(' or ')}. ${dissent.expert} did not`);
    // A missing or paraphrased quote is not worth another model call (a third attempt sat queued
    // on the network for 10+ minutes live): quote the member's own sentence closest to it instead.
    const said = memberWords(dissent.expert, verdicts, debate);
    if (!dissent.quote || !quoteFound(dissent.quote, said)) dissent.quote = closestSentence(`${dissent.quote} ${dissent.argument}`, said) || dissent.quote;
    if (LEANS_BACK.test(dissent.argument))
      return fail(`"dissent.argument" must argue only against the majority, in ${dissent.expert}'s favour: no "however", "that said" or turn back to why the majority is right`);
  }
  if (!dissent.quote) delete dissent.quote;
  return { ok: true, value: { title, majority, clashes: clashes.slice(0, 4), dissent, recommendation, question } };
}

// A concession that turns a dissent back toward the majority.
const LEANS_BACK =
  /\b(however|that said|on the other hand|nevertheless|nonetheless|even so|admittedly|to be fair|in fairness|but if (?:they|it|we|you|customers) (?:stay|stays|work|works|succeed|succeeds|hold|holds))\b/i;

const wordCount = (s) => (str(s).match(/\S+/g) ?? []).length;

/** 2, "2", "Option 2", "2. Raise for all" or the option's own text -> its 1-based number. */
export function parseOption(v, options) {
  if (!options?.length) return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= options.length ? v : null;
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(?:option\s*)?#?(\d+)\b/i);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= options.length ? n : null;
  }
  const t = norm(s);
  const exact = options.findIndex((o) => norm(o) === t);
  if (exact >= 0) return exact + 1;
  const within = options.map((o, i) => (t.includes(norm(o)) ? i + 1 : 0)).filter(Boolean);
  return within.length === 1 ? within[0] : null;
}

const STOP = new Set(['the', 'for', 'and', 'with', 'our', 'your', 'from', 'into', 'that', 'this', 'them', 'they', 'are', 'its']);
const stem = (w) => {
  const s = w.replace(/(ing|ed|es|s|e)$/, '');
  return s.length >= 3 ? s : w;
};
const stems = (text) => new Set(norm(text).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));

/**
 * Which option a sentence picks, read from its words: an option counts only when every content
 * word of it appears and no other option's words all appear too. Returns a 1-based number, or
 * null when the words do not settle it.
 */
export function inferOption(text, options) {
  if (!options?.length) return null;
  const have = stems(text);
  const full = options
    .map((o, i) => ({ i, want: [...stems(o)] }))
    .filter((x) => x.want.length && x.want.every((w) => have.has(w)));
  return full.length === 1 ? full[0].i + 1 : null;
}

/** Members per option; majority = the most-picked option when it is a strict plurality. */
export function tallyOptions(rows) {
  const by = new Map();
  for (const r of rows) if (r?.option != null) by.set(r.option, [...(by.get(r.option) ?? []), r.expert]);
  const sorted = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  const majority = sorted.length && (sorted.length === 1 || sorted[0][1].length > sorted[1][1].length) ? sorted[0][0] : null;
  return { by, majority };
}

/**
 * Who may carry the strongest dissent: members whose final option differs from the final
 * majority; failing that, members who started against it in round 1; failing that (a unanimous
 * board), the Contrarian, whose round 2 steelmans the other side.
 */
export function dissentCandidates(verdicts, debate, options = []) {
  const all = { majority: null, candidates: EXPERT_IDS.slice() };
  if (options.length < 2) return all;
  const { majority } = tallyOptions(debate);
  if (majority == null) return all;
  const finalAgainst = debate.filter((d) => d.option != null && d.option !== majority).map((d) => d.expert);
  if (finalAgainst.length) return { majority, candidates: finalAgainst };
  const startedAgainst = verdicts.filter((v) => v.option != null && v.option !== majority).map((v) => v.expert);
  if (startedAgainst.length) return { majority, candidates: startedAgainst };
  return { majority, candidates: ['contrarian'] };
}

function memberWords(id, verdicts, debate) {
  const v = verdicts.find((x) => x.expert === id) ?? {};
  const d = debate.find((x) => x.expert === id) ?? {};
  return [v.call, ...(v.reasons ?? []), v.watch_out, d.reply, d.position, d.steelman, ...(d.agrees ?? []).map((a) => a.why), ...(d.disagrees ?? []).map((a) => a.why)]
    .filter(Boolean)
    .join(' \n ');
}

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9$%' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sentence of `source` sharing the most words with `text` (at least four words long). */
export function closestSentence(text, source) {
  const want = new Set(norm(text).split(' ').filter((w) => w.length > 3));
  let best = '';
  let score = -1;
  for (const raw of String(source ?? '').split(/(?<=[.!?])\s+|\s*\n\s*/)) {
    const sent = raw.trim();
    const words = norm(sent).split(' ').filter(Boolean);
    if (words.length < 4) continue;
    const hit = words.filter((w) => want.has(w)).length;
    if (hit > score) {
      score = hit;
      best = sent;
    }
  }
  return best;
}

/** A quote counts when it is four words or more and most of its three-word runs appear in the source. */
export function quoteFound(quote, source) {
  const q = norm(quote).split(' ').filter(Boolean);
  if (q.length < 4) return false;
  const src = norm(source);
  if (src.includes(q.join(' '))) return true;
  const grams = q.length - 2;
  let hit = 0;
  for (let i = 0; i < grams; i++) if (src.includes(q.slice(i, i + 3).join(' '))) hit++;
  return hit / grams >= 0.7;
}

const MEMBER_PATTERNS = [
  ['cfo', /\bcfo\b/],
  ['growth', /\bgrowth\b/],
  ['operator', /\b(operator|coo)\b/],
  ['founder-time', /\bfounder[- ]time\b|\btime strategist\b/],
  ['contrarian', /\bcontrarian\b/],
];

/** Board members a sentence names ("The CFO and Growth vs the Contrarian" -> cfo, growth, contrarian). */
export function membersMentioned(text) {
  const t = String(text ?? '').toLowerCase();
  return MEMBER_PATTERNS.filter(([, re]) => re.test(t)).map(([id]) => id);
}

const NAMES = { cfo: 'The CFO', growth: 'The Growth Marketer', operator: 'The Operator', 'founder-time': 'The Founder-Time Strategist', contrarian: 'The Contrarian Investor' };
// Only a bare name or id is mapped; a longer phrase ("CFO and Operator want X") stays as written.
const memberName = (v) => {
  const s = str(v);
  return s.split(/\s+/).length <= 4 ? (NAMES[normalizeId(s)] ?? s) : s;
};
const group = (g) => (Array.isArray(g) ? g.map(memberName).filter(Boolean).join(' and ') : memberName(g));

/** "sides" as a string, a list of groups or {for:[...], against:[...]} -> one readable string. */
function sidesText(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(group).filter(Boolean).join(' vs ');
  if (v && typeof v === 'object') return Object.values(v).map(group).filter(Boolean).join(' vs ');
  return '';
}
function sidesFromParts(c) {
  if (c?.side_a || c?.side_b) return [c.side_a, c.side_b].filter(Boolean);
  if (c?.for || c?.against) return [c.for, c.against].filter(Boolean);
  return '';
}

function parseChangedBy(v, self) {
  if (!v) return null;
  if (typeof v === 'string') {
    const i = v.indexOf(':');
    const id = normalizeId(i >= 0 ? v.slice(0, i) : v);
    const argument = i >= 0 ? v.slice(i + 1).trim() : '';
    return id && id !== self && argument ? { with: id, argument } : null;
  }
  if (typeof v !== 'object') return null;
  const id = normalizeId(v.with ?? v.expert ?? v.member ?? v.id);
  const argument = str(v.argument ?? v.why ?? v.reason);
  return id && id !== self && argument ? { with: id, argument } : null;
}

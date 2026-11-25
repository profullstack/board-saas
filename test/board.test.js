import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { signWebhook } from '@profullstack/coinpay-onboard';
import { BoardClient } from '../src/client.js';
import { openDb } from '../src/db.js';
import { createMcpHandler } from '../src/mcp.js';
import { renderReport } from '../src/render-report.js';
import { createApp } from '../src/server.js';
import { extractJson, normalizeId, validateDebate, validateMinutes, validateVerdict } from '../src/validate.js';
import { persona } from '../src/experts.js';
import { view } from '../src/tui.js';

const fixture = JSON.parse(readFileSync(new URL('./fixture-meeting.json', import.meta.url), 'utf8'));

/** A fake c0mpute that answers each round from the fixture. `bad` = how many bad replies to give first. */
function fakeModel({ bad = 0, missing = [], fail = null } = {}) {
  let badLeft = bad;
  const calls = [];
  return {
    calls,
    async generate(req) {
      calls.push(req);
      if (fail) throw Object.assign(new Error(fail), { kind: 'invalid' });
      if (badLeft > 0) {
        badLeft--;
        return { text: 'Sure! Here is my verdict: the CFO thinks', model: 'fake' };
      }
      const u = req.user;
      if (u.includes('pull out the three things')) {
        return { text: JSON.stringify({ decision: 'Next hire', options: missing.includes('options') ? [] : ['A', 'B'], constraints: missing.includes('constraints') && !u.includes('answered') ? [] : ['$25/mo'], missing: u.includes('answered') ? [] : missing }), model: 'fake' };
      }
      const id = (u.match(/"expert":"([a-z-]+)"/) ?? [])[1];
      if (u.includes('Board meeting, round 3')) {
        const { vote, ...rest } = fixture.minutes;
        // A unanimous board (everyone picked option 1), so the dissent quotes the Contrarian.
        const quote = fixture.verdicts.find((v) => v.expert === 'contrarian').call.split(' ').slice(0, 9).join(' ');
        return { text: JSON.stringify({ title: fixture.title, ...rest, dissent: { ...rest.dissent, quote } }), model: 'fake' };
      }
      if (u.includes('Board meeting, round 1')) return { text: '```json\n' + JSON.stringify({ ...fixture.verdicts.find((v) => v.expert === id), option: 1 }) + '\n```', model: 'fake' };
      if (u.includes('Board meeting, round 2')) {
        const d = { ...fixture.debate.find((v) => v.expert === id), option: 1 };
        if (d.changed_mind) d.changed_by = { with: id === 'growth' ? 'cfo' : 'growth', argument: 'run the test now, not after an audit' };
        if (id === 'contrarian') d.steelman = 'Waiting has a cost too. A two-week test this small proves nothing about a $240K plan, so the board may be buying false confidence.';
        return { text: '<think>hmm</think>' + JSON.stringify(d), model: 'fake' };
      }
      throw new Error('unexpected prompt');
    },
  };
}

async function start(opts = {}) {
  const mails = [];
  const env = { BOARD_SAAS_ADMIN_KEY: 'admin-secret', COINPAY_WEBHOOK_SECRET: 'whsec_test', PUBLIC_URL: 'http://local', ...opts.env };
  const model = opts.model ?? fakeModel();
  const app = createApp({ env, db: openDb(':memory:'), model, freeModel: opts.freeModel, c0mpute: opts.c0mpute, mailer: async (m) => mails.push(m), log: process.env.DEBUG ? console.log : () => {} });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  };
  const waitDone = async (id) => {
    for (let i = 0; i < 200; i++) {
      const r = await call('GET', `/api/v1/meetings/${id}`, undefined, 'admin-secret');
      if (!['queued', 'checking', 'running'].includes(r.json.status)) return r.json;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error('timeout');
  };
  return { app, server, base, call, mails, model, waitDone, close: () => server.close() };
}

test('extractJson handles fences, think blocks and prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('<think>{"no":1}</think> ok {"a":"}"} trailing'), { a: '}' });
  assert.throws(() => extractJson('nothing here'));
});

test('extractJson repairs inner quotes, raw newlines and trailing commas', () => {
  const raw = '{"expert":"operator","call":"Sell the "5-pack" first","reasons":["Document before you delegate: the "pack" is repeatable","b\nc",],"watch_out":"x"}';
  const o = extractJson(raw);
  assert.equal(o.call, 'Sell the "5-pack" first');
  assert.equal(o.reasons.length, 2);
  assert.equal(o.reasons[1], 'b\nc');
  // A small model forgot to close "reasons" and put watch_out inside it (seen live on c0mpute).
  const unclosed = '{"expert":"growth","call":"c","reasons":["r1 ’x’","r2","r3","watch_out":"w"]}';
  assert.deepEqual(extractJson(unclosed), { expert: 'growth', call: 'c', reasons: ['r1 ’x’', 'r2', 'r3'], watch_out: 'w' });
});

test('extractJson closes a reply that stopped cleanly before its closing "} (the 9B, seen live)', () => {
  const stopped = '{"expert":"operator","call":"Raise prices.","reasons":["a","b","c"],"watch_out":"Write the objection checklist before day one.';
  assert.deepEqual(extractJson(stopped), { expert: 'operator', call: 'Raise prices.', reasons: ['a', 'b', 'c'], watch_out: 'Write the objection checklist before day one.' });
  assert.deepEqual(extractJson('{"a":{"b":["x","y"]'), { a: { b: ['x', 'y'] } });
  // Cut off mid-sentence or mid-value: still refused, so the model is asked again.
  assert.throws(() => extractJson('{"expert":"operator","watch_out":"Write the objection'), /not closed/);
  assert.throws(() => extractJson('{"expert":"operator","reasons":["a",'), /not closed/);
});

test('validateVerdict splits three labelled reasons written into one string (the 9B, seen live)', () => {
  const v = validateVerdict(
    { call: 'c', reasons: ['Document before you delegate: write the policy. Time audit: 40% of revenue is old customers. Automate then delegate: self-serve annual plan.'], watch_out: 'w' },
    'operator',
  );
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.reasons, ['Document before you delegate: write the policy.', 'Time audit: 40% of revenue is old customers.', 'Automate then delegate: self-serve annual plan.']);
  assert.equal(validateVerdict({ call: 'c', reasons: ['Just one reason, no labels. Another sentence.'], watch_out: 'w' }, 'cfo').ok, false);
});

test('validators normalize ids and reject missing fields', () => {
  assert.equal(normalizeId('The CFO'), 'cfo');
  assert.equal(normalizeId('founder_time'), 'founder-time');
  assert.equal(validateVerdict({ call: 'x', reasons: ['a', 'b', 'c'] }, 'cfo').ok, false);
  const d = validateDebate({ position: 'p', reply: 'r', agrees: [{ with: 'The Operator', why: 'y' }, { with: 'cfo', why: 'self' }] }, 'cfo');
  assert.deepEqual(d.value.agrees, [{ with: 'operator', why: 'y' }]);
  assert.equal(validateMinutes({ majority: 'm', recommendation: 'r', question: 'q', clashes: [], dissent: {} }).ok, false);
});

// The live 9B meeting xfUDZiOdvoH3rbvr (2026-11-22): a price-rise brief with an obvious majority.
const PRICE_OPTIONS = ['Raise for all', 'Raise for new only', 'Keep prices'];
const priceVerdicts = [
  { expert: 'cfo', call: 'Raise prices on all existing customers immediately with 60 days notice.', option: 1, reasons: ['a', 'b'], watch_out: 'w' },
  { expert: 'growth', call: 'Raise prices on all existing customers with a 60-day notice.', option: 1, reasons: ['a', 'b'], watch_out: 'w' },
  { expert: 'operator', call: 'Raise prices on all existing customers with a 60-day notice period.', option: 1, reasons: ['a', 'b'], watch_out: 'w' },
  { expert: 'founder-time', call: 'Raise the price for all existing customers, grandfathering none.', option: 1, reasons: ['a', 'b'], watch_out: 'w' },
  {
    expert: 'contrarian',
    call: 'Grandfather existing customers while raising prices only on new signups.',
    option: 2,
    reasons: ['Inversion: long-tenured customers are the most price-sensitive cohort', 'b'],
    watch_out: 'losing the 40% legacy revenue in a single month with 4 months of runway',
  },
];

test('options: parsed from numbers and text, inferred from words only when unambiguous', async () => {
  const { parseOption, inferOption, tallyOptions } = await import('../src/validate.js');
  assert.equal(parseOption(2, PRICE_OPTIONS), 2);
  assert.equal(parseOption('Option 3', PRICE_OPTIONS), 3);
  assert.equal(parseOption('raise for new only', PRICE_OPTIONS), 2);
  assert.equal(parseOption(7, PRICE_OPTIONS), null);
  assert.equal(inferOption('Grandfather existing customers while raising prices only on new signups.', PRICE_OPTIONS), 2);
  assert.equal(inferOption('Raise prices on all existing customers with a 60-day notice period, grandfathering none.', PRICE_OPTIONS), 1);
  assert.equal(inferOption('Raise prices only for new signups, never raise for all existing customers.', PRICE_OPTIONS), null);
  assert.deepEqual(tallyOptions(priceVerdicts).majority, 1);
  assert.equal(tallyOptions([{ expert: 'cfo', option: 1 }, { expert: 'growth', option: 2 }]).majority, null);
});

test('round 1 must name an option that matches its call', () => {
  const base = { call: 'Raise prices on all existing customers now.', reasons: ['a', 'b', 'c'], watch_out: 'w' };
  assert.equal(validateVerdict({ ...base, option: 1 }, 'cfo', { options: PRICE_OPTIONS }).value.option, 1);
  assert.equal(validateVerdict(base, 'cfo', { options: PRICE_OPTIONS }).value.option, 1, 'inferred from the words');
  const wrong = validateVerdict({ ...base, option: 3 }, 'cfo', { options: PRICE_OPTIONS });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /reads as option 1/);
  assert.equal(validateVerdict({ ...base, call: 'Do what feels right.' }, 'cfo', { options: PRICE_OPTIONS }).ok, false);
  assert.equal(validateVerdict({ ...base, call: 'Do what feels right.' }, 'cfo', { options: PRICE_OPTIONS, final: true }).value.option, null);
});

test('round 2: switching options with changed_mind:false is sent back with a correction (the live Contrarian)', () => {
  const ctx = { options: PRICE_OPTIONS, verdict: priceVerdicts[4] };
  const flip = {
    position: 'Raise prices on all existing customers with a 60-day notice period, grandfathering none.',
    option: 1,
    changed_mind: false,
    reply: 'r',
    steelman: 'Legacy customers are 40% of revenue. One bad month of churn ends the company with 4 months of runway left.',
  };
  const r = validateDebate(flip, 'contrarian', ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /round-1 call was option 2 \(Raise for new only\)/);
  assert.match(r.error, /changed_by/);
  // A switch that lies about its option number is caught by its words.
  assert.match(validateDebate({ ...flip, option: 2 }, 'contrarian', ctx).error, /reads as option 1/);
  // changed_mind true needs the member whose argument did it.
  assert.match(validateDebate({ ...flip, changed_mind: true }, 'contrarian', ctx).error, /"changed_by" must be/);
  const ok = validateDebate({ ...flip, changed_mind: true, changed_by: { with: 'The CFO', argument: 'grandfathering is a permanent fixed cost' } }, 'contrarian', ctx);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.value.changed_by, { with: 'cfo', argument: 'grandfathering is a permanent fixed cost' });
  // Holding is fine; on the last attempt an unflagged switch is labelled, not lost.
  assert.equal(validateDebate({ ...flip, position: priceVerdicts[4].call, option: 2 }, 'contrarian', ctx).ok, true);
  const last = validateDebate(flip, 'contrarian', { ...ctx, final: true });
  assert.equal(last.value.changed_mind, true);
  assert.equal(last.value.changed_mind_inferred, true);
});

test('round 2: the Contrarian must steelman the case against the majority', () => {
  const ctx = { options: PRICE_OPTIONS, verdict: priceVerdicts[4] };
  const hold = { position: priceVerdicts[4].call, option: 2, changed_mind: false, reply: 'r' };
  assert.match(validateDebate(hold, 'contrarian', ctx).error, /"steelman"/);
  assert.equal(validateDebate(hold, 'contrarian', { ...ctx, final: true }).ok, true);
  assert.equal(validateDebate({ ...hold, position: priceVerdicts[0].call, option: 1 }, 'cfo', { options: PRICE_OPTIONS, verdict: priceVerdicts[0] }).ok, true, 'others need none');
});

test('minutes: every clash names its sides; the dissent argues against the majority in its own words', () => {
  const debate = priceVerdicts.map((v) => ({ expert: v.expert, position: v.call, option: v.option, changed_mind: false, reply: 'r', agrees: [], disagrees: [] }));
  debate[4].steelman = 'Legacy customers are 40% of revenue and one bad month of churn ends the company.';
  const ctx = { verdicts: priceVerdicts, debate, options: PRICE_OPTIONS };
  const good = {
    title: 't',
    majority: 'Raise for all with 60 days notice.',
    recommendation: 'r',
    question: 'q',
    clashes: [
      { topic: 'Grandfathering', sides: 'The CFO, Growth and the Operator vs the Contrarian', crux: 'c' },
      { topic: 'Notice', sides: { for: ['cfo', 'operator'], against: ['founder-time'] }, crux: 'c' },
    ],
    dissent: { expert: 'contrarian', quote: 'long-tenured customers are the most price-sensitive cohort', argument: 'With 4 months of runway, losing the 40% legacy revenue is fatal; grandfather them.' },
  };
  const ok = validateMinutes(good, ctx);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.value.clashes[1].sides, 'The CFO and The Operator vs The Founder-Time Strategist');
  assert.deepEqual(ok.value.clashes[0].members, ['cfo', 'growth', 'operator', 'contrarian']);

  // The live minutes: empty sides on every clash.
  const empty = validateMinutes({ ...good, clashes: good.clashes.map((c) => ({ ...c, sides: '' })) }, ctx);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /every clash must fill "sides"/);
  // The live dissent leaned back to the majority.
  const leaning = validateMinutes({ ...good, dissent: { ...good.dissent, argument: 'If 40% churns we lose them entirely, but if they stay we prove demand.' } }, ctx);
  assert.match(leaning.error, /argue only against the majority/);
  assert.match(validateMinutes({ ...good, dissent: { ...good.dissent, argument: 'Legacy churn could hurt. However, raising for all is right.' } }, ctx).error, /argue only against/);
  // From a majority member, or paraphrased instead of quoted.
  assert.match(validateMinutes({ ...good, dissent: { ...good.dissent, expert: 'cfo' } }, ctx).error, /must come from a member who argued against the majority: contrarian/);
  // A paraphrased or missing quote is replaced by the member's closest real sentence (no retry).
  const para = validateMinutes({ ...good, dissent: { ...good.dissent, quote: 'old customers hate price rises a lot' } }, ctx);
  assert.equal(para.ok, true);
  assert.notEqual(para.value.dissent.quote, 'old customers hate price rises a lot');
  assert.ok(para.value.dissent.quote.split(' ').length >= 4);
  const none = validateMinutes({ ...good, dissent: { expert: 'contrarian', argument: 'legacy customers churn when prices rise' } }, ctx);
  assert.equal(none.ok, true);
  assert.ok(none.value.dissent.quote);
  // Last attempt: keep the clashes that name sides rather than lose the meeting.
  const last = validateMinutes({ ...good, clashes: [good.clashes[0], { topic: 'x', sides: '', crux: 'c' }] }, { ...ctx, final: true });
  assert.equal(last.value.clashes.length, 1);
});

test('dissent candidates: final minority, else round-1 minority, else the Contrarian', async () => {
  const { dissentCandidates } = await import('../src/validate.js');
  const d = (opts) => opts.map((option, i) => ({ expert: priceVerdicts[i].expert, option }));
  assert.deepEqual(dissentCandidates(priceVerdicts, d([1, 1, 3, 1, 2]), PRICE_OPTIONS).candidates, ['operator', 'contrarian']);
  assert.deepEqual(dissentCandidates(priceVerdicts, d([1, 1, 1, 1, 1]), PRICE_OPTIONS).candidates, ['contrarian'], 'started against');
  const allOne = priceVerdicts.map((v) => ({ ...v, option: 1 }));
  assert.deepEqual(dissentCandidates(allOne, d([1, 1, 1, 1, 1]), PRICE_OPTIONS).candidates, ['contrarian'], 'unanimous');
  assert.equal(dissentCandidates(priceVerdicts, d([1, 1, 1, 1, 1]), []).candidates.length, 5);
});

test('round prompts carry the round-1 call, the steelman duty and the named-sides rule', async () => {
  const { round2Prompt, round3Prompt } = await import('../src/meeting.js');
  const b = { text: 't', decision: 'd', options: PRICE_OPTIONS, constraints: ['4 months runway'] };
  const p2 = round2Prompt(b, { id: 'contrarian' }, priceVerdicts);
  assert.match(p2, /Your round-1 call was: 'Grandfather existing customers/);
  assert.match(p2, /option 2 \(Raise for new only\)/);
  assert.match(p2, /round-1 majority picked option 1 \(Raise for all\)/);
  assert.match(p2, /"steelman"/);
  assert.doesNotMatch(round2Prompt(b, { id: 'cfo' }, priceVerdicts), /"steelman"/);
  assert.match(p2, /"changed_mind":<true or false>/);
  const debate = priceVerdicts.map((v) => ({ expert: v.expert, position: v.call, option: v.option, changed_mind: false, reply: 'r', agrees: [], disagrees: [] }));
  const p3 = round3Prompt(b, priceVerdicts, debate);
  assert.match(p3, /The dissent must come from contrarian/);
  assert.match(p3, /Never leave "sides" empty/);
  assert.match(p3, /Final tally by option: option 1 \(Raise for all\): cfo, growth, operator, founder-time \/ option 2/);
});

test('personas are the boardroom skill texts without frontmatter', () => {
  assert.match(persona('cfo'), /^# The CFO/);
  assert.match(persona('chair'), /^# The Chair/);
  assert.match(persona('chair'), /The one question/);
  assert.doesNotMatch(persona('chair'), /Report data|"verdicts"/);
});

test('report renders the fixture with tabs, debate and copy button', () => {
  const html = renderReport(fixture);
  assert.match(html, /role="tablist"/);
  assert.match(html, /Copy recommendation/);
  assert.match(html, /not real directors/);
});

test('free meeting end to end: code, key, meeting, report, then 402 checkout', async () => {
  const t = await start();
  try {
    let r = await t.call('POST', '/api/v1/auth/code', { email: 'Founder@Example.com' });
    assert.equal(r.status, 200);
    const code = t.mails[0].subject.match(/(\d{6})/)[1];
    assert.match(t.mails[0].html, /network|Profullstack|pit/i);
    r = await t.call('POST', '/api/v1/auth/verify', { email: 'founder@example.com', code: '000000' === code ? '111111' : '000000' });
    assert.equal(r.status, 401);
    r = await t.call('POST', '/api/v1/auth/verify', { email: 'founder@example.com', code });
    assert.equal(r.status, 200);
    const key = r.json.api_key;
    assert.match(key, /^bsk_/);
    assert.equal(r.json.account.free_meeting_available, true);

    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, key);
    assert.equal(r.status, 201);
    const done = await t.waitDone(r.json.id);
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.meeting.verdicts.length, 5);
    assert.equal(done.meeting.debate.length, 5);
    assert.equal(done.meeting.minutes.vote.length, 5);
    assert.equal(t.model.calls.length, 1 + 5 + 5 + 1);
    // Round 1 prompts contain only the brief, never another member's answer.
    const r1 = t.model.calls.filter((c) => c.user.includes('round 1'));
    for (const c of r1) assert.doesNotMatch(c.user, /Verdicts:/);
    const r2 = t.model.calls.filter((c) => c.user.includes('round 2'));
    for (const c of r2) assert.match(c.user, /The Contrarian Investor \(contrarian\)/);

    // Private by default: the page is a shell with nothing private in it; the report needs the key.
    const shell = await fetch(`${t.base}/m/${done.id}`).then((x) => x.text());
    assert.doesNotMatch(shell, /Copy recommendation/);
    assert.match(shell, /This meeting is private/);
    assert.equal((await fetch(`${t.base}/api/v1/meetings/${done.id}`)).status, 401);
    assert.equal((await fetch(`${t.base}/api/v1/meetings/${done.id}/report.html`)).status, 401);
    assert.equal((await fetch(`${t.base}/api/v1/meetings/${done.id}/page.html`)).status, 401);
    const page = await fetch(`${t.base}/api/v1/meetings/${done.id}/page.html`, { headers: { authorization: `Bearer ${key}` } }).then((x) => x.text());
    assert.match(page, /Copy recommendation/);
    assert.match(page, /\/ring\/profullstack/);
    assert.match(page, /Create share link/);
    const dl = await fetch(`${t.base}/api/v1/meetings/${done.id}/report.html`, { headers: { authorization: `Bearer ${key}` } });
    assert.match(dl.headers.get('content-disposition'), /attachment/);

    // Share links: read-only, revocable.
    r = await t.call('POST', `/api/v1/meetings/${done.id}/shares`, { expires: '7d' }, key);
    assert.equal(r.status, 201);
    const share = r.json;
    assert.match(share.url, /\/s\/[\w-]{30,}$/);
    const shared = await fetch(share.url.replace('http://local', t.base)).then((x) => x.text());
    assert.match(shared, /Copy recommendation/);
    assert.match(shared, /Shared with you by the meeting owner/);
    assert.doesNotMatch(shared, /Create share link/);
    r = await t.call('GET', '/api/v1/shares', undefined, key);
    assert.equal(r.json.shares.length, 1);
    r = await t.call('DELETE', `/api/v1/shares/${share.id}`, undefined, key);
    assert.equal(r.json.revoked, true);
    assert.equal((await fetch(share.url.replace('http://local', t.base))).status, 404);

    r = await t.call('GET', '/api/v1/account', undefined, key);
    assert.equal(r.json.free_meeting_available, false);
    r = await t.call('GET', '/api/v1/meetings', undefined, key);
    assert.equal(r.json.meetings.length, 1);
    const deck = await fetch(`${t.base}/api/v1/meetings/${done.id}/deck.pptx`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(deck.status, 200);
    assert.equal(Buffer.from(await deck.arrayBuffer()).subarray(0, 2).toString(), 'PK', 'the owner gets the slide deck');
    assert.equal((await fetch(`${t.base}/api/v1/meetings/${done.id}/deck.pptx`)).status, 401);
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(t.mails.some((m) => /Board minutes/.test(m.subject)));
  } finally {
    t.close();
  }
});

test('bad JSON is retried once, then the meeting fails honestly and is refunded', async () => {
  const t = await start({ model: fakeModel({ fail: 'boom' }) });
  try {
    let r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, 'admin-secret');
    let done = await t.waitDone(r.json.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /Nothing was made up/);
  } finally {
    t.close();
  }
  const t2 = await start({ model: fakeModel({ bad: 1 }) });
  try {
    const r = await t2.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, 'admin-secret');
    const done = await t2.waitDone(r.json.id);
    assert.equal(done.status, 'done', done.error);
    assert.ok(t2.model.calls.some((c) => c.user.includes('could not be used')));
  } finally {
    t2.close();
  }
});

test('a missing piece is asked once, then becomes an assumption', async () => {
  const t = await start({ model: fakeModel({ missing: ['constraints'] }) });
  try {
    let r = await t.call('POST', '/api/v1/meetings', { brief: 'Should I hire someone? Options: A or B.' }, 'admin-secret');
    let v = await t.waitDone(r.json.id);
    assert.equal(v.status, 'needs_clarification');
    assert.equal(v.clarify.missing[0], 'constraints');
    r = await t.call('POST', `/api/v1/meetings/${v.id}/clarify`, { answers: 'Budget $500' });
    assert.equal(r.status, 401); // private: only the owner answers
    r = await t.call('POST', `/api/v1/meetings/${v.id}/clarify`, { answers: 'Budget $500' }, 'admin-secret');
    assert.equal(r.status, 200);
    r = await t.call('POST', `/api/v1/meetings/${v.id}/clarify`, { answers: 'again' }, 'admin-secret');
    assert.equal(r.status, 409);
    v = await t.waitDone(v.id);
    assert.equal(v.status, 'done', v.error);
  } finally {
    t.close();
  }
});

test('coinpay webhook: bad signature 401, paid event queues the meeting once', async () => {
  const t = await start();
  try {
    const db = t.app.db;
    const acct = db.ensureAccount('payer@example.com');
    db.spend(acct.id);
    const row = db.createMeeting({ accountId: acct.id, briefText: fixture.brief.text, status: 'awaiting_payment' });
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.confirmed', data: { payment_id: 'p1', status: 'confirmed', amount_usd: 9, metadata: { meeting_id: row.id } } });
    let r = await t.call('POST', '/api/v1/coinpay/webhook', body);
    assert.equal(r.status, 401);
    const send = () => fetch(`${t.base}/api/v1/coinpay/webhook`, { method: 'POST', headers: { 'x-coinpay-signature': signWebhook(body, 'whsec_test') }, body });
    assert.equal((await send()).status, 200);
    assert.equal((await send().then((x) => x.json())).duplicate, true);
    const done = await t.waitDone(row.id);
    assert.equal(done.status, 'done');
  } finally {
    t.close();
  }
});

test('MCP: 401 with resource metadata without a token; tools work with one', async () => {
  const t = await start();
  try {
    let r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/local\/\.well-known\/oauth-protected-resource\/mcp"/);
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }, 'bso_nope');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, 'admin-secret');
    assert.equal(r.json.result.serverInfo.name, 'board-saas');
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'admin-secret');
    assert.deepEqual(r.json.result.tools.map((x) => x.name), ['run_meeting', 'get_meeting', 'list_meetings', 'clarify_meeting', 'share_meeting', 'invite_to_meeting', 'publish_meeting', 'list_shareables', 'list_shares', 'revoke_share', 'start_meeting_now', 'connect_c0mpute', 'make_branded_video', 'get_account']);
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_meeting', arguments: { brief: fixture.brief.text, wait_seconds: 5 } } }, 'admin-secret');
    assert.equal(r.json.result.structuredContent.status, 'done');
    const id = r.json.result.structuredContent.id;
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_meeting', arguments: { id, brief: true } } }, 'admin-secret');
    assert.match(r.json.result.content[0].text, /Recommendation:/);
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_meeting', arguments: { brief: 'too short' } } }, 'admin-secret');
    assert.equal(r.json.result.isError, true);
  } finally {
    t.close();
  }
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const form = (t, path, params, headers = {}) =>
  fetch(t.base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params).toString() }).then(async (r) => ({ status: r.status, json: await r.json() }));

/** Sign in on the consent pages the way a browser does: email code -> session cookie. */
async function browserSession(t, email) {
  await t.call('POST', '/api/v1/auth/code', { email });
  const code = t.mails.at(-1).text.match(/\b(\d{6})\b/)[1];
  const r = await fetch(t.base + '/oauth/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://local' }, body: JSON.stringify({ email, code }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  return cookie;
}
const csrfOf = (html) => html.match(/C="([^"]+)"/)[1];

test('OAuth discovery: protected resource and authorization server metadata', async () => {
  const t = await start();
  try {
    let r = await t.call('GET', '/.well-known/oauth-protected-resource/mcp');
    assert.equal(r.json.resource, 'http://local/mcp');
    assert.deepEqual(r.json.authorization_servers, ['http://local']);
    r = await t.call('GET', '/.well-known/oauth-protected-resource');
    assert.equal(r.json.resource, 'http://local/mcp');
    r = await t.call('GET', '/.well-known/oauth-protected-resource/api/v1');
    assert.equal(r.json.resource, 'http://local/api/v1');
    r = await t.call('GET', '/.well-known/oauth-authorization-server');
    assert.equal(r.json.issuer, 'http://local');
    assert.deepEqual(r.json.code_challenge_methods_supported, ['S256']);
    assert.ok(r.json.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code'));
    assert.equal(r.json.registration_endpoint, 'http://local/oauth/register');
    assert.equal(r.json.authorization_response_iss_parameter_supported, true);
    r = await t.call('GET', '/api/v1/account', undefined);
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /oauth-protected-resource\/api\/v1/);
  } finally {
    t.close();
  }
});

test('OAuth connector flow: DCR, consent sign-in, PKCE code, MCP + API, refresh rotation, reuse revokes, revoke', async () => {
  const t = await start();
  try {
    // 1. A connector registers itself (no scope, like claude.ai).
    let r = await t.call('POST', '/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' });
    assert.equal(r.status, 201);
    const clientId = r.json.client_id;
    assert.match(clientId, /^bsc_/);
    assert.equal(r.json.client_secret, undefined);
    r = await t.call('POST', '/oauth/register', { redirect_uris: ['http://evil.example/cb'] });
    assert.equal(r.json.error, 'invalid_redirect_uri');

    // 2. Authorization request: bad ones are refused, unknown redirect never redirected.
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: 'http://local/mcp' });
    let page = await fetch(`${t.base}/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: 'https://attacker.example/cb' })}`);
    assert.equal(page.status, 400);
    page = await fetch(`${t.base}/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), code_challenge_method: 'plain' })}`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /error=invalid_request.*iss=/);

    // 3. Signed out, the consent page offers sign-in; signed in, it shows Allow with a CSRF token.
    page = await fetch(`${t.base}/oauth/authorize?${q}`);
    let html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Email me a code/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const cookie = await browserSession(t, 'cfo@example.com');
    page = await fetch(`${t.base}/oauth/authorize?${q}`, { headers: { cookie } });
    html = await page.text();
    assert.match(html, /Connect Claude to Board as a Service/);
    assert.match(html, /claude\.ai/);
    const csrf = csrfOf(html);
    r = await fetch(`${t.base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' }, body: JSON.stringify({ query: `?${q}`, action: 'approve', csrf }) });
    assert.equal(r.status, 403);
    r = await fetch(`${t.base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ query: `?${q}`, action: 'approve', csrf: 'wrong' }) });
    assert.equal(r.status, 403);
    r = await fetch(`${t.base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'http://local' }, body: JSON.stringify({ query: `?${q}`, action: 'approve', csrf }) });
    const back = new URL((await r.json()).redirect);
    assert.equal(back.origin + back.pathname, 'https://claude.ai/api/mcp/auth_callback');
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal(back.searchParams.get('iss'), 'http://local');
    const code = back.searchParams.get('code');

    // 4. Token exchange: wrong verifier fails and burns the code; right one works once.
    r = await form(t, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: clientId, code_verifier: pkce().verifier });
    assert.equal(r.json.error, 'invalid_grant');
    // fresh approval for the real exchange
    r = await fetch(`${t.base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'http://local' }, body: JSON.stringify({ query: `?${q}`, action: 'approve', csrf }) });
    const code2 = new URL((await r.json()).redirect).searchParams.get('code');
    r = await form(t, '/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: clientId, code_verifier: verifier });
    assert.equal(r.status, 200);
    assert.match(r.json.access_token, /^bso_/);
    assert.match(r.json.refresh_token, /^bsr_/);
    assert.equal(r.json.scope, 'board');
    const tok = r.json;
    r = await form(t, '/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: clientId, code_verifier: verifier });
    assert.equal(r.json.error, 'invalid_grant');

    // 5. The token works on MCP and the API, as the consenting account, with company data.
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_account', arguments: {} } }, tok.access_token);
    assert.equal(r.json.result.structuredContent.email, 'cfo@example.com');
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_meeting', arguments: { brief: fixture.brief.text, company_data: { cash_usd: 41000, mrr_usd: 6200, burn_usd: 5900 }, wait_seconds: 5 } } }, tok.access_token);
    assert.equal(r.json.result.structuredContent.status, 'done');
    assert.equal(r.json.result.structuredContent.has_company_data, true);
    assert.ok(t.model.calls.some((c) => c.user.includes('<company_data>') && c.user.includes('"cash_usd": 41000')));
    assert.equal((await t.call('GET', `/api/v1/meetings/${r.json.result.structuredContent.id}/meeting.json`)).status, 401);
    const meetingJson = await t.call('GET', `/api/v1/meetings/${r.json.result.structuredContent.id}/meeting.json`, undefined, tok.access_token);
    assert.doesNotMatch(JSON.stringify(meetingJson.json), /41000/);
    r = await t.call('GET', '/api/v1/meetings', undefined, tok.access_token);
    assert.equal(r.json.meetings.length, 1);
    r = await t.call('GET', '/api/v1/connections', undefined, tok.access_token);
    assert.equal(r.json.connections[0].name, 'Claude');

    // 6. Refresh rotates; replaying the old refresh token revokes the whole family.
    r = await form(t, '/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
    assert.equal(r.status, 200);
    const tok2 = r.json;
    assert.notEqual(tok2.refresh_token, tok.refresh_token);
    r = await t.call('GET', '/api/v1/account', undefined, tok.access_token);
    assert.equal(r.status, 401, 'old access token dies on refresh');
    r = await t.call('GET', '/api/v1/account', undefined, tok2.access_token);
    assert.equal(r.status, 200);
    r = await form(t, '/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
    assert.equal(r.json.error, 'invalid_grant');
    r = await t.call('GET', '/api/v1/account', undefined, tok2.access_token);
    assert.equal(r.status, 401, 'reuse revoked the family');

    // 7. Deny sends the client access_denied.
    r = await fetch(`${t.base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ query: `?${q}`, action: 'deny', csrf }) });
    assert.match((await r.json()).redirect, /error=access_denied/);
  } finally {
    t.close();
  }
});

test('OAuth device flow for the CLI, confidential client secret, revoke and disconnect', async () => {
  const t = await start();
  try {
    let r = await form(t, '/oauth/device_authorization', { client_id: 'board-saas-cli', scope: 'board' });
    assert.equal(r.status, 200);
    assert.match(r.json.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(r.json.verification_uri, 'http://local/oauth/device');
    const d = r.json;
    r = await form(t, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: 'board-saas-cli' });
    assert.equal(r.json.error, 'authorization_pending');
    r = await form(t, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: 'board-saas-cli' });
    assert.equal(r.json.error, 'slow_down');

    const cookie = await browserSession(t, 'advisor@example.com');
    const html = await (await fetch(`${t.base}/oauth/device`, { headers: { cookie } })).text();
    const csrf = csrfOf(html);
    const post = (b) => fetch(`${t.base}/oauth/device`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ csrf, ...b }) }).then((x) => x.json());
    assert.equal((await post({ user_code: d.user_code.toLowerCase().replace('-', ' '), action: 'lookup' })).client, 'board-saas CLI');
    assert.equal((await post({ user_code: d.user_code, action: 'approve' })).approved, true);

    // The client's own poller (BoardClient.deviceLogin) is exercised separately below; here, redeem directly.
    t.app.db.raw.prepare('update oauth_devices set last_poll = 0').run();
    r = await form(t, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: 'board-saas-cli' });
    assert.match(r.json.access_token, /^bso_/);
    const tok = r.json;
    r = await t.call('GET', '/api/v1/account', undefined, tok.access_token);
    assert.equal(r.json.email, 'advisor@example.com');
    t.app.db.raw.prepare('update oauth_devices set last_poll = 0').run();
    r = await form(t, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: 'board-saas-cli' });
    assert.equal(r.json.error, 'invalid_grant', 'a device code redeems once');

    // Revoke the refresh token: the family dies.
    r = await form(t, '/oauth/revoke', { token: tok.refresh_token, client_id: 'board-saas-cli' });
    assert.equal(r.status, 200);
    r = await t.call('GET', '/api/v1/account', undefined, tok.access_token);
    assert.equal(r.status, 401);

    // A confidential client must authenticate (Basic) on the token endpoint.
    r = await t.call('POST', '/oauth/register', { client_name: 'Ops app', redirect_uris: ['https://ops.example/cb'], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'] });
    const { client_id, client_secret } = r.json;
    assert.match(client_secret, /^bss_/);
    r = await form(t, '/oauth/device_authorization', { client_id });
    assert.equal(r.json.error, 'invalid_client');
    r = await form(t, '/oauth/device_authorization', {}, { authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}` });
    assert.equal(r.status, 200);
    const d2 = r.json;
    assert.equal((await post({ user_code: d2.user_code, action: 'approve' })).approved, true);
    r = await form(t, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d2.device_code }, { authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}` });
    const tok2 = r.json;
    assert.match(tok2.access_token, /^bso_/);
    r = await t.call('DELETE', `/api/v1/connections/${client_id}`, undefined, tok2.access_token);
    assert.equal(r.json.revoked, true);
    r = await t.call('GET', '/api/v1/account', undefined, tok2.access_token);
    assert.equal(r.status, 401);
  } finally {
    t.close();
  }
});

test('BoardClient: device login polls through pending, then refreshes on 401', async () => {
  const t = await start();
  try {
    const saved = [];
    const client = new BoardClient({ url: t.base, onTokens: (x) => saved.push(x) });
    let polls = 0;
    const login = client.deviceLogin(
      async (d) => {
        const cookie = await browserSession(t, 'cli@example.com');
        const csrf = csrfOf(await (await fetch(`${t.base}/oauth/device`, { headers: { cookie } })).text());
        setTimeout(() => fetch(`${t.base}/oauth/device`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ csrf, user_code: d.user_code, action: 'approve' }) }), 30);
      },
      { sleep: async () => { polls++; t.app.db.raw.prepare('update oauth_devices set last_poll = 0').run(); await new Promise((res) => setTimeout(res, 40)); } },
    );
    await login;
    assert.ok(polls >= 1);
    assert.equal((await client.account()).email, 'cli@example.com');
    // Kill the access token server-side: the client refreshes and carries on.
    t.app.db.raw.prepare("update oauth_tokens set revoked = 1 where kind = 'access'").run();
    assert.equal((await client.account()).email, 'cli@example.com');
    assert.ok(saved.length >= 2);
    await client.logout();
    assert.equal(client.key, null);
  } finally {
    t.close();
  }
});

test('every MCP tool has a title and read-only/destructive hints (directory requirement)', async () => {
  const { TOOLS } = await import('../src/mcp.js');
  for (const t of TOOLS) {
    assert.ok(t.title && t.annotations?.title, `${t.name} title`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', `${t.name} readOnlyHint`);
    assert.equal(typeof t.annotations.destructiveHint, 'boolean', `${t.name} destructiveHint`);
    // Directory rule: descriptions say what a tool does, never tell the model what to do or which other tools to use.
    const text = JSON.stringify({ d: t.description, s: t.inputSchema });
    assert.doesNotMatch(text, /QuickBooks|Stripe|connected tools|\bpoll\b|give the user|ask the user|call get_meeting/i, `${t.name} description instructs the model`);
  }
});

test('icon is served as a PNG at /favicon.ico', async () => {
  const t = await start();
  try {
    const r = await fetch(`${t.base}/favicon.ico`);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
  } finally {
    t.close();
  }
});

test('reviewer login: the fixed vault code signs in that one email only', async () => {
  process.env.BOARD_SAAS_REVIEW_LOGIN = 'reviewer@example.com:review-code-0123456789';
  const t = await start();
  try {
    let r = await t.call('POST', '/api/v1/auth/verify', { email: 'reviewer@example.com', code: 'review-code-0123456789' });
    assert.match(r.json.api_key, /^bsk_/);
    r = await t.call('POST', '/api/v1/auth/verify', { email: 'other@example.com', code: 'review-code-0123456789' });
    assert.equal(r.status, 401);
    r = await t.call('POST', '/api/v1/auth/verify', { email: 'reviewer@example.com', code: 'review-code-wrong' });
    assert.equal(r.status, 401);
  } finally {
    delete process.env.BOARD_SAAS_REVIEW_LOGIN;
    t.close();
  }
});

test('TUI view renders headless', async () => {
  const { renderToText } = await import('@profullstack/hqtui/testing');
  const text = renderToText(view({ list: [{ id: 'a', status: 'done', created_at: '2026-11-22T10:00:00Z', brief: 'hire' }], selected: 0, detail: { id: 'a', status: 'done', url: 'u', report_url: 'r', meeting: { ...fixture } }, account: { email: 'x@y.z', free_meeting_available: false, credits: 0 } }), { width: 120, height: 40 });
  assert.match(text, /Meetings/);
  assert.match(text, /Majority/);
});

test('mcp handler rejects unknown methods', async () => {
  const h = createMcpHandler({ runMeeting: async () => ({}), getMeeting: async () => ({}) });
  const r = await h({ jsonrpc: '2.0', id: 9, method: 'nope' });
  assert.equal(r.error.code, -32601);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});


/** A fake c0mpute pay-as-you-go store: who is connected, their balance, what was charged. */
function fakeC0mpute({ connected = true, balance = 10, charge = null } = {}) {
  const charges = [];
  return {
    charges,
    configured: () => true,
    topUpUrl: 'https://c0mpute.test/checkout',
    connected: () => connected,
    balance: async () => balance,
    start: () => ({ authorize_url: 'https://c0mpute.test/oauth/authorize?x' }),
    finish: async () => ({ accountId: 'a', name: 'n' }),
    disconnect: async () => {},
    async charge(account, args) {
      charges.push({ account: account.id, ...args });
      return charge ? charge(args) : { charged: true, balance_usd: balance - args.priceUsd };
    },
  };
}

/** The paid (Claude) fake: the fixture answers, each one costing $0.05 at Anthropic. */
function claudeFake(opts) {
  const base = fakeModel(opts);
  return { name: 'claude', models: ['claude-opus-5-5'], calls: base.calls, generate: async (req) => ({ ...(await base.generate(req)), costUsd: 0.05, model: 'claude-opus-5-5' }) };
}

async function signedIn(t, email) {
  await t.call('POST', '/api/v1/auth/code', { email });
  const code = t.mails.at(-1).subject.match(/(\d{6})/)[1];
  return (await t.call('POST', '/api/v1/auth/verify', { email, code })).json.api_key;
}

test('paygo: after the free meeting, connect c0mpute; a low balance gets the top-up link', async () => {
  let t = await start({ model: claudeFake(), freeModel: fakeModel(), c0mpute: fakeC0mpute({ connected: false }) });
  try {
    const key = await signedIn(t, 'payg@example.com');
    let r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, key);
    assert.equal(r.status, 201, 'the free meeting');
    await t.waitDone(r.json.id);
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, key);
    assert.equal(r.status, 402);
    assert.equal(r.json.code, 'connect_c0mpute');
    assert.match(r.json.pricing, /Claude Opus 5\.5.*plus 20%/);
    r = await t.call('POST', '/api/v1/c0mpute/connect', {}, key);
    assert.match(r.json.authorize_url, /^https:\/\/c0mpute\.test\/oauth\/authorize/);
  } finally {
    t.close();
  }
  t = await start({ model: claudeFake(), freeModel: fakeModel(), c0mpute: fakeC0mpute({ balance: 0.5 }) });
  try {
    const key = await signedIn(t, 'low@example.com');
    t.app.db.spend(t.app.db.ensureAccount('low@example.com').id);
    const r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, key);
    assert.equal(r.status, 402);
    assert.equal(r.json.code, 'insufficient_balance');
    assert.equal(r.json.top_up_url, 'https://c0mpute.test/checkout');
    const a = await t.call('GET', '/api/v1/account', undefined, key);
    assert.equal(a.json.c0mpute.connected, true);
    assert.equal(a.json.c0mpute.balance_usd, 0.5);
  } finally {
    t.close();
  }
});

test('paygo: a paid meeting runs on Claude and is charged Anthropic cost + 20%, once', async () => {
  const paid = claudeFake();
  const free = fakeModel();
  const c0 = fakeC0mpute({ balance: 10 });
  const t = await start({ model: paid, freeModel: free, c0mpute: c0 });
  try {
    const key = await signedIn(t, 'payer2@example.com');
    t.app.db.spend(t.app.db.ensureAccount('payer2@example.com').id);
    const r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, key);
    assert.equal(r.status, 201);
    assert.equal((await t.waitDone(r.json.id)).status, 'done');
    assert.equal(free.calls.length, 0, 'the paid meeting reached c0mpute');
    const calls = paid.calls.length;
    assert.ok(calls > 0);
    assert.equal(c0.charges.length, 1);
    const cost = 0.05 * calls;
    assert.ok(Math.abs(c0.charges[0].costUsd - cost) < 1e-9);
    assert.equal(c0.charges[0].priceUsd, Math.ceil(cost * 1.2 * 100 - 1e-9) / 100);
    assert.equal(c0.charges[0].meetingId, r.json.id);
    const row = t.app.db.meeting(r.json.id);
    assert.equal(row.charge_status, 'charged');
    assert.equal(row.paid_with, 'c0mpute');
    assert.equal(JSON.parse(row.meeting_json).billing.price_usd, c0.charges[0].priceUsd);
  } finally {
    t.close();
  }
});

test('paygo: a failed paid meeting charges nothing and adds no credit', async () => {
  const c0 = fakeC0mpute({ balance: 10 });
  const t = await start({ model: claudeFake({ fail: 'model exploded' }), freeModel: fakeModel(), c0mpute: c0 });
  try {
    const key = await signedIn(t, 'fail@example.com');
    const acct = t.app.db.ensureAccount('fail@example.com');
    t.app.db.spend(acct.id);
    const r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, key);
    assert.equal((await t.waitDone(r.json.id)).status, 'failed');
    assert.match(t.app.db.meeting(r.json.id).error, /You were not charged/);
    assert.equal(c0.charges.length, 0);
    assert.equal(t.app.db.accountById(acct.id).credits, 0, 'a failed pay-as-you-go meeting must not mint a credit');
  } finally {
    t.close();
  }
});

test('recording: long silences are cut to under a second and transcript times follow', async () => {
  const { compressSilence } = await import('../src/recording.js');
  const rate = 24000;
  const tone = (s) => Int16Array.from({ length: Math.round(s * rate) }, (_, i) => Math.round(8000 * Math.sin(i / 7)));
  const quiet = (s) => new Int16Array(Math.round(s * rate));
  const parts = [quiet(3), tone(2), quiet(60), tone(2), quiet(0.5), tone(1), quiet(5)];
  const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (pcm.set(p, o), (o += p.length));
  const c = compressSilence(pcm, rate);
  const seconds = c.pcm.length / rate;
  assert.ok(seconds < 8, `trimmed to ${seconds}s, expected about 6.6s`);
  assert.ok(seconds > 5.5, 'speech and the short gap are kept');
  assert.ok(c.removedSeconds > 66, `removed ${c.removedSeconds}s`);
  // The second tone started at 65s in the original; after the cuts it starts 3.2s in.
  assert.ok(Math.abs(c.map(65) - 3.2) < 0.1, `mapped 65s to ${c.map(65)}`); // 0.4s lead-in, 2s tone, 0.8s kept of the gap
  assert.equal(c.map(0), 0);
  // Nothing long enough to cut: unchanged.
  const short = Int16Array.from({ length: rate }, (_, i) => (i < rate / 2 ? 5000 : 0));
  assert.equal(compressSilence(short, rate).pcm, short);
});

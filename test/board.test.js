import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { signWebhook } from '@profullstack/coinpay-onboard';
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
        return { text: JSON.stringify({ title: fixture.title, ...rest }), model: 'fake' };
      }
      if (u.includes('Board meeting, round 1')) return { text: '```json\n' + JSON.stringify(fixture.verdicts.find((v) => v.expert === id)) + '\n```', model: 'fake' };
      if (u.includes('Board meeting, round 2')) return { text: '<think>hmm</think>' + JSON.stringify(fixture.debate.find((v) => v.expert === id)), model: 'fake' };
      throw new Error('unexpected prompt');
    },
  };
}

async function start(opts = {}) {
  const mails = [];
  const env = { BOARD_SAAS_ADMIN_KEY: 'admin-secret', COINPAY_WEBHOOK_SECRET: 'whsec_test', PUBLIC_URL: 'http://local', ...opts.env };
  const model = opts.model ?? fakeModel();
  const app = createApp({ env, db: openDb(':memory:'), model, mailer: async (m) => mails.push(m), log: process.env.DEBUG ? console.log : () => {} });
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
      const r = await call('GET', `/api/v1/meetings/${id}`);
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
});

test('validators normalize ids and reject missing fields', () => {
  assert.equal(normalizeId('The CFO'), 'cfo');
  assert.equal(normalizeId('founder_time'), 'founder-time');
  assert.equal(validateVerdict({ call: 'x', reasons: ['a', 'b', 'c'] }, 'cfo').ok, false);
  const d = validateDebate({ position: 'p', reply: 'r', agrees: [{ with: 'The Operator', why: 'y' }, { with: 'cfo', why: 'self' }] }, 'cfo');
  assert.deepEqual(d.value.agrees, [{ with: 'operator', why: 'y' }]);
  assert.equal(validateMinutes({ majority: 'm', recommendation: 'r', question: 'q', clashes: [], dissent: {} }).ok, false);
});

test('personas are the boardroom skill texts without frontmatter', () => {
  assert.match(persona('cfo'), /^# The CFO/);
  assert.match(persona('chair'), /^# The Chair/);
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

    const page = await fetch(`${t.base}/m/${done.id}`).then((x) => x.text());
    assert.match(page, /Copy recommendation/);
    assert.match(page, /\/ring\/profullstack/);
    const dl = await fetch(`${t.base}/api/v1/meetings/${done.id}/report.html`);
    assert.match(dl.headers.get('content-disposition'), /attachment/);

    r = await t.call('GET', '/api/v1/account', undefined, key);
    assert.equal(r.json.free_meeting_available, false);
    r = await t.call('GET', '/api/v1/meetings', undefined, key);
    assert.equal(r.json.meetings.length, 1);
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
    assert.equal(r.status, 200);
    r = await t.call('POST', `/api/v1/meetings/${v.id}/clarify`, { answers: 'again' });
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

test('MCP: initialize, tools/list, run_meeting and get_meeting over HTTP', async () => {
  const t = await start();
  try {
    let r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(r.json.result.serverInfo.name, 'board-saas');
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(r.json.result.tools.map((x) => x.name), ['run_meeting', 'get_meeting']);
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_meeting', arguments: { brief: fixture.brief.text, wait_seconds: 5 } } }, 'admin-secret');
    assert.equal(r.json.result.structuredContent.status, 'done');
    const id = r.json.result.structuredContent.id;
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_meeting', arguments: { id, brief: true } } });
    assert.match(r.json.result.content[0].text, /Recommendation:/);
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_meeting', arguments: { brief: 'x'.repeat(30) } } });
    assert.equal(r.json.result.isError, true);
  } finally {
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

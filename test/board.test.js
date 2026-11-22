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
    assert.deepEqual(r.json.result.tools.map((x) => x.name), ['run_meeting', 'get_meeting', 'list_meetings', 'clarify_meeting', 'get_account']);
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
    const meetingJson = await t.call('GET', `/api/v1/meetings/${r.json.result.structuredContent.id}/meeting.json`);
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

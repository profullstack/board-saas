import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createC0mputeAccounts, priceFor } from '../src/c0mpute-account.js';

const KEY = 'c0k_testkeytestkey123456';

function fakeC0mpute(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, init });
    const [status, body] = routes[u.pathname]?.(init) ?? [404, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function setup(routes, env = {}) {
  const db = openDb(':memory:');
  const acct = db.ensureAccount('c0@example.com');
  const f = fakeC0mpute(routes);
  const c0 = createC0mputeAccounts({ db, env: { C0MPUTE_OAUTH_CLIENT_ID: 'c0c_board', C0MPUTE_ORIGIN: 'https://c0.test', ...env }, kek: randomBytes(32), publicUrl: 'https://board.test', fetchImpl: f.fetchImpl });
  return { db, acct, c0, calls: f.calls };
}

test('priceFor: Anthropic cost + 20%, rounded up to the cent', () => {
  assert.equal(priceFor(0), 0);
  assert.equal(priceFor(0.5), 0.6);
  assert.equal(priceFor(0.4321), 0.52);
  assert.equal(priceFor(1), 1.2);
});

test('connect: PKCE authorize link for inference + billing; finish stores the key wrapped, never in the clear', async () => {
  const { db, acct, c0, calls } = setup({
    '/api/oauth/token': () => [200, { access_token: KEY, token_type: 'Bearer', scope: 'inference billing' }],
    '/api/v1/me': () => [200, { name: 'founder', balance: { spendable_usd: '7.500000' } }],
  });
  const u = new URL(c0.start(acct.id).authorize_url);
  assert.equal(u.origin + u.pathname, 'https://c0.test/oauth/authorize');
  assert.equal(u.searchParams.get('scope'), 'inference billing');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://board.test/c0mpute/callback');
  const r = await c0.finish('c0a_code', u.searchParams.get('state'));
  assert.deepEqual(r, { accountId: acct.id, name: 'founder' });
  const row = db.accountById(acct.id);
  assert.ok(row.c0mpute_key && !row.c0mpute_key.includes(KEY), 'the key is wrapped');
  assert.equal(c0.connected(row), true);
  assert.equal(await c0.balance(row), 7.5);
  const token = new URLSearchParams(calls.find((c) => c.path === '/api/oauth/token').init.body);
  assert.equal(token.get('grant_type'), 'authorization_code');
  assert.ok(token.get('code_verifier'));
  await assert.rejects(c0.finish('c0a_code', u.searchParams.get('state')), /expired/, 'a state is used once');
});

test('connect: refused without the billing scope', async () => {
  const { acct, c0 } = setup({ '/api/oauth/token': () => [200, { access_token: KEY, scope: 'inference' }] });
  const state = new URL(c0.start(acct.id).authorize_url).searchParams.get('state');
  await assert.rejects(c0.finish('c', state), /billing/);
});

test('charge: one idempotent board.meeting charge per meeting; a short balance is reported, not thrown', async () => {
  let reply = [200, { charged: true, cost_usd: 0.6, balance_usd: 6.9 }];
  const { db, acct, c0, calls } = setup({
    '/api/oauth/token': () => [200, { access_token: KEY, scope: 'inference billing' }],
    '/api/v1/me': () => [200, { name: 'f' }],
    '/api/v1/billing/charge': () => reply,
  });
  await c0.finish('c', new URL(c0.start(acct.id).authorize_url).searchParams.get('state'));
  const row = db.accountById(acct.id);
  assert.deepEqual(await c0.charge(row, { meetingId: 'm1', priceUsd: 0.6, costUsd: 0.5 }), { charged: true, balance_usd: 6.9 });
  const sent = calls.find((c) => c.path === '/api/v1/billing/charge');
  assert.equal(sent.init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(sent.init.body), { idem_key: 'meeting:m1', kind: 'board.meeting', cost_usd: 0.6, meta: { meeting: 'm1', anthropic_cost_usd: 0.5 } });
  reply = [402, { charged: false, reason: 'insufficient_balance', balance_usd: 0.1, top_up_url: 'https://c0.test/checkout' }];
  assert.deepEqual(await c0.charge(row, { meetingId: 'm2', priceUsd: 0.6, costUsd: 0.5 }), { charged: false, reason: 'insufficient_balance', balance_usd: 0.1, top_up_url: 'https://c0.test/checkout' });
  reply = [503, { error: { message: 'billing did not answer' } }];
  await assert.rejects(c0.charge(row, { meetingId: 'm3', priceUsd: 0.6, costUsd: 0.5 }), /billing did not answer/);
});

test('a key c0mpute no longer accepts disconnects the account', async () => {
  let me = [200, { name: 'f' }];
  const { db, acct, c0 } = setup({ '/api/oauth/token': () => [200, { access_token: KEY, scope: 'inference billing' }], '/api/v1/me': () => me });
  await c0.finish('c', new URL(c0.start(acct.id).authorize_url).searchParams.get('state'));
  me = [401, {}];
  assert.equal(await c0.balance(db.accountById(acct.id), { fresh: true }), null);
  assert.equal(c0.connected(db.accountById(acct.id)), false);
});

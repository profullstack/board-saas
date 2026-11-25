// Sign in with CoinPay against a fake coinpayportal.com (token + userinfo endpoints).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { safeReturnTo } from '../src/coinpay-signin.js';
import { createApp } from '../src/server.js';
import { fakeModel } from './fakes.js';

const CLIENT_ID = 'cp_client_test';
const CLIENT_SECRET = 'cp_secret_test';
const b64url = (b) => Buffer.from(b).toString('base64url');

/** A fake CoinPay OAuth server. `grant(...)` stands in for the person consenting on coinpayportal.com. */
async function fakeCoinPay() {
  const codes = new Map();
  const tokens = new Map();
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const json = (status, v) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.url === '/api/oauth/token') {
      seen.push(body);
      const g = codes.get(body.code);
      codes.delete(body.code);
      if (!g) return json(400, { error: 'invalid_grant' });
      if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      if (body.redirect_uri !== g.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (b64url(createHash('sha256').update(body.code_verifier).digest()) !== g.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE failed' });
      const access = `cpat_${randomBytes(8).toString('hex')}`;
      tokens.set(access, g);
      const claims = { iss: base, aud: CLIENT_ID, sub: g.sub, exp: Math.floor(Date.now() / 1000) + 600, nonce: g.idNonce, email: g.email, email_verified: false };
      const idToken = `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email', id_token: idToken });
    }
    if (req.url === '/api/oauth/userinfo') {
      const g = tokens.get(String(req.headers.authorization).replace(/^Bearer /, ''));
      if (!g) return json(401, { error: 'invalid_token' });
      return json(200, { sub: g.sub, email: g.email, email_verified: false, name: 'Someone', ...(g.pass ? { pass: g.pass } : {}) });
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    seen,
    /** The person consents for `sub`: returns the code CoinPay redirects back with. */
    grant(authorizeLocation, { sub, email = null, pass = null, badNonce = false }) {
      const u = new URL(authorizeLocation);
      const code = `cpc_${randomBytes(8).toString('hex')}`;
      codes.set(code, { sub, email, pass, challenge: u.searchParams.get('code_challenge'), redirectUri: u.searchParams.get('redirect_uri'), idNonce: badNonce ? 'not-the-nonce' : u.searchParams.get('nonce') });
      return code;
    },
    close: () => server.close(),
  };
}

async function start({ configured = true } = {}) {
  const cp = await fakeCoinPay();
  const mails = [];
  const env = { PUBLIC_URL: 'http://local', BOARD_SAAS_ADMIN_KEY: 'admin-secret', BOARD_VOICE: '0', COINPAY_OAUTH_BASE: cp.base, ...(configured ? { COINPAY_OAUTH_CLIENT_ID: CLIENT_ID, COINPAY_OAUTH_CLIENT_SECRET: CLIENT_SECRET } : {}) };
  const app = createApp({ env, db: openDb(':memory:'), model: fakeModel(), mailer: async (m) => mails.push(m), log: process.env.DEBUG ? console.log : () => {} });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  /** GET /auth/coinpay/start (or a link url): the CoinPay authorize location and the binding cookie. */
  const begin = async (pathOrUrl = '/auth/coinpay/start?return_to=%2Faccount') => {
    const u = new URL(pathOrUrl, base);
    const r = await fetch(base + u.pathname + u.search, { redirect: 'manual' });
    assert.equal(r.status, 302, await r.text());
    return { location: r.headers.get('location'), cookie: r.headers.get('set-cookie').split(';')[0], setCookie: r.headers.get('set-cookie') };
  };
  const callback = async (state, code, cookie) => {
    const r = await fetch(`${base}/auth/coinpay/callback?${new URLSearchParams({ state, code })}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    return { status: r.status, html: await r.text(), headers: r.headers };
  };
  /** A whole CoinPay sign-in as `sub`; returns the API key the handoff page stores. */
  const signIn = async (who, returnTo = '/account') => {
    const s = await begin(`/auth/coinpay/start?return_to=${encodeURIComponent(returnTo)}`);
    const state = new URL(s.location).searchParams.get('state');
    const r = await callback(state, cp.grant(s.location, who), s.cookie);
    return { ...r, key: (r.html.match(/'board-saas:key',"(bsk_[^"]+)"/) ?? [])[1], cookie: s.cookie };
  };
  const emailKey = async (email) => {
    await call('POST', '/api/v1/auth/code', { email });
    const code = mails.at(-1).text.match(/\b(\d{6})\b/)[1];
    return (await call('POST', '/api/v1/auth/verify', { email, code })).json.api_key;
  };
  return { app, base, cp, mails, call, begin, callback, signIn, emailKey, close: () => (server.close(), cp.close()) };
}

test('safeReturnTo keeps same-site paths only', () => {
  assert.equal(safeReturnTo('/m/abc?x=1'), '/m/abc?x=1');
  assert.equal(safeReturnTo('/oauth/authorize?client_id=a&state=b'), '/oauth/authorize?client_id=a&state=b');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', null, '/a\nb']) assert.equal(safeReturnTo(bad), '/account');
});

test('CoinPay start: 302 to CoinPay authorize with client_id, exact redirect_uri, S256 PKCE, state, nonce and a binding cookie', async () => {
  const t = await start();
  try {
    const s = await t.begin();
    const u = new URL(s.location);
    assert.equal(u.origin, t.cp.base);
    assert.equal(u.pathname, '/api/oauth/authorize');
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('redirect_uri'), 'http://local/auth/coinpay/callback');
    assert.equal(u.searchParams.get('scope'), 'openid profile email');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(u.searchParams.get('state').length >= 40);
    assert.ok(u.searchParams.get('nonce').length >= 40);
    assert.notEqual(u.searchParams.get('state'), u.searchParams.get('nonce'));
    assert.match(s.setCookie, /^bs_cp=[\w-]+; Path=\/auth\/coinpay; HttpOnly; SameSite=Lax; Max-Age=600/);
    assert.doesNotMatch(s.location, /verifier/);
  } finally {
    t.close();
  }
});

test('CoinPay callback: wrong state, missing binding cookie, replay and a bad nonce are all refused', async () => {
  const t = await start();
  try {
    // Wrong state.
    let s = await t.begin();
    let r = await t.callback('not-the-state', t.cp.grant(s.location, { sub: 'cp-user-1' }), s.cookie);
    assert.equal(r.status, 400);
    assert.match(r.html, /expired or was already used/);

    // Right state, but not the browser that started it (no / another binding cookie).
    s = await t.begin();
    let state = new URL(s.location).searchParams.get('state');
    r = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-user-1' }), 'bs_cp=someone-else');
    assert.equal(r.status, 400);
    assert.match(r.html, /did not start in this browser/);
    // ...and that state is now burned, even with the right cookie.
    r = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-user-1' }), s.cookie);
    assert.equal(r.status, 400);

    // The id_token nonce must match the one the authorization request sent (finishSignIn checks it).
    s = await t.begin();
    state = new URL(s.location).searchParams.get('state');
    r = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-user-1', badNonce: true }), s.cookie);
    assert.equal(r.status, 400);
    assert.match(r.html, /nonce mismatch/);

    // A successful one cannot be replayed.
    s = await t.begin();
    state = new URL(s.location).searchParams.get('state');
    r = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-user-1' }), s.cookie);
    assert.equal(r.status, 200);
    r = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-user-1' }), s.cookie);
    assert.equal(r.status, 400);

    // The user said no on CoinPay.
    s = await t.begin();
    state = new URL(s.location).searchParams.get('state');
    const denied = await fetch(`${t.base}/auth/coinpay/callback?${new URLSearchParams({ state, error: 'access_denied' })}`, { headers: { cookie: s.cookie } });
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /cancelled/);

    // The token request carried the PKCE verifier and the client secret, server to server.
    const last = t.cp.seen.at(-1);
    assert.match(last.code_verifier, /^[A-Za-z0-9_-]{43,}$/);
    assert.equal(last.client_secret, CLIENT_SECRET);
  } finally {
    t.close();
  }
});

test('CoinPay sign-in: a new sub makes an account, the same sub signs back in, the email is never used for matching', async () => {
  const t = await start();
  try {
    // An existing email account with a meeting.
    const victimKey = await t.emailKey('victim@example.com');
    const victim = (await t.call('GET', '/api/v1/account', undefined, victimKey)).json;
    const m = await t.call('POST', '/api/v1/meetings', { brief: 'Decision: hire now or later? Options: hire, wait. Constraints: $3k a month.' }, victimKey);
    assert.equal(m.status, 201);

    // Someone signs in with CoinPay as a different sub that claims the victim's email.
    const a = await t.signIn({ sub: 'cp-attacker', email: 'victim@example.com' }, '/m/abc');
    assert.equal(a.status, 200);
    assert.ok(a.key, 'the handoff page carries the new API key');
    assert.match(a.html, /location\.replace\("\/m\/abc"\)/);
    assert.match(a.headers.get('set-cookie'), /bs_sid=[\w-]+; Path=\/oauth; HttpOnly/);
    assert.match(a.headers.get('set-cookie'), /bs_cp=; Path=\/auth\/coinpay;.*Max-Age=0/);
    assert.equal(a.headers.get('cache-control'), 'no-store');
    const acct = (await t.call('GET', '/api/v1/account', undefined, a.key)).json;
    assert.notEqual(acct.id, victim.id, 'never signed into the account whose email matches');
    assert.equal(acct.email, null, 'the CoinPay email is not stored as the account email');
    assert.equal(acct.name, 'CoinPay account');
    assert.deepEqual({ linked: acct.coinpay.linked, sign_in_only: acct.coinpay.sign_in_only }, { linked: true, sign_in_only: true });
    assert.equal(acct.free_meeting_available, true);
    assert.equal((await t.call('GET', '/api/v1/meetings', undefined, a.key)).json.meetings.length, 0);
    assert.equal((await t.call('GET', `/api/v1/meetings/${m.json.id}`, undefined, a.key)).status, 403, "the victim's private meeting stays private");
    const row = t.app.db.accountById(acct.id);
    assert.doesNotMatch(row.email, /victim/);
    assert.match(row.email, /@coinpay\.invalid$/);
    // Nothing is mailed to the placeholder.
    const before = t.mails.length;
    await t.call('POST', '/api/v1/auth/code', { email: row.email }).then((r) => assert.equal(r.status, 400));
    assert.equal(t.mails.length, before);

    // The same sub signs back in to the same account (with a fresh key; the old one is replaced).
    const again = await t.signIn({ sub: 'cp-attacker', email: 'other@example.com' });
    assert.equal((await t.call('GET', '/api/v1/account', undefined, again.key)).json.id, acct.id);
    assert.equal((await t.call('GET', '/api/v1/account', undefined, a.key)).status, 401);

    // The OAuth consent page sees the CoinPay sign-in's session and shows no email.
    const consent = await fetch(`${t.base}/oauth/device`, { headers: { cookie: again.headers.get('set-cookie').match(/bs_sid=[\w-]+/)[0] } });
    assert.match(await consent.text(), /Signed in as your CoinPay account/);

    // A CoinPay-only account cannot drop its only way in.
    const d = await t.call('DELETE', '/api/v1/auth/coinpay', undefined, again.key);
    assert.equal(d.status, 409);
  } finally {
    t.close();
  }
});

test('Connect CoinPay: only while signed in, finished only with the same account key; then CoinPay signs into it; several accounts ask which', async () => {
  const t = await start();
  try {
    const ownerKey = await t.emailKey('owner@example.com');
    const owner = (await t.call('GET', '/api/v1/account', undefined, ownerKey)).json;
    assert.equal(owner.coinpay.linked, false);
    assert.equal((await t.call('POST', '/api/v1/auth/coinpay/link')).status, 401);

    // Owner starts Connect CoinPay; the link url is single use.
    let r = await t.call('POST', '/api/v1/auth/coinpay/link', undefined, ownerKey);
    assert.equal(r.status, 200);
    const linkUrl = r.json.url;
    assert.match(linkUrl, /^http:\/\/local\/auth\/coinpay\/start\?link=/);
    let s = await t.begin(linkUrl);
    const stale = await fetch(t.base + new URL(linkUrl).pathname + new URL(linkUrl).search, { redirect: 'manual' });
    assert.equal(stale.status, 400);
    let state = new URL(s.location).searchParams.get('state');
    let cb = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-owner', email: 'whatever@example.com' }), s.cookie);
    assert.equal(cb.status, 200);
    const confirmToken = cb.html.match(/token:"([^"]+)"/)[1];
    assert.equal(t.app.db.coinpayLinkOf(owner.id), undefined, 'nothing is linked until the account itself confirms');

    // Another account (an attacker who sent the owner its own link) cannot finish it.
    const otherKey = await t.emailKey('other@example.com');
    r = await t.call('POST', '/api/v1/auth/coinpay/confirm', { token: confirmToken }, otherKey);
    assert.equal(r.status, 403);
    // The token was burned by that try: start again, finish with the owner's key.
    r = await t.call('POST', '/api/v1/auth/coinpay/link', undefined, ownerKey);
    s = await t.begin(r.json.url);
    state = new URL(s.location).searchParams.get('state');
    cb = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-owner' }), s.cookie);
    r = await t.call('POST', '/api/v1/auth/coinpay/confirm', { token: cb.html.match(/token:"([^"]+)"/)[1] }, ownerKey);
    assert.equal(r.status, 200);
    assert.equal(r.json.linked, true);
    assert.equal((await t.call('GET', '/api/v1/account', undefined, ownerKey)).json.coinpay.linked, true);
    assert.equal((await t.call('POST', '/api/v1/auth/coinpay/link', undefined, ownerKey)).status, 409);

    // Now CoinPay signs into the owner's email account (by sub).
    const back = await t.signIn({ sub: 'cp-owner' });
    const viaCp = (await t.call('GET', '/api/v1/account', undefined, back.key)).json;
    assert.equal(viaCp.id, owner.id);
    assert.equal(viaCp.email, 'owner@example.com');

    // The same CoinPay identity connected to a second account: the sign-in asks which one.
    const secondKey = await t.emailKey('second@example.com');
    const second = (await t.call('GET', '/api/v1/account', undefined, secondKey)).json;
    r = await t.call('POST', '/api/v1/auth/coinpay/link', undefined, secondKey);
    s = await t.begin(r.json.url);
    state = new URL(s.location).searchParams.get('state');
    cb = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-owner' }), s.cookie);
    assert.equal((await t.call('POST', '/api/v1/auth/coinpay/confirm', { token: cb.html.match(/token:"([^"]+)"/)[1] }, secondKey)).status, 200);
    s = await t.begin();
    state = new URL(s.location).searchParams.get('state');
    cb = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-owner' }), s.cookie);
    assert.equal(cb.status, 200);
    assert.match(cb.html, /Which account\?/);
    assert.match(cb.html, /owner@example\.com/);
    assert.match(cb.html, /second@example\.com/);
    const token = cb.html.match(/name="token" value="([^"]+)"/)[1];
    // An account not linked to this sub cannot be picked.
    const other = (await t.call('GET', '/api/v1/account', undefined, otherKey)).json;
    let pick = await fetch(`${t.base}/auth/coinpay/choose`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: s.cookie, origin: 'http://local' }, body: new URLSearchParams({ token, account_id: other.id }) });
    assert.equal(pick.status, 403);
    // (that burned the choice) sign in again and pick the second account
    s = await t.begin();
    state = new URL(s.location).searchParams.get('state');
    cb = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-owner' }), s.cookie);
    const token2 = cb.html.match(/name="token" value="([^"]+)"/)[1];
    pick = await fetch(`${t.base}/auth/coinpay/choose`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'bs_cp=wrong', origin: 'http://local' }, body: new URLSearchParams({ token: token2, account_id: second.id }) });
    assert.equal(pick.status, 400, 'the choice is bound to the browser that signed in');
    s = await t.begin();
    state = new URL(s.location).searchParams.get('state');
    cb = await t.callback(state, t.cp.grant(s.location, { sub: 'cp-owner' }), s.cookie);
    pick = await fetch(`${t.base}/auth/coinpay/choose`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: s.cookie, origin: 'http://local' }, body: new URLSearchParams({ token: cb.html.match(/name="token" value="([^"]+)"/)[1], account_id: second.id }) });
    assert.equal(pick.status, 200);
    const key2 = (await pick.text()).match(/'board-saas:key',"(bsk_[^"]+)"/)[1];
    assert.equal((await t.call('GET', '/api/v1/account', undefined, key2)).json.id, second.id);

    // Disconnect: an email account can drop CoinPay; its sign-in then no longer reaches it.
    assert.equal((await t.call('DELETE', '/api/v1/auth/coinpay', undefined, key2)).status, 200);
    const after = await t.signIn({ sub: 'cp-owner' });
    assert.equal((await t.call('GET', '/api/v1/account', undefined, after.key)).json.id, owner.id);
  } finally {
    t.close();
  }
});

test('Profullstack Pass: active pass covers meetings without spending the free meeting; re-checked on each sign-in', async () => {
  const t = await start();
  try {
    const until = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const s1 = await t.signIn({ sub: 'cp-pass', pass: { active: true, expires_at: until } });
    let a = (await t.call('GET', '/api/v1/account', undefined, s1.key)).json;
    assert.equal(a.pass.active, true);
    assert.equal(a.pass.until, until);
    assert.equal(a.voice.active, true);
    assert.equal(a.voice.plan, 'pass');
    const m = await t.call('POST', '/api/v1/meetings', { brief: 'Decision: hire now or later? Options: hire, wait. Constraints: $3k a month.' }, s1.key);
    assert.equal(m.status, 201);
    assert.equal(t.app.db.meeting(m.json.id).paid_with, 'pass');
    a = (await t.call('GET', '/api/v1/account', undefined, s1.key)).json;
    assert.equal(a.free_meeting_available, true, 'the pass paid, not the free meeting');

    // A stale claim (active but already expired) or no pass: cleared at the next sign-in.
    const s2 = await t.signIn({ sub: 'cp-pass', pass: { active: true, expires_at: new Date(Date.now() - 1000).toISOString() } });
    a = (await t.call('GET', '/api/v1/account', undefined, s2.key)).json;
    assert.equal(a.pass.active, false);
    const m2 = await t.call('POST', '/api/v1/meetings', { brief: 'Decision: raise prices or not? Options: raise, keep. Constraints: 400 customers.' }, s2.key);
    assert.equal(t.app.db.meeting(m2.json.id).paid_with, 'free');
  } finally {
    t.close();
  }
});

test('pages: CoinPay buttons on the account page, private meeting page and OAuth pages; unconfigured server says so', async () => {
  const t = await start();
  try {
    let html = await (await fetch(`${t.base}/account`)).text();
    assert.match(html, /href="http:\/\/local\/auth\/coinpay\/start\?return_to=%2Faccount"/);
    assert.match(html, /Connect CoinPay/);
    html = await (await fetch(`${t.base}/oauth/device`)).text();
    assert.match(html, /Sign in with CoinPay/);
    assert.match(html, /return_to=%2Foauth%2Fdevice/);
  } finally {
    t.close();
  }
  const u = await start({ configured: false });
  try {
    const r = await fetch(`${u.base}/auth/coinpay/start`, { redirect: 'manual' });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /not configured/);
    assert.doesNotMatch(await (await fetch(`${u.base}/oauth/device`)).text(), /Sign in with CoinPay/);
    assert.equal((await u.call('POST', '/api/v1/auth/coinpay/link', undefined, await u.emailKey('x@example.com'))).status, 503);
  } finally {
    u.close();
  }
});

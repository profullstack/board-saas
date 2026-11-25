// Sign in with CoinPay (0.6.0). board.saas is a confidential OAuth client of coinpayportal.com:
// authorization code + PKCE S256 + state + nonce, scopes openid profile email, through
// @profullstack/coinpay-onboard/oauth.
//
// STANDING rule: an account is bound to the CoinPay `sub` ONLY. The CoinPay email is unverified
// contact information, so it is never used to find an account, never stored as the account email,
// never marked verified and never grants anything. A sign-in with an unknown sub makes a new
// account with a placeholder email. CoinPay is linked to an existing (email) account only by its
// signed-in owner (Connect CoinPay on /account), never implicitly.
//
//   GET  /auth/coinpay/start?return_to=/path     302 to CoinPay; state/nonce/verifier kept server-side
//   GET  /auth/coinpay/start?link=<token>        the same, to link CoinPay to a signed-in account
//   GET  /auth/coinpay/callback                  state + browser binding checked, code exchanged
//   POST /auth/coinpay/choose                    a sub linked to several accounts: the person picks one
//   POST /api/v1/auth/coinpay/link     (bearer)  -> { url } that starts a link flow for this account
//   POST /api/v1/auth/coinpay/confirm  (bearer)  finishes a link flow: only the account that started it
//   DELETE /api/v1/auth/coinpay        (bearer)  unlink (refused for a CoinPay-only account)
//
// Every flow row is single-use and lives 10 minutes. The start sets an httpOnly cookie (bs_cp)
// whose hash is stored with the row, so a callback only completes in the browser that started it.
//
// Profullstack Pass: CoinPay reports it on userinfo. While `pass.active`, the account's
// pass_until is set to `pass.expiresAt`: board meetings (text and voice) are covered without
// spending the free meeting or credits. It is re-read on every CoinPay sign-in and link, and
// cleared when CoinPay no longer reports an active pass.
import { createHash } from 'node:crypto';
import { resolveCoinPayAccountLink, resolveCoinPaySignIn } from '@profullstack/coinpay-onboard/identity';
import { authorizeUrl, finishSignIn, pkce, randomToken, sameState, SIGN_IN_SCOPES } from '@profullstack/coinpay-onboard/oauth';
import { HttpError } from './service.js';

const FLOW_TTL = 10 * 60_000;
const COOKIE = 'bs_cp';

const SCHEMA = `
create table if not exists coinpay_flows (
  token_hash text primary key,
  kind text not null,
  binder_hash text,
  data text not null,
  expires_at integer not null
);
`;

const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Only a same-site path: "/x", never "//host" or "/\\host"; anything else is /account. */
export function safeReturnTo(v) {
  const s = String(v ?? '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.length > 2000 || /[\u0000-\u001f]/.test(s)) return '/account';
  return s;
}

export function createCoinPaySignIn({ db, env = process.env, publicUrl, oauth, fetchImpl = fetch, log = () => {} }) {
  const raw = db.raw;
  raw.exec(SCHEMA);
  const run = (sql, ...a) => raw.prepare(sql).run(...a);
  const clientId = env.COINPAY_OAUTH_CLIENT_ID || '';
  const clientSecret = env.COINPAY_OAUTH_CLIENT_SECRET || '';
  const base = (env.COINPAY_OAUTH_BASE || 'https://coinpayportal.com').replace(/\/+$/, '');
  const redirectUri = `${publicUrl}/auth/coinpay/callback`;
  const secure = publicUrl.startsWith('https:');
  const configured = !!(clientId && clientSecret);

  function requireConfigured() {
    if (!configured) throw new HttpError(503, 'Sign in with CoinPay is not configured on this server yet; sign in with your email instead');
  }

  function put(kind, data, { binder = null, token = randomToken() } = {}) {
    if (Math.random() < 0.1) run('delete from coinpay_flows where expires_at < ?', Date.now());
    run('insert into coinpay_flows (token_hash, kind, binder_hash, data, expires_at) values (?, ?, ?, ?, ?)', hash(token), kind, binder ? hash(binder) : null, JSON.stringify(data), Date.now() + FLOW_TTL);
    return token;
  }

  /** Take (and delete) a flow row: single use, even when a later check fails. */
  function take(kind, token) {
    if (!token) return null;
    const row = raw.prepare('delete from coinpay_flows where token_hash = ? and kind = ? returning *').get(hash(token), kind);
    if (!row || row.expires_at < Date.now()) return null;
    return { ...row, data: JSON.parse(row.data) };
  }

  const binderOf = (cookieHeader) => (String(cookieHeader ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`)) ?? [])[1] ?? null;
  const bound = (row, cookieHeader) => {
    const b = binderOf(cookieHeader);
    return !!(row.binder_hash && b && sameState(row.binder_hash, hash(b)));
  };
  const setCookie = (binder) => `${COOKIE}=${binder}; Path=/auth/coinpay; HttpOnly; SameSite=Lax; Max-Age=${FLOW_TTL / 1000}${secure ? '; Secure' : ''}`;
  const clearCookie = () => `${COOKIE}=; Path=/auth/coinpay; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

  /** GET /auth/coinpay/start -> { location, cookie }. */
  function start(query) {
    requireConfigured();
    let mode = 'signin';
    let accountId = null;
    let returnTo = safeReturnTo(query.get('return_to'));
    if (query.get('link')) {
      const link = take('link', query.get('link'));
      if (!link) throw new HttpError(400, 'that Connect CoinPay link expired or was already used; start again from your account page');
      mode = 'link';
      accountId = link.data.account_id;
      returnTo = '/account';
    }
    const { verifier, challenge } = pkce();
    const state = randomToken();
    const nonce = randomToken();
    const binder = randomToken();
    put('auth', { state, nonce, verifier, mode, account_id: accountId, return_to: returnTo }, { binder, token: state });
    return { location: authorizeUrl({ clientId, redirectUri, state, nonce, challenge, scopes: SIGN_IN_SCOPES, base }), cookie: setCookie(binder) };
  }

  /** Re-read the Profullstack Pass on every sign-in: active -> paid until it ends; otherwise none. */
  function applyPass(accountId, pass) {
    const until = pass?.active && pass.expiresAt ? pass.expiresAt.getTime() : null;
    db.setPass(accountId, until);
    if (until) log(`coinpay: account ${accountId} has a Profullstack Pass until ${new Date(until).toISOString()}`);
  }

  /** Signed in as `accountId`: a fresh API key for the web pages and a session for the OAuth pages. */
  function complete(accountId, returnTo) {
    const apiKey = db.rotateKey(accountId);
    return { kind: 'signed_in', accountId, apiKey, returnTo: safeReturnTo(returnTo), sessionCookie: oauth.createSession(accountId) };
  }

  /**
   * GET /auth/coinpay/callback. Returns one of
   *   { kind: 'signed_in', apiKey, returnTo, sessionCookie, accountId }
   *   { kind: 'choose', token, accounts: [{ id, label }] }
   *   { kind: 'confirm_link', token }
   * and always clears the binding cookie on the way out (the caller sends `clearCookie`).
   */
  async function callback(query, cookieHeader) {
    requireConfigured();
    const state = query.get('state');
    if (query.get('error')) {
      take('auth', state); // burn it
      throw new HttpError(400, query.get('error') === 'access_denied' ? 'You cancelled the CoinPay sign-in. Nothing was changed.' : `CoinPay did not sign you in (${String(query.get('error_description') || query.get('error')).slice(0, 200)}).`);
    }
    const flow = take('auth', state);
    if (!flow || !sameState(flow.data.state, state)) throw new HttpError(400, 'This sign-in link expired or was already used, or did not start here. Start again.');
    if (!bound(flow, cookieHeader)) throw new HttpError(400, 'This sign-in did not start in this browser (or cookies are blocked). Start again from the same browser.');
    const code = query.get('code');
    if (!code) throw new HttpError(400, 'CoinPay sent no authorization code. Start again.');
    let who;
    try {
      who = await finishSignIn({ code, verifier: flow.data.verifier, nonce: flow.data.nonce, clientId, clientSecret, redirectUri, base, fetch: fetchImpl });
    } catch (e) {
      log(`coinpay: sign-in failed: ${e.message}`);
      throw new HttpError(400, `CoinPay sign-in could not be completed (${String(e.message).slice(0, 200)}). Start again.`);
    }
    const pass = who.pass?.active ? { active: true, expiresAt: who.pass.expiresAt.toISOString() } : { active: false };

    if (flow.data.mode === 'link') {
      // Finished only by the account that started it, with its own key (see confirmLink).
      const token = put('confirm', { sub: who.sub, account_id: flow.data.account_id, pass });
      return { kind: 'confirm_link', token };
    }

    // Sign-in: by sub only. The CoinPay email is never looked at here.
    const decision = resolveCoinPaySignIn(db.coinpayAccountsFor(who.sub));
    if (decision.kind === 'create_account') {
      const account = db.createCoinPayAccount(who.sub);
      log(`coinpay: new account ${account.id} for a CoinPay sign-in`);
      applyPass(account.id, who.pass);
      return complete(account.id, flow.data.return_to);
    }
    if (decision.kind === 'sign_in') {
      applyPass(decision.userId, who.pass);
      return complete(decision.userId, flow.data.return_to);
    }
    // Several accounts linked to this sub: the person chooses; never pick one for them.
    const binder = binderOf(cookieHeader);
    const token = put('choose', { sub: who.sub, ids: decision.userIds, pass, return_to: flow.data.return_to }, { binder });
    return { kind: 'choose', token, accounts: decision.userIds.map((id) => ({ id, label: labelOf(db.accountById(id)) })) };
  }

  const labelOf = (a) => (!a ? 'an account' : a.signin === 'coinpay' ? `CoinPay account ${a.id}` : a.email);
  const passFrom = (p) => (p?.active ? { active: true, expiresAt: new Date(p.expiresAt) } : { active: false });

  /** POST /auth/coinpay/choose: the account picked from the chooser. */
  function choose(token, accountId, cookieHeader) {
    const flow = take('choose', token);
    if (!flow) throw new HttpError(400, 'This choice expired or was already made. Sign in again.');
    if (!bound(flow, cookieHeader)) throw new HttpError(400, 'This sign-in did not start in this browser. Sign in again.');
    if (!flow.data.ids.includes(String(accountId)) || !db.coinpayAccountsFor(flow.data.sub).includes(String(accountId))) throw new HttpError(403, 'that account is not linked to this CoinPay identity');
    applyPass(String(accountId), passFrom(flow.data.pass));
    return complete(String(accountId), flow.data.return_to);
  }

  /** POST /api/v1/auth/coinpay/link (signed in): a one-time URL that starts the link flow. */
  function linkUrl(accountId) {
    requireConfigured();
    if (db.coinpayLinkOf(accountId)) throw new HttpError(409, 'CoinPay is already connected to this account');
    const token = put('link', { account_id: accountId });
    return { url: `${publicUrl}/auth/coinpay/start?link=${encodeURIComponent(token)}` };
  }

  /** POST /api/v1/auth/coinpay/confirm (signed in): finish linking, only for the account that started it. */
  function confirmLink(accountId, token) {
    const flow = take('confirm', token);
    if (!flow) throw new HttpError(400, 'this Connect CoinPay step expired or was already used; start again from your account page');
    if (flow.data.account_id !== accountId) throw new HttpError(403, 'this Connect CoinPay step was started by another account; nothing was linked');
    const link = db.coinpayLinkOf(accountId);
    const decision = resolveCoinPayAccountLink({ bindings: link ? [{ sub: link.sub, userId: accountId }] : [], sub: flow.data.sub, userId: accountId });
    if (decision.kind === 'account_has_other_identity') throw new HttpError(409, 'this account is already connected to a different CoinPay account; disconnect it first');
    if (decision.kind === 'link' && !db.linkCoinPay(accountId, flow.data.sub)) throw new HttpError(409, 'this account was connected to CoinPay in the meantime; reload');
    applyPass(accountId, passFrom(flow.data.pass));
    log(`coinpay: account ${accountId} ${decision.kind === 'link' ? 'connected' : 're-confirmed'} CoinPay`);
    return { linked: true, already: decision.kind === 'already_linked' };
  }

  /** DELETE /api/v1/auth/coinpay (signed in). */
  function unlink(accountId) {
    const a = db.accountById(accountId);
    if (a?.signin === 'coinpay') throw new HttpError(409, 'this account was made by Sign in with CoinPay and has no other way to sign in, so CoinPay cannot be disconnected from it');
    const removed = db.unlinkCoinPay(accountId);
    if (removed) {
      db.setPass(accountId, null);
      log(`coinpay: account ${accountId} disconnected CoinPay`);
    }
    return { linked: false, removed };
  }

  return { configured, redirectUri, clientId, start, callback, choose, linkUrl, confirmLink, unlink, clearCookie };
}

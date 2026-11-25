// Pay as you go on c0mpute (Anthony, 2026-11-25: "use a paygo model. where they top off with
// coinpay to their c0mpute account (oauth'd)").
//
// A person connects their c0mpute account once: OAuth 2.1 authorization code + PKCE against
// c0mpute.com as a public client, scopes "inference billing". The token c0mpute issues is an
// ordinary c0k_ key; it is stored wrapped under BOARD_RECORDING_KEK and never shown again. Each paid
// meeting is then charged to that person's compute balance (topped up with CoinPay on c0mpute) at
// Anthropic cost + 20%, through c0mpute's POST /api/v1/billing/charge. Only clients c0mpute lists in
// C0MPUTE_BILLING_CLIENTS can get "billing", so C0MPUTE_OAUTH_CLIENT_ID must be one of them.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const MARKUP = 1.2;
const C0_KEY = /^c0k_[A-Za-z0-9_-]{8,200}$/;

export class C0mputeError extends Error {
  constructor(message, status = 502, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** The price of a meeting that cost `costUsd` at Anthropic: cost + 20%, rounded up to the cent. */
export function priceFor(costUsd) {
  const c = Number(costUsd) || 0;
  if (c <= 0) return 0;
  return Math.ceil(c * MARKUP * 100 - 1e-9) / 100;
}

const b64url = (buf) => buf.toString('base64url');

function wrap(kek, accountId, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(`board-saas-c0mpute-key:${accountId}`));
  return Buffer.concat([iv, c.update(key, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

function unwrap(kek, accountId, wrapped) {
  const b = Buffer.from(wrapped, 'base64');
  const d = createDecipheriv('aes-256-gcm', kek, b.subarray(0, 12));
  d.setAAD(Buffer.from(`board-saas-c0mpute-key:${accountId}`));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
}

export function createC0mputeAccounts({ db, env = process.env, kek, publicUrl, fetchImpl = fetch, log = () => {}, now = () => Date.now() }) {
  const origin = (env.C0MPUTE_ORIGIN || 'https://c0mpute.com').replace(/\/+$/, '');
  const clientId = env.C0MPUTE_OAUTH_CLIENT_ID || '';
  const redirectUri = `${publicUrl}/c0mpute/callback`;
  const balances = new Map(); // accountId -> { at, value }

  const configured = () => Boolean(clientId && kek);

  async function call(path, init = {}, timeoutMs = 20_000) {
    let res;
    try {
      res = await fetchImpl(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new C0mputeError(`c0mpute did not answer: ${e.message}`, 503);
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const said = (data, fallback) =>
    (typeof data?.error === 'object' && data.error?.message) || data?.error_description || (typeof data?.error === 'string' ? data.error : '') || fallback;

  function keyOf(account) {
    if (!account?.c0mpute_key || !kek) return null;
    try {
      return unwrap(kek, account.id, account.c0mpute_key);
    } catch {
      return null;
    }
  }

  return {
    configured,
    origin,
    topUpUrl: `${origin}/checkout`,

    /** Start the c0mpute sign-in for this account: the URL to send the person to. */
    start(accountId) {
      if (!configured()) throw new C0mputeError('c0mpute is not set up on this server yet', 503);
      const state = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(48));
      db.addC0mputePending(state, accountId, verifier);
      const u = new URL(`${origin}/oauth/authorize`);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', 'inference billing');
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
      u.searchParams.set('code_challenge_method', 'S256');
      return { authorize_url: u.toString() };
    },

    /** Finish it: exchange the code, check the key, store it wrapped. Returns { accountId, name }. */
    async finish(code, state) {
      const pending = state ? db.takeC0mputePending(state) : null;
      if (!pending || !code) throw new C0mputeError('that c0mpute sign-in expired; start it again', 400);
      const { status, data } = await call('/api/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: pending.verifier }).toString(),
      });
      const key = data?.access_token;
      if (status !== 200 || typeof key !== 'string' || !C0_KEY.test(key)) throw new C0mputeError(said(data, `c0mpute refused the sign-in (${status})`), 400);
      const scopes = String(data.scope || '').split(/\s+/);
      if (!scopes.includes('billing')) throw new C0mputeError('c0mpute did not allow billing, so meetings could not be charged to your balance', 403);
      const me = await call('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
      const name = me.status === 200 ? String(me.data?.name || me.data?.did || 'your c0mpute account').slice(0, 80) : 'your c0mpute account';
      db.setC0mpute(pending.account_id, { key: wrap(kek, pending.account_id, key), name });
      balances.delete(pending.account_id);
      return { accountId: pending.account_id, name };
    },

    /** Forget the account's c0mpute key here and revoke it at c0mpute. */
    async disconnect(account) {
      const key = keyOf(account);
      db.setC0mpute(account.id, {});
      balances.delete(account.id);
      if (key) {
        await call('/api/oauth/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: key }).toString(),
        }).catch(() => null);
      }
    },

    connected: (account) => Boolean(keyOf(account)),

    /** The spendable balance in USD, cached a minute; null when unknown. Clears a key c0mpute no longer accepts. */
    async balance(account, { fresh = false } = {}) {
      const key = keyOf(account);
      if (!key) return null;
      const cached = balances.get(account.id);
      if (!fresh && cached && now() - cached.at < 60_000) return cached.value;
      let r;
      try {
        r = await call('/api/v1/me', { headers: { authorization: `Bearer ${key}` } }, 10_000);
      } catch {
        return cached?.value ?? null;
      }
      if (r.status === 401 || r.status === 403) {
        log(`c0mpute key for account ${account.id} no longer works; disconnected`);
        db.setC0mpute(account.id, {});
        return null;
      }
      const v = Number(r.data?.balance?.spendable_usd);
      const value = Number.isFinite(v) ? v : null;
      balances.set(account.id, { at: now(), value });
      return value;
    },

    /** Charge `priceUsd` for meeting `meetingId`. Returns { charged, balance_usd, reason?, top_up_url? }. */
    async charge(account, { meetingId, priceUsd, costUsd }) {
      const key = keyOf(account);
      if (!key) return { charged: false, reason: 'not_connected' };
      const { status, data } = await call('/api/v1/billing/charge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ idem_key: `meeting:${meetingId}`, kind: 'board.meeting', cost_usd: priceUsd, meta: { meeting: meetingId, anthropic_cost_usd: Number(costUsd.toFixed(6)) } }),
      });
      balances.delete(account.id);
      if (status === 200 && data?.charged) return { charged: true, balance_usd: data.balance_usd };
      if (status === 402) return { charged: false, reason: data?.reason || 'insufficient_balance', balance_usd: data?.balance_usd ?? null, top_up_url: data?.top_up_url };
      throw new C0mputeError(said(data, `c0mpute answered ${status}`), status >= 500 ? 503 : status);
    },
  };
}

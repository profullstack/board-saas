// OAuth 2.1 authorization server for board.saas, so any OAuth client can act for an
// account: Claude / ChatGPT connectors and `claude mcp add` (MCP authorization spec), our
// own CLI (device flow) and any other app (authorization code + PKCE).
//
//   RFC 9728  protected resource metadata   /.well-known/oauth-protected-resource[/mcp|/api/v1]
//   RFC 8414  authorization server metadata /.well-known/oauth-authorization-server
//   RFC 7591  dynamic client registration   POST /oauth/register (and POST /register)
//   OAuth 2.1 authorization code + S256 PKCE, iss on every redirect (RFC 9207)
//   RFC 8628  device authorization grant    POST /oauth/device_authorization, page /oauth/device
//   RFC 7009  token revocation              POST /oauth/revoke
//   RFC 8707  resource indicators (accepted, must name this server)
//
// Tokens are opaque and stored as sha256: access `bso_` (1 hour), refresh `bsr_` (90 days,
// rotated on every use; presenting a rotated one revokes the whole family). One scope,
// `board`: run, read, list and clarify the account's meetings. Clients that ask for no
// scope (connectors never do) get `board` and always get a refresh token.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { newId, sha256 } from './db.js';
import { HttpError, normalizeEmail } from './service.js';

export const SCOPE = 'board';
export const CLI_CLIENT_ID = 'board-saas-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 86400;
const CODE_TTL = 300;
const DEVICE_TTL = 900;
const SESSION_TTL = 7 * 86400;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

const SCHEMA = `
create table if not exists oauth_clients (
  client_id text primary key,
  secret_hash text,
  name text not null,
  redirect_uris text not null,
  grant_types text not null,
  auth_method text not null,
  dynamic integer not null default 0,
  created_ip text,
  created_at integer not null
);
create table if not exists oauth_codes (
  code_hash text primary key,
  client_id text not null,
  account_id text not null,
  redirect_uri text not null,
  challenge text not null,
  scope text not null,
  resource text,
  expires_at integer not null
);
create table if not exists oauth_tokens (
  token_hash text primary key,
  kind text not null,
  client_id text not null,
  account_id text not null,
  scope text not null,
  family text not null,
  expires_at integer not null,
  used integer not null default 0,
  revoked integer not null default 0,
  created_at integer not null
);
create index if not exists oauth_tokens_family on oauth_tokens(family);
create index if not exists oauth_tokens_account on oauth_tokens(account_id, kind);
create table if not exists oauth_devices (
  device_hash text primary key,
  user_code text not null unique,
  client_id text not null,
  scope text not null,
  account_id text,
  status text not null default 'pending',
  interval_s integer not null default 5,
  last_poll integer not null default 0,
  expires_at integer not null
);
create table if not exists web_sessions (
  sid_hash text primary key,
  account_id text not null,
  csrf text not null,
  expires_at integer not null
);
`;

const now = () => Date.now();
const sec = () => Math.floor(Date.now() / 1000);
const token = (prefix) => `${prefix}${randomBytes(32).toString('base64url')}`;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** OAuth error as JSON (token, register, revoke, device endpoints). */
export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

const isLoopback = (u) => u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);

/** A redirect URI a client may register: https anywhere, http only on loopback, or a native app scheme. No fragments. */
function checkRedirect(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new OAuthError('invalid_redirect_uri', `not a URL: ${raw}`);
  }
  if (u.hash) throw new OAuthError('invalid_redirect_uri', 'redirect URIs may not have a fragment');
  if (u.protocol === 'https:' || isLoopback(u)) return u.href;
  if (/^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol)) return u.href; // reverse-DNS app scheme (RFC 8252)
  throw new OAuthError('invalid_redirect_uri', 'redirect URIs must be https, http on a loopback address, or a reverse-DNS app scheme');
}

/** Exact match, except a loopback redirect may use any port (RFC 8252 7.3). */
function redirectMatches(registered, given) {
  if (registered.includes(given)) return true;
  let g;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (!isLoopback(g)) return false;
  return registered.some((r) => {
    const u = new URL(r);
    return isLoopback(u) && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
  });
}

export function createOAuth({ db, publicUrl, log = () => {} }) {
  const raw = db.raw;
  raw.exec(SCHEMA);
  const get = (sql, ...a) => raw.prepare(sql).get(...a);
  const all = (sql, ...a) => raw.prepare(sql).all(...a);
  const run = (sql, ...a) => raw.prepare(sql).run(...a);
  const issuer = publicUrl;
  const mcpResource = `${publicUrl}/mcp`;
  const apiResource = `${publicUrl}/api/v1`;
  const secureCookie = publicUrl.startsWith('https:');
  const limits = new Map();

  // Our own CLI is a pre-registered public client: device flow plus loopback redirects.
  run(
    `insert into oauth_clients (client_id, secret_hash, name, redirect_uris, grant_types, auth_method, dynamic, created_at)
     values (?, null, ?, ?, ?, 'none', 0, ?) on conflict(client_id) do update set name = excluded.name, redirect_uris = excluded.redirect_uris, grant_types = excluded.grant_types`,
    CLI_CLIENT_ID,
    'board-saas CLI',
    JSON.stringify(['http://127.0.0.1/callback', 'http://localhost/callback']),
    JSON.stringify(['authorization_code', 'refresh_token', DEVICE_GRANT]),
    now(),
  );

  function limit(key, max, windowMs = 3_600_000) {
    const k = `${key}:${Math.floor(now() / windowMs)}`;
    const n = (limits.get(k) ?? 0) + 1;
    limits.set(k, n);
    if (limits.size > 10_000) limits.clear();
    if (n > max) throw new OAuthError('slow_down', 'too many requests from this address; try again later', 429);
  }

  function sweep() {
    if (Math.random() > 0.05) return;
    const t = now();
    run('delete from oauth_codes where expires_at < ?', t);
    run('delete from oauth_devices where expires_at < ?', t - 3_600_000);
    run('delete from oauth_tokens where expires_at < ?', t - 86_400_000);
    run('delete from web_sessions where expires_at < ?', t);
  }

  // ------------------------------------------------------------- metadata

  function resourceMetadata(which = 'mcp') {
    return {
      resource: which === 'api' ? apiResource : mcpResource,
      authorization_servers: [issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: which === 'api' ? 'Board as a Service API' : 'Board as a Service MCP',
      resource_documentation: `${publicUrl}/api/v1`,
    };
  }

  function serverMetadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_GRANT],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${publicUrl}/api/v1`,
    };
  }

  /** WWW-Authenticate for a 401 on a protected resource. */
  function challenge(which, error) {
    const meta = which === 'api' ? `${issuer}/.well-known/oauth-protected-resource/api/v1` : `${issuer}/.well-known/oauth-protected-resource/mcp`;
    return `Bearer realm="board-saas", resource_metadata="${meta}", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;
  }

  // -------------------------------------------------------------- clients

  const clientRow = (id) => (id ? get('select * from oauth_clients where client_id = ?', String(id)) : undefined);
  const clientView = (c) => ({ ...c, redirect_uris: JSON.parse(c.redirect_uris), grant_types: JSON.parse(c.grant_types) });

  function register(body, ip = '') {
    limit(`reg:${ip}`, 30);
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const grants = Array.isArray(body.grant_types) && body.grant_types.length ? body.grant_types.map(String) : ['authorization_code', 'refresh_token'];
    const bad = grants.filter((g) => !['authorization_code', 'refresh_token', DEVICE_GRANT].includes(g));
    if (bad.length) throw new OAuthError('invalid_client_metadata', `unsupported grant_types: ${bad.join(', ')}`);
    if (grants.includes('authorization_code') && !uris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required for the authorization_code grant');
    if (uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'at most 10 redirect URIs');
    const redirectUris = uris.map(checkRedirect);
    const method = String(body.token_endpoint_auth_method || 'none');
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) throw new OAuthError('invalid_client_metadata', `unsupported token_endpoint_auth_method: ${method}`);
    const name = String(body.client_name || 'An OAuth app').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'An OAuth app';
    const clientId = `bsc_${newId(16)}`;
    const secret = method === 'none' ? null : token('bss_');
    run(
      'insert into oauth_clients (client_id, secret_hash, name, redirect_uris, grant_types, auth_method, dynamic, created_ip, created_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      clientId,
      secret ? sha256(secret) : null,
      name,
      JSON.stringify(redirectUris),
      JSON.stringify(grants),
      method,
      ip,
      now(),
    );
    log(`oauth: registered client ${clientId} "${name}" (${method}) from ${ip}`);
    return {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: sec(),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: grants,
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPE,
    };
  }

  /** Authenticate the client on the token/revoke endpoints. Returns the client row. */
  function authClient(params, authHeader) {
    let id = params.client_id;
    let secret = params.client_secret;
    const m = String(authHeader ?? '').match(/^Basic\s+(.+)$/i);
    if (m) {
      const [u, p] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(p ?? '');
    }
    const c = clientRow(id);
    if (!c) throw new OAuthError('invalid_client', 'unknown client_id', 401);
    if (c.auth_method !== 'none') {
      if (!secret || !c.secret_hash || !safeEqual(sha256(secret), c.secret_hash)) throw new OAuthError('invalid_client', 'client authentication failed', 401);
    }
    return clientView(c);
  }

  // --------------------------------------------------------------- tokens

  function issue({ clientId, accountId, scope, family = newId(12) }) {
    const access = token('bso_');
    const refresh = token('bsr_');
    const t = now();
    run('insert into oauth_tokens (token_hash, kind, client_id, account_id, scope, family, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', sha256(access), 'access', clientId, accountId, scope, family, t + ACCESS_TTL * 1000, t);
    run('insert into oauth_tokens (token_hash, kind, client_id, account_id, scope, family, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', sha256(refresh), 'refresh', clientId, accountId, scope, family, t + REFRESH_TTL * 1000, t);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope };
  }

  const revokeFamily = (family) => run('update oauth_tokens set revoked = 1 where family = ?', family);

  /** Bearer access token -> account id, or null. */
  function accountForAccessToken(bearer) {
    if (!bearer || !bearer.startsWith('bso_')) return null;
    const row = get("select * from oauth_tokens where token_hash = ? and kind = 'access'", sha256(bearer));
    if (!row || row.revoked || row.expires_at < now()) return null;
    return row.account_id;
  }

  function normalizeScope(s) {
    const asked = String(s ?? '').split(/\s+/).filter(Boolean);
    // offline_access is implied (everyone gets a refresh token); anything else unknown is refused.
    const unknown = asked.filter((x) => x !== SCOPE && x !== 'offline_access');
    if (unknown.length) throw new OAuthError('invalid_scope', `unknown scope: ${unknown.join(' ')}; this server has one scope, "${SCOPE}"`);
    return SCOPE;
  }

  function checkResource(resource) {
    if (!resource) return null;
    const list = Array.isArray(resource) ? resource : [resource];
    for (const r of list) if (!String(r).startsWith(publicUrl)) throw new OAuthError('invalid_target', `this server only issues tokens for ${publicUrl}`);
    return list.join(' ');
  }

  async function tokenEndpoint(params, authHeader, ip = '') {
    sweep();
    const grant = params.grant_type;
    if (grant === 'authorization_code') {
      const client = authClient(params, authHeader);
      const row = get('select * from oauth_codes where code_hash = ?', sha256(String(params.code ?? '')));
      if (!row) throw new OAuthError('invalid_grant', 'unknown or used authorization code');
      run('delete from oauth_codes where code_hash = ?', row.code_hash); // one use, even on failure
      if (row.expires_at < now()) throw new OAuthError('invalid_grant', 'the authorization code expired');
      if (row.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'the code was issued to another client');
      if (row.redirect_uri !== String(params.redirect_uri ?? '')) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
      const verifier = String(params.code_verifier ?? '');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant', 'code_verifier is missing or malformed');
      if (b64url(createHash('sha256').update(verifier).digest()) !== row.challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed');
      log(`oauth: code exchanged by ${client.client_id} for account ${row.account_id}`);
      return issue({ clientId: client.client_id, accountId: row.account_id, scope: row.scope });
    }
    if (grant === 'refresh_token') {
      const client = authClient(params, authHeader);
      const row = get("select * from oauth_tokens where token_hash = ? and kind = 'refresh'", sha256(String(params.refresh_token ?? '')));
      if (!row || row.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'unknown refresh token');
      if (row.revoked) throw new OAuthError('invalid_grant', 'this connection was revoked; sign in again');
      if (row.used) {
        revokeFamily(row.family);
        log(`oauth: refresh token reuse on family ${row.family} (client ${row.client_id}); family revoked`);
        throw new OAuthError('invalid_grant', 'this refresh token was already used; the connection is revoked for safety, sign in again');
      }
      if (row.expires_at < now()) throw new OAuthError('invalid_grant', 'the refresh token expired; sign in again');
      if (!db.accountById(row.account_id)) throw new OAuthError('invalid_grant', 'the account no longer exists');
      if (!run("update oauth_tokens set used = 1 where token_hash = ? and used = 0", row.token_hash).changes) {
        revokeFamily(row.family);
        throw new OAuthError('invalid_grant', 'this refresh token was already used; sign in again');
      }
      run("update oauth_tokens set revoked = 1 where family = ? and kind = 'access'", row.family);
      return issue({ clientId: client.client_id, accountId: row.account_id, scope: row.scope, family: row.family });
    }
    if (grant === DEVICE_GRANT) {
      const client = authClient(params, authHeader);
      const row = get('select * from oauth_devices where device_hash = ?', sha256(String(params.device_code ?? '')));
      if (!row || row.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'unknown device_code');
      if (row.expires_at < now()) throw new OAuthError('expired_token', 'the code expired; start again');
      if (now() - row.last_poll < row.interval_s * 1000 - 250) {
        run('update oauth_devices set interval_s = interval_s + 5, last_poll = ? where device_hash = ?', now(), row.device_hash);
        throw new OAuthError('slow_down', `poll no faster than every ${row.interval_s + 5} seconds`);
      }
      run('update oauth_devices set last_poll = ? where device_hash = ?', now(), row.device_hash);
      if (row.status === 'pending') throw new OAuthError('authorization_pending', 'waiting for you to approve in the browser');
      if (row.status === 'denied') throw new OAuthError('access_denied', 'the request was denied');
      if (row.status !== 'approved') throw new OAuthError('invalid_grant', 'this device code was already used');
      if (!run("update oauth_devices set status = 'used' where device_hash = ? and status = 'approved'", row.device_hash).changes) throw new OAuthError('invalid_grant', 'this device code was already used');
      log(`oauth: device code redeemed by ${client.client_id} for account ${row.account_id}`);
      return issue({ clientId: client.client_id, accountId: row.account_id, scope: row.scope });
    }
    void ip;
    throw new OAuthError('unsupported_grant_type', `unsupported grant_type: ${grant ?? '(none)'}`);
  }

  function revoke(params, authHeader) {
    // RFC 7009: answer 200 whether or not the token existed.
    let client = null;
    try {
      client = authClient(params, authHeader);
    } catch (e) {
      if (params.client_id || authHeader) throw e;
    }
    const row = get('select * from oauth_tokens where token_hash = ?', sha256(String(params.token ?? '')));
    if (row && (!client || row.client_id === client.client_id)) {
      if (row.kind === 'refresh') revokeFamily(row.family);
      else run('update oauth_tokens set revoked = 1 where token_hash = ?', row.token_hash);
      log(`oauth: revoked ${row.kind} token of family ${row.family}`);
    }
    return {};
  }

  // -------------------------------------------------------------- consent

  function sessionFor(cookieHeader) {
    const m = String(cookieHeader ?? '').match(/(?:^|;\s*)bs_sid=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const row = get('select * from web_sessions where sid_hash = ?', sha256(m[1]));
    if (!row || row.expires_at < now()) return null;
    const account = db.accountById(row.account_id);
    return account ? { account, csrf: row.csrf } : null;
  }

  /** Email + code -> a web session for the consent and device pages. Returns the Set-Cookie value. */
  function signIn(emailIn, code) {
    const email = normalizeEmail(emailIn);
    if (!db.checkLoginCode(email, code)) throw new HttpError(401, 'that code is wrong or expired; ask for a new one');
    const account = db.ensureAccount(email);
    const sid = randomBytes(32).toString('base64url');
    run('insert into web_sessions (sid_hash, account_id, csrf, expires_at) values (?, ?, ?, ?)', sha256(sid), account.id, randomBytes(18).toString('base64url'), now() + SESSION_TTL * 1000);
    return `bs_sid=${sid}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secureCookie ? '; Secure' : ''}`;
  }

  function signOut(cookieHeader) {
    const m = String(cookieHeader ?? '').match(/(?:^|;\s*)bs_sid=([A-Za-z0-9_-]+)/);
    if (m) run('delete from web_sessions where sid_hash = ?', sha256(m[1]));
    return `bs_sid=; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? '; Secure' : ''}`;
  }

  /**
   * Validate an authorization request. Returns { client, redirectUri, state, challenge, scope, resource }.
   * Throws { redirect } once the redirect URI is trusted (errors go back to the client), or a
   * plain error before that (shown on the page, never redirected to an unverified URI).
   */
  function checkAuthorize(q) {
    const c = clientRow(q.client_id);
    if (!c) throw new HttpError(400, 'unknown client_id. The app must register first (POST /oauth/register).');
    const client = clientView(c);
    const redirectUri = String(q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : ''));
    if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) throw new HttpError(400, 'redirect_uri is not registered for this app');
    const back = (error, description) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      if (description) u.searchParams.set('error_description', description);
      if (q.state) u.searchParams.set('state', q.state);
      u.searchParams.set('iss', issuer);
      return Object.assign(new Error(description), { redirect: u.href });
    };
    if (q.response_type !== 'code') throw back('unsupported_response_type', 'response_type must be code');
    if (!client.grant_types.includes('authorization_code')) throw back('unauthorized_client', 'this app is not registered for the authorization_code grant');
    if (!q.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) throw back('invalid_request', 'PKCE is required: send code_challenge (S256)');
    if ((q.code_challenge_method || 'plain') !== 'S256') throw back('invalid_request', 'code_challenge_method must be S256');
    let scope;
    let resource;
    try {
      scope = normalizeScope(q.scope);
      resource = checkResource(q.resource);
    } catch (e) {
      throw back(e.code, e.message);
    }
    return { client, redirectUri, state: q.state ?? null, challenge: q.code_challenge, scope, resource };
  }

  function approve(req, accountId) {
    const code = token('bsa_');
    run(
      'insert into oauth_codes (code_hash, client_id, account_id, redirect_uri, challenge, scope, resource, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      sha256(code),
      req.client.client_id,
      accountId,
      req.redirectUri,
      req.challenge,
      req.scope,
      req.resource,
      now() + CODE_TTL * 1000,
    );
    const u = new URL(req.redirectUri);
    u.searchParams.set('code', code);
    if (req.state) u.searchParams.set('state', req.state);
    u.searchParams.set('iss', issuer);
    log(`oauth: account ${accountId} approved ${req.client.client_id} "${req.client.name}"`);
    return u.href;
  }

  function deny(req) {
    const u = new URL(req.redirectUri);
    u.searchParams.set('error', 'access_denied');
    u.searchParams.set('error_description', 'the account owner said no');
    if (req.state) u.searchParams.set('state', req.state);
    u.searchParams.set('iss', issuer);
    return u.href;
  }

  // ---------------------------------------------------------- device flow

  function newUserCode() {
    let s = '';
    for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(0, USER_CODE_ALPHABET.length)];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }
  const normUserCode = (v) => {
    const s = String(v ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
  };

  function deviceAuthorization(params, authHeader, ip = '') {
    limit(`dev:${ip}`, 30);
    sweep();
    const client = authClient(params, authHeader);
    if (!client.grant_types.includes(DEVICE_GRANT)) throw new OAuthError('unauthorized_client', 'this app is not registered for the device grant');
    const scope = normalizeScope(params.scope);
    const device = token('bsd_');
    let userCode = newUserCode();
    for (let i = 0; i < 5 && get('select 1 from oauth_devices where user_code = ?', userCode); i++) userCode = newUserCode();
    run('insert into oauth_devices (device_hash, user_code, client_id, scope, expires_at) values (?, ?, ?, ?, ?)', sha256(device), userCode, client.client_id, scope, now() + DEVICE_TTL * 1000);
    // No verification_uri_complete on purpose: typing the code is what stops a phished link.
    return { device_code: device, user_code: userCode, verification_uri: `${issuer}/oauth/device`, expires_in: DEVICE_TTL, interval: 5 };
  }

  function deviceLookup(userCodeIn) {
    const userCode = normUserCode(userCodeIn);
    const row = userCode && get('select * from oauth_devices where user_code = ?', userCode);
    if (!row || row.expires_at < now() || row.status !== 'pending') throw new HttpError(404, 'that code is wrong, expired or already used; start again in your terminal');
    const c = clientRow(row.client_id);
    return { row, client: c ? clientView(c) : { name: row.client_id } };
  }

  function deviceDecide(userCodeIn, accountId, allow) {
    const { row, client } = deviceLookup(userCodeIn);
    const ok = run("update oauth_devices set status = ?, account_id = ? where device_hash = ? and status = 'pending'", allow ? 'approved' : 'denied', accountId, row.device_hash).changes;
    if (!ok) throw new HttpError(409, 'that code was already used');
    log(`oauth: account ${accountId} ${allow ? 'approved' : 'denied'} device code for ${row.client_id}`);
    return { ok: true, approved: !!allow, client: client.name };
  }

  // ---------------------------------------------------------- connections

  function connections(accountId) {
    return all(
      `select t.client_id, c.name, min(t.created_at) as first_at, max(t.created_at) as last_at
         from oauth_tokens t left join oauth_clients c on c.client_id = t.client_id
        where t.account_id = ? and t.kind = 'refresh' and t.revoked = 0 and t.used = 0 and t.expires_at > ?
        group by t.client_id order by last_at desc`,
      accountId,
      now(),
    ).map((r) => ({ client_id: r.client_id, name: r.name ?? r.client_id, connected_at: new Date(r.first_at).toISOString(), last_refreshed_at: new Date(r.last_at).toISOString() }));
  }

  function disconnect(accountId, clientId) {
    const n = run('update oauth_tokens set revoked = 1 where account_id = ? and client_id = ? and revoked = 0', accountId, String(clientId)).changes;
    return { revoked: n > 0 };
  }

  return {
    resourceMetadata,
    serverMetadata,
    challenge,
    register,
    tokenEndpoint,
    revoke,
    accountForAccessToken,
    sessionFor,
    signIn,
    signOut,
    checkAuthorize,
    approve,
    deny,
    deviceAuthorization,
    deviceLookup,
    deviceDecide,
    connections,
    disconnect,
    clientName: (id) => clientRow(id)?.name ?? null,
  };
}

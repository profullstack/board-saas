// Board as a Service: HTTP API, MCP endpoint, report pages and the public site.
// The public front page is the copy hosted on the c0mpute network (C0MPUTE_SITE_URL),
// with the bundled build as the fallback when the gateway does not answer.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { allFooters, startFooterRefresh } from './footers.js';
import { createModel } from './llm.js';
import { createMailer } from './mail.js';
import { createMcpHandler, TOOLS } from './mcp.js';
import { createOAuth, OAuthError } from './oauth.js';
import { consentPage, devicePage, errorPage, newNonce, pageHeaders } from './oauth-pages.js';
import { reportDownload, reportPage, statusPage } from './pages.js';
import { createService, HttpError, PRICE_USD } from './service.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const STATIC = new Set(['/index.html', '/style.css', '/app.js']);

export const API_DOCS = {
  name: 'Board as a Service API',
  version: VERSION,
  base: 'https://board.saas.pit.world/api/v1',
  auth: 'Authorization: Bearer <token>. Either an OAuth 2.1 access token (any app: discovery at /.well-known/oauth-authorization-server, dynamic client registration, authorization code + S256 PKCE, device flow, refresh, revoke) or an API key from POST /auth/code {email} then POST /auth/verify {email, code}. Keys are full access to your account; a new verify replaces the old key.',
  oauth: {
    metadata: 'https://board.saas.pit.world/.well-known/oauth-authorization-server',
    protected_resources: ['https://board.saas.pit.world/.well-known/oauth-protected-resource/mcp', 'https://board.saas.pit.world/.well-known/oauth-protected-resource/api/v1'],
    register: 'POST /oauth/register (RFC 7591, open; public clients use PKCE, confidential ones get a secret)',
    authorize: 'GET /oauth/authorize?response_type=code&client_id=..&redirect_uri=..&code_challenge=..&code_challenge_method=S256&state=..',
    token: 'POST /oauth/token (authorization_code, refresh_token, urn:ietf:params:oauth:grant-type:device_code)',
    device: 'POST /oauth/device_authorization, then the person enters the code at /oauth/device',
    revoke: 'POST /oauth/revoke',
    scope: 'board',
    cli_client_id: 'board-saas-cli',
  },
  pricing: `First meeting free per email, then $${PRICE_USD} per meeting via CoinPay (crypto). A meeting the network cannot finish is refunded.`,
  honesty: 'The advisors are AI models on the c0mpute network, not real directors.',
  endpoints: [
    { method: 'POST', path: '/auth/code', body: { email: 'you@example.com' }, does: 'Email a 6-digit sign-in code.' },
    { method: 'POST', path: '/auth/verify', body: { email: 'you@example.com', code: '123456' }, does: 'Exchange the code for an API key.' },
    { method: 'GET', path: '/account', auth: true, does: 'Free meeting left, paid credits.' },
    { method: 'POST', path: '/meetings', auth: true, body: { brief: 'Decision ... Options ... Constraints ...', company_data: 'optional: P&L, cash, runway, MRR, churn (max 12000 chars, text or JSON); every advisor reads it, the shareable report does not show it' }, does: 'Start a meeting. 201 with status queued, or awaiting_payment with checkout_url.' },
    { method: 'GET', path: '/meetings', auth: true, does: 'Your meetings, newest first.' },
    { method: 'GET', path: '/meetings/:id', does: 'Status, progress, and the full meeting when done. The id is the capability; share it like a link.' },
    { method: 'POST', path: '/meetings/:id/clarify', body: { answers: '...' }, does: 'Answer the chair\'s one round of questions (status needs_clarification).' },
    { method: 'GET', path: '/meetings/:id/report.html', does: 'The interactive report as a downloadable file.' },
    { method: 'GET', path: '/meetings/:id/meeting.json', does: 'The meeting data (boardroom meeting.json shape).' },
    { method: 'GET', path: '/connections', auth: true, does: 'Apps connected to your account over OAuth.' },
    { method: 'DELETE', path: '/connections/:client_id', auth: true, does: 'Disconnect an app; its tokens stop working at once.' },
  ],
  mcp: { endpoint: 'https://board.saas.pit.world/mcp', transport: 'streamable HTTP (JSON responses)', auth: 'OAuth 2.1 (add the URL as a connector; the client discovers and registers itself) or Authorization: Bearer <key>', tools: TOOLS.map((t) => t.name), stdio: 'npx -y @profullstack/board-saas mcp' },
  cli: 'npm i -g @profullstack/board-saas  (board-saas login | meet | get | list | connections | tui | mcp)',
};

function bearer(req) {
  const h = req.headers.authorization ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

/** OAuth endpoints take application/x-www-form-urlencoded (the spec) or JSON. */
async function formBody(req) {
  const raw = await readBody(req, 32 * 1024);
  if (!raw) return {};
  if (String(req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      throw new OAuthError('invalid_request', 'body must be form-encoded or JSON');
    }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    if (k === 'resource' && out.resource) out.resource = [].concat(out.resource, v);
    else out[k] = v;
  }
  return out;
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
};
const NO_STORE = { ...CORS, 'cache-control': 'no-store', pragma: 'no-cache' };

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, {
    'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body, null, 1));
}

export function createApp({ env = process.env, db, model, mailer, fetchImpl = fetch, log = console.log } = {}) {
  const publicUrl = (env.PUBLIC_URL || 'https://board.saas.pit.world').replace(/\/+$/, '');
  db ??= openDb(env.BOARD_DB || join(env.HOME || '.', '.local/share/board-saas/board.db'));
  model ??= createModel(env);
  mailer ??= createMailer(env, fetchImpl);
  const oauth = createOAuth({ db, publicUrl, log });
  const service = createService({ db, env, model, mailer, log, publicUrl, accountForToken: oauth.accountForAccessToken });
  const origin = new URL(publicUrl).origin;

  const mcp = (key) =>
    createMcpHandler(
      {
        runMeeting: (brief, companyData) => service.createMeeting(key, brief, companyData),
        getMeeting: async (id) => service.getMeeting(id),
        listMeetings: async () => service.listMeetings(key),
        clarify: async (id, answers) => service.clarify(key, id, answers),
        account: async () => service.account(key),
      },
      { version: VERSION },
    );

  /** Browser POSTs to /oauth/* must come from our own pages. */
  function sameOrigin(req) {
    const o = req.headers.origin;
    if (o && o !== origin) throw new HttpError(403, 'cross-site request refused');
  }
  function sessionOrThrow(req, csrf) {
    const s = oauth.sessionFor(req.headers.cookie);
    if (!s) throw new HttpError(401, 'your sign-in expired; reload the page and sign in again');
    if (csrf !== undefined && csrf !== s.csrf) throw new HttpError(403, 'stale page; reload and try again');
    return s;
  }
  const sendOAuthError = (res, e) => send(res, e.status || 400, { error: e.code, error_description: e.message }, NO_STORE);

  async function oauthRoute(req, res, path, method, url) {
    if (path === '/oauth/register' || path === '/register') {
      if (method !== 'POST') return send(res, 405, { error: 'POST client metadata (RFC 7591)' }, CORS);
      try {
        return send(res, 201, oauth.register(await jsonBody(req).catch(() => ({})), clientIp(req)), NO_STORE);
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(res, e);
        throw e;
      }
    }
    if (path === '/oauth/token' && method === 'POST') {
      try {
        return send(res, 200, await oauth.tokenEndpoint(await formBody(req), req.headers.authorization, clientIp(req)), NO_STORE);
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(res, e);
        throw e;
      }
    }
    if (path === '/oauth/device_authorization' && method === 'POST') {
      try {
        return send(res, 200, oauth.deviceAuthorization(await formBody(req), req.headers.authorization, clientIp(req)), NO_STORE);
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(res, e);
        throw e;
      }
    }
    if (path === '/oauth/revoke' && method === 'POST') {
      try {
        return send(res, 200, oauth.revoke(await formBody(req), req.headers.authorization), NO_STORE);
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(res, e);
        throw e;
      }
    }
    if (path === '/oauth/authorize' && method === 'GET') {
      const nonce = newNonce();
      let ar;
      try {
        ar = oauth.checkAuthorize(Object.fromEntries(url.searchParams));
      } catch (e) {
        if (e.redirect) return send(res, 302, '', { location: e.redirect, 'cache-control': 'no-store' });
        return send(res, 400, errorPage(e.message, nonce), pageHeaders(nonce));
      }
      const session = oauth.sessionFor(req.headers.cookie);
      return send(res, 200, consentPage({ client: ar.client, redirectUri: ar.redirectUri, session, query: url.search, nonce }), pageHeaders(nonce));
    }
    if (path === '/oauth/authorize' && method === 'POST') {
      sameOrigin(req);
      const b = await jsonBody(req);
      const s = sessionOrThrow(req, b.csrf);
      let ar;
      try {
        ar = oauth.checkAuthorize(Object.fromEntries(new URLSearchParams(String(b.query ?? ''))));
      } catch (e) {
        if (e.redirect) return send(res, 200, { redirect: e.redirect }, { 'cache-control': 'no-store' });
        throw new HttpError(400, e.message);
      }
      const redirect = b.action === 'approve' ? oauth.approve(ar, s.account.id) : oauth.deny(ar);
      return send(res, 200, { redirect }, { 'cache-control': 'no-store' });
    }
    if (path === '/oauth/device' && method === 'GET') {
      const nonce = newNonce();
      return send(res, 200, devicePage({ session: oauth.sessionFor(req.headers.cookie), nonce }), pageHeaders(nonce));
    }
    if (path === '/oauth/device' && method === 'POST') {
      sameOrigin(req);
      const b = await jsonBody(req);
      const s = sessionOrThrow(req, b.csrf);
      if (b.action === 'lookup') return send(res, 200, { client: oauth.deviceLookup(b.user_code).client.name }, { 'cache-control': 'no-store' });
      if (b.action !== 'approve' && b.action !== 'deny') throw new HttpError(400, 'action must be lookup, approve or deny');
      return send(res, 200, oauth.deviceDecide(b.user_code, s.account.id, b.action === 'approve'), { 'cache-control': 'no-store' });
    }
    if (path === '/oauth/session' && method === 'POST') {
      sameOrigin(req);
      const b = await jsonBody(req);
      const cookie = oauth.signIn(b.email, b.code);
      return send(res, 200, { ok: true }, { 'set-cookie': cookie, 'cache-control': 'no-store' });
    }
    if (path === '/oauth/logout' && method === 'POST') {
      sameOrigin(req);
      return send(res, 200, { ok: true }, { 'set-cookie': oauth.signOut(req.headers.cookie), 'cache-control': 'no-store' });
    }
    return send(res, 404, { error: 'no such OAuth endpoint; see /.well-known/oauth-authorization-server' }, CORS);
  }

  // ------------------------------------------------------------ static site
  const builtDir = join(ROOT, 'site');
  const localDir = existsSync(join(builtDir, 'index.html')) ? builtDir : join(ROOT, 'public');
  const siteUrl = (env.C0MPUTE_SITE_URL || '').replace(/\/*$/, '/');
  const cache = new Map();

  function localFile(path) {
    let body = readFileSync(join(localDir, path.slice(1)), 'utf8');
    if (path === '/index.html') body = body.replace('<!--FOOTERS-->', allFooters());
    return body;
  }

  async function staticFile(path) {
    if (env.C0MPUTE_SITE_URL) {
      const hit = cache.get(path);
      if (hit && hit.until > Date.now()) return { body: hit.body, source: 'c0mpute' };
      try {
        const r = await fetchImpl(siteUrl + path.slice(1), { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const body = await r.text();
          // Only a copy that is really ours: the gateway can answer 200 with its own pages.
          if (path !== '/index.html' || body.includes('Board as a Service')) {
            cache.set(path, { body, until: Date.now() + 5 * 60_000 });
            return { body, source: 'c0mpute' };
          }
        }
      } catch {
        /* fall back below */
      }
      if (hit) return { body: hit.body, source: 'c0mpute-stale' };
    }
    return { body: localFile(path), source: 'local' };
  }

  // ---------------------------------------------------------------- routes
  async function route(req, res) {
    const url = new URL(req.url, publicUrl);
    const path = url.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method; // node drops the body for HEAD

    if (method === 'OPTIONS') return send(res, 204, '', CORS);

    if (path === '/healthz') return send(res, 200, { ok: true, version: VERSION, model: 'c0mpute', ...db.stats() });

    if (path === '/install.sh') {
      return send(res, 200, `#!/bin/sh\n# Board as a Service CLI: board-saas\nset -e\ncommand -v npm >/dev/null 2>&1 || { echo "board-saas needs Node 22+ and npm: https://nodejs.org" >&2; exit 1; }\nnpm install -g @profullstack/board-saas\necho "installed: run 'board-saas login you@example.com' then 'board-saas meet \\"<brief>\\"'"\n`, { 'content-type': 'text/x-shellscript; charset=utf-8' });
    }

    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\nDisallow: /m/\nDisallow: /api/\nDisallow: /oauth/\n', { 'content-type': 'text/plain' });

    // OAuth discovery: RFC 9728 (resource) at the root and path forms, RFC 8414 (server).
    if (method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) return send(res, 200, oauth.resourceMetadata('mcp'), { ...CORS, 'cache-control': 'public, max-age=3600' });
    if (method === 'GET' && path === '/.well-known/oauth-protected-resource/api/v1') return send(res, 200, oauth.resourceMetadata('api'), { ...CORS, 'cache-control': 'public, max-age=3600' });
    if (method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp' || path === '/.well-known/openid-configuration')) return send(res, 200, oauth.serverMetadata(), { ...CORS, 'cache-control': 'public, max-age=3600' });
    if (path.startsWith('/oauth/') || path === '/register') return oauthRoute(req, res, path, method, url);

    if (path === '/mcp') {
      if (method === 'GET') return send(res, 405, { error: 'POST JSON-RPC messages to this endpoint' }, { ...CORS, allow: 'POST' });
      if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, CORS);
      // Every MCP call needs a bearer: an OAuth access token or an API key. The 401 points the
      // client at the resource metadata, which is how connectors find the OAuth server.
      const key = bearer(req);
      if (!service.actorFor(key)) {
        await readBody(req).catch(() => '');
        return send(res, 401, { error: key ? 'invalid_token' : 'unauthorized', error_description: key ? 'the token is expired, revoked or unknown' : 'sign in with OAuth or send Authorization: Bearer <key>' }, { ...CORS, 'www-authenticate': oauth.challenge('mcp', key ? 'invalid_token' : undefined) });
      }
      const msg = await jsonBody(req);
      const handle = mcp(key);
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(handle))).filter(Boolean);
        return out.length ? send(res, 200, out, CORS) : send(res, 202, '', CORS);
      }
      const out = await handle(msg);
      return out ? send(res, 200, out, CORS) : send(res, 202, '', CORS);
    }

    if (path === '/api/v1/coinpay/webhook' && method === 'POST') {
      const raw = await readBody(req, 256 * 1024);
      const r = service.coinpayWebhook(raw, req.headers['x-coinpay-signature']);
      return send(res, r.status, r.body);
    }

    if (path.startsWith('/api/')) {
      const key = bearer(req);
      let m;
      if (path === '/api/v1' || path === '/api/v1/' || path === '/api') return send(res, 200, API_DOCS, CORS);
      if (path === '/api/v1/auth/code' && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, await service.startLogin(b.email, clientIp(req)), CORS);
      }
      if (path === '/api/v1/auth/verify' && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, service.verifyLogin(b.email, b.code), CORS);
      }
      if (path === '/api/v1/account' && method === 'GET') return send(res, 200, service.account(key), CORS);
      if (path === '/api/v1/meetings' && method === 'POST') {
        const b = await jsonBody(req);
        const v = await service.createMeeting(key, b.brief, b.company_data ?? b.context ?? null);
        return send(res, v.status === 'awaiting_payment' ? 402 : 201, v, CORS);
      }
      if (path === '/api/v1/meetings' && method === 'GET') return send(res, 200, { meetings: service.listMeetings(key) }, CORS);
      if (path === '/api/v1/connections' && method === 'GET') {
        const a = service.actorFor(key);
        if (!a?.account) throw new HttpError(401, 'sign in first', { auth: true });
        return send(res, 200, { connections: oauth.connections(a.account.id) }, NO_STORE);
      }
      if ((m = path.match(/^\/api\/v1\/connections\/([\w-]{3,80})$/)) && method === 'DELETE') {
        const a = service.actorFor(key);
        if (!a?.account) throw new HttpError(401, 'sign in first', { auth: true });
        return send(res, 200, oauth.disconnect(a.account.id, m[1]), NO_STORE);
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})$/)) && method === 'GET') return send(res, 200, service.getMeeting(m[1]), CORS);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/clarify$/)) && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, service.clarify(key, m[1], b.answers), CORS);
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/(report\.html|meeting\.json)$/)) && method === 'GET') {
        const v = service.getMeeting(m[1]);
        if (v.status !== 'done') throw new HttpError(409, `the meeting is ${v.status}; the report exists once it is done`);
        const slug = v.meeting.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'meeting';
        if (m[2] === 'meeting.json') return send(res, 200, v.meeting, { ...CORS, 'content-disposition': `inline; filename="${slug}.json"` });
        return send(res, 200, reportDownload(v), { ...CORS, 'content-disposition': `attachment; filename="board-${v.meeting.date}-${slug}.html"` });
      }
      throw new HttpError(404, 'no such endpoint; see /api/v1');
    }

    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/m/')) {
      const id = path.slice(3).replace(/\/$/, '');
      let v;
      try {
        v = service.getMeeting(id);
      } catch {
        return send(res, 404, '<!doctype html><title>Not found</title><p>No meeting with that link. <a href="/">Board as a Service</a></p>');
      }
      return send(res, 200, v.status === 'done' ? reportPage(v) : statusPage(v), { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    }

    if (method === 'GET' || method === 'HEAD') {
      const p = path === '/' ? '/index.html' : normalize(path);
      if (STATIC.has(p)) {
        const { body, source } = await staticFile(p);
        return send(res, 200, body, { 'content-type': TYPES[extname(p)], 'x-board-source': source, 'cache-control': 'public, max-age=300' });
      }
    }
    return send(res, 404, '<!doctype html><title>Not found</title><p>Not found. <a href="/">Board as a Service</a></p>');
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e?.status && e.status < 600 ? e.status : 500;
      if (status >= 500) log(`error ${req.method} ${req.url}: ${e?.stack ?? e}`);
      const { auth, ...extra } = e.extra ?? {};
      const headers = auth && status === 401 ? { ...CORS, 'www-authenticate': oauth.challenge('api', bearer(req) ? 'invalid_token' : undefined) } : CORS;
      if (!res.headersSent) send(res, status, { error: status >= 500 && !(e instanceof HttpError) ? `server error: ${e.message}` : e.message, ...extra }, headers);
    }
  }

  return { handler, service, db };
}

export function startServer(env = process.env) {
  if (!env.C0MPUTE_API_KEY) console.warn('warning: C0MPUTE_API_KEY is not set; c0mpute gives 10 free queries a day without a key');
  const app = createApp({ env });
  startFooterRefresh();
  app.service.resume();
  const port = Number(env.PORT) || 8826;
  const host = env.HOST || '127.0.0.1';
  const server = createServer(app.handler);
  server.requestTimeout = 120_000;
  server.listen(port, host, () => console.log(`board-saas ${VERSION} on http://${host}:${port}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startServer();

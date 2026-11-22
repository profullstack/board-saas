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
  auth: 'Authorization: Bearer <key>. Get a key: POST /auth/code {email} then POST /auth/verify {email, code}. Keys are full access to your account; a new verify replaces the old key.',
  pricing: `First meeting free per email, then $${PRICE_USD} per meeting via CoinPay (crypto). A meeting the network cannot finish is refunded.`,
  honesty: 'The advisors are AI models on the c0mpute network, not real directors.',
  endpoints: [
    { method: 'POST', path: '/auth/code', body: { email: 'you@example.com' }, does: 'Email a 6-digit sign-in code.' },
    { method: 'POST', path: '/auth/verify', body: { email: 'you@example.com', code: '123456' }, does: 'Exchange the code for an API key.' },
    { method: 'GET', path: '/account', auth: true, does: 'Free meeting left, paid credits.' },
    { method: 'POST', path: '/meetings', auth: true, body: { brief: 'Decision ... Options ... Constraints ...' }, does: 'Start a meeting. 201 with status queued, or awaiting_payment with checkout_url.' },
    { method: 'GET', path: '/meetings', auth: true, does: 'Your meetings, newest first.' },
    { method: 'GET', path: '/meetings/:id', does: 'Status, progress, and the full meeting when done. The id is the capability; share it like a link.' },
    { method: 'POST', path: '/meetings/:id/clarify', body: { answers: '...' }, does: 'Answer the chair\'s one round of questions (status needs_clarification).' },
    { method: 'GET', path: '/meetings/:id/report.html', does: 'The interactive report as a downloadable file.' },
    { method: 'GET', path: '/meetings/:id/meeting.json', does: 'The meeting data (boardroom meeting.json shape).' },
  ],
  mcp: { endpoint: 'https://board.saas.pit.world/mcp', transport: 'streamable HTTP (JSON responses)', auth: 'Authorization: Bearer <key>', tools: TOOLS.map((t) => t.name), stdio: 'npx -y @profullstack/board-saas mcp' },
  cli: 'npm i -g @profullstack/board-saas  (board-saas login | meet | get | list | tui | mcp)',
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

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
  const service = createService({ db, env, model, mailer, log, publicUrl });

  const mcp = (key) =>
    createMcpHandler(
      {
        runMeeting: (brief) => service.createMeeting(key, brief),
        getMeeting: async (id) => service.getMeeting(id),
      },
      { version: VERSION },
    );

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

    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\nDisallow: /m/\nDisallow: /api/\n', { 'content-type': 'text/plain' });

    if (path === '/mcp') {
      if (method === 'GET') return send(res, 405, { error: 'POST JSON-RPC messages to this endpoint' }, { ...CORS, allow: 'POST' });
      if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, CORS);
      const msg = await jsonBody(req);
      const handle = mcp(bearer(req));
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
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        return send(res, 200, await service.startLogin(b.email, ip), CORS);
      }
      if (path === '/api/v1/auth/verify' && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, service.verifyLogin(b.email, b.code), CORS);
      }
      if (path === '/api/v1/account' && method === 'GET') return send(res, 200, service.account(key), CORS);
      if (path === '/api/v1/meetings' && method === 'POST') {
        const b = await jsonBody(req);
        const v = await service.createMeeting(key, b.brief);
        return send(res, v.status === 'awaiting_payment' ? 402 : 201, v, CORS);
      }
      if (path === '/api/v1/meetings' && method === 'GET') return send(res, 200, { meetings: service.listMeetings(key) }, CORS);
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
      if (!res.headersSent) send(res, status, { error: status >= 500 && !(e instanceof HttpError) ? `server error: ${e.message}` : e.message, ...(e.extra ?? {}) }, CORS);
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

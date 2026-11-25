// Board as a Service: HTTP API, MCP endpoint, report pages and the public site.
// The public front page is the copy hosted on the c0mpute network (C0MPUTE_SITE_URL),
// with the bundled build as the fallback when the gateway does not answer.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchive } from './archive.js';
import { openDb } from './db.js';
import { allFooters, startFooterRefresh } from './footers.js';
import { createLive } from './live.js';
import { createModel } from './llm.js';
import { createClaudeModel } from './claude.js';
import { createC0mputeAccounts } from './c0mpute-account.js';
import { createMailer } from './mail.js';
import { createMcpHandler, TOOLS } from './mcp.js';
import { createOAuth, OAuthError } from './oauth.js';
import { createCoinPaySignIn } from './coinpay-signin.js';
import { coinpayChoosePage, coinpayConfirmPage, coinpayErrorPage, coinpayHandoffPage, consentPage, devicePage, errorPage, newNonce, pageHeaders } from './oauth-pages.js';
import { accountPage, adminPage, audiencePage, meetingsIndexPage, ownerReportPage, publicReportPage, reportDownload, reportPage, sharePage, statusPage } from './pages.js';
import { createPairux } from './pairux.js';
import { createRecordingStore, kekFrom } from './recording.js';
import { C0MPUTE_LINK_WARNING, createService, HttpError, PAYGO_PRICING, PRICE_USD } from './service.js';
import { createSpeech } from './speech.js';
import { runVoiceMeeting } from './voice.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const STATIC = new Set(['/index.html', '/style.css', '/app.js']);
const ICON_PNG = readFileSync(join(ROOT, 'public/icon.png')); // 512 px
const ICON_400 = readFileSync(join(ROOT, 'public/icon-400.png')); // directories that want exactly 400x400 (Cline)
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f5bd3"/><circle cx="9" cy="12" r="3" fill="white"/><circle cx="16" cy="10" r="3" fill="white"/><circle cx="23" cy="12" r="3" fill="white"/><rect x="6" y="18" width="20" height="5" rx="2" fill="white"/></svg>`;
function sendIcon(res, png = ICON_PNG) {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=86400' });
  res.end(png);
}

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
  pricing: `${PAYGO_PRICING} Voice meetings (live on PairUX, with recording) are a paid feature: free for a trial per account (up to 90 days, fixed at the first voice meeting), then a voice pass (BOARD_VOICE_PRICE_USD, default $19) per 30 days; a voice meeting also uses one meeting credit, like text. Profullstack Pass (coinpayportal.com/pass): while CoinPay reports an active pass at your last Sign in with CoinPay, board meetings (text and voice) are included and do not use your free meeting or credits. Premium (BOARD_PREMIUM_PRICE_USD, default $29 per 30 days through CoinPay): a branded 1080x1080 LinkedIn video of each voice meeting and its trimmed MP3; an active Profullstack Pass includes Premium. The recording and the captioned meeting video stay free.`,
  privacy: 'Meetings are private to their owner by default: status, report, recording and transcript need the owner\'s key, or a share link the owner made (POST /meetings/:id/shares). The owner can publish a meeting (PATCH /meetings/:id {visibility:"public"}): it then has a public page at /m/<public id> and is listed on /meetings. Meetings made before 0.3.0 keep their old link.',
  sharing: {
    roles: { view: 'the report', listen: 'the report, the live audio while the meeting runs, the recording afterwards', join: 'listen, plus the PairUX join link while the call is open (never after the meeting ended)' },
    links: 'Every share is a token checked by this server on each request: it can expire and can be revoked. Share pages: /s/<token>, /s/<token>/state.json, /s/<token>/recording.mp3.',
    live: 'Live audio is an unlisted c0mpute Live stream (HLS). It exists only while the meeting is public or has an active listen or join share: a private meeting nobody was invited to sends nothing to c0mpute. Unlisted is not encrypted: the share token gates the page that reveals the playback URL. The stream is deleted when the meeting ends, or when the last invite is revoked or expires.',
    c0mpute_private_link: C0MPUTE_LINK_WARNING,
  },
  honesty: 'The advisors are AI models on the c0mpute network, not real directors.',
  endpoints: [
    { method: 'POST', path: '/auth/code', body: { email: 'you@example.com' }, does: 'Email a 6-digit sign-in code.' },
    { method: 'POST', path: '/auth/verify', body: { email: 'you@example.com', code: '123456' }, does: 'Exchange the code for an API key.' },
    { method: 'GET', path: '/account', auth: true, does: 'Free meeting left, old prepaid credits, voice standing, CoinPay link, Profullstack Pass, and the c0mpute connection and balance meetings are charged to.' },
    { method: 'POST', path: '/c0mpute/connect', auth: true, does: 'Connect your c0mpute account (your CoinPay account) to pay for meetings as you go: returns authorize_url, a c0mpute sign-in link. Top up with CoinPay on c0mpute.' },
    { method: 'DELETE', path: '/c0mpute', auth: true, does: 'Disconnect your c0mpute account; Board can no longer charge it.' },
    { method: 'GET', path: '(site) /auth/coinpay/start?return_to=/path', does: 'Sign in with CoinPay in a browser: bound to your CoinPay account id (sub), never to its email. An unknown CoinPay account gets a new board account; connect CoinPay to an email account from /account while signed in.' },
    { method: 'POST', path: '/auth/coinpay/link', auth: true, does: 'Connect CoinPay to this account: returns a one-time url to open in this browser.' },
    { method: 'DELETE', path: '/auth/coinpay', auth: true, does: 'Disconnect CoinPay (not for an account made by Sign in with CoinPay).' },
    { method: 'POST', path: '/meetings', auth: true, body: { brief: 'Decision ... Options ... Constraints ...', company_data: 'optional: P&L, cash, runway, MRR, churn (max 12000 chars, text or JSON); every advisor reads it, the shareable report does not show it', voice: 'optional, default false: hold the meeting live on PairUX; the result carries call.join_url once the brief is checked', record: 'optional, default true for voice: record the call (private to you, encrypted)' }, does: 'Start a meeting. 201 with status queued, or awaiting_payment with checkout_url. 402 voice_trial_ended (with checkout_url) when the voice trial is over and no voice pass is active.' },
    { method: 'POST', path: '/meetings/:id/start', auth: true, does: 'Voice meeting: start now instead of waiting for you to join the call.' },
    { method: 'POST', path: '/voice/checkout', auth: true, does: 'A CoinPay checkout for a voice pass (30 days of voice meetings).' },
    { method: 'GET', path: '/meetings/:id/recording', auth: true, does: 'The call recording (MP3), decrypted for its owner; supports Range.' },
    { method: 'DELETE', path: '/meetings/:id/recording', auth: true, does: 'Delete the recording and transcript: the key is destroyed, so no copy can be played again.' },
    { method: 'POST', path: '/meetings/:id/branded-video', auth: true, body: { force: 'optional: make it again' }, does: 'Premium: make the branded 1080x1080 LinkedIn video of a voice meeting (title banner, waveform, subtitles coloured per speaker, every pause cut to 0.35 s) and its trimmed MP3. 202 while it renders (1 to 2 minutes), 200 when done; 402 premium_required with a checkout_url without Premium. Premium accounts get it made by itself after each recorded voice meeting. The captioned meeting video stays free.' },
    { method: 'GET', path: '/meetings/:id/branded.mp4', auth: true, does: 'Premium: the branded LinkedIn video (H.264 + AAC), decrypted for its owner; supports Range. Listen shares play it at /s/<token>/branded.mp4, a public meeting with its recording at /m/<public id>/branded.mp4.' },
    { method: 'GET', path: '/meetings/:id/trimmed.mp3', auth: true, does: 'Premium: the recording with every pause shortened to 0.35 s (MP3).' },
    { method: 'POST', path: '/meetings/:id/branded-video/link', auth: true, body: { kind: 'branded | trimmed' }, does: 'A 6-hour link to the branded video or trimmed MP3 that needs no key (for a <video> element or an upload).' },
    { method: 'POST', path: '/premium/checkout', auth: true, does: 'A CoinPay checkout for Premium (BOARD_PREMIUM_PRICE_USD, default $29, per 30 days). An active Profullstack Pass includes Premium.' },
    { method: 'GET', path: '/meetings/:id/transcript', auth: true, does: 'The call transcript (board lines verbatim, founder via Whisper).' },
    { method: 'PATCH', path: '/meetings/:id', auth: true, body: { visibility: 'public | private', include_recording: 'optional, default false: put the recording player on the public page' }, does: 'Publish a meeting or make it private again. Returns the meeting with visibility and public_url.' },
    { method: 'POST', path: '/meetings/:id/shares', auth: true, body: { role: 'view | listen | join (default view, or listen when include_recording is true)', label: 'optional: who it is for', allow_download: false, expires: 'never | 24h | 7d | 30d' }, does: 'Create a share link (an invite). view needs a finished meeting; listen and join can be made for a voice meeting before and while it runs. Returns url and role.' },
    { method: 'GET', path: '/shareables', auth: true, does: 'Everything you can hand to someone, per meeting: title, status, visibility, public_url, active shares (role, label, url, expiry), the live playback URL while running, and the private c0mpute link of the recording if there is one.' },
    { method: 'GET', path: '/meetings/:id/shares', auth: true, does: 'Share links for a meeting.' },
    { method: 'GET', path: '/shares', auth: true, does: 'All your share links.' },
    { method: 'DELETE', path: '/shares/:id', auth: true, does: 'Revoke a share link at once.' },
    { method: 'GET', path: '/meetings', auth: true, does: 'Your meetings, newest first.' },
    { method: 'GET', path: '/meetings/:id', auth: true, does: 'Status, progress (and the live call\'s join link), and the full meeting when done. Private to the owner.' },
    { method: 'POST', path: '/meetings/:id/clarify', body: { answers: '...' }, does: 'Answer the chair\'s one round of questions (status needs_clarification).' },
    { method: 'GET', path: '/meetings/:id/report.html', auth: true, does: 'The interactive report as a downloadable file.' },
    { method: 'GET', path: '/meetings/:id/meeting.json', auth: true, does: 'The meeting data (boardroom meeting.json shape).' },
    { method: 'GET', path: '/connections', auth: true, does: 'Apps connected to your account over OAuth.' },
    { method: 'DELETE', path: '/connections/:client_id', auth: true, does: 'Disconnect an app; its tokens stop working at once.' },
  ],
  mcp: { endpoint: 'https://board.saas.pit.world/mcp', transport: 'streamable HTTP (JSON responses)', auth: 'OAuth 2.1 (add the URL as a connector; the client discovers and registers itself) or Authorization: Bearer <key>', tools: TOOLS.map((t) => t.name), stdio: 'npx -y @profullstack/board-saas mcp' },
  cli: 'npm i -g @profullstack/board-saas  (board-saas login | meet | get | list | publish | invite | share | shareables | connections | tui | mcp)',
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
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
};
const NO_STORE = { ...CORS, 'cache-control': 'no-store', pragma: 'no-cache' };
// Admin answers carry no CORS headers: no other site's page may read them.
const ADMIN_HEADERS = { 'cache-control': 'no-store', pragma: 'no-cache', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, {
    'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body, null, 1));
}

export function createApp({ env = process.env, db, model, freeModel, c0mpute: c0mputeOverride, brandedRenderer, mailer, fetchImpl = fetch, log = console.log, voice: voiceOverride, kek: kekOverride, coinpay: coinpayOverride, live: liveOverride, archive: archiveOverride, abtest, spawnImpl } = {}) {
  const publicUrl = (env.PUBLIC_URL || 'https://board.saas.pit.world').replace(/\/+$/, '');
  db ??= openDb(env.BOARD_DB || join(env.HOME || '.', '.local/share/board-saas/board.db'));
  // Board meetings run on Claude (Opus 5.5); c0mpute serves only free-tier meetings.
  // Without an ANTHROPIC_API_KEY (tests, local dev) everything stays on c0mpute.
  freeModel ??= model ?? createModel(env);
  model ??= env.ANTHROPIC_API_KEY ? createClaudeModel(env) : freeModel;
  mailer ??= createMailer(env, fetchImpl);
  const oauth = createOAuth({ db, publicUrl, log });
  // Voice meetings: PairUX (partner key) for the call, c0mpute Kokoro for the voices.
  const pairux = createPairux({ url: env.PAIRUX_URL || 'https://pairux.com', key: env.PAIRUX_PARTNER_KEY, fetchImpl });
  const speech = env.C0MPUTE_SPEECH_TOKEN ? createSpeech({ url: env.C0MPUTE_SPEECH_URL || 'http://127.0.0.1:8818', token: env.C0MPUTE_SPEECH_TOKEN, fetchImpl, log }) : null;
  const voice = voiceOverride !== undefined ? voiceOverride : env.BOARD_VOICE === '0' ? null : { pairux, speech, run: runVoiceMeeting };
  const dataDir = env.BOARD_DATA_DIR || join(env.HOME || '.', '.local/share/board-saas');
  const kek = kekOverride ?? kekFrom(env);
  const recordings = createRecordingStore({ dir: env.BOARD_RECORDINGS_DIR || join(dataDir, 'recordings'), env, log });
  // c0mpute Live (listen invites) and c0mpute private storage (the recording's private link):
  // each is on only when its key is set, and the rest of the service does not depend on either.
  const c0mputeUrl = env.BOARD_C0MPUTE_URL || 'https://c0mpute.com';
  const live = liveOverride !== undefined ? liveOverride : env.BOARD_C0MPUTE_KEY ? createLive({ key: env.BOARD_C0MPUTE_KEY, url: c0mputeUrl, fetchImpl, ...(spawnImpl ? { spawnImpl } : {}), ffmpeg: env.FFMPEG || 'ffmpeg', log }) : null;
  const archive = archiveOverride !== undefined ? archiveOverride : env.BOARD_C0MPUTE_STORAGE_TOKEN ? createArchive({ token: env.BOARD_C0MPUTE_STORAGE_TOKEN, baseUrl: c0mputeUrl, fetchImpl, log }) : null;
  const c0mpute = c0mputeOverride ?? createC0mputeAccounts({ db, env, kek, publicUrl, fetchImpl, log });
  const service = createService({ db, env, model, freeModel, c0mpute, mailer, log, publicUrl, accountForToken: oauth.accountForAccessToken, voice, recordings, kek, live, archive, coinpay: coinpayOverride, abtest, ...(brandedRenderer ? { brandedRenderer } : {}), videoTmpDir: join(dataDir, 'video-tmp') });
  const origin = new URL(publicUrl).origin;
  // Sign in with CoinPay (on when COINPAY_OAUTH_CLIENT_ID and COINPAY_OAUTH_CLIENT_SECRET are set).
  const coinpaySignIn = createCoinPaySignIn({ db, env, publicUrl, oauth, fetchImpl, log });
  // Absolute on purpose: the flow's browser-binding cookie must be set on the host the callback returns to.
  const coinpayStart = (returnTo) => (coinpaySignIn.configured ? `${publicUrl}/auth/coinpay/start?return_to=${encodeURIComponent(returnTo)}` : null);
  const accountOf = (key) => {
    const a = service.actorFor(key);
    if (!a?.account) throw new HttpError(401, a?.admin ? 'the admin key has no account to connect' : 'sign in first', { auth: !a });
    return a.account;
  };

  const mcp = (key) =>
    createMcpHandler(
      {
        runMeeting: (brief, companyData, opts) => service.createMeeting(key, brief, companyData, opts),
        getMeeting: async (id) => service.getMeeting(key, id),
        startNow: async (id) => service.startNow(key, id),
        connectC0mpute: async () => service.c0mputeConnect(key),
        shareMeeting: async (id, opts) => service.createShare(key, id, opts),
        listShares: async (id) => service.listShares(key, id),
        revokeShare: async (shareId) => service.revokeShare(key, shareId),
        publishMeeting: async (id, opts) => service.setVisibility(key, id, opts),
        listShareables: async () => service.shareables(key),
        voiceCheckout: async () => service.voiceCheckoutFor(key),
        makeBrandedVideo: async (id, opts) => service.requestBranded(key, id, opts),
        premiumCheckout: async () => service.premiumCheckoutFor(key),
        listMeetings: async () => service.listMeetings(key),
        clarify: async (id, answers) => service.clarify(key, id, answers),
        account: async () => service.accountWithBalance(key),
      },
      { version: VERSION },
    );

  /**
   * Browser POSTs to /oauth/* must come from our own pages. The pit.world edge forwards with
   * the Moshpit name (Host and Origin both `board.saas`), so an Origin whose host is the
   * request's Host is ours too; a cross-site page cannot make those two match.
   */
  function sameOrigin(req) {
    const o = req.headers.origin;
    if (!o || o === origin) return;
    let host = null;
    try {
      host = new URL(o).host;
    } catch {
      /* "null" or garbage */
    }
    if (host && host === req.headers.host) return;
    throw new HttpError(403, `cross-site request refused (Origin ${String(o).slice(0, 80)})`);
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
      return send(res, 200, consentPage({ client: ar.client, redirectUri: ar.redirectUri, session, query: url.search, nonce, coinpayUrl: coinpayStart(`/oauth/authorize${url.search}`) }), pageHeaders(nonce));
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
      return send(res, 200, devicePage({ session: oauth.sessionFor(req.headers.cookie), nonce, coinpayUrl: coinpayStart('/oauth/device') }), pageHeaders(nonce));
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

  /** /auth/coinpay/*: start, callback, choose. Errors are shown as a page, never redirected. */
  async function coinpayRoute(req, res, path, method, url) {
    const nonce = newNonce();
    try {
      if (path === '/auth/coinpay/start' && method === 'GET') {
        const { location, cookie } = coinpaySignIn.start(url.searchParams);
        return send(res, 302, '', { location, 'set-cookie': cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      }
      if (path === '/auth/coinpay/callback' && method === 'GET') {
        const r = await coinpaySignIn.callback(url.searchParams, req.headers.cookie);
        if (r.kind === 'choose') return send(res, 200, coinpayChoosePage({ token: r.token, accounts: r.accounts, nonce }), pageHeaders(nonce));
        const clear = coinpaySignIn.clearCookie();
        if (r.kind === 'confirm_link') return send(res, 200, coinpayConfirmPage({ token: r.token, nonce }), { ...pageHeaders(nonce), 'set-cookie': clear });
        return send(res, 200, coinpayHandoffPage({ apiKey: r.apiKey, returnTo: r.returnTo, nonce }), { ...pageHeaders(nonce), 'set-cookie': [r.sessionCookie, clear] });
      }
      if (path === '/auth/coinpay/choose' && method === 'POST') {
        sameOrigin(req);
        const b = Object.fromEntries(new URLSearchParams(await readBody(req, 8 * 1024)));
        const r = coinpaySignIn.choose(b.token, b.account_id, req.headers.cookie);
        return send(res, 200, coinpayHandoffPage({ apiKey: r.apiKey, returnTo: r.returnTo, nonce }), { ...pageHeaders(nonce), 'set-cookie': [r.sessionCookie, coinpaySignIn.clearCookie()] });
      }
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return send(res, e.status, coinpayErrorPage(e.message, nonce), { ...pageHeaders(nonce), 'set-cookie': coinpaySignIn.clearCookie() });
    }
    return send(res, 404, coinpayErrorPage('No such page.', nonce), pageHeaders(nonce));
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
          // A copy published with the placeholder gets the live footers here, like the local build.
          const body = path === '/index.html' ? (await r.text()).replace('<!--FOOTERS-->', allFooters()) : await r.text();
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

  /** Decrypt and stream a recording, honouring Range so players can seek. */
  // branded: 'branded' (the Premium LinkedIn MP4) or 'trimmed' (its MP3); video: the free captioned MP4.
  async function streamRecording(req, res, meetingId, { download = false, video = false, branded = null } = {}) {
    const r = branded ? service.openBranded(meetingId, branded) : video ? await service.openVideo(meetingId) : await service.openRecording(meetingId);
    const fileName = branded === 'branded' ? `board-meeting-${meetingId}-linkedin.mp4` : branded === 'trimmed' ? `board-meeting-${meetingId}-trimmed.mp3` : `board-meeting-${meetingId}.${video ? 'mp4' : 'mp3'}`;
    try {
      const total = r.length;
      const head = { 'content-type': r.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': download ? `attachment; filename="${fileName}"` : 'inline' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      let start = 0;
      let end = total - 1;
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
        } else {
          start = Math.max(0, total - Number(range[2]));
        }
        if (start > end || start >= total) {
          res.writeHead(416, { ...head, 'content-range': `bytes */${total}` });
          return res.end();
        }
        res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 });
      } else res.writeHead(200, { ...head, 'content-length': total });
      if (req.method === 'HEAD') return res.end();
      const STEP = 512 * 1024;
      for (let o = start; o <= end; o += STEP) {
        const ok = res.write(r.read(o, Math.min(end, o + STEP - 1)));
        if (!ok) await new Promise((done) => res.once('drain', done));
      }
      res.end();
    } finally {
      r.close();
    }
  }

  // ---------------------------------------------------------------- routes
  async function route(req, res) {
    const url = new URL(req.url, publicUrl);
    const path = url.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method; // node drops the body for HEAD
    let m;

    if (method === 'OPTIONS') return send(res, 204, '', CORS);

    // The end of a c0mpute sign-in (pay as you go): store the key, back to the app.
    if (path === '/c0mpute/callback' && method === 'GET') {
      const q = url.searchParams;
      const to = new URL(`${publicUrl}/`);
      if (q.get('error')) to.searchParams.set('c0mpute_error', q.get('error') === 'access_denied' ? 'You did not allow the connection.' : String(q.get('error_description') || q.get('error')).slice(0, 200));
      else {
        try {
          const r = await service.c0mputeFinish(q.get('code'), q.get('state'));
          to.searchParams.set('c0mpute', 'connected');
          log(`account ${r.accountId}: c0mpute connected`);
        } catch (e) {
          to.searchParams.set('c0mpute_error', String(e.message).slice(0, 200));
        }
      }
      return send(res, 303, '', { location: to.toString(), 'cache-control': 'no-store' });
    }
    if (path === '/healthz') return send(res, 200, { ok: true, version: VERSION, model: model.name, free_model: freeModel.name, ...db.stats() });

    if (path === '/install.sh') {
      return send(res, 200, `#!/bin/sh\n# Board as a Service CLI: board-saas\nset -e\ncommand -v npm >/dev/null 2>&1 || { echo "board-saas needs Node 22+ and npm: https://nodejs.org" >&2; exit 1; }\nnpm install -g @profullstack/board-saas\necho "installed: run 'board-saas login you@example.com' then 'board-saas meet \\"<brief>\\"'"\n`, { 'content-type': 'text/x-shellscript; charset=utf-8' });
    }

    // A fetchable icon for directories and browsers (the page itself uses an inline one).
    if (path === '/favicon.ico' || path === '/icon.png' || path === '/apple-touch-icon.png') return sendIcon(res);
    if (path === '/icon-400.png') return sendIcon(res, ICON_400);
    if (path === '/favicon.svg') return send(res, 200, ICON_SVG, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });

    // /m/ is crawlable because public meetings live there; private meeting pages under /m/ answer
    // with noindex (header and meta), which a crawler can only obey if it may fetch the page.
    if (path === '/robots.txt') return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /s/\nDisallow: /media/\nDisallow: /api/\nDisallow: /oauth/\nDisallow: /auth/\nDisallow: /account\nDisallow: /admin\nSitemap: ${publicUrl}/sitemap.xml\n`, { 'content-type': 'text/plain' });
    if (path === '/sitemap.xml' && method === 'GET') {
      const urls = [`${publicUrl}/`, `${publicUrl}/meetings`, ...service.publicIndex().map((x) => x.url)];
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${u}</loc></url>`).join('\n')}\n</urlset>\n`, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
    }
    if ((path === '/meetings' || path === '/meetings/') && method === 'GET') return send(res, 200, meetingsIndexPage(service.publicIndex(), { canonical: `${publicUrl}/meetings` }), { 'cache-control': 'public, max-age=60' });

    // OAuth discovery: RFC 9728 (resource) at the root and path forms, RFC 8414 (server).
    if (method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) return send(res, 200, oauth.resourceMetadata('mcp'), { ...CORS, 'cache-control': 'public, max-age=3600' });
    if (method === 'GET' && path === '/.well-known/oauth-protected-resource/api/v1') return send(res, 200, oauth.resourceMetadata('api'), { ...CORS, 'cache-control': 'public, max-age=3600' });
    if (method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp' || path === '/.well-known/openid-configuration')) return send(res, 200, oauth.serverMetadata(), { ...CORS, 'cache-control': 'public, max-age=3600' });
    if (path.startsWith('/oauth/') || path === '/register') return oauthRoute(req, res, path, method, url);

    // Sign in with CoinPay and the account page.
    if ((path === '/account' || path === '/account/') && method === 'GET') {
      return send(res, 200, accountPage({ coinpayUrl: coinpayStart('/account'), coinpayEnabled: coinpaySignIn.configured }), { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    }
    if (path.startsWith('/auth/coinpay/')) return coinpayRoute(req, res, path, method, url);
    // /admin: a shell like /account, with nothing in it. Every lookup and change goes through
    // /api/v1/admin/*, which only answers the admin key or an admin account's own key.
    if ((path === '/admin' || path === '/admin/') && method === 'GET') return send(res, 200, adminPage(), ADMIN_HEADERS);

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
      if (path === '/api/v1' || path === '/api/v1/' || path === '/api') return send(res, 200, API_DOCS, CORS);
      if (path === '/api/v1/auth/code' && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, await service.startLogin(b.email, clientIp(req)), CORS);
      }
      if (path === '/api/v1/auth/verify' && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, service.verifyLogin(b.email, b.code), CORS);
      }
      if (path === '/api/v1/account' && method === 'GET') return send(res, 200, await service.accountWithBalance(key), CORS);
      if (path === '/api/v1/c0mpute/connect' && method === 'POST') return send(res, 200, service.c0mputeConnect(key), NO_STORE);
      if (path === '/api/v1/c0mpute' && method === 'DELETE') return send(res, 200, await service.c0mputeDisconnect(key), NO_STORE);
      if (path === '/api/v1/auth/coinpay/link' && method === 'POST') return send(res, 200, coinpaySignIn.linkUrl(accountOf(key).id), NO_STORE);
      if (path === '/api/v1/auth/coinpay/confirm' && method === 'POST') {
        const account = accountOf(key);
        const b = await jsonBody(req);
        return send(res, 200, coinpaySignIn.confirmLink(account.id, String(b.token ?? '')), NO_STORE);
      }
      if (path === '/api/v1/auth/coinpay' && method === 'DELETE') return send(res, 200, coinpaySignIn.unlink(accountOf(key).id), NO_STORE);
      // ---- admin (no CORS: only our own /admin page and the admin key from a terminal)
      if (path.startsWith('/api/v1/admin/')) {
        if (path === '/api/v1/admin/me' && method === 'GET') return send(res, 200, service.adminWho(key), ADMIN_HEADERS);
        if (path === '/api/v1/admin/accounts' && method === 'GET') return send(res, 200, service.adminFind(key, url.searchParams.get('q')), ADMIN_HEADERS);
        if ((m = path.match(/^\/api\/v1\/admin\/accounts\/([\w-]{3,64})$/)) && method === 'POST') {
          sameOrigin(req); // CSRF: a browser POST must come from our own page (Origin = our origin, or = Host at the pit.world edge)
          service.adminWho(key); // refuse before reading the body
          return send(res, 200, service.adminAct(key, m[1], await jsonBody(req), clientIp(req)), ADMIN_HEADERS);
        }
        if (path === '/api/v1/admin/audit' && method === 'GET') return send(res, 200, { audit: service.adminAudit(key, url.searchParams.get('account'), url.searchParams.get('limit')) }, ADMIN_HEADERS);
        throw new HttpError(404, 'no such admin endpoint');
      }
      // ---- Premium: the branded LinkedIn rendition
      if (path === '/api/v1/premium/checkout' && method === 'POST') return send(res, 200, await service.premiumCheckoutFor(key), NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/branded-video$/)) && method === 'POST') {
        const b = await jsonBody(req);
        const v = await service.requestBranded(key, m[1], { force: b.force === true });
        return send(res, v.status === 'done' ? 200 : 202, v, NO_STORE);
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/branded-video\/link$/)) && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, service.brandedLink(key, m[1], b.kind === 'trimmed' ? 'trimmed' : 'branded'), NO_STORE);
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/(branded\.mp4|trimmed\.mp3)$/)) && method === 'GET') {
        const kind = m[2] === 'trimmed.mp3' ? 'trimmed' : 'branded';
        service.brandedLink(key, m[1], kind); // owner check
        return streamRecording(req, res, m[1], { branded: kind, download: url.searchParams.has('download') });
      }
      if (path === '/api/v1/meetings' && method === 'POST') {
        const b = await jsonBody(req);
        const v = await service.createMeeting(key, b.brief, b.company_data ?? b.context ?? null, { voice: b.voice, record: b.record });
        return send(res, v.status === 'awaiting_payment' ? 402 : 201, v, NO_STORE);
      }
      if (path === '/api/v1/meetings' && method === 'GET') return send(res, 200, { meetings: service.listMeetings(key) }, CORS);
      if (path === '/api/v1/shareables' && method === 'GET') return send(res, 200, { shareables: service.shareables(key) }, NO_STORE);
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
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})$/)) && method === 'GET') return send(res, 200, service.getMeeting(key, m[1]), NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})$/)) && method === 'PATCH') return send(res, 200, service.setVisibility(key, m[1], await jsonBody(req)), NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/start$/)) && method === 'POST') return send(res, 200, service.startNow(key, m[1]), NO_STORE);
      if (path === '/api/v1/voice/checkout' && method === 'POST') return send(res, 200, await service.voiceCheckoutFor(key), NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/page\.html$/)) && method === 'GET') {
        const { view, owner } = service.reportData(key, m[1]);
        if (view.status !== 'done') throw new HttpError(409, `the meeting is ${view.status}`);
        if (!owner) return send(res, 200, reportPage(view), NO_STORE);
        const mediaUrl = view.recording && !view.recording.deleted ? service.signMedia(view.id) : null;
        const transcript = view.transcript_url ? service.transcript(key, view.id) : null;
        const brandedUrls = view.branded_video?.status === 'done' ? { video: service.signMedia(view.id, 6 * 3_600_000, 'branded'), trimmed: view.branded_video.trimmed_mp3_url ? service.signMedia(view.id, 6 * 3_600_000, 'trimmed') : null } : null;
        return send(res, 200, ownerReportPage(view, { mediaUrl, transcript, brandedUrls }), { ...NO_STORE, 'x-robots-tag': 'noindex' });
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/video$/)) && method === 'GET') {
        service.recordingLink(key, m[1]); // owner check
        return streamRecording(req, res, m[1], { download: url.searchParams.has('download'), video: true });
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/recording$/)) && method === 'GET') {
        service.recordingLink(key, m[1]); // owner check
        return streamRecording(req, res, m[1], { download: url.searchParams.has('download') });
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/recording\/link$/)) && method === 'POST') return send(res, 200, service.recordingLink(key, m[1]), NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/recording$/)) && method === 'DELETE') return send(res, 200, await service.deleteRecording(key, m[1]), NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/transcript$/)) && method === 'GET') return send(res, 200, { transcript: service.transcript(key, m[1]) }, NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/shares$/)) && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 201, service.createShare(key, m[1], b), NO_STORE);
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/shares$/)) && method === 'GET') return send(res, 200, { shares: service.listShares(key, m[1]) }, NO_STORE);
      if (path === '/api/v1/shares' && method === 'GET') return send(res, 200, { shares: service.listShares(key) }, NO_STORE);
      if ((m = path.match(/^\/api\/v1\/shares\/([\w-]{6,40})$/)) && method === 'DELETE') return send(res, 200, service.revokeShare(key, m[1]), NO_STORE);
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/clarify$/)) && method === 'POST') {
        const b = await jsonBody(req);
        return send(res, 200, service.clarify(key, m[1], b.answers), CORS);
      }
      if ((m = path.match(/^\/api\/v1\/meetings\/([\w-]{8,40})\/(report\.html|meeting\.json)$/)) && method === 'GET') {
        const v = service.getMeeting(key, m[1]);
        if (v.status !== 'done') throw new HttpError(409, `the meeting is ${v.status}; the report exists once it is done`);
        const slug = v.meeting.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'meeting';
        if (m[2] === 'meeting.json') return send(res, 200, v.meeting, { ...CORS, 'content-disposition': `inline; filename="${slug}.json"` });
        return send(res, 200, reportDownload(v), { ...CORS, 'content-disposition': `attachment; filename="board-${v.meeting.date}-${slug}.html"` });
      }
      throw new HttpError(404, 'no such endpoint; see /api/v1');
    }

    // /m/<id>: the owner's meeting page by its internal id (a shell that signs in; nothing private
    // is in it), or a PUBLIC meeting by its public id. A private meeting has no public id that
    // resolves, so its public URL answers 404 like any unknown link.
    if (method === 'GET' && (m = path.match(/^\/m\/([\w-]{1,64})(\/recording\.mp3|\/video\.mp4|\/branded\.mp4|\/state\.json)?\/?$/))) {
      const id = m[1];
      const row = m[2] ? null : db.meeting(id);
      if (row) {
        // Private meetings: a shell that signs in from the browser and loads the report over the API.
        if (row.private || row.status !== 'done') return send(res, 200, statusPage(id, { coinpayUrl: coinpayStart(`/m/${id}`) }), { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        return send(res, 200, reportPage(service.getMeeting(null, id)), { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      }
      let pub;
      try {
        pub = service.publicMeeting(id);
      } catch (e) {
        if (m[2]) return send(res, 404, { error: e.message }, { 'cache-control': 'no-store' });
        return send(res, 404, '<!doctype html><title>Not found</title><p>No meeting with that link. <a href="/">Board as a Service</a></p>', { 'x-robots-tag': 'noindex' });
      }
      if (m[2] === '/state.json') return send(res, 200, pub.state, { 'cache-control': 'no-store' });
      if (m[2] === '/recording.mp3') {
        if (!pub.recordingAvailable) return send(res, 404, { error: 'this public meeting does not include a recording' }, { 'cache-control': 'no-store' });
        return streamRecording(req, res, pub.row.id, { download: url.searchParams.has('download') });
      }
      if (m[2] === '/branded.mp4') {
        if (!pub.brandedAvailable) return send(res, 404, { error: 'this public meeting has no branded video' }, { 'cache-control': 'no-store' });
        return streamRecording(req, res, pub.row.id, { branded: 'branded', download: url.searchParams.has('download') });
      }
      if (m[2] === '/video.mp4') {
        if (!pub.videoAvailable) return send(res, 404, { error: 'this public meeting has no video' }, { 'cache-control': 'no-store' });
        return streamRecording(req, res, pub.row.id, { video: true, download: url.searchParams.has('download') });
      }
      // Public pages are indexable: no noindex header, and a canonical link in the page.
      if (pub.view) return send(res, 200, publicReportPage(pub, { mediaUrl: `${pub.url}/recording.mp3?v=1`, videoUrl: pub.videoAvailable ? `${pub.url}/video.mp4?v=1` : null, brandedUrl: pub.brandedAvailable ? `${pub.url}/branded.mp4?v=1` : null }), { 'cache-control': 'public, max-age=60' });
      return send(res, 200, audiencePage({ state: pub.state, stateUrl: `/m/${pub.publicId}/state.json`, kind: 'public', indexable: true, canonical: pub.url }), { 'cache-control': 'no-store' });
    }
    if (method === 'GET' && path.startsWith('/m/')) return send(res, 404, '<!doctype html><title>Not found</title><p>No meeting with that link. <a href="/">Board as a Service</a></p>');

    // Signed media links (an <audio> element cannot send a bearer header): 6 hours, owner-minted.
    if ((m = path.match(/^\/media\/([\w-]{8,40})\.(mp3|mp4)$/)) && method === 'GET') {
      if (!service.checkMedia(m[1], url.searchParams.get('exp'), url.searchParams.get('sig'))) return send(res, 403, { error: 'this media link is invalid or expired; reload the report' }, NO_STORE);
      return streamRecording(req, res, m[1], { download: url.searchParams.has('download'), video: m[2] === 'mp4' });
    }

    if ((m = path.match(/^\/media\/(branded|trimmed)\/([\w-]{8,40})\.(mp4|mp3)$/)) && method === 'GET') {
      const kind = m[1];
      if ((kind === 'branded') !== (m[3] === 'mp4') || !service.checkMedia(m[2], url.searchParams.get('exp'), url.searchParams.get('sig'), kind)) return send(res, 403, { error: 'this media link is invalid or expired; reload the report' }, NO_STORE);
      return streamRecording(req, res, m[2], { branded: kind, download: url.searchParams.has('download') });
    }

    // Share links (invites). The token is looked up on every request, here and for the state and
    // the recording, so a revoked or expired link stops working at once on all three.
    if ((m = path.match(/^\/s\/([\w-]{20,64})(\/recording\.mp3|\/video\.mp4|\/branded\.mp4|\/state\.json)?$/)) && method === 'GET') {
      let shared;
      try {
        shared = service.byShareToken(m[1]);
      } catch (e) {
        if (m[2]) return send(res, 404, { error: e.message }, NO_STORE);
        return send(res, 404, `<!doctype html><title>Link not available</title><p>${e.message}. <a href="/">Board as a Service</a></p>`, { 'cache-control': 'no-store' });
      }
      const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' };
      // What this role may have right now: the playback URL while running (listen, join), the join link while the call is open (join).
      if (m[2] === '/state.json') return send(res, 200, shared.state, headers);
      if (m[2] === '/recording.mp3') {
        if (!shared.recordingAvailable) return send(res, 404, { error: 'this share does not include a recording' }, NO_STORE);
        const download = url.searchParams.has('download') && !!shared.share.allow_download;
        return streamRecording(req, res, shared.row.id, { download });
      }
      if (m[2] === '/branded.mp4') {
        if (!shared.brandedAvailable) return send(res, 404, { error: 'this share does not include a branded video' }, NO_STORE);
        return streamRecording(req, res, shared.row.id, { branded: 'branded', download: url.searchParams.has('download') && !!shared.share.allow_download });
      }
      if (m[2] === '/video.mp4') {
        if (!shared.videoAvailable) return send(res, 404, { error: 'this share does not include a video' }, NO_STORE);
        return streamRecording(req, res, shared.row.id, { download: url.searchParams.has('download') && !!shared.share.allow_download, video: true });
      }
      if (!shared.view) return send(res, 200, audiencePage({ state: shared.state, stateUrl: `/s/${m[1]}/state.json`, share: shared.share }), headers);
      return send(res, 200, sharePage(shared, { mediaUrl: `${publicUrl}/s/${m[1]}/recording.mp3?v=1`, videoUrl: shared.videoAvailable ? `${publicUrl}/s/${m[1]}/video.mp4?v=1` : null, brandedUrl: shared.brandedAvailable ? `${publicUrl}/s/${m[1]}/branded.mp4?v=1` : null, warning: C0MPUTE_LINK_WARNING }), headers);
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
  app.service.backfillVideos();
  const port = Number(env.PORT) || 8826;
  const host = env.HOST || '127.0.0.1';
  const server = createServer(app.handler);
  server.requestTimeout = 120_000;
  server.listen(port, host, () => console.log(`board-saas ${VERSION} on http://${host}:${port}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startServer();

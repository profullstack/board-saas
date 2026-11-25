// Business logic shared by the HTTP API, the MCP endpoint and the worker.
// Meeting statuses:
//   awaiting_payment -> queued -> checking -> (needs_clarification -> queued -> checking) -> running -> done | failed
// A voice meeting (voice=1) also holds a live PairUX call while it is running; voice_json carries
// the join link and the call's state (waiting -> live -> ended | failed).
//
// Privacy: every meeting made since 0.3.0 is private (private=1): its status, report, recording
// and transcript are readable by the owner (or the admin key) only, or through a share link the
// owner made. Meetings made before 0.3.0 keep working by their old public link (private=0).
//
// Publishing and invites (0.4.0). A meeting's visibility is 'private' (default) or 'public'. A
// public meeting has a page at /m/<public id> (a random id, never the internal one) and is listed
// on /meetings. Everything else is reached through a share: a token this server checks on every
// request, with a role, an optional expiry, and a revoke switch.
//   view   the report
//   listen the report, the live audio while the meeting runs, the recording afterwards
//   join   listen, plus the PairUX join link while the call is open (never after it ended)
// The public page is a listen-level audience: live audio while running, the report afterwards,
// and the recording only if the owner included it.
import { CoinPay, readWebhook, verifyWebhook } from '@profullstack/coinpay-onboard';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assumptionsFor, checkBrief, clarifyingQuestions, MAX_BRIEF, MAX_CONTEXT, runMeeting } from './meeting.js';
import { codeEmail, meetingDoneEmail, voiceFailedEmail } from './mail.js';
import { streamNameFor } from './live.js';
import { renderMeetingVideo } from './video.js';
import { renderSlideshow } from './slideshow.js';
import { compressSilence, encodeMp3, encryptRecording, openEncrypted, openText, sealText, unwrapKey, wrapKey } from './recording.js';
import { SAMPLE_RATE } from './speech.js';
import { createVoiceTrialExperiment } from './abtest.js';
import { metered } from './claude.js';
import { MARKUP, priceFor } from './c0mpute-account.js';
import { FOREVER, isPlaceholderEmail } from './db.js';
import { modelLabel, renderBrandedVideo, videoTitle } from './video.js';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const PRICE_USD = 9; // the old per-meeting checkout; credits bought with it still run

/** Pay as you go, as shown to people and agents. */
export const PAYGO_PRICING =
  `First meeting free per email (open models on c0mpute). After that, each meeting runs on Claude Opus 5.5 and is charged to your c0mpute balance (your CoinPay account; top it up with CoinPay) at what it cost us at Anthropic plus ${Math.round((MARKUP - 1) * 100)}%: $4.80 per million input tokens and $24 per million output tokens, under a dollar for a typical meeting. A meeting that fails is not charged. A Profullstack Pass covers meetings while it is active.`;
// Voice meetings (with recording): a paid feature, free for a trial per account that starts on the
// account's first voice meeting. After the trial, a voice pass costs VOICE_PRICE_USD for
// VOICE_PASS_DAYS of voice meetings. The text meeting price is unchanged (first free, then $9).
// Trial length is an A/B test (src/abtest.js): 90 days (control, and the most anyone gets) or 30
// days, fixed per account at its first voice meeting. Copy shown before that says "up to 90 days".
export const VOICE_TRIAL_DAYS = 90;
export const VOICE_PASS_DAYS = 30;
const DAY = 86_400_000;
// Premium (0.9.1): the captioned meeting video stays free for everyone; Premium adds the branded
// 1080x1080 LinkedIn rendition of each voice meeting (banner, waveform, per-speaker subtitles, every
// pause cut to 0.35 s) and its trimmed MP3. BOARD_PREMIUM_PRICE_USD (default 29) per
// BOARD_PREMIUM_DAYS (default 30) through CoinPay, like the voice pass. An active Profullstack Pass
// includes Premium. Admins grant it on /admin (days, or with no expiry).
export const PREMIUM_FEATURES = ['A branded 1080x1080 LinkedIn video of each voice meeting (title banner, waveform, subtitles coloured per speaker, pauses cut short)', 'The trimmed MP3: the recording with every pause shortened to 0.35 s'];

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 200) throw new HttpError(400, 'a valid email address is required');
  return e;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  promise.catch(() => {});
  return { promise, resolve, reject };
};

const EXPIRES = { never: null, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
export const SHARE_ROLES = ['view', 'listen', 'join'];
/** Rows made before roles existed: include_recording meant what listen means now. */
export const roleOf = (s) => (SHARE_ROLES.includes(s.role) ? s.role : s.include_recording ? 'listen' : 'view');
export const C0MPUTE_LINK_WARNING = 'Anyone who has this link can open the file. Revoking a board share does not revoke a link that was already copied.';
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};

export function createService({
  db,
  env = process.env,
  model,
  freeModel = model, // free-tier meetings (c0mpute); everything else uses `model` (Claude)
  c0mpute = null, // createC0mputeAccounts(...): pay as you go on the person's c0mpute balance
  mailer,
  log = console.log,
  publicUrl = 'https://board.saas.pit.world',
  accountForToken = () => null,
  voice = null, // { pairux, speech, run } when voice meetings are configured
  recordings = null, // createRecordingStore(...)
  kek = null, // Buffer(32): wraps recording keys
  live = null, // createLive(...): c0mpute Live for listen invites (BOARD_C0MPUTE_KEY)
  archive = null, // createArchive(...): c0mpute private storage copy (BOARD_C0MPUTE_STORAGE_TOKEN)
  now = () => Date.now(),
  coinpay: coinpayOverride = undefined,
  abtest = undefined, // createVoiceTrialExperiment(...): the voice trial length A/B test
  brandedRenderer = renderBrandedVideo, // Premium rendition (tests pass a fake)
  videoTmpDir = null, // where a branded render works (plain audio lives there only during a render)
}) {
  // Accounts made by Sign in with CoinPay have an undeliverable placeholder email: never mail it.
  if (mailer) {
    const send = mailer;
    mailer = async (m) => (isPlaceholderEmail(m?.to) ? undefined : send(m));
  }
  const contactEmail = (a) => (a?.email && !isPlaceholderEmail(a.email) ? a.email : undefined);
  const trialTest = abtest ?? createVoiceTrialExperiment({ env, log });
  if (env.CRAWLPROOF_TOKEN) trialTest.ensure();
  const coinpay = coinpayOverride !== undefined ? coinpayOverride : env.COINPAY_API_KEY ? new CoinPay({ token: env.COINPAY_API_KEY, base: env.COINPAY_API_URL || undefined }) : null;
  const running = new Set();
  const maxRunning = Number(env.BOARD_MAX_MEETINGS) || 2;
  const liveCtls = new Map(); // meeting id -> the live broadcast controller of its running voice call
  const liveCheckMs = (Number(env.BOARD_LIVE_CHECK_SECONDS) || 15) * 1000;
  const ipCodes = new Map();
  const VOICE_PRICE_USD = Number(env.BOARD_VOICE_PRICE_USD) || 19;
  const PREMIUM_PRICE_USD = Number(env.BOARD_PREMIUM_PRICE_USD) || 29;
  const PREMIUM_DAYS = Number(env.BOARD_PREMIUM_DAYS) || 30;
  const voiceWaitMs = (Number(env.BOARD_VOICE_WAIT_SECONDS) || 180) * 1000;
  // Signs short-lived media links (an <audio> element cannot send a bearer header).
  const mediaSecret = kek ? createHmac('sha256', kek).update('board-saas media links').digest() : randomBytes(32);

  const urlFor = (id) => `${publicUrl}/m/${id}`;
  const publicUrlFor = (row) => (row.visibility === 'public' && row.public_id ? `${publicUrl}/m/${row.public_id}` : null);
  const pendingArchives = new Set();
  const linkAad = (meetingId) => `board-saas-c0mpute-link:${meetingId}`;

  /** What a meeting is called on pages that are not the report. */
  function titleOf(row) {
    if (row.status === 'done') return parse(row.meeting_json)?.title || 'Board meeting';
    const d = parse(row.brief_json)?.decision;
    return d ? `Board meeting: ${String(d).slice(0, 140)}` : 'Board meeting';
  }
  /** The live audio's playback URL, only while the meeting is running and the stream is up. */
  function livePlayback(row) {
    if (row.status !== 'running') return null;
    const l = parse(row.live_json);
    return l?.status === 'live' && l.playback_url ? l.playback_url : null;
  }
  /** The PairUX join link, only while the call is open. Never once the meeting has ended. */
  function joinLink(row) {
    if (!row.voice || row.status !== 'running') return null;
    const c = parse(row.voice_json);
    return c && ['waiting', 'live'].includes(c.status) && c.join_url ? { join_url: c.join_url, join_code: c.join_code ?? null } : null;
  }
  /** The private c0mpute link of a recording, decrypted, or null. */
  function archiveLink(rec) {
    if (!rec?.archive_link || rec.deleted_at || !kek) return null;
    try {
      return openText(kek, linkAad(rec.meeting_id), rec.archive_link);
    } catch {
      return null;
    }
  }
  const recordingPlayable = (rec) => !!(rec && !rec.deleted_at && rec.wrapped_key);
  const voiceReady = () => !!(voice?.pairux?.configured && voice?.speech && voice?.run);

  /** Bearer key -> { admin } | { account } | null. */
  function actorFor(key) {
    if (!key) return null;
    if (env.BOARD_SAAS_ADMIN_KEY && safeEqual(key, env.BOARD_SAAS_ADMIN_KEY)) return { admin: true, account: null };
    // An OAuth access token (bso_) from any connected app, or the account's own API key.
    const viaOAuth = accountForToken(key);
    const account = viaOAuth ? db.accountById(viaOAuth) : db.accountByKey(key);
    return account ? { admin: false, account, oauth: !!viaOAuth } : null;
  }

  function requireActor(key) {
    const a = actorFor(key);
    if (!a) throw new HttpError(401, key ? 'that key or token is not valid (expired, revoked or replaced); sign in again' : 'sign in first: use OAuth (see /.well-known/oauth-authorization-server), or POST /api/v1/auth/code with your email then /api/v1/auth/verify with the code, and send "Authorization: Bearer <key>"', { auth: true });
    return a;
  }

  async function startLogin(emailIn, ip = '') {
    const email = normalizeEmail(emailIn);
    if (isPlaceholderEmail(email)) throw new HttpError(400, 'a valid email address is required');
    const hour = Math.floor(Date.now() / 3_600_000);
    const k = `${ip}:${hour}`;
    const n = (ipCodes.get(k) ?? 0) + 1;
    ipCodes.set(k, n);
    if (ipCodes.size > 5000) ipCodes.clear();
    if (n > 10) throw new HttpError(429, 'too many codes from this address this hour; try again later');
    if (!mailer) throw new HttpError(503, 'email is not configured on this server, so sign-in codes cannot be sent');
    const code = db.newLoginCode(email);
    if (!code) return { sent: false, email, message: 'a code was sent less than a minute ago; check your inbox' };
    await mailer({ to: email, ...codeEmail(code) });
    return { sent: true, email, message: 'check your email for a 6-digit code (valid 15 minutes)' };
  }

  function verifyLogin(emailIn, code) {
    const email = normalizeEmail(emailIn);
    if (!db.checkLoginCode(email, code)) throw new HttpError(401, 'that code is wrong or expired; ask for a new one');
    const account = db.ensureAccount(email);
    const apiKey = db.rotateKey(account.id);
    return { api_key: apiKey, account: accountView(db.accountById(account.id)) };
  }

  // ---------------------------------------------------------------- voice access

  /** The account's trial length: its A/B arm's, or the 90-day control for trials that predate the test. */
  const trialDaysOf = (a) => a.voice_trial_days || VOICE_TRIAL_DAYS;

  /**
   * Start the account's voice trial on its first voice meeting: assign its A/B arm (sticky), store
   * the length, and record the exposure. A trial that already started is left as it is.
   */
  async function startTrial(accountId) {
    const a = db.accountById(accountId);
    if (a.voice_trial_started_at) return;
    let pick = { arm: null, days: VOICE_TRIAL_DAYS };
    try {
      pick = await trialTest.assign(accountId);
    } catch (e) {
      log(`abtest: assign failed for ${accountId} (${e.message}); 90-day control`);
    }
    const t = db.startVoiceTrial(accountId, { days: pick.days, arm: pick.arm });
    if (t.fresh && t.arm) trialTest.exposure(accountId, t.arm).catch(() => {});
  }

  /** Engagement: one voice_meeting event per voice meeting that runs while its account is in an A/B trial. */
  function noteVoiceMeeting(row) {
    if (!row.voice || !row.account_id) return;
    const a = db.accountById(row.account_id);
    if (!a?.voice_trial_arm || !a.voice_trial_started_at) return;
    if (a.voice_trial_started_at + trialDaysOf(a) * DAY <= now()) return;
    trialTest.meeting(a.id, a.voice_trial_arm, row.id).catch(() => {});
  }

  /** The account's voice standing: trial, paid pass, or ended. */
  function voiceStatus(a) {
    const t = now();
    const trialDays = trialDaysOf(a);
    const trialEnds = a.voice_trial_started_at ? a.voice_trial_started_at + trialDays * DAY : null;
    const inTrial = !a.voice_trial_started_at || trialEnds > t;
    const pass = (a.pass_until ?? 0) > t;
    const paid = (a.voice_paid_until ?? 0) > t;
    const daysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds - t) / DAY)) : null;
    return {
      available: voiceReady(),
      active: inTrial || paid || pass,
      plan: pass ? 'pass' : paid ? 'paid' : !a.voice_trial_started_at ? 'trial_not_started' : inTrial ? 'trial' : 'trial_ended',
      trial_started_at: a.voice_trial_started_at ? new Date(a.voice_trial_started_at).toISOString() : null,
      trial_ends_at: trialEnds ? new Date(trialEnds).toISOString() : null,
      // The account's own trial length once it started; before that no length is promised.
      trial_days: a.voice_trial_started_at ? trialDays : null,
      trial_days_left: !a.voice_trial_started_at ? null : inTrial ? daysLeft : 0,
      paid_until: paid ? new Date(a.voice_paid_until).toISOString() : null,
      price_usd: VOICE_PRICE_USD,
      pass_days: VOICE_PASS_DAYS,
      pass_until: pass ? new Date(a.pass_until).toISOString() : null,
      summary: pass
        ? `Voice meetings: included with your Profullstack Pass through ${new Date(a.pass_until).toISOString().slice(0, 10)}`
        : paid
        ? `Voice meetings: paid through ${new Date(a.voice_paid_until).toISOString().slice(0, 10)}`
        : !a.voice_trial_started_at
          ? `Voice meetings: free trial (up to ${VOICE_TRIAL_DAYS} days, starts with your first voice meeting), then $${VOICE_PRICE_USD} per ${VOICE_PASS_DAYS} days`
          : inTrial
            ? `Voice trial: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left, then $${VOICE_PRICE_USD} per ${VOICE_PASS_DAYS} days`
            : `Voice trial ended: $${VOICE_PRICE_USD} for ${VOICE_PASS_DAYS} days of voice meetings`,
    };
  }

  async function voiceCheckout(account) {
    if (!coinpay) throw new HttpError(503, 'payments are not configured on this server');
    const day = Math.floor(now() / DAY);
    const session = await coinpay.createCheckoutSession({
      amount: VOICE_PRICE_USD,
      description: `Board as a Service: voice meetings for ${VOICE_PASS_DAYS} days`,
      customerEmail: contactEmail(account),
      accountId: account.id,
      property: 'board.saas.pit.world',
      metadata: { voice_pass_account: account.id },
      successUrl: `${publicUrl}/?voice=paid`,
      cancelUrl: `${publicUrl}/`,
      expiresInMinutes: 120,
      idempotencyKey: `board-voice-${account.id}-${day}`,
    });
    return session.url;
  }

  /** Throws 402 voice_trial_ended (with a checkout_url) when the account cannot hold a voice meeting. */
  async function requireVoice(actor) {
    if (!voiceReady()) throw new HttpError(503, 'voice meetings are not configured on this server right now; run it as a text meeting');
    if (actor.admin) return { plan: 'admin' };
    const a = db.accountById(actor.account.id);
    const s = voiceStatus(a);
    if (s.active) return s;
    const checkout_url = await voiceCheckout(a);
    throw new HttpError(402, `Your ${trialDaysOf(a)}-day voice trial has ended. Voice meetings are $${VOICE_PRICE_USD} per ${VOICE_PASS_DAYS} days: pay with CoinPay, then start the meeting again. Text meetings still work as before.`, {
      code: 'voice_trial_ended',
      checkout_url,
      price_usd: VOICE_PRICE_USD,
      pass_days: VOICE_PASS_DAYS,
    });
  }

  function voiceCheckoutFor(key) {
    const actor = requireActor(key);
    if (actor.admin) throw new HttpError(400, 'the admin key does not pay');
    return voiceCheckout(db.accountById(actor.account.id)).then((checkout_url) => ({ checkout_url, price_usd: VOICE_PRICE_USD, pass_days: VOICE_PASS_DAYS }));
  }

  function accountView(a) {
    const coinpayOnly = a.signin === 'coinpay';
    const link = db.coinpayLinkOf(a.id);
    const pass = (a.pass_until ?? 0) > now();
    return {
      id: a.id,
      // A CoinPay-only account has no email of its own (the placeholder is never shown).
      email: coinpayOnly || isPlaceholderEmail(a.email) ? null : a.email,
      name: coinpayOnly ? 'CoinPay account' : a.email,
      free_meeting_available: !a.free_used,
      credits: a.credits,
      price_usd: PRICE_USD,
      voice: voiceStatus(a),
      coinpay: { linked: !!link, linked_at: link ? new Date(link.linked_at).toISOString() : null, sign_in_only: coinpayOnly },
      pass: { active: pass, until: pass ? new Date(a.pass_until).toISOString() : null, covers: 'board meetings (text and voice) and Premium while active' },
      premium: premiumStatus(a),
      ...(a.admin ? { admin_page: `${publicUrl}/admin` } : {}),
    };
  }

  // ---------------------------------------------------------------- premium

  /** The account's premium standing: its own (paid or granted), or included with an active Pass. */
  function premiumStatus(a) {
    const t = now();
    const own = (a?.premium_until ?? 0) > t;
    const pass = (a?.pass_until ?? 0) > t;
    const forever = own && a.premium_until >= FOREVER;
    const until = own ? (forever ? null : new Date(a.premium_until).toISOString()) : null;
    return {
      active: own || pass,
      plan: own ? 'premium' : pass ? 'pass' : 'none',
      until,
      forever,
      pass_until: pass ? new Date(a.pass_until).toISOString() : null,
      price_usd: PREMIUM_PRICE_USD,
      days: PREMIUM_DAYS,
      features: PREMIUM_FEATURES,
      summary: own
        ? forever
          ? 'Premium: active, no expiry'
          : `Premium: active through ${until.slice(0, 10)}`
        : pass
          ? `Premium: included with your Profullstack Pass through ${new Date(a.pass_until).toISOString().slice(0, 10)}`
          : `Premium (a branded LinkedIn video of each voice meeting): $${PREMIUM_PRICE_USD} per ${PREMIUM_DAYS} days`,
    };
  }
  const premiumActive = (accountId) => {
    if (!accountId) return true; // meetings made with the admin key
    const a = db.accountById(accountId);
    return !!a && premiumStatus(a).active;
  };

  async function premiumCheckout(account) {
    if (!coinpay) throw new HttpError(503, 'payments are not configured on this server');
    const day = Math.floor(now() / DAY);
    const session = await coinpay.createCheckoutSession({
      amount: PREMIUM_PRICE_USD,
      description: `Board as a Service: Premium for ${PREMIUM_DAYS} days (branded LinkedIn videos)`,
      customerEmail: contactEmail(account),
      accountId: account.id,
      property: 'board.saas.pit.world',
      metadata: { premium_account: account.id },
      successUrl: `${publicUrl}/account?premium=paid`,
      cancelUrl: `${publicUrl}/account`,
      expiresInMinutes: 120,
      idempotencyKey: `board-premium-${account.id}-${day}`,
    });
    return session.url;
  }

  async function premiumCheckoutFor(key) {
    const actor = requireActor(key);
    if (actor.admin) throw new HttpError(400, 'the admin key does not pay');
    const checkout_url = await premiumCheckout(db.accountById(actor.account.id));
    return { checkout_url, price_usd: PREMIUM_PRICE_USD, days: PREMIUM_DAYS, features: PREMIUM_FEATURES };
  }

  // ---------------------------------------------------------------- access

  const ownerOf = (actor, row) => !!actor && (actor.admin || (row.account_id && actor.account?.id === row.account_id));

  /** The meeting row if this key may read it; private meetings answer 404 to anyone else. */
  function readable(key, id) {
    const row = db.meeting(String(id ?? ''));
    if (!row) throw new HttpError(404, 'no meeting with that id');
    if (!row.private) return { row, actor: actorFor(key), owner: ownerOf(actorFor(key), row) };
    const actor = actorFor(key);
    if (!ownerOf(actor, row)) {
      throw new HttpError(key && actor ? 403 : 401, key && actor ? 'this meeting is private to another account' : 'this meeting is private: sign in as its owner, or open a share link the owner made', key && actor ? {} : { auth: true, private: true });
    }
    return { row, actor, owner: true };
  }

  function owned(key, id) {
    const actor = requireActor(key);
    const row = db.meeting(String(id ?? ''));
    if (!row) throw new HttpError(404, 'no meeting with that id');
    if (!ownerOf(actor, row)) throw new HttpError(403, 'this meeting belongs to another account');
    return { row, actor };
  }

  function meetingView(row, { owner = false } = {}) {
    if (!row) return null;
    const v = {
      id: row.id,
      status: row.status,
      url: urlFor(row.id),
      private: !!row.private,
      visibility: row.visibility === 'public' ? 'public' : 'private',
      public_url: publicUrlFor(row),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      progress: row.progress ? JSON.parse(row.progress) : null,
      brief_text: row.brief_text,
      has_company_data: !!row.context_text,
      voice: !!row.voice,
    };
    if (row.voice) {
      const s = row.voice_json ? JSON.parse(row.voice_json) : { status: row.status === 'done' || row.status === 'failed' ? 'ended' : 'pending' };
      v.call = {
        status: s.status,
        join_url: s.join_url ?? null,
        join_code: s.join_code ?? null,
        recorded: !!row.record,
        started_at: s.started_at ?? null,
        started_because: s.started_because ?? null,
        error: s.error ?? null,
        how: s.status === 'waiting' ? `Open join_url in the PairUX desktop app or any browser (works as a PWA). The board starts when you join, or within ${Math.round(voiceWaitMs / 60000)} minutes, or now: POST /api/v1/meetings/${row.id}/start` : undefined,
      };
      if (s.status === 'pending' && ['queued', 'checking'].includes(row.status)) v.call.how = 'The call opens once the chair has checked the brief (a few seconds).';
    }
    if (owner && row.visibility === 'public') v.public_recording = !!row.public_recording;
    if (owner && livePlayback(row)) {
      v.live = { playback_url: livePlayback(row), note: 'Live audio on an unlisted c0mpute stream (HLS). Unlisted is not encrypted: give people a listen or join invite, not this URL.' };
    }
    if (row.status === 'needs_clarification') {
      const b = row.brief_json ? JSON.parse(row.brief_json) : { missing: [] };
      v.clarify = { missing: b.missing, questions: clarifyingQuestions(b.missing), how: `POST /api/v1/meetings/${row.id}/clarify {"answers":"..."} (asked once; unanswered gaps become assumptions)` };
    }
    if (row.status === 'awaiting_payment') {
      v.checkout_url = row.checkout_url;
      v.price_usd = PRICE_USD;
    }
    if (row.status === 'failed') v.error = row.error;
    if (row.status === 'done') {
      v.report_url = `${publicUrl}/m/${row.id}`;
      v.download_url = `${publicUrl}/api/v1/meetings/${row.id}/report.html`;
      v.json_url = `${publicUrl}/api/v1/meetings/${row.id}/meeting.json`;
      v.meeting = JSON.parse(row.meeting_json);
      const rec = db.recording(row.id);
      if (owner && rec && !rec.deleted_at) {
        v.recording = { video: !!rec.video_path, seconds: rec.seconds, bytes: rec.bytes, mime: rec.mime, stored: rec.c0mpute_ref || rec.archive_ref ? 'encrypted on this server and as a private c0mpute storage object' : 'encrypted on this server', url: `${publicUrl}/api/v1/meetings/${row.id}/recording` };
        const link = archiveLink(rec);
        if (link) v.recording.c0mpute = { ref: rec.archive_ref, private_link: link, warning: C0MPUTE_LINK_WARNING };
        const vlink = videoArchiveLink(rec);
        if (vlink) v.recording.video_c0mpute = { ref: rec.video_archive_ref, private_link: vlink, warning: C0MPUTE_LINK_WARNING };
        else if (rec.archive_note) v.recording.c0mpute = { private_link: null, note: rec.archive_note };
      } else if (owner && rec?.deleted_at) v.recording = { deleted: true, ...(rec.archive_ref ? { c0mpute_copy_ref: rec.archive_ref } : {}) };
      if (owner && row.transcript_json) v.transcript_url = `${publicUrl}/api/v1/meetings/${row.id}/transcript`;
      if (owner && row.voice && rec && !rec.deleted_at) v.branded_video = brandedView(row);
    }
    if (row.status === 'done' && row.slideshow_path) v.slideshow = { seconds: row.slideshow_seconds, bytes: row.slideshow_bytes };
    return v;
  }

  // ---------------------------------------------------------------- meetings

  async function createMeeting(key, briefIn, contextIn = null, opts = {}) {
    const actor = requireActor(key);
    const briefText = String(briefIn ?? '').trim();
    if (briefText.length < 20) throw new HttpError(400, 'the brief is too short: give the decision, the options and the constraints');
    if (briefText.length > MAX_BRIEF) throw new HttpError(400, `the brief is too long (max ${MAX_BRIEF} characters)`);
    const ctx = contextIn && typeof contextIn === 'object' ? JSON.stringify(contextIn, null, 1) : String(contextIn ?? '');
    const contextText = ctx.trim() || null;
    if (contextText && contextText.length > MAX_CONTEXT) throw new HttpError(400, `the company data is too long (max ${MAX_CONTEXT} characters): send the summary figures (P&L totals, cash, runway, MRR, churn), not raw ledgers`);
    const wantVoice = opts.voice === true || opts.voice === 'true' || opts.voice === 1;
    const record = wantVoice && opts.record !== false && opts.record !== 'false' && opts.record !== 0;
    // Voice is checked first, so a refused voice meeting never spends a meeting credit.
    if (wantVoice) await requireVoice(actor);
    const common = { briefText, contextText, voice: wantVoice, record };
    if (actor.admin) {
      const row = db.createMeeting({ accountId: null, ...common, status: 'queued', paidWith: 'admin' });
      kick();
      return meetingView(row, { owner: true });
    }
    if (wantVoice) await startTrial(actor.account.id);
    const spent = db.spend(actor.account.id);
    if (spent) {
      const row = db.createMeeting({ accountId: actor.account.id, ...common, status: 'queued', paidWith: spent });
      kick();
      return meetingView(row, { owner: true });
    }
    // Pay as you go (Anthony 2026-11-25): after the free meeting (and outside a Pass), each meeting is
    // charged to the person's c0mpute balance at Anthropic cost + 20% when it finishes. A failed
    // meeting is never charged.
    if (!c0mpute?.configured()) throw new HttpError(503, 'paid meetings are not set up on this server yet');
    if (!c0mpute.connected(actor.account)) {
      throw new HttpError(402, 'connect your c0mpute account to pay for meetings as you go (your free meeting is used)', {
        code: 'connect_c0mpute',
        connect_url: `${publicUrl}/api/v1/c0mpute/connect`,
        how: 'POST /api/v1/c0mpute/connect with your key returns a sign-in link for c0mpute; your c0mpute account is your CoinPay account',
        pricing: PAYGO_PRICING,
      });
    }
    const balance = await c0mpute.balance(actor.account, { fresh: true });
    if (balance != null && balance < MIN_BALANCE_USD) {
      throw new HttpError(402, `your c0mpute balance is $${balance.toFixed(2)}; top it up with CoinPay to at least $${MIN_BALANCE_USD.toFixed(2)} to hold a meeting`, {
        code: 'insufficient_balance',
        balance_usd: balance,
        needed_usd: MIN_BALANCE_USD,
        top_up_url: c0mpute.topUpUrl,
        pricing: PAYGO_PRICING,
      });
    }
    const row = db.createMeeting({ accountId: actor.account.id, ...common, status: 'queued', paidWith: 'c0mpute' });
    kick();
    return meetingView(row, { owner: true });
  }

  function getMeeting(key, id) {
    const { row, owner } = readable(key, id);
    return meetingView(row, { owner });
  }

  /** The meeting as its report needs it, plus the owner's private extras. */
  function reportData(key, id) {
    const { row, owner } = readable(key, id);
    return { view: meetingView(row, { owner }), row, owner };
  }

  function startNow(key, id) {
    const { row } = owned(key, id);
    if (!row.voice) throw new HttpError(409, 'this is not a voice meeting');
    db.updateMeeting(row.id, { start_now: 1 });
    return meetingView(db.meeting(row.id), { owner: true });
  }

  function listMeetings(key) {
    const actor = requireActor(key);
    if (actor.admin) return [];
    return db.meetingsFor(actor.account.id).map((r) => ({
      id: r.id,
      status: r.status,
      url: urlFor(r.id),
      visibility: r.visibility === 'public' ? 'public' : 'private',
      public_url: publicUrlFor(r),
      brief: r.brief_text.slice(0, 140),
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  /** The account's pay-as-you-go standing, without a network call. */
  function c0mputeStatus(a, balance = undefined) {
    if (!c0mpute?.configured()) return { available: false };
    const connected = c0mpute.connected(a);
    return {
      available: true,
      connected,
      name: connected ? a.c0mpute_name : null,
      ...(balance !== undefined ? { balance_usd: balance } : {}),
      top_up_url: c0mpute.topUpUrl,
      ...(connected ? {} : { connect: `POST ${publicUrl}/api/v1/c0mpute/connect` }),
    };
  }

  /** The account view with the live c0mpute balance (one c0mpute call, cached a minute). */
  async function accountWithBalance(key) {
    const view = account(key);
    if (view?.admin) return view;
    const a = requireActor(key).account;
    view.c0mpute = c0mputeStatus(a, c0mpute?.connected(a) ? await c0mpute.balance(a) : undefined);
    view.pricing = PAYGO_PRICING;
    return view;
  }

  /** Start connecting a c0mpute account: a sign-in link for c0mpute. */
  function c0mputeConnect(key) {
    const actor = requireActor(key);
    if (actor.admin) throw new HttpError(400, 'the admin key does not pay for meetings');
    if (!c0mpute?.configured()) throw new HttpError(503, 'paid meetings are not set up on this server yet');
    return c0mpute.start(actor.account.id);
  }

  async function c0mputeFinish(code, state) {
    return c0mpute.finish(code, state);
  }

  async function c0mputeDisconnect(key) {
    const actor = requireActor(key);
    if (actor.admin || !c0mpute) return { connected: false };
    await c0mpute.disconnect(actor.account);
    return { connected: false };
  }

  function account(key) {
    const actor = requireActor(key);
    if (actor.admin) return { admin: true, admin_page: `${publicUrl}/admin`, free_meeting_available: true, credits: 'unlimited', price_usd: PRICE_USD, voice: { available: voiceReady(), active: true, plan: 'admin', summary: 'Voice meetings: admin', price_usd: VOICE_PRICE_USD, pass_days: VOICE_PASS_DAYS }, premium: { active: true, plan: 'admin', summary: 'Premium: admin key', price_usd: PREMIUM_PRICE_USD, days: PREMIUM_DAYS, features: PREMIUM_FEATURES } };
    return accountView(db.accountById(actor.account.id));
  }

  // A private meeting's clarification needs its owner's key; a pre-0.3.0 public meeting still
  // takes the id as the capability (only its owner had it until they shared the link).
  function clarify(key, id, answersIn) {
    const actor = key ? requireActor(key) : null;
    const row = db.meeting(String(id));
    if (!row) throw new HttpError(404, 'no meeting with that id');
    if (row.private && !ownerOf(actor, row)) throw new HttpError(actor ? 403 : 401, 'this meeting is private: answer as its owner', actor ? {} : { auth: true });
    if (actor && !actor.admin && row.account_id && row.account_id !== actor.account.id) throw new HttpError(403, 'this meeting belongs to another account');
    if (row.status !== 'needs_clarification') throw new HttpError(409, `this meeting is ${row.status}, not waiting for answers`);
    const answers = String(answersIn ?? '').trim().slice(0, 3000);
    if (!db.transition(row.id, 'needs_clarification', 'queued', { answers, clarified: 1 })) throw new HttpError(409, 'already answered');
    kick();
    return meetingView(db.meeting(row.id), { owner: true });
  }

  // ---------------------------------------------------------------- shares

  function shareView(s) {
    const role = roleOf(s);
    return {
      id: s.id,
      meeting_id: s.meeting_id,
      url: `${publicUrl}/s/${s.token}`,
      role,
      label: s.label ?? null,
      include_recording: role !== 'view',
      allow_download: !!s.allow_download,
      expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null,
      revoked: !!s.revoked_at,
      expired: !!(s.expires_at && s.expires_at < now()),
      created_at: new Date(s.created_at).toISOString(),
      last_used_at: s.last_used_at ? new Date(s.last_used_at).toISOString() : null,
    };
  }

  /**
   * A share (an invite). role: view | listen | join; without one, include_recording picks listen
   * or view as before. A view share needs the finished report. A listen or join invite to a voice
   * meeting can be made as soon as the meeting exists, so people can be invited before it starts.
   */
  function createShare(key, id, opts = {}) {
    const { row, actor } = owned(key, id);
    const role = opts.role === undefined || opts.role === null || opts.role === '' ? (truthy(opts.include_recording) ? 'listen' : 'view') : String(opts.role);
    if (!SHARE_ROLES.includes(role)) throw new HttpError(400, 'role must be view, listen or join');
    if (role === 'join' && !row.voice) throw new HttpError(400, 'only a voice meeting has a call to join; use view or listen');
    if (row.status === 'failed') throw new HttpError(409, 'the meeting failed, so there is nothing to share');
    if (row.status === 'done') {
      if (role === 'join') throw new HttpError(409, 'the meeting has ended, so there is no call to join; make a listen or view share');
    } else if (role === 'view' || !row.voice) {
      throw new HttpError(409, `the meeting is ${row.status}; share it once the report is ready${row.voice ? ' (a listen or join invite can be made now)' : ''}`);
    }
    const exp = String(opts.expires ?? 'never');
    if (!(exp in EXPIRES)) throw new HttpError(400, 'expires must be never, 24h, 7d or 30d');
    const label = String(opts.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    const s = db.createShare({
      meetingId: row.id,
      accountId: actor.account?.id ?? null,
      role,
      label,
      includeRecording: role !== 'view',
      allowDownload: role !== 'view' && truthy(opts.allow_download),
      expiresAt: EXPIRES[exp] ? now() + EXPIRES[exp] : null,
    });
    syncLive(row.id); // the first listen or join invite to a running meeting starts the live audio
    return shareView(s);
  }

  function listShares(key, id = null) {
    if (id) return db.sharesFor(owned(key, id).row.id).map(shareView);
    const actor = requireActor(key);
    return actor.admin ? [] : db.sharesForAccount(actor.account.id).map(shareView);
  }

  function revokeShare(key, shareId) {
    const actor = requireActor(key);
    const s = db.share(String(shareId ?? ''));
    if (!s) throw new HttpError(404, 'no share with that id');
    const row = db.meeting(s.meeting_id);
    if (!ownerOf(actor, row)) throw new HttpError(403, 'this share belongs to another account');
    db.revokeShare(s.id);
    syncLive(s.meeting_id); // the last invite gone from a private meeting stops the live audio
    return shareView(db.share(s.id));
  }

  /**
   * What somebody who is not the owner may see of a meeting right now, by role. This is the one
   * place the live playback URL and the join link are handed out, and both are re-read from the
   * meeting on every request: playback only while it runs, join only while the call is open.
   */
  function audienceState(row, role) {
    const status = row.status === 'done' ? 'ended' : row.status === 'running' ? 'live' : 'scheduled';
    const playback = role === 'view' ? null : livePlayback(row);
    return {
      status,
      title: titleOf(row),
      voice: !!row.voice,
      role,
      live: playback ? { playback_url: playback } : null,
      join: role === 'join' ? joinLink(row) : null,
    };
  }

  /** What a share link opens, or 404. Checked on every request, so revoke and expiry take effect at once. */
  function byShareToken(token) {
    const gone = () => new HttpError(404, 'this share link was revoked, has expired, or never existed');
    const s = db.shareByToken(token);
    if (!s) throw gone();
    const row = db.meeting(s.meeting_id);
    const role = roleOf(s);
    if (!row || row.status === 'failed') throw gone();
    // Before the report exists there is something to open only for a listen or join invite to a voice meeting.
    if (row.status !== 'done' && (role === 'view' || !row.voice)) throw gone();
    const rec = db.recording(row.id);
    const recordingAvailable = role !== 'view' && row.status === 'done' && recordingPlayable(rec);
    return {
      share: s,
      role,
      row,
      state: audienceState(row, role),
      view: row.status === 'done' ? { id: row.id, meeting: JSON.parse(row.meeting_json), recordingAvailable } : null,
      recordingAvailable,
      videoAvailable: recordingAvailable && !!rec?.video_path,
      slideshowAvailable: row.status === 'done' && !!row.slideshow_path,
      brandedAvailable: recordingAvailable && brandedPlayable(row.id),
      transcript: role !== 'view' && row.status === 'done' ? parse(row.transcript_json) : null,
      // The private c0mpute link goes only to shares the owner allowed to download.
      c0mputeLink: recordingAvailable && s.allow_download ? archiveLink(rec) : null,
    };
  }

  // ---------------------------------------------------------------- publishing

  /** PATCH visibility: 'public' puts the meeting on /m/<public id> and /meetings; 'private' takes it off both. */
  function setVisibility(key, id, body = {}) {
    const { row } = owned(key, id);
    const visibility = String(body?.visibility ?? '');
    if (visibility !== 'public' && visibility !== 'private') throw new HttpError(400, 'visibility must be public or private');
    if (visibility === 'public' && row.status === 'failed') throw new HttpError(409, 'the meeting failed, so there is nothing to publish');
    const includeRecording = visibility === 'public' && (body.include_recording === undefined ? !!row.public_recording : truthy(body.include_recording));
    const next = db.setVisibility(row.id, visibility, includeRecording);
    syncLive(row.id);
    log(`meeting ${row.id}: visibility ${visibility}${includeRecording ? ' (with recording)' : ''}`);
    return meetingView(next, { owner: true });
  }

  /** A public meeting by its public id, or 404 (a private meeting answers exactly like a missing one). */
  function publicMeeting(publicId) {
    const row = db.meetingByPublicId(String(publicId ?? ''));
    if (!row || row.status === 'failed') throw new HttpError(404, 'no public meeting with that link');
    const rec = db.recording(row.id);
    const recordingAvailable = !!row.public_recording && row.status === 'done' && recordingPlayable(rec);
    return {
      row,
      publicId: row.public_id,
      url: publicUrlFor(row),
      state: audienceState(row, 'listen'),
      view: row.status === 'done' ? { id: row.id, meeting: JSON.parse(row.meeting_json), recordingAvailable } : null,
      recordingAvailable,
      videoAvailable: recordingAvailable && !!rec?.video_path,
      slideshowAvailable: row.status === 'done' && !!row.slideshow_path,
      brandedAvailable: recordingAvailable && brandedPlayable(row.id),
      transcript: recordingAvailable ? parse(row.transcript_json) : null,
    };
  }

  /** Public meetings, newest first. */
  function publicIndex() {
    return db.publicMeetings().map((r) => ({
      title: titleOf(r),
      url: `${publicUrl}/m/${r.public_id}`,
      status: r.status === 'done' ? 'ended' : r.status === 'running' ? 'live' : 'scheduled',
      voice: !!r.voice,
      date: new Date(r.finished_at ?? r.created_at).toISOString(),
    }));
  }

  /** Everything the account can hand to somebody else, per meeting, for machines. */
  function shareables(key) {
    const actor = requireActor(key);
    if (actor.admin) return [];
    return db.meetingRowsFor(actor.account.id).map((row) => {
      const rec = db.recording(row.id);
      const join = joinLink(row);
      const link = archiveLink(rec);
      return {
        meeting_id: row.id,
        title: titleOf(row),
        status: row.status,
        voice: !!row.voice,
        visibility: row.visibility === 'public' ? 'public' : 'private',
        owner_url: urlFor(row.id),
        public_url: publicUrlFor(row),
        public_includes_recording: row.visibility === 'public' ? !!row.public_recording : false,
        live_playback_url: livePlayback(row),
        join_url: join?.join_url ?? null,
        recording: recordingPlayable(rec) ? { seconds: rec.seconds, mime: rec.mime, url: `${publicUrl}/api/v1/meetings/${row.id}/recording` } : null,
        c0mpute_private_link: link,
        c0mpute_private_link_warning: link ? C0MPUTE_LINK_WARNING : null,
        shares: db
          .sharesFor(row.id)
          .filter((s) => !s.revoked_at && !(s.expires_at && s.expires_at < now()))
          .map((s) => ({ id: s.id, role: roleOf(s), label: s.label ?? null, url: `${publicUrl}/s/${s.token}`, allow_download: !!s.allow_download, expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null })),
      };
    });
  }

  // ---------------------------------------------------------------- live audience

  /**
   * Does anybody have a way to hear this meeting live? Only then is its audio pushed to c0mpute:
   * the meeting is public, or it has at least one listen or join share that is neither revoked
   * nor expired. A private meeting nobody was invited to never leaves this server.
   */
  function liveAudience(row) {
    if (!row) return false;
    if (row.visibility === 'public') return true;
    const t = now();
    return db.sharesFor(row.id).some((s) => !s.revoked_at && !(s.expires_at && s.expires_at < t) && roleOf(s) !== 'view');
  }

  /**
   * Bring a running voice meeting's c0mpute stream in line with its audience: start it when the
   * first listener appears (at the start, or mid-meeting when an invite is made or the meeting is
   * published), stop the push and delete the stream when the last one is gone or the meeting ends.
   * Changes are queued per meeting, so a start and a stop can never overlap.
   */
  function syncLive(id) {
    const ctl = liveCtls.get(id);
    if (!ctl) return Promise.resolve();
    ctl.chain = ctl.chain
      .then(async () => {
        const want = !ctl.ended && liveAudience(db.meeting(id));
        if (want && !ctl.stream) {
          // A neutral title: the stream's c0mpute page must not carry the decision.
          const stream = await live.open({ name: streamNameFor(id), title: 'Board meeting' });
          ctl.stream = stream;
          ctl.cast = live.broadcast(stream.publish_url, { rate: SAMPLE_RATE });
          // Only the id and the playback URL are stored. The publish URL holds the stream key and stays in memory.
          db.updateMeeting(id, { live_json: JSON.stringify({ status: 'live', stream_id: stream.id, playback_url: stream.playback_url, watch_url: stream.watch_url ?? null, started_at: new Date().toISOString() }) });
          ctl.log(`live: broadcasting on an unlisted c0mpute stream (${stream.id})`);
        } else if (!want && ctl.stream) {
          const stream = ctl.stream;
          const cast = ctl.cast;
          ctl.stream = null;
          ctl.cast = null;
          db.updateMeeting(id, { live_json: JSON.stringify({ status: 'ended', stream_id: stream.id, ended_at: new Date().toISOString() }) });
          await cast?.stop().catch(() => {});
          // Deleting the stream kills its key and its playback URL (and c0mpute allows 50 streams an account).
          await live.remove(stream.id).catch((e) => ctl.log(`live: could not delete the c0mpute stream ${stream.id}: ${e.message}`));
          ctl.log(ctl.ended ? 'live: stream stopped and deleted' : 'live: nobody is invited any more, stream stopped and deleted');
        }
      })
      .catch((e) => ctl.log(`live listening is off for now: ${String(e?.message ?? e).slice(0, 200)}`));
    return ctl.chain;
  }

  // ---------------------------------------------------------------- recordings

  function recordingMeta(meetingId) {
    const rec = db.recording(meetingId);
    if (!rec || rec.deleted_at || !rec.wrapped_key) throw new HttpError(404, 'this meeting has no recording (it was not recorded, or the owner deleted it)');
    if (!kek) throw new HttpError(503, 'recordings cannot be opened: the server key is not configured');
    return rec;
  }

  /** Open a recording for streaming: { length, mime, read(start,end), close }. */
  async function openRecording(meetingId) {
    const rec = recordingMeta(meetingId);
    const path = await recordings.ensureLocal(meetingId, rec.c0mpute_ref);
    const key = unwrapKey(kek, meetingId, rec.wrapped_key);
    const r = openEncrypted(path, meetingId, key);
    return { ...r, mime: rec.mime, seconds: rec.seconds };
  }

  // kind 'recording' signs /media/<id>.mp3 (and the free video's .mp4) exactly as before; the
  // Premium files ('branded', 'trimmed') sign their own input, so one link never opens another file.
  const MEDIA_PATH = { slideshow: (id) => `/media/slideshow/${id}.mp4`, recording: (id) => `/media/${id}.mp3`, branded: (id) => `/media/branded/${id}.mp4`, trimmed: (id) => `/media/trimmed/${id}.mp3` };
  const mediaInput = (meetingId, exp, kind) => (kind === 'recording' ? `${meetingId}.${exp}` : `${meetingId}.${kind}.${exp}`);
  function signMedia(meetingId, ttlMs = 6 * 3_600_000, kind = 'recording') {
    const exp = now() + ttlMs;
    const sig = createHmac('sha256', mediaSecret).update(mediaInput(meetingId, exp, kind)).digest('base64url');
    return `${publicUrl}${MEDIA_PATH[kind](meetingId)}?exp=${exp}&sig=${sig}`;
  }
  function checkMedia(meetingId, exp, sig, kind = 'recording') {
    if (!exp || !sig || Number(exp) < now() || !MEDIA_PATH[kind]) return false;
    return safeEqual(createHmac('sha256', mediaSecret).update(mediaInput(meetingId, exp, kind)).digest('base64url'), sig);
  }

  function recordingLink(key, id) {
    const { row } = owned(key, id);
    recordingMeta(row.id);
    return { url: signMedia(row.id), expires_in: 6 * 3600 };
  }

  async function deleteRecording(key, id) {
    const { row } = owned(key, id);
    const rec = db.recording(row.id);
    if (!rec || rec.deleted_at) throw new HttpError(404, 'no recording to delete');
    db.deleteRecording(row.id); // the key is gone first: every copy this server encrypted is now unreadable
    await recordings?.remove(row.id, rec.c0mpute_ref);
    if (rec.video_path) await recordings?.remove(`${row.id}-video`);
    // The Premium rendition and trimmed MP3 are made from the recording: they go with it.
    if (db.branded(row.id)) {
      db.deleteBranded(row.id);
      for (const k of ['branded', 'trimmed']) rmSync(recordings.pathFor(`${row.id}-${k}`), { force: true });
    }
    db.updateMeeting(row.id, { transcript_json: null });
    log(`meeting ${row.id}: recording and transcript deleted by the owner${rec.archive_ref ? `; its c0mpute copy ${rec.archive_ref} is not deleted from here` : ''}`);
    const out = { deleted: true, meeting_id: row.id };
    // The c0mpute copy was sealed with its own key, which lives in the private link. This server
    // has forgotten the link, but it cannot delete the object or recall a link someone copied.
    if (rec.archive_ref) out.c0mpute_copy = { ref: rec.archive_ref, note: `This server forgot the private c0mpute link, but the c0mpute object still exists and a link that was already copied still opens it. Remove it from the storage account with: c0mpute storage rm ${rec.archive_ref}` };
    return out;
  }

  function transcript(key, id) {
    const { row } = owned(key, id);
    if (!row.transcript_json) throw new HttpError(404, 'no transcript for this meeting');
    return JSON.parse(row.transcript_json);
  }

  async function saveRecording(row, rec) {
    if (!kek || !recordings) {
      log(`meeting ${row.id}: recording dropped: BOARD_RECORDING_KEK or the store is not configured`);
      return false;
    }
    const mp3 = await encodeMp3(rec.pcm, rec.rate);
    const { key, data } = encryptRecording(row.id, mp3);
    const stored = await recordings.put(row.id, data);
    db.saveRecording({ meetingId: row.id, accountId: row.account_id, wrappedKey: wrapKey(kek, row.id, key), mime: 'audio/mpeg', bytes: mp3.length, cipherBytes: data.length, seconds: rec.seconds, path: stored.path, c0mputeRef: stored.c0mpute_ref });
    key.fill(0);
    log(`meeting ${row.id}: recording saved (${rec.seconds}s, ${mp3.length} bytes mp3, encrypted${stored.c0mpute_ref ? ', on c0mpute' : ''})`);
    if (archive?.configured) archiveRecording(row.id, mp3);
    return mp3;
  }

  // ---------------------------------------------------------------- meeting video
  // Made from the recording and transcript after the meeting (Anthony 2026-11-25: "add the video too
  // to the page. do that automatically"), one at a time in the background, encrypted like the
  // recording and shown wherever the recording may be played. BOARD_VIDEO=0 turns it off.
  const videoQueue = [];
  let videoBusy = false;
  const videoOn = () => env.BOARD_VIDEO !== '0' && kek && recordings;

  function queueVideo(meetingId, mp3 = null) {
    if (!videoOn() || videoQueue.some((q) => q.id === meetingId)) return;
    videoQueue.push({ id: meetingId, mp3 });
    drainVideos();
  }

  async function drainVideos() {
    if (videoBusy) return;
    videoBusy = true;
    try {
      while (videoQueue.length) {
        const { id, mp3 } = videoQueue.shift();
        await makeVideo(id, mp3).catch((e) => log(`meeting ${id}: video not made: ${String(e?.message ?? e).slice(0, 300)}`));
      }
    } finally {
      videoBusy = false;
    }
  }

  async function makeVideo(id, mp3In) {
    const row = db.meeting(id);
    const rec = db.recording(id);
    if (!row || !rec || rec.deleted_at || !rec.wrapped_key || rec.video_path) return;
    let mp3 = mp3In;
    if (!mp3) {
      const r = await openRecording(id);
      try {
        mp3 = r.read(0, r.length - 1);
      } finally {
        r.close();
      }
    }
    const transcript = parse(row.transcript_json) || [];
    const title = parse(row.brief_json)?.decision || row.brief_text.slice(0, 140);
    const t0 = now();
    const mp4 = await renderMeetingVideo({ mp3, transcript, title, duration: rec.seconds, workDir: recordings.dir });
    const vid = `${id}-video`;
    const { key, data } = encryptRecording(vid, mp4);
    const stored = await recordings.put(vid, data);
    // A recording deleted while the video rendered: drop the file, keep nothing.
    if (db.recording(id)?.deleted_at) {
      await recordings.remove(vid);
      key.fill(0);
      return;
    }
    db.saveVideo(id, { wrappedKey: wrapKey(kek, vid, key), path: stored.path, bytes: mp4.length });
    key.fill(0);
    log(`meeting ${id}: video made (${mp4.length} bytes mp4, ${Math.round((now() - t0) / 1000)}s, encrypted)`);
    // Anthony 2026-11-25: "store videos on c0mpute hosting". A sealed private copy, like the recording's.
    if (archive?.configured) await archiveVideo(id, mp4);
  }

  async function openVideo(meetingId) {
    const rec = recordingMeta(meetingId);
    if (!rec.video_key || !rec.video_path) throw new HttpError(404, 'this meeting has no video yet');
    const vid = `${meetingId}-video`;
    const key = unwrapKey(kek, vid, rec.video_key);
    const r = openEncrypted(rec.video_path, vid, key);
    return { ...r, mime: 'video/mp4', seconds: rec.seconds };
  }

  // ---------------------------------------------------------------- narrated slide show
  // The deck read by the Chair (Anthony 2026-11-25), made after every finished meeting, one at a
  // time, encrypted like the recording. Needs speech (C0MPUTE_SPEECH_URL) and LibreOffice on the
  // host. BOARD_SLIDESHOW=0 turns it off.
  const showQueue = [];
  const showTries = new Map();
  let showBusy = false;
  const showOn = () => env.BOARD_SLIDESHOW !== '0' && kek && recordings && voice?.speech;

  function queueSlideshow(meetingId) {
    if (!showOn() || showQueue.includes(meetingId)) return;
    showQueue.push(meetingId);
    drainSlideshows();
  }

  async function drainSlideshows() {
    if (showBusy) return;
    showBusy = true;
    try {
      while (showQueue.length) {
        const id = showQueue.shift();
        await makeSlideshow(id).catch((e) => {
          // The speech gateway has short outages (a warm worker dropped while sessions churn): try
          // again after 3, 10 and 30 minutes before giving up until the next boot.
          const n = (showTries.get(id) ?? 0) + 1;
          showTries.set(id, n);
          const wait = [3, 10, 30][n - 1];
          log(`meeting ${id}: slide show not made${wait ? `, retrying in ${wait} min` : ', giving up until the next restart'}: ${String(e?.message ?? e).slice(0, 300)}`);
          if (wait) setTimeout(() => queueSlideshow(id), wait * 60_000).unref?.();
        });
      }
    } finally {
      showBusy = false;
    }
  }

  async function makeSlideshow(id) {
    const row = db.meeting(id);
    if (!row || row.status !== 'done' || !row.meeting_json || row.slideshow_path) return;
    const t0 = now();
    const r = await renderSlideshow(JSON.parse(row.meeting_json), { speech: voice.speech, workDir: recordings.dir, url: row.visibility === 'public' ? publicUrlFor(row) : null });
    const sid = `${id}-slideshow`;
    const { key, data } = encryptRecording(sid, r.mp4);
    const stored = await recordings.put(sid, data);
    db.saveSlideshow(id, { wrappedKey: wrapKey(kek, sid, key), path: stored.path, bytes: r.mp4.length, seconds: r.seconds });
    key.fill(0);
    log(`meeting ${id}: slide show made (${r.slides} slides, ${r.seconds}s narrated, ${r.mp4.length} bytes mp4, ${Math.round((now() - t0) / 1000)}s)`);
    if (archive?.configured) {
      await archive
        .put(r.mp4, { fileName: `board-meeting-${new Date(now()).toISOString().slice(0, 10)}-slide-show.mp4` })
        .then((a) => a.ref && log(`meeting ${id}: slide show copied to c0mpute private storage (${a.ref})`))
        .catch((e) => log(`meeting ${id}: c0mpute copy of the slide show failed: ${String(e?.message ?? e).slice(0, 200)}`));
    }
  }

  function openSlideshow(meetingId) {
    const row = db.meeting(meetingId);
    if (!row?.slideshow_key || !row.slideshow_path) throw new HttpError(404, 'this meeting has no slide show yet');
    if (!kek) throw new HttpError(503, 'the slide show cannot be opened: the server key is not configured');
    const sid = `${meetingId}-slideshow`;
    const r = openEncrypted(row.slideshow_path, sid, unwrapKey(kek, sid, row.slideshow_key));
    const title = parse(row.meeting_json)?.title || 'Board meeting';
    return { ...r, mime: 'video/mp4', seconds: row.slideshow_seconds, title };
  }

  /** On boot, make the videos recorded meetings do not have yet (older meetings, or a restart mid-render). */
  function backfillVideos() {
    if (videoOn()) for (const id of db.recordingsWithoutVideo()) queueVideo(id);
    if (showOn()) for (const id of db.meetingsWithoutSlideshow()) queueSlideshow(id);
    // After the videos that are already queued; makeVideo archives each new one itself.
    setTimeout(() => backfillArchive().catch((e) => log(`c0mpute backfill failed: ${e?.message ?? e}`)), 60_000);
  }

  /**
   * Copy the finished MP3 to c0mpute private storage, in the background: the meeting is already
   * saved and done, and whatever happens here only adds or does not add the private link.
   */
  const videoLinkAad = (meetingId) => `board-saas-c0mpute-video-link:${meetingId}`;

  function videoArchiveLink(rec) {
    if (!rec?.video_archive_link || rec.deleted_at || !kek) return null;
    try {
      return openText(kek, videoLinkAad(rec.meeting_id), rec.video_archive_link);
    } catch {
      return null;
    }
  }

  /** Copy a meeting video to c0mpute private storage. Never throws: this server's copy stays primary. */
  async function archiveVideo(id, mp4) {
    try {
      const r = await archive.put(mp4, { fileName: `board-meeting-${new Date(now()).toISOString().slice(0, 10)}.mp4` });
      if (r.skipped) return db.setVideoArchive(id, { note: `not copied to c0mpute: ${r.skipped}` });
      const rec = db.recording(id);
      if (!rec || rec.deleted_at) return log(`meeting ${id}: the recording was deleted while its video uploaded; ${r.ref} remains in c0mpute storage`);
      db.setVideoArchive(id, { ref: r.ref, link: sealText(kek, videoLinkAad(id), r.link) });
      log(`meeting ${id}: video copied to c0mpute private storage (${r.ref})`);
    } catch (e) {
      log(`meeting ${id}: c0mpute copy of the video failed, the copy on this server is unaffected: ${String(e?.message ?? e).slice(0, 200)}`);
      try {
        db.setVideoArchive(id, { note: 'the c0mpute copy failed; the video is kept on this server' });
      } catch {
        /* the row is gone */
      }
    }
  }

  /** On boot: copy to c0mpute the recordings and videos made before it was configured. One at a time. */
  async function backfillArchive() {
    if (!archive?.configured || !kek || !recordings) return;
    for (const m of db.mediaWithoutArchive()) {
      try {
        if (m.audio) {
          const r = await openRecording(m.meeting_id);
          let mp3;
          try {
            mp3 = r.read(0, r.length - 1);
          } finally {
            r.close();
          }
          await archiveRecording(m.meeting_id, mp3);
        }
        if (m.video) {
          const v = await openVideo(m.meeting_id);
          let mp4;
          try {
            mp4 = v.read(0, v.length - 1);
          } finally {
            v.close();
          }
          await archiveVideo(m.meeting_id, mp4);
        }
      } catch (e) {
        log(`meeting ${m.meeting_id}: c0mpute backfill skipped: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  }

  function archiveRecording(id, mp3) {
    const p = Promise.resolve()
      .then(() => archive.put(mp3, { fileName: `board-meeting-${new Date(now()).toISOString().slice(0, 10)}.mp3` }))
      .then((r) => {
        if (r.skipped) return db.setRecordingArchive(id, { note: `not copied to c0mpute: ${r.skipped}` });
        const rec = db.recording(id);
        if (!rec || rec.deleted_at) return log(`meeting ${id}: the recording was deleted while its c0mpute copy uploaded; ${r.ref} remains in c0mpute storage`);
        db.setRecordingArchive(id, { ref: r.ref, link: sealText(kek, linkAad(id), r.link) });
        log(`meeting ${id}: recording copied to c0mpute private storage (${r.ref})`); // never the link: it carries the key
      })
      .catch((e) => {
        log(`meeting ${id}: c0mpute private storage copy failed, the copy on this server is unaffected: ${String(e?.message ?? e).slice(0, 200)}`);
        try {
          db.setRecordingArchive(id, { note: 'the c0mpute copy failed; the recording is kept on this server' });
        } catch {
          /* the row is gone */
        }
      });
    pendingArchives.add(p);
    p.finally(() => pendingArchives.delete(p));
    return p;
  }

  // ---------------------------------------------------------------- premium: the branded rendition
  // Free for everyone: the captioned meeting video above (recordings.video_*). Premium adds the
  // branded 1080x1080 LinkedIn rendition (src/video.js renderBrandedVideo) and its trimmed MP3.

  let brandedChain = Promise.resolve();
  const brandedQueued = new Set();
  const brandedPlayable = (meetingId) => {
    const v = db.branded(meetingId);
    return !!(v && v.status === 'done' && v.wrapped_key && !v.deleted_at);
  };

  /** What the owner sees of a meeting's branded rendition. */
  function brandedView(row) {
    const v = db.branded(row.id);
    const premium = premiumActive(row.account_id);
    const base = `${publicUrl}/api/v1/meetings/${row.id}`;
    if (v && v.status === 'done' && v.wrapped_key) {
      return {
        status: 'done',
        video_url: `${base}/branded.mp4`,
        trimmed_mp3_url: v.mp3_wrapped_key ? `${base}/trimmed.mp3` : null,
        seconds: v.seconds ? Math.round(v.seconds) : null,
        original_seconds: v.original_seconds ? Math.round(v.original_seconds) : null,
        bytes: v.bytes,
        made_at: v.finished_at ? new Date(v.finished_at).toISOString() : null,
        how: 'GET video_url with your key (Range works), or POST .../branded-video/link for a 6-hour link a <video> element or an upload can use.',
      };
    }
    if (v && (v.status === 'queued' || v.status === 'rendering')) return { status: v.status, note: 'The LinkedIn video is being made (about 1 to 2 minutes for a 15-minute meeting).' };
    return {
      status: v?.status === 'failed' ? 'failed' : 'none',
      ...(v?.status === 'failed' ? { error: v.error } : {}),
      premium,
      how: premium ? `POST ${base}/branded-video makes it` : `A Premium feature ($${PREMIUM_PRICE_USD} per ${PREMIUM_DAYS} days): POST ${publicUrl}/api/v1/premium/checkout`,
    };
  }

  /** Ask for a meeting's branded rendition (Premium). Returns the rendition view. */
  async function requestBranded(key, id, { force = false } = {}) {
    const { row, actor } = owned(key, id);
    if (!row.voice) throw new HttpError(409, 'only a voice meeting has a recording to make a video from');
    if (row.status !== 'done') throw new HttpError(409, `the meeting is ${row.status}; the video can be made once it is done`);
    recordingMeta(row.id);
    if (!actor.admin && !premiumActive(row.account_id)) {
      const a = db.accountById(row.account_id);
      throw new HttpError(402, `The branded LinkedIn video is a Premium feature: $${PREMIUM_PRICE_USD} per ${PREMIUM_DAYS} days through CoinPay (included with an active Profullstack Pass). The recording and the captioned meeting video stay free.`, {
        code: 'premium_required',
        checkout_url: coinpay ? await premiumCheckout(a) : null,
        price_usd: PREMIUM_PRICE_USD,
        days: PREMIUM_DAYS,
      });
    }
    const cur = db.branded(row.id);
    if (cur && (cur.status === 'queued' || cur.status === 'rendering')) return brandedView(row);
    if (cur && cur.status === 'done' && cur.wrapped_key && !force) return brandedView(row);
    db.queueBranded(row.id, row.account_id, actor.admin ? 'admin-key' : `account:${actor.account.id}`);
    enqueueBranded(row.id);
    return brandedView(db.meeting(row.id));
  }

  /** One render at a time, in order. */
  function enqueueBranded(id) {
    if (brandedQueued.has(id)) return brandedChain;
    brandedQueued.add(id);
    brandedChain = brandedChain
      .then(() => renderBrandedJob(id))
      .catch((e) => log(`meeting ${id}: branded video failed: ${String(e?.stack ?? e).slice(0, 600)}`))
      .finally(() => brandedQueued.delete(id));
    return brandedChain;
  }

  /** The meta line under the title: the model the board ran on, or the date. */
  function modelLine(row) {
    const m = parse(row.meeting_json);
    const label = modelLabel(m?.billing?.model?.split(',')[0]?.trim()) || (row.paid_with === 'free' && !row.voice ? null : modelLabel(model?.models?.[0]));
    return `5 AI advisors + a chair · ${label || m?.date || new Date(row.created_at).toISOString().slice(0, 10)}`;
  }

  async function renderBrandedJob(id) {
    const row = db.meeting(id);
    const v = db.branded(id);
    if (!row || !v || (v.status !== 'queued' && v.status !== 'rendering')) return;
    const mlog = (m) => log(`meeting ${id}: ${m}`);
    if (!kek || !recordings) {
      db.updateBranded(id, { status: 'failed', error: 'videos cannot be stored: the server key is not configured' });
      return;
    }
    db.updateBranded(id, { status: 'rendering', error: null });
    const tmp = videoTmpDir || join(recordings.dir, '..', 'video-tmp');
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(tmp, `${id.replace(/[^\w-]/g, '')}-`));
    try {
      // The decrypted recording exists only in this private work directory, for this render.
      const r = await openRecording(id);
      const fd = openSync(join(work, 'orig.mp3'), 'w', 0o600);
      try {
        const STEP = 1024 * 1024;
        for (let o = 0; o < r.length; o += STEP) writeSync(fd, r.read(o, Math.min(r.length - 1, o + STEP - 1)));
      } finally {
        closeSync(fd);
        r.close();
      }
      const out = await brandedRenderer({
        dir: work,
        input: 'orig.mp3',
        title: videoTitle({ meeting: parse(row.meeting_json), brief: parse(row.brief_json) }),
        meta: modelLine(row),
        transcript: parse(row.transcript_json) ?? [],
        ffmpeg: env.FFMPEG || 'ffmpeg',
        ffprobe: env.FFPROBE || 'ffprobe',
        nice: env.BOARD_VIDEO_NICE === 'off' ? null : Number(env.BOARD_VIDEO_NICE ?? 19),
        log: mlog,
      });
      // The recording may have been deleted while this ran: then nothing is kept.
      if (!recordingPlayable(db.recording(id))) {
        db.deleteBranded(id);
        mlog('branded video: the recording was deleted during the render; nothing kept');
        return;
      }
      const store = (kind, plain) => {
        const vid = `${id}-${kind}`;
        const { key, data } = encryptRecording(vid, plain);
        const path = recordings.pathFor(vid);
        writeFileSync(path, data, { mode: 0o600 });
        const wrapped = wrapKey(kek, vid, key);
        key.fill(0);
        return { path, wrapped, bytes: plain.length, cipher: data.length };
      };
      const mp4 = store('branded', readFileSync(out.mp4));
      const mp3 = out.mp3 ? store('trimmed', readFileSync(out.mp3)) : null;
      db.updateBranded(id, {
        status: 'done',
        wrapped_key: mp4.wrapped,
        path: mp4.path,
        bytes: mp4.bytes,
        cipher_bytes: mp4.cipher,
        seconds: out.seconds,
        mp3_wrapped_key: mp3?.wrapped ?? null,
        mp3_path: mp3?.path ?? null,
        mp3_bytes: mp3?.bytes ?? null,
        mp3_seconds: out.mp3Seconds ?? null,
        original_seconds: out.originalSeconds ?? null,
        cuts: out.cuts ?? null,
        finished_at: now(),
        deleted_at: null,
      });
      mlog(`branded video saved (${Math.round(out.seconds)}s, ${mp4.bytes} bytes mp4, encrypted)`);
    } catch (e) {
      db.updateBranded(id, { status: 'failed', error: String(e?.message ?? e).slice(0, 400) });
      mlog(`branded video failed: ${String(e?.message ?? e).slice(0, 400)}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Open the branded MP4 (kind 'branded') or its trimmed MP3 (kind 'trimmed') for streaming. */
  function openBranded(meetingId, kind = 'branded') {
    const v = db.branded(meetingId);
    const wrapped = kind === 'trimmed' ? v?.mp3_wrapped_key : v?.wrapped_key;
    const path = kind === 'trimmed' ? v?.mp3_path : v?.path;
    if (!v || v.status !== 'done' || !wrapped || !path) throw new HttpError(404, kind === 'trimmed' ? 'this meeting has no trimmed MP3' : 'this meeting has no branded video yet');
    if (!kek) throw new HttpError(503, 'videos cannot be opened: the server key is not configured');
    const vid = `${meetingId}-${kind}`;
    const key = unwrapKey(kek, vid, wrapped);
    const r = openEncrypted(path, vid, key);
    return { ...r, mime: kind === 'trimmed' ? 'audio/mpeg' : 'video/mp4', seconds: kind === 'trimmed' ? v.mp3_seconds : v.seconds };
  }

  /** A 6-hour link to the owner's branded MP4 or trimmed MP3 (a <video> element cannot send a bearer). */
  function brandedLink(key, id, kind = 'branded') {
    const { row } = owned(key, id);
    openBranded(row.id, kind).close();
    return { url: signMedia(row.id, 6 * 3_600_000, kind), expires_in: 6 * 3600 };
  }

  /** On boot: premium accounts' recorded voice meetings that have no branded rendition yet get one. */
  function backfillBranded() {
    if (env.BOARD_VIDEO === '0' || !kek || !recordings) return;
    for (const r of db.recordedWithoutBranded()) {
      if (!premiumActive(r.account_id)) continue;
      db.queueBranded(r.id, r.account_id, 'backfill');
      enqueueBranded(r.id);
    }
  }

  // ---------------------------------------------------------------- admin

  /**
   * Who may use /admin: the admin key (BOARD_SAAS_ADMIN_KEY), or an account flagged admin using its
   * own API key (the key the web app keeps after an email code or Sign in with CoinPay). An OAuth
   * token from a connected app never gets admin, even for an admin account. The flag is set by an
   * admin by account id (never from an email, and never from CoinPay's unverified email).
   */
  function adminWho(key) {
    const a = actorFor(key);
    if (!a) throw new HttpError(401, 'sign in first', { auth: true });
    if (a.admin) return { actor: 'admin-key', keyAdmin: true, accountId: null };
    if (a.account?.admin && !a.oauth) return { actor: `account:${a.account.id}`, keyAdmin: false, accountId: a.account.id };
    throw new HttpError(403, 'admins only');
  }

  const auditView = (r) => ({ id: r.id, at: new Date(r.at).toISOString(), actor: r.actor, account_id: r.account_id, action: r.action, detail: parse(r.detail), ip: r.ip ?? null });

  function adminView(a) {
    const link = db.coinpayLinkOf(a.id);
    const t = now();
    return {
      ...accountView(a),
      signin: a.signin ?? 'email',
      created_at: new Date(a.created_at).toISOString(),
      admin: !!a.admin,
      free_used: !!a.free_used,
      coinpay_sub: link?.sub ?? null,
      meetings: db.meetingCountFor(a.id),
      voice_raw: {
        trial_started_at: a.voice_trial_started_at ? new Date(a.voice_trial_started_at).toISOString() : null,
        trial_days: a.voice_trial_days ?? null,
        trial_arm: a.voice_trial_arm ?? null,
        paid_until: a.voice_paid_until ? new Date(a.voice_paid_until).toISOString() : null,
      },
      pass_until: a.pass_until ? new Date(a.pass_until).toISOString() : null,
      pass_active: (a.pass_until ?? 0) > t,
      audit: db.auditFor(a.id, 20).map(auditView),
    };
  }

  /** Find accounts by id, by email (email accounts only) or by CoinPay sub. */
  function adminFind(key, qIn) {
    adminWho(key);
    const q = String(qIn ?? '').trim();
    if (!q || q.length > 200) throw new HttpError(400, 'look up by account id, email or CoinPay sub');
    const found = new Map();
    const byId = db.accountById(q);
    if (byId) found.set(byId.id, byId);
    if (q.includes('@') && !isPlaceholderEmail(q)) {
      const e = db.accountByEmail(q.toLowerCase());
      if (e) found.set(e.id, e);
    }
    for (const id of db.coinpayAccountsFor(q)) {
      const a = db.accountById(id);
      if (a) found.set(a.id, a);
    }
    return { query: q, accounts: [...found.values()].map(adminView) };
  }

  /**
   * One admin change, written to the audit log: credits (+/-), premium (days or forever), revoke
   * premium, admin on/off (the admin key only). body: { action, delta | days | forever | value, note }
   */
  function adminAct(key, accountId, body = {}, ip = null) {
    const who = adminWho(key);
    const a = db.accountById(String(accountId ?? ''));
    if (!a) throw new HttpError(404, 'no account with that id');
    const note = String(body?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    const action = String(body?.action ?? '');
    const iso = (t) => (t == null ? null : t >= FOREVER ? 'forever' : new Date(t).toISOString());
    let detail;
    if (action === 'credits') {
      const delta = Number(body.delta);
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) throw new HttpError(400, 'delta must be a whole number from -1000 to 1000, not 0');
      const after = db.addCredits(a.id, delta);
      detail = { delta, before: a.credits, after };
    } else if (action === 'premium') {
      const forever = truthy(body.forever);
      const days = Number(body.days);
      if (!forever && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new HttpError(400, 'days must be a whole number from 1 to 3650, or forever: true');
      if (forever) db.setPremium(a.id, FOREVER);
      else db.extendPremium(a.id, days);
      detail = { ...(forever ? { forever: true } : { days }), before: iso(a.premium_until), after: iso(db.accountById(a.id).premium_until) };
    } else if (action === 'revoke_premium') {
      db.setPremium(a.id, null);
      detail = { before: iso(a.premium_until), after: null };
    } else if (action === 'admin') {
      if (!who.keyAdmin) throw new HttpError(403, 'only the admin key can make or remove admins');
      const value = truthy(body.value);
      db.setAdmin(a.id, value);
      detail = { before: !!a.admin, after: value };
    } else throw new HttpError(400, 'action must be credits, premium, revoke_premium or admin');
    if (note) detail.note = note;
    db.audit({ actor: who.actor, accountId: a.id, action, detail, ip });
    log(`admin: ${who.actor} ${action} on account ${a.id} ${JSON.stringify(detail)}`);
    return adminView(db.accountById(a.id));
  }

  function adminAudit(key, accountId = null, limit = 100) {
    adminWho(key);
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    return (accountId ? db.auditFor(String(accountId), n) : db.auditRecent(n)).map(auditView);
  }

  // ---------------------------------------------------------------- payments

  /** CoinPay webhook. Returns { status, body }. */
  function coinpayWebhook(rawBody, signature) {
    if (!env.COINPAY_WEBHOOK_SECRET || !verifyWebhook(rawBody, signature, env.COINPAY_WEBHOOK_SECRET)) {
      return { status: 401, body: { error: 'bad signature' } };
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'bad json' } };
    }
    const ev = readWebhook(payload);
    if (!ev.paid) return { status: 200, body: { ok: true, ignored: ev.type || 'not paid' } };
    const premiumAccount = ev.metadata?.premium_account;
    if (premiumAccount) {
      const acct = db.accountById(String(premiumAccount));
      if (!acct) return { status: 200, body: { ok: true, ignored: 'no matching account' } };
      const fresh = db.recordPayment({ eventId: ev.eventId || `${ev.checkoutSessionId}:${ev.paymentId}`, meetingId: null, checkoutId: ev.checkoutSessionId, amountUsd: ev.amountUsd, raw: rawBody.slice(0, 20_000) });
      if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
      db.extendPremium(acct.id, PREMIUM_DAYS);
      db.audit({ actor: 'coinpay', accountId: acct.id, action: 'premium_paid', detail: { days: PREMIUM_DAYS, amount_usd: ev.amountUsd ?? null, checkout_id: ev.checkoutSessionId ?? null } });
      log(`account ${acct.id}: premium paid (${ev.type}), +${PREMIUM_DAYS} days`);
      return { status: 200, body: { ok: true } };
    }
    const voiceAccount = ev.metadata?.voice_pass_account;
    if (voiceAccount) {
      const acct = db.accountById(String(voiceAccount));
      if (!acct) return { status: 200, body: { ok: true, ignored: 'no matching account' } };
      const fresh = db.recordPayment({ eventId: ev.eventId || `${ev.checkoutSessionId}:${ev.paymentId}`, meetingId: null, checkoutId: ev.checkoutSessionId, amountUsd: ev.amountUsd, raw: rawBody.slice(0, 20_000) });
      if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
      db.extendVoice(acct.id, VOICE_PASS_DAYS);
      log(`account ${acct.id}: voice pass paid (${ev.type}), +${VOICE_PASS_DAYS} days`);
      // A/B: conversion + revenue for accounts in the trial length test (exposed when the trial started).
      if (acct.voice_trial_arm) trialTest.purchase(acct.id, acct.voice_trial_arm, ev.eventId || `${ev.checkoutSessionId}:${ev.paymentId}`, ev.amountUsd ?? VOICE_PRICE_USD).catch(() => {});
      return { status: 200, body: { ok: true } };
    }
    const meetingId = ev.metadata?.meeting_id;
    const row = (meetingId && db.meeting(String(meetingId))) || (ev.checkoutSessionId && db.meetingByCheckout(ev.checkoutSessionId));
    if (!row) return { status: 200, body: { ok: true, ignored: 'no matching meeting' } };
    const fresh = db.recordPayment({ eventId: ev.eventId || `${ev.checkoutSessionId}:${ev.paymentId}`, meetingId: row.id, checkoutId: ev.checkoutSessionId, amountUsd: ev.amountUsd, raw: rawBody.slice(0, 20_000) });
    if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
    if (db.transition(row.id, 'awaiting_payment', 'queued', { paid_with: 'coinpay' })) {
      log(`meeting ${row.id}: paid (${ev.type}), queued`);
      kick();
    } else if (row.account_id) {
      // Paid twice or after the meeting moved on: keep the money as a credit, never lose it.
      db.refund(row.account_id, 'credit');
      log(`meeting ${row.id}: extra payment kept as a credit`);
    }
    return { status: 200, body: { ok: true } };
  }

  // ---------------------------------------------------------------- worker

  function kick() {
    setImmediate(pump);
  }

  function pump() {
    if (running.size >= maxRunning) return;
    for (const row of db.meetingsInStatus('queued')) {
      if (running.size >= maxRunning) break;
      if (!db.transition(row.id, 'queued', 'checking', { progress: JSON.stringify({ stage: 'checking' }) })) continue;
      running.add(row.id);
      work(row.id)
        .catch((e) => log(`meeting ${row.id}: worker crashed: ${e?.stack ?? e}`))
        .finally(() => {
          running.delete(row.id);
          kick();
        });
    }
  }

  /** Run the meeting with a live PairUX call alongside. Returns { meeting, call }. */
  async function withVoice(id, row, brief, mlog, onProgress, model) {
    const r1 = deferred();
    const r2 = deferred();
    const r3 = deferred();
    const compute = runMeeting(model, brief, {
      log: mlog,
      onProgress,
      onRound: (stage, value) => (stage === 'round1' ? r1.resolve(value) : r2.resolve(value)),
    }).then(
      (m) => (r3.resolve(m), m),
      (e) => {
        r1.reject(e);
        r2.reject(e);
        r3.reject(e);
        throw e;
      },
    );
    let call = null;
    let callError = null;
    // Live listening is on demand (see liveAudience): the voice runner always gets this sink, and
    // the sink goes nowhere until the meeting has an audience. An extra in every case: if c0mpute
    // refuses or ffmpeg fails, the call and the recording go on without it.
    const ctl = live?.configured ? { id, cast: null, stream: null, ended: false, chain: Promise.resolve(), log: mlog } : null;
    const liveSink = ctl
      ? {
          add: (pcm, at) => ctl.cast?.add(pcm, at),
          stream: (track, pcm, at) => ctl.cast?.stream(track, pcm, at),
        }
      : null;
    if (ctl) {
      liveCtls.set(id, ctl);
      // Shares expire without anybody calling in, so the audience is looked at again on a timer.
      ctl.timer = setInterval(() => syncLive(id), liveCheckMs);
      ctl.timer.unref?.();
      await syncLive(id); // an audience that already exists gets its playback URL before the call opens
    }
    const endLive = async () => {
      if (!ctl) return;
      ctl.ended = true;
      clearInterval(ctl.timer);
      await syncLive(id);
      liveCtls.delete(id);
    };
    const callRun = voice
      .run({
        id,
        board: { brief, round1: r1.promise, round2: r2.promise, minutes: r3.promise },
        record: !!row.record,
        pairux: voice.pairux,
        speech: voice.speech,
        model,
        waitMs: voiceWaitMs,
        log: mlog,
        liveSink,
        startNow: () => !!db.meeting(id)?.start_now,
        onState: (s) => db.updateMeeting(id, { voice_json: JSON.stringify(s) }),
      })
      .then(
        (r) => (call = r),
        (e) => {
          callError = e;
          // Say so at once: the call is marked failed (the page, CLI and MCP show call.error) and the
          // owner is emailed, while the meeting itself still finishes as text.
          const msg = String(e?.message ?? e).slice(0, 300);
          const s = db.meeting(id)?.voice_json ? JSON.parse(db.meeting(id).voice_json) : {};
          db.updateMeeting(id, { voice_json: JSON.stringify({ ...s, status: 'failed', error: msg, failed_at: new Date().toISOString() }) });
          mlog(`voice call failed: ${msg}`);
          const acct = row.account_id ? db.accountById(row.account_id) : null;
          if (acct && mailer) mailer({ to: acct.email, ...voiceFailedEmail(msg, urlFor(id)) }).catch((err) => mlog(`voice-failed email failed: ${err.message}`));
        },
      );
    let meeting;
    try {
      meeting = await compute;
    } finally {
      await callRun;
      await endLive();
    }
    if (callError) {
      mlog(`voice call failed, the meeting still finishes as text: ${callError.stack ?? callError}`);
      const s = db.meeting(id)?.voice_json ? JSON.parse(db.meeting(id).voice_json) : {};
      db.updateMeeting(id, { voice_json: JSON.stringify({ ...s, status: 'failed', error: String(callError.message ?? callError).slice(0, 300) }) });
    } else db.updateMeeting(id, { voice_json: JSON.stringify(call.state) });
    meeting.qa = call?.qa ?? [];
    meeting.voice = {
      held: !callError,
      error: callError ? 'The live call could not run, so this meeting finished as text. You were not charged anything extra.' : null,
      recorded: !!row.record && !callError,
      attendees: call?.humans?.map((h) => h.name) ?? [],
      notes: call?.notes ?? [],
      speech: 'Kokoro text to speech on c0mpute; the founder transcribed by self-hosted Whisper on PairUX.',
      pricing: `Voice meetings are a paid feature: free for a trial (up to ${VOICE_TRIAL_DAYS} days, fixed at your first voice meeting), then $${VOICE_PRICE_USD} per ${VOICE_PASS_DAYS} days. This meeting used one meeting credit, the same as a text meeting.`,
    };
    // Cut the dead air (answers are generated while the call runs) from the recording, and move the
    // transcript's times to match. BOARD_TRIM_SILENCE=0 keeps the raw mix.
    let recording = call?.recording;
    let transcript = call?.transcript;
    if (recording?.pcm?.length && env.BOARD_TRIM_SILENCE !== '0') {
      const c = compressSilence(recording.pcm, recording.rate, { maxGap: Number(env.BOARD_TRIM_MAX_GAP) || 1.2 });
      if (c.removedSeconds > 0) {
        recording = { ...recording, pcm: c.pcm, seconds: Math.round(c.pcm.length / recording.rate) };
        transcript = transcript?.map((line) => (line.t == null ? line : { ...line, t: c.map(Number(line.t)).toFixed(1) }));
        mlog(`recording: cut ${Math.round(c.removedSeconds)}s of silence (${call.recording.seconds}s -> ${recording.seconds}s)`);
      }
    }
    if (transcript?.length) db.updateMeeting(id, { transcript_json: JSON.stringify(transcript) });
    if (recording?.pcm?.length) {
      const mp3 = await saveRecording(row, recording).catch((e) => mlog(`recording could not be saved: ${e.stack ?? e}`));
      // The video needs the meeting's transcript_json, which is saved above; render after the call returns.
      if (mp3) setTimeout(() => queueVideo(row.id, mp3), 0);
    }
    return meeting;
  }

  // A paid meeting needs at least this much on the c0mpute balance before it starts (measured 2026-11-25:
  // the fixture meeting on Opus 5.5 was 13 calls, $0.47 at Anthropic, $0.57 charged; long company data
  // costs more, so 1.50 leaves headroom. BOARD_MIN_BALANCE_USD overrides).
  const MIN_BALANCE_USD = Number(env.BOARD_MIN_BALANCE_USD) || 1.5;
  // A pay-as-you-go meeting's model is metered, so it can be charged at Anthropic cost + 20%.
  const meters = new Map();

  /** Free-tier meetings run on c0mpute; paid, credit, admin and voice meetings on Claude. */
  function modelFor(row) {
    const m = row.paid_with === 'free' && !row.voice ? freeModel : model;
    if (row.paid_with !== 'c0mpute' || m === freeModel) return m;
    if (!meters.has(row.id)) meters.set(row.id, { costUsd: 0, calls: 0, models: {} });
    return metered(m, meters.get(row.id));
  }

  /**
   * Charge a finished pay-as-you-go meeting to the person's c0mpute balance: Anthropic cost + 20%,
   * once (idempotent per meeting). The meeting is delivered either way: the balance was checked
   * before it started, and a charge that did not go through is recorded to retry.
   */
  async function settle(id, row, mlog) {
    const meter = meters.get(id);
    meters.delete(id);
    if (!meter || row.paid_with !== 'c0mpute') return null;
    const costUsd = meter.costUsd;
    const priceUsd = priceFor(costUsd);
    const out = { model: Object.keys(meter.models).join(', ') || null, calls: meter.calls, anthropic_cost_usd: Number(costUsd.toFixed(4)), price_usd: priceUsd };
    db.updateMeeting(id, { cost_usd: costUsd, price_usd: priceUsd });
    if (!priceUsd) {
      db.updateMeeting(id, { charge_status: 'nothing_to_charge' });
      return { ...out, charged: false };
    }
    const acct = row.account_id ? db.accountById(row.account_id) : null;
    try {
      const r = await c0mpute.charge(acct, { meetingId: id, priceUsd, costUsd });
      db.updateMeeting(id, { charge_status: r.charged ? 'charged' : r.reason || 'unpaid', charge_json: JSON.stringify(r) });
      mlog(r.charged ? `charged $${priceUsd.toFixed(2)} (Anthropic cost $${costUsd.toFixed(4)})` : `charge of $${priceUsd.toFixed(2)} not taken: ${r.reason}`);
      return { ...out, charged: r.charged, ...(r.charged ? { balance_usd: r.balance_usd } : { reason: r.reason, top_up_url: r.top_up_url }) };
    } catch (e) {
      db.updateMeeting(id, { charge_status: 'pending', charge_json: JSON.stringify({ error: e.message }) });
      mlog(`charge of $${priceUsd.toFixed(2)} failed, kept to retry: ${e.message}`);
      return { ...out, charged: false, reason: 'pending' };
    }
  }

  async function work(id) {
    const row = db.meeting(id);
    const mlog = (m) => log(`meeting ${id}: ${m}`);
    const model = modelFor(row);
    try {
      mlog(`model: ${model.name} (${model.models?.[0] ?? 'default'})`);
      const check = await checkBrief(model, row.brief_text, { answers: row.clarified ? row.answers : null, log: mlog });
      if (check.missing.length && !row.clarified) {
        db.transition(id, 'checking', 'needs_clarification', { brief_json: JSON.stringify(check), progress: JSON.stringify({ stage: 'needs_clarification' }) });
        mlog(`asking once for: ${check.missing.join(', ')}`);
        return;
      }
      const brief = {
        text: row.clarified && row.answers ? `${row.brief_text}\n\nClarification: ${row.answers}` : row.brief_text,
        decision: check.decision || row.brief_text.slice(0, 200),
        options:
          check.options.length >= 2
            ? check.options
            : [check.options[0] || 'Go ahead with what the brief describes', 'Do nothing for now'],
        constraints: check.constraints,
        assumptions: assumptionsFor(check.missing),
        context: row.context_text || null,
      };
      db.transition(id, 'checking', 'running', { brief_json: JSON.stringify(brief), progress: JSON.stringify({ stage: 'round1', done: 0, of: 5 }) });
      noteVoiceMeeting(row);
      const onProgress = (stage, detail) => db.updateMeeting(id, { progress: JSON.stringify({ stage, ...detail }) });
      const callFailed = row.voice_json && JSON.parse(row.voice_json).status === 'failed';
      const meeting = row.voice && voice && !callFailed ? await withVoice(id, row, brief, mlog, onProgress, model) : await runMeeting(model, brief, { log: mlog, onProgress });
      if (row.voice && callFailed) meeting.voice = { held: false, error: `The live call stopped (${JSON.parse(row.voice_json).error}). You were not charged anything extra.`, recorded: false, attendees: [], notes: [] };
      const billing = await settle(id, row, mlog);
      if (billing) meeting.billing = billing;
      db.transition(id, 'running', 'done', { meeting_json: JSON.stringify(meeting), finished_at: Date.now(), progress: JSON.stringify({ stage: 'done' }) });
      setTimeout(() => queueSlideshow(id), 0);
      mlog('done');
      // Premium: the branded LinkedIn rendition is made by itself once a recorded voice meeting is done.
      if (row.voice && recordingPlayable(db.recording(id)) && premiumActive(row.account_id) && env.BOARD_VIDEO !== '0') {
        db.queueBranded(id, row.account_id, 'auto');
        enqueueBranded(id);
      }
      const acct = row.account_id ? db.accountById(row.account_id) : null;
      if (acct && mailer) mailer({ to: acct.email, ...meetingDoneEmail(meeting, urlFor(id)) }).catch((e) => mlog(`done email failed: ${e.message}`));
    } catch (e) {
      const back = row.paid_with === 'c0mpute' ? 'You were not charged.' : 'Your meeting was refunded.';
      const msg = e?.code === 'bad_json'
        ? `The ${model.name} model did not return usable JSON after two retries (${e.message}). Nothing was made up. ${back}`
        : `${model.name} could not finish this meeting: ${e?.message ?? e}. Nothing was made up. ${back}`;
      const cur = db.meeting(id);
      meters.delete(id);
      db.updateMeeting(id, { status: 'failed', error: msg, finished_at: Date.now() });
      // A pay-as-you-go meeting is charged only on success, so there is nothing to give back.
      if (cur.account_id && cur.paid_with && cur.paid_with !== 'admin' && cur.paid_with !== 'pass' && cur.paid_with !== 'c0mpute') db.refund(cur.account_id, cur.paid_with === 'free' ? 'free' : 'credit');
      mlog(`failed: ${e?.message ?? e}${e?.raw ? ` raw=${JSON.stringify(e.raw.slice(0, 1500))}` : ''}`);
    }
  }

  /**
   * On boot, meetings a restart interrupted start over. A voice meeting whose call had already
   * opened finishes as text instead (no second call, and no restart loop if the call itself
   * was what brought the server down); one that never reached its call tries again.
   */
  function resume() {
    // Branded renders a restart interrupted start again (one at a time, like any other).
    for (const v of db.brandedInStatus('queued', 'rendering')) enqueueBranded(v.meeting_id);
    backfillBranded();
    for (const s of ['checking', 'running']) {
      for (const r of db.meetingsInStatus(s)) {
        const opened = r.voice && r.voice_json && JSON.parse(r.voice_json).session_id;
        // Its ffmpeg died with the process: mark the live stream ended and delete it on c0mpute.
        const wasLive = parse(r.live_json);
        if (wasLive?.status === 'live') {
          db.updateMeeting(r.id, { live_json: JSON.stringify({ status: 'ended', stream_id: wasLive.stream_id, ended_at: new Date().toISOString() }) });
          if (live?.configured && wasLive.stream_id) live.remove(wasLive.stream_id).catch((e) => log(`meeting ${r.id}: could not delete the orphaned c0mpute stream: ${e.message}`));
        }
        // The process that held the call is gone: end the PairUX session so nobody waits in an empty room.
        if (opened && voice?.pairux?.configured) voice.pairux.endSession(opened).catch((e) => log(`meeting ${r.id}: could not end the orphaned call: ${e.message}`));
        const extra = opened ? { voice_json: JSON.stringify({ ...JSON.parse(r.voice_json), status: 'failed', error: 'the server restarted during the call, so the meeting finished as text' }) } : r.voice ? { voice_json: null, start_now: 0 } : {};
        db.transition(r.id, s, 'queued', extra);
      }
    }
    kick();
  }

  return {
    actorFor,
    startLogin,
    verifyLogin,
    createMeeting,
    getMeeting,
    reportData,
    startNow,
    listMeetings,
    account,
    accountWithBalance,
    c0mputeConnect,
    c0mputeFinish,
    c0mputeDisconnect,
    clarify,
    coinpayWebhook,
    resume,
    backfillVideos,
    kick,
    meetingView,
    urlFor,
    voiceCheckoutFor,
    createShare,
    listShares,
    revokeShare,
    byShareToken,
    setVisibility,
    publicMeeting,
    publicIndex,
    shareables,
    /** Resolves when background c0mpute uploads have settled (tests, shutdown). */
    idle: () => Promise.allSettled([...pendingArchives, brandedChain]),
    premiumCheckoutFor,
    premiumStatus,
    requestBranded,
    openBranded,
    brandedLink,
    adminWho,
    adminFind,
    adminAct,
    adminAudit,
    openRecording,
    openVideo,
    openSlideshow,
    recordingLink,
    signMedia,
    checkMedia,
    deleteRecording,
    transcript,
  };
}

// Business logic shared by the HTTP API, the MCP endpoint and the worker.
// Meeting statuses:
//   awaiting_payment -> queued -> checking -> (needs_clarification -> queued -> checking) -> running -> done | failed
// A voice meeting (voice=1) also holds a live PairUX call while it is running; voice_json carries
// the join link and the call's state (waiting -> live -> ended | failed).
//
// Privacy: every meeting made since 0.3.0 is private (private=1): its status, report, recording
// and transcript are readable by the owner (or the admin key) only, or through a share link the
// owner made. Meetings made before 0.3.0 keep working by their old public link (private=0).
import { CoinPay, readWebhook, verifyWebhook } from '@profullstack/coinpay-onboard';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assumptionsFor, checkBrief, clarifyingQuestions, MAX_BRIEF, MAX_CONTEXT, runMeeting } from './meeting.js';
import { codeEmail, meetingDoneEmail } from './mail.js';
import { encodeMp3, encryptRecording, openEncrypted, unwrapKey, wrapKey } from './recording.js';

export const PRICE_USD = 9;
// Voice meetings (with recording): a paid feature, free for a 30-day trial per account that starts
// on the account's first voice meeting. After the trial, a voice pass costs VOICE_PRICE_USD for
// VOICE_PASS_DAYS of voice meetings. The text meeting price is unchanged (first free, then $9).
export const VOICE_TRIAL_DAYS = 30;
export const VOICE_PASS_DAYS = 30;
const DAY = 86_400_000;

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

const EXPIRES = { never: null, '7d': 7 * DAY, '30d': 30 * DAY };

export function createService({
  db,
  env = process.env,
  model,
  mailer,
  log = console.log,
  publicUrl = 'https://board.saas.pit.world',
  accountForToken = () => null,
  voice = null, // { pairux, speech, run } when voice meetings are configured
  recordings = null, // createRecordingStore(...)
  kek = null, // Buffer(32): wraps recording keys
  now = () => Date.now(),
  coinpay: coinpayOverride = undefined,
}) {
  const coinpay = coinpayOverride !== undefined ? coinpayOverride : env.COINPAY_API_KEY ? new CoinPay({ token: env.COINPAY_API_KEY, base: env.COINPAY_API_URL || undefined }) : null;
  const running = new Set();
  const maxRunning = Number(env.BOARD_MAX_MEETINGS) || 2;
  const ipCodes = new Map();
  const VOICE_PRICE_USD = Number(env.BOARD_VOICE_PRICE_USD) || 19;
  const voiceWaitMs = (Number(env.BOARD_VOICE_WAIT_SECONDS) || 180) * 1000;
  // Signs short-lived media links (an <audio> element cannot send a bearer header).
  const mediaSecret = kek ? createHmac('sha256', kek).update('board-saas media links').digest() : randomBytes(32);

  const urlFor = (id) => `${publicUrl}/m/${id}`;
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

  /** The account's voice standing: trial, paid pass, or ended. */
  function voiceStatus(a) {
    const t = now();
    const trialEnds = a.voice_trial_started_at ? a.voice_trial_started_at + VOICE_TRIAL_DAYS * DAY : null;
    const inTrial = !a.voice_trial_started_at || trialEnds > t;
    const paid = (a.voice_paid_until ?? 0) > t;
    const daysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds - t) / DAY)) : VOICE_TRIAL_DAYS;
    return {
      available: voiceReady(),
      active: inTrial || paid,
      plan: paid ? 'paid' : !a.voice_trial_started_at ? 'trial_not_started' : inTrial ? 'trial' : 'trial_ended',
      trial_started_at: a.voice_trial_started_at ? new Date(a.voice_trial_started_at).toISOString() : null,
      trial_ends_at: trialEnds ? new Date(trialEnds).toISOString() : null,
      trial_days_left: inTrial ? daysLeft : 0,
      paid_until: paid ? new Date(a.voice_paid_until).toISOString() : null,
      price_usd: VOICE_PRICE_USD,
      pass_days: VOICE_PASS_DAYS,
      summary: paid
        ? `Voice meetings: paid through ${new Date(a.voice_paid_until).toISOString().slice(0, 10)}`
        : !a.voice_trial_started_at
          ? `Voice meetings: free ${VOICE_TRIAL_DAYS}-day trial (starts with your first voice meeting), then $${VOICE_PRICE_USD} per ${VOICE_PASS_DAYS} days`
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
      customerEmail: account.email,
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
    throw new HttpError(402, `Your ${VOICE_TRIAL_DAYS}-day voice trial has ended. Voice meetings are $${VOICE_PRICE_USD} per ${VOICE_PASS_DAYS} days: pay with CoinPay, then start the meeting again. Text meetings still work as before.`, {
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
    return { id: a.id, email: a.email, free_meeting_available: !a.free_used, credits: a.credits, price_usd: PRICE_USD, voice: voiceStatus(a) };
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
        v.recording = { seconds: rec.seconds, bytes: rec.bytes, mime: rec.mime, stored: rec.c0mpute_ref ? 'encrypted on this server and as a private c0mpute storage object' : 'encrypted on this server', url: `${publicUrl}/api/v1/meetings/${row.id}/recording` };
      } else if (owner && rec?.deleted_at) v.recording = { deleted: true };
      if (owner && row.transcript_json) v.transcript_url = `${publicUrl}/api/v1/meetings/${row.id}/transcript`;
    }
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
    if (wantVoice) db.startVoiceTrial(actor.account.id);
    const spent = db.spend(actor.account.id);
    if (spent) {
      const row = db.createMeeting({ accountId: actor.account.id, ...common, status: 'queued', paidWith: spent });
      kick();
      return meetingView(row, { owner: true });
    }
    if (!coinpay) throw new HttpError(503, 'payments are not configured on this server');
    const row = db.createMeeting({ accountId: actor.account.id, ...common, status: 'awaiting_payment' });
    const session = await coinpay.createCheckoutSession({
      amount: PRICE_USD,
      description: 'Board as a Service: one board meeting',
      customerEmail: actor.account.email,
      accountId: actor.account.id,
      property: 'board.saas.pit.world',
      metadata: { meeting_id: row.id },
      successUrl: urlFor(row.id),
      cancelUrl: `${publicUrl}/`,
      expiresInMinutes: 120,
      idempotencyKey: `board-${row.id}`,
    });
    db.updateMeeting(row.id, { checkout_id: session.id, checkout_url: session.url });
    return meetingView(db.meeting(row.id), { owner: true });
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
      brief: r.brief_text.slice(0, 140),
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  function account(key) {
    const actor = requireActor(key);
    if (actor.admin) return { admin: true, free_meeting_available: true, credits: 'unlimited', price_usd: PRICE_USD, voice: { available: voiceReady(), active: true, plan: 'admin', summary: 'Voice meetings: admin', price_usd: VOICE_PRICE_USD, pass_days: VOICE_PASS_DAYS } };
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
    return {
      id: s.id,
      meeting_id: s.meeting_id,
      url: `${publicUrl}/s/${s.token}`,
      include_recording: !!s.include_recording,
      allow_download: !!s.allow_download,
      expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null,
      revoked: !!s.revoked_at,
      expired: !!(s.expires_at && s.expires_at < now()),
      created_at: new Date(s.created_at).toISOString(),
      last_used_at: s.last_used_at ? new Date(s.last_used_at).toISOString() : null,
    };
  }

  function createShare(key, id, opts = {}) {
    const { row, actor } = owned(key, id);
    if (row.status !== 'done') throw new HttpError(409, `the meeting is ${row.status}; share it once the report is ready`);
    const exp = String(opts.expires ?? 'never');
    if (!(exp in EXPIRES)) throw new HttpError(400, 'expires must be never, 7d or 30d');
    const s = db.createShare({
      meetingId: row.id,
      accountId: actor.account?.id ?? null,
      includeRecording: opts.include_recording === true || opts.include_recording === 'true',
      allowDownload: opts.allow_download === true || opts.allow_download === 'true',
      expiresAt: EXPIRES[exp] ? now() + EXPIRES[exp] : null,
    });
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
    return shareView(db.share(s.id));
  }

  /** What a share link opens, or 404. */
  function byShareToken(token) {
    const s = db.shareByToken(token);
    if (!s) throw new HttpError(404, 'this share link was revoked, has expired, or never existed');
    const row = db.meeting(s.meeting_id);
    if (!row || row.status !== 'done') throw new HttpError(404, 'this share link was revoked, has expired, or never existed');
    const view = meetingView(row);
    return { share: s, view, row };
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

  function signMedia(meetingId, ttlMs = 6 * 3_600_000) {
    const exp = now() + ttlMs;
    const sig = createHmac('sha256', mediaSecret).update(`${meetingId}.${exp}`).digest('base64url');
    return `${publicUrl}/media/${meetingId}.mp3?exp=${exp}&sig=${sig}`;
  }
  function checkMedia(meetingId, exp, sig) {
    if (!exp || !sig || Number(exp) < now()) return false;
    return safeEqual(createHmac('sha256', mediaSecret).update(`${meetingId}.${exp}`).digest('base64url'), sig);
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
    db.deleteRecording(row.id); // the key is gone first: every copy is now unreadable
    await recordings?.remove(row.id, rec.c0mpute_ref);
    db.updateMeeting(row.id, { transcript_json: null });
    log(`meeting ${row.id}: recording and transcript deleted by the owner`);
    return { deleted: true, meeting_id: row.id };
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
    return true;
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
    const voiceAccount = ev.metadata?.voice_pass_account;
    if (voiceAccount) {
      const acct = db.accountById(String(voiceAccount));
      if (!acct) return { status: 200, body: { ok: true, ignored: 'no matching account' } };
      const fresh = db.recordPayment({ eventId: ev.eventId || `${ev.checkoutSessionId}:${ev.paymentId}`, meetingId: null, checkoutId: ev.checkoutSessionId, amountUsd: ev.amountUsd, raw: rawBody.slice(0, 20_000) });
      if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
      db.extendVoice(acct.id, VOICE_PASS_DAYS);
      log(`account ${acct.id}: voice pass paid (${ev.type}), +${VOICE_PASS_DAYS} days`);
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
  async function withVoice(id, row, brief, mlog, onProgress) {
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
    const live = voice
      .run({
        id,
        board: { brief, round1: r1.promise, round2: r2.promise, minutes: r3.promise },
        record: !!row.record,
        pairux: voice.pairux,
        speech: voice.speech,
        model,
        waitMs: voiceWaitMs,
        log: mlog,
        startNow: () => !!db.meeting(id)?.start_now,
        onState: (s) => db.updateMeeting(id, { voice_json: JSON.stringify(s) }),
      })
      .then(
        (r) => (call = r),
        (e) => (callError = e),
      );
    let meeting;
    try {
      meeting = await compute;
    } finally {
      await live;
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
      pricing: `Voice meetings are a paid feature: free for a ${VOICE_TRIAL_DAYS}-day trial, then $${VOICE_PRICE_USD} per ${VOICE_PASS_DAYS} days. This meeting used one meeting credit, the same as a text meeting.`,
    };
    if (call?.transcript?.length) db.updateMeeting(id, { transcript_json: JSON.stringify(call.transcript) });
    if (call?.recording?.pcm?.length) await saveRecording(row, call.recording).catch((e) => mlog(`recording could not be saved: ${e.stack ?? e}`));
    return meeting;
  }

  async function work(id) {
    const row = db.meeting(id);
    const mlog = (m) => log(`meeting ${id}: ${m}`);
    try {
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
      const onProgress = (stage, detail) => db.updateMeeting(id, { progress: JSON.stringify({ stage, ...detail }) });
      const meeting = row.voice && voice ? await withVoice(id, row, brief, mlog, onProgress) : await runMeeting(model, brief, { log: mlog, onProgress });
      db.transition(id, 'running', 'done', { meeting_json: JSON.stringify(meeting), finished_at: Date.now(), progress: JSON.stringify({ stage: 'done' }) });
      mlog('done');
      const acct = row.account_id ? db.accountById(row.account_id) : null;
      if (acct && mailer) mailer({ to: acct.email, ...meetingDoneEmail(meeting, urlFor(id)) }).catch((e) => mlog(`done email failed: ${e.message}`));
    } catch (e) {
      const msg = e?.code === 'bad_json'
        ? `The c0mpute model did not return usable JSON after two retries (${e.message}). Nothing was made up; your meeting was refunded.`
        : `c0mpute could not finish this meeting: ${e?.message ?? e}. Nothing was made up; your meeting was refunded.`;
      const cur = db.meeting(id);
      db.updateMeeting(id, { status: 'failed', error: msg, finished_at: Date.now() });
      if (cur.account_id && cur.paid_with && cur.paid_with !== 'admin') db.refund(cur.account_id, cur.paid_with === 'free' ? 'free' : 'credit');
      mlog(`failed: ${e?.message ?? e}${e?.raw ? ` raw=${JSON.stringify(e.raw.slice(0, 1500))}` : ''}`);
    }
  }

  /** On boot, meetings a restart interrupted start over (a voice meeting opens a new call). */
  function resume() {
    for (const s of ['checking', 'running']) for (const r of db.meetingsInStatus(s)) db.transition(r.id, s, 'queued', r.voice ? { voice_json: null, start_now: 0 } : {});
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
    clarify,
    coinpayWebhook,
    resume,
    kick,
    meetingView,
    urlFor,
    voiceCheckoutFor,
    createShare,
    listShares,
    revokeShare,
    byShareToken,
    openRecording,
    recordingLink,
    signMedia,
    checkMedia,
    deleteRecording,
    transcript,
  };
}

// Business logic shared by the HTTP API, the MCP endpoint and the worker.
// Meeting statuses:
//   awaiting_payment -> queued -> checking -> (needs_clarification -> queued -> checking) -> running -> done | failed
import { CoinPay, readWebhook, verifyWebhook } from '@profullstack/coinpay-onboard';
import { timingSafeEqual } from 'node:crypto';
import { assumptionsFor, checkBrief, clarifyingQuestions, MAX_BRIEF, runMeeting } from './meeting.js';
import { codeEmail, meetingDoneEmail } from './mail.js';

export const PRICE_USD = 9;

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

export function createService({ db, env = process.env, model, mailer, log = console.log, publicUrl = 'https://board.saas.pit.world' }) {
  const coinpay = env.COINPAY_API_KEY ? new CoinPay({ token: env.COINPAY_API_KEY, base: env.COINPAY_API_URL || undefined }) : null;
  const running = new Set();
  const maxRunning = Number(env.BOARD_MAX_MEETINGS) || 2;
  const ipCodes = new Map();

  const urlFor = (id) => `${publicUrl}/m/${id}`;

  /** Bearer key -> { admin } | { account } | null. */
  function actorFor(key) {
    if (!key) return null;
    if (env.BOARD_SAAS_ADMIN_KEY && safeEqual(key, env.BOARD_SAAS_ADMIN_KEY)) return { admin: true, account: null };
    const account = db.accountByKey(key);
    return account ? { admin: false, account } : null;
  }

  function requireActor(key) {
    const a = actorFor(key);
    if (!a) throw new HttpError(401, 'sign in first: POST /api/v1/auth/code with your email, then /api/v1/auth/verify with the code, and send the key as "Authorization: Bearer <key>"');
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

  function accountView(a) {
    return { id: a.id, email: a.email, free_meeting_available: !a.free_used, credits: a.credits, price_usd: PRICE_USD };
  }

  function meetingView(row) {
    if (!row) return null;
    const v = {
      id: row.id,
      status: row.status,
      url: urlFor(row.id),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      progress: row.progress ? JSON.parse(row.progress) : null,
      brief_text: row.brief_text,
    };
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
    }
    return v;
  }

  async function createMeeting(key, briefIn) {
    const actor = requireActor(key);
    const briefText = String(briefIn ?? '').trim();
    if (briefText.length < 20) throw new HttpError(400, 'the brief is too short: give the decision, the options and the constraints');
    if (briefText.length > MAX_BRIEF) throw new HttpError(400, `the brief is too long (max ${MAX_BRIEF} characters)`);
    if (actor.admin) {
      const row = db.createMeeting({ accountId: null, briefText, status: 'queued', paidWith: 'admin' });
      kick();
      return meetingView(row);
    }
    const spent = db.spend(actor.account.id);
    if (spent) {
      const row = db.createMeeting({ accountId: actor.account.id, briefText, status: 'queued', paidWith: spent });
      kick();
      return meetingView(row);
    }
    if (!coinpay) throw new HttpError(503, 'payments are not configured on this server');
    const row = db.createMeeting({ accountId: actor.account.id, briefText, status: 'awaiting_payment' });
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
    return meetingView(db.meeting(row.id));
  }

  function getMeeting(id) {
    const row = db.meeting(String(id ?? ''));
    if (!row) throw new HttpError(404, 'no meeting with that id');
    return meetingView(row);
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
    if (actor.admin) return { admin: true, free_meeting_available: true, credits: 'unlimited', price_usd: PRICE_USD };
    return accountView(db.accountById(actor.account.id));
  }

  // The meeting id is the capability (96 random bits, only its owner has it until they share
  // the link), so answering the chair's one question needs the id, not a key. A key that is
  // given must belong to the owner.
  function clarify(key, id, answersIn) {
    const actor = key ? requireActor(key) : null;
    const row = db.meeting(String(id));
    if (!row) throw new HttpError(404, 'no meeting with that id');
    if (actor && !actor.admin && row.account_id !== actor.account.id) throw new HttpError(403, 'this meeting belongs to another account');
    if (row.status !== 'needs_clarification') throw new HttpError(409, `this meeting is ${row.status}, not waiting for answers`);
    const answers = String(answersIn ?? '').trim().slice(0, 3000);
    if (!db.transition(row.id, 'needs_clarification', 'queued', { answers, clarified: 1 })) throw new HttpError(409, 'already answered');
    kick();
    return meetingView(db.meeting(row.id));
  }

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
      };
      db.transition(id, 'checking', 'running', { brief_json: JSON.stringify(brief), progress: JSON.stringify({ stage: 'round1', done: 0, of: 5 }) });
      const meeting = await runMeeting(model, brief, {
        log: mlog,
        onProgress: (stage, detail) => db.updateMeeting(id, { progress: JSON.stringify({ stage, ...detail }) }),
      });
      db.transition(id, 'running', 'done', { meeting_json: JSON.stringify(meeting), finished_at: Date.now(), progress: JSON.stringify({ stage: 'done' }) });
      mlog('done');
      const acct = row.account_id ? db.accountById(row.account_id) : null;
      if (acct && mailer) mailer({ to: acct.email, ...meetingDoneEmail(meeting, urlFor(id)) }).catch((e) => mlog(`done email failed: ${e.message}`));
    } catch (e) {
      const msg = e?.code === 'bad_json'
        ? `The c0mpute model did not return usable JSON after one retry (${e.message}). Nothing was made up; your meeting was refunded.`
        : `c0mpute could not finish this meeting: ${e?.message ?? e}. Nothing was made up; your meeting was refunded.`;
      const cur = db.meeting(id);
      db.updateMeeting(id, { status: 'failed', error: msg, finished_at: Date.now() });
      if (cur.account_id && cur.paid_with && cur.paid_with !== 'admin') db.refund(cur.account_id, cur.paid_with === 'free' ? 'free' : 'credit');
      mlog(`failed: ${e?.message ?? e}${e?.raw ? ` raw=${JSON.stringify(e.raw.slice(0, 300))}` : ''}`);
    }
  }

  /** On boot, meetings a restart interrupted start over. */
  function resume() {
    for (const s of ['checking', 'running']) for (const r of db.meetingsInStatus(s)) db.transition(r.id, s, 'queued');
    kick();
  }

  return { actorFor, startLogin, verifyLogin, createMeeting, getMeeting, listMeetings, account, clarify, coinpayWebhook, resume, kick, meetingView, urlFor };
}

// SQLite through node:sqlite (Node 22.5+): accounts, login codes, meetings, payments.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newId = (bytes = 12) => randomBytes(bytes).toString('base64url');
export const newApiKey = () => `bsk_${randomBytes(24).toString('base64url')}`;

const SCHEMA = `
create table if not exists accounts (
  id text primary key,
  email text not null unique,
  key_hash text,
  free_used integer not null default 0,
  credits integer not null default 0,
  created_at integer not null
);
create table if not exists login_codes (
  email text primary key,
  code_hash text not null,
  expires_at integer not null,
  tries integer not null default 0,
  sent_at integer not null
);
create table if not exists meetings (
  id text primary key,
  account_id text,
  status text not null,
  brief_text text not null,
  brief_json text,
  answers text,
  clarified integer not null default 0,
  paid_with text,
  progress text,
  error text,
  meeting_json text,
  checkout_id text,
  checkout_url text,
  created_at integer not null,
  updated_at integer not null,
  finished_at integer
);
create index if not exists meetings_account on meetings(account_id, created_at);
create index if not exists meetings_status on meetings(status);
create table if not exists recordings (
  meeting_id text primary key,
  account_id text,
  wrapped_key text,
  mime text not null,
  bytes integer not null,
  cipher_bytes integer not null,
  seconds integer,
  path text,
  c0mpute_ref text,
  created_at integer not null,
  deleted_at integer
);
create table if not exists shares (
  id text primary key,
  token text not null unique,
  meeting_id text not null,
  account_id text,
  include_recording integer not null default 0,
  allow_download integer not null default 0,
  expires_at integer,
  revoked_at integer,
  created_at integer not null,
  last_used_at integer
);
create index if not exists shares_meeting on shares(meeting_id);
create table if not exists payments (
  event_id text primary key,
  meeting_id text,
  checkout_id text,
  amount_usd real,
  raw text,
  created_at integer not null
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Added after launch: company data (financials, metrics) the board reads with the brief.
  const cols = db.prepare('pragma table_info(meetings)').all().map((c) => c.name);
  if (!cols.includes('context_text')) db.exec('alter table meetings add column context_text');
  // Voice meetings on PairUX, recordings, private-by-default reports (0.3.0).
  const addCol = (table, have, name, ddl) => {
    if (!have.includes(name)) db.exec(`alter table ${table} add column ${name} ${ddl}`);
  };
  addCol('meetings', cols, 'voice', 'integer not null default 0');
  addCol('meetings', cols, 'record', 'integer not null default 0');
  // Reports made before 0.3.0 stay public by link (0); every new meeting is private (1).
  addCol('meetings', cols, 'private', 'integer not null default 0');
  addCol('meetings', cols, 'voice_json', 'text');
  addCol('meetings', cols, 'start_now', 'integer not null default 0');
  addCol('meetings', cols, 'transcript_json', 'text');
  const acols = db.prepare('pragma table_info(accounts)').all().map((c) => c.name);
  addCol('accounts', acols, 'voice_trial_started_at', 'integer');
  addCol('accounts', acols, 'voice_paid_until', 'integer');
  return wrap(db);
}

function wrap(db) {
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const now = () => Date.now();

  return {
    raw: db,
    accountByEmail: (email) => get('select * from accounts where email = ?', email),
    accountById: (id) => get('select * from accounts where id = ?', id),
    accountByKey: (key) => (key ? get('select * from accounts where key_hash = ?', sha256(key)) : undefined),
    ensureAccount(email) {
      const found = get('select * from accounts where email = ?', email);
      if (found) return found;
      const id = newId(9);
      run('insert into accounts (id, email, created_at) values (?, ?, ?)', id, email, now());
      return get('select * from accounts where id = ?', id);
    },
    /** A fresh API key for the account; the old one stops working. Returns the plaintext once. */
    rotateKey(accountId) {
      const key = newApiKey();
      run('update accounts set key_hash = ? where id = ?', sha256(key), accountId);
      return key;
    },

    /** Store a 6-digit code for 15 minutes. Returns the code, or null when one was sent under 60 s ago. */
    newLoginCode(email) {
      const prev = get('select * from login_codes where email = ?', email);
      if (prev && now() - prev.sent_at < 60_000) return null;
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      run(
        'insert into login_codes (email, code_hash, expires_at, tries, sent_at) values (?, ?, ?, 0, ?) on conflict(email) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0, sent_at = excluded.sent_at',
        email,
        sha256(`${email}:${code}`),
        now() + 15 * 60_000,
        now(),
      );
      return code;
    },
    checkLoginCode(email, code) {
      const review = String(process.env.BOARD_SAAS_REVIEW_LOGIN ?? '');
      const i = review.indexOf(':');
      if (i > 0 && review.length - i > 16 && email === review.slice(0, i).toLowerCase() && sha256(String(code).trim()) === sha256(review.slice(i + 1))) return true;
      const row = get('select * from login_codes where email = ?', email);
      if (!row || row.expires_at < now() || row.tries >= 5) return false;
      if (row.code_hash !== sha256(`${email}:${String(code).trim()}`)) {
        run('update login_codes set tries = tries + 1 where email = ?', email);
        return false;
      }
      run('delete from login_codes where email = ?', email);
      return true;
    },

    /**
     * Spend what the account has for one meeting: the free meeting first, then a paid credit.
     * Returns 'free' | 'credit' | null. Atomic per statement, so two racing requests cannot both win.
     */
    spend(accountId) {
      if (run('update accounts set free_used = 1 where id = ? and free_used = 0', accountId).changes) return 'free';
      if (run('update accounts set credits = credits - 1 where id = ? and credits > 0', accountId).changes) return 'credit';
      return null;
    },
    /** Give back what a failed meeting spent. */
    refund(accountId, paidWith) {
      if (paidWith === 'free') run('update accounts set free_used = 0 where id = ?', accountId);
      else if (paidWith === 'credit' || paidWith === 'coinpay') run('update accounts set credits = credits + 1 where id = ?', accountId);
    },

    createMeeting({ accountId, briefText, contextText = null, status, paidWith = null, voice = false, record = false, isPrivate = true }) {
      const id = newId(12);
      const t = now();
      run(
        'insert into meetings (id, account_id, status, brief_text, context_text, paid_with, voice, record, private, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        accountId,
        status,
        briefText,
        contextText,
        paidWith,
        voice ? 1 : 0,
        record ? 1 : 0,
        isPrivate ? 1 : 0,
        t,
        t,
      );
      return get('select * from meetings where id = ?', id);
    },
    meeting: (id) => get('select * from meetings where id = ?', id),
    meetingByCheckout: (cid) => get('select * from meetings where checkout_id = ?', cid),
    meetingsFor: (accountId, limit = 50) =>
      all('select id, status, brief_text, created_at, finished_at, meeting_json is not null as has_report from meetings where account_id = ? order by created_at desc limit ?', accountId, limit),
    updateMeeting(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      run(`update meetings set ${sets}, updated_at = ? where id = ?`, ...keys.map((k) => fields[k]), now(), id);
    },
    /** Move a meeting from one status to another only if it is still in the first (claims work). */
    transition(id, from, to, extra = {}) {
      const keys = Object.keys(extra);
      const sets = [`status = ?`, ...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
      return run(`update meetings set ${sets} where id = ? and status = ?`, to, ...keys.map((k) => extra[k]), now(), id, from).changes > 0;
    },
    meetingsInStatus: (status) => all('select * from meetings where status = ? order by created_at', status),

    recordPayment({ eventId, meetingId, checkoutId, amountUsd, raw }) {
      return run(
        'insert or ignore into payments (event_id, meeting_id, checkout_id, amount_usd, raw, created_at) values (?, ?, ?, ?, ?, ?)',
        eventId,
        meetingId,
        checkoutId,
        amountUsd,
        raw,
        now(),
      ).changes > 0;
    },
    /** Start the 90-day voice trial on first use. Returns the (possibly new) start time. */
    startVoiceTrial(accountId) {
      run('update accounts set voice_trial_started_at = ? where id = ? and voice_trial_started_at is null', now(), accountId);
      return get('select voice_trial_started_at from accounts where id = ?', accountId)?.voice_trial_started_at ?? null;
    },
    /** Add `days` of paid voice from the later of now and the current end. */
    extendVoice(accountId, days) {
      const a = get('select voice_paid_until from accounts where id = ?', accountId);
      const from = Math.max(now(), a?.voice_paid_until ?? 0);
      run('update accounts set voice_paid_until = ? where id = ?', from + days * 86_400_000, accountId);
    },

    saveRecording(r) {
      run(
        'insert or replace into recordings (meeting_id, account_id, wrapped_key, mime, bytes, cipher_bytes, seconds, path, c0mpute_ref, created_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)',
        r.meetingId,
        r.accountId,
        r.wrappedKey,
        r.mime,
        r.bytes,
        r.cipherBytes,
        r.seconds,
        r.path,
        r.c0mputeRef,
        now(),
      );
    },
    recording: (meetingId) => get('select * from recordings where meeting_id = ?', meetingId),
    /** Forget the key: every copy of the ciphertext becomes unreadable. */
    deleteRecording(meetingId) {
      return run('update recordings set wrapped_key = null, path = null, deleted_at = ? where meeting_id = ? and deleted_at is null', now(), meetingId).changes > 0;
    },

    createShare({ meetingId, accountId, includeRecording, allowDownload, expiresAt }) {
      const id = newId(9);
      const token = randomBytes(24).toString('base64url');
      run(
        'insert into shares (id, token, meeting_id, account_id, include_recording, allow_download, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        token,
        meetingId,
        accountId,
        includeRecording ? 1 : 0,
        allowDownload ? 1 : 0,
        expiresAt,
        now(),
      );
      return get('select * from shares where id = ?', id);
    },
    share: (id) => get('select * from shares where id = ?', id),
    /** A live share for a token (not revoked, not expired), or undefined. */
    shareByToken(token) {
      const s = get('select * from shares where token = ?', String(token));
      if (!s || s.revoked_at || (s.expires_at && s.expires_at < now())) return undefined;
      run('update shares set last_used_at = ? where id = ?', now(), s.id);
      return s;
    },
    sharesFor: (meetingId) => all('select * from shares where meeting_id = ? order by created_at desc', meetingId),
    sharesForAccount: (accountId) => all('select * from shares where account_id = ? order by created_at desc limit 200', accountId),
    revokeShare: (id) => run('update shares set revoked_at = ? where id = ? and revoked_at is null', now(), id).changes > 0,

    stats: () => get("select count(*) as meetings, sum(status = 'done') as done, sum(status = 'failed') as failed from meetings"),
  };
}

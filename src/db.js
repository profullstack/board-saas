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

    createMeeting({ accountId, briefText, status, paidWith = null }) {
      const id = newId(12);
      const t = now();
      run(
        'insert into meetings (id, account_id, status, brief_text, paid_with, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
        id,
        accountId,
        status,
        briefText,
        paidWith,
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
    stats: () => get("select count(*) as meetings, sum(status = 'done') as done, sum(status = 'failed') as failed from meetings"),
  };
}

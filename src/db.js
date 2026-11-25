// SQLite through node:sqlite (Node 22.5+): accounts, login codes, meetings, payments.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newId = (bytes = 12) => randomBytes(bytes).toString('base64url');
/** The email column of an account made by Sign in with CoinPay: undeliverable on purpose (RFC 2606). */
export const coinpayPlaceholderEmail = (id) => `coinpay-${id}@coinpay.invalid`;
export const isPlaceholderEmail = (email) => /@coinpay\.invalid$/i.test(String(email ?? ''));
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
-- Sign in with CoinPay (0.6.0): a local account keeps at most one CoinPay identity (sub); one
-- sub may be linked by its owner to several accounts (the sign-in then asks which one).
create table if not exists coinpay_links (
  account_id text primary key,
  sub text not null,
  linked_at integer not null
);
create index if not exists coinpay_links_sub on coinpay_links(sub);
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
  // Publishing, invites and live listening (0.4.0). visibility is 'private' (default) or 'public';
  // a public meeting is reached by public_id (random, never the internal id). live_json holds the
  // c0mpute Live stream's id and playback URL while a voice meeting runs, never its stream key.
  addCol('meetings', cols, 'visibility', "text not null default 'private'");
  addCol('meetings', cols, 'public_id', 'text');
  addCol('meetings', cols, 'public_recording', 'integer not null default 0');
  addCol('meetings', cols, 'published_at', 'integer');
  addCol('meetings', cols, 'live_json', 'text');
  // How questions asked during the meeting are taken: 'realtime' (default) or 'queued' (0.13.0).
  addCol('meetings', cols, 'qa_mode', 'text');
  db.exec('create unique index if not exists meetings_public_id on meetings(public_id) where public_id is not null');
  db.exec('create index if not exists meetings_visibility on meetings(visibility, created_at)');
  // Share roles: view | listen | join. Rows made before 0.4.0 have no role and are read from
  // include_recording (1 = listen, 0 = view).
  const scols = db.prepare('pragma table_info(shares)').all().map((c) => c.name);
  addCol('shares', scols, 'role', 'text');
  addCol('shares', scols, 'label', 'text');
  // The private c0mpute storage copy of a recording: its c0p1 ref, and its private link
  // encrypted under BOARD_RECORDING_KEK (the link opens the file for anyone who holds it).
  const rcols = db.prepare('pragma table_info(recordings)').all().map((c) => c.name);
  addCol('recordings', rcols, 'archive_ref', 'text');
  addCol('recordings', rcols, 'archive_link', 'text');
  addCol('recordings', rcols, 'archive_note', 'text');
  // The meeting video (captioned, made from the recording and transcript), encrypted the same way.
  addCol('recordings', rcols, 'video_key', 'text');
  addCol('recordings', rcols, 'video_path', 'text');
  addCol('recordings', rcols, 'video_bytes', 'integer');
  // Its c0mpute private storage copy, like the recording's (ref in the clear, link sealed under the KEK).
  addCol('recordings', rcols, 'video_archive_ref', 'text');
  addCol('recordings', rcols, 'video_archive_link', 'text');
  addCol('recordings', rcols, 'video_archive_note', 'text');
  const acols = db.prepare('pragma table_info(accounts)').all().map((c) => c.name);
  addCol('accounts', acols, 'voice_trial_started_at', 'integer');
  addCol('accounts', acols, 'voice_paid_until', 'integer');
  // Voice trial length A/B test (0.4.1): the account's trial length and its arm, set once at its
  // first voice meeting. NULL days = a trial that started before the test: the 90-day control.
  addCol('accounts', acols, 'voice_trial_days', 'integer');
  addCol('accounts', acols, 'voice_trial_arm', 'text');
  // Sign in with CoinPay (0.6.0). signin = 'coinpay' for an account made by a CoinPay sign-in:
  // its email column holds a placeholder (coinpay-<id>@coinpay.invalid), never CoinPay's email,
  // which is unverified. pass_until = Profullstack Pass end (ms), re-read on every CoinPay sign-in.
  addCol('accounts', acols, 'signin', 'text');
  addCol('accounts', acols, 'pass_until', 'integer');
  // Pay as you go on c0mpute: the account's c0mpute OAuth key (scopes inference billing), wrapped
  // under BOARD_RECORDING_KEK, and the c0mpute name it belongs to. A paid meeting is charged to that
  // balance at Anthropic cost + 20%; the meeting row keeps what it cost and what was charged.
  addCol('accounts', acols, 'c0mpute_key', 'text');
  addCol('accounts', acols, 'c0mpute_name', 'text');
  addCol('accounts', acols, 'c0mpute_at', 'integer');
  addCol('meetings', cols, 'cost_usd', 'real');
  addCol('meetings', cols, 'price_usd', 'real');
  addCol('meetings', cols, 'charge_status', 'text');
  addCol('meetings', cols, 'charge_json', 'text');
  // The narrated slide-show video (the deck read by the Chair), encrypted like the recording.
  addCol('meetings', cols, 'slideshow_key', 'text');
  addCol('meetings', cols, 'slideshow_path', 'text');
  addCol('meetings', cols, 'slideshow_bytes', 'integer');
  addCol('meetings', cols, 'slideshow_seconds', 'integer');
  // The 30-second vertical short (0.14.0), encrypted the same way.
  addCol('meetings', cols, 'short_key', 'text');
  addCol('meetings', cols, 'short_path', 'text');
  addCol('meetings', cols, 'short_bytes', 'integer');
  addCol('meetings', cols, 'short_seconds', 'real');
  db.exec(`create table if not exists c0mpute_pending (
    state text primary key,
    account_id text not null,
    verifier text not null,
    created_at integer not null
  )`);
  // Premium (0.9.1): premium_until (ms) = paid or granted Premium (the branded LinkedIn rendition of
  // a voice meeting, and its tighter-trimmed MP3). admin = this account may use /admin (set only by
  // the admin key, by account id; never from an email, least of all CoinPay's unverified one).
  addCol('accounts', acols, 'premium_until', 'integer');
  addCol('accounts', acols, 'admin', 'integer not null default 0');
  db.exec(`create table if not exists admin_audit (
    id integer primary key autoincrement,
    at integer not null,
    actor text not null,
    account_id text,
    action text not null,
    detail text,
    ip text
  )`);
  db.exec('create index if not exists admin_audit_account on admin_audit(account_id, at)');
  // Premium branded renditions: the 1080x1080 MP4 and the trimmed MP3, each encrypted like a
  // recording (its own key, wrapped under BOARD_RECORDING_KEK) next to the recordings. The free
  // captioned video stays on the recordings row (video_key, video_path).
  db.exec(`create table if not exists branded_videos (
    meeting_id text primary key,
    account_id text,
    status text not null,
    requested_by text,
    error text,
    wrapped_key text,
    path text,
    bytes integer,
    cipher_bytes integer,
    seconds real,
    mp3_wrapped_key text,
    mp3_path text,
    mp3_bytes integer,
    mp3_seconds real,
    original_seconds real,
    cuts integer,
    created_at integer not null,
    updated_at integer not null,
    finished_at integer,
    deleted_at integer
  )`);
  return wrap(db);
}

/** Premium "with no expiry": the last millisecond of 9999. */
export const FOREVER = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

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
      // An active Profullstack Pass covers the meeting and keeps the free meeting and credits.
      if (get('select 1 as ok from accounts where id = ? and pass_until > ?', accountId, now())) return 'pass';
      if (run('update accounts set free_used = 1 where id = ? and free_used = 0', accountId).changes) return 'free';
      if (run('update accounts set credits = credits - 1 where id = ? and credits > 0', accountId).changes) return 'credit';
      return null;
    },
    /** Give back what a failed meeting spent. */
    refund(accountId, paidWith) {
      if (paidWith === 'free') run('update accounts set free_used = 0 where id = ?', accountId);
      else if (paidWith === 'credit' || paidWith === 'coinpay') run('update accounts set credits = credits + 1 where id = ?', accountId);
    },

    createMeeting({ accountId, briefText, contextText = null, status, paidWith = null, voice = false, record = false, isPrivate = true, qaMode = 'realtime' }) {
      const id = newId(12);
      const t = now();
      run(
        'insert into meetings (id, account_id, status, brief_text, context_text, paid_with, voice, record, private, qa_mode, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        accountId,
        status,
        briefText,
        contextText,
        paidWith,
        voice ? 1 : 0,
        record ? 1 : 0,
        isPrivate ? 1 : 0,
        qaMode,
        t,
        t,
      );
      return get('select * from meetings where id = ?', id);
    },
    meeting: (id) => get('select * from meetings where id = ?', id),
    meetingByCheckout: (cid) => get('select * from meetings where checkout_id = ?', cid),
    meetingsFor: (accountId, limit = 50) =>
      all('select id, status, brief_text, created_at, finished_at, visibility, public_id, meeting_json is not null as has_report from meetings where account_id = ? order by created_at desc limit ?', accountId, limit),
    saveSlideshow(meetingId, { wrappedKey, path, bytes, seconds }) {
      run('update meetings set slideshow_key = ?, slideshow_path = ?, slideshow_bytes = ?, slideshow_seconds = ? where id = ?', wrappedKey, path, bytes, seconds, meetingId);
    },
    saveShort(meetingId, { wrappedKey, path, bytes, seconds }) {
      run('update meetings set short_key = ?, short_path = ?, short_bytes = ?, short_seconds = ? where id = ?', wrappedKey, path, bytes, seconds, meetingId);
    },
    clearShort: (meetingId) => run('update meetings set short_key = null, short_path = null, short_bytes = null, short_seconds = null where id = ?', meetingId),
    /** Finished meetings with no short yet, newest first. */
    meetingsWithoutShort(limit = 50) {
      return db.prepare("select id from meetings where status = 'done' and meeting_json is not null and short_path is null order by finished_at desc limit ?").all(limit).map((x) => x.id);
    },
    /** Finished meetings with no slide show yet, newest first. */
    meetingsWithoutSlideshow(limit = 50) {
      return db.prepare("select id from meetings where status = 'done' and meeting_json is not null and slideshow_path is null order by finished_at desc limit ?").all(limit).map((x) => x.id);
    },
    setC0mpute(accountId, { key = null, name = null } = {}) {
      run('update accounts set c0mpute_key = ?, c0mpute_name = ?, c0mpute_at = ? where id = ?', key, name, key ? now() : null, accountId);
    },
    /** One pending c0mpute sign-in, for ten minutes. */
    addC0mputePending(state, accountId, verifier) {
      run('delete from c0mpute_pending where created_at < ?', now() - 10 * 60_000);
      run('insert into c0mpute_pending (state, account_id, verifier, created_at) values (?, ?, ?, ?)', state, accountId, verifier, now());
    },
    /** Take a pending sign-in by its state, once. */
    takeC0mputePending(state) {
      const row = get('select * from c0mpute_pending where state = ? and created_at >= ?', state, now() - 10 * 60_000);
      run('delete from c0mpute_pending where state = ?', state);
      return row ?? null;
    },
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
    meetingByPublicId: (pid) => get("select * from meetings where public_id = ? and visibility = 'public'", String(pid)),
    /** Publish or unpublish. The public id is made once and kept, so a republished meeting keeps its link. */
    setVisibility(id, visibility, includeRecording) {
      const cur = get('select public_id from meetings where id = ?', id);
      const pid = cur?.public_id ?? (visibility === 'public' ? randomBytes(18).toString('base64url') : null);
      run('update meetings set visibility = ?, public_id = ?, public_recording = ?, published_at = case when ? = \'public\' then coalesce(published_at, ?) else published_at end, updated_at = ? where id = ?', visibility, pid, includeRecording ? 1 : 0, visibility, now(), now(), id);
      return get('select * from meetings where id = ?', id);
    },
    publicMeetings: (limit = 200) =>
      all("select id, public_id, status, brief_json, meeting_json, voice, live_json, created_at, finished_at from meetings where visibility = 'public' and public_id is not null and status != 'failed' order by created_at desc limit ?", limit),
    meetingRowsFor: (accountId, limit = 200) => all('select * from meetings where account_id = ? order by created_at desc limit ?', accountId, limit),
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
    /**
     * Start the voice trial on first use, with its length and A/B arm. A trial that already
     * started keeps its length. Returns { started_at, days, arm, fresh }.
     */
    startVoiceTrial(accountId, { days = null, arm = null } = {}) {
      const fresh = run('update accounts set voice_trial_started_at = ?, voice_trial_days = ?, voice_trial_arm = ? where id = ? and voice_trial_started_at is null', now(), days, arm, accountId).changes > 0;
      const a = get('select voice_trial_started_at, voice_trial_days, voice_trial_arm from accounts where id = ?', accountId);
      return { started_at: a?.voice_trial_started_at ?? null, days: a?.voice_trial_days ?? null, arm: a?.voice_trial_arm ?? null, fresh };
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
    /** The private c0mpute copy: ref in the clear (it opens nothing), link encrypted under the KEK. */
    setRecordingArchive(meetingId, { ref = null, link = null, note = null }) {
      run('update recordings set archive_ref = ?, archive_link = ?, archive_note = ? where meeting_id = ? and deleted_at is null', ref, link, note, meetingId);
    },
    recording: (meetingId) => get('select * from recordings where meeting_id = ?', meetingId),
    /** Forget the key: every copy of the ciphertext becomes unreadable. */
    setVideoArchive(meetingId, { ref = null, link = null, note = null }) {
      run('update recordings set video_archive_ref = ?, video_archive_link = ?, video_archive_note = ? where meeting_id = ?', ref, link, note, meetingId);
    },
    /** Live recordings and videos with no c0mpute copy yet: [{ meeting_id, audio, video }]. */
    mediaWithoutArchive(limit = 50) {
      return db
        .prepare(
          "select meeting_id, (archive_ref is null and archive_note is null) as audio, (video_path is not null and video_archive_ref is null and video_archive_note is null) as video from recordings where deleted_at is null and wrapped_key is not null and ((archive_ref is null and archive_note is null) or (video_path is not null and video_archive_ref is null and video_archive_note is null)) order by created_at limit ?",
        )
        .all(limit);
    },
    saveVideo(meetingId, { wrappedKey, path, bytes }) {
      run('update recordings set video_key = ?, video_path = ?, video_bytes = ? where meeting_id = ? and deleted_at is null', wrappedKey, path, bytes, meetingId);
    },
    /** Recorded, finished meetings whose video has not been made yet (oldest first). */
    recordingsWithoutVideo(limit = 50) {
      return db
        .prepare("select r.meeting_id from recordings r join meetings m on m.id = r.meeting_id where r.deleted_at is null and r.wrapped_key is not null and r.video_path is null and m.status = 'done' and m.transcript_json is not null order by r.created_at limit ?")
        .all(limit)
        .map((x) => x.meeting_id);
    },
    deleteRecording(meetingId) {
      return run('update recordings set wrapped_key = null, path = null, archive_link = null, video_key = null, video_path = null, video_archive_link = null, deleted_at = ? where meeting_id = ? and deleted_at is null', now(), meetingId).changes > 0;
    },

    createShare({ meetingId, accountId, role = null, label = null, includeRecording, allowDownload, expiresAt }) {
      const id = newId(9);
      const token = randomBytes(24).toString('base64url');
      run(
        'insert into shares (id, token, meeting_id, account_id, role, label, include_recording, allow_download, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        token,
        meetingId,
        accountId,
        role,
        label,
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

    /** A new account for a CoinPay identity: placeholder email, nothing taken from CoinPay. */
    createCoinPayAccount(sub) {
      const id = newId(9);
      const t = now();
      run("insert into accounts (id, email, signin, created_at) values (?, ?, 'coinpay', ?)", id, coinpayPlaceholderEmail(id), t);
      run('insert into coinpay_links (account_id, sub, linked_at) values (?, ?, ?)', id, String(sub), t);
      return get('select * from accounts where id = ?', id);
    },
    coinpayAccountsFor: (sub) => all('select account_id from coinpay_links where sub = ? order by linked_at', String(sub)).map((r) => r.account_id),
    coinpayLinkOf: (accountId) => get('select * from coinpay_links where account_id = ?', accountId),
    /** Link a CoinPay identity to an account that has none (insert only: never replaces another sub). */
    linkCoinPay: (accountId, sub) => run('insert into coinpay_links (account_id, sub, linked_at) values (?, ?, ?) on conflict(account_id) do nothing', accountId, String(sub), now()).changes > 0,
    unlinkCoinPay: (accountId) => run('delete from coinpay_links where account_id = ?', accountId).changes > 0,
    /** Profullstack Pass: paid access until `until` (ms), or none (null). */
    setPass: (accountId, until) => run('update accounts set pass_until = ? where id = ?', until ?? null, accountId),

    // ------------------------------------------------------------ premium + admin
    /** Add `days` of premium from the later of now and the current end (a forever grant stays forever). */
    extendPremium(accountId, days) {
      const a = get('select premium_until from accounts where id = ?', accountId);
      const from = Math.max(now(), a?.premium_until ?? 0);
      run('update accounts set premium_until = ? where id = ?', Math.min(FOREVER, from + days * 86_400_000), accountId);
      return get('select premium_until from accounts where id = ?', accountId)?.premium_until ?? null;
    },
    setPremium: (accountId, until) => run('update accounts set premium_until = ? where id = ?', until ?? null, accountId),
    /** Add (or take away) meeting credits; never below zero. Returns the new count. */
    addCredits(accountId, delta) {
      run('update accounts set credits = max(0, credits + ?) where id = ?', Math.trunc(delta), accountId);
      return get('select credits from accounts where id = ?', accountId)?.credits ?? null;
    },
    setAdmin: (accountId, on) => run('update accounts set admin = ? where id = ?', on ? 1 : 0, accountId),
    audit({ actor, accountId = null, action, detail = null, ip = null }) {
      run('insert into admin_audit (at, actor, account_id, action, detail, ip) values (?, ?, ?, ?, ?, ?)', now(), String(actor), accountId, String(action), detail == null ? null : JSON.stringify(detail), ip);
    },
    auditFor: (accountId, limit = 50) => all('select * from admin_audit where account_id = ? order by id desc limit ?', accountId, limit),
    auditRecent: (limit = 50) => all('select * from admin_audit order by id desc limit ?', limit),
    meetingCountFor: (accountId) => get('select count(*) as n from meetings where account_id = ?', accountId)?.n ?? 0,

    // ------------------------------------------------------------ premium branded renditions
    branded: (meetingId) => get('select * from branded_videos where meeting_id = ?', meetingId),
    brandedInStatus: (...statuses) => all(`select * from branded_videos where status in (${statuses.map(() => '?').join(',')}) order by updated_at`, ...statuses),
    /** Recorded, finished voice meetings that have no branded rendition yet (oldest first). */
    recordedWithoutBranded: (limit = 200) =>
      all("select m.id, m.account_id from meetings m join recordings r on r.meeting_id = m.id left join branded_videos b on b.meeting_id = m.id where m.voice = 1 and m.status = 'done' and m.transcript_json is not null and r.deleted_at is null and r.wrapped_key is not null and b.meeting_id is null order by m.created_at limit ?", limit),
    /** Queue a rendition (a new row, or a failed/done one asked for again). */
    queueBranded(meetingId, accountId, requestedBy) {
      run(
        "insert into branded_videos (meeting_id, account_id, status, requested_by, created_at, updated_at) values (?, ?, 'queued', ?, ?, ?) on conflict(meeting_id) do update set status = 'queued', requested_by = excluded.requested_by, error = null, updated_at = excluded.updated_at",
        meetingId,
        accountId,
        requestedBy,
        now(),
        now(),
      );
      return get('select * from branded_videos where meeting_id = ?', meetingId);
    },
    updateBranded(meetingId, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      run(`update branded_videos set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where meeting_id = ?`, ...keys.map((k) => fields[k]), now(), meetingId);
    },
    /** Forget the rendition's keys (with the recording): both files become unreadable. */
    deleteBranded: (meetingId) => run("update branded_videos set status = 'deleted', wrapped_key = null, mp3_wrapped_key = null, path = null, mp3_path = null, deleted_at = ?, updated_at = ? where meeting_id = ?", now(), now(), meetingId).changes > 0,

    stats: () => get("select count(*) as meetings, sum(status = 'done') as done, sum(status = 'failed') as failed from meetings"),
  };
}

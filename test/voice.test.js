import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { signWebhook } from '@profullstack/coinpay-onboard';
import { openDb } from '../src/db.js';
import { encryptRecording, Mixer, openEncrypted, unwrapKey, wrapKey } from '../src/recording.js';
import { createApp } from '../src/server.js';
import { createVoiceTrialExperiment, VOICE_TRIAL_ARMS, VOICE_TRIAL_EXPERIMENT } from '../src/abtest.js';
import { assignArm } from '@profullstack/abtest';
import { clip, decodeWav, encodeWav, levelPcm, sentences } from '../src/speech.js';
import { createVad, routeByKeywords, runVoiceMeeting } from '../src/voice.js';

import { fakeModel, fakePairux, fakeRtc, fakeSpeech, fixture } from './fakes.js';

const DAY = 86_400_000;


// ---------------------------------------------------------------- pure parts

test('speech helpers: WAV round trip, levelling, sentences, clip', () => {
  const pcm = new Int16Array(24000).map((_, i) => Math.round(Math.sin(i / 10) * 1000));
  const back = decodeWav(encodeWav(pcm));
  assert.equal(back.sampleRate, 24000);
  assert.deepEqual([...back.pcm.slice(0, 50)], [...pcm.slice(0, 50)]);
  const louder = levelPcm(pcm);
  assert.ok(Math.max(...louder) > Math.max(...pcm));
  assert.deepEqual(sentences('Hi. This is a longer sentence that stands alone. And another one here, also long enough.'), ['Hi. This is a longer sentence that stands alone.', 'And another one here, also long enough.']);
  const c = clip('one two three. four five six seven eight nine ten', 6);
  assert.equal(c, 'one two three. four five six.');
  assert.ok(clip('see https://example.com now', 10).indexOf('http') === -1);
});

test('routing and the utterance detector', () => {
  assert.equal(routeByKeywords('What does this cost us in cash?'), 'cfo');
  assert.equal(routeByKeywords('How do we get more customers?'), 'growth');
  assert.equal(routeByKeywords('What do all of you think?'), 'all');
  const got = [];
  const vad = createVad({ threshold: 500, onUtterance: (p) => got.push(p.length) });
  const loud = new Int16Array(480).fill(3000);
  const quiet = new Int16Array(480);
  for (let i = 0; i < 50; i++) vad(loud); // 1 s of voice
  for (let i = 0; i < 60; i++) vad(quiet); // 1.2 s of quiet
  assert.equal(got.length, 1);
  for (let i = 0; i < 5; i++) vad(loud); // 0.1 s blip: too short
  for (let i = 0; i < 60; i++) vad(quiet);
  assert.equal(got.length, 1);
});

test('recording crypto: chunked AES-GCM, random access, tamper and wrong key refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-'));
  const plain = randomBytes(200_000);
  const { key, data } = encryptRecording('m1', plain);
  assert.ok(!data.includes(plain.subarray(1000, 1064)), 'ciphertext must not contain the plaintext');
  const path = join(dir, 'm1.bsr');
  writeFileSync(path, data);
  const r = openEncrypted(path, 'm1', key);
  assert.equal(r.length, plain.length);
  assert.deepEqual(r.read(0, 99), plain.subarray(0, 100));
  assert.deepEqual(r.read(65_530, 131_100), plain.subarray(65_530, 131_101));
  assert.deepEqual(r.read(199_990, 199_999), plain.subarray(199_990));
  r.close();
  assert.throws(() => openEncrypted(path, 'other-id', key).read(0, 10)); // AAD binds the id
  const bad = Buffer.from(data);
  bad[100] ^= 1;
  writeFileSync(path, bad);
  assert.throws(() => openEncrypted(path, 'm1', key).read(0, 10));
  const kek = randomBytes(32);
  const wrapped = wrapKey(kek, 'm1', key);
  assert.deepEqual(unwrapKey(kek, 'm1', wrapped), key);
  assert.throws(() => unwrapKey(kek, 'm2', wrapped));
  assert.throws(() => unwrapKey(randomBytes(32), 'm1', wrapped));
});

test('mixer lays clips and streams on one timeline', () => {
  const m = new Mixer(1000, 0);
  m.add(new Int16Array(500).fill(100), 0);
  m.stream('h', new Int16Array(250).fill(50), 250);
  m.stream('h', new Int16Array(250).fill(50), 260); // contiguous, not at 260 ms
  const out = m.render();
  assert.equal(out.length, 750);
  assert.equal(out[100], 100);
  assert.equal(out[300], 150);
  assert.equal(out[600], 50);
});

// ---------------------------------------------------------------- the live call, with fakes

test('voice runner: one speaker at a time, chair calls each member, chat and speech interjections answered', async () => {
  const rtc = fakeRtc({ humanPcm: (() => {
    const p = new Int16Array(24000 * 3);
    p.fill(4000, 0, 24000); // 1 s of speech, then 2 s of quiet
    return p;
  })() });
  const pairux = fakePairux();
  const speech = fakeSpeech();
  const states = [];
  const sink = { clips: 0, frames: 0, add() { this.clips++; }, stream() { this.frames++; } };
  const brief = { decision: 'Who should my next hire be?', options: ['A video editor', 'No hire yet'], constraints: ['$3,000 a month'], text: 'x' };
  const r = await runVoiceMeeting({
    id: 'm1',
    board: { brief, round1: Promise.resolve(fixture.verdicts), round2: Promise.resolve(fixture.debate), minutes: Promise.resolve({ ...fixture, minutes: fixture.minutes }) },
    record: true,
    pairux,
    speech,
    model: fakeModel(),
    rtcModule: rtc,
    liveSink: sink,
    onState: (s) => states.push(s.status),
    waitMs: 2000,
    vadThreshold: 500,
    gapMs: 0,
    finalWaitMs: 300,
  });
  assert.equal(pairux.log.opened.agents.length, 6);
  assert.match(pairux.log.opened.agents[0].name, /recording/);
  assert.deepEqual(states.slice(0, 2), ['waiting', 'live']);
  assert.ok(pairux.log.said.some((m) => /recorded/.test(m)), 'everyone is told the call is recorded');
  // Order: chair intro, then chair + member for each verdict in board order.
  const roles = speech.lines.map((l) => l.role);
  const firstOf = (role) => roles.indexOf(role);
  assert.equal(roles[0], 'chair');
  assert.ok(firstOf('cfo') < firstOf('growth') && firstOf('growth') < firstOf('operator') && firstOf('operator') < firstOf('founder-time') && firstOf('founder-time') < firstOf('contrarian'));
  // The typed question went to the CFO and was answered out loud; the spoken one was transcribed.
  const chat = r.qa.find((q) => q.via === 'chat');
  assert.equal(chat.routed_to, 'cfo');
  assert.match(chat.answers[0].text, /runway/);
  assert.ok(speech.lines.some((l) => l.role === 'cfo' && /runway/.test(l.text)));
  assert.equal(pairux.log.transcribed, 1);
  assert.ok(r.qa.some((q) => q.via === 'voice' && /raise prices/.test(q.question)));
  assert.ok(r.transcript.some((l) => l.source === 'whisper') && r.transcript.some((l) => l.source === 'board'));
  assert.ok(r.recording.pcm.length > 24000);
  // The live broadcast gets what the recorder gets: every spoken clip, and the founder's frames.
  assert.ok(sink.clips >= speech.lines.length && sink.frames > 0, JSON.stringify(sink));
  assert.ok(pairux.log.ended && pairux.log.left.length === 6, 'agents leave and the session ends');
});

// ---------------------------------------------------------------- the service: trial, paywall, recording, sharing

/** A stand-in for the @profullstack/abtest client: always assigns `arm`, records every call. */
function fakeAbClient(arm = '90d') {
  const calls = [];
  const ok = (r = {}) => Promise.resolve({ ok: true, ...r });
  return {
    calls,
    experiment: (d) => (calls.push(['experiment', d.key, d.control]), ok({ created: true })),
    assign: (e, u) => (calls.push(['assign', e, u]), Promise.resolve({ arm, new: true })),
    exposure: (e, u, o) => (calls.push(['exposure', u, o.arm, o.id]), ok()),
    event: (e, u, n, o) => (calls.push(['event', u, n, o.arm, o.id]), ok()),
    conversion: (e, u, o) => (calls.push(['conversion', u, o.arm, o.id]), ok()),
    revenue: (e, u, a, o) => (calls.push(['revenue', u, a, o.arm, o.id]), ok()),
  };
}

async function start({ voice = true, arm = '90d', abClient = undefined, archive = undefined } = {}) {
  const ab = abClient ?? fakeAbClient(arm);
  const pairux = fakePairux();
  const rtc = fakeRtc();
  const kek = randomBytes(32);
  const checkouts = [];
  const coinpay = { createCheckoutSession: async (o) => (checkouts.push(o), { id: `cs_${checkouts.length}`, url: `https://coinpay.test/c/${checkouts.length}` }) };
  const env = { BOARD_SAAS_ADMIN_KEY: 'admin-secret', COINPAY_WEBHOOK_SECRET: 'whsec_test', PUBLIC_URL: 'http://local', BOARD_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), 'bsr-')), BOARD_VOICE_WAIT_SECONDS: '1' };
  const db = openDb(':memory:');
  const app = createApp({
    env,
    db,
    model: fakeModel(),
    mailer: async () => {},
    log: process.env.DEBUG ? console.log : () => {},
    kek,
    coinpay,
    voice: voice ? { pairux, speech: fakeSpeech(), run: (o) => runVoiceMeeting({ ...o, rtcModule: rtc, gapMs: 0, finalWaitMs: 300 }) } : null,
    abtest: createVoiceTrialExperiment({ env, log: () => {}, client: ab }),
    archive,
  });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    let json;
    try {
      json = JSON.parse(buf.toString());
    } catch {
      json = null;
    }
    return { status: res.status, json, buf, headers: res.headers };
  };
  const waitDone = async (id, key) => {
    for (let i = 0; i < 1200; i++) {
      const r = await call('GET', `/api/v1/meetings/${id}`, undefined, key);
      if (!['queued', 'checking', 'running'].includes(r.json.status)) return r.json;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('timeout');
  };
  const account = (email) => {
    const a = db.ensureAccount(email);
    return { id: a.id, key: db.rotateKey(a.id) };
  };
  return { app, db, base, call, waitDone, account, pairux, checkouts, ab, close: () => server.close() };
}

test('voice meeting end to end: trial starts, call held, Q&A in the report, recording private, share and delete', async () => {
  const t = await start();
  try {
    const a = t.account('founder@example.com');
    let r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.voice.plan, 'trial_not_started');
    assert.match(r.json.voice.summary, /free trial \(up to 90 days/);
    assert.equal(r.json.voice.trial_days, null, 'no length is promised before the trial starts');
    assert.equal(r.json.voice.trial_days_left, null);

    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.id;
    r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.voice.plan, 'trial');
    assert.equal(r.json.voice.trial_days, 90);
    assert.equal(r.json.voice.trial_days_left, 90);
    assert.match(r.json.voice.summary, /Voice trial: 90 days left/);
    assert.deepEqual(t.ab.calls.filter((c) => c[0] === 'exposure'), [['exposure', a.id, '90d', `trial-start:${a.id}`]]);

    const done = await t.waitDone(id, a.key);
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.call.status, 'ended');
    assert.equal(done.meeting.qa[0].routed_to, 'cfo');
    assert.equal(done.meeting.voice.held, true);
    assert.equal(done.meeting.voice.recorded, true);
    assert.ok(done.recording.seconds >= 1, JSON.stringify(done.recording));

    // Nobody else gets in.
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}`)).status, 401);
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/recording`)).status, 401);
    const b = t.account('stranger@example.com');
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}`, undefined, b.key)).status, 403);
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/recording`, undefined, b.key)).status, 403);

    // The owner streams it, with seeking.
    r = await t.call('GET', `/api/v1/meetings/${id}/recording`, undefined, a.key);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    const full = r.buf;
    assert.equal(full.length, done.recording.bytes);
    r = await t.call('GET', `/api/v1/meetings/${id}/recording`, undefined, a.key, { range: 'bytes=100-299' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 100-299/${full.length}`);
    assert.deepEqual(r.buf, full.subarray(100, 300));
    // On disk it is ciphertext.
    const disk = readFileSync(t.app.db.recording(id).path);
    assert.equal(disk.subarray(0, 4).toString(), 'BSR1');
    assert.ok(!disk.includes(full.subarray(1000, 1064)));

    // The meeting video is made in the background from the recording and transcript.
    for (let i = 0; i < 100 && !t.app.db.recording(id).video_path; i++) await new Promise((r) => setTimeout(r, 200));
    assert.ok(t.app.db.recording(id).video_path, 'the meeting video was made');
    r = await t.call('GET', `/api/v1/meetings/${id}/video`, undefined, a.key);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.buf.subarray(4, 8).toString(), 'ftyp', 'an MP4');
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/video`, undefined, b.key)).status, 403);
    assert.equal(readFileSync(t.app.db.recording(id).video_path).subarray(0, 4).toString(), 'BSR1', 'the video is encrypted on disk');

    // The owner's report page carries a signed media link and the transcript; the media link works without a header.
    const page = (await t.call('GET', `/api/v1/meetings/${id}/page.html`, undefined, a.key)).buf.toString();
    assert.match(page, /Founder Q&amp;A/);
    assert.match(page, /Transcript/);
    assert.match(page, /<video controls/, 'the owner page shows the meeting video');
    const vmedia = page.match(/src="(http:\/\/local\/media\/[^"]+\.mp4[^"]*)"/)[1].replace(/&amp;/g, '&');
    const vr = await fetch(vmedia.replace('http://local', t.base), { headers: { range: 'bytes=0-15' } });
    assert.equal(vr.status, 206);
    assert.equal(vr.headers.get('content-type'), 'video/mp4');
    // With a video, the MP3 is the Audio download button rather than a second player.
    assert.doesNotMatch(page, /<audio[^>]*src="http:\/\/local\/media\/[^"]+\.mp3/, 'no duplicate audio player under the video');
    const media = page.match(/href="(http:\/\/local\/media\/[^"]+\.mp3[^"]*)"/)[1].replace(/&amp;/g, '&');
    assert.equal((await fetch(media.replace('http://local', t.base))).status, 200);
    assert.equal((await fetch(media.replace('http://local', t.base).replace(/sig=[^&]+/, 'sig=forged'))).status, 403);

    // Share with the recording: plays; revoke: stops.
    r = await t.call('POST', `/api/v1/meetings/${id}/shares`, { include_recording: true, expires: '30d' }, a.key);
    const share = r.json;
    const sharedPage = await fetch(share.url.replace('http://local', t.base)).then((x) => x.text());
    assert.match(sharedPage, /<audio/);
    assert.match(sharedPage, /nodownload/);
    const sharedAudio = await fetch(`${share.url.replace('http://local', t.base)}/recording.mp3`, { headers: { range: 'bytes=0-9' } });
    assert.equal(sharedAudio.status, 206);
    const noDl = await fetch(`${share.url.replace('http://local', t.base)}/recording.mp3?download=1`);
    assert.equal(noDl.headers.get('content-disposition'), 'inline');
    // A report-only share does not open the recording.
    const reportOnly = (await t.call('POST', `/api/v1/meetings/${id}/shares`, {}, a.key)).json;
    assert.equal((await fetch(`${reportOnly.url.replace('http://local', t.base)}/recording.mp3`)).status, 404);
    await t.call('DELETE', `/api/v1/shares/${share.id}`, undefined, a.key);
    assert.equal((await fetch(`${share.url.replace('http://local', t.base)}/recording.mp3`)).status, 404);

    // Delete: the key is gone; nothing plays any more.
    r = await t.call('DELETE', `/api/v1/meetings/${id}/recording`, undefined, a.key);
    assert.equal(r.json.deleted, true);
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/recording`, undefined, a.key)).status, 404);
    assert.equal((await fetch(media.replace('http://local', t.base))).status, 404);
    assert.equal(t.app.db.recording(id).wrapped_key, null);
    assert.equal(t.app.db.recording(id).video_key, null, 'deleting the recording deletes the video too');
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/video`, undefined, a.key)).status, 404);
  } finally {
    t.close();
  }
});

test('voice paywall: after 90 days a voice meeting is refused with 402 voice_trial_ended + checkout; a voice pass reopens it', async () => {
  const t = await start();
  try {
    const a = t.account('late@example.com');
    t.db.raw.prepare('update accounts set voice_trial_started_at = ? where id = ?').run(Date.now() - 91 * DAY, a.id);
    let r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.voice.plan, 'trial_ended');
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    assert.equal(r.status, 402);
    assert.equal(r.json.code, 'voice_trial_ended');
    assert.match(r.json.checkout_url, /coinpay\.test/);
    assert.equal(t.checkouts.at(-1).amount, 19);
    // The text meeting credit was not spent by the refusal.
    r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.free_meeting_available, true);
    // A text meeting still works.
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, a.key);
    assert.equal(r.status, 201);
    // MCP says it plainly, with the link.
    r = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_meeting', arguments: { brief: fixture.brief.text, voice: true } } }, a.key);
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /voice trial has ended[\s\S]*coinpay\.test/);
    // Pay: the webhook adds 30 days of voice.
    const body = JSON.stringify({ id: 'evt_v1', type: 'payment.confirmed', data: { payment_id: 'pv', status: 'confirmed', amount_usd: 19, metadata: { voice_pass_account: a.id } } });
    const res = await fetch(`${t.base}/api/v1/coinpay/webhook`, { method: 'POST', headers: { 'x-coinpay-signature': signWebhook(body, 'whsec_test') }, body });
    assert.equal(res.status, 200);
    r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.voice.plan, 'paid');
    assert.equal(r.json.voice.active, true);
  } finally {
    t.close();
  }
});

test('voice not configured: 503 for voice, text unaffected', async () => {
  const t = await start({ voice: false });
  try {
    const a = t.account('x@example.com');
    let r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    assert.equal(r.status, 503);
    r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.free_meeting_available, true);
    assert.equal(r.json.voice.available, false);
  } finally {
    t.close();
  }
});

test('a call connection that hangs or keeps failing fails the call fast with a clear error, and the session is ended', async () => {
  for (const mode of ['hang', 'reject']) {
    const rtc = fakeRtc();
    rtc.Room = class extends rtc.Room {
      async connect() {
        if (mode === 'hang') return new Promise(() => {});
        throw new Error('track publication timed out, no response received from the server');
      }
    };
    const pairux = fakePairux();
    const states = [];
    const t0 = Date.now();
    await assert.rejects(
      runVoiceMeeting({
        id: 'm-fail',
        board: { brief: { decision: 'x', options: ['a', 'b'], constraints: [], text: 'x' }, round1: new Promise(() => {}), round2: new Promise(() => {}), minutes: new Promise(() => {}) },
        pairux,
        speech: fakeSpeech(),
        model: fakeModel(),
        rtcModule: rtc,
        onState: (s) => states.push(s.status),
        connectTimeoutMs: 200,
      }),
      /could not join the PairUX call after 3 tries/,
    );
    assert.ok(Date.now() - t0 < 10_000, `${mode}: failed in ${Date.now() - t0} ms`);
    assert.ok(pairux.log.ended, `${mode}: the PairUX session is ended`);
    assert.deepEqual(states, ['waiting']);
  }
});

// ---------------------------------------------------------------- the trial length A/B test

test('voice trial A/B: a 30d account sees 30 days, is refused after 30, and its paid pass is a conversion with revenue', async () => {
  const t = await start({ arm: '30d' });
  try {
    const a = t.account('thirty@example.com');
    let r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const first = r.json.id;
    r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.voice.plan, 'trial');
    assert.equal(r.json.voice.trial_days, 30);
    assert.equal(r.json.voice.trial_days_left, 30);
    assert.match(r.json.voice.summary, /Voice trial: 30 days left/);
    assert.ok(!JSON.stringify(r.json.voice).includes('30d'), 'the arm name is not shown to the user');
    const row = t.db.accountById(a.id);
    assert.equal(row.voice_trial_days, 30);
    assert.equal(row.voice_trial_arm, '30d');
    await t.waitDone(first, a.key);

    // A second voice meeting during the trial (paid with a credit): one more engagement event, no second exposure.
    t.db.raw.prepare('update accounts set credits = 1 where id = ?').run(a.id);
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    const second = r.json.id;
    await t.waitDone(second, a.key);
    const calls = t.ab.calls;
    assert.equal(calls.filter((c) => c[0] === 'assign').length, 1, 'assigned once, sticky');
    assert.deepEqual(calls.filter((c) => c[0] === 'exposure'), [['exposure', a.id, '30d', `trial-start:${a.id}`]]);
    assert.deepEqual(calls.filter((c) => c[0] === 'event').map((c) => c[4]), [`voice-meeting:${first}`, `voice-meeting:${second}`]);
    assert.ok(calls.every((c) => c[0] !== 'event' || (c[2] === 'voice_meeting' && c[3] === '30d')));

    // Day 31: refused, and the message names this account's own length.
    t.db.raw.prepare('update accounts set voice_trial_started_at = ? where id = ?').run(Date.now() - 31 * DAY, a.id);
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    assert.equal(r.status, 402);
    assert.match(r.json.error, /30-day voice trial has ended/);

    // Paying is the conversion, with the amount as revenue; a replayed webhook counts once.
    const body = JSON.stringify({ id: 'evt_ab1', type: 'payment.confirmed', data: { payment_id: 'pab', status: 'confirmed', amount_usd: 19, metadata: { voice_pass_account: a.id } } });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${t.base}/api/v1/coinpay/webhook`, { method: 'POST', headers: { 'x-coinpay-signature': signWebhook(body, 'whsec_test') }, body });
      assert.equal(res.status, 200);
    }
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(t.ab.calls.filter((c) => c[0] === 'conversion'), [['conversion', a.id, '30d', 'voice-pass:evt_ab1']]);
    assert.deepEqual(t.ab.calls.filter((c) => c[0] === 'revenue'), [['revenue', a.id, 19, '30d', 'voice-pass-revenue:evt_ab1']]);
    r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.voice.plan, 'paid');
  } finally {
    t.close();
  }
});

test('voice trial A/B: a trial that started before the test keeps 90 days and sends nothing', async () => {
  const t = await start({ arm: '30d' });
  try {
    const a = t.account('early@example.com');
    t.db.raw.prepare('update accounts set voice_trial_started_at = ? where id = ?').run(Date.now() - 40 * DAY, a.id);
    let r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.voice.trial_days, 90);
    assert.equal(r.json.voice.trial_days_left, 50);
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    assert.equal(r.status, 201);
    await t.waitDone(r.json.id, a.key).catch(() => {});
    const body = JSON.stringify({ id: 'evt_ab2', type: 'payment.confirmed', data: { payment_id: 'pab2', status: 'confirmed', amount_usd: 19, metadata: { voice_pass_account: a.id } } });
    await fetch(`${t.base}/api/v1/coinpay/webhook`, { method: 'POST', headers: { 'x-coinpay-signature': signWebhook(body, 'whsec_test') }, body });
    assert.deepEqual(t.ab.calls.filter((c) => c[0] !== 'experiment'), [], 'grandfathered accounts are outside the experiment');
  } finally {
    t.close();
  }
});

test('voice trial A/B: CrawlProof unreachable falls back to the same deterministic arm; off gives everyone 90 days', async () => {
  const down = { experiment: async () => ({ ok: false, error: 'down' }), assign: async () => { throw new Error('should not be called directly'); } };
  // The real client with no token: every call fails open, assign computes the arm locally.
  const { createClient } = await import('@profullstack/abtest');
  const offline = createClient({ token: undefined });
  const exp = createVoiceTrialExperiment({ env: {}, log: () => {}, client: offline });
  const arms = VOICE_TRIAL_ARMS.map((x) => ({ key: x.key }));
  for (const id of ['acct-a', 'acct-b', 'acct-c', 'acct-d']) {
    const r = await exp.assign(id);
    const want = assignArm(VOICE_TRIAL_EXPERIMENT, id, arms);
    assert.equal(r.arm, want);
    assert.equal(r.days, want === '30d' ? 30 : 90);
    assert.equal(r.offline, true);
  }
  const off = createVoiceTrialExperiment({ env: { BOARD_VOICE_TRIAL_EXPERIMENT: 'off' }, log: () => {}, client: down });
  assert.deepEqual(await off.assign('acct-a'), { arm: null, days: 90, offline: false });
});

test('meeting video: copied to c0mpute private storage when that is configured', async () => {
  const puts = [];
  const archive = { configured: true, put: async (buf, { fileName }) => (puts.push({ bytes: buf.length, fileName, mp4: buf.subarray(4, 8).toString() === 'ftyp' }), { ref: `c0p1:ref${puts.length}`, link: `https://gateway.c0mpute.test/p/x${puts.length}/#k=secret` }) };
  const t = await start({ archive });
  try {
    const a = t.account('archived@example.com');
    const r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    const id = r.json.id;
    await t.call('POST', `/api/v1/meetings/${id}/start`, {}, a.key);
    await t.waitDone(id);
    for (let i = 0; i < 100 && !t.app.db.recording(id)?.video_archive_ref; i++) await new Promise((res) => setTimeout(res, 200));
    const rec = t.app.db.recording(id);
    assert.ok(rec.video_archive_ref, 'the video has a c0mpute copy');
    assert.ok(puts.some((p) => p.mp4 && /\.mp4$/.test(p.fileName)), 'an MP4 was uploaded');
    assert.ok(!String(rec.video_archive_link).includes('secret'), 'the private link is stored sealed');
    const page = (await t.call('GET', `/api/v1/meetings/${id}/page.html`, undefined, a.key)).buf.toString();
    assert.match(page, /Video on c0mpute/);
  } finally {
    t.close();
  }
});

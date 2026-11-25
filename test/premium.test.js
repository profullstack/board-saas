// Premium (the branded LinkedIn rendition), /admin (gating, CSRF, audit) and its cut math. The branded
// renderer is a stand-in that writes small files here; the pure parts are tested directly.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { signWebhook } from '@profullstack/coinpay-onboard';
import { FOREVER, openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { assTime, capThreads, brandedAss, chunkText, fitTitle, modelLabel, parseSilences, planCuts, remapTime, speakerColour, speakerLabel, timedLines, trimFilterScript, videoTitle, wrapText } from '../src/video.js';
import { fakeModel, fakePairux, fixture } from './fakes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

// ---------------------------------------------------------------- pure: cuts and remap

test('silencedetect output parses into closed silences', () => {
  const err = `[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 25.051292 | silence_duration: 25.051292
size=N/A time=00:00:30
[silencedetect @ 0x1] silence_start: 27.803333
[silencedetect @ 0x1] silence_end: 30.037167 | silence_duration: 2.233833
[silencedetect @ 0x1] silence_start: 40.5`;
  assert.deepEqual(parseSilences(err), [
    [0, 25.051292],
    [27.803333, 30.037167],
  ]);
});

test('planCuts keeps 0.35 s of every long gap, skips short ones, merges overlaps', () => {
  // 100 s: a 10 s gap at 20..30, a 0.4 s gap (too short to cut), a 2 s gap at 60..62.
  const plan = planCuts(
    [
      [20, 30],
      [40, 40.4],
      [60, 62],
    ],
    100,
  );
  assert.deepEqual(
    plan.cuts.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]),
    [
      [20.175, 29.825],
      [60.175, 61.825],
    ],
  );
  assert.deepEqual(
    plan.keep.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]),
    [
      [0, 20.175],
      [29.825, 60.175],
      [61.825, 100],
    ],
  );
  assert.equal(+plan.removed.toFixed(3), 9.65 + 1.65);
  assert.equal(+plan.duration.toFixed(3), 100 - 11.3);
  // Each kept gap is exactly 0.35 s: the gap 20..30 becomes 20..20.35 after the cut.
  assert.equal(+remapTime(30, plan.cuts).toFixed(3), 20.35);
  // Before the first cut nothing moves; inside a cut a time lands on the join; after, it shifts by everything removed.
  assert.equal(remapTime(10, plan.cuts), 10);
  assert.equal(+remapTime(25, plan.cuts).toFixed(3), 20.175);
  assert.equal(+remapTime(70, plan.cuts).toFixed(3), +(70 - 11.3).toFixed(3));
  assert.equal(+remapTime(100, plan.cuts).toFixed(3), +plan.duration.toFixed(3));
  // A leading silence from 0 keeps its last 0.175 s; nothing is cut past the end.
  const lead = planCuts([[0, 5], [98, 100]], 100);
  assert.deepEqual(lead.cuts.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]), [[0.175, 4.825], [98.175, 99.825]]);
  // No silences: one segment, nothing removed.
  assert.deepEqual(planCuts([], 12), { cuts: [], keep: [[0, 12]], removed: 0, duration: 12 });
});

test('the trim filter cuts explicit segments and concats them (never aselect), with 10 ms fades', () => {
  const f = trimFilterScript([
    [0, 20.175],
    [29.825, 60.175],
  ]);
  assert.doesNotMatch(f, /aselect/);
  assert.match(f, /\[0:a\]atrim=start=0\.000:end=20\.175,asetpts=PTS-STARTPTS,afade=t=in:d=0\.01,afade=t=out:st=20\.165:d=0\.01\[s0\]/);
  assert.match(f, /\[0:a\]atrim=start=29\.825:end=60\.175,.*\[s1\]/);
  assert.match(f, /\[s0\]\[s1\]concat=n=2:v=0:a=1\[out\]$/);
  assert.throws(() => trimFilterScript([]));
});

test('transcript lines move through the cuts and end before the next line', () => {
  const cuts = [[20.175, 29.825]];
  const lines = timedLines(
    [
      { t: '0.0', speaker: 'Chair', text: 'Welcome to the board.' },
      { t: '30.0', speaker: 'The CFO', text: 'x'.repeat(290) },
      { t: 31, speaker: 'The Operator', text: 'Short.' },
      { t: 33, speaker: 'Founder', text: '   ' }, // nothing said: dropped
    ],
    cuts,
    40,
  );
  assert.equal(lines.length, 3);
  assert.equal(lines[0].start, 0);
  assert.equal(lines[0].end, 1.5); // 21 chars / 14.5 is under the 1.5 s floor
  assert.equal(+lines[1].start.toFixed(3), 20.35);
  assert.equal(+lines[1].end.toFixed(3), +(lines[2].start - 0.1).toFixed(3)); // cut short by the next line
  assert.equal(+lines[2].end.toFixed(3), +(lines[2].start + 1.5).toFixed(3));
  assert.ok(lines.every((l) => l.end > l.start));
});

test('subtitle text: chunks, wrap, colours, labels, title fitting and the ASS script', () => {
  assert.deepEqual(chunkText('Welcome. I am the chair of your AI board. The members are AI models, not real directors.'), ['Welcome. I am the chair of your AI board.', 'The members are AI models, not real directors.']);
  assert.ok(chunkText('word '.repeat(60)).every((c) => c.length <= 75));
  assert.deepEqual(wrapText('The members are AI models, not real directors.', 34), ['The members are AI models, not', 'real directors.']);
  assert.deepEqual(wrapText('a'.repeat(40), 34), ['a'.repeat(34), 'a'.repeat(6)]);
  assert.equal(speakerColour('Chair'), '&H00D35B2F');
  assert.equal(speakerColour('The Founder-Time Strategist'), '&H00B98AE8');
  assert.equal(speakerColour('Anthony'), '&H00FFFFFF');
  assert.equal(speakerLabel('The Growth Marketer'), 'GROWTH MARKETER');
  assert.equal(assTime(453.31), '0:07:33.31');
  assert.equal(assTime(3725.5), '1:02:05.50');
  assert.deepEqual(fitTitle('How should b1dz.com make money?'), { lines: ['How should b1dz.com', 'make money?'], size: 66 });
  assert.equal(fitTitle('b1dz Monetization: Pro Tier vs Metered Credits').size, 52);
  const long = fitTitle('word '.repeat(60));
  assert.equal(long.size, 44);
  assert.equal(long.lines.length, 3);
  assert.match(long.lines[2], /…$/);
  assert.equal(videoTitle({ brief: { decision: 'Should we hire a video editor?' }, meeting: { title: 'Hiring' } }), 'Should we hire a video editor?');
  assert.equal(videoTitle({ brief: { decision: 'How should b1dz.com, a free Bloomberg-style trading and research terminal now earning $0, make money' }, meeting: { title: 'b1dz Monetization' } }), 'b1dz Monetization');
  assert.equal(videoTitle({}), 'Board meeting');
  assert.equal(modelLabel('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(modelLabel('qwen2.5'), null);
  const { ass, events } = brandedAss({ title: 'Hire {now}?', meta: '5 AI advisors + a chair', duration: 10, lines: [{ start: 0, end: 4, speaker: 'The CFO', text: 'Keep the cash. Hire in six months when runway allows it.' }] });
  assert.equal(events, 1); // "Keep the cash." is under 30 characters, so it stays with the next sentence
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:10\.00,Kicker,,0,0,0,,AI BOARD MEETING/);
  assert.match(ass, /Title,,0,0,0,,\{\\fs66\}Hire \(now\)\?/); // braces in content never become override tags
  assert.match(ass, /Foot,,0,0,0,,board\.saas\.pit\.world/);
  assert.match(ass, /\{\\c&H0055C3F2&\}CFO\\N\{\\c&H00FFFFFF&\}Keep the cash\./);
});

// ---------------------------------------------------------------- the service

/** A voice call that ends at once with a one-second recording and a transcript. */
const fakeCall = async (o) => {
  const state = { status: 'live', session_id: 'sess-1', join_url: 'https://pairux.com/join/X', join_code: 'X', recorded: o.record };
  o.onState(state);
  return {
    qa: [],
    notes: [],
    humans: [],
    transcript: [{ t: 0, speaker: 'Chair', text: 'Welcome.', source: 'board' }],
    recording: o.record ? { pcm: new Int16Array(24000).fill(800), rate: 24000, seconds: 1 } : null,
    state: { ...state, status: 'ended' },
  };
};

function fakeRenderer() {
  const calls = [];
  const render = async (o) => {
    calls.push(o);
    writeFileSync(join(o.dir, 'video.mp4'), Buffer.concat([Buffer.from('....ftypisom'), randomBytes(150_000)]));
    writeFileSync(join(o.dir, 'trimmed.mp3'), Buffer.concat([Buffer.from('ID3'), randomBytes(5000)]));
    return { mp4: join(o.dir, 'video.mp4'), mp3: join(o.dir, 'trimmed.mp3'), seconds: 0.9, mp3Seconds: 0.9, originalSeconds: 1, cuts: 0 };
  };
  return { calls, render };
}

async function start() {
  const db = openDb(':memory:');
  const renderer = fakeRenderer();
  const logs = [];
  const app = createApp({
    env: { BOARD_SAAS_ADMIN_KEY: 'admin-secret', COINPAY_WEBHOOK_SECRET: 'whsec_test', PUBLIC_URL: 'http://local', BOARD_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), 'bsr-')), BOARD_DATA_DIR: mkdtempSync(join(tmpdir(), 'bsd-')) },
    db,
    model: fakeModel(),
    mailer: async () => {},
    log: (m) => logs.push(m),
    kek: randomBytes(32),
    coinpay: { createCheckoutSession: async (o) => ({ id: 'cs_1', url: `https://coinpay.test/c/${o.metadata.premium_account ? 'premium' : 'other'}` }) },
    voice: { pairux: fakePairux(), speech: { render: async () => new Int16Array(240), close: async () => {} }, run: fakeCall },
    brandedRenderer: renderer.render,
  });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key, headers = {}) => {
    const res = await fetch(base + path.replace('http://local', ''), { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      /* not json */
    }
    return { status: res.status, json, text: buf.toString('utf8'), buf, headers: res.headers };
  };
  const account = (email) => {
    const a = db.ensureAccount(email);
    return { id: a.id, key: db.rotateKey(a.id) };
  };
  const until = async (fn) => {
    for (let i = 0; i < 400; i++) {
      const v = await fn();
      if (v) return v;
      await sleep(15);
    }
    throw new Error('timeout');
  };
  const voiceMeeting = async (key) => {
    const r = await call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, key);
    assert.equal(r.status, 201, r.text);
    return until(async () => {
      const v = (await call('GET', `/api/v1/meetings/${r.json.id}`, undefined, key)).json;
      return v.status === 'done' ? v : null;
    });
  };
  const mcp = async (name, args, key) => (await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key)).json.result;
  return { app, db, call, account, until, voiceMeeting, mcp, renderer, logs, close: () => server.close() };
}

test('a non-premium account keeps its recording but cannot get the branded LinkedIn video (API, MCP, media paths)', async () => {
  const t = await start();
  try {
    const a = t.account('free@example.com');
    const m = await t.voiceMeeting(a.key);
    assert.ok(m.recording && !m.recording.deleted, 'the recording is there for everyone');
    assert.equal(m.branded_video.status, 'none');
    assert.equal(m.branded_video.premium, false);
    await t.app.service.idle();
    assert.equal(t.renderer.calls.length, 0, 'nothing was rendered automatically');
    let r = await t.call('POST', `/api/v1/meetings/${m.id}/branded-video`, {}, a.key);
    assert.equal(r.status, 402);
    assert.equal(r.json.code, 'premium_required');
    assert.equal(r.json.checkout_url, 'https://coinpay.test/c/premium');
    assert.equal(r.json.price_usd, 29);
    assert.equal((await t.call('GET', `/api/v1/meetings/${m.id}/branded.mp4`, undefined, a.key)).status, 404);
    assert.equal((await t.call('POST', `/api/v1/meetings/${m.id}/branded-video/link`, {}, a.key)).status, 404);
    const tool = await t.mcp('make_branded_video', { id: m.id }, a.key);
    assert.equal(tool.isError, true);
    assert.match(tool.content[0].text, /Premium[\s\S]*coinpay\.test\/c\/premium/);
    assert.equal(t.renderer.calls.length, 0);
    // The owner page offers Premium instead of a player.
    const page = await t.call('GET', `/api/v1/meetings/${m.id}/page.html`, undefined, a.key);
    assert.match(page.text, /data-branded="premium"/);
    assert.doesNotMatch(page.text, /\/media\/branded\//);
    // Account view tells the price.
    r = await t.call('GET', '/api/v1/account', undefined, a.key);
    assert.equal(r.json.premium.active, false);
    assert.equal(r.json.premium.plan, 'none');
    assert.match(r.json.premium.summary, /\$29 per 30 days/);
  } finally {
    t.close();
  }
});

test('premium: granted on /admin, the branded video is made, stored encrypted and served with Range to owner and listen shares only', async () => {
  const t = await start();
  try {
    const a = t.account('premium@example.com');
    const stranger = t.account('stranger@example.com');
    const m = await t.voiceMeeting(a.key);
    let r = await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'premium', days: 30, note: 'test grant' }, 'admin-secret');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.premium.active, true);
    r = await t.call('POST', `/api/v1/meetings/${m.id}/branded-video`, {}, a.key);
    assert.equal(r.status, 202);
    assert.ok(['queued', 'rendering', 'done'].includes(r.json.status));
    await t.app.service.idle();
    assert.equal(t.renderer.calls.length, 1);
    const call0 = t.renderer.calls[0];
    assert.equal(call0.title, 'Next hire'); // the brief's decision (short enough)
    assert.match(call0.meta, /^5 AI advisors \+ a chair/);
    assert.equal(call0.transcript[0].text, 'Welcome.');
    const v = (await t.call('GET', `/api/v1/meetings/${m.id}`, undefined, a.key)).json.branded_video;
    assert.equal(v.status, 'done');
    assert.equal(v.video_url, `http://local/api/v1/meetings/${m.id}/branded.mp4`);
    assert.equal(v.trimmed_mp3_url, `http://local/api/v1/meetings/${m.id}/trimmed.mp3`);
    // Encrypted at rest: the file on disk is not the MP4.
    const row = t.db.branded(m.id);
    const { readFileSync } = await import('node:fs');
    assert.ok(!readFileSync(row.path).includes(Buffer.from('ftypisom')));
    // Owner: whole file, then a range.
    r = await t.call('GET', `/api/v1/meetings/${m.id}/branded.mp4`, undefined, a.key);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.buf.length, row.bytes);
    assert.equal(r.buf.subarray(4, 12).toString(), 'ftypisom');
    r = await t.call('GET', `/api/v1/meetings/${m.id}/branded.mp4`, undefined, a.key, { range: 'bytes=70000-70099' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 70000-70099/${row.bytes}`);
    assert.equal(r.buf.length, 100);
    r = await t.call('GET', `/api/v1/meetings/${m.id}/trimmed.mp3`, undefined, a.key);
    assert.equal(r.status, 200);
    assert.equal(r.buf.subarray(0, 3).toString(), 'ID3');
    // Not the owner: refused.
    assert.equal((await t.call('GET', `/api/v1/meetings/${m.id}/branded.mp4`, undefined, stranger.key)).status, 403);
    assert.equal((await t.call('GET', `/api/v1/meetings/${m.id}/branded.mp4`)).status, 401);
    // Signed media link (for the <video> element), and a forged one.
    const link = (await t.call('POST', `/api/v1/meetings/${m.id}/branded-video/link`, {}, a.key)).json.url;
    assert.match(link, /\/media\/branded\/[\w-]+\.mp4\?exp=\d+&sig=/);
    assert.equal((await t.call('GET', link)).status, 200);
    assert.equal((await t.call('GET', link.replace(/sig=.*/, 'sig=AAAA'))).status, 403);
    assert.equal((await t.call('GET', link.replace('/media/branded/', '/media/trimmed/').replace('.mp4', '.mp3'))).status, 403, 'a branded-video signature does not open the MP3');
    // The owner page plays it.
    const page = await t.call('GET', `/api/v1/meetings/${m.id}/page.html`, undefined, a.key);
    assert.match(page.text, /<video controls[^>]+src="http:\/\/local\/media\/branded\//);
    // Shares: listen plays the video, view does not.
    const listen = (await t.call('POST', `/api/v1/meetings/${m.id}/shares`, { role: 'listen' }, a.key)).json;
    const view = (await t.call('POST', `/api/v1/meetings/${m.id}/shares`, { role: 'view' }, a.key)).json;
    const tok = (s) => s.url.split('/s/')[1];
    r = await t.call('GET', `/s/${tok(listen)}/branded.mp4`, undefined, null, { range: 'bytes=0-11' });
    assert.equal(r.status, 206);
    assert.equal(r.buf.subarray(4, 12).toString(), 'ftypisom');
    assert.match((await t.call('GET', `/s/${tok(listen)}`)).text, /\/s\/[\w-]+\/branded\.mp4/);
    assert.equal((await t.call('GET', `/s/${tok(view)}/branded.mp4`)).status, 404);
    assert.doesNotMatch((await t.call('GET', `/s/${tok(view)}`)).text, /branded\.mp4/);
    // MCP get_meeting carries the video URL.
    const g = await t.mcp('get_meeting', { id: m.id, brief: true }, a.key);
    assert.equal(g.structuredContent.branded_video.video_url, v.video_url);
    assert.match(g.content[0].text, /LinkedIn video \(Premium/);
    // Deleting the recording takes the video with it.
    assert.equal((await t.call('DELETE', `/api/v1/meetings/${m.id}/recording`, undefined, a.key)).status, 200);
    assert.equal((await t.call('GET', `/api/v1/meetings/${m.id}/branded.mp4`, undefined, a.key)).status, 404);
    assert.equal(t.db.branded(m.id).wrapped_key, null);
  } finally {
    t.close();
  }
});

test('premium accounts get the branded video made by itself after a recorded voice meeting', async () => {
  const t = await start();
  try {
    const a = t.account('auto@example.com');
    t.db.setPremium(a.id, Date.now() + DAY);
    const m = await t.voiceMeeting(a.key);
    await t.app.service.idle();
    assert.equal(t.renderer.calls.length, 1);
    assert.equal(t.db.branded(m.id).requested_by, 'auto');
    assert.equal((await t.call('GET', `/api/v1/meetings/${m.id}`, undefined, a.key)).json.branded_video.status, 'done');
  } finally {
    t.close();
  }
});

test('premium standing: expiry, forever, Pass includes it, the CoinPay webhook extends it once', async () => {
  const t = await start();
  try {
    const a = t.account('standing@example.com');
    const premium = async () => (await t.call('GET', '/api/v1/account', undefined, a.key)).json.premium;
    t.db.setPremium(a.id, Date.now() - 1000);
    assert.equal((await premium()).active, false, 'an ended grant is not premium');
    t.db.setPass(a.id, Date.now() + 5 * DAY);
    let p = await premium();
    assert.equal(p.active, true);
    assert.equal(p.plan, 'pass');
    t.db.setPass(a.id, null);
    let r = await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'premium', forever: true }, 'admin-secret');
    assert.equal(r.json.premium.forever, true);
    assert.equal(t.db.accountById(a.id).premium_until, FOREVER);
    p = await premium();
    assert.equal(p.summary, 'Premium: active, no expiry');
    // Days added to a forever grant stay forever.
    await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'premium', days: 5 }, 'admin-secret');
    assert.equal(t.db.accountById(a.id).premium_until, FOREVER);
    await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'revoke_premium' }, 'admin-secret');
    assert.equal((await premium()).active, false);
    // Checkout + webhook: +30 days, once per event.
    r = await t.call('POST', '/api/v1/premium/checkout', {}, a.key);
    assert.equal(r.json.checkout_url, 'https://coinpay.test/c/premium');
    const body = JSON.stringify({ id: 'evt_p1', type: 'payment.confirmed', data: { payment_id: 'pp', status: 'confirmed', amount_usd: 29, metadata: { premium_account: a.id } } });
    assert.equal((await t.call('POST', '/api/v1/coinpay/webhook', JSON.parse(body), null, { 'x-coinpay-signature': 'bad' })).status, 401);
    const post = () => t.call('POST', '/api/v1/coinpay/webhook', JSON.parse(body), null, { 'x-coinpay-signature': signWebhook(body, 'whsec_test') });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).json.duplicate, true);
    const until = t.db.accountById(a.id).premium_until;
    assert.ok(Math.abs(until - (Date.now() + 30 * DAY)) < 60_000);
    assert.equal(t.db.auditFor(a.id).filter((x) => x.action === 'premium_paid').length, 1);
  } finally {
    t.close();
  }
});

test('/admin: gated to the admin key or an admin account, CSRF-checked, every change audited', async () => {
  const t = await start();
  try {
    const a = t.account('target@example.com');
    const b = t.account('helper@example.com');
    // The page is an empty shell for anyone; the API decides.
    let r = await t.call('GET', '/admin');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.doesNotMatch(r.text, /target@example\.com/);
    assert.match((await t.call('GET', '/robots.txt')).text, /Disallow: \/admin/);
    assert.equal((await t.call('GET', '/api/v1/admin/me')).status, 401);
    assert.equal((await t.call('GET', '/api/v1/admin/me', undefined, b.key)).status, 403);
    assert.equal((await t.call('GET', `/api/v1/admin/accounts?q=${a.id}`, undefined, b.key)).status, 403);
    assert.equal((await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'credits', delta: 5 }, b.key)).status, 403);
    assert.equal(t.db.accountById(a.id).credits, 0);
    r = await t.call('GET', '/api/v1/admin/me', undefined, 'admin-secret');
    assert.equal(r.status, 200);
    assert.equal(r.json.actor, 'admin-key');
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'admin answers carry no CORS');

    // Lookups: by id, by email, by CoinPay sub. A CoinPay placeholder email never matches.
    t.db.linkCoinPay(a.id, 'cp-sub-123');
    for (const q of [a.id, 'TARGET@example.com', 'cp-sub-123']) {
      r = await t.call('GET', `/api/v1/admin/accounts?q=${encodeURIComponent(q)}`, undefined, 'admin-secret');
      assert.deepEqual(r.json.accounts.map((x) => x.id), [a.id], q);
    }
    assert.equal(r.json.accounts[0].coinpay_sub, 'cp-sub-123');
    assert.ok('voice_raw' in r.json.accounts[0] && 'pass_active' in r.json.accounts[0]);
    const cpOnly = t.db.createCoinPayAccount('cp-other');
    r = await t.call('GET', `/api/v1/admin/accounts?q=${encodeURIComponent(t.db.accountById(cpOnly.id).email)}`, undefined, 'admin-secret');
    assert.deepEqual(r.json.accounts, []);

    // The admin key makes b an admin; b (its own API key) can then top up and grant, not make admins.
    r = await t.call('POST', `/api/v1/admin/accounts/${b.id}`, { action: 'admin', value: true }, 'admin-secret');
    assert.equal(r.json.admin, true);
    r = await t.call('GET', '/api/v1/admin/me', undefined, b.key);
    assert.equal(r.json.actor, `account:${b.id}`);
    assert.equal((await t.call('GET', '/api/v1/account', undefined, b.key)).json.admin_page, 'http://local/admin');
    r = await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'credits', delta: 5, note: 'refund for a bad call' }, b.key);
    assert.equal(r.status, 200);
    assert.equal(r.json.credits, 5);
    assert.equal((await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'admin', value: true }, b.key)).status, 403);
    assert.equal((await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'credits', delta: 0 }, b.key)).status, 400);
    assert.equal((await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'credits', delta: -50 }, b.key)).json.credits, 0, 'never below zero');
    assert.equal((await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'explode' }, b.key)).status, 400);
    assert.equal((await t.call('POST', '/api/v1/admin/accounts/nosuchaccount', { action: 'credits', delta: 1 }, b.key)).status, 404);

    // CSRF: a browser POST from another site is refused; the pit.world edge (Origin host = Host) and our origin pass.
    r = await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'credits', delta: 1 }, b.key, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /cross-site/);
    assert.equal((await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'credits', delta: 1 }, b.key, { origin: 'http://local' })).status, 200);

    // The audit log: who, what, when, for every change (refused ones are not changes).
    const audit = t.db.auditFor(a.id);
    assert.deepEqual(audit.map((x) => [x.actor, x.action]).reverse(), [
      [`account:${b.id}`, 'credits'],
      [`account:${b.id}`, 'credits'],
      [`account:${b.id}`, 'credits'],
    ]);
    assert.deepEqual(JSON.parse(audit.at(-1).detail), { delta: 5, before: 0, after: 5, note: 'refund for a bad call' });
    assert.ok(audit.every((x) => x.at > 0));
    r = await t.call('GET', '/api/v1/admin/audit', undefined, 'admin-secret');
    assert.equal(r.json.audit[r.json.audit.length - 1].action, 'admin');
    assert.equal(r.json.audit[r.json.audit.length - 1].actor, 'admin-key');
    assert.equal((await t.call('GET', '/api/v1/admin/audit', undefined, a.key)).status, 403);

    // Removing the flag takes /admin away at once.
    await t.call('POST', `/api/v1/admin/accounts/${b.id}`, { action: 'admin', value: false }, 'admin-secret');
    assert.equal((await t.call('GET', '/api/v1/admin/me', undefined, b.key)).status, 403);
  } finally {
    t.close();
  }
});

test('renders share ONE gate: a branded video waits while another render holds it; x264 threads are capped', async () => {
  assert.deepEqual(capThreads(['-i', 'a', '-c:v', 'libx264', '-crf', '23', 'out.mp4'], 2), ['-i', 'a', '-c:v', 'libx264', '-threads', '2', '-crf', '23', 'out.mp4']);
  assert.deepEqual(capThreads(['-i', 'a', '-c:a', 'aac', 'out.m4a'], 2), ['-i', 'a', '-c:a', 'aac', 'out.m4a'], 'audio-only commands are left alone');
  const t = await start();
  try {
    const a = t.account('gate@example.com');
    const m = await t.voiceMeeting(a.key);
    await t.call('POST', `/api/v1/admin/accounts/${a.id}`, { action: 'premium', days: 30 }, 'admin-secret');
    assert.equal(t.app.service.renderGate.max, 1);
    // Let the meeting's own renders (captioned video, slide show) finish first.
    const gate = t.app.service.renderGate;
    for (let i = 0; i < 1200 && (gate.active || gate.waiting); i++) await sleep(50);
    let release;
    const held = gate.run(() => new Promise((r) => (release = r)));
    await t.until(() => typeof release === 'function');
    const before = t.renderer.calls.length;
    const r = await t.call('POST', `/api/v1/meetings/${m.id}/branded-video`, {}, a.key);
    assert.equal(r.status, 202);
    await sleep(300);
    assert.equal(t.renderer.calls.length, before, 'the branded render waits for the gate');
    release();
    await held;
    await t.app.service.idle();
    assert.equal(t.renderer.calls.length, before + 1);
  } finally {
    t.close();
  }
});

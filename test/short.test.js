import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { captionChunks, renderShort, shortSlides, slideHtml, voteLine } from '../src/short.js';
import { fakeModel, fixture } from './fakes.js';

test('short slides: hook, question, vote, dissent (in the dissenter\'s voice), recommendation, call to action', () => {
  const s = shortSlides(fixture, { url: 'https://board.saas.pit.world/m/abc' });
  assert.equal(s.length, 6);
  assert.deepEqual(s.map((x) => x.kicker), ['AI board meeting', 'The question', 'The vote', 'Strongest dissent', 'The recommendation', 'Your turn']);
  assert.equal(s[3].voice, fixture.minutes.dissent.expert);
  assert.match(s[5].body, /board\.saas\.pit\.world\/m\/abc/);
  for (const x of s) assert.ok(x.say.split(' ').length <= 18, x.say);
  assert.equal(voteLine(fixture.minutes), '5-0', 'unanimous'); assert.equal(voteLine({ majority: 'x', vote: [{ final_option: 1 }, { final_option: 1 }, { final_option: 2 }] }), '2-1'); assert.equal(voteLine({ majority: 'x', vote: [{ final: 'a' }] }), null);
  assert.match(slideHtml(s[2], 2, 6), /1080px/);
  const c = captionChunks('one two three four five six seven', 1, 7);
  assert.deepEqual(c.map((x) => x.text), ['one two three four', 'five six seven']);
  assert.ok(Math.abs(c[1].end - 8) < 1e-9);
});

test('the short renders as a 1080x1920 H.264/AAC MP4 of at most 30 s, sped up to fit', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'short-test-'));
  // Long narration (7 s a slide = 42 s) forces the speed-up.
  const speech = { synthesize: async () => new Int16Array(24000 * 7).map((_, i) => Math.round(Math.sin(i / 9) * 3000)) };
  const shoot = async (html, png) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0f1a33:s=1080x1920', '-frames:v', '1', png]);
  const r = await renderShort(fixture, { speech, workDir: dir, url: 'https://board.saas.pit.world', shoot });
  const out = join(dir, 'out.mp4');
  writeFileSync(out, r.mp4);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', out]).toString());
  const v = probe.streams.find((x) => x.codec_name === 'h264');
  const a = probe.streams.find((x) => x.codec_name === 'aac');
  assert.ok(v && a, JSON.stringify(probe));
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.ok(Number(probe.format.duration) <= 30.05, probe.format.duration);
  assert.ok(Number(probe.format.duration) > 25, probe.format.duration);
  assert.ok(r.speed > 1.3 && r.speed <= 1.6, String(r.speed));
});

test('every finished meeting gets its short: encrypted at rest, on get_meeting, list_shareables, the owner page and the public page', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-'));
  const db = openDb(':memory:');
  const shoot = async (html, png) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0f1a33:s=1080x1920', '-frames:v', '1', png]);
  const app = createApp({
    env: { BOARD_SAAS_ADMIN_KEY: 'admin-secret', PUBLIC_URL: 'http://local', BOARD_RECORDINGS_DIR: dir, BOARD_SLIDESHOW: '0', BOARD_VOICE_TRIAL_EXPERIMENT: 'off' },
    db,
    model: fakeModel(),
    mailer: async () => {},
    log: () => {},
    kek: randomBytes(32),
    voice: { pairux: { configured: true }, speech: { synthesize: async () => new Int16Array(24000 * 2), close: async () => {} }, run: async () => ({}) },
    shortRenderer: shoot,
  });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const res = await fetch(base + path.replace('http://local', ''), { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buf.toString());
    } catch {}
    return { status: res.status, json, buf, text: buf.toString(), headers: res.headers };
  };
  try {
    const a = db.ensureAccount('shorts@example.com');
    const key = db.rotateKey(a.id);
    let r = await call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, key);
    const id = r.json.id;
    let v;
    for (let i = 0; i < 2400; i++) {
      v = (await call('GET', `/api/v1/meetings/${id}`, undefined, key)).json;
      if (v.short) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(v.short, JSON.stringify(v.status));
    assert.equal(v.short.video_url, `http://local/api/v1/meetings/${id}/short.mp4`);
    assert.match(v.short.post, /TikTok/);
    assert.ok(v.short.seconds > 5 && v.short.seconds <= 30);
    assert.equal(readFileSync(db.meeting(id).short_path).subarray(0, 4).toString(), 'BSR1', 'encrypted at rest');
    r = await call('GET', `/api/v1/meetings/${id}/short.mp4`, undefined, key);
    assert.equal(r.status, 200);
    assert.equal(r.buf.subarray(4, 8).toString(), 'ftyp');
    assert.equal((await call('GET', `/api/v1/meetings/${id}/short.mp4`, undefined, db.rotateKey(db.ensureAccount('x@example.com').id))).status, 403);
    const shareables = (await call('GET', '/api/v1/shareables', undefined, key)).json.shareables;
    assert.ok(shareables.find((s) => s.meeting_id === id).short.video_url);
    const page = (await call('GET', `/api/v1/meetings/${id}/page.html`, undefined, key)).text;
    assert.match(page, /30-second short/);
    assert.match(page, /\/media\/short\//);
    r = await call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public' }, key);
    const pub = r.json.public_url;
    assert.ok(pub);
    const ppage = (await call('GET', pub)).text;
    assert.match(ppage, /30-second short/);
    assert.match(ppage, /Post it:/);
    const pr = await call('GET', `${pub}/short.mp4`);
    assert.equal(pr.status, 200);
    assert.equal((await call('GET', `/api/v1/meetings/${id}`, undefined, key)).json.short.public_url, `${pub}/short.mp4`);
    r = await call('POST', `/api/v1/meetings/${id}/short`, {}, key);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'done');
  } finally {
    server.close();
  }
});

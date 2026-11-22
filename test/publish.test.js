// Publishing (private by default), invites by role, live listening over c0mpute Live, and the
// c0mpute private storage copy. Every c0mpute call is mocked: nothing here leaves the machine.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createArchive, MAX_ARCHIVE_BYTES } from '../src/archive.js';
import { openDb } from '../src/db.js';
import { createBroadcast, createLive, ffmpegArgs, streamNameFor } from '../src/live.js';
import { createApp } from '../src/server.js';
import { fakeModel, fakePairux, fixture } from './fakes.js';

const JOIN = 'https://pairux.com/join/ABC123';
const STREAM_KEY = 'sk_live_SECRET_KEY_123';
const PLAYBACK = 'https://c0mpute.com/live/st_1/index.m3u8';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** c0mpute.com + its ingest gateway. `conflict`: the stream name is taken (409). `uploads`: 'ok' | 'fail'. */
function fakeC0mpute({ conflict = false, uploads = 'ok' } = {}) {
  const calls = [];
  const identity = `c0ps1.${randomBytes(32).toString('base64url')}`;
  const stream = (id) => ({ id, name: null, title: 'Board meeting', visibility: 'unlisted', live: false, watch_url: `https://c0mpute.com/live/${id}`, playback_url: `https://c0mpute.com/live/${id}/index.m3u8` });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method ?? 'GET';
    const auth = opts.headers?.authorization ?? null;
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    calls.push({ method, path: u.pathname, host: u.host, auth, body, bytes: opts.body?.length ?? 0 });
    const p = u.pathname;
    if (u.host === 'c0mpute.com') {
      if (p === '/api/v1/live/streams' && method === 'POST') {
        if (conflict) return json(409, { error: { code: 'conflict', message: `you already have a stream named "${body.name}" (st_old)` } });
        return json(201, { ...stream('st_1'), name: body.name, visibility: body.visibility, stream_key: STREAM_KEY, publish_url: `rtmp://live.c0mpute.com/live/${STREAM_KEY}` });
      }
      if (p === '/api/v1/live/streams' && method === 'GET') return json(200, { streams: [{ ...stream('st_other'), name: 'someone-else' }, { ...stream('st_old'), name: calls.find((c) => c.method === 'POST' && c.path === '/api/v1/live/streams').body.name }] });
      if (p === '/api/v1/live/streams/st_old/key' && method === 'POST') return json(200, { stream_key: `${STREAM_KEY}_2`, publish_url: `rtmp://live.c0mpute.com/live/${STREAM_KEY}_2` });
      if (/^\/api\/v1\/live\/streams\/st_\w+$/.test(p) && method === 'DELETE') return json(200, { ok: true });
      if (p === '/api/v1/storage/identity') return json(200, { linked: true, identity, ingest_url: 'https://gateway.c0mpute.com', format: 'c0mpute-private-v1' });
      if (p === '/api/v1/storage/uploads' && method === 'POST') return uploads === 'fail' ? json(500, { error: { code: 'internal', message: 'storage is down' } }) : json(200, { upload_id: 'up_1', ticket: 'ticket-1', ingest_url: 'https://gateway.c0mpute.com' });
      if (p === '/api/v1/storage/uploads/up_1' && method === 'POST') return json(200, { status: 'replicating', copies: 1 });
    }
    if (u.host === 'gateway.c0mpute.com' && p.startsWith('/storage/v1/sealed/')) return json(200, { ok: true });
    return json(404, { error: 'not mocked' });
  };
  return { calls, fetchImpl };
}

/** ffmpeg stand-in: records its arguments and what is written to stdin; exits when stdin closes. */
function fakeSpawn() {
  const procs = [];
  const spawnImpl = (bin, args) => {
    const p = new EventEmitter();
    p.args = args;
    p.bytes = 0;
    p.stdin = Object.assign(new EventEmitter(), {
      write: (b) => ((p.bytes += b.length), true),
      end: () => setImmediate(() => p.emit('close', 0)),
    });
    p.stderr = new EventEmitter();
    p.kill = () => p.emit('close', null);
    p.on('close', () => (p.closed = true));
    procs.push(p);
    return p;
  };
  return { procs, spawnImpl };
}

/** A voice call that opens at once and stays open until `gate` resolves (or ends at once without one). */
const fakeCall = (gate = null) => async (o) => {
  const state = { status: 'live', session_id: 'sess-1', join_url: JOIN, join_code: 'ABC123', recorded: o.record };
  o.onState(state);
  o.liveSink?.add(new Int16Array(2400).fill(500), Date.now());
  await gate?.promise;
  return {
    qa: [],
    notes: [],
    humans: [{ name: 'Anthony' }],
    transcript: [{ t: 0, speaker: 'Chair', text: 'Welcome.', source: 'board' }],
    recording: o.record ? { pcm: new Int16Array(24000).fill(300), rate: 24000, seconds: 1 } : null,
    state: { ...state, status: 'ended' },
  };
};

async function start({ env = {}, c0mpute = fakeC0mpute(), gate = null } = {}) {
  const spawned = fakeSpawn();
  const db = openDb(':memory:');
  const app = createApp({
    env: { BOARD_SAAS_ADMIN_KEY: 'admin-secret', COINPAY_WEBHOOK_SECRET: 'whsec_test', PUBLIC_URL: 'http://local', BOARD_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), 'bsr-')), ...env },
    db,
    model: fakeModel(),
    mailer: async () => {},
    log: process.env.DEBUG ? console.log : () => {},
    kek: randomBytes(32),
    coinpay: { createCheckoutSession: async () => ({ id: 'cs_1', url: 'https://coinpay.test/c/1' }) },
    voice: { pairux: fakePairux(), speech: { render: async () => new Int16Array(240), close: async () => {} }, run: fakeCall(gate) },
    fetchImpl: c0mpute.fetchImpl,
    spawnImpl: spawned.spawnImpl,
  });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const res = await fetch(base + path.replace('http://local', ''), { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* a page */
    }
    return { status: res.status, json: j, text, headers: res.headers };
  };
  const until = async (id, key, ok) => {
    for (let i = 0; i < 400; i++) {
      const r = await call('GET', `/api/v1/meetings/${id}`, undefined, key);
      if (ok(r.json)) return r.json;
      await sleep(20);
    }
    throw new Error('timeout');
  };
  const account = (email) => {
    const a = db.ensureAccount(email);
    return { id: a.id, key: db.rotateKey(a.id) };
  };
  const mcp = async (name, args, key) => (await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key)).json.result;
  return { app, db, call, until, account, mcp, c0mpute, spawned, close: () => server.close() };
}

const done = (v) => !['queued', 'checking', 'running'].includes(v.status);

test('a meeting is private by default; its public page is a 404 until the owner publishes it, and again after', async () => {
  const t = await start();
  try {
    const a = t.account('founder@example.com');
    const stranger = t.account('stranger@example.com');
    let r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, a.key);
    assert.equal(r.status, 201);
    assert.equal(r.json.visibility, 'private');
    assert.equal(r.json.public_url, null);
    const id = r.json.id;
    const m = await t.until(id, a.key, done);
    assert.equal(m.status, 'done', m.error);
    assert.equal(m.visibility, 'private');
    assert.deepEqual((await t.call('GET', '/meetings')).text.match(/No public meetings yet/)?.length, 1);

    // The internal id is the owner's page (a sign-in shell, noindex); it is not a public page.
    r = await t.call('GET', `/m/${id}`);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.doesNotMatch(r.text, /Copy recommendation/);
    assert.equal((await t.call('GET', `/m/${id}/state.json`)).status, 404);

    // Only the owner publishes.
    assert.equal((await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public' })).status, 401);
    assert.equal((await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public' }, stranger.key)).status, 403);
    assert.equal((await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'everyone' }, a.key)).status, 400);
    assert.equal(t.db.meeting(id).public_id, null, 'no public id exists while it was never published');

    r = await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public' }, a.key);
    assert.equal(r.status, 200);
    assert.equal(r.json.visibility, 'public');
    const publicUrl = r.json.public_url;
    assert.match(publicUrl, /^http:\/\/local\/m\/[\w-]{24}$/);
    assert.ok(!publicUrl.includes(id), 'the public id is not the internal id');

    // The public page: the report, indexable, with none of the owner's controls or data.
    r = await t.call('GET', publicUrl);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), null);
    assert.doesNotMatch(r.text, /noindex/);
    assert.match(r.text, /Copy recommendation/);
    assert.match(r.text, new RegExp(`<link rel="canonical" href="${publicUrl}">`));
    assert.doesNotMatch(r.text, /Create share link/);
    assert.ok(!r.text.includes(id));
    assert.equal((await t.call('GET', `${publicUrl}/recording.mp3`)).status, 404);

    // Listed, newest first, and in the sitemap; robots.txt lets crawlers reach /m/.
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text }, 'admin-secret');
    const second = await t.until(r.json.id, 'admin-secret', done);
    const pub2 = (await t.call('PATCH', `/api/v1/meetings/${second.id}`, { visibility: 'public' }, 'admin-secret')).json.public_url;
    r = await t.call('GET', '/meetings');
    assert.equal(r.status, 200);
    assert.ok(r.text.indexOf(pub2) > 0 && r.text.indexOf(pub2) < r.text.indexOf(publicUrl), 'newest first');
    assert.match((await t.call('GET', '/sitemap.xml')).text, new RegExp(`<loc>${publicUrl}</loc>`));
    const robots = (await t.call('GET', '/robots.txt')).text;
    assert.doesNotMatch(robots, /Disallow: \/m\//);
    assert.match(robots, /Disallow: \/s\//);

    // MCP: publish_meeting and list_shareables.
    let tool = await t.mcp('list_shareables', {}, a.key);
    assert.equal(tool.structuredContent.shareables[0].public_url, publicUrl);
    assert.equal(tool.structuredContent.shareables[0].title, fixture.title);
    tool = await t.mcp('publish_meeting', { meeting_id: id, visibility: 'private' }, a.key);
    assert.equal(tool.structuredContent.visibility, 'private');
    assert.equal(tool.structuredContent.public_url, null);

    // Private again: the old public link is a 404, and it is off the index.
    assert.equal((await t.call('GET', publicUrl)).status, 404);
    assert.equal((await t.call('GET', `${publicUrl}/state.json`)).status, 404);
    assert.ok(!(await t.call('GET', '/meetings')).text.includes(publicUrl));
    assert.ok(!(await t.call('GET', '/sitemap.xml')).text.includes(publicUrl));
    tool = await t.mcp('publish_meeting', { meeting_id: id, visibility: 'public' }, stranger.key);
    assert.equal(tool.isError, true);
  } finally {
    t.close();
  }
});

test('invites while the meeting runs: roles gate the live audio, the join link and the recording; revoke and expiry hold on every route', async () => {
  const gate = deferred();
  const t = await start({ env: { BOARD_C0MPUTE_KEY: 'c0k_live_key' }, gate });
  try {
    const a = t.account('founder@example.com');
    let r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.id;
    const running = await t.until(id, a.key, (v) => v.status === 'running' && v.call?.join_url);
    // Running, private, nobody invited yet: nothing has gone to c0mpute and ffmpeg is not running.
    assert.equal(running.live, undefined);
    assert.equal(t.c0mpute.calls.length, 0);
    assert.equal(t.spawned.procs.length, 0);

    // A view share needs the finished report; listen and join invites can be made now.
    r = await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'view' }, a.key);
    assert.equal(r.status, 409);
    assert.equal((await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'owner' }, a.key)).status, 400);
    const listen = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'listen', label: 'Dana (investor)', expires: '24h' }, a.key)).json;
    assert.equal(listen.role, 'listen');
    assert.equal(listen.label, 'Dana (investor)');
    assert.match(listen.url, /^http:\/\/local\/s\/[\w-]{30,}$/);
    const joinShare = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'join' }, a.key)).json;
    assert.equal(joinShare.role, 'join');
    const invite = await t.mcp('invite_to_meeting', { meeting_id: id, label: 'Sam' }, a.key);
    assert.equal(invite.structuredContent.role, 'listen');
    assert.match(invite.content[0].text, new RegExp(invite.structuredContent.url.replace(/[/.]/g, '\\$&')));
    const tool = await t.mcp('list_shares', { id }, a.key);
    assert.deepEqual(tool.structuredContent.shares.map((s) => s.role).sort(), ['join', 'listen', 'listen']);
    assert.ok(tool.structuredContent.shares.every((s) => s.url.startsWith('http://local/s/')));

    // The first listen or join invite started the live audio.
    const withLive = await t.until(id, a.key, (v) => !!v.live);
    assert.equal(withLive.live.playback_url, PLAYBACK);
    // The unlisted stream was made with the c0mpute key; ffmpeg pushes FLV to its publish URL.
    const made = t.c0mpute.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/live/streams');
    assert.equal(made.auth, 'Bearer c0k_live_key');
    assert.equal(made.body.visibility, 'unlisted');
    assert.equal(made.body.name, streamNameFor(id));
    assert.ok(!JSON.stringify(made.body).includes(id), 'c0mpute never gets the meeting id');
    assert.equal(t.spawned.procs.length, 1);
    assert.equal(t.spawned.procs[0].args.at(-1), `rtmp://live.c0mpute.com/live/${STREAM_KEY}`);
    assert.deepEqual(t.spawned.procs[0].args.slice(-3, -1), ['-f', 'flv']);
    // The stream key is nowhere in the database.
    assert.ok(!JSON.stringify(t.db.meeting(id)).includes(STREAM_KEY));

    // listen: the playback URL, no join link. join: both.
    r = await t.call('GET', `${listen.url}/state.json`);
    assert.equal(r.json.status, 'live');
    assert.equal(r.json.live.playback_url, PLAYBACK);
    assert.equal(r.json.join, null);
    r = await t.call('GET', listen.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.ok(r.text.includes(PLAYBACK) && r.text.includes('hls.js@1.5.17/dist/hls.min.js'));
    assert.ok(!r.text.includes(JOIN), 'a listen invite never shows the join link');
    assert.ok(!r.text.includes(STREAM_KEY) && !r.text.includes('rtmp://'), 'the stream key is never on a page');
    r = await t.call('GET', `${joinShare.url}/state.json`);
    assert.equal(r.json.join.join_url, JOIN);
    assert.equal(r.json.live.playback_url, PLAYBACK);
    r = await t.call('GET', joinShare.url);
    assert.ok(r.text.includes(JOIN) && r.text.includes(PLAYBACK) && !r.text.includes(STREAM_KEY));
    // No recording exists yet for anyone.
    assert.equal((await t.call('GET', `${joinShare.url}/recording.mp3`)).status, 404);

    // The machine-readable list: live URL, join link, active shares with role, label, URL and expiry.
    r = await t.call('GET', '/api/v1/shareables', undefined, a.key);
    assert.equal(r.status, 200);
    const s0 = r.json.shareables[0];
    assert.equal(s0.meeting_id, id);
    assert.equal(s0.status, 'running');
    assert.equal(s0.visibility, 'private');
    assert.equal(s0.live_playback_url, PLAYBACK);
    assert.equal(s0.join_url, JOIN);
    assert.equal(s0.shares.length, 3);
    const dana = s0.shares.find((s) => s.label === 'Dana (investor)');
    assert.equal(dana.url, listen.url);
    assert.equal(dana.role, 'listen');
    assert.ok(dana.expires_at);
    assert.equal((await t.call('GET', '/api/v1/shareables')).status, 401);
    assert.deepEqual((await t.call('GET', '/api/v1/shareables', undefined, t.account('other@example.com').key)).json.shareables, []);

    // The public page of a running meeting is a listen-level audience: live audio, never the join link.
    const pub = (await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public' }, a.key)).json.public_url;
    r = await t.call('GET', pub);
    assert.equal(r.headers.get('x-robots-tag'), null);
    assert.ok(r.text.includes(PLAYBACK) && !r.text.includes(JOIN) && !r.text.includes(STREAM_KEY));
    r = await t.call('GET', `${pub}/state.json`);
    assert.equal(r.json.join, null);
    assert.equal(r.json.live.playback_url, PLAYBACK);
    await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'private' }, a.key);
    assert.equal((await t.call('GET', `${pub}/state.json`)).status, 404);

    // Revoke: the page and the state stop at once. Expiry: the same.
    await t.call('DELETE', `/api/v1/shares/${listen.id}`, undefined, a.key);
    assert.equal((await t.call('GET', listen.url)).status, 404);
    assert.equal((await t.call('GET', `${listen.url}/state.json`)).status, 404);
    const sam = invite.structuredContent;
    assert.equal((await t.call('GET', `${sam.url}/state.json`)).status, 200);
    t.db.raw.prepare('update shares set expires_at = ? where id = ?').run(Date.now() - 1000, sam.id);
    assert.equal((await t.call('GET', sam.url)).status, 404);
    assert.equal((await t.call('GET', `${sam.url}/state.json`)).status, 404);
    assert.equal((await t.call('GET', `${sam.url}/recording.mp3`)).status, 404);
    assert.equal((await t.call('GET', '/api/v1/shareables', undefined, a.key)).json.shareables[0].shares.length, 1, 'revoked and expired links are not listed as shareable');

    // The meeting ends (after the broadcast's 0.4 s look-behind has let some audio through).
    await sleep(600);
    gate.resolve();
    const ended = await t.until(id, a.key, done);
    assert.equal(ended.status, 'done', ended.error);
    assert.equal(ended.live, undefined);
    assert.ok(t.spawned.procs[0].bytes > 0, 'audio reached ffmpeg');
    assert.ok(t.c0mpute.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/live/streams/st_1'), 'the stream is deleted when the meeting ends');
    assert.equal(JSON.parse(t.db.meeting(id).live_json).status, 'ended');

    // After the end a join share exposes neither the join link nor the playback URL, anywhere.
    r = await t.call('GET', `${joinShare.url}/state.json`);
    assert.equal(r.json.status, 'ended');
    assert.equal(r.json.join, null);
    assert.equal(r.json.live, null);
    r = await t.call('GET', joinShare.url);
    assert.match(r.text, /Copy recommendation/);
    assert.ok(!r.text.includes('pairux.com/join') && !r.text.includes(PLAYBACK));
    assert.match(r.text, /<audio/);
    assert.equal((await t.call('GET', `${joinShare.url}/recording.mp3`)).status, 200);
    const after = (await t.call('GET', '/api/v1/shareables', undefined, a.key)).json.shareables[0];
    assert.equal(after.join_url, null);
    assert.equal(after.live_playback_url, null);
    assert.equal((await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'join' }, a.key)).status, 409);

    // view: the report only. No recording, no transcript, no playback URL.
    const view = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'view' }, a.key)).json;
    assert.equal(view.role, 'view');
    assert.equal(view.include_recording, false);
    r = await t.call('GET', view.url);
    assert.match(r.text, /Copy recommendation/);
    assert.doesNotMatch(r.text, /<audio/);
    assert.doesNotMatch(r.text, /Transcript/);
    assert.equal((await t.call('GET', `${view.url}/recording.mp3`)).status, 404);
    r = await t.call('GET', `${view.url}/state.json`);
    assert.equal(r.json.live, null);
    assert.equal(r.json.join, null);
    // An old-style share still maps to a role.
    assert.equal((await t.call('POST', `/api/v1/meetings/${id}/shares`, { include_recording: true }, a.key)).json.role, 'listen');
    assert.equal((await t.call('POST', `/api/v1/meetings/${id}/shares`, {}, a.key)).json.role, 'view');
    // A row made before roles existed (role is null) reads from include_recording.
    t.db.raw.prepare('update shares set role = null where id = ?').run(joinShare.id);
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/shares`, undefined, a.key)).json.shares.find((s) => s.id === joinShare.id).role, 'listen');

    // Published with the recording: the public page plays it; without, it does not.
    const pub2 = (await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public', include_recording: true }, a.key)).json;
    assert.equal(pub2.public_recording, true);
    assert.equal((await t.call('GET', `${pub2.public_url}/recording.mp3`)).status, 200);
    assert.match((await t.call('GET', pub2.public_url)).text, /<audio/);
    await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public', include_recording: false }, a.key);
    assert.equal((await t.call('GET', `${pub2.public_url}/recording.mp3`)).status, 404);
    assert.doesNotMatch((await t.call('GET', pub2.public_url)).text, /<audio/);
  } finally {
    gate.resolve();
    t.close();
  }
});

test('a private voice meeting nobody was invited to makes no c0mpute call at all', async () => {
  const gate = deferred();
  const t = await start({ env: { BOARD_C0MPUTE_KEY: 'c0k_live_key', BOARD_LIVE_CHECK_SECONDS: '0.03' }, gate });
  try {
    const a = t.account('founder@example.com');
    const id = (await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key)).json.id;
    const running = await t.until(id, a.key, (v) => v.status === 'running' && v.call?.join_url);
    assert.equal(running.live, undefined);
    await sleep(150); // several audience checks pass
    gate.resolve();
    const m = await t.until(id, a.key, done);
    assert.equal(m.status, 'done', m.error);
    // A view share of the finished report is not a live audience either.
    await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'view' }, a.key);
    await sleep(60);
    assert.equal(t.c0mpute.calls.length, 0, 'no stream was created, listed, re-keyed or deleted');
    assert.equal(t.spawned.procs.length, 0, 'ffmpeg never ran');
    assert.equal(t.db.meeting(id).live_json, null);
  } finally {
    gate.resolve();
    t.close();
  }
});

test('the live stream follows the audience: an invite or publishing mid-meeting starts it; the last invite revoked or expired stops and deletes it', async () => {
  const gate = deferred();
  const t = await start({ env: { BOARD_C0MPUTE_KEY: 'c0k_live_key', BOARD_LIVE_CHECK_SECONDS: '0.03' }, gate });
  const count = (method, re) => t.c0mpute.calls.filter((c) => c.method === method && re.test(c.path)).length;
  try {
    const a = t.account('founder@example.com');
    const id = (await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key)).json.id;
    await t.until(id, a.key, (v) => v.status === 'running' && v.call?.join_url);
    assert.equal(t.c0mpute.calls.length, 0);

    // The first invite, made while the meeting runs, starts the stream and the ffmpeg push.
    const first = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'listen' }, a.key)).json;
    let v = await t.until(id, a.key, (x) => !!x.live);
    assert.equal(v.live.playback_url, PLAYBACK);
    assert.equal(count('POST', /\/live\/streams$/), 1);
    assert.equal(t.spawned.procs.length, 1);
    assert.equal((await t.call('GET', `${first.url}/state.json`)).json.live.playback_url, PLAYBACK);
    // A second invite does not open a second stream.
    const second = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'join' }, a.key)).json;
    await sleep(100);
    assert.equal(count('POST', /\/live\/streams$/), 1);

    // One of two revoked: still an audience. The last one revoked: the push stops and the stream is deleted.
    await t.call('DELETE', `/api/v1/shares/${first.id}`, undefined, a.key);
    await sleep(100);
    assert.equal(count('DELETE', /\/live\/streams\//), 0);
    assert.ok((await t.call('GET', `/api/v1/meetings/${id}`, undefined, a.key)).json.live);
    await t.call('DELETE', `/api/v1/shares/${second.id}`, undefined, a.key);
    v = await t.until(id, a.key, (x) => !x.live && t.spawned.procs[0].closed && count('DELETE', /\/live\/streams\/st_1$/) === 1);
    assert.equal(v.status, 'running', 'the meeting itself goes on');
    assert.equal(JSON.parse(t.db.meeting(id).live_json).status, 'ended');

    // Made public while running: it starts again. Private again with no invites: it stops again.
    await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public' }, a.key);
    await t.until(id, a.key, (x) => !!x.live);
    assert.equal(count('POST', /\/live\/streams$/), 2);
    assert.equal(t.spawned.procs.length, 2);
    await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'private' }, a.key);
    await t.until(id, a.key, (x) => !x.live && t.spawned.procs[1].closed && count('DELETE', /\/live\/streams\//) === 2);

    // An invite that expires is noticed without anyone calling in.
    const third = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'listen', expires: '24h' }, a.key)).json;
    await t.until(id, a.key, (x) => !!x.live);
    t.db.raw.prepare('update shares set expires_at = ? where id = ?').run(Date.now() - 1000, third.id);
    await t.until(id, a.key, (x) => !x.live && count('DELETE', /\/live\/streams\//) === 3);
    assert.equal(t.spawned.procs.length, 3);
    assert.ok(t.spawned.procs.every((p) => p.closed));

    gate.resolve();
    assert.equal((await t.until(id, a.key, done)).status, 'done');
    assert.equal(count('POST', /\/live\/streams$/), 3);
    assert.equal(count('DELETE', /\/live\/streams\//), 3, 'nothing left to delete at the end');
  } finally {
    gate.resolve();
    t.close();
  }
});

test('without BOARD_C0MPUTE_KEY there is no live audio, and everything else still works', async () => {
  const gate = deferred();
  const t = await start({ gate });
  try {
    const a = t.account('founder@example.com');
    const id = (await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key)).json.id;
    const running = await t.until(id, a.key, (v) => v.status === 'running' && v.call?.join_url);
    assert.equal(running.live, undefined);
    const inv = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'join' }, a.key)).json;
    const st = (await t.call('GET', `${inv.url}/state.json`)).json;
    assert.equal(st.live, null);
    assert.equal(st.join.join_url, JOIN);
    assert.equal(t.spawned.procs.length, 0);
    assert.equal(t.c0mpute.calls.length, 0);
    gate.resolve();
    assert.equal((await t.until(id, a.key, done)).status, 'done');
  } finally {
    gate.resolve();
    t.close();
  }
});

test('c0mpute Live client: creates an unlisted stream; on 409 it lists, finds the stream by name and takes a new key', async () => {
  const fresh = fakeC0mpute();
  let live = createLive({ key: 'c0k_x', fetchImpl: fresh.fetchImpl });
  assert.equal(live.configured, true);
  assert.equal(createLive({}).configured, false);
  let s = await live.open({ name: streamNameFor('meeting-1'), title: 'Board meeting' });
  assert.deepEqual(s, { id: 'st_1', publish_url: `rtmp://live.c0mpute.com/live/${STREAM_KEY}`, playback_url: PLAYBACK, watch_url: 'https://c0mpute.com/live/st_1' });
  assert.deepEqual(fresh.calls[0].body, { name: streamNameFor('meeting-1'), title: 'Board meeting', visibility: 'unlisted' });
  assert.match(streamNameFor('meeting-1'), /^board-[0-9a-f]{20}$/);

  const taken = fakeC0mpute({ conflict: true });
  live = createLive({ key: 'c0k_x', fetchImpl: taken.fetchImpl });
  s = await live.open({ name: streamNameFor('meeting-1'), title: 'Board meeting' });
  assert.deepEqual(taken.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/v1/live/streams', 'GET /api/v1/live/streams', 'POST /api/v1/live/streams/st_old/key']);
  assert.ok(taken.calls.every((c) => c.auth === 'Bearer c0k_x'));
  assert.equal(s.id, 'st_old');
  assert.equal(s.publish_url, `rtmp://live.c0mpute.com/live/${STREAM_KEY}_2`);
  assert.equal(s.playback_url, 'https://c0mpute.com/live/st_old/index.m3u8');

  // Any other refusal is an error the meeting survives (the service logs it and goes on).
  const down = createLive({ key: 'c0k_x', fetchImpl: async () => json(503, { error: { message: 'down' } }) });
  await assert.rejects(down.open({ name: 'x', title: 'y' }), /503 down/);
});

test('live broadcast: mixes on a wall clock into ffmpeg, restarts it when it drops, and never logs the stream key', async () => {
  const sp = fakeSpawn();
  const logs = [];
  let clock = 1_000_000;
  const cast = createBroadcast({ publishUrl: `rtmp://live.c0mpute.com/live/${STREAM_KEY}`, rate: 24000, spawnImpl: sp.spawnImpl, log: (m) => logs.push(m), tickMs: 1_000_000, delayMs: 0, restartMs: 5, now: () => clock });
  try {
    const args = ffmpegArgs('rtmp://x/live/k');
    assert.ok(args.includes('aac') && args.includes('libx264') && args.includes('color=c=black:s=320x180:r=5'));
    assert.deepEqual(args.slice(0, 16).filter((x) => ['s16le', 'pipe:0'].includes(x)), ['s16le', 'pipe:0']);
    assert.deepEqual(args.slice(-5), ['-flush_packets', '1', '-f', 'flv', 'rtmp://x/live/k']);

    // Half a second passes: a clip at t=0 and a live track are mixed, with silence where nobody speaks.
    cast.add(new Int16Array(2400).fill(1000), clock);
    cast.stream('founder', new Int16Array(480).fill(200), clock);
    cast.stream('founder', new Int16Array(480).fill(200), clock + 20);
    clock += 500;
    cast.tick();
    assert.equal(sp.procs[0].bytes, 12000 * 2, '0.5 s of 24 kHz 16-bit mono');

    // ffmpeg drops (the key is in its error): it is started again, and the log has no key in it.
    sp.procs[0].stderr.emit('data', `Failed to open rtmp://live.c0mpute.com/live/${STREAM_KEY}: Connection refused`);
    sp.procs[0].emit('close', 1);
    clock += 100;
    cast.tick(); // nothing is running: this slice is dropped, not queued
    await sleep(30);
    assert.equal(sp.procs.length, 2, 'restarted');
    assert.equal(cast.restarts, 1);
    assert.ok(logs.some((l) => /ffmpeg exited 1/.test(l)));
    assert.ok(!logs.join('\n').includes(STREAM_KEY));
    clock += 100;
    cast.tick();
    assert.equal(sp.procs[1].bytes, 2400 * 2);
  } finally {
    await cast.stop();
  }
  await sleep(20);
  assert.equal(sp.procs.length, 2, 'no restart after stop');
});

test('c0mpute private storage: the MP3 is uploaded, the private link is stored encrypted and shown to the owner and to download shares only', async () => {
  const t = await start({ env: { BOARD_C0MPUTE_STORAGE_TOKEN: 'c0k_storage_token' } });
  try {
    const a = t.account('founder@example.com');
    const id = (await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key)).json.id;
    const m = await t.until(id, a.key, done);
    assert.equal(m.status, 'done', m.error);
    await t.app.service.idle();

    // The app-upload flow, with the storage token: identity, a ticket, pieces, finish.
    const paths = t.c0mpute.calls.map((c) => `${c.method} ${c.host}${c.path.replace(/[0-9a-f]{20}/, ':id')}`);
    assert.deepEqual(paths, ['GET c0mpute.com/api/v1/storage/identity', 'POST c0mpute.com/api/v1/storage/uploads', 'PUT gateway.c0mpute.com/storage/v1/sealed/:id', 'POST gateway.c0mpute.com/storage/v1/sealed/:id/finish', 'POST c0mpute.com/api/v1/storage/uploads/up_1']);
    assert.ok(t.c0mpute.calls.filter((c) => c.host === 'c0mpute.com').every((c) => c.auth === 'Bearer c0k_storage_token'));
    assert.ok(t.c0mpute.calls[1].body.bytes > 0);

    const view = (await t.call('GET', `/api/v1/meetings/${id}`, undefined, a.key)).json;
    const link = view.recording.c0mpute.private_link;
    assert.match(link, /^https:\/\/gateway\.c0mpute\.com\/p\/[0-9a-f]{20}\/#k=[\w-]{20,}$/);
    assert.match(view.recording.c0mpute.warning, /Anyone who has this link can open the file/);
    assert.match(view.recording.c0mpute.warning, /does not revoke a link that was already copied/);
    // At rest: encrypted under the KEK, never the link itself.
    const row = t.db.recording(id);
    assert.match(row.archive_ref, /^c0p1:[0-9a-f]{20}$/);
    assert.ok(row.archive_link && !row.archive_link.includes('gateway.c0mpute.com') && !JSON.stringify(row).includes(link.split('#k=')[1]));
    // The local encrypted copy is still the one that plays.
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/recording`, undefined, a.key)).status, 200);

    assert.equal((await t.call('GET', '/api/v1/shareables', undefined, a.key)).json.shareables[0].c0mpute_private_link, link);
    assert.match((await t.call('GET', `/api/v1/meetings/${id}/page.html`, undefined, a.key)).text, /Private c0mpute link/);

    // A listen share without downloads does not get it; one with allow_download does, with the warning.
    const plain = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'listen' }, a.key)).json;
    let page = (await t.call('GET', plain.url)).text;
    assert.match(page, /<audio/);
    assert.ok(!page.includes('gateway.c0mpute.com/p/') && !page.includes('Private c0mpute link'));
    const dl = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'listen', allow_download: true }, a.key)).json;
    page = (await t.call('GET', dl.url)).text;
    assert.ok(page.includes(link.replace(/&/g, '&amp;')));
    assert.match(page, /Anyone who has this link can open the file\. Revoking a board share does not revoke a link that was already copied\./);
    // A view share never does, even if download was asked for.
    const view2 = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'view', allow_download: true }, a.key)).json;
    assert.equal(view2.allow_download, false);
    assert.ok(!(await t.call('GET', view2.url)).text.includes('gateway.c0mpute.com/p/'));
    // Nor does a public page.
    const pub = (await t.call('PATCH', `/api/v1/meetings/${id}`, { visibility: 'public', include_recording: true }, a.key)).json.public_url;
    assert.ok(!(await t.call('GET', pub)).text.includes('gateway.c0mpute.com/p/'));

    // Deleting the recording forgets the link and says plainly that the c0mpute object remains.
    const del = (await t.call('DELETE', `/api/v1/meetings/${id}/recording`, undefined, a.key)).json;
    assert.equal(del.deleted, true);
    assert.match(del.c0mpute_copy.note, /still opens it/);
    assert.equal(t.db.recording(id).archive_link, null);
    assert.equal((await t.call('GET', '/api/v1/shareables', undefined, a.key)).json.shareables[0].c0mpute_private_link, null);
    assert.ok(!(await t.call('GET', dl.url)).text.includes('gateway.c0mpute.com/p/'));
  } finally {
    t.close();
  }
});

test('c0mpute private storage: a failed upload never fails the meeting; oversized files are skipped; unset means off', async () => {
  const t = await start({ env: { BOARD_C0MPUTE_STORAGE_TOKEN: 'c0k_storage_token' }, c0mpute: fakeC0mpute({ uploads: 'fail' }) });
  try {
    const a = t.account('founder@example.com');
    const id = (await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key)).json.id;
    const m = await t.until(id, a.key, done);
    assert.equal(m.status, 'done', m.error);
    await t.app.service.idle();
    const view = (await t.call('GET', `/api/v1/meetings/${id}`, undefined, a.key)).json;
    assert.equal(view.recording.c0mpute.private_link, null);
    assert.match(view.recording.c0mpute.note, /c0mpute copy failed/);
    assert.equal(view.recording.stored, 'encrypted on this server');
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/recording`, undefined, a.key)).status, 200);
    assert.equal((await t.call('GET', '/api/v1/shareables', undefined, a.key)).json.shareables[0].c0mpute_private_link, null);
  } finally {
    t.close();
  }

  // Over 192 MiB a browser link cannot open the object: skipped and logged, nothing is sent.
  const logs = [];
  let sent = 0;
  const archive = createArchive({ token: 'c0k_x', log: (l) => logs.push(l), upload: async () => (sent++, {}) });
  assert.deepEqual(await archive.put({ length: MAX_ARCHIVE_BYTES + 1 }), { skipped: 'over 192 MiB' });
  assert.equal(sent, 0);
  assert.match(logs[0], /over 192 MiB/);
  assert.equal(createArchive({}).configured, false);

  // No token: no upload is attempted and the meeting has no c0mpute fields.
  const off = await start();
  try {
    const a = off.account('founder@example.com');
    const id = (await off.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true }, a.key)).json.id;
    const m = await off.until(id, a.key, done);
    assert.equal(m.status, 'done');
    await off.app.service.idle();
    assert.equal(m.recording.c0mpute, undefined);
    assert.equal(off.c0mpute.calls.length, 0);
  } finally {
    off.close();
  }
});

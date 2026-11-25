// Questions to the board while it meets: names, routing, the limiter, fast answers, the two
// Q&A modes on a live call (with the fakes), and the submit paths (REST, invite page, MCP).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createMcpHandler } from '../src/mcp.js';
import { runVoiceMeeting } from '../src/voice.js';
import { createLimiter, looksLikeId, ownerNameOf, parseQaMode, pickQuestion, pickResponder, quickAnswer, relevantMembers, resolveName, safeName, scrubIds } from '../src/qa.js';
import { createClaudeModel } from '../src/claude.js';
import { createPairux } from '../src/pairux.js';
import { fakeModel, fakePairux, fakeRtc, fakeSpeech, fixture } from './fakes.js';

const UUID = 'ef0a5315-9ea6-41d3-be69-ec8381c3495e';
const speechPcm = () => {
  const p = new Int16Array(24000 * 3);
  p.fill(4000, 0, 24000); // 1 s of speech, then 2 s of quiet
  return p;
};

test('names: a uuid is never a name; PairUX display_name, the only human, the owner, then "the founder"', () => {
  assert.ok(looksLikeId(UUID));
  assert.ok(looksLikeId('a3f9c2e81b7d4c6e9f00'));
  assert.ok(looksLikeId('did:key:z6Mkabc'));
  assert.ok(!looksLikeId('Anthony Ettinger'));
  assert.equal(safeName(UUID), null);
  assert.equal(safeName('  Anthony  '), 'Anthony');
  assert.equal(scrubIds(`${UUID} asks: hi`), 'someone asks: hi');
  const roster = [{ id: 'p1', display_name: 'Anthony', kind: 'human' }];
  assert.equal(resolveName({ identity: UUID, rawName: UUID, roster }), 'Anthony', 'one human on the call: their display name');
  assert.equal(resolveName({ identity: UUID, rawName: UUID, roster: [...roster, { id: 'p2', display_name: 'Sam', kind: 'human', identity: UUID }] }), 'Sam', 'matched by identity');
  assert.equal(resolveName({ identity: UUID, rawName: UUID, roster: [], ownerName: 'Anthony' }), 'Anthony', 'the owner');
  assert.equal(resolveName({ identity: UUID, rawName: UUID, roster: [] }), 'the founder');
  assert.equal(ownerNameOf({ email: 'anthony+board@example.com' }), 'Anthony');
  assert.equal(ownerNameOf({ email: 'x9@example.com', c0mpute_name: 'did:key:abc' }), null);
  assert.equal(ownerNameOf({ email: 'coinpay-1@coinpay.invalid', c0mpute_name: 'Chovy' }), 'Chovy');
  assert.equal(parseQaMode(undefined), 'realtime');
  assert.equal(parseQaMode('Queued'), 'queued');
  assert.throws(() => parseQaMode('later'), /realtime/);
});

test('routing: one responder for a live question (never five), group members for a queued one, the chair picks bumped then voted', () => {
  assert.equal(pickResponder('What does this cost us in cash?'), 'cfo');
  assert.equal(pickResponder('What do all of you think?'), 'chair');
  assert.equal(pickResponder('Hello there board people'), 'chair');
  assert.equal(pickResponder('cash or risk?', { current: 'contrarian' }), 'contrarian', 'a tie goes to whoever is speaking');
  const g = relevantMembers('Is hiring a risk to our cash runway?');
  assert.ok(g.length >= 2 && g.length <= 3 && g.includes('cfo'), g.join());
  assert.equal(relevantMembers('Hello').length, 2);
  const items = [
    { id: 'a', status: 'queued', text: 'one', votes: 0, at: '1' },
    { id: 'b', status: 'queued', text: 'two', votes: 3, at: '2' },
    { id: 'c', status: 'queued', text: 'three', votes: 0, at: '3', bumped: true, bumped_at: 5 },
    { id: 'd', status: 'answered', text: 'four', votes: 9, at: '0' },
  ];
  assert.equal(pickQuestion(items).id, 'c');
  items[2].status = 'answered';
  assert.equal(pickQuestion(items).id, 'b');
});

test('limiter: board work never takes the last slot, so a live answer always gets one', async () => {
  const lim = createLimiter({ max: 3, reserve: 1 });
  const gate = [];
  const job = (lane) => lim.run(() => new Promise((r) => gate.push(r)), lane);
  const all = [job(), job(), job(), job(), job('live')];
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(lim.active, 3, 'two board calls + the live one');
  assert.equal(lim.waiting, 2, 'the other board calls wait');
  while (gate.length) {
    gate.shift()();
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(all);
  assert.equal(lim.active, 0);
});

test('fast answers: a 429 or a stall moves straight to the next model, no backoff', async () => {
  const tried = [];
  const model = {
    models: ['claude-opus-5-5'],
    liveModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
    async generate(req) {
      tried.push(req.model ?? 'main');
      assert.equal(req.fast, true);
      if (req.model === 'claude-haiku-5-5') throw Object.assign(new Error('Number of concurrent connections has exceeded your rate limit'), { status: 429 });
      if (req.model === 'claude-sonnet-5-5') return new Promise(() => {}); // stalls
      return { text: 'Opus answered.', model: 'claude-opus-5-5' };
    },
  };
  const t = Date.now();
  const out = await quickAnswer(model, { system: 's', user: 'u' }, { timeoutMs: 2000 });
  assert.deepEqual(tried, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'main']);
  assert.equal(out.text, 'Opus answered.');
  assert.ok(Date.now() - t < 2500);
});

test('claude model: a live answer goes to the fast model at low effort with no SDK retries', async () => {
  const calls = [];
  const client = {
    beta: {
      messages: {
        stream(params, opts) {
          calls.push({ params, opts });
          return { finalMessage: async () => ({ model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Short answer.' }], usage: { input_tokens: 10, output_tokens: 5 } }) };
        },
      },
    },
  };
  const m = createClaudeModel({ ANTHROPIC_API_KEY: 'x' }, { client });
  assert.deepEqual(m.liveModels, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  await m.generate({ user: 'q', model: 'claude-haiku-5-5', fast: true, maxTokens: 300 });
  assert.equal(calls[0].params.model, 'claude-haiku-5-5');
  assert.equal(calls[0].params.output_config.effort, 'low');
  assert.equal(calls[0].params.fallbacks, undefined, 'Haiku has no server-side fallbacks');
  assert.equal(calls[0].opts.maxRetries, 0);
  await m.generate({ user: 'q' });
  assert.equal(calls[1].params.model, 'claude-opus-5-5');
  assert.equal(calls[1].params.fallbacks, 'default');
  assert.equal(createClaudeModel({ ANTHROPIC_API_KEY: 'x', BOARD_LIVE_MODELS: 'off' }, { client }).liveModels.length, 0);
});

test('realtime: a spoken question from a uuid identity is answered by ONE member under the right name, while the board still thinks, in seconds', async () => {
  const rtc = fakeRtc({ human: { identity: UUID, name: UUID }, humanPcm: speechPcm() });
  const pairux = fakePairux({ chat: null, participants: [{ id: 'row-1', display_name: 'Anthony', kind: 'human' }], transcript: 'What does this cost us in cash?' });
  const speech = fakeSpeech();
  const model = fakeModel();
  const logs = [];
  const round1 = new Promise((r) => setTimeout(() => r(fixture.verdicts), 1500)); // round 1 is slow
  const r = await runVoiceMeeting({
    id: 'm-rt',
    board: { brief: { decision: 'Next hire', options: ['Editor', 'No hire'], constraints: [] }, round1, round2: Promise.resolve(fixture.debate), minutes: Promise.resolve(fixture) },
    record: false,
    pairux,
    speech,
    model,
    rtcModule: rtc,
    waitMs: 2000,
    vadThreshold: 500,
    gapMs: 0,
    finalWaitMs: 200,
    log: (m) => logs.push(m),
  });
  const asked = model.calls.filter((c) => / asks: /.test(c.user));
  assert.equal(asked.length, 1, 'one model call per question, not five');
  assert.equal(r.qa.length, 1, JSON.stringify(r.qa));
  assert.equal(r.qa[0].from, 'Anthony');
  assert.equal(r.qa[0].routed_to, 'cfo');
  assert.equal(r.qa[0].answers.length, 1);
  assert.equal(r.qa[0].mode, 'realtime');
  assert.ok(r.qa[0].latency_s < 10, `answered in ${r.qa[0].latency_s} s`);
  assert.ok(logs.some((l) => /^voice: answered Anthony in [\d.]+ s/.test(l)), logs.join('\n'));
  // Answered before round 1 came back: the chair took it while the board was still thinking.
  const lines = speech.lines.map((l) => `${l.role}:${l.text}`);
  const cfoAnswer = lines.findIndex((l) => l.startsWith('cfo:') && /runway/.test(l));
  const firstVerdictCall = lines.findIndex((l) => /Let us start with/.test(l));
  assert.ok(cfoAnswer > 0 && cfoAnswer < firstVerdictCall, lines.join('\n'));
  // Never a uuid anywhere people can see or hear.
  const everything = JSON.stringify([r.transcript, r.qa, r.humans, speech.lines, pairux.log.said]);
  assert.ok(!everything.includes(UUID), 'no uuid spoken or written');
  assert.ok(r.transcript.some((l) => l.source === 'whisper' && l.speaker === 'Anthony'));
  assert.deepEqual(r.humans.map((h) => h.name), ['Anthony']);
});

test('realtime: a question waiting mid-line takes the floor at the next sentence, then the line resumes', async () => {
  const pairux = fakePairux({ chat: null });
  const speech = fakeSpeech();
  const inbox = [];
  let pushed = false;
  // Push the question as soon as the first member starts their verdict.
  const render = speech.render;
  speech.render = async (role, text) => {
    if (role === 'cfo' && !pushed) {
      pushed = true;
      inbox.push({ id: 'w1', from: 'Sam', text: 'How do we reach more customers?', at: new Date().toISOString() });
    }
    return render(role, text);
  };
  const r = await runVoiceMeeting({
    id: 'm-mid',
    board: { brief: { decision: 'Next hire', options: ['Editor', 'No hire'], constraints: [] }, round1: Promise.resolve(fixture.verdicts), round2: Promise.resolve(fixture.debate), minutes: Promise.resolve(fixture) },
    record: false,
    pairux,
    speech,
    model: fakeModel(),
    rtcModule: fakeRtc(),
    inbox: { take: () => inbox.splice(0), update() {} },
    waitMs: 300,
    gapMs: 0,
    finalWaitMs: 200,
  });
  assert.equal(r.qa.length, 1);
  assert.equal(r.qa[0].from, 'Sam');
  assert.equal(r.qa[0].routed_to, 'growth');
  const roles = speech.lines.map((l) => l.role);
  const ack = speech.lines.findIndex((l) => /^Sam asks/.test(l.text));
  const lastDebateCall = speech.lines.findIndex((l) => /your reply/.test(l.text));
  assert.ok(ack > 0 && ack < lastDebateCall, 'answered during the verdicts, not at the end');
  assert.equal(roles.slice(ack).find((x) => x !== 'chair'), 'growth', 'growth answers right after the chair');
});

test('queued: the chair says "noted" at once, then picks the question (bumped first) and the relevant members answer in a round with a summary', async () => {
  const panel = [
    { id: 'pq1', display_name: 'Sam', content: 'Is hiring now a risk to our cash runway?', votes: 2, status: 'open', created_at: new Date().toISOString() },
    { id: 'pq2', display_name: 'Ana', content: 'How do we reach more customers?', votes: 0, status: 'open', created_at: new Date().toISOString(), bumped_at: new Date().toISOString() },
  ];
  const pairux = fakePairux({ chat: null, questions: (n) => (n >= 2 ? panel : []) });
  const speech = fakeSpeech();
  const inboxItems = [{ id: 'w1', from: 'Lee', text: 'What would you do with the time saved?', via: 'web', at: new Date().toISOString() }];
  const updates = [];
  const r = await runVoiceMeeting({
    id: 'm-q',
    board: { brief: { decision: 'Next hire', options: ['Editor', 'No hire'], constraints: [] }, round1: new Promise((res) => setTimeout(() => res(fixture.verdicts), 400)), round2: Promise.resolve(fixture.debate), minutes: Promise.resolve(fixture) },
    record: false,
    qaMode: 'queued',
    pairux,
    speech,
    model: fakeModel(),
    rtcModule: fakeRtc(),
    inbox: { take: () => inboxItems.splice(0), update: (id, p) => updates.push([id, p.status]) },
    waitMs: 300,
    gapMs: 0,
    finalWaitMs: 200,
  });
  const texts = speech.lines.map((l) => l.text);
  assert.equal(r.qa.length, 3, JSON.stringify(r.qa));
  for (const q of r.qa) {
    assert.equal(q.mode, 'queued');
    assert.equal(q.routed_to, 'group');
    assert.ok(q.answers.length >= 2, JSON.stringify(q));
    assert.match(q.summary, /board says/);
  }
  const ana = r.qa.findIndex((q) => q.from === 'Ana');
  const sam = r.qa.findIndex((q) => q.from === 'Sam');
  assert.ok(ana >= 0 && sam > ana, 'the host bump goes before the most voted');
  assert.ok(texts.some((t) => /^Now a question from Ana/.test(t)));
  assert.deepEqual(pairux.log.updated.filter((u) => u.qid === 'pq2').map((u) => u.status), ['answering', 'answered'], 'the panel shows now answering, then answered');
  assert.deepEqual(updates.map((u) => u[1]), ['answering', 'answered']);
});

test('queued: a question that arrives mid-agenda is acknowledged at the next sentence and answered later', async () => {
  const pairux = fakePairux({ chat: 'What does this cost us in cash?' });
  const speech = fakeSpeech();
  const r = await runVoiceMeeting({
    id: 'm-q2',
    board: { brief: { decision: 'Next hire', options: ['Editor', 'No hire'], constraints: [] }, round1: Promise.resolve(fixture.verdicts), round2: Promise.resolve(fixture.debate), minutes: Promise.resolve(fixture) },
    record: false,
    qaMode: 'queued',
    pairux,
    speech,
    model: fakeModel(),
    rtcModule: fakeRtc(),
    waitMs: 300,
    gapMs: 0,
    finalWaitMs: 200,
  });
  const texts = speech.lines.map((l) => l.text);
  const noted = texts.findIndex((t) => /^Noted, Anthony/.test(t));
  const answered = texts.findIndex((t) => /^Now a question from Anthony/.test(t));
  assert.ok(noted >= 0 && answered > noted, texts.join('\n'));
  assert.equal(r.qa.length, 1);
});

// ---------------------------------------------------------------- the service

async function start() {
  const env = { BOARD_SAAS_ADMIN_KEY: 'admin-secret', BOARD_SHORT: '0', PUBLIC_URL: 'http://local', BOARD_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), 'bsr-')), BOARD_VOICE_WAIT_SECONDS: '1', BOARD_VOICE_TRIAL_EXPERIMENT: 'off' };
  const db = openDb(':memory:');
  const pairux = fakePairux({ chat: null });
  const slowRound = (o) => {
    const board = { ...o.board, round1: o.board.round1.then((v) => new Promise((r) => setTimeout(() => r(v), 600))) };
    return runVoiceMeeting({ ...o, board, record: false, rtcModule: fakeRtc(), gapMs: 0, finalWaitMs: 300 });
  };
  const app = createApp({ env, db, model: fakeModel(), mailer: async () => {}, log: () => {}, kek: randomBytes(32), voice: { pairux, speech: fakeSpeech(), run: slowRound } });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  const account = (email) => {
    const acct = db.ensureAccount(email);
    return { id: acct.id, key: db.rotateKey(acct.id) };
  };
  const waitDone = async (id, key) => {
    for (let i = 0; i < 1200; i++) {
      const r = await call('GET', `/api/v1/meetings/${id}`, undefined, key);
      if (!['queued', 'checking', 'running'].includes(r.json.status)) return r.json;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('timeout');
  };
  return { base, call, account, waitDone, pairux, close: () => server.close() };
}

test('questions over the API: qa_mode on run_meeting, submit while it runs, a listen invite asks too, answers in the report', async () => {
  const t = await start();
  try {
    const a = t.account('asker@example.com');
    let r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true, qa_mode: 'sometime' }, a.key);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /qa_mode/);
    r = await t.call('POST', '/api/v1/meetings', { brief: fixture.brief.text, voice: true, qa_mode: 'queued' }, a.key);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.qa_mode, 'queued');
    const id = r.json.id;
    r = await t.call('POST', `/api/v1/meetings/${id}/questions`, { text: 'Is hiring now a risk to our cash?' }, a.key);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.from, 'Asker', 'the account name');
    const invite = (await t.call('POST', `/api/v1/meetings/${id}/shares`, { role: 'listen', label: 'Dana' }, a.key)).json;
    const token = invite.url.split('/s/')[1];
    r = await t.call('POST', `/s/${token}/questions`, { text: 'How do we reach more customers?' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.from, 'Dana');
    const live = await t.call('GET', `/s/${token}`);
    assert.match(live.text, /Ask the board/);
    assert.equal((await t.call('POST', `/api/v1/meetings/${id}/questions`, { text: 'hi there' }, t.account('x@example.com').key)).status, 403);
    assert.equal((await t.call('GET', `/api/v1/meetings/${id}/questions`, undefined, a.key)).json.questions.length, 2);
    const done = await t.waitDone(id, a.key);
    assert.equal(done.status, 'done', done.error);
    const froms = done.meeting.qa.map((q) => q.from);
    assert.ok(froms.includes('Asker') && froms.includes('Dana'), JSON.stringify(done.meeting.qa));
    assert.ok(done.meeting.qa.every((q) => q.answers.length >= 2));
    assert.equal(done.meeting.voice.qa_mode, 'queued');
    assert.deepEqual(t.pairux.log.opened.moderatorEmails, ['asker@example.com'], 'the owner moderates the PairUX Q&A panel');
    assert.equal((await t.call('POST', `/api/v1/meetings/${id}/questions`, { text: 'too late now' }, a.key)).status, 409);
    const page = (await t.call('GET', `/api/v1/meetings/${id}/page.html`, undefined, a.key)).text;
    assert.match(page, /Dana asked on the meeting page/);
  } finally {
    t.close();
  }
});

test('MCP: run_meeting takes qa_mode and submit_question reaches the service', async () => {
  const seen = {};
  const h = createMcpHandler({
    runMeeting: async (brief, data, opts) => ((seen.opts = opts), { id: 'm1', status: 'queued' }),
    getMeeting: async () => ({ id: 'm1', status: 'queued' }),
    submitQuestion: async (id, text, name) => ((seen.q = { id, text, name }), { id: 'w1', qa_mode: 'realtime', how: 'soon' }),
  });
  const list = await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const run = list.result.tools.find((x) => x.name === 'run_meeting');
  assert.deepEqual(run.inputSchema.properties.qa_mode.enum, ['realtime', 'queued']);
  assert.ok(list.result.tools.some((x) => x.name === 'submit_question'));
  await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_meeting', arguments: { brief: 'x'.repeat(30), voice: true, qa_mode: 'queued' } } });
  assert.equal(seen.opts.qa_mode, 'queued');
  const out = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'submit_question', arguments: { meeting_id: 'm1', text: 'Why now?', name: 'Sam' } } });
  assert.deepEqual(seen.q, { id: 'm1', text: 'Why now?', name: 'Sam' });
  assert.match(out.result.content[0].text, /sent to the board/);
});

test('PairUX client: the Q&A panel update is the agent PATCH, and moderators ride on openSession', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization }), new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
  const p = createPairux({ url: 'https://pairux.test', key: 'pux_pk_x', fetchImpl });
  await p.updateQuestion('agent-1', 'q-1', { status: 'answering' });
  assert.deepEqual(seen[0], { url: 'https://pairux.test/api/v1/agents/agent-1/questions/q-1', method: 'PATCH', body: { status: 'answering' }, auth: undefined });
  await p.openSession({ subject: 's', agents: [], recorded: true, moderatorEmails: ['a@example.com'] });
  assert.deepEqual(seen[1].body.moderatorEmails, ['a@example.com']);
  await p.openSession({ subject: 's', agents: [], recorded: true });
  assert.equal('moderatorEmails' in seen[2].body, false);
});

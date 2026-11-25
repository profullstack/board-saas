// Live voice board meetings on PairUX.
//
// The board meets in an ordinary PairUX session: the founder joins it from the PairUX desktop
// app or the web/PWA with a normal join link; the chair and the five members join as PairUX
// agents and each speaks in its own Kokoro voice (rendered on c0mpute) over a microphone-only
// LiveKit track. This module is the floor manager: ONE process speaks for all six, so there is
// exactly one speaker at a time by construction (the OTR co-host bugs came from independent
// legs guessing who held the floor; here nobody guesses).
//
// Anyone on the call can ask: by speaking (their track is transcribed by PairUX's self-hosted
// Whisper), by typing in the room chat, in PairUX's Q&A panel, or through board.saas (REST, MCP,
// the live page). Two styles, per meeting (qa_mode):
//   realtime (default)  the agenda yields at the next sentence, the chair acknowledges, ONE member
//                       answers on a fast model, and the agenda resumes: seconds, not minutes.
//   queued              the chair says "noted" at once; questions are taken at the right agenda
//                       points (after the verdicts, after the debate, a Q&A before the minutes,
//                       and whenever the board is still thinking), each answered by a short
//                       round of the relevant members and a one-line summary from the chair.
import { EXPERTS, nameOf } from './experts.js';
import { Mixer } from './recording.js';
import { createLimiter, groupAnswer, memberAnswer, pickQuestion, pickResponder, relevantMembers, resolveName, routeByKeywords, safeName, scrubIds, SHORT as QA_SHORT } from './qa.js';
import { childLink, inProcessLink } from './agent-link.js';
import { clip, encodeWav, SAMPLE_RATE, sayable, sentences } from './speech.js';

export const ROLES = ['chair', ...EXPERTS.map((e) => e.id)];
export const AGENT_NAMES = {
  chair: 'Chair (AI)',
  cfo: 'CFO (AI)',
  growth: 'Growth Marketer (AI)',
  operator: 'Operator (AI)',
  'founder-time': 'Founder-Time Strategist (AI)',
  contrarian: 'Contrarian Investor (AI)',
};
const SHORT = { cfo: 'CFO', growth: 'Growth', operator: 'Operator', 'founder-time': 'Founder-Time', contrarian: 'Contrarian' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { routeByKeywords };

/**
 * Energy-gated utterance detector for 24 kHz mono frames. onUtterance(pcm) fires after
 * `hangMs` of quiet following at least `minMs` of voice; utterances are cut at `maxMs`.
 */
export function createVad({ threshold = 700, minMs = 600, hangMs = 900, maxMs = 30_000, preMs = 300, onUtterance }) {
  let buf = [];
  let pre = [];
  let voiced = 0;
  let quiet = 0;
  let total = 0;
  let active = false;
  const ms = (n) => (n / SAMPLE_RATE) * 1000;
  return function push(pcm) {
    let sum = 0;
    for (const v of pcm) sum += v * v;
    const loud = Math.sqrt(sum / Math.max(1, pcm.length)) > threshold;
    if (!active) {
      pre.push(pcm);
      while (pre.length && ms(pre.reduce((a, p) => a + p.length, 0)) > preMs) pre.shift();
      if (loud) {
        active = true;
        buf = [...pre];
        pre = [];
        voiced = 0;
        quiet = 0;
        total = buf.reduce((a, p) => a + p.length, 0);
      } else return;
    }
    buf.push(pcm);
    total += pcm.length;
    if (loud) {
      voiced += pcm.length;
      quiet = 0;
    } else quiet += pcm.length;
    if (ms(quiet) >= hangMs || ms(total) >= maxMs) {
      active = false;
      const n = buf.reduce((a, p) => a + p.length, 0);
      const out = new Int16Array(n);
      let o = 0;
      for (const p of buf) {
        out.set(p, o);
        o += p.length;
      }
      buf = [];
      if (ms(voiced) >= minMs) onUtterance(out);
    }
  };
}

/** What each role says, kept short for the ear; the report keeps every word. */
export const script = {
  intro(brief, { recorded, qaMode = 'realtime' }) {
    const opts = brief.options.slice(0, 4).join('; or ');
    return [
      'Welcome. I am the chair of your AI board. The members are AI models, not real directors.',
      recorded ? 'This call is being recorded for your private report.' : '',
      `Today we decide: ${clip(brief.decision, 40)}`,
      `The options on the table: ${clip(opts, 50)}`,
      'Each member gives a verdict, then we debate, then I give the recommendation.',
      qaMode === 'queued' ? 'Ask a question any time, by speaking, in the chat or in the Q and A panel. I will note it and we will take it at the right moment.' : 'Speak up any time, or type in the chat, and the board will answer you right away.',
    ]
      .filter(Boolean)
      .join(' ');
  },
  callOn: (id, first) => (first ? `Let us start with ${SHORT[id]}. Your verdict.` : `${SHORT[id]}, your verdict.`),
  verdict: (v) => clip(`${v.call} ${v.reasons[0] ?? ''} ${v.reasons[1] ?? ''} The one thing I would watch: ${v.watch_out}`, 95),
  debateOpen: 'Thank you all. Now the debate. Each of you has read the others. Keep it short.',
  callOnDebate: (id) => `${SHORT[id]}, your reply.`,
  debate: (d) => clip(d.reply, 65),
  minutes(meeting) {
    const m = meeting.minutes;
    return clip(
      `Here is where the board landed. ${m.majority} The strongest dissent came from ${SHORT[m.dissent.expert] ?? 'a member'}${m.dissent.quote ? `, who said: ${m.dissent.quote.replace(/[.!?\s]+$/, '')}.` : ':'} ${m.dissent.argument} My recommendation: ${m.recommendation} And the one question you still need to answer: ${m.question}`,
      170,
    );
  },
  finalCall: 'Before we close: any last questions for the board? Speak now or type in the chat.',
  close: 'Thank you. The full minutes, with any questions you asked, are in your report. This meeting is closed.',
  waiting: 'The members are still finishing their notes. While they do, the floor is open: ask the board anything.',
  ack(q, to) {
    const asker = q.from === 'the founder' ? 'A question from the founder' : `${q.from} asks`;
    return `${asker}: ${clip(q.text, 25)} ${to === 'chair' ? '' : `${SHORT[to]}, that one is yours.`}`.trim();
  },
  noted(list) {
    const names = [...new Set(list.map((q) => q.from))];
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `Noted, ${who === 'the founder' ? 'thank you' : who}. We will take ${list.length > 1 ? 'those' : 'it'} in the Q and A.`;
  },
  groupOpen(q, members) {
    const asker = q.from === 'the founder' ? 'the founder' : q.from;
    return `Now a question from ${asker}: ${clip(q.text, 30)} Let us go round: ${members.map((m) => SHORT[m]).join(', ')}.`;
  },
  qaSegment: 'Before the minutes, your questions.',
  noAnswer: 'I could not get an answer to that in time. It is noted in your report, and we can come back to it.',
};

/**
 * Run one live voice meeting. Resolves with { qa, transcript, recording, humans, notes }.
 *
 * board = { brief, round1: Promise<verdicts>, round2: Promise<debate>, minutes: Promise<meeting> }
 * onState(fields) persists the voice state (join link, status) so the web page, CLI and MCP see it.
 * startNow() is polled while waiting for the founder.
 * liveSink (optional) gets the same audio as the recorder, as it happens: { add(pcm, atMs), stream(trackId, pcm) }.
 */
export async function runVoiceMeeting({
  id,
  board,
  record = true,
  pairux,
  speech,
  model,
  qaMode = 'realtime',
  ownerName = null,
  moderatorEmails = [],
  inbox = null,
  limiter = null,
  liveTimeoutMs = 20_000,
  onState = () => {},
  startNow = () => false,
  waitMs = 180_000,
  log = () => {},
  liveSink = null,
  rtcModule = null,
  vadThreshold = 700,
  gapMs = 350,
  finalWaitMs = 25_000,
  connectTimeoutMs = 30_000,
  nudgeMs = 15_000,
  qaSegmentMax = 6,
}) {
  const t0 = Date.now();
  const mixer = record ? new Mixer(SAMPLE_RATE, t0) : null;
  // Everything the recorder hears also goes to the live broadcast (src/live.js), when there is one.
  const sinks = [mixer, liveSink].filter(Boolean);
  const transcript = [];
  const qa = [];
  const notes = [];
  // Every question from every source, in arrival order. status: queued | answering | answered | unanswered
  const questions = [];
  const roster = new Map(); // PairUX poll roster: participant id -> row (display_name, identity...)
  const callers = new Map(); // LiveKit identity -> the name LiveKit gave
  const links = [];
  const agents = {};
  const known = { verdicts: null };
  let ended = false;
  let current = null; // who holds the floor right now
  limiter ??= createLimiter({ max: 3, reserve: 1 });
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const nameFor = (identity, rawName) => resolveName({ identity, rawName, roster: [...roster.values()], ownerName });
  board.round1.then((v) => (known.verdicts = v)).catch(() => {});

  const subject = `Board meeting: ${sayable(board.brief.decision).slice(0, 90)}`;
  const opened = await pairux.openSession({
    subject: record ? `${subject} (recorded)` : subject,
    recorded: record,
    agents: ROLES.map((r) => ({ name: r === 'chair' && record ? 'Chair (AI) - recording' : AGENT_NAMES[r], client: 'board.saas' })),
    // The meeting owner moderates the PairUX Q&A panel (picks the next question) when signed in to PairUX.
    moderatorEmails,
  });
  ROLES.forEach((r, i) => (agents[r] = { participantId: opened.agents[i].participantId, name: opened.agents[i].name }));
  const agentIds = new Set(Object.values(agents).map((a) => a.participantId));
  const state = { status: 'waiting', session_id: opened.sessionId, join_url: opened.joinUrl, join_code: opened.joinCode, recorded: record, qa_mode: qaMode, agents: ROLES.map((r) => ({ role: r, name: agents[r].name })), opened_at: new Date().toISOString() };
  onState(state);
  log(`voice: PairUX session ${opened.sessionId} open, join ${opened.joinUrl} (questions: ${qaMode})`);

  const timers = [];
  let lostReason = null;
  const beat = () => {
    for (const r of ROLES) {
      if (r === 'chair' && timers.chairPolling) continue;
      pairux.poll(agents[r].participantId).catch((e) => {
        if (e.status === 410 && !lostReason) lostReason = `${AGENT_NAMES[r]} was removed from the PairUX call (or the call ended)`;
      });
    }
  };
  beat();
  timers.push(setInterval(beat, 30_000));

  // ---- questions: one queue for every source
  const ctx = () => ({ brief: board.brief, verdicts: known.verdicts });
  /** Tell the source (PairUX Q&A panel, the board.saas inbox) where a question stands. */
  const mark = (q, status) => {
    q.status = status;
    if (q.source === 'pairux' && pairux.updateQuestion) pairux.updateQuestion(agents.chair.participantId, q.ext_id, { status: status === 'unanswered' ? 'open' : status }).catch((e) => log(`voice: could not update the PairUX question: ${e.message}`));
    if (q.source === 'inbox') inbox?.update?.(q.ext_id, { status });
  };
  function addQuestion({ via, from, text, at: when, source = via, ext_id = null, votes = 0, bumped_at = null, heardAt = Date.now() }) {
    if (ended) return null;
    if (ext_id && questions.some((q) => q.source === source && q.ext_id === ext_id)) return null;
    const q = { id: `q${questions.length + 1}`, via, source, ext_id, from: safeName(from) || 'the founder', text: scrubIds(text).slice(0, 600), at: when || new Date().toISOString(), votes, bumped: !!bumped_at, bumped_at: bumped_at ? Date.parse(bumped_at) || Date.now() : null, status: 'queued', heardAt, acked: false };
    questions.push(q);
    if (via !== 'voice') transcript.push({ t: at(), speaker: q.from, text: q.text, source: via });
    if (qaMode === 'realtime') {
      // Start on the answer now, while the current sentence finishes: by the time the chair has
      // acknowledged it, the member's answer is usually back.
      q.responder = pickResponder(q.text, { current });
      q.answer = memberAnswer(model, q.responder, q, ctx(), { sentences: 3, words: q.responder === 'chair' ? 60 : 70, timeoutMs: liveTimeoutMs, limiter, log });
      q.answer.catch(() => {});
    }
    log(`voice: question from ${q.from} (${via}${qaMode === 'realtime' ? `, for ${q.responder}` : ', queued'}): ${q.text.slice(0, 120)}`);
    return q;
  }
  const waiting = () => questions.some((q) => q.status === 'queued' && (qaMode === 'realtime' || !q.acked));

  try {
    // Six call connections, one microphone track each, each in its own process in production
    // (see agent-link.js for why). The chair also hears the founder: it is the board's ears
    // (and the recorder). Every attempt is time-boxed, so a connection that hangs fails the
    // call with a clear error instead of leaving it in "waiting".
    const vads = new Map();
    const onHuman = (identity, name) => {
      if (!callers.has(identity)) callers.set(identity, name);
    };
    const onAudio = (identity, rawName, pcm) => {
      if (ended) return;
      let vad = vads.get(identity);
      if (!vad) {
        onHuman(identity, rawName);
        log(`voice: listening to ${nameFor(identity, rawName)}`);
        vad = createVad({
          threshold: vadThreshold,
          onUtterance: async (utt) => {
            const heardAt = Date.now();
            try {
              const { text } = await pairux.transcribe(encodeWav(utt, SAMPLE_RATE));
              const words = String(text || '').trim();
              if (words.split(/\s+/).length < 2) return;
              const name = nameFor(identity, rawName);
              transcript.push({ t: at(), speaker: name, text: scrubIds(words), source: 'whisper' });
              log(`voice: heard ${name} (${((Date.now() - heardAt) / 1000).toFixed(1)} s to transcribe): ${words.slice(0, 120)}`);
              addQuestion({ via: 'voice', from: name, text: words, heardAt });
            } catch (e) {
              log(`voice: transcription failed: ${e.message}`);
            }
          },
        });
        vads.set(identity, vad);
      }
      for (const k of sinks) k.stream(identity, pcm);
      vad(pcm);
    };
    const makeLink = (opts) => (rtcModule ? inProcessLink(rtcModule, opts) : childLink(opts));
    const connect = async (role) => {
      const a = agents[role];
      for (let attempt = 1; ; attempt++) {
        try {
          const tok = await pairux.voiceToken(a.participantId);
          a.link = await makeLink({ url: tok.url, token: tok.token, role, subscribe: role === 'chair', agentIds, onAudio, onHuman, log, connectTimeoutMs });
          links.push(a.link);
          return;
        } catch (e) {
          if (attempt >= 3) throw new Error(`${AGENT_NAMES[role]} could not join the PairUX call after 3 tries: ${e.message}`);
          log(`voice: ${role} connect attempt ${attempt} failed (${e.message}); reconnecting`);
          await sleep(1500);
        }
      }
    };
    // One process per member (production): connect all six at once, so a slow or retried join
    // costs seconds, not minutes. The in-process test double connects in order.
    if (rtcModule) for (const role of [...ROLES.slice(1), 'chair']) await connect(role);
    else {
      const results = await Promise.allSettled(ROLES.map((role) => connect(role)));
      const bad = results.find((r) => r.status === 'rejected');
      if (bad) throw bad.reason;
    }
    log('voice: six agents connected and publishing');

    // Heartbeats keep every agent in the roster; the chair also reads chat, the Q&A panel and the roster.
    let after = new Date(Date.now() - 1000).toISOString();
    const announced = new Set();
    const ourMessages = new Set();
    const pollChair = async () => {
      if (ended) return;
      try {
        const r = await pairux.poll(agents.chair.participantId, after);
        if (r.serverTime) after = r.messages?.length ? r.messages[r.messages.length - 1].created_at : after;
        for (const p of r.participants ?? []) {
          if (p.kind !== 'human') continue;
          roster.set(p.id, p);
          if (record && !announced.has(p.id)) {
            announced.add(p.id);
            const hello = safeName(p.display_name);
            const m = await pairux.say(agents.chair.participantId, `Welcome${hello ? `, ${hello}` : ''}. This board call is recorded for the meeting owner's private report. The board members are AI. Ask a question any time by speaking or typing here.`).catch(() => null);
            if (m?.id) ourMessages.add(m.id);
          }
        }
        for (const m of r.messages ?? []) {
          if (ourMessages.has(m.id) || Object.values(agents).some((a) => a.name === m.display_name)) continue;
          if (m.message_type && m.message_type !== 'text') continue;
          const text = String(m.content || '').trim();
          if (!text) continue;
          addQuestion({ via: 'chat', from: safeName(m.display_name) || nameFor(m.participant_id, null), text, at: m.created_at, ext_id: m.id });
        }
        // PairUX's room Q&A panel: new questions join the queue; votes and a host's bump update it.
        for (const pq of r.questions ?? []) {
          const mine = questions.find((q) => q.source === 'pairux' && q.ext_id === pq.id);
          if (mine) {
            mine.votes = Number(pq.votes) || 0;
            if (pq.bumped_at && !mine.bumped) Object.assign(mine, { bumped: true, bumped_at: Date.parse(pq.bumped_at) || Date.now() });
            continue;
          }
          if (pq.status && pq.status !== 'open') continue;
          addQuestion({ via: 'qa', source: 'pairux', ext_id: pq.id, from: safeName(pq.display_name) || nameFor(pq.participant_id, null), text: String(pq.content || ''), at: pq.created_at, votes: Number(pq.votes) || 0, bumped_at: pq.bumped_at });
        }
      } catch (e) {
        if (e.status === 410) {
          lostReason ??= 'the chair was removed from the PairUX call (or the call ended)';
          ended = true;
        }
      }
    };
    timers.chairPolling = true;
    timers.push(setInterval(pollChair, 2500));
    await pollChair();
    // Questions sent through board.saas (REST, MCP, the live page) arrive through the inbox.
    const drainInbox = () => {
      for (const it of inbox?.take?.() ?? []) addQuestion({ via: it.via || 'web', source: 'inbox', ext_id: it.id, from: it.from, text: it.text, at: it.at });
    };
    if (inbox) timers.push(setInterval(drainInbox, 1000));

    // ---- wait for the founder (or "start now", or the wait running out)
    const waitUntil = Date.now() + waitMs;
    const someone = () => callers.size > 0 || roster.size > 0;
    while (!someone() && !startNow() && Date.now() < waitUntil && !ended) await sleep(1000);
    const started = someone() ? 'founder joined' : startNow() ? 'start now' : 'wait ran out';
    Object.assign(state, { status: 'live', started_at: new Date().toISOString(), started_because: started });
    onState({ ...state });
    log(`voice: meeting starts (${started})`);
    if (someone()) await sleep(2500); // let their audio settle before the first word

    // ---- speaking: one voice at a time, next line rendered while this one plays
    const prepare = (role, text) => {
      const parts = sentences(scrubIds(text));
      let chain = Promise.resolve();
      const rendered = parts.map((s) => (chain = chain.then(() => speech.render(role, s))));
      rendered.forEach((p) => p.catch(() => {}));
      return { role, text: scrubIds(text), parts, rendered };
    };
    let serving = false;
    const speak = async (line, { onFirstAudio = null } = {}) => {
      if (ended) return;
      const a = agents[line.role];
      transcript.push({ t: at(), speaker: line.role === 'chair' ? 'Chair' : nameOf(line.role), text: line.text, source: 'board' });
      for (let i = 0; i < line.parts.length; i++) {
        // Realtime: a waiting question takes the floor at the next sentence, not the next section.
        if (i > 0 && !serving && waiting()) {
          await serve();
          if (ended) return;
        }
        let pcm;
        try {
          pcm = await line.rendered[i];
        } catch (e) {
          log(`voice: could not render a line for ${line.role}: ${e.message}`);
          notes.push(`A line from ${line.role === 'chair' ? 'the chair' : nameOf(line.role)} could not be spoken (${e.message}); it is in the report.`);
          continue;
        }
        if (onFirstAudio) {
          onFirstAudio();
          onFirstAudio = null;
        }
        current = line.role;
        for (const k of sinks) k.add(pcm, Date.now());
        await a.link.play(pcm);
      }
      await sleep(gapMs);
      if (!serving && waiting()) await serve();
    };
    const say = (role, text, opts) => speak(prepare(role, text), opts);
    const recordQa = (q, answers, extra = {}) =>
      qa.push({
        at: q.at,
        via: q.via,
        from: q.from,
        question: q.text,
        routed_to: extra.routed_to ?? routeByKeywords(q.text),
        mode: qaMode,
        answers,
        ...(extra.summary ? { summary: extra.summary } : {}),
        ...(extra.latency_s != null ? { latency_s: extra.latency_s } : {}),
        ...(q.votes ? { votes: q.votes } : {}),
      });

    /** Realtime: the chair acknowledges, ONE member answers, the agenda goes on. */
    async function answerNow(q) {
      mark(q, 'answering');
      const to = q.responder;
      let firstAudio = null;
      await say('chair', script.ack(q, to), { onFirstAudio: () => (firstAudio = Date.now()) });
      let a = null;
      try {
        a = await q.answer;
      } catch (e) {
        log(`voice: no live answer for ${q.from}: ${e.message}`);
      }
      if (a?.text && !ended) {
        let answerAudio = null;
        await say(to, a.text, { onFirstAudio: () => (answerAudio = Date.now()) });
        const secs = Math.round(((answerAudio ?? Date.now()) - q.heardAt) / 100) / 10;
        log(`voice: answered ${q.from} in ${secs} s (first board audio after ${firstAudio ? ((firstAudio - q.heardAt) / 1000).toFixed(1) : '?'} s; ${to} on ${a.model ?? 'the model'}, ${((a.ms ?? 0) / 1000).toFixed(1)} s to write)`);
        recordQa(q, [{ expert: to, text: a.text }], { routed_to: to, latency_s: secs });
        mark(q, 'answered');
      } else if (!ended) {
        await say('chair', script.noAnswer);
        recordQa(q, [], { routed_to: to });
        mark(q, 'unanswered');
      }
    }

    /** Queued: the chair reads the question with who asked, the relevant members go round, the chair sums up. */
    async function groupRound(q) {
      mark(q, 'answering');
      const members = relevantMembers(q.text);
      const t = Date.now();
      // The members start thinking while the chair reads the question out; each answer is spoken
      // as soon as it is back, in board order.
      let speakChain = say('chair', script.groupOpen(q, members));
      const out = await groupAnswer(model, q, ctx(), {
        members,
        timeoutMs: liveTimeoutMs,
        limiter,
        log,
        onAnswer: (ans) => {
          speakChain = speakChain.then(() => say(ans.expert, ans.text));
        },
      }).catch(() => ({ answers: [], summary: null }));
      await speakChain;
      const good = out.answers.filter((x) => x.text);
      if (good.length) {
        if (out.summary) await say('chair', out.summary);
        log(`voice: answered ${q.from} as a group (${good.map((x) => x.expert).join(', ')}) in ${Math.round((Date.now() - t) / 1000)} s`);
        recordQa(q, good.map((x) => ({ expert: x.expert, text: x.text })), { routed_to: 'group', summary: out.summary });
        mark(q, 'answered');
      } else if (!ended) {
        await say('chair', script.noAnswer);
        recordQa(q, [], { routed_to: 'group' });
        mark(q, 'unanswered');
      }
    }

    /** At a line boundary: answer (realtime) or acknowledge (queued) whatever is waiting. */
    async function serve() {
      if (serving || ended) return;
      serving = true;
      try {
        if (qaMode === 'realtime') {
          for (let q = questions.find((x) => x.status === 'queued'); q && !ended; q = questions.find((x) => x.status === 'queued')) await answerNow(q);
        } else {
          const fresh = questions.filter((x) => x.status === 'queued' && !x.acked);
          if (fresh.length) {
            fresh.forEach((x) => (x.acked = true));
            await say('chair', script.noted(fresh));
          }
        }
      } finally {
        serving = false;
      }
    }

    /** Queued: take up to `n` questions now, the chair's pick first. */
    async function takeQueued(n = 1) {
      if (qaMode !== 'queued' || serving) return 0;
      let taken = 0;
      serving = true;
      try {
        for (let q = pickQuestion(questions, { current }); q && taken < n && !ended; q = pickQuestion(questions, { current })) {
          q.acked = true;
          await groupRound(q);
          taken++;
        }
      } finally {
        serving = false;
      }
      return taken;
    }

    /** Wait for a round without dead air: questions are taken while the board thinks. */
    const waitFor = async (promise) => {
      let done = false;
      let value;
      let error;
      promise.then(
        (v) => ((done = true), (value = v)),
        (e) => ((done = true), (error = e)),
      );
      let quiet = 0;
      let nudged = 0;
      while (!done && !ended) {
        if (waiting()) {
          await serve();
          quiet = 0;
        } else if (qaMode === 'queued' && (await takeQueued(1))) quiet = 0;
        else {
          await sleep(250);
          quiet += 250;
          if (quiet >= (nudged ? 45_000 : nudgeMs) && nudged < 4 && !done) {
            nudged++;
            quiet = 0;
            await say('chair', script.waiting);
          }
        }
      }
      if (error) throw error;
      return value;
    };

    // ---- the meeting
    await say('chair', script.intro(board.brief, { recorded: record, qaMode }));

    const verdicts = await waitFor(board.round1);
    let next = null;
    for (let i = 0; i < EXPERTS.length; i++) {
      const e = EXPERTS[i];
      const v = verdicts.find((x) => x.expert === e.id);
      const line = next?.role === e.id ? next : prepare(e.id, script.verdict(v));
      const n2 = EXPERTS[i + 1];
      next = n2 ? prepare(n2.id, script.verdict(verdicts.find((x) => x.expert === n2.id))) : null;
      await say('chair', script.callOn(e.id, i === 0));
      await speak(line);
    }
    await takeQueued(1);

    const debate = await waitFor(board.round2);
    await say('chair', script.debateOpen);
    for (const e of EXPERTS) {
      const d = debate.find((x) => x.expert === e.id);
      await say('chair', script.callOnDebate(e.id));
      await say(e.id, script.debate(d));
    }
    await takeQueued(1);

    if (qaMode === 'queued' && questions.some((q) => q.status === 'queued')) {
      await say('chair', script.qaSegment);
      await takeQueued(qaSegmentMax);
    }
    const meeting = await waitFor(board.minutes);
    await say('chair', script.minutes(meeting));
    await say('chair', script.finalCall);
    const lastCall = Date.now() + finalWaitMs;
    while (Date.now() < lastCall && !ended) {
      if (waiting()) await serve();
      else if (!(await takeQueued(1))) await sleep(250);
    }
    if (inbox) drainInbox();
    if (qaMode === 'queued') await takeQueued(qaSegmentMax);
    else await serve();
    await say('chair', script.close);
    for (const q of questions.filter((x) => x.status === 'queued' || x.status === 'answering')) {
      recordQa(q, []);
      mark(q, 'unanswered');
    }
    if (lostReason && !transcript.some((l) => l.source === 'board')) throw new Error(`the call was lost before the board spoke: ${lostReason}`);
    if (lostReason) notes.push(`The call was cut short: ${lostReason}. Everything said before then is in the recording; the report has the full minutes.`);
    const attendees = new Set([...[...roster.values()].map((p) => safeName(p.display_name)).filter(Boolean), ...[...callers].map(([idt, n]) => nameFor(idt, n))]);
    return {
      qa,
      transcript,
      notes,
      humans: [...attendees].map((name) => ({ name })),
      recording: mixer ? { pcm: mixer.render(), rate: SAMPLE_RATE, seconds: Math.round(mixer.durationSeconds) } : null,
      state: { ...state, status: 'ended', ended_at: new Date().toISOString() },
    };
  } finally {
    ended = true;
    for (const t of timers) clearInterval(t);
    await Promise.allSettled(ROLES.map((r) => (agents[r] ? pairux.leave(agents[r].participantId) : null)));
    await pairux.endSession(opened.sessionId).catch((e) => log(`voice: could not end the session: ${e.message}`));
    await Promise.allSettled(links.map((l) => l.close()));
    await speech.close().catch(() => {});
  }
}

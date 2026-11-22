// Live voice board meetings on PairUX.
//
// The board meets in an ordinary PairUX session: the founder joins it from the PairUX desktop
// app or the web/PWA with a normal join link; the chair and the five members join as PairUX
// agents and each speaks in its own Kokoro voice (rendered on c0mpute) over a microphone-only
// LiveKit track. This module is the floor manager: ONE process speaks for all six, so there is
// exactly one speaker at a time by construction (the OTR co-host bugs came from independent
// legs guessing who held the floor; here nobody guesses).
//
// The founder can interject by speaking (their track is transcribed by PairUX's self-hosted
// Whisper) or by typing in the room chat. The chair takes interjections at the next turn
// boundary, routes each to the most relevant member (or everyone), and the answer is spoken and
// returned as "Founder Q&A" for the report.
import { EXPERTS, nameOf, persona } from './experts.js';
import { generateWithPatience } from './llm.js';
import { Mixer } from './recording.js';
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

/** Pick who answers a founder question: a member id or 'all'. Keyword fallback when the model is slow. */
export function routeByKeywords(q) {
  const t = String(q).toLowerCase();
  const rules = [
    ['cfo', /\b(cash|money|cost|price|pricing|revenue|margin|runway|budget|afford|profit|burn|payback|roi|\$)/],
    ['growth', /\b(market|customer|audience|acquisition|growth|channel|brand|launch|sales|funnel|traffic|seo)/],
    ['operator', /\b(hire|hiring|team|process|system|delegat|ops\b|operation|execut|tool|automat)/],
    ['founder-time', /\b(time|hours|burnout|focus|week|energy|my day|calendar|family)\b/],
    ['contrarian', /\b(risk|wrong|worst|fail|downside|reverse|alternative|why not|devil)\b/],
  ];
  if (/\b(everyone|all of you|each of you|the board|whole board)\b/.test(t)) return 'all';
  for (const [id, re] of rules) if (re.test(t)) return id;
  return 'all';
}

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
  intro(brief, { recorded }) {
    const opts = brief.options.slice(0, 4).join('; or ');
    return [
      'Welcome. I am the chair of your AI board. The members are AI models, not real directors.',
      recorded ? 'This call is being recorded for your private report.' : '',
      `Today we decide: ${clip(brief.decision, 40)}`,
      `The options on the table: ${clip(opts, 50)}`,
      'Each member gives a verdict, then we debate, then I give the recommendation. You can interrupt by speaking or by typing in the chat, and I will take your question between speakers.',
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
  waiting: 'The members are still finishing their notes. One moment.',
};

/**
 * Run one live voice meeting. Resolves with { qa, transcript, recording, humans, notes }.
 *
 * board = { brief, round1: Promise<verdicts>, round2: Promise<debate>, minutes: Promise<meeting> }
 * onState(fields) persists the voice state (join link, status) so the web page, CLI and MCP see it.
 * startNow() is polled while waiting for the founder.
 * liveSink (optional) gets the same audio as the recorder, as it happens: { add(pcm, atMs), stream(trackId, pcm) }.
 */
export async function runVoiceMeeting({ id, board, record = true, pairux, speech, model, onState = () => {}, startNow = () => false, waitMs = 180_000, log = () => {}, liveSink = null, rtcModule = null, vadThreshold = 700, gapMs = 350, finalWaitMs = 25_000, connectTimeoutMs = 30_000 }) {
  const t0 = Date.now();
  const mixer = record ? new Mixer(SAMPLE_RATE, t0) : null;
  // Everything the recorder hears also goes to the live broadcast (src/live.js), when there is one.
  const sinks = [mixer, liveSink].filter(Boolean);
  const transcript = [];
  const qa = [];
  const notes = [];
  const queue = [];
  const humans = new Map();
  const links = [];
  const agents = {};
  let ended = false;
  const at = () => Math.round((Date.now() - t0) / 100) / 10;

  const subject = `Board meeting: ${sayable(board.brief.decision).slice(0, 90)}`;
  const opened = await pairux.openSession({
    subject: record ? `${subject} (recorded)` : subject,
    recorded: record,
    agents: ROLES.map((r) => ({ name: r === 'chair' && record ? 'Chair (AI) - recording' : AGENT_NAMES[r], client: 'board.saas' })),
  });
  ROLES.forEach((r, i) => (agents[r] = { participantId: opened.agents[i].participantId, name: opened.agents[i].name }));
  const agentIds = new Set(Object.values(agents).map((a) => a.participantId));
  const state = { status: 'waiting', session_id: opened.sessionId, join_url: opened.joinUrl, join_code: opened.joinCode, recorded: record, agents: ROLES.map((r) => ({ role: r, name: agents[r].name })), opened_at: new Date().toISOString() };
  onState(state);
  log(`voice: PairUX session ${opened.sessionId} open, join ${opened.joinUrl}`);

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
  try {
    // Six call connections, one microphone track each, each in its own process in production
    // (see agent-link.js for why). The chair also hears the founder: it is the board's ears
    // (and the recorder). Every attempt is time-boxed, so a connection that hangs fails the
    // call with a clear error instead of leaving it in "waiting".
    const vads = new Map();
    const onHuman = (identity, name) => {
      if (!humans.has(identity)) humans.set(identity, { name, at: new Date().toISOString() });
    };
    const onAudio = (identity, name, pcm) => {
      if (ended) return;
      let vad = vads.get(identity);
      if (!vad) {
        onHuman(identity, name);
        log(`voice: listening to ${name}`);
        vad = createVad({
          threshold: vadThreshold,
          onUtterance: async (utt) => {
            try {
              const { text } = await pairux.transcribe(encodeWav(utt, SAMPLE_RATE));
              const words = String(text || '').trim();
              if (words.split(/\s+/).length < 2) return;
              transcript.push({ t: at(), speaker: name, text: words, source: 'whisper' });
              queue.push({ via: 'voice', from: name, text: words, at: new Date().toISOString() });
              log(`voice: heard ${name}: ${words.slice(0, 120)}`);
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

    // Heartbeats keep every agent in the roster; the chair also reads chat and the roster.
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
          if (!humans.has(p.id)) humans.set(p.id, { name: p.display_name, at: new Date().toISOString() });
          if (record && !announced.has(p.id)) {
            announced.add(p.id);
            const m = await pairux.say(agents.chair.participantId, `Welcome, ${p.display_name}. This board call is recorded for the meeting owner's private report. The board members are AI. Ask a question any time by speaking or typing here.`).catch(() => null);
            if (m?.id) ourMessages.add(m.id);
          }
        }
        for (const m of r.messages ?? []) {
          if (ourMessages.has(m.id) || Object.values(agents).some((a) => a.name === m.display_name)) continue;
          if (m.message_type && m.message_type !== 'text') continue;
          const text = String(m.content || '').trim();
          if (!text) continue;
          transcript.push({ t: at(), speaker: m.display_name, text, source: 'chat' });
          queue.push({ via: 'chat', from: m.display_name, text, at: m.created_at });
          log(`voice: chat from ${m.display_name}: ${text.slice(0, 120)}`);
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

    // ---- wait for the founder (or "start now", or the wait running out)
    const waitUntil = Date.now() + waitMs;
    while (!humans.size && !startNow() && Date.now() < waitUntil && !ended) await sleep(1000);
    const started = humans.size ? 'founder joined' : startNow() ? 'start now' : 'wait ran out';
    Object.assign(state, { status: 'live', started_at: new Date().toISOString(), started_because: started });
    onState({ ...state });
    log(`voice: meeting starts (${started})`);
    if (humans.size) await sleep(2500); // let their audio settle before the first word

    // ---- speaking: one voice at a time, next line rendered while this one plays
    const prepare = (role, text) => {
      const parts = sentences(text);
      let chain = Promise.resolve();
      const rendered = parts.map((s) => (chain = chain.then(() => speech.render(role, s))));
      rendered.forEach((p) => p.catch(() => {}));
      return { role, text, parts, rendered };
    };
    const speak = async (line) => {
      if (ended) return;
      const a = agents[line.role];
      transcript.push({ t: at(), speaker: line.role === 'chair' ? 'Chair' : nameOf(line.role), text: line.text, source: 'board' });
      for (let i = 0; i < line.parts.length; i++) {
        let pcm;
        try {
          pcm = await line.rendered[i];
        } catch (e) {
          log(`voice: could not render a line for ${line.role}: ${e.message}`);
          notes.push(`A line from ${line.role === 'chair' ? 'the chair' : nameOf(line.role)} could not be spoken (${e.message}); it is in the report.`);
          continue;
        }
        for (const k of sinks) k.add(pcm, Date.now());
        await a.link.play(pcm);
      }
      await sleep(gapMs);
    };
    const say = (role, text) => speak(prepare(role, text));

    const waitFor = async (promise) => {
      let done = false;
      let value;
      let error;
      promise.then(
        (v) => ((done = true), (value = v)),
        (e) => ((done = true), (error = e)),
      );
      let nudged = 0;
      for (let waited = 0; !done; waited += 1000) {
        if (waited > 0 && waited % 45_000 === 0 && nudged < 4) {
          nudged++;
          await say('chair', script.waiting);
        }
        await takeQuestions();
        await sleep(1000);
      }
      if (error) throw error;
      return value;
    };

    async function answer(role, item) {
      const verdict = (await board.round1.catch(() => [])).find?.((v) => v.expert === role);
      const out = await generateWithPatience(
        model,
        {
          system: `${persona(role)}\n\nYou are on a live voice call with the founder. Answer in plain spoken English, at most 3 sentences, no lists, no markdown.`,
          user: `The decision: ${board.brief.decision}\nOptions: ${board.brief.options.join('; ')}\nConstraints: ${board.brief.constraints.join('; ') || 'none stated'}${verdict ? `\nYour verdict so far: ${verdict.call}` : ''}\n\nThe founder asks: ${item.text}\n\nAnswer them directly.`,
          maxTokens: 220,
          temperature: 0.4,
        },
        { patienceMs: 90_000, log },
      );
      return clip(out.text.replace(/<think>[\s\S]*?<\/think>/g, ''), role === 'chair' ? 60 : 70);
    }

    // Questions are acknowledged at once and answered when the answer is ready: the network
    // may be busy with the meeting's own rounds, and the call must not go silent waiting.
    const pendingAnswers = [];
    async function takeQuestions(limit = 3) {
      for (let n = 0; n < limit && queue.length && !ended; n++) {
        const item = queue.shift();
        const to = routeByKeywords(item.text);
        const targets = to === 'all' ? EXPERTS.map((e) => e.id) : [to];
        const p = { item, to, done: false, delivered: false, result: [] };
        p.promise = Promise.all(targets.map((r) => answer(r, item).then((text) => ({ expert: r, text })).catch((e) => ({ expert: r, text: null, error: e.message })))).then((r) => {
          p.result = r;
          p.done = true;
        });
        pendingAnswers.push(p);
        const who = item.from && item.from !== 'Founder' ? `${item.from} asks` : 'A question from the founder';
        await say('chair', `${who}: ${clip(item.text, 30)} ${to === 'all' ? 'I will take a quick answer from each member.' : `That one is for ${SHORT[to]}.`} ${p.done ? '' : 'The answer comes at the next pause.'}`);
        await deliverAnswers();
      }
      await deliverAnswers();
    }
    async function deliverAnswers() {
      for (const p of pendingAnswers) {
        if (!p.done || p.delivered || ended) continue;
        p.delivered = true;
        const answers = p.result.filter((a) => a.text);
        if (answers.length) {
          await say('chair', p.to === 'all' ? `On the question: ${clip(p.item.text, 18)}` : `${SHORT[p.to]}, on the question: ${clip(p.item.text, 18)}`);
          for (const a of answers) await say(a.expert, p.to === 'all' ? clip(a.text, 35) : a.text);
        } else await say('chair', 'The board could not get an answer to that question from the network right now. It is noted in your report.');
        qa.push({ at: p.item.at, via: p.item.via, from: p.item.from, question: p.item.text, routed_to: p.to, answers: answers.map((a) => ({ expert: a.expert, text: a.text })) });
      }
    }
    async function finishAnswers(maxMs = 150_000) {
      const until = Date.now() + maxMs;
      while (pendingAnswers.some((p) => !p.delivered) && Date.now() < until && !ended) {
        await deliverAnswers();
        await sleep(1000);
      }
      for (const p of pendingAnswers.filter((x) => !x.delivered)) {
        p.delivered = true;
        qa.push({ at: p.item.at, via: p.item.via, from: p.item.from, question: p.item.text, routed_to: p.to, answers: [] });
      }
    }

    // ---- the meeting
    await say('chair', script.intro(board.brief, { recorded: record }));
    await takeQuestions();

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
      await takeQuestions();
    }

    const debate = await waitFor(board.round2);
    await say('chair', script.debateOpen);
    for (const e of EXPERTS) {
      const d = debate.find((x) => x.expert === e.id);
      await say('chair', script.callOnDebate(e.id));
      await say(e.id, script.debate(d));
      await takeQuestions();
    }

    const meeting = await waitFor(board.minutes);
    await say('chair', script.minutes(meeting));
    await takeQuestions();
    await say('chair', script.finalCall);
    const lastCall = Date.now() + finalWaitMs;
    while (Date.now() < lastCall && !ended) {
      await takeQuestions();
      await sleep(1000);
    }
    if (pendingAnswers.some((p) => !p.delivered)) await say('chair', 'One moment while the last answer comes back.');
    await finishAnswers();
    await say('chair', script.close);
    if (lostReason && !transcript.some((l) => l.source === 'board')) throw new Error(`the call was lost before the board spoke: ${lostReason}`);
    if (lostReason) notes.push(`The call was cut short: ${lostReason}. Everything said before then is in the recording; the report has the full minutes.`);
    return {
      qa,
      transcript,
      notes,
      humans: [...humans.values()],
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

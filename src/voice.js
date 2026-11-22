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
import { loadRtc } from './rtc.js';
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
const FRAME = SAMPLE_RATE / 50; // 20 ms

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
      `Here is where the board landed. ${m.majority} The strongest dissent came from ${SHORT[m.dissent.expert] ?? 'a member'}: ${m.dissent.argument} My recommendation: ${m.recommendation} And the one question you still need to answer: ${m.question}`,
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
 */
export async function runVoiceMeeting({ id, board, record = true, pairux, speech, model, onState = () => {}, startNow = () => false, waitMs = 180_000, log = () => {}, rtcModule = null, vadThreshold = 700, gapMs = 350, finalWaitMs = 25_000 }) {
  const rtc = rtcModule ?? loadRtc();
  const t0 = Date.now();
  const mixer = record ? new Mixer(SAMPLE_RATE, t0) : null;
  const transcript = [];
  const qa = [];
  const notes = [];
  const queue = [];
  const humans = new Map();
  const rooms = [];
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
  try {
    // Six LiveKit connections, one microphone track each. Only the chair subscribes: it is
    // the board's ears for the founder (and the recorder).
    for (const role of ROLES) {
      const a = agents[role];
      const tok = await pairux.voiceToken(a.participantId);
      const room = new rtc.Room();
      await room.connect(tok.url, tok.token, { autoSubscribe: role === 'chair', dynacast: false });
      const source = new rtc.AudioSource(SAMPLE_RATE, 1);
      const track = rtc.LocalAudioTrack.createAudioTrack(`${role}-voice`, source);
      const opts = new rtc.TrackPublishOptions();
      opts.source = rtc.TrackSource.SOURCE_MICROPHONE;
      // Under load the SFU sometimes misses one publication; try again before giving up.
      for (let attempt = 1; ; attempt++) {
        try {
          await room.localParticipant.publishTrack(track, opts);
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          log(`voice: ${role} publish attempt ${attempt} failed (${e.message}); retrying`);
          await sleep(1000);
        }
      }
      a.room = room;
      a.source = source;
      rooms.push(room);
    }
    log('voice: six agents connected and publishing');

    // The founder's audio: recorded, and turned into interjections.
    const chairRoom = agents.chair.room;
    const listen = async (track, participant) => {
      if (agentIds.has(participant.identity) || track.kind !== rtc.TrackKind.KIND_AUDIO) return;
      const who = participant.name || 'Founder';
      humans.set(participant.identity, { name: who, at: new Date().toISOString() });
      log(`voice: listening to ${who}`);
      const vad = createVad({
        threshold: vadThreshold,
        onUtterance: async (pcm) => {
          try {
            const { text } = await pairux.transcribe(encodeWav(pcm, SAMPLE_RATE));
            const words = String(text || '').trim();
            if (words.split(/\s+/).length < 2) return;
            transcript.push({ t: at(), speaker: who, text: words, source: 'whisper' });
            queue.push({ via: 'voice', from: who, text: words, at: new Date().toISOString() });
            log(`voice: heard ${who}: ${words.slice(0, 120)}`);
          } catch (e) {
            log(`voice: transcription failed: ${e.message}`);
          }
        },
      });
      const stream = new rtc.AudioStream(track, SAMPLE_RATE, 1);
      for await (const frame of stream) {
        if (ended) break;
        mixer?.stream(participant.identity, frame.data);
        vad(frame.data);
      }
    };
    chairRoom.on(rtc.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      listen(track, participant).catch((e) => log(`voice: listener stopped: ${e.message}`));
    });
    chairRoom.on(rtc.RoomEvent.ParticipantConnected, (p) => {
      if (!agentIds.has(p.identity)) humans.set(p.identity, humans.get(p.identity) ?? { name: p.name || 'Founder', at: new Date().toISOString() });
    });

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
        if (e.status === 410) ended = true;
      }
    };
    timers.push(setInterval(pollChair, 2500));
    timers.push(
      setInterval(() => {
        for (const r of ROLES.slice(1)) pairux.poll(agents[r].participantId).catch(() => {});
      }, 30_000),
    );
    await pollChair();

    // ---- wait for the founder (or "start now", or the wait running out)
    const waitUntil = Date.now() + waitMs;
    while (!humans.size && !startNow() && Date.now() < waitUntil && !ended) await sleep(1000);
    const started = humans.size ? 'founder joined' : startNow() ? 'start now' : 'wait ran out';
    onState({ ...state, status: 'live', started_at: new Date().toISOString(), started_because: started });
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
        mixer?.add(pcm, Date.now());
        for (let o = 0; o + 1 <= pcm.length; o += FRAME) {
          const n = Math.min(FRAME, pcm.length - o);
          await a.source.captureFrame(new rtc.AudioFrame(pcm.slice(o, o + n), SAMPLE_RATE, 1, n));
        }
        await a.source.waitForPlayout();
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

    async function takeQuestions(limit = 3) {
      for (let n = 0; n < limit && queue.length && !ended; n++) {
        const item = queue.shift();
        const to = routeByKeywords(item.text);
        const targets = to === 'all' ? EXPERTS.map((e) => e.id) : [to];
        const ack = `${item.from === 'Founder' ? 'A question' : `${item.from} asks`}: ${clip(item.text, 30)} ${to === 'all' ? 'I will take a quick answer from each member.' : `${SHORT[to]}, that one is yours.`}`;
        const pending = targets.map((r) => answer(r, item).then((text) => ({ expert: r, text })).catch((e) => ({ expert: r, text: null, error: e.message })));
        await say('chair', ack);
        const answers = [];
        for (const p of pending) {
          const a = await p;
          if (a.text) {
            await say(a.expert, to === 'all' ? clip(a.text, 35) : a.text);
            answers.push({ expert: a.expert, text: a.text });
          }
        }
        if (!answers.length) await say('chair', 'The board could not get an answer to that from the network right now. It is noted in your report.');
        qa.push({ at: item.at, via: item.via, from: item.from, question: item.text, routed_to: to, answers });
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
      if (queue.length) await takeQuestions();
      await sleep(1000);
    }
    await say('chair', script.close);
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
    await Promise.allSettled(rooms.map((r) => r.disconnect()));
    await speech.close().catch(() => {});
  }
}

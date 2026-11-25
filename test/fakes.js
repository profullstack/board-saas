// Stand-ins shared by the voice and publishing tests: the c0mpute model, @livekit/rtc-node,
// the PairUX partner API and the speech worker.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const fixture = JSON.parse(readFileSync(new URL('./fixture-meeting.json', import.meta.url), 'utf8'));

export function fakeModel() {
  const calls = [];
  return {
    calls,
    models: ['fake'],
    async generate(req) {
      calls.push(req);
      const u = req.user;
      if (u.includes('pull out the three things')) return { text: JSON.stringify({ decision: 'Next hire', options: ['A video editor', 'No hire yet'], constraints: ['$3,000 a month'], missing: [] }), model: 'fake' };
      const id = (u.match(/"expert":"([a-z-]+)"/) ?? [])[1];
      if (u.includes('Board meeting, round 3')) {
        const { vote, ...rest } = fixture.minutes;
        return { text: JSON.stringify({ title: fixture.title, ...rest }), model: 'fake' };
      }
      if (u.includes('Board meeting, round 1')) return { text: JSON.stringify(fixture.verdicts.find((v) => v.expert === id)), model: 'fake' };
      if (u.includes('Board meeting, round 2')) return { text: JSON.stringify(fixture.debate.find((v) => v.expert === id)), model: 'fake' };
      if (u.includes('Your one-line summary')) return { text: 'The board says: protect the runway first, then hire.', model: 'fake' };
      if (/ asks: /.test(u)) return { text: 'Keep the cash for six months of runway first, then hire. That is my answer.', model: 'fake' };
      throw new Error(`unexpected prompt: ${u.slice(0, 80)}`);
    },
  };
}

/** A stand-in for @livekit/rtc-node: records what each agent publishes; the founder's track plays `humanPcm`. */
export function fakeRtc({ humanPcm = null, human: who = { identity: 'human-1', name: 'Anthony' } } = {}) {
  const spoken = [];
  class Room {
    constructor() {
      this.handlers = {};
      this.localParticipant = { publishTrack: async (track) => (this.track = track) };
    }
    on(ev, fn) {
      this.handlers[ev] = fn;
    }
    async connect(url, token, opts) {
      this.identity = token;
      assert.equal(opts.autoSubscribe, false, 'agents subscribe by hand, after publishing');
      this.remoteParticipants = new Map();
      if (humanPcm) {
        // The founder is already in the room with a microphone track; subscribing delivers it.
        const human = { ...who };
        let subscribed = false;
        const pub = { kind: 1, setSubscribed: (v) => { if (v && !subscribed) { subscribed = true; setTimeout(() => this.handlers.trackSubscribed?.({ kind: 1, pcm: humanPcm }, pub, human), 10); } } };
        human.trackPublications = new Map([['TR_1', pub]]);
        this.remoteParticipants.set(human.identity, human);
      }
    }
    async disconnect() {}
  }
  class AudioSource {
    constructor(rate) {
      this.rate = rate;
    }
    async captureFrame(frame) {
      spoken.push({ source: this, samples: frame.samplesPerChannel });
    }
    async waitForPlayout() {}
  }
  class AudioStream {
    constructor(track) {
      this.track = track;
    }
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < this.track.pcm.length; i += 480) yield { data: this.track.pcm.subarray(i, i + 480) };
    }
  }
  return {
    spoken,
    Room,
    AudioSource,
    AudioStream,
    AudioFrame: class {
      constructor(data, rate, ch, n) {
        this.data = data;
        this.samplesPerChannel = n;
      }
    },
    LocalAudioTrack: { createAudioTrack: (name, src) => ({ name, src }) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 2 },
    TrackKind: { KIND_AUDIO: 1 },
    RoomEvent: { TrackSubscribed: 'trackSubscribed', TrackPublished: 'trackPublished', ParticipantConnected: 'participantConnected' },
  };
}

export function fakePairux({ chat = 'What does this cost us in cash?', participants = [{ id: 'human-1', display_name: 'Anthony', kind: 'human' }], transcript = 'Should we raise prices before hiring?', questions = null } = {}) {
  const log = { opened: null, said: [], ended: false, left: [], transcribed: 0, updated: [] };
  let polls = 0;
  return {
    log,
    configured: true,
    async openSession(body) {
      log.opened = body;
      return { sessionId: 'sess-1', joinCode: 'ABC123', joinUrl: 'https://pairux.com/join/ABC123', roomName: 'session-sess-1', agents: body.agents.map((a, i) => ({ participantId: `agent-${i}`, name: a.name })) };
    },
    async voiceToken(pid) {
      return { url: 'wss://sfu.test', token: pid };
    },
    async poll(pid) {
      if (pid !== 'agent-0') return {};
      polls++;
      return {
        serverTime: new Date().toISOString(),
        participants,
        messages: polls === 2 && chat ? [{ id: 'm1', display_name: participants[0]?.display_name ?? 'Anthony', content: chat, message_type: 'text', created_at: new Date().toISOString() }] : [],
        ...(questions ? { questions: typeof questions === 'function' ? questions(polls) : questions } : {}),
      };
    },
    async say(pid, content) {
      log.said.push(content);
      return { id: `said-${log.said.length}` };
    },
    async leave(pid) {
      log.left.push(pid);
    },
    async updateQuestion(pid, qid, patch) {
      log.updated.push({ qid, ...patch });
      return {};
    },
    async endSession() {
      log.ended = true;
    },
    async transcribe() {
      log.transcribed++;
      return { text: transcript };
    },
  };
}

export const fakeSpeech = () => {
  const lines = [];
  return {
    lines,
    async render(role, text) {
      lines.push({ role, text });
      return new Int16Array(2400).fill(1000);
    },
    async close() {},
  };
};

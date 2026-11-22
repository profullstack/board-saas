// One board member's connection to the call: a LiveKit room with one microphone track, and for
// the chair also the founder's audio coming back. Two ways to run it, same interface:
//
//   inProcessLink(rtc, opts)  the room lives in this process (tests use a fake rtc module)
//   childLink(opts)           the room lives in its own child process (production)
//
// Why child processes: @livekit/rtc-node is unreliable with several rooms in one process. Live
// on dev2 the second room's publication went unanswered ("track publication timed out") and its
// third connect never reached the SFU at all, so the call sat in "waiting"; earlier, a room that
// subscribed after other rooms were created never bound its track. One room per process has
// published and subscribed every time.
//
// link = { play(pcm Int16Array 24 kHz) -> Promise (resolves when played out), close() }
// opts = { url, token, role, subscribe, agentIds:Set, onAudio(identity, name, pcm), onHuman(identity, name), log }
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 24000;
const FRAME = SAMPLE_RATE / 50; // 20 ms

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms).unref?.())]);

export async function inProcessLink(rtc, { url, token, role, subscribe = false, agentIds = new Set(), onAudio = () => {}, onHuman = () => {}, log = () => {}, connectTimeoutMs = 25_000 }) {
  const room = new rtc.Room();
  const timers = [];
  let closed = false;
  try {
    await withTimeout(room.connect(url, token, { autoSubscribe: false, dynacast: false }), connectTimeoutMs, `${role}: connecting to the SFU`);
    const source = new rtc.AudioSource(SAMPLE_RATE, 1);
    const track = rtc.LocalAudioTrack.createAudioTrack(`${role}-voice`, source);
    const opts = new rtc.TrackPublishOptions();
    opts.source = rtc.TrackSource.SOURCE_MICROPHONE;
    await withTimeout(room.localParticipant.publishTrack(track, opts), connectTimeoutMs, `${role}: publishing the microphone`);

    if (subscribe) {
      const listening = new Set();
      room.on(rtc.RoomEvent.TrackSubscribed, (t, pub, participant) => {
        const k = pub?.sid ?? `${participant.identity}:${t.sid ?? ''}`;
        if (listening.has(k) || agentIds.has(participant.identity) || t.kind !== rtc.TrackKind.KIND_AUDIO) return;
        listening.add(k);
        const name = participant.name || 'Founder';
        onHuman(participant.identity, name);
        (async () => {
          const stream = new rtc.AudioStream(t, SAMPLE_RATE, 1);
          for await (const frame of stream) {
            if (closed) break;
            onAudio(participant.identity, name, frame.data);
          }
        })().catch((e) => log(`voice: listener stopped: ${e.message}`));
      });
      const asked = new Set();
      const hear = (pub, participant) => {
        if (!pub || agentIds.has(participant.identity) || pub.kind !== rtc.TrackKind.KIND_AUDIO || pub.subscribed) return;
        const k = `${pub.sid}:${Math.floor(Date.now() / 10_000)}`; // ask again every 10 s until it binds
        if (asked.has(k)) return;
        asked.add(k);
        try {
          pub.setSubscribed(true);
          log(`voice: subscribing to ${participant.name || participant.identity}`);
        } catch (e) {
          log(`voice: could not subscribe to ${participant.name}: ${e.message}`);
        }
      };
      room.on(rtc.RoomEvent.TrackPublished, hear);
      room.on(rtc.RoomEvent.ParticipantConnected, (p) => {
        if (!agentIds.has(p.identity)) onHuman(p.identity, p.name || 'Founder');
      });
      const sweep = () => {
        for (const p of room.remoteParticipants?.values?.() ?? []) for (const pub of p.trackPublications?.values?.() ?? []) hear(pub, p);
      };
      sweep();
      timers.push(setInterval(sweep, 3000));
    }

    return {
      async play(pcm) {
        for (let o = 0; o < pcm.length; o += FRAME) {
          const n = Math.min(FRAME, pcm.length - o);
          await source.captureFrame(new rtc.AudioFrame(pcm.slice(o, o + n), SAMPLE_RATE, 1, n));
        }
        await source.waitForPlayout();
      },
      async close() {
        closed = true;
        for (const t of timers) clearInterval(t);
        await room.disconnect().catch(() => {});
      },
    };
  } catch (e) {
    closed = true;
    for (const t of timers) clearInterval(t);
    await room.disconnect().catch(() => {});
    throw e;
  }
}

const CHILD = fileURLToPath(new URL('./voice-agent-child.js', import.meta.url));

/** The same link with the room in its own process. */
export function childLink({ url, token, role, subscribe = false, agentIds = new Set(), onAudio = () => {}, onHuman = () => {}, log = () => {}, connectTimeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, NODE_ENV: 'production' } });
    let ready = false;
    let seq = 0;
    const pending = new Map();
    const fail = (e) => {
      for (const p of pending.values()) p.reject(e);
      pending.clear();
    };
    const timer = setTimeout(() => {
      if (ready) return;
      child.kill('SIGKILL');
      reject(new Error(`${role}: the call connection did not come up in ${Math.round(connectTimeoutMs / 1000)} s`));
    }, connectTimeoutMs + 5000);
    child.on('message', (m) => {
      if (m.t === 'ready') {
        ready = true;
        clearTimeout(timer);
        resolve({
          play(pcm) {
            const id = ++seq;
            return new Promise((res, rej) => {
              pending.set(id, { resolve: res, reject: rej });
              child.send({ t: 'play', id, pcm });
            });
          },
          close() {
            return new Promise((res) => {
              if (child.exitCode !== null) return res();
              const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
              child.once('exit', () => (clearTimeout(kill), res()));
              child.send({ t: 'close' });
            });
          },
        });
      } else if (m.t === 'error') {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error(m.message));
      } else if (m.t === 'played') {
        pending.get(m.id)?.resolve();
        pending.delete(m.id);
      } else if (m.t === 'audio') onAudio(m.identity, m.name, m.pcm);
      else if (m.t === 'human') onHuman(m.identity, m.name);
      else if (m.t === 'log') log(m.message);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fail(new Error(`${role}: call connection process exited (${signal ?? code})`));
      if (!ready) reject(new Error(`${role}: call connection process exited before it was ready (${signal ?? code})`));
    });
    child.send({ t: 'init', url, token, role, subscribe, agentIds: [...agentIds], connectTimeoutMs });
  });
}

// Live listening over c0mpute Live.
//
// When a voice meeting starts and BOARD_C0MPUTE_KEY is set, this server opens an UNLISTED
// c0mpute stream, mixes in real time the same audio the recorder collects (each board member's
// speech as it plays, plus the founder's microphone), and pushes it with ffmpeg to the stream's
// RTMP publish URL: AAC audio plus a tiny black video track, so every HLS player accepts it.
// People with a listen or join invite (or the public page of a public meeting) get an HLS
// player pointed at the stream's playback URL.
//
// What "unlisted" means, plainly: the stream is not on c0mpute.com/live, and its id is random,
// but it is NOT encrypted and c0mpute does not check who plays it. Anyone who learns the
// playback URL can listen while the meeting runs. The board share token (server-checked,
// expiring, revocable) gates the PAGE that reveals the URL; it cannot recall a URL somebody
// already has. The stream is deleted when the meeting ends, so the URL goes dead then.
//
// The stream key (and the publish URL that contains it) lives only in this process's memory:
// it is never stored, logged, or put on a page.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/** The c0mpute stream name for a meeting: stable (a restart finds the same stream) and not the meeting id. */
export const streamNameFor = (meetingId) => `board-${createHash('sha256').update(`board-saas live:${meetingId}`).digest('hex').slice(0, 20)}`;

export function createLive({ key, url = 'https://c0mpute.com', fetchImpl = fetch, spawnImpl = spawn, ffmpeg = process.env.FFMPEG || 'ffmpeg', log = () => {} } = {}) {
  const base = String(url).replace(/\/+$/, '');

  async function call(method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000), // the call waits on this, so keep it short
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : '');
      const e = new Error(`c0mpute live ${method} ${path.replace(/streams\/[^/]+/, 'streams/:id')}: ${res.status} ${msg}`.trim());
      e.status = res.status;
      throw e;
    }
    return j;
  }

  /**
   * Open the meeting's unlisted stream. -> { id, publish_url, playback_url, watch_url }.
   * A 409 means the stream already exists (this meeting was started before a restart): find it
   * by name and take a new key, which also cuts off whoever held the old one.
   */
  async function open({ name, title }) {
    try {
      const s = await call('POST', '/api/v1/live/streams', { name, title: String(title || 'Board meeting').slice(0, 120), visibility: 'unlisted' });
      return { id: s.id, publish_url: s.publish_url, playback_url: s.playback_url, watch_url: s.watch_url };
    } catch (e) {
      if (e.status !== 409) throw e;
    }
    const list = await call('GET', '/api/v1/live/streams');
    const found = (list.streams ?? []).find((s) => s.name === name);
    if (!found) throw new Error('c0mpute live: the stream name is taken but the stream is not listed for this key');
    const k = await call('POST', `/api/v1/live/streams/${encodeURIComponent(found.id)}/key`);
    return { id: found.id, publish_url: k.publish_url, playback_url: found.playback_url, watch_url: found.watch_url };
  }

  /** Delete the stream: its key and its playback URL stop working. Accounts hold at most 50 streams. */
  const remove = (id) => call('DELETE', `/api/v1/live/streams/${encodeURIComponent(id)}`);

  return {
    configured: !!key,
    open,
    remove,
    broadcast: (publishUrl, opts = {}) => createBroadcast({ publishUrl, spawnImpl, ffmpeg, log, ...opts }),
  };
}

/**
 * ffmpeg: raw PCM on stdin + a 320x180 black picture -> H.264/AAC in FLV over RTMP.
 * Measured with ffmpeg 8 writing FLV to a file: without -probesize/-analyzeduration ffmpeg sat on
 * the pipe for about 5 s before sending anything; without -re on the picture, its timestamps ran
 * ahead of the audio and the lead grew with time. With both, output starts inside a second and
 * the picture stays a constant fraction of a second ahead. The picture never ends, so ffmpeg is
 * stopped with SIGTERM after stdin closes (see stop()).
 */
export function ffmpegArgs(publishUrl, rate = 24000) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostats',
    '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0',
    '-re', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=5',
    '-map', '0:a', '-map', '1:v',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-g', '10', '-b:v', '40k', '-maxrate', '60k', '-bufsize', '120k',
    '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '1',
    '-flush_packets', '1', '-f', 'flv', publishUrl,
  ];
}

/**
 * A real-time mix that feeds ffmpeg. It has the Mixer's two inputs, so the voice runner can
 * hand both the same audio:
 *   add(pcm, atMs)             a whole clip that starts at wall time atMs (a board member's line)
 *   stream(trackId, pcm, atMs) the next frame of a live track (the founder's microphone)
 * Every `tickMs` it writes the samples for the wall-clock time that has passed (silence
 * included), `delayMs` behind real time so late frames still land. If ffmpeg exits before
 * stop(), it is started again; audio during the gap is dropped, never buffered without bound.
 */
export function createBroadcast({ publishUrl, rate = 24000, spawnImpl = spawn, ffmpeg = 'ffmpeg', log = () => {}, tickMs = 100, delayMs = 400, restartMs = 2000, maxRestarts = 30, now = () => Date.now() }) {
  const t0 = now();
  const secret = String(publishUrl).split('/').pop();
  const redact = (s) => (secret ? String(s).split(secret).join('<stream key>') : String(s));
  let segments = [];
  const tracks = new Map();
  let emitted = 0; // samples already written, from t0
  let proc = null;
  let writable = false;
  let stopped = false;
  let restarts = 0;
  let restartTimer = null;
  let errTail = '';
  const sampleAt = (ms) => Math.max(0, Math.round(((ms - t0) / 1000) * rate));

  function start() {
    if (stopped) return;
    errTail = '';
    let p;
    try {
      p = spawnImpl(ffmpeg, ffmpegArgs(publishUrl, rate), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      log(`live: ffmpeg could not start: ${redact(e.message)}`);
      return retry();
    }
    proc = p;
    writable = true;
    // Drain stderr always: a full pipe would block ffmpeg. Keep only a short tail for the log.
    p.stderr?.on('data', (c) => (errTail = (errTail + c).slice(-600)));
    p.stdin?.on('error', () => (writable = false));
    p.stdin?.on('drain', () => (writable = true));
    p.on('error', (e) => {
      if (proc === p) {
        proc = null;
        log(`live: ffmpeg error: ${redact(e.message)}`);
        retry();
      }
    });
    p.on('close', (code) => {
      if (proc !== p) return;
      proc = null;
      if (stopped) return;
      log(`live: ffmpeg exited ${code}${errTail ? `: ${redact(errTail).replace(/\s+/g, ' ').slice(-300)}` : ''}`);
      retry();
    });
  }
  function retry() {
    if (stopped || restartTimer) return;
    if (++restarts > maxRestarts) return log('live: giving up on the live stream after too many restarts; the meeting and its recording are unaffected');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, restartMs);
    restartTimer.unref?.();
  }

  function tick(final = false) {
    const target = sampleAt(now() - (final === true ? 0 : delayMs));
    if (target <= emitted) return;
    const len = target - emitted;
    const acc = new Int32Array(len);
    const keep = [];
    for (const s of segments) {
      const end = s.at + s.pcm.length;
      if (end > emitted && s.at < target) {
        const from = Math.max(s.at, emitted);
        const to = Math.min(end, target);
        for (let i = from; i < to; i++) acc[i - emitted] += s.pcm[i - s.at];
      }
      if (end > target) keep.push(s);
    }
    segments = keep;
    emitted = target;
    if (!proc || !writable) return; // ffmpeg is down or behind: drop this slice
    const out = Buffer.alloc(len * 2);
    for (let i = 0; i < len; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, acc[i])), i * 2);
    try {
      if (!proc.stdin.write(out)) writable = false;
    } catch {
      writable = false;
    }
  }

  start();
  const timer = setInterval(() => tick(), tickMs);
  timer.unref?.();

  return {
    add(pcm, atMs = now()) {
      if (!stopped) segments.push({ at: sampleAt(atMs), pcm });
    },
    stream(trackId, pcm, atMs = now()) {
      if (stopped) return;
      const wall = sampleAt(atMs);
      let next = tracks.get(trackId);
      if (next === undefined || Math.abs(wall - next) > rate / 2) next = wall;
      segments.push({ at: next, pcm: Int16Array.from(pcm) });
      tracks.set(trackId, next + pcm.length);
    },
    tick,
    get restarts() {
      return restarts;
    },
    /** Flush what is due, close ffmpeg's input, and make sure it is gone. */
    async stop() {
      if (stopped) return;
      tick(true); // everything up to now, without the look-behind
      stopped = true;
      clearInterval(timer);
      if (restartTimer) clearTimeout(restartTimer);
      const p = proc;
      if (!p) return;
      await new Promise((resolve) => {
        // The picture input never ends, so closing stdin does not stop ffmpeg by itself:
        // SIGTERM makes it finish the stream cleanly, SIGKILL is the last resort.
        const term = setTimeout(() => p.kill?.('SIGTERM'), 1500);
        const kill = setTimeout(() => p.kill?.('SIGKILL'), 4000);
        const giveUp = setTimeout(resolve, 6000);
        for (const t of [term, kill, giveUp]) t.unref?.();
        p.on('close', () => {
          for (const t of [term, kill, giveUp]) clearTimeout(t);
          resolve();
        });
        try {
          p.stdin.end();
        } catch {
          /* already closed */
        }
      });
    },
  };
}

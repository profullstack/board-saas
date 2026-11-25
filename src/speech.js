// Text to speech on c0mpute: Kokoro through the speech gateway's warm sessions
// (POST /v1/sessions pins a worker with Kokoro loaded, /v1/sessions/<id>/say renders one
// line with no auction and no reload). Free, open source, our own metal. No paid TTS path.
//
// Each board member has its own Kokoro voice, the six the gateway serves:
export const VOICES = {
  chair: 'am_onyx',
  cfo: 'af_sarah',
  growth: 'af_bella',
  operator: 'am_echo',
  'founder-time': 'af_nicole',
  contrarian: 'am_michael',
};

export const SAMPLE_RATE = 24000;

/** Parse a 16-bit PCM mono WAV into { pcm: Int16Array, sampleRate }. */
export function decodeWav(buf) {
  const b = Buffer.from(buf);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let sampleRate = SAMPLE_RATE;
  let channels = 1;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(off + 10);
      sampleRate = b.readUInt32LE(off + 12);
    } else if (id === 'data') {
      const end = Math.min(b.length, off + 8 + size);
      const body = b.subarray(off + 8, end);
      const all = new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + (body.length - (body.length % 2))));
      if (channels === 1) return { pcm: all, sampleRate };
      const mono = new Int16Array(Math.floor(all.length / channels));
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * channels];
      return { pcm: mono, sampleRate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** 16-bit PCM mono WAV bytes. */
export function encodeWav(pcm, sampleRate = SAMPLE_RATE) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * Kokoro renders quietly (peak about -10 dBFS, RMS about -25 dBFS), too soft next to a person
 * on a call. Lift each line to RMS -18 dBFS under a -1 dBFS ceiling, at most +20 dB.
 */
export function levelPcm(pcm) {
  let sum = 0;
  let peak = 1;
  for (const v of pcm) {
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, pcm.length)) || 1;
  const target = 32767 * 10 ** (-18 / 20);
  const ceiling = 32767 * 10 ** (-1 / 20);
  const gain = Math.min(target / rms, ceiling / peak, 10);
  if (gain <= 1.01) return pcm;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
  return out;
}

/** Split text into sentences, so the first one plays while the rest render. */
export function sentences(text) {
  const parts = String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g);
  if (!parts) return [];
  // Kokoro's prosody wants whole clauses: merge fragments under 40 characters.
  const out = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length < 40 || p.length < 12)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

/** Words a voice should not read out: URLs, markdown, ids. */
export function sayable(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|]/g, '')
    .replace(/\s*\([^)]*framework[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim spoken text to about `words` words, ending on a sentence where possible. */
export function clip(text, words) {
  const w = sayable(text).split(' ');
  if (w.length <= words) return w.join(' ');
  const cut = w.slice(0, words).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > cut.length * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/[,;:]$/, '')}.`;
}

/**
 * createSpeech({ url, token }) -> { say(role, text) -> Int16Array at 24 kHz, close() }.
 * Opens one warm session per voice on first use and reopens it if the gateway forgot it.
 */
export function createSpeech({ url, token, fetchImpl = fetch, log = () => {} }) {
  const base = String(url || '').replace(/\/+$/, '');
  const sessions = new Map();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function open(voice) {
    const res = await fetchImpl(`${base}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ engine: 'kokoro', voice }), signal: AbortSignal.timeout(120_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.session) throw new Error(`c0mpute speech: could not open a ${voice} session (${res.status} ${j.error ?? ''})`.trim());
    log(`speech: warm ${voice} session in ${j.load_ms ?? '?'} ms`);
    return j.session;
  }

  function session(voice) {
    if (!sessions.has(voice)) {
      const p = open(voice);
      sessions.set(voice, p);
      p.catch(() => sessions.delete(voice));
    }
    return sessions.get(voice);
  }

  async function renderOne(voice, text, retry = true) {
    const id = await session(voice);
    const res = await fetchImpl(`${base}/v1/sessions/${id}/say`, { method: 'POST', headers, body: JSON.stringify({ text }), signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      // The gateway forgot the session (404) or its warm worker died (502: "session is gone",
      // "exited mid-utterance", "did not answer in time"):
      // open a fresh session for this voice and say the line once more.
      // "could not read the synthesized audio" / "could not say it": the gateway dropped the warm worker
      // under this session (c0mpute#508); a fresh session gets a fresh worker.
      if (retry && (res.status === 404 || /session is gone|reopen|exited mid-utterance|closed its input|did not answer in time|could not read the synthesized audio|could not say it/i.test(detail))) {
        sessions.delete(voice);
        return renderOne(voice, text, false);
      }
      throw new Error(`c0mpute speech: ${res.status} ${detail}`);
    }
    const { pcm, sampleRate } = decodeWav(Buffer.from(await res.arrayBuffer()));
    if (sampleRate !== SAMPLE_RATE) throw new Error(`c0mpute speech: unexpected sample rate ${sampleRate}`);
    return levelPcm(pcm);
  }

  /**
   * One-shot synthesis (POST /v1/tts): its own job per request, no warm session, so a worker the
   * gateway broke under a session (c0mpute#508) cannot touch it. Slower per call (a bid window and a
   * model load), so for background work such as the slide show, not a live call.
   */
  async function tts(voice, text, tries = 3) {
    for (let i = 1; ; i++) {
      const res = await fetchImpl(`${base}/v1/tts`, { method: 'POST', headers, body: JSON.stringify({ text, engine: 'kokoro', voice }), signal: AbortSignal.timeout(300_000) }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
      if (res.ok) {
        const { pcm, sampleRate } = decodeWav(Buffer.from(await res.arrayBuffer()));
        if (sampleRate !== SAMPLE_RATE) throw new Error(`c0mpute speech: unexpected sample rate ${sampleRate}`);
        return levelPcm(pcm);
      }
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      if (i >= tries || (res.status >= 400 && res.status < 500 && res.status !== 429)) throw new Error(`c0mpute speech tts: ${res.status} ${detail}`);
      log(`speech: one-shot tts failed (${res.status} ${detail}); try ${i + 1}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }

  return {
    voices: VOICES,
    /** One-shot synthesis of a passage in a role's voice (see tts above). */
    synthesize: (role, text) => tts(VOICES[role] ?? VOICES.chair, text),
    /** Render one sentence in a role's voice. */
    render: (role, text) => renderOne(VOICES[role] ?? VOICES.chair, text),
    warm: (roles = Object.keys(VOICES)) => Promise.allSettled(roles.map((r) => session(VOICES[r]))),
    async close() {
      const ids = await Promise.allSettled([...sessions.values()]);
      sessions.clear();
      await Promise.allSettled(ids.filter((x) => x.status === 'fulfilled').map((x) => fetchImpl(`${base}/v1/sessions/${x.value}`, { method: 'DELETE', headers }).catch(() => {})));
    },
  };
}

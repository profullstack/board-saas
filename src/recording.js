// Call recordings: mixed on this server from what it already has (each board member's TTS
// audio as it plays, plus the founder's microphone track it subscribes to), encoded to MP3,
// then encrypted HERE before anything is stored. Nothing leaves this server in the clear.
//
// Encryption: a fresh random 256-bit key per recording, AES-256-GCM in 64 KiB chunks so a
// player can seek (a Range request decrypts only the chunks it covers). Each chunk's nonce is
// an 8-byte random prefix plus the chunk index, and its AAD binds the recording id and index,
// so chunks cannot be reordered or moved between recordings. The recording key is stored only
// wrapped (AES-256-GCM) under BOARD_RECORDING_KEK, a server key kept in the vault; deleting the
// wrapped key makes every copy of the ciphertext unreadable.
//
// Storage: the ciphertext on this box is the primary copy. Two optional c0mpute copies:
//  - BOARD_C0MPUTE_STORAGE_TOKEN (src/archive.js): the finished MP3 is sealed with
//    @profullstack/c0mpute-sealed and uploaded to c0mpute private storage over the app-upload
//    API. This needs no c0mpute node or identity on this host, and yields a private link.
//  - BOARD_RECORDING_C0MPUTE=1 (legacy): `c0mpute storage put` of the .bsr ciphertext through a
//    local c0mpute CLI and identity. Hosts without a c0mpute node cannot use it.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { encodeWav } from './speech.js';

const run = promisify(execFile);
export const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = 24; // 'BSR1' | chunk size u32 | plain length u64 | nonce prefix 8 bytes
const MAGIC = Buffer.from('BSR1');

// ------------------------------------------------------------------ mixing

/** Collects timed PCM (mono, `rate` Hz) and mixes it into one track. */
export class Mixer {
  constructor(rate = 24000, t0 = Date.now()) {
    this.rate = rate;
    this.t0 = t0;
    this.segments = [];
    this.tracks = new Map();
  }
  /** A whole clip that starts at wall time `atMs`. */
  add(pcm, atMs = Date.now()) {
    this.segments.push({ at: Math.max(0, Math.round(((atMs - this.t0) / 1000) * this.rate)), pcm });
  }
  /** A live stream's next frame: stays contiguous, resyncs if it drifts more than 0.5 s. */
  stream(trackId, pcm, atMs = Date.now()) {
    const wall = Math.max(0, Math.round(((atMs - this.t0) / 1000) * this.rate));
    let next = this.tracks.get(trackId);
    if (next === undefined || Math.abs(wall - next) > this.rate / 2) next = wall;
    this.segments.push({ at: next, pcm: Int16Array.from(pcm) });
    this.tracks.set(trackId, next + pcm.length);
  }
  get durationSeconds() {
    let end = 0;
    for (const s of this.segments) end = Math.max(end, s.at + s.pcm.length);
    return end / this.rate;
  }
  render() {
    const len = Math.ceil(this.durationSeconds * this.rate);
    const acc = new Int32Array(len);
    for (const s of this.segments) for (let i = 0; i < s.pcm.length; i++) acc[s.at + i] += s.pcm[i];
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) out[i] = Math.max(-32768, Math.min(32767, acc[i]));
    return out;
  }
}

/** PCM -> MP3 (mono, 48 kbps) with ffmpeg. */
export function encodeMp3(pcm, rate = 24000, ffmpeg = process.env.FFMPEG || 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 300)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(encodeWav(pcm, rate));
  });
}

// ------------------------------------------------------------------ crypto

const nonceFor = (prefix, i) => {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(i, 8);
  return n;
};
const aadFor = (id, i) => Buffer.from(`board-saas-recording:${id}:${i}`);

/** Encrypt `plain` for recording `id`. -> { key, data } (key = 32 random bytes). */
export function encryptRecording(id, plain) {
  const key = randomBytes(32);
  const prefix = randomBytes(8);
  const n = Math.ceil(plain.length / CHUNK);
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(CHUNK, 4);
  header.writeBigUInt64BE(BigInt(plain.length), 8);
  prefix.copy(header, 16);
  const parts = [header];
  for (let i = 0; i < n; i++) {
    const c = createCipheriv('aes-256-gcm', key, nonceFor(prefix, i));
    c.setAAD(aadFor(id, i));
    parts.push(c.update(plain.subarray(i * CHUNK, (i + 1) * CHUNK)), c.final(), c.getAuthTag());
  }
  return { key, data: Buffer.concat(parts) };
}

/** A random-access reader over an encrypted recording file. */
export function openEncrypted(path, id, key) {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  const header = Buffer.alloc(HEADER);
  readSync(fd, header, 0, HEADER, 0);
  if (!header.subarray(0, 4).equals(MAGIC)) {
    closeSync(fd);
    throw new Error('not a board-saas recording');
  }
  const chunk = header.readUInt32BE(4);
  const length = Number(header.readBigUInt64BE(8));
  const prefix = header.subarray(16, 24);
  const chunkAt = (i) => {
    const plainLen = Math.min(chunk, length - i * chunk);
    const buf = Buffer.alloc(plainLen + TAG);
    readSync(fd, buf, 0, buf.length, HEADER + i * (chunk + TAG));
    const d = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, i));
    d.setAAD(aadFor(id, i));
    d.setAuthTag(buf.subarray(plainLen));
    return Buffer.concat([d.update(buf.subarray(0, plainLen)), d.final()]);
  };
  return {
    length,
    cipherSize: size,
    /** Plaintext bytes [start, end] inclusive. */
    read(start, end) {
      const out = [];
      for (let i = Math.floor(start / chunk); i <= Math.floor(end / chunk); i++) {
        const c = chunkAt(i);
        const from = i * chunk;
        out.push(c.subarray(Math.max(0, start - from), Math.min(c.length, end - from + 1)));
      }
      return Buffer.concat(out);
    },
    close: () => closeSync(fd),
  };
}

export function kekFrom(env = process.env) {
  const raw = env.BOARD_RECORDING_KEK;
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('BOARD_RECORDING_KEK must be 32 bytes, base64');
  return k;
}

/** Wrap a recording key under the server KEK: base64(iv | ciphertext | tag). */
export function wrapKey(kek, id, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(`board-saas-recording-key:${id}`));
  return Buffer.concat([iv, c.update(key), c.final(), c.getAuthTag()]).toString('base64');
}

export function unwrapKey(kek, id, wrapped) {
  const b = Buffer.from(wrapped, 'base64');
  const d = createDecipheriv('aes-256-gcm', kek, b.subarray(0, 12));
  d.setAAD(Buffer.from(`board-saas-recording-key:${id}`));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

/** Encrypt a short secret (a private link) under the KEK, bound to `aad`: base64(iv | ct | tag). */
export function sealText(kek, aad, text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, c.update(Buffer.from(String(text), 'utf8')), c.final(), c.getAuthTag()]).toString('base64');
}

export function openText(kek, aad, sealed) {
  const b = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', kek, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
}

// ------------------------------------------------------------------ storage

export function createRecordingStore({ dir, env = process.env, log = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const c0mpute = env.BOARD_RECORDING_C0MPUTE === '1';
  const bin = env.C0MPUTE_BIN || 'c0mpute';
  const pathFor = (id) => join(dir, `${id.replace(/[^\w-]/g, '')}.bsr`);

  return {
    pathFor,
    /** Write ciphertext; returns { path, c0mpute_ref|null }. */
    async put(id, data) {
      const path = pathFor(id);
      writeFileSync(path, data, { mode: 0o600 });
      let ref = null;
      if (c0mpute) {
        try {
          const { stdout } = await run(bin, ['storage', 'put', '--wait-secs', '300', path], { timeout: 400_000 });
          ref = (stdout.match(/c0p1:[A-Za-z0-9_-]+/) || [null])[0];
        } catch (e) {
          log(`recording ${id}: c0mpute storage put failed, kept on this box only: ${e.message.slice(0, 200)}`);
        }
      }
      return { path, c0mpute_ref: ref };
    },
    /** Make sure the ciphertext is on this box (fetching it back from c0mpute if it is not). */
    async ensureLocal(id, ref) {
      const path = pathFor(id);
      if (existsSync(path)) return path;
      if (!ref) throw new Error('the recording file is missing');
      await run(bin, ['storage', 'get', ref, '--out', path], { timeout: 400_000 });
      return path;
    },
    async remove(id, ref) {
      rmSync(pathFor(id), { force: true });
      if (ref) await run(bin, ['storage', 'rm', ref], { timeout: 120_000 }).catch((e) => log(`recording ${id}: c0mpute rm failed: ${e.message.slice(0, 200)}`));
    },
  };
}

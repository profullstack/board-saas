// The 30-second vertical short of a finished meeting (1080x1920, H.264 + AAC, burned-in captions) for
// TikTok, Instagram Reels, YouTube Shorts and Threads. Made by itself after every meeting (free ones
// too: it is how board.saas gets seen), one render at a time through the service's render gate.
//
// Six slides: the hook, the question, the vote, the strongest dissent, the recommendation, and the
// call to action with the meeting's URL. Each is drawn by headless Chrome, read by a board voice (the
// dissent in the dissenter's own voice), gently zoomed, captioned four words at a time, and the whole
// thing is sped up to fit 30 s (setpts + atempo, never more than 1.6x; the text is clipped first).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nameOf } from './experts.js';
import { clip, encodeWav, SAMPLE_RATE, sayable, sentences } from './speech.js';
import { capThreads } from './video.js';

export const SHORT_W = 1080;
export const SHORT_H = 1920;
export const SHORT_MAX_SECONDS = 30;
const FPS = 30;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function run(cmd, args, { timeoutMs = 10 * 60_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, capThreads(args), { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err = (err + c).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.on('close', (code) => (clearTimeout(timer), code ? reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(-400)}`)) : resolve()));
  });
}

/**
 * "4-1" from the minutes: the final options when the vote carries them, "5-0" when the majority
 * line says unanimous; otherwise null (free-text positions cannot be counted honestly).
 */
export function voteLine(minutes) {
  const vote = minutes?.vote ?? [];
  if (!vote.length) return null;
  if (/^\s*unanimous/i.test(minutes.majority ?? '')) return `${vote.length}-0`;
  const opts = vote.map((v) => v.final_option).filter((o) => o != null);
  if (opts.length !== vote.length) return null;
  const counts = new Map();
  for (const o of opts) counts.set(o, (counts.get(o) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return `${top}-${vote.length - top}`;
}

/** The six slides: what each shows and what is said over it (kept short so 30 s holds). */
export function shortSlides(meeting, { url = 'https://board.saas.pit.world' } = {}) {
  const m = meeting.minutes ?? {};
  const decision = sayable(meeting.brief?.decision || meeting.title || 'a hard decision');
  const dissenter = m.dissent?.expert;
  const vote = voteLine(m);
  const host = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return [
    { kicker: 'AI board meeting', head: clip(meeting.title || decision, 12), body: 'Five AI advisors debated it. Here is what they decided.', say: `Five AI advisors just debated this: ${clip(decision, 12)}`, voice: 'chair' },
    { kicker: 'The question', head: clip(decision, 14), body: (meeting.brief?.options ?? []).slice(0, 3).map((o) => `• ${clip(o, 8)}`).join('\n'), say: `The question: ${clip(decision, 14)}`, voice: 'chair' },
    { kicker: 'The vote', stat: vote, head: clip(m.majority, 14), say: clip(m.majority, 16), voice: 'chair' },
    { kicker: 'Strongest dissent', head: dissenter ? nameOf(dissenter) : 'The minority view', body: clip(m.dissent?.quote || m.dissent?.argument, 20), say: clip(m.dissent?.quote || m.dissent?.argument, 16), voice: dissenter || 'contrarian' },
    { kicker: 'The recommendation', head: clip(m.recommendation, 16), say: clip(m.recommendation, 16), voice: 'chair' },
    { kicker: 'Your turn', head: 'Put your own decision to an AI board', body: host, say: 'Put your own decision to the board at board dot saas.', voice: 'chair' },
  ].map((s) => ({ ...s, say: sayable(s.say || s.head || '') }));
}

/** One slide as a self-contained HTML page sized for the short. */
export function slideHtml(s, i, n, brand = 'board.saas') {
  const body = s.body ? `<div class="b">${esc(s.body).replace(/\n/g, '<br>')}</div>` : '';
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${SHORT_W}px;height:${SHORT_H}px;overflow:hidden}
body{background:#0f1a33;color:#f4f1ea;font-family:'DejaVu Sans',sans-serif;display:flex;flex-direction:column;justify-content:flex-start;padding:300px 96px 96px;gap:40px;
background-image:radial-gradient(circle at 85% 8%,rgba(79,124,255,.28),transparent 45%),radial-gradient(circle at 10% 92%,rgba(232,184,75,.16),transparent 50%)}
.k{color:#e8b84b;font:700 38px 'DejaVu Sans Mono',monospace;letter-spacing:.06em;text-transform:uppercase}
.s{font:800 200px 'DejaVu Sans',sans-serif;color:#e8b84b;line-height:1}
.h{font-weight:800;font-size:${(s.head ?? '').length > 70 ? 68 : 88}px;line-height:1.08;letter-spacing:-.02em}
.b{font-size:42px;line-height:1.32;color:#c8cfdf}
.n,.f{position:absolute;left:110px;right:110px;font:600 30px 'DejaVu Sans Mono',monospace;color:#8792ab}
.n{top:150px}.f{bottom:170px;display:flex;justify-content:space-between}
</style><div class="n">${i + 1}/${n}</div><div class="k">${esc(s.kicker)}</div>${s.stat ? `<div class="s">${esc(s.stat)}</div>` : ''}<div class="h">${esc(s.head)}</div>${body}<div class="f"><span>${esc(brand)}</span><span>AI advisors, not real directors</span></div>`;
}

/** Draw one slide with headless Chrome (CHROME, default google-chrome). */
export async function shootWithChrome(htmlPath, pngPath, { chrome = process.env.CHROME || 'google-chrome', profileDir } = {}) {
  await run(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--user-data-dir=${profileDir}`, `--window-size=${SHORT_W},${SHORT_H}`, `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href], { timeoutMs: 120_000 });
}

const ts = (t) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
};

/** Caption chunks of four words, timed by length across [start, start + length). */
export function captionChunks(text, start, length, per = 4) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const groups = [];
  for (let i = 0; i < words.length; i += per) groups.push(words.slice(i, i + per).join(' '));
  const total = groups.reduce((n, g) => n + g.length, 0) || 1;
  let t = start;
  return groups.map((g) => {
    const d = (length * g.length) / total;
    const c = { start: t, end: t + d, text: g };
    t += d;
    return c;
  });
}

export function captionsAss(chunks) {
  const fs = Math.round(SHORT_W * 0.055);
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${SHORT_W}\nPlayResY: ${SHORT_H}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\nStyle: C,DejaVu Sans,${fs},&H00FFFFFF,&H00000000,&H99000000,1,3,2,0,2,60,60,${Math.round(SHORT_H * 0.11)}\n\n[Events]\nFormat: Layer, Start, End, Style, Text\n`;
  return head + chunks.map((c) => `Dialogue: 0,${ts(c.start)},${ts(c.end)},C,${c.text.replace(/[{}\\]/g, '')}`).join('\n') + '\n';
}

const silence = (seconds) => new Int16Array(Math.round(seconds * SAMPLE_RATE));
function concatPcm(parts) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

async function narrate(speech, role, text) {
  if (speech.synthesize) return speech.synthesize(role, text);
  const parts = [];
  for (const s of sentences(text)) parts.push(await speech.render(role, s), silence(0.15));
  return concatPcm(parts);
}

/**
 * Render the short. `speech` is the slideshow's speech (synthesize or render). `shoot(htmlPath, pngPath)`
 * draws a slide (headless Chrome by default). Resolves to { mp4: Buffer, seconds, slides, speed }.
 */
export async function renderShort(meeting, { speech, workDir, url, ffmpeg = process.env.FFMPEG || 'ffmpeg', shoot = null, log = () => {} }) {
  const dir = mkdtempSync(join(workDir, 'short-'));
  try {
    const slides = shortSlides(meeting, { url });
    const draw = shoot ?? ((h, p) => shootWithChrome(h, p, { profileDir: join(dir, 'chrome') }));
    const segs = [];
    const chunks = [];
    let t = 0;
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      const html = join(dir, `s${i}.html`);
      const png = join(dir, `s${i}.png`);
      writeFileSync(html, slideHtml(s, i, slides.length));
      await draw(html, png);
      const pcm = concatPcm([await narrate(speech, s.voice, s.say), silence(0.25)]);
      const len = pcm.length / SAMPLE_RATE;
      const wav = join(dir, `a${i}.wav`);
      writeFileSync(wav, encodeWav(pcm));
      const seg = join(dir, `seg${i}.mp4`);
      const frames = Math.ceil(len * FPS) + 1;
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-i', wav,
        '-filter_complex', `[0]scale=${SHORT_W}:${SHORT_H},zoompan=z='min(zoom+0.0006,1.06)':d=${frames}:s=${SHORT_W}x${SHORT_H}:fps=${FPS}[v];[1]aresample=48000,aformat=channel_layouts=stereo[a]`,
        '-map', '[v]', '-map', '[a]', '-t', len.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', seg]);
      segs.push(seg);
      chunks.push(...captionChunks(s.say, t + 0.05, len - 0.25));
      t += len;
      log(`short: slide ${i + 1}/${slides.length} (${len.toFixed(1)} s)`);
    }
    writeFileSync(join(dir, 'list.txt'), segs.map((s) => `file '${s}'`).join('\n') + '\n');
    const joined = join(dir, 'joined.mp4');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-c', 'copy', joined]);
    // Fit 30 s: speed everything up by the same factor (captions move with it), at most 1.6x.
    const target = SHORT_MAX_SECONDS - 0.2;
    const speed = Math.min(1.6, Math.max(1, t / target));
    writeFileSync(join(dir, 'cap.ass'), captionsAss(chunks.map((c) => ({ ...c, start: c.start / speed, end: c.end / speed }))));
    const out = join(dir, 'short.mp4');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', joined,
      '-filter_complex', `[0:v]setpts=PTS/${speed.toFixed(4)},ass=cap.ass[v];[0:a]atempo=${speed.toFixed(4)},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
      '-map', '[v]', '-map', '[a]', '-r', String(FPS), '-t', String(SHORT_MAX_SECONDS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'short.mp4'], { cwd: dir });
    const seconds = Math.min(SHORT_MAX_SECONDS, t / speed);
    return { mp4: readFileSync(out), seconds: Math.round(seconds * 10) / 10, slides: slides.length, speed: Math.round(speed * 100) / 100 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

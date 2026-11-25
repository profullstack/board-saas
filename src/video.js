// The meeting video (Anthony 2026-11-25: "add the video too to the page. do that automatically").
//
// A board call is audio only, so the video is made from what every recorded meeting already has:
// the (silence-trimmed) recording and its transcript. Each line shows who is speaking, with what
// they said as captions timed across their turn, over a plain background and the meeting title.
// ASS subtitles burned in by ffmpeg, H.264 + AAC, 10 fps (nothing moves but the text), faststart.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;

/** Speaker colors in ASS order (&HBBGGRR). Unknown speakers get the last one. */
const COLORS = {
  chair: '&H00F2E6DA',
  cfo: '&H0089E39A',
  growth: '&H0042C8F5',
  operator: '&H00F5B042',
  'founder-time': '&H00D88BE8',
  contrarian: '&H006D6DFF',
  founder: '&H00FFFFFF',
};

function roleOf(speaker) {
  const s = String(speaker || '').toLowerCase();
  if (s.includes('chair')) return 'chair';
  if (s.includes('cfo')) return 'cfo';
  if (s.includes('growth')) return 'growth';
  if (s.includes('operator')) return 'operator';
  if (s.includes('founder-time') || s.includes('founder time')) return 'founder-time';
  if (s.includes('contrarian')) return 'contrarian';
  return 'founder';
}

/** ASS time: h:mm:ss.cc */
export function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Text safe inside an ASS Dialogue line: no override braces, no raw newlines. */
const assText = (s) => String(s ?? '').replace(/\\/g, '/').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\s*\n\s*/g, ' ').trim();

/** Split one turn's text into caption chunks of at most `max` characters, on sentence then word boundaries. */
export function captionChunks(text, max = 150) {
  const sentences = String(text ?? '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) || [];
  const out = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      let line = '';
      for (const w of s.split(' ')) {
        if ((line + ' ' + w).trim().length > max) {
          out.push(line.trim());
          line = w;
        } else line = `${line} ${w}`;
      }
      if (line.trim()) out.push(line.trim());
      continue;
    }
    if ((cur + s).length > max) push();
    cur += s;
  }
  push();
  return out;
}

/**
 * The ASS script for a meeting: the title throughout, then per transcript line the speaker's name
 * and their words, captions spread over the turn by length. Lines are { t: seconds, speaker, text }.
 */
export function meetingAss({ title, transcript, duration }) {
  const lines = (transcript || []).filter((l) => l && l.text && Number.isFinite(Number(l.t))).sort((a, b) => Number(a.t) - Number(b.t));
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Liberation Sans,30,&H00B8B0A8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,60,60,40,1
Style: Speaker,Liberation Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1
Style: Caption,Liberation Sans,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,3,14,0,2,110,110,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = [];
  const end = Number(duration) || (lines.length ? Number(lines.at(-1).t) + 30 : 30);
  if (title) {
    let t = assText(title);
    if (t.length > 110) t = `${t.slice(0, 110).replace(/\s+\S*$/, '')}...`;
    ev.push(`Dialogue: 0,${assTime(0)},${assTime(end)},Title,,0,0,0,,${t}`);
  }
  lines.forEach((l, i) => {
    const start = Number(l.t);
    const stop = Math.min(end, i + 1 < lines.length ? Number(lines[i + 1].t) : end);
    if (!(stop > start)) return;
    const color = COLORS[roleOf(l.speaker)] || COLORS.founder;
    ev.push(`Dialogue: 0,${assTime(start)},${assTime(stop)},Speaker,,0,0,0,,{\\c${color}}${assText(l.speaker)}`);
    const chunks = captionChunks(assText(l.text));
    const chars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let at = start;
    for (const c of chunks) {
      const len = ((stop - start) * c.length) / chars;
      ev.push(`Dialogue: 1,${assTime(at)},${assTime(Math.min(stop, at + len))},Caption,,0,0,0,,${c}`);
      at += len;
    }
  });
  return head + ev.join('\n') + '\n';
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err = (err + c).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.on('close', (code) => (clearTimeout(timer), code ? reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-500)}`)) : resolve()));
  });
}

/** Render the meeting video: MP3 bytes + transcript -> MP4 bytes. `workDir` holds the temp files. */
export async function renderMeetingVideo({ mp3, transcript, title, duration, workDir, ffmpeg = process.env.FFMPEG || 'ffmpeg', timeoutMs = 20 * 60_000 }) {
  const dir = mkdtempSync(join(workDir, 'video-'));
  try {
    writeFileSync(join(dir, 'audio.mp3'), mp3, { mode: 0o600 });
    writeFileSync(join(dir, 'meeting.ass'), meetingAss({ title, transcript, duration }), { mode: 0o600 });
    // The ass filter takes a path inside a filter graph: run it from the temp dir with bare names.
    const out = join(dir, 'meeting.mp4');
    await run(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=0x0f1a33:s=${W}x${H}:r=10`,
        '-i', join(dir, 'audio.mp3'),
        '-vf', `ass=${join(dir, 'meeting.ass')}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '30', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', out],
      timeoutMs,
    );
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

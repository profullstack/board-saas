// The meeting video (Anthony 2026-11-25: "add the video too to the page. do that automatically").
//
// A board call is audio only, so the video is made from what every recorded meeting already has:
// the (silence-trimmed) recording and its transcript. Each line shows who is speaking, with what
// they said as captions timed across their turn, over a plain background and the meeting title.
// ASS subtitles burned in by ffmpeg, H.264 + AAC, 10 fps (nothing moves but the text), faststart.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// ------------------------------------------------------------------ Premium: the branded rendition
//
// Premium (0.9.x): a branded 1080x1080 rendition for LinkedIn, next to the free captioned video
// above, ported from the b1dz build.py. It starts from the same recording (already silence-trimmed
// when it was saved, quiet runs over 1.2 s cut to 0.8 s) and goes further:
//   1. silencedetect (noise -40 dB, at least 0.6 s) finds the remaining pauses.
//   2. Every pause is shortened to 0.35 s by cutting explicit atrim segments joined with concat via
//      -filter_complex_script (aselect keeps every frame on the ffmpeg we run, so it cannot drop
//      audio), with a 10 ms fade at each join so the cuts do not click. That MP3 is kept too.
//   3. The transcript (on the recording's timeline) is moved through the same cuts and split into
//      short subtitle chunks coloured per speaker.
//   4. An ASS file carries the banner (kicker, title, meta line, footer) and the subtitles over the
//      board.saas dark background, an accent bar and a live waveform. 30 fps, H.264 high yuv420p
//      crf 23, AAC 128k 48 kHz, +faststart. ffmpeg runs under nice, one render at a time.
// Everything but renderBrandedVideo() is pure, so the cut and remap math is tested on its own.

export const BRANDED_DEFAULTS = { noise: '-40dB', minSilence: 0.6, keepGap: 0.35, pad: 0.05, fade: 0.01 };

// ------------------------------------------------------------------ cuts

/** silencedetect's stderr -> [[start, end], ...] (seconds). A run still open at the end is dropped. */
export function parseSilences(stderr) {
  const starts = [];
  const ends = [];
  for (const line of String(stderr).split('\n')) {
    let m = line.match(/silence_start: (-?[\d.]+)/);
    if (m) starts.push(Math.max(0, Number(m[1])));
    m = line.match(/silence_end: ([\d.]+)/);
    if (m) ends.push(Number(m[1]));
  }
  const out = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) if (ends[i] > starts[i]) out.push([starts[i], ends[i]]);
  return out;
}

/**
 * Which stretches of the original to remove and which to keep. Every silence longer than
 * keepGap + 2 * pad keeps keepGap seconds (half after the last sound, half before the next).
 * -> { cuts: [[from, to]], keep: [[from, to]], removed, duration }
 */
export function planCuts(silences, duration, { keepGap = BRANDED_DEFAULTS.keepGap, pad = BRANDED_DEFAULTS.pad } = {}) {
  const half = keepGap / 2;
  const cuts = [];
  for (const [s, e] of [...silences].sort((a, b) => a[0] - b[0])) {
    if (e - s <= keepGap + 2 * pad) continue;
    const from = Math.max(0, s + half);
    const to = Math.min(duration, e - half);
    if (to <= from) continue;
    const last = cuts[cuts.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else cuts.push([from, to]);
  }
  const keep = [];
  let t = 0;
  for (const [a, b] of cuts) {
    if (a > t) keep.push([t, a]);
    t = b;
  }
  if (t < duration) keep.push([t, duration]);
  const removed = cuts.reduce((n, [a, b]) => n + (b - a), 0);
  return { cuts, keep, removed, duration: Math.max(0, duration - removed) };
}

/** A time on the original timeline -> the same moment after the cuts. Inside a cut it lands on the join. */
export function remapTime(x, cuts) {
  let removed = 0;
  for (const [a, b] of cuts) {
    if (x >= b) removed += b - a;
    else if (x > a) removed += x - a;
  }
  return Math.max(0, x - removed);
}

/** The ffmpeg filter graph that keeps `keep` and joins it, with short fades at every join. */
export function trimFilterScript(keep, { fade = BRANDED_DEFAULTS.fade } = {}) {
  if (!keep.length) throw new Error('nothing to keep');
  const parts = keep.map(([a, b], i) => {
    const d = b - a;
    return `[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, d - fade).toFixed(3)}:d=${fade}[s${i}]`;
  });
  return `${parts.join(';\n')};\n${keep.map((_, i) => `[s${i}]`).join('')}concat=n=${keep.length}:v=0:a=1[out]`;
}

/**
 * Transcript lines on the original timeline -> { start, end, speaker, text } after the cuts.
 * A line ends before the next one starts, after about 14.5 characters a second (at least 1.5 s).
 */
export function timedLines(transcript, cuts, newDuration) {
  const lines = (transcript ?? [])
    .filter((l) => l && String(l.text ?? '').trim() && Number.isFinite(Number(l.t)))
    .map((l) => ({ speaker: String(l.speaker ?? ''), text: String(l.text).replace(/\s+/g, ' ').trim(), start: Math.min(newDuration, remapTime(Number(l.t), cuts)) }))
    .sort((a, b) => a.start - b.start);
  return lines.map((l, i) => {
    const next = i + 1 < lines.length ? lines[i + 1].start : newDuration;
    const end = Math.min(next - 0.1, l.start + Math.max(1.5, l.text.length / 14.5));
    return { ...l, end: Math.max(l.start + 0.1, Math.min(end, newDuration)) };
  });
}

// ------------------------------------------------------------------ text

/** One spoken line -> short subtitle chunks (a sentence over 30 characters, or anything past 70). */
export function chunkText(text) {
  const chunks = [];
  let cur = [];
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    cur.push(w);
    const joined = cur.join(' ');
    if (joined.length > 70 || (/[.?!]$/.test(w) && joined.length > 30)) {
      chunks.push(joined);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur.join(' '));
  return chunks;
}

/** Greedy word wrap at `width` characters (words longer than a line are broken). */
export function wrapText(text, width) {
  const lines = [];
  let cur = '';
  for (let w of String(text).split(/\s+/).filter(Boolean)) {
    while (w.length > width) {
      if (cur) lines.push(cur), (cur = '');
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else lines.push(cur), (cur = w);
  }
  if (cur) lines.push(cur);
  return lines;
}

/** ASS text: no override blocks or line breaks from the content itself. */
export const assEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/[\r\n]+/g, ' ');

// ASS colours are &HAABBGGRR. Chair = the site accent #2f5bd3.
const SPEAKER_COLOURS = [
  [/chair/i, '&H00D35B2F'],
  [/cfo/i, '&H0055C3F2'],
  [/growth/i, '&H0077D18A'],
  [/operator/i, '&H00E0A869'],
  [/founder/i, '&H00B98AE8'],
  [/contrarian/i, '&H006A6AF0'],
];
export const speakerColour = (speaker) => (SPEAKER_COLOURS.find(([re]) => re.test(speaker)) ?? [null, '&H00FFFFFF'])[1];
/** "The Growth Marketer" -> "GROWTH MARKETER". */
export const speakerLabel = (speaker) => String(speaker || 'Speaker').replace(/^the\s+/i, '').toUpperCase();

/**
 * The banner title, sized to fit above the waveform: 66 px on up to two lines, 52 px on up to
 * three, else 44 px on three lines with an ellipsis. -> { lines, size }
 */
export function fitTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim() || 'Board meeting';
  for (const [size, width, max] of [
    [66, 22, 2],
    [52, 28, 3],
  ]) {
    const lines = wrapText(t, width);
    if (lines.length <= max) return { lines, size };
  }
  const lines = wrapText(t, 34);
  if (lines.length > 3) {
    lines.length = 3;
    lines[2] = `${lines[2].replace(/[\s,.;:!?-]+$/, '').slice(0, 33)}…`;
  }
  return { lines, size: 44 };
}

/**
 * What the video is called: the brief's decision when it is short enough to read at a glance,
 * otherwise the minutes' title, otherwise the decision cut down.
 */
export function videoTitle({ meeting = null, brief = null } = {}) {
  const decision = String(brief?.decision ?? '').replace(/\s+/g, ' ').trim();
  const title = String(meeting?.title ?? '').replace(/\s+/g, ' ').trim();
  if (decision && decision.length <= 64) return decision;
  if (title) return title;
  if (decision) return decision.split(/[:;,]/)[0].slice(0, 90);
  return 'Board meeting';
}

/** The full ASS script: banner for the whole video plus the subtitle events. */
export function brandedAss({ title, meta, footer = 'board.saas.pit.world', kicker = 'AI BOARD MEETING', lines, duration }) {
  const end = assTime(duration);
  const fit = fitTitle(title);
  const metaTop = Math.min(345, Math.round(140 + fit.lines.length * fit.size * 1.2 + 24));
  const events = [];
  for (const ln of lines) {
    const chunks = chunkText(ln.text);
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    const span = ln.end - ln.start;
    const col = speakerColour(ln.speaker);
    let t0 = ln.start;
    for (const c of chunks) {
      const t1 = t0 + (span * c.length) / total;
      const body = wrapText(assEscape(c), 34).join('\\N');
      events.push(`Dialogue: 0,${assTime(t0)},${assTime(t1)},Sub,,0,0,0,,{\\c${col}&}${assEscape(speakerLabel(ln.speaker))}\\N{\\c&H00FFFFFF&}${body}`);
      t0 = t1;
    }
  }
  const banner = [
    `Dialogue: 1,0:00:00.00,${end},Kicker,,0,0,0,,${assEscape(kicker)}`,
    `Dialogue: 1,0:00:00.00,${end},Title,,0,0,0,,{\\fs${fit.size}}${fit.lines.map(assEscape).join('\\N')}`,
    `Dialogue: 1,0:00:00.00,${end},Meta,,0,0,${metaTop},,${assEscape(meta)}`,
    `Dialogue: 1,0:00:00.00,${end},Foot,,0,0,0,,${assEscape(footer)}`,
  ];
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Kicker,DejaVu Sans,30,&H00D35B2F,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,6,0,1,0,0,7,80,80,90,1
Style: Title,DejaVu Sans,66,&H00F3F6F7,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,7,80,80,140,1
Style: Meta,DejaVu Sans,30,&H00A0A4A8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,80,80,320,1
Style: Foot,DejaVu Sans,28,&H00F3F6F7,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,1,0,1,0,0,9,80,80,90,1
Style: Sub,DejaVu Sans,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,3,18,0,2,80,80,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${[...banner, ...events].join('\n')}
`;
  return { ass, events: events.length };
}

/** "claude-opus-5-5" -> "Claude Opus 5.5"; anything else -> null. */
export function modelLabel(id) {
  const m = String(id ?? '').match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!m) return null;
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`;
}

// ------------------------------------------------------------------ ffmpeg

/** Run a tool at low priority. -> { stdout, stderr } or throws with the end of stderr. */
export function runTool(bin, args, { cwd, nice = 19, timeoutMs = 30 * 60_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, argv] = nice == null ? [bin, args] : ['nice', ['-n', String(nice), bin, ...args]];
    const p = spawnImpl(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`));
    });
  });
}

async function probeDuration(ffprobe, file, opts) {
  const { stdout } = await runTool(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], opts);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`could not read the duration of ${file}`);
  return d;
}

/**
 * Render the video in `dir` from `dir/<input>` (a plain MP3 the caller wrote there). Writes
 * trimmed.mp3 and video.mp4 next to it and returns their paths with the numbers.
 */
export async function renderBrandedVideo({ dir, input = 'orig.mp3', title, meta, transcript, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', nice = 19, log = () => {}, options = {} }) {
  const o = { ...BRANDED_DEFAULTS, ...options };
  const run = { cwd: dir, nice };
  const t0 = Date.now();
  const dur = await probeDuration(ffprobe, input, run);
  const { stderr } = await runTool(ffmpeg, ['-hide_banner', '-nostats', '-i', input, '-af', `silencedetect=noise=${o.noise}:d=${o.minSilence}`, '-f', 'null', '-'], run);
  const plan = planCuts(parseSilences(stderr), dur, o);
  writeFileSync(join(dir, 'trim.filter'), trimFilterScript(plan.keep, o));
  await runTool(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-filter_complex_script', 'trim.filter', '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '64k', 'trimmed.mp3'], run);
  const newDur = await probeDuration(ffprobe, 'trimmed.mp3', run);
  const lines = timedLines(transcript, plan.cuts, newDur);
  const { ass, events } = brandedAss({ title, meta, lines, duration: newDur });
  writeFileSync(join(dir, 'subs.ass'), ass);
  const fc = [
    'color=c=0x141413:s=1080x1080:r=30[bg]',
    'color=c=0x2f5bd3:s=920x6:r=30[bar]',
    '[0:a]showwaves=s=920x170:mode=cline:rate=30:colors=0x2f5bd3|0x5b80e0:scale=sqrt,format=rgba[wave]',
    '[bg][bar]overlay=80:390[b1]',
    '[b1][wave]overlay=80:430:shortest=1[b2]',
    '[b2]ass=subs.ass,format=yuv420p[v]',
  ].join(';');
  await runTool(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', 'trimmed.mp3', '-filter_complex', fc, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-shortest', 'video.mp4'],
    run,
  );
  const seconds = await probeDuration(ffprobe, 'video.mp4', run);
  const out = { mp4: join(dir, 'video.mp4'), mp3: join(dir, 'trimmed.mp3'), seconds, mp3Seconds: newDur, originalSeconds: dur, cuts: plan.cuts.length, removedSeconds: plan.removed, subtitleEvents: events, bytes: statSync(join(dir, 'video.mp4')).size, renderMs: Date.now() - t0 };
  log(`video: ${Math.round(dur)}s -> ${Math.round(newDur)}s (${plan.cuts.length} gaps cut), ${events} subtitles, ${Math.round(out.bytes / 1024)} KiB in ${Math.round(out.renderMs / 1000)}s`);
  return out;
}

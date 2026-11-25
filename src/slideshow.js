// The slide-show video (Anthony 2026-11-25: "now we need an audio track, just have the chairman
// narrate ... give the presentation as a video talking through our slides. call it 'Slide show
// presentation.mp4'").
//
// The meeting's deck (src/deck.js) is rendered to images by LibreOffice (soffice -> PDF ->
// pdftoppm), so the video shows exactly the slides the PowerPoint has. The Chair reads the deck's
// script (deckNarration, which is also its speaker notes) in the Chair's call voice, one slide at a
// time; each slide stays up for its narration plus a short pause. H.264 + AAC, 1920x1080.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deckNarration, meetingDeck } from './deck.js';
import { encodeWav, sayable, SAMPLE_RATE, sentences } from './speech.js';

function run(cmd, args, { timeoutMs = 10 * 60_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err = (err + c).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.on('close', (code) => (clearTimeout(timer), code ? reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(-400)}`)) : resolve()));
  });
}

const silence = (seconds) => new Int16Array(Math.round(seconds * SAMPLE_RATE));

function concatPcm(parts) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/** The deck's slides as PNG paths, in order. */
export async function slideImages(deck, dir, { soffice = process.env.SOFFICE || 'soffice', pdftoppm = process.env.PDFTOPPM || 'pdftoppm' } = {}) {
  writeFileSync(join(dir, 'deck.pptx'), deck);
  // A private LibreOffice profile per render, so two renders never fight over one profile lock.
  await run(soffice, ['--headless', '--norestore', `-env:UserInstallation=file://${join(dir, 'lo-profile')}`, '--convert-to', 'pdf', '--outdir', dir, join(dir, 'deck.pptx')], { cwd: dir, env: { HOME: dir } });
  await run(pdftoppm, ['-png', '-scale-to-x', '1920', '-scale-to-y', '1080', join(dir, 'deck.pdf'), join(dir, 'slide')]);
  return readdirSync(dir)
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => join(dir, f));
}

/**
 * Render the slide-show video for a finished meeting. `speech` is createSpeech(...) (or a fake with
 * render(role, text) -> Int16Array at 24 kHz). Resolves to { mp4, seconds, slides }.
 */
export async function renderSlideshow(meeting, { speech, workDir, url = null, ffmpeg = process.env.FFMPEG || 'ffmpeg', soffice, pdftoppm, log = () => {} }) {
  const dir = mkdtempSync(join(workDir, 'slideshow-'));
  try {
    const deck = await meetingDeck(meeting, { url });
    const images = await slideImages(deck, dir, { soffice, pdftoppm });
    const script = deckNarration(meeting);
    if (images.length !== script.length) throw new Error(`the deck rendered ${images.length} slides but the script has ${script.length}`);
    const segments = [];
    let seconds = 0;
    for (let i = 0; i < images.length; i++) {
      const parts = [silence(0.5)];
      for (const s of sentences(sayable(script[i]))) {
        parts.push(await speech.render('chair', s));
        parts.push(silence(0.3));
      }
      parts.push(silence(0.9));
      const pcm = concatPcm(parts);
      seconds += pcm.length / SAMPLE_RATE;
      const wav = join(dir, `a-${i + 1}.wav`);
      writeFileSync(wav, encodeWav(pcm));
      const seg = join(dir, `seg-${i + 1}.mp4`);
      // -t, not -shortest: with a looped still image -shortest overruns the audio by seconds.
      const len = (pcm.length / SAMPLE_RATE).toFixed(3);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '10', '-t', len, '-i', images[i], '-i', wav,
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', '10',
        '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-t', len, seg]);
      segments.push(seg);
      log(`slide ${i + 1}/${images.length} narrated (${Math.round(pcm.length / SAMPLE_RATE)}s)`);
    }
    writeFileSync(join(dir, 'list.txt'), segments.map((s) => `file '${s}'`).join('\n') + '\n');
    const out = join(dir, 'slideshow.mp4');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', out]);
    return { mp4: readFileSync(out), seconds: Math.round(seconds), slides: images.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

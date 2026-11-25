import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { deckNarration, meetingDeck } from '../src/deck.js';
import { renderSlideshow } from '../src/slideshow.js';

const fixture = JSON.parse(readFileSync(new URL('./fixture-meeting.json', import.meta.url), 'utf8'));

test("the Chair's script has one part per slide and is the deck's speaker notes", async () => {
  const script = deckNarration(fixture);
  const zip = await JSZip.loadAsync(await meetingDeck(fixture));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.equal(script.length, slides.length);
  const words = script.join(' ').split(/\s+/).length;
  assert.ok(words > 300 && words < 750, `${words} words: about 4 to 5 minutes`);
  const notes = await zip.file('ppt/notesSlides/notesSlide2.xml').async('string');
  assert.match(notes, /Here is where we landed/);
});

const hasOffice = (() => {
  try {
    execFileSync('soffice', ['--version'], { stdio: 'ignore' });
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('renderSlideshow: one narrated segment per slide, one MP4', { skip: !hasOffice && 'LibreOffice and pdftoppm are not installed here' }, async () => {
  const said = [];
  const speech = { render: async (role, text) => (said.push(role), new Int16Array(24000 * 0.4)) };
  const r = await renderSlideshow(fixture, { speech, workDir: mkdtempSync(join(tmpdir(), 'show-')) });
  assert.equal(r.slides, deckNarration(fixture).length);
  assert.ok(said.length >= r.slides && said.every((x) => x === 'chair'), 'only the Chair speaks');
  assert.equal(r.mp4.subarray(4, 8).toString(), 'ftyp');
});

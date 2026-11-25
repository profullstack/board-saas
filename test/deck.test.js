import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import JSZip from 'jszip';
import { clip, meetingDeck, numbersBehind, voteCounts } from '../src/deck.js';

const fixture = JSON.parse(readFileSync(new URL('./fixture-meeting.json', import.meta.url), 'utf8'));

test('clip cuts on a word boundary with an ellipsis', () => {
  assert.equal(clip('short', 20), 'short');
  assert.equal(clip('one two three four', 10), 'one two...');
});

test('numbersBehind pulls money and percent figures, no zeros, no repeats', () => {
  const n = numbersBehind({
    minutes: { clashes: [{ topic: 'Pace', crux: 'Two pilots at $2,400 is $4,800 ARR, enough to pay back.' }], dissent: { expert: 'contrarian', argument: 'Revenue is $0/mo today, so measure first.' } },
    verdicts: [{ expert: 'cfo', reasons: ['Churn at 3.1% monthly means a year loses a third of customers.', 'Again $2,400 per pilot is the bar.'] }],
  });
  assert.deepEqual(n.map((x) => x.figure), ['$2,400', '3.1%']);
});

test('voteCounts counts round 1 and final picks per option', () => {
  const c = voteCounts({ brief: { options: ['A) x', 'B) y'] }, verdicts: [{ option: 1 }, { option: 2 }, { option: 1 }], debate: [{ option: 1 }, { option: 1 }, { option: 1 }] });
  assert.deepEqual([c.r1, c.fin], [[2, 1], [3, 0]]);
});

test('meetingDeck builds a valid PowerPoint with eight slides and speaker notes, no folder entries', async () => {
  const buf = await meetingDeck(fixture, { url: 'https://board.test/m/x' });
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.ok(slides.length >= 7, `${slides.length} slides`);
  assert.ok(Object.keys(zip.files).some((n) => n.startsWith('ppt/notesSlides/')), 'speaker notes');
  assert.equal(Object.values(zip.files).filter((f) => f.dir).length, 0, 'no folder entries');
  const s2 = await zip.file('ppt/slides/slide2.xml').async('string');
  assert.match(s2, /The recommendation/);
});

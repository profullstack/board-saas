import assert from 'node:assert/strict';
import test from 'node:test';
import { assTime, captionChunks, meetingAss } from '../src/video.js';

test('assTime formats h:mm:ss.cc', () => {
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(61.234), '0:01:01.23');
  assert.equal(assTime(3725.5), '1:02:05.50');
});

test('captionChunks splits on sentences, then words, never over the limit', () => {
  const c = captionChunks('One. Two is a bit longer. ' + 'word '.repeat(60), 60);
  assert.ok(c.length >= 4);
  for (const x of c) assert.ok(x.length <= 60, x);
  assert.equal(c[0], 'One. Two is a bit longer.');
});

test('meetingAss: speaker names and captions follow the transcript turns', () => {
  const ass = meetingAss({
    title: 'Should we { raise } prices?',
    duration: 30,
    transcript: [
      { t: '0.0', speaker: 'Chair', text: 'Welcome. CFO, your verdict.' },
      { t: '5.0', speaker: 'The CFO', text: 'Raise to $39 for new customers only.' },
    ],
  });
  assert.match(ass, /Style: Speaker/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:30\.00,Title,,0,0,0,,Should we \( raise \) prices\?/, 'override braces are neutralised');
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:05\.00,Speaker,.*Chair/);
  assert.match(ass, /Dialogue: 0,0:00:05\.00,0:00:30\.00,Speaker,.*The CFO/);
  assert.match(ass, /Caption,,0,0,0,,Raise to \$39 for new customers only\./);
});

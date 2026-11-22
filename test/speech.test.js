import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeech, encodeWav } from '../src/speech.js';

// A warm worker that dies mid-line must not silence a voice: the line is retried once on a
// fresh session (seen live 2026-11-22: "the warm speech worker exited mid-utterance").
const errors = [
  'the warm speech worker exited mid-utterance',
  'the warm speech worker closed its input; the session is gone and must be reopened',
  'the warm speech worker did not answer in time',
];
for (const error of errors) {
  test(`speech: "${error.slice(0, 40)}..." reopens the session and says the line again`, async () => {
    let opened = 0;
    let said = 0;
    const wav = encodeWav(new Int16Array(240));
    const fetchImpl = async (url) => {
      if (url.endsWith('/v1/sessions')) {
        opened++;
        return new Response(JSON.stringify({ session: `s${opened}`, load_ms: 1 }));
      }
      said++;
      if (url.includes('/s1/')) return new Response(JSON.stringify({ error }), { status: 502 });
      return new Response(wav);
    };
    const speech = createSpeech({ url: 'http://speech', token: 't', fetchImpl });
    const pcm = await speech.render('chair', 'Hello board.');
    assert.equal(opened, 2);
    assert.equal(said, 2);
    assert.ok(pcm.length > 0);
  });
}

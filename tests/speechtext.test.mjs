// Answers are spoken: no Markdown on screen, no symbols read out by the voice, and the app's tags left alone.
import assert from 'node:assert/strict';
import { plainText, speakable } from '../packages/shared/src/speechtext.ts';
const ok = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
await ok('Markdown comes off the answer; tags stay', () => {
  assert.equal(plainText('Got it. Set a home place in **Connections**—that’s where forecasts come from.'), 'Got it. Set a home place in Connections—that’s where forecasts come from.');
  assert.equal(plainText('## Today\n- **Stand-up** at 10\n- Lunch with _Sam_\n\nSee [the doc](https://x.example/a).'), 'Today\nStand-up at 10\nLunch with Sam\n\nSee the doc.');
  assert.equal(plainText('Painting it. [[image:wide: a **neon** city]]'), 'Painting it. [[image:wide: a **neon** city]]');
  assert.equal(plainText('Use `npm test` now'), 'Use npm test now');
  assert.equal(plainText('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(plainText('2 * 3 = 6'), '2 * 3 = 6');
});
await ok('the voice says words, not symbols', () => {
  assert.equal(speakable('Set a home place in **Connections**—that’s where forecasts come from.'), 'Set a home place in Connections, that’s where forecasts come from.');
  assert.equal(speakable('23–30 °C, rain 90% & wind'), '23 to 30 degrees, rain 90 percent and wind');
  assert.equal(speakable('Here it is 🌧️ #weather [[map:fly|Tokyo]]'), 'Here it is weather');
  assert.equal(speakable('Read more at https://example.com/x'), 'Read more at the link');
  assert.equal(speakable('Tea/coffee at 10/12'), 'Tea or coffee at 10/12');
});

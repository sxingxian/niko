// When Niko decides someone started and stopped talking (the recording sent to the speech-in service), with the
// levels phones and tablets really give: quiet mics, people further away, speaking straight after a tap or "Niko".
import assert from 'node:assert/strict';
import { createVad } from '../apps/app/src/listen.ts';

let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };
const F = 21; // ms per slice (1024 samples at 48 kHz)
/** Plays a list of [rms, ms] through a new detector; returns each frame's answer. */
const play = (parts) => { const v = createVad(); const out = []; for (const [rms, ms] of parts) for (let t = 0; t < ms; t += F) out.push(v.push(rms, F)); return out; };
const at = (out, word) => out.indexOf(word);

ok('a quiet phone voice in a quiet room is heard', () => {
  const out = play([[0.0015, 600], [0.009, 1500], [0.0015, 1600]]);
  assert.ok(at(out, 'start') >= 0, 'started'); assert.ok(at(out, 'end') > at(out, 'start'), 'ended after');
});
ok('speaking straight away (right after a tap or “Niko”) is heard, not taken for the room', () => {
  // Speech from the first frame: loud syllables with the short dips between them.
  const syll = []; for (let i = 0; i < 8; i++) syll.push([0.03, 200], [0.004, 80]);
  const out = play([...syll, [0.002, 1600]]);
  const s = at(out, 'start');
  assert.ok(s >= 0 && s * F <= 800, `started within the ${s * F} ms kept before speech`);
  assert.ok(at(out, 'end') > s);
});
ok('a quiet voice right away, on a tablet across the table, is heard too', () => {
  const syll = []; for (let i = 0; i < 8; i++) syll.push([0.008, 200], [0.0018, 80]);
  const out = play([...syll, [0.0018, 1600]]);
  assert.ok(at(out, 'start') >= 0 && at(out, 'start') * F <= 800);
});
ok('a tap or click on its own does not start it', () => {
  const out = play([[0.002, 500], [0.012, 40], [0.002, 3000]]);
  assert.equal(at(out, 'start'), -1);
});
ok('quieter words and short pauses mid-sentence don’t end it', () => {
  const out = play([[0.002, 400], [0.02, 900], [0.005, 700], [0.0025, 900], [0.02, 900], [0.002, 1500]]);
  const s = at(out, 'start'), e = at(out, 'end');
  assert.ok(s >= 0 && e > 0);
  assert.ok(e * F > 400 + 900 + 700 + 900 + 900, 'ends only after the last words');
});
ok('in a noisy room the bar rises: the noise alone doesn’t start it, speech over it does', () => {
  assert.equal(at(play([[0.02, 4000]]), 'start'), -1, 'steady noise');
  const out = play([[0.02, 800], [0.08, 1200], [0.02, 2000]]);
  assert.ok(at(out, 'start') > 0); assert.ok(at(out, 'end') > at(out, 'start'));
});
ok('steady noise that seemed to start (a fan, traffic) ends as noise and sends nothing', () => {
  const out = play([[0.003, 300], [0.018, 1500], [0.009, 4000]]);
  assert.ok(!out.includes('end'), 'not sent');
  assert.ok(out.includes('noise') || !out.includes('start'));
});
ok('it ends after a pause of about 1.3 seconds', () => {
  const out = play([[0.002, 300], [0.03, 600], [0.002, 3000]]);
  const quietFrames = at(out, 'end') - (Math.ceil(300 / F) + Math.ceil(600 / F)) + 1;
  void quietFrames;
  assert.ok(quietFrames * F >= 1300 && quietFrames * F <= 1400, `${quietFrames * F} ms`);
});
console.log(`${pass} listening checks passed`);

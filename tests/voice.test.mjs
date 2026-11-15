import { isEcho, matchWake } from '../apps/app/src/speech.ts';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const said = 'You have a dentist appointment at nine thirty today.';
// Niko's own voice, as the mic hears it after Niko stops (often partial, lower-case, no punctuation)
for (const h of ['you have a dentist appointment at nine thirty today', 'dentist appointment at nine thirty', 'at nine thirty today', 'You have a dentist appointment.'])
  ok(isEcho(h, said), `Niko's own words are recognised as echo: "${h}"`);
// The user's real follow-ups are not echo, even when they repeat a word or two
for (const h of ['and what about tomorrow', 'move the dentist to ten', 'what time is it', 'thanks', 'cancel it', 'remind me at nine'])
  ok(!isEcho(h, said), `a real follow-up is not echo: "${h}"`);
ok(!isEcho('', said) && !isEcho('hello there', ''), 'empty text is never echo');
// Wake word
ok(matchWake('Niko what is on today')?.command === 'what is on today', 'wake word with a command');
ok(matchWake('Nico')?.command === '', 'the name alone');
ok(matchWake('Nikon camera') === null, 'Nikon is not Niko');

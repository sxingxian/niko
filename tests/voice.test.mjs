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

// ---- Changing screen by voice
import { screenFor, takeScreenTag } from '../apps/app/src/speech.ts';
const go = {
  'switch to calendar': '/calendar', 'change to notes': '/notes', 'change the screen to inbox': '/inbox', 'Open my calendar.': '/calendar',
  'can you open my notes please': '/notes', 'could you show me the inbox': '/inbox', 'take me back to home': '/', 'go home': '/',
  'back to home screen': '/', 'calendar': '/calendar', 'my notes': '/notes', 'notes screen': '/notes', 'show me my schedule': '/calendar',
  'open my email': '/inbox', 'bring up connections': '/connections', 'go to integrations': '/connections', 'open voice settings': '/voice',
  'open engine settings': '/engine', 'open settings': '/appearance', 'change the colours': '/appearance', 'go to my account': '/account',
  "let's see the calendar": '/calendar', 'I want to see my messages': '/inbox', 'navigate to the engine page': '/engine', 'okay niko switch over to notes now': '/notes',
  'go back': 'back', 'take me back': 'back',
  // questions about what is on a screen go to the AI, not to the screen
  "what's on my calendar today": null, 'do I have any meetings tomorrow': null, 'show me what is on my calendar today': null,
  'read my latest messages': null, 'what notes did I write yesterday': null, 'open the email from Maya': null, 'tell me a joke': null,
};
for (const [phrase, want] of Object.entries(go)) ok(screenFor(phrase) === want, `"${phrase}" → ${want ?? 'the AI'} (got ${screenFor(phrase) ?? 'the AI'})`);
let tg = takeScreenTag('Opening your calendar. [[open:calendar]]');
ok(tg.text === 'Opening your calendar.' && tg.path === '/calendar', 'the AI can open a screen; the tag is not spoken: ' + JSON.stringify(tg));
tg = takeScreenTag('Sure. [[open:https://evil.example]]');
ok(tg.path === null && !tg.text.includes('[['), 'only Niko’s own screens can be opened that way');

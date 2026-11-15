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

// ---- Opening an item on screen
import { pickItem, takeItemTag } from '../apps/app/src/speech.ts';
const notes = ['Scheduled - XX', 'Scheduled - XX', 'Scheduled - XX', 'Scheduled - XX', '9130192411', 'testing 1235241', 'Testing 123021', 'Testing 123'];
const pk = { 'open Testing 123021': 6, 'open testing one two three zero two one': 6, 'open testing 1 2 3 0 2 1': 6, 'open the note testing 123': 7, 'show me testing 1235241': 5,
  'open 9130192411': 4, 'open scheduled XX': 0, 'open the second one': 1, 'open the fifth note': 4, 'open number 7': 6, 'open the last one': 7, 'can you open testing 123021 please': 6,
  'open testing 999': null, 'what is in testing 123': null, 'open calendar': null, 'open the twentieth one': null };
for (const [phrase, want] of Object.entries(pk)) ok(pickItem(phrase, notes) === want, `notes: "${phrase}" → ${want ?? 'none'} (got ${pickItem(phrase, notes) ?? 'none'})`);
ok(pickItem('next', notes, 2) === 3 && pickItem('previous', notes, 2) === 1 && pickItem('next', notes, 7) === null, 'next and previous move from the open item');
const events = ['Dentist', 'Team sync with the design group', 'Climbing'];
ok(pickItem('open the dentist appointment', events) === 0, 'event by a word in its title, with "appointment"');
ok(pickItem('show me the team sync', events) === 1, 'event by part of its title');
const inbox = ['Kaxa', 'Jun Wei', 'Maya Chen'];
ok(pickItem('open the message from Maya', inbox) === 2 && pickItem('open Jun Wei', inbox) === 1, 'conversation by sender');
const it = takeItemTag('Opening Testing 123021. [[item:notes:Testing 123021]]');
ok(it.text === 'Opening Testing 123021.' && it.item?.view === 'notes' && it.item.title === 'Testing 123021', 'the AI can name an item to open; the tag is not spoken');
ok(takeItemTag('Sure [[item:settings:x]]').item === null, 'only inbox, calendar and notes items');

// ---- Rewriting the draft by voice
import { rewriteRequest } from '../apps/app/src/speech.ts';
for (const p of ['rewrite the draft', 'Niko, rewrite it', 're-write that', 'try again', 'another version', 'make it shorter', 'make the reply more formal', 'more casual please', 'friendlier', 'shorten it', 'fix the grammar', 'say I will be there at 7', 'tell her thanks for the update', 'reply saying I am in', 'add that I will bring snacks', 'change the draft to mention Friday', "don't mention the price", 'rephrase it'])
  ok(rewriteRequest(p) !== null, `asks to change the draft: "${p}"`);
for (const p of ['what is the weather tomorrow', 'open my calendar', 'change to notes', 'send it', 'cancel', 'what time is my next meeting', 'open the second one', 'switch to inbox', 'more about the weather'])
  ok(rewriteRequest(p) === null, `not a draft change: "${p}"`);

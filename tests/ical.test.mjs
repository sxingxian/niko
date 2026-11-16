import { icalList, icalDetail, icalCheck, icalCheckOne, icalLinks, normalizeLink, forgetIcsCopies, calendarsOf, calendarsSecret, shownCalendars, kindOf, cleanCalName, newCalId } from '../apps/api/src/calendarlink.ts';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const ICS = [
'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Google Inc//Google Calendar 70.9054//EN',
'BEGIN:VTIMEZONE','TZID:Asia/Singapore','BEGIN:STANDARD','TZOFFSETFROM:+0800','TZOFFSETTO:+0800','TZNAME:+08','DTSTART:19700101T000000','END:STANDARD','END:VTIMEZONE',
'BEGIN:VEVENT','UID:one@x','DTSTART;TZID=Asia/Singapore:20261116T093000','DTEND;TZID=Asia/Singapore:20261116T103000','SUMMARY:Dentist','LOCATION:Orchard Rd','DESCRIPTION:Bring the forms.','ATTENDEE;CN=Maya:mailto:maya@example.com','END:VEVENT',
'BEGIN:VEVENT','UID:allday@x','DTSTART;VALUE=DATE:20261116','DTEND;VALUE=DATE:20261117','SUMMARY:Public holiday','END:VEVENT',
'BEGIN:VEVENT','UID:weekly@x','DTSTART;TZID=Asia/Singapore:20261102T180000','DTEND;TZID=Asia/Singapore:20261102T190000','RRULE:FREQ=WEEKLY;BYDAY=MO','EXDATE;TZID=Asia/Singapore:20261109T180000','SUMMARY:Climbing','END:VEVENT',
'BEGIN:VEVENT','UID:weekly@x','RECURRENCE-ID;TZID=Asia/Singapore:20261123T180000','DTSTART;TZID=Asia/Singapore:20261123T200000','DTEND;TZID=Asia/Singapore:20261123T210000','SUMMARY:Climbing (late)','END:VEVENT',
'BEGIN:VEVENT','UID:gone@x','DTSTART:20261116T050000Z','DTEND:20261116T060000Z','STATUS:CANCELLED','SUMMARY:Cancelled thing','END:VEVENT',
'END:VCALENDAR'].join('\r\n');
const URL1 = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics';
// Stand-ins that behave like the real servers, including what has broken real calendar apps:
// - Outlook published links answer 500 to anything without a browser User-Agent (Workers send none), and the
//   "HTML" link is a web page; a link that was unpublished answers 404.
// - Google's secret address works; its public address of a private calendar answers 404; embed links are pages.
const OUT = 'https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/abc/cid-1234/calendar.ics';
const OUT_ICS = ['BEGIN:VCALENDAR', 'METHOD:PUBLISH', 'VERSION:2.0', 'PRODID:Microsoft Exchange Server 2010',
  'BEGIN:VTIMEZONE', 'TZID:Singapore Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:040000008200E00074C5B7101A82E008000000', 'SUMMARY:Team sync', 'DTSTART;TZID=Singapore Standard Time:20261116T140000', 'DTEND;TZID=Singapore Standard Time:20261116T143000', 'CLASS:PUBLIC', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');
const browserUA = (h) => /^Mozilla\/5\.0 \((Windows|Macintosh|X11)/.test(new Headers(h).get('user-agent') ?? '');
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const u = String(input); seen.push({ u, ua: new Headers(init.headers).get('user-agent') });
  const html = (status = 200) => new Response('<!doctype html><html><body>Outlook</body></html>', { status, headers: { 'content-type': 'text/html' } });
  if (u === URL1) return new Response(ICS, { headers: { 'content-type': 'text/calendar' } });
  if (u.startsWith('https://calendar.google.com/calendar/ical/') && u.includes('/public/')) return new Response('Not Found', { status: 404 });
  if (u.startsWith('https://outlook.live.com/')) {
    if (!browserUA(init.headers)) return html(500);
    if (u === OUT) return new Response(OUT_ICS, { headers: { 'content-type': 'text/calendar; charset=utf-8' } });
    if (u.endsWith('/calendar.html')) return html();
    return html(404);
  }
  if (u === 'https://slow.example.com/a.ics') throw new DOMException('timed out', 'TimeoutError');
  return new Response('nope', { status: 404 });
};
const tz = -480; // Singapore, as the browser reports it
const day = (y, m, d) => { const s = new Date(Date.UTC(y, m - 1, d) + tz * 60_000); return [s, new Date(s.getTime() + 86_400_000)]; };
const S = { url: 'webcal://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics' };
ok(icalLinks(S)[0] === URL1, 'webcal:// is read as https://');
await icalCheck(S); ok(true, 'link check passes');
const fails = async (secret, re, what) => { try { await icalCheck(secret); ok(false, what + ' (was accepted)'); } catch (e) { ok(re.test(e.message) && !/https?:\/\//.test(e.message), `${what}: ${e.message}`); } };
await fails({ url: 'https://example.com/missing.ics' }, /“Calendar 1” calendar address no longer works/, 'a dead link is explained');
const sgt = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
let [a, b] = day(2026, 11, 16);
let ev = await icalList(S, a, b, tz);
ok(ev.map((e) => e.title).join('|') === 'Public holiday|Dentist|Climbing', 'Mon 16 Nov: ' + ev.map((e) => `${e.title}${e.allDay ? ' (all day)' : ' ' + sgt(e.start)}`).join(', '));
ok(sgt(ev.find((e) => e.title === 'Dentist').start) === '09:30', 'time zone respected (09:30 Singapore)');
ok(ev.find((e) => e.title === 'Public holiday').allDay && ev.find((e) => e.title === 'Public holiday').start === a.getTime(), 'all-day event starts at the user’s local midnight');
ok(!ev.some((e) => /Cancelled/.test(e.title)), 'cancelled events are left out');
[a, b] = day(2026, 11, 9); ev = await icalList(S, a, b, tz);
ok(!ev.some((e) => e.title.startsWith('Climbing')), 'a skipped week (EXDATE) does not show');
[a, b] = day(2026, 11, 23); ev = await icalList(S, a, b, tz);
ok(ev.length === 1 && ev[0].title === 'Climbing (late)' && sgt(ev[0].start) === '20:00', 'a moved week shows its new time: ' + ev.map((e) => e.title + ' ' + sgt(e.start)));
[a, b] = day(2026, 11, 16); ev = await icalList(S, a, b, tz);
const d = await icalDetail(S, ev.find((e) => e.title === 'Dentist').id, tz);
ok(d.location === 'Orchard Rd' && d.description === 'Bring the forms.' && d.attendees[0] === 'Maya', 'event opens with place, notes and people: ' + JSON.stringify(d));
const w = await icalDetail(S, ev.find((e) => e.title === 'Climbing').id, tz);
ok(w.title === 'Climbing' && sgt(w.start) === '18:00', 'a repeating event opens on the right day');
try { await icalDetail(S, '5~0~x', tz); ok(false, 'bad id'); } catch (e) { ok(true, 'an id from another link is refused'); }
ok(icalLinks({ url: 'http://example.com/a.ics', url2: 'https://192.168.1.2/a.ics', url3: 'https://localhost/a.ics' }).length === 0, 'plain http, private and local addresses are never fetched');

// ---- Outlook and Google, the way people actually paste them
await icalCheck({ url: OUT }); ok(true, 'Outlook published ICS link connects');
ok(seen.filter((x) => x.u === OUT).every((x) => browserUA({ 'user-agent': x.ua })), 'Outlook is asked with a browser User-Agent (it refuses others)');
ok(normalizeLink(OUT.replace('calendar.ics', 'calendar.html')) === OUT, 'Outlook’s HTML link is turned into its ICS link');
await icalCheck({ url: OUT.replace('calendar.ics', 'calendar.html') }); ok(true, 'pasting Outlook’s HTML link still connects');
ok(normalizeLink('webcal://outlook.live.com/owa/calendar/x/y/calendar.html') === 'https://outlook.live.com/owa/calendar/x/y/calendar.ics', 'webcal + HTML link both fixed');
await fails({ url: 'https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/gone/cid-1/calendar.ics' }, /Outlook didn’t hand over the “Calendar 1” calendar.*still published/, 'an unpublished Outlook calendar is explained');
await fails({ url: 'https://calendar.google.com/calendar/ical/me%40gmail.com/public/basic.ics' }, /public address.*Secret address in iCal format/, 'Google public address of a private calendar is explained');
await fails({ url: 'https://calendar.google.com/calendar/embed?src=me%40gmail.com' }, /web page.*Secret address in iCal format/, 'Google embed link is explained');
await fails({ url: URL1, url2: 'https://calendar.google.com/calendar/ical/x/private-old/basic.ics' }, /“Calendar 2” calendar address no longer exists/, 'the failing address is named');
await fails({ url: 'https://slow.example.com/a.ics' }, /didn’t answer in time/, 'a server that times out is explained');

// Google + Outlook together, as in the screenshot
const BOTH = { url: URL1, url2: OUT };
await icalCheck(BOTH); ok(true, 'Google secret address + Outlook ICS link connect together');
[a, b] = day(2026, 11, 16); ev = await icalList(BOTH, a, b, tz);
ok(ev.some((e) => e.title === 'Dentist') && ev.some((e) => e.title === 'Team sync'), 'events from both calendars are listed: ' + ev.map((e) => e.title).join(', '));
const o = await icalDetail(BOTH, ev.find((e) => e.title === 'Team sync').id, tz);
ok(o.title === 'Team sync' && sgt(o.start) === '14:00', 'an Outlook event (Windows time-zone name) opens at 14:00 Singapore');
// One calendar breaking later must not hide the other
ev = await icalList({ url: URL1, url2: 'https://outlook.live.com/owa/calendar/0/gone/cid-1/calendar.ics' }, a, b, tz);
ok(ev.some((e) => e.title === 'Dentist'), 'a calendar that stops working does not hide the others');
try { await icalList({ url: 'https://outlook.live.com/owa/calendar/0/gone/cid-1/calendar.ics' }, a, b, tz); ok(false, 'all failed accepted'); } catch { ok(true, 'when every address fails, the problem is reported'); }

// ---- A named list of calendars (private and public), editable
{
  const legacy = calendarsOf(BOTH);
  ok(legacy.length === 2 && legacy[0].id === '0' && legacy[1].id === '1' && legacy[0].name === 'Calendar 1', 'older url/url2 links become a list with ids 0 and 1, so their event ids stay the same');
  const PUB = 'https://calendar.google.com/calendar/ical/en.singapore%23holiday%40group.v.calendar.google.com/public/basic.ics';
  ok(kindOf(URL1) === 'private' && kindOf(PUB) === 'public' && kindOf(OUT) === 'private', 'Google public addresses are recognised; everything else is treated as private');
  const list = [{ id: 'work1', name: 'Work', url: URL1, kind: 'private', on: true }, { id: 'out1', name: 'Family', url: OUT, kind: 'private', on: true }, { id: 'pub1', name: 'Holidays', url: PUB, kind: 'public', on: false }];
  const S3 = calendarsSecret(list);
  ok(calendarsOf(S3).length === 3 && calendarsOf(S3)[2].on === false, 'the list is stored and read back, including a switched-off calendar');
  const shown = shownCalendars(calendarsOf(S3));
  ok(shown[0].address === 'calendar.google.com/…/basic.ics' && !shown.some((c) => c.kind === 'private' && /private-abc|cid-1234/.test(c.address)), 'a private address is never shown back in full: ' + shown[0].address);
  ok(shown[2].address === PUB, 'a public address is shown in full');
  ev = await icalList(S3, a, b, tz);
  ok(ev.find((e) => e.title === 'Dentist')?.source === 'Work' && ev.find((e) => e.title === 'Team sync')?.source === 'Family', 'events carry their calendar’s name');
  ok(ev.every((e) => /^(work1|out1)~/.test(e.id)), 'a switched-off calendar is not read');
  ok((await icalDetail(S3, ev.find((e) => e.title === 'Team sync').id, tz)).source === 'Family', 'an event opens from its own calendar');
  try { await icalDetail(S3, 'pub1~0~x', tz); ok(false, 'off calendar opened'); } catch { ok(true, 'an event from a switched-off calendar is refused'); }
  ev = await icalList(S3, a, b, tz, 1);
  ok(ev.every((e) => e.id.startsWith('work1~')), 'only as many calendars as the account may keep are read');
  ok(calendarsOf({ cals: '[{"id":"../x","name":"a","url":"https://example.com/a.ics"},{"id":"ok","name":"b","url":"http://10.0.0.1/a.ics"},{"id":"ok2","name":"<b>“Hi”</b>","url":"https://example.com/b.ics"}]' }).map((c) => c.id + ':' + c.name).join() === 'ok2:bHi/b', 'bad ids, private addresses and markup in names are dropped');
  ok(cleanCalName('  Work\n  stuff  ') === 'Work stuff' && /^[a-z0-9]{8}$/.test(newCalId()), 'names are tidied; new ids are short and plain');
  await icalCheckOne(URL1, 'Work'); ok(true, 'one address is checked on its own before it is saved');
  try { await icalCheckOne('https://example.com/missing.ics', 'Gym'); ok(false, 'dead accepted'); } catch (e) { ok(/“Gym” calendar address no longer works/.test(e.message) && !/https?:/.test(e.message), 'a failing check names the calendar and never repeats the address: ' + e.message); }
  ok(calendarsOf({ cals: JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ id: 'c' + i, name: 'C', url: `https://example.com/${i}.ics` }))) }).length === 50, 'never more than 50 are read from storage');
}

// ---- Rate limits: read each feed at most every 10 minutes, keep the last good copy, back off when told to
{
  const realNow = Date.now; let clock = realNow.call(Date); Date.now = () => clock;
  const G = 'https://calendar.google.com/calendar/ical/rl%40gmail.com/private-x/basic.ics';
  let calls = 0, mode = 'ok', retryAfter = null, uaSeen = '';
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) !== G) return before(input, init);
    calls++; uaSeen = new Headers(init.headers).get('user-agent') ?? '';
    if (mode === '429') return new Response('<html>Too many requests (CAPTCHA)</html>', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
    if (mode === '503') return new Response('busy', { status: 503 });
    return new Response(ICS, { headers: { 'content-type': 'text/calendar' } });
  };
  forgetIcsCopies();
  const S2 = { url: G };
  let [x, y] = day(2026, 11, 16);
  await icalList(S2, x, y, tz); await icalList(S2, x, y, tz); await icalDetail(S2, (await icalList(S2, x, y, tz))[1].id, tz);
  ok(calls === 1, `within 10 minutes the feed is read once, however often screens ask (${calls} read)`);
  ok(!/Mozilla/.test(uaSeen) && /Niko-Calendar/.test(uaSeen), 'Google is asked as a calendar client, not as a browser');
  clock += 11 * 60_000; await icalList(S2, x, y, tz);
  ok(calls === 2, 'after 10 minutes it is read again');
  // Google says 429 with a saved copy: the copy is shown quietly, and Google is left alone for Retry-After.
  mode = '429'; retryAfter = '1200'; clock += 11 * 60_000;
  const ev429 = await icalList(S2, x, y, tz);
  ok(ev429.some((e) => e.title === 'Dentist'), '429 with a saved copy: events still show, no error');
  const c429 = calls; clock += 5 * 60_000; await icalList(S2, x, y, tz); clock += 10 * 60_000; await icalList(S2, x, y, tz);
  ok(calls === c429, `during the 20 min Google asked for (Retry-After: 1200), it is not asked again (${calls - c429} extra)`);
  mode = 'ok'; clock += 6 * 60_000; await icalList(S2, x, y, tz);
  ok(calls === c429 + 1, 'after the wait, it is read again');
  // 503 is a passing fault: same treatment, 5 minutes.
  mode = '503'; clock += 11 * 60_000;
  ok((await icalList(S2, x, y, tz)).length > 0, 'a server fault (503) with a saved copy: events still show');
  // No saved copy at all and Google says 429: a plain message, and no hammering.
  forgetIcsCopies(); mode = '429'; retryAfter = null; calls = 0; clock += 60 * 60_000;
  try { await icalList(S2, x, y, tz); ok(false, '429 without copy accepted'); } catch (e) { ok(/Google is limiting how often the “Calendar 1” calendar can be read.*about 15 min/.test(e.message), '429 with no saved copy explains and says when: ' + e.message); }
  try { await icalList(S2, x, y, tz); } catch (e) { ok(calls === 1 && /asked Niko to wait/.test(e.message), 'and asking again right away does not call Google: ' + e.message); }
  Date.now = realNow;
}

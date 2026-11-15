import { icalList, icalDetail, icalCheck, icalLinks } from '../apps/api/src/calendarlink.ts';
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
globalThis.fetch = async (u) => (String(u) === URL1 ? new Response(ICS, { headers: { 'content-type': 'text/calendar' } }) : new Response('nope', { status: 404 }));
const tz = -480; // Singapore, as the browser reports it
const day = (y, m, d) => { const s = new Date(Date.UTC(y, m - 1, d) + tz * 60_000); return [s, new Date(s.getTime() + 86_400_000)]; };
const S = { url: 'webcal://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics' };
ok(icalLinks(S)[0] === URL1, 'webcal:// is read as https://');
await icalCheck(S); ok(true, 'link check passes');
try { await icalCheck({ url: 'https://example.com/missing.ics' }); ok(false, 'bad link'); } catch (e) { ok(/no longer works/.test(e.message), 'a dead link is explained: ' + e.message); }
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

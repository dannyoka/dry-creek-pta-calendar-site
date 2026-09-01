/**
 * Test harness for Code.gs. Runs the real sync logic against the live district
 * feed with a mock Google Calendar, so nothing touches a real calendar.
 *
 *   cd sync && node test.js
 *
 * Run this after changing CONFIG.excludePatterns or the parser. The tests that
 * matter most are #4 and #7: PTA-authored events must survive every code path,
 * and a broken feed must never wipe the calendar.
 */
const fs = require('fs');
const path = require('path');

const SRC     = path.join(__dirname, 'Code.gs');
const FIXTURE = path.join(__dirname, 'district.ics'); // cached feed, optional

let FEED = '';
const logs = [];

// ---- Apps Script stubs ------------------------------------------------------
global.Logger = { log: m => logs.push(String(m)) };
global.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => FEED }) };
global.Session = { getScriptTimeZone: () => 'America/Denver' };
global.Utilities = { formatDate: d => d.toISOString().slice(0, 10) };
global.MailApp = { sendEmail: () => {} };
global.ScriptApp = {
  getProjectTriggers: () => [],
  newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }) }) }),
  deleteTrigger: () => {},
};

let SEQ = 0;
class MockEvent {
  constructor(title, start, end, allDay, opts) {
    Object.assign(this, { title, start, end, allDay, tags: {}, id: ++SEQ, opts: opts || {}, deleted: false });
  }
  getTitle() { return this.title; }
  getStartTime() { return this.start; }
  getTag(k) { return this.tags[k] || null; }
  setTag(k, v) { this.tags[k] = v; return this; }
  removeAllReminders() { return this; }
  deleteEvent() { this.deleted = true; CAL.events = CAL.events.filter(e => e !== this); }
}
const CAL = {
  events: [],
  getEvents(min, max) { return this.events.filter(e => e.end > min && e.start < max); },
  createAllDayEvent(t, s, e, o) { const ev = new MockEvent(t, s, e, true, o); this.events.push(ev); return ev; },
  createEvent(t, s, e, o) { const ev = new MockEvent(t, s, e, false, o); this.events.push(ev); return ev; },
};
global.CalendarApp = { getCalendarById: id => (id === 'test-cal' ? CAL : null) };

// Indirect eval runs in global scope; top-level const -> var so it lands on globalThis.
(0, eval)(fs.readFileSync(SRC, 'utf8').replace(/^const /gm, 'var '));
CONFIG.ptaCalendarId = 'test-cal';

let pass = 0, fail = 0;
const chk = (name, cond, extra) =>
  cond ? (pass++, console.log('  PASS  ' + name))
       : (fail++, console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')));
const num = (s, label) => { const m = s.match(new RegExp(label + ' (\\d+)')); return m ? +m[1] : -1; };

/**
 * Edit the one VEVENT block carrying `uid`. Mutating by UID rather than by
 * SUMMARY text matters: titles like "Spring Break" repeat every school year, so
 * a text match would hit whichever copy appears first in the feed -- usually an
 * out-of-window one -- and the test would pass or fail depending on feed order.
 * `fn` returns the new block body, or null to delete the event entirely.
 */
function editBlock(feed, uid, fn) {
  const parts = feed.split('BEGIN:VEVENT');
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i].includes('UID:' + uid)) continue;
    const out = fn(parts[i]);
    if (out === null) parts.splice(i, 1); else parts[i] = out;
    return parts.join('BEGIN:VEVENT');
  }
  throw new Error('test setup: uid not found in feed: ' + uid);
}

async function main() {
  if (fs.existsSync(FIXTURE)) {
    FEED = fs.readFileSync(FIXTURE, 'utf8');
    console.log('using cached fixture: sync/district.ics');
  } else {
    console.log('fetching live district feed...');
    const url = CONFIG.districtIcsUrl;
    const r = await fetch(url);
    if (!r.ok) { console.error('feed fetch failed: HTTP ' + r.status); process.exit(1); }
    FEED = await r.text();
  }
  const ORIGINAL = FEED;

  console.log('\n=== 1. parser against the real feed ===');
  const parsed = parseIcs(FEED);
  chk('parses events', parsed.length > 100, parsed.length);
  chk('no unparsed dates', parsed.every(e => e.start instanceof Date && !isNaN(e.start)));
  chk('end always after start', parsed.every(e => e.end > e.start));
  const labor = parsed.find(e => /LABOR DAY/i.test(e.summary) && e.start.getFullYear() === 2026);
  chk('LABOR DAY 2026 = Sep 7 (no timezone drift)',
      labor && labor.start.getMonth() === 8 && labor.start.getDate() === 7,
      labor && labor.start.toDateString());
  const esc = parsed.find(e => /Martin Luther King/i.test(e.summary));
  chk('escaped comma unescaped', esc && esc.summary.includes('King, Jr'), esc && esc.summary);
  chk('VALARM blocks ignored', !parsed.some(e => e.summary === 'ACTION'));
  const kept = parsed.filter(e => e.start >= new Date() &&
    !CONFIG.excludePatterns.some(r => r.test(e.summary)));
  chk('every kept upcoming event is all-day', kept.every(e => e.allDay),
      kept.filter(e => !e.allDay).map(e => e.summary).join(', '));

  console.log('\n=== 2. first sync onto an empty calendar ===');
  let s = runSync(false);
  const created1 = num(s, 'created');
  chk('created events', created1 > 0, created1);
  chk('deleted nothing', num(s, 'deleted') === 0);
  chk('excluded some', num(s, 'excluded') > 0, num(s, 'excluded'));
  chk('no board meetings on calendar',
      !CAL.events.some(e => /board meeting|study session/i.test(e.title)));
  chk('kept the useful stuff', CAL.events.some(e => /BREAK|Teacher Work Day/i.test(e.title)));

  console.log('\n=== 3. re-running is idempotent ===');
  s = runSync(false);
  chk('created 0', num(s, 'created') === 0, num(s, 'created'));
  chk('updated 0', num(s, 'updated') === 0, num(s, 'updated'));
  chk('deleted 0', num(s, 'deleted') === 0, num(s, 'deleted'));
  chk('event count stable', CAL.events.length === created1, CAL.events.length);

  console.log('\n=== 4. PTA-authored events are never touched ===');
  const ptaEv = CAL.createAllDayEvent('PTA Fall Carnival', new Date(2026, 9, 3), new Date(2026, 9, 4), {});
  const ptaId = ptaEv.id;
  s = runSync(false);
  chk('PTA event survives sync', CAL.events.some(e => e.id === ptaId));
  chk('PTA event not deleted', !ptaEv.deleted);
  chk('reported as untouched', /untouched: 1/.test(s), (s.match(/untouched: \d+/) || [])[0]);
  chk('no spurious deletes', num(s, 'deleted') === 0, num(s, 'deleted'));

  console.log('\n=== 5. a district-side edit produces an update ===');
  // Deterministic target: earliest kept upcoming event, addressed by UID.
  const target = kept.slice().sort((a, b) => a.start - b.start)[0];
  console.log('  (target: "' + target.summary + '" on ' + target.start.toDateString() + ')');
  FEED = editBlock(FEED, target.uid,
    b => b.replace('SUMMARY:' + target.summary, 'SUMMARY:' + target.summary + ' - EXTENDED'));
  s = runSync(false);
  chk('exactly 1 update', num(s, 'updated') === 1, num(s, 'updated'));
  chk('new title applied', CAL.events.some(e => /EXTENDED/.test(e.title)));
  chk('PTA event still alive', CAL.events.some(e => e.id === ptaId));

  console.log('\n=== 6. a district removal produces a delete ===');
  const before = CAL.events.length;
  FEED = editBlock(FEED, target.uid, () => null);
  s = runSync(false);
  chk('exactly 1 delete', num(s, 'deleted') === 1, num(s, 'deleted'));
  chk('count dropped by 1', CAL.events.length === before - 1, CAL.events.length);
  chk('PTA event STILL alive', CAL.events.some(e => e.id === ptaId));

  console.log('\n=== 7. safety guard: empty or broken feed ===');
  const snapshot = CAL.events.length;
  FEED = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
  let threw = false;
  try { runSync(false); } catch (e) { threw = true; }
  chk('throws instead of wiping the calendar', threw);
  chk('calendar untouched after failure', CAL.events.length === snapshot, CAL.events.length);

  console.log('\n=== 8. previewSync writes nothing ===');
  FEED = ORIGINAL;
  const pre = CAL.events.length;
  s = runSync(true);
  chk('preview flagged', s.startsWith('[PREVIEW]'));
  chk('no writes during preview', CAL.events.length === pre, CAL.events.length);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) { console.log('--- last log ---\n' + (logs[logs.length - 1] || '')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });

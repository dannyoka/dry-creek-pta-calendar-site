/**
 * District -> PTA calendar sync.
 *
 * Mirrors the district's public calendar into the PTA calendar, filtering out
 * events parents don't need, so parents subscribe to ONE calendar.
 *
 * Safety property: this script only ever touches events it created itself.
 * Synced events are tagged with `districtUid`. Anything without that tag is a
 * PTA-authored event and is never modified or deleted.
 *
 * Setup: see SETUP.md in the repo. Run `previewSync` first -- it reports what
 * would change without writing anything.
 */

const CONFIG = {
  // The PTA calendar's ID (Settings -> your calendar -> Integrate calendar).
  ptaCalendarId: '',

  districtIcsUrl:
    'https://calendar.google.com/calendar/ical/' +
    'c_e107c6330df83760fdfc1b2a39762a8ee1575bcf8e898c195304658d6b3f386a' +
    '%40group.calendar.google.com/public/basic.ics',

  // District events whose title matches any of these are not copied over.
  excludePatterns: [
    /board meeting/i,
    /study session/i,
    /\bgraduation\b/i,
    /commencement/i,
    /board & cabinet/i,
  ],

  // Prefix added to copied titles so parents can tell them apart. '' to disable.
  titlePrefix: '',

  // How much of the calendar this script manages. Events outside this window
  // are left alone entirely.
  daysBack: 30,
  daysAhead: 400,

  // Email address to alert if a sync fails. '' to disable.
  notifyEmailOnError: '',
};

const TAG_UID = 'districtUid';   // marks an event as ours to manage
const TAG_FP  = 'districtFp';    // fingerprint, for detecting district-side edits

/* ---- Entry points ------------------------------------------------------ */

/** Time-driven trigger points here. */
function syncDistrictCalendar() {
  return runSync(false);
}

/** Run manually from the editor to see what would change. Writes nothing. */
function previewSync() {
  return runSync(true);
}

/* ---- Core -------------------------------------------------------------- */

function runSync(dryRun) {
  const t0 = new Date().getTime();
  try {
    if (!CONFIG.ptaCalendarId) {
      throw new Error('CONFIG.ptaCalendarId is empty -- set it before running.');
    }
    const calendar = CalendarApp.getCalendarById(CONFIG.ptaCalendarId);
    if (!calendar) {
      throw new Error(
        'Cannot open calendar ' + CONFIG.ptaCalendarId +
        '. Check the ID, and that this account has "Make changes to events".');
    }

    const now       = new Date();
    const windowMin = addDays(now, -CONFIG.daysBack);
    const windowMax = addDays(now,  CONFIG.daysAhead);

    // 1. Fetch and parse the district feed.
    const resp = UrlFetchApp.fetch(CONFIG.districtIcsUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('District feed returned HTTP ' + resp.getResponseCode() +
                      '. The calendar may have been made private.');
    }
    const parsed = parseIcs(resp.getContentText());
    if (!parsed.length) {
      throw new Error('District feed parsed to zero events -- aborting rather ' +
                      'than deleting everything.');
    }

    // 2. Filter: drop excluded titles, out-of-window dates, and recurring events.
    const wanted = {};
    let skippedExcluded = 0, skippedWindow = 0, skippedRecurring = 0;
    parsed.forEach(function (ev) {
      if (ev.rrule) { skippedRecurring++; return; }
      if (CONFIG.excludePatterns.some(function (re) { return re.test(ev.summary); })) {
        skippedExcluded++; return;
      }
      if (ev.end <= windowMin || ev.start >= windowMax) { skippedWindow++; return; }
      wanted[ev.uid] = ev;
    });

    // 3. Index what we've already synced. Untagged events are the PTA's -- skip.
    const existing = {};
    let ptaOwned = 0;
    calendar.getEvents(windowMin, windowMax).forEach(function (e) {
      const uid = safeTag(e, TAG_UID);
      if (!uid) { ptaOwned++; return; }
      // Defensive: if the district feed ever repeats a UID, keep one, drop dupes.
      if (existing[uid]) { if (!dryRun) e.deleteEvent(); return; }
      existing[uid] = e;
    });

    // 4. Reconcile.
    const plan = { created: [], updated: [], deleted: [] };

    Object.keys(wanted).forEach(function (uid) {
      const ev = wanted[uid];
      const fp = fingerprint(ev);
      const cur = existing[uid];
      if (!cur) {
        plan.created.push(ev.summary + ' -- ' + fmt(ev.start));
        if (!dryRun) writeEvent(calendar, ev, fp, null);
      } else if (safeTag(cur, TAG_FP) !== fp) {
        plan.updated.push(ev.summary + ' -- ' + fmt(ev.start));
        if (!dryRun) writeEvent(calendar, ev, fp, cur);
      }
    });

    Object.keys(existing).forEach(function (uid) {
      if (wanted[uid]) return;
      plan.deleted.push(existing[uid].getTitle() + ' -- ' + fmt(existing[uid].getStartTime()));
      if (!dryRun) existing[uid].deleteEvent();
    });

    const summary =
      (dryRun ? '[PREVIEW] ' : '') +
      'district feed: ' + parsed.length + ' events | ' +
      'kept ' + Object.keys(wanted).length +
      ' (excluded ' + skippedExcluded +
      ', out-of-window ' + skippedWindow +
      ', recurring ' + skippedRecurring + ') | ' +
      'created ' + plan.created.length +
      ', updated ' + plan.updated.length +
      ', deleted ' + plan.deleted.length +
      ' | PTA-authored events left untouched: ' + ptaOwned +
      ' | ' + (new Date().getTime() - t0) + 'ms';

    Logger.log(summary);
    ['created', 'updated', 'deleted'].forEach(function (k) {
      if (plan[k].length) Logger.log('  ' + k + ':\n    ' + plan[k].join('\n    '));
    });
    if (skippedRecurring) {
      Logger.log('  NOTE: skipped ' + skippedRecurring + ' recurring district event(s). ' +
                 'If any of those matter to parents, add them by hand.');
    }
    return summary;

  } catch (err) {
    Logger.log('SYNC FAILED: ' + err.message);
    if (CONFIG.notifyEmailOnError && !dryRun) {
      MailApp.sendEmail(CONFIG.notifyEmailOnError,
        'PTA calendar sync failed',
        'The district -> PTA calendar sync failed:\n\n' + err.stack +
        '\n\nParents will keep seeing the last successful sync until this is fixed.');
    }
    throw err;
  }
}

/** Create or update one event, then tag it as ours. */
function writeEvent(calendar, ev, fp, existingEvent) {
  if (existingEvent) existingEvent.deleteEvent();  // simplest correct update

  const opts = {};
  if (ev.description) opts.description = ev.description;
  if (ev.location)    opts.location    = ev.location;

  const title = CONFIG.titlePrefix + ev.summary;
  const e = ev.allDay
    ? calendar.createAllDayEvent(title, ev.start, ev.end, opts)
    : calendar.createEvent(title, ev.start, ev.end, opts);

  e.removeAllReminders();          // don't inherit the district's alarms
  e.setTag(TAG_UID, ev.uid);
  e.setTag(TAG_FP,  fp);
  return e;
}

/** Content hash -- catches district-side edits and changes to our own filters. */
function fingerprint(ev) {
  return [
    ev.summary, ev.location || '', ev.description || '',
    ev.start.getTime(), ev.end.getTime(), ev.allDay ? 'A' : 'T',
    CONFIG.titlePrefix,
  ].join('');
}

function safeTag(event, key) {
  try { return event.getTag(key); } catch (e) { return null; }
}

/* ---- Minimal RFC 5545 parser ------------------------------------------- */

function parseIcs(text) {
  // Unfold: a CRLF followed by space or tab continues the previous line.
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').split('\n');

  const events = [];
  let cur = null, inAlarm = false;

  lines.forEach(function (line) {
    if (line === 'BEGIN:VEVENT') { cur = {}; return; }
    if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.start && cur.summary) {
        if (!cur.end) {
          cur.end = cur.allDay ? addDays(cur.start, 1)
                               : new Date(cur.start.getTime() + 3600000);
        }
        events.push(cur);
      }
      cur = null; return;
    }
    if (!cur) return;
    if (line === 'BEGIN:VALARM') { inAlarm = true; return; }  // ignore alarm blocks
    if (line === 'END:VALARM')   { inAlarm = false; return; }
    if (inAlarm) return;

    const sep = line.indexOf(':');
    if (sep < 0) return;
    const rawName = line.substring(0, sep);
    const value   = line.substring(sep + 1);
    const name    = rawName.split(';')[0].toUpperCase();
    // Google tags all-day events with VALUE=DATE. Also treat a bare 8-digit
    // value as all-day, in case the district's tooling ever omits the param.
    const isDate  = /VALUE=DATE(?![-A-Z])/i.test(rawName) || /^\d{8}$/.test(value);

    switch (name) {
      case 'UID':         cur.uid         = value; break;
      case 'SUMMARY':     cur.summary     = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value); break;
      case 'LOCATION':    cur.location    = unescapeText(value); break;
      case 'RRULE':       cur.rrule       = value; break;
      case 'DTSTART':     cur.start = parseIcsDate(value, isDate); cur.allDay = isDate; break;
      case 'DTEND':       cur.end   = parseIcsDate(value, isDate); break;
    }
  });

  return events;
}

/**
 * Date-only values and TZID/floating times are read in the *script's* timezone,
 * which must be set to the district's (America/Denver) or dates shift by a day.
 * Values ending in Z are UTC.
 */
function parseIcsDate(value, isDate) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) throw new Error('Unparseable date in district feed: ' + value);

  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (isDate || !m[4]) return new Date(y, mo, d);

  const h = +m[4], mi = +m[5], s = +m[6];
  return m[7] ? new Date(Date.UTC(y, mo, d, h, mi, s)) : new Date(y, mo, d, h, mi, s);
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',')
          .replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/* ---- Small helpers ----------------------------------------------------- */

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

function fmt(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Run once to install the recurring trigger. Safe to re-run; replaces existing. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncDistrictCalendar') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncDistrictCalendar').timeBased().everyHours(6).create();
  Logger.log('Trigger installed: syncDistrictCalendar every 6 hours.');
}

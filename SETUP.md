# PTA Calendar — Setup

Parents subscribe to **one** calendar. District no-school days are copied into it
automatically every 6 hours; the PTA adds its own events to the same calendar by
hand. One-time setup is about 20 minutes.

## How it works

```
  District's public calendar  ──┐
  (they maintain it, we read)   │
                                ├──►  PTA Calendar  ──►  parents
  PTA volunteers add events  ───┘     (the one they add)
  directly in Google Calendar
```

A Google Apps Script owned by the PTA account runs on a timer, reads the
district's public feed, and mirrors the relevant events across.

**The one safety property worth understanding:** every event the script copies is
tagged with the district's event ID. The script only ever modifies or deletes
events carrying that tag. Events the PTA creates by hand have no tag, so the
sync can't touch them. This is covered by tests (`sync/test.js`, cases 4 and 6).

### Why Apps Script and not GitHub Actions

Apps Script runs *as* the PTA account that already owns the calendar, so there
are no credentials to manage. The GitHub Actions equivalent needs a Google
service account whose private key lives in repo secrets — a long-lived
credential handed between rotating volunteers. GitHub also
[auto-disables scheduled workflows after 60 days without commits](https://docs.github.com/actions/managing-workflow-runs/disabling-and-enabling-a-workflow),
which would silently stop the sync over summer break — exactly when next year's
district dates get published.

The parsing and reconciliation logic is plain JavaScript, so porting to Actions
or a Cloudflare Worker later is about 20 lines of glue.

## 1. Create the PTA calendar

Sign in to a **shared PTA Google account**, not a personal one — the calendar
should outlive any one volunteer, and Google has no clean way to transfer
calendar ownership later. If there's no shared account, make a free Gmail
(e.g. `ourschoolpta@gmail.com`) and store the password wherever the PTA keeps
shared credentials.

1. [Google Calendar](https://calendar.google.com) → gear → **Settings**
2. **Add calendar** → **Create new calendar**
3. Name it, set timezone **America/Denver**, click **Create**

## 2. Make it public

Everything else depends on this. Skip it and every subscribe link 404s.

1. Settings → select your new calendar in the sidebar
2. **Access permissions for events** → check **Make available to public**
3. Leave the dropdown on **See all event details**
4. Accept the warning — this is intended; it's how parents subscribe

## 3. Copy the calendar ID

Same page → **Integrate calendar** → copy **Calendar ID**. Looks like:

```
c_a1b2c3d4e5f6...@group.calendar.google.com
```

## 4. Set up the sync script

1. Go to [script.google.com](https://script.google.com) **signed in as the PTA
   account**, → **New project**
2. Delete the placeholder code, paste in all of `sync/Code.gs`
3. At the top, set `ptaCalendarId` to the ID from step 3
4. Project Settings (gear) → **Time zone** → **America/Denver**
   — if this is wrong, all-day events land on the wrong day
5. Optionally set `notifyEmailOnError` so a failing sync emails someone

### Preview before writing anything

Select **`previewSync`** in the function dropdown and click **Run**. Approve the
permission prompt (it asks for calendar access; "unverified app" is expected for
your own script — choose Advanced → Go to project).

Check **Execution log**. You should see something like:

```
[PREVIEW] district feed: 428 events | kept 20 (excluded 12, out-of-window 396,
recurring 4) | created 20, updated 0, deleted 0 | PTA-authored events left
untouched: 0
```

If the numbers look sane, run **`syncDistrictCalendar`** once for real, then look
at the calendar.

### Install the timer

Select **`installTrigger`** → **Run**. That schedules the sync every 6 hours.
Verify under the clock icon (**Triggers**) in the sidebar.

## 5. Give other board members access

So you're not a single point of failure: Calendar Settings → **Share with
specific people** → add 2 others with **Make changes to events**.

Note they'll be able to edit events but not the sync script; the script belongs
to whichever account created it. That's another reason to use a shared account.

## 6. Host the subscribe page

`index.html` is one self-contained file — no build step, no dependencies. Set
`SCHOOL_NAME` and `CALENDAR_ID` in the CONFIG block near the bottom, then:

- **Netlify Drop** — drag the folder onto <https://app.netlify.com/drop>. Free, instant URL.
- **GitHub Pages** — push the repo, Settings → Pages → deploy from `main`.
- **Existing PTA site** — upload as `calendar.html`.

Link it from the newsletter as "Add the school calendar to your phone."

## Tuning what gets copied

`CONFIG.excludePatterns` in `Code.gs` decides what's filtered out. It currently
drops Board Meetings, Study Sessions, and graduations — about 12 events a year
that aren't relevant to elementary parents. To keep something, delete its
pattern; to drop more, add a regex.

After changing it, re-run the tests:

```bash
cd sync && node test.js
```

Then run `previewSync` before the live sync. Changing a filter to be *more*
inclusive creates events; making it *less* inclusive deletes previously-synced
ones. Neither can affect PTA-authored events.

## Adding PTA events

Just add them to the calendar in Google Calendar as normal. Google users see them
immediately. Apple and Outlook users see them within a few hours, because those
apps poll subscribed feeds on their own schedule.

**The calendar is not an announcement channel.** You cannot push a notification
to subscribers — reminders are configured by each parent on their end. For "bake
sale is tomorrow," still send the email.

## Known limitations

- **Recurring district events are skipped.** All 4 in the current feed are
  expired 2023 board meetings, so nothing is lost today. If the district adds a
  real recurring event, the sync logs a NOTE and you'd add it by hand.
- **Sync window** is 30 days back to 400 days ahead. Events outside that range
  are ignored entirely, not deleted.
- **District renames create churn.** If the district edits an event title, the
  script deletes and recreates it, so a parent who had personally set a reminder
  on that event loses it. Rare, and unavoidable without the advanced Calendar API.

## Reference

District calendar (public, verified populated through 2027-05-31):

```
c_e107c6330df83760fdfc1b2a39762a8ee1575bcf8e898c195304658d6b3f386a@group.calendar.google.com
```

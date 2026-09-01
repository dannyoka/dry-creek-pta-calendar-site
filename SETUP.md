# PTA Calendar — Setup

One-time setup, ~15 minutes. After this, adding an event is just adding an event
in Google Calendar. There is no code to run and nothing to redeploy.

## How it works

Parents subscribe to **two** calendars:

| Calendar | Owner | Updates |
|---|---|---|
| **District Events** | The district (already exists, public) | Automatic — we never touch it |
| **PTA Events** | Us (created below) | Instant for Google users; a few hours for Apple/Outlook |

We deliberately do *not* copy district events into our calendar. The district
maintains theirs a year ahead; mirroring it would only create a second thing to
break. The one tradeoff: parents will see district Board Meetings on their
calendar. If that becomes a complaint, we can revisit.

## 1. Create the PTA calendar

Ideally sign in to a **shared PTA Google account**, not a personal one — the
calendar should outlive any one volunteer. If no shared account exists yet,
create one first (a free Gmail account is fine, e.g. `ourschoolpta@gmail.com`)
and store the password wherever the PTA keeps shared credentials.

1. Go to [Google Calendar](https://calendar.google.com) → gear icon → **Settings**
2. Left sidebar → **Add calendar** → **Create new calendar**
3. Name it `<School Name> PTA`, set the timezone to **America/Denver**, click **Create**

## 2. Make it public

This is the step everything else depends on. If you skip it, the subscribe
links return "not found."

1. Settings → pick your new calendar in the left sidebar
2. **Access permissions for events** → check **Make available to public**
3. Leave the dropdown on **See all event details**
4. Accept the warning — this is intended; it's how parents subscribe

## 3. Get the calendar ID

Same settings page → scroll to **Integrate calendar** → copy **Calendar ID**.
It looks like:

```
c_a1b2c3d4e5f6...@group.calendar.google.com
```

## 4. Configure the page

Open `index.html` and edit the CONFIG block near the bottom:

```js
const SCHOOL_NAME     = "Cedar Ridge Elementary";
const PTA_CALENDAR_ID = "c_a1b2c3...@group.calendar.google.com";
```

The district ID is already filled in. Until `PTA_CALENDAR_ID` is set, the PTA
card renders as a dashed "not published yet" placeholder.

## 5. Give other board members access

So you are not a single point of failure:

Settings → **Share with specific people** → add 2 other board members →
permission **Make changes to events**.

## 6. Host the page

`index.html` is a single self-contained file — no build step, no dependencies.

- **Netlify Drop** — drag the folder onto <https://app.netlify.com/drop>. Free, instant, gives you a URL.
- **GitHub Pages** — push this folder to a repo, Settings → Pages → deploy from `main`.
- **Existing PTA site** — if the PTA already has a website, upload it there as `calendar.html`.

Then link it from the newsletter as "Add the school calendar to your phone."

## Adding events from here on

Just add them in Google Calendar. Google users see them immediately; Apple and
Outlook users within a few hours.

**The calendar is not an announcement channel.** You cannot push a notification
to subscribers — reminders are set by each parent on their end. For "bake sale
is tomorrow," still send the email.

## Reference

District calendar ID:
```
c_e107c6330df83760fdfc1b2a39762a8ee1575bcf8e898c195304658d6b3f386a@group.calendar.google.com
```
Verified public and populated through 2027-05-31.

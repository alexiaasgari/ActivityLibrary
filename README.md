# Activity Library

A static HTML/CSS/JS app for storing activities you want to do — with:

- **Calendar view** for time-bound events (including recurring events)
- **List view** for everything you might do
  - **Active** shows upcoming + unscheduled
  - **Archive** shows items that have already passed
- Filtering by **type**, **price tier**, **neighborhood**, **starred**, and **date range** (list-only)
- Type-based color coding in the calendar + list
  - Neighborhoods are grouped by borough/region (e.g., Manhattan → Upper/Midtown/Lower; Brooklyn → West/East)
  - Type pills act as a color key for the calendar
- Notes for **tickets**, **addresses**, and anything else you want to remember
- Import/export:
  - **JSON** (copy/paste or upload/download)
  - **iCalendar (.ics)** (Google Calendar exports, museum free-times calendars, etc.)

## Running it

### Option A — open directly

Open `index.html` in a browser.

### Option B — run a tiny local server (recommended)

From the project folder:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Storage / persistence

This app always keeps a local copy in your browser via `localStorage`.

If you want changes to persist when you reopen the app on **GitHub Pages** (or on another device), use **GitHub Sync**:

1. Click **Settings → GitHub sync**
2. Provide a **Gist ID** and (optionally) a filename (default: `activity-library.json`)
3. Provide a GitHub token to **push** changes (the app can often **pull** without a token)

### Recommended approach

- Use a **dedicated gist** that stores one JSON file (e.g., `activity-library.json`).
- Turn on **Remember token on this device** only if you’re comfortable storing the token locally.

> Tokens are required for writing (pushing) back to GitHub.


## NYC neighborhood lookup

- Use **Settings → Lookup neighborhood from address** to auto-fill `borough` + `neighborhood` for items that have an address but are missing those fields.
- In the edit dialog, click **Lookup neighborhood (NYC)** to fill the neighborhood for a single item.

This uses the NYC GeoSearch API (Planning Labs).

## Calendar display

- **Condense 12am–8am** (toggle in Filters) so your 8am–late schedule is visible without a huge scroll.
- Any events that start before 8am show up in an **Early hours** strip above the calendar.

## Date filtering

- The **Date from / Date to** filter appears in **List view** and only affects the **list**.
- The **calendar** uses its own navigation (month/week/day). Type/cost/neighborhood filters still apply.
- If you set a date window, the list shows items with an **upcoming occurrence inside that window**.
- Use **Include unscheduled** to keep (or hide) places/ideas that don’t have a time yet.

## Seed data

This repo includes `seed.js`, generated from the Google Calendar `.ics` exports you uploaded.

- Clicking **Settings → Reset to seed** restores that original seed and removes your local edits.

## Data model (JSON)

The stored JSON looks like:

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-01-19T00:00:00.000Z",
  "items": [
    {
      "id": "…",
      "title": "Poster House",
      "summary": "Free Friday hours",
      "type": "museum",
      "tags": ["free"],
      "neighborhood": "Chelsea",
      "cost": 0,
      "isFree": true,
      "starred": false,
      "start": "2026-01-18T10:00:00",
      "end": "2026-01-18T18:00:00",
      "allDay": false,
      "rrule": "FREQ=MONTHLY;BYDAY=3SU",
      "exdate": [],
      "dateRange": null,
      "openHours": null,
      "notes": "Bring ID",
      "ticketsRequired": false,
      "ticketsLink": "",
      "haveTickets": false,
      "address": "119 W 23rd St, New York, NY 10011",
      "layer": "museumFreeTimes"
    }
  ]
}
```

## Recurrence support

This app supports the most common patterns you’ll likely use:

- `FREQ=DAILY`
- `FREQ=WEEKLY;BYDAY=WE,FR`
- `FREQ=MONTHLY;BYDAY=2SU` (2nd Sunday)
- Optional: `INTERVAL=2`, `UNTIL=…`
- Optional: `EXDATE` (excluded occurrences)

## Multi-week gallery shows with open hours

For a gallery show that spans multiple weeks with opening hours, fill:

- **Show/date range start** + **end**
- **Open hours JSON**

Example open hours JSON:

```json
[
  {"dow":[2,3,4,5],"start":"11:00","end":"18:00","label":"Open"},
  {"dow":[6],"start":"12:00","end":"17:00","label":"Open"}
]
```

Where `dow` uses `0=Sun … 6=Sat`.

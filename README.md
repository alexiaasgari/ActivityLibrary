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

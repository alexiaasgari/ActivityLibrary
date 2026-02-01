/*
  Activity Library (static HTML/CSS/JS)

  Features
  - Calendar view (FullCalendar from CDN)
  - List view (upcoming + unscheduled; past items are hidden)
  - Filters: text, type, neighborhood, cost, date range, layers, starred
  - Data entry: one-off events, recurring RRULE, multi-week open hours

  Storage
  - Always keeps a local copy in browser localStorage
  - Optional GitHub Gist sync:
      - Pull latest on load
      - Auto-push on changes (if token is provided)

  Notes
  - This intentionally focuses on common RRULE patterns (DAILY/WEEKLY/MONTHLY)
  - A GitHub token is required to push changes back to a gist.
*/

const STORAGE_KEY = 'activityVault.store.v1';
const CONFIG_KEY = 'activityVault.config.v1';
const SESSION_TOKEN_KEY = 'activityVault.githubToken.session.v1';
const SCHEMA_VERSION = 1;

// ---------- Utilities ----------

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function toArray(x) {
  return Array.isArray(x) ? x : (x ? [x] : []);
}

function normalizeStr(s) {
  return (s ?? '').toString().trim();
}

function slugify(s) {
  return normalizeStr(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function clampNumber(n, { min = -Infinity, max = Infinity } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function stableShortId(input) {
  // Deterministic short id (12 hex chars) from arbitrary string.
  // (Not cryptographic — just for stable merges.)
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  const h2 = ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
  return (hex + h2).slice(0, 12);
}

function newId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `id_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function parseNumberOrNull(x) {
  if (x === '' || x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function formatCost(item) {
  const explicitTier = normalizeStr(item?.priceTier).toLowerCase();
  const isFree = explicitTier === 'free' || item?.isFree === true || item?.cost === 0;
  if (isFree) return 'Free';

  // If an exact numeric cost exists, keep showing it.
  const c = parseNumberOrNull(item?.cost);
  if (c !== null) return `$${c}`;

  // Otherwise fall back to the tier.
  if (explicitTier === 'low') return 'Low';
  if (explicitTier === 'medium') return 'Medium';
  if (explicitTier === 'high') return 'High';

  return '—';
}

function parseDateTimeLocalValue(value) {
  // From <input type="datetime-local"> we get 'YYYY-MM-DDTHH:mm'
  // We'll store it as-is (local time). FullCalendar interprets local Date strings.
  const v = normalizeStr(value);
  return v ? v : null;
}

function parseDateOnlyValue(value) {
  const v = normalizeStr(value);
  return v ? v : null;
}

function parseAnyDate(value) {
  const v = normalizeStr(value);
  if (!v) return null;
  // Date-only
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  // ISO-ish
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfWeekMonday(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0..6, Sun=0
  const diff = (day === 0 ? -6 : 1 - day); // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

function monthsDiff(a, b) {
  // a, b are Dates. returns how many months to get from a -> b.
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function setTimeFrom(baseDate, timeSourceDate) {
  const d = new Date(baseDate);
  d.setHours(timeSourceDate.getHours(), timeSourceDate.getMinutes(), timeSourceDate.getSeconds(), 0);
  return d;
}

function intersectsRange(start, end, rangeStart, rangeEnd) {
  if (!start) return false;
  const s = start.getTime();
  const e = (end ?? start).getTime();
  return e > rangeStart.getTime() && s < rangeEnd.getTime();
}

function escapeHtml(s) {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

// ----- Calendar export helpers (.ics + Google Calendar template URL) -----

function escapeIcsText(value) {
  return (value ?? '').toString()
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatIcsDateOnly(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}`;
}

function formatIcsLocalDateTime(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
}

function formatIcsUtcDateTime(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}T${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}${pad2(dt.getUTCSeconds())}Z`;
}

function foldIcsLine(line, limit = 75) {
  // RFC 5545 line folding uses CRLF + space for continuations.
  // This is a simple character-based folding (good enough for typical calendar text).
  const out = [];
  let s = String(line ?? '');
  while (s.length > limit) {
    out.push(s.slice(0, limit));
    s = ' ' + s.slice(limit);
  }
  out.push(s);
  return out;
}

function buildIcsForItem(item, { tz = getLocalTimeZone() } = {}) {
  if (!item) throw new Error('No item provided.');
  if (!hasCalendarPresence(item)) throw new Error('This item has no scheduled time to export.');

  const calendarName = 'Activity Library';
  const uidBase = normalizeStr(item?.source?.uid) || `${item.id}@activity-library.local`;
  const dtstamp = formatIcsUtcDateTime(new Date());

  const commonDescriptionParts = [];
  if (normalizeStr(item.summary)) commonDescriptionParts.push(normalizeStr(item.summary));
  if (normalizeStr(item.notes)) commonDescriptionParts.push(normalizeStr(item.notes));
  if (normalizeStr(item.ticketsLink)) commonDescriptionParts.push(`Tickets: ${normalizeStr(item.ticketsLink)}`);
  const description = commonDescriptionParts.join('\n\n');

  const baseEventLines = ({ uid, summary }) => {
    const lines = [];
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcsText(uid)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${escapeIcsText(summary)}`);
    if (normalizeStr(description)) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
    if (normalizeStr(item.address)) lines.push(`LOCATION:${escapeIcsText(item.address)}`);
    return lines;
  };

  const vevents = [];

  // Open hours schedules: expand each opening block as its own VEVENT.
  if (item.dateRange && item.openHours) {
    const rs = startOfDay(parseAnyDate(item.dateRange?.start) || new Date());
    const re = addDays(endOfDay(parseAnyDate(item.dateRange?.end) || rs), 1);
    const occ = expandOpenHoursOccurrences(item, rs, re);
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());

    const max = 500;
    const sliced = occ.slice(0, max);
    for (const o of sliced) {
      const suffix = formatIcsLocalDateTime(o.start);
      const uid = `${uidBase}--open--${suffix}`;
      const summary = o.label ? `${item.title} — ${o.label}` : item.title;
      const lines = baseEventLines({ uid, summary });
      lines.push(`DTSTART;TZID=${tz}:${formatIcsLocalDateTime(o.start)}`);
      lines.push(`DTEND;TZID=${tz}:${formatIcsLocalDateTime(o.end)}`);
      lines.push('END:VEVENT');
      vevents.push(lines);
    }

    // Note: if we truncated, add a final note event (optional). We skip to keep files clean.
  } else {
    // Single or RRULE-based recurring event.
    const win = itemSingleInstanceWindow(item);
    if (!win?.start || !win?.end) throw new Error('Could not determine event start/end.');

    const summary = item.title || '(untitled)';
    const lines = baseEventLines({ uid: uidBase, summary });

    if (win.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatIcsDateOnly(win.start)}`);
      lines.push(`DTEND;VALUE=DATE:${formatIcsDateOnly(win.end)}`);
    } else {
      lines.push(`DTSTART;TZID=${tz}:${formatIcsLocalDateTime(win.start)}`);
      lines.push(`DTEND;TZID=${tz}:${formatIcsLocalDateTime(win.end)}`);
    }

    if (normalizeStr(item.rrule)) {
      lines.push(`RRULE:${normalizeStr(item.rrule)}`);

      const ex = toArray(item.exdate);
      if (ex.length > 0) {
        const parts = [];
        for (const x of ex) {
          const dx = parseAnyDate(x);
          if (!dx) continue;
          parts.push(win.allDay ? formatIcsDateOnly(dx) : formatIcsLocalDateTime(dx));
        }
        if (parts.length) {
          if (win.allDay) lines.push(`EXDATE;VALUE=DATE:${parts.join(',')}`);
          else lines.push(`EXDATE;TZID=${tz}:${parts.join(',')}`);
        }
      }
    }

    lines.push('END:VEVENT');
    vevents.push(lines);
  }

  const calLines = [];
  calLines.push('BEGIN:VCALENDAR');
  calLines.push('VERSION:2.0');
  calLines.push('CALSCALE:GREGORIAN');
  calLines.push('METHOD:PUBLISH');
  calLines.push('PRODID:-//Activity Library//EN');
  calLines.push(`X-WR-CALNAME:${escapeIcsText(calendarName)}`);
  calLines.push(`X-WR-TIMEZONE:${escapeIcsText(tz)}`);

  for (const block of vevents) {
    for (const line of block) calLines.push(line);
  }

  calLines.push('END:VCALENDAR');

  // Fold long lines and join using CRLF.
  const folded = [];
  for (const line of calLines) {
    folded.push(...foldIcsLine(line));
  }
  return folded.join('\r\n') + '\r\n';
}

function downloadTextFile(filename, text, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadIcsForItem(item) {
  const base = slugify(item?.title) || 'event';
  const filename = `${base}.ics`;
  const ics = buildIcsForItem(item, { tz: getLocalTimeZone() });
  downloadTextFile(filename, ics, 'text/calendar;charset=utf-8');
}

function formatGoogleDate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}`;
}

function formatGoogleDateTime(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
}

function buildGoogleCalendarUrl(item, { tz = getLocalTimeZone() } = {}) {
  if (!item || !hasCalendarPresence(item)) return '';

  // Determine the event window.
  let start = null;
  let end = null;
  let allDay = false;
  let recur = '';

  if (item.dateRange && item.openHours) {
    // For open-hours schedules, add the next upcoming opening as a single event.
    const win = nextOccurrenceWindow(item, new Date()) || null;
    if (!win) return '';
    start = win.start;
    end = win.end;
    allDay = false;
  } else {
    const win = itemSingleInstanceWindow(item);
    if (!win?.start || !win?.end) return '';
    start = win.start;
    end = win.end;
    allDay = win.allDay === true;
    if (normalizeStr(item.rrule)) {
      recur = `RRULE:${normalizeStr(item.rrule)}`;
    }
  }

  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text', normalizeStr(item.title) || 'Event');

  const detailParts = [];
  if (normalizeStr(item.summary)) detailParts.push(normalizeStr(item.summary));
  if (normalizeStr(item.notes)) detailParts.push(normalizeStr(item.notes));
  if (normalizeStr(item.ticketsLink)) detailParts.push(`Tickets: ${normalizeStr(item.ticketsLink)}`);
  const details = detailParts.join('\n\n');
  if (details) params.set('details', details);

  if (normalizeStr(item.address)) params.set('location', normalizeStr(item.address));

  if (allDay) {
    params.set('dates', `${formatGoogleDate(start)}/${formatGoogleDate(end)}`);
  } else {
    params.set('dates', `${formatGoogleDateTime(start)}/${formatGoogleDateTime(end)}`);
  }

  if (recur) params.set('recur', recur);
  if (normalizeStr(tz)) params.set('ctz', tz);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function formatShortDateTime(d) {
  if (!d) return '';
  const opts = { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString([], opts);
}

function formatShortDate(d) {
  if (!d) return '';
  const opts = { year: 'numeric', month: 'short', day: '2-digit' };
  return d.toLocaleDateString([], opts);
}

function toDateInputValue(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toTimeInputValue(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function splitDateTimeParts(value) {
  const v = normalizeStr(value);
  if (!v) return { date: '', time: '' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v, time: '' };
  const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };
  const d = parseAnyDate(v);
  if (!d) return { date: '', time: '' };
  return { date: toDateInputValue(d), time: toTimeInputValue(d) };
}

function combineDateAndTime(dateStr, timeStr) {
  const date = normalizeStr(dateStr);
  const time = normalizeStr(timeStr);
  if (!date) return null;
  if (!time) return date; // date-only (all-day)
  const t = (time.length >= 5) ? time.slice(0, 5) : time;
  return `${date}T${t}`;
}

// ---------- Local storage (always on) ----------

function getSeed() {
  const seed = window.ACTIVITY_VAULT_SEED;
  if (!seed || !Array.isArray(seed.items)) {
    return { schemaVersion: SCHEMA_VERSION, generatedAt: nowIso(), items: [] };
  }
  return seed;
}

function loadLocalStore() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seed = getSeed();
    const s = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowIso(),
      items: seed.items,
      sources: { seedGeneratedAt: seed.generatedAt },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return s;
  }

  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== 'object') {
    const seed = getSeed();
    const s = { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), items: seed.items };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return s;
  }

  if (!Array.isArray(parsed.items)) parsed.items = [];
  if (!parsed.schemaVersion) parsed.schemaVersion = SCHEMA_VERSION;
  return parsed;
}

function saveLocalStore(store) {
  store.updatedAt = nowIso();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function resetLocalToSeed() {
  const seed = getSeed();
  const s = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso(),
    items: seed.items,
    sources: { seedGeneratedAt: seed.generatedAt },
  };
  saveLocalStore(s);
  return s;
}

function backupLocalStore(label = 'backup') {
  try {
    const key = `activityVault.backup.${label}.${Date.now()}`;
    localStorage.setItem(key, JSON.stringify(store));
  } catch {
    // ignore
  }
}

// ---------- GitHub Sync config ----------

function defaultConfig() {
  return {
    schemaVersion: 1,
    storage: {
      backend: 'local', // 'local' | 'gist'
      gistId: '',
      filename: 'activity-library.json',
      rememberToken: false,
      token: '',
      lastPullAt: '',
      lastPushAt: '',
      lastError: '',
    }
  };
}

function loadConfig() {
  const raw = localStorage.getItem(CONFIG_KEY);
  const parsed = safeJsonParse(raw, null);
  const cfg = (parsed && typeof parsed === 'object') ? parsed : defaultConfig();

  // normalize
  cfg.schemaVersion = cfg.schemaVersion || 1;
  cfg.storage = cfg.storage || {};
  cfg.storage.backend = cfg.storage.backend || 'local';
  cfg.storage.gistId = normalizeStr(cfg.storage.gistId);
  cfg.storage.filename = normalizeStr(cfg.storage.filename) || 'activity-library.json';
  cfg.storage.rememberToken = cfg.storage.rememberToken === true;
  cfg.storage.token = normalizeStr(cfg.storage.token);
  cfg.storage.lastPullAt = normalizeStr(cfg.storage.lastPullAt);
  cfg.storage.lastPushAt = normalizeStr(cfg.storage.lastPushAt);
  cfg.storage.lastError = normalizeStr(cfg.storage.lastError);

  return cfg;
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function getSessionToken() {
  return normalizeStr(sessionStorage.getItem(SESSION_TOKEN_KEY) || '');
}

function setSessionToken(token) {
  const t = normalizeStr(token);
  if (t) sessionStorage.setItem(SESSION_TOKEN_KEY, t);
  else sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

function getGitHubToken() {
  if (config.storage.rememberToken && normalizeStr(config.storage.token)) return normalizeStr(config.storage.token);
  const s = getSessionToken();
  return s || '';
}

function isGistEnabled() {
  return config.storage.backend === 'gist' && normalizeStr(config.storage.gistId);
}

// ---------- GitHub API (Gist) ----------

async function githubRequest(url, { method = 'GET', token = '', body = null } = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const t = normalizeStr(token);
  if (t) headers['Authorization'] = `Bearer ${t}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = safeJsonParse(text, null);

  if (!res.ok) {
    const msg = json?.message || text || res.statusText;
    throw new Error(`GitHub API ${res.status}: ${msg}`);
  }

  return json;
}

function pickGistFile(gist, preferredFilename) {
  const files = gist?.files || {};
  const pref = normalizeStr(preferredFilename);

  if (pref && files[pref]) return files[pref];

  // Fall back to any *.json file
  const jsonKey = Object.keys(files).find(k => k.toLowerCase().endsWith('.json'));
  if (jsonKey) return files[jsonKey];

  // Fall back to first file
  const firstKey = Object.keys(files)[0];
  return firstKey ? files[firstKey] : null;
}

async function readGistFileContent(file, token = '') {
  if (!file) return '';
  if (file.truncated && file.raw_url) {
    const headers = {};
    const t = normalizeStr(token);
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const res = await fetch(file.raw_url, { headers });
    if (!res.ok) throw new Error(`Failed to fetch gist raw file: ${res.status}`);
    return await res.text();
  }
  return file.content || '';
}

function normalizeItem(item) {
  const it = { ...item };
  if (!it.id) it.id = newId();
  if (!('currency' in it)) it.currency = 'USD';
  if (!Array.isArray(it.tags)) it.tags = [];
  if (!Array.isArray(it.exdate)) it.exdate = [];
  if (!('isFree' in it)) it.isFree = (it.cost === 0);
  if (!('starred' in it)) it.starred = false;
  if (!('committed' in it)) it.committed = false;
  if (!('done' in it)) it.done = false;
  if (!('layer' in it)) it.layer = '';

  // Normalize category
  it.type = normalizeTypeToCategory(it.type);

  // Normalize price tier (stored as a rough bucket: free/low/medium/high)
  if (!('priceTier' in it)) it.priceTier = '';
  it.priceTier = normalizeStr(it.priceTier).toLowerCase();

  const inferred = priceTierForItem(it);
  if (!['free', 'low', 'medium', 'high'].includes(it.priceTier)) {
    it.priceTier = (inferred === 'unknown') ? '' : inferred;
  }

  // Keep legacy fields aligned (for backwards compatibility)
  if (it.priceTier === 'free') {
    it.isFree = true;
    it.cost = 0;
  } else {
    if (it.isFree === true) it.isFree = false;
    if (parseNumberOrNull(it.cost) == 0) it.cost = null;
  }

  // Normalize booleans
  it.starred = it.starred === true;
  it.committed = it.committed === true;
  it.done = it.done === true;

  // Normalize overnight events (end after midnight).
  // If start/end are the same calendar date but the end time is earlier than the start time,
  // assume the end is on the following day. This prevents negative durations (which can
  // cause FullCalendar rendering glitches) and matches typical intent for "7pm–1am".
  try {
    const sStr = normalizeStr(it.start);
    const eStr = normalizeStr(it.end);
    const mS = sStr && sStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/);
    const mE = eStr && eStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/);
    if (mS && mE && mS[1] === mE[1]) {
      const toSec = (hhmm, ssPart) => {
        const parts = String(hhmm).split(':');
        const hh = Number(parts[0] || 0);
        const mm = Number(parts[1] || 0);
        const ss = ssPart ? Number(String(ssPart).slice(1)) : 0;
        if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
        return hh * 3600 + mm * 60 + ss;
      };
      const sSec = toSec(mS[2], mS[3]);
      const eSec = toSec(mE[2], mE[3]);
      if (sSec !== null && eSec !== null && eSec < sSec) {
        const base = new Date(`${mE[1]}T00:00:00`);
        if (!Number.isNaN(base.getTime())) {
          base.setDate(base.getDate() + 1);
          const nextDate = toDateInputValue(base);
          it.end = `${nextDate}T${mE[2]}${mE[3] || ''}`;
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return it;
}

function parseItemsFromRemoteJson(text) {
  const parsed = safeJsonParse(text, null);
  if (!parsed) throw new Error('Remote JSON is not valid JSON.');

  const items = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed.items) ? parsed.items : null);

  if (!Array.isArray(items)) throw new Error('Remote JSON must be an array or an object with an "items" array.');
  return items.map(normalizeItem);
}

async function pullFromGist({ silent = false } = {}) {
  if (!isGistEnabled()) return { ok: false, message: 'Not configured.' };

  const gistId = normalizeStr(config.storage.gistId);
  const filename = normalizeStr(config.storage.filename) || 'activity-library.json';
  const token = getGitHubToken();

  const gist = await githubRequest(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, { token });
  const file = pickGistFile(gist, filename);
  if (!file) throw new Error('No files found in that gist.');

  const content = await readGistFileContent(file, token);
  if (!normalizeStr(content)) throw new Error('That gist file is empty.');

  const items = parseItemsFromRemoteJson(content);

  // Replace local store with remote
  backupLocalStore('prePull');
  store.items = items;
  store.schemaVersion = SCHEMA_VERSION;
  saveLocalStore(store);

  config.storage.lastPullAt = nowIso();
  config.storage.lastError = '';
  saveConfig(config);

  if (!silent) {
    alert(`Pulled ${items.length} item(s) from GitHub.`);
  }

  return { ok: true, itemsCount: items.length };
}

async function pushToGist({ silent = false } = {}) {
  if (!isGistEnabled()) return { ok: false, message: 'Not configured.' };

  const gistId = normalizeStr(config.storage.gistId);
  const filename = normalizeStr(config.storage.filename) || 'activity-library.json';
  const token = getGitHubToken();
  if (!token) throw new Error('No GitHub token set. Add a token to push changes.');

  const payload = exportStoreJson();
  const content = JSON.stringify(payload, null, 2);

  await githubRequest(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    method: 'PATCH',
    token,
    body: {
      files: {
        [filename]: { content },
      }
    }
  });

  config.storage.lastPushAt = nowIso();
  config.storage.lastError = '';
  saveConfig(config);

  if (!silent) {
    alert('Pushed to GitHub.');
  }

  return { ok: true };
}

async function ensureGistHasFile({ silent = true } = {}) {
  // If gist exists but file is missing/empty, seed it with current local data.
  if (!isGistEnabled()) return;
  const gistId = normalizeStr(config.storage.gistId);
  const filename = normalizeStr(config.storage.filename) || 'activity-library.json';
  const token = getGitHubToken();
  if (!token) return;

  const gist = await githubRequest(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, { token });
  const files = gist?.files || {};
  const file = files[filename];
  const hasContent = file && normalizeStr(file.content);
  if (hasContent) return;

  // Create/overwrite the file
  await pushToGist({ silent });
}

async function createNewGist({ publicGist = false, token = '', remember = false } = {}) {
  const t = normalizeStr(token);
  if (!t) throw new Error('A GitHub token is required to create a gist.');

  // Store token choice immediately so push/pull can use it after creation.
  config.storage.rememberToken = remember === true;
  if (remember) {
    config.storage.token = t;
    setSessionToken('');
  } else {
    config.storage.token = '';
    setSessionToken(t);
  }
  saveConfig(config);

  const filename = normalizeStr($('ghFilename')?.value) || 'activity-library.json';
  const payload = exportStoreJson();
  const content = JSON.stringify(payload, null, 2);

  const gist = await githubRequest('https://api.github.com/gists', {
    method: 'POST',
    token: t,
    body: {
      description: 'Activity Library data store',
      public: publicGist === true,
      files: {
        [filename]: { content },
      },
    }
  });

  const id = gist?.id;
  if (!id) throw new Error('GitHub did not return a gist id.');

  config.storage.backend = 'gist';
  config.storage.gistId = id;
  config.storage.filename = filename;
  config.storage.lastPushAt = nowIso();
  config.storage.lastError = '';
  saveConfig(config);

  // Update dialog fields if present
  const idInput = $('ghGistId');
  if (idInput) idInput.value = id;

  updateStorageUi();
  alert(`Created gist: ${id}`);

  return { ok: true, gistId: id };
}

let storageReady = false;
let pushTimer = null;

function scheduleAutoPush() {
  if (!storageReady) return;
  if (!isGistEnabled()) return;
  if (!getGitHubToken()) return;

  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await pushToGist({ silent: true });
      updateStorageUi();
    } catch (err) {
      config.storage.lastError = err?.message || String(err);
      saveConfig(config);
      updateStorageUi();
      console.warn(err);
    }
  }, 900);
}

function updateStorageUi() {
  const chip = document.getElementById('syncChip');
  const status = document.getElementById('storageStatus');

  const backend = config.storage.backend;
  const gistId = normalizeStr(config.storage.gistId);
  const token = getGitHubToken();

  let chipText = 'Local';
  let statusText = 'Storage: Local (browser)';

  if (backend === 'gist' && gistId) {
    const short = gistId.slice(0, 6) + '…' + gistId.slice(-4);
    const canPush = !!token;

    chipText = canPush ? 'GitHub: Synced' : 'GitHub: Read-only';
    statusText = `Storage: GitHub Gist (${short})`;
    if (!canPush) statusText += ' — read-only (no token)';

    const bits = [];
    if (normalizeStr(config.storage.lastPullAt)) bits.push(`pulled ${formatShortDateTime(new Date(config.storage.lastPullAt))}`);
    if (normalizeStr(config.storage.lastPushAt)) bits.push(`pushed ${formatShortDateTime(new Date(config.storage.lastPushAt))}`);
    if (bits.length) statusText += `\n${bits.join(' · ')}`;

    if (normalizeStr(config.storage.lastError)) statusText += `\nLast error: ${config.storage.lastError}`;
  }

  if (chip) chip.textContent = chipText;
  if (status) status.textContent = statusText;
}

async function initRemoteOnLoad() {
  updateStorageUi();

  if (!isGistEnabled()) return;

  try {
    // Pull remote first so we don't accidentally overwrite it.
    await pullFromGist({ silent: true });
  } catch (err) {
    // If pull failed, keep local store. If gist exists but file missing, try seeding.
    config.storage.lastError = err?.message || String(err);
    saveConfig(config);

    try {
      await ensureGistHasFile({ silent: true });
      config.storage.lastError = '';
      saveConfig(config);
    } catch (err2) {
      config.storage.lastError = err2?.message || String(err2);
      saveConfig(config);
    }
  }

  updateStorageUi();
}

// ---------- Filters ----------

const DEFAULT_TYPES = [
  'museums/galleries',
  'nightlife',
  'parties',
  'performances',
  'sweet treats',
  'outdoors',
  'networking',
  'coffee',
  'lunch/dinner',
  'brunch',
  'activism',
  'other',
];

// ---------- Type color coding ----------

const TYPE_COLOR_PRESET = {
  'museums/galleries': '#3b82f6',
  'nightlife': '#a855f7',
  'parties': '#ef4444',
  'performances': '#6366f1',
  'sweet treats': '#ec4899',
  'outdoors': '#22c55e',
  'networking': '#06b6d4',
  'coffee': '#a16207',
  'lunch/dinner': '#f97316',
  'brunch': '#f59e0b',
  'activism': '#14b8a6',
  'other': '#64748b',
};

const TYPE_COLOR_FALLBACKS = [
  '#0ea5e9', '#22c55e', '#f97316', '#a855f7', '#ef4444', '#14b8a6',
  '#f59e0b', '#06b6d4', '#6366f1', '#ec4899', '#84cc16', '#8b5cf6', '#64748b'
];
const TYPE_DISPLAY = {
  'museums/galleries': 'Museums / galleries',
  'nightlife': 'Nightlife',
  'parties': 'Parties',
  'performances': 'Performances',
  'sweet treats': 'Sweet treats',
  'outdoors': 'Outdoors',
  'networking': 'Networking',
  'coffee': 'Coffee',
  'lunch/dinner': 'Lunch / dinner',
  'brunch': 'Brunch',
  'activism': 'Activism',
  'other': 'Other',
};

function typeDisplayName(t) {
  const key = normalizeStr(t).toLowerCase();
  if (!key) return '';
  return TYPE_DISPLAY[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

function normalizeTypeToCategory(t) {
  const raw = normalizeStr(t).toLowerCase();
  if (!raw) return '';
  if (DEFAULT_TYPES.includes(raw)) return raw;

  const m = raw.replace(/\s+/g, ' ').trim();

  // Legacy + common synonyms
  if (['museum', 'gallery', 'art', 'exhibit', 'exhibition'].includes(m)) return 'museums/galleries';
  if (['bar', 'club', 'nightlife', 'drinks'].includes(m)) return 'nightlife';
  if (['party', 'parties', 'dance', 'rave'].includes(m)) return 'parties';
  if (['music', 'theater', 'theatre', 'performance', 'performances', 'comedy', 'film', 'screening'].includes(m)) return 'performances';
  if (['sweet treat', 'sweet treats', 'dessert', 'ice cream', 'bakery'].includes(m)) return 'sweet treats';
  if (['outdoors', 'park', 'hike', 'beach', 'nature'].includes(m)) return 'outdoors';
  if (['networking', 'meetup'].includes(m)) return 'networking';
  if (['coffee', 'cafe'].includes(m)) return 'coffee';
  if (['food', 'lunch', 'dinner', 'restaurant'].includes(m)) return 'lunch/dinner';
  if (['brunch'].includes(m)) return 'brunch';
  if (['activism', 'protest', 'volunteer', 'mutual aid'].includes(m)) return 'activism';

  return 'other';
}


function hexToRgb(hex) {
  const h = normalizeStr(hex).replace('#', '').trim();
  if (h.length == 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return { r, g, b };
  }
  if (h.length != 6) return { r: 100, g: 116, b: 139 }; // slate fallback
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  const to = (n) => clampNumber(Math.round(n), { min: 0, max: 255 }).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function darkenHex(hex, amount = 0.16) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const srgb = [r, g, b].map(v => v / 255);
  const lin = srgb.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function hexToRgba(hex, alpha = 0.18) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function pickTypeBaseColor(type) {
  const key = normalizeStr(type).toLowerCase();
  if (!key) return '#64748b';
  if (TYPE_COLOR_PRESET[key]) return TYPE_COLOR_PRESET[key];
  const idx = parseInt(stableShortId(key).slice(0, 2), 16) % TYPE_COLOR_FALLBACKS.length;
  return TYPE_COLOR_FALLBACKS[idx];
}

function typeColors(type) {
  const bg = pickTypeBaseColor(type);
  const border = darkenHex(bg, 0.18);
  const lum = relativeLuminance(bg);
  const text = lum < 0.5 ? '#ffffff' : '#0f172a';
  return { bg, border, text };
}

// ---------- Optional auto-fill helpers (NYC) ----------

// These rules are intentionally conservative: they only fill blank fields and avoid
// overwriting anything you've already entered.
const NYC_ENRICH_RULES = [
  {
    patterns: ['henrietta hudson', '438 hudson'],
    neighborhood: 'West Village',
    type: 'nightlife',
  },
  {
    patterns: ['stonewall inn', 'stonewall', '53 christopher'],
    neighborhood: 'West Village',
    type: 'nightlife',
  },
  {
    patterns: ['union square'],
    neighborhood: 'Union Square',
    type: 'outdoors',
  },
  {
    patterns: ["ginger's bar", "ginger's", '363 5th ave'],
    neighborhood: 'Park Slope',
    type: 'nightlife',
  },
  {
    patterns: ['sunset stoop', '4114 5th ave'],
    neighborhood: 'Sunset Park',
    type: 'performances',
  },
  {
    patterns: ['vino theater', '274 morgan ave'],
    neighborhood: 'East Williamsburg',
    type: 'performances',
  },
  {
    patterns: ['616 halsey', '11233'],
    neighborhood: 'Bedford-Stuyvesant',
  },
  {
    patterns: ['sultan room', '234 starr'],
    neighborhood: 'Bushwick',
    type: 'performances',
  },
  {
    patterns: ['mood ring'],
    neighborhood: 'Bushwick',
    type: 'nightlife',
    // Fill only if address is missing or looks incomplete (no street number)
    address: 'Mood Ring, 1260 Myrtle Ave, Brooklyn, NY 11221, USA',
    allowAddressIfNoDigits: true,
  },
  {
    patterns: ['the bush', '333 troutman'],
    neighborhood: 'Bushwick',
    type: 'nightlife',
  },
  {
    patterns: ['boyfriend co-op', 'boyfriend co op', '1157 myrtle'],
    neighborhood: 'Bushwick',
    type: 'other',
  },
  {
    patterns: ['museum of modern art', 'moma'],
    neighborhood: 'Midtown',
    type: 'museums/galleries',
  },
  {
    patterns: ['metropolitan museum of art', '1000 5th ave'],
    neighborhood: 'Upper East Side',
    type: 'museums/galleries',
  },
  {
    patterns: ['pier 57', '25 11th ave'],
    neighborhood: 'Chelsea',
  },
  {
    patterns: ['rack shack', '17 thames'],
    neighborhood: 'East Williamsburg',
  },
  {
    patterns: ['tompkins square park', 'e 10th'],
    neighborhood: 'East Village',
    type: 'outdoors',
  },
  {
    patterns: ['whitney museum', '99 gansevoort', 'the whitney'],
    neighborhood: 'Meatpacking District',
    type: 'museums/galleries',
  },
  {
    patterns: ['poster house', '119 w 23rd'],
    neighborhood: 'Chelsea',
    type: 'museums/galleries',
  },
  {
    patterns: ['9/11 memorial', '9/11 museum', '911 memorial', '180 greenwich'],
    neighborhood: 'Financial District',
    type: 'museums/galleries',
  },
  {
    patterns: ['museum of the city of new york', '1220 5th'],
    neighborhood: 'East Harlem',
    type: 'museums/galleries',
  },
  {
    patterns: ['cooper hewitt', '2 e 91st'],
    neighborhood: 'Upper East Side',
    type: 'museums/galleries',
  },
  {
    patterns: ['morgan library', '225 madison'],
    neighborhood: 'Murray Hill',
    type: 'museums/galleries',
  },
  {
    patterns: ['3$ bill', '3 $ bill', '3 dollar bill'],
    neighborhood: 'East Williamsburg',
    type: 'performances',
    address: '3 Dollar Bill, 260 Meserole St, Brooklyn, NY 11206, USA',
  },
  {
    patterns: ['the woods'],
    neighborhood: 'Williamsburg',
    type: 'nightlife',
    address: 'The Woods, 48 S 4th St, Brooklyn, NY 11249, USA',
  },
  {
    patterns: ['morgan ave station', 'turnstile', 'morgan ave'],
    neighborhood: 'East Williamsburg',
    address: 'Morgan Ave Station (L), Brooklyn, NY 11237, USA',
    allowAddressIfNoDigits: true,
  },
];

function maybeAutoFillNYCItem(item) {
  const hay = `${normalizeStr(item.title)} ${normalizeStr(item.address)}`.toLowerCase();
  if (!hay.trim()) return false;

  let changed = false;

  for (const rule of NYC_ENRICH_RULES) {
    if (!rule?.patterns?.length) continue;
    const hit = rule.patterns.some(p => hay.includes(String(p).toLowerCase()));
    if (!hit) continue;

    if (rule.neighborhood && !normalizeStr(item.neighborhood)) {
      item.neighborhood = rule.neighborhood;
      changed = true;
    }
    if (rule.type && !normalizeStr(item.type)) {
      item.type = rule.type;
      changed = true;
    }

    if (rule.address) {
      const currentAddr = normalizeStr(item.address);
      const hasDigits = /\d/.test(currentAddr);
      const canFill = !currentAddr || (rule.allowAddressIfNoDigits === true && !hasDigits);
      if (canFill) {
        item.address = rule.address;
        changed = true;
      }
    }
  }

  return changed;
}

function autoFillNYCDetails() {
  let changedCount = 0;
  const updated = store.items.map((it) => {
    const copy = { ...it };
    const changed = maybeAutoFillNYCItem(copy);
    if (!changed) return it;
    changedCount += 1;
    return normalizeItem(copy);
  });

  if (changedCount === 0) {
    alert('No NYC fields to auto-fill (everything already looks filled).');
    return;
  }

  const ok = confirm(
    `Auto-fill NYC details for ${changedCount} item(s)?\n\nThis will only fill blank fields (and optionally replace incomplete addresses without street numbers).`
  );
  if (!ok) return;

  store.items = updated;
  persistAndMaybeSync();
  refresh();
  alert(`Updated ${changedCount} item(s).`);
}

// ---------- NYC GeoSearch (address → borough + neighborhood) ----------

const NYC_GEOSEARCH_CACHE_KEY = 'activityVault.nycGeosearchCache.v1';

function loadGeoSearchCache() {
  try {
    const raw = localStorage.getItem(NYC_GEOSEARCH_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    return obj;
  } catch (_) {
    return {};
  }
}

function saveGeoSearchCache(cache) {
  try {
    localStorage.setItem(NYC_GEOSEARCH_CACHE_KEY, JSON.stringify(cache || {}));
  } catch (_) {
    // ignore
  }
}

async function geosearchNYC(text) {
  const q = encodeURIComponent(normalizeStr(text));
  if (!q) return null;

  const url = `https://geosearch.planninglabs.nyc/v2/search?text=${q}&size=1`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`NYC GeoSearch request failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  const feat = data?.features?.[0];
  if (!feat) return null;
  const props = feat.properties || {};

  const neighborhood = normalizeStr(props.neighbourhood || props.neighborhood);
  const borough = normalizeStr(props.borough);
  const label = normalizeStr(props.label);
  const confidence = (typeof props.confidence === 'number') ? props.confidence : parseNumberOrNull(props.confidence);

  return {
    neighborhood,
    borough,
    label,
    confidence,
    source: 'NYC GeoSearch',
    ts: new Date().toISOString(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupNeighborhoodFromAddress() {
  // Only try to fill blanks (no overwriting)
  const candidates = store.items.filter(it => {
    const addr = normalizeStr(it.address);
    if (!addr) return false;
    return !normalizeStr(it.neighborhood) || !normalizeStr(it.borough);
  });

  if (candidates.length === 0) {
    alert('No items with an address but missing neighborhood/borough.');
    return;
  }

  const ok = confirm(
    `Lookup NYC neighborhood for ${candidates.length} item(s) using NYC GeoSearch?

` +
    `This will make network requests. It will only fill blank neighborhood/borough fields (and optionally normalize incomplete addresses).`
  );
  if (!ok) return;

  const cache = loadGeoSearchCache();
  let changed = 0;
  let lookedUp = 0;
  let cacheHits = 0;

  const btn = $('btnGeoSearchNYC');
  const originalText = btn ? btn.textContent : '';

  try {
    for (const it of store.items) {
      const addr = normalizeStr(it.address);
      if (!addr) continue;

      const needs = !normalizeStr(it.neighborhood) || !normalizeStr(it.borough);
      if (!needs) continue;

      const key = addr.toLowerCase();
      let res = cache[key];
      if (res) {
        cacheHits += 1;
      } else {
        lookedUp += 1;
        if (btn) btn.textContent = `Looking up… (${lookedUp}/${candidates.length})`;
        try {
          res = await geosearchNYC(addr);
          if (res) cache[key] = res;
        } catch (err) {
          console.warn('GeoSearch failed', addr, err);
        }
        // Be polite to the API
        await sleep(250);
      }

      if (!res) continue;

      let itemChanged = false;
      if (!normalizeStr(it.neighborhood) && normalizeStr(res.neighborhood)) {
        it.neighborhood = res.neighborhood;
        itemChanged = true;
      }
      if (!normalizeStr(it.borough) && normalizeStr(res.borough)) {
        it.borough = res.borough;
        itemChanged = true;
      }

      const currentAddr = normalizeStr(it.address);
      const hasDigits = /\d/.test(currentAddr);
      if (normalizeStr(res.label) && (!currentAddr || !hasDigits)) {
        it.address = res.label;
        itemChanged = true;
      }

      if (itemChanged) changed += 1;
    }
  } finally {
    if (btn) btn.textContent = originalText;
  }

  saveGeoSearchCache(cache);

  if (changed === 0) {
    alert(`No updates applied. (Cache hits: ${cacheHits}, lookups: ${lookedUp})`);
    return;
  }

  // Normalize just in case
  store.items = store.items.map(it => normalizeItem(it));
  persistAndMaybeSync();
  refresh();

  alert(`Updated ${changed} item(s). (Cache hits: ${cacheHits}, lookups: ${lookedUp})`);
}

async function lookupNYCInEditDialog() {
  const btn = $('btnEditLookupNYC');
  const orig = btn ? btn.textContent : '';

  const addr = normalizeStr($('editAddress').value);
  const title = normalizeStr($('editTitle').value);
  const query = addr || title;

  if (!query) {
    alert('Enter an address (or at least a title) first.');
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Looking up…';
    }

    const cache = loadGeoSearchCache();
    const key = query.toLowerCase();
    let res = cache[key];
    if (!res) {
      res = await geosearchNYC(query);
      if (res) cache[key] = res;
      saveGeoSearchCache(cache);
    }

    if (!res) {
      alert('No NYC GeoSearch match found for that address/title.');
      return;
    }

    if (normalizeStr(res.label)) {
      const existing = normalizeStr($('editAddress').value);
      const hasDigits = /\d/.test(existing);
      if (!existing || !hasDigits) {
        $('editAddress').value = res.label;
      }
    }

    if (normalizeStr(res.neighborhood) && !normalizeStr($('editNeighborhood').value)) {
      $('editNeighborhood').value = res.neighborhood;
    }

    // Store borough into raw JSON if you want it later.
    if (normalizeStr(res.borough)) {
      // non-destructive: add to raw JSON preview only when it already has content, else skip
      // (borough can also live as a top-level field; the app will preserve it)
      const rawEl = $('editRawJson');
      const raw = normalizeStr(rawEl.value);
      if (raw) {
        try {
          const obj = JSON.parse(raw);
          obj.borough = obj.borough || res.borough;
          rawEl.value = JSON.stringify(obj, null, 2);
        } catch (_) {
          // ignore
        }
      }
    }

    alert('Lookup complete. Review the filled fields, then Save.');
  } catch (err) {
    alert(err?.message || String(err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
}

function buildFacetValues(items, key, { includeDefaults = [] } = {}) {
  const set = new Set();
  for (const it of items) {
    const v = normalizeStr(it?.[key]);
    if (v) set.add(v);
  }
  for (const d of includeDefaults) {
    if (d) set.add(d);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function buildLayerValues(items) {
  const set = new Set();
  for (const it of items) {
    const v = normalizeStr(it?.layer);
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function itemMatchesText(item, q) {
  const query = normalizeStr(q).toLowerCase();
  if (!query) return true;
  const hay = [item.title, item.summary, item.notes, item.address, item.type, (item.tags || []).join(' ')].join(' ').toLowerCase();
  return hay.includes(query);
}

function itemCostValue(item) {
  if (item?.isFree === true) return 0;
  const c = parseNumberOrNull(item?.cost);
  if (c === null) return null;
  return c;
}

// ---------- Price tiers ----------

const PRICE_TIER_THRESHOLDS = {
  lowMax: 20,
  mediumMax: 50,
};

function priceTierForItem(item, costValue = null) {
  const explicit = normalizeStr(item?.priceTier).toLowerCase();
  if (['free', 'low', 'medium', 'high'].includes(explicit)) return explicit;
  if (explicit === 'unknown') return 'unknown';

  const c = (costValue === null || costValue === undefined) ? itemCostValue(item) : costValue;
  if (item?.isFree === true || c === 0) return 'free';
  if (c === null) return 'unknown';
  if (c <= PRICE_TIER_THRESHOLDS.lowMax) return 'low';
  if (c <= PRICE_TIER_THRESHOLDS.mediumMax) return 'medium';
  return 'high';
}

// ---------- Icons ----------

const ICON_TICKET_SVG = `<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M5 4a2 2 0 0 0-2 2v2a2 2 0 0 1 0 4v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2a2 2 0 0 1 0-4V6a2 2 0 0 0-2-2H5zm4 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>
</svg>`;

const ICON_EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill="currentColor" d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"/>
  <path fill="currentColor" d="M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>
</svg>`;

const ICON_EYE_CLOSED_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill="currentColor" d="M2.3 3.7 3.7 2.3 21.7 20.3 20.3 21.7l-2.5-2.5C16.4 19.7 14.4 20 12 20 5 20 2 13 2 13s1.4-3.2 4.5-5.4L2.3 3.7Zm7 7 5 5a3 3 0 0 1-5-5Z"/>
  <path fill="currentColor" d="M12 4c7 0 10 7 10 7s-1.5 3.4-4.8 5.7l-2.1-2.1A5 5 0 0 0 9.4 8.9L7.6 7.1C8.9 6.4 10.4 4 12 4Z"/>
</svg>`;

function ticketIconHtml() {
  return `<span class="icon-ticket" aria-hidden="true">${ICON_TICKET_SVG}</span>`;
}

function getEffectiveDateFilter(filters, { scope = 'list' } = {}) {
  // List-only: the calendar already has its own date range navigation.
  if (scope !== 'list') return { active: false, start: null, end: null };

  // Keep it bounded so we never expand recurrences across "infinite" ranges.
  const fromRaw = parseAnyDate(filters.dateFrom);
  const toRaw = parseAnyDate(filters.dateTo);

  if (!fromRaw && !toRaw) return { active: false, start: null, end: null };

  const today = new Date();
  const start = fromRaw ? startOfDay(fromRaw) : startOfDay(today);
  const end = toRaw ? endOfDay(toRaw) : endOfDay(addDays(start, 365));

  return { active: true, start, end };
}

function parseTimeToMinutes(value) {
  const v = normalizeStr(value);
  if (!v) return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = clampNumber(Number(m[1]), { min: 0, max: 23 });
  const mm = clampNumber(Number(m[2]), { min: 0, max: 59 });
  if (hh === null || mm === null) return null;
  return hh * 60 + mm;
}

function getEffectiveTimeFilter(filters, { scope = 'list' } = {}) {
  // List-only: the calendar has its own interaction model.
  if (scope !== 'list') return { active: false };

  const from = parseTimeToMinutes(filters.timeFrom);
  const to = parseTimeToMinutes(filters.timeTo);
  if (from === null && to === null) return { active: false };

  const startMin = (from === null) ? 0 : from;
  const endMin = (to === null) ? 24 * 60 : to;

  // 00:00 → 00:00 means “no time filter”.
  if (from !== null && to !== null && startMin === endMin) return { active: false };

  return { active: true, startMin, endMin, wraps: endMin < startMin };
}

function hasCalendarPresence(item) {
  if (normalizeStr(item.start)) return true;
  if (item?.dateRange && item?.openHours) return true;
  return false;
}

function isRecurringItem(item) {
  return !!normalizeStr(item?.rrule);
}

function isAllDayDateOnly(item) {
  const s = normalizeStr(item?.start);
  return (item?.allDay === true) || (/^\d{4}-\d{2}-\d{2}$/.test(s));
}

function itemSingleInstanceWindow(item) {
  const s = parseAnyDate(item.start);
  if (!s) return null;

  // all-day semantics: treat date-only end as exclusive (matches ICS)
  const allDay = isAllDayDateOnly(item);

  const eRaw = parseAnyDate(item.end);
  let e = eRaw;

  if (!e) {
    e = allDay ? addDays(s, 1) : addMinutes(s, 60);
  }

  // Defensive: never return an end <= start (FullCalendar can behave badly).
  if (e && e.getTime() <= s.getTime()) {
    if (allDay) {
      e = addDays(s, 1);
    } else {
      try {
        const bumped = new Date(e);
        bumped.setDate(bumped.getDate() + 1);
        e = (bumped.getTime() > s.getTime()) ? bumped : addMinutes(s, 60);
      } catch (_) {
        e = addMinutes(s, 60);
      }
    }
  }

  return { start: s, end: e, allDay };
}

function itemHasOccurrenceInRange(item, rangeStart, rangeEnd) {
  if (!hasCalendarPresence(item)) return false;

  // Open hours blocks (gallery show schedule)
  if (item.dateRange && item.openHours) {
    const occ = expandOpenHoursOccurrences(item, rangeStart, rangeEnd);
    return occ.length > 0;
  }

  // Recurring
  if (normalizeStr(item.rrule)) {
    const occ = expandRecurringOccurrences(item, rangeStart, rangeEnd);
    return occ.length > 0;
  }

  // Single
  const win = itemSingleInstanceWindow(item);
  if (!win) return false;
  return intersectsRange(win.start, win.end, rangeStart, rangeEnd);
}

// ---------- List time filtering ----------

function dateWithMinutesIntoDay(day, minutes) {
  const d = startOfDay(day);
  return new Date(d.getTime() + minutes * 60000);
}

function occurrenceOverlapsTimeFilter(start, end, timeFilter) {
  if (!timeFilter?.active) return true;
  if (!start) return false;

  const s = start;
  const e = end ?? start;

  const startDay = startOfDay(s);
  const endDay = startOfDay(e);

  // For an overnight filter (e.g., 22:00-02:00), occurrences on day D early morning
  // can match the window that started the previous day.
  let day = timeFilter.wraps ? addDays(startDay, -1) : startDay;

  // Safety: don't iterate forever on pathological multi-day items.
  const maxDays = 400;
  for (let i = 0; i < maxDays && day.getTime() <= endDay.getTime(); i++) {
    const wStart = dateWithMinutesIntoDay(day, timeFilter.startMin);
    let wEnd = dateWithMinutesIntoDay(day, timeFilter.endMin);
    if (timeFilter.wraps) wEnd = addDays(wEnd, 1);

    if (intersectsRange(s, e, wStart, wEnd)) return true;
    day = addDays(day, 1);
  }

  return false;
}

function itemHasOccurrenceInRangeOverlappingTimeFilter(item, rangeStart, rangeEnd, timeFilter) {
  if (!hasCalendarPresence(item)) return false;
  if (!timeFilter?.active) return itemHasOccurrenceInRange(item, rangeStart, rangeEnd);

  if (item.dateRange && item.openHours) {
    const occ = expandOpenHoursOccurrences(item, rangeStart, rangeEnd);
    for (const o of occ) {
      if (occurrenceOverlapsTimeFilter(o.start, o.end, timeFilter)) return true;
    }
    return false;
  }

  if (normalizeStr(item.rrule)) {
    const occ = expandRecurringOccurrences(item, rangeStart, rangeEnd);
    for (const o of occ) {
      if (occurrenceOverlapsTimeFilter(o.start, o.end, timeFilter)) return true;
    }
    return false;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return false;
  if (!intersectsRange(win.start, win.end, rangeStart, rangeEnd)) return false;
  return occurrenceOverlapsTimeFilter(win.start, win.end, timeFilter);
}

function firstOccurrenceStartInRange(item, rangeStart, rangeEnd) {
  if (!hasCalendarPresence(item)) return null;

  if (item.dateRange && item.openHours) {
    const occ = expandOpenHoursOccurrences(item, rangeStart, rangeEnd);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[0].start;
  }

  if (normalizeStr(item.rrule)) {
    const occ = expandRecurringOccurrences(item, rangeStart, rangeEnd);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[0].start;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return null;
  if (!intersectsRange(win.start, win.end, rangeStart, rangeEnd)) return null;
  return win.start;
}

function lastOccurrenceStartInRange(item, rangeStart, rangeEnd) {
  if (!hasCalendarPresence(item)) return null;

  if (item.dateRange && item.openHours) {
    const occ = expandOpenHoursOccurrences(item, rangeStart, rangeEnd);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[occ.length - 1].start;
  }

  if (isRecurringItem(item)) {
    const occ = expandRecurringOccurrences(item, rangeStart, rangeEnd);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[occ.length - 1].start;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return null;
  if (!intersectsRange(win.start, win.end, rangeStart, rangeEnd)) return null;
  return win.start;
}

function firstOccurrenceStartInRangeOverlappingTimeFilter(item, rangeStart, rangeEnd, timeFilter) {
  if (!hasCalendarPresence(item)) return null;
  if (!timeFilter?.active) return firstOccurrenceStartInRange(item, rangeStart, rangeEnd);

  if (item.dateRange && item.openHours) {
    const occ = expandOpenHoursOccurrences(item, rangeStart, rangeEnd)
      .filter(o => occurrenceOverlapsTimeFilter(o.start, o.end, timeFilter));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[0].start;
  }

  if (normalizeStr(item.rrule)) {
    const occ = expandRecurringOccurrences(item, rangeStart, rangeEnd)
      .filter(o => occurrenceOverlapsTimeFilter(o.start, o.end, timeFilter));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[0].start;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return null;
  if (!intersectsRange(win.start, win.end, rangeStart, rangeEnd)) return null;
  return occurrenceOverlapsTimeFilter(win.start, win.end, timeFilter) ? win.start : null;
}

function lastOccurrenceStartInRangeOverlappingTimeFilter(item, rangeStart, rangeEnd, timeFilter) {
  if (!hasCalendarPresence(item)) return null;
  if (!timeFilter?.active) return lastOccurrenceStartInRange(item, rangeStart, rangeEnd);

  if (item.dateRange && item.openHours) {
    const occ = expandOpenHoursOccurrences(item, rangeStart, rangeEnd)
      .filter(o => occurrenceOverlapsTimeFilter(o.start, o.end, timeFilter));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[occ.length - 1].start;
  }

  if (normalizeStr(item.rrule)) {
    const occ = expandRecurringOccurrences(item, rangeStart, rangeEnd)
      .filter(o => occurrenceOverlapsTimeFilter(o.start, o.end, timeFilter));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[occ.length - 1].start;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return null;
  if (!intersectsRange(win.start, win.end, rangeStart, rangeEnd)) return null;
  return occurrenceOverlapsTimeFilter(win.start, win.end, timeFilter) ? win.start : null;
}

function lastOccurrenceStart(item, beforeDate = new Date()) {
  const before = beforeDate ?? new Date();
  if (!hasCalendarPresence(item)) return null;

  if (item.dateRange && item.openHours) {
    const drEnd = parseAnyDate(item.dateRange?.end);
    const end = drEnd ? endOfDay(drEnd) : before;
    const rangeEnd = new Date(Math.min(end.getTime() + 1, before.getTime() + 1));
    const rangeStart = addDays(rangeEnd, -90);
    const occ = expandOpenHoursOccurrences(item, rangeStart, addDays(rangeEnd, 1));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    // pick last start <= before
    for (let i = occ.length - 1; i >= 0; i--) {
      if (occ[i].start.getTime() <= before.getTime()) return occ[i].start;
    }
    return null;
  }

  if (isRecurringItem(item)) {
    const rule = parseRRule(item.rrule);
    const until = parseUntil(rule?.UNTIL);
    const anchorEnd = until ? addMinutes(until, durationMinutesFromItem(item)) : before;
    const rangeEnd = new Date(Math.min(anchorEnd.getTime() + 1, before.getTime() + 1));
    const rangeStart = addDays(rangeEnd, -365);
    const occ = expandRecurringOccurrences(item, rangeStart, addDays(rangeEnd, 1));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = occ.length - 1; i >= 0; i--) {
      if (occ[i].start.getTime() <= before.getTime()) return occ[i].start;
    }
    return null;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return null;
  if (win.start.getTime() > before.getTime()) return null;
  return win.start;
}

function isArchivedItem(item, now = new Date()) {
  if (!hasCalendarPresence(item)) return false;
  return nextOccurrenceStart(item, now) === null;
}

// ---------- Layers ----------

// Fixed, user-facing layer toggles
const LAYER_MUSEUM_FREE_TIMES = 'museumFreeTimes';
const LAYER_CHILD_FRIENDLY = 'childFriendly';
const LAYER_DOG_FRIENDLY = 'dogFriendly';
const LAYER_OTHER = 'other';

const REAL_LAYER_IDS = [LAYER_MUSEUM_FREE_TIMES, LAYER_CHILD_FRIENDLY, LAYER_DOG_FRIENDLY];
const LAYER_TOGGLE_ORDER = [...REAL_LAYER_IDS, LAYER_OTHER];

function layerBucketForItem(item) {
  const raw = normalizeStr(item?.layer);
  if (raw && REAL_LAYER_IDS.includes(raw)) return raw;
  // Anything without a recognized layer (including blank or custom ids) is treated as "other".
  return LAYER_OTHER;
}

function applyFilters(items, filters, { scope = 'all' } = {}) {
  const dateFilter = getEffectiveDateFilter(filters, { scope });

  return items.filter((it) => {
    // Unscheduled items are list-only. If you don't want them, hide them here.
    if (scope === 'list' && filters.includeUnscheduled === false && !hasCalendarPresence(it)) return false;
    if (!itemMatchesText(it, filters.text)) return false;

    if (filters.starredOnly && !it.starred) return false;

    if (filters.hideDone === true && it.done === true) return false;

    if (filters.hideRecurring === true && isRecurringItem(it)) return false;

    const bucket = layerBucketForItem(it);
    if (!filters.enabledLayers.has(bucket)) return false;

    if (filters.types.size > 0) {
      const type = normalizeStr(it.type);
      const tags = new Set(toArray(it.tags).map(normalizeStr));
      let ok = false;
      if (type && filters.types.has(type)) ok = true;
      if (!ok) {
        for (const t of filters.types) {
          if (tags.has(t)) { ok = true; break; }
        }
      }
      if (!ok) return false;
    }

    if (filters.neighborhoods.size > 0) {
      const n = normalizeStr(it.neighborhood);
      if (!n || !filters.neighborhoods.has(n)) return false;
    }

    const tier = normalizeStr(filters.priceTier || 'all').toLowerCase();

    if (tier && tier !== 'all') {
      const itTier = priceTierForItem(it);
      if (itTier !== tier) return false;
    }

    if (dateFilter.active) {
      if (!hasCalendarPresence(it)) {
        return filters.includeUnscheduled === true;
      }
      return itemHasOccurrenceInRange(it, dateFilter.start, dateFilter.end);
    }

    return true;
  });
}

// ---------- Recurrence expansion ----------

const DOW_MAP = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

function parseRRule(rruleStr) {
  const r = normalizeStr(rruleStr);
  if (!r) return null;
  const parts = r.split(';');
  const out = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (!k || v === undefined) continue;
    out[k.toUpperCase()] = v;
  }
  if (!out.FREQ) return null;
  return out;
}

function parseByDayTokens(bydayValue) {
  const tokens = normalizeStr(bydayValue).split(',').map(s => s.trim()).filter(Boolean);
  return tokens.map(t => {
    const m = t.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i);
    if (!m) return null;
    const ord = m[1] ? parseInt(m[1], 10) : null;
    const dow = m[2].toUpperCase();
    return { ord, dow, dowIndex: DOW_MAP[dow] };
  }).filter(Boolean);
}

function parseByMonthDayTokens(value) {
  const v = normalizeStr(value);
  if (!v) return [];
  return v
    .split(',')
    .map(s => parseInt(String(s).trim(), 10))
    .filter(n => Number.isFinite(n) && n !== 0 && Math.abs(n) <= 31);
}

function parseBySetPosTokens(value) {
  const v = normalizeStr(value);
  if (!v) return [];
  // BYSETPOS is 1-based. Negative values count from the end.
  return v
    .split(',')
    .map(s => parseInt(String(s).trim(), 10))
    .filter(n => Number.isFinite(n) && n !== 0 && Math.abs(n) <= 366);
}

function parseUntil(untilValue) {
  const v = normalizeStr(untilValue);
  if (!v) return null;
  // Formats we might see:
  // - 20251224T045959Z
  // - 20260110T103000
  // - 20251019
  if (/^\d{8}T\d{6}Z$/.test(v)) {
    const y = v.slice(0, 4);
    const mo = v.slice(4, 6);
    const d = v.slice(6, 8);
    const hh = v.slice(9, 11);
    const mm = v.slice(11, 13);
    const ss = v.slice(13, 15);
    return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`);
  }
  if (/^\d{8}T\d{6}$/.test(v)) {
    const y = v.slice(0, 4);
    const mo = v.slice(4, 6);
    const d = v.slice(6, 8);
    const hh = v.slice(9, 11);
    const mm = v.slice(11, 13);
    const ss = v.slice(13, 15);
    return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`);
  }
  if (/^\d{8}$/.test(v)) {
    const y = v.slice(0, 4);
    const mo = v.slice(4, 6);
    const d = v.slice(6, 8);
    return new Date(`${y}-${mo}-${d}T23:59:59`);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function durationMinutesFromItem(item) {
  const s = parseAnyDate(item.start);
  const e = parseAnyDate(item.end);
  if (!s || !e) return 60;
  let minutes = Math.round((e.getTime() - s.getTime()) / 60000);

  // If the end is earlier than the start, assume it crosses midnight
  // (common for things like "10pm–2am"). If it still doesn't make sense,
  // fall back to a 1-hour duration to avoid negative / zero-length events.
  if (minutes <= 0) {
    try {
      const bumped = new Date(e);
      bumped.setDate(bumped.getDate() + 1);
      const m2 = Math.round((bumped.getTime() - s.getTime()) / 60000);
      minutes = (m2 > 0) ? m2 : 60;
    } catch (_) {
      minutes = 60;
    }
  }

  return Math.max(1, minutes);
}

function exdateSet(item) {
  const set = new Set();
  for (const x of toArray(item.exdate)) {
    const d = parseAnyDate(x);
    if (d) set.add(d.getTime());
  }
  return set;
}

function nthWeekdayOfMonth(year, monthIndex, weekdayIndex, n) {
  if (!n) return null;
  if (n > 0) {
    const first = new Date(year, monthIndex, 1);
    const diff = (weekdayIndex - first.getDay() + 7) % 7;
    const day = 1 + diff + (n - 1) * 7;
    const d = new Date(year, monthIndex, day);
    if (d.getMonth() !== monthIndex) return null;
    return d;
  }
  // negative: from end
  const last = new Date(year, monthIndex + 1, 0);
  const diff = (last.getDay() - weekdayIndex + 7) % 7;
  const day = last.getDate() - diff + (n + 1) * 7; // n=-1 -> +0
  const d = new Date(year, monthIndex, day);
  if (d.getMonth() !== monthIndex) return null;
  return d;
}

function expandRecurringOccurrences(item, rangeStart, rangeEnd) {
  const dtstart = parseAnyDate(item.start);
  if (!dtstart) return [];
  const rule = parseRRule(item.rrule);
  if (!rule) return [];

  const freq = rule.FREQ.toUpperCase();
  const interval = parseInt(rule.INTERVAL || '1', 10) || 1;
  const until = parseUntil(rule.UNTIL);
  const bydayTokens = rule.BYDAY ? parseByDayTokens(rule.BYDAY) : [];
  const bymonthdayTokens = rule.BYMONTHDAY ? parseByMonthDayTokens(rule.BYMONTHDAY) : [];
  const bysetposTokens = rule.BYSETPOS ? parseBySetPosTokens(rule.BYSETPOS) : [];
  const durationMin = durationMinutesFromItem(item);
  const excluded = exdateSet(item);

  const out = [];

  if (freq === 'DAILY') {
    let occ = new Date(dtstart);

    // fast-forward to rangeStart
    while (occ.getTime() + durationMin * 60000 <= rangeStart.getTime()) {
      occ = addDays(occ, interval);
      if (until && occ.getTime() > until.getTime()) break;
    }

    while (occ.getTime() < rangeEnd.getTime()) {
      if (until && occ.getTime() > until.getTime()) break;
      if (occ.getTime() >= dtstart.getTime()) {
        if (!excluded.has(occ.getTime())) {
          const end = addMinutes(occ, durationMin);
          if (intersectsRange(occ, end, rangeStart, rangeEnd)) {
            out.push({ start: new Date(occ), end });
          }
        }
      }
      occ = addDays(occ, interval);
    }

    return out;
  }

  if (freq === 'WEEKLY') {
    const rangeDay = startOfDay(rangeStart);
    const endDay = startOfDay(rangeEnd);

    const dtstartWeek = startOfWeekMonday(dtstart);

    for (let d = new Date(rangeDay); d.getTime() < endDay.getTime(); d = addDays(d, 1)) {
      const dow = d.getDay();
      const matches = bydayTokens.length === 0
        ? (dow === dtstart.getDay())
        : bydayTokens.some(t => t.dowIndex === dow);
      if (!matches) continue;

      const candidate = setTimeFrom(d, dtstart);
      if (candidate.getTime() < dtstart.getTime()) continue;

      if (until && candidate.getTime() > until.getTime()) continue;

      const candidateWeek = startOfWeekMonday(candidate);
      const weeks = Math.floor((candidateWeek.getTime() - dtstartWeek.getTime()) / 604800000);
      if (weeks < 0) continue;
      if (weeks % interval !== 0) continue;

      if (excluded.has(candidate.getTime())) continue;

      const end = addMinutes(candidate, durationMin);
      if (!intersectsRange(candidate, end, rangeStart, rangeEnd)) continue;
      out.push({ start: candidate, end });
    }

    return out;
  }

  if (freq === 'MONTHLY') {
    const baseMonth = new Date(dtstart.getFullYear(), dtstart.getMonth(), 1);
    const rangeStartMonth = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
    const rangeEndMonth = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);

    for (let m = new Date(rangeStartMonth); m.getTime() <= rangeEndMonth.getTime(); m.setMonth(m.getMonth() + 1)) {
      const months = monthsDiff(baseMonth, m);
      if (months < 0) continue;
      if (months % interval !== 0) continue;

      const year = m.getFullYear();
      const monthIndex = m.getMonth();

      // Support a few common monthly RRULE variants:
      // - BYDAY=2MO (2nd Monday) (already supported)
      // - BYDAY=MO;BYSETPOS=2 (Google Calendar style)
      // - BYMONTHDAY=8,9,10,11,12,13,14;BYDAY=MO ("Mon between 8..14" => 2nd Monday)

      const lastDay = new Date(year, monthIndex + 1, 0).getDate();

      // Convert BYMONTHDAY into actual day-of-month numbers for this month.
      const monthDaySet = (bymonthdayTokens.length > 0)
        ? new Set(
          bymonthdayTokens
            .map(n => (n > 0 ? n : (lastDay + n + 1)))
            .filter(d => d >= 1 && d <= lastDay)
        )
        : null;

      let candidates = [];

      const pushCandidateDay = (dayDate) => {
        if (!dayDate) return;
        if (dayDate.getMonth() !== monthIndex) return;
        if (monthDaySet && !monthDaySet.has(dayDate.getDate())) return;
        candidates.push(setTimeFrom(dayDate, dtstart));
      };

      if (bydayTokens.length === 0) {
        // Monthly by specific day(s) of month, or fall back to DTSTART's day-of-month.
        if (monthDaySet && monthDaySet.size > 0) {
          for (const dayNum of Array.from(monthDaySet).sort((a, b) => a - b)) {
            pushCandidateDay(new Date(year, monthIndex, dayNum));
          }
        } else {
          pushCandidateDay(new Date(year, monthIndex, dtstart.getDate()));
        }
      } else {
        // Monthly by weekday(s)
        for (const tok of bydayTokens) {
          if (tok.ord === null) {
            // Every <weekday> within the month
            const firstOfMonth = new Date(year, monthIndex, 1);
            const diff = (tok.dowIndex - firstOfMonth.getDay() + 7) % 7;
            let day = 1 + diff;
            while (true) {
              const d = new Date(year, monthIndex, day);
              if (d.getMonth() !== monthIndex) break;
              pushCandidateDay(d);
              day += 7;
            }
          } else {
            // Nth weekday (e.g., 2MO)
            pushCandidateDay(nthWeekdayOfMonth(year, monthIndex, tok.dowIndex, tok.ord));
          }
        }
      }

      // De-dup + sort
      {
        const uniq = new Map();
        for (const c of candidates) uniq.set(c.getTime(), c);
        candidates = Array.from(uniq.values());
        candidates.sort((a, b) => a.getTime() - b.getTime());
      }

      // Apply BYSETPOS (select Nth entry from the candidate set).
      if (bysetposTokens.length > 0 && candidates.length > 0) {
        const picked = [];
        for (const pos of bysetposTokens) {
          const idx = (pos > 0) ? (pos - 1) : (candidates.length + pos);
          if (idx >= 0 && idx < candidates.length) picked.push(candidates[idx]);
        }
        const uniq = new Map();
        for (const c of picked) uniq.set(c.getTime(), c);
        candidates = Array.from(uniq.values());
        candidates.sort((a, b) => a.getTime() - b.getTime());
      }

      // Materialize occurrences
      for (const candidate of candidates) {
        if (candidate.getTime() < dtstart.getTime()) continue;
        if (until && candidate.getTime() > until.getTime()) continue;
        if (excluded.has(candidate.getTime())) continue;

        const end = addMinutes(candidate, durationMin);
        if (!intersectsRange(candidate, end, rangeStart, rangeEnd)) continue;
        out.push({ start: candidate, end });
      }
    }

    return out;
  }

  return [];
}

function expandOpenHoursOccurrences(item, rangeStart, rangeEnd) {
  const dr = item.dateRange;
  const oh = item.openHours;
  if (!dr || !oh) return [];

  const rangeStartDate = parseAnyDate(dr.start);
  const rangeEndDate = parseAnyDate(dr.end);
  if (!rangeStartDate || !rangeEndDate) return [];

  const openHours = toArray(oh).filter(Boolean);
  if (openHours.length === 0) return [];

  const showStart = startOfDay(rangeStartDate);
  const showEnd = endOfDay(rangeEndDate);

  const start = startOfDay(rangeStart);
  const end = startOfDay(rangeEnd);

  const out = [];
  for (let d = new Date(start); d.getTime() < end.getTime(); d = addDays(d, 1)) {
    if (d.getTime() < showStart.getTime() || d.getTime() > showEnd.getTime()) continue;

    const dow = d.getDay();
    for (const block of openHours) {
      const dows = toArray(block.dow);
      if (dows.length > 0 && !dows.includes(dow)) continue;

      const startT = normalizeStr(block.start);
      const endT = normalizeStr(block.end);
      if (!startT || !endT) continue;

      const [sh, sm] = startT.split(':').map(Number);
      const [eh, em] = endT.split(':').map(Number);

      const s = new Date(d);
      s.setHours(sh || 0, sm || 0, 0, 0);
      const e = new Date(d);
      e.setHours(eh || 0, em || 0, 0, 0);

      // Support overnight open-hours blocks (e.g., 20:00–02:00).
      if (e.getTime() <= s.getTime()) {
        e.setDate(e.getDate() + 1);
      }

      if (!intersectsRange(s, e, rangeStart, rangeEnd)) continue;
      out.push({ start: s, end: e, label: normalizeStr(block.label) });
    }
  }
  return out;
}

function itemToCalendarEvents(item, rangeStart, rangeEnd) {
  if (!hasCalendarPresence(item)) return [];

  const colors = typeColors(item.type);
  const base = {
    title: item.title,
    allDay: item.allDay === true,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    textColor: colors.text,
    extendedProps: { itemId: item.id },
    classNames: [
      item.starred ? 'is-starred' : '',
      priceTierForItem(item) === 'free' ? 'is-free' : '',
      item.ticketsRequired ? 'has-ticket' : '',
      normalizeStr(item.layer) ? 'is-layer' : '',
      normalizeStr(item.type) ? `type-${slugify(item.type)}` : '',
    ].filter(Boolean),
  };

  if (item.dateRange && item.openHours) {
    const occ = expandOpenHoursOccurrences(item, rangeStart, rangeEnd);
    return occ.map((o) => ({
      ...base,
      id: `${item.id}__open__${o.start.toISOString()}`,
      start: o.start,
      end: o.end,
      title: o.label ? `${item.title} — ${o.label}` : item.title,
    }));
  }

  if (normalizeStr(item.rrule)) {
    const occ = expandRecurringOccurrences(item, rangeStart, rangeEnd);
    return occ.map((o) => ({
      ...base,
      id: `${item.id}__rr__${o.start.toISOString()}`,
      start: o.start,
      end: o.end,
    }));
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return [];

  if (!intersectsRange(win.start, win.end, rangeStart, rangeEnd)) return [];

  // All-day date-only strings are supported by FullCalendar
  if (isAllDayDateOnly(item) && /^\d{4}-\d{2}-\d{2}$/.test(normalizeStr(item.start))) {
    return [{
      ...base,
      id: `${item.id}__single`,
      start: item.start,
      end: item.end || null,
      allDay: true,
    }];
  }

  return [{
    ...base,
    id: `${item.id}__single`,
    start: win.start,
    end: win.end,
  }];
}

// ---------- Next occurrence (for list view) ----------

function nextOccurrenceStart(item, fromDate) {
  const from = fromDate ?? new Date();

  if (item.dateRange && item.openHours) {
    // Look ahead up to the show end (or 2 years, whichever is sooner)
    const drEnd = parseAnyDate(item.dateRange?.end);
    const horizon = drEnd ? new Date(Math.min(addDays(from, 730).getTime(), endOfDay(drEnd).getTime() + 1)) : addDays(from, 365);
    const occ = expandOpenHoursOccurrences(item, from, horizon);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[0].start;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) {
    return null;
  }

  if (normalizeStr(item.rrule)) {
    const horizon = addDays(from, 730);
    const occ = expandRecurringOccurrences(item, from, horizon);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return occ[0].start;
  }

  // Single event: return null if it's already ended
  if (win.end.getTime() < from.getTime()) return null;
  return win.start;
}

function nextOccurrenceWindow(item, fromDate) {
  const from = fromDate ?? new Date();
  if (!hasCalendarPresence(item)) return null;

  if (item.dateRange && item.openHours) {
    const drEnd = parseAnyDate(item.dateRange?.end);
    const horizon = drEnd ? new Date(Math.min(addDays(from, 730).getTime(), endOfDay(drEnd).getTime() + 1)) : addDays(from, 365);
    const occ = expandOpenHoursOccurrences(item, from, horizon);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { start: occ[0].start, end: occ[0].end };
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return null;

  if (normalizeStr(item.rrule)) {
    const horizon = addDays(from, 730);
    const occ = expandRecurringOccurrences(item, from, horizon);
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { start: occ[0].start, end: occ[0].end };
  }

  if (win.end.getTime() < from.getTime()) return null;
  return { start: win.start, end: win.end };
}

function lastOccurrenceWindow(item, beforeDate = new Date()) {
  const before = beforeDate ?? new Date();
  if (!hasCalendarPresence(item)) return null;

  if (item.dateRange && item.openHours) {
    const drEnd = parseAnyDate(item.dateRange?.end);
    const end = drEnd ? endOfDay(drEnd) : before;
    const rangeEnd = new Date(Math.min(end.getTime() + 1, before.getTime() + 1));
    const rangeStart = addDays(rangeEnd, -90);
    const occ = expandOpenHoursOccurrences(item, rangeStart, addDays(rangeEnd, 1));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = occ.length - 1; i >= 0; i--) {
      if (occ[i].start.getTime() <= before.getTime()) return { start: occ[i].start, end: occ[i].end };
    }
    return null;
  }

  if (isRecurringItem(item)) {
    const rule = parseRRule(item.rrule);
    const until = parseUntil(rule?.UNTIL);
    const anchorEnd = until ? addMinutes(until, durationMinutesFromItem(item)) : before;
    const rangeEnd = new Date(Math.min(anchorEnd.getTime() + 1, before.getTime() + 1));
    const rangeStart = addDays(rangeEnd, -365);
    const occ = expandRecurringOccurrences(item, rangeStart, addDays(rangeEnd, 1));
    if (occ.length === 0) return null;
    occ.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = occ.length - 1; i >= 0; i--) {
      if (occ[i].start.getTime() <= before.getTime()) return { start: occ[i].start, end: occ[i].end };
    }
    return null;
  }

  const win = itemSingleInstanceWindow(item);
  if (!win) return null;
  if (win.start.getTime() > before.getTime()) return null;
  return { start: win.start, end: win.end };
}

function formatWhenForList(item, { now = new Date(), listRange = null, mode = 'active' } = {}) {
  if (!hasCalendarPresence(item)) return 'Unscheduled';

  let occ = null;

  if (mode === 'archive') {
    // For archive: show the most recent occurrence (or most recent within the chosen range)
    if (listRange?.active) {
      occ = lastOccurrenceStartInRange(item, listRange.start, listRange.end);
    } else {
      occ = lastOccurrenceStart(item, now);
    }
  } else {
    // Active: show the next upcoming occurrence (or the first within the chosen range)
    if (listRange?.active) {
      occ = firstOccurrenceStartInRange(item, listRange.start, listRange.end);
    } else {
      occ = nextOccurrenceStart(item, now);
    }
  }

  if (!occ) {
    if (item.dateRange && item.openHours) {
      const dr = item.dateRange;
      return `Open hours (${dr.start} → ${dr.end})`;
    }
    return '—';
  }

  const baseLabel = isAllDayDateOnly(item) ? formatShortDate(occ) : formatShortDateTime(occ);

  if (isRecurringItem(item)) return `Recurring · ${baseLabel}`;
  if (item.dateRange && item.openHours) return `Open hours · ${baseLabel}`;

  return baseLabel;
}

// ---------- UI state ----------

const UI_PREFS_KEY = 'activityVault.uiPrefs.v1';

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    return obj;
  } catch (_) {
    return {};
  }
}

function saveUiPrefs(prefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs || {}));
  } catch (_) {
    // ignore
  }
}

const uiPrefs = loadUiPrefs();

let config = loadConfig();
let store = loadLocalStore();
// Normalize on load (type mapping, defaults)
store.items = (store.items || []).map(normalizeItem);

const state = {

  view: 'calendar',
  listTab: (uiPrefs.listTab === 'archive') ? 'archive' : 'active',
  selectedId: null,
  calendarSettings: {
    condenseEarlyHours: uiPrefs.condenseEarlyHours !== false,
    earlyCutoffHour: 8,
  },
  neighborhoodTree: {
    openBoroughs: new Set(toArray(uiPrefs.neighborhoodOpenBoroughs)),
    openRegions: new Set(toArray(uiPrefs.neighborhoodOpenRegions)),
  },
  filters: {
    text: '',
    priceTier: 'all',
    dateFrom: '',
    dateTo: '',
    timeFrom: '',
    timeTo: '',
    includeUnscheduled: true,
    starredOnly: false,
    hideDone: false,
    hideRecurring: false,
    types: new Set(),
    neighborhoods: new Set(),
    enabledLayers: new Set(LAYER_TOGGLE_ORDER),
  },
  editingUnlocked: false,
  calendar: null,
};

// ---------- DOM helpers ----------

function $(id) { return document.getElementById(id); }
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

// ---------- Edit mode (session-only) ----------

function updateEditModeUi() {
  const unlocked = state.editingUnlocked === true;

  const pill = $('editModePill');
  if (pill) {
    pill.textContent = unlocked ? 'Unlocked' : 'Locked';
    pill.classList.toggle('is-active', unlocked);
  }

  const statusText = $('editModeStatusText');
  if (statusText) {
    statusText.textContent = unlocked
      ? 'Editing is enabled for this session. Refresh/reload locks it again.'
      : 'Unlock to add, edit, delete, import, or run data tools. Refresh/reload locks it again.';
  }

  const unlockRow = $('editModeUnlockRow');
  if (unlockRow) unlockRow.hidden = unlocked;

  const err = $('editModeError');
  if (err) err.hidden = true;

  const lockBtn = $('btnLockEditMode');
  if (lockBtn) lockBtn.hidden = !unlocked;

  const addBtn = $('btnOpenAdd');
  if (addBtn) addBtn.disabled = !unlocked;

  // Hide add/import controls entirely until edit mode is unlocked (reduces confusion for view-only visitors).
  const editActions = $('editModeActions');
  if (editActions) editActions.hidden = !unlocked;

  // Hide data tools & sync section until edit mode is unlocked.
  const dataToolsSection = $('settingsDataTools');
  if (dataToolsSection) dataToolsSection.hidden = !unlocked;

  // Tools that change data should be locked behind edit mode.
  const gated = [
  'btnOpenGitHubSync',
  'btnEnrichNYC',
  'btnGeoSearchNYC',
  'btnCopySeedJs',
  'btnDownloadSeedJs',
  'btnResetToSeed',
];
  for (const id of gated) {
    const el = $(id);
    if (el) el.disabled = !unlocked;
  }

  // List actions column
  const thActions = $('thActions');
  if (thActions) thActions.hidden = !unlocked;

  // Import buttons inside the IO dialog (exports still work when locked)
  const ioLocked = !unlocked;
  const ioNote = $('ioLockedNote');
  if (ioNote) ioNote.hidden = !ioLocked;
  const btnImportJson = $('btnImportJson');
  if (btnImportJson) btnImportJson.disabled = ioLocked;
  const btnImportIcs = $('btnImportIcs');
  if (btnImportIcs) btnImportIcs.disabled = ioLocked;
  const importJsonFile = $('importJsonFile');
  if (importJsonFile) importJsonFile.disabled = ioLocked;
  const importIcsFile = $('importIcsFile');
  if (importIcsFile) importIcsFile.disabled = ioLocked;
  const importIcsLayer = $('importIcsLayer');
  if (importIcsLayer) importIcsLayer.disabled = ioLocked;
}

function setEditingUnlocked(unlocked) {
  state.editingUnlocked = unlocked === true;
  updateEditModeUi();
  // Re-render UI that conditionally exposes editing controls.
  renderSelectedDetails();
  refresh();
}

function openSettingsToUnlockEditing() {
  const dlg = $('settingsDialog');
  try {
    if (dlg && !dlg.open) dlg.showModal();
  } catch (_) {}

  const pwdRow = $('editModeUnlockRow');
  try { pwdRow?.scrollIntoView({ block: 'center' }); } catch (_) {}
  const pwd = $('editModePassword');
  if (pwd) {
    pwd.value = '';
    try { pwd.focus(); } catch (_) {}
  }
}

function requireEditMode() {
  if (state.editingUnlocked === true) return true;
  openSettingsToUnlockEditing();
  return false;
}

function setSelected(id) {
  state.selectedId = id;
  renderSelectedDetails();
  if (id) openDetailsDrawer();
  else closeDetailsDrawer();
}

function getSelectedItem() {
  if (!state.selectedId) return null;
  return store.items.find(it => it.id === state.selectedId) || null;
}

function openDetailsDrawer() {
  const drawer = $('detailsDrawer');
  if (!drawer) return;
  drawer.hidden = false;
  document.body.classList.add('has-drawer');
  try { state.calendar?.updateSize(); } catch (_) {}
}

function closeDetailsDrawer({ clearSelection = false } = {}) {
  const drawer = $('detailsDrawer');
  if (drawer) drawer.hidden = true;
  document.body.classList.remove('has-drawer');
  try { state.calendar?.updateSize(); } catch (_) {}
  if (clearSelection) {
    state.selectedId = null;
    renderSelectedDetails();
    renderList();
  }
}

// ---------- Rendering ----------

function renderFacetPills(container, values, selectedSet, onToggle, { kind = 'default' } = {}) {
  container.innerHTML = '';
  for (const v of values) {
    const isOn = selectedSet.has(v);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill' + (isOn ? ' is-active' : '');

    if (kind === 'type') {
      btn.classList.add('pill--type');
      const tc = typeColors(v);

      // Subtle key: colored dot + colored text (pills stay mostly neutral)
      const sw = document.createElement('span');
      sw.className = 'type-swatch';
      sw.style.background = tc.bg;
      sw.style.borderColor = tc.border;

      const label = document.createElement('span');
      label.className = 'pill__label';
      label.textContent = typeDisplayName(v) || v;
      label.style.color = tc.bg;

      btn.appendChild(sw);
      btn.appendChild(label);

      if (isOn) {
        btn.style.borderColor = tc.border;
        btn.style.background = hexToRgba(tc.bg, 0.12);
      }
    } else {
      btn.textContent = v;
    }

    btn.addEventListener('click', () => onToggle(v));
    container.appendChild(btn);
  }

  if (values.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'helptext';
    empty.textContent = 'No values yet — add items and they will appear here.';
    container.appendChild(empty);
  }
}

// ---------- Neighborhood grouping (NYC) ----------

const BOROUGH_ORDER = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'Other'];

const REGION_ORDER = {
  'Manhattan': ['Upper Manhattan', 'Midtown', 'Lower Manhattan', 'Other'],
  'Brooklyn': ['West Brooklyn', 'East Brooklyn', 'Other'],
  'Queens': ['Queens', 'Other'],
  'Bronx': ['Bronx', 'Other'],
  'Staten Island': ['Staten Island', 'Other'],
  'Other': ['Other'],
};

function _includesAny(hay, needles) {
  for (const n of needles) {
    if (hay.includes(n)) return true;
  }
  return false;
}

function categorizeNeighborhood(n) {
  const raw = normalizeStr(n);
  if (!raw) return { borough: 'Other', region: 'Other' };
  const s = raw.toLowerCase();

  // Manhattan
  if (_includesAny(s, [
    'upper east', 'ues', 'upper west', 'uws', 'harlem', 'east harlem', 'morningside',
    'washington heights', 'inwood', 'hamilton heights', 'yorkville', 'lenox hill', 'carnegie hill'
  ])) return { borough: 'Manhattan', region: 'Upper Manhattan' };

  if (_includesAny(s, [
    'midtown', 'hell\'s kitchen', 'hells kitchen', 'times square', 'garment', 'theater district',
    'hudson yards', 'chelsea', 'flatiron', 'nomad', 'no mad', 'kips bay', 'murray hill', 'gramercy',
    'union square'
  ])) return { borough: 'Manhattan', region: 'Midtown' };

  if (_includesAny(s, [
    'lower east', 'les', 'east village', 'west village', 'greenwich village', 'village',
    'soho', 'tribeca', 'chinatown', 'little italy', 'nolita', 'financial district', 'fidi',
    'battery park', 'meatpacking', 'bowery', 'two bridges', 'alphabet city', 'noho'
  ])) return { borough: 'Manhattan', region: 'Lower Manhattan' };

  // Brooklyn
  if (_includesAny(s, [
    'park slope', 'carroll gardens', 'cobble hill', 'boerum hill', 'brooklyn heights', 'dumbo',
    'downtown brooklyn', 'fort greene', 'clinton hill', 'gowanus', 'red hook', 'sunset park',
    'bay ridge', 'greenpoint', 'williamsburg'
  ])) return { borough: 'Brooklyn', region: 'West Brooklyn' };

  if (_includesAny(s, [
    'bushwick', 'bed-stuy', 'bed stuy', 'bedford-stuyvesant', 'east williamsburg', 'crown heights',
    'flatbush', 'east new york', 'brownsville', 'canarsie', 'borough park', 'midwood'
  ])) return { borough: 'Brooklyn', region: 'East Brooklyn' };

  // Queens
  if (_includesAny(s, ['astoria', 'long island city', 'lic', 'ridgewood', 'sunnyside', 'jackson heights', 'flushing', 'forest hills', 'elmhurst', 'woodside', 'jamaica'])) {
    return { borough: 'Queens', region: 'Queens' };
  }

  // Bronx
  if (_includesAny(s, ['bronx', 'mott haven', 'concourse', 'riverdale', 'fordham', 'pelham', 'kingsbridge'])) {
    return { borough: 'Bronx', region: 'Bronx' };
  }

  // Staten Island
  if (_includesAny(s, ['staten', 'st. george', 'saint george', 'tottenville', 'great kills', 'stapleton'])) {
    return { borough: 'Staten Island', region: 'Staten Island' };
  }

  return { borough: 'Other', region: 'Other' };
}

function buildNeighborhoodTree(neighborhoodVals) {
  const tree = new Map(); // borough -> Map(region -> neighborhoods[])
  for (const n of neighborhoodVals) {
    const { borough, region } = categorizeNeighborhood(n);
    if (!tree.has(borough)) tree.set(borough, new Map());
    const rmap = tree.get(borough);
    if (!rmap.has(region)) rmap.set(region, []);
    rmap.get(region).push(n);
  }
  // Sort neighborhood lists
  for (const [, rmap] of tree) {
    for (const [region, arr] of rmap) {
      arr.sort((a, b) => a.localeCompare(b));
      rmap.set(region, arr);
    }
  }
  return tree;
}

function sortRegionsForBorough(borough, regionKeys) {
  const pref = REGION_ORDER[borough] || [];
  const out = [];
  for (const r of pref) {
    if (regionKeys.includes(r)) out.push(r);
  }
  const rest = regionKeys.filter(r => !out.includes(r)).sort((a, b) => a.localeCompare(b));
  return out.concat(rest);
}

function setGroupCheckboxState(input, selectedCount, totalCount) {
  input.indeterminate = false;
  if (totalCount === 0) {
    input.checked = false;
    input.disabled = true;
    return;
  }
  input.disabled = false;
  if (selectedCount === 0) {
    input.checked = false;
  } else if (selectedCount === totalCount) {
    input.checked = true;
  } else {
    input.checked = false;
    input.indeterminate = true;
  }
}

function renderNeighborhoodTree(container, neighborhoodVals, selectedSet) {
  if (!container) return;
  container.innerHTML = '';

  if (!neighborhoodVals || neighborhoodVals.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'helptext';
    empty.textContent = 'No neighborhoods yet — add a neighborhood to an item and it will appear here.';
    container.appendChild(empty);
    return;
  }

  const tree = buildNeighborhoodTree(neighborhoodVals);
  const openBoroughs = state.neighborhoodTree.openBoroughs;
  const openRegions = state.neighborhoodTree.openRegions;

  const persistOpen = () => {
    uiPrefs.neighborhoodOpenBoroughs = Array.from(openBoroughs);
    uiPrefs.neighborhoodOpenRegions = Array.from(openRegions);
    saveUiPrefs(uiPrefs);
  };

  for (const borough of BOROUGH_ORDER) {
    const rmap = tree.get(borough);
    if (!rmap) continue;

    // Compute borough checkbox tri-state
    const allNeighborhoods = [];
    for (const arr of rmap.values()) allNeighborhoods.push(...arr);
    const totalN = allNeighborhoods.length;
    const selectedN = allNeighborhoods.filter(n => selectedSet.has(n)).length;

    const boroughDetails = document.createElement('details');
    boroughDetails.className = 'tree__group';
    boroughDetails.open = openBoroughs.has(borough);
    boroughDetails.addEventListener('toggle', () => {
      if (boroughDetails.open) openBoroughs.add(borough);
      else openBoroughs.delete(borough);
      persistOpen();
    });

    const boroughSummary = document.createElement('summary');
    boroughSummary.className = 'tree__summary';

    const boroughMain = document.createElement('div');
    boroughMain.className = 'tree__summary-main';

    const boroughLabel = document.createElement('label');
    boroughLabel.className = 'checkbox checkbox--inline';
    const boroughInput = document.createElement('input');
    boroughInput.type = 'checkbox';
    setGroupCheckboxState(boroughInput, selectedN, totalN);
    boroughInput.addEventListener('click', (e) => e.stopPropagation());
    boroughInput.addEventListener('change', () => {
      const on = boroughInput.checked === true;
      for (const n of allNeighborhoods) {
        if (on) selectedSet.add(n);
        else selectedSet.delete(n);
      }
      refresh();
    });

    const boroughName = document.createElement('span');
    boroughName.className = 'tree__title';
    boroughName.textContent = borough;

    boroughLabel.appendChild(boroughInput);
    boroughLabel.appendChild(boroughName);
    boroughMain.appendChild(boroughLabel);

    const hint = document.createElement('span');
    hint.className = 'tree__hint';
    hint.textContent = `${selectedN}/${totalN}`;

    boroughSummary.appendChild(boroughMain);
    boroughSummary.appendChild(hint);
    boroughDetails.appendChild(boroughSummary);

    // Regions (collapsed by default)
    const regionKeys = Array.from(rmap.keys());
    const orderedRegions = sortRegionsForBorough(borough, regionKeys);

    for (const region of orderedRegions) {
      const neighborhoods = rmap.get(region) || [];
      if (neighborhoods.length === 0) continue;

      const regionKey = `${borough}::${region}`;
      const regionDetails = document.createElement('details');
      regionDetails.className = 'tree__region';
      regionDetails.open = openRegions.has(regionKey);
      regionDetails.addEventListener('toggle', () => {
        if (regionDetails.open) openRegions.add(regionKey);
        else openRegions.delete(regionKey);
        persistOpen();
      });

      const regionSummary = document.createElement('summary');
      regionSummary.className = 'tree__summary';

      const regionMain = document.createElement('div');
      regionMain.className = 'tree__summary-main';

      const regionLabel = document.createElement('label');
      regionLabel.className = 'checkbox checkbox--inline';
      const regionInput = document.createElement('input');
      regionInput.type = 'checkbox';

      const regionTotal = neighborhoods.length;
      const regionSelected = neighborhoods.filter(n => selectedSet.has(n)).length;
      setGroupCheckboxState(regionInput, regionSelected, regionTotal);

      regionInput.addEventListener('click', (e) => e.stopPropagation());
      regionInput.addEventListener('change', () => {
        const on = regionInput.checked === true;
        for (const n of neighborhoods) {
          if (on) selectedSet.add(n);
          else selectedSet.delete(n);
        }
        refresh();
      });

      const regionName = document.createElement('span');
      regionName.className = 'tree__subtitle';
      regionName.textContent = region;

      regionLabel.appendChild(regionInput);
      regionLabel.appendChild(regionName);
      regionMain.appendChild(regionLabel);

      const regionHint = document.createElement('span');
      regionHint.className = 'tree__hint';
      regionHint.textContent = `${regionSelected}/${regionTotal}`;

      regionSummary.appendChild(regionMain);
      regionSummary.appendChild(regionHint);
      regionDetails.appendChild(regionSummary);

      const list = document.createElement('div');
      list.className = 'tree__leaf-list';

      for (const n of neighborhoods) {
        const row = document.createElement('label');
        row.className = 'checkbox checkbox--inline tree__leaf';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = selectedSet.has(n);
        input.addEventListener('change', () => {
          if (input.checked) selectedSet.add(n);
          else selectedSet.delete(n);
          refresh();
        });
        const name = document.createElement('span');
        name.textContent = n;
        row.appendChild(input);
        row.appendChild(name);
        list.appendChild(row);
      }

      regionDetails.appendChild(list);
      boroughDetails.appendChild(regionDetails);
    }

    container.appendChild(boroughDetails);
  }
}

function renderLayers(container) {
  if (!container) return;
  container.innerHTML = '';

  for (const layer of LAYER_TOGGLE_ORDER) {
    const on = state.filters.enabledLayers.has(layer);

    const row = document.createElement('div');
    row.className = 'layer-row' + (on ? '' : ' is-off');

    const label = document.createElement('div');
    label.className = 'layer-row__label';
    label.textContent = layer;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-eye';
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? `Hide ${layer}` : `Show ${layer}`);
    btn.innerHTML = on ? ICON_EYE_OPEN_SVG : ICON_EYE_CLOSED_SVG;
    btn.addEventListener('click', () => {
      if (state.filters.enabledLayers.has(layer)) state.filters.enabledLayers.delete(layer);
      else state.filters.enabledLayers.add(layer);
      refresh();
    });

    row.appendChild(label);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

function renderFilters() {
  const items = store.items;
  const typeVals = buildFacetValues(items, 'type', { includeDefaults: DEFAULT_TYPES });
  const neighborhoodVals = buildFacetValues(items, 'neighborhood');

  renderFacetPills($('filterTypes'), typeVals, state.filters.types, (v) => {
    if (state.filters.types.has(v)) state.filters.types.delete(v);
    else state.filters.types.add(v);
    refresh();
  }, { kind: 'type' });

  renderNeighborhoodTree($('filterNeighborhoodTree'), neighborhoodVals, state.filters.neighborhoods);

  renderLayers($('filterLayers'));

  const priceEl = $('filterPriceTier');
  if (priceEl) priceEl.value = normalizeStr(state.filters.priceTier) || 'all';

  const hrEl = $('filterHideRecurring');
  if (hrEl) hrEl.checked = state.filters.hideRecurring !== true;

}


function renderSelectedDetails() {
  const el = $('selectedDetails');
  const item = getSelectedItem();
  if (!item) {
    el.innerHTML = 'Click an event in the calendar, or a row in the list.';
    return;
  }

  const lines = [];
  lines.push(`<div class="selected__title">${item.ticketsRequired ? ticketIconHtml() : ''}${escapeHtml(item.title)}</div>`);

  if (isRecurringItem(item)) {
    lines.push(`<div class="notice notice--recurring">Recurring event</div>`);
  }

  const metaParts = [];
  if (normalizeStr(item.type)) metaParts.push(`<span class="tag">${escapeHtml(typeDisplayName(item.type) || item.type)}</span>`);
  if (normalizeStr(item.neighborhood)) metaParts.push(`<span class="tag">${escapeHtml(item.neighborhood)}</span>`);
  metaParts.push(item.starred ? `<span class="tag tag--star">★ Starred</span>` : '');

  // Status tags (read-only; keeps the UI understandable even when edit mode is locked)
  if (item.committed === true) metaParts.push(`<span class="tag">Committed</span>`);
  if (item.done === true) metaParts.push(`<span class="tag">Done</span>`);

  const cost = formatCost(item);
  if (cost === 'Free') metaParts.push(`<span class="tag tag--free">Free</span>`);
  else if (cost !== '—') metaParts.push(`<span class="tag">${escapeHtml(cost)}</span>`);

  if (normalizeStr(item.layer)) metaParts.push(`<span class="tag">layer: ${escapeHtml(item.layer)}</span>`);

  lines.push(`<div class="selected__meta">${metaParts.filter(Boolean).join(' ')}</div>`);

  if (normalizeStr(item.summary)) {
    lines.push(`<div class="selected__summary">${escapeHtml(item.summary)}</div>`);
  }

  if (normalizeStr(item.address)) {
    lines.push(`<div class="selected__block"><span class="muted">Address:</span> ${escapeHtml(item.address)}</div>`);
  }

  if (normalizeStr(item.start) || (item.dateRange && item.openHours)) {
    if (item.dateRange && item.openHours) {
      const dr = item.dateRange;
      lines.push(`<div class="selected__block"><span class="muted">When:</span> Open hours (${escapeHtml(dr.start)} → ${escapeHtml(dr.end)})</div>`);
    } else {
      const win = itemSingleInstanceWindow(item);
      if (win?.start) {
        lines.push(`<div class="selected__block"><span class="muted">When:</span> ${escapeHtml(isAllDayDateOnly(item) ? formatShortDate(win.start) : formatShortDateTime(win.start))}</div>`);
      }
    }
  } else {
    lines.push(`<div class="selected__block"><span class="muted">When:</span> Unscheduled</div>`);
  }

  if (normalizeStr(item.rrule)) {
    lines.push(`<div class="selected__block"><span class="muted">RRULE:</span> ${escapeHtml(item.rrule)}</div>`);
  }

  if (item.ticketsRequired || normalizeStr(item.ticketsLink) || item.haveTickets) {
    const t = [];
    if (item.ticketsRequired) t.push('tickets required');
    if (item.haveTickets) t.push('have tickets');
    if (normalizeStr(item.ticketsLink)) t.push(`link: <a href="${escapeHtml(item.ticketsLink)}" target="_blank" rel="noreferrer">open</a>`);
    lines.push(`<div class="selected__block"><span class="muted">Tickets:</span> ${t.join(' · ')}</div>`);
  }

  if (normalizeStr(item.notes)) {
    lines.push(`<div class="selected__notes">${escapeHtml(item.notes).replace(/\n/g, '<br/>')}</div>`);
  }

  // Calendar actions (read-only; available to all visitors)
  const canIcs = hasCalendarPresence(item);
  const googleUrl = buildGoogleCalendarUrl(item);
  lines.push(`<div class="inline-actions" style="margin-top: 12px;">
    <button class="btn btn--small" type="button" id="btnSelectedDownloadIcs" ${canIcs ? '' : 'disabled'}>Download .ics</button>
    ${googleUrl
      ? `<a class="btn btn--small" href="${escapeHtml(googleUrl)}" target="_blank" rel="noreferrer">Add to Google Calendar</a>`
      : `<button class="btn btn--small" type="button" disabled>Add to Google Calendar</button>`
    }
  </div>`);

  // Edit-only actions (hidden unless unlocked)
  const unlocked = state.editingUnlocked === true;
  if (unlocked) {
    lines.push(`<div class="selected__actions">
      <button class="starbtn" type="button" id="btnSelectedToggleStar" aria-label="${item.starred ? 'Remove top pick' : 'Mark as top pick'}" title="${item.starred ? 'Top pick' : 'Mark as top pick'}">${item.starred ? '★' : '☆'}</button>
      <label class="checkbox checkbox--inline">
        <input id="detailsCommitted" type="checkbox" ${item.committed === true ? 'checked' : ''} />
        <span>Committed</span>
      </label>
      <label class="checkbox checkbox--inline">
        <input id="detailsDone" type="checkbox" ${item.done === true ? 'checked' : ''} />
        <span>Done</span>
      </label>
      <div class="spacer"></div>
      <button class="btn" type="button" id="btnSelectedEdit">Edit</button>
    </div>`);
  }

  el.innerHTML = lines.join('');

  const btnIcs = $('btnSelectedDownloadIcs');
  if (btnIcs) {
    btnIcs.addEventListener('click', () => {
      try { downloadIcsForItem(item); } catch (err) { alert(err?.message || String(err)); }
    });
  }

  // Edit-only wiring
  if (unlocked) {
    const btnEdit = $('btnSelectedEdit');
    if (btnEdit) btnEdit.addEventListener('click', () => openEditDialog(item.id));

    const btnStar = $('btnSelectedToggleStar');
    if (btnStar) btnStar.addEventListener('click', () => toggleStar(item.id));

    const committedEl = $('detailsCommitted');
    if (committedEl) committedEl.addEventListener('change', (e) => {
      setCommitted(item.id, e.target.checked === true);
    });

    const doneEl = $('detailsDone');
    if (doneEl) doneEl.addEventListener('change', (e) => {
      setDone(item.id, e.target.checked === true);
    });
  }
}

function computeListRange(now, { mode = 'active' } = {}) {
  const df = getEffectiveDateFilter(state.filters, { scope: 'list' });
  if (!df.active) return { active: false, start: null, end: null };

  if (mode === 'archive') {
    const start = df.start;
    const end = new Date(Math.min(df.end.getTime(), now.getTime() + 1));
    return { active: true, start, end };
  }

  // active
  const start = new Date(Math.max(df.start.getTime(), now.getTime()));
  const end = df.end;
  return { active: true, start, end };
}

function renderList() {
  const tbody = $('itemsTableBody');
  tbody.innerHTML = '';

const now = new Date();
const viewingArchive = state.listTab === 'archive';

// Tabs UI
const tabA = $('tabListActive');
const tabR = $('tabListArchive');
if (tabA && tabR) {
  tabA.classList.toggle('is-active', !viewingArchive);
  tabR.classList.toggle('is-active', viewingArchive);
  tabA.setAttribute('aria-selected', String(!viewingArchive));
  tabR.setAttribute('aria-selected', String(viewingArchive));
}

const dateFilter = getEffectiveDateFilter(state.filters, { scope: 'list' });
const listRange = computeListRange(now, { mode: viewingArchive ? 'archive' : 'active' });
const timeFilter = getEffectiveTimeFilter(state.filters, { scope: 'list' });

let filtered = applyFilters(store.items, state.filters, { scope: 'list' });

// Active tab hides fully passed items; Archive tab shows them.
if (viewingArchive) {
  filtered = filtered.filter((it) => isArchivedItem(it, now));
} else {
  filtered = filtered.filter((it) => !isArchivedItem(it, now));
}

// If a date filter is active, keep only items that have an occurrence inside the window.
// If a time filter is also active, require overlap with that time window.
if (dateFilter.active) {
  filtered = filtered.filter((it) => {
    if (!hasCalendarPresence(it)) return (!viewingArchive && state.filters.includeUnscheduled === true);
    return itemHasOccurrenceInRangeOverlappingTimeFilter(it, listRange.start, listRange.end, timeFilter);
  });
} else if (timeFilter.active) {
  filtered = filtered.filter((it) => {
    if (!hasCalendarPresence(it)) return (!viewingArchive && state.filters.includeUnscheduled === true);
    const win = viewingArchive ? lastOccurrenceWindow(it, now) : nextOccurrenceWindow(it, now);
    if (!win) return false;
    return occurrenceOverlapsTimeFilter(win.start, win.end, timeFilter);
  });
}

// Sort:
// - Active: starred first, then soonest (next) occurrence
// - Archive: starred first, then most recent (last) occurrence
const withSortKeys = filtered.map(it => {
  const d = dateFilter.active
    ? (viewingArchive
      ? lastOccurrenceStartInRangeOverlappingTimeFilter(it, listRange.start, listRange.end, timeFilter)
      : firstOccurrenceStartInRangeOverlappingTimeFilter(it, listRange.start, listRange.end, timeFilter))
    : (viewingArchive
      ? (timeFilter.active ? (lastOccurrenceWindow(it, now)?.start ?? lastOccurrenceStart(it, now)) : lastOccurrenceStart(it, now))
      : (timeFilter.active ? (nextOccurrenceWindow(it, now)?.start ?? nextOccurrenceStart(it, now)) : nextOccurrenceStart(it, now)));
  const key = d ? d.getTime() : (viewingArchive ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
  return { it, key };
});

withSortKeys.sort((a, b) => {
  const star = (b.it.starred ? 1 : 0) - (a.it.starred ? 1 : 0);
  if (star !== 0) return star;
  if (a.key !== b.key) return viewingArchive ? (b.key - a.key) : (a.key - b.key);
  return a.it.title.localeCompare(b.it.title);
});

  for (const { it } of withSortKeys) {
    const tr = document.createElement('tr');
    if (it.id === state.selectedId) tr.classList.add('is-selected');
    if (it.done === true) tr.classList.add('is-done');

    const tdStar = document.createElement('td');
    const btnStar = document.createElement('button');
    btnStar.type = 'button';
    btnStar.className = 'starbtn' + (it.starred ? ' is-on' : '');
    btnStar.disabled = state.editingUnlocked !== true;
    btnStar.textContent = it.starred ? '★' : '☆';
    btnStar.title = it.starred ? 'Unstar' : 'Star';
    btnStar.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(it.id);
    });
    tdStar.appendChild(btnStar);

    const tdCommitted = document.createElement('td');
    const cbCommitted = document.createElement('input');
    cbCommitted.type = 'checkbox';
    cbCommitted.checked = it.committed === true;
    cbCommitted.disabled = state.editingUnlocked !== true;
    cbCommitted.title = it.committed === true ? 'Committed' : 'Mark committed';
    cbCommitted.addEventListener('click', (e) => e.stopPropagation());
    cbCommitted.addEventListener('change', (e) => {
      e.stopPropagation();
      setCommitted(it.id, cbCommitted.checked === true);
    });
    tdCommitted.appendChild(cbCommitted);

    const tdDone = document.createElement('td');
    const cbDone = document.createElement('input');
    cbDone.type = 'checkbox';
    cbDone.checked = it.done === true;
    cbDone.disabled = state.editingUnlocked !== true;
    cbDone.title = it.done === true ? 'Done' : 'Mark done';
    cbDone.addEventListener('click', (e) => e.stopPropagation());
    cbDone.addEventListener('change', (e) => {
      e.stopPropagation();
      setDone(it.id, cbDone.checked === true);
    });
    tdDone.appendChild(cbDone);

    const tdTitle = document.createElement('td');
    const tc = typeColors(it.type);
    const dot = `<span class="dot" style="background:${tc.bg}; border-color:${tc.border}"></span>`;
    const ticket = it.ticketsRequired ? ticketIconHtml() : '';
    tdTitle.innerHTML = `<div class="cell-title">${dot}${ticket}<span>${escapeHtml(it.title)}</span></div>` +
      (normalizeStr(it.layer) ? `<div class="helptext">layer: ${escapeHtml(it.layer)}</div>` : '');

    const tdSummary = document.createElement('td');
    tdSummary.textContent = normalizeStr(it.summary) || '';

    const tdType = document.createElement('td');
    tdType.textContent = typeDisplayName(it.type) || '';

    const tdN = document.createElement('td');
    tdN.textContent = normalizeStr(it.neighborhood) || '';

    const tdCost = document.createElement('td');
    tdCost.textContent = formatCost(it);

    const tdWhen = document.createElement('td');
    tdWhen.textContent = formatWhenForList(it, { now, listRange: dateFilter.active ? listRange : null, mode: viewingArchive ? 'archive' : 'active' });

    const tdActions = document.createElement('td');
    tdActions.className = 'actions';

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn btn--small';
    btnEdit.textContent = 'Edit';
    btnEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditDialog(it.id);
    });

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn btn--small btn--danger';
    btnDel.textContent = 'Delete';
    btnDel.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteItem(it.id);
    });

    tdActions.hidden = state.editingUnlocked !== true;
    if (state.editingUnlocked === true) {
      tdActions.appendChild(btnEdit);
      tdActions.appendChild(btnDel);
    }

    tr.appendChild(tdStar);
    tr.appendChild(tdCommitted);
    tr.appendChild(tdDone);
    tr.appendChild(tdTitle);
    tr.appendChild(tdSummary);
    tr.appendChild(tdType);
    tr.appendChild(tdN);
    tr.appendChild(tdCost);
    tr.appendChild(tdWhen);
    tr.appendChild(tdActions);

    tr.addEventListener('click', () => {
      setSelected(it.id);
      renderList();
    });

    tr.addEventListener('dblclick', (e) => {
      // Avoid opening edit when double-clicking action buttons/links inside the row
      if (e.target && (e.target.closest('button') || e.target.closest('a'))) return;
      if (state.editingUnlocked !== true) return;
      openEditDialog(it.id);
    });

    tbody.appendChild(tr);
  }
}

// ---------- Calendar ----------

function initCalendar() {
  const calEl = $('calendar');
  const fallback = $('calendarFallback');

  if (!window.FullCalendar) {
    show(fallback);
    return null;
  }

  hide(fallback);

  const calendar = new FullCalendar.Calendar(calEl, {
    initialView: 'timeGridWeek',
    nowIndicator: true,
    height: '100%',
    selectable: false,
    slotMinTime: state.calendarSettings.condenseEarlyHours ? '08:00:00' : '00:00:00',
    slotMaxTime: '24:00:00',
    scrollTime: state.calendarSettings.condenseEarlyHours ? '08:00:00' : '00:00:00',
    datesSet: (info) => {
      try {
        updateEarlyStrip(info.start, info.end);
      } catch (_) {}
    },
    eventClick: (info) => {
      const itemId = info.event.extendedProps?.itemId;
      if (itemId) setSelected(itemId);
    },
    eventContent: (arg) => {
      const viewType = arg.view?.type || '';
      const itemId = arg.event.extendedProps?.itemId;
      const item = itemId ? store.items.find((it) => it.id === itemId) : null;
      if (!item) return;

      const wrap = document.createElement('div');
      wrap.className = 'av-event';
      if (item.done === true) wrap.classList.add('is-done');

      const titleRow = document.createElement('div');
      titleRow.className = 'av-event__title';

      if (item.starred) {
        const star = document.createElement('span');
        star.className = 'av-event__star';
        star.textContent = '★';
        titleRow.appendChild(star);
      }

      if (item.committed === true) {
        const c = document.createElement('span');
        c.className = 'av-event__flag av-event__flag--committed';
        c.textContent = '☑';
        titleRow.appendChild(c);
      }

      if (item.done === true) {
        const d = document.createElement('span');
        d.className = 'av-event__flag av-event__flag--done';
        d.textContent = '✓';
        titleRow.appendChild(d);
      }

      if (item.ticketsRequired) {
        const span = document.createElement('span');
        span.className = 'icon-ticket';
        span.innerHTML = ICON_TICKET_SVG;
        titleRow.appendChild(span);
      }

      const title = document.createElement('span');
      title.textContent = arg.event.title;
      titleRow.appendChild(title);

      wrap.appendChild(titleRow);

      // Show neighborhood (and cost) on a smaller second line for timeGrid views.
      const showSub = viewType.startsWith('timeGrid');
      if (showSub) {
        const bits = [];
        const n = normalizeStr(item.neighborhood);
        if (n) bits.push(n);
        const c = formatCost(item);
        if (c && c !== '—' && c !== 'Free') bits.push(c);
        if (bits.length) {
          const sub = document.createElement('div');
          sub.className = 'av-event__sub';
          sub.textContent = bits.join(' · ');
          wrap.appendChild(sub);
        }
      }

      return { domNodes: [wrap] };
    },
    eventDidMount: (info) => {
      // Double-click to open the edit dialog (keeps single-click for quick details)
      info.el.addEventListener('dblclick', () => {
        if (state.editingUnlocked !== true) return;
        const itemId = info.event.extendedProps?.itemId;
        if (itemId) openEditDialog(itemId);
      });
    },
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek'
    },
    events: (fetchInfo, successCallback, failureCallback) => {
      try {
        const filtered = applyFilters(store.items, state.filters, { scope: 'calendar' }).filter(hasCalendarPresence);
        const events = [];
        for (const it of filtered) {
          const evs = itemToCalendarEvents(it, fetchInfo.start, fetchInfo.end);
          for (const ev of evs) {
            events.push(ev);
          }
        }
        successCallback(events);
      } catch (err) {
        console.error(err);
        failureCallback(err);
      }
    }
  });

  calendar.render();
  return calendar;
}

function refreshCalendar() {
  if (!state.calendar) return;
  state.calendar.refetchEvents();
}

function refreshEarlyStrip() {
  if (!state.calendar) return;
  const view = state.calendar.view;
  if (!view) return;
  updateEarlyStrip(view.activeStart, view.activeEnd);
}

function formatTimeOnly(d) {
  try {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (_) {
    return formatShortDateTime(d);
  }
}

function formatDayShort(d) {
  try {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (_) {
    return formatShortDate(d);
  }
}

function statusPrefixText(it) {
  let p = '';
  if (it?.starred === true) p += '★ ';
  if (it?.committed === true) p += '☑ ';
  if (it?.done === true) p += '✓ ';
  return p;
}

function computeEarlyEvents(rangeStart, rangeEnd) {
  const cutoff = state.calendarSettings.earlyCutoffHour ?? 8;
  const filtered = applyFilters(store.items, state.filters, { scope: 'calendar' }).filter(hasCalendarPresence);
  const out = [];
  for (const it of filtered) {
    const evs = itemToCalendarEvents(it, rangeStart, rangeEnd);
    for (const ev of evs) {
      const s = ev.start;
      if (!s || typeof s === 'string') continue; // skip all-day date strings
      const start = (s instanceof Date) ? s : new Date(s);
      if (isNaN(start.getTime())) continue;
      if (start.getHours() >= cutoff) continue;
      out.push({
        itemId: it.id,
        title: statusPrefixText(it) + (ev.title || it.title),
        type: it.type || '',
        start,
        end: ev.end ? ((ev.end instanceof Date) ? ev.end : new Date(ev.end)) : null,
      });
    }
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

function updateEarlyStrip(rangeStart, rangeEnd) {
  const el = $('earlyStrip');
  if (!el) return;

  if (!state.calendarSettings.condenseEarlyHours) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  const early = computeEarlyEvents(rangeStart, rangeEnd);
  if (early.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  el.hidden = false;
  const cutoff = state.calendarSettings.earlyCutoffHour ?? 8;
  el.innerHTML = `
    <div class="early-strip__head">
      <div class="early-strip__title">Early hours</div>
      <div class="early-strip__count">${early.length} event${early.length === 1 ? '' : 's'} before ${cutoff}:00</div>
    </div>
    <div class="early-strip__list"></div>
  `;

  const list = el.querySelector('.early-strip__list');
  for (const ev of early) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'early-pill';
    const tc = typeColors(ev.type);
    btn.style.borderColor = tc.border;
    btn.style.background = hexToRgba(tc.bg, 0.18);
    btn.textContent = `${formatDayShort(ev.start)} · ${formatTimeOnly(ev.start)} — ${ev.title}`;
    btn.addEventListener('click', () => setSelected(ev.itemId));
    btn.addEventListener('dblclick', () => openEditDialog(ev.itemId));
    list.appendChild(btn);
  }
}

// ---------- CRUD ----------

function persistAndMaybeSync() {
  saveLocalStore(store);
  updateStorageUi();
  scheduleAutoPush();
}

function upsertItem(item) {
  const idx = store.items.findIndex(it => it.id === item.id);
  if (idx >= 0) store.items[idx] = item;
  else store.items.unshift(item);
  persistAndMaybeSync();
}

function deleteItem(id) {
  if (!id) return;
  if (!requireEditMode()) return;
  const item = store.items.find(it => it.id === id);
  const ok = confirm(`Delete "${item?.title || id}"?`);
  if (!ok) return;
  store.items = store.items.filter(it => it.id !== id);
  if (state.selectedId === id) {
    state.selectedId = null;
    closeDetailsDrawer();
  }
  persistAndMaybeSync();
  refresh();
}

function toggleStar(id) {
  const idx = store.items.findIndex(it => it.id === id);
  if (idx < 0) return;
  if (!requireEditMode()) return;
  store.items[idx].starred = !store.items[idx].starred;
  persistAndMaybeSync();
  refresh();
  setSelected(id);
}

function setCommitted(id, committed) {
  const idx = store.items.findIndex(it => it.id === id);
  if (idx < 0) return;
  if (!requireEditMode()) return;
  store.items[idx].committed = committed === true;
  persistAndMaybeSync();
  refresh();
  setSelected(id);
}

function setDone(id, done) {
  const idx = store.items.findIndex(it => it.id === id);
  if (idx < 0) return;
  if (!requireEditMode()) return;
  store.items[idx].done = done === true;
  persistAndMaybeSync();
  refresh();
  setSelected(id);
}

// ---------- Add/Edit dialog ----------

function setEditStarValue(isOn) {
  const val = isOn ? '1' : '0';
  const input = $('editStarred');
  if (input) input.value = val;

  const btn = $('editStarToggle');
  if (btn) {
    btn.classList.toggle('is-on', !!isOn);
    btn.textContent = isOn ? '★' : '☆';
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    btn.title = isOn ? 'Top pick (click to remove)' : 'Mark as a top pick';
  }
}

function getEditStarValue() {
  return normalizeStr($('editStarred')?.value) === '1';
}


function fillEditForm(item) {
  $('editId').value = item?.id || '';
  $('editTitle').value = item?.title || '';
  $('editSummary').value = item?.summary || '';
  $('editCategory').value = item?.type || '';

  $('editAddress').value = item?.address || '';
  $('editNeighborhood').value = item?.neighborhood || '';

  // Cost tier (default: free)
  const explicit = normalizeStr(item?.priceTier).toLowerCase();
  let tier = '';
  if (['free', 'low', 'medium', 'high'].includes(explicit)) tier = explicit;
  else {
    const inferred = item ? priceTierForItem(item) : 'free';
    tier = (inferred === 'unknown') ? '' : inferred;
  }
  $('editPriceTier').value = tier;

  const sp = splitDateTimeParts(item?.start);
  $('editStartDate').value = sp.date;
  $('editStartTime').value = sp.time;

  const ep = splitDateTimeParts(item?.end);
  $('editEndDate').value = ep.date;
  $('editEndTime').value = ep.time;

  $('editRRule').value = item?.rrule || '';
  $('editExDate').value = toArray(item?.exdate).join(', ');

  $('editRangeStart').value = item?.dateRange?.start || '';
  $('editRangeEnd').value = item?.dateRange?.end || '';
  $('editOpenHours').value = item?.openHours ? JSON.stringify(item.openHours, null, 2) : '';
  $('editLayer').value = item?.layer || '';

  $('editTicketsRequired').checked = item?.ticketsRequired === true;
  $('editHaveTickets').checked = item?.haveTickets === true;
  const committedEl = $('editCommitted');
  if (committedEl) committedEl.checked = item?.committed === true;
  const doneEl = $('editDone');
  if (doneEl) doneEl.checked = item?.done === true;
  $('editTicketsLink').value = item?.ticketsLink || '';
  $('editNotes').value = item?.notes || '';

  setEditStarValue(item?.starred === true);

  $('editRawJson').value = '';
}

function readEditForm(existingItem) {
  const base = existingItem ? { ...existingItem } : {
    id: newId(),
    tags: [],
    currency: 'USD',
    source: { kind: 'manual', createdAt: nowIso() },
  };

  base.title = normalizeStr($('editTitle').value);
  base.summary = normalizeStr($('editSummary').value);
  base.type = normalizeStr($('editCategory').value);
  base.neighborhood = normalizeStr($('editNeighborhood').value);
  base.address = normalizeStr($('editAddress').value);

  const tier = normalizeStr($('editPriceTier').value).toLowerCase();
  base.priceTier = ['free', 'low', 'medium', 'high'].includes(tier) ? tier : '';

  // Keep legacy cost/isFree aligned for backwards compatibility.
  if (base.priceTier === 'free') {
    base.isFree = true;
    base.cost = 0;
  } else {
    base.isFree = false;
    const c = parseNumberOrNull(base.cost);
    if (c !== null) base.cost = c;
    if (parseNumberOrNull(base.cost) == 0) base.cost = null;
  }

  base.starred = getEditStarValue();

  const sd = parseDateOnlyValue($('editStartDate').value);
  const st = normalizeStr($('editStartTime').value);
  const ed = parseDateOnlyValue($('editEndDate').value);
  const et = normalizeStr($('editEndTime').value);

  base.start = combineDateAndTime(sd, st);
  base.end = combineDateAndTime(ed, et);

  const startIsDateOnly = !!(base.start && /^\d{4}-\d{2}-\d{2}$/.test(base.start));
  const endIsDateOnly = !!(base.end && /^\d{4}-\d{2}-\d{2}$/.test(base.end));
  base.allDay = !!(base.start && startIsDateOnly && (!base.end || endIsDateOnly));

  base.rrule = normalizeStr($('editRRule').value) || null;
  const ex = normalizeStr($('editExDate').value);
  base.exdate = ex ? ex.split(',').map(s => normalizeStr(s)).filter(Boolean) : [];

  const rs = parseDateOnlyValue($('editRangeStart').value);
  const re = parseDateOnlyValue($('editRangeEnd').value);
  const openHoursText = normalizeStr($('editOpenHours').value);
  if (rs || re || openHoursText) {
    base.dateRange = { start: rs || '', end: re || '' };
    if (openHoursText) {
      const parsed = safeJsonParse(openHoursText, null);
      if (!Array.isArray(parsed)) {
        throw new Error('Open hours JSON must be an array.');
      }
      base.openHours = parsed;
    } else {
      base.openHours = null;
    }
  } else {
    base.dateRange = null;
    base.openHours = null;
  }

  base.layer = normalizeStr($('editLayer').value);

  base.ticketsRequired = $('editTicketsRequired').checked;
  base.haveTickets = $('editHaveTickets').checked;
  base.committed = ($('editCommitted')?.checked === true);
  base.done = ($('editDone')?.checked === true);
  base.ticketsLink = normalizeStr($('editTicketsLink').value);
  base.notes = $('editNotes').value || '';

  const raw = normalizeStr($('editRawJson').value);
  if (raw) {
    const patch = safeJsonParse(raw, null);
    if (!patch || typeof patch !== 'object') {
      throw new Error('Raw JSON is not valid JSON.');
    }
    Object.assign(base, patch);
  }

  // Clean empty strings to nulls where useful
  if (!normalizeStr(base.rrule)) base.rrule = null;
  if (!normalizeStr(base.layer)) base.layer = '';
  if (!normalizeStr(base.start)) base.start = null;
  if (!normalizeStr(base.end)) base.end = null;
  if (!normalizeStr(base.address)) base.address = '';
  if (!normalizeStr(base.type)) base.type = '';
  if (!normalizeStr(base.neighborhood)) base.neighborhood = '';
  if (!normalizeStr(base.summary)) base.summary = '';

  return base;
}

function openAddDialog() {
  if (!requireEditMode()) return;
  try { $('settingsDialog')?.close(); } catch (_) {}
  $('editDialogTitle').textContent = 'Add item';
  fillEditForm(null);
  hide($('btnDelete'));
  $('editDialog').showModal();
}

function openEditDialog(id) {
  if (!requireEditMode()) return;
  try { $('settingsDialog')?.close(); } catch (_) {}
  const item = store.items.find(it => it.id === id);
  if (!item) return;
  $('editDialogTitle').textContent = 'Edit item';
  fillEditForm(item);
  show($('btnDelete'));
  $('btnDelete').onclick = () => {
    $('editDialog').close();
    deleteItem(id);
  };
  $('editDialog').showModal();
}

// ---------- Import/Export ----------

function exportStoreJson() {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    items: store.items,
  };
}
function buildSeedJsText() {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    items: store.items,
  };
  const json = JSON.stringify(payload, null, 2);
  return `// Auto-generated seed data from locally stored items\nwindow.ACTIVITY_VAULT_SEED = ${json};\n`;
}

async function copySeedJsToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert('Copied seed.js to clipboard. Replace the repo\'s seed.js with this content and commit it.');
  } catch (e) {
    console.error(e);
    alert('Could not copy seed.js to clipboard. Try the download button instead.');
  }
}


function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert('Copied JSON to clipboard.');
  } catch (e) {
    console.error(e);
    alert('Could not copy to clipboard. You can still manually copy from the textbox.');
  }
}

function importJson(payload, { merge = true } = {}) {
  const parsed = (typeof payload === 'string') ? safeJsonParse(payload, null) : payload;
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON.');

  const items = parsed.items || parsed;
  if (!Array.isArray(items)) throw new Error('JSON must contain an "items" array.');

  const incoming = items.map(normalizeItem);

  if (!merge) {
    store.items = incoming;
  } else {
    const byId = new Map(store.items.map(it => [it.id, it]));
    for (const it of incoming) {
      byId.set(it.id, it);
    }
    store.items = Array.from(byId.values());
  }

  persistAndMaybeSync();
}

function openImportExportDialog() {
  try { $('settingsDialog')?.close(); } catch (_) {}
  $('importJsonText').value = '';
  $('importJsonFile').value = '';
  $('importIcsText').value = '';
  $('importIcsFile').value = '';
  $('importIcsLayer').value = '';

  // Import actions are disabled unless edit mode is unlocked
  updateEditModeUi();

  $('ioDialog').showModal();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// ----- ICS parsing (client-side, minimal) -----

function unfoldIcsLines(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line.trimEnd());
    }
  }
  return out;
}

function unescapeIcsValue(v) {
  return (v ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIcsDate(value) {
  const v = normalizeStr(value);
  if (!v) return null;
  if (/^\d{8}$/.test(v)) {
    const y = v.slice(0, 4);
    const mo = v.slice(4, 6);
    const d = v.slice(6, 8);
    return `${y}-${mo}-${d}`;
  }
  if (/^\d{8}T\d{6}Z$/.test(v)) {
    const y = v.slice(0, 4);
    const mo = v.slice(4, 6);
    const d = v.slice(6, 8);
    const hh = v.slice(9, 11);
    const mm = v.slice(11, 13);
    const ss = v.slice(13, 15);
    return `${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`;
  }
  if (/^\d{8}T\d{6}$/.test(v)) {
    const y = v.slice(0, 4);
    const mo = v.slice(4, 6);
    const d = v.slice(6, 8);
    const hh = v.slice(9, 11);
    const mm = v.slice(11, 13);
    const ss = v.slice(13, 15);
    return `${y}-${mo}-${d}T${hh}:${mm}:${ss}`;
  }
  return v;
}

function parseIcs(text, { defaultLayer = '' } = {}) {
  const lines = unfoldIcsLines(text);

  let calendarName = '';
  for (const line of lines) {
    if (line.startsWith('X-WR-CALNAME:')) {
      calendarName = unescapeIcsValue(line.split(':').slice(1).join(':'));
      break;
    }
  }

  const items = [];
  let inEvent = false;
  let evLines = [];

  function flushEvent(blockLines) {
    const fields = {};
    for (const line of blockLines) {
      if (!line || line.startsWith('BEGIN:') || line.startsWith('END:')) continue;
      const [left, ...rightParts] = line.split(':');
      if (!left || rightParts.length === 0) continue;
      const valueRaw = rightParts.join(':');
      const key = left.split(';')[0].toUpperCase();
      const value = unescapeIcsValue(valueRaw);

      if (key === 'EXDATE') {
        fields.EXDATE = fields.EXDATE || [];
        fields.EXDATE.push(value);
      } else {
        fields[key] = value;
      }
    }

    const uid = fields.UID || newId();
    const id = stableShortId(uid);
    const title = fields.SUMMARY || '(untitled)';

    const dtStartLine = blockLines.find(l => l.toUpperCase().startsWith('DTSTART')) || '';
    const dtEndLine = blockLines.find(l => l.toUpperCase().startsWith('DTEND')) || '';

    const dtStartVal = dtStartLine.split(':').slice(1).join(':');
    const dtEndVal = dtEndLine.split(':').slice(1).join(':');

    const startParsed = parseIcsDate(dtStartVal);
    const endParsed = parseIcsDate(dtEndVal);

    const allDay = (dtStartLine.toUpperCase().includes('VALUE=DATE')) || (/^\d{4}-\d{2}-\d{2}$/.test(normalizeStr(startParsed)));

    const ex = [];
    for (const exLine of toArray(fields.EXDATE)) {
      for (const part of exLine.split(',')) {
        const p = parseIcsDate(part);
        if (p) ex.push(p);
      }
    }

    const item = normalizeItem({
      id,
      title,
      summary: '',
      type: '',
      tags: [],
      neighborhood: '',
      cost: null,
      currency: 'USD',
      isFree: false,
      starred: false,
      start: startParsed,
      end: endParsed,
      allDay,
      rrule: fields.RRULE || null,
      exdate: ex,
      dateRange: null,
      openHours: null,
      notes: fields.DESCRIPTION || '',
      ticketsRequired: false,
      ticketsLink: '',
      haveTickets: false,
      address: fields.LOCATION || '',
      source: {
        kind: 'ics_import',
        calendarName,
        uid,
        importedAt: nowIso(),
      },
      layer: normalizeStr(defaultLayer),
    });

    items.push(item);
  }

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      evLines = [line];
      continue;
    }
    if (line === 'END:VEVENT') {
      evLines.push(line);
      flushEvent(evLines);
      inEvent = false;
      evLines = [];
      continue;
    }
    if (inEvent) evLines.push(line);
  }

  return { schemaVersion: SCHEMA_VERSION, items };
}

// ---------- Refresh (re-render all) ----------

function refresh() {
  renderFilters();
  renderList();
  renderSelectedDetails();
  refreshCalendar();
  refreshEarlyStrip();
}

// ---------- GitHub dialog ----------

function openGitHubDialog() {
  const dlg = $('githubDialog');

  $('ghGistId').value = normalizeStr(config.storage.gistId);
  $('ghFilename').value = normalizeStr(config.storage.filename) || 'activity-library.json';

  const token = getGitHubToken();
  $('ghToken').value = token;
  $('ghRememberToken').checked = config.storage.rememberToken === true;
  $('ghCreatePublic').checked = false;

  dlg.showModal();
}

function disconnectGist() {
  config.storage.backend = 'local';
  config.storage.gistId = '';
  config.storage.filename = 'activity-library.json';
  config.storage.lastPullAt = '';
  config.storage.lastPushAt = '';
  config.storage.lastError = '';
  config.storage.rememberToken = false;
  config.storage.token = '';
  setSessionToken('');
  saveConfig(config);
  updateStorageUi();
  alert('Disconnected GitHub sync.');
}

function saveGistSettingsFromDialog() {
  const gistId = normalizeStr($('ghGistId').value);
  const filename = normalizeStr($('ghFilename').value) || 'activity-library.json';

  const token = normalizeStr($('ghToken').value);
  const remember = $('ghRememberToken').checked;

  if (!gistId) {
    alert('Enter a gist ID, or use "Create new gist".');
    return;
  }

  config.storage.backend = 'gist';
  config.storage.gistId = gistId;
  config.storage.filename = filename;
  config.storage.rememberToken = remember === true;

  if (remember) {
    config.storage.token = token;
    setSessionToken('');
  } else {
    config.storage.token = '';
    setSessionToken(token);
  }

  saveConfig(config);
  updateStorageUi();
}

// ---------- Wire up ----------


function updateHeaderHeightVar() {
  const header = document.querySelector('.app-header');
  if (!header) return;
  const h = Math.ceil(header.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--header-h', `${h}px`);
}

document.addEventListener('DOMContentLoaded', () => {
  updateHeaderHeightVar();

  window.addEventListener('resize', () => {
    updateHeaderHeightVar();
    try { state.calendar?.updateSize(); } catch (_) {}
  });
  // (Layer toggles are fixed; do not infer from JSON.)

  // View toggles
  $('btnViewCalendar').addEventListener('click', () => setView('calendar'));
  $('btnViewList').addEventListener('click', () => setView('list'));

  // Help / instructions
  const helpBtn = $('btnOpenHelp');
  if (helpBtn) {
    helpBtn.addEventListener('click', () => {
      try { $('helpDialog')?.showModal(); } catch (_) {}
    });
  }
// List tabs (Active / Archive)
const tabActive = $('tabListActive');
const tabArchive = $('tabListArchive');
if (tabActive && tabArchive) {
  tabActive.addEventListener('click', () => {
    state.listTab = 'active';
    uiPrefs.listTab = 'active';
    saveUiPrefs(uiPrefs);
    refresh();
  });
  tabArchive.addEventListener('click', () => {
    state.listTab = 'archive';
    uiPrefs.listTab = 'archive';
    saveUiPrefs(uiPrefs);
    refresh();
  });
}



  $('btnOpenImportExport').addEventListener('click', openImportExportDialog);
  $('btnOpenAdd').addEventListener('click', openAddDialog);

  // Settings
  const settingsBtn = $('btnOpenSettings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      try {
        const errEl = $('editModeError');
        if (errEl) hide(errEl);
        const pwd = $('editModePassword');
        if (pwd) pwd.value = '';
      } catch (_) {}
      $('settingsDialog').showModal();
    });
  }

  // Edit mode (settings)
  const unlockBtn = $('btnUnlockEditMode');
  const lockBtn = $('btnLockEditMode');
  const pwdEl = $('editModePassword');
  if (pwdEl) {
    pwdEl.addEventListener('input', () => {
      const errEl = $('editModeError');
      if (errEl) hide(errEl);
    });
    pwdEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        unlockBtn?.click();
      }
    });
  }

  if (unlockBtn) {
    unlockBtn.addEventListener('click', () => {
      const pwd = String(pwdEl?.value || '');
      if (pwd.trim() === 'calendar') {
        setEditingUnlocked(true);
        if (pwdEl) pwdEl.value = '';
        const errEl = $('editModeError');
        if (errEl) hide(errEl);
      } else {
        const errEl = $('editModeError');
        if (errEl) show(errEl);
        if (pwdEl) {
          pwdEl.focus();
          pwdEl.select?.();
        }
      }
    });
  }

  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      setEditingUnlocked(false);
    });
  }

  updateEditModeUi();

  // Details drawer
  const closeDetailsBtn = $('btnCloseDetails');
  if (closeDetailsBtn) {
    closeDetailsBtn.addEventListener('click', () => closeDetailsDrawer());
  }

  // Filters
  $('filterText').addEventListener('input', (e) => {
    state.filters.text = e.target.value || '';
    refresh();
  });

  $('btnApplyFilters').addEventListener('click', () => {
    refresh();
  });

  const priceEl = $('filterPriceTier');
  if (priceEl) {
    priceEl.addEventListener('change', (e) => {
      state.filters.priceTier = e.target.value || 'all';
      refresh();
    });
  }

  $('filterDateFrom').addEventListener('change', (e) => {
    state.filters.dateFrom = e.target.value || '';
    refresh();
  });

  $('filterDateTo').addEventListener('change', (e) => {
    state.filters.dateTo = e.target.value || '';
    refresh();
  });

  const timeFromEl = $('filterTimeFrom');
  if (timeFromEl) {
    timeFromEl.addEventListener('change', (e) => {
      state.filters.timeFrom = e.target.value || '';
      refresh();
    });
  }

  const timeToEl = $('filterTimeTo');
  if (timeToEl) {
    timeToEl.addEventListener('change', (e) => {
      state.filters.timeTo = e.target.value || '';
      refresh();
    });
  }


  // List-only date presets (does not affect the calendar)
  const btnClearDates = $('btnClearListDates');
  if (btnClearDates) {
    btnClearDates.addEventListener('click', () => {
      state.filters.dateFrom = '';
      state.filters.dateTo = '';
      $('filterDateFrom').value = '';
      $('filterDateTo').value = '';
      refresh();
    });
  }

  const btnClearTimes = $('btnClearListTimes');
  if (btnClearTimes) {
    btnClearTimes.addEventListener('click', () => {
      state.filters.timeFrom = '';
      state.filters.timeTo = '';
      if (timeFromEl) timeFromEl.value = '';
      if (timeToEl) timeToEl.value = '';
      refresh();
    });
  }

  const btnPreset7 = $('btnPreset7');
  if (btnPreset7) {
    btnPreset7.addEventListener('click', () => {
      const start = startOfDay(new Date());
      const end = addDays(start, 7);
      const from = toDateInputValue(start);
      const to = toDateInputValue(end);
      state.filters.dateFrom = from;
      state.filters.dateTo = to;
      $('filterDateFrom').value = from;
      $('filterDateTo').value = to;
      refresh();
    });
  }

  const btnPreset30 = $('btnPreset30');
  if (btnPreset30) {
    btnPreset30.addEventListener('click', () => {
      const start = startOfDay(new Date());
      const end = addDays(start, 30);
      const from = toDateInputValue(start);
      const to = toDateInputValue(end);
      state.filters.dateFrom = from;
      state.filters.dateTo = to;
      $('filterDateFrom').value = from;
      $('filterDateTo').value = to;
      refresh();
    });
  }

  $('filterIncludeUnscheduled').addEventListener('change', (e) => {
    state.filters.includeUnscheduled = e.target.checked;
    refresh();
  });

  $('filterStarredOnly').addEventListener('change', (e) => {
    state.filters.starredOnly = e.target.checked;
    refresh();
  });

  const hideDoneEl = $('filterHideDone');
  if (hideDoneEl) {
    hideDoneEl.checked = state.filters.hideDone === true;
    hideDoneEl.addEventListener('change', (e) => {
      state.filters.hideDone = e.target.checked === true;
      refresh();
    });
  }

  const hideRecEl = $('filterHideRecurring');
  if (hideRecEl) {
    // UI is "Include recurring"; internal flag stays as hideRecurring
    hideRecEl.checked = state.filters.hideRecurring !== true;
    hideRecEl.addEventListener('change', (e) => {
      state.filters.hideRecurring = !(e.target.checked === true);
      refresh();
    });
  }

  // Calendar display (settings)
  const condEl = $('settingsCondenseEarly');
  if (condEl) {
    condEl.checked = state.calendarSettings.condenseEarlyHours === true;
    condEl.addEventListener('change', () => {
      state.calendarSettings.condenseEarlyHours = condEl.checked === true;
      saveUiPrefs(Object.assign({}, uiPrefs, { condenseEarlyHours: state.calendarSettings.condenseEarlyHours }));

      if (state.calendar) {
        const min = state.calendarSettings.condenseEarlyHours ? '08:00:00' : '00:00:00';
        state.calendar.setOption('slotMinTime', min);
        state.calendar.setOption('scrollTime', min);
        state.calendar.setOption('slotMaxTime', '24:00:00');
      }

      refreshEarlyStrip();
    });
  }

  $('btnClearFilters').addEventListener('click', () => {
    state.filters.text = '';
    state.filters.priceTier = 'all';
    state.filters.dateFrom = '';
    state.filters.dateTo = '';
    state.filters.timeFrom = '';
    state.filters.timeTo = '';
    state.filters.includeUnscheduled = true;
    state.filters.starredOnly = false;
    state.filters.hideDone = false;
    state.filters.hideRecurring = false;
    state.filters.types.clear();
    state.filters.neighborhoods.clear();
    state.filters.enabledLayers = new Set(LAYER_TOGGLE_ORDER);

    $('filterText').value = '';
    const priceEl = $('filterPriceTier');
    if (priceEl) priceEl.value = 'all';
    $('filterDateFrom').value = '';
    $('filterDateTo').value = '';
    const tf = $('filterTimeFrom');
    const tt = $('filterTimeTo');
    if (tf) tf.value = '';
    if (tt) tt.value = '';
    $('filterIncludeUnscheduled').checked = true;
    $('filterStarredOnly').checked = false;
    const hdEl = $('filterHideDone');
    if (hdEl) hdEl.checked = false;
    const hrEl = $('filterHideRecurring');
    if (hrEl) hrEl.checked = true;

    refresh();
  });

  // Data buttons
  $('btnEnrichNYC').addEventListener('click', () => {
    if (!requireEditMode()) return;
    autoFillNYCDetails();
  });

  $('btnGeoSearchNYC').addEventListener('click', () => {
    if (!requireEditMode()) return;
    lookupNeighborhoodFromAddress().catch((err) => {
      alert(err?.message || String(err));
    });
  });
  $('btnCopySeedJs').addEventListener('click', async () => {
  if (!requireEditMode()) return;
  const text = buildSeedJsText();
  await copySeedJsToClipboard(text);
});

$('btnDownloadSeedJs').addEventListener('click', () => {
  if (!requireEditMode()) return;
  const text = buildSeedJsText();
  downloadTextFile('seed.js', text, 'text/javascript;charset=utf-8');
});


  $('btnResetToSeed').addEventListener('click', () => {
    if (!requireEditMode()) return;
    const ok = confirm('Reset to seed? This will remove your local changes.');
    if (!ok) return;
    store = resetLocalToSeed();
    state.filters.enabledLayers = new Set(LAYER_TOGGLE_ORDER);
    state.selectedId = null;
    closeDetailsDrawer();
    persistAndMaybeSync();
    refresh();
  });

  $('btnOpenGitHubSync').addEventListener('click', () => {
    if (!requireEditMode()) return;
    try { $('settingsDialog').close(); } catch (_) {}
    openGitHubDialog();
  });

  // Edit dialog helpers
  const editLookupBtn = $('btnEditLookupNYC');
  if (editLookupBtn) {
    editLookupBtn.addEventListener('click', () => {
      lookupNYCInEditDialog().catch((err) => {
        alert(err?.message || String(err));
      });
    });
  }


  // Prevent accidental time changes via mouse wheel on time inputs
  const preventWheel = (el) => {
    if (!el) return;
    el.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });
  };
  preventWheel($('editStartTime'));
  preventWheel($('editEndTime'));
  preventWheel($('filterTimeFrom'));
  preventWheel($('filterTimeTo'));

  const starToggleBtn = $('editStarToggle');
  if (starToggleBtn) {
    starToggleBtn.addEventListener('click', () => {
      setEditStarValue(!getEditStarValue());
    });
  }

  // Edit dialog save
  $('editForm').addEventListener('submit', (e) => {
    e.preventDefault();

    const id = normalizeStr($('editId').value);
    const existing = id ? store.items.find(it => it.id === id) : null;

    try {
      const item = readEditForm(existing);
      if (!item.title) {
        alert('Title is required.');
        return;
      }
      upsertItem(normalizeItem(item));
      $('editDialog').close();
      setSelected(item.id);
      refresh();
    } catch (err) {
      alert(err?.message || String(err));
    }
  });

  // Import/Export dialog actions
  $('btnImportJson').addEventListener('click', async () => {
    if (!requireEditMode()) return;
    let text = normalizeStr($('importJsonText').value);

    const file = $('importJsonFile').files?.[0];
    if (!text && file) {
      text = String(await readFileAsText(file));
      $('importJsonText').value = text;
    }

    if (!text) {
      alert('Paste JSON or choose a .json file.');
      return;
    }

    try {
      importJson(text, { merge: $('importMerge').checked });
      $('ioDialog').close();
      refresh();
      alert('Imported JSON.');
    } catch (err) {
      alert(err?.message || String(err));
    }
  });

  $('btnImportIcs').addEventListener('click', async () => {
    if (!requireEditMode()) return;
    let text = normalizeStr($('importIcsText').value);

    const file = $('importIcsFile').files?.[0];
    if (!text && file) {
      text = String(await readFileAsText(file));
      $('importIcsText').value = text;
    }

    if (!text) {
      alert('Paste .ics content or choose an .ics file.');
      return;
    }

    const layer = normalizeStr($('importIcsLayer').value);

    try {
      const parsed = parseIcs(text, { defaultLayer: layer });
      importJson(parsed, { merge: true });
      $('ioDialog').close();
      refresh();
      alert(`Imported ${parsed.items.length} event(s) from .ics.`);
    } catch (err) {
      alert(err?.message || String(err));
    }
  });

  $('btnCopyJson').addEventListener('click', () => {
    const json = JSON.stringify(exportStoreJson(), null, 2);
    copyToClipboard(json);
  });

  $('btnDownloadJson').addEventListener('click', () => {
    downloadJson('activity-library.json', exportStoreJson());
  });

  // GitHub dialog actions
  $('btnSaveGistSettings').addEventListener('click', async () => {
    try {
      saveGistSettingsFromDialog();
      await initRemoteOnLoad();
      refresh();
      $('githubDialog').close();
      alert('Saved GitHub settings.');
    } catch (err) {
      alert(err?.message || String(err));
    }
  });

  $('btnDisconnectGist').addEventListener('click', () => {
    disconnectGist();
    $('githubDialog').close();
  });

  $('btnPullGist').addEventListener('click', async () => {
    try {
      await pullFromGist({ silent: false });
      refresh();
      updateStorageUi();
    } catch (err) {
      config.storage.lastError = err?.message || String(err);
      saveConfig(config);
      updateStorageUi();
      alert(err?.message || String(err));
    }
  });

  $('btnPushGist').addEventListener('click', async () => {
    try {
      await pushToGist({ silent: false });
      updateStorageUi();
    } catch (err) {
      config.storage.lastError = err?.message || String(err);
      saveConfig(config);
      updateStorageUi();
      alert(err?.message || String(err));
    }
  });

  $('btnCreateGist').addEventListener('click', async () => {
    try {
      const publicGist = $('ghCreatePublic').checked;
      const token = normalizeStr($('ghToken').value);
      const remember = $('ghRememberToken').checked;
      await createNewGist({ publicGist, token, remember });
      updateStorageUi();
    } catch (err) {
      alert(err?.message || String(err));
    }
  });

  // Calendar init (after we wire handlers)
  state.calendar = initCalendar();

  // Boot sequence: pull remote (if configured) then render
  (async () => {
    await initRemoteOnLoad();

    refresh();
    setView('calendar');

    storageReady = true;
    updateStorageUi();
  })();
});

function setView(view) {
  state.view = view;

  const calView = $('calendarView');
  const listView = $('listView');

  const btnCal = $('btnViewCalendar');
  const btnList = $('btnViewList');

  if (view === 'calendar') {
    show(calView);
    hide(listView);
    btnCal.classList.add('btn--primary');
    btnList.classList.remove('btn--primary');
    if (state.calendar) state.calendar.updateSize();
  } else {
    hide(calView);
    show(listView);
    btnList.classList.add('btn--primary');
    btnCal.classList.remove('btn--primary');
  }
}

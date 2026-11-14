// Minimal iCalendar (RFC 5545) reader for Moodle calendar exports.
import { isHttpUrl } from './validate.js';

function unfold(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseLine(line) {
  let colon = -1;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === ':' && !inQuote) { colon = i; break; }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

// Offset of `timeZone` from UTC at the given instant, in ms.
function tzOffset(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(utcMs))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

export function parseIcsDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => (x === undefined ? undefined : Number(x)));
  // An all-day deadline is due at the end of that day.
  if (h === undefined) return new Date(y, mo - 1, d, 23, 59, 0).getTime();
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (m[7]) return wall;
  if (params.TZID) {
    try {
      const guess = wall - tzOffset(wall, params.TZID);
      return wall - tzOffset(guess, params.TZID);
    } catch {
      // Unknown zone name (e.g. a Windows one): treat as local time below.
    }
  }
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function toDeadline(props) {
  if (!props.DTSTART) return null;
  const dueAt = parseIcsDate(props.DTSTART.value, props.DTSTART.params);
  if (dueAt === null) return null;
  const text = (name) => (props[name] ? unescapeText(props[name].value) : '');
  const title = text('SUMMARY').trim() || 'Untitled';
  const description = text('DESCRIPTION');
  const course = props.CATEGORIES
    ? unescapeText(props.CATEGORIES.value.split(/(?<!\\),/)[0]).trim()
    : '';
  let url = props.URL ? props.URL.value.trim() : '';
  if (!isHttpUrl(url)) url = (description.match(/https?:\/\/[^\s<>"]+/) || [''])[0];
  const uid = props.UID ? props.UID.value.trim() : `${title}@${dueAt}`;
  return { uid, title, course, url, dueAt, description };
}

export function parseIcs(text) {
  const events = [];
  let current = null;
  for (const raw of unfold(String(text)).split('\n')) {
    const line = raw.trimEnd();
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') current = {};
    else if (upper === 'END:VEVENT') {
      const event = current && toDeadline(current);
      if (event) events.push(event);
      current = null;
    } else if (current && line) {
      const prop = parseLine(line);
      if (prop && !(prop.name in current)) current[prop.name] = prop;
    }
  }
  return events;
}

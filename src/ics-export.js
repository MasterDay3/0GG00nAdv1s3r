// The board as an iCalendar feed (RFC 5545) that Google, Apple or Outlook calendars subscribe to.

// Text values escape backslash, semicolon, comma and line breaks.
export function escapeText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 bytes continue on the next line after a space; a UTF-8 character is never split.
export function foldLine(line) {
  const parts = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    const limit = parts.length ? 74 : 75; // continuation lines start with a space
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// items: board items ({ key, source, course, title, url, dueAt, note }). host only names the UIDs, so it never changes.
export function buildCalendar(items, now, host = 'dueboard') {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dueboard//Deadlines//UK',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Dueboard',
    'X-WR-TIMEZONE:Europe/Kyiv',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const item of items) {
    const title = item.source === 'exam' ? `Екзамен: ${item.title}` : item.title;
    const summary = item.course ? `[${item.course}] ${title}` : title;
    const description = [item.note, item.url].filter(Boolean).join('\n\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.key}@${host}`,
      `DTSTAMP:${stamp(now)}`,
      // A deadline is a moment, so the event starts and ends at it.
      `DTSTART:${stamp(item.dueAt)}`,
      `DTEND:${stamp(item.dueAt)}`,
      `SUMMARY:${escapeText(summary)}`,
      description ? `DESCRIPTION:${escapeText(description)}` : null,
      /^https?:\/\//i.test(item.url || '') ? `URL:${item.url}` : null,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.filter(Boolean).map(foldLine).join('\r\n')}\r\n`;
}

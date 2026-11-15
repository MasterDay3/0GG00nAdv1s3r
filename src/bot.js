// Telegram bot texts. Times are always shown in Kyiv time, whatever the server's own time zone is.
import { urgency, DAY } from './urgency.js';

export const TIME_ZONE = 'Europe/Kyiv';
export const DIGEST_HOUR = 8;
// The digest goes out once a day, between DIGEST_HOUR and DIGEST_HOUR + DIGEST_WINDOW (e.g. after a restart).
export const DIGEST_WINDOW = 4;
const LIST_LIMIT = 15;
const ICON = { overdue: '⚫', red: '🔴', amber: '🟡', grey: '⚪' };

export const COMMANDS = [
  { command: 'deadlines', description: 'Your upcoming deadlines' },
  { command: 'digest', description: 'Turn the morning digest on or off' },
  { command: 'help', description: 'What this bot can do' },
  { command: 'stop', description: 'Unlink this chat from Dueboard' },
];

export const NOT_LINKED = 'This chat is not linked to Dueboard yet. Open Dueboard → Settings → "Connect Telegram".';

export function formatDue(ms, timeZone = TIME_ZONE) {
  return new Date(ms).toLocaleString('en-GB', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// { date: 'YYYY-MM-DD', hour: 0–23 } in the given time zone.
export function localParts(ms, timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function itemLine(item, now) {
  const course = item.course ? `[${clip(item.course, 60)}] ` : '';
  const kind = item.source === 'exam' ? ' (exam)' : '';
  const link = item.url ? `\n   ${item.url}` : '';
  return `${ICON[urgency(item.dueAt, now)]} ${course}${clip(item.title, 200)}${kind}\n   ${formatDue(item.dueAt)}${link}`;
}

function list(items, now) {
  const shown = items.slice(0, LIST_LIMIT).map((item) => itemLine(item, now));
  if (items.length > LIST_LIMIT) shown.push(`…and ${items.length - LIST_LIMIT} more on the website.`);
  return shown.join('\n');
}

export function deadlinesText(items, now) {
  const upcoming = items.filter((item) => item.dueAt > now);
  if (!upcoming.length) return 'Nothing due. Enjoy the free time! 🎉';
  return `Upcoming deadlines:\n\n${list(upcoming, now)}`;
}

// Deadlines in the next 7 days, or null when there are none (then no digest is sent).
export function digestText(items, now) {
  const week = items.filter((item) => item.dueAt > now && item.dueAt <= now + 7 * DAY);
  if (!week.length) return null;
  return `☀️ Good morning! Due in the next 7 days:\n\n${list(week, now)}`;
}

export function groupDeadlineText(author, item, now) {
  return `📌 ${author} added a deadline for your group:\n\n${itemLine(item, now)}`;
}

export function linkedText(username) {
  return `Linked to Dueboard as ${username}. You'll get reminders 3 days and 1 day before each deadline `
    + `and a short digest at ${DIGEST_HOUR}:00 when something is due that week.\n\n${commandList()}`;
}

export function helpText(linked) {
  if (!linked) return `Hi! I'm the Dueboard bot. ${NOT_LINKED}`;
  return `I remind you about deadlines 3 days and 1 day ahead and send a digest at ${DIGEST_HOUR}:00 `
    + `when something is due that week.\n\n${commandList()}`;
}

function commandList() {
  return COMMANDS.map((c) => `/${c.command} - ${c.description}`).join('\n');
}

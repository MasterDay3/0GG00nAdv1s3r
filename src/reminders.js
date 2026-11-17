import { DAY, HOUR } from './urgency.js';
import { formatDue } from './bot.js';

// Reminder kinds, from the latest to the earliest; each fires once when that much time (or less) is left.
export const REMINDER_WINDOWS = { '3h': 3 * HOUR, '1d': DAY, '3d': 3 * DAY };
export const DEFAULT_REMINDERS = ['3d', '1d'];

// The kinds a user picked, stored as "3d,1d"; unknown parts are dropped.
export function parseReminders(value) {
  if (value == null) return [...DEFAULT_REMINDERS];
  return String(value).split(',').filter((kind) => kind in REMINDER_WINDOWS);
}

// items: [{ key, dueAt }]; sent: Set of "key:kind"; kinds: the reminders the user wants.
// Returns reminders still owed: only the tightest window the deadline is in, so a late signup gets one message, not three.
export function dueReminders(items, sent, now, kinds = DEFAULT_REMINDERS) {
  const wanted = Object.keys(REMINDER_WINDOWS).filter((kind) => kinds.includes(kind)); // tightest first
  const due = [];
  for (const item of items) {
    const left = item.dueAt - now;
    if (left <= 0) continue;
    const kind = wanted.find((k) => left <= REMINDER_WINDOWS[k]);
    if (kind && !sent.has(`${item.key}:${kind}`)) due.push({ item, kind });
  }
  return due;
}

// Kinds made pointless by sending this one (the earlier, wider reminders).
export function supersededBy(kind) {
  return Object.keys(REMINDER_WINDOWS).filter((k) => REMINDER_WINDOWS[k] > REMINDER_WINDOWS[kind]);
}

const WHEN = { '3h': 'менш ніж за 3 години', '1d': 'менш ніж за добу', '3d': 'через 3 дні' };

export function reminderText(item, kind) {
  const course = item.course ? `[${item.course}] ` : '';
  const due = formatDue(item.dueAt);
  return `⏰ ${course}${item.title}: термін ${WHEN[kind]} (${due}).${item.url ? `\n${item.url}` : ''}`;
}

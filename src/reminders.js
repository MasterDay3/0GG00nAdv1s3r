import { DAY } from './urgency.js';
import { formatDue } from './bot.js';

// items: [{ key, dueAt }]; sent: Set of "key:kind". Returns reminders still owed.
export function dueReminders(items, sent, now) {
  const due = [];
  for (const item of items) {
    const left = item.dueAt - now;
    if (left <= 0) continue;
    const kind = left <= DAY ? '1d' : left <= 3 * DAY ? '3d' : null;
    if (kind && !sent.has(`${item.key}:${kind}`)) due.push({ item, kind });
  }
  return due;
}

export function reminderText(item, kind) {
  const when = kind === '1d' ? 'менш ніж за добу' : 'через 3 дні';
  const course = item.course ? `[${item.course}] ` : '';
  const due = formatDue(item.dueAt);
  return `⏰ ${course}${item.title}: термін ${when} (${due}).${item.url ? `\n${item.url}` : ''}`;
}

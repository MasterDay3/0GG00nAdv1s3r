import { DAY } from './urgency.js';

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
  const when = kind === '1d' ? 'in less than 1 day' : 'in 3 days';
  const course = item.course ? `[${item.course}] ` : '';
  const due = new Date(item.dueAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `⏰ ${course}${item.title} is due ${when} (${due}).${item.url ? `\n${item.url}` : ''}`;
}

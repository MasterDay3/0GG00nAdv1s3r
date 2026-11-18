// Time units, and how urgent a deadline is: red under 48 h, amber under 7 days, grey later.
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export function urgency(dueAt, now) {
  const left = dueAt - now;
  if (left < 0) return 'overdue';
  if (left < 48 * HOUR) return 'red';
  if (left < 7 * DAY) return 'amber';
  return 'grey';
}

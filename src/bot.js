// Telegram bot texts. Times are always shown in Kyiv time, whatever the server's own time zone is.
import { urgency, DAY } from './urgency.js';

export const TIME_ZONE = 'Europe/Kyiv';
export const DIGEST_HOUR = 8;
// The digest goes out once a day, between DIGEST_HOUR and DIGEST_HOUR + DIGEST_WINDOW (e.g. after a restart).
export const DIGEST_WINDOW = 4;
const LIST_LIMIT = 15;
const ICON = { overdue: '⚫', red: '🔴', amber: '🟡', grey: '⚪' };

export const COMMANDS = [
  { command: 'deadlines', description: 'Найближчі дедлайни' },
  { command: 'digest', description: 'Увімкнути чи вимкнути ранковий дайджест' },
  { command: 'help', description: 'Що вміє цей бот' },
  { command: 'stop', description: 'Відв’язати цей чат від Dueboard' },
];

export const NOT_LINKED = 'Цей чат ще не прив’язаний до Dueboard. Відкрийте Dueboard → Налаштування → «Під’єднати Telegram».';

export function formatDue(ms, timeZone = TIME_ZONE) {
  return new Date(ms).toLocaleString('uk-UA', {
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
  const kind = item.source === 'exam' ? ' (екзамен)' : '';
  const link = item.url ? `\n   ${item.url}` : '';
  return `${ICON[urgency(item.dueAt, now)]} ${course}${clip(item.title, 200)}${kind}\n   ${formatDue(item.dueAt)}${link}`;
}

function list(items, now) {
  const shown = items.slice(0, LIST_LIMIT).map((item) => itemLine(item, now));
  if (items.length > LIST_LIMIT) shown.push(`…і ще ${items.length - LIST_LIMIT} на сайті.`);
  return shown.join('\n');
}

export function deadlinesText(items, now) {
  const upcoming = items.filter((item) => item.dueAt > now);
  if (!upcoming.length) return 'Нічого не горить. Насолоджуйтеся вільним часом! 🎉';
  return `Найближчі дедлайни:\n\n${list(upcoming, now)}`;
}

// Deadlines in the next 7 days, or null when there are none (then no digest is sent).
export function digestText(items, now) {
  const week = items.filter((item) => item.dueAt > now && item.dueAt <= now + 7 * DAY);
  if (!week.length) return null;
  return `☀️ Доброго ранку! Дедлайни на найближчі 7 днів:\n\n${list(week, now)}`;
}

export function groupDeadlineText(author, item, now) {
  return `📌 ${author} додає дедлайн для вашої групи:\n\n${itemLine(item, now)}`;
}

export function linkedText(username) {
  return `Чат прив’язано до Dueboard як ${username}. Нагадування приходитимуть за 3 дні й за 1 день до кожного дедлайну, `
    + `а о ${DIGEST_HOUR}:00 — короткий дайджест, коли цього тижня щось треба здати.\n\n${commandList()}`;
}

export function helpText(linked) {
  if (!linked) return `Привіт! Я бот Dueboard. ${NOT_LINKED}`;
  return `Я нагадую про дедлайни за 3 дні й за 1 день і надсилаю дайджест о ${DIGEST_HOUR}:00, `
    + `коли цього тижня щось треба здати.\n\n${commandList()}`;
}

function commandList() {
  return COMMANDS.map((c) => `/${c.command} - ${c.description}`).join('\n');
}

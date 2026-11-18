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

const FOCUS = { practice: 'тренуйте слабкі теми', refresh: 'повторіть', review: 'загальне повторення всіх тем' };

// study: today's step of each exam plan, [{ exam, examAt, focus, topics }].
export function studyLines(study) {
  return study.map((s) => {
    const topics = s.focus === 'review' || !s.topics.length ? '' : `: ${s.topics.join(', ')}`;
    return `📚 ${s.exam} (${formatDue(s.examAt)}) — сьогодні ${FOCUS[s.focus]}${topics}`;
  }).join('\n');
}

// Deadlines in the next 7 days and today's exam prep, or null when there is neither (then no digest is sent).
export function digestText(items, now, study = []) {
  const week = items.filter((item) => item.dueAt > now && item.dueAt <= now + 7 * DAY);
  if (!week.length && !study.length) return null;
  const parts = ['☀️ Доброго ранку!'];
  if (week.length) parts.push(`Дедлайни на найближчі 7 днів:\n\n${list(week, now)}`);
  if (study.length) parts.push(`План підготовки на сьогодні:\n${studyLines(study)}`);
  return parts.join('\n\n');
}

export function groupDeadlineText(author, item, now) {
  return `📌 ${author} додає дедлайн для вашої групи:\n\n${itemLine(item, now)}`;
}

// The reminders a user picked, earliest first, as words: "за 3 дні, за 1 день і за 3 години".
const REMINDER_WORDS = { '3d': 'за 3 дні', '1d': 'за 1 день', '3h': 'за 3 години' };
export function remindersPhrase(kinds) {
  const words = ['3d', '1d', '3h'].filter((k) => kinds.includes(k)).map((k) => REMINDER_WORDS[k]);
  if (!words.length) return null;
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} і ${words.at(-1)}`;
}

// What the bot sends about deadlines, in the user's own settings (reminders can be changed or turned off on the site).
function remindersSentence(kinds) {
  const phrase = remindersPhrase(kinds);
  return phrase
    ? `Нагадування приходять ${phrase} до кожного дедлайну.`
    : 'Нагадування про дедлайни вимкнені (увімкнути можна в Dueboard → Налаштування).';
}

const DIGEST_SENTENCE = `О ${DIGEST_HOUR}:00 — короткий дайджест, коли цього тижня є дедлайни або план підготовки до екзамену.`;

export function linkedText(username, kinds) {
  return `Чат прив’язано до Dueboard як ${username}. ${remindersSentence(kinds)} ${DIGEST_SENTENCE}\n\n${commandList()}`;
}

export function helpText(linked, kinds = []) {
  if (!linked) return `Привіт! Я бот Dueboard. ${NOT_LINKED}`;
  return `${remindersSentence(kinds)} ${DIGEST_SENTENCE}\n\n${commandList()}`;
}

export function digestOffText(kinds) {
  const phrase = remindersPhrase(kinds);
  return `Ранковий дайджест вимкнено.${phrase ? ` Нагадування ${phrase} до дедлайну й далі приходитимуть.` : ''} Надішліть /digest, щоб увімкнути його знову.`;
}

function commandList() {
  return COMMANDS.map((c) => `/${c.command} - ${c.description}`).join('\n');
}

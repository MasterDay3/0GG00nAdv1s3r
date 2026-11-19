// Reads a deadline from a message without AI, for when the AI is down, over its daily limit or not set up.
// It understands the usual ways a deadline is written in a course chat: "до 25.11 18:00", "1 грудня о 9:00",
// "завтра 8:00", "до п'ятниці", "через 3 дні". It finds at most one deadline; the student checks it before adding.
import { localParts } from './texts.js';

const L = '\\p{L}';
// Word boundaries that also work for Cyrillic letters.
const word = (body) => new RegExp(`(?<![${L}])(?:${body})(?![${L}])`, 'iu');

const MONTHS = [
  ['січня', 1], ['лютого', 2], ['березня', 3], ['квітня', 4], ['травня', 5], ['червня', 6],
  ['липня', 7], ['серпня', 8], ['вересня', 9], ['жовтня', 10], ['листопада', 11], ['грудня', 12],
];
const MONTH_RE = new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTHS.map(([m]) => m).join('|')})(?:\\s+(\\d{4}))?(?![${L}])`, 'iu');
const WEEKDAYS = [
  [word('понеділ(?:ок|ка)|пн'), 1], [word('вівтор(?:ок|ка)|вт'), 2], [word('серед(?:а|и|у)|ср'), 3],
  [word('четвер(?:га)?|чт'), 4], [word('п[\'’ʼ`]?ятниц(?:я|і|ю)|пт'), 5], [word('субот(?:а|и|у)|сб'), 6], [word('неділ(?:я|і|ю)|нд'), 0],
];
const RELATIVE = [[word('післязавтра'), 2], [word('завтра'), 1], [word('сьогодні'), 0]];
const IN_DAYS = word('через\\s+(\\d{1,2})\\s+(?:дн(?:і|ів|я)|день)');
const IN_WEEK = word('через\\s+тиждень');
const NUMERIC_DATE = /(?<![\d:])(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?![\d:])/g;
const TIME = /(?<![\d.])([01]?\d|2[0-3]):([0-5]\d)(?![\d])/;
const DOT_TIME = new RegExp(`(?<![${L}])(?:о|об)\\s+([01]?\\d|2[0-3])\\.([0-5]\\d)(?!\\d)`, 'iu');
// "18.00" on its own, once the date is taken out of the text (a date like 10.12 is read as a date first).
const BARE_DOT_TIME = /(?<![\d.])([01]?\d|2[0-3])\.([0-5]\d)(?![\d.])/;
const HOUR_ONLY = new RegExp(`(?<![${L}])(?:о|об)\\s+([01]?\\d|2[0-3])(?:\\s*(?:год(?:ині|ина)?\\.?))?(?![\\d:.])`, 'iu');
const URL = /https?:\/\/\S+/i;

const pad = (n) => String(n).padStart(2, '0');
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const realDate = (y, m, d) => {
  const ms = Date.UTC(y, m - 1, d);
  const t = new Date(ms);
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? ms : null;
};

// A day and month without a year: the next such date from today. A date a little in the past stays this year's
// (an old forwarded message: the bot then says it has passed); one months behind is next year's (5.01 in November).
function nextDate(today, month, day, year) {
  if (year) return realDate(year < 100 ? 2000 + year : year, month, day);
  const y = new Date(today).getUTCFullYear();
  const thisYear = realDate(y, month, day);
  if (thisYear !== null && thisYear >= today - 60 * 864e5) return thisYear;
  return realDate(y + 1, month, day);
}

// text: the message; sentAt: when it was sent (ms). Returns [] or [{ title, course, url, date, time }], like the AI.
export function parseDeadlineSimply(text, sentAt) {
  let rest = String(text || '').slice(0, 4000);
  const [ty, tm, td] = localParts(sentAt).date.split('-').map(Number);
  const today = Date.UTC(ty, tm - 1, td);
  const DAY = 864e5;
  // Takes a found piece out of the text; returns the line it was on (the title is taken from the date's line).
  const cut = (match) => {
    const at = typeof match === 'string' ? rest.indexOf(match) : rest.search(match);
    rest = rest.replace(match, ' ');
    return at < 0 ? 0 : rest.slice(0, at).split('\n').length - 1;
  };
  let dateLine = 0;

  const url = URL.exec(rest)?.[0].replace(/[).,;!?»"]+$/, '') || '';
  if (url) cut(URL);

  let time = '';
  let m = TIME.exec(rest) || DOT_TIME.exec(rest);
  if (m) { time = `${pad(m[1])}:${m[2]}`; cut(m[0]); }

  let day = null;
  for (const n of rest.matchAll(NUMERIC_DATE)) {
    const found = nextDate(today, Number(n[2]), Number(n[1]), n[3] && Number(n[3]));
    if (found !== null) { day = found; dateLine = cut(n[0]); break; }
  }
  if (day === null && (m = MONTH_RE.exec(rest))) {
    const month = MONTHS.find(([name]) => name === m[2].toLowerCase())[1];
    day = nextDate(today, month, Number(m[1]), m[3] && Number(m[3]));
    if (day !== null) dateLine = cut(m[0]);
  }
  if (day === null && (m = IN_DAYS.exec(rest))) { day = today + Number(m[1]) * DAY; dateLine = cut(m[0]); }
  if (day === null && (m = IN_WEEK.exec(rest))) { day = today + 7 * DAY; dateLine = cut(m[0]); }
  if (day === null) {
    for (const [re, offset] of RELATIVE) if ((m = re.exec(rest))) { day = today + offset * DAY; dateLine = cut(m[0]); break; }
  }
  if (day === null) {
    for (const [re, weekday] of WEEKDAYS) {
      if ((m = re.exec(rest))) {
        // "до п'ятниці" written on a Friday means next Friday.
        const ahead = (weekday - new Date(today).getUTCDay() + 7) % 7 || 7;
        day = today + ahead * DAY;
        dateLine = cut(m[0]);
        break;
      }
    }
  }
  if (day === null) return [];
  if (!time && (m = BARE_DOT_TIME.exec(rest))) { time = `${pad(m[1])}:${m[2]}`; cut(m[0]); }
  if (!time && (m = HOUR_ONLY.exec(rest))) { time = `${pad(m[1])}:00`; cut(m[0]); }

  // The title: what is left of the date's line (or else the first line with words), without the little words around it.
  const clean = (line) => line
    .replace(new RegExp(`(?<![${L}])(?:до|о|об|на|у|в|за|термін|дедлайн|deadline|здати|здача)(?![${L}])`, 'giu'), (w, offset, all) => (
      // Keep the words inside the title ("здати лабу" stays), drop them only at its ends.
      all.slice(0, offset).trim() && all.slice(offset + w.length).trim() ? w : ' '))
    .replace(/[\s:,.;!—–-]+$/u, '').replace(/^[\s:,.;!—–-]+/u, '').replace(/\s+/g, ' ').trim();
  const lines = rest.split('\n');
  const title = [lines[dateLine] || '', ...lines].map(clean).find((t) => /\p{L}/u.test(t))?.slice(0, 120) || 'Дедлайн';
  return [{ title: title[0].toUpperCase() + title.slice(1), course: '', url, date: iso(day), time }];
}

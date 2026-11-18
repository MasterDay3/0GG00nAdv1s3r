// Limits and fixed values shared across the server.
import { DAY } from './lib/urgency.js';

export const MAX_JSON = 64 * 1024;
export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_UPLOAD_BODY = Math.ceil(MAX_FILE * 4 / 3) + 4096;
export const MAX_FEED = 5 * 1024 * 1024;
export const MAX_BIG_BODIES = 4;
export const SESSION_TTL = 30 * DAY;
// Dueboard Prep: the whole exam prep section, 149 грн for 30 days. Payments are a demo with test cards only.
export const PREMIUM = { price: 149, days: 30 };
export const PAID_API = /^\/api\/(exams|topics|questions|problems|materials)(\/|$)/;
// The bank's answer for each test card. Real card numbers never reach the server: the page sends only which test card it was.
export const TEST_CARDS = {
  success: { last4: '4242', ok: true },
  declined: { last4: '0002', ok: false, reason: 'Банк відхилив оплату. Спробуйте іншу картку.' },
  funds: { last4: '9995', ok: false, reason: 'Недостатньо коштів на картці.' },
};
export const AI_RUNS_PER_DAY = 10;
export const AI_EXPLAINS_PER_DAY = 100;
export const AI_PARSES_PER_DAY = 50;
export const RESET_TTL = 15 * 60 * 1000;
export const RESET_TRIES = 5;
export const RESET_FAILS_PER_DAY = 10;
export const MINUTE = 60 * 1000;
export const BOT_WALL_MESSAGE = 'Ваш Moodle захищений перевіркою на бота, тож автоматична синхронізація не працює. '
  + 'У Moodle натисніть Експорт календаря → «Експортувати», завантажте файл .ics і імпортуйте його нижче.';

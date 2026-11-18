// Linking the Telegram bot and choosing reminders.
import { randomBytes } from 'node:crypto';
import { parseReminders, REMINDER_WINDOWS } from '../bot/reminders.js';
import { HttpError } from '../lib/validate.js';

export function telegramRoutes(ctx) {
  const { telegram, route, one, run } = ctx;

  route('POST', '/api/telegram/link', async ({ user }) => {
    if (!telegram.enabled) throw new HttpError(409, 'Telegram на цьому сервері не налаштований (TELEGRAM_BOT_TOKEN)');
    const code = randomBytes(6).toString('hex');
    run('UPDATE users SET tg_link_code = ? WHERE id = ?', code, user.id);
    return { code, botName: await telegram.botName() };
  });

  route('PUT', '/api/telegram/reminders', ({ user, body }) => {
    const kinds = body.kinds;
    if (!Array.isArray(kinds) || kinds.some((k) => !(k in REMINDER_WINDOWS))) throw new HttpError(400, 'Невідомий час нагадування');
    run('UPDATE users SET tg_remind = ? WHERE id = ?', [...new Set(kinds)].join(','), user.id);
    return { reminders: parseReminders(one('SELECT tg_remind FROM users WHERE id = ?', user.id).tg_remind) };
  });

  route('DELETE', '/api/telegram', ({ user }) => {
    run('UPDATE users SET tg_chat_id = NULL, tg_link_code = NULL WHERE id = ?', user.id);
    return { ok: true };
  });
}

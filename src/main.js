import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createTelegram } from './telegram.js';
import { COMMANDS } from './bot.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || 'data/dueboard.db';
const MINUTE = 60_000;

if (DB_PATH !== ':memory:') mkdirSync(DB_PATH.replace(/[^/]*$/, '') || '.', { recursive: true });

const telegram = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN });
const app = createApp({ db: openDb(DB_PATH), telegram, secureCookies: process.env.COOKIE_SECURE === '1' });

createServer(app.handler).listen(PORT, HOST, () => {
  console.log(`Dueboard running at http://${HOST}:${PORT}`);
  console.log(telegram.enabled ? 'Telegram bot: on' : 'Telegram bot: off (set TELEGRAM_BOT_TOKEN to enable reminders)');
});

const safely = (job) => () => job().catch((err) => console.error(err));
setInterval(safely(app.runReminders), MINUTE);
setInterval(safely(app.runDigests), MINUTE);
setInterval(safely(app.syncAll), 6 * 60 * MINUTE);

async function pollTelegram() {
  let offset = 0;
  for (;;) {
    try {
      for (const update of await telegram.getUpdates(offset)) {
        offset = update.update_id + 1;
        await app.handleTelegramUpdate(update);
      }
    } catch (err) {
      console.error('Telegram polling failed:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
if (telegram.enabled) {
  telegram.setCommands(COMMANDS).catch((err) => console.error('Telegram setMyCommands failed:', err.message));
  pollTelegram();
}

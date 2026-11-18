import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { COMMANDS } from '../src/bot/texts.js';

const TEAM = '-100555';

async function start(options = {}) {
  const sent = [];
  const telegram = {
    enabled: true,
    botName: async () => 'dueboard_test_bot',
    send: async (chatId, text) => { sent.push({ chatId: String(chatId), text }); },
  };
  const app = createApp({ db: openDb(':memory:'), now: () => Date.UTC(2026, 10, 18, 12), telegram, ...options });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  const say = (chatId, text, type = 'private') => app.handleTelegramUpdate({ update_id: 1, message: { chat: { id: chatId, type }, text, date: 1 } });
  return { sent, say, base, close };
}

test('support: /support goes to the team chat, and /reply from the team comes back to the student', async (t) => {
  const { sent, say, close } = await start({ teamChatId: TEAM });
  t.after(close);
  assert.ok(COMMANDS.some((c) => c.command === 'support'));

  await say(42, '/support Як видалити всі мої дані?');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chatId, TEAM);
  assert.match(sent[0].text, /чат без акаунта, чат 42/);
  assert.match(sent[0].text, /Як видалити всі мої дані\?/);
  assert.match(sent[0].text, /\/reply 42 /);
  assert.equal(sent[1].chatId, '42');
  assert.match(sent[1].text, /Надіслано команді Dueboard/);

  sent.length = 0;
  await say(TEAM, '/reply 42 Налаштування → Акаунт → Видалити акаунт.', 'supergroup');
  assert.deepEqual(sent.map((m) => m.chatId), ['42', TEAM]);
  assert.match(sent[0].text, /Відповідь команди Dueboard:\nНалаштування → Акаунт/);

  // Anything else in the team chat is ignored, and so is /reply in a student's chat.
  sent.length = 0;
  await say(TEAM, 'просто розмова', 'supergroup');
  await say(43, '/reply 42 підробка');
  assert.ok(!sent.some((m) => m.chatId === '42'));
});

test('support: empty question, rate limit, and a server without a team chat', async (t) => {
  const { sent, say, close } = await start({ teamChatId: TEAM });
  t.after(close);
  await say(42, '/support');
  assert.match(sent.at(-1).text, /Напишіть питання в тому ж повідомленні/);
  assert.equal(sent.filter((m) => m.chatId === TEAM).length, 0);

  for (let i = 0; i < 6; i++) await say(42, `/support питання ${i}`);
  assert.equal(sent.filter((m) => m.chatId === TEAM).length, 5);
  assert.match(sent.at(-1).text, /кілька питань за годину/);

  const off = await start();
  t.after(off.close);
  await off.say(42, '/support привіт');
  assert.deepEqual(off.sent.map((m) => m.chatId), ['42']);
  assert.match(off.sent[0].text, /поки не налаштована/);
});

test('privacy: the page learns the AI service, the bot and whether /support is set up, without logging in', async (t) => {
  const on = await start({ teamChatId: TEAM });
  t.after(on.close);
  const info = await (await fetch(`${on.base}/api/privacy-info`)).json();
  assert.deepEqual(info, { bot: 'dueboard_test_bot', ai: null, support: true, storageMb: 100 });

  const off = await start();
  t.after(off.close);
  assert.equal((await (await fetch(`${off.base}/api/privacy-info`)).json()).support, false);
});

test('support: /chatid in a group tells its id for TEAM_CHAT_ID; a private chat does not get it', async (t) => {
  const { sent, say, close } = await start();
  t.after(close);
  await say(-100777, '/chatid', 'group');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /ID цього чату: -100777/);
  assert.match(sent[0].text, /TEAM_CHAT_ID=-100777/);
  await say(-100777, 'просто повідомлення', 'group');
  assert.equal(sent.length, 1, 'other group messages are still ignored');
});

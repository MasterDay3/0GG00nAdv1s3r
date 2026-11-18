// What the Telegram bot does with messages and buttons, and messages it sends on its own.
import { parseReminders } from './reminders.js';
import { NOT_LINKED, DIGEST_HOUR, deadlinesText, groupDeadlineText, linkedText, helpText, digestOffText, kyivToMs, draftText, FORWARD_HINT } from './texts.js';
import { AI_PARSES_PER_DAY, MINUTE } from '../constants.js';
import { createLimiter } from '../lib/limiter.js';
import { DAY } from '../lib/urgency.js';
import { HttpError, text } from '../lib/validate.js';

export function createBotHandlers(ctx) {
  const { now, telegram, ai, teamChatId, one, all, run } = ctx;

  // Sends to a linked chat; a chat that blocked the bot (403) is unlinked so we stop writing to it.
  async function sendTo(user, message, options) {
    try {
      await telegram.send(user.tg_chat_id, message, options);
      return true;
    } catch (err) {
      if (err.code === 403) run('UPDATE users SET tg_chat_id = NULL WHERE id = ?', user.id);
      console.error(`Telegram message to ${user.username} failed:`, err.message);
      return false;
    }
  }

  async function notifyGroup(author, item) {
    if (!telegram.enabled) return;
    const members = all(
      'SELECT * FROM users WHERE group_id = ? AND id != ? AND tg_chat_id IS NOT NULL', author.group_id, author.id,
    );
    const message = groupDeadlineText(author.username, item, now());
    for (const member of members) await sendTo(member, message);
  }

  // The "✅ Done" button under a reminder.
  // "Add for me" / "Add for my group" / "Cancel" under a deadline the bot found in a message.
  async function handleDraftButton(query, user, chatId, draftId, action) {
    const draft = user && one('SELECT * FROM tg_drafts WHERE id = ? AND user_id = ?', draftId, user.id);
    if (!user) return telegram.answerButton(query.id, 'Цей чат більше не прив’язаний до Dueboard.');
    if (!draft) return telegram.answerButton(query.id, 'Цей дедлайн уже оброблено.');
    if (action === 'group' && !user.group_id) return telegram.answerButton(query.id, 'Ви вже не в групі. Додайте дедлайн собі.');
    // Delete first: a double tap must not add the deadline twice.
    if (!run('DELETE FROM tg_drafts WHERE id = ?', draft.id).changes) return telegram.answerButton(query.id, 'Цей дедлайн уже оброблено.');
    let note = '✖️ Скасовано';
    if (action !== 'no') {
      ctx.addDeadline(user, { title: draft.title, course: draft.course, url: draft.url, dueAt: draft.due_at }, action === 'group');
      note = action === 'group' ? '👥 Додано для всієї групи' : '✅ Додано на вашу дошку';
    }
    await telegram.answerButton(query.id, note);
    await telegram.editMessage(String(chatId), query.message.message_id, `${query.message.text}\n\n${note}`)
      .catch((err) => console.error('Telegram edit failed:', err.message));
  }

  async function handleTelegramButton(query) {
    const chatId = query.message?.chat?.id;
    const user = chatId != null && one('SELECT * FROM users WHERE tg_chat_id = ?', String(chatId));
    const draft = /^draft:(\d+):(me|group|no)$/.exec(query.data || '');
    if (draft) return handleDraftButton(query, user, chatId, Number(draft[1]), draft[2]);
    const key = /^done:(d\d+)$/.exec(query.data || '')?.[1];
    let answer = 'Цього дедлайну вже немає на вашій дошці.';
    if (!user) answer = 'Цей чат більше не прив’язаний до Dueboard.';
    else if (key) {
      try {
        ctx.markDone(user, key, true);
        answer = 'Позначено як виконане ✅';
        await telegram.editMessage(String(chatId), query.message.message_id, `${query.message.text}\n\n✅ Виконано`);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error('Telegram done button failed:', err.message);
      }
    }
    await telegram.answerButton(query.id, answer);
  }

  const supportLimit = createLimiter({ limit: 5, windowMs: 60 * MINUTE, now });

  // A question for the people behind Dueboard: it goes to the team's chat, the answer comes back to this chat.
  async function handleSupport(user, chatId, question, reply) {
    if (!teamChatId) return reply('Підтримка через бота поки не налаштована на цьому сервері.');
    if (!question) return reply('Напишіть питання в тому ж повідомленні, наприклад:\n/support Як видалити всі мої дані?');
    if (supportLimit.blockedFor(chatId)) return reply('Ви вже надіслали кілька питань за годину. Зачекайте на відповідь, будь ласка.');
    supportLimit.hit(chatId);
    const who = user ? `акаунт ${user.username}` : 'чат без акаунта';
    await telegram.send(teamChatId, `📩 Питання (${who}, чат ${chatId}):\n${question.slice(0, 3000)}\n\nВідповісти: /reply ${chatId} ваш текст`);
    return reply('Надіслано команді Dueboard. Відповідь прийде сюди, у цей чат.');
  }

  async function handleTeamReply(body) {
    const match = /^\/reply(?:@\w+)?\s+(-?\d+)\s+([\s\S]+)$/.exec(body.trim());
    if (!match) return telegram.send(teamChatId, 'Формат: /reply <id чату> текст відповіді');
    try {
      await telegram.send(match[1], `💬 Відповідь команди Dueboard:\n${match[2].trim().slice(0, 3000)}`);
    } catch (err) {
      return telegram.send(teamChatId, `Не вдалося надіслати в чат ${match[1]}: ${err.message}`);
    }
    return telegram.send(teamChatId, `Надіслано в чат ${match[1]}.`);
  }

  async function handleTelegramUpdate(update) {
    if (update.callback_query) return handleTelegramButton(update.callback_query);
    const message = update.message;
    // A forwarded photo or file carries its words in the caption.
    const body = typeof message?.text === 'string' ? message.text : message?.caption;
    if (!message?.chat || typeof body !== 'string') return;
    // The team's chat answers a /support message with "/reply <chat id> text".
    // Only /reply is read there, so a team chat that is someone's private chat with the bot still works as a normal chat.
    if (teamChatId && String(message.chat.id) === String(teamChatId) && /^\/reply(@\w+)?(\s|$)/i.test(body.trim())) return handleTeamReply(body);
    // Setting up /support: in a group, "/chatid" tells the id to put into TEAM_CHAT_ID.
    if (message.chat.type && message.chat.type !== 'private' && /^\/chatid(@\w+)?$/i.test(body.trim())) {
      return telegram.send(String(message.chat.id), `ID цього чату: ${message.chat.id}\nДодайте на сервері в /etc/dueboard.env рядок TEAM_CHAT_ID=${message.chat.id} і перезапустіть Dueboard.`);
    }
    // Deadlines are personal: only answer in a private chat with the bot, never in group chats.
    if (message.chat.type && message.chat.type !== 'private') return;
    const chatId = String(message.chat.id);
    const reply = (text) => telegram.send(chatId, text);
    const [word = '', arg = ''] = body.trim().split(/\s+/);
    const command = word.toLowerCase().replace(/@\w+$/, '');
    const user = one('SELECT * FROM users WHERE tg_chat_id = ?', chatId);

    if (command === '/start' && arg) {
      const target = /^[a-f0-9]{12}$/.test(arg) && one('SELECT * FROM users WHERE tg_link_code = ?', arg);
      if (!target) return reply('Посилання застаріло. Відкрийте Dueboard → Налаштування → «Під’єднати Telegram», щоб отримати нове.');
      // One chat follows one Dueboard account.
      run('UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id != ?', chatId, target.id);
      run('UPDATE users SET tg_chat_id = ?, tg_link_code = NULL WHERE id = ?', chatId, target.id);
      return reply(linkedText(target.username, parseReminders(target.tg_remind)));
    }
    if (command === '/deadlines') {
      return reply(user ? deadlinesText(ctx.openItems(user), now()) : NOT_LINKED);
    }
    if (command === '/digest') {
      if (!user) return reply(NOT_LINKED);
      const on = !user.tg_digest;
      run('UPDATE users SET tg_digest = ? WHERE id = ?', on ? 1 : 0, user.id);
      return reply(on
        ? `Ранковий дайджест увімкнено. Він приходитиме о ${DIGEST_HOUR}:00, коли цього тижня є дедлайни або план підготовки до екзамену.`
        : digestOffText(parseReminders(user.tg_remind)));
    }
    if (command === '/stop') {
      if (!user) return reply(NOT_LINKED);
      run('UPDATE users SET tg_chat_id = NULL WHERE id = ?', user.id);
      return reply('Чат відв’язано, повідомлень більше не буде. Під’єднатися знову можна в Dueboard → Налаштування.');
    }
    if (command === '/support') return handleSupport(user, chatId, body.trim().slice(word.length).trim(), reply);
    if (user && !command.startsWith('/')) return draftsFromMessage(user, chatId, message, body);
    return reply(helpText(Boolean(user), user ? parseReminders(user.tg_remind) : []));
  }

  // A message the student forwards (or types): the AI finds the deadlines in it, and each comes back with buttons.
  // Updates are handled in parallel; a student forwarding a pile of messages gets a few AI reads at a time, not all at once.
  const MAX_PARSES_AT_ONCE = 3;
  const parsing = new Map();

  async function draftsFromMessage(user, chatId, message, text) {
    const reply = (t, options) => telegram.send(chatId, t, options);
    if (!ai.enabled) return reply('Розпізнавати дедлайни з повідомлень зараз не вийде: AI на сервері не налаштований. Додайте дедлайн на сайті.');
    const busy = parsing.get(user.id) || 0;
    if (busy >= MAX_PARSES_AT_ONCE) return reply('Ще читаю попередні повідомлення. Перешліть це ще раз за хвилину.');
    parsing.set(user.id, busy + 1);
    try {
      return await readDrafts(user, chatId, message, text, reply);
    } finally {
      const left = (parsing.get(user.id) || 1) - 1;
      if (left > 0) parsing.set(user.id, left); else parsing.delete(user.id);
    }
  }

  async function readDrafts(user, chatId, message, text, reply) {
    const { used } = one('SELECT COUNT(*) AS used FROM ai_parses WHERE user_id = ? AND created_at > ?', user.id, now() - DAY);
    if (used >= AI_PARSES_PER_DAY) return reply(`Розібрати можна ${AI_PARSES_PER_DAY} повідомлень на день. Спробуйте завтра або додайте дедлайн на сайті.`);
    run('INSERT INTO ai_parses (user_id, created_at) VALUES (?, ?)', user.id, now());
    // Relative dates ("до п'ятниці") count from when the message was first sent, not when it was forwarded.
    const sentSeconds = message.forward_origin?.date ?? message.forward_date ?? message.date;
    const sentAt = Number.isFinite(sentSeconds) ? sentSeconds * 1000 : now();
    // The AI takes a few seconds: say so at once, so the chat does not look dead; the note goes when the answer comes.
    const reading = await reply('📖 Читаю повідомлення…').catch(() => null);
    const doneReading = () => reading?.message_id && telegram.deleteMessage?.(chatId, reading.message_id).catch(() => {});
    let found;
    try {
      found = await ai.extractDeadlines({ text, sentAt });
    } catch (err) {
      doneReading();
      if (!(err instanceof HttpError)) console.error('Deadline extraction failed:', err);
      return reply(err instanceof HttpError && [503, 504].includes(err.status)
        ? 'AI зараз перевантажений і не встиг відповісти. Спробуйте ще раз за хвилину або додайте дедлайн на сайті.'
        : 'Не вдалося розібрати повідомлення. Спробуйте ще раз за хвилину.');
    }
    doneReading();
    if (!found.length) return reply(`Не знайшов тут дедлайну. ${FORWARD_HINT}`);
    for (const d of found) {
      const dueAt = d.date ? kyivToMs(d.date, d.time || '23:59') : NaN;
      if (!Number.isFinite(dueAt)) {
        await reply(`Бачу «${d.title}», але не бачу дати. Напишіть, до коли, наприклад: «${d.title} до 25.11 18:00».`);
        continue;
      }
      if (dueAt <= now()) {
        await reply(`«${d.title}»: цей термін уже минув. Якщо дата інша, напишіть її, наприклад: «${d.title} до 25.11 18:00».`);
        continue;
      }
      // The AI's answer goes through the same checks as a deadline typed on the site (length, link, date range).
      let fields;
      try {
        fields = ctx.deadlineFields({ title: d.title, course: d.course, url: d.url, dueAt });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        await reply(`Не можу додати «${d.title.slice(0, 80)}»: ${err.message}`);
        continue;
      }
      const { lastInsertRowid } = run(
        'INSERT INTO tg_drafts (user_id, title, course, url, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        user.id, fields.title, fields.course, fields.url, fields.dueAt, now(),
      );
      const id = Number(lastInsertRowid);
      const add = [{ text: '✅ Додати собі', data: `draft:${id}:me` }];
      if (user.group_id) add.push({ text: '👥 Додати групі', data: `draft:${id}:group` });
      await reply(draftText({ title: fields.title, course: fields.course, url: fields.url, due_at: fields.dueAt }, now()), {
        buttons: [add, [{ text: '✖️ Скасувати', data: `draft:${id}:no` }]],
      });
    }
  }

  return { sendTo, notifyGroup, handleTelegramUpdate };
}

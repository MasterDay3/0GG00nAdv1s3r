// Thin Telegram Bot API client. Without a token it only logs, so the app still runs locally.
export function createTelegram({ token, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  async function call(method, body) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(`Telegram ${method} failed: ${data.description}`);
      err.code = data.error_code; // 403: the user blocked the bot or deleted the chat
      throw err;
    }
    return data.result;
  }

  let cachedName = null;
  return {
    enabled: Boolean(token),
    async botName() {
      if (!token) return null;
      cachedName ??= (await call('getMe', {})).username;
      return cachedName;
    },
    // doneKey adds a "✅ Done" button that marks that deadline as done; buttons: rows of [{ text, data }].
    async send(chatId, text, { doneKey, buttons } = {}) {
      if (!token) return log(`[telegram off] to ${chatId}: ${text}`);
      // Telegram refuses messages over 4096 characters; a long list is cut instead of failing every minute.
      if (text.length > 4000) text = `${text.slice(0, 3990)}\n…`;
      const rows = buttons || (doneKey ? [[{ text: '✅ Виконано', data: `done:${doneKey}` }]] : null);
      const markup = rows ? { reply_markup: { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {};
      return call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...markup });
    },
    async editMessage(chatId, messageId, text) {
      if (token) await call('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true });
    },
    async deleteMessage(chatId, messageId) {
      if (token) await call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
    async answerButton(queryId, text) {
      if (token) await call('answerCallbackQuery', { callback_query_id: queryId, text });
    },
    async setCommands(commands) {
      if (token) await call('setMyCommands', { commands });
    },
    getUpdates(offset) {
      return call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    },
  };
}

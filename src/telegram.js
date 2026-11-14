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
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
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
    async send(chatId, text) {
      if (!token) return log(`[telegram off] to ${chatId}: ${text}`);
      await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    },
    getUpdates(offset) {
      return call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    },
  };
}

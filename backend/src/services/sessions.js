// Who is asking: the session cookie or the extension key, and what /api/me returns.
import { randomBytes } from 'node:crypto';
import { parseReminders } from '../bot/reminders.js';
import { SESSION_TTL, PREMIUM } from '../constants.js';
import { parseCookies } from '../lib/http.js';
import { sha256 } from '../lib/passwords.js';

export function createSessions(ctx) {
  const { now, telegram, paywall, cookieFlags, one, run } = ctx;

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      token, now(),
    ) || null;
  }

  // The browser extension authenticates with its own key, which only opens the /api/extension/* routes.
  function extensionUser(req) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!match) return null;
    return one('SELECT * FROM users WHERE ext_key_hash = ?', sha256(match[1])) || null;
  }

  function startSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    run('DELETE FROM sessions WHERE expires_at <= ?', now());
    run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, now() + SESSION_TTL);
    res.setHeader('set-cookie', `sid=${token}; ${cookieFlags}; Max-Age=${SESSION_TTL / 1000}`);
  }

  function me(user) {
    const group = user.group_id ? one('SELECT name, join_code FROM study_groups WHERE id = ?', user.group_id) : null;
    return {
      username: user.username,
      group: group ? { name: group.name, code: group.join_code } : null,
      icsUrl: user.ics_url || '',
      lastSyncAt: user.last_sync_at,
      syncError: user.ics_url ? user.sync_error || null : null,
      telegram: {
        enabled: telegram.enabled, linked: Boolean(user.tg_chat_id), digest: Boolean(user.tg_digest), reminders: parseReminders(user.tg_remind),
      },
      extension: { connected: Boolean(user.ext_key_hash) },
      calendarFeed: Boolean(user.cal_token_hash),
      premium: { required: paywall, active: premiumActive(user), until: user.premium_until || null, ...PREMIUM },
    };
  }

  const premiumActive = (user) => Boolean(user.premium_until && user.premium_until > now());

  return { currentUser, extensionUser, startSession, me, premiumActive };
}

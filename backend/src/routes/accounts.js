// Registration, login, the account itself, password reset and settings.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { parseReminders } from '../bot/reminders.js';
import { RESET_TTL, RESET_TRIES, RESET_FAILS_PER_DAY } from '../constants.js';
import { parseCookies } from '../lib/http.js';
import { clientIp } from '../lib/limiter.js';
import { hashPassword, verifyPassword, sha256, DUMMY_HASH, newPassword } from '../lib/passwords.js';
import { DAY } from '../lib/urgency.js';
import { HttpError, text, normalizeFeedUrl } from '../lib/validate.js';

export function accountRoutes(ctx) {
  const { now, telegram, ai, storageLimit, teamChatId, cookieFlags, route, one, all, run, limits, guard } = ctx;

  route('POST', '/api/register', async ({ req, body, res }) => {
    const ip = clientIp(req);
    guard(res, [limits.registerIp, ip]);
    const username = text(body.username, 'Логін', { max: 32 });
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) throw new HttpError(400, 'Логін: від 3 до 32 латинських літер, цифр або _');
    const password = newPassword(body.password);
    if (one('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'Цей логін уже зайнятий');
    limits.registerIp.hit(ip);
    let created;
    try {
      created = run('INSERT INTO users (username, pass_hash) VALUES (?, ?)', username, await hashPassword(password));
    } catch (err) {
      // Two sign-ups with one name at the same moment: the second loses at the unique index.
      if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'Цей логін уже зайнятий');
      throw err;
    }
    ctx.startSession(res, Number(created.lastInsertRowid));
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/login', async ({ req, body, res }) => {
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const ip = clientIp(req);
    const account = username.toLowerCase();
    const pair = `${ip} ${account}`;
    guard(res, [limits.loginIp, ip], [limits.loginFails, pair], [limits.accountFails, account]);
    limits.loginIp.hit(ip);
    const user = one('SELECT * FROM users WHERE username = ?', username);
    const valid = await verifyPassword(password, user ? user.pass_hash : DUMMY_HASH);
    if (!user || !valid) {
      limits.loginFails.hit(pair);
      limits.accountFails.hit(account);
      throw new HttpError(401, 'Неправильний логін або пароль');
    }
    limits.loginFails.reset(pair);
    ctx.startSession(res, user.id);
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/logout', ({ req, res }) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) run('DELETE FROM sessions WHERE token = ?', token);
    res.setHeader('set-cookie', `sid=; ${cookieFlags}; Max-Age=0`);
    return { ok: true };
  }, { auth: false });

  route('GET', '/api/me', ({ user }) => ctx.me(user));

  // For the guest page: the Telegram bot to link to (null when the bot is off or Telegram does not answer).
  route('GET', '/api/public', async () => ({
    bot: telegram.enabled ? await telegram.botName().catch(() => null) : null,
  }), { auth: false });

  // For the privacy page: which AI provider gets materials, the bot, and whether /support reaches a person.
  route('GET', '/api/privacy-info', async () => ({
    bot: telegram.enabled ? await telegram.botName().catch(() => null) : null,
    ai: ai.enabled ? ai.label : null,
    support: Boolean(teamChatId && telegram.enabled),
    storageMb: Math.round(storageLimit / 1024 / 1024),
  }), { auth: false });

  // Checks the current password before a sensitive change; wrong guesses are limited like logins.
  async function confirmPassword(user, password, res) {
    const key = String(user.id);
    guard(res, [limits.confirmFails, key]);
    const valid = typeof password === 'string' && await verifyPassword(password.slice(0, 200), user.pass_hash);
    if (!valid) {
      limits.confirmFails.hit(key);
      throw new HttpError(403, 'Неправильний поточний пароль');
    }
    limits.confirmFails.reset(key);
  }

  // A new password signs out every other device: whoever knew the old one loses access, including through an
  // extension key or a Telegram link code they made while signed in. (The extension connects again in Settings.)
  async function setPassword(userId, password, res) {
    run(`UPDATE users SET pass_hash = ?, reset_hash = NULL, reset_expires = NULL, reset_tries = 0, reset_fails = 0,
         ext_key_hash = NULL, tg_link_code = NULL WHERE id = ?`,
    await hashPassword(password), userId);
    run('DELETE FROM sessions WHERE user_id = ?', userId);
    ctx.startSession(res, userId);
  }

  route('PUT', '/api/password', async ({ user, body, res }) => {
    const password = newPassword(body.password);
    await confirmPassword(user, body.current, res);
    await setPassword(user.id, password, res);
    return { ok: true };
  });

  // Everything the account holds, as one JSON file (uploaded files are listed, not embedded: they download on their own).
  // Its own shape, read straight from the tables, with ISO dates and ids that link topics, questions and files.
  // Secrets stay out: no password hash, keys or the Moodle link, whose authtoken opens the student's calendar.
  route('GET', '/api/export', ({ user, res }) => {
    const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
    const notes = new Map(all('SELECT item_key, text FROM notes WHERE user_id = ?', user.id).map((n) => [n.item_key, n.text]));
    const exams = all('SELECT * FROM exams WHERE user_id = ? ORDER BY exam_at', user.id).map((exam) => {
      const topics = all('SELECT id, name FROM topics WHERE exam_id = ? ORDER BY id', exam.id);
      const sources = new Map(all(
        `SELECT s.* FROM question_sources s JOIN questions q ON q.id = s.question_id
         JOIN topics t ON t.id = q.topic_id WHERE t.exam_id = ?`, exam.id,
      ).map((x) => [x.question_id, { fileId: x.material_id, file: x.filename, slide: x.slide, quote: x.quote }]));
      const questions = ctx.examQuestions(exam.id);
      const problems = all('SELECT p.* FROM problems p JOIN topics t ON t.id = p.topic_id WHERE t.exam_id = ? ORDER BY p.id', exam.id);
      return {
        id: exam.id, title: exam.title, course: exam.course, theme: exam.theme, examAt: iso(exam.exam_at), note: notes.get(`e${exam.id}`) || '',
        topics: topics.map((t) => ({
          id: t.id,
          name: t.name,
          questions: questions.filter((q) => q.topicId === t.id).map((q) => ({
            id: q.id, prompt: q.prompt, options: q.options, answerIndex: q.answerIndex, explanation: q.explanation || null, source: sources.get(q.id) || null,
          })),
          problems: problems.filter((x) => x.topic_id === t.id).map((x) => x.text),
        })),
        files: all('SELECT id, filename, size, created_at FROM materials WHERE exam_id = ? ORDER BY id', exam.id)
          .map((m) => ({ id: m.id, name: m.filename, bytes: m.size, uploadedAt: iso(m.created_at) })),
        testAttempts: all('SELECT * FROM attempts WHERE exam_id = ? ORDER BY id', exam.id).map((a) => ({
          takenAt: iso(a.created_at), topics: JSON.parse(a.result), wrongQuestionIds: JSON.parse(a.wrong || '[]'),
        })),
      };
    });
    const group = user.group_id ? one('SELECT name FROM study_groups WHERE id = ?', user.group_id) : null;
    const data = {
      exportedAt: iso(now()),
      account: {
        username: user.username,
        group: group?.name || null,
        moodleConnected: Boolean(user.ics_url),
        lastMoodleSync: iso(user.last_sync_at),
        telegramLinked: Boolean(user.tg_chat_id),
        morningDigest: Boolean(user.tg_digest),
        reminders: parseReminders(user.tg_remind),
        calendarFeed: Boolean(user.cal_token_hash),
        dueboardPrepUntil: iso(user.premium_until),
      },
      payments: all("SELECT * FROM payments WHERE user_id = ? AND status != 'pending' ORDER BY id", user.id).map((p) => ({
        order: p.order_ref, amount: p.amount / 100, status: p.status, testCardLast4: p.card_last4,
        at: iso(p.paid_at || p.created_at), activeUntil: iso(p.active_until),
      })),
      deadlines: ctx.boardItems(user).filter((item) => item.source !== 'exam').map((item) => ({
        id: item.id, title: item.title, course: item.course, dueAt: iso(item.dueAt), source: item.source,
        url: item.url, note: item.note, done: item.done,
      })),
      exams,
    };
    res.setHeader('content-disposition', `attachment; filename="dueboard-${user.username}-${iso(now()).slice(0, 10)}.json"`);
    return data;
  });

  // "Someone had access": every way in goes, the extension key, the calendar link and the Telegram chat included.
  route('POST', '/api/logout-all', ({ user, res }) => {
    run('DELETE FROM sessions WHERE user_id = ?', user.id);
    run('UPDATE users SET ext_key_hash = NULL, cal_token_hash = NULL, tg_chat_id = NULL, tg_link_code = NULL WHERE id = ?', user.id);
    res.setHeader('set-cookie', `sid=; ${cookieFlags}; Max-Age=0`);
    return { ok: true };
  });

  route('DELETE', '/api/account', async ({ user, body, res }) => {
    if (body.confirm !== user.username) throw new HttpError(400, 'Щоб підтвердити, введіть свій логін');
    await confirmPassword(user, body.password, res);
    // Everything the user owns goes with the account (ON DELETE CASCADE); group deadlines they added stay for the group.
    run('DELETE FROM users WHERE id = ?', user.id);
    res.setHeader('set-cookie', `sid=; ${cookieFlags}; Max-Age=0`);
    return { ok: true };
  }, { withBody: true });

  // Forgotten password: a 6-digit code goes to the Telegram chat linked to the account.
  // The answer is the same whether or not the account exists, so it does not reveal usernames.
  route('POST', '/api/password-reset', async ({ req, body, res }) => {
    if (!telegram.enabled) throw new HttpError(409, 'Відновлення пароля працює через Telegram, а він на цьому сервері вимкнений');
    const username = text(body.username, 'Логін', { max: 64 });
    const ip = clientIp(req);
    const account = username.toLowerCase();
    guard(res, [limits.resetIp, ip], [limits.resetAccount, account]);
    limits.resetIp.hit(ip);
    limits.resetAccount.hit(account);
    const user = one('SELECT * FROM users WHERE username = ?', username);
    if (user?.tg_chat_id) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      run('UPDATE users SET reset_hash = ?, reset_expires = ?, reset_tries = 0 WHERE id = ?', sha256(code), now() + RESET_TTL, user.id);
      await ctx.sendTo(user, `🔑 Код для відновлення пароля Dueboard: ${code}\nВін діє 15 хвилин. Якщо це не ви, просто проігноруйте повідомлення: пароль не зміниться.`);
    }
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/password-reset/confirm', async ({ body, res }) => {
    const username = text(body.username, 'Логін', { max: 64 });
    const code = text(body.code, 'Код', { max: 12 }).replace(/\s/g, '');
    const password = newPassword(body.password);
    const user = one('SELECT * FROM users WHERE username = ?', username);
    const t = now();
    // Wrong codes add up across codes for a day, so asking for new codes does not buy new guesses.
    const failsToday = user && user.reset_fails_at > t - DAY ? user.reset_fails : 0;
    if (failsToday >= RESET_FAILS_PER_DAY) throw new HttpError(429, 'Забагато неправильних кодів. Спробуйте завтра.');
    const usable = user?.reset_hash && user.reset_expires > t && user.reset_tries < RESET_TRIES;
    if (!usable) throw new HttpError(400, 'Код недійсний або застарів. Попросіть новий.');
    if (!timingSafeEqual(Buffer.from(sha256(code)), Buffer.from(user.reset_hash))) {
      run(`UPDATE users SET reset_tries = reset_tries + 1, reset_fails = ?,
           reset_fails_at = CASE WHEN ? THEN reset_fails_at ELSE ? END WHERE id = ?`,
      failsToday + 1, failsToday > 0 ? 1 : 0, t, user.id);
      throw new HttpError(400, 'Неправильний код');
    }
    await setPassword(user.id, password, res);
    return { ok: true };
  }, { auth: false });

  route('PUT', '/api/settings', ({ user, body }) => {
    const icsUrl = normalizeFeedUrl(body.icsUrl) || null;
    // A new link starts clean: the old link's error says nothing about it.
    run('UPDATE users SET ics_url = ?, sync_error = CASE WHEN ics_url IS ? THEN sync_error END WHERE id = ?', icsUrl, icsUrl, user.id);
    return ctx.me(one('SELECT * FROM users WHERE id = ?', user.id));
  });
}

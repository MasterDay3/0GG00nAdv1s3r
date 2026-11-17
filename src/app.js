// node:crypto is needed for password hashing and session tokens; node:fs to serve the page files.
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseIcs } from './ics.js';
import { urgency, DAY } from './urgency.js';
import { dueReminders, reminderText } from './reminders.js';
import { buildPlan, localDate } from './plan.js';
import { scoreDiagnostic } from './diagnostic.js';
import { HttpError, text, link, timestamp } from './validate.js';
import { createAi, COUNT } from './ai.js';
import { createLimiter, clientIp } from './limiter.js';
import { buildCalendar } from './ics-export.js';
import {
  NOT_LINKED, DIGEST_HOUR, DIGEST_WINDOW, localParts, deadlinesText, digestText, groupDeadlineText, linkedText, helpText,
} from './bot.js';

const MAX_JSON = 64 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_UPLOAD_BODY = Math.ceil(MAX_FILE * 4 / 3) + 4096;
const MAX_FEED = 5 * 1024 * 1024;
const SESSION_TTL = 30 * DAY;
const AI_RUNS_PER_DAY = 10;
const RESET_TTL = 15 * 60 * 1000;
const RESET_TRIES = 5;
const MINUTE = 60 * 1000;
const BOT_WALL_MESSAGE = 'Ваш Moodle захищений перевіркою на бота, тож автоматична синхронізація не працює. '
  + 'У Moodle натисніть Експорт календаря → «Експортувати», завантажте файл .ics і імпортуйте його нижче.';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/tokens.css': ['tokens.css', 'text/css; charset=utf-8'],
  '/base.css': ['base.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; "
    + "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function hashPassword(password, salt = randomBytes(16)) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(`${salt.toString('hex')}:${key.toString('hex')}`)));
  });
}

async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const candidate = await hashPassword(password, Buffer.from(saltHex, 'hex'));
  return timingSafeEqual(Buffer.from(candidate.split(':')[1], 'hex'), Buffer.from(keyHex, 'hex'));
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const DUMMY_HASH =`${'0'.repeat(32)}:${'0'.repeat(128)}`;

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

async function readJson(req, limit) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Очікувався application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Запит завеликий');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Некоректний JSON');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new HttpError(400, 'Пароль має бути не коротшим за 8 символів');
  }
  return value;
}

function normalizeFeedUrl(value) {
  let url = text(value, 'Посилання на календар', { max: 2000, required: false });
  if (/^webcals?:\/\//i.test(url)) url = url.replace(/^webcals?:/i, 'https:');
  return link(url, 'Посилання на календар');
}

export function createApp({ db, now = () => Date.now(), fetchImpl = globalThis.fetch, telegram, secureCookies = false, ai = createAi() }) {
  // Behind HTTPS the session cookie must never travel over plain HTTP.
  const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${secureCookies ? '; Secure' : ''}`;
  const routes = [];
  // withBody: a DELETE that also takes a JSON body (POST and PUT always do).
  const route = (method, pattern, fn, { auth = true, limit = MAX_JSON, withBody = false } = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>\\d+)')}$`);
    routes.push({ method, re, fn, auth, limit, withBody });
  };
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // ---------- brute-force limits ----------

  const limits = {
    // Every login attempt from one address, right or wrong (generous: a campus shares one address).
    loginIp: createLimiter({ limit: 100, windowMs: 15 * MINUTE, now }),
    // Wrong passwords for one account from one address.
    loginFails: createLimiter({ limit: 5, windowMs: 15 * MINUTE, now }),
    // Wrong passwords for one account from anywhere: a slow, spread-out guess.
    accountFails: createLimiter({ limit: 30, windowMs: 60 * MINUTE, now }),
    registerIp: createLimiter({ limit: 20, windowMs: 60 * MINUTE, now }),
    // Reset codes sent to one account, and reset requests from one address.
    resetAccount: createLimiter({ limit: 3, windowMs: 15 * MINUTE, now }),
    resetIp: createLimiter({ limit: 20, windowMs: 15 * MINUTE, now }),
    // Wrong current passwords when changing the password or deleting the account.
    confirmFails: createLimiter({ limit: 5, windowMs: 15 * MINUTE, now }),
  };

  function guard(res, ...checks) {
    const wait = Math.max(...checks.map(([limiter, key]) => limiter.blockedFor(key)));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      res.setHeader('retry-after', String(seconds));
      throw new HttpError(429, `Забагато спроб. Спробуйте за ${Math.ceil(seconds / 60)} хв.`);
    }
  }

  // ---------- sessions ----------

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
      telegram: { enabled: telegram.enabled, linked: Boolean(user.tg_chat_id), digest: Boolean(user.tg_digest) },
      extension: { connected: Boolean(user.ext_key_hash) },
      calendarFeed: Boolean(user.cal_token_hash),
    };
  }

  // ---------- board ----------

  // Row ids can be reused after a delete, so per-user rows keyed by 'd<id>' go with the deadline.
  function forgetDeadline(id) {
    run('DELETE FROM deadlines WHERE id = ?', id);
    for (const table of ['notes', 'done', 'reminders_sent']) run(`DELETE FROM ${table} WHERE item_key = ?`, `d${id}`);
  }

  function markDone(user, key, isDone) {
    if (!/^d\d+$/.test(key) || !boardItems(user).some((item) => item.key === key)) {
      throw new HttpError(404, 'Дедлайн не знайдено');
    }
    if (isDone) {
      run('INSERT OR IGNORE INTO done (user_id, item_key, done_at) VALUES (?, ?, ?)', user.id, key, now());
    } else {
      run('DELETE FROM done WHERE user_id = ? AND item_key = ?', user.id, key);
    }
  }

  // What still needs doing: the board without what the user marked done.
  const openItems = (user) => boardItems(user).filter((item) => !item.done);

  function boardItems(user) {
    const t = now();
    const deadlines = all(
      `SELECT d.*, n.text AS note, dn.done_at FROM deadlines d
       LEFT JOIN notes n ON n.user_id = ? AND n.item_key = 'd' || d.id
       LEFT JOIN done dn ON dn.user_id = ? AND dn.item_key = 'd' || d.id
       WHERE d.owner_user_id = ? OR (d.group_id IS NOT NULL AND d.group_id = ?)`,
      user.id, user.id, user.id, user.group_id ?? -1,
    ).map((d) => ({
      key: `d${d.id}`, id: d.id, source: d.source, course: d.course, title: d.title, url: d.url,
      dueAt: d.due_at, note: d.note || '', done: d.done_at != null,
      canDelete: d.source !== 'moodle' && d.created_by === user.id,
    }));
    const exams = all(
      `SELECT e.*, n.text AS note FROM exams e
       LEFT JOIN notes n ON n.user_id = ? AND n.item_key = 'e' || e.id
       WHERE e.user_id = ?`,
      user.id, user.id,
    ).map((e) => ({
      key: `e${e.id}`, id: e.id, source: 'exam', course: e.course, title: e.title, url: '',
      dueAt: e.exam_at, note: e.note || '', done: false, canDelete: false,
    }));
    return [...deadlines, ...exams]
      .map((item) => ({ ...item, urgency: urgency(item.dueAt, t) }))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  function importEvents(user, events, origin) {
    const t = now();
    const upsert = db.prepare(
      `INSERT INTO deadlines (owner_user_id, created_by, source, uid, course, title, url, due_at)
       VALUES (?, ?, 'moodle', ?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, uid) DO UPDATE SET
         course = excluded.course, title = excluded.title, due_at = excluded.due_at,
         url = CASE WHEN excluded.url = '' THEN deadlines.url ELSE excluded.url END`,
    );
    db.exec('BEGIN');
    try {
      for (const ev of events) {
        let url = ev.url;
        if (!url && origin) url = `${origin}/calendar/view.php?view=day&time=${Math.floor(ev.dueAt / 1000)}`;
        upsert.run(user.id, user.id, ev.uid.slice(0, 500), ev.course.slice(0, 200), ev.title.slice(0, 500), url.slice(0, 2000), ev.dueAt);
      }
      // A future Moodle deadline that disappeared from the feed was removed or moved in Moodle.
      if (origin) {
        const uids = new Set(events.map((e) => e.uid.slice(0, 500)));
        const stale = all(`SELECT id, uid FROM deadlines WHERE owner_user_id = ? AND source = 'moodle' AND due_at > ?`, user.id, t)
          .filter((d) => !uids.has(d.uid));
        for (const d of stale) forgetDeadline(d.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return events.length;
  }

  async function syncMoodle(user) {
    if (!user.ics_url) throw new HttpError(400, 'Спершу додайте посилання на календар Moodle');
    let body;
    try {
      const res = await fetchImpl(user.ics_url, { signal: AbortSignal.timeout(15_000) });
      const cloudflareBlock = !res.ok && /cloudflare/i.test(res.headers.get('server') || '');
      if (res.headers.get('cf-mitigated') === 'challenge' || cloudflareBlock) {
        throw new HttpError(502, BOT_WALL_MESSAGE);
      }
      if (!res.ok) throw new HttpError(502, `Moodle відповів зі статусом ${res.status}`);
      body = await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'Не вдалося відкрити посилання на календар');
    }
    if (body.length > MAX_FEED) throw new HttpError(502, 'Календар завеликий');
    if (!/BEGIN:VCALENDAR/i.test(body)) throw new HttpError(502, 'За цим посиланням немає календаря');
    const imported = importEvents(user, parseIcs(body), new URL(user.ics_url).origin);
    run('UPDATE users SET last_sync_at = ? WHERE id = ?', now(), user.id);
    return imported;
  }

  // ---------- prep ----------

  function ownExam(user, id) {
    const exam = one('SELECT * FROM exams WHERE id = ? AND user_id = ?', id, user.id);
    if (!exam) throw new HttpError(404, 'Екзамен не знайдено');
    return exam;
  }

  function ownTopic(user, id) {
    const topic = one(
      'SELECT t.* FROM topics t JOIN exams e ON e.id = t.exam_id WHERE t.id = ? AND e.user_id = ?', id, user.id,
    );
    if (!topic) throw new HttpError(404, 'Тему не знайдено');
    return topic;
  }

  function examQuestions(examId) {
    return all(
      `SELECT q.* FROM questions q JOIN topics t ON t.id = q.topic_id WHERE t.exam_id = ? ORDER BY t.id, q.id`, examId,
    ).map((q) => ({ id: q.id, topicId: q.topic_id, prompt: q.prompt, options: JSON.parse(q.options), answerIndex: q.answer_index }));
  }

  function examDetail(exam) {
    const questions = examQuestions(exam.id);
    const problems = all(
      `SELECT p.* FROM problems p JOIN topics t ON t.id = p.topic_id WHERE t.exam_id = ? ORDER BY p.id`, exam.id,
    );
    const topics = all('SELECT * FROM topics WHERE exam_id = ? ORDER BY id', exam.id).map((t) => ({
      id: t.id,
      name: t.name,
      questions: questions.filter((q) => q.topicId === t.id),
      problems: problems.filter((p) => p.topic_id === t.id).map((p) => ({ id: p.id, text: p.text })),
    }));
    const attempt = one('SELECT * FROM attempts WHERE exam_id = ? ORDER BY id DESC LIMIT 1', exam.id);
    const result = attempt ? { takenAt: attempt.created_at, topics: JSON.parse(attempt.result) } : null;
    const statusOf = (topicId) => result?.topics.find((r) => r.topicId === topicId)?.status || 'untested';
    return {
      id: exam.id,
      title: exam.title,
      course: exam.course,
      examAt: exam.exam_at,
      topics,
      materials: all('SELECT id, filename, size, created_at FROM materials WHERE exam_id = ? ORDER BY id', exam.id)
        .map((m) => ({ id: m.id, filename: m.filename, size: m.size, createdAt: m.created_at })),
      result,
      plan: buildPlan({
        today: localDate(now()),
        examDate: localDate(exam.exam_at),
        topics: topics.map((t) => ({ name: t.name, status: statusOf(t.id) })),
      }),
    };
  }

  // ---------- routes: accounts ----------

  route('POST', '/api/register', async ({ req, body, res }) => {
    const ip = clientIp(req);
    guard(res, [limits.registerIp, ip]);
    const username = text(body.username, 'Логін', { max: 32 });
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) throw new HttpError(400, 'Логін: 3–32 латинські літери, цифри або _');
    const password = newPassword(body.password);
    if (one('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'Цей логін уже зайнятий');
    limits.registerIp.hit(ip);
    const { lastInsertRowid } = run('INSERT INTO users (username, pass_hash) VALUES (?, ?)', username, await hashPassword(password));
    startSession(res, Number(lastInsertRowid));
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
    startSession(res, user.id);
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/logout', ({ req, res }) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) run('DELETE FROM sessions WHERE token = ?', token);
    res.setHeader('set-cookie', `sid=; ${cookieFlags}; Max-Age=0`);
    return { ok: true };
  }, { auth: false });

  route('GET', '/api/me', ({ user }) => me(user));

  // ---------- routes: account ----------

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

  // A new password signs out every other device: whoever knew the old one loses access.
  async function setPassword(userId, password, res) {
    run('UPDATE users SET pass_hash = ?, reset_hash = NULL, reset_expires = NULL, reset_tries = 0 WHERE id = ?',
      await hashPassword(password), userId);
    run('DELETE FROM sessions WHERE user_id = ?', userId);
    startSession(res, userId);
  }

  route('PUT', '/api/password', async ({ user, body, res }) => {
    const password = newPassword(body.password);
    await confirmPassword(user, body.current, res);
    await setPassword(user.id, password, res);
    return { ok: true };
  });

  route('POST', '/api/logout-all', ({ user, res }) => {
    run('DELETE FROM sessions WHERE user_id = ?', user.id);
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
      await sendTo(user, `🔑 Код для відновлення пароля Dueboard: ${code}\nВін діє 15 хвилин. Якщо це не ви, просто проігноруйте повідомлення: пароль не зміниться.`);
    }
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/password-reset/confirm', async ({ body, res }) => {
    const username = text(body.username, 'Логін', { max: 64 });
    const code = text(body.code, 'Код', { max: 12 }).replace(/\s/g, '');
    const password = newPassword(body.password);
    const user = one('SELECT * FROM users WHERE username = ?', username);
    const usable = user?.reset_hash && user.reset_expires > now() && user.reset_tries < RESET_TRIES;
    if (!usable) throw new HttpError(400, 'Код недійсний або застарів. Попросіть новий.');
    if (!timingSafeEqual(Buffer.from(sha256(code)), Buffer.from(user.reset_hash))) {
      run('UPDATE users SET reset_tries = reset_tries + 1 WHERE id = ?', user.id);
      throw new HttpError(400, 'Неправильний код');
    }
    await setPassword(user.id, password, res);
    return { ok: true };
  }, { auth: false });

  route('PUT', '/api/settings', ({ user, body }) => {
    run('UPDATE users SET ics_url = ? WHERE id = ?', normalizeFeedUrl(body.icsUrl) || null, user.id);
    return me(one('SELECT * FROM users WHERE id = ?', user.id));
  });

  // ---------- routes: groups ----------

  route('POST', '/api/group', ({ user, body }) => {
    const name = text(body.name, 'Назва групи', { max: 80 });
    const code = randomBytes(4).toString('hex').toUpperCase();
    const { lastInsertRowid } = run('INSERT INTO study_groups (name, join_code) VALUES (?, ?)', name, code);
    run('UPDATE users SET group_id = ? WHERE id = ?', Number(lastInsertRowid), user.id);
    return { name, code };
  });

  route('POST', '/api/group/join', ({ user, body }) => {
    const code = text(body.code, 'Код групи', { max: 16 }).toUpperCase();
    const group = one('SELECT * FROM study_groups WHERE join_code = ?', code);
    if (!group) throw new HttpError(404, 'Групи з таким кодом немає');
    run('UPDATE users SET group_id = ? WHERE id = ?', group.id, user.id);
    return { name: group.name, code: group.join_code };
  });

  route('POST', '/api/group/leave', ({ user }) => {
    run('UPDATE users SET group_id = NULL WHERE id = ?', user.id);
    return { ok: true };
  });

  // ---------- routes: deadlines ----------

  route('GET', '/api/deadlines', ({ user }) => ({ now: now(), items: boardItems(user) }));

  function deadlineFields(body) {
    return {
      title: text(body.title, 'Назва'),
      course: text(body.course, 'Курс', { max: 100, required: false }),
      dueAt: timestamp(body.dueAt, 'Термін'),
      url: link(body.url),
    };
  }

  route('POST', '/api/deadlines', ({ user, body }) => {
    const { title, course, dueAt, url } = deadlineFields(body);
    const shared = body.shared === true;
    if (shared && !user.group_id) throw new HttpError(400, 'Щоб ділитися дедлайнами, приєднайтеся до групи');
    const { lastInsertRowid } = run(
      `INSERT INTO deadlines (owner_user_id, group_id, created_by, source, course, title, url, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      shared ? null : user.id, shared ? user.group_id : null, user.id, shared ? 'group' : 'personal',
      course, title, url, dueAt,
    );
    const id = Number(lastInsertRowid);
    // Not awaited: the response should not wait for Telegram.
    if (shared) notifyGroup(user, { source: 'group', course, title, url, dueAt }).catch((err) => console.error(err));
    return { id, key: `d${id}` };
  });

  // Only the author edits a deadline they added; Moodle ones come from Moodle and would be overwritten by the next sync.
  route('PUT', '/api/deadlines/:id', ({ user, params, body }) => {
    const deadline = one(
      `SELECT * FROM deadlines WHERE id = ? AND created_by = ? AND source != 'moodle'
         AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))`,
      params.id, user.id, user.id, user.group_id ?? -1,
    );
    if (!deadline) throw new HttpError(404, 'Дедлайн не знайдено');
    const { title, course, dueAt, url } = deadlineFields(body);
    run('UPDATE deadlines SET title = ?, course = ?, url = ?, due_at = ? WHERE id = ?', title, course, url, dueAt, params.id);
    // A new date means new reminders, for everyone who sees the deadline.
    if (dueAt !== deadline.due_at) run('DELETE FROM reminders_sent WHERE item_key = ?', `d${params.id}`);
    return { ok: true };
  });

  route('DELETE', '/api/deadlines/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM deadlines WHERE id = ? AND created_by = ? AND source != 'moodle'
         AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))`,
      params.id, user.id, user.id, user.group_id ?? -1,
    );
    if (!changes) throw new HttpError(404, 'Дедлайн не знайдено');
    forgetDeadline(params.id);
    return { ok: true };
  });

  route('PUT', '/api/done', ({ user, body }) => {
    markDone(user, text(body.key, 'Запис', { max: 24 }), body.done !== false);
    return { ok: true };
  });

  route('PUT', '/api/notes', ({ user, body }) => {
    const key = text(body.key, 'Запис', { max: 24 });
    const note = text(body.text, 'Нотатка', { max: 2000, required: false });
    if (!boardItems(user).some((item) => item.key === key)) throw new HttpError(404, 'Дедлайн не знайдено');
    if (note) {
      run(`INSERT INTO notes (user_id, item_key, text) VALUES (?, ?, ?)
           ON CONFLICT (user_id, item_key) DO UPDATE SET text = excluded.text`, user.id, key, note);
    } else {
      run('DELETE FROM notes WHERE user_id = ? AND item_key = ?', user.id, key);
    }
    return { ok: true };
  });

  route('POST', '/api/sync', async ({ user }) => ({ imported: await syncMoodle(user) }));

  route('POST', '/api/import-ics', ({ user, body }) => {
    const ics = text(body.ics, 'Файл календаря', { max: MAX_FEED });
    if (!/BEGIN:VCALENDAR/i.test(ics)) throw new HttpError(400, 'Це не календар .ics');
    return { imported: importEvents(user, parseIcs(ics), null) };
  }, { limit: MAX_FEED + 4096 });

  // ---------- routes: browser extension ----------

  route('POST', '/api/extension/key', ({ user }) => {
    const key = randomBytes(32).toString('hex');
    run('UPDATE users SET ext_key_hash = ? WHERE id = ?', sha256(key), user.id);
    return { key };
  });

  route('DELETE', '/api/extension/key', ({ user }) => {
    run('UPDATE users SET ext_key_hash = NULL WHERE id = ?', user.id);
    return { ok: true };
  });

  route('GET', '/api/extension/config', ({ user }) => ({ icsUrl: user.ics_url || '' }), { auth: 'extension' });

  route('POST', '/api/extension/upload', ({ user, body }) => {
    const ics = text(body.ics, 'Календар', { max: MAX_FEED });
    if (!/BEGIN:VCALENDAR/i.test(ics)) throw new HttpError(400, 'Це не календар .ics');
    const origin = user.ics_url ? new URL(user.ics_url).origin : null;
    const imported = importEvents(user, parseIcs(ics), origin);
    run('UPDATE users SET last_sync_at = ? WHERE id = ?', now(), user.id);
    return { imported };
  }, { auth: 'extension', limit: MAX_FEED + 4096 });

  // ---------- routes: calendar feed ----------

  // The link is shown once; making a new one turns the old one off.
  route('POST', '/api/calendar-feed', ({ user }) => {
    const token = randomBytes(32).toString('hex');
    run('UPDATE users SET cal_token_hash = ? WHERE id = ?', sha256(token), user.id);
    return { path: `/cal/${token}.ics` };
  });

  route('DELETE', '/api/calendar-feed', ({ user }) => {
    run('UPDATE users SET cal_token_hash = NULL WHERE id = ?', user.id);
    return { ok: true };
  });

  // Calendar apps fetch the feed without a cookie, so the secret in the link is the only key.
  function serveCalendar(token, req, res) {
    const user = one('SELECT * FROM users WHERE cal_token_hash = ?', sha256(token));
    if (!user) throw new HttpError(404, 'Не знайдено');
    const t = now();
    // What is still to do, plus the last 30 days so a calendar does not lose what just passed.
    const items = openItems(user).filter((item) => item.dueAt > t - 30 * DAY);
    res.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="dueboard.ics"',
      'cache-control': 'private, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : buildCalendar(items, t));
  }

  // ---------- routes: telegram ----------

  route('POST', '/api/telegram/link', async ({ user }) => {
    if (!telegram.enabled) throw new HttpError(409, 'Telegram на цьому сервері не налаштований (TELEGRAM_BOT_TOKEN)');
    const code = randomBytes(6).toString('hex');
    run('UPDATE users SET tg_link_code = ? WHERE id = ?', code, user.id);
    return { code, botName: await telegram.botName() };
  });

  route('DELETE', '/api/telegram', ({ user }) => {
    run('UPDATE users SET tg_chat_id = NULL, tg_link_code = NULL WHERE id = ?', user.id);
    return { ok: true };
  });

  // ---------- routes: exams ----------

  route('GET', '/api/exams', ({ user }) =>
    all('SELECT id, title, course, exam_at FROM exams WHERE user_id = ? ORDER BY exam_at', user.id)
      .map((e) => ({ id: e.id, title: e.title, course: e.course, examAt: e.exam_at })));

  function examFields(body) {
    return {
      title: text(body.title, 'Назва екзамену'),
      course: text(body.course, 'Курс', { max: 100, required: false }),
      examAt: timestamp(body.examAt, 'Дата екзамену'),
    };
  }

  route('POST', '/api/exams', ({ user, body }) => {
    const { title, course, examAt } = examFields(body);
    const { lastInsertRowid } = run('INSERT INTO exams (user_id, course, title, exam_at) VALUES (?, ?, ?, ?)', user.id, course, title, examAt);
    return { id: Number(lastInsertRowid) };
  });

  route('GET', '/api/exams/:id', ({ user, params }) => withAi(examDetail(ownExam(user, params.id))));

  route('PUT', '/api/exams/:id', ({ user, params, body }) => {
    const exam = ownExam(user, params.id);
    const { title, course, examAt } = examFields(body);
    run('UPDATE exams SET title = ?, course = ?, exam_at = ? WHERE id = ?', title, course, examAt, exam.id);
    if (examAt !== exam.exam_at) run('DELETE FROM reminders_sent WHERE item_key = ?', `e${exam.id}`);
    return { ok: true };
  });

  route('DELETE', '/api/exams/:id', ({ user, params }) => {
    ownExam(user, params.id);
    run('DELETE FROM exams WHERE id = ?', params.id);
    for (const table of ['notes', 'reminders_sent']) run(`DELETE FROM ${table} WHERE item_key = ?`, `e${params.id}`);
    return { ok: true };
  });

  route('POST', '/api/exams/:id/topics', ({ user, params, body }) => {
    ownExam(user, params.id);
    const name = text(body.name, 'Тема', { max: 120 });
    const { lastInsertRowid } = run('INSERT INTO topics (exam_id, name) VALUES (?, ?)', params.id, name);
    return { id: Number(lastInsertRowid), name };
  });

  route('PUT', '/api/topics/:id', ({ user, params, body }) => {
    ownTopic(user, params.id);
    run('UPDATE topics SET name = ? WHERE id = ?', text(body.name, 'Тема', { max: 120 }), params.id);
    return { ok: true };
  });

  route('DELETE', '/api/topics/:id', ({ user, params }) => {
    ownTopic(user, params.id);
    run('DELETE FROM topics WHERE id = ?', params.id);
    return { ok: true };
  });

  function questionFields(body) {
    const prompt = text(body.prompt, 'Питання', { max: 1000 });
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 6) {
      throw new HttpError(400, 'Питанню потрібно 2–6 варіантів відповіді');
    }
    const options = body.options.map((o, i) => text(o, `Варіант ${i + 1}`, { max: 300 }));
    if (!Number.isInteger(body.answerIndex) || body.answerIndex < 0 || body.answerIndex >= options.length) {
      throw new HttpError(400, 'Вкажіть правильний варіант');
    }
    return { prompt, options, answerIndex: body.answerIndex };
  }

  // A question or problem of one of the user's exams.
  // table is one of two constants ('questions' | 'problems'), never user input.
  function ownItem(user, table, id, notFound) {
    const row = one(
      `SELECT x.* FROM ${table} x JOIN topics t ON t.id = x.topic_id JOIN exams e ON e.id = t.exam_id
       WHERE x.id = ? AND e.user_id = ?`, id, user.id,
    );
    if (!row) throw new HttpError(404, notFound);
    return row;
  }

  route('POST', '/api/topics/:id/questions', ({ user, params, body }) => {
    ownTopic(user, params.id);
    const { prompt, options, answerIndex } = questionFields(body);
    const { lastInsertRowid } = run(
      'INSERT INTO questions (topic_id, prompt, options, answer_index) VALUES (?, ?, ?, ?)',
      params.id, prompt, JSON.stringify(options), answerIndex,
    );
    return { id: Number(lastInsertRowid) };
  });

  // Editing keeps the question's topic; moving it is topicId (another topic of the same exam).
  route('PUT', '/api/questions/:id', ({ user, params, body }) => {
    const question = ownItem(user, 'questions', params.id, 'Питання не знайдено');
    const { prompt, options, answerIndex } = questionFields(body);
    let topicId = question.topic_id;
    if (body.topicId !== undefined && body.topicId !== topicId) {
      const target = Number.isInteger(body.topicId) && ownTopic(user, body.topicId);
      const current = one('SELECT exam_id FROM topics WHERE id = ?', topicId);
      if (!target || target.exam_id !== current.exam_id) throw new HttpError(400, 'Тему не знайдено');
      topicId = target.id;
    }
    run('UPDATE questions SET topic_id = ?, prompt = ?, options = ?, answer_index = ? WHERE id = ?',
      topicId, prompt, JSON.stringify(options), answerIndex, params.id);
    return { ok: true };
  });

  route('DELETE', '/api/questions/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM questions WHERE id = ? AND topic_id IN
         (SELECT t.id FROM topics t JOIN exams e ON e.id = t.exam_id WHERE e.user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Питання не знайдено');
    return { ok: true };
  });

  route('POST', '/api/topics/:id/problems', ({ user, params, body }) => {
    ownTopic(user, params.id);
    const problem = text(body.text, 'Задача', { max: 4000 });
    const { lastInsertRowid } = run('INSERT INTO problems (topic_id, text) VALUES (?, ?)', params.id, problem);
    return { id: Number(lastInsertRowid) };
  });

  route('PUT', '/api/problems/:id', ({ user, params, body }) => {
    ownItem(user, 'problems', params.id, 'Задачу не знайдено');
    run('UPDATE problems SET text = ? WHERE id = ?', text(body.text, 'Задача', { max: 4000 }), params.id);
    return { ok: true };
  });

  route('DELETE', '/api/problems/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM problems WHERE id = ? AND topic_id IN
         (SELECT t.id FROM topics t JOIN exams e ON e.id = t.exam_id WHERE e.user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Задачу не знайдено');
    return { ok: true };
  });

  route('POST', '/api/exams/:id/materials', ({ user, params, body }) => {
    ownExam(user, params.id);
    const filename = text(body.filename, 'Назва файлу', { max: 200 }).replace(/[\r\n"\\/]/g, '_');
    if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
      throw new HttpError(400, 'Дані файлу мають бути в base64');
    }
    const data = Buffer.from(body.data, 'base64');
    if (!data.length) throw new HttpError(400, 'Файл порожній');
    if (data.length > MAX_FILE) throw new HttpError(413, 'Файл не може бути більшим за 10 МБ');
    const { lastInsertRowid } = run(
      'INSERT INTO materials (exam_id, filename, size, data, created_at) VALUES (?, ?, ?, ?, ?)',
      params.id, filename, data.length, data, now(),
    );
    return { id: Number(lastInsertRowid), filename, size: data.length };
  }, { limit: MAX_UPLOAD_BODY });

  route('GET', '/api/materials/:id', ({ user, params, res }) => {
    const material = one(
      `SELECT m.* FROM materials m JOIN exams e ON e.id = m.exam_id WHERE m.id = ? AND e.user_id = ?`, params.id, user.id,
    );
    if (!material) throw new HttpError(404, 'Файл не знайдено');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(material.filename)}`,
      'cache-control': 'no-store',
    });
    res.end(Buffer.from(material.data));
  });

  route('DELETE', '/api/materials/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM materials WHERE id = ? AND exam_id IN (SELECT id FROM exams WHERE user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Файл не знайдено');
    return { ok: true };
  });

  route('GET', '/api/exams/:id/test', ({ user, params }) => {
    ownExam(user, params.id);
    const topics = new Map(all('SELECT id, name FROM topics WHERE exam_id = ?', params.id).map((t) => [t.id, t.name]));
    const sources = new Map(all(
      `SELECT s.* FROM question_sources s JOIN questions q ON q.id = s.question_id
       JOIN topics t ON t.id = q.topic_id WHERE t.exam_id = ?`, params.id,
    ).map((s) => [s.question_id, { filename: s.filename, slide: s.slide, quote: s.quote }]));
    // Practice on the student's own questions, so the answer comes along: the page shows right/wrong at once.
    return {
      questions: examQuestions(params.id).map(({ id, topicId, prompt, options, answerIndex }) => ({
        id, topicId, topic: topics.get(topicId), prompt, options, answerIndex, source: sources.get(id) || null,
      })),
    };
  });

  route('POST', '/api/exams/:id/test', ({ user, params, body }) => {
    const exam = ownExam(user, params.id);
    const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    const questions = examQuestions(exam.id);
    if (!questions.length) throw new HttpError(400, 'Спершу додайте питання');
    const topics = all('SELECT id, name FROM topics WHERE exam_id = ? ORDER BY id', exam.id);
    const result = scoreDiagnostic(topics, questions, answers);
    run('INSERT INTO attempts (exam_id, created_at, result) VALUES (?, ?, ?)', exam.id, now(), JSON.stringify(result));
    return examDetail(exam);
  });

  // ---------- routes: AI questions from slides ----------

  // Adds the slide each AI-generated question comes from, and whether AI generation is available.
  function withAi(detail) {
    const sources = new Map(all(
      `SELECT s.* FROM question_sources s JOIN questions q ON q.id = s.question_id
       JOIN topics t ON t.id = q.topic_id WHERE t.exam_id = ?`, detail.id,
    ).map((s) => [s.question_id, { materialId: s.material_id, filename: s.filename, slide: s.slide, quote: s.quote }]));
    for (const topic of detail.topics) {
      for (const q of topic.questions) q.source = sources.get(q.id) || null;
    }
    return { ...detail, ai: { enabled: ai.enabled, model: ai.model, label: ai.label } };
  }

  const generating = new Set();

  route('POST', '/api/exams/:id/generate', async ({ user, params, body }) => {
    const exam = ownExam(user, params.id);
    const count = body.count === undefined ? COUNT.default : body.count;
    if (!Number.isInteger(count) || count < COUNT.min || count > COUNT.max) {
      throw new HttpError(400, `За раз можна згенерувати ${COUNT.min}–${COUNT.max} питань`);
    }
    const topics = all('SELECT id, name FROM topics WHERE exam_id = ? ORDER BY id', exam.id);
    const materials = all('SELECT id, filename, data FROM materials WHERE exam_id = ? ORDER BY id', exam.id);
    if (!materials.length) throw new HttpError(400, 'Спершу завантажте слайди лекцій');
    if (generating.has(user.id)) throw new HttpError(409, 'Питання вже генеруються. Зачекайте, доки закінчиться.');
    const { runs } = one('SELECT COUNT(*) AS runs FROM ai_runs WHERE user_id = ? AND created_at > ?', user.id, now() - DAY);
    if (runs >= AI_RUNS_PER_DAY) throw new HttpError(429, `Генерувати питання можна ${AI_RUNS_PER_DAY} разів на день. Спробуйте завтра.`);

    const existing = examQuestions(exam.id);
    generating.add(user.id);
    let result;
    try {
      result = await ai.generateQuestions({
        examTitle: exam.title,
        count,
        topics: topics.map((t) => ({ ...t, existing: existing.filter((q) => q.topicId === t.id).map((q) => q.prompt) })),
        materials,
      });
    } finally {
      generating.delete(user.id);
    }
    run('INSERT INTO ai_runs (user_id, created_at) VALUES (?, ?)', user.id, now());

    const filenames = new Map(materials.map((m) => [m.id, m.filename]));
    // The model names the topics; a name the exam does not have yet becomes a new topic.
    const topicIds = new Map(topics.map((t) => [t.name.toLowerCase(), t.id]));
    const topicFor = (name) => {
      const key = name.toLowerCase();
      if (!topicIds.has(key)) {
        topicIds.set(key, Number(run('INSERT INTO topics (exam_id, name) VALUES (?, ?)', exam.id, name).lastInsertRowid));
      }
      return topicIds.get(key);
    };
    db.exec('BEGIN');
    try {
      for (const q of result.questions) {
        const { lastInsertRowid } = run(
          'INSERT INTO questions (topic_id, prompt, options, answer_index) VALUES (?, ?, ?, ?)',
          topicFor(q.topic), q.prompt, JSON.stringify(q.options), q.answerIndex,
        );
        run(
          'INSERT INTO question_sources (question_id, material_id, filename, slide, quote) VALUES (?, ?, ?, ?, ?)',
          lastInsertRowid, q.materialId, filenames.get(q.materialId), q.slide, q.quote,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { ...withAi(examDetail(exam)), added: result.questions.length, skipped: result.skipped };
  });

  // ---------- request handling ----------

  async function serveStatic(pathname, res) {
    const file = STATIC[pathname];
    if (!file) throw new HttpError(404, 'Не знайдено');
    const body = await readFile(new URL(`../public/${file[0]}`, import.meta.url));
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
    res.end(body);
  }

  async function handler(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не підтримується');
        const feed = /^\/cal\/([a-f0-9]{64})\.ics$/.exec(pathname);
        if (feed) return serveCalendar(feed[1], req, res);
        return await serveStatic(pathname, res);
      }
      const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!match) throw new HttpError(404, 'Не знайдено');
      const params = Object.fromEntries(
        Object.entries(match.re.exec(pathname).groups || {}).map(([k, v]) => [k, Number(v)]),
      );
      const user = match.auth === 'extension' ? extensionUser(req) : currentUser(req);
      if (match.auth && !user) throw new HttpError(401, match.auth === 'extension' ? 'Розширення не під’єднане' : 'Увійдіть у свій акаунт');
      const body = ['POST', 'PUT'].includes(req.method) || match.withBody ? await readJson(req, match.limit) : {};
      const result = await match.fn({ req, res, user, params, body });
      if (!res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Щось пішло не так' });
    }
  }

  // ---------- background jobs ----------

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
  async function handleTelegramButton(query) {
    const chatId = query.message?.chat?.id;
    const user = chatId != null && one('SELECT * FROM users WHERE tg_chat_id = ?', String(chatId));
    const key = /^done:(d\d+)$/.exec(query.data || '')?.[1];
    let answer = 'Цього дедлайну вже немає на вашій дошці.';
    if (!user) answer = 'Цей чат більше не прив’язаний до Dueboard.';
    else if (key) {
      try {
        markDone(user, key, true);
        answer = 'Позначено як виконане ✅';
        await telegram.editMessage(String(chatId), query.message.message_id, `${query.message.text}\n\n✅ Виконано`);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error('Telegram done button failed:', err.message);
      }
    }
    await telegram.answerButton(query.id, answer);
  }

  async function handleTelegramUpdate(update) {
    if (update.callback_query) return handleTelegramButton(update.callback_query);
    const message = update.message;
    if (!message?.chat || typeof message.text !== 'string') return;
    // Deadlines are personal: only answer in a private chat with the bot, never in group chats.
    if (message.chat.type && message.chat.type !== 'private') return;
    const chatId = String(message.chat.id);
    const reply = (text) => telegram.send(chatId, text);
    const [word = '', arg = ''] = message.text.trim().split(/\s+/);
    const command = word.toLowerCase().replace(/@\w+$/, '');
    const user = one('SELECT * FROM users WHERE tg_chat_id = ?', chatId);

    if (command === '/start' && arg) {
      const target = /^[a-f0-9]{12}$/.test(arg) && one('SELECT * FROM users WHERE tg_link_code = ?', arg);
      if (!target) return reply('Посилання застаріло. Відкрийте Dueboard → Налаштування → «Під’єднати Telegram», щоб отримати нове.');
      // One chat follows one Dueboard account.
      run('UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id != ?', chatId, target.id);
      run('UPDATE users SET tg_chat_id = ?, tg_link_code = NULL WHERE id = ?', chatId, target.id);
      return reply(linkedText(target.username));
    }
    if (command === '/deadlines') {
      return reply(user ? deadlinesText(openItems(user), now()) : NOT_LINKED);
    }
    if (command === '/digest') {
      if (!user) return reply(NOT_LINKED);
      const on = !user.tg_digest;
      run('UPDATE users SET tg_digest = ? WHERE id = ?', on ? 1 : 0, user.id);
      return reply(on
        ? `Ранковий дайджест увімкнено. Він приходитиме о ${DIGEST_HOUR}:00, коли цього тижня щось треба здати.`
        : 'Ранковий дайджест вимкнено. Нагадування за 3 дні й за 1 день до дедлайну й далі приходитимуть. Надішліть /digest, щоб увімкнути його знову.');
    }
    if (command === '/stop') {
      if (!user) return reply(NOT_LINKED);
      run('UPDATE users SET tg_chat_id = NULL WHERE id = ?', user.id);
      return reply('Чат відв’язано, повідомлень більше не буде. Під’єднатися знову можна в Dueboard → Налаштування.');
    }
    return reply(helpText(Boolean(user)));
  }

  async function runReminders() {
    const t = now();
    for (const user of all('SELECT * FROM users WHERE tg_chat_id IS NOT NULL')) {
      const sent = new Set(
        all('SELECT item_key, kind FROM reminders_sent WHERE user_id = ?', user.id).map((r) => `${r.item_key}:${r.kind}`),
      );
      for (const { item, kind } of dueReminders(openItems(user), sent, t)) {
        const button = item.key.startsWith('d') ? { doneKey: item.key } : {};
        if (!(await sendTo(user, reminderText(item, kind), button))) break;
        run('INSERT OR IGNORE INTO reminders_sent (user_id, item_key, kind) VALUES (?, ?, ?)', user.id, item.key, kind);
        // The 1-day reminder makes the 3-day one pointless.
        if (kind === '1d') run(`INSERT OR IGNORE INTO reminders_sent (user_id, item_key, kind) VALUES (?, ?, '3d')`, user.id, item.key);
      }
    }
  }

  // Morning digest: once a day after DIGEST_HOUR (Kyiv time), only when something is due within 7 days.
  async function runDigests() {
    const t = now();
    const { date, hour } = localParts(t);
    if (hour < DIGEST_HOUR || hour >= DIGEST_HOUR + DIGEST_WINDOW) return;
    const users = all(
      `SELECT * FROM users WHERE tg_chat_id IS NOT NULL AND tg_digest = 1 AND (tg_digest_on IS NULL OR tg_digest_on != ?)`, date,
    );
    for (const user of users) {
      const message = digestText(openItems(user), t);
      if (message && !(await sendTo(user, message))) continue;
      run('UPDATE users SET tg_digest_on = ? WHERE id = ?', date, user.id);
    }
  }

  async function syncAll() {
    // Users with the extension connected are synced from their browser instead.
    for (const user of all('SELECT * FROM users WHERE ics_url IS NOT NULL AND ext_key_hash IS NULL')) {
      try {
        await syncMoodle(user);
      } catch (err) {
        console.error(`Moodle sync for ${user.username} failed:`, err.message);
      }
    }
  }

  return { handler, handleTelegramUpdate, runReminders, runDigests, syncAll };
}

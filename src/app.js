// node:crypto is needed for password hashing and session tokens; node:fs to serve the page files.
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseIcs } from './ics.js';
import { urgency, DAY } from './urgency.js';
import {
  dueReminders, reminderText, parseReminders, supersededBy, REMINDER_WINDOWS,
} from './reminders.js';
import { buildPlan, localDate } from './plan.js';
import { scoreDiagnostic } from './diagnostic.js';
import { HttpError, text, link, timestamp } from './validate.js';
import { createAi, COUNT } from './ai.js';
import { createLimiter, clientIp } from './limiter.js';
import { buildCalendar } from './ics-export.js';
import { safeFetch } from './safe-fetch.js';
import {
  NOT_LINKED, DIGEST_HOUR, DIGEST_WINDOW, localParts, deadlinesText, digestText, groupDeadlineText, linkedText, helpText, digestOffText,
  kyivToMs, draftText, FORWARD_HINT,
} from './bot.js';

const MAX_JSON = 64 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_UPLOAD_BODY = Math.ceil(MAX_FILE * 4 / 3) + 4096;
const MAX_FEED = 5 * 1024 * 1024;
const MAX_BIG_BODIES = 4;
const SESSION_TTL = 30 * DAY;
// Dueboard Prep: the whole exam prep section, 149 грн for 30 days. Payments are a demo with test cards only.
const PREMIUM = { price: 149, days: 30 };
const PAID_API = /^\/api\/(exams|topics|questions|problems|materials)(\/|$)/;
// The bank's answer for each test card. Real card numbers never reach the server: the page sends only which test card it was.
const TEST_CARDS = {
  success: { last4: '4242', ok: true },
  declined: { last4: '0002', ok: false, reason: 'Банк відхилив оплату. Спробуйте іншу картку.' },
  funds: { last4: '9995', ok: false, reason: 'Недостатньо коштів на картці.' },
};
const AI_RUNS_PER_DAY = 10;
const AI_EXPLAINS_PER_DAY = 100;
const AI_PARSES_PER_DAY = 50;
const RESET_TTL = 15 * 60 * 1000;
const RESET_TRIES = 5;
const RESET_FAILS_PER_DAY = 10;
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
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; "
    + "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
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

// storageLimit: bytes of uploaded files one user may keep, across all their exams.
export function createApp({
  db, now = () => Date.now(), fetchImpl = safeFetch, telegram, secureCookies = false, ai = createAi(),
  storageLimit = 100 * 1024 * 1024, paywall = false, teamChatId = null,
}) {
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
    // Manual Moodle syncs: each one makes the server download a link.
    sync: createLimiter({ limit: 10, windowMs: 10 * MINUTE, now }),
    groupJoin: createLimiter({ limit: 10, windowMs: 60 * MINUTE, now }),
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

  // ---------- routes: Dueboard Prep (demo payments) ----------

  const paymentView = (p) => ({
    id: p.id, orderRef: p.order_ref, amount: p.amount / 100, status: p.status, cardLast4: p.card_last4,
    reason: p.reason, createdAt: p.created_at, paidAt: p.paid_at, activeUntil: p.active_until,
  });

  route('GET', '/api/payments', ({ user }) =>
    all('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id).map(paymentView));

  // An order for one package. Unpaid orders older than a day are dropped, so the list stays short.
  const orderLimit = createLimiter({ limit: 20, windowMs: 60 * MINUTE, now });
  route('POST', '/api/payments', ({ user, res }) => {
    guard(res, [orderLimit, `u${user.id}`]);
    orderLimit.hit(`u${user.id}`);
    run("DELETE FROM payments WHERE user_id = ? AND status = 'pending' AND created_at < ?", user.id, now() - DAY);
    const orderRef = `DB-${new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const { lastInsertRowid } = run(
      "INSERT INTO payments (user_id, order_ref, amount, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      user.id, orderRef, PREMIUM.price * 100, now(),
    );
    return paymentView(one('SELECT * FROM payments WHERE id = ?', lastInsertRowid));
  });

  // The demo "bank": the page says which test card was used; a paid order adds 30 days (on top of time left, if any).
  route('POST', '/api/payments/:id/pay', ({ user, params, body }) => {
    const payment = one('SELECT * FROM payments WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!payment) throw new HttpError(404, 'Замовлення не знайдено');
    if (payment.status !== 'pending') throw new HttpError(409, 'Це замовлення вже оброблено. Почніть нове.');
    const card = Object.hasOwn(TEST_CARDS, body.card) ? TEST_CARDS[body.card] : null;
    if (!card) throw new HttpError(400, 'Це демо-оплата: приймаються лише тестові картки.');
    if (!card.ok) {
      run("UPDATE payments SET status = 'declined', card_last4 = ?, reason = ? WHERE id = ?", card.last4, card.reason, payment.id);
    } else {
      const fresh = one('SELECT premium_until FROM users WHERE id = ?', user.id);
      const until = Math.max(now(), fresh.premium_until || 0) + PREMIUM.days * DAY;
      run('UPDATE users SET premium_until = ? WHERE id = ?', until, user.id);
      run("UPDATE payments SET status = 'paid', card_last4 = ?, paid_at = ?, active_until = ? WHERE id = ?", card.last4, now(), until, payment.id);
    }
    return paymentView(one('SELECT * FROM payments WHERE id = ?', payment.id));
  });

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
       WHERE d.removed_at IS NULL AND (d.owner_user_id = ? OR (d.group_id IS NOT NULL AND d.group_id = ?))`,
      user.id, user.id, user.id, user.group_id ?? -1,
    ).map((d) => ({
      key: `d${d.id}`, id: d.id, source: d.source, course: d.course, title: d.title, url: d.url,
      dueAt: d.due_at, note: d.note || '', done: d.done_at != null,
      canDelete: d.source !== 'moodle' && (d.created_by === user.id || (d.created_by == null && d.group_id != null)),
      canEdit: d.source !== 'moodle' && d.created_by === user.id,
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
         course = excluded.course, title = excluded.title, due_at = excluded.due_at, removed_at = NULL,
         url = CASE WHEN excluded.url = '' THEN deadlines.url ELSE excluded.url END`,
    );
    const existing = db.prepare('SELECT id, due_at FROM deadlines WHERE owner_user_id = ? AND uid = ?');
    db.exec('BEGIN');
    try {
      for (const ev of events) {
        let url = ev.url;
        if (!url && origin) url = `${origin}/calendar/view.php?view=day&time=${Math.floor(ev.dueAt / 1000)}`;
        const uid = ev.uid.slice(0, 500);
        const before = existing.get(user.id, uid);
        upsert.run(user.id, user.id, uid, ev.course.slice(0, 200), ev.title.slice(0, 500), url.slice(0, 2000), ev.dueAt);
        // The teacher moved the date: its reminders come again for the new one.
        if (before && before.due_at !== ev.dueAt) run('DELETE FROM reminders_sent WHERE item_key = ?', `d${before.id}`);
      }
      // A future Moodle deadline that disappeared from the feed was removed or moved in Moodle.
      // An empty feed is more likely a glitch than every assignment gone: then nothing (and no note) is deleted.
      if (origin && events.length) {
        const uids = new Set(events.map((e) => e.uid.slice(0, 500)));
        const stale = all(
          `SELECT id, uid FROM deadlines WHERE owner_user_id = ? AND source = 'moodle' AND due_at > ? AND removed_at IS NULL`, user.id, t,
        ).filter((d) => !uids.has(d.uid));
        // Hidden, not deleted: a teacher who hides an assignment for a while brings it back with the student's note.
        for (const d of stale) run('UPDATE deadlines SET removed_at = ? WHERE id = ?', t, d.id);
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
    try {
      const imported = await downloadMoodle(user);
      run('UPDATE users SET last_sync_at = ?, sync_error = NULL WHERE id = ?', now(), user.id);
      return imported;
    } catch (err) {
      run('UPDATE users SET sync_error = ? WHERE id = ?', err instanceof HttpError ? err.message : 'Щось пішло не так', user.id);
      throw err;
    }
  }

  async function downloadMoodle(user) {
    let body;
    try {
      const res = await fetchImpl(user.ics_url, { signal: AbortSignal.timeout(15_000), maxBytes: MAX_FEED });
      const cloudflareBlock = !res.ok && /cloudflare/i.test(res.headers.get('server') || '');
      if (res.headers.get('cf-mitigated') === 'challenge' || cloudflareBlock) {
        throw new HttpError(502, BOT_WALL_MESSAGE);
      }
      if (!res.ok) throw new HttpError(502, `Moodle відповів зі статусом ${res.status}`);
      body = await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err.code === 'BLOCKED_ADDRESS') throw new HttpError(400, 'Посилання має вести на сайт в інтернеті, а не на внутрішню адресу');
      throw new HttpError(502, 'Не вдалося відкрити посилання на календар');
    }
    if (body.length > MAX_FEED) throw new HttpError(502, 'Календар завеликий');
    if (!/BEGIN:VCALENDAR/i.test(body)) throw new HttpError(502, 'За цим посиланням немає календаря');
    return importEvents(user, parseIcs(body), new URL(user.ics_url).origin);
  }

  // ---------- prep ----------

  const storageUsed = (user) => one(
    'SELECT COALESCE(SUM(m.size), 0) AS used FROM materials m JOIN exams e ON e.id = m.exam_id WHERE e.user_id = ?', user.id,
  ).used;

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
    ).map((q) => ({
      id: q.id, topicId: q.topic_id, prompt: q.prompt, options: JSON.parse(q.options), answerIndex: q.answer_index,
      explanation: q.explanation || '',
    }));
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
    // Every attempt, oldest first, so the page can show the trend; the last one drives the plan.
    const attempts = all('SELECT * FROM attempts WHERE exam_id = ? ORDER BY id', exam.id).map((a) => {
      const byTopic = JSON.parse(a.result);
      return {
        takenAt: a.created_at,
        correct: byTopic.reduce((n, t) => n + t.correct, 0),
        total: byTopic.reduce((n, t) => n + t.total, 0),
        topics: byTopic,
        wrong: JSON.parse(a.wrong || '[]'),
      };
    });
    const last = attempts.at(-1);
    const result = last ? { takenAt: last.takenAt, topics: last.topics } : null;
    // Mistakes of the last attempt that are still in the exam (a question may have been deleted since).
    const questionIds = new Set(questions.map((q) => q.id));
    const mistakes = last ? last.wrong.filter((id) => questionIds.has(id)) : [];
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
      history: attempts.map(({ takenAt, correct, total, topics: byTopic }) => ({ takenAt, correct, total, topics: byTopic })),
      mistakes,
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
    startSession(res, Number(created.lastInsertRowid));
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

  // A new password signs out every other device: whoever knew the old one loses access, including through an
  // extension key or a Telegram link code they made while signed in. (The extension connects again in Settings.)
  async function setPassword(userId, password, res) {
    run(`UPDATE users SET pass_hash = ?, reset_hash = NULL, reset_expires = NULL, reset_tries = 0, reset_fails = 0,
         ext_key_hash = NULL, tg_link_code = NULL WHERE id = ?`,
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
      const questions = examQuestions(exam.id);
      const problems = all('SELECT p.* FROM problems p JOIN topics t ON t.id = p.topic_id WHERE t.exam_id = ? ORDER BY p.id', exam.id);
      return {
        id: exam.id, title: exam.title, course: exam.course, theme: exam.theme, examAt: iso(exam.exam_at), note: notes.get(`e${exam.id}`) || '',
        topics: topics.map((t) => ({
          id: t.id,
          name: t.name,
          questions: questions.filter((q) => q.topicId === t.id).map((q) => ({
            id: q.id, prompt: q.prompt, options: q.options, answerIndex: q.answerIndex, source: sources.get(q.id) || null,
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
      },
      deadlines: boardItems(user).filter((item) => item.source !== 'exam').map((item) => ({
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
      await sendTo(user, `🔑 Код для відновлення пароля Dueboard: ${code}\nВін діє 15 хвилин. Якщо це не ви, просто проігноруйте повідомлення: пароль не зміниться.`);
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
    return me(one('SELECT * FROM users WHERE id = ?', user.id));
  });

  // ---------- routes: groups ----------

  route('POST', '/api/group', ({ user, body }) => {
    const name = text(body.name, 'Назва групи', { max: 80 });
    const code = randomBytes(6).toString('hex').toUpperCase();
    const { lastInsertRowid } = run('INSERT INTO study_groups (name, join_code) VALUES (?, ?)', name, code);
    run('UPDATE users SET group_id = ? WHERE id = ?', Number(lastInsertRowid), user.id);
    return { name, code };
  });

  route('POST', '/api/group/join', ({ user, body, res }) => {
    const code = text(body.code, 'Код групи', { max: 16 }).toUpperCase();
    // Wrong codes are limited, so codes cannot be guessed until one opens someone's group.
    guard(res, [limits.groupJoin, String(user.id)]);
    const group = one('SELECT * FROM study_groups WHERE join_code = ?', code);
    if (!group) {
      limits.groupJoin.hit(String(user.id));
      throw new HttpError(404, 'Групи з таким кодом немає');
    }
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

  // A deadline the user adds, for themselves or (shared) for their whole group; from the site or the bot.
  function addDeadline(user, { title, course, url, dueAt }, shared) {
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
  }

  route('POST', '/api/deadlines', ({ user, body }) => addDeadline(user, deadlineFields(body), body.shared === true));

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
      `DELETE FROM deadlines WHERE id = ? AND source != 'moodle'
         AND (created_by = ? OR (created_by IS NULL AND group_id IS NOT NULL))
         AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))`,
      params.id, user.id, user.id, user.group_id ?? -1,
    );
    if (!changes) throw new HttpError(404, 'Дедлайн не знайдено');
    // A group deadline whose author deleted their account can be removed by any member.
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

  route('POST', '/api/sync', async ({ user, res }) => {
    guard(res, [limits.sync, String(user.id)]);
    limits.sync.hit(String(user.id));
    return { imported: await syncMoodle(user) };
  });

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
    run('UPDATE users SET last_sync_at = ?, sync_error = NULL WHERE id = ?', now(), user.id);
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

  // The theme is optional and only changes when the request sends it, so older clients keep it as it was.
  const themeOf = (body) => (body.theme === undefined ? undefined : text(body.theme, 'Тема екзамену', { max: 1000, required: false }));
  function saveTheme(examId, theme) {
    if (theme !== undefined) run('UPDATE exams SET theme = ? WHERE id = ?', theme, examId);
  }

  // Full course names the student already has (Moodle, own and group deadlines, exams), for the course field hints.
  route('GET', '/api/courses', ({ user }) => all(
    `SELECT course FROM deadlines
     WHERE removed_at IS NULL AND course != '' AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))
     UNION SELECT course FROM exams WHERE user_id = ? AND course != ''
     ORDER BY course`,
    user.id, user.group_id ?? -1, user.id,
  ).map((r) => r.course));

  route('POST', '/api/exams', ({ user, body }) => {
    const { title, course, examAt } = examFields(body);
    const theme = themeOf(body);
    const { lastInsertRowid } = run('INSERT INTO exams (user_id, course, title, exam_at) VALUES (?, ?, ?, ?)', user.id, course, title, examAt);
    saveTheme(Number(lastInsertRowid), theme);
    return { id: Number(lastInsertRowid) };
  });

  route('GET', '/api/exams/:id', ({ user, params }) => {
    const exam = ownExam(user, params.id);
    return {
      ...withAi(examDetail(exam)),
      theme: exam.theme,
      storage: { used: storageUsed(user), limit: storageLimit },
    };
  });

  route('PUT', '/api/exams/:id', ({ user, params, body }) => {
    const exam = ownExam(user, params.id);
    const { title, course, examAt } = examFields(body);
    saveTheme(exam.id, themeOf(body));
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
      throw new HttpError(400, 'Питанню потрібно від 2 до 6 варіантів відповіді');
    }
    const options = body.options.map((o, i) => text(o, `Варіант ${i + 1}`, { max: 300 }));
    if (!Number.isInteger(body.answerIndex) || body.answerIndex < 0 || body.answerIndex >= options.length) {
      throw new HttpError(400, 'Вкажіть правильний варіант');
    }
    const explanation = text(body.explanation, 'Пояснення', { max: 1000, required: false });
    return { prompt, options, answerIndex: body.answerIndex, explanation };
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
    const { prompt, options, answerIndex, explanation } = questionFields(body);
    const { lastInsertRowid } = run(
      'INSERT INTO questions (topic_id, prompt, options, answer_index, explanation) VALUES (?, ?, ?, ?, ?)',
      params.id, prompt, JSON.stringify(options), answerIndex, explanation || null,
    );
    return { id: Number(lastInsertRowid) };
  });

  // Editing keeps the question's topic; moving it is topicId (another topic of the same exam).
  route('PUT', '/api/questions/:id', ({ user, params, body }) => {
    const question = ownItem(user, 'questions', params.id, 'Питання не знайдено');
    const { prompt, options, answerIndex, explanation } = questionFields(body);
    // An explanation sent along is kept; otherwise one for a changed question or answer is dropped, as it may be wrong now.
    const changed = prompt !== question.prompt || JSON.stringify(options) !== question.options || answerIndex !== question.answer_index;
    const newExplanation = body.explanation !== undefined ? explanation || null : (changed ? null : question.explanation);
    let topicId = question.topic_id;
    if (body.topicId !== undefined && body.topicId !== topicId) {
      const target = Number.isInteger(body.topicId) && ownTopic(user, body.topicId);
      const current = one('SELECT exam_id FROM topics WHERE id = ?', topicId);
      if (!target || target.exam_id !== current.exam_id) throw new HttpError(400, 'Тему не знайдено');
      topicId = target.id;
    }
    run('UPDATE questions SET topic_id = ?, prompt = ?, options = ?, answer_index = ?, explanation = ? WHERE id = ?',
      topicId, prompt, JSON.stringify(options), answerIndex, newExplanation, params.id);
    return { ok: true };
  });

  // Why the right answer is right, for a question without an explanation: the AI writes one once, then it is kept.
  route('POST', '/api/questions/:id/explain', async ({ user, params }) => {
    const question = ownItem(user, 'questions', params.id, 'Питання не знайдено');
    if (question.explanation) return { explanation: question.explanation };
    if (!ai.enabled) throw new HttpError(503, 'AI-пояснення на цьому сервері не налаштовані');
    const { used } = one('SELECT COUNT(*) AS used FROM ai_explains WHERE user_id = ? AND created_at > ?', user.id, now() - DAY);
    if (used >= AI_EXPLAINS_PER_DAY) throw new HttpError(429, `Пояснень можна отримати ${AI_EXPLAINS_PER_DAY} на день. Спробуйте завтра.`);
    run('INSERT INTO ai_explains (user_id, created_at) VALUES (?, ?)', user.id, now());
    const quote = one('SELECT quote FROM question_sources WHERE question_id = ?', question.id)?.quote || '';
    const explanation = await ai.explainQuestion({
      prompt: question.prompt, options: JSON.parse(question.options), answerIndex: question.answer_index, quote,
    });
    // The question may have been edited while the AI was writing; keep the explanation only if it still fits.
    run('UPDATE questions SET explanation = ? WHERE id = ? AND explanation IS NULL AND prompt = ? AND options = ? AND answer_index = ?',
      explanation, question.id, question.prompt, question.options, question.answer_index);
    return { explanation };
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
    if (storageUsed(user) + data.length > storageLimit) {
      throw new HttpError(413, `Місце для файлів закінчилося (${Math.round(storageLimit / 1024 / 1024)} МБ на акаунт). Видаліть старі файли, які вже не потрібні.`);
    }
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
      questions: examQuestions(params.id).map(({ id, topicId, prompt, options, answerIndex, explanation }) => ({
        id, topicId, topic: topics.get(topicId), prompt, options, answerIndex, explanation, source: sources.get(id) || null,
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
    const wrong = questions.filter((q) => answers[q.id] !== q.answerIndex).map((q) => q.id);
    run('INSERT INTO attempts (exam_id, created_at, result, wrong) VALUES (?, ?, ?, ?)',
      exam.id, now(), JSON.stringify(result), JSON.stringify(wrong));
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
      throw new HttpError(400, `За раз можна згенерувати від ${COUNT.min} до ${COUNT.max} питань`);
    }
    const topics = all('SELECT id, name FROM topics WHERE exam_id = ? ORDER BY id', exam.id);
    const materials = all('SELECT id, filename, data FROM materials WHERE exam_id = ? ORDER BY id', exam.id);
    if (!materials.length) throw new HttpError(400, 'Спершу завантажте слайди лекцій');
    if (generating.has(user.id)) throw new HttpError(409, 'Питання вже генеруються. Зачекайте, доки закінчиться.');
    const { runs } = one('SELECT COUNT(*) AS runs FROM ai_runs WHERE user_id = ? AND created_at > ?', user.id, now() - DAY);
    if (runs >= AI_RUNS_PER_DAY) throw new HttpError(429, `Генерувати питання можна ${AI_RUNS_PER_DAY} разів на день. Спробуйте завтра.`);

    const existing = examQuestions(exam.id);
    // Counted before the call: a run that fails (timeout, refusal) still costs the provider, so it counts too.
    run('INSERT INTO ai_runs (user_id, created_at) VALUES (?, ?)', user.id, now());
    generating.add(user.id);
    let result;
    try {
      result = await ai.generateQuestions({
        examTitle: exam.title,
        examTheme: exam.theme,
        count,
        topics: topics.map((t) => ({ ...t, existing: existing.filter((q) => q.topicId === t.id).map((q) => q.prompt) })),
        materials,
      });
    } finally {
      generating.delete(user.id);
    }

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
          'INSERT INTO questions (topic_id, prompt, options, answer_index, explanation) VALUES (?, ?, ?, ?, ?)',
          topicFor(q.topic), q.prompt, JSON.stringify(q.options), q.answerIndex, q.explanation || null,
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

  let bigBodies = 0;

  async function handler(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    // Served over HTTPS: browsers should never try plain HTTP again.
    if (secureCookies) res.setHeader('strict-transport-security', 'max-age=31536000');
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
      // Deleting one's own exams and files stays free: the privacy page promises everything can be deleted.
      if (paywall && match.auth === true && req.method !== 'DELETE' && PAID_API.test(pathname) && !premiumActive(user)) {
        throw new HttpError(402, `Підготовка до екзаменів входить у Dueboard Prep: ${PREMIUM.price} грн на ${PREMIUM.days} днів.`);
      }
      const wantsBody = ['POST', 'PUT'].includes(req.method) || match.withBody;
      // A big body (an upload, a calendar) is held in memory several times over: only a few at once.
      const big = wantsBody && match.limit > MAX_JSON;
      if (big && bigBodies >= MAX_BIG_BODIES) throw new HttpError(503, 'Сервер зайнятий іншими завантаженнями. Спробуйте за хвилину.');
      if (big) bigBodies++;
      let body;
      try {
        body = wantsBody ? await readJson(req, match.limit) : {};
      } finally {
        if (big) bigBodies--;
      }
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
      addDeadline(user, { title: draft.title, course: draft.course, url: draft.url, dueAt: draft.due_at }, action === 'group');
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
        markDone(user, key, true);
        answer = 'Позначено як виконане ✅';
        await telegram.editMessage(String(chatId), query.message.message_id, `${query.message.text}\n\n✅ Виконано`);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error('Telegram done button failed:', err.message);
      }
    }
    await telegram.answerButton(query.id, answer);
  }

  // ---------- Telegram: /support to the team ----------

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
    if (!match) return;
    await telegram.send(match[1], `💬 Відповідь команди Dueboard:\n${match[2].trim().slice(0, 3000)}`);
    return telegram.send(teamChatId, `Надіслано в чат ${match[1]}.`);
  }

  async function handleTelegramUpdate(update) {
    if (update.callback_query) return handleTelegramButton(update.callback_query);
    const message = update.message;
    // A forwarded photo or file carries its words in the caption.
    const body = typeof message?.text === 'string' ? message.text : message?.caption;
    if (!message?.chat || typeof body !== 'string') return;
    // The team's chat answers a /support message with "/reply <chat id> text".
    if (teamChatId && String(message.chat.id) === String(teamChatId)) return handleTeamReply(body);
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
      return reply(user ? deadlinesText(openItems(user), now()) : NOT_LINKED);
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
        fields = deadlineFields({ title: d.title, course: d.course, url: d.url, dueAt });
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

  async function runReminders() {
    const t = now();
    for (const user of all('SELECT * FROM users WHERE tg_chat_id IS NOT NULL')) {
      const sent = new Set(
        all('SELECT item_key, kind FROM reminders_sent WHERE user_id = ?', user.id).map((r) => `${r.item_key}:${r.kind}`),
      );
      // One user's bad row (or an account deleted meanwhile) must not stop everyone after them.
      try {
        for (const { item, kind } of dueReminders(openItems(user), sent, t, parseReminders(user.tg_remind))) {
          const button = item.key.startsWith('d') ? { doneKey: item.key } : {};
          if (!(await sendTo(user, reminderText(item, kind), button))) break;
          run('INSERT OR IGNORE INTO reminders_sent (user_id, item_key, kind) VALUES (?, ?, ?)', user.id, item.key, kind);
          // A later reminder makes the earlier ones pointless (the 1-day one replaces a missed 3-day one).
          for (const earlier of supersededBy(kind)) {
            run('INSERT OR IGNORE INTO reminders_sent (user_id, item_key, kind) VALUES (?, ?, ?)', user.id, item.key, earlier);
          }
        }
      } catch (err) {
        console.error(`Reminders for ${user.username} failed:`, err.message);
      }
    }
  }

  // Today's step of every coming exam's plan that has topics (date: 'YYYY-MM-DD' in Kyiv).
  function todaysStudy(user, date) {
    return all('SELECT * FROM exams WHERE user_id = ? AND exam_at > ? ORDER BY exam_at', user.id, now())
      .map((exam) => ({ exam, detail: examDetail(exam) }))
      .filter(({ detail }) => detail.topics.length)
      .map(({ exam, detail }) => ({ exam, step: detail.plan.find((d) => d.date === date) }))
      .filter(({ step }) => step)
      .map(({ exam, step }) => ({ exam: exam.title, examAt: exam.exam_at, focus: step.focus, topics: step.topics }));
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
      try {
        const message = digestText(openItems(user), t, todaysStudy(user, date));
        if (message && !(await sendTo(user, message))) continue;
        run('UPDATE users SET tg_digest_on = ? WHERE id = ?', date, user.id);
      } catch (err) {
        console.error(`Digest for ${user.username} failed:`, err.message);
      }
    }
  }

  // Hourly housekeeping: rows that only ever grow and are no longer needed.
  function cleanup() {
    const t = now();
    // A Moodle deadline hidden for 60 days is not coming back: now it goes, with its notes and marks.
    for (const { id } of all('SELECT id FROM deadlines WHERE removed_at IS NOT NULL AND removed_at <= ?', t - 60 * DAY)) forgetDeadline(id);
    run('DELETE FROM sessions WHERE expires_at <= ?', t);
    run('DELETE FROM ai_runs WHERE created_at <= ?', t - DAY);
    run('DELETE FROM ai_explains WHERE created_at <= ?', t - DAY);
    run('DELETE FROM ai_parses WHERE created_at <= ?', t - DAY);
    // A found deadline nobody added in two days is not coming.
    run('DELETE FROM tg_drafts WHERE created_at <= ?', t - 2 * DAY);
    run('UPDATE users SET reset_hash = NULL, reset_expires = NULL, reset_tries = 0 WHERE reset_expires <= ?', t);
    // Reminder marks for deadlines and exams that are gone or a week past: no reminder can come for them any more.
    run(`DELETE FROM reminders_sent WHERE
      (item_key LIKE 'd%' AND CAST(substr(item_key, 2) AS INTEGER) NOT IN (SELECT id FROM deadlines WHERE due_at > ?))
      OR (item_key LIKE 'e%' AND CAST(substr(item_key, 2) AS INTEGER) NOT IN (SELECT id FROM exams WHERE exam_at > ?))`,
    t - 7 * DAY, t - 7 * DAY);
  }

  async function syncAll() {
    // Users with the extension connected are synced from their browser instead.
    for (const { id } of all('SELECT id FROM users WHERE ics_url IS NOT NULL AND ext_key_hash IS NULL')) {
      // Read the row now, not at the start: the link may have changed (or the account gone) while others synced.
      const user = one('SELECT * FROM users WHERE id = ? AND ics_url IS NOT NULL AND ext_key_hash IS NULL', id);
      if (!user) continue;
      try {
        await syncMoodle(user);
      } catch (err) {
        console.error(`Moodle sync for ${user.username} failed:`, err.message);
        // Tell the student once, when a sync that used to work starts failing, not every 6 hours.
        if (!user.sync_error && user.tg_chat_id && telegram.enabled) {
          await sendTo(user, `⚠️ Не вдалося оновити ваші дедлайни з Moodle: ${err.message}\nПеревірте посилання в Dueboard → Налаштування.`);
        }
      }
    }
  }

  // A job that takes longer than its interval (slow Telegram) must not start a second copy that sends everything twice.
  const single = (job) => {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try { await job(); } finally { running = false; }
    };
  };

  return {
    handler, handleTelegramUpdate, cleanup,
    runReminders: single(runReminders), runDigests: single(runDigests), syncAll: single(syncAll),
  };
}

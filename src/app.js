// node:crypto is needed for password hashing and session tokens; node:fs to serve the page files.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseIcs } from './ics.js';
import { urgency, DAY } from './urgency.js';
import { dueReminders, reminderText } from './reminders.js';
import { buildPlan, localDate } from './plan.js';
import { scoreDiagnostic } from './diagnostic.js';
import { HttpError, text, link, timestamp } from './validate.js';
import {
  NOT_LINKED, DIGEST_HOUR, DIGEST_WINDOW, localParts, deadlinesText, digestText, groupDeadlineText, linkedText, helpText,
} from './bot.js';

const MAX_JSON = 64 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_UPLOAD_BODY = Math.ceil(MAX_FILE * 4 / 3) + 4096;
const MAX_FEED = 5 * 1024 * 1024;
const SESSION_TTL = 30 * DAY;
const BOT_WALL_MESSAGE = 'Your Moodle is behind a bot check that blocks automatic sync. '
  + 'In Moodle use Export calendar → "Export" to download the .ics file, then import it below.';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
    throw new HttpError(415, 'Expected application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request is too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function normalizeFeedUrl(value) {
  let url = text(value, 'Calendar link', { max: 2000, required: false });
  if (/^webcals?:\/\//i.test(url)) url = url.replace(/^webcals?:/i, 'https:');
  return link(url, 'Calendar link');
}

export function createApp({ db, now = () => Date.now(), fetchImpl = globalThis.fetch, telegram, secureCookies = false }) {
  // Behind HTTPS the session cookie must never travel over plain HTTP.
  const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${secureCookies ? '; Secure' : ''}`;
  const routes = [];
  const route = (method, pattern, fn, { auth = true, limit = MAX_JSON } = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>\\d+)')}$`);
    routes.push({ method, re, fn, auth, limit });
  };
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

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
    };
  }

  // ---------- board ----------

  function boardItems(user) {
    const t = now();
    const deadlines = all(
      `SELECT d.*, n.text AS note FROM deadlines d
       LEFT JOIN notes n ON n.user_id = ? AND n.item_key = 'd' || d.id
       WHERE d.owner_user_id = ? OR (d.group_id IS NOT NULL AND d.group_id = ?)`,
      user.id, user.id, user.group_id ?? -1,
    ).map((d) => ({
      key: `d${d.id}`, id: d.id, source: d.source, course: d.course, title: d.title, url: d.url,
      dueAt: d.due_at, note: d.note || '',
      canDelete: d.source !== 'moodle' && d.created_by === user.id,
    }));
    const exams = all(
      `SELECT e.*, n.text AS note FROM exams e
       LEFT JOIN notes n ON n.user_id = ? AND n.item_key = 'e' || e.id
       WHERE e.user_id = ?`,
      user.id, user.id,
    ).map((e) => ({
      key: `e${e.id}`, id: e.id, source: 'exam', course: e.course, title: e.title, url: '',
      dueAt: e.exam_at, note: e.note || '', canDelete: false,
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
        for (const d of stale) run('DELETE FROM deadlines WHERE id = ?', d.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return events.length;
  }

  async function syncMoodle(user) {
    if (!user.ics_url) throw new HttpError(400, 'Add your Moodle calendar link first');
    let body;
    try {
      const res = await fetchImpl(user.ics_url, { signal: AbortSignal.timeout(15_000) });
      const cloudflareBlock = !res.ok && /cloudflare/i.test(res.headers.get('server') || '');
      if (res.headers.get('cf-mitigated') === 'challenge' || cloudflareBlock) {
        throw new HttpError(502, BOT_WALL_MESSAGE);
      }
      if (!res.ok) throw new HttpError(502, `Moodle answered with status ${res.status}`);
      body = await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'Could not reach the calendar link');
    }
    if (body.length > MAX_FEED) throw new HttpError(502, 'The calendar is too large');
    if (!/BEGIN:VCALENDAR/i.test(body)) throw new HttpError(502, 'That link did not return a calendar');
    const imported = importEvents(user, parseIcs(body), new URL(user.ics_url).origin);
    run('UPDATE users SET last_sync_at = ? WHERE id = ?', now(), user.id);
    return imported;
  }

  // ---------- prep ----------

  function ownExam(user, id) {
    const exam = one('SELECT * FROM exams WHERE id = ? AND user_id = ?', id, user.id);
    if (!exam) throw new HttpError(404, 'Exam not found');
    return exam;
  }

  function ownTopic(user, id) {
    const topic = one(
      'SELECT t.* FROM topics t JOIN exams e ON e.id = t.exam_id WHERE t.id = ? AND e.user_id = ?', id, user.id,
    );
    if (!topic) throw new HttpError(404, 'Topic not found');
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

  route('POST', '/api/register', async ({ body, res }) => {
    const username = text(body.username, 'Username', { max: 32 });
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) throw new HttpError(400, 'Username: 3–32 letters, digits or _');
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 200) {
      throw new HttpError(400, 'Password must be at least 8 characters');
    }
    if (one('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'That username is taken');
    const { lastInsertRowid } = run('INSERT INTO users (username, pass_hash) VALUES (?, ?)', username, await hashPassword(body.password));
    startSession(res, Number(lastInsertRowid));
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/login', async ({ body, res }) => {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = one('SELECT * FROM users WHERE username = ?', username);
    const valid = await verifyPassword(password, user ? user.pass_hash : DUMMY_HASH);
    if (!user || !valid) throw new HttpError(401, 'Wrong username or password');
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

  route('PUT', '/api/settings', ({ user, body }) => {
    run('UPDATE users SET ics_url = ? WHERE id = ?', normalizeFeedUrl(body.icsUrl) || null, user.id);
    return me(one('SELECT * FROM users WHERE id = ?', user.id));
  });

  // ---------- routes: groups ----------

  route('POST', '/api/group', ({ user, body }) => {
    const name = text(body.name, 'Group name', { max: 80 });
    const code = randomBytes(4).toString('hex').toUpperCase();
    const { lastInsertRowid } = run('INSERT INTO study_groups (name, join_code) VALUES (?, ?)', name, code);
    run('UPDATE users SET group_id = ? WHERE id = ?', Number(lastInsertRowid), user.id);
    return { name, code };
  });

  route('POST', '/api/group/join', ({ user, body }) => {
    const code = text(body.code, 'Group code', { max: 16 }).toUpperCase();
    const group = one('SELECT * FROM study_groups WHERE join_code = ?', code);
    if (!group) throw new HttpError(404, 'No group with that code');
    run('UPDATE users SET group_id = ? WHERE id = ?', group.id, user.id);
    return { name: group.name, code: group.join_code };
  });

  route('POST', '/api/group/leave', ({ user }) => {
    run('UPDATE users SET group_id = NULL WHERE id = ?', user.id);
    return { ok: true };
  });

  // ---------- routes: deadlines ----------

  route('GET', '/api/deadlines', ({ user }) => ({ now: now(), items: boardItems(user) }));

  route('POST', '/api/deadlines', ({ user, body }) => {
    const title = text(body.title, 'Title');
    const course = text(body.course, 'Course', { max: 100, required: false });
    const dueAt = timestamp(body.dueAt, 'Due date');
    const url = link(body.url);
    const shared = body.shared === true;
    if (shared && !user.group_id) throw new HttpError(400, 'Join a group to share deadlines');
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

  route('DELETE', '/api/deadlines/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM deadlines WHERE id = ? AND created_by = ? AND source != 'moodle'
         AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))`,
      params.id, user.id, user.id, user.group_id ?? -1,
    );
    if (!changes) throw new HttpError(404, 'Deadline not found');
    run(`DELETE FROM notes WHERE item_key = ?`, `d${params.id}`);
    return { ok: true };
  });

  route('PUT', '/api/notes', ({ user, body }) => {
    const key = text(body.key, 'Item', { max: 24 });
    const note = text(body.text, 'Note', { max: 2000, required: false });
    if (!boardItems(user).some((item) => item.key === key)) throw new HttpError(404, 'Deadline not found');
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
    const ics = text(body.ics, 'Calendar file', { max: MAX_FEED });
    if (!/BEGIN:VCALENDAR/i.test(ics)) throw new HttpError(400, 'That is not an .ics calendar');
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
    const ics = text(body.ics, 'Calendar', { max: MAX_FEED });
    if (!/BEGIN:VCALENDAR/i.test(ics)) throw new HttpError(400, 'That is not an .ics calendar');
    const origin = user.ics_url ? new URL(user.ics_url).origin : null;
    const imported = importEvents(user, parseIcs(ics), origin);
    run('UPDATE users SET last_sync_at = ? WHERE id = ?', now(), user.id);
    return { imported };
  }, { auth: 'extension', limit: MAX_FEED + 4096 });

  // ---------- routes: telegram ----------

  route('POST', '/api/telegram/link', async ({ user }) => {
    if (!telegram.enabled) throw new HttpError(409, 'Telegram is not set up on this server (TELEGRAM_BOT_TOKEN)');
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

  route('POST', '/api/exams', ({ user, body }) => {
    const title = text(body.title, 'Exam name');
    const course = text(body.course, 'Course', { max: 100, required: false });
    const examAt = timestamp(body.examAt, 'Exam date');
    const { lastInsertRowid } = run('INSERT INTO exams (user_id, course, title, exam_at) VALUES (?, ?, ?, ?)', user.id, course, title, examAt);
    return { id: Number(lastInsertRowid) };
  });

  route('GET', '/api/exams/:id', ({ user, params }) => examDetail(ownExam(user, params.id)));

  route('DELETE', '/api/exams/:id', ({ user, params }) => {
    ownExam(user, params.id);
    run('DELETE FROM exams WHERE id = ?', params.id);
    run('DELETE FROM notes WHERE item_key = ?', `e${params.id}`);
    return { ok: true };
  });

  route('POST', '/api/exams/:id/topics', ({ user, params, body }) => {
    ownExam(user, params.id);
    const name = text(body.name, 'Topic', { max: 120 });
    const { lastInsertRowid } = run('INSERT INTO topics (exam_id, name) VALUES (?, ?)', params.id, name);
    return { id: Number(lastInsertRowid), name };
  });

  route('DELETE', '/api/topics/:id', ({ user, params }) => {
    ownTopic(user, params.id);
    run('DELETE FROM topics WHERE id = ?', params.id);
    return { ok: true };
  });

  route('POST', '/api/topics/:id/questions', ({ user, params, body }) => {
    ownTopic(user, params.id);
    const prompt = text(body.prompt, 'Question', { max: 1000 });
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 6) {
      throw new HttpError(400, 'A question needs 2–6 answer options');
    }
    const options = body.options.map((o, i) => text(o, `Option ${i + 1}`, { max: 300 }));
    if (!Number.isInteger(body.answerIndex) || body.answerIndex < 0 || body.answerIndex >= options.length) {
      throw new HttpError(400, 'Pick which option is correct');
    }
    const { lastInsertRowid } = run(
      'INSERT INTO questions (topic_id, prompt, options, answer_index) VALUES (?, ?, ?, ?)',
      params.id, prompt, JSON.stringify(options), body.answerIndex,
    );
    return { id: Number(lastInsertRowid) };
  });

  route('DELETE', '/api/questions/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM questions WHERE id = ? AND topic_id IN
         (SELECT t.id FROM topics t JOIN exams e ON e.id = t.exam_id WHERE e.user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Question not found');
    return { ok: true };
  });

  route('POST', '/api/topics/:id/problems', ({ user, params, body }) => {
    ownTopic(user, params.id);
    const problem = text(body.text, 'Practice problem', { max: 4000 });
    const { lastInsertRowid } = run('INSERT INTO problems (topic_id, text) VALUES (?, ?)', params.id, problem);
    return { id: Number(lastInsertRowid) };
  });

  route('DELETE', '/api/problems/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM problems WHERE id = ? AND topic_id IN
         (SELECT t.id FROM topics t JOIN exams e ON e.id = t.exam_id WHERE e.user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Problem not found');
    return { ok: true };
  });

  route('POST', '/api/exams/:id/materials', ({ user, params, body }) => {
    ownExam(user, params.id);
    const filename = text(body.filename, 'File name', { max: 200 }).replace(/[\r\n"\\/]/g, '_');
    if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
      throw new HttpError(400, 'File data must be base64');
    }
    const data = Buffer.from(body.data, 'base64');
    if (!data.length) throw new HttpError(400, 'The file is empty');
    if (data.length > MAX_FILE) throw new HttpError(413, 'Files are limited to 10 MB');
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
    if (!material) throw new HttpError(404, 'File not found');
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
    if (!changes) throw new HttpError(404, 'File not found');
    return { ok: true };
  });

  route('GET', '/api/exams/:id/test', ({ user, params }) => {
    ownExam(user, params.id);
    const topics = new Map(all('SELECT id, name FROM topics WHERE exam_id = ?', params.id).map((t) => [t.id, t.name]));
    return {
      questions: examQuestions(params.id).map(({ id, topicId, prompt, options }) => ({
        id, topic: topics.get(topicId), prompt, options,
      })),
    };
  });

  route('POST', '/api/exams/:id/test', ({ user, params, body }) => {
    const exam = ownExam(user, params.id);
    const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    const questions = examQuestions(exam.id);
    if (!questions.length) throw new HttpError(400, 'Add some questions first');
    const topics = all('SELECT id, name FROM topics WHERE exam_id = ? ORDER BY id', exam.id);
    const result = scoreDiagnostic(topics, questions, answers);
    run('INSERT INTO attempts (exam_id, created_at, result) VALUES (?, ?, ?)', exam.id, now(), JSON.stringify(result));
    return examDetail(exam);
  });

  // ---------- request handling ----------

  async function serveStatic(pathname, res) {
    const file = STATIC[pathname];
    if (!file) throw new HttpError(404, 'Not found');
    const body = await readFile(new URL(`../public/${file[0]}`, import.meta.url));
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
    res.end(body);
  }

  async function handler(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return await serveStatic(pathname, res);
      }
      const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!match) throw new HttpError(404, 'Not found');
      const params = Object.fromEntries(
        Object.entries(match.re.exec(pathname).groups || {}).map(([k, v]) => [k, Number(v)]),
      );
      const user = match.auth === 'extension' ? extensionUser(req) : currentUser(req);
      if (match.auth && !user) throw new HttpError(401, match.auth === 'extension' ? 'Extension is not connected' : 'Please log in');
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req, match.limit) : {};
      const result = await match.fn({ req, res, user, params, body });
      if (!res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong' });
    }
  }

  // ---------- background jobs ----------

  // Sends to a linked chat; a chat that blocked the bot (403) is unlinked so we stop writing to it.
  async function sendTo(user, message) {
    try {
      await telegram.send(user.tg_chat_id, message);
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

  async function handleTelegramUpdate(update) {
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
      if (!target) return reply('That link has expired. Open Dueboard → Settings → "Connect Telegram" to get a new one.');
      // One chat follows one Dueboard account.
      run('UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id != ?', chatId, target.id);
      run('UPDATE users SET tg_chat_id = ?, tg_link_code = NULL WHERE id = ?', chatId, target.id);
      return reply(linkedText(target.username));
    }
    if (command === '/deadlines') {
      return reply(user ? deadlinesText(boardItems(user), now()) : NOT_LINKED);
    }
    if (command === '/digest') {
      if (!user) return reply(NOT_LINKED);
      const on = !user.tg_digest;
      run('UPDATE users SET tg_digest = ? WHERE id = ?', on ? 1 : 0, user.id);
      return reply(on
        ? `Morning digest is on. You'll get it at ${DIGEST_HOUR}:00 when something is due that week.`
        : 'Morning digest is off. Reminders 3 days and 1 day before each deadline still come. Send /digest to turn it back on.');
    }
    if (command === '/stop') {
      if (!user) return reply(NOT_LINKED);
      run('UPDATE users SET tg_chat_id = NULL WHERE id = ?', user.id);
      return reply('Unlinked. You will not get any more messages. Connect again from Dueboard → Settings.');
    }
    return reply(helpText(Boolean(user)));
  }

  async function runReminders() {
    const t = now();
    for (const user of all('SELECT * FROM users WHERE tg_chat_id IS NOT NULL')) {
      const sent = new Set(
        all('SELECT item_key, kind FROM reminders_sent WHERE user_id = ?', user.id).map((r) => `${r.item_key}:${r.kind}`),
      );
      for (const { item, kind } of dueReminders(boardItems(user), sent, t)) {
        if (!(await sendTo(user, reminderText(item, kind)))) break;
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
      const message = digestText(boardItems(user), t);
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

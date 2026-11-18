import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { DAY, HOUR } from '../src/urgency.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

const FEED = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:1@moodle.example',
  'SUMMARY:Lab 3 is due',
  `DTSTART:${icsStamp(NOW + 30 * HOUR)}`,
  'CATEGORIES:OOP',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function icsStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function start(options = {}) {
  const sent = [];
  const telegram = {
    enabled: true,
    botName: async () => 'dueboard_test_bot',
    send: async (chatId, text, options = {}) => { sent.push({ chatId, text, ...options }); },
    editMessage: async (chatId, messageId, text) => { sent.push({ chatId, messageId, text, edited: true }); },
    answerButton: async (queryId, text) => { sent.push({ queryId, text, answer: true }); },
  };
  const app = createApp({ db: openDb(':memory:'), now: () => NOW, telegram, ...options });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { app, sent, base, close };
}

function client(base) {
  let cookie = '';
  return async (method, path, body) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const isJson = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, data: isJson ? await res.json() : await res.text(), headers: res.headers };
  };
}

async function signedUp(base, username) {
  const call = client(base);
  const res = await call('POST', '/api/register', { username, password: 'correct horse' });
  assert.equal(res.status, 200);
  return call;
}

test('accounts: register, log in, reject bad input and anonymous access', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const anon = client(base);
  assert.equal((await anon('GET', '/api/deadlines')).status, 401);
  assert.equal((await anon('POST', '/api/register', { username: 'a', password: 'correct horse' })).status, 400);
  assert.equal((await anon('POST', '/api/register', { username: 'mykola', password: 'short' })).status, 400);

  const mykola = await signedUp(base, 'mykola');
  assert.equal((await mykola('GET', '/api/me')).data.username, 'mykola');
  assert.equal((await anon('POST', '/api/register', { username: 'MYKOLA', password: 'correct horse' })).status, 409);

  assert.equal((await anon('POST', '/api/login', { username: 'mykola', password: 'wrong password' })).status, 401);
  assert.equal((await anon('POST', '/api/login', { username: 'mykola', password: 'correct horse' })).status, 200);
  assert.equal((await anon('GET', '/api/me')).status, 200);

  await anon('POST', '/api/logout', {});
  assert.equal((await anon('GET', '/api/me')).status, 401);
});

test('mutating requests must be JSON', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=x&password=y',
  });
  assert.equal(res.status, 415);
});

test('board: personal vs group deadlines, per-user notes, urgency and delete rights', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const maryan = await signedUp(base, 'maryan');
  const outsider = await signedUp(base, 'outsider');

  const group = (await mykola('POST', '/api/group', { name: 'PZ-2' })).data;
  assert.match(group.code, /^[A-F0-9]{12}$/);
  assert.equal((await maryan('POST', '/api/group/join', { code: group.code.toLowerCase() })).status, 200);
  assert.equal((await outsider('POST', '/api/group/join', { code: 'NOPE' })).status, 404);

  assert.equal((await mykola('POST', '/api/deadlines', {
    title: 'Bad link', dueAt: NOW + DAY, url: 'javascript:alert(1)',
  })).status, 400);

  await mykola('POST', '/api/deadlines', { title: 'Mine', course: 'OOP', dueAt: NOW + 10 * DAY, url: '' });
  const shared = (await mykola('POST', '/api/deadlines', {
    title: 'Announced in class', course: 'Calc', dueAt: NOW + 3 * DAY, url: 'https://example.com', shared: true,
  })).data;

  const mine = (await mykola('GET', '/api/deadlines')).data.items;
  assert.deepEqual(mine.map((i) => [i.title, i.urgency, i.source]), [
    ['Announced in class', 'amber', 'group'],
    ['Mine', 'grey', 'personal'],
  ]);
  const theirs = (await maryan('GET', '/api/deadlines')).data.items;
  assert.deepEqual(theirs.map((i) => i.title), ['Announced in class']);
  assert.equal(theirs[0].canDelete, false);
  assert.deepEqual((await outsider('GET', '/api/deadlines')).data.items, []);

  assert.equal((await maryan('PUT', '/api/notes', { key: shared.key, text: 'ask about format' })).status, 200);
  assert.equal((await outsider('PUT', '/api/notes', { key: shared.key, text: 'x' })).status, 404);
  assert.equal((await maryan('GET', '/api/deadlines')).data.items[0].note, 'ask about format');
  assert.equal((await mykola('GET', '/api/deadlines')).data.items[0].note, '');

  assert.equal((await maryan('DELETE', `/api/deadlines/${shared.id}`)).status, 404);
  assert.equal((await mykola('DELETE', `/api/deadlines/${shared.id}`)).status, 200);
  assert.deepEqual((await maryan('GET', '/api/deadlines')).data.items, []);
});

test('moodle: pasted feed and calendar link import without duplicates', async (t) => {
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); return new Response(FEED); };
  const { base, close } = await start({ fetchImpl });
  t.after(close);
  const call = await signedUp(base, 'mykola');

  assert.equal((await call('PUT', '/api/settings', { icsUrl: 'ftp://moodle.example/cal' })).status, 400);
  const link = 'webcal://moodle.example/calendar/export_execute.php?userid=1&authtoken=abc';
  assert.equal((await call('PUT', '/api/settings', { icsUrl: link })).status, 200);
  const sync = await call('POST', '/api/sync', {});
  assert.equal(sync.status, 200);
  assert.equal(sync.data.imported, 1);
  assert.equal(fetched[0], 'https://moodle.example/calendar/export_execute.php?userid=1&authtoken=abc');

  await call('POST', '/api/import-ics', { ics: FEED });
  const items = (await call('GET', '/api/deadlines')).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'moodle');
  assert.equal(items[0].course, 'OOP');
  assert.equal(items[0].urgency, 'red');
  assert.equal(items[0].url, `https://moodle.example/calendar/view.php?view=day&time=${(NOW + 30 * HOUR) / 1000}`);

  assert.equal((await call('POST', '/api/import-ics', { ics: 'hello' })).status, 400);
});

test('moodle: a Cloudflare bot check gives a clear message pointing to file import', async (t) => {
  const fetchImpl = async () => new Response('<title>Just a moment...</title>', {
    status: 403, headers: { server: 'cloudflare', 'cf-mitigated': 'challenge' },
  });
  const { base, close } = await start({ fetchImpl });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('PUT', '/api/settings', { icsUrl: 'https://learn.example/calendar/export_execute.php?userid=1&authtoken=x' });
  const sync = await call('POST', '/api/sync', {});
  assert.equal(sync.status, 502);
  assert.match(sync.data.error, /перевіркою на бота/);
  assert.match(sync.data.error, /\.ics/);
});

test('extension: scoped key reads the Moodle link and uploads the calendar', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const link = 'https://moodle.example/calendar/export_execute.php?userid=1&authtoken=abc';
  await call('PUT', '/api/settings', { icsUrl: link });

  const anon = client(base);
  assert.equal((await anon('POST', '/api/extension/key', {})).status, 401);
  const { key } = (await call('POST', '/api/extension/key', {})).data;
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal((await call('GET', '/api/me')).data.extension.connected, true);

  const ext = (method, path, body, k = key) => fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${k}`, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

  assert.deepEqual((await ext('GET', '/api/extension/config')).data, { icsUrl: link });
  assert.equal((await ext('GET', '/api/extension/config', undefined, 'f'.repeat(64))).status, 401);
  // The extension key is not a login: it cannot reach the normal API.
  assert.equal((await ext('GET', '/api/deadlines')).status, 401);

  const up = await ext('POST', '/api/extension/upload', { ics: FEED });
  assert.equal(up.status, 200);
  assert.equal(up.data.imported, 1);
  const items = (await call('GET', '/api/deadlines')).data.items;
  assert.equal(items.length, 1);
  assert.match(items[0].url, /^https:\/\/moodle\.example\/calendar\/view\.php/);
  assert.equal((await call('GET', '/api/me')).data.lastSyncAt, NOW);
  assert.equal((await ext('POST', '/api/extension/upload', { ics: 'nope' })).status, 400);

  const { key: newKey } = (await call('POST', '/api/extension/key', {})).data;
  assert.equal((await ext('GET', '/api/extension/config')).status, 401);
  assert.equal((await ext('GET', '/api/extension/config', undefined, newKey)).status, 200);

  await call('DELETE', '/api/extension/key');
  assert.equal((await ext('GET', '/api/extension/config', undefined, newKey)).status, 401);
  assert.equal((await call('GET', '/api/me')).data.extension.connected, false);
});

test('telegram: link through /start code, reminders sent once', async (t) => {
  const { app, base, sent, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('POST', '/api/deadlines', { title: 'Essay', course: 'Ethics', dueAt: NOW + 2 * DAY });

  const { code, botName } = (await call('POST', '/api/telegram/link', {})).data;
  assert.equal(botName, 'dueboard_test_bot');
  await app.handleTelegramUpdate({ message: { chat: { id: 4242 }, text: `/start ${code}` } });
  assert.equal((await call('GET', '/api/me')).data.telegram.linked, true);
  assert.equal(sent.at(-1).chatId, '4242');

  sent.length = 0;
  await app.runReminders();
  await app.runReminders();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Essay/);
  assert.match(sent[0].text, /через 3 дні/);
});

async function linkTelegram(app, call, chatId) {
  const { code } = (await call('POST', '/api/telegram/link', {})).data;
  await app.handleTelegramUpdate({ message: { chat: { id: chatId, type: 'private' }, text: `/start ${code}` } });
}

const tg = (app, chatId, text, type = 'private') => app.handleTelegramUpdate({ message: { chat: { id: chatId, type }, text } });

test('telegram: /deadlines, /digest, /stop, /help and group chats', async (t) => {
  const { app, base, sent, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('POST', '/api/deadlines', { title: 'Essay', course: 'Ethics', dueAt: NOW + 2 * DAY, url: 'https://learn.example/a/1' });
  await call('POST', '/api/deadlines', { title: 'Old lab', dueAt: NOW - DAY });

  await tg(app, 7, '/deadlines');
  assert.match(sent.at(-1).text, /не прив’язаний/);

  await linkTelegram(app, call, 7);
  assert.match(sent.at(-1).text, /прив’язано до Dueboard як mykola/);

  await tg(app, 7, '/deadlines@dueboard_test_bot');
  const list = sent.at(-1).text;
  assert.match(list, /🟡 \[Ethics\] Essay/);
  assert.match(list, /пн, 16 лист\., 14:00/, 'shown in Kyiv time (UTC+2)');
  assert.match(list, /learn\.example\/a\/1/);
  assert.doesNotMatch(list, /Old lab/);

  await tg(app, 7, '/digest');
  assert.match(sent.at(-1).text, /дайджест вимкнено/);
  assert.equal((await call('GET', '/api/me')).data.telegram.digest, false);
  await tg(app, 7, '/digest');
  assert.match(sent.at(-1).text, /дайджест увімкнено/);

  await tg(app, 7, 'hello');
  assert.match(sent.at(-1).text, /\/deadlines/);

  const before = sent.length;
  await tg(app, -100500, '/deadlines', 'group');
  assert.equal(sent.length, before, 'silent in group chats');

  await tg(app, 7, '/start deadbeef0000');
  assert.match(sent.at(-1).text, /застаріло/);

  await tg(app, 7, '/stop');
  assert.match(sent.at(-1).text, /відв’язано/);
  assert.equal((await call('GET', '/api/me')).data.telegram.linked, false);
});

test('telegram: bot texts name the reminders the user picked, or say they are off', async (t) => {
  const { app, base, sent, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');

  await linkTelegram(app, call, 7);
  assert.match(sent.at(-1).text, /Нагадування приходять за 3 дні і за 1 день до кожного дедлайну/, 'defaults');

  await call('PUT', '/api/telegram/reminders', { kinds: ['3h', '3d'] });
  await tg(app, 7, '/help');
  assert.match(sent.at(-1).text, /Нагадування приходять за 3 дні і за 3 години до кожного дедлайну/);
  assert.doesNotMatch(sent.at(-1).text, /за 1 день/);
  await tg(app, 7, '/digest');
  assert.match(sent.at(-1).text, /Нагадування за 3 дні і за 3 години до дедлайну й далі приходитимуть/);

  await call('PUT', '/api/telegram/reminders', { kinds: [] });
  await tg(app, 7, '/help');
  assert.match(sent.at(-1).text, /Нагадування про дедлайни вимкнені/);
  await tg(app, 7, '/digest');
  assert.doesNotMatch(sent.at(-1).text, /приходитимуть/);
});

test('telegram: group deadline is announced to the other linked members', async (t) => {
  const { app, base, sent, close } = await start();
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const maryan = await signedUp(base, 'maryan');
  const sviat = await signedUp(base, 'sviat');
  const { code } = (await mykola('POST', '/api/group', { name: 'CS-2' })).data;
  await maryan('POST', '/api/group/join', { code });
  await sviat('POST', '/api/group/join', { code });
  await linkTelegram(app, mykola, 1);
  await linkTelegram(app, maryan, 2);

  sent.length = 0;
  await mykola('POST', '/api/deadlines', { title: 'Team report', course: 'OOAD', dueAt: NOW + 5 * DAY, shared: true });
  await mykola('POST', '/api/deadlines', { title: 'My own thing', dueAt: NOW + 5 * DAY });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((m) => m.chatId), ['2'], 'only linked members, not the author, only shared deadlines');
  assert.match(sent[0].text, /mykola додає дедлайн для вашої групи/);
  assert.match(sent[0].text, /Team report/);
});

test('telegram: morning digest once a day in the 08:00 Kyiv window, only when something is due', async (t) => {
  let clock = Date.UTC(2026, 10, 14, 5, 30); // 07:30 Kyiv
  const { app, base, sent, close } = await start({ now: () => clock });
  t.after(close);
  const busy = await signedUp(base, 'busy');
  const idle = await signedUp(base, 'idle');
  await busy('POST', '/api/deadlines', { title: 'Essay', dueAt: clock + 3 * DAY });
  await busy('POST', '/api/deadlines', { title: 'Far away', dueAt: clock + 20 * DAY });
  await linkTelegram(app, busy, 1);
  await linkTelegram(app, idle, 2);
  sent.length = 0;

  await app.runDigests();
  assert.equal(sent.length, 0, 'too early');

  clock = Date.UTC(2026, 10, 14, 6, 5); // 08:05 Kyiv
  await app.runDigests();
  await app.runDigests();
  assert.deepEqual(sent.map((m) => m.chatId), ['1']);
  assert.match(sent[0].text, /Essay/);
  assert.doesNotMatch(sent[0].text, /Far away/);

  clock += DAY; // next morning, digest switched off
  await tg(app, 1, '/digest');
  sent.length = 0;
  await app.runDigests();
  assert.equal(sent.length, 0);
});

test('telegram: a chat that blocked the bot gets unlinked', async (t) => {
  const sent = [];
  let blocked = false;
  const telegram = {
    enabled: true,
    botName: async () => 'dueboard_test_bot',
    send: async (chatId, text) => {
      if (blocked) throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { code: 403 });
      sent.push({ chatId, text });
    },
  };
  const { app, base, close } = await start({ telegram });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('POST', '/api/deadlines', { title: 'Essay', dueAt: NOW + 12 * HOUR });
  await linkTelegram(app, call, 9);

  blocked = true;
  t.mock.method(console, 'error', () => {});
  await app.runReminders();
  assert.equal((await call('GET', '/api/me')).data.telegram.linked, false);
});

test('done: leaves the board, stops reminders, per user for group deadlines, undo', async (t) => {
  const { app, base, sent, close } = await start();
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const maryan = await signedUp(base, 'maryan');
  const { code } = (await mykola('POST', '/api/group', { name: 'CS-2' })).data;
  await maryan('POST', '/api/group/join', { code });
  const essay = (await mykola('POST', '/api/deadlines', { title: 'Essay', dueAt: NOW + 12 * HOUR })).data;
  const report = (await mykola('POST', '/api/deadlines', { title: 'Team report', dueAt: NOW + 12 * HOUR, shared: true })).data;
  const exam = (await mykola('POST', '/api/exams', { title: 'Calculus', examAt: NOW + 12 * HOUR })).data;

  assert.equal((await mykola('PUT', '/api/done', { key: essay.key })).status, 200);
  assert.equal((await mykola('PUT', '/api/done', { key: report.key })).status, 200);
  assert.equal((await maryan('PUT', '/api/done', { key: essay.key })).status, 404, 'not on her board');
  assert.equal((await mykola('PUT', '/api/done', { key: `e${exam.id}` })).status, 404, 'exams are not "done"');

  const board = (await mykola('GET', '/api/deadlines')).data.items;
  assert.deepEqual(board.filter((i) => i.done).map((i) => i.title).sort(), ['Essay', 'Team report']);
  const hers = (await maryan('GET', '/api/deadlines')).data.items;
  assert.equal(hers.find((i) => i.title === 'Team report').done, false, 'done is personal');

  await linkTelegram(app, mykola, 1);
  sent.length = 0;
  await app.runReminders();
  assert.deepEqual(sent.map((m) => m.text.match(/Essay|Team report|Calculus/)[0]), ['Calculus']);

  await mykola('PUT', '/api/done', { key: essay.key, done: false });
  sent.length = 0;
  await app.runReminders();
  assert.match(sent[0].text, /Essay/);
  assert.equal(sent[0].doneKey, essay.key, 'reminder carries a Done button');
});

test('done: the Telegram button marks the deadline done and edits the reminder', async (t) => {
  const { app, base, sent, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const essay = (await call('POST', '/api/deadlines', { title: 'Essay', dueAt: NOW + 12 * HOUR })).data;
  await linkTelegram(app, call, 5);
  const press = (data, chatId = 5) => app.handleTelegramUpdate({
    callback_query: { id: 'q1', data, message: { message_id: 77, chat: { id: chatId }, text: '⏰ Essay is due' } },
  });

  sent.length = 0;
  await press(`done:${essay.key}`);
  assert.equal((await call('GET', '/api/deadlines')).data.items[0].done, true);
  assert.deepEqual(sent.find((m) => m.edited), { chatId: '5', messageId: 77, text: '⏰ Essay is due\n\n✅ Виконано', edited: true });
  assert.equal(sent.find((m) => m.answer).text, 'Позначено як виконане ✅');

  sent.length = 0;
  await press(`done:${essay.key}`, 999);
  assert.deepEqual(sent, [{ queryId: 'q1', text: 'Цей чат більше не прив’язаний до Dueboard.', answer: true }]);
});

test('prep: exam on the board, diagnostic test, weak topics and plan, owner-only access', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const other = await signedUp(base, 'maryan');

  const exam = (await call('POST', '/api/exams', { title: 'Calculus', course: 'MATH-1', examAt: NOW + 6 * DAY })).data;
  assert.equal((await other('GET', `/api/exams/${exam.id}`)).status, 404);

  const board = (await call('GET', '/api/deadlines')).data.items;
  assert.deepEqual(board.map((i) => [i.source, i.title]), [['exam', 'Calculus']]);

  const limits = (await call('POST', `/api/exams/${exam.id}/topics`, { name: 'Limits' })).data;
  const series = (await call('POST', `/api/exams/${exam.id}/topics`, { name: 'Series' })).data;
  assert.equal((await other('POST', `/api/topics/${limits.id}/questions`, {
    prompt: 'x', options: ['a', 'b'], answerIndex: 0,
  })).status, 404);
  assert.equal((await call('POST', `/api/topics/${limits.id}/questions`, {
    prompt: 'x', options: ['a'], answerIndex: 0,
  })).status, 400);

  const q1 = (await call('POST', `/api/topics/${limits.id}/questions`, {
    prompt: 'lim sin(x)/x at 0?', options: ['0', '1', '∞'], answerIndex: 1,
  })).data;
  const q2 = (await call('POST', `/api/topics/${series.id}/questions`, {
    prompt: 'Does Σ1/n converge?', options: ['Yes', 'No'], answerIndex: 1,
  })).data;
  await call('POST', `/api/topics/${series.id}/problems`, { text: 'Test Σ1/n² for convergence.' });

  const testView = (await call('GET', `/api/exams/${exam.id}/test`)).data;
  assert.equal(testView.questions.length, 2);
  // The answer comes along so the page can show right/wrong right away (the exam page shows answers too).
  assert.deepEqual(testView.questions.map((q) => q.answerIndex), [1, 1]);
  assert.ok(testView.questions.every((q) => q.topic && 'source' in q));

  const detail = (await call('POST', `/api/exams/${exam.id}/test`, { answers: { [q1.id]: 1, [q2.id]: 0 } })).data;
  assert.deepEqual(detail.result.topics.map((r) => [r.name, r.status]), [['Limits', 'strong'], ['Series', 'weak']]);
  assert.equal(detail.plan.length, 6);
  assert.deepEqual(detail.plan[0].topics, ['Series']);
  assert.equal(detail.plan.at(-1).focus, 'review');
  assert.equal(detail.topics.find((tp) => tp.name === 'Series').problems.length, 1);

  assert.equal((await call('DELETE', `/api/exams/${exam.id}`)).status, 200);
  assert.deepEqual((await call('GET', '/api/deadlines')).data.items, []);
});

test('materials: upload, download as attachment, owner-only', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const other = await signedUp(base, 'maryan');
  const exam = (await call('POST', '/api/exams', { title: 'Physics', examAt: NOW + 5 * DAY })).data;

  const material = (await call('POST', `/api/exams/${exam.id}/materials`, {
    filename: 'lecture "1".html',
    mime: 'text/html',
    data: Buffer.from('<script>alert(1)</script>').toString('base64'),
  })).data;
  assert.equal(material.size, 25);

  const download = await call('GET', `/api/materials/${material.id}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(download.data, '<script>alert(1)</script>');
  assert.equal((await other('GET', `/api/materials/${material.id}`)).status, 404);
});

test('auth: wrong passwords are limited per address and account, the real address comes from the proxy', async (t) => {
  let clock = NOW;
  const { base, close } = await start({ now: () => clock });
  t.after(close);
  await signedUp(base, 'mykola');
  const login = (password, ip) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': `6.6.6.6, ${ip}` } : {}) },
    body: JSON.stringify({ username: 'mykola', password }),
  });

  for (let i = 0; i < 5; i++) assert.equal((await login('wrong password', '1.1.1.1')).status, 401);
  const blocked = await login('correct horse', '1.1.1.1');
  assert.equal(blocked.status, 429, 'even the right password waits once the limit is hit');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Another address (the last X-Forwarded-For entry, set by Caddy) is not blocked.
  assert.equal((await login('correct horse', '2.2.2.2')).status, 200);

  clock += 16 * 60 * 1000;
  assert.equal((await login('correct horse', '1.1.1.1')).status, 200, 'the block expires');
  // A success clears the count for that address.
  for (let i = 0; i < 4; i++) await login('wrong password', '1.1.1.1');
  assert.equal((await login('correct horse', '1.1.1.1')).status, 200);
  assert.equal((await login('wrong password', '1.1.1.1')).status, 401);
});

test('auth: one address cannot create accounts without end', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const register = (username) => fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '3.3.3.3' },
    body: JSON.stringify({ username, password: 'correct horse' }),
  });
  for (let i = 0; i < 20; i++) assert.equal((await register(`user${i}`)).status, 200);
  assert.equal((await register('user20')).status, 429);
});

test('account: change password signs out other devices, log out everywhere', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const laptop = await signedUp(base, 'mykola');
  const phone = client(base);
  assert.equal((await phone('POST', '/api/login', { username: 'mykola', password: 'correct horse' })).status, 200);

  assert.equal((await laptop('PUT', '/api/password', { current: 'wrong one', password: 'battery staple' })).status, 403);
  assert.equal((await laptop('PUT', '/api/password', { current: 'correct horse', password: 'short' })).status, 400);
  assert.equal((await laptop('PUT', '/api/password', { current: 'correct horse', password: 'battery staple' })).status, 200);
  assert.equal((await laptop('GET', '/api/me')).status, 200, 'the device that changed it stays signed in');
  assert.equal((await phone('GET', '/api/me')).status, 401, 'other devices are signed out');
  assert.equal((await phone('POST', '/api/login', { username: 'mykola', password: 'correct horse' })).status, 401);
  assert.equal((await phone('POST', '/api/login', { username: 'mykola', password: 'battery staple' })).status, 200);

  assert.equal((await phone('POST', '/api/logout-all', {})).status, 200);
  assert.equal((await phone('GET', '/api/me')).status, 401);
  assert.equal((await laptop('GET', '/api/me')).status, 401);
});

test('account: delete needs the username and password and removes the data', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const anna = await signedUp(base, 'anna');
  const { code } = (await mykola('POST', '/api/group', { name: 'CS-2' })).data;
  await anna('POST', '/api/group/join', { code });
  await mykola('POST', '/api/deadlines', { title: 'Mine', dueAt: NOW + DAY });
  await mykola('POST', '/api/deadlines', { title: 'Team report', dueAt: NOW + DAY, shared: true });
  await mykola('POST', '/api/exams', { title: 'Calculus', examAt: NOW + 5 * DAY });

  assert.equal((await mykola('DELETE', '/api/account', { confirm: 'mykola', password: 'nope nope' })).status, 403);
  assert.equal((await mykola('DELETE', '/api/account', { confirm: 'anna', password: 'correct horse' })).status, 400);
  assert.equal((await mykola('DELETE', '/api/account', { confirm: 'mykola', password: 'correct horse' })).status, 200);
  assert.equal((await mykola('GET', '/api/me')).status, 401);
  assert.equal((await client(base)('POST', '/api/login', { username: 'mykola', password: 'correct horse' })).status, 401);
  // The group keeps the deadline that was shared with it; nothing else of the account is left.
  assert.deepEqual((await anna('GET', '/api/deadlines')).data.items.map((i) => i.title), ['Team report']);
  // The username is free again.
  assert.equal((await client(base)('POST', '/api/register', { username: 'mykola', password: 'correct horse' })).status, 200);
});

test('account: password reset with a code sent to the linked Telegram chat', async (t) => {
  let clock = NOW;
  const { app, base, sent, close } = await start({ now: () => clock });
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const { code: link } = (await mykola('POST', '/api/telegram/link', {})).data;
  await app.handleTelegramUpdate({ message: { chat: { id: 5, type: 'private' }, text: `/start ${link}` } });
  await signedUp(base, 'anna'); // no Telegram
  const anon = client(base);

  // Same answer for an unknown user, a user without Telegram and a linked one; only the linked one gets a code.
  for (const username of ['nobody', 'anna', 'mykola']) {
    assert.deepEqual((await anon('POST', '/api/password-reset', { username })).data, { ok: true });
  }
  const message = sent.at(-1);
  assert.equal(message.chatId, '5');
  const code = /(\d{6})/.exec(message.text)[1];

  const confirm = (body) => anon('POST', '/api/password-reset/confirm', { username: 'mykola', password: 'battery staple', ...body });
  assert.equal((await confirm({ code: code === '000000' ? '111111' : '000000' })).status, 400);
  assert.equal((await confirm({ code, password: 'short' })).status, 400);
  assert.equal((await confirm({ code })).status, 200);
  assert.equal((await anon('GET', '/api/me')).data.username, 'mykola', 'signed in with the new password');
  assert.equal((await mykola('GET', '/api/me')).status, 401, 'old sessions are gone');
  assert.equal((await confirm({ code })).status, 400, 'a code works once');

  // Codes expire, and five wrong tries burn a code.
  await anon('POST', '/api/password-reset', { username: 'mykola' });
  const expired = /(\d{6})/.exec(sent.at(-1).text)[1];
  clock += 16 * 60 * 1000;
  assert.equal((await confirm({ code: expired })).status, 400);
  await anon('POST', '/api/password-reset', { username: 'mykola' });
  const burnt = /(\d{6})/.exec(sent.at(-1).text)[1];
  for (let i = 0; i < 5; i++) await confirm({ code: burnt === '000000' ? '111111' : '000000' });
  assert.equal((await confirm({ code: burnt })).status, 400);
  // At most three codes per account in 15 minutes (one was already asked for since the clock moved).
  assert.equal((await anon('POST', '/api/password-reset', { username: 'mykola' })).status, 200);
  assert.equal((await anon('POST', '/api/password-reset', { username: 'mykola' })).status, 200);
  assert.equal((await anon('POST', '/api/password-reset', { username: 'mykola' })).status, 429);
});

test('edit: own deadlines only, a new date brings reminders back', async (t) => {
  const { app, base, sent, close } = await start();
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const anna = await signedUp(base, 'anna');
  const { code } = (await mykola('POST', '/api/group', { name: 'CS-2' })).data;
  await anna('POST', '/api/group/join', { code });
  const { id } = (await mykola('POST', '/api/deadlines', { title: 'Essay', dueAt: NOW + 20 * HOUR, shared: true })).data;
  await mykola('POST', '/api/import-ics', { ics: FEED });
  const moodleId = (await mykola('GET', '/api/deadlines')).data.items.find((i) => i.source === 'moodle').id;
  const { code: link } = (await mykola('POST', '/api/telegram/link', {})).data;
  await app.handleTelegramUpdate({ message: { chat: { id: 5, type: 'private' }, text: `/start ${link}` } });
  await app.runReminders();
  const before = sent.filter((m) => /Essay/.test(m.text)).length;
  assert.equal(before, 1);

  const edit = { title: 'Essay, final draft', course: 'Ethics', url: 'https://learn.example/e', dueAt: NOW + 2.5 * DAY };
  assert.equal((await anna('PUT', `/api/deadlines/${id}`, edit)).status, 404, 'only the author edits');
  assert.equal((await mykola('PUT', `/api/deadlines/${moodleId}`, edit)).status, 404, 'Moodle deadlines are not edited here');
  assert.equal((await mykola('PUT', `/api/deadlines/${id}`, { ...edit, url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await mykola('PUT', `/api/deadlines/${id}`, edit)).status, 200);
  const item = (await anna('GET', '/api/deadlines')).data.items.find((i) => i.id === id);
  assert.deepEqual([item.title, item.course, item.url, item.dueAt], [edit.title, 'Ethics', edit.url, edit.dueAt]);

  await app.runReminders();
  assert.equal(sent.filter((m) => /Essay, final draft/.test(m.text)).length, 1, 'the 3-day reminder comes for the new date');
});

test('edit: exam, topic, question and problem, owner-only', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const anna = await signedUp(base, 'anna');
  const { id: examId } = (await mykola('POST', '/api/exams', { title: 'Calc', examAt: NOW + 5 * DAY })).data;
  const { id: other } = (await anna('POST', '/api/exams', { title: 'Other', examAt: NOW + 5 * DAY })).data;
  const { id: t1 } = (await mykola('POST', `/api/exams/${examId}/topics`, { name: 'Limits' })).data;
  const { id: t2 } = (await mykola('POST', `/api/exams/${examId}/topics`, { name: 'Series' })).data;
  const { id: annaTopic } = (await anna('POST', `/api/exams/${other}/topics`, { name: 'Hers' })).data;
  const { id: q } = (await mykola('POST', `/api/topics/${t1}/questions`, { prompt: '1+1?', options: ['1', '2'], answerIndex: 1 })).data;
  const { id: p } = (await mykola('POST', `/api/topics/${t1}/problems`, { text: 'Old problem' })).data;

  assert.equal((await anna('PUT', `/api/exams/${examId}`, { title: 'X', examAt: NOW })).status, 404);
  assert.equal((await mykola('PUT', `/api/exams/${examId}`, { title: 'Calculus I', course: 'Math', examAt: NOW + 6 * DAY })).status, 200);
  assert.equal((await mykola('PUT', `/api/topics/${t1}`, { name: 'Limits & continuity' })).status, 200);
  assert.equal((await anna('PUT', `/api/topics/${t1}`, { name: 'Mine now' })).status, 404);
  const question = { prompt: '2+2?', options: ['3', '4', '5'], answerIndex: 1 };
  assert.equal((await mykola('PUT', `/api/questions/${q}`, { ...question, answerIndex: 3 })).status, 400);
  assert.equal((await anna('PUT', `/api/questions/${q}`, question)).status, 404);
  assert.equal((await mykola('PUT', `/api/questions/${q}`, { ...question, topicId: annaTopic })).status, 404, 'not into another user\'s topic');
  assert.equal((await mykola('PUT', `/api/questions/${q}`, { ...question, topicId: t2 })).status, 200);
  assert.equal((await mykola('PUT', `/api/problems/${p}`, { text: 'New problem' })).status, 200);
  assert.equal((await anna('PUT', `/api/problems/${p}`, { text: 'Hacked' })).status, 404);

  const exam = (await mykola('GET', `/api/exams/${examId}`)).data;
  assert.deepEqual([exam.title, exam.course, exam.examAt], ['Calculus I', 'Math', NOW + 6 * DAY]);
  assert.deepEqual(exam.topics.map((t) => [t.name, t.questions.map((x) => x.prompt), t.problems.map((x) => x.text)]), [
    ['Limits & continuity', [], ['New problem']],
    ['Series', ['2+2?'], []],
  ]);
  assert.deepEqual(exam.topics[1].questions[0].options, ['3', '4', '5']);
});

test('calendar feed: secret link without a cookie, open items only, new link turns the old one off', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  await mykola('POST', '/api/deadlines', { title: 'Essay', course: 'Ethics', dueAt: NOW + DAY });
  const { key } = (await mykola('POST', '/api/deadlines', { title: 'Done already', dueAt: NOW + DAY })).data;
  await mykola('PUT', '/api/done', { key, done: true });
  await mykola('POST', '/api/exams', { title: 'Calculus', examAt: NOW + 5 * DAY });
  assert.equal((await mykola('GET', '/api/me')).data.calendarFeed, false);

  const { path } = (await mykola('POST', '/api/calendar-feed', {})).data;
  assert.match(path, /^\/cal\/[a-f0-9]{64}\.ics$/);
  assert.equal((await mykola('GET', '/api/me')).data.calendarFeed, true);
  const feed = await fetch(base + path);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /^text\/calendar/);
  const body = await feed.text();
  assert.match(body, /\[Ethics\] Essay/);
  assert.match(body, /Екзамен: Calculus/);
  assert.doesNotMatch(body, /Done already/);

  assert.equal((await fetch(`${base}/cal/${'0'.repeat(64)}.ics`)).status, 404);
  const { path: second } = (await mykola('POST', '/api/calendar-feed', {})).data;
  assert.equal((await fetch(base + path)).status, 404, 'the old link stops working');
  assert.equal((await fetch(base + second)).status, 200);
  await mykola('DELETE', '/api/calendar-feed');
  assert.equal((await fetch(base + second)).status, 404);
});

test('prep: every attempt is kept for the progress chart, the last one lists its mistakes', async (t) => {
  let clock = NOW;
  const { base, close } = await start({ now: () => clock });
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  const { id: examId } = (await mykola('POST', '/api/exams', { title: 'Calc', examAt: NOW + 5 * DAY })).data;
  const { id: topic } = (await mykola('POST', `/api/exams/${examId}/topics`, { name: 'Limits' })).data;
  const ids = [];
  for (const prompt of ['a', 'b', 'c']) {
    ids.push((await mykola('POST', `/api/topics/${topic}/questions`, { prompt, options: ['x', 'y'], answerIndex: 0 })).data.id);
  }
  assert.deepEqual((await mykola('GET', `/api/exams/${examId}`)).data.history, []);

  await mykola('POST', `/api/exams/${examId}/test`, { answers: { [ids[0]]: 0, [ids[1]]: 1 } });
  clock += DAY;
  const second = (await mykola('POST', `/api/exams/${examId}/test`, { answers: { [ids[0]]: 0, [ids[1]]: 0, [ids[2]]: 1 } })).data;
  assert.deepEqual(second.history.map((a) => [a.takenAt, a.correct, a.total]), [[NOW, 1, 3], [NOW + DAY, 2, 3]]);
  assert.deepEqual(second.mistakes, [ids[2]]);

  // A deleted question drops out of the mistakes.
  await mykola('DELETE', `/api/questions/${ids[2]}`);
  assert.deepEqual((await mykola('GET', `/api/exams/${examId}`)).data.mistakes, []);
});

test('materials: one account has a storage limit across all its exams', async (t) => {
  const { base, close } = await start({ storageLimit: 100 });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const other = await signedUp(base, 'maryan');
  const upload = async (who, examId, bytes) => (await who('POST', `/api/exams/${examId}/materials`, {
    filename: 'notes.txt', data: Buffer.alloc(bytes, 'a').toString('base64'),
  })).status;
  const a = (await call('POST', '/api/exams', { title: 'A', examAt: NOW + DAY })).data.id;
  const b = (await call('POST', '/api/exams', { title: 'B', examAt: NOW + DAY })).data.id;
  const theirs = (await other('POST', '/api/exams', { title: 'C', examAt: NOW + DAY })).data.id;

  assert.equal(await upload(call, a, 60), 200);
  assert.equal(await upload(call, b, 41), 413, 'the limit counts every exam of the account');
  assert.equal(await upload(call, b, 40), 200);
  assert.deepEqual((await call('GET', `/api/exams/${a}`)).data.storage, { used: 100, limit: 100 });
  assert.equal(await upload(other, theirs, 100), 200, 'another account has its own space');

  const fileId = (await call('GET', `/api/exams/${a}`)).data.materials[0].id;
  await call('DELETE', `/api/materials/${fileId}`);
  assert.equal(await upload(call, b, 60), 200, 'deleting a file frees its space');
});

test('pwa: manifest, service worker and icons are served with the right types', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
  const data = await manifest.json();
  assert.equal(data.display, 'standalone');
  for (const icon of data.icons) {
    const res = await fetch(base + icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), icon.type);
  }
  const sw = await fetch(`${base}/sw.js`);
  assert.match(sw.headers.get('content-type'), /^text\/javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache', 'browsers must see a new worker at once');
  assert.equal((await fetch(`${base}/apple-touch-icon.png`)).headers.get('content-type'), 'image/png');
});

test('moodle: a calendar link to an internal address is refused, manual syncs are limited', async (t) => {
  const { base, close } = await start({ fetchImpl: undefined });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('PUT', '/api/settings', { icsUrl: 'http://169.254.169.254/latest/meta-data/' });
  const sync = await call('POST', '/api/sync', {});
  assert.equal(sync.status, 400);
  assert.match(sync.data.error, /внутрішню адресу/);
  for (let i = 1; i < 10; i++) await call('POST', '/api/sync', {});
  assert.equal((await call('POST', '/api/sync', {})).status, 429);
});

test('security headers: HSTS only behind HTTPS, permissions locked down', async (t) => {
  const plain = await start();
  t.after(plain.close);
  const res = await fetch(`${plain.base}/`);
  assert.equal(res.headers.get('strict-transport-security'), null);
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
  const https = await start({ secureCookies: true });
  t.after(https.close);
  assert.match((await fetch(`${https.base}/`)).headers.get('strict-transport-security'), /max-age=31536000/);
});

test('cleanup: expired sessions, old AI runs and reminder marks of past deadlines go away', async (t) => {
  let clock = NOW;
  const db = openDb(':memory:');
  const { app, base, close } = await start({ now: () => clock, db });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const { id: past } = (await call('POST', '/api/deadlines', { title: 'Old', dueAt: NOW - 8 * DAY })).data;
  const { id: soon } = (await call('POST', '/api/deadlines', { title: 'Soon', dueAt: NOW + DAY })).data;
  const userId = db.prepare('SELECT id FROM users').get().id;
  for (const key of [`d${past}`, `d${soon}`, 'd9999']) {
    db.prepare("INSERT INTO reminders_sent (user_id, item_key, kind) VALUES (?, ?, '1d')").run(userId, key);
  }
  db.prepare('INSERT INTO ai_runs (user_id, created_at) VALUES (?, ?)').run(userId, NOW - 2 * DAY);
  db.prepare('INSERT INTO ai_runs (user_id, created_at) VALUES (?, ?)').run(userId, NOW - HOUR);

  app.cleanup();
  assert.deepEqual(db.prepare('SELECT item_key FROM reminders_sent').all().map((r) => r.item_key), [`d${soon}`]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  clock += 31 * DAY;
  app.cleanup();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('moodle: a failing sync is shown on the site and announced in Telegram once', async (t) => {
  let answer = () => new Response('Server error', { status: 500 });
  const { app, base, sent, close } = await start({ fetchImpl: async () => answer() });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('PUT', '/api/settings', { icsUrl: 'https://moodle.example/cal.ics' });
  const { code } = (await call('POST', '/api/telegram/link', {})).data;
  await app.handleTelegramUpdate({ message: { chat: { id: 5, type: 'private' }, text: `/start ${code}` } });
  sent.length = 0;

  await app.syncAll();
  await app.syncAll();
  assert.match((await call('GET', '/api/me')).data.syncError, /статусом 500/);
  assert.equal(sent.filter((m) => /Не вдалося оновити/.test(m.text)).length, 1, 'one message, not one per sync');

  answer = () => new Response(FEED);
  await app.syncAll();
  assert.equal((await call('GET', '/api/me')).data.syncError, null);
});

test('telegram: reminder times are chosen in settings, a 3-hour one can be added', async (t) => {
  let clock = NOW;
  const { app, base, sent, close } = await start({ now: () => clock });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const { code } = (await call('POST', '/api/telegram/link', {})).data;
  await app.handleTelegramUpdate({ message: { chat: { id: 5, type: 'private' }, text: `/start ${code}` } });
  assert.deepEqual((await call('GET', '/api/me')).data.telegram.reminders, ['3d', '1d']);
  assert.equal((await call('PUT', '/api/telegram/reminders', { kinds: ['5m'] })).status, 400);
  assert.deepEqual((await call('PUT', '/api/telegram/reminders', { kinds: ['1d', '3h'] })).data.reminders, ['1d', '3h']);

  await call('POST', '/api/deadlines', { title: 'Essay', dueAt: NOW + 2 * DAY });
  sent.length = 0;
  await app.runReminders();
  assert.equal(sent.length, 0, 'no 3-day reminder: it was turned off');
  clock = NOW + DAY + HOUR;
  await app.runReminders();
  clock = NOW + 2 * DAY - 2 * HOUR;
  await app.runReminders();
  await app.runReminders();
  assert.deepEqual(sent.map((m) => /менш ніж за (добу|3 години)/.exec(m.text)[1]), ['добу', '3 години']);
});

test('telegram: the morning digest says what to study today for a coming exam', async (t) => {
  const clock = Date.UTC(2026, 10, 14, 6, 5); // 08:05 Kyiv
  const { app, base, sent, close } = await start({ now: () => clock });
  t.after(close);
  const student = await signedUp(base, 'student');
  const { id: examId } = (await student('POST', '/api/exams', { title: 'Calculus', examAt: clock + 10 * DAY })).data;
  await student('POST', '/api/exams', { title: 'No topics yet', examAt: clock + 12 * DAY });
  const { id: topic } = (await student('POST', `/api/exams/${examId}/topics`, { name: 'Series' })).data;
  await student('POST', `/api/topics/${topic}/questions`, { prompt: '?', options: ['a', 'b'], answerIndex: 0 });
  await student('POST', `/api/exams/${examId}/test`, { answers: {} });
  await linkTelegram(app, student, 7);
  sent.length = 0;

  await app.runDigests();
  assert.equal(sent.length, 1, 'sent although nothing is due this week: there is studying to do');
  assert.match(sent[0].text, /План підготовки на сьогодні/);
  assert.doesNotMatch(sent[0].text, /Дедлайни на найближчі/);
  assert.match(sent[0].text, /📚 Calculus .*тренуйте слабкі теми: Series/);
  assert.doesNotMatch(sent[0].text, /No topics yet/, 'an exam without topics has no plan to follow');
});

test('account: export downloads all your data as JSON, without secrets', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await signedUp(base, 'anna');
  const { key } = (await call('POST', '/api/deadlines', { title: 'Essay', course: 'Ethics', dueAt: NOW + DAY })).data;
  await call('PUT', '/api/notes', { key, text: 'Use 3 sources' });
  const { id: examId } = (await call('POST', '/api/exams', { title: 'Calculus', examAt: NOW + 5 * DAY })).data;
  const { id: topic } = (await call('POST', `/api/exams/${examId}/topics`, { name: 'Limits' })).data;
  await call('POST', `/api/topics/${topic}/questions`, { prompt: '1+1?', options: ['1', '2'], answerIndex: 1 });
  await call('POST', '/api/extension/key', {});
  await call('PUT', '/api/notes', { key: `e${examId}`, text: 'Bring a calculator' });
  await call('PUT', '/api/settings', { icsUrl: 'https://moodle.example/export_execute.php?authtoken=secret-token' });

  const res = await call('GET', '/api/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="dueboard-mykola-/);
  const data = res.data;
  assert.equal(data.account.username, 'mykola');
  assert.deepEqual(data.deadlines.map((d) => [d.title, d.note]), [['Essay', 'Use 3 sources']]);
  assert.equal(data.exams[0].topics[0].questions[0].answerIndex, 1);
  assert.equal(data.exams[0].note, 'Bring a calculator', 'exam notes are exported too');
  assert.match(data.exams[0].examAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(data.account.moodleConnected, true);
  const text = JSON.stringify(data);
  assert.doesNotMatch(text, /pass_hash|ext_key|anna|authtoken|secret-token/);
  assert.equal((await client(base)('GET', '/api/export')).status, 401);
});

test('audit: a new password revokes the extension key; log out everywhere also the calendar link and Telegram', async (t) => {
  const { app, base, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  const { key } = (await call('POST', '/api/extension/key', {})).data;
  const ext = () => fetch(`${base}/api/extension/config`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal((await ext()).status, 200);
  await call('PUT', '/api/password', { current: 'correct horse', password: 'battery staple' });
  assert.equal((await ext()).status, 401, 'the key made before the new password stops working');

  const { path } = (await call('POST', '/api/calendar-feed', {})).data;
  const { code } = (await call('POST', '/api/telegram/link', {})).data;
  await app.handleTelegramUpdate({ message: { chat: { id: 9, type: 'private' }, text: `/start ${code}` } });
  await call('POST', '/api/logout-all', {});
  assert.equal((await fetch(base + path)).status, 404);
  const again = client(base);
  await again('POST', '/api/login', { username: 'mykola', password: 'battery staple' });
  assert.equal((await again('GET', '/api/me')).data.telegram.linked, false);
});

test('audit: absurd dates and links with line breaks are refused', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const call = await signedUp(base, 'mykola');
  assert.equal((await call('POST', '/api/exams', { title: 'X', examAt: 1e300 })).status, 400);
  assert.equal((await call('POST', '/api/deadlines', { title: 'X', dueAt: -1e15 })).status, 400);
  const bad = await call('POST', '/api/deadlines', { title: 'X', dueAt: NOW + DAY, url: 'https://ok.example/\nBEGIN:VALARM' });
  assert.equal(bad.status, 400);
});

test('audit: a moved Moodle date brings reminders back; an empty feed deletes nothing', async (t) => {
  let clock = NOW;
  let feed = FEED;
  const { app, base, sent, close } = await start({ now: () => clock, fetchImpl: async () => new Response(feed) });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('PUT', '/api/settings', { icsUrl: 'https://moodle.example/cal.ics' });
  await call('POST', '/api/sync', {});
  const { code } = (await call('POST', '/api/telegram/link', {})).data;
  await app.handleTelegramUpdate({ message: { chat: { id: 5, type: 'private' }, text: `/start ${code}` } });
  const [item] = (await call('GET', '/api/deadlines')).data.items;
  await call('PUT', '/api/notes', { key: item.key, text: 'Ask about part 2' });
  sent.length = 0;
  await app.runReminders();
  assert.equal(sent.length, 1);

  feed = FEED.replace(icsStamp(NOW + 30 * HOUR), icsStamp(NOW + 8 * DAY));
  await call('POST', '/api/sync', {});
  clock = NOW + 7 * DAY + 4 * HOUR;
  await app.runReminders();
  assert.equal(sent.length, 2, 'the 1-day reminder comes again for the new date');

  feed = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';
  await call('POST', '/api/sync', {});
  const after = (await call('GET', '/api/deadlines')).data.items;
  assert.equal(after.length, 1);
  assert.equal(after[0].note, 'Ask about part 2');
});

test('audit: overlapping job runs send one reminder, not two', async (t) => {
  const messages = [];
  let slow = null;
  const telegram = {
    enabled: true,
    botName: async () => 'dueboard_test_bot',
    // While `slow` is set, every send waits for it: a Telegram that takes longer than a job tick.
    send: async (chatId, text) => { if (slow) await slow; messages.push(text); },
    editMessage: async () => {},
    answerButton: async () => {},
  };
  const { app, base, close } = await start({ telegram });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await linkTelegram(app, call, 3);
  await call('POST', '/api/deadlines', { title: 'Essay', dueAt: NOW + 20 * HOUR });
  messages.length = 0;
  let release;
  slow = new Promise((resolve) => { release = resolve; });
  const first = app.runReminders();
  const second = app.runReminders(); // the next minute's tick while the first still waits on Telegram
  release();
  await Promise.all([first, second]);
  assert.equal(messages.filter((m) => /Essay/.test(m)).length, 1);
});

test('audit: wrong reset codes add up across new codes', async (t) => {
  let clock = NOW;
  const { app, base, sent, close } = await start({ now: () => clock });
  t.after(close);
  const mykola = await signedUp(base, 'mykola');
  await linkTelegram(app, mykola, 5);
  const anon = client(base);
  const guess = () => anon('POST', '/api/password-reset/confirm', { username: 'mykola', code: '000000', password: 'battery staple' });
  for (let round = 0; round < 2; round++) {
    await anon('POST', '/api/password-reset', { username: 'mykola' });
    for (let i = 0; i < 5; i++) await guess();
    clock += 16 * 60 * 1000;
  }
  await anon('POST', '/api/password-reset', { username: 'mykola' });
  const code = /(\d{6})/.exec(sent.at(-1).text)[1];
  const res = await anon('POST', '/api/password-reset/confirm', { username: 'mykola', code, password: 'battery staple' });
  assert.equal(res.status, 429, 'ten wrong codes in a day lock resets until tomorrow, even with the right new code');
});

test('moodle: an assignment hidden for a while comes back with its note and done mark', async (t) => {
  let clock = NOW;
  const other = [
    'BEGIN:VEVENT', 'UID:2@moodle.example', 'SUMMARY:Quiz 4', `DTSTART:${icsStamp(NOW + 5 * DAY)}`, 'END:VEVENT',
  ].join('\r\n');
  const both = FEED.replace('END:VCALENDAR', `${other}\r\nEND:VCALENDAR`);
  const onlyQuiz = `BEGIN:VCALENDAR\r\n${other}\r\nEND:VCALENDAR`;
  let feed = both;
  const { app, base, close } = await start({ now: () => clock, fetchImpl: async () => new Response(feed) });
  t.after(close);
  const call = await signedUp(base, 'mykola');
  await call('PUT', '/api/settings', { icsUrl: 'https://moodle.example/cal.ics' });
  await call('POST', '/api/sync', {});
  const lab = (await call('GET', '/api/deadlines')).data.items.find((i) => i.title === 'Lab 3 is due');
  await call('PUT', '/api/notes', { key: lab.key, text: 'Bring the dataset' });
  await call('PUT', '/api/done', { key: lab.key, done: true });

  feed = onlyQuiz; // the teacher hides the lab
  await call('POST', '/api/sync', {});
  assert.deepEqual((await call('GET', '/api/deadlines')).data.items.map((i) => i.title), ['Quiz 4']);

  feed = both; // and shows it again
  await call('POST', '/api/sync', {});
  const back = (await call('GET', '/api/deadlines')).data.items.find((i) => i.title === 'Lab 3 is due');
  assert.equal(back.key, lab.key, 'the same row comes back');
  assert.equal(back.note, 'Bring the dataset');
  assert.equal(back.done, true);

  // Hidden for 60 days: then it is really gone.
  feed = onlyQuiz;
  await call('POST', '/api/sync', {});
  clock += 61 * DAY;
  app.cleanup();
  feed = both;
  clock = NOW;
  // The cleanup at day 61 also removed the expired session.
  await call('POST', '/api/login', { username: 'mykola', password: 'correct horse' });
  await call('POST', '/api/sync', {});
  const fresh = (await call('GET', '/api/deadlines')).data.items.find((i) => i.title === 'Lab 3 is due');
  assert.notEqual(fresh.key, lab.key);
  assert.equal(fresh.note, '');
});

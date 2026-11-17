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
  assert.match(group.code, /^[A-F0-9]{8}$/);
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
  assert.match(sync.data.error, /bot check/);
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
  assert.match(sent[0].text, /3 days/);
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
  assert.match(sent.at(-1).text, /not linked/);

  await linkTelegram(app, call, 7);
  assert.match(sent.at(-1).text, /Linked to Dueboard as mykola/);

  await tg(app, 7, '/deadlines@dueboard_test_bot');
  const list = sent.at(-1).text;
  assert.match(list, /🟡 \[Ethics\] Essay/);
  assert.match(list, /Mon 16 Nov, 14:00/, 'shown in Kyiv time (UTC+2)');
  assert.match(list, /learn\.example\/a\/1/);
  assert.doesNotMatch(list, /Old lab/);

  await tg(app, 7, '/digest');
  assert.match(sent.at(-1).text, /digest is off/);
  assert.equal((await call('GET', '/api/me')).data.telegram.digest, false);
  await tg(app, 7, '/digest');
  assert.match(sent.at(-1).text, /digest is on/);

  await tg(app, 7, 'hello');
  assert.match(sent.at(-1).text, /\/deadlines/);

  const before = sent.length;
  await tg(app, -100500, '/deadlines', 'group');
  assert.equal(sent.length, before, 'silent in group chats');

  await tg(app, 7, '/start deadbeef0000');
  assert.match(sent.at(-1).text, /expired/);

  await tg(app, 7, '/stop');
  assert.match(sent.at(-1).text, /Unlinked/);
  assert.equal((await call('GET', '/api/me')).data.telegram.linked, false);
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
  assert.match(sent[0].text, /mykola added a deadline for your group/);
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
  assert.deepEqual(sent.find((m) => m.edited), { chatId: '5', messageId: 77, text: '⏰ Essay is due\n\n✅ Done', edited: true });
  assert.equal(sent.find((m) => m.answer).text, 'Marked as done ✅');

  sent.length = 0;
  await press(`done:${essay.key}`, 999);
  assert.deepEqual(sent, [{ queryId: 'q1', text: 'This chat is not linked to Dueboard any more.', answer: true }]);
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

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
    send: async (chatId, text) => { sent.push({ chatId, text }); },
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
  assert.ok(testView.questions.every((q) => !('answerIndex' in q)));

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

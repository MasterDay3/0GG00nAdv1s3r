import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createAi } from '../src/clients/ai.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 86_400_000;

const FEED = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'UID:1@moodle', 'SUMMARY:Lab 1', 'DTSTART:20261120T120000Z', 'CATEGORIES:Алгоритми та структури даних (1.26-27.)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:2@moodle', 'SUMMARY:Quiz 2', 'DTSTART:20261121T120000Z', 'CATEGORIES:Основи програмування 2026', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:3@moodle', 'SUMMARY:Lab 2', 'DTSTART:20261122T120000Z', 'CATEGORIES:Алгоритми та структури даних (1.26-27.)', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

async function start(ai = createAi({})) {
  const telegram = { enabled: false, botName: async () => null, send: async () => {} };
  const app = createApp({ db: openDb(':memory:'), now: () => NOW, telegram, ai });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const headers = body === undefined ? {} : { 'content-type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { client, close };
}

test('exam theme: saved on create, kept by edits that leave it out, changed or cleared on purpose', async (t) => {
  const { client, close } = await start();
  t.after(close);
  const call = client();
  await call('POST', '/api/register', { username: 'olena', password: 'correct horse' });

  const { id } = (await call('POST', '/api/exams', {
    title: 'Матаналіз', course: 'Математичний аналіз', theme: '  Ряди, інтеграли  ', examAt: NOW + 10 * DAY,
  })).data;
  assert.equal((await call('GET', `/api/exams/${id}`)).data.theme, 'Ряди, інтеграли');

  await call('PUT', `/api/exams/${id}`, { title: 'Матаналіз 2', course: '', examAt: NOW + 11 * DAY });
  const kept = (await call('GET', `/api/exams/${id}`)).data;
  assert.equal(kept.title, 'Матаналіз 2');
  assert.equal(kept.theme, 'Ряди, інтеграли');

  await call('PUT', `/api/exams/${id}`, { title: 'Матаналіз 2', examAt: NOW + 11 * DAY, theme: 'Диференціальні рівняння' });
  assert.equal((await call('GET', `/api/exams/${id}`)).data.theme, 'Диференціальні рівняння');
  await call('PUT', `/api/exams/${id}`, { title: 'Матаналіз 2', examAt: NOW + 11 * DAY, theme: '' });
  assert.equal((await call('GET', `/api/exams/${id}`)).data.theme, '');

  // No theme at all, and a theme that is too long is refused without creating the exam.
  const plain = (await call('POST', '/api/exams', { title: 'Фізика', examAt: NOW + 5 * DAY })).data;
  assert.equal((await call('GET', `/api/exams/${plain.id}`)).data.theme, '');
  const tooLong = await call('POST', '/api/exams', { title: 'Хімія', theme: 'x'.repeat(1001), examAt: NOW + 5 * DAY });
  assert.equal(tooLong.status, 400);
  assert.equal((await call('GET', '/api/exams')).data.length, 2);

  await call('PUT', `/api/exams/${id}`, { title: 'Матаналіз 2', examAt: NOW + 11 * DAY, theme: 'Ряди' });
  const exported = (await call('GET', '/api/export')).data;
  assert.equal(exported.exams.find((e) => e.id === id).theme, 'Ряди');
});

test('courses: full course names from the board and exams, each once, only the student’s own', async (t) => {
  const { client, close } = await start();
  t.after(close);
  const olena = client();
  const taras = client();
  await olena('POST', '/api/register', { username: 'olena', password: 'correct horse' });
  await taras('POST', '/api/register', { username: 'taras', password: 'correct horse' });
  assert.deepEqual((await olena('GET', '/api/courses')).data, []);

  await olena('POST', '/api/import-ics', { ics: FEED });
  await olena('POST', '/api/exams', { title: 'Фізика', course: 'Фізика (1.26-27.)', examAt: NOW + 5 * DAY });
  await olena('POST', '/api/exams', { title: 'Без курсу', examAt: NOW + 5 * DAY });
  assert.deepEqual((await olena('GET', '/api/courses')).data, [
    'Алгоритми та структури даних (1.26-27.)', 'Основи програмування 2026', 'Фізика (1.26-27.)',
  ]);
  assert.deepEqual((await taras('GET', '/api/courses')).data, []);
});

test('ai: the exam theme is sent with the task, and left out when empty', async (t) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"questions":[]}' }] }));
  };
  const { client, close } = await start(createAi({ apiKey: 'k', fetchImpl }));
  t.after(close);
  const call = client();
  await call('POST', '/api/register', { username: 'olena', password: 'correct horse' });
  const notes = Buffer.from('# Ряди\nРяд збігається, якщо ...').toString('base64');

  const themed = (await call('POST', '/api/exams', { title: 'Матаналіз', theme: 'Лише ряди', examAt: NOW + 10 * DAY })).data;
  await call('POST', `/api/exams/${themed.id}/materials`, { filename: 'notes.md', data: notes });
  assert.equal((await call('POST', `/api/exams/${themed.id}/generate`, {})).status, 200);
  assert.match(JSON.stringify(requests[0]), /the exam covers: Лише ряди/);

  const plain = (await call('POST', '/api/exams', { title: 'Фізика', examAt: NOW + 10 * DAY })).data;
  await call('POST', `/api/exams/${plain.id}/materials`, { filename: 'notes.md', data: notes });
  await call('POST', `/api/exams/${plain.id}/generate`, {});
  assert.doesNotMatch(JSON.stringify(requests[1]), /the exam covers/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const DAY = 86_400_000;

async function start({ paywall = true } = {}) {
  let clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const telegram = { enabled: false, botName: async () => null, send: async () => {} };
  const app = createApp({ db: openDb(':memory:'), now: () => clock, telegram, paywall });
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
  return { client, close, advance: (ms) => { clock += ms; }, now: () => clock };
}

async function student(client, username = 'olena') {
  const call = client();
  await call('POST', '/api/register', { username, password: 'correct horse' });
  return call;
}

test('paywall: exam prep needs Dueboard Prep, the board stays free', async (t) => {
  const { client, close } = await start();
  t.after(close);
  const call = await student(client);
  const me = (await call('GET', '/api/me')).data.premium;
  assert.deepEqual(me, { required: true, active: false, until: null, price: 149, days: 30 });
  for (const [method, path, body] of [['GET', '/api/exams'], ['POST', '/api/exams', { title: 'x', examAt: Date.now() + DAY }], ['GET', '/api/exams/1/test'], ['PUT', '/api/topics/1', { name: 'x' }]]) {
    const r = await call(method, path, body);
    assert.equal(r.status, 402, `${method} ${path}`);
    assert.match(r.data.error, /Dueboard Prep: 149 грн на 30 днів/);
  }
  assert.equal((await call('GET', '/api/deadlines')).status, 200);
  assert.equal((await call('GET', '/api/courses')).status, 200);
  // Deleting stays free (the privacy page promises everything can be deleted): no 402, just "not found" here.
  assert.equal((await call('DELETE', '/api/exams/1')).status, 404);
});

test('payments: reopening the checkout continues the unpaid order; new orders are limited to 20 an hour', async (t) => {
  const { client, close } = await start();
  t.after(close);
  const call = await student(client);
  const first = (await call('POST', '/api/payments', {})).data;
  assert.equal((await call('POST', '/api/payments', {})).data.id, first.id, 'a reload does not start a second order');
  await call('POST', `/api/payments/${first.id}/pay`, { card: 'declined' });
  for (let i = 1; i < 20; i++) {
    const order = (await call('POST', '/api/payments', {})).data;
    assert.notEqual(order.id, first.id);
    await call('POST', `/api/payments/${order.id}/pay`, { card: 'declined' });
  }
  assert.equal((await call('POST', '/api/payments', {})).status, 429);
});

test('payments: a test card pays, 30 days are added on top of the time left, and the order cannot be paid twice', async (t) => {
  const { client, close, advance, now } = await start();
  t.after(close);
  const call = await student(client);

  const order = (await call('POST', '/api/payments', {})).data;
  assert.equal(order.amount, 149);
  assert.equal(order.status, 'pending');
  assert.match(order.orderRef, /^DB-20261118-[0-9A-F]{6}$/);
  const paid = (await call('POST', `/api/payments/${order.id}/pay`, { card: 'success' })).data;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.cardLast4, '4242');
  assert.equal(paid.activeUntil, now() + 30 * DAY);
  assert.equal((await call('GET', '/api/me')).data.premium.active, true);
  assert.equal((await call('GET', '/api/exams')).status, 200);
  assert.equal((await call('POST', `/api/payments/${order.id}/pay`, { card: 'success' })).status, 409);

  // Extending with 10 days left: the new 30 days start where the old ones end.
  advance(20 * DAY);
  const second = (await call('POST', '/api/payments', {})).data;
  const extended = (await call('POST', `/api/payments/${second.id}/pay`, { card: 'success' })).data;
  assert.equal(extended.activeUntil, paid.activeUntil + 30 * DAY);

  // After it runs out, exam prep closes again (a new login: sessions last 30 days).
  advance(41 * DAY);
  await call('POST', '/api/login', { username: 'olena', password: 'correct horse' });
  assert.equal((await call('GET', '/api/me')).data.premium.active, false);
  assert.equal((await call('GET', '/api/exams')).status, 402);
  const history = (await call('GET', '/api/payments')).data;
  assert.deepEqual(history.map((p) => p.status), ['paid', 'paid']);
});

test('payments: declined test cards, unknown cards and someone else’s order', async (t) => {
  const { client, close } = await start();
  t.after(close);
  const call = await student(client);
  const order = (await call('POST', '/api/payments', {})).data;

  assert.equal((await call('POST', `/api/payments/${order.id}/pay`, { card: '4111111111111111' })).status, 400, 'no real card numbers');
  assert.equal((await call('POST', `/api/payments/${order.id}/pay`, { card: 'toString' })).status, 400);
  const other = await student(client, 'taras');
  assert.equal((await other('POST', `/api/payments/${order.id}/pay`, { card: 'success' })).status, 404);

  const declined = (await call('POST', `/api/payments/${order.id}/pay`, { card: 'funds' })).data;
  assert.equal(declined.status, 'declined');
  assert.equal(declined.reason, 'Недостатньо коштів на картці.');
  assert.equal((await call('GET', '/api/me')).data.premium.active, false);
  const again = (await call('POST', '/api/payments', {})).data;
  assert.equal((await call('POST', `/api/payments/${again.id}/pay`, { card: 'declined' })).data.reason, 'Банк відхилив оплату. Спробуйте іншу картку.');
  assert.equal((await call('GET', '/api/exams')).status, 402);
});

test('paywall: off unless the server turns it on', async (t) => {
  const { client, close } = await start({ paywall: false });
  t.after(close);
  const call = await student(client);
  assert.equal((await call('GET', '/api/me')).data.premium.required, false);
  assert.equal((await call('GET', '/api/exams')).status, 200);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSafeFetch, isPublicAddress, safeFetch } from '../src/safe-fetch.js';

test('safe fetch: private, loopback, link-local and metadata addresses are not public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '104.16.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  assert.equal(isPublicAddress('not an ip'), false);
});

async function localServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('safe fetch: refuses the local machine by IP and by a name that resolves to it', async (t) => {
  const { port, close } = await localServer((req, res) => res.end('secret'));
  t.after(close);
  await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), { code: 'BLOCKED_ADDRESS' });
  await assert.rejects(safeFetch(`http://localhost:${port}/`), { code: 'BLOCKED_ADDRESS' });
  await assert.rejects(safeFetch('http://[::1]/'), { code: 'BLOCKED_ADDRESS' });
  await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data/'), { code: 'BLOCKED_ADDRESS' });
});

test('safe fetch: follows redirects but checks every hop, caps the size', async (t) => {
  const { port, close } = await localServer((req, res) => {
    if (req.url === '/moved') { res.writeHead(302, { location: '/calendar' }); return res.end(); }
    if (req.url === '/to-internal') { res.writeHead(302, { location: 'http://10.0.0.5/admin' }); return res.end(); }
    if (req.url === '/big') return res.end('x'.repeat(2000));
    res.writeHead(200, { server: 'test' });
    res.end('BEGIN:VCALENDAR');
  });
  t.after(close);
  // Pretend loopback is the public internet, so a local server can stand in for Moodle.
  const fetchLocal = createSafeFetch({ isAllowed: (ip) => ip === '127.0.0.1' });
  const res = await fetchLocal(`http://127.0.0.1:${port}/moved`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Server'), 'test');
  assert.equal(await res.text(), 'BEGIN:VCALENDAR');
  await assert.rejects(fetchLocal(`http://127.0.0.1:${port}/to-internal`), { code: 'BLOCKED_ADDRESS' });
  await assert.rejects(fetchLocal(`http://127.0.0.1:${port}/big`, { maxBytes: 1000 }), /too large/);
});

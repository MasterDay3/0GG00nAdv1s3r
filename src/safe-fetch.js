// Fetch for links that users give us (the Moodle calendar link). The server must never be made to call itself,
// the local network or the cloud metadata service (SSRF), so every address is checked at connect time,
// on every redirect too. node:http/https/dns/net are needed because fetch() cannot check the address it connects to.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4Number = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

function blockedV4(ip) {
  const n = v4Number(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4Number(base);
    return n >= start && n < start + size;
  });
}

// True for an address on the public internet.
export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return !blockedV4(ip);
  if (family !== 6) return false;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) || /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return !blockedV4(mapped[1]);
  if (lower === '::' || lower === '::1') return false;
  // fc00::/7 unique local, fe80::/10 link local, fec0::/10 old site local, ff00::/8 multicast, 2001:db8::/32 docs.
  return !/^(f[cd]|fe[89ab]|fe[c-f]|ff)/.test(lower) && !lower.startsWith('2001:db8:') && !lower.startsWith('::ffff:');
}

export class BlockedAddressError extends Error {
  constructor(host) {
    super(`${host} is not a public internet address`);
    this.code = 'BLOCKED_ADDRESS';
  }
}

// isAllowed is only replaced in tests, which have to talk to a local server.
export function createSafeFetch({ isAllowed = isPublicAddress, lookup = dnsLookup } = {}) {
  function checkedLookup(hostname, options, callback) {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err);
      // Every address the name resolves to must be public: the connection could use any of them.
      if (!addresses.length || !addresses.every((a) => isAllowed(a.address))) return callback(new BlockedAddressError(hostname));
      const first = addresses[0];
      if (options && options.all) return callback(null, [first]);
      return callback(null, first.address, first.family);
    });
  }

  function once(url, { signal, maxBytes }) {
    return new Promise((resolve, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      // An IP written in the link skips DNS, so it is checked here.
      if (isIP(host) && !isAllowed(host)) return reject(new BlockedAddressError(host));
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url, {
        lookup: checkedLookup, signal, headers: { 'user-agent': 'Dueboard calendar sync', accept: 'text/calendar, */*' },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            reject(new Error('Response is too large'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  // Returns the small part of the fetch() Response that the app uses.
  return async function safeFetch(link, { signal, maxBytes = 5 * 1024 * 1024, maxRedirects = 3 } = {}) {
    let url = new URL(link);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedAddressError(url.protocol);
      const { res, body } = await once(url, { signal, maxBytes });
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (hop >= maxRedirects) throw new Error('Too many redirects');
        url = new URL(res.headers.location, url);
        continue;
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => res.headers[name.toLowerCase()] ?? null },
        text: async () => body.toString('utf8'),
      };
    }
  };
}

export const safeFetch = createSafeFetch();

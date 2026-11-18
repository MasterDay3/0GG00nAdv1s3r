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

// An IPv6 address as eight 16-bit numbers (handles "::" and a dotted IPv4 tail), or null.
function expandV6(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4Number(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = text.includes('::') ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array(missing).fill('0'), ...right].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((n) => n >= 0 && n <= 0xffff) ? parts : null;
}

const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');

// True for an address on the public internet. IPv6 forms that carry an IPv4 inside (mapped, compatible, NAT64,
// 6to4) are judged by that IPv4, whichever way they are written.
export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return !blockedV4(ip);
  if (family !== 6) return false;
  const h = expandV6(ip);
  if (!h) return false;
  const zeros = (from, to) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 6)) return h[6] === 0 && h[7] <= 1 ? false : !blockedV4(v4From(h[6], h[7])); // ::, ::1, ::a.b.c.d
  if (zeros(0, 5) && h[5] === 0xffff) return !blockedV4(v4From(h[6], h[7])); // ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b) return zeros(2, 6) && !blockedV4(v4From(h[6], h[7])); // NAT64 (local-use /48 blocked)
  if (h[0] === 0x2002) return !blockedV4(v4From(h[1], h[2])); // 6to4
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return false; // Teredo, documentation
  if (h[0] === 0x100 && zeros(1, 4)) return false; // discard prefix
  if ((h[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return false; // link and site local
  if ((h[0] & 0xff00) === 0xff00) return false; // multicast
  return true;
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

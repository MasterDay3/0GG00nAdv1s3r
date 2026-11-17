// Fixed-window counters kept in memory: enough for one server process.
export function createLimiter({ limit, windowMs, now = () => Date.now() }) {
  const windows = new Map();

  function current(key) {
    const t = now();
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    // Drop expired windows now and then so the map does not grow forever.
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
    }
    return w;
  }

  return {
    // Milliseconds until the key may try again, or 0 when it is under the limit.
    blockedFor(key) {
      const w = current(key);
      return w.count >= limit ? w.resetAt - now() : 0;
    },
    hit(key) {
      current(key).count++;
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

// The client's address. Behind Caddy every request comes from loopback, and Caddy puts the real address last in
// X-Forwarded-For (it drops what an untrusted client sent), so the header is only believed from loopback.
export function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const fromProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  if (fromProxy && typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',').at(-1).trim();
  }
  return remote;
}

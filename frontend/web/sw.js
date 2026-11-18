// Offline support. Network first, so an online visit always gets the newest code and data;
// without a connection the last saved page and board are shown instead.
const SHELL_CACHE = 'dueboard-shell-v3';
const DATA_CACHE = 'dueboard-data'; // the page clears it on log out
const SHELL = ['/', '/style.css', '/tokens.css', '/base.css', '/favicon.svg', '/manifest.webmanifest', '/icon-192.png',
  // every module of the app (frontend/web/js); a new module must be added here to work offline
  '/js/auth.js', '/js/board.js', '/js/core.js', '/js/courses.js', '/js/extension.js', '/js/main.js',
  '/js/payments.js', '/js/prep.js', '/js/privacy.js', '/js/quiz.js', '/js/router.js', '/js/settings.js'];
// Read-only answers worth showing offline. Everything else (writes, files, AI) needs the network.
const DATA = /^\/api\/(me|deadlines|exams(\/\d+)?)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName, fallbackKey = request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Only a real page goes in place of the app page; data and scripts go under their own URL.
    const isPage = (response.headers.get('content-type') || '').startsWith('text/html');
    if (response.ok && (fallbackKey !== '/' || isPage)) await cache.put(fallbackKey, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(fallbackKey);
    if (!cached) throw err;
    if (cacheName !== DATA_CACHE) return cached;
    // Mark saved data so the page can say it is offline.
    const headers = new Headers(cached.headers);
    headers.set('x-dueboard-offline', '1');
    return new Response(cached.body, { status: cached.status, headers });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Only the app page itself is a navigation worth saving: a download or a feed opened as a page must not replace it.
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(networkFirst(request, SHELL_CACHE, '/'));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  } else if (DATA.test(url.pathname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
  }
});

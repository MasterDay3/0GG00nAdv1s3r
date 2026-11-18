// The Dueboard server as one request handler. createApp() builds a shared context (the database, settings, the
// route table, rate limits), lets each part add its functions and routes to it, and answers HTTP requests.
// node:fs is needed to serve the page files.
import { readFile } from 'node:fs/promises';
import { MAX_JSON, MAX_BIG_BODIES, MINUTE, PAID_API, PREMIUM } from './constants.js';
import { HttpError } from './lib/validate.js';
import { readJson, sendJson } from './lib/http.js';
import { createLimiter } from './lib/limiter.js';
import { safeFetch } from './lib/safe-fetch.js';
import { createAi } from './clients/ai.js';
import { createSessions } from './services/sessions.js';
import { createBoard } from './services/board.js';
import { createPrep } from './services/prep.js';
import { createBotHandlers } from './bot/handlers.js';
import { createJobs } from './jobs.js';
import { accountRoutes } from './routes/accounts.js';
import { paymentRoutes } from './routes/payments.js';
import { groupRoutes } from './routes/groups.js';
import { deadlineRoutes } from './routes/deadlines.js';
import { extensionRoutes } from './routes/extension.js';
import { calendarRoutes } from './routes/calendar.js';
import { telegramRoutes } from './routes/telegram.js';
import { examRoutes } from './routes/exams.js';
import { aiRoutes } from './routes/ai.js';

// The site's files in frontend/web, by URL.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/tokens.css': ['tokens.css', 'text/css; charset=utf-8'],
  '/base.css': ['base.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; "
    + "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};

// storageLimit: bytes of uploaded files one user may keep, across all their exams.
export function createApp({
  db, now = () => Date.now(), fetchImpl = safeFetch, telegram, secureCookies = false, ai = createAi(),
  storageLimit = 100 * 1024 * 1024, paywall = false, teamChatId = null,
}) {
  // Behind HTTPS the session cookie must never travel over plain HTTP.
  const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${secureCookies ? '; Secure' : ''}`;
  const routes = [];
  // withBody: a DELETE that also takes a JSON body (POST and PUT always do).
  const route = (method, pattern, fn, { auth = true, limit = MAX_JSON, withBody = false } = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>\\d+)')}$`);
    routes.push({ method, re, fn, auth, limit, withBody });
  };
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // Brute-force limits, shared by the account routes.
  const limits = {
    // Every login attempt from one address, right or wrong (generous: a campus shares one address).
    loginIp: createLimiter({ limit: 100, windowMs: 15 * MINUTE, now }),
    // Wrong passwords for one account from one address.
    loginFails: createLimiter({ limit: 5, windowMs: 15 * MINUTE, now }),
    // Wrong passwords for one account from anywhere: a slow, spread-out guess.
    accountFails: createLimiter({ limit: 30, windowMs: 60 * MINUTE, now }),
    registerIp: createLimiter({ limit: 20, windowMs: 60 * MINUTE, now }),
    // Reset codes sent to one account, and reset requests from one address.
    resetAccount: createLimiter({ limit: 3, windowMs: 15 * MINUTE, now }),
    resetIp: createLimiter({ limit: 20, windowMs: 15 * MINUTE, now }),
    // Wrong current passwords when changing the password or deleting the account.
    confirmFails: createLimiter({ limit: 5, windowMs: 15 * MINUTE, now }),
    // Manual Moodle syncs: each one makes the server download a link.
    sync: createLimiter({ limit: 10, windowMs: 10 * MINUTE, now }),
    groupJoin: createLimiter({ limit: 10, windowMs: 60 * MINUTE, now }),
  };

  function guard(res, ...checks) {
    const wait = Math.max(...checks.map(([limiter, key]) => limiter.blockedFor(key)));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      res.setHeader('retry-after', String(seconds));
      throw new HttpError(429, `Забагато спроб. Спробуйте за ${Math.ceil(seconds / 60)} хв.`);
    }
  }

  // Every part reads what it needs from ctx and adds its own functions to it; parts call each other through ctx,
  // so the order below does not matter.
  const ctx = {
    db, now, fetchImpl, telegram, ai, secureCookies, storageLimit, paywall, teamChatId,
    cookieFlags, route, one, all, run, limits, guard,
  };
  for (const part of [createSessions, createBoard, createPrep, createBotHandlers, createJobs]) Object.assign(ctx, part(ctx));
  for (const register of [
    accountRoutes, paymentRoutes, groupRoutes, deadlineRoutes, extensionRoutes, calendarRoutes, telegramRoutes, examRoutes, aiRoutes,
  ]) Object.assign(ctx, register(ctx));

  async function serveStatic(pathname, res) {
    // The app's modules: /js/<name>.js, plain names only, so no path can leave frontend/web/js.
    const script = /^\/js\/([a-z-]+)\.js$/.exec(pathname);
    const file = script ? [`js/${script[1]}.js`, 'text/javascript; charset=utf-8'] : STATIC[pathname];
    if (!file) throw new HttpError(404, 'Не знайдено');
    const body = await readFile(new URL(`../../frontend/web/${file[0]}`, import.meta.url)).catch(() => {
      throw new HttpError(404, 'Не знайдено');
    });
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
    res.end(body);
  }

  let bigBodies = 0;

  async function handler(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    // Served over HTTPS: browsers should never try plain HTTP again.
    if (secureCookies) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не підтримується');
        const feed = /^\/cal\/([a-f0-9]{64})\.ics$/.exec(pathname);
        if (feed) return ctx.serveCalendar(feed[1], req, res);
        return await serveStatic(pathname, res);
      }
      const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!match) throw new HttpError(404, 'Не знайдено');
      const params = Object.fromEntries(
        Object.entries(match.re.exec(pathname).groups || {}).map(([k, v]) => [k, Number(v)]),
      );
      const user = match.auth === 'extension' ? ctx.extensionUser(req) : ctx.currentUser(req);
      if (match.auth && !user) throw new HttpError(401, match.auth === 'extension' ? 'Розширення не під’єднане' : 'Увійдіть у свій акаунт');
      // Deleting one's own exams and files stays free: the privacy page promises everything can be deleted.
      if (paywall && match.auth === true && req.method !== 'DELETE' && PAID_API.test(pathname) && !ctx.premiumActive(user)) {
        throw new HttpError(402, `Підготовка до екзаменів входить у Dueboard Prep: ${PREMIUM.price} грн на ${PREMIUM.days} днів.`);
      }
      const wantsBody = ['POST', 'PUT'].includes(req.method) || match.withBody;
      // A big body (an upload, a calendar) is held in memory several times over: only a few at once.
      const big = wantsBody && match.limit > MAX_JSON;
      if (big && bigBodies >= MAX_BIG_BODIES) throw new HttpError(503, 'Сервер зайнятий іншими завантаженнями. Спробуйте за хвилину.');
      if (big) bigBodies++;
      let body;
      try {
        body = wantsBody ? await readJson(req, match.limit) : {};
      } finally {
        if (big) bigBodies--;
      }
      const result = await match.fn({ req, res, user, params, body });
      if (!res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Щось пішло не так' });
    }
  }

  const { single } = ctx;
  return {
    handler, handleTelegramUpdate: ctx.handleTelegramUpdate, cleanup: ctx.cleanup,
    runReminders: single(ctx.runReminders), runDigests: single(ctx.runDigests), syncAll: single(ctx.syncAll),
  };
}

// The calendar feed Google or Apple Calendar subscribes to.
import { randomBytes } from 'node:crypto';
import { buildCalendar } from '../lib/ics-export.js';
import { sha256 } from '../lib/passwords.js';
import { DAY } from '../lib/urgency.js';
import { HttpError } from '../lib/validate.js';

export function calendarRoutes(ctx) {
  const { now, route, one, run } = ctx;

  // The link is shown once; making a new one turns the old one off.
  route('POST', '/api/calendar-feed', ({ user }) => {
    const token = randomBytes(32).toString('hex');
    run('UPDATE users SET cal_token_hash = ? WHERE id = ?', sha256(token), user.id);
    return { path: `/cal/${token}.ics` };
  });

  route('DELETE', '/api/calendar-feed', ({ user }) => {
    run('UPDATE users SET cal_token_hash = NULL WHERE id = ?', user.id);
    return { ok: true };
  });

  // Calendar apps fetch the feed without a cookie, so the secret in the link is the only key.
  function serveCalendar(token, req, res) {
    const user = one('SELECT * FROM users WHERE cal_token_hash = ?', sha256(token));
    if (!user) throw new HttpError(404, 'Не знайдено');
    const t = now();
    // What is still to do, plus the last 30 days so a calendar does not lose what just passed.
    const items = ctx.openItems(user).filter((item) => item.dueAt > t - 30 * DAY);
    res.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="dueboard.ics"',
      'cache-control': 'private, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : buildCalendar(items, t));
  }

  return { serveCalendar };
}

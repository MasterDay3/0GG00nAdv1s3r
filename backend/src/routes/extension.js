// The Chrome extension that syncs Moodle from the student's browser.
import { randomBytes } from 'node:crypto';
import { MAX_FEED } from '../constants.js';
import { parseIcs } from '../lib/ics.js';
import { sha256 } from '../lib/passwords.js';
import { HttpError, text } from '../lib/validate.js';

export function extensionRoutes(ctx) {
  const { now, route, run } = ctx;

  route('POST', '/api/extension/key', ({ user }) => {
    const key = randomBytes(32).toString('hex');
    run('UPDATE users SET ext_key_hash = ? WHERE id = ?', sha256(key), user.id);
    return { key };
  });

  route('DELETE', '/api/extension/key', ({ user }) => {
    run('UPDATE users SET ext_key_hash = NULL WHERE id = ?', user.id);
    return { ok: true };
  });

  route('GET', '/api/extension/config', ({ user }) => ({ icsUrl: user.ics_url || '' }), { auth: 'extension' });

  route('POST', '/api/extension/upload', ({ user, body }) => {
    const ics = text(body.ics, 'Календар', { max: MAX_FEED });
    if (!/BEGIN:VCALENDAR/i.test(ics)) throw new HttpError(400, 'Це не календар .ics');
    const origin = user.ics_url ? new URL(user.ics_url).origin : null;
    const imported = ctx.importEvents(user, parseIcs(ics), origin);
    run('UPDATE users SET last_sync_at = ?, sync_error = NULL WHERE id = ?', now(), user.id);
    return { imported };
  }, { auth: 'extension', limit: MAX_FEED + 4096 });
}

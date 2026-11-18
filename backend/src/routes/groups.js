// Study groups.
import { randomBytes } from 'node:crypto';
import { HttpError, text } from '../lib/validate.js';

export function groupRoutes(ctx) {
  const { route, one, run, limits, guard } = ctx;

  route('POST', '/api/group', ({ user, body }) => {
    const name = text(body.name, 'Назва групи', { max: 80 });
    const code = randomBytes(6).toString('hex').toUpperCase();
    const { lastInsertRowid } = run('INSERT INTO study_groups (name, join_code) VALUES (?, ?)', name, code);
    run('UPDATE users SET group_id = ? WHERE id = ?', Number(lastInsertRowid), user.id);
    return { name, code };
  });

  route('POST', '/api/group/join', ({ user, body, res }) => {
    const code = text(body.code, 'Код групи', { max: 16 }).toUpperCase();
    // Wrong codes are limited, so codes cannot be guessed until one opens someone's group.
    guard(res, [limits.groupJoin, String(user.id)]);
    const group = one('SELECT * FROM study_groups WHERE join_code = ?', code);
    if (!group) {
      limits.groupJoin.hit(String(user.id));
      throw new HttpError(404, 'Групи з таким кодом немає');
    }
    run('UPDATE users SET group_id = ? WHERE id = ?', group.id, user.id);
    return { name: group.name, code: group.join_code };
  });

  route('POST', '/api/group/leave', ({ user }) => {
    run('UPDATE users SET group_id = NULL WHERE id = ?', user.id);
    return { ok: true };
  });
}

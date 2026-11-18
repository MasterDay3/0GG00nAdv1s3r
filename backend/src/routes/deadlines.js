// Deadlines: the board, own and group deadlines, done, notes, Moodle sync and import.
import { MAX_FEED } from '../constants.js';
import { parseIcs } from '../lib/ics.js';
import { HttpError, text } from '../lib/validate.js';

export function deadlineRoutes(ctx) {
  const { now, route, one, run, limits, guard } = ctx;

  route('GET', '/api/deadlines', ({ user }) => ({ now: now(), items: ctx.boardItems(user) }));

  route('POST', '/api/deadlines', ({ user, body }) => ctx.addDeadline(user, ctx.deadlineFields(body), body.shared === true));

  // Only the author edits a deadline they added; Moodle ones come from Moodle and would be overwritten by the next sync.
  route('PUT', '/api/deadlines/:id', ({ user, params, body }) => {
    const deadline = one(
      `SELECT * FROM deadlines WHERE id = ? AND created_by = ? AND source != 'moodle'
         AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))`,
      params.id, user.id, user.id, user.group_id ?? -1,
    );
    if (!deadline) throw new HttpError(404, 'Дедлайн не знайдено');
    const { title, course, dueAt, url } = ctx.deadlineFields(body);
    run('UPDATE deadlines SET title = ?, course = ?, url = ?, due_at = ? WHERE id = ?', title, course, url, dueAt, params.id);
    // A new date means new reminders, for everyone who sees the deadline.
    if (dueAt !== deadline.due_at) run('DELETE FROM reminders_sent WHERE item_key = ?', `d${params.id}`);
    return { ok: true };
  });

  route('DELETE', '/api/deadlines/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM deadlines WHERE id = ? AND source != 'moodle'
         AND (created_by = ? OR (created_by IS NULL AND group_id IS NOT NULL))
         AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))`,
      params.id, user.id, user.id, user.group_id ?? -1,
    );
    if (!changes) throw new HttpError(404, 'Дедлайн не знайдено');
    // A group deadline whose author deleted their account can be removed by any member.
    ctx.forgetDeadline(params.id);
    return { ok: true };
  });

  route('PUT', '/api/done', ({ user, body }) => {
    ctx.markDone(user, text(body.key, 'Запис', { max: 24 }), body.done !== false);
    return { ok: true };
  });

  route('PUT', '/api/notes', ({ user, body }) => {
    const key = text(body.key, 'Запис', { max: 24 });
    const note = text(body.text, 'Нотатка', { max: 2000, required: false });
    if (!ctx.boardItems(user).some((item) => item.key === key)) throw new HttpError(404, 'Дедлайн не знайдено');
    if (note) {
      run(`INSERT INTO notes (user_id, item_key, text) VALUES (?, ?, ?)
           ON CONFLICT (user_id, item_key) DO UPDATE SET text = excluded.text`, user.id, key, note);
    } else {
      run('DELETE FROM notes WHERE user_id = ? AND item_key = ?', user.id, key);
    }
    return { ok: true };
  });

  route('POST', '/api/sync', async ({ user, res }) => {
    guard(res, [limits.sync, String(user.id)]);
    limits.sync.hit(String(user.id));
    return { imported: await ctx.syncMoodle(user) };
  });

  route('POST', '/api/import-ics', ({ user, body }) => {
    const ics = text(body.ics, 'Файл календаря', { max: MAX_FEED });
    if (!/BEGIN:VCALENDAR/i.test(ics)) throw new HttpError(400, 'Це не календар .ics');
    return { imported: ctx.importEvents(user, parseIcs(ics), null) };
  }, { limit: MAX_FEED + 4096 });
}

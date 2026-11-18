// The deadline board: what a user sees, marking done, and importing Moodle calendars.
import { MAX_FEED, BOT_WALL_MESSAGE } from '../constants.js';
import { parseIcs } from '../lib/ics.js';
import { urgency } from '../lib/urgency.js';
import { HttpError, text, link, timestamp } from '../lib/validate.js';

export function createBoard(ctx) {
  const { db, now, fetchImpl, all, run } = ctx;

  // Row ids can be reused after a delete, so per-user rows keyed by 'd<id>' go with the deadline.
  function forgetDeadline(id) {
    run('DELETE FROM deadlines WHERE id = ?', id);
    for (const table of ['notes', 'done', 'reminders_sent']) run(`DELETE FROM ${table} WHERE item_key = ?`, `d${id}`);
  }

  function markDone(user, key, isDone) {
    if (!/^d\d+$/.test(key) || !boardItems(user).some((item) => item.key === key)) {
      throw new HttpError(404, 'Дедлайн не знайдено');
    }
    if (isDone) {
      run('INSERT OR IGNORE INTO done (user_id, item_key, done_at) VALUES (?, ?, ?)', user.id, key, now());
    } else {
      run('DELETE FROM done WHERE user_id = ? AND item_key = ?', user.id, key);
    }
  }

  // What still needs doing: the board without what the user marked done.
  const openItems = (user) => boardItems(user).filter((item) => !item.done);

  function boardItems(user) {
    const t = now();
    const deadlines = all(
      `SELECT d.*, n.text AS note, dn.done_at FROM deadlines d
       LEFT JOIN notes n ON n.user_id = ? AND n.item_key = 'd' || d.id
       LEFT JOIN done dn ON dn.user_id = ? AND dn.item_key = 'd' || d.id
       WHERE d.removed_at IS NULL AND (d.owner_user_id = ? OR (d.group_id IS NOT NULL AND d.group_id = ?))`,
      user.id, user.id, user.id, user.group_id ?? -1,
    ).map((d) => ({
      key: `d${d.id}`, id: d.id, source: d.source, course: d.course, title: d.title, url: d.url,
      dueAt: d.due_at, note: d.note || '', done: d.done_at != null,
      canDelete: d.source !== 'moodle' && (d.created_by === user.id || (d.created_by == null && d.group_id != null)),
      canEdit: d.source !== 'moodle' && d.created_by === user.id,
    }));
    const exams = all(
      `SELECT e.*, n.text AS note FROM exams e
       LEFT JOIN notes n ON n.user_id = ? AND n.item_key = 'e' || e.id
       WHERE e.user_id = ?`,
      user.id, user.id,
    ).map((e) => ({
      key: `e${e.id}`, id: e.id, source: 'exam', course: e.course, title: e.title, url: '',
      dueAt: e.exam_at, note: e.note || '', done: false, canDelete: false,
    }));
    return [...deadlines, ...exams]
      .map((item) => ({ ...item, urgency: urgency(item.dueAt, t) }))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  function importEvents(user, events, origin) {
    const t = now();
    const upsert = db.prepare(
      `INSERT INTO deadlines (owner_user_id, created_by, source, uid, course, title, url, due_at)
       VALUES (?, ?, 'moodle', ?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, uid) DO UPDATE SET
         course = excluded.course, title = excluded.title, due_at = excluded.due_at, removed_at = NULL,
         url = CASE WHEN excluded.url = '' THEN deadlines.url ELSE excluded.url END`,
    );
    const existing = db.prepare('SELECT id, due_at FROM deadlines WHERE owner_user_id = ? AND uid = ?');
    db.exec('BEGIN');
    try {
      for (const ev of events) {
        let url = ev.url;
        if (!url && origin) url = `${origin}/calendar/view.php?view=day&time=${Math.floor(ev.dueAt / 1000)}`;
        const uid = ev.uid.slice(0, 500);
        const before = existing.get(user.id, uid);
        upsert.run(user.id, user.id, uid, ev.course.slice(0, 200), ev.title.slice(0, 500), url.slice(0, 2000), ev.dueAt);
        // The teacher moved the date: its reminders come again for the new one.
        if (before && before.due_at !== ev.dueAt) run('DELETE FROM reminders_sent WHERE item_key = ?', `d${before.id}`);
      }
      // A future Moodle deadline that disappeared from the feed was removed or moved in Moodle.
      // An empty feed is more likely a glitch than every assignment gone: then nothing (and no note) is deleted.
      if (origin && events.length) {
        const uids = new Set(events.map((e) => e.uid.slice(0, 500)));
        const stale = all(
          `SELECT id, uid FROM deadlines WHERE owner_user_id = ? AND source = 'moodle' AND due_at > ? AND removed_at IS NULL`, user.id, t,
        ).filter((d) => !uids.has(d.uid));
        // Hidden, not deleted: a teacher who hides an assignment for a while brings it back with the student's note.
        for (const d of stale) run('UPDATE deadlines SET removed_at = ? WHERE id = ?', t, d.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return events.length;
  }

  async function syncMoodle(user) {
    if (!user.ics_url) throw new HttpError(400, 'Спершу додайте посилання на календар Moodle');
    try {
      const imported = await downloadMoodle(user);
      run('UPDATE users SET last_sync_at = ?, sync_error = NULL WHERE id = ?', now(), user.id);
      return imported;
    } catch (err) {
      run('UPDATE users SET sync_error = ? WHERE id = ?', err instanceof HttpError ? err.message : 'Щось пішло не так', user.id);
      throw err;
    }
  }

  async function downloadMoodle(user) {
    let body;
    try {
      const res = await fetchImpl(user.ics_url, { signal: AbortSignal.timeout(15_000), maxBytes: MAX_FEED });
      const cloudflareBlock = !res.ok && /cloudflare/i.test(res.headers.get('server') || '');
      if (res.headers.get('cf-mitigated') === 'challenge' || cloudflareBlock) {
        throw new HttpError(502, BOT_WALL_MESSAGE);
      }
      if (!res.ok) throw new HttpError(502, `Moodle відповів зі статусом ${res.status}`);
      body = await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err.code === 'BLOCKED_ADDRESS') throw new HttpError(400, 'Посилання має вести на сайт в інтернеті, а не на внутрішню адресу');
      throw new HttpError(502, 'Не вдалося відкрити посилання на календар');
    }
    if (body.length > MAX_FEED) throw new HttpError(502, 'Календар завеликий');
    if (!/BEGIN:VCALENDAR/i.test(body)) throw new HttpError(502, 'За цим посиланням немає календаря');
    return importEvents(user, parseIcs(body), new URL(user.ics_url).origin);
  }

  function deadlineFields(body) {
    return {
      title: text(body.title, 'Назва'),
      course: text(body.course, 'Курс', { max: 100, required: false }),
      dueAt: timestamp(body.dueAt, 'Термін'),
      url: link(body.url),
    };
  }

  // A deadline the user adds, for themselves or (shared) for their whole group; from the site or the bot.
  function addDeadline(user, { title, course, url, dueAt }, shared) {
    if (shared && !user.group_id) throw new HttpError(400, 'Щоб ділитися дедлайнами, приєднайтеся до групи');
    const { lastInsertRowid } = run(
      `INSERT INTO deadlines (owner_user_id, group_id, created_by, source, course, title, url, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      shared ? null : user.id, shared ? user.group_id : null, user.id, shared ? 'group' : 'personal',
      course, title, url, dueAt,
    );
    const id = Number(lastInsertRowid);
    // Not awaited: the response should not wait for Telegram.
    if (shared) ctx.notifyGroup(user, { source: 'group', course, title, url, dueAt }).catch((err) => console.error(err));
    return { id, key: `d${id}` };
  }

  return { forgetDeadline, markDone, boardItems, importEvents, syncMoodle, deadlineFields, addDeadline, openItems };
}

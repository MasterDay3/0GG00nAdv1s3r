// Background jobs: reminders, the morning digest, housekeeping and Moodle sync.
import { dueReminders, reminderText, parseReminders, supersededBy } from './bot/reminders.js';
import { DIGEST_HOUR, DIGEST_WINDOW, localParts, digestText } from './bot/texts.js';
import { DAY } from './lib/urgency.js';

export function createJobs(ctx) {
  const { now, telegram, one, all, run } = ctx;

  async function runReminders() {
    const t = now();
    for (const user of all('SELECT * FROM users WHERE tg_chat_id IS NOT NULL')) {
      const sent = new Set(
        all('SELECT item_key, kind FROM reminders_sent WHERE user_id = ?', user.id).map((r) => `${r.item_key}:${r.kind}`),
      );
      // One user's bad row (or an account deleted meanwhile) must not stop everyone after them.
      try {
        for (const { item, kind } of dueReminders(ctx.openItems(user), sent, t, parseReminders(user.tg_remind))) {
          const button = item.key.startsWith('d') ? { doneKey: item.key } : {};
          if (!(await ctx.sendTo(user, reminderText(item, kind), button))) break;
          run('INSERT OR IGNORE INTO reminders_sent (user_id, item_key, kind) VALUES (?, ?, ?)', user.id, item.key, kind);
          // A later reminder makes the earlier ones pointless (the 1-day one replaces a missed 3-day one).
          for (const earlier of supersededBy(kind)) {
            run('INSERT OR IGNORE INTO reminders_sent (user_id, item_key, kind) VALUES (?, ?, ?)', user.id, item.key, earlier);
          }
        }
      } catch (err) {
        console.error(`Reminders for ${user.username} failed:`, err.message);
      }
    }
  }

  // Today's step of every coming exam's plan that has topics (date: 'YYYY-MM-DD' in Kyiv).
  function todaysStudy(user, date) {
    return all('SELECT * FROM exams WHERE user_id = ? AND exam_at > ? ORDER BY exam_at', user.id, now())
      .map((exam) => ({ exam, detail: ctx.examDetail(exam) }))
      .filter(({ detail }) => detail.topics.length)
      .map(({ exam, detail }) => ({ exam, step: detail.plan.find((d) => d.date === date) }))
      .filter(({ step }) => step)
      .map(({ exam, step }) => ({ exam: exam.title, examAt: exam.exam_at, focus: step.focus, topics: step.topics }));
  }

  // Morning digest: once a day after DIGEST_HOUR (Kyiv time), only when something is due within 7 days.
  async function runDigests() {
    const t = now();
    const { date, hour } = localParts(t);
    if (hour < DIGEST_HOUR || hour >= DIGEST_HOUR + DIGEST_WINDOW) return;
    const users = all(
      `SELECT * FROM users WHERE tg_chat_id IS NOT NULL AND tg_digest = 1 AND (tg_digest_on IS NULL OR tg_digest_on != ?)`, date,
    );
    for (const user of users) {
      try {
        const message = digestText(ctx.openItems(user), t, todaysStudy(user, date));
        if (message && !(await ctx.sendTo(user, message))) continue;
        run('UPDATE users SET tg_digest_on = ? WHERE id = ?', date, user.id);
      } catch (err) {
        console.error(`Digest for ${user.username} failed:`, err.message);
      }
    }
  }

  // Hourly housekeeping: rows that only ever grow and are no longer needed.
  function cleanup() {
    const t = now();
    // A Moodle deadline hidden for 60 days is not coming back: now it goes, with its notes and marks.
    for (const { id } of all('SELECT id FROM deadlines WHERE removed_at IS NOT NULL AND removed_at <= ?', t - 60 * DAY)) ctx.forgetDeadline(id);
    run('DELETE FROM sessions WHERE expires_at <= ?', t);
    run('DELETE FROM ai_runs WHERE created_at <= ?', t - DAY);
    run('DELETE FROM ai_explains WHERE created_at <= ?', t - DAY);
    run('DELETE FROM ai_parses WHERE created_at <= ?', t - DAY);
    // A found deadline nobody added in two days is not coming.
    run('DELETE FROM tg_drafts WHERE created_at <= ?', t - 2 * DAY);
    run('UPDATE users SET reset_hash = NULL, reset_expires = NULL, reset_tries = 0 WHERE reset_expires <= ?', t);
    // Reminder marks for deadlines and exams that are gone or a week past: no reminder can come for them any more.
    run(`DELETE FROM reminders_sent WHERE
      (item_key LIKE 'd%' AND CAST(substr(item_key, 2) AS INTEGER) NOT IN (SELECT id FROM deadlines WHERE due_at > ?))
      OR (item_key LIKE 'e%' AND CAST(substr(item_key, 2) AS INTEGER) NOT IN (SELECT id FROM exams WHERE exam_at > ?))`,
    t - 7 * DAY, t - 7 * DAY);
  }

  async function syncAll() {
    // Users with the extension connected are synced from their browser instead.
    for (const { id } of all('SELECT id FROM users WHERE ics_url IS NOT NULL AND ext_key_hash IS NULL')) {
      // Read the row now, not at the start: the link may have changed (or the account gone) while others synced.
      const user = one('SELECT * FROM users WHERE id = ? AND ics_url IS NOT NULL AND ext_key_hash IS NULL', id);
      if (!user) continue;
      try {
        await ctx.syncMoodle(user);
      } catch (err) {
        console.error(`Moodle sync for ${user.username} failed:`, err.message);
        // Tell the student once, when a sync that used to work starts failing, not every 6 hours.
        if (!user.sync_error && user.tg_chat_id && telegram.enabled) {
          await ctx.sendTo(user, `⚠️ Не вдалося оновити ваші дедлайни з Moodle: ${err.message}\nПеревірте посилання в Dueboard → Налаштування.`);
        }
      }
    }
  }

  // A job that takes longer than its interval (slow Telegram) must not start a second copy that sends everything twice.
  const single = (job) => {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try { await job(); } finally { running = false; }
    };
  };

  return { runReminders, runDigests, cleanup, syncAll, single };
}

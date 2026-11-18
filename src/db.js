// node:sqlite is built into Node; needed for persistent storage.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS study_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  group_id INTEGER REFERENCES study_groups(id) ON DELETE SET NULL,
  ics_url TEXT,
  last_sync_at INTEGER,
  tg_chat_id TEXT,
  tg_link_code TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES study_groups(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('moodle', 'personal', 'group')),
  uid TEXT,
  course TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  due_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, uid)
);
CREATE TABLE IF NOT EXISTS notes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (user_id, item_key)
);
-- Deadlines a user marked as done (per user: a group deadline can be done for one member and not another).
CREATE TABLE IF NOT EXISTS done (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_key)
);
CREATE TABLE IF NOT EXISTS reminders_sent (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (user_id, item_key, kind)
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  exam_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,
  answer_index INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  result TEXT NOT NULL
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Columns added after the first release.
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('ext_key_hash')) db.exec('ALTER TABLE users ADD COLUMN ext_key_hash TEXT');
  if (!userColumns.includes('tg_digest')) db.exec('ALTER TABLE users ADD COLUMN tg_digest INTEGER NOT NULL DEFAULT 1');
  // Kyiv date ('YYYY-MM-DD') of the last morning digest, so it goes out once a day.
  if (!userColumns.includes('tg_digest_on')) db.exec('ALTER TABLE users ADD COLUMN tg_digest_on TEXT');
  // Password reset through Telegram: a one-time code (stored hashed), when it expires and how many wrong tries it had.
  // Each column on its own, so a start that died halfway through still gets the rest.
  if (!userColumns.includes('reset_hash')) db.exec('ALTER TABLE users ADD COLUMN reset_hash TEXT');
  if (!userColumns.includes('reset_expires')) db.exec('ALTER TABLE users ADD COLUMN reset_expires INTEGER');
  if (!userColumns.includes('reset_tries')) db.exec('ALTER TABLE users ADD COLUMN reset_tries INTEGER NOT NULL DEFAULT 0');
  // Wrong reset codes per account across codes, in a day (a new code must not reset the count).
  if (!userColumns.includes('reset_fails')) db.exec('ALTER TABLE users ADD COLUMN reset_fails INTEGER NOT NULL DEFAULT 0');
  if (!userColumns.includes('reset_fails_at')) db.exec('ALTER TABLE users ADD COLUMN reset_fails_at INTEGER');
  // Secret link to the board as a calendar feed (stored hashed, like the extension key).
  if (!userColumns.includes('cal_token_hash')) db.exec('ALTER TABLE users ADD COLUMN cal_token_hash TEXT');
  // Why the last Moodle sync failed (NULL after a good one), so the student sees it instead of a silently stale board.
  if (!userColumns.includes('sync_error')) db.exec('ALTER TABLE users ADD COLUMN sync_error TEXT');
  // Which Telegram reminders the user wants, e.g. "3d,1d,3h" (NULL: the default 3 days and 1 day).
  if (!userColumns.includes('tg_remind')) db.exec('ALTER TABLE users ADD COLUMN tg_remind TEXT');
  // Which questions a diagnostic attempt got wrong (JSON array of ids), for "practise your mistakes".
  // A Moodle deadline that left the feed is hidden, not deleted, so its notes and done mark come back with it.
  const deadlineColumns = db.prepare('PRAGMA table_info(deadlines)').all().map((c) => c.name);
  if (!deadlineColumns.includes('removed_at')) db.exec('ALTER TABLE deadlines ADD COLUMN removed_at INTEGER');
  const attemptColumns = db.prepare('PRAGMA table_info(attempts)').all().map((c) => c.name);
  if (!attemptColumns.includes('wrong')) db.exec("ALTER TABLE attempts ADD COLUMN wrong TEXT NOT NULL DEFAULT '[]'");
  // What the exam covers, in the student's words; the AI keeps its questions to it.
  const examColumns = db.prepare('PRAGMA table_info(exams)').all().map((c) => c.name);
  if (!examColumns.includes('theme')) db.exec("ALTER TABLE exams ADD COLUMN theme TEXT NOT NULL DEFAULT ''");
  // Why the right answer is right, shown after a wrong answer (NULL: none yet; the AI can write one on demand).
  const questionColumns = db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name);
  if (!questionColumns.includes('explanation')) db.exec('ALTER TABLE questions ADD COLUMN explanation TEXT');
  // AI explanations asked for, per user, for a daily limit.
  db.exec('CREATE TABLE IF NOT EXISTS ai_explains (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ext_key ON users (ext_key_hash)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_cal_token ON users (cal_token_hash)');
  // AI-generated questions: which uploaded file and slide each one comes from (slide 0 = the whole file).
  db.exec(`
CREATE TABLE IF NOT EXISTS question_sources (
  question_id INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  slide INTEGER NOT NULL,
  quote TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);`);
  return db;
}

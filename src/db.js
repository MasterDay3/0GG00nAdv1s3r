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
  if (!userColumns.includes('reset_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN reset_hash TEXT');
    db.exec('ALTER TABLE users ADD COLUMN reset_expires INTEGER');
    db.exec('ALTER TABLE users ADD COLUMN reset_tries INTEGER NOT NULL DEFAULT 0');
  }
  // Secret link to the board as a calendar feed (stored hashed, like the extension key).
  if (!userColumns.includes('cal_token_hash')) db.exec('ALTER TABLE users ADD COLUMN cal_token_hash TEXT');
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

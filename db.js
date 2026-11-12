const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const seedTasks = require('./seed-tasks');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TEAM_COUNT = parseInt(process.env.TEAM_COUNT || '25', 10);
const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS || '4', 10);

const db = new Database(path.join(DATA_DIR, 'mumbaimaxing.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 10,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  comment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sub_team_task ON submissions(team_id, task_id);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  size INTEGER NOT NULL
);
-- Files uploaded one by one while the player is still capturing; attached to a submission on Send.
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Google Drive sync columns (added after launch — migrate existing databases in place).
const mediaCols = db.prepare('PRAGMA table_info(media)').all().map(c => c.name);
for (const [col, def] of [['drive_id', 'TEXT'], ['drive_error', 'TEXT'], ['drive_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['drive_next_try', 'INTEGER NOT NULL DEFAULT 0'], ['local_deleted', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!mediaCols.includes(col)) db.exec(`ALTER TABLE media ADD COLUMN ${col} ${def}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS drive_folders (key TEXT PRIMARY KEY, id TEXT NOT NULL)`);

// Room codes avoid look-alike characters (0/O, 1/I/L) so they're easy to read out loud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(len = 6) {
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
function uniqueCode() {
  const exists = db.prepare('SELECT 1 FROM teams WHERE code = ?');
  let c;
  do c = makeCode(); while (exists.get(c));
  return c;
}

// First-run seeding: teams + tasks.
if (db.prepare('SELECT COUNT(*) n FROM teams').get().n === 0) {
  const ins = db.prepare('INSERT INTO teams (name, code) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 1; i <= TEAM_COUNT; i++) ins.run(`Team ${String(i).padStart(2, '0')}`, uniqueCode());
  })();
}
if (db.prepare('SELECT COUNT(*) n FROM tasks').get().n === 0) {
  const ins = db.prepare('INSERT INTO tasks (title, description, points, sort) VALUES (?, ?, ?, ?)');
  db.transaction(() => seedTasks.forEach(([t, d, p], i) => ins.run(t, d, p, i + 1)))();
}

function getSetting(key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

module.exports = { db, DATA_DIR, UPLOAD_DIR, MAX_MEMBERS, uniqueCode, getSetting, setSetting };

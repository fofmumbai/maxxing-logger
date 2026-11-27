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

// What each task asks players to submit. 0 photos / 0 videos means no photo / video is asked for.
{
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  for (const [col, def] of [['min_photos', 'INTEGER NOT NULL DEFAULT 0'], ['min_videos', 'INTEGER NOT NULL DEFAULT 0'], ['needs_link', 'INTEGER NOT NULL DEFAULT 0'], ['link_label', "TEXT NOT NULL DEFAULT ''"], ['allow_gallery', 'INTEGER NOT NULL DEFAULT 0'], ['opens_at', 'INTEGER'], ['closes_at', 'INTEGER']]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
  }
  const scols = db.prepare('PRAGMA table_info(submissions)').all().map(c => c.name);
  if (!scols.includes('link')) db.exec("ALTER TABLE submissions ADD COLUMN link TEXT NOT NULL DEFAULT ''");
}

// Capture details sent by the phone: when it was taken and where (GPS), plus when the server received it.
// source: 'camera' (captured live in the app) or 'gallery' (picked from the phone's library, only on tasks that allow it).
const CAPTURE_COLS = [['captured_at', 'INTEGER'], ['lat', 'REAL'], ['lng', 'REAL'], ['accuracy', 'REAL'], ['uploaded_at', 'INTEGER'], ['source', "TEXT NOT NULL DEFAULT 'camera'"]];
for (const table of ['uploads', 'media']) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [col, def] of CAPTURE_COLS) if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// Onboarding selfie: every member takes one live photo with the in-app camera before seeing tasks.
// Proves camera (and location) access works on their phone, and gives organisers a face for each name.
{
  const cols = db.prepare('PRAGMA table_info(members)').all().map(c => c.name);
  for (const [col, def] of [['selfie', 'TEXT'], ['selfie_size', 'INTEGER'], ['selfie_captured_at', 'INTEGER'], ['selfie_lat', 'REAL'], ['selfie_lng', 'REAL'], ['selfie_accuracy', 'REAL'], ['selfie_uploaded_at', 'INTEGER'],
    // Copied to Google Drive like task media (the local file is kept: it's every avatar in the apps).
    ['selfie_drive_id', 'TEXT'], ['selfie_drive_error', 'TEXT'], ['selfie_drive_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['selfie_drive_next_try', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE members ADD COLUMN ${col} ${def}`);
  }
}

// Saved drafts: captures a player kept for later on a task ("Save for later" when closing the task).
// The files stay in uploads, tagged with the task; the note and link are kept here.
{
  const cols = db.prepare('PRAGMA table_info(uploads)').all().map(c => c.name);
  if (!cols.includes('task_id')) db.exec('ALTER TABLE uploads ADD COLUMN task_id INTEGER');
  if (!cols.includes('duration')) db.exec('ALTER TABLE uploads ADD COLUMN duration REAL');
}
db.exec(`
CREATE TABLE IF NOT EXISTS drafts (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, task_id)
);
`);

// End-of-day check-in: one row per member who scanned the venue QR code (or was marked in by an organiser).
db.exec(`
CREATE TABLE IF NOT EXISTS checkins (
  member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'qr',
  marked_by TEXT NOT NULL DEFAULT ''
);
`);

// Reviewer accounts created by the super admin, and the teams each one reviews.
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS admin_teams (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (admin_id, team_id)
);
`);
{
  const scols = db.prepare('PRAGMA table_info(submissions)').all().map(c => c.name);
  if (!scols.includes('reviewed_by')) db.exec("ALTER TABLE submissions ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT ''");
}

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
  const ins = db.prepare(`INSERT INTO tasks (title, description, points, sort, min_photos, min_videos, needs_link, link_label, allow_gallery)
    VALUES (@title, @description, @points, @sort, @min_photos, @min_videos, @needs_link, @link_label, @allow_gallery)`);
  const defaults = { description: '', min_photos: 0, min_videos: 0, needs_link: 0, link_label: '', allow_gallery: 0 };
  db.transaction(() => seedTasks.forEach((t, i) => ins.run({ ...defaults, ...t, sort: i + 1 })))();
}

// One-time: tasks saved with 0 photos, 0 videos and no link used to mean "at least 1 photo or video".
// That rule is gone (0 now means none), so those tasks become "1 photo" once to keep their camera button.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'zeroMeansNone'").get()) {
  db.transaction(() => {
    db.prepare('UPDATE tasks SET min_photos = 1 WHERE min_photos = 0 AND min_videos = 0 AND needs_link = 0').run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('zeroMeansNone', 'true')").run();
  })();
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

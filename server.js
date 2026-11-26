const path = require('path');
const fs = require('fs');

// Load settings from a .env file next to this script (KEY=value per line). Real env vars win.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, UPLOAD_DIR, MAX_MEMBERS, uniqueCode, getSetting, setSetting } = require('./db');
const drive = require('./drive');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SUPERADMIN_USERNAME = (process.env.SUPERADMIN_USERNAME || 'admin').trim().toLowerCase();
if (!process.env.ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD not set — using "changeme". Set it before the event!');

let secret = getSetting('secret', null);
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setSetting('secret', secret); }
const ADMIN_TOKEN = crypto.createHmac('sha256', secret).update('admin:' + ADMIN_PASSWORD).digest('hex');

const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '300', 10);
const MAX_FILES = 12;


const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// ---------- Realtime (Server-Sent Events) ----------
const teamClients = new Map(); // teamId -> Set<res>
const adminClients = new Map(); // res -> admin (super admin, or a reviewer limited to their teams)

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => clearInterval(ping));
}
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function toTeam(teamId, event, data) { (teamClients.get(teamId) || []).forEach(r => send(r, event, data)); }
function toAllTeams(event, data) { teamClients.forEach(set => set.forEach(r => send(r, event, data))); }
// Reviewers only hear about their own teams (assignments are looked up fresh, so changes apply at once).
function toAdmins(event, data) {
  adminClients.forEach((a, r) => {
    if (a.super || data?.teamId == null || reviewerTeamIds(a.id).includes(data.teamId)) send(r, event, data);
  });
}
function toAdmin(adminId, event, data) { adminClients.forEach((a, r) => { if (a.id === adminId) send(r, event, data); }); }

// ---------- Auth helpers ----------
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
}
function teamAuth(req, res, next) {
  const m = db.prepare(`SELECT m.id, m.name, m.team_id, m.selfie FROM members m WHERE m.token = ?`).get(bearer(req));
  if (!m) return res.status(401).json({ error: 'Session expired. Please join again with your room code.' });
  req.member = m;
  next();
}
// Passwords for reviewer accounts: scrypt with a per-account salt.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reviewerTeamIds = adminId => db.prepare('SELECT team_id FROM admin_teams WHERE admin_id = ? ORDER BY team_id').all(adminId).map(r => r.team_id);

// Super admin (ADMIN_PASSWORD) can do everything. Reviewers see and review only their assigned teams.
function adminAuth(req, res, next) {
  const t = bearer(req);
  if (t && safeEqual(t, ADMIN_TOKEN)) { req.admin = { super: true, id: 0, name: 'Super admin', username: SUPERADMIN_USERNAME }; return next(); }
  const a = t && db.prepare('SELECT id, name, username FROM admins WHERE token = ?').get(t);
  if (!a) return res.status(401).json({ error: 'Not authorised' });
  req.admin = { super: false, ...a, teamIds: reviewerTeamIds(a.id) };
  next();
}
function superOnly(req, res, next) {
  if (!req.admin?.super) return res.status(403).json({ error: 'Only the super admin can do that.' });
  next();
}
const canSeeTeam = (req, teamId) => req.admin.super || req.admin.teamIds.includes(+teamId);
// SQL fragment limiting a query to the teams this admin may see.
function teamScope(req, col) {
  if (req.admin.super) return { sql: '1', args: [] };
  const ids = req.admin.teamIds;
  return ids.length ? { sql: `${col} IN (${ids.map(() => '?').join(',')})`, args: ids } : { sql: '0', args: [] };
}

// ---------- Queries ----------
const scoreSql = `
  SELECT t.id, t.name, t.code,
    COALESCE((SELECT SUM(k.points) FROM submissions s JOIN tasks k ON k.id = s.task_id
              WHERE s.team_id = t.id AND s.status = 'approved'), 0) AS points,
    (SELECT COUNT(*) FROM submissions s WHERE s.team_id = t.id AND s.status = 'approved') AS approved,
    (SELECT COUNT(*) FROM submissions s WHERE s.team_id = t.id AND s.status = 'pending') AS pending,
    (SELECT COUNT(*) FROM members m WHERE m.team_id = t.id) AS member_count,
    (SELECT MAX(s.reviewed_at) FROM submissions s WHERE s.team_id = t.id AND s.status = 'approved') AS last_approved
  FROM teams t`;
function leaderboard() {
  return db.prepare(`${scoreSql} ORDER BY points DESC, last_approved ASC, t.id ASC`).all()
    .map(({ code, ...r }) => r);
}
function mediaFor(subIds) {
  if (!subIds.length) return {};
  const rows = db.prepare(`SELECT * FROM media WHERE submission_id IN (${subIds.map(() => '?').join(',')}) ORDER BY id`).all(...subIds);
  const out = {};
  rows.forEach(m => (out[m.submission_id] ||= []).push({
    id: m.id, url: '/media/' + m.filename, kind: m.kind, mime: m.mime, size: m.size,
    driveUrl: m.drive_id ? `https://drive.google.com/file/d/${m.drive_id}/view` : null,
    capturedAt: m.captured_at, uploadedAt: m.uploaded_at,
    lat: m.lat, lng: m.lng, accuracy: m.accuracy, source: m.source || 'camera',
  }));
  return out;
}
// Members as sent to the apps: the selfie becomes a /media URL plus when and where it was taken.
const MEMBER_COLS = 'id, team_id, name, created_at, selfie, selfie_captured_at, selfie_lat, selfie_lng, selfie_accuracy, selfie_uploaded_at';
function memberOut(m) {
  return {
    id: m.id, team_id: m.team_id, name: m.name, created_at: m.created_at,
    selfie: m.selfie ? '/media/' + m.selfie : null,
    selfieAt: m.selfie_captured_at, selfieUploadedAt: m.selfie_uploaded_at,
    selfieLat: m.selfie_lat, selfieLng: m.selfie_lng, selfieAccuracy: m.selfie_accuracy,
  };
}
function teamState(teamId) {
  const team = db.prepare(`${scoreSql} WHERE t.id = ?`).get(teamId);
  const members = db.prepare(`SELECT ${MEMBER_COLS} FROM members WHERE team_id = ? ORDER BY id`).all(teamId).map(memberOut);
  const tasks = db.prepare('SELECT id, title, description, points, min_photos, min_videos, needs_link, link_label, allow_gallery, opens_at, closes_at FROM tasks ORDER BY sort, id').all();
  const subs = db.prepare(`
    SELECT s.*, m.name AS member_name, k.title AS task_title, k.points
    FROM submissions s LEFT JOIN members m ON m.id = s.member_id JOIN tasks k ON k.id = s.task_id
    WHERE s.team_id = ? ORDER BY s.id DESC`).all(teamId);
  const media = mediaFor(subs.map(s => s.id));
  subs.forEach(s => (s.media = media[s.id] || []));
  return {
    team, members, tasks, submissions: subs, maxMembers: MAX_MEMBERS,
    showLeaderboard: getSetting('showLeaderboard', false),
    submissionsOpen: getSetting('submissionsOpen', true),
  };
}

// ---------- Team API ----------
app.post('/api/join', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!code || !name) return res.status(400).json({ error: 'Enter your room code and your name.' });
  const team = db.prepare('SELECT id, name FROM teams WHERE code = ?').get(code);
  if (!team) return res.status(404).json({ error: 'That room code doesn\'t exist. Check with your organiser.' });

  // Same name re-joining (new phone, cleared browser) gets the existing seat back.
  const existing = db.prepare('SELECT * FROM members WHERE team_id = ? AND lower(name) = lower(?)').get(team.id, name);
  let token;
  if (existing) {
    token = existing.token;
  } else {
    const count = db.prepare('SELECT COUNT(*) n FROM members WHERE team_id = ?').get(team.id).n;
    if (count >= MAX_MEMBERS) return res.status(409).json({ error: `${team.name} already has ${MAX_MEMBERS} members. If this is you, use the exact same name you joined with.` });
    token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO members (team_id, name, token) VALUES (?, ?, ?)').run(team.id, name, token);
    toTeam(team.id, 'refresh', {});
    toAdmins('teams', {});
  }
  res.json({ token });
});

app.get('/api/me', teamAuth, (req, res) => {
  res.json({ me: { id: req.member.id, name: req.member.name, selfie: req.member.selfie ? '/media/' + req.member.selfie : null }, serverNow: Date.now(), ...teamState(req.member.team_id) });
});

app.get('/api/leaderboard', teamAuth, (req, res) => {
  if (!getSetting('showLeaderboard', false)) return res.status(403).json({ error: 'Leaderboard is hidden right now.' });
  res.json(leaderboard());
});

app.get('/api/events', teamAuth, (req, res) => {
  const id = req.member.team_id;
  openStream(req, res);
  if (!teamClients.has(id)) teamClients.set(id, new Set());
  teamClients.get(id).add(res);
  req.on('close', () => teamClients.get(id)?.delete(res));
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [''])[0]
        || (file.mimetype.startsWith('video/') ? '.mp4' : '.jpg');
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

// Time and GPS position the phone recorded when the photo/video was taken (all optional, validated).
function captureMeta(body) {
  const num = (v, min, max) => { const n = parseFloat(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const lat = num(body.lat, -90, 90), lng = num(body.lng, -180, 180);
  const hasPos = lat !== null && lng !== null && !(lat === 0 && lng === 0);
  return {
    captured_at: num(body.captured_at, 1.5e12, 4e12), // ms since epoch
    lat: hasPos ? lat : null,
    lng: hasPos ? lng : null,
    accuracy: hasPos ? num(body.accuracy, 0, 1e6) : null, // metres
    source: body.source === 'gallery' ? 'gallery' : 'camera',
  };
}

// Step 1: each photo/video is uploaded on its own as soon as it's captured.
app.post('/api/uploads', teamAuth, (req, res) => {
  upload.single('media')(req, res, err => {
    const f = req.file;
    if (err) {
      if (f) fs.unlink(f.path, () => {});
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_FILE_MB} MB. Record a shorter video.` : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!f) return res.status(400).json({ error: 'Only photos and videos can be uploaded.' });
    const g = captureMeta(req.body);
    const r = db.prepare('INSERT INTO uploads (member_id, team_id, filename, mime, kind, size, captured_at, lat, lng, accuracy, uploaded_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.member.id, req.member.team_id, f.filename, f.mimetype, f.mimetype.startsWith('video/') ? 'video' : 'image', f.size,
        g.captured_at, g.lat, g.lng, g.accuracy, Date.now(), g.source);
    res.json({ id: r.lastInsertRowid, size: f.size });
  });
});

// Onboarding selfie: one live photo per member. Taking a new one replaces the old file.
app.post('/api/me/selfie', teamAuth, (req, res) => {
  upload.single('media')(req, res, err => {
    const f = req.file;
    if (err || !f || !f.mimetype.startsWith('image/')) {
      if (f) fs.unlink(f.path, () => {});
      return res.status(400).json({ error: err?.code === 'LIMIT_FILE_SIZE' ? `Photo is larger than ${MAX_FILE_MB} MB.` : err?.message || 'Send a photo.' });
    }
    const g = captureMeta(req.body);
    const old = req.member.selfie;
    db.prepare(`UPDATE members SET selfie = ?, selfie_size = ?, selfie_captured_at = ?, selfie_lat = ?, selfie_lng = ?, selfie_accuracy = ?, selfie_uploaded_at = ? WHERE id = ?`)
      .run(f.filename, f.size, g.captured_at, g.lat, g.lng, g.accuracy, Date.now(), req.member.id);
    if (old) fs.unlink(path.join(UPLOAD_DIR, old), () => {});
    toTeam(req.member.team_id, 'refresh', {});
    toAdmins('reviewed', { teamId: req.member.team_id }); // refreshes the team list and that team's page
    res.json({ selfie: '/media/' + f.filename });
  });
});

// Player removed a captured item before sending.
app.delete('/api/uploads/:id', teamAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM uploads WHERE id = ? AND team_id = ?').get(req.params.id, req.member.team_id);
  if (u) { db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id); fs.unlink(path.join(UPLOAD_DIR, u.filename), () => {}); }
  res.json({ ok: true });
});

// ---------- Task schedule (times stored as ms since epoch; shown in IST) ----------
const CLOSE_GRACE_MS = 60 * 1000; // uploads already in flight when the timer hits zero still count
const fmtIST = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + ' IST';
function windowError(task, now = Date.now()) {
  if (task.opens_at && now < task.opens_at) return `This task opens at ${fmtIST(task.opens_at)}.`;
  if (task.closes_at && now > task.closes_at + CLOSE_GRACE_MS) return `Submissions for this task closed at ${fmtIST(task.closes_at)}.`;
  return '';
}

// ---------- Task requirements ----------
function cleanLink(v) {
  const s = String(v || '').trim().slice(0, 500);
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname.includes('.') ? u.href : '';
  } catch { return ''; }
}
// Returns a human list of what's missing ("1 photo, a link"), or '' when the task's requirements are met.
function missingRequirements(task, ups, link) {
  const photos = ups.filter(u => u.kind === 'image').length, videos = ups.filter(u => u.kind === 'video').length;
  const out = [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (photos < task.min_photos) out.push(plural(task.min_photos - photos, 'more photo'));
  if (videos < task.min_videos) out.push(plural(task.min_videos - videos, 'more video'));
  if (task.needs_link && !link) out.push('a link');
  return out.join(', ');
}

// Step 2: Send attaches the already-uploaded files to a new submission.
app.post('/api/submissions', teamAuth, (req, res) => {
  if (!getSetting('submissionsOpen', true)) return res.status(403).json({ error: 'Submissions are closed.' });
  const taskId = parseInt(req.body.task_id, 10);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const ids = [...new Set((Array.isArray(req.body.upload_ids) ? req.body.upload_ids : []).map(Number).filter(Boolean))].slice(0, MAX_FILES);
  const teamId = req.member.team_id;
  const ups = ids.length ? db.prepare(`SELECT * FROM uploads WHERE team_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(teamId, ...ids) : [];
  if (ups.length !== ids.length) return res.status(400).json({ error: 'Some files are missing. Please capture them again.' });
  if (!task.allow_gallery && ups.some(u => u.source === 'gallery')) return res.status(400).json({ error: 'This task only accepts photos and videos taken with the in-app camera.' });
  const link = cleanLink(req.body.link);
  if (req.body.link && String(req.body.link).trim() && !link) return res.status(400).json({ error: 'That link doesn\'t look right. Paste a full link starting with https://' });
  const win = windowError(task);
  if (win) return res.status(403).json({ error: win });
  const missing = missingRequirements(task, ups, link);
  if (missing) return res.status(400).json({ error: `Still needed: ${missing}.` });

  const blocking = db.prepare(`SELECT status FROM submissions WHERE team_id = ? AND task_id = ? AND status IN ('pending','approved') LIMIT 1`).get(teamId, taskId);
  if (blocking) return res.status(409).json({ error: blocking.status === 'approved' ? 'This task is already approved for your team.' : 'Your team already has a submission waiting for review on this task.' });

  const subId = db.transaction(() => {
    const r = db.prepare('INSERT INTO submissions (team_id, task_id, member_id, note, link) VALUES (?, ?, ?, ?, ?)')
      .run(teamId, taskId, req.member.id, String(req.body.note || '').slice(0, 500), link);
    const ins = db.prepare('INSERT INTO media (submission_id, filename, mime, kind, size, captured_at, lat, lng, accuracy, uploaded_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const del = db.prepare('DELETE FROM uploads WHERE id = ?');
    // Keep the order the player captured them in.
    ids.map(id => ups.find(u => u.id === id)).forEach(u => {
      ins.run(r.lastInsertRowid, u.filename, u.mime, u.kind, u.size, u.captured_at, u.lat, u.lng, u.accuracy, u.uploaded_at, u.source || 'camera');
      del.run(u.id);
    });
    return r.lastInsertRowid;
  })();

  toTeam(teamId, 'refresh', {});
  toAdmins('submission', { id: subId, teamId });
  drive.kick(); // copy the new files to Google Drive in the background
  res.json({ ok: true, id: subId });
});

// Remove uploads that were never sent (abandoned captures) after 12 hours.
setInterval(() => {
  const old = db.prepare(`SELECT * FROM uploads WHERE created_at < unixepoch() - 43200`).all();
  old.forEach(u => { db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id); fs.unlink(path.join(UPLOAD_DIR, u.filename), () => {}); });
}, 60 * 60 * 1000);

// ---------- Admin API ----------
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });
  if (username === SUPERADMIN_USERNAME) {
    if (!safeEqual(crypto.createHash('sha256').update(password).digest('hex'), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex')))
      return res.status(401).json({ error: 'Wrong username or password.' });
    return res.json({ token: ADMIN_TOKEN });
  }
  const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!a || !checkPassword(password, a.pass_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: a.token });
});

app.get('/api/admin/me', adminAuth, (req, res) => {
  const { super: isSuper, id, name, username, teamIds = [] } = req.admin;
  res.json({ super: isSuper, id, name, username, teamIds });
});

app.get('/api/admin/events', adminAuth, (req, res) => {
  openStream(req, res);
  adminClients.set(res, { super: req.admin.super, id: req.admin.id });
  req.on('close', () => adminClients.delete(res));
});

// ---------- Reviewer accounts (super admin only) ----------
function cleanAdmin(b, creating) {
  const a = {
    name: String(b.name || '').trim().slice(0, 60),
    username: String(b.username || '').trim().toLowerCase().slice(0, 40),
    password: String(b.password || ''),
    teamIds: [...new Set((Array.isArray(b.teamIds) ? b.teamIds : []).map(Number).filter(Number.isInteger))],
  };
  if (!a.name) return { error: 'Enter a name.' };
  if (!/^[a-z0-9._-]{3,40}$/.test(a.username)) return { error: 'Username needs 3–40 letters, numbers, dots, dashes or underscores (no spaces).' };
  if (a.username === SUPERADMIN_USERNAME) return { error: 'That username is taken by the super admin.' };
  if ((creating || a.password) && a.password.length < 6) return { error: 'Password must be at least 6 characters.' };
  return a;
}
function setAdminTeams(adminId, teamIds) {
  db.prepare('DELETE FROM admin_teams WHERE admin_id = ?').run(adminId);
  const ins = db.prepare('INSERT OR IGNORE INTO admin_teams (admin_id, team_id) SELECT ?, id FROM teams WHERE id = ?');
  teamIds.forEach(t => ins.run(adminId, t));
}
app.get('/api/admin/admins', adminAuth, superOnly, (req, res) => {
  const admins = db.prepare('SELECT id, name, username, created_at FROM admins ORDER BY name COLLATE NOCASE').all();
  admins.forEach(a => (a.teamIds = reviewerTeamIds(a.id)));
  res.json({ admins, superUsername: SUPERADMIN_USERNAME });
});
app.post('/api/admin/admins', adminAuth, superOnly, (req, res) => {
  const a = cleanAdmin(req.body, true);
  if (a.error) return res.status(400).json(a);
  if (db.prepare('SELECT 1 FROM admins WHERE username = ?').get(a.username)) return res.status(409).json({ error: 'That username is already in use.' });
  db.transaction(() => {
    const r = db.prepare('INSERT INTO admins (name, username, pass_hash, token) VALUES (?, ?, ?, ?)')
      .run(a.name, a.username, hashPassword(a.password), crypto.randomBytes(24).toString('hex'));
    setAdminTeams(r.lastInsertRowid, a.teamIds);
  })();
  res.json({ ok: true });
});
app.put('/api/admin/admins/:id', adminAuth, superOnly, (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM admins WHERE id = ?').get(id)) return res.status(404).json({ error: 'Admin not found' });
  const a = cleanAdmin(req.body, false);
  if (a.error) return res.status(400).json(a);
  if (db.prepare('SELECT 1 FROM admins WHERE username = ? AND id != ?').get(a.username, id)) return res.status(409).json({ error: 'That username is already in use.' });
  db.transaction(() => {
    db.prepare('UPDATE admins SET name = ?, username = ? WHERE id = ?').run(a.name, a.username, id);
    // A new password signs them out everywhere.
    if (a.password) db.prepare('UPDATE admins SET pass_hash = ?, token = ? WHERE id = ?').run(hashPassword(a.password), crypto.randomBytes(24).toString('hex'), id);
    setAdminTeams(id, a.teamIds);
  })();
  if (a.password) toAdmin(id, 'signout', {});
  else toAdmin(id, 'teams', {});
  res.json({ ok: true });
});
app.delete('/api/admin/admins/:id', adminAuth, superOnly, (req, res) => {
  const id = +req.params.id;
  toAdmin(id, 'signout', {});
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/admin/summary', adminAuth, (req, res) => {
  const sc = teamScope(req, 'team_id');
  const c = db.prepare(`SELECT status, COUNT(*) n FROM submissions WHERE ${sc.sql} GROUP BY status`).all(...sc.args);
  const counts = { pending: 0, approved: 0, rejected: 0 };
  c.forEach(r => (counts[r.status] = r.n));
  res.json({
    counts,
    showLeaderboard: getSetting('showLeaderboard', false),
    submissionsOpen: getSetting('submissionsOpen', true),
  });
});

app.get('/api/admin/submissions', adminAuth, (req, res) => {
  const sc = teamScope(req, 's.team_id');
  const where = [sc.sql], args = [...sc.args];
  if (['pending', 'approved', 'rejected'].includes(req.query.status)) { where.push('s.status = ?'); args.push(req.query.status); }
  if (req.query.team) { where.push('s.team_id = ?'); args.push(+req.query.team); }
  if (req.query.task) { where.push('s.task_id = ?'); args.push(+req.query.task); }
  // Pending queue is oldest-first (fair review order); everything else newest-first.
  const order = req.query.status === 'pending' ? 's.id ASC' : 's.id DESC';
  const rows = db.prepare(`
    SELECT s.*, t.name AS team_name, k.title AS task_title, k.points, k.description AS task_description, m.name AS member_name
    FROM submissions s JOIN teams t ON t.id = s.team_id JOIN tasks k ON k.id = s.task_id
    LEFT JOIN members m ON m.id = s.member_id
    WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 300`).all(...args);
  const media = mediaFor(rows.map(r => r.id));
  rows.forEach(r => (r.media = media[r.id] || []));
  res.json(rows);
});

app.post('/api/admin/submissions/:id/review', adminAuth, (req, res) => {
  const status = req.body.status;
  const comment = String(req.body.comment || '').trim().slice(0, 1000);
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (status === 'rejected' && !comment) return res.status(400).json({ error: 'Add a comment so the team knows why it was rejected.' });
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub || !canSeeTeam(req, sub.team_id)) return res.status(404).json({ error: 'Not found' });
  if (status === 'approved') {
    const other = db.prepare(`SELECT id FROM submissions WHERE team_id = ? AND task_id = ? AND status = 'approved' AND id != ?`).get(sub.team_id, sub.task_id, sub.id);
    if (other) return res.status(409).json({ error: 'This team already has an approved submission for this task.' });
  }
  db.prepare('UPDATE submissions SET status = ?, comment = ?, reviewed_at = unixepoch(), reviewed_by = ? WHERE id = ?').run(status, comment, req.admin.name, sub.id);
  const task = db.prepare('SELECT title, points FROM tasks WHERE id = ?').get(sub.task_id);
  toTeam(sub.team_id, 'review', { submissionId: sub.id, status, comment, task: task.title, points: task.points });
  toAdmins('reviewed', { id: sub.id, teamId: sub.team_id });
  if (getSetting('showLeaderboard', false)) toAllTeams('leaderboard', {});
  res.json({ ok: true });
});

app.get('/api/admin/teams', adminAuth, (req, res) => {
  const sc = teamScope(req, 't.id');
  const teams = db.prepare(`${scoreSql} WHERE ${sc.sql} ORDER BY t.id`).all(...sc.args);
  const members = db.prepare(`SELECT ${MEMBER_COLS} FROM members ORDER BY id`).all().map(memberOut);
  const reviewers = req.admin.super ? db.prepare('SELECT at.team_id, a.name FROM admin_teams at JOIN admins a ON a.id = at.admin_id ORDER BY a.name').all() : [];
  teams.forEach(t => {
    t.members = members.filter(m => m.team_id === t.id);
    t.reviewers = reviewers.filter(r => r.team_id === t.id).map(r => r.name);
  });
  res.json({ teams, maxMembers: MAX_MEMBERS });
});
app.get('/api/admin/teams/:id', adminAuth, (req, res) => {
  const id = +req.params.id;
  if (!canSeeTeam(req, id) || !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id)) return res.status(404).json({ error: 'Team not found' });
  const st = teamState(id);
  st.team.rejected = db.prepare(`SELECT COUNT(*) n FROM submissions WHERE team_id = ? AND status = 'rejected'`).get(id).n;
  res.json(st);
});
app.get('/api/admin/leaderboard', adminAuth, (req, res) =>
  res.json(req.admin.super ? leaderboard() : leaderboard().map(({ id, name, points }) => ({ id, name, points }))));

app.post('/api/admin/teams', adminAuth, superOnly, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM teams').get().n;
  const name = String(req.body.name || '').trim() || `Team ${String(n + 1).padStart(2, '0')}`;
  db.prepare('INSERT INTO teams (name, code) VALUES (?, ?)').run(name.slice(0, 40), uniqueCode());
  res.json({ ok: true });
});
app.patch('/api/admin/teams/:id', adminAuth, superOnly, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, req.params.id);
  toTeam(+req.params.id, 'refresh', {});
  res.json({ ok: true });
});
app.post('/api/admin/teams/:id/new-code', adminAuth, superOnly, (req, res) => {
  db.prepare('UPDATE teams SET code = ? WHERE id = ?').run(uniqueCode(), req.params.id);
  res.json({ ok: true });
});
// Delete media files everywhere: local copy (if still here) and the Drive copy (moved to trash).
function purgeMedia(rows) {
  rows.forEach(m => { if (!m.local_deleted) fs.unlink(path.join(UPLOAD_DIR, m.filename), () => {}); });
  drive.trash(rows.filter(m => m.drive_id).map(m => m.drive_id));
}
function deleteSubmissions(subIds) {
  if (!subIds.length) return 0;
  const q = subIds.map(() => '?').join(',');
  const media = db.prepare(`SELECT * FROM media WHERE submission_id IN (${q})`).all(...subIds);
  db.prepare(`DELETE FROM submissions WHERE id IN (${q})`).run(...subIds); // media rows cascade
  purgeMedia(media);
  return media.length;
}

// Remove a member. ?withMedia=1 also deletes every submission they sent (and its photos/videos).
app.delete('/api/admin/members/:id', adminAuth, superOnly, (req, res) => {
  const m = db.prepare('SELECT team_id, selfie FROM members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Member not found' });
  if (m.selfie) fs.unlink(path.join(UPLOAD_DIR, m.selfie), () => {});
  let files = 0;
  db.transaction(() => {
    if (req.query.withMedia === '1') {
      files = deleteSubmissions(db.prepare('SELECT id FROM submissions WHERE member_id = ?').all(req.params.id).map(r => r.id));
    }
    const staged = db.prepare('SELECT * FROM uploads WHERE member_id = ?').all(req.params.id);
    staged.forEach(u => fs.unlink(path.join(UPLOAD_DIR, u.filename), () => {}));
    db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id); // their session ends: next request asks them to rejoin
  })();
  toTeam(m.team_id, 'refresh', {});
  toAdmins('reviewed', { teamId: m.team_id });
  res.json({ ok: true, deletedFiles: files });
});

// Delete a team with its members, submissions and media (media goes to the Drive trash).
app.delete('/api/admin/teams/:id', adminAuth, superOnly, (req, res) => {
  const t = db.prepare('SELECT id FROM teams WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Team not found' });
  let files = 0;
  db.transaction(() => {
    files = deleteSubmissions(db.prepare('SELECT id FROM submissions WHERE team_id = ?').all(t.id).map(r => r.id));
    db.prepare('SELECT filename FROM uploads WHERE team_id = ?').all(t.id).forEach(u => fs.unlink(path.join(UPLOAD_DIR, u.filename), () => {}));
    db.prepare('SELECT selfie FROM members WHERE team_id = ? AND selfie IS NOT NULL').all(t.id).forEach(m => fs.unlink(path.join(UPLOAD_DIR, m.selfie), () => {}));
    // Forget its Drive folders so a future team that reuses this id gets fresh ones.
    db.prepare("DELETE FROM drive_folders WHERE key = ? OR key LIKE ?").run(`team:${t.id}`, `team:${t.id}:%`);
    db.prepare('DELETE FROM teams WHERE id = ?').run(t.id); // members, submissions and uploads cascade
  })();
  toTeam(t.id, 'refresh', {}); // its players get signed out
  toAdmins('teams', {});
  res.json({ ok: true, deletedFiles: files });
});

// Delete a whole submission with all its photos/videos. Points update automatically.
app.delete('/api/admin/submissions/:id', adminAuth, superOnly, (req, res) => {
  const sub = db.prepare('SELECT team_id FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const files = deleteSubmissions([+req.params.id]);
  toTeam(sub.team_id, 'refresh', {});
  toAdmins('reviewed', { teamId: sub.team_id });
  res.json({ ok: true, deletedFiles: files });
});

// Delete one photo/video. Deleting the last one removes the submission too.
app.delete('/api/admin/media/:id', adminAuth, superOnly, (req, res) => {
  const m = db.prepare('SELECT media.*, s.team_id FROM media JOIN submissions s ON s.id = media.submission_id WHERE media.id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'File not found' });
  const left = db.prepare('SELECT COUNT(*) n FROM media WHERE submission_id = ?').get(m.submission_id).n;
  const hasLink = !!db.prepare("SELECT 1 FROM submissions WHERE id = ? AND link != ''").get(m.submission_id);
  const dropSub = left <= 1 && !hasLink;
  if (dropSub) deleteSubmissions([m.submission_id]);
  else { db.prepare('DELETE FROM media WHERE id = ?').run(m.id); purgeMedia([m]); }
  toTeam(m.team_id, 'refresh', {});
  toAdmins('reviewed', { teamId: m.team_id });
  res.json({ ok: true, submissionDeleted: dropSub });
});

app.get('/api/admin/tasks', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY sort, id').all());
});
function cleanTask(b) {
  const int = (v, max) => Math.max(0, Math.min(max, parseInt(v, 10) || 0));
  const t = {
    title: String(b.title || '').trim().slice(0, 120),
    description: String(b.description || '').trim().slice(0, 1000),
    points: int(b.points, 10000),
    min_photos: int(b.min_photos, MAX_FILES),
    min_videos: int(b.min_videos, 5),
    needs_link: b.needs_link === true || b.needs_link === 1 || b.needs_link === '1' || b.needs_link === 'on' ? 1 : 0,
    link_label: String(b.link_label || '').trim().slice(0, 60),
    allow_gallery: b.allow_gallery === true || b.allow_gallery === 1 || b.allow_gallery === '1' || b.allow_gallery === 'on' ? 1 : 0,
  };
  if (t.min_photos + t.min_videos > MAX_FILES) t.min_photos = MAX_FILES - t.min_videos;
  const ms = v => { const n = Number(v); return Number.isFinite(n) && n > 1.5e12 && n < 4e12 ? Math.round(n) : null; };
  t.opens_at = ms(b.opens_at);
  t.closes_at = ms(b.closes_at);
  return t;
}
const taskError = t => !t.title ? 'Title required' : t.opens_at && t.closes_at && t.closes_at <= t.opens_at ? 'The closing time must be after the opening time.' : '';
app.post('/api/admin/tasks', adminAuth, superOnly, (req, res) => {
  const t = cleanTask(req.body);
  const bad = taskError(t);
  if (bad) return res.status(400).json({ error: bad });
  const sort = (db.prepare('SELECT MAX(sort) m FROM tasks').get().m || 0) + 1;
  db.prepare('INSERT INTO tasks (title, description, points, sort, min_photos, min_videos, needs_link, link_label, allow_gallery, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.title, t.description, t.points, sort, t.min_photos, t.min_videos, t.needs_link, t.link_label, t.allow_gallery, t.opens_at, t.closes_at);
  toAllTeams('refresh', {});
  res.json({ ok: true });
});
app.put('/api/admin/tasks/:id', adminAuth, superOnly, (req, res) => {
  const t = cleanTask(req.body);
  const bad = taskError(t);
  if (bad) return res.status(400).json({ error: bad });
  db.prepare('UPDATE tasks SET title = ?, description = ?, points = ?, min_photos = ?, min_videos = ?, needs_link = ?, link_label = ?, allow_gallery = ?, opens_at = ?, closes_at = ? WHERE id = ?')
    .run(t.title, t.description, t.points, t.min_photos, t.min_videos, t.needs_link, t.link_label, t.allow_gallery, t.opens_at, t.closes_at, req.params.id);
  toAllTeams('refresh', {});
  res.json({ ok: true });
});
// Reorder: swap with the neighbour above (dir = -1) or below (dir = 1).
app.post('/api/admin/tasks/:id/move', adminAuth, superOnly, (req, res) => {
  const dir = req.body.dir === -1 || req.body.dir === '-1' ? -1 : 1;
  db.transaction(() => {
    const all = db.prepare('SELECT id FROM tasks ORDER BY sort, id').all().map(r => r.id);
    const i = all.indexOf(+req.params.id), j = i + dir;
    if (i < 0 || j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    const upd = db.prepare('UPDATE tasks SET sort = ? WHERE id = ?');
    all.forEach((id, k) => upd.run(k + 1, id));
  })();
  toAllTeams('refresh', {});
  res.json({ ok: true });
});
app.delete('/api/admin/tasks/:id', adminAuth, superOnly, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM submissions WHERE task_id = ?').get(req.params.id).n;
  if (n && req.query.force !== '1') return res.status(409).json({ error: `This task has ${n} submission(s). Deleting it removes them and their points.`, needsForce: true });
  deleteSubmissions(db.prepare('SELECT id FROM submissions WHERE task_id = ?').all(req.params.id).map(r => r.id));
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  toAllTeams('refresh', {});
  res.json({ ok: true });
});

app.post('/api/admin/settings', adminAuth, superOnly, (req, res) => {
  for (const k of ['showLeaderboard', 'submissionsOpen']) if (typeof req.body[k] === 'boolean') setSetting(k, req.body[k]);
  toAllTeams('refresh', {});
  res.json({ ok: true });
});

app.get('/api/admin/drive', adminAuth, superOnly, (req, res) => res.json(drive.info()));
app.post('/api/admin/drive/retry', adminAuth, superOnly, (req, res) => { drive.retryFailed(); res.json({ ok: true }); });

// Connecting a personal Google account: Admin → Settings → "Connect Google Drive" → Google → back here.
// The redirect URL must be listed in the OAuth client in Cloud Console (see DRIVE_SETUP.md).
const publicUrl = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
app.post('/api/admin/drive/connect', adminAuth, superOnly, (req, res) => {
  if (drive.mode !== 'oauth') return res.status(400).json({ error: 'Google Drive OAuth client is not configured on the server.' });
  res.json({ url: drive.authUrl(publicUrl(req) + '/oauth/google/callback') });
});
app.get('/oauth/google/callback', async (req, res) => {
  const back = msg => res.redirect('/admin?drive=' + encodeURIComponent(msg) + '#/settings');
  if (req.query.error) return back('error:' + (req.query.error === 'access_denied' ? 'You cancelled the Google sign-in.' : req.query.error));
  try { await drive.completeAuth(String(req.query.code || ''), String(req.query.state || '')); back('connected'); }
  catch (err) { console.error('Google Drive connect failed:', err.message); back('error:' + err.message); }
});
app.post('/api/admin/drive/disconnect', adminAuth, superOnly, async (req, res) => { await drive.disconnect(); res.json({ ok: true }); });
let driveNotify = null;
drive.onChange.add(() => { clearTimeout(driveNotify); driveNotify = setTimeout(() => toAdmins('drive', {}), 1500); });

app.get('/api/admin/export.csv', adminAuth, superOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT t.name team, k.title task, k.points, s.status, s.comment, s.reviewed_by, m.name member, s.link,
      datetime(s.created_at, 'unixepoch', '+330 minutes') submitted_at_ist, datetime(s.reviewed_at, 'unixepoch', '+330 minutes') reviewed_at_ist,
      (SELECT group_concat(
         md.kind || CASE WHEN md.source = 'gallery' THEN ' (gallery)' ELSE '' END || ' ' || COALESCE(strftime('%Y-%m-%d %H:%M:%S', md.captured_at / 1000, 'unixepoch', '+330 minutes') || ' IST', 'time unknown') || ' @ ' ||
         CASE WHEN md.lat IS NULL THEN 'no location' ELSE printf('%.6f,%.6f (±%dm)', md.lat, md.lng, CAST(COALESCE(md.accuracy, 0) AS INTEGER)) END, ' | ')
       FROM media md WHERE md.submission_id = s.id) media_capture
    FROM submissions s JOIN teams t ON t.id = s.team_id JOIN tasks k ON k.id = s.task_id LEFT JOIN members m ON m.id = s.member_id ORDER BY s.id`).all();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['team', 'task', 'points', 'status', 'comment', 'reviewed_by', 'member', 'link', 'submitted_at_ist', 'reviewed_at_ist', 'media_capture'];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="mumbai-maxxing-submissions.csv"');
  res.send([cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'));
});

// ---------- Static ----------
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
// Not on this server any more? It was moved to Google Drive: stream it from there.
app.get('/media/:file', async (req, res) => {
  const m = db.prepare('SELECT drive_id FROM media WHERE filename = ?').get(req.params.file);
  if (!m?.drive_id || !drive.isReady()) return res.status(404).send('Not found');
  try { await drive.stream(m.drive_id, req, res); }
  catch (err) { console.error('Drive stream failed:', err.message); if (!res.headersSent) res.status(502).send('Could not load from Google Drive'); }
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (/\.(html|js|webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.listen(PORT, () => {
  console.log(`Mumbai Maxxing running on http://localhost:${PORT}  (admin: /admin)`);
  drive.start();
});

// Optional HTTPS listener, for testing the camera on phones over local Wi-Fi.
// Phones only allow camera access on https. In production, terminate HTTPS at your host/proxy instead.
if (process.env.SSL_KEY && process.env.SSL_CERT) {
  const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
  require('https').createServer({ key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }, app)
    .listen(HTTPS_PORT, () => console.log(`HTTPS on https://<this-computer-ip>:${HTTPS_PORT}`));
}

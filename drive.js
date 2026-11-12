// Google Drive storage for submitted media.
//
// Flow: phones upload to this server (fast, with progress) → once a submission is sent, its files are
// copied in the background into Google Drive, organised as  <root folder>/<Team>/<#n Task>/...
// After Drive confirms a file, the local copy is deleted. The dashboard keeps using /media/<file>; that
// route streams from Drive (with Range support, so videos can seek) when the local copy is gone.
//
// Two ways to connect (Drive stays off if neither is configured; files then stay on this server):
//
// A) Your own Google account (personal Gmail / Google One). Files live in your My Drive.
//    GOOGLE_OAUTH_CLIENT_FILE   path to the OAuth client JSON downloaded from Cloud Console, or
//    GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET
//    Then click "Connect Google Drive" in Admin → Settings once. The app creates a
//    "Mumbai Maxing 2026" folder (DRIVE_FOLDER_NAME) and can only see files it created (drive.file scope).
//    GOOGLE_OAUTH_REFRESH_TOKEN  optional: reuse a connection on another server without clicking Connect.
//
// B) Google Workspace Shared Drive with a service account.
//    GOOGLE_SERVICE_ACCOUNT_FILE (or GOOGLE_SERVICE_ACCOUNT_JSON) + DRIVE_FOLDER_ID
//
//   DRIVE_KEEP_LOCAL=1   optional: keep local copies too (more disk, faster dashboard)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { db, UPLOAD_DIR, getSetting, setSetting } = require('./db');

const API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const KEEP_LOCAL = process.env.DRIVE_KEEP_LOCAL === '1';
const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME || 'Mumbai Maxing 2026';
const PARALLEL = 2;
const MAX_ATTEMPTS = 12;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const readJson = p => JSON.parse(fs.readFileSync(path.resolve(__dirname, p), 'utf8'));

// ---------- Mode A: OAuth client (user account) ----------
let oauthClient = null;
try {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    oauthClient = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  } else if (process.env.GOOGLE_OAUTH_CLIENT_FILE) {
    const j = readJson(process.env.GOOGLE_OAUTH_CLIENT_FILE);
    const c = j.web || j.installed || j;
    if (c.client_id && c.client_secret) oauthClient = { id: c.client_id, secret: c.client_secret };
  }
} catch (e) { console.error('Google Drive: could not read the OAuth client file:', e.message); }

// ---------- Mode B: service account (Workspace Shared Drive) ----------
let saKey = null;
try {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    || (process.env.GOOGLE_SERVICE_ACCOUNT_FILE && fs.readFileSync(path.resolve(__dirname, process.env.GOOGLE_SERVICE_ACCOUNT_FILE), 'utf8'));
  if (raw) saKey = JSON.parse(raw);
} catch (e) { console.error('Google Drive: could not read the service account key:', e.message); }

const mode = oauthClient ? 'oauth' : (saKey?.client_email && saKey?.private_key && process.env.DRIVE_FOLDER_ID ? 'service' : 'off');
const status = { connected: false, lastError: '', lastOkAt: 0, folderName: '' };

function oauthState() { return getSetting('driveOAuth', null); } // { refreshToken, email, rootId }
if (mode === 'oauth' && process.env.GOOGLE_OAUTH_REFRESH_TOKEN && !oauthState()?.refreshToken) {
  setSetting('driveOAuth', { refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
}
function rootId() { return mode === 'service' ? process.env.DRIVE_FOLDER_ID : oauthState()?.rootId || ''; }
function account() { return mode === 'service' ? saKey.client_email : oauthState()?.email || ''; }
function isReady() { return mode === 'service' || (mode === 'oauth' && Boolean(oauthState()?.refreshToken && rootId())); }

// ---------- Access tokens ----------
let token = null, tokenExp = 0;
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

async function accessToken() {
  if (token && Date.now() < tokenExp - 5 * 60 * 1000) return token;
  let data;
  if (mode === 'service') {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: saKey.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const sig = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(saKey.private_key));
    data = await tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${sig}` });
  } else {
    const st = oauthState();
    if (!st?.refreshToken) throw new Error('Google Drive is not connected. Click "Connect Google Drive" in Settings.');
    try {
      data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: st.refreshToken, client_id: oauthClient.id, client_secret: oauthClient.secret });
    } catch (err) {
      // Revoked access or expired token (e.g. consent screen left in "Testing"): needs a reconnect.
      if (err.code === 'invalid_grant') { status.connected = false; status.needsReconnect = true; }
      throw err;
    }
  }
  token = data.access_token;
  tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return token;
}

async function gapi(url, opts = {}) {
  const res = await fetch(API + url, { ...opts, headers: { Authorization: 'Bearer ' + await accessToken(), ...opts.headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try { msg = JSON.parse(body).error.message; } catch {}
    const err = new Error(`Drive ${res.status}: ${msg || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ---------- OAuth connect flow (mode A) ----------
const pendingStates = new Map(); // state -> { redirectUri, exp }

function authUrl(redirectUri) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { redirectUri, exp: Date.now() + 10 * 60 * 1000 });
  return AUTH_URL + '?' + new URLSearchParams({
    client_id: oauthClient.id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
}

async function completeAuth(code, state) {
  const p = pendingStates.get(state);
  pendingStates.delete(state);
  if (!p || p.exp < Date.now()) throw new Error('This sign-in link expired. Please click "Connect Google Drive" again.');
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: oauthClient.id, client_secret: oauthClient.secret });
  if (!data.refresh_token) throw new Error('Google did not return a long-lived token. Remove the app at myaccount.google.com/permissions and connect again.');
  token = data.access_token;
  tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  setSetting('driveOAuth', { refreshToken: data.refresh_token });
  const about = await (await gapi('/drive/v3/about?fields=user(emailAddress)')).json();
  // Create (or reuse) the event's root folder in the connected account's My Drive.
  db.prepare('DELETE FROM drive_folders').run();
  const root = await (await gapi('/drive/v3/files?fields=id,name', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  })).json();
  setSetting('driveOAuth', { refreshToken: data.refresh_token, email: about.user?.emailAddress || '', rootId: root.id });
  Object.assign(status, { connected: true, needsReconnect: false, lastError: '', folderName: root.name });
  console.log(`Google Drive: connected as ${about.user?.emailAddress} → "${root.name}"`);
  retryFailed();
  return about.user?.emailAddress;
}

async function disconnect() {
  const st = oauthState();
  if (st?.refreshToken) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(st.refreshToken), { method: 'POST' }).catch(() => {});
  setSetting('driveOAuth', null);
  db.prepare('DELETE FROM drive_folders').run();
  token = null; tokenExp = 0;
  Object.assign(status, { connected: false, lastError: '', folderName: '' });
}

// ---------- Folders ----------
const clean = s => String(s).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 100) || 'untitled';
const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Parallel uploads for the same team/task must share one folder lookup, or each would create its own folder.
const folderLocks = new Map();
function ensureFolder(cacheKey, name, parentId) {
  const cached = db.prepare('SELECT id FROM drive_folders WHERE key = ?').get(cacheKey);
  if (cached) return Promise.resolve(cached.id);
  if (!folderLocks.has(cacheKey)) {
    folderLocks.set(cacheKey, findOrCreateFolder(cacheKey, name, parentId).finally(() => folderLocks.delete(cacheKey)));
  }
  return folderLocks.get(cacheKey);
}

async function findOrCreateFolder(cacheKey, name, parentId) {
  // Reuse an existing folder with that name (e.g. after a server move), otherwise create it.
  const search = new URLSearchParams({
    q: `name = '${q(name)}' and '${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '1',
    ...(mode === 'service' ? { corpora: 'allDrives' } : {}),
  });
  const found = await (await gapi('/drive/v3/files?' + search)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await (await gapi('/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    })).json();
    id = created.id;
  }
  db.prepare('INSERT OR REPLACE INTO drive_folders (key, id) VALUES (?, ?)').run(cacheKey, id);
  return id;
}

// ---------- Upload one media file ----------
async function uploadMedia(m) {
  const info = db.prepare(`
    SELECT s.id sub_id, s.team_id, s.task_id, t.name team_name, k.title task_title,
      (SELECT COUNT(*) FROM tasks k2 WHERE k2.sort < k.sort OR (k2.sort = k.sort AND k2.id <= k.id)) task_no,
      (SELECT COUNT(*) FROM submissions s2 WHERE s2.team_id = s.team_id AND s2.task_id = s.task_id AND s2.id <= s.id) attempt,
      (SELECT COUNT(*) FROM media m2 WHERE m2.submission_id = s.id AND m2.kind = ? AND m2.id <= ?) item_no
    FROM submissions s JOIN teams t ON t.id = s.team_id JOIN tasks k ON k.id = s.task_id WHERE s.id = ?`).get(m.kind, m.id, m.submission_id);
  if (!info) throw new Error('Submission no longer exists');

  const teamFolder = await ensureFolder(`team:${info.team_id}`, clean(info.team_name), rootId());
  const taskFolder = await ensureFolder(`team:${info.team_id}:task:${info.task_id}`, clean(`#${String(info.task_no).padStart(2, '0')} ${info.task_title}`), teamFolder);
  const ext = path.extname(m.filename) || (m.kind === 'video' ? '.mp4' : '.jpg');
  const name = `attempt-${info.attempt}_${m.kind === 'video' ? 'video' : 'photo'}-${info.item_no}${ext}`;

  // Resumable upload: streams the file from disk, fine for large videos.
  const localPath = path.join(UPLOAD_DIR, m.filename);
  const size = fs.statSync(localPath).size;
  const init = await gapi('/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': m.mime, 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({ name, parents: [taskFolder], description: `Mumbai Maxing · ${info.team_name} · ${info.task_title} · submission ${info.sub_id}` }),
  });
  const session = init.headers.get('location');
  if (!session) throw new Error('Drive did not return an upload session');
  const put = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': m.mime, 'Content-Length': String(size) },
    body: Readable.toWeb(fs.createReadStream(localPath)),
    duplex: 'half',
  });
  const out = await put.json().catch(() => ({}));
  if (!put.ok || !out.id) throw new Error(`Drive upload failed (${put.status}): ${out.error?.message || ''}`);
  return out.id;
}

// ---------- Background worker ----------
let running = 0;
const inFlight = new Set();
const onChange = new Set();

function pending() {
  return db.prepare(`SELECT * FROM media WHERE drive_id IS NULL AND local_deleted = 0 AND drive_attempts < ? AND drive_next_try <= unixepoch() ORDER BY id LIMIT 20`).all(MAX_ATTEMPTS);
}

function work() {
  if (!isReady()) return;
  for (const m of pending()) {
    if (running >= PARALLEL) break;
    if (inFlight.has(m.id)) continue;
    inFlight.add(m.id);
    running++;
    uploadMedia(m)
      .then(id => {
        db.prepare('UPDATE media SET drive_id = ?, drive_error = NULL WHERE id = ?').run(id, m.id);
        if (!KEEP_LOCAL) {
          fs.unlink(path.join(UPLOAD_DIR, m.filename), () => {});
          db.prepare('UPDATE media SET local_deleted = 1 WHERE id = ?').run(m.id);
        }
        Object.assign(status, { connected: true, lastOkAt: Date.now(), lastError: '' });
      })
      .catch(err => {
        const attempts = m.drive_attempts + 1;
        const wait = Math.min(600, 15 * 2 ** (attempts - 1)); // 15s, 30s, 1m … capped at 10 min
        db.prepare('UPDATE media SET drive_error = ?, drive_attempts = ?, drive_next_try = unixepoch() + ? WHERE id = ?').run(err.message.slice(0, 500), attempts, wait, m.id);
        status.lastError = err.message;
        if (err.status === 401 || err.status === 403) status.connected = false;
        console.error(`Google Drive: media ${m.id} failed (attempt ${attempts}): ${err.message}`);
      })
      .finally(() => {
        running--; inFlight.delete(m.id);
        onChange.forEach(fn => fn());
        setImmediate(work);
      });
  }
}

function kick() { if (isReady()) setImmediate(work); }

function start() {
  setInterval(work, 15000);
  if (mode === 'off') return console.log('Google Drive: not configured. Media stays on this server.');
  if (!isReady()) return console.log('Google Drive: ready to connect. Open Admin → Settings → "Connect Google Drive".');
  gapi(`/drive/v3/files/${rootId()}?supportsAllDrives=true&fields=id,name,trashed`)
    .then(r => r.json())
    .then(f => {
      Object.assign(status, { connected: true, folderName: f.name });
      if (f.trashed) status.lastError = `The "${f.name}" folder is in the Drive trash. Restore it, or disconnect and reconnect.`;
      console.log(`Google Drive: connected as ${account()} → "${f.name}"`);
      kick();
    })
    .catch(err => { status.lastError = err.message; console.error(`Google Drive: cannot open the folder: ${err.message}`); });
}

function counts() {
  const r = db.prepare(`SELECT
      SUM(drive_id IS NOT NULL) synced,
      SUM(drive_id IS NULL AND local_deleted = 0 AND drive_attempts < ?) waiting,
      SUM(drive_id IS NULL AND drive_attempts >= ?) failed
    FROM media`).get(MAX_ATTEMPTS, MAX_ATTEMPTS);
  return { synced: r.synced || 0, waiting: r.waiting || 0, failed: r.failed || 0 };
}

function retryFailed() {
  db.prepare('UPDATE media SET drive_attempts = 0, drive_next_try = 0 WHERE drive_id IS NULL AND local_deleted = 0').run();
  kick();
}

// Stream a Drive file to the browser, passing Range through so video seeking works.
async function stream(driveId, req, res) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const r = await gapi(`/drive/v3/files/${driveId}?alt=media&supportsAllDrives=true`, { headers });
  res.status(r.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = r.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!r.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(r.body).pipe(res);
}

function info() {
  return {
    mode,
    enabled: isReady(),
    connected: status.connected,
    needsReconnect: Boolean(status.needsReconnect),
    lastError: status.lastError,
    lastOkAt: status.lastOkAt,
    folderName: status.folderName || (mode === 'oauth' ? FOLDER_NAME : ''),
    account: account(),
    folderUrl: rootId() ? `https://drive.google.com/drive/folders/${rootId()}` : '',
    keepLocal: KEEP_LOCAL,
    ...counts(),
  };
}

module.exports = {
  mode, isReady, start, kick, stream, info, retryFailed, onChange,
  authUrl, completeAuth, disconnect,
  get enabled() { return isReady(); },
};

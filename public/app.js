/* Mumbai Maxxing — team app */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const MAX_ITEMS = 12;
const STATUS_LABEL = { todo: 'To do', pending: 'In review', approved: 'Approved', rejected: 'Rejected' };
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const STATUS_ICON = {
  todo: '',
  pending: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>'),
  approved: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  rejected: svg('<path d="M12 7v6M12 17h.01"/>'),
};
const ICON_X = icon('x');
// Static markup marks icon spots with data-icon; swap in the SVGs once.
document.querySelectorAll('[data-icon]').forEach(e => { e.outerHTML = icon(e.dataset.icon); });

// Styled confirmation popup (resolves true/false).
function confirmBox(title, body, okLabel, danger = false) {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'dlg-scrim';
    el.innerHTML = `<div class="dlg" role="alertdialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3><p>${body}</p>
      <div class="dlg-actions"><button class="btn ghost" data-v="0">Cancel</button><button class="btn ${danger ? 'coral' : ''}" data-v="1">${esc(okLabel)}</button></div></div>`;
    el.onclick = e => { const b = e.target.closest('[data-v]'); if (b || e.target === el) { el.remove(); resolve(b?.dataset.v === '1'); } };
    document.body.appendChild(el);
  });
}

function updateChipFade() {
  const c = $('#filterChips');
  c.classList.toggle('at-end', c.scrollLeft + c.clientWidth >= c.scrollWidth - 4);
}
const AVATAR_COLORS = ['var(--lime)', 'var(--coral)', 'var(--green)', '#C9C8FF'];

let token = store.get('mm_token');
let state = null;
let filter = 'all';
// Task order: 'num' (task number) or 'points' (most points first). Remembered per phone.
let taskSort = store.get('mm_task_sort') === 'points' ? 'points' : 'num';
let tab = 'tasks';
let es = null;
let openTaskId = null;
let draft = []; // [{file, url, kind}]

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...opts.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error(data.error || 'Please join again'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(title, body = '', kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
  el.onclick = () => el.remove();
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind ? 7000 : 3500);
}

// ---------- Join ----------
$('#filterChips').addEventListener('scroll', updateChipFade, { passive: true });
$('#codeInput').value = new URLSearchParams(location.search).get('code') || '';
$('#joinForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('#joinBtn');
  btn.disabled = true;
  $('#joinErr').classList.add('hidden');
  try {
    const r = await api('/api/join', { method: 'POST', body: JSON.stringify({ code: $('#codeInput').value, name: $('#nameInput').value }) });
    token = r.token;
    store.set('mm_token', token);
    history.replaceState(null, '', '/');
    await boot();
  } catch (err) {
    $('#joinErr').textContent = err.message;
    $('#joinErr').classList.remove('hidden');
  } finally { btn.disabled = false; }
};

function logout() {
  token = null; state = null;
  store.del('mm_token');
  es?.close(); es = null;
  $('#app').classList.add('hidden');
  $('#join').classList.remove('hidden');
}

// ---------- Derived state ----------
function taskStatus(taskId) {
  const subs = state.submissions.filter(s => s.task_id === taskId); // newest first
  if (!subs.length) return { status: 'todo', sub: null, history: [] };
  const approved = subs.find(s => s.status === 'approved');
  const sub = approved || subs[0];
  return { status: sub.status, sub, history: subs };
}

function lastSeen() { return +(store.get('mm_seen_' + state.me.id) || 0); }
function unreadCount() { const t = lastSeen(); return state.submissions.filter(s => s.reviewed_at && s.reviewed_at > t).length; }

// ---------- Render ----------
function render() {
  if (!state) return;
  const { team, tasks } = state;
  $('#teamName').textContent = team.name;
  $('#teamPoints').textContent = team.points;
  $('#progressBar').style.width = (tasks.length ? (team.approved / tasks.length) * 100 : 0) + '%';
  $('#progressLabel').textContent = `${team.approved}/${tasks.length} done`;
  $('#boardBtn').classList.toggle('hidden', !state.showLeaderboard);
  if (!state.showLeaderboard && tab === 'board') setTab('tasks');
  renderCheckinBar();

  const n = unreadCount();
  $('#unreadDot').textContent = n;
  $('#unreadDot').classList.toggle('hidden', !n);

  const statuses = tasks.map(t => ({ t, ...taskStatus(t.id) }));
  const counts = { all: tasks.length, todo: 0, pending: 0, approved: 0, rejected: 0 };
  statuses.forEach(s => counts[s.status]++);
  // Rejected first after To do: those need the team's attention. Empty filters are hidden (except All / To do).
  document.querySelectorAll('[data-sort]').forEach(b => { b.classList.toggle('on', b.dataset.sort === taskSort); b.setAttribute('aria-pressed', b.dataset.sort === taskSort); });
  $('#filterChips').innerHTML = ['all', 'todo', 'rejected', 'pending', 'approved'].filter(f => f === 'all' || f === 'todo' || counts[f] || filter === f).map(f =>
    `<button class="chip ${filter === f ? 'on' : ''}" data-f="${f}">${f === 'all' ? 'All' : STATUS_LABEL[f]}<span class="n">${counts[f]}</span></button>`).join('');
  $('#filterChips').classList.toggle('hidden', tab !== 'tasks');
  updateChipFade();

  const list = statuses.filter(s => filter === 'all' || s.status === filter);
  if (taskSort === 'points') list.sort((a, b) => b.t.points - a.t.points || tasks.indexOf(a.t) - tasks.indexOf(b.t));
  $('#taskList').innerHTML = list.length ? list.map(({ t, status }) => `
    <button class="task card ${status} ${(status === 'todo' || status === 'rejected') && ['upcoming', 'closed'].includes(taskWindow(t).state) ? 'w-' + taskWindow(t).state : ''}" data-task="${t.id}" aria-label="${esc(t.title)}, ${STATUS_LABEL[status]}, ${t.points} points">
      <span class="ic ${status}">${(status === 'todo' || status === 'rejected') && taskWindow(t).state === 'upcoming' ? icon('lock') : STATUS_ICON[status]}</span>
      <div>
        <h3>${esc(t.title)}</h3>
        <div class="sub ${status}">#${tasks.indexOf(t) + 1}${status === 'todo' ? '' : ' · ' + STATUS_LABEL[status]}<span class="req-chips">${reqChips(t)}</span></div>
        ${schedLine(t, status)}
      </div>
      <span class="pill pts">+${t.points}</span>
    </button>`).join('') : `<div class="empty">${filter === 'all' ? 'No tasks yet.' : `No ${STATUS_LABEL[filter].toLowerCase()} tasks.`}</div>`;

  renderUpdates();
  renderTeam();
  if (openTaskId) renderSheet();
}

function renderUpdates() {
  const seen = lastSeen();
  const subs = [...state.submissions].sort((a, b) => (b.reviewed_at || b.created_at) - (a.reviewed_at || a.created_at));
  $('#updateList').innerHTML = subs.length ? subs.map(s => `
    <div class="update card ${s.reviewed_at && s.reviewed_at > seen ? 'unread' : ''}" data-task="${s.task_id}">
      <div class="meta"><b>${esc(s.task_title)}</b><span class="pill st-${s.status}">${STATUS_LABEL[s.status]}${s.status === 'approved' ? ' · +' + s.points : ''}</span></div>
      ${s.comment ? `<div>“${esc(s.comment)}”</div>` : ''}
      <div class="muted small">${s.status === 'pending' ? 'Sent' : 'Reviewed'} ${ago(s.reviewed_at || s.created_at)} · by ${esc(s.member_name || 'a member')} · ${s.media.length} file${s.media.length === 1 ? '' : 's'}</div>
    </div>`).join('') : `<div class="empty">No submissions yet. Pick a task and capture it!</div>`;
}

function renderTeam() {
  const { team, members, maxMembers, me } = state;
  $('#teamView').innerHTML = `
    <div class="card codebox"><span class="small" style="opacity:.7">ROOM CODE</span><b>${esc(team.code)}</b><span class="small" style="opacity:.7">${members.length}/${maxMembers} members joined</span></div>
    <div class="card">${members.map((m, i) => `
      <div class="member">${m.selfie ? `<img class="avatar" src="${esc(m.selfie)}" alt="">` : `<div class="avatar" style="background:${AVATAR_COLORS[i % 4]}">${esc(m.name[0].toUpperCase())}</div>`}
      <div style="flex:1"><b>${esc(m.name)}</b>${m.id === me.id ? ' <span class="muted small">(you)</span>' : ''}</div></div>`).join('')}
    </div>
    <div class="card" style="padding:16px; display:grid; gap:4px">
      <b>${team.points} points · ${team.approved}/${state.tasks.length} tasks approved</b>
      <span class="muted small">${team.pending} waiting for review</span>
    </div>
    <button class="card perm-link" id="permLink"><span class="perm-ics">${icon('camera')}${icon('pin')}${icon('bell')}</span><b>Phone permissions</b><span class="muted small perm-go">Camera, location, alerts${icon('chevron-right')}</span></button>
    <button class="linkbtn" id="leaveBtn">Sign out on this device</button>`;
  $('#permLink').onclick = openPerms;
  $('#leaveBtn').onclick = async () => { if (await confirmBox('Sign out on this device?', 'You can rejoin any time with the same room code and <b>the same name</b>.', 'Sign out')) logout(); };
}

async function renderBoard() {
  try {
    const rows = await api('/api/leaderboard');
    $('#boardList').innerHTML = rows.map((r, i) => `
      <div class="lb card ${r.id === state.team.id ? 'me' : ''}"><span class="rank">${i + 1}</span><span class="name">${esc(r.name)}</span><span class="pill pts">${r.points}</span></div>`).join('');
  } catch (e) { $('#boardList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(ts * 1000).toLocaleDateString();
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('nav.bottom button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['tasks', 'updates', 'team', 'board'].forEach(x => $('#tab-' + x).classList.toggle('hidden', x !== t));
  $('#filterChips').classList.toggle('hidden', t !== 'tasks');
  if (t === 'updates' && state) { store.set('mm_seen_' + state.me.id, String(Math.floor(Date.now() / 1000))); setTimeout(render, 1500); }
  if (t === 'board') renderBoard();
  window.scrollTo(0, 0);
}

// ---------- Task sheet ----------
function openTask(id) {
  if (openTaskId !== id) { clearDraft(); }
  openTaskId = id;
  renderSheet();
}
async function closeSheet(force = false) {
  if (sending && !force) return;
  if (!force && draft.length && !await confirmBox('Discard your captures?', draft.length > 1 ? `You have <b>${draft.length} photos/videos</b> that haven't been sent. They'll be deleted.` : `You have <b>1 photo/video</b> that hasn't been sent. It'll be deleted.`, 'Discard', true)) return;
  clearDraft();
  openTaskId = null;
  $('#sheetHost').innerHTML = '';
  document.body.style.overflow = '';
}
// discardOnServer=false after a successful send (files now belong to the submission).
function clearDraft(discardOnServer = true) {
  draft.forEach(d => {
    d.removed = true;
    d.xhr?.abort();
    if (discardOnServer && d.uploadId) api('/api/uploads/' + d.uploadId, { method: 'DELETE' }).catch(() => {});
    URL.revokeObjectURL(d.url);
  });
  draft = [];
}

// ---------- Background uploads ----------
// Each capture starts uploading immediately (2 at a time), so most of the work is done before Send.
const MAX_PARALLEL = 2;
let keySeq = 0;
let sending = false;
const fmtMB = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function pump() {
  if ($('#reqList')) { const t = state?.tasks.find(x => x.id === openTaskId); if (t) $('#reqList').outerHTML = reqListHtml(t); }
  const active = draft.filter(d => d.state === 'uploading').length;
  draft.filter(d => d.state === 'queued').slice(0, Math.max(0, MAX_PARALLEL - active)).forEach(uploadItem);
  updateSendBtn();
}

function uploadItem(d) {
  d.state = 'uploading'; d.progress = 0; d.error = '';
  paintItem(d);
  const fd = new FormData();
  // Capture details go before the file so the server has them when the upload lands.
  const m = d.meta || {};
  fd.append('captured_at', m.capturedAt ?? '');
  if (d.source === 'gallery') fd.append('source', 'gallery');
  if (m.lat != null) { fd.append('lat', m.lat); fd.append('lng', m.lng); fd.append('accuracy', m.acc ?? ''); }
  fd.append('media', d.file, d.file.name);
  const xhr = d.xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/uploads');
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.upload.onprogress = e => { if (e.lengthComputable && !d.removed) { d.progress = e.loaded / e.total; paintItem(d); updateSendBtn(); } };
  const finish = (ok, data = {}) => {
    d.xhr = null;
    if (d.removed) { if (ok && data.id) api('/api/uploads/' + data.id, { method: 'DELETE' }).catch(() => {}); return; }
    if (ok) { d.state = 'done'; d.uploadId = data.id; d.progress = 1; }
    else { d.state = 'error'; d.error = data.error || 'Upload failed'; }
    paintItem(d);
    pump();
  };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    finish(xhr.status >= 200 && xhr.status < 300, data);
  };
  xhr.onerror = () => finish(false, { error: 'No connection' });
  xhr.send(fd);
}

function overlayHtml(d) {
  if (d.state === 'done') return `<span class="ok" aria-label="Uploaded">${icon('check')}</span>`;
  if (d.state === 'error') return `<button class="up err" data-retry="${d.key}"><b>!</b><span>Tap to retry</span></button>`;
  const pct = Math.round((d.progress || 0) * 100);
  return `<div class="up"><b>${d.state === 'queued' ? 'Waiting…' : pct >= 100 ? 'Saving…' : pct + '%'}</b><span class="upline"><i style="width:${pct}%"></i></span></div>`;
}
function paintItem(d) {
  const el = document.querySelector(`.thumb[data-key="${d.key}"] .ov`);
  if (el) el.innerHTML = overlayHtml(d);
}

function updateSendBtn() {
  const btn = $('#sendBtn');
  if (!btn) return;
  const n = draft.length;
  const done = draft.filter(d => d.state === 'done').length;
  const failed = draft.filter(d => d.state === 'error').length;
  const total = draft.reduce((a, d) => a + d.file.size, 0) || 1;
  const pct = Math.round(draft.reduce((a, d) => a + d.file.size * (d.progress || 0), 0) / total * 100);
  const t = state?.tasks.find(x => x.id === openTaskId);
  const rq = t ? reqStatus(t) : { ok: n > 0, missing: [] };
  btn.disabled = !rq.ok || sending;
  if (!rq.ok && !sending) { btn.innerHTML = `<span style="display:grid; gap:4px; justify-items:center">Send for review<span class="small" style="font-weight:400">Still needed: ${esc(rq.missing.join(' · '))}</span></span>`; return; }
  if (!n) { btn.innerHTML = 'Send for review'; return; }
  const label = sending ? (done < n ? `Finishing uploads… ${pct}%` : 'Submitting…') : `Send ${n} item${n > 1 ? 's' : ''} for review`;
  const sub = failed ? `${failed} failed, tap to retry` : done < n ? `Uploading ${done}/${n} · ${pct}%` : `All ${n} uploaded`;
  btn.innerHTML = `<span style="display:grid; gap:6px; width:100%; justify-items:center">${label}<span class="small" style="font-weight:400">${sub}</span>${done < n ? `<span class="upbar"><i style="width:${pct}%"></i></span>` : ''}</span>`;
}

function lockSheet(locked) {
  document.querySelectorAll('[data-slot], [data-rm], [data-retry], #closeSheet, #noteInput, #linkInput').forEach(b => (b.disabled = locked));
}

// ---------- Task schedule ----------
// Countdowns use the server's clock (offset measured on every refresh), so a wrong phone clock can't skew them.
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
const IST_TZ = { timeZone: 'Asia/Kolkata' };
const fmtClock = ms => new Date(ms).toLocaleTimeString('en-IN', { ...IST_TZ, hour: 'numeric', minute: '2-digit' });
const fmtDay = ms => new Date(ms).toLocaleDateString('en-IN', { ...IST_TZ, weekday: 'short', day: 'numeric', month: 'short' });
const sameISTDay = (a, b) => fmtDay(a) === fmtDay(b);
const whenIST = ms => `${fmtClock(ms)} IST${sameISTDay(ms, now()) ? '' : ', ' + fmtDay(ms)}`;
const SOON_MS = 10 * 60 * 1000;
function taskWindow(t) {
  const n = now();
  if (!t.opens_at && !t.closes_at) return { state: 'always' };
  if (t.opens_at && n < t.opens_at) return { state: 'upcoming', at: t.opens_at };
  if (t.closes_at && n >= t.closes_at) return { state: 'closed', at: t.closes_at };
  return t.closes_at ? { state: 'open', at: t.closes_at, soon: t.closes_at - n <= SOON_MS } : { state: 'always' };
}
// "1h 20m", "4m 10s", "45s" (short) or "01:20:15" / "2d 03:20:15" (clock).
function fmtLeft(ms, style) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (style === 'clock') { const p = n => String(n).padStart(2, '0'); return (d ? `${d}d ` : '') + `${p(h)}:${p(m)}:${p(sec)}`; }
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
const cd = (at, style = 'short') => `<span data-cd="${at}" data-cd-style="${style}">${fmtLeft(at - now(), style)}</span>`;
function schedLine(t, status) {
  if (status === 'approved' || status === 'pending') return '';
  const w = taskWindow(t);
  if (w.state === 'upcoming') return `<div class="sched up">${icon('lock')} Opens ${whenIST(w.at)} · in ${cd(w.at)}</div>`;
  if (w.state === 'open') return `<div class="sched open ${w.soon ? 'soon' : ''}">${icon('timer')} ${cd(w.at)} left · closes ${fmtClock(w.at)} IST</div>`;
  if (w.state === 'closed') return `<div class="sched closed">Closed at ${whenIST(w.at)}</div>`;
  return '';
}
// Tick every second: refresh countdown text; re-render when any task opens, closes or enters its last 10 minutes.
let schedSig = '';
setInterval(() => {
  if (!state) return;
  document.querySelectorAll('[data-cd]').forEach(el => { el.textContent = fmtLeft(+el.dataset.cd - now(), el.dataset.cdStyle); });
  const sig = state.tasks.map(t => { const w = taskWindow(t); return w.state + (w.soon ? '!' : ''); }).join(',');
  if (schedSig && sig !== schedSig) render();
  schedSig = sig;
}, 1000);

// ---------- Task requirements ----------
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function reqChips(t) {
  return [t.min_photos ? `<span>${icon('camera')}${t.min_photos}</span>` : '', t.min_videos ? `<span>${icon('video')}${t.min_videos}</span>` : '', t.needs_link ? `<span>${icon('link')}</span>` : '',
    t.allow_gallery && (t.min_photos || t.min_videos) ? `<span title="Gallery uploads allowed">${icon('image')}</span>` : ''].filter(Boolean).join('');
}
function validLink(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  try { const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.'); } catch { return false; }
}
// Checklist rows + whether everything required is in place.
function reqStatus(t) {
  const photos = draft.filter(d => d.kind === 'image').length, videos = draft.filter(d => d.kind === 'video').length;
  const link = $('#linkInput')?.value || '';
  const rows = [];
  if (t.min_photos) rows.push({ label: plural(t.min_photos, 'photo'), have: photos, need: t.min_photos, noun: 'photo' });
  if (t.min_videos) rows.push({ label: plural(t.min_videos, 'video'), have: videos, need: t.min_videos, noun: 'video' });
  if (t.needs_link) rows.push({ label: t.link_label || 'A link', have: validLink(link) ? 1 : 0, need: 1, isLink: true });
  const missing = rows.filter(r => r.have < r.need).map(r => r.isLink ? 'a link' : plural(r.need - r.have, 'more ' + r.noun));
  return { rows, ok: rows.every(r => r.have >= r.need), missing };
}
function reqListHtml(t) {
  // Photos and videos are shown as slots (see slotsHtml); this box only appears when nothing is asked for.
  if (t.min_photos || t.min_videos || t.needs_link) return '';
  return `<div class="req" id="reqList"><b class="req-h">Nothing to upload</b><span class="muted small">Add a note if you like, then send.</span></div>`;
}

// One dashed slot per required photo/video. Filled slots show the capture; tap an empty one to add.
function draftThumb(d) {
  return `<div class="thumb" data-key="${d.key}">${d.kind === 'video' ? `<video src="${d.url}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="${d.url}" alt="">`}
    <span class="tag">${d.source === 'gallery' ? icon('image') : ''}${d.meta?.lat != null ? icon('pin') : ''}${d.kind === 'video' ? `${icon('play')}${fmtDur(d.duration || 0)} · ` : ''}${fmtMB(d.file.size)}</span>
    <div class="ov">${overlayHtml(d)}</div>
    <button class="x" data-rm="${d.key}" aria-label="Remove">${icon('x')}</button></div>`;
}
function slotGroupHtml(kind, need) {
  const items = draft.filter(d => d.kind === (kind === 'photo' ? 'image' : 'video'));
  const noun = kind === 'photo' ? 'Photo' : 'Video';
  const done = items.length >= need;
  const empty = Array.from({ length: Math.max(0, need - items.length) }, (_, i) =>
    `<button class="slot" data-slot="${kind}">${kind === 'photo' ? ICON_CAM : ICON_VID}<span>${noun} ${items.length + i + 1}</span></button>`).join('');
  const extra = done && draft.length < MAX_ITEMS ? `<button class="slot extra" data-slot="${kind}"><b>+</b><span>Add more</span></button>` : '';
  return `<div class="slot-sec">
    <div class="slot-h"><span>${noun}s</span><span class="slot-n ${done ? 'ok' : ''}">${done ? icon('check') : ''}${Math.min(items.length, need)}/${need}</span></div>
    <div class="thumbs">${items.map(draftThumb).join('')}${empty}${extra}</div></div>`;
}
function slotsHtml(t) {
  return (t.min_photos ? slotGroupHtml('photo', t.min_photos) : '') + (t.min_videos ? slotGroupHtml('video', t.min_videos) : '');
}
// Empty slot tapped: straight to the camera, or ask camera vs gallery when the task allows the gallery.
function chooseSource(kind) {
  const t = state?.tasks.find(x => x.id === openTaskId);
  if (draft.length >= MAX_ITEMS) return toast(`Max ${MAX_ITEMS} items per submission`);
  if (!t?.allow_gallery) return capture(kind);
  const el = document.createElement('div');
  el.className = 'dlg-scrim';
  el.innerHTML = `<div class="dlg src-pick" role="dialog" aria-modal="true" aria-label="Add a ${kind}"><h3>Add a ${kind}</h3>
    <button class="btn block" data-src="cam">${kind === 'photo' ? ICON_CAM + 'Take photo' : ICON_VID + 'Record video'}</button>
    <button class="btn ghost block" data-src="gal">${ICON_GAL}Choose from gallery</button>
    <button class="btn ghost block" data-src="">Cancel</button></div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-src]');
    if (!b && e.target !== el) return;
    el.remove();
    if (b?.dataset.src === 'cam') capture(kind);
    if (b?.dataset.src === 'gal') { const inp = $('#galleryInput'); inp.accept = kind === 'photo' ? 'image/*' : 'video/*'; inp.click(); }
  };
  document.body.appendChild(el);
}
function refreshReq() {
  const t = state?.tasks.find(x => x.id === openTaskId);
  const el = $('#reqList');
  if (t && el) el.outerHTML = reqListHtml(t);
  updateSendBtn();
}

function linkHtml(sub) {
  if (!sub?.link) return '';
  return `<a class="sub-link" href="${esc(sub.link)}" target="_blank" rel="noopener">${icon('link')}${esc(sub.link.replace(/^https?:\/\//, '').slice(0, 60))}</a>`;
}
function mediaHtml(list) {
  return `<div class="thumbs fixed">${list.map(m => `
    <div class="thumb" data-view="${esc(m.url)}" data-kind="${m.kind}">
      ${m.kind === 'video' ? `<video src="${esc(m.url)}#t=0.1" muted playsinline preload="metadata"></video><span class="tag">${icon('play')}Video</span>` : `<img src="${esc(m.url)}" loading="lazy" alt="">`}
    </div>`).join('')}</div>`;
}

const ICON_CAM = icon('camera'), ICON_GAL = icon('image'), ICON_VID = icon('video');

function renderSheet() {
  const t = state.tasks.find(x => x.id === openTaskId);
  if (!t) { openTaskId = null; $('#sheetHost').innerHTML = ''; return; }
  const { status, sub, history } = taskStatus(t.id);
  const win = taskWindow(t);
  const canSubmit = state.submissionsOpen && (status === 'todo' || status === 'rejected') && (win.state === 'open' || win.state === 'always');
  const prevScroll = $('#sheetHost .sheet')?.scrollTop || 0;

  let body = '';
  if (status === 'approved') {
    body = `<div class="feedback approved"><b>${icon('sparkle')}+${t.points} points earned</b>${sub.comment ? `<span>Organisers: “${esc(sub.comment)}”</span>` : ''}</div>${linkHtml(sub)}${mediaHtml(sub.media)}`;
  } else if (status === 'pending') {
    body = `<div class="feedback pending"><b>Waiting for review</b><span>Sent by ${esc(sub.member_name || 'your team')} ${ago(sub.created_at)}. You'll be notified when organisers review it.</span></div>${linkHtml(sub)}${mediaHtml(sub.media)}`;
  } else {
    if (status === 'rejected') body += `<div class="feedback rejected"><b>Not accepted. Try again below</b><span>Organisers: “${esc(sub.comment)}”</span></div>`;
    if ((status === 'todo' || status === 'rejected') && win.state === 'upcoming') {
      body += `<div class="sched-card up"><span class="muted small">Submissions open at</span><b class="sched-when">${fmtClock(win.at)} IST</b><span class="muted small">${fmtDay(win.at)}</span>
        <div class="sched-big">${cd(win.at, 'clock')}</div></div>`;
    } else if ((status === 'todo' || status === 'rejected') && win.state === 'closed') {
      body += `<div class="sched-card closed"><b>Submissions closed</b><span class="small">This task closed at ${whenIST(win.at)}.</span></div>`;
    }
    if (canSubmit && win.state === 'open') {
      body += `<div class="sched-bar ${win.soon ? 'soon' : ''}">${icon('timer')}<b>${cd(win.at, 'clock')}</b> left · closes ${whenIST(win.at)}</div>`;
    }
    if (canSubmit) {
      body += reqListHtml(t) + slotsHtml(t) + `
        ${t.allow_gallery ? `<input type="file" id="galleryInput" class="hidden" multiple>` : ''}
        ${t.needs_link ? `<div class="field"><label for="linkInput">${esc(t.link_label || 'Link')}</label>
          <input id="linkInput" class="input" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://" maxlength="500"></div>` : ''}
        <textarea id="noteInput" class="input" placeholder="Add a note for the organisers (optional)" maxlength="500"></textarea>
        <button class="btn lime block" id="sendBtn" disabled>Send for review</button>`;
    } else if (!state.submissionsOpen) {
      body += `<div class="feedback pending"><b>Submissions are closed</b></div>`;
    }
  }
  const older = history.filter(h => h !== sub);
  if (older.length) body += `<details><summary class="muted small" style="cursor:pointer">Earlier attempts (${older.length})</summary>${older.map(h => `
    <div style="margin-top:10px; display:grid; gap:6px"><span class="pill st-${h.status}" style="justify-self:start">${STATUS_LABEL[h.status]}</span>${h.comment ? `<span class="small">“${esc(h.comment)}”</span>` : ''}${mediaHtml(h.media)}</div>`).join('')}</details>`;

  const note = $('#noteInput')?.value || '';
  const linkVal = $('#linkInput')?.value || '';
  $('#sheetHost').innerHTML = `
    <div class="scrim" id="scrim"></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="inner">
      <div class="grab"></div>
      <div class="head">
        <div class="pills"><span class="pill st-${status}">${STATUS_LABEL[status]}</span><span class="pill pts">+${t.points} pts</span></div>
        <button class="x-btn" id="closeSheet" aria-label="Close">${ICON_X}</button>
      </div>
      <h2>${esc(t.title)}</h2>
      ${t.description ? `<p class="desc">${esc(t.description)}</p>` : ''}
      ${body}
    </div></div>`;
  document.body.style.overflow = 'hidden';
  $('#sheetHost .sheet').scrollTop = prevScroll;
  if ($('#noteInput')) $('#noteInput').value = note;
  if ($('#linkInput')) { $('#linkInput').value = linkVal; $('#linkInput').oninput = refreshReq; refreshReq(); }

  // Wrap in arrows: passing closeSheet directly would hand it the click event as "force" and skip the discard prompt.
  $('#scrim').onclick = () => closeSheet();
  $('#closeSheet').onclick = () => closeSheet();
  document.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => chooseSource(b.dataset.slot));
  if ($('#galleryInput')) $('#galleryInput').onchange = e => { const files = [...e.target.files]; e.target.value = ''; addFromGallery(files); };
  $('#sendBtn') && ($('#sendBtn').onclick = send);
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    const i = draft.findIndex(d => d.key === +b.dataset.rm);
    if (i < 0) return;
    const [d] = draft.splice(i, 1);
    d.removed = true; d.xhr?.abort();
    if (d.uploadId) api('/api/uploads/' + d.uploadId, { method: 'DELETE' }).catch(() => {});
    URL.revokeObjectURL(d.url);
    renderSheet(); pump();
  });
  document.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => {
    const d = draft.find(x => x.key === +b.dataset.retry);
    if (d) { d.state = 'queued'; d.progress = 0; paintItem(d); pump(); }
  });
  updateSendBtn();
  if (sending) lockSheet(true);
}

// ---------- In-app camera ----------
// Captures come live from getUserMedia. Picking from the gallery is only offered
// on tasks where the organisers turned on "Allow uploads from gallery".
const MAX_VIDEO_SEC = 120;
const cam = { stream: null, mode: 'photo', facing: 'environment', recorder: null, chunks: [], timer: null, started: 0, startMeta: null };

// ---------- Location (where + when each capture was taken) ----------
// GPS is watched only while the camera is open. Captures still work without it; organisers then see "No location".
const GEO_MAX_AGE = 5 * 60 * 1000; // a fix older than this isn't attached
const geo = { watch: null, last: null, status: 'idle' };

function startGeo() {
  if (!('geolocation' in navigator)) { geo.status = 'unavailable'; return updateGeoPill(); }
  if (geo.watch != null) return;
  if (!geo.last) { geo.status = 'finding'; updateGeoPill(); }
  geo.watch = navigator.geolocation.watchPosition(
    p => { geo.last = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; geo.status = 'on'; updateGeoPill(); },
    err => { geo.status = err.code === 1 ? 'denied' : (geo.last ? 'on' : 'weak'); updateGeoPill(); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function stopGeo() {
  if (geo.watch != null) { navigator.geolocation.clearWatch(geo.watch); geo.watch = null; }
}
function captureMeta() {
  const l = geo.last && Date.now() - geo.last.at < GEO_MAX_AGE ? geo.last : null;
  return { capturedAt: Date.now(), lat: l?.lat ?? null, lng: l?.lng ?? null, acc: l?.acc ?? null };
}
function updateGeoPill() {
  updateSelfieGeo();
  const el = $('#geoPill');
  if (!el) return;
  const fresh = geo.last && Date.now() - geo.last.at < GEO_MAX_AGE;
  const st = geo.status === 'on' && fresh ? 'on' : geo.status === 'on' ? 'weak' : geo.status;
  el.className = 'geo-pill ' + st;
  const txt = { on: `Location on · ±${Math.round(geo.last?.acc || 0)} m`, finding: 'Finding location…', weak: 'Weak GPS signal…', denied: 'Location off', unavailable: 'No location on this device', idle: '' }[st] || '';
  el.innerHTML = txt ? icon('pin') + esc(txt) : '';
}


function capture(mode) {
  if (draft.length >= MAX_ITEMS) return toast(`Max ${MAX_ITEMS} items per submission`);
  cam.mode = mode === 'video' ? 'video' : 'photo';
  // Only offer the camera modes this task asks for.
  const t = state?.tasks.find(x => x.id === openTaskId);
  document.querySelectorAll('.cam-modes button').forEach(b => b.classList.toggle('hidden', !!t && !(b.dataset.mode === 'video' ? t.min_videos : t.min_photos)));
  $('.cam-modes').classList.toggle('hidden', !!t && !(t.min_photos && t.min_videos));
  $('#cam').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  updateCamUi();
  startStream();
  startGeo();
}

function camMsg(html) {
  $('#camMsg').innerHTML = html;
  $('#camMsg').classList.toggle('hidden', !html);
}

async function startStream() {
  stopStream();
  camMsg('');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return camMsg(`<b>Camera unavailable</b><span>The camera only works on a secure (https://) link. Ask an organiser for the right link.</span>`);
  }
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      // Video is recorded at 720p (photos still use the full sensor stream for a sharper frame).
      video: cam.mode === 'video'
        ? { facingMode: { ideal: cam.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
        : { facingMode: { ideal: cam.facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: cam.mode === 'video',
    });
    const v = $('#camView');
    v.srcObject = cam.stream;
    v.classList.toggle('mirror', cam.facing === 'user');
    await v.play().catch(() => {});
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    camMsg(denied
      ? `<b>Allow camera access</b><span>Mumbai Maxxing needs your camera${cam.mode === 'video' ? ' and microphone' : ''} to log tasks. Enable it in your browser's site settings, then try again.</span><button class="btn lime" id="camRetry">Try again</button>`
      : `<b>Couldn't start the camera</b><span>${esc(err.message || err.name)}</span><button class="btn lime" id="camRetry">Try again</button>`);
    $('#camRetry').onclick = startStream;
  }
}

function stopStream() {
  cam.stream?.getTracks().forEach(t => t.stop());
  cam.stream = null;
}

function closeCam() {
  if (cam.recorder?.state === 'recording') stopRecording();
  stopStream();
  stopGeo();
  $('#cam').classList.add('hidden');
  if (cam.onShot) { // back to the onboarding task
    cam.onShot = null;
    cam.facing = 'environment';
    $('.cam-modes').classList.remove('hidden');
    document.body.style.overflow = '';
    return renderSelfie();
  }
  renderSheet();
}

function updateCamUi() {
  const recording = cam.recorder?.state === 'recording';
  $('#cam').classList.toggle('video', cam.mode === 'video');
  $('#cam').classList.toggle('recording', recording);
  document.querySelectorAll('.cam-modes button').forEach(b => { b.classList.toggle('on', b.dataset.mode === cam.mode); b.disabled = recording; });
  $('#camRec').classList.toggle('hidden', !recording);
  $('#camFlip').disabled = recording;
  $('#camDone').disabled = recording;
  $('#camClose').disabled = recording;
  const last = draft[draft.length - 1];
  $('#camLast').innerHTML = last ? `<span class="media">${last.kind === 'video' ? `<video src="${last.url}#t=0.1" muted playsinline></video>` : `<img src="${last.url}" alt="">`}</span><b>${draft.length}</b>` : '';
}

function addCapture(blob, kind, ext, duration = 0, meta = captureMeta(), source = 'camera') {
  const file = new File([blob], `${kind}-${Date.now()}.${ext}`, { type: blob.type, lastModified: Date.now() });
  draft.push({ key: ++keySeq, file, url: URL.createObjectURL(file), kind, duration, meta, source, state: 'queued', progress: 0 });
  pump();
  navigator.vibrate?.(30);
  updateCamUi();
  if (draft.length >= MAX_ITEMS) { toast(`That's the max of ${MAX_ITEMS} items`); closeCam(); }
}

// Photos target 500 KB – 1 MB: saved at up to 2560px and high quality, then
// stepped down until the file is at or under the 1 MB hard limit.
const PHOTO_MAX_BYTES = 1024 * 1024;
const PHOTO_MAX_EDGE = 2560;
const PHOTO_STEPS = [[1, 0.88], [1, 0.82], [1, 0.76], [1, 0.7], [0.85, 0.72], [0.75, 0.7], [0.6, 0.7]]; // [scale, quality]

async function takePhoto() {
  const v = $('#camView');
  if (!v.videoWidth) return;
  $('#camFlash').classList.add('on');
  setTimeout(() => $('#camFlash').classList.remove('on'), 60);
  // Grab the frame once at full size; every re-encode below starts from this.
  const base = Math.min(1, PHOTO_MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
  const src = document.createElement('canvas');
  src.width = Math.round(v.videoWidth * base);
  src.height = Math.round(v.videoHeight * base);
  const sctx = src.getContext('2d');
  if (cam.facing === 'user') { sctx.translate(src.width, 0); sctx.scale(-1, 1); }
  sctx.drawImage(v, 0, 0, src.width, src.height);
  const blob = await encodeJpeg(src);
  if (!blob) return;
  if (cam.onShot) cam.onShot(blob); // onboarding selfie
  else addCapture(blob, 'image', 'jpg');
}

async function encodeJpeg(src) {
  let blob = null;
  for (const [scale, q] of PHOTO_STEPS) {
    let c = src;
    if (scale < 1) {
      c = document.createElement('canvas');
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    }
    blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= PHOTO_MAX_BYTES) break;
  }
  return blob;
}

// ---------- Gallery picks (only on tasks that allow them) ----------
// Photos are re-encoded like camera shots (≤ 2560px, ≤ 1 MB JPEG). Videos go up as they are.
// They carry no GPS; the file's own date is sent as the capture time.
async function decodeImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}
function videoDuration(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    v.src = url;
  });
}
async function addFromGallery(files) {
  const t = state?.tasks.find(x => x.id === openTaskId);
  if (!t?.allow_gallery) return;
  const wantPhoto = t.min_photos > 0, wantVideo = t.min_videos > 0;
  let skipped = 0;
  for (let f of files) {
    if (draft.length >= MAX_ITEMS) break; // addCapture already said so
    const type = f.type || ({ mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', '3gp': 'video/3gpp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp' })[f.name.split('.').pop().toLowerCase()] || '';
    if (type && !f.type) f = new File([f], f.name, { type, lastModified: f.lastModified });
    const kind = type.startsWith('video/') ? 'video' : type.startsWith('image/') ? 'image' : '';
    if (!kind || (kind === 'image' && !wantPhoto) || (kind === 'video' && !wantVideo)) { skipped++; continue; }
    const meta = { capturedAt: f.lastModified || null, lat: null, lng: null, acc: null };
    if (kind === 'video') {
      addCapture(f, 'video', (f.name.split('.').pop() || 'mp4').toLowerCase().slice(0, 5), await videoDuration(f), meta, 'gallery');
      continue;
    }
    let blob = null;
    try {
      const img = await decodeImage(f);
      const w = img.width, h = img.height, scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      img.close?.();
      blob = await encodeJpeg(c);
    } catch {}
    // Couldn't decode it here (e.g. HEIC on some browsers): send the original file.
    if (blob) addCapture(blob, 'image', 'jpg', 0, meta, 'gallery');
    else addCapture(f, 'image', (f.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5), 0, meta, 'gallery');
  }
  if (skipped) toast(`${skipped} file${skipped === 1 ? '' : 's'} skipped`, wantPhoto ? 'This task only takes photos.' : 'This task only takes videos.');
  renderSheet();
}

function pickVideoType() {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

function startRecording() {
  if (!window.MediaRecorder) return toast('Video recording isn\'t supported in this browser', 'Try Chrome or Safari.', 'rejected');
  const type = pickVideoType();
  cam.chunks = [];
  cam.recorder = new MediaRecorder(cam.stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 64_000 }); // ≈ 9 MB per minute
  cam.recorder.ondataavailable = e => e.data.size && cam.chunks.push(e.data);
  cam.recorder.onstop = () => {
    const mime = (cam.recorder.mimeType || type || 'video/webm').split(';')[0];
    const blob = new Blob(cam.chunks, { type: mime });
    if (blob.size) addCapture(blob, 'video', mime.includes('mp4') ? 'mp4' : 'webm', (Date.now() - cam.started) / 1000, cam.startMeta || captureMeta());
    updateCamUi();
    if ($('#cam').classList.contains('hidden')) renderSheet();
  };
  cam.recorder.start(1000);
  cam.started = Date.now();
  cam.startMeta = captureMeta();
  $('#camTime').textContent = '0:00';
  cam.timer = setInterval(() => {
    const s = Math.floor((Date.now() - cam.started) / 1000);
    $('#camTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= MAX_VIDEO_SEC) { stopRecording(); toast(`Videos are limited to ${MAX_VIDEO_SEC / 60} minutes`); }
  }, 250);
  updateCamUi();
}

function stopRecording() {
  clearInterval(cam.timer);
  if (cam.recorder?.state === 'recording') cam.recorder.stop();
  updateCamUi();
}

$('#camShutter').onclick = () => {
  if (!cam.stream) return;
  if (cam.mode === 'photo') return takePhoto();
  if (cam.recorder?.state === 'recording') stopRecording(); else startRecording();
};
$('#camClose').onclick = closeCam;
$('#geoPill').onclick = () => {
  if (geo.status === 'denied') toast('Location is off', 'Allow location for this site in your browser settings so organisers can see where photos were taken. You can still submit without it.');
};
$('#camDone').onclick = closeCam;
$('#camFlip').onclick = () => { cam.facing = cam.facing === 'environment' ? 'user' : 'environment'; startStream(); };
document.querySelectorAll('.cam-modes button').forEach(b => b.onclick = () => {
  if (cam.mode === b.dataset.mode) return;
  cam.mode = b.dataset.mode;
  updateCamUi();
  startStream(); // video mode also needs the microphone
});
// Release the camera if the app is backgrounded mid-capture.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && cam.stream) { if (cam.recorder?.state === 'recording') stopRecording(); stopStream(); stopGeo(); }
  else if (!document.hidden && !$('#cam').classList.contains('hidden') && !cam.stream) { startStream(); startGeo(); }
});

async function send() {
  const task = state.tasks.find(x => x.id === openTaskId);
  if (sending || !task || !reqStatus(task).ok) return;
  draft.filter(d => d.state === 'error').forEach(d => { d.state = 'queued'; d.progress = 0; paintItem(d); });
  sending = true;
  lockSheet(true);
  pump();
  // Wait for background uploads to finish.
  while (draft.some(d => d.state === 'queued' || d.state === 'uploading')) await new Promise(r => setTimeout(r, 250));
  if (draft.some(d => d.state === 'error')) {
    sending = false; lockSheet(false); updateSendBtn();
    return toast('Some uploads failed', 'Check your connection, then tap the red items to retry.', 'rejected');
  }
  updateSendBtn();
  const taskId = openTaskId;
  const items = draft.length;
  try {
    await api('/api/submissions', { method: 'POST', body: JSON.stringify({ task_id: taskId, note: $('#noteInput')?.value || '', link: $('#linkInput')?.value || '', upload_ids: draft.map(d => d.uploadId) }) });
    sending = false;
    clearDraft(false);
    showDone(taskId, items);
    load();
  } catch (err) {
    sending = false; lockSheet(false); updateSendBtn();
    toast('Couldn\'t submit', err.message, 'rejected');
  }
}

function showDone(taskId, items) {
  const t = state.tasks.find(x => x.id === taskId);
  navigator.vibrate?.([60, 40, 120]);
  const el = document.createElement('div');
  el.className = 'done-pop';
  el.innerHTML = `
    <div class="done-card" role="alertdialog" aria-label="Submitted">
      <div class="truck-band" aria-hidden="true"></div>
      <div class="done-check">${icon('check')}</div>
      <h2 class="sticker green">Submitted!</h2>
      <p><b>${esc(t ? t.title : 'Task')}</b>${items ? ` · ${items} item${items > 1 ? 's' : ''} uploaded` : ''}.<br>Organisers will review it soon, and you'll get a notification here.</p>
      <button class="btn block" id="doneOk">Back to tasks</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#doneOk').onclick = () => { el.remove(); closeSheet(true); };
}

// ---------- Lightbox ----------
document.addEventListener('click', e => {
  const v = e.target.closest('[data-view]');
  if (v) {
    const url = v.dataset.view;
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = (v.dataset.kind === 'video' ? `<video src="${esc(url)}" controls autoplay playsinline></video>` : `<img src="${esc(url)}" alt="">`) + `<button class="btn sm close">Close</button>`;
    lb.onclick = ev => { if (ev.target === lb || ev.target.classList.contains('close')) lb.remove(); };
    document.body.appendChild(lb);
    return;
  }
  const task = e.target.closest('[data-task]');
  if (task) return openTask(+task.dataset.task);
  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    taskSort = sortBtn.dataset.sort;
    store.set('mm_task_sort', taskSort);
    render();
    return;
  }
  const chip = e.target.closest('[data-f]');
  if (chip) { filter = chip.dataset.f; render(); return; }
  const nav = e.target.closest('nav.bottom [data-tab]');
  if (nav) setTab(nav.dataset.tab);
});

// ---------- Realtime ----------
function connect() {
  es?.close();
  es = new EventSource('/api/events?token=' + encodeURIComponent(token));
  es.addEventListener('refresh', () => load());
  es.addEventListener('leaderboard', () => tab === 'board' && renderBoard());
  es.addEventListener('review', ev => {
    const d = JSON.parse(ev.data);
    const ok = d.status === 'approved';
    const title = ok ? `Approved: ${d.task} (+${d.points})` : `Rejected: ${d.task}`;
    toast(title, d.comment, d.status);
    navigator.vibrate?.(ok ? [80, 40, 80] : [200]);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker?.ready.then(r => r.showNotification(title, { body: d.comment || '', icon: '/img/icon-192.png', tag: 'review-' + d.submissionId }));
    }
    load();
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) { load(); if (!es || es.readyState === 2) connect(); } });

// ---------- Permission setup (shown right after joining) ----------
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const perm = { cam: 'unknown', geo: 'unknown', notif: 'unknown' };

async function queryPerm(name) {
  try { return (await navigator.permissions.query({ name })).state; } catch { return 'unknown'; } // granted | denied | prompt
}
async function refreshPerms() {
  const [c, m, g] = await Promise.all([queryPerm('camera'), queryPerm('microphone'), queryPerm('geolocation')]);
  if (c !== 'unknown') perm.cam = c === 'granted' && m !== 'denied' ? (m === 'granted' || m === 'unknown' ? 'granted' : 'prompt') : c;
  if (g !== 'unknown') perm.geo = g;
  perm.notif = !('Notification' in window) ? 'unsupported' : Notification.permission === 'default' ? 'prompt' : Notification.permission;
}

function askCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) { perm.cam = 'unsupported'; return Promise.resolve(); }
  return navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(s => { s.getTracks().forEach(t => t.stop()); perm.cam = 'granted'; })
    .catch(e => { perm.cam = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'denied' : 'error'; });
}
function askLocation() {
  if (!('geolocation' in navigator)) { perm.geo = 'unsupported'; return Promise.resolve(); }
  return new Promise(resolve => navigator.geolocation.getCurrentPosition(
    () => { perm.geo = 'granted'; resolve(); },
    e => { perm.geo = e.code === 1 ? 'denied' : 'granted-weak'; resolve(); }, // timeout/no fix: allowed, just no signal yet
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }));
}
async function askNotifications() {
  if (!('Notification' in window)) { perm.notif = 'unsupported'; return; }
  try { perm.notif = await Notification.requestPermission(); } catch { perm.notif = Notification.permission; }
}

const SEP = icon('chevron-right', 'sep'); // breadcrumb separator in settings paths
const FIX = {
  cam: IS_IOS
    ? 'iPhone: open <b>Settings ' + SEP + ' Safari ' + SEP + ' Camera</b> and <b>Microphone</b> ' + SEP + ' <b>Allow</b> (or tap <b>aA</b> in the address bar ' + SEP + ' Website Settings), then tap Check again.'
    : 'Tap the icon left of the address bar ' + SEP + ' <b>Permissions</b> ' + SEP + ' turn on <b>Camera</b> and <b>Microphone</b>, then tap Check again.',
  geo: IS_IOS
    ? 'iPhone: <b>Settings ' + SEP + ' Privacy & Security ' + SEP + ' Location Services</b> (on) ' + SEP + ' <b>Safari Websites ' + SEP + ' While Using</b>. Then tap Check again.'
    : 'Tap the icon left of the address bar ' + SEP + ' <b>Permissions</b> ' + SEP + ' <b>Location ' + SEP + ' Allow</b>. Make sure location is on in your phone settings too.',
  notif: IS_IOS
    ? 'On iPhone, alerts only work after <b>Share ' + SEP + ' Add to Home Screen</b>, opening the app from there. Optional: you\'ll still see updates inside the app.'
    : 'Tap the icon left of the address bar ' + SEP + ' <b>Permissions ' + SEP + ' Notifications ' + SEP + ' Allow</b>. Optional.',
};

function permRow(key, title, why, required) {
  const s = perm[key];
  const ok = s === 'granted' || s === 'granted-weak';
  const bad = s === 'denied' || s === 'error';
  const na = s === 'unsupported';
  // Each row can be allowed on its own tap, so every prompt comes straight from a tap.
  const badge = ok ? `<span class="pr-st ok">${icon('check')}Allowed</span>` : bad ? `<span class="pr-st bad">${icon('x')}Blocked</span>` : na ? '<span class="pr-st na">Not available</span>'
    : `<button type="button" class="pr-st pr-ask" data-ask="${key}">Allow</button>`;
  const help = bad || (na && key === 'notif') ? `<div class="pr-help">${FIX[key]}</div>` : s === 'granted-weak' ? '<div class="pr-help">Allowed. GPS signal is weak here, but it will lock on outdoors.</div>' : '';
  return `<div class="pr ${ok ? 'ok' : bad ? 'bad' : ''}"><div class="pr-ic">${icon({ cam: 'camera', geo: 'pin', notif: 'bell' }[key])}</div>
    <div class="pr-body"><div class="pr-top"><b>${title}${required ? '' : ' <span class="pr-opt">optional</span>'}</b>${badge}</div><div class="muted small">${why}</div>${help}</div></div>`;
}

// New members (no selfie yet) must finish both steps: permissions, then a live selfie. No skipping.
const needsOnboarding = () => !!state && !state.me.selfie;

function renderPerms() {
  const camOk = perm.cam === 'granted';
  const geoOk = ['granted', 'granted-weak', 'unsupported'].includes(perm.geo);
  const allDone = ['cam', 'geo', 'notif'].every(k => perm[k] !== 'prompt' && perm[k] !== 'unknown');
  const onboarding = needsOnboarding();
  $('#perms').innerHTML = `
    <div class="pr-hero">${onboarding ? '<span class="ob-step">Step 1 of 2</span>' : ''}<h1>Get your phone <span class="sticker pink">ready</span></h1>
      <p class="muted">Allow these once now, so nothing interrupts you mid-task.</p></div>
    <div class="card pr-list">
      ${permRow('cam', 'Camera & microphone', 'To take photos and record videos for tasks.', true)}
      ${permRow('geo', 'Location', 'Proves where each photo was taken. Organisers may reject submissions without it.', true)}
      ${permRow('notif', 'Notifications', 'Get alerted when organisers approve or reject.', false)}
    </div>
    ${onboarding && camOk && geoOk ? '' : `<button class="btn blue block" id="permAllow">${allDone ? 'Check again' : 'Allow all'}</button>`}
    ${onboarding
      ? `<button class="btn ${camOk && geoOk ? 'blue' : 'ghost'} block" id="permDone" ${camOk && geoOk ? '' : 'disabled'}>Next: onboarding task${icon('arrow-right')}</button>
         ${camOk && geoOk ? '' : '<p class="muted small" style="text-align:center; margin:0">Camera and location are needed to join in.</p>'}`
      : `<button class="btn ${camOk ? '' : 'ghost'} block" id="permDone">${camOk ? `Let's go${icon('arrow-right')}` : 'Skip for now'}</button>`}
    ${allDone ? '' : '<p class="muted small" style="text-align:center; margin:0">Your phone will show its own pop-ups. Tap <b>Allow</b> on each.</p>'}`;
  if ($('#permAllow')) $('#permAllow').onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Waiting for your phone…';
    // Notifications first: browsers only show that prompt right after a tap, and the
    // camera/location pop-ups take long enough that a later request gets auto-blocked.
    if (perm.notif === 'prompt' || perm.notif === 'unknown') await askNotifications();
    if (perm.cam !== 'granted') await askCamera();
    if (perm.geo !== 'granted' && perm.geo !== 'granted-weak') await askLocation();
    await refreshPerms().catch(() => {});
    renderPerms();
  };
  document.querySelectorAll('[data-ask]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Waiting…';
    await { cam: askCamera, geo: askLocation, notif: askNotifications }[b.dataset.ask]();
    await refreshPerms().catch(() => {});
    renderPerms();
  });
  $('#permDone').onclick = async () => {
    if (onboarding) return renderSelfie();
    if (!camOk && !await confirmBox('Skip camera setup?', "You won't be able to complete tasks until camera access is allowed. You can come back to this from the <b>Team</b> tab.", 'Skip')) return;
    store.set('mm_perms_' + (state?.me.id || ''), '1');
    closePerms();
  };
}

// ---------- End-of-day check-in ----------
// While organisers have check-in open, a banner floats at the top. Each member scans the QR code on the
// organisers' screen at the venue. It's not a task: it has its own banner and scanner.
function renderCheckinBar() {
  const el = $('#checkinBar');
  const c = state?.checkin;
  if (!el) return;
  if (!c?.open) { el.className = 'ci-bar hidden'; el.innerHTML = ''; return; }
  const late = c.arrivedAt ? c.lateMin : Math.max(0, Math.ceil((now() - c.deadline) / 60000));
  const pts = late * c.perMinute;
  if (!c.arrivedAt) {
    el.className = 'ci-bar todo' + (late ? ' late' : '');
    el.innerHTML = `<div class="wrap ci-in"><span class="ci-ic">${icon('pin')}</span>
      <div class="ci-txt"><b>Check-in is open</b><span>${late
        ? `${late} min late · your team has lost ${pts} pts so far`
        : `Be back by ${fmtClock(c.deadline)} · one scan per team at the venue`}</span></div>
      <button class="btn sm ci-btn" id="ciScan">Scan QR</button></div>`;
    $('#ciScan').onclick = openScanner;
    return;
  }
  // Any one member's scan checks in the whole team.
  el.className = 'ci-bar done';
  const who = c.meAt && c.meAt === c.arrivedAt ? 'you' : esc(c.arrivedBy || 'a teammate');
  el.innerHTML = `<div class="wrap ci-in"><span class="ci-ic">${icon('check')}</span>
    <div class="ci-txt"><b>Your team is checked in · ${fmtClock(c.arrivedAt)}</b><span>Scanned by ${who} · ${c.lateMin ? `${c.lateMin} min late (−${c.penalty} pts)` : 'on time'}</span></div></div>`;
}
// Keep the "late by" line ticking while the banner is up.
setInterval(() => { if (state?.checkin?.open) renderCheckinBar(); }, 10000);

const scan = { stream: null, timer: null, busy: false, detector: null, paused: false };
function scanMsg(text, kind = '') {
  const el = $('#scanMsg');
  el.className = 'scan-msg ' + kind;
  el.textContent = text;
}
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the scanner. Check your connection."));
    document.head.appendChild(s);
  });
}
async function openScanner() {
  $('#scan').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  scanMsg("Point your camera at the QR code on the organisers' screen");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return scanMsg('The camera only works on a secure (https://) link.', 'bad');
  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (err) {
    return scanMsg(err.name === 'NotAllowedError' ? 'Camera is blocked. Allow it in your browser settings, then try again.' : "Couldn't start the camera: " + (err.message || err.name), 'bad');
  }
  if ($('#scan').classList.contains('hidden')) return stopScanner(); // closed while waiting
  const v = $('#scanView');
  v.srcObject = scan.stream;
  await v.play().catch(() => {});
  // Built-in detector where the phone has one (Android Chrome); jsQR everywhere else (iPhone).
  try {
    if (!scan.detector && 'BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) scan.detector = new BarcodeDetector({ formats: ['qr_code'] });
  } catch {}
  if (!scan.detector) { try { await loadJsQR(); } catch (e) { return scanMsg(e.message, 'bad'); } }
  scan.paused = false;
  clearInterval(scan.timer);
  scan.timer = setInterval(scanFrame, 200);
}
const scanCanvas = document.createElement('canvas');
async function scanFrame() {
  const v = $('#scanView');
  if (scan.busy || scan.paused || !v.videoWidth) return;
  scan.busy = true;
  try {
    let data = null;
    if (scan.detector) data = (await scan.detector.detect(v))[0]?.rawValue || null;
    else {
      const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
      const w = scanCanvas.width = Math.round(v.videoWidth * k), h = scanCanvas.height = Math.round(v.videoHeight * k);
      const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, w, h);
      data = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
    }
    if (data) await submitCheckin(data);
  } catch {} finally { scan.busy = false; }
}
async function submitCheckin(code) {
  if (!code.startsWith('MMCHK-')) return scanMsg("That's a different QR code. Scan the one on the organisers' screen.", 'bad');
  scan.paused = true;
  scanMsg('Checking you in…', 'ok');
  try {
    const r = await api('/api/checkin', { method: 'POST', body: JSON.stringify({ code }) });
    state.checkin = r.checkin;
    closeScanner();
    navigator.vibrate?.([40, 60, 40]);
    renderCheckinBar();
    toast(`Team checked in at ${fmtClock(r.checkin.arrivedAt)}`, 'No one else on your team needs to scan.');
    load();
  } catch (e) {
    scanMsg(e.message, 'bad');
    setTimeout(() => { scan.paused = false; }, 1500); // keep scanning
  }
}
function stopScanner() {
  clearInterval(scan.timer); scan.timer = null;
  scan.stream?.getTracks().forEach(t => t.stop());
  scan.stream = null;
}
function closeScanner() {
  stopScanner();
  $('#scan').classList.add('hidden');
  document.body.style.overflow = openTaskId ? 'hidden' : '';
}
$('#scanClose').onclick = closeScanner;

// ---------- Onboarding task: a selfie, shown like any other task ----------
// The dashed slot opens the same full-screen camera players use for tasks (front camera, photo only).
const selfie = { blob: null, url: null, meta: null, busy: false };

function renderSelfie() {
  const shot = !!selfie.blob;
  $('#perms').innerHTML = `
    <div class="ob-top"><span class="ob-step">Step 2 of 2</span><button class="linkbtn" id="selfieBack">${icon('arrow-left')}Permissions</button></div>
    <div class="ob-task card">
      <div class="head"><div class="pills"><span class="pill st-todo">Onboarding task</span><span class="pill ob-req">Required</span></div></div>
      <h2>Take a picture</h2>
      <p class="desc">Your first task! Snap a picture of yourself, or one with your team. It's a quick test to make sure your camera and location work before the real tasks.</p>
      <div class="slot-sec">
        <div class="slot-h"><span>Photo</span><span class="slot-n ${shot ? 'ok' : ''}">${shot ? icon('check') : ''}${shot ? 1 : 0}/1</span></div>
        <div class="thumbs">${shot
          ? `<div class="thumb"><img src="${selfie.url}" alt="Your picture"><button class="x" id="selfieRetake" aria-label="Retake">${icon('x')}</button></div>`
          : `<button class="slot" id="selfieSlot">${icon('camera')}<span>Photo</span></button>`}</div>
      </div>
      <div id="selfieGeo" class="selfie-geo"></div>
      <button class="btn lime block" id="selfieUse" ${shot ? '' : 'disabled'}>Submit task</button>
    </div>`;
  updateSelfieGeo();
  startGeo();
  $('#selfieBack').onclick = () => { stopGeo(); openPerms(); };
  if (shot) $('#selfieRetake').onclick = () => { resetSelfieShot(); openSelfieCam(); };
  else $('#selfieSlot').onclick = openSelfieCam;
  $('#selfieUse').onclick = uploadSelfie;
}

function openSelfieCam() {
  cam.mode = 'photo';
  cam.facing = 'user';
  cam.onShot = blob => {
    selfie.meta = captureMeta();
    selfie.blob = blob;
    selfie.url = URL.createObjectURL(blob);
    navigator.vibrate?.(30);
    closeCam();
  };
  $('.cam-modes').classList.add('hidden');
  $('#cam').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  updateCamUi();
  startStream();
  startGeo();
}

function updateSelfieGeo() {
  const el = $('#selfieGeo');
  if (!el) return;
  const fresh = geo.last && Date.now() - geo.last.at < GEO_MAX_AGE;
  const [cls, txt] = fresh ? ['on', `Location on · ±${Math.round(geo.last.acc || 0)} m`]
    : geo.status === 'denied' ? ['bad', 'Location is blocked. Allow it to submit.']
      : geo.status === 'unavailable' ? ['', 'No location on this device']
        : ['', 'Finding your location…'];
  el.className = 'selfie-geo ' + cls;
  el.innerHTML = icon('pin') + esc(txt);
  const use = $('#selfieUse');
  if (use) use.disabled = !selfie.blob || geo.status === 'denied' || selfie.busy;
}

function resetSelfieShot() {
  if (selfie.url) URL.revokeObjectURL(selfie.url);
  selfie.blob = selfie.url = selfie.meta = null;
}
function stopSelfie() { stopGeo(); }

async function uploadSelfie() {
  if (selfie.busy || !selfie.blob) return;
  if (geo.status === 'denied') return toast('Allow location first', 'Go back to permissions to fix it.');
  selfie.busy = true;
  const btn = $('#selfieUse');
  btn.disabled = true; btn.textContent = 'Saving…';
  // Use a location fix that arrived after the shot if there wasn't one at the time.
  const m = selfie.meta?.lat != null ? selfie.meta : { ...captureMeta(), capturedAt: selfie.meta?.capturedAt ?? Date.now() };
  const fd = new FormData();
  fd.append('captured_at', m.capturedAt ?? '');
  if (m.lat != null) { fd.append('lat', m.lat); fd.append('lng', m.lng); fd.append('accuracy', m.acc ?? ''); }
  fd.append('media', selfie.blob, 'selfie.jpg');
  try {
    const r = await fetch('/api/me/selfie', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Upload failed');
    state.me.selfie = data.selfie;
    stopSelfie();
    resetSelfieShot();
    store.set('mm_perms_' + state.me.id, '1');
    closePerms();
    render();
    toast(`Onboarding task done, ${state.me.name.split(' ')[0]}!`, "You're in. Pick a task and go.");
  } catch (e) {
    toast("Couldn't save your picture", e.message === 'Failed to fetch' ? 'No connection. Try again.' : e.message, 'rejected');
    btn.disabled = false; btn.textContent = 'Submit task';
  } finally { selfie.busy = false; }
}

async function openPerms() {
  await refreshPerms();
  $('#perms').classList.remove('hidden');
  $('#app').classList.add('hidden');
  window.scrollTo(0, 0);
  renderPerms();
}
function closePerms() {
  $('#perms').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderTeam();
}

async function load() {
  try { const t0 = Date.now(); state = await api('/api/me'); clockOffset = state.serverNow ? state.serverNow - (t0 + Date.now()) / 2 : 0; render(); } catch (e) { if (token) toast('Couldn\'t refresh', e.message); }
}

async function boot() {
  if (!token) { $('#join').classList.remove('hidden'); return; }
  await load();
  if (!state) { if (token) setTimeout(boot, 4000); return; } // offline: retry
  $('#join').classList.add('hidden');
  $('#app').classList.remove('hidden');
  connect();
  // New member: permissions, then a selfie, before the task list (once per member, on any device).
  // Already onboarded but first time on this device: just re-check permissions.
  if (needsOnboarding() || !store.get('mm_perms_' + state.me.id)) openPerms();
}
boot();

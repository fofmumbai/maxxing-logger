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
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

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
  const btn = e.target.querySelector('button');
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

  const n = unreadCount();
  $('#unreadDot').textContent = n;
  $('#unreadDot').classList.toggle('hidden', !n);

  const statuses = tasks.map(t => ({ t, ...taskStatus(t.id) }));
  const counts = { all: tasks.length, todo: 0, pending: 0, approved: 0, rejected: 0 };
  statuses.forEach(s => counts[s.status]++);
  // Rejected first after To do: those need the team's attention. Empty filters are hidden (except All / To do).
  $('#filterChips').innerHTML = ['all', 'todo', 'rejected', 'pending', 'approved'].filter(f => f === 'all' || f === 'todo' || counts[f] || filter === f).map(f =>
    `<button class="chip ${filter === f ? 'on' : ''}" data-f="${f}">${f === 'all' ? 'All' : STATUS_LABEL[f]}<span class="n">${counts[f]}</span></button>`).join('');
  $('#filterChips').classList.toggle('hidden', tab !== 'tasks');
  updateChipFade();

  const list = statuses.filter(s => filter === 'all' || s.status === filter);
  $('#taskList').innerHTML = list.length ? list.map(({ t, status }) => `
    <button class="task card ${status}" data-task="${t.id}" aria-label="${esc(t.title)}, ${STATUS_LABEL[status]}, ${t.points} points">
      <span class="ic ${status}">${STATUS_ICON[status]}</span>
      <div>
        <h3>${esc(t.title)}</h3>
        <div class="sub ${status}">#${tasks.indexOf(t) + 1}${status === 'todo' ? '' : ' · ' + STATUS_LABEL[status]}</div>
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
  const notifOk = 'Notification' in window && Notification.permission === 'granted';
  $('#teamView').innerHTML = `
    <div class="card codebox"><span class="small" style="opacity:.7">ROOM CODE</span><b>${esc(team.code)}</b><span class="small" style="opacity:.7">${members.length}/${maxMembers} members joined</span></div>
    <div class="card">${members.map((m, i) => `
      <div class="member"><div class="avatar" style="background:${AVATAR_COLORS[i % 4]}">${esc(m.name[0].toUpperCase())}</div>
      <div style="flex:1"><b>${esc(m.name)}</b>${m.id === me.id ? ' <span class="muted small">(you)</span>' : ''}</div></div>`).join('')}
    </div>
    <div class="card" style="padding:16px; display:grid; gap:4px">
      <b>${team.points} points · ${team.approved}/${state.tasks.length} tasks approved</b>
      <span class="muted small">${team.pending} waiting for review</span>
    </div>
    ${'Notification' in window && !notifOk ? `<button class="btn lime block" id="notifBtn">Turn on review alerts</button>` : ''}
    <button class="linkbtn" id="leaveBtn">Sign out on this device</button>`;
  $('#notifBtn') && ($('#notifBtn').onclick = async () => { await Notification.requestPermission(); renderTeam(); });
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
  if (d.state === 'done') return `<span class="ok" aria-label="Uploaded">✓</span>`;
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
  btn.disabled = !n || sending;
  if (!n) { btn.innerHTML = 'Send for review'; return; }
  const label = sending ? (done < n ? `Finishing uploads… ${pct}%` : 'Submitting…') : `Send ${n} item${n > 1 ? 's' : ''} for review`;
  const sub = failed ? `${failed} failed, tap to retry` : done < n ? `Uploading ${done}/${n} · ${pct}%` : `All ${n} uploaded ✓`;
  btn.innerHTML = `<span style="display:grid; gap:6px; width:100%; justify-items:center">${label}<span class="small" style="font-weight:400">${sub}</span>${done < n ? `<span class="upbar"><i style="width:${pct}%"></i></span>` : ''}</span>`;
}

function lockSheet(locked) {
  document.querySelectorAll('.capture .btn, [data-rm], [data-retry], #closeSheet, #noteInput').forEach(b => (b.disabled = locked));
}

function mediaHtml(list) {
  return `<div class="thumbs">${list.map(m => `
    <div class="thumb" data-view="${esc(m.url)}" data-kind="${m.kind}">
      ${m.kind === 'video' ? `<video src="${esc(m.url)}#t=0.1" muted playsinline preload="metadata"></video><span class="tag">▶ Video</span>` : `<img src="${esc(m.url)}" loading="lazy" alt="">`}
    </div>`).join('')}</div>`;
}

const ICON_CAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';
const ICON_VID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>';

function renderSheet() {
  const t = state.tasks.find(x => x.id === openTaskId);
  if (!t) { openTaskId = null; $('#sheetHost').innerHTML = ''; return; }
  const { status, sub, history } = taskStatus(t.id);
  const canSubmit = state.submissionsOpen && (status === 'todo' || status === 'rejected');
  const prevScroll = $('#sheetHost .sheet')?.scrollTop || 0;

  let body = '';
  if (status === 'approved') {
    body = `<div class="feedback approved"><b>+${t.points} points earned 🎉</b>${sub.comment ? `<span>Organisers: “${esc(sub.comment)}”</span>` : ''}</div>${mediaHtml(sub.media)}`;
  } else if (status === 'pending') {
    body = `<div class="feedback pending"><b>Waiting for review</b><span>Sent by ${esc(sub.member_name || 'your team')} ${ago(sub.created_at)}. You'll be notified when organisers review it.</span></div>${mediaHtml(sub.media)}`;
  } else {
    if (status === 'rejected') body += `<div class="feedback rejected"><b>Not accepted. Try again below</b><span>Organisers: “${esc(sub.comment)}”</span></div>`;
    if (canSubmit) {
      body += `
        <div class="capture">
          <button class="btn" id="takePhoto">${ICON_CAM}Take photo</button>
          <button class="btn blue" id="takeVideo">${ICON_VID}Record video</button>
        </div>
        ${draft.length ? `<div class="thumbs">${draft.map(d => `
          <div class="thumb" data-key="${d.key}">${d.kind === 'video' ? `<video src="${d.url}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="${d.url}" alt="">`}
          <span class="tag">${d.meta?.lat != null ? '📍 ' : ''}${d.kind === 'video' ? `▶ ${fmtDur(d.duration || 0)} · ` : ''}${fmtMB(d.file.size)}</span>
          <div class="ov">${overlayHtml(d)}</div>
          <button class="x" data-rm="${d.key}" aria-label="Remove">×</button></div>`).join('')}</div>`
          : `<p class="muted small" style="margin:0">Camera only: capture photos and videos live. Add as many as you need, then send.</p>`}
        <textarea id="noteInput" class="input" placeholder="Add a note for the organisers (optional)" maxlength="500"></textarea>
        <button class="btn lime block" id="sendBtn" ${draft.length ? '' : 'disabled'}>Send ${draft.length ? draft.length + ' item' + (draft.length > 1 ? 's' : '') : ''} for review</button>`;
    } else if (!state.submissionsOpen) {
      body += `<div class="feedback pending"><b>Submissions are closed</b></div>`;
    }
  }
  const older = history.filter(h => h !== sub);
  if (older.length) body += `<details><summary class="muted small" style="cursor:pointer">Earlier attempts (${older.length})</summary>${older.map(h => `
    <div style="margin-top:10px; display:grid; gap:6px"><span class="pill st-${h.status}" style="justify-self:start">${STATUS_LABEL[h.status]}</span>${h.comment ? `<span class="small">“${esc(h.comment)}”</span>` : ''}${mediaHtml(h.media)}</div>`).join('')}</details>`;

  const note = $('#noteInput')?.value || '';
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

  // Wrap in arrows: passing closeSheet directly would hand it the click event as "force" and skip the discard prompt.
  $('#scrim').onclick = () => closeSheet();
  $('#closeSheet').onclick = () => closeSheet();
  $('#takePhoto') && ($('#takePhoto').onclick = () => capture('photo'));
  $('#takeVideo') && ($('#takeVideo').onclick = () => capture('video'));
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
// Everything is captured live from getUserMedia. There is no <input type=file>,
// so on every device there is no way to pick from the gallery.
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
  const el = $('#geoPill');
  if (!el) return;
  const fresh = geo.last && Date.now() - geo.last.at < GEO_MAX_AGE;
  const st = geo.status === 'on' && fresh ? 'on' : geo.status === 'on' ? 'weak' : geo.status;
  el.className = 'geo-pill ' + st;
  el.textContent = { on: `📍 Location on · ±${Math.round(geo.last?.acc || 0)} m`, finding: '📍 Finding location…', weak: '📍 Weak GPS signal…', denied: '📍 Location off', unavailable: '📍 No location on this device', idle: '' }[st] || '';
}


function capture(mode) {
  if (draft.length >= MAX_ITEMS) return toast(`Max ${MAX_ITEMS} items per submission`);
  cam.mode = mode === 'video' ? 'video' : 'photo';
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

function addCapture(blob, kind, ext, duration = 0, meta = captureMeta()) {
  const file = new File([blob], `${kind}-${Date.now()}.${ext}`, { type: blob.type, lastModified: Date.now() });
  draft.push({ key: ++keySeq, file, url: URL.createObjectURL(file), kind, duration, meta, state: 'queued', progress: 0 });
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
  if (blob) addCapture(blob, 'image', 'jpg');
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
  if (sending || !draft.length) return;
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
    await api('/api/submissions', { method: 'POST', body: JSON.stringify({ task_id: taskId, note: $('#noteInput')?.value || '', upload_ids: draft.map(d => d.uploadId) }) });
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
      <div class="done-check">✓</div>
      <h2>Submitted!</h2>
      <p><b>${esc(t ? t.title : 'Task')}</b> · ${items} item${items > 1 ? 's' : ''} uploaded.<br>Organisers will review it soon, and you'll get a notification here.</p>
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

async function load() {
  try { state = await api('/api/me'); render(); } catch (e) { if (token) toast('Couldn\'t refresh', e.message); }
}

async function boot() {
  if (!token) { $('#join').classList.remove('hidden'); return; }
  await load();
  if (!state) { if (token) setTimeout(boot, 4000); return; } // offline: retry
  $('#join').classList.add('hidden');
  $('#app').classList.remove('hidden');
  connect();
}
boot();

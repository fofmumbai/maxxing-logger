/* Mumbai Maxxing — organiser dashboard */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const STATUS = { todo: 'Not started', pending: 'Needs review', approved: 'Approved', rejected: 'Rejected' };
const AV = ['var(--lime)', 'var(--coral)', 'var(--green)', '#C9C8FF'];
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

let token = store.get('mm_admin');
let me = null; // { super, id, name, username, teamIds }
const isSuper = () => !!me?.super;
let es = null;
let route = { name: 'teams' };
let teamSort = store.get('mm_sort') || 'pending';
let teamTaskFilter = 'all';
let queueStatus = 'pending', queueTeam = '', queueTask = '';
let tasksCache = [];
let teamsCache = [];
const drafts = {};      // submission id -> comment being typed (survives live re-renders)
const openRows = {};    // `${teamId}:${taskId}` -> expanded?

// ---------- Helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...opts.headers } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Logged out'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); Object.assign(e, data); throw e; }
  return data;
}
function toast(title, body = '', kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
  el.onclick = () => el.remove();
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(ts * 1000).toLocaleString();
}
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
const avatar = (name, i) => `<span class="av" style="background:${AV[i % 4]}">${esc((name || '?')[0].toUpperCase())}</span>`;

// Render into #view while keeping the comment box the organiser is typing in.
function paint(html) {
  const f = document.activeElement;
  const fid = f?.id, sel = f && 'selectionStart' in f ? [f.selectionStart, f.selectionEnd] : null;
  $('#view').innerHTML = html;
  if (fid && $('#' + fid)) { const el = $('#' + fid); el.focus(); if (sel) try { el.setSelectionRange(...sel); } catch {} }
}

// ---------- Auth ----------
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#user').value, password: $('#pw').value }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    token = d.token; store.set('mm_admin', token);
    boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
function logout() {
  token = null; me = null; store.del('mm_admin'); es?.close();
  teamsCache = []; tasksCache = [];
  document.body.classList.remove('reviewer');
  $('#pw').value = '';
  $('#dash').classList.add('hidden'); $('#login').classList.remove('hidden');
}

// ---------- Router ----------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  if (name === 'team' && id) return { name: 'team', id: +id };
  const allowed = isSuper() ? ['teams', 'queue', 'board', 'tasks', 'admins', 'settings'] : ['teams', 'queue', 'board', 'settings'];
  return { name: allowed.includes(name) ? name : 'teams' };
}
window.addEventListener('hashchange', () => { route = parseRoute(); window.scrollTo(0, 0); render(); });
function render() {
  const tab = route.name === 'team' ? 'teams' : route.name;
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  ({ teams: viewTeams, team: () => viewTeam(route.id), queue: viewQueue, board: viewBoard, tasks: viewTasks, admins: viewAdmins, settings: viewSettings })[route.name]()
    .catch(err => err.message !== 'Logged out' && paint(`<div class="empty">${esc(err.message)}</div>`));
  loadSummary();
}

async function loadSummary() {
  const s = await api('/api/admin/summary');
  $('#pendingBadge').textContent = s.counts.pending || '';
  document.title = (s.counts.pending ? `(${s.counts.pending}) ` : '') + 'Mumbai Maxxing Admin';
  return s;
}

// ---------- Shared: submission card ----------
// Small dialog with labelled choices (clearer than OK/Cancel for destructive actions).
// options: [{ label, value, kind: 'danger' | 'primary' | 'ghost' }] -> resolves to the chosen value, or null.
function choose(title, body, options, cancelLabel = 'Cancel') {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'dlg-scrim';
    el.innerHTML = `<div class="dlg card" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><p>${body}</p>
      <div class="dlg-actions">${options.map((o, i) => `<button class="btn sm ${o.kind === 'danger' ? 'coral' : o.kind === 'primary' ? '' : 'ghost'}" data-i="${i}">${esc(o.label)}</button>`).join('')}
      <button class="btn sm ghost" data-i="-1">${esc(cancelLabel)}</button></div></div>`;
    const done = v => { el.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(null); };
    el.onclick = e => { const b = e.target.closest('[data-i]'); if (b) done(+b.dataset.i < 0 ? null : options[+b.dataset.i].value); else if (e.target === el) done(null); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(el);
    el.querySelector('[data-i="-1"]').focus();
  });
}

// ---------- Capture details (time + GPS) ----------
const IST = { timeZone: 'Asia/Kolkata' };
const fmtTime = ms => new Date(ms).toLocaleTimeString('en-IN', { ...IST, hour: 'numeric', minute: '2-digit' });
const fmtDateTime = ms => new Date(ms).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' IST';
const mapsUrl = m => `https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lng}`;
const coords = m => `${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`;

// One line per submission: where/when the first located file was taken, or a warning if none were.
function captureLine(s) {
  const located = s.media.filter(m => m.lat != null);
  const first = located[0];
  const taken = s.media.find(m => m.capturedAt)?.capturedAt;
  if (!first) return `<div class="cap none">📍 No location shared${taken ? ` · taken ${fmtTime(taken)} IST` : ''}</div>`;
  const partial = located.length < s.media.length ? ` · ${located.length}/${s.media.length} files located` : '';
  return `<div class="cap">📍 <a href="${mapsUrl(first)}" target="_blank" rel="noopener">${coords(first)}</a> <span class="muted">±${Math.round(first.accuracy || 0)} m${taken ? ` · taken ${fmtTime(taken)} IST` : ''}${partial}</span></div>`;
}

function mediaTile(m) {
  const cap = JSON.stringify({ t: m.capturedAt || null, u: m.uploadedAt || null, lat: m.lat, lng: m.lng, acc: m.accuracy, g: m.source === 'gallery' });
  return `<div class="m" data-view="${esc(m.url)}" data-kind="${m.kind}" data-drive="${esc(m.driveUrl || '')}" data-cap="${esc(cap)}" title="${fmtSize(m.size)}">
    ${m.lat != null ? '<span class="pin" title="Has location">📍</span>' : ''}
    ${m.source === 'gallery' ? '<span class="src-gal" title="Picked from the phone gallery, not captured live">🖼️ Gallery</span>' : ''}
    ${isSuper() ? `<button class="del-file" data-del-file="${m.id}" aria-label="Delete this ${m.kind === 'video' ? 'video' : 'photo'}" title="Delete this file">${ICON_TRASH}</button>` : ''}
    ${m.kind === 'video' ? `<video src="${esc(m.url)}#t=0.1" muted playsinline preload="metadata"></video><span class="tag">▶ ${fmtSize(m.size)}</span>` : `<img src="${esc(m.url)}" loading="lazy" alt="">`}
  </div>`;
}
function subCard(s, { showTeam = false, showTask = false, attempt = null } = {}) {
  const pending = s.status === 'pending';
  return `
    <article class="card sub" id="sub-${s.id}">
      <div class="hd">
        <div>
          ${showTeam ? `<a class="team" href="#/team/${s.team_id}">${esc(s.team_name)} →</a>` : ''}
          ${showTask ? `<h3>${esc(s.task_title)}</h3>` : ''}
          ${attempt ? `<b>Attempt ${attempt}</b>` : ''}
          <div class="muted small">by ${esc(s.member_name || 'removed member')} · ${ago(s.created_at)} · ${s.media.length} file${s.media.length === 1 ? '' : 's'}</div>
        </div>
        ${showTask ? `<span class="pill pts">+${s.points}</span>` : `<span class="pill st-${s.status}">${STATUS[s.status]}</span>`}
      </div>
      <div class="media">${s.media.map(mediaTile).join('')}</div>
      ${captureLine(s)}
      ${s.link ? `<a class="sub-link" href="${esc(s.link)}" target="_blank" rel="noopener">🔗 ${esc(s.link.replace(/^https?:\/\//, '').slice(0, 70))}</a>` : ''}
      ${s.note ? `<div class="note"><b>Team note:</b> ${esc(s.note)}</div>` : ''}
      ${!pending ? `<div class="reviewed ${s.status}"><b>${s.status === 'approved' ? 'Approved' : 'Rejected'}</b> ${ago(s.reviewed_at)}${s.reviewed_by ? ` by ${esc(s.reviewed_by)}` : ''}${s.comment ? ` · “${esc(s.comment)}”` : ''}</div>` : ''}
      <div class="rv ${pending || drafts[s.id] !== undefined ? '' : 'hidden'}" style="display:grid; gap:8px">
        <textarea class="input" id="c-${s.id}" data-c="${s.id}" placeholder="Comment for the team (required to reject)" rows="2">${esc(drafts[s.id] ?? (pending ? '' : s.comment))}</textarea>
        <div class="actions">
          <button class="btn coral" data-review="rejected" data-id="${s.id}">Reject</button>
          <button class="btn green" data-review="approved" data-id="${s.id}">Approve</button>
        </div>
      </div>
      <div class="sub-foot">
        ${!pending && drafts[s.id] === undefined ? `<button class="btn ghost sm" data-change="${s.id}">Change decision</button>` : '<span></span>'}
        ${isSuper() ? `<button class="del-btn" data-del-sub="${s.id}" data-files="${s.media.length}" data-status="${s.status}" data-pts="${s.points ?? ''}">Delete submission</button>` : ''}
      </div>
    </article>`;
}

// Confirm, then delete a team. Fetches fresh counts so the warning is accurate wherever it's triggered from.
async function confirmDeleteTeam(id) {
  let d;
  try { d = await api('/api/admin/teams/' + id); } catch (err) { toast('Error', err.message, 'rejected'); return false; }
  const { team, members, submissions } = d;
  const files = submissions.reduce((a, s) => a + s.media.length, 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ok = await choose(`Delete ${team.name}?`,
    `This permanently deletes the team and its room code <b>${esc(team.code)}</b>, signs out <b>${plural(members.length, 'member')}</b>, and deletes <b>${plural(submissions.length, 'submission')}</b> with <b>${plural(files, 'file')}</b> (moved to the Google Drive trash).` +
    (team.points ? ` Its <b>${team.points} points</b> leave the leaderboard.` : '') + ` This can't be undone.`,
    [{ label: 'Delete team', value: true, kind: 'danger' }]);
  if (!ok) return false;
  try { await api('/api/admin/teams/' + id, { method: 'DELETE' }); toast(`${team.name} deleted`); return true; }
  catch (err) { toast('Error', err.message, 'rejected'); return false; }
}

// ---------- Teams home ----------
async function viewTeams() {
  const d = await api('/api/admin/teams');
  teamsCache = d.teams;
  const tasks = tasksCache.length ? tasksCache : (tasksCache = await api('/api/admin/tasks'));
  const totals = d.teams.reduce((a, t) => ({ pending: a.pending + t.pending, members: a.members + t.member_count }), { pending: 0, members: 0 });
  const sorted = [...d.teams].sort(
    teamSort === 'points' ? (a, b) => b.points - a.points || a.id - b.id
      : teamSort === 'pending' ? (a, b) => b.pending - a.pending || a.id - b.id
        : (a, b) => a.id - b.id);
  $('#printSheet').innerHTML = d.teams.map(t => `<div class="pcard"><div>Mumbai Maxxing · ${esc(t.name)}</div><b>${esc(t.code)}</b><div>Join at ${esc(location.origin)}</div></div>`).join('');
  paint(`
    <div class="toolbar">
      <h2>Teams</h2>
      <div class="stats"><span class="pill st-pending">${totals.pending} to review</span><span class="pill st-todo">${totals.members} players joined</span></div>
      <select class="input sm" id="teamSort">
        <option value="pending" ${teamSort === 'pending' ? 'selected' : ''}>Sort: needs review first</option>
        <option value="number" ${teamSort === 'number' ? 'selected' : ''}>Sort: team number</option>
        <option value="points" ${teamSort === 'points' ? 'selected' : ''}>Sort: points</option>
      </select>
      ${isSuper() ? `<button class="btn ghost sm" id="addTeam">+ Add team</button>
      <button class="btn sm" id="printCodes">Print room codes</button>` : ''}
    </div>
    ${!isSuper() && !sorted.length ? '<div class="empty">No teams are assigned to you yet. Ask the super admin to assign your teams.</div>' : ''}
    <div class="teamgrid">${sorted.map(t => `
      <a class="card tcard ${t.pending ? 'has-pending' : ''}" href="#/team/${t.id}">
        ${t.pending ? `<span class="review-tag">${t.pending} to review</span>` : ''}
        <div class="hd">
          <div><h3>${esc(t.name)}</h3><div class="code">${esc(t.code)}</div></div>
          <span class="pill pts">${t.points} pts</span>
        </div>
        <div>
          <div class="bar"><i style="width:${tasks.length ? (t.approved / tasks.length) * 100 : 0}%"></i></div>
          <div class="muted small" style="margin-top:6px">${t.approved}/${tasks.length} tasks approved</div>
          ${isSuper() ? `<div class="reviewers-line" style="margin-top:4px">${t.reviewers.length ? 'Reviewer: ' + esc(t.reviewers.join(', ')) : 'No reviewer assigned'}</div>` : ''}
        </div>
        <div class="foot">
          <div class="avs">${t.members.map((m, i) => avatar(m.name, i)).join('')}${Array.from({ length: Math.max(0, d.maxMembers - t.members.length) }, () => '<span class="av av-empty">+</span>').join('')}</div>
          <span class="foot-r"><span class="muted small">${t.members.length}/${d.maxMembers} joined</span>
            ${isSuper() ? `<button class="card-del" data-del-team="${t.id}" aria-label="Delete ${esc(t.name)}" title="Delete team">${ICON_TRASH}</button>` : ''}</span>
        </div>
      </a>`).join('')}
    </div>`);
  $('#teamSort').onchange = e => { teamSort = e.target.value; store.set('mm_sort', teamSort); viewTeams(); };
  $$('[data-del-team]').forEach(b => b.onclick = async e => {
    e.preventDefault(); e.stopPropagation(); // the card itself is a link to the team page
    if (await confirmDeleteTeam(+b.dataset.delTeam)) viewTeams();
  });
  if (!isSuper()) return;
  $('#addTeam').onclick = async () => {
    const name = prompt('Team name', '');
    if (name === null) return;
    await api('/api/admin/teams', { method: 'POST', body: JSON.stringify({ name }) }); viewTeams();
  };
  $('#printCodes').onclick = () => window.print();
}

// ---------- Team detail ----------
async function viewTeam(id) {
  const d = await api('/api/admin/teams/' + id);
  const { team, members, tasks, submissions, maxMembers } = d;
  tasksCache = tasks.map(t => ({ ...t }));

  const rows = tasks.map((t, i) => {
    const subs = submissions.filter(s => s.task_id === t.id); // newest first
    const status = subs.some(s => s.status === 'pending') ? 'pending'
      : subs.some(s => s.status === 'approved') ? 'approved'
        : subs.length ? 'rejected' : 'todo';
    return { t, i, subs, status };
  });
  const counts = { all: rows.length, pending: 0, approved: 0, rejected: 0, todo: 0 };
  rows.forEach(r => counts[r.status]++);
  const visible = rows.filter(r => teamTaskFilter === 'all' || r.status === teamTaskFilter);

  paint(`
    <a class="back" href="#/teams">← All teams</a>
    <section class="card thead">
      <div style="display:grid; gap:14px">
        <input class="namefield" id="teamName" value="${esc(team.name)}" maxlength="40" aria-label="Team name" ${isSuper() ? '' : 'readonly'}>
        <div class="codebig">
          <span class="muted small">ROOM CODE</span><b>${esc(team.code)}</b>
          ${isSuper() ? `<button class="btn ghost sm" id="copyLink">Copy join link</button>
          <button class="btn ghost sm" id="newCode">New code</button>
          <button class="btn sm danger-ghost" id="deleteTeam">${ICON_TRASH} Delete team</button>` : ''}
        </div>
        <div>
          <div class="muted small" style="margin-bottom:6px">MEMBERS · ${members.length}/${maxMembers}</div>
          ${members.map((m, i) => `<span class="mchip">${avatar(m.name, i)}${esc(m.name)}${isSuper() ? `<button class="kick" data-kick="${m.id}" data-name="${esc(m.name)}" data-subs="${submissions.filter(x => x.member_id === m.id).length}">Remove</button>` : ''}</span>`).join('') || '<span class="muted">No one has joined yet.</span>'}
        </div>
      </div>
      <div class="scorebox">
        <div class="big">${team.points}</div><div class="muted">points</div>
        <div class="stats">
          <span class="pill st-approved">${team.approved} approved</span>
          <span class="pill st-pending">${team.pending} to review</span>
          <span class="pill st-rejected">${d.team.rejected} rejected</span>
        </div>
      </div>
    </section>

    <div class="toolbar">
      <h2 style="font-size:22px">Tasks</h2>
      <div class="seg" id="ttFilter">
        ${['all', 'pending', 'approved', 'rejected', 'todo'].map(f => `<button data-f="${f}" class="${teamTaskFilter === f ? 'on' : ''}">${f === 'all' ? 'All' : STATUS[f]}<span class="n">${counts[f]}</span></button>`).join('')}
      </div>
      <button class="btn ghost sm" id="expandAll">Expand all</button>
      <button class="btn ghost sm" id="collapseAll">Collapse all</button>
    </div>

    <div class="tasklist">${visible.length ? visible.map(({ t, i, subs, status }) => {
      const key = `${id}:${t.id}`;
      const open = openRows[key] ?? status === 'pending';
      return `
      <div class="card trow ${open ? 'open' : ''} ${status === 'pending' ? 'st-pending-row' : ''}">
        <button class="sum" data-toggle="${key}">
          <span class="num">#${i + 1}</span>
          <span class="tt"><b>${esc(t.title)}</b><span class="muted small">${subs.length ? `${subs.length} submission${subs.length > 1 ? 's' : ''} · last ${ago(subs[0].created_at)}` : 'No submissions yet'}</span></span>
          <span style="display:flex; gap:6px; align-items:center"><span class="pill st-${status}">${STATUS[status]}</span><span class="pill pts">+${t.points}</span></span>
          <span class="chev">›</span>
        </button>
        ${open ? `<div class="body">
          ${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}
          ${subs.length ? `<div class="attempts">${subs.map((s, k) => subCard(s, { attempt: subs.length - k })).join('')}</div>` : '<div class="muted">Nothing submitted for this task yet.</div>'}
        </div>` : ''}
      </div>`;
    }).join('') : `<div class="empty">No tasks in this filter.</div>`}</div>`);

  $$('#ttFilter [data-f]').forEach(b => b.onclick = () => { teamTaskFilter = b.dataset.f; viewTeam(id); });
  $$('[data-toggle]').forEach(b => b.onclick = () => {
    const row = rows.find(r => `${id}:${r.t.id}` === b.dataset.toggle);
    openRows[b.dataset.toggle] = !(openRows[b.dataset.toggle] ?? row.status === 'pending');
    viewTeam(id);
  });
  $('#expandAll').onclick = () => { visible.forEach(r => (openRows[`${id}:${r.t.id}`] = true)); viewTeam(id); };
  $('#collapseAll').onclick = () => { visible.forEach(r => (openRows[`${id}:${r.t.id}`] = false)); viewTeam(id); };
  if (!isSuper()) return;
  $('#teamName').onchange = async e => {
    try { await api('/api/admin/teams/' + id, { method: 'PATCH', body: JSON.stringify({ name: e.target.value }) }); toast('Team renamed'); }
    catch (err) { toast('Error', err.message, 'rejected'); }
  };
  $('#copyLink').onclick = async () => {
    const link = `${location.origin}/?code=${team.code}`;
    try { await navigator.clipboard.writeText(link); toast('Copied', link); } catch { prompt('Join link', link); }
  };
  $('#newCode').onclick = async () => {
    if (!await choose('Generate a new room code?', `The current code <b>${esc(team.code)}</b> stops working for new joins. Members already in the team stay in.`,
      [{ label: 'Generate new code', value: true, kind: 'primary' }])) return;
    await api(`/api/admin/teams/${id}/new-code`, { method: 'POST' }); viewTeam(id);
  };
  $('#deleteTeam').onclick = async () => { if (await confirmDeleteTeam(id)) location.hash = '#/teams'; };
  $$('[data-kick]').forEach(b => b.onclick = async () => {
    const name = esc(b.dataset.name), n = +b.dataset.subs;
    const choice = await choose(`Remove ${b.dataset.name}?`,
      `${name} will be signed out and their seat frees up for someone else.` + (n ? `<br><br>They sent <b>${n} submission${n > 1 ? 's' : ''}</b>. Keep them for the team, or delete them with all their photos and videos (any points they earned are removed)?` : ''),
      n ? [{ label: 'Remove, keep uploads', value: 'keep', kind: 'primary' }, { label: `Remove & delete ${n} submission${n > 1 ? 's' : ''}`, value: 'delete', kind: 'danger' }]
        : [{ label: 'Remove', value: 'keep', kind: 'danger' }]);
    if (!choice) return;
    try {
      const r = await api('/api/admin/members/' + b.dataset.kick + (choice === 'delete' ? '?withMedia=1' : ''), { method: 'DELETE' });
      toast(`${b.dataset.name} removed`, choice === 'delete' ? `${r.deletedFiles} file${r.deletedFiles === 1 ? '' : 's'} deleted.` : '');
      viewTeam(id);
    } catch (err) { toast('Error', err.message, 'rejected'); }
  });
}

// ---------- Review queue (all teams) ----------
async function viewQueue() {
  if (!teamsCache.length) teamsCache = (await api('/api/admin/teams')).teams;
  if (!tasksCache.length) tasksCache = await api('/api/admin/tasks');
  const q = new URLSearchParams({ status: queueStatus, team: queueTeam, task: queueTask });
  const [rows, s] = await Promise.all([api('/api/admin/submissions?' + q), loadSummary()]);
  paint(`
    <div class="toolbar">
      <h2>Review queue</h2>
      <div class="seg" id="qStatus">
        ${[['pending', 'Pending', s.counts.pending], ['approved', 'Approved', s.counts.approved], ['rejected', 'Rejected', s.counts.rejected], ['', 'All', '']].map(([v, l, n]) =>
          `<button data-s="${v}" class="${queueStatus === v ? 'on' : ''}">${l}${n !== '' ? `<span class="n">${n}</span>` : ''}</button>`).join('')}
      </div>
      <select class="input sm" id="qTeam"><option value="">All teams</option>${teamsCache.map(t => `<option value="${t.id}" ${+queueTeam === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <select class="input sm" id="qTask"><option value="">All tasks</option>${tasksCache.map((t, i) => `<option value="${t.id}" ${+queueTask === t.id ? 'selected' : ''}>#${i + 1} ${esc(t.title)}</option>`).join('')}</select>
    </div>
    ${queueStatus === 'pending' ? `<p class="muted small" style="margin:-6px 0 14px">Oldest first, across ${isSuper() ? 'all teams' : 'your teams'}.</p>` : ''}
    <div class="grid">${rows.length ? rows.map(r => subCard(r, { showTeam: true, showTask: true })).join('') : `<div class="empty" style="grid-column:1/-1">${queueStatus === 'pending' ? 'All caught up. New submissions appear here live.' : 'No submissions.'}</div>`}</div>`);
  $$('#qStatus [data-s]').forEach(b => b.onclick = () => { queueStatus = b.dataset.s; viewQueue(); });
  $('#qTeam').onchange = e => { queueTeam = e.target.value; viewQueue(); };
  $('#qTask').onchange = e => { queueTask = e.target.value; viewQueue(); };
}

// ---------- Leaderboard ----------
async function viewBoard() {
  const rows = await api('/api/admin/leaderboard');
  paint(`<div class="toolbar"><h2>Leaderboard</h2></div>
    <div class="card">${rows.map((r, i) => `
      <a class="lbrow" ${isSuper() || me.teamIds.includes(r.id) ? `href="#/team/${r.id}"` : ''} style="${i ? 'border-top:1px solid var(--line)' : ''}"><span class="rank">${i + 1}</span><span class="name">${esc(r.name)}</span>
      ${isSuper() ? `<span class="muted small">${r.approved} approved · ${r.pending} to review</span>` : ''}<span class="pill pts" style="font-size:16px">${r.points}</span></a>`).join('')}</div>`);
}

// ---------- Tasks editor ----------
// Requirement summary used in the task list, editor preview and submission cards.
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function reqParts(t) {
  if (!t.min_photos && !t.min_videos && !t.needs_link) return [{ ic: '📝', text: 'Nothing to upload', cls: 'any' }];
  return [
    t.min_photos ? { ic: '📷', text: plural(t.min_photos, 'photo') } : null,
    t.min_videos ? { ic: '🎥', text: plural(t.min_videos, 'video') } : null,
    t.needs_link ? { ic: '🔗', text: t.link_label || 'Link' } : null,
  ].filter(Boolean);
}
// Gallery uploads only matter when the task asks for photos/videos.
const wantsMedia = t => !!(t.min_photos || t.min_videos);
const galleryPill = t => t.allow_gallery && wantsMedia(t) ? '<span class="req-pill gallery">🖼️ Gallery allowed</span>' : '';
const reqPills = t => reqParts(t).map(p => `<span class="req-pill ${p.cls || ''}">${p.ic} ${esc(p.text)}</span>`).join('') + galleryPill(t);

// ---------- Task schedule (entered and shown in IST, stored as ms since epoch) ----------
const IST_OFFSET_MS = 330 * 60 * 1000;
const toISTInput = ms => ms ? new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16) : '';
const fromISTInput = v => v ? Date.parse(v + ':00+05:30') || null : null;
const istTime = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const istDay = ms => new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
function schedText(t) {
  const o = t.opens_at, c = t.closes_at;
  if (!o && !c) return '';
  if (o && c) return istDay(o) === istDay(c) ? `${istDay(o)}, ${istTime(o)} – ${istTime(c)} IST` : `${istDay(o)} ${istTime(o)} → ${istDay(c)} ${istTime(c)} IST`;
  return o ? `Opens ${istDay(o)}, ${istTime(o)} IST` : `Closes ${istDay(c)}, ${istTime(c)} IST`;
}
function schedPill(t) {
  const txt = schedText(t);
  if (!txt) return '';
  const n = Date.now();
  const st = t.opens_at && n < t.opens_at ? ['upcoming', 'Upcoming'] : t.closes_at && n >= t.closes_at ? ['closed', 'Closed'] : ['open', 'Open now'];
  return `<span class="req-pill sched-${st[0]}">🕒 ${esc(txt)} · <b>${st[1]}</b></span>`;
}

async function viewTasks() {
  const tasks = tasksCache = await api('/api/admin/tasks');
  paint(`
    <div class="toolbar">
      <h2>Tasks</h2>
      <span class="muted small">${tasks.length} tasks · ${tasks.reduce((a, t) => a + t.points, 0)} points available</span>
      <button class="btn blue sm" id="newTaskBtn">+ New task</button>
    </div>
    <div class="tlist">${tasks.map((t, i) => `
      <div class="card titem">
        <div class="tnum">${i + 1}</div>
        <div class="tmain">
          <div class="ttop"><b>${esc(t.title)}</b><span class="pill pts">+${t.points}</span></div>
          ${t.description ? `<div class="muted small tdesc">${esc(t.description)}</div>` : ''}
          <div class="treq">${reqPills(t)}${schedPill(t)}</div>
        </div>
        <div class="tacts">
          <button class="icon-btn" data-move="${t.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up" title="Move up">↑</button>
          <button class="icon-btn" data-move="${t.id}" data-dir="1" ${i === tasks.length - 1 ? 'disabled' : ''} aria-label="Move down" title="Move down">↓</button>
          <button class="btn ghost sm" data-edit="${t.id}">Edit</button>
          <button class="del-btn" data-del="${t.id}" aria-label="Delete task ${i + 1}">Delete</button>
        </div>
      </div>`).join('') || '<div class="empty">No tasks yet. Add one with “+ New task”.</div>'}</div>`);

  $('#newTaskBtn').onclick = () => editTask(null);
  $$('[data-edit]').forEach(b => b.onclick = () => editTask(tasks.find(t => t.id === +b.dataset.edit)));
  $$('[data-move]').forEach(b => b.onclick = async () => {
    try { await api(`/api/admin/tasks/${b.dataset.move}/move`, { method: 'POST', body: JSON.stringify({ dir: +b.dataset.dir }) }); viewTasks(); }
    catch (err) { toast('Error', err.message, 'rejected'); }
  });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    const t = tasks.find(x => x.id === +b.dataset.del);
    if (!await choose(`Delete "${t.title}"?`, 'It disappears from every team\'s task list.', [{ label: 'Delete task', value: true, kind: 'danger' }])) return;
    try { await api('/api/admin/tasks/' + t.id, { method: 'DELETE' }); }
    catch (err) {
      if (!err.needsForce) return toast('Error', err.message, 'rejected');
      if (!await choose('This task has submissions', esc(err.message) + ' Their photos and videos are moved to the Google Drive trash.',
        [{ label: 'Delete task and submissions', value: true, kind: 'danger' }])) return;
      await api('/api/admin/tasks/' + t.id + '?force=1', { method: 'DELETE' });
    }
    toast('Task deleted'); viewTasks();
  });
}

// Task editor (create or edit) with submission requirements and a live player preview.
function editTask(task) {
  const t = task || { title: '', description: '', points: 10, min_photos: 1, min_videos: 0, needs_link: 0, link_label: '', allow_gallery: 0, opens_at: null, closes_at: null };
  const el = document.createElement('div');
  el.className = 'dlg-scrim';
  el.innerHTML = `
    <form class="dlg card tedit" autocomplete="off">
      <div class="tedit-hd"><h3>${task ? 'Edit task' : 'New task'}</h3><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label class="fl">Title<input class="input" name="title" maxlength="120" required value="${esc(t.title)}" placeholder="e.g. Local train selfie"></label>
      <label class="fl">Description / rules<textarea class="input" name="description" maxlength="1000" rows="3" placeholder="What should players do?">${esc(t.description)}</textarea></label>
      <label class="fl pts-f">Points<input class="input" name="points" type="number" min="0" max="10000" value="${t.points}"></label>
      <fieldset class="reqset">
        <legend>What players must submit</legend>
        <div class="stepper"><span>📷 Photos required</span><div><button type="button" data-step="min_photos" data-d="-1">−</button><input name="min_photos" type="number" min="0" max="12" value="${t.min_photos}"><button type="button" data-step="min_photos" data-d="1">+</button></div></div>
        <div class="stepper"><span>🎥 Videos required</span><div><button type="button" data-step="min_videos" data-d="-1">−</button><input name="min_videos" type="number" min="0" max="5" value="${t.min_videos}"><button type="button" data-step="min_videos" data-d="1">+</button></div></div>
        <label class="toggle-row"><span>🔗 Link required</span><span class="switch"><input type="checkbox" name="needs_link" ${t.needs_link ? 'checked' : ''}><span></span></span></label>
        <label class="fl link-label ${t.needs_link ? '' : 'hidden'}">Link label (shown to players)<input class="input" name="link_label" maxlength="60" value="${esc(t.link_label)}" placeholder="e.g. Instagram reel link"></label>
        <label class="toggle-row gallery-row"><span>🖼️ Allow uploads from gallery</span><span class="switch"><input type="checkbox" name="allow_gallery" ${t.allow_gallery ? 'checked' : ''}><span></span></span></label>
      </fieldset>
      <fieldset class="reqset">
        <legend>Schedule <span class="muted small">(optional, IST)</span></legend>
        <label class="toggle-row"><span>🕒 Time window</span><span class="switch"><input type="checkbox" name="scheduled" ${t.opens_at || t.closes_at ? 'checked' : ''}><span></span></span></label>
        <div class="sched-fields ${t.opens_at || t.closes_at ? '' : 'hidden'}">
          <label class="fl">Opens at (IST)<input class="input" type="datetime-local" name="opens" value="${toISTInput(t.opens_at)}"></label>
          <label class="fl">Closes at (IST)<input class="input" type="datetime-local" name="closes" value="${toISTInput(t.closes_at)}"></label>
          <p class="small sched-err hidden"></p>
        </div>
      </fieldset>
      <div class="preview"><span class="muted small">Players will see</span><div id="tprev"></div></div>
      <div class="dlg-actions"><button type="button" class="btn sm ghost" data-close>Cancel</button><button class="btn sm blue">${task ? 'Save changes' : 'Add task'}</button></div>
    </form>`;
  document.body.appendChild(el);
  const f = el.querySelector('form');
  const val = () => {
    const d = Object.fromEntries(new FormData(f));
    const on = f.scheduled.checked;
    return { ...d, points: +d.points || 0, min_photos: Math.max(0, Math.min(12, +d.min_photos || 0)), min_videos: Math.max(0, Math.min(5, +d.min_videos || 0)), needs_link: f.needs_link.checked ? 1 : 0, allow_gallery: f.allow_gallery.checked ? 1 : 0,
      opens_at: on ? fromISTInput(f.opens.value) : null, closes_at: on ? fromISTInput(f.closes.value) : null };
  };
  const preview = () => {
    const v = val();
    f.querySelector('.link-label').classList.toggle('hidden', !v.needs_link);
    f.querySelector('.gallery-row').classList.toggle('hidden', !wantsMedia(v));
    f.querySelector('.sched-fields').classList.toggle('hidden', !f.scheduled.checked);
    const err = v.opens_at && v.closes_at && v.closes_at <= v.opens_at ? 'Closing time must be after the opening time.' : '';
    const errEl = f.querySelector('.sched-err'); errEl.textContent = err; errEl.classList.toggle('hidden', !err);
    f.querySelector('#tprev').innerHTML = `<div class="ttop"><b>${esc(v.title || 'Untitled task')}</b><span class="pill pts">+${v.points}</span></div><div class="treq">${reqPills(v)}${schedPill(v)}</div>`;
  };
  f.oninput = preview;
  // Turning the schedule on pre-fills a sensible window: the next full hour, for one hour.
  f.scheduled.onchange = () => {
    if (f.scheduled.checked && !f.opens.value && !f.closes.value) {
      const start = Math.ceil(Date.now() / 3600000) * 3600000;
      f.opens.value = toISTInput(start); f.closes.value = toISTInput(start + 3600000);
    }
    preview();
  };
  // Closing with unsaved edits asks first: discard, save, or keep editing.
  let saved = '';
  let asking = false;
  const tryClose = async () => {
    if (asking) return;
    if (JSON.stringify(val()) === saved) return el.remove();
    asking = true;
    const pick = await choose('Unsaved changes', `You've made changes to ${task ? 'this task' : 'this new task'} that haven't been saved.`,
      [{ label: 'Discard', value: 'discard', kind: 'danger' }, { label: task ? 'Save changes' : 'Add task', value: 'save', kind: 'primary' }], 'Keep editing');
    asking = false;
    if (pick === 'discard') el.remove();
    else if (pick === 'save') f.requestSubmit();
  };
  f.onclick = e => {
    const st = e.target.closest('[data-step]');
    if (st) { const inp = f[st.dataset.step]; inp.value = Math.max(+inp.min, Math.min(+inp.max, (+inp.value || 0) + +st.dataset.d)); preview(); }
    if (e.target.closest('[data-close]')) tryClose();
  };
  el.onclick = e => { if (e.target === el) tryClose(); };
  f.onsubmit = async e => {
    e.preventDefault();
    const v = val();
    if (!v.title.trim()) return f.title.focus();
    if (v.opens_at && v.closes_at && v.closes_at <= v.opens_at) return f.closes.focus();
    if (f.scheduled.checked && !v.opens_at && !v.closes_at) { toast('Set a time', 'Add an opening or closing time, or switch the schedule off.'); return f.opens.focus(); }
    try {
      await api(task ? '/api/admin/tasks/' + task.id : '/api/admin/tasks', { method: task ? 'PUT' : 'POST', body: JSON.stringify(v) });
      el.remove(); toast(task ? 'Task saved' : 'Task added'); viewTasks();
    } catch (err) { toast('Error', err.message, 'rejected'); }
  };
  preview();
  saved = JSON.stringify(val());
  f.title.focus();
}

// ---------- Admins (reviewer accounts, super admin only) ----------
async function viewAdmins() {
  const [{ admins, superUsername }, { teams }] = await Promise.all([api('/api/admin/admins'), api('/api/admin/teams')]);
  teamsCache = teams;
  const teamName = id => teams.find(t => t.id === id)?.name || '';
  const covered = new Set(admins.flatMap(a => a.teamIds));
  const unassigned = teams.filter(t => !covered.has(t.id));
  paint(`
    <div class="toolbar">
      <h2>Admins</h2>
      <span class="muted small">${admins.length} reviewer${admins.length === 1 ? '' : 's'} · ${unassigned.length ? `${unassigned.length} team${unassigned.length === 1 ? '' : 's'} without a reviewer` : 'every team has a reviewer'}</span>
      <button class="btn blue sm" id="newAdminBtn">+ New admin</button>
    </div>
    <p class="muted small" style="margin:-6px 0 14px">Admins log in at <b>${esc(location.origin)}/admin</b> with the username and password you set. They only see their assigned teams and can approve or reject submissions. You (<b>${esc(superUsername)}</b>) can do everything.</p>
    <div class="alist">${admins.map(a => `
      <div class="card aitem">
        <div class="who">
          <div class="ttop"><b>${esc(a.name)}</b><span class="uname">@${esc(a.username)}</span></div>
          <div class="chips">${a.teamIds.length ? a.teamIds.map(id => `<span class="req-pill">${esc(teamName(id))}</span>`).join('') : '<span class="req-pill any">No teams assigned</span>'}</div>
        </div>
        <div class="tacts">
          <button class="btn ghost sm" data-edit-admin="${a.id}">Edit</button>
          <button class="del-btn" data-del-admin="${a.id}">Delete</button>
        </div>
      </div>`).join('') || '<div class="empty">No admins yet. Add one with “+ New admin” and assign their teams.</div>'}</div>`);
  $('#newAdminBtn').onclick = () => editAdmin(null, admins, teams);
  $$('[data-edit-admin]').forEach(b => b.onclick = () => editAdmin(admins.find(a => a.id === +b.dataset.editAdmin), admins, teams));
  $$('[data-del-admin]').forEach(b => b.onclick = async () => {
    const a = admins.find(x => x.id === +b.dataset.delAdmin);
    if (!await choose(`Delete ${a.name}?`, `<b>@${esc(a.username)}</b> is signed out and can no longer log in. Reviews they already made stay.`,
      [{ label: 'Delete admin', value: true, kind: 'danger' }])) return;
    try { await api('/api/admin/admins/' + a.id, { method: 'DELETE' }); toast(`${a.name} deleted`); viewAdmins(); }
    catch (err) { toast('Error', err.message, 'rejected'); }
  });
}

const randomPassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(10));
  return [...b].map(x => chars[x % chars.length]).join('');
};

function editAdmin(admin, admins, teams) {
  const a = admin || { name: '', username: '', teamIds: [] };
  const others = {}; // team id -> other reviewers' names
  admins.filter(x => x.id !== a.id).forEach(x => x.teamIds.forEach(t => (others[t] ||= []).push(x.name)));
  const el = document.createElement('div');
  el.className = 'dlg-scrim';
  el.innerHTML = `
    <form class="dlg card tedit" autocomplete="off">
      <div class="tedit-hd"><h3>${admin ? 'Edit admin' : 'New admin'}</h3><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label class="fl">Name<input class="input" name="name" maxlength="60" required value="${esc(a.name)}" placeholder="e.g. Priya"></label>
      <label class="fl">Username<input class="input" name="username" maxlength="40" required value="${esc(a.username)}" placeholder="e.g. priya" autocapitalize="none" spellcheck="false"></label>
      <label class="fl">${admin ? 'New password <span class="muted small">(leave empty to keep the current one)</span>' : 'Password'}
        <span class="pw-row"><input class="input" name="password" type="text" minlength="6" ${admin ? '' : 'required'} placeholder="${admin ? 'Unchanged' : 'At least 6 characters'}" autocomplete="new-password" spellcheck="false"><button type="button" class="btn ghost sm" data-gen>Generate</button></span>
      </label>
      <fieldset class="reqset">
        <legend>Teams to review</legend>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <button type="button" class="btn ghost sm" data-pick="all">Select all</button>
          <button type="button" class="btn ghost sm" data-pick="free">Select teams without a reviewer</button>
          <button type="button" class="btn ghost sm" data-pick="none">Clear</button>
        </div>
        <div class="teampick">${teams.map(t => `<label class="${others[t.id] ? 'taken' : ''}" title="${others[t.id] ? 'Also reviewed by ' + esc(others[t.id].join(', ')) : ''}">
          <input type="checkbox" name="team" value="${t.id}" ${a.teamIds.includes(t.id) ? 'checked' : ''}><span>${esc(t.name)}${others[t.id] ? ` · ${esc(others[t.id].join(', '))}` : ''}</span></label>`).join('')}</div>
        <p class="muted small hint" id="pickCount"></p>
      </fieldset>
      ${admin ? '<p class="muted small hint">Changing the password signs this admin out on every device.</p>' : ''}
      <div class="dlg-actions"><button type="button" class="btn sm ghost" data-close>Cancel</button><button class="btn sm blue">${admin ? 'Save changes' : 'Create admin'}</button></div>
    </form>`;
  document.body.appendChild(el);
  const f = el.querySelector('form');
  const boxes = [...f.querySelectorAll('input[name=team]')];
  const count = () => { const n = boxes.filter(b => b.checked).length; f.querySelector('#pickCount').textContent = `${n} team${n === 1 ? '' : 's'} selected`; };
  f.onchange = count;
  f.onclick = e => {
    if (e.target.closest('[data-close]')) return el.remove();
    if (e.target.closest('[data-gen]')) { f.password.value = randomPassword(); return; }
    const pick = e.target.closest('[data-pick]')?.dataset.pick;
    if (pick) { boxes.forEach(b => (b.checked = pick === 'all' || (pick === 'free' && (b.checked || !others[b.value])))); count(); }
  };
  el.onclick = e => { if (e.target === el) el.remove(); };
  f.onsubmit = async e => {
    e.preventDefault();
    const body = { name: f.elements.namedItem("name").value, username: f.username.value, password: f.password.value, teamIds: boxes.filter(b => b.checked).map(b => +b.value) };
    try {
      await api(admin ? '/api/admin/admins/' + admin.id : '/api/admin/admins', { method: admin ? 'PUT' : 'POST', body: JSON.stringify(body) });
      el.remove();
      const login = body.password ? `Username: ${body.username.trim().toLowerCase()} · Password: ${body.password}` : '';
      toast(admin ? 'Admin saved' : 'Admin created', login ? login + ' (share these with them)' : '', 'approved');
      if (login) try { await navigator.clipboard.writeText(`${location.origin}/admin\nUsername: ${body.username.trim().toLowerCase()}\nPassword: ${body.password}`); toast('Login details copied', 'Paste them to the admin.'); } catch {}
      viewAdmins();
    } catch (err) { toast('Error', err.message, 'rejected'); }
  };
  count();
  f.elements.namedItem("name").focus();
}

// ---------- Settings ----------
function driveCard(d) {
  const head = (pill, cls) => `<span class="pill ${cls}">${pill}</span>`;
  if (d.mode === 'off') return `
    <div class="card setting"><div><b>Google Drive</b>
      <div class="muted small">Not set up. Photos and videos are stored on this server. See DRIVE_SETUP.md.</div></div>
      ${head('Off', 'st-todo')}</div>`;
  if (d.mode === 'oauth' && (!d.enabled || d.needsReconnect)) return `
    <div class="card setting" style="align-items:flex-start"><div style="display:grid; gap:8px">
      <b>Google Drive</b>
      <div class="muted small">${d.needsReconnect ? 'Google access was revoked or expired. Reconnect to resume uploads (nothing is lost; files wait on the server).' : `Connect the Google account whose Drive should store submissions. The app creates its own folder and can only see files it creates.`}</div>
      ${d.waiting ? `<div class="small"><span class="pill st-pending">${d.waiting} file${d.waiting > 1 ? 's' : ''} waiting</span></div>` : ''}
      <div class="acts"><button class="btn blue sm" id="driveConnect">${d.needsReconnect ? 'Reconnect' : 'Connect'} Google Drive</button></div>
    </div>${head(d.needsReconnect ? 'Reconnect' : 'Not connected', 'st-rejected')}</div>`;
  const ok = d.connected && !d.lastError;
  return `
    <div class="card setting" style="align-items:flex-start"><div style="display:grid; gap:8px">
      <b>Google Drive</b>
      <div class="muted small">Saving to “${esc(d.folderName || 'Drive folder')}” as ${esc(d.account)}</div>
      <div class="stats">
        <span class="pill st-approved">${d.synced} in Drive</span>
        <span class="pill st-pending">${d.waiting} waiting</span>
        ${d.failed ? `<span class="pill st-rejected">${d.failed} failed</span>` : ''}
      </div>
      ${d.lastError ? `<div class="small" style="color:var(--maroon)">Last error: ${esc(d.lastError)}</div>` : ''}
      <div class="acts" style="flex-wrap:wrap">
        <a class="btn sm" href="${esc(d.folderUrl)}" target="_blank" rel="noopener">Open Drive folder</a>
        ${d.failed || d.lastError ? `<button class="btn ghost sm" id="driveRetry">Retry now</button>` : ''}
        ${d.mode === 'oauth' ? `<button class="btn ghost sm" id="driveDisconnect">Disconnect</button>` : ''}
      </div>
    </div>${head(ok ? 'Connected' : 'Problem', ok ? 'st-approved' : 'st-rejected')}</div>`;
}

async function viewSettings() {
  if (!isSuper()) {
    paint(`
      <div style="display:grid; gap:12px; max-width:720px">
        <h2 style="font-size:28px">Settings</h2>
        <div class="card setting"><div><b>${esc(me.name)}</b><div class="muted small">Signed in as ${esc(me.username)} · reviewing ${me.teamIds.length} team${me.teamIds.length === 1 ? '' : 's'}</div></div></div>
        <label class="card setting"><div><b>Sound on new submissions</b><div class="muted small">Plays a chime when one of your teams sends something.</div></div><span class="switch"><input type="checkbox" id="setSound" ${store.get('mm_sound') !== '0' ? 'checked' : ''}><span></span></span></label>
        <button class="btn ghost" id="logoutBtn" style="justify-self:start">Log out</button>
      </div>`);
    $('#setSound').onchange = e => store.set('mm_sound', e.target.checked ? '1' : '0');
    $('#logoutBtn').onclick = logout;
    return;
  }
  const [s, d] = await Promise.all([loadSummary(), api('/api/admin/drive')]);
  paint(`
    <div style="display:grid; gap:12px; max-width:720px">
      <h2 style="font-size:28px">Settings</h2>
      <label class="card setting"><div><b>Show leaderboard to teams</b><div class="muted small">Teams see a live "Board" tab with all scores.</div></div><span class="switch"><input type="checkbox" id="setBoard" ${s.showLeaderboard ? 'checked' : ''}><span></span></span></label>
      <label class="card setting"><div><b>Accept submissions</b><div class="muted small">Turn off when time's up. Teams can still see their results.</div></div><span class="switch"><input type="checkbox" id="setOpen" ${s.submissionsOpen ? 'checked' : ''}><span></span></span></label>
      <label class="card setting"><div><b>Sound on new submissions</b><div class="muted small">Plays a chime when a team sends something.</div></div><span class="switch"><input type="checkbox" id="setSound" ${store.get('mm_sound') !== '0' ? 'checked' : ''}><span></span></span></label>
      ${driveCard(d)}
      <div class="card setting"><div><b>Export</b><div class="muted small">All submissions and review decisions as CSV.</div></div><button class="btn sm" id="exportBtn">Download CSV</button></div>
      <button class="btn ghost" id="logoutBtn" style="justify-self:start">Log out</button>
    </div>`);
  const save = body => api('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) }).then(() => toast('Saved'));
  $('#setBoard').onchange = e => save({ showLeaderboard: e.target.checked });
  $('#setOpen').onchange = e => save({ submissionsOpen: e.target.checked });
  $('#setSound').onchange = e => store.set('mm_sound', e.target.checked ? '1' : '0');
  $('#logoutBtn').onclick = logout;
  $('#driveConnect') && ($('#driveConnect').onclick = async () => {
    try { const { url } = await api('/api/admin/drive/connect', { method: 'POST' }); location.href = url; }
    catch (err) { toast('Error', err.message, 'rejected'); }
  });
  $('#driveDisconnect') && ($('#driveDisconnect').onclick = async () => {
    if (!await choose('Disconnect Google Drive?', 'Files already in Drive stay there, but the dashboard can\'t show them until you reconnect. New uploads wait safely on the server.',
      [{ label: 'Disconnect', value: true, kind: 'danger' }])) return;
    await api('/api/admin/drive/disconnect', { method: 'POST' }); viewSettings();
  });
  $('#driveRetry') && ($('#driveRetry').onclick = async () => { await api('/api/admin/drive/retry', { method: 'POST' }); toast('Retrying Drive uploads'); viewSettings(); });
  $('#exportBtn').onclick = async () => {
    const r = await fetch('/api/admin/export.csv', { headers: { Authorization: 'Bearer ' + token } });
    const url = URL.createObjectURL(await r.blob());
    Object.assign(document.createElement('a'), { href: url, download: 'mumbai-maxxing-submissions.csv' }).click();
    URL.revokeObjectURL(url);
  };
}

// ---------- Review actions + lightbox (delegated) ----------
document.addEventListener('input', e => { if (e.target.dataset.c) drafts[e.target.dataset.c] = e.target.value; });
document.addEventListener('click', async e => {
  const delFile = e.target.closest('[data-del-file]');
  if (delFile) {
    e.stopPropagation();
    const card = delFile.closest('.sub');
    const last = card && card.querySelectorAll('[data-del-file]').length === 1;
    const ok = await choose('Delete this file?',
      last ? "It's the only file in this submission, so <b>the whole submission will be deleted</b> (and any points it earned)." : 'The photo or video is removed from the dashboard and moved to the Google Drive trash. The rest of the submission stays.',
      [{ label: last ? 'Delete submission' : 'Delete file', value: true, kind: 'danger' }]);
    if (!ok) return;
    try { await api('/api/admin/media/' + delFile.dataset.delFile, { method: 'DELETE' }); toast(last ? 'Submission deleted' : 'File deleted'); render(); }
    catch (err) { toast('Error', err.message, 'rejected'); }
    return;
  }
  const delSub = e.target.closest('[data-del-sub]');
  if (delSub) {
    const n = +delSub.dataset.files, approved = delSub.dataset.status === 'approved';
    const ok = await choose('Delete this submission?',
      `This deletes the submission and its <b>${n} file${n === 1 ? '' : 's'}</b> (moved to the Google Drive trash).` + (approved ? ` It was approved, so the team <b>loses ${esc(delSub.dataset.pts)} points</b>.` : '') + ' The team can submit this task again.',
      [{ label: 'Delete submission', value: true, kind: 'danger' }]);
    if (!ok) return;
    try { await api('/api/admin/submissions/' + delSub.dataset.delSub, { method: 'DELETE' }); delete drafts[delSub.dataset.delSub]; toast('Submission deleted'); render(); }
    catch (err) { toast('Error', err.message, 'rejected'); }
    return;
  }
  const v = e.target.closest('[data-view]');
  if (v) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    let cap = {};
    try { cap = JSON.parse(v.dataset.cap || '{}'); } catch {}
    const info = [
      cap.g ? '<span>🖼️ Uploaded from the phone gallery (not captured live)</span>' : '',
      cap.t ? `<span>🕒 ${cap.g ? 'File date' : 'Taken'} ${fmtDateTime(cap.t)}</span>` : '<span>🕒 Capture time unknown</span>',
      cap.lat != null
        ? `<span>📍 ${coords(cap)} · ±${Math.round(cap.acc || 0)} m · <a href="${mapsUrl(cap)}" target="_blank" rel="noopener">Open in Google Maps</a></span>`
        : '<span>📍 No location shared</span>',
      cap.u ? `<span class="muted">Uploaded ${fmtDateTime(cap.u)}</span>` : '',
    ].join('');
    lb.innerHTML = `<div class="lb-cap">${info}</div>` + (v.dataset.kind === 'video' ? `<video src="${esc(v.dataset.view)}" controls autoplay playsinline></video>` : `<img src="${esc(v.dataset.view)}" alt="">`)
      + `<div class="close" style="display:flex; gap:8px">${v.dataset.drive ? `<a class="btn sm" style="background:var(--white); color:var(--ink)" href="${esc(v.dataset.drive)}" target="_blank" rel="noopener">Open in Drive</a>` : ''}<a class="btn sm lime" href="${esc(v.dataset.view)}" download>Download</a><button class="btn sm">Close</button></div>`;
    lb.onclick = ev => { if (ev.target === lb || ev.target.tagName === 'BUTTON') lb.remove(); };
    lb.style.gridTemplateRows = 'auto 1fr';
    document.body.appendChild(lb);
    return;
  }
  const ch = e.target.closest('[data-change]');
  if (ch) {
    const card = $('#sub-' + ch.dataset.change);
    card.querySelector('.rv').classList.remove('hidden');
    drafts[ch.dataset.change] = $('#c-' + ch.dataset.change).value;
    ch.remove();
    return;
  }
  const rb = e.target.closest('[data-review]');
  if (rb) {
    const id = rb.dataset.id, status = rb.dataset.review;
    const comment = $('#c-' + id).value.trim();
    if (status === 'rejected' && !comment) { $('#c-' + id).focus(); return toast('Add a comment', 'Tell the team why it was rejected.'); }
    rb.disabled = true;
    try {
      await api(`/api/admin/submissions/${id}/review`, { method: 'POST', body: JSON.stringify({ status, comment }) });
      delete drafts[id];
      toast(status === 'approved' ? 'Approved ✓' : 'Rejected', 'The team has been notified.', status);
      render();
    } catch (err) { toast('Error', err.message, 'rejected'); rb.disabled = false; }
  }
});

// ---------- Realtime ----------
let audioCtx;
function chime() {
  if (store.get('mm_sound') === '0') return;
  try {
    audioCtx ||= new AudioContext();
    [660, 990].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t); o.stop(t + 0.32);
    });
  } catch {}
}
// Re-render only views affected by an event; never the tasks editor or settings (would drop unsaved edits).
function liveRefresh(teamId) {
  if (route.name === 'team') { if (route.id === teamId) render(); else loadSummary(); }
  else if (['teams', 'queue', 'board'].includes(route.name)) render();
  else loadSummary();
}
function connect() {
  es?.close();
  es = new EventSource('/api/admin/events?token=' + encodeURIComponent(token));
  es.onopen = () => $('#live').classList.add('on');
  es.onerror = () => $('#live').classList.remove('on');
  es.addEventListener('submission', ev => {
    const d = JSON.parse(ev.data);
    chime();
    const t = teamsCache.find(x => x.id === d.teamId);
    toast('New submission', `${t ? t.name : 'A team'} just sent a task for review.`);
    liveRefresh(d.teamId);
  });
  es.addEventListener('reviewed', ev => liveRefresh(JSON.parse(ev.data).teamId));
  es.addEventListener('teams', async () => {
    if (!isSuper()) { // the super admin may have changed this reviewer's teams
      try { me = await api('/api/admin/me'); } catch { return; }
      teamsCache = [];
      if (route.name === 'team' && !me.teamIds.includes(route.id)) { location.hash = '#/teams'; return; }
      if (['teams', 'queue', 'board', 'settings'].includes(route.name)) render();
      return;
    }
    if (route.name === 'teams') render();
  });
  es.addEventListener('signout', () => { logout(); $('#loginErr').textContent = 'You were signed out. Log in again with your new password.'; });
  es.addEventListener('drive', () => route.name === 'settings' && render());
}

// Result of the Google Drive connect redirect (/admin?drive=connected#/settings).
const driveResult = new URLSearchParams(location.search).get('drive');
if (driveResult) {
  history.replaceState(null, '', '/admin' + location.hash);
  setTimeout(() => driveResult === 'connected'
    ? toast('Google Drive connected ✓', 'New submissions will be saved to your Drive.', 'approved')
    : toast('Google Drive not connected', driveResult.replace(/^error:/, ''), 'rejected'), 300);
}

async function boot() {
  if (!token) { $('#login').classList.remove('hidden'); return; }
  try { me = await api('/api/admin/me'); await loadSummary(); } catch { return; }
  document.body.classList.toggle('reviewer', !me.super);
  $('#roleLabel').textContent = me.super ? 'Super admin' : `Reviewer · ${me.name}`;
  $('#login').classList.add('hidden');
  $('#dash').classList.remove('hidden');
  connect();
  route = parseRoute();
  render();
}
boot();

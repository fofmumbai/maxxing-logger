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
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    token = d.token; store.set('mm_admin', token);
    boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
function logout() {
  token = null; store.del('mm_admin'); es?.close();
  $('#dash').classList.add('hidden'); $('#login').classList.remove('hidden');
}

// ---------- Router ----------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  if (name === 'team' && id) return { name: 'team', id: +id };
  return { name: ['teams', 'queue', 'board', 'tasks', 'settings'].includes(name) ? name : 'teams' };
}
window.addEventListener('hashchange', () => { route = parseRoute(); window.scrollTo(0, 0); render(); });
function render() {
  const tab = route.name === 'team' ? 'teams' : route.name;
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  ({ teams: viewTeams, team: () => viewTeam(route.id), queue: viewQueue, board: viewBoard, tasks: viewTasks, settings: viewSettings })[route.name]()
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
function choose(title, body, options) {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'dlg-scrim';
    el.innerHTML = `<div class="dlg card" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><p>${body}</p>
      <div class="dlg-actions">${options.map((o, i) => `<button class="btn sm ${o.kind === 'danger' ? 'coral' : o.kind === 'primary' ? '' : 'ghost'}" data-i="${i}">${esc(o.label)}</button>`).join('')}
      <button class="btn sm ghost" data-i="-1">Cancel</button></div></div>`;
    const done = v => { el.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(null); };
    el.onclick = e => { const b = e.target.closest('[data-i]'); if (b) done(+b.dataset.i < 0 ? null : options[+b.dataset.i].value); else if (e.target === el) done(null); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(el);
    el.querySelector('[data-i="-1"]').focus();
  });
}

function mediaTile(m) {
  return `<div class="m" data-view="${esc(m.url)}" data-kind="${m.kind}" data-drive="${esc(m.driveUrl || '')}" title="${fmtSize(m.size)}">
    <button class="del-file" data-del-file="${m.id}" aria-label="Delete this ${m.kind === 'video' ? 'video' : 'photo'}" title="Delete this file">${ICON_TRASH}</button>
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
      ${s.note ? `<div class="note"><b>Team note:</b> ${esc(s.note)}</div>` : ''}
      ${!pending ? `<div class="reviewed ${s.status}"><b>${s.status === 'approved' ? 'Approved' : 'Rejected'}</b> ${ago(s.reviewed_at)}${s.comment ? ` · “${esc(s.comment)}”` : ''}</div>` : ''}
      <div class="rv ${pending || drafts[s.id] !== undefined ? '' : 'hidden'}" style="display:grid; gap:8px">
        <textarea class="input" id="c-${s.id}" data-c="${s.id}" placeholder="Comment for the team (required to reject)" rows="2">${esc(drafts[s.id] ?? (pending ? '' : s.comment))}</textarea>
        <div class="actions">
          <button class="btn coral" data-review="rejected" data-id="${s.id}">Reject</button>
          <button class="btn green" data-review="approved" data-id="${s.id}">Approve</button>
        </div>
      </div>
      <div class="sub-foot">
        ${!pending && drafts[s.id] === undefined ? `<button class="btn ghost sm" data-change="${s.id}">Change decision</button>` : '<span></span>'}
        <button class="del-btn" data-del-sub="${s.id}" data-files="${s.media.length}" data-status="${s.status}" data-pts="${s.points ?? ''}">Delete submission</button>
      </div>
    </article>`;
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
      <button class="btn ghost sm" id="addTeam">+ Add team</button>
      <button class="btn sm" id="printCodes">Print room codes</button>
    </div>
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
        </div>
        <div class="foot">
          <div class="avs">${t.members.map((m, i) => avatar(m.name, i)).join('')}${Array.from({ length: Math.max(0, d.maxMembers - t.members.length) }, () => '<span class="av av-empty">+</span>').join('')}</div>
          <span class="muted small">${t.members.length}/${d.maxMembers} joined</span>
        </div>
      </a>`).join('')}
    </div>`);
  $('#teamSort').onchange = e => { teamSort = e.target.value; store.set('mm_sort', teamSort); viewTeams(); };
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
        <input class="namefield" id="teamName" value="${esc(team.name)}" maxlength="40" aria-label="Team name">
        <div class="codebig">
          <span class="muted small">ROOM CODE</span><b>${esc(team.code)}</b>
          <button class="btn ghost sm" id="copyLink">Copy join link</button>
          <button class="btn ghost sm" id="newCode">New code</button>
        </div>
        <div>
          <div class="muted small" style="margin-bottom:6px">MEMBERS · ${members.length}/${maxMembers}</div>
          ${members.map((m, i) => `<span class="mchip">${avatar(m.name, i)}${esc(m.name)}<button class="kick" data-kick="${m.id}" data-name="${esc(m.name)}" data-subs="${submissions.filter(x => x.member_id === m.id).length}">Remove</button></span>`).join('') || '<span class="muted">No one has joined yet.</span>'}
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

  $('#teamName').onchange = async e => {
    try { await api('/api/admin/teams/' + id, { method: 'PATCH', body: JSON.stringify({ name: e.target.value }) }); toast('Team renamed'); }
    catch (err) { toast('Error', err.message, 'rejected'); }
  };
  $('#copyLink').onclick = async () => {
    const link = `${location.origin}/?code=${team.code}`;
    try { await navigator.clipboard.writeText(link); toast('Copied', link); } catch { prompt('Join link', link); }
  };
  $('#newCode').onclick = async () => {
    if (!confirm('Generate a new room code? The old code stops working for new joins (members already in stay in).')) return;
    await api(`/api/admin/teams/${id}/new-code`, { method: 'POST' }); viewTeam(id);
  };
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
  $$('#ttFilter [data-f]').forEach(b => b.onclick = () => { teamTaskFilter = b.dataset.f; viewTeam(id); });
  $$('[data-toggle]').forEach(b => b.onclick = () => {
    const row = rows.find(r => `${id}:${r.t.id}` === b.dataset.toggle);
    openRows[b.dataset.toggle] = !(openRows[b.dataset.toggle] ?? row.status === 'pending');
    viewTeam(id);
  });
  $('#expandAll').onclick = () => { visible.forEach(r => (openRows[`${id}:${r.t.id}`] = true)); viewTeam(id); };
  $('#collapseAll').onclick = () => { visible.forEach(r => (openRows[`${id}:${r.t.id}`] = false)); viewTeam(id); };
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
    ${queueStatus === 'pending' ? '<p class="muted small" style="margin:-6px 0 14px">Oldest first, across all teams.</p>' : ''}
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
      <a class="lbrow" href="#/team/${r.id}" style="${i ? 'border-top:1px solid var(--line)' : ''}"><span class="rank">${i + 1}</span><span class="name">${esc(r.name)}</span>
      <span class="muted small">${r.approved} approved · ${r.pending} to review</span><span class="pill pts" style="font-size:16px">${r.points}</span></a>`).join('')}</div>`);
}

// ---------- Tasks editor ----------
async function viewTasks() {
  const tasks = tasksCache = await api('/api/admin/tasks');
  paint(`
    <div class="toolbar"><h2>Tasks</h2><span class="muted small">${tasks.length} tasks · ${tasks.reduce((a, t) => a + t.points, 0)} points available</span></div>
    <form id="newTask" class="card taskrow" style="margin-bottom:16px; border:0">
      <b>+</b>
      <input class="input" name="title" placeholder="New task title" required>
      <input class="input desc" name="description" placeholder="Description / rules">
      <input class="input" name="points" type="number" min="0" value="10" placeholder="Pts">
      <div class="acts"><button class="btn blue sm">Add</button></div>
    </form>
    <div class="card" id="taskRows">${tasks.map((t, i) => `
      <form class="taskrow" data-task="${t.id}">
        <b class="muted">${i + 1}</b>
        <input class="input" name="title" value="${esc(t.title)}" required>
        <input class="input desc" name="description" value="${esc(t.description)}" placeholder="Description">
        <input class="input" name="points" type="number" min="0" value="${t.points}">
        <div class="acts"><button class="btn blue sm save">Save</button><button type="button" class="del-btn" data-del="${t.id}" aria-label="Delete task ${i + 1}">Delete</button></div>
      </form>`).join('')}</div>`);
  const fd = f => Object.fromEntries(new FormData(f));
  // Save only appears on rows that were edited.
  $('#taskRows').oninput = e => e.target.form?.classList.add('dirty');
  $('#taskRows').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/admin/tasks/' + e.target.dataset.task, { method: 'PUT', body: JSON.stringify(fd(e.target)) }); toast('Task saved'); viewTasks(); }
    catch (err) { toast('Error', err.message, 'rejected'); }
  };
  $('#taskRows').onclick = async e => {
    const id = e.target.dataset.del;
    if (!id || !confirm('Delete this task?')) return;
    try { await api('/api/admin/tasks/' + id, { method: 'DELETE' }); }
    catch (err) {
      if (!err.needsForce || !confirm(err.message + ' Delete anyway?')) return;
      await api('/api/admin/tasks/' + id + '?force=1', { method: 'DELETE' });
    }
    viewTasks();
  };
  $('#newTask').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/admin/tasks', { method: 'POST', body: JSON.stringify(fd(e.target)) }); toast('Task added'); viewTasks(); }
    catch (err) { toast('Error', err.message, 'rejected'); }
  };
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
    if (!confirm('Disconnect Google Drive? Files already in Drive stay there, but the dashboard can no longer show them until you reconnect. New uploads wait on the server.')) return;
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
    lb.innerHTML = (v.dataset.kind === 'video' ? `<video src="${esc(v.dataset.view)}" controls autoplay playsinline></video>` : `<img src="${esc(v.dataset.view)}" alt="">`)
      + `<div class="close" style="display:flex; gap:8px">${v.dataset.drive ? `<a class="btn sm" style="background:var(--white); color:var(--ink)" href="${esc(v.dataset.drive)}" target="_blank" rel="noopener">Open in Drive</a>` : ''}<a class="btn sm lime" href="${esc(v.dataset.view)}" download>Download</a><button class="btn sm">Close</button></div>`;
    lb.onclick = ev => { if (ev.target === lb || ev.target.tagName === 'BUTTON') lb.remove(); };
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
  es.addEventListener('teams', () => route.name === 'teams' && render());
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
  try { await loadSummary(); } catch { return; }
  $('#login').classList.add('hidden');
  $('#dash').classList.remove('hidden');
  connect();
  route = parseRoute();
  render();
}
boot();

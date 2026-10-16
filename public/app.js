/* OpsBoard frontend — no build step.
   State model: ONE `state` object, render functions per region, server is the source of truth.
   - Lists are server-paginated (keyset cursor) and server-filtered; the browser never holds the dataset.
   - Optimistic UI only for claim + comment; both reconcile with the server's decision (rollback on 409/failure).
   - Every mutation carries an Idempotency-Key, reused on automatic retry after a network error.
   - Item mutations send the `version` the user saw; a 409 shows the server's current state instead of overwriting. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());
const PRIO = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const LABEL = { open: 'Open', in_progress: 'In progress', pending_approval: 'Pending approval', resolved: 'Resolved', closed: 'Closed' };
const DASH = [['', 'All work', ''], ['mine', 'My active work', ''], ['approvals', 'Awaiting my approval', 'hot'], ['unassigned_urgent', 'Unassigned & urgent', 'hot'], ['overdue', 'Overdue', 'hot'], ['stale', 'Stale (48h+ quiet)', '']];

const state = { token: localStorage.getItem('token'), user: null, teams: [], dash: {}, f: { q: '', team: '', status: '', priority: '', assignee: '', view: '' },
  items: [], cursor: null, loading: false, newCount: 0, selId: null, detail: null, events: [], evMore: null, members: {}, editing: null, conflict: null, stale: false, draft: '', notifs: { unread: 0, notifications: [] } };

class ApiError extends Error { constructor(status, e) { super(e?.message || 'Request failed'); this.status = status; this.code = e?.code; this.current = e?.current; } }
async function api(method, path, body, key) {
  const go = async () => {
    const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) { logout(); throw new ApiError(401, data.error); }
    if (!res.ok) throw new ApiError(res.status, data.error);
    return data;
  };
  try { return await go(); } catch (e) {
    if (e instanceof ApiError || !key) throw e;       // network failure on a mutation: safe to retry ONLY because of the idempotency key
    await new Promise((r) => setTimeout(r, 600)); return go();
  }
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4500); }
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? ((s / 60) | 0) + 'm ago' : s < 86400 ? ((s / 3600) | 0) + 'h ago' : ((s / 86400) | 0) + 'd ago'; };
const myRole = (teamId) => state.teams.find((t) => t.team_id === teamId)?.role;

// ---------- auth ----------
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  try { const r = await api('POST', '/login', { email: f.get('email'), password: f.get('password') }); state.token = r.token; localStorage.setItem('token', r.token); boot(); }
  catch (er) { $('#loginErr').textContent = er.message; }
};
function logout() { localStorage.removeItem('token'); state.token = null; es?.close(); $('#app').hidden = true; $('#login').hidden = false; }
$('#logout').onclick = logout;

async function boot() {
  if (!state.token) { $('#login').hidden = false; return; }
  try {
    const me = await api('GET', '/me'); state.user = me.user; state.teams = me.teams;
  } catch { return; }
  $('#login').hidden = true; $('#app').hidden = false; $('#me').textContent = state.user.name;
  $('#fTeam').innerHTML = '<option value="">All my teams</option>' + state.teams.map((t) => `<option value="${t.team_id}">${esc(t.name)} (${t.role})</option>`).join('');
  await Promise.all([loadDash(), loadList(true), loadNotifs()]); connect();
}

// ---------- dashboard / list ----------
async function loadDash() { state.dash = await api('GET', '/dashboard'); renderDash(); }
function renderDash() {
  $('#dash').innerHTML = DASH.map(([k, label, hot]) => `<div class="stat ${state.f.view === k ? 'active' : ''} ${hot && state.dash[k] ? 'hot' : ''}" data-view="${k}"><span>${label}</span>${k ? `<b>${state.dash[k] ?? 0}</b>` : ''}</div>`).join('');
}
$('#dash').onclick = (e) => { const el = e.target.closest('[data-view]'); if (!el) return; state.f.view = el.dataset.view; loadList(true); renderDash(); };

function query(cursor) {
  const p = new URLSearchParams(); for (const [k, v] of Object.entries(state.f)) if (v) p.set(k, v);
  if (cursor) p.set('cursor', cursor); p.set('limit', 30); return p.toString();
}
let listSeq = 0;
async function loadList(reset) {
  const seq = ++listSeq;                    // ignore out-of-order responses (fast typing in search)
  if (reset) { state.cursor = null; state.newCount = 0; }
  state.loading = true; renderList();
  try {
    const r = await api('GET', '/items?' + query(reset ? null : state.cursor));
    if (seq !== listSeq) return;
    state.items = reset ? r.items : [...state.items, ...r.items]; state.cursor = r.nextCursor;
  } catch (e) { toast(e.message); } finally { if (seq === listSeq) { state.loading = false; renderList(); } }
}
function renderList() {
  const b = $('#banner'); b.hidden = !state.newCount;
  b.innerHTML = state.newCount ? `<span>${state.newCount} update(s) elsewhere.</span><button data-act="refresh">Refresh list</button>` : '';
  $('#list').innerHTML = (state.items.length ? state.items.map((i) => `
    <div class="row ${i.id === state.selId ? 'sel' : ''}" data-id="${i.id}">
      <span class="pill p${i.priority}">${PRIO[i.priority]}</span>
      <div><div class="t">${esc(i.title)}</div><div class="s">#${i.id} · ${esc(i.team_name)} · ${i.assignee_name ? esc(i.assignee_name) : '<i>unassigned</i>'}${i.due_at && i.due_at < Date.now() && !['resolved', 'closed'].includes(i.status) ? ' · <b style="color:var(--red)">overdue</b>' : ''} · ${ago(i.updated_at)}</div></div>
      <span class="pill st-${i.status}">${LABEL[i.status]}</span></div>`).join('') : (state.loading ? '' : '<p class="muted">Nothing matches.</p>'))
    + (state.loading ? '<p class="muted">Loading…</p>' : '') + (state.cursor && !state.loading ? '<button data-act="more">Load more</button>' : '');
}
$('#list').onclick = (e) => { const r = e.target.closest('.row'); if (r) select(+r.dataset.id); if (e.target.dataset.act === 'more') loadList(false); };
$('#banner').onclick = (e) => { if (e.target.dataset.act === 'refresh') { loadList(true); loadDash(); } };
let qT; $('#q').oninput = (e) => { clearTimeout(qT); qT = setTimeout(() => { state.f.q = e.target.value; loadList(true); }, 250); };
for (const [id, k] of [['#fTeam', 'team'], ['#fStatus', 'status'], ['#fPrio', 'priority'], ['#fAssignee', 'assignee']]) $(id).onchange = (e) => { state.f[k] = e.target.value; loadList(true); };
$('#clear').onclick = () => { Object.keys(state.f).forEach((k) => (state.f[k] = '')); ['#q', '#fTeam', '#fStatus', '#fPrio', '#fAssignee'].forEach((s) => ($(s).value = '')); renderDash(); loadList(true); };

// ---------- detail ----------
async function select(id) {
  if (state.editing && !confirm('Discard your unsaved edit?')) return;
  state.selId = id; state.editing = null; state.conflict = null; state.stale = false; state.draft = ''; renderList();
  await reloadDetail();
}
async function reloadDetail() {
  if (!state.selId) return;
  try {
    const [d, ev] = await Promise.all([api('GET', `/items/${state.selId}`), api('GET', `/items/${state.selId}/events?limit=30`)]);
    state.detail = d; state.events = ev.events; state.evMore = ev.nextBefore; state.stale = false; setListItem(d); renderDetail();
  } catch (e) { toast(e.message); state.detail = null; $('#detail').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function setListItem(d) { const i = state.items.findIndex((x) => x.id === d.id); if (i > -1) { const { allowed, ...row } = d; state.items[i] = row; renderList(); } }
async function ensureMembers(teamId) { if (!state.members[teamId]) state.members[teamId] = (await api('GET', `/teams/${teamId}/members`)).members.filter((m) => m.role !== 'viewer'); return state.members[teamId]; }

const TR = { 'open>in_progress': 'Start work', 'in_progress>pending_approval': 'Request approval', 'in_progress>resolved': 'Resolve', 'pending_approval>resolved': 'Approve & resolve', 'pending_approval>in_progress': 'Reject…', 'resolved>closed': 'Close', 'resolved>open': 'Reopen', 'closed>open': 'Reopen' };
function evText(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'comment': return esc(d.body).replace(/\n/g, '<br>');
    case 'item.created': return 'created this item';
    case 'item.updated': return 'edited ' + esc(Object.keys(d.changes || {}).join(', '));
    case 'item.claimed': return 'took ownership';
    case 'item.released': return 'released ownership';
    case 'item.assigned': return d.toName ? 'assigned it to ' + esc(d.toName) : 'unassigned it';
    case 'item.status': return `moved <b>${LABEL[d.from]}</b> → <b>${LABEL[d.to]}</b>${d.note ? ' — “' + esc(d.note) + '”' : ''}`;
    case 'item.priority': return `changed priority ${PRIO[d.from]} → ${PRIO[d.to]}`;
    default: return esc(e.type);
  }
}
function renderDetail() {
  const d = state.detail; if (!d) return; const a = d.allowed || {}; const ed = state.editing;
  const due = d.due_at ? new Date(d.due_at).toLocaleString() : '—';
  const staleBar = state.stale ? `<div class="banner"><span>Someone changed this item while you were editing.</span><button data-act="reload">Load latest</button></div>` : '';
  const conflict = state.conflict ? `<div class="banner"><span>Your edit was NOT saved: ${esc(state.conflict.assignee_name || 'someone')} changed it first (now v${state.conflict.version}).</span><button data-act="applyLatest">See latest</button></div>` : '';
  $('#detail').innerHTML = `${staleBar}${conflict}
    <div><span class="pill st-${d.status}">${LABEL[d.status]}</span> <span class="pill p${d.priority}">${PRIO[d.priority]}</span> ${d.requires_approval ? '<span class="pill">needs approval</span>' : ''} <span class="muted small">#${d.id} · v${d.version}</span></div>
    ${ed ? `<input id="eTitle" value="${esc(ed.title)}" style="width:100%;margin-top:8px"><textarea id="eDesc">${esc(ed.description)}</textarea>
       <div class="actions"><button class="primary" data-act="saveEdit">Save</button><button data-act="cancelEdit">Cancel</button></div>`
      : `<h2 style="margin:8px 0">${esc(d.title)}</h2><p style="white-space:pre-wrap">${esc(d.description) || '<span class="muted">No description</span>'}</p>`}
    <dl class="grid"><dt>Team</dt><dd>${esc(d.team_name)}</dd><dt>Owner</dt><dd>${d.assignee_name ? esc(d.assignee_name) : '<i>unassigned</i>'}</dd><dt>Created by</dt><dd>${esc(d.creator_name)}</dd><dt>Due</dt><dd>${due}</dd>${d.approved_by ? '<dt>Approved</dt><dd>yes</dd>' : ''}</dl>
    <div class="actions">
      ${a.claim ? '<button class="primary" data-act="claim">Take ownership</button>' : ''}
      ${a.release ? '<button data-act="release">Release</button>' : ''}
      ${(a.transitions || []).map((to) => `<button data-act="tr" data-to="${to}" class="${to === 'in_progress' && d.status === 'pending_approval' ? 'danger' : ''}">${TR[d.status + '>' + to]}</button>`).join('')}
      ${a.edit && !ed ? '<button data-act="edit">Edit</button>' : ''}
      ${a.setPriority ? `<select data-act="prio">${[1, 2, 3, 4].filter((p) => p < 4 || a.setUrgent).map((p) => `<option value="${p}" ${p === d.priority ? 'selected' : ''}>Priority: ${PRIO[p]}</option>`).join('')}</select>` : ''}
      ${a.assign ? `<select data-act="assign" id="asg"><option value="">Assign to…</option></select>` : ''}
    </div>
    <h4>History</h4>
    ${a.comment ? `<textarea id="cBody" placeholder="Add a comment…">${esc(state.draft)}</textarea><div class="actions"><button data-act="comment">Comment</button></div>` : '<p class="muted small">You have read-only access.</p>'}
    <ul class="tl">${state.events.map((e) => `<li class="${e.pending ? 'pending' : ''} ${e.failed ? 'failed' : ''}"><b>${esc(e.actor_name)}</b> <span class="muted small">${e.pending ? 'sending…' : e.failed ? 'failed' : ago(e.created_at)}</span><div>${evText(e)}${e.failed ? ` <button data-act="retry" data-key="${e.key}">Retry</button>` : ''}</div></li>`).join('')}</ul>
    ${state.evMore ? '<button data-act="moreEv">Older history</button>' : ''}`;
  if (a.assign) ensureMembers(d.team_id).then((ms) => { const s = $('#asg'); if (s) s.innerHTML = '<option value="">Assign to…</option><option value="-">— Unassign —</option>' + ms.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join(''); });
}
$('#detail').oninput = (e) => { if (e.target.id === 'cBody') state.draft = e.target.value; if (state.editing) { if (e.target.id === 'eTitle') state.editing.title = e.target.value; if (e.target.id === 'eDesc') state.editing.description = e.target.value; } };

const busy = (on) => $('#detail').querySelectorAll('button,select').forEach((b) => (b.disabled = on));
// Pessimistic mutation: disable controls, send version, show server result or conflict.
async function mutate(method, path, body) {
  busy(true);
  try { const r = await api(method, path, { version: state.detail.version, ...body }, uuid()); state.detail = r; setListItem(r); await refreshEvents(); loadDash(); return r; }
  catch (e) { handleErr(e); } finally { renderDetail(); }
}
function handleErr(e) {
  toast(e.message);
  if (e.current) { state.detail = e.current; setListItem(e.current); refreshEvents().then(renderDetail); }  // reconcile with the server's decision
  if (e.code === 'VERSION_CONFLICT' && state.editing) state.conflict = e.current;
}
async function refreshEvents() { const ev = await api('GET', `/items/${state.selId}/events?limit=30`); state.events = ev.events; state.evMore = ev.nextBefore; }

$('#detail').onchange = (e) => {
  if (e.target.dataset.act === 'prio') mutate('PATCH', `/items/${state.selId}`, { priority: +e.target.value });
  if (e.target.dataset.act === 'assign' && e.target.value) mutate('POST', `/items/${state.selId}/assign`, { assigneeId: e.target.value === '-' ? null : +e.target.value });
};
$('#detail').onclick = async (e) => {
  const act = e.target.dataset.act; if (!act) return; const d = state.detail;
  if (act === 'reload' || act === 'applyLatest') { state.editing = state.conflict = null; state.stale = false; return reloadDetail(); }
  if (act === 'edit') { state.editing = { title: d.title, description: d.description, base: d.version }; return renderDetail(); }
  if (act === 'cancelEdit') { state.editing = state.conflict = null; return renderDetail(); }
  if (act === 'saveEdit') { const ed = state.editing; const r = await mutate('PATCH', `/items/${d.id}`, { version: ed.base, title: ed.title, description: ed.description }); if (r) state.editing = state.conflict = null; return renderDetail(); }
  if (act === 'release') return mutate('POST', `/items/${d.id}/release`, {});
  if (act === 'tr') { const to = e.target.dataset.to; let note; if (d.status === 'pending_approval' && to === 'in_progress') { note = prompt('Reason for rejecting?'); if (!note) return; } return mutate('POST', `/items/${d.id}/transition`, { to, note }); }
  if (act === 'claim') return claim();
  if (act === 'comment') { const body = state.draft.trim(); if (!body) return; state.draft = ''; return sendComment({ key: uuid(), body }); }
  if (act === 'retry') return sendComment(state.events.find((x) => x.key === e.target.dataset.key));
  if (act === 'moreEv') { const ev = await api('GET', `/items/${d.id}/events?limit=30&before=${state.evMore}`); state.events.push(...ev.events); state.evMore = ev.nextBefore; renderDetail(); }
};

// Optimistic claim: show the result immediately, then reconcile. If someone else won, we roll back to THEIR state.
async function claim() {
  const prev = state.detail, me = state.user;
  state.detail = { ...prev, assignee_id: me.id, assignee_name: me.name, status: 'in_progress', allowed: { ...prev.allowed, claim: false, assign: false, transitions: [] } };
  renderDetail(); busy(true);
  try { const r = await api('POST', `/items/${prev.id}/claim`, {}, uuid()); state.detail = r; setListItem(r); toast('You now own this item'); await refreshEvents(); loadDash(); }
  catch (e) { state.detail = prev; handleErr(e); if (!e.current) reloadDetail(); }
  finally { renderDetail(); }
}
// Optimistic comment with retry. The SAME key is reused, so retry can never post it twice.
async function sendComment(ev) {
  const itemId = state.selId;
  if (!state.events.includes(ev)) state.events.unshift({ id: 'tmp-' + ev.key, type: 'comment', key: ev.key, body: ev.body, actor_name: state.user.name, data: { body: ev.body } });
  const tmp = state.events.find((x) => x.key === ev.key); tmp.pending = true; tmp.failed = false; renderDetail();
  try {
    const r = await api('POST', `/items/${itemId}/comments`, { body: ev.body }, ev.key);
    if (state.selId === itemId) { const i = state.events.findIndex((x) => x.key === ev.key); if (i > -1) state.events[i] = { ...r, data: r.data ? (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) : {} }; renderDetail(); }
  } catch (e) { tmp.pending = false; tmp.failed = true; toast(e.message); renderDetail(); }
}

// ---------- create ----------
$('#newBtn').onclick = () => {
  const writable = state.teams.filter((t) => ['member', 'lead', 'admin'].includes(t.role));
  if (!writable.length) return toast('You only have read access.');
  const key = uuid(); const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<form><h3>New work item</h3>
    <select name="teamId">${writable.map((t) => `<option value="${t.team_id}">${esc(t.name)}</option>`).join('')}</select>
    <input name="title" placeholder="What needs doing?" maxlength="200" required>
    <textarea name="description" placeholder="Why does this exist? Context, links…"></textarea>
    <select name="priority"><option value="2">Medium</option><option value="1">Low</option><option value="3">High</option><option value="4">Urgent (leads only)</option></select>
    <input name="dueAt" type="datetime-local"><label><input type="checkbox" name="requiresApproval"> Requires approval before resolving</label>
    <div class="err" id="cErr"></div><div class="actions"><button class="primary">Create</button><button type="button" id="cCancel">Cancel</button></div></form>`;
  $('#cCancel').onclick = () => (m.hidden = true);
  m.querySelector('form').onsubmit = async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target), btn = ev.submitter; btn.disabled = true;
    const body = { teamId: +f.get('teamId'), title: f.get('title'), description: f.get('description'), priority: +f.get('priority'), requiresApproval: !!f.get('requiresApproval'), dueAt: f.get('dueAt') ? new Date(f.get('dueAt')).getTime() : null };
    try { const it = await api('POST', '/items', body, key); m.hidden = true; toast('Created #' + it.id); await Promise.all([loadList(true), loadDash()]); select(it.id); }
    catch (e) { $('#cErr').textContent = e.message; btn.disabled = false; }   // same key on re-submit: no duplicate
  };
};

// ---------- notifications ----------
async function loadNotifs() { state.notifs = await api('GET', '/notifications'); const u = state.notifs.unread; $('#unread').hidden = !u; $('#unread').textContent = u; }
$('#bellBtn').onclick = async () => {
  const p = $('#notifs'); p.hidden = !p.hidden; if (p.hidden) return;
  p.innerHTML = state.notifs.notifications.map((n) => `<div class="${n.read_at ? '' : 'unread'}" data-id="${n.item_id}" style="cursor:pointer">${esc(n.message)}<div class="muted small">${ago(n.created_at)}</div></div>`).join('') || '<div class="muted">Nothing yet.</div>';
  p.onclick = (e) => { const r = e.target.closest('[data-id]'); if (r) { p.hidden = true; select(+r.dataset.id); } };
  if (state.notifs.unread) { await api('POST', '/notifications/read'); setTimeout(loadNotifs, 300); }
};

// ---------- realtime (SSE = hint; truth is always re-fetched) ----------
let es, dashT;
function connect() {
  es?.close(); es = new EventSource('/api/stream?token=' + encodeURIComponent(state.token));
  es.onopen = () => $('#live').classList.add('on'); es.onerror = () => $('#live').classList.remove('on');
  let first = true;
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'hello') { if (!first) { loadList(true); reloadIfIdle(); } first = false; loadDash(); return; } // after reconnect: resync everything
    if (ev.type === 'notification') return loadNotifs();
    if (ev.type === 'item') {
      clearTimeout(dashT); dashT = setTimeout(loadDash, 700);
      const inList = state.items.some((i) => i.id === ev.itemId);
      if (ev.itemId === state.selId && ev.actorId !== state.user.id) {
        if (state.editing) { state.stale = true; renderDetail(); } else reloadDetail();   // never clobber an in-progress edit
      } else if (inList && ev.actorId !== state.user.id) {
        try { setListItem(await api('GET', `/items/${ev.itemId}`)); } catch {}
      } else if (!inList && ev.actorId !== state.user.id) { state.newCount++; renderList(); }
    }
  };
}
function reloadIfIdle() { if (state.selId && !state.editing) reloadDetail(); }

boot();

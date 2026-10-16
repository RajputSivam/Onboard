const { HttpError } = require('./errors');
const P = require('./policy');

const STALE_MS = 48 * 3600 * 1000;
const NOTIFY_TYPES = new Set(['comment', 'item.updated', 'item.claimed', 'item.released', 'item.assigned', 'item.status', 'item.priority']);
const ITEM_SQL = `SELECT i.*, a.name AS assignee_name, c.name AS creator_name, t.name AS team_name
  FROM items i LEFT JOIN users a ON a.id = i.assignee_id JOIN users c ON c.id = i.creator_id JOIN teams t ON t.id = i.team_id`;

function createService(db, { now = Date.now, publish = null } = {}) {
  const after = [];
  const afterCommit = (fn) => after.push(fn);
  // All writes run in ONE immediate (write-locked) transaction; side effects fire only after commit.
  function run(fn) {
    if (db.inTransaction) return fn();
    after.length = 0;
    let r;
    try { r = db.transaction(fn).immediate(); } catch (e) { after.length = 0; throw e; }
    const fx = after.splice(0); fx.forEach((f) => { try { f(); } catch (_) {} });
    return r;
  }

  const roleOf = (userId, teamId) =>
    db.prepare('SELECT role FROM memberships WHERE user_id=? AND team_id=?').get(userId, teamId)?.role ?? null;

  const present = (row, userId, role) => ({
    ...row, requires_approval: !!row.requires_approval,
    ...(role !== undefined ? { allowed: P.allowed(row, userId, role) } : {}),
  });

  function loadFor(userId, id) {
    const item = db.prepare(`${ITEM_SQL} WHERE i.id = ?`).get(id);
    const role = item ? roleOf(userId, item.team_id) : null;
    // non-members get 404, not 403: don't leak that the item exists
    if (!item || role == null) throw new HttpError(404, 'NOT_FOUND', 'Item not found');
    return { item, role };
  }
  const conflict = (item, userId, role) =>
    new HttpError(409, 'VERSION_CONFLICT', 'This item was changed by someone else. Review the latest version and retry.',
      { current: present(item, userId, role) });
  const forbid = (msg) => new HttpError(403, 'FORBIDDEN', msg);

  function addEvent(item, actorId, type, data = {}) {
    const id = db.prepare('INSERT INTO events(item_id,team_id,actor_id,type,data,created_at) VALUES (?,?,?,?,?,?)')
      .run(item.id, item.team_id, actorId, type, JSON.stringify(data), now()).lastInsertRowid;
    if (NOTIFY_TYPES.has(type))
      db.prepare('INSERT INTO outbox(kind,payload,next_run_at,created_at) VALUES (?,?,?,?)')
        .run('notify', JSON.stringify({ eventId: Number(id) }), now(), now());
    return Number(id);
  }

  // Core primitive: authorize -> check version -> conditional UPDATE -> event+outbox, atomically.
  function mutate(userId, itemId, expectedVersion, decide, { versionRequired = true } = {}) {
    return run(() => {
      const { item, role } = loadFor(userId, itemId);
      if (versionRequired && !Number.isInteger(expectedVersion))
        throw new HttpError(428, 'VERSION_REQUIRED', 'Send the item version you were looking at');
      if (Number.isInteger(expectedVersion) && expectedVersion !== item.version) throw conflict(item, userId, role);
      const d = decide(item, role);
      if (d.noop) return present(item, userId, role);
      const ts = now(), cols = Object.keys(d.set);
      const res = db.prepare(
        `UPDATE items SET ${cols.map((c) => `${c}=@${c}`).join(',')}, version=version+1, updated_at=@ts WHERE id=@id AND version=@v`
      ).run({ ...d.set, ts, id: itemId, v: item.version });
      if (res.changes !== 1) throw conflict(item, userId, role); // lost a race: never overwrite silently
      for (const ev of d.events) addEvent(item, userId, ev.type, ev.data);
      const fresh = db.prepare(`${ITEM_SQL} WHERE i.id=?`).get(itemId);
      afterCommit(() => publish?.team(item.team_id, { type: 'item', itemId, version: fresh.version, actorId: userId }));
      return present(fresh, userId, role);
    });
  }

  const clampStr = (v, max, name, { required = false } = {}) => {
    if (v == null) { if (required) throw new HttpError(400, 'VALIDATION', `${name} is required`); return v; }
    const s = String(v).trim();
    if (required && !s) throw new HttpError(400, 'VALIDATION', `${name} is required`);
    if (s.length > max) throw new HttpError(400, 'VALIDATION', `${name} is too long (max ${max})`);
    return s;
  };
  const prio = (p) => {
    if (!Number.isInteger(p) || p < 1 || p > 4) throw new HttpError(400, 'VALIDATION', 'priority must be 1..4');
    return p;
  };
  const dueAt = (v) => {
    if (v == null) return null;
    if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'VALIDATION', 'dueAt must be epoch ms');
    return v;
  };

  const svc = {
    run, roleOf, STALE_MS,

    createItem(userId, b) {
      return run(() => {
        const teamId = Number(b.teamId);
        const role = roleOf(userId, teamId);
        if (role == null) throw new HttpError(404, 'NOT_FOUND', 'Team not found');
        if (!P.atLeast(role, 'member')) throw forbid('Viewers cannot create items');
        const title = clampStr(b.title, 200, 'title', { required: true });
        const description = clampStr(b.description ?? '', 10000, 'description');
        const priority = prio(b.priority ?? 2);
        if (priority === 4 && !P.atLeast(role, 'lead')) throw forbid('Only leads can create urgent items');
        const ts = now();
        const id = Number(db.prepare(`INSERT INTO items(team_id,title,description,priority,creator_id,requires_approval,due_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(teamId, title, description, priority, userId, b.requiresApproval ? 1 : 0, dueAt(b.dueAt), ts, ts).lastInsertRowid);
        const item = db.prepare(`${ITEM_SQL} WHERE i.id=?`).get(id);
        addEvent(item, userId, 'item.created', { title, priority });
        afterCommit(() => publish?.team(teamId, { type: 'item', itemId: id, version: 1, actorId: userId }));
        return present(item, userId, role);
      });
    },

    getItem(userId, id) { const { item, role } = loadFor(userId, id); return present(item, userId, role); },

    updateItem(userId, id, b) {
      return mutate(userId, id, b.version, (item, role) => {
        const set = {}, changes = {}, events = [];
        const apply = (col, val) => { if (val !== item[col]) { changes[col] = { from: item[col], to: val }; set[col] = val; } };
        if ('title' in b || 'description' in b || 'dueAt' in b) {
          if (!P.canEdit(item, userId, role)) throw forbid('You cannot edit this item');
          if ('title' in b) apply('title', clampStr(b.title, 200, 'title', { required: true }));
          if ('description' in b) apply('description', clampStr(b.description, 10000, 'description'));
          if ('dueAt' in b) apply('due_at', dueAt(b.dueAt));
        }
        if (Object.keys(changes).length)
          events.push({ type: 'item.updated', data: { changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, k === 'description' ? { edited: true } : v])) } });
        if ('priority' in b && b.priority !== item.priority) {
          const p = prio(b.priority);
          if (!P.canSetPriority(item, userId, role, p)) throw forbid(p === 4 ? 'Only leads can mark items urgent' : 'You cannot change priority');
          set.priority = p;
          events.push({ type: 'item.priority', data: { from: item.priority, to: p } });
        }
        if (!events.length) return { noop: true };
        return { set, events };
      });
    },

    // Atomic claim: exactly one concurrent caller wins; repeats by the winner are harmless.
    claim(userId, id, version) {
      return mutate(userId, id, version, (item, role) => {
        if (!P.atLeast(role, 'member')) throw forbid('Viewers cannot take ownership');
        if (item.assignee_id === userId) return { noop: true }; // idempotent retry
        if (item.assignee_id != null)
          throw new HttpError(409, 'ALREADY_CLAIMED', `${item.assignee_name} already owns this item`, { current: present(item, userId, role) });
        if (item.status !== 'open') throw new HttpError(409, 'INVALID_STATE', `Cannot claim an item that is ${item.status}`);
        return { set: { assignee_id: userId, status: 'in_progress' }, events: [{ type: 'item.claimed', data: { toAssignee: userId } }] };
      }, { versionRequired: false });
    },

    release(userId, id, version) {
      return mutate(userId, id, version, (item, role) => {
        if (item.assignee_id == null) return { noop: true };
        if (!P.canRelease(item, userId, role)) throw forbid('You cannot release this item');
        return { set: { assignee_id: null, status: 'open' }, events: [{ type: 'item.released', data: { fromAssignee: item.assignee_id } }] };
      }, { versionRequired: false });
    },

    assign(userId, id, b) {
      return mutate(userId, id, b.version, (item, role) => {
        if (!P.canAssign(item, userId, role)) throw forbid('Only leads can assign work (on open/in-progress items)');
        const to = b.assigneeId == null ? null : Number(b.assigneeId);
        if (to === item.assignee_id) return { noop: true };
        let toName = null;
        if (to != null) {
          const r = roleOf(to, item.team_id);
          if (!P.atLeast(r, 'member')) throw new HttpError(422, 'INVALID_ASSIGNEE', 'Assignee must be a member of this team');
          toName = db.prepare('SELECT name FROM users WHERE id=?').get(to).name;
        }
        const set = { assignee_id: to };
        if (to == null) set.status = 'open';
        return { set, events: [{ type: 'item.assigned', data: { fromAssignee: item.assignee_id, toAssignee: to, toName } }] };
      });
    },

    transition(userId, id, b) {
      return mutate(userId, id, b.version, (item, role) => {
        const to = b.to;
        if (!P.STATUSES.includes(to)) throw new HttpError(400, 'VALIDATION', 'Unknown status');
        const why = P.checkTransition(item, userId, role, to);
        if (why) throw new HttpError(why.startsWith('Invalid') ? 409 : 403, why.startsWith('Invalid') ? 'INVALID_TRANSITION' : 'FORBIDDEN', why);
        const note = clampStr(b.note ?? '', 2000, 'note');
        if (item.status === 'pending_approval' && to === 'in_progress' && !note) throw new HttpError(400, 'VALIDATION', 'A reason is required when rejecting');
        const set = { status: to };
        if (item.status === 'pending_approval' && to === 'resolved') { set.approved_by = userId; set.approved_at = now(); }
        if (to === 'open') { set.approved_by = null; set.approved_at = null; }
        return { set, events: [{ type: 'item.status', data: { from: item.status, to, note: note || undefined } }] };
      });
    },

    addComment(userId, id, body) {
      return run(() => {
        const { item, role } = loadFor(userId, id);
        if (!P.canComment(item, userId, role)) throw forbid('Viewers cannot comment');
        const text = clampStr(body, 5000, 'body', { required: true });
        const eid = addEvent(item, userId, 'comment', { body: text });
        db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(now(), id); // floats up; does NOT bump version
        afterCommit(() => publish?.team(item.team_id, { type: 'item', itemId: id, version: item.version, actorId: userId }));
        return svc.eventById(eid);
      });
    },

    eventById: (id) => db.prepare('SELECT e.*, u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor_id WHERE e.id=?').get(id),

    listEvents(userId, id, { before, limit = 50 } = {}) {
      loadFor(userId, id);
      const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
      const rows = db.prepare(`SELECT e.*, u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor_id
        WHERE e.item_id=? AND (? IS NULL OR e.id < ?) ORDER BY e.id DESC LIMIT ?`).all(id, before ?? null, before ?? null, lim + 1);
      const more = rows.length > lim; if (more) rows.pop();
      return { events: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })), nextBefore: more ? rows[rows.length - 1].id : null };
    },

    // ---- overview / search --------------------------------------------------
    viewPredicates(leadTeamIds) {
      const leads = leadTeamIds.length ? leadTeamIds.join(',') : '0';
      return {
        mine: `i.assignee_id = @me AND i.status IN ('open','in_progress','pending_approval')`,
        approvals: `i.status = 'pending_approval' AND (i.assignee_id IS NULL OR i.assignee_id != @me) AND i.team_id IN (${leads})`,
        unassigned_urgent: `i.assignee_id IS NULL AND i.status = 'open' AND i.priority >= 3`,
        overdue: `i.due_at IS NOT NULL AND i.due_at < @now AND i.status IN ('open','in_progress','pending_approval')`,
        stale: `i.status IN ('open','in_progress') AND i.updated_at < @stale`,
      };
    },
    memberships: (userId) => db.prepare('SELECT m.team_id, m.role, t.name FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=? ORDER BY t.name').all(userId),

    dashboard(userId) {
      const ms = svc.memberships(userId);
      if (!ms.length) return { mine: 0, approvals: 0, unassigned_urgent: 0, overdue: 0, stale: 0 };
      const pr = svc.viewPredicates(ms.filter((m) => P.atLeast(m.role, 'lead')).map((m) => m.team_id));
      const sel = Object.entries(pr).map(([k, v]) => `COALESCE(SUM(CASE WHEN ${v} THEN 1 ELSE 0 END),0) AS ${k}`).join(',');
      return db.prepare(`SELECT ${sel} FROM items i WHERE i.team_id IN (${ms.map((m) => m.team_id).join(',')}) AND i.status != 'closed'`)
        .get({ me: userId, now: now(), stale: now() - STALE_MS });
    },

    listItems(userId, q = {}) {
      const ms = svc.memberships(userId);
      let teamIds = ms.map((m) => m.team_id);
      if (q.team) teamIds = teamIds.filter((t) => t === Number(q.team));
      if (!teamIds.length) return { items: [], nextCursor: null };
      const where = [`i.team_id IN (${teamIds.join(',')})`], p = { me: userId, now: now(), stale: now() - STALE_MS };
      if (q.status) {
        const st = String(q.status).split(',').filter((s) => P.STATUSES.includes(s));
        if (st.length) where.push(`i.status IN (${st.map((s) => `'${s}'`).join(',')})`);
      }
      if (q.priority && Number.isInteger(+q.priority)) { where.push('i.priority = @prio'); p.prio = +q.priority; }
      if (q.assignee === 'me') where.push('i.assignee_id = @me');
      else if (q.assignee === 'none') where.push('i.assignee_id IS NULL');
      else if (q.assignee && Number.isInteger(+q.assignee)) { where.push('i.assignee_id = @asg'); p.asg = +q.assignee; }
      if (q.view) {
        const pr = svc.viewPredicates(ms.filter((m) => P.atLeast(m.role, 'lead')).map((m) => m.team_id));
        if (!pr[q.view]) throw new HttpError(400, 'VALIDATION', 'Unknown view');
        where.push(pr[q.view]);
      }
      const tokens = String(q.q || '').match(/[\p{L}\p{N}]+/gu);
      if (tokens?.length) { where.push('i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH @fts)'); p.fts = tokens.slice(0, 8).map((t) => `"${t}"*`).join(' '); }
      if (q.cursor) {
        try {
          const [cu, ci] = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString());
          where.push('(i.updated_at < @cu OR (i.updated_at = @cu AND i.id < @ci))'); p.cu = +cu; p.ci = +ci;
        } catch { throw new HttpError(400, 'VALIDATION', 'Bad cursor'); }
      }
      const limit = Math.min(Math.max(parseInt(q.limit) || 30, 1), 100);
      // keyset pagination: stable and O(limit) regardless of how deep the user scrolls
      const rows = db.prepare(`${ITEM_SQL} WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT ${limit + 1}`).all(p);
      const more = rows.length > limit; if (more) rows.pop();
      const last = rows[rows.length - 1];
      return { items: rows.map((r) => present(r)), nextCursor: more ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString('base64url') : null };
    },

    members(userId, teamId) {
      if (roleOf(userId, teamId) == null) throw new HttpError(404, 'NOT_FOUND', 'Team not found');
      return db.prepare('SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.name').all(teamId);
    },

    setMemberRole(actorId, teamId, targetId, role) {
      return run(() => {
        const mine = roleOf(actorId, teamId);
        if (mine == null) throw new HttpError(404, 'NOT_FOUND', 'Team not found');
        if (mine !== 'admin') throw forbid('Only team admins can change roles');
        if (!['viewer', 'member', 'lead', 'admin'].includes(role)) throw new HttpError(400, 'VALIDATION', 'Unknown role');
        const cur = roleOf(targetId, teamId);
        if (cur === 'admin' && role !== 'admin' &&
          db.prepare("SELECT COUNT(*) c FROM memberships WHERE team_id=? AND role='admin'").get(teamId).c <= 1)
          throw new HttpError(409, 'LAST_ADMIN', 'A team must keep at least one admin');
        db.prepare('INSERT INTO memberships(user_id,team_id,role) VALUES (?,?,?) ON CONFLICT(user_id,team_id) DO UPDATE SET role=excluded.role').run(targetId, teamId, role);
        db.prepare('INSERT INTO events(item_id,team_id,actor_id,type,data,created_at) VALUES (NULL,?,?,?,?,?)')
          .run(teamId, actorId, 'member.role_changed', JSON.stringify({ userId: targetId, from: cur, to: role }), now());
        return { userId: targetId, teamId, role };
      });
    },

    notifications(userId) {
      return {
        unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL').get(userId).c,
        notifications: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(userId),
      };
    },
    markRead: (userId) => db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), userId).changes,
  };
  return svc;
}
module.exports = { createService, ITEM_SQL };

// Reliable async processing via a transactional outbox.
// Guarantees: at-least-once delivery, exponential backoff, dead-lettering, lease recovery after a crash.
// Handlers MUST be idempotent (notify uses UNIQUE(user_id,event_id) + INSERT OR IGNORE).
const MAX_ATTEMPTS = 5, LEASE_MS = 30000;
const backoff = (n) => Math.min(2 ** n * 1000, 5 * 60 * 1000);

function describe(type, d) {
  switch (type) {
    case 'comment': return 'commented';
    case 'item.updated': return `edited ${Object.keys(d.changes || {}).join(', ')}`;
    case 'item.claimed': return 'took ownership';
    case 'item.released': return 'released ownership';
    case 'item.assigned': return d.toName ? `assigned it to ${d.toName}` : 'unassigned it';
    case 'item.status': return `moved it ${d.from} → ${d.to}`;
    case 'item.priority': return `changed priority ${d.from} → ${d.to}`;
    default: return type;
  }
}

function createWorker(db, { now = Date.now, publish = null, handlers = {} } = {}) {
  const all = {
    notify({ eventId }) {
      const ev = db.prepare('SELECT e.*, u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor_id WHERE e.id=?').get(eventId);
      if (!ev) return;
      const item = db.prepare('SELECT id, title, team_id, assignee_id, creator_id FROM items WHERE id=?').get(ev.item_id);
      const d = JSON.parse(ev.data);
      const ids = new Set([item.assignee_id, item.creator_id, d.toAssignee, d.fromAssignee,
        ...db.prepare('SELECT DISTINCT actor_id FROM events WHERE item_id=?').all(item.id).map((r) => r.actor_id)]);
      ids.delete(ev.actor_id); ids.delete(null); ids.delete(undefined);
      const msg = `${ev.actor_name} ${describe(ev.type, d)} — ${item.title}`;
      const ins = db.prepare(`INSERT OR IGNORE INTO notifications(user_id,item_id,event_id,message,created_at)
        SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM memberships WHERE user_id=? AND team_id=?)`);
      const notified = [];
      for (const uid of ids)
        if (ins.run(uid, item.id, ev.id, msg, now(), uid, item.team_id).changes) notified.push(uid);
      if (notified.length) publish?.users(notified, { type: 'notification' });
    },
    ...handlers,
  };
  const claim = db.prepare(`UPDATE outbox SET locked_until=@lease, attempts=attempts+1
    WHERE id IN (SELECT id FROM outbox WHERE status='pending' AND next_run_at<=@now AND (locked_until IS NULL OR locked_until<@now)
                 ORDER BY id LIMIT 50) RETURNING *`);
  const done = db.prepare("UPDATE outbox SET status='done', locked_until=NULL, last_error=NULL WHERE id=?");
  const fail = db.prepare("UPDATE outbox SET status=@status, locked_until=NULL, next_run_at=@next, last_error=@err WHERE id=@id");

  return {
    runOnce() {
      const jobs = db.transaction(() => claim.all({ now: now(), lease: now() + LEASE_MS })).immediate();
      let ok = 0;
      for (const j of jobs) {
        try {
          db.transaction(() => { all[j.kind](JSON.parse(j.payload)); done.run(j.id); }).immediate(); // effect + ack are atomic
          ok++;
        } catch (e) {
          fail.run({ id: j.id, err: String(e.message).slice(0, 500), status: j.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending', next: now() + backoff(j.attempts) });
        }
      }
      return { claimed: jobs.length, ok };
    },
    start(ms = 1000) { const t = setInterval(() => { try { this.runOnce(); } catch (e) { console.error('worker', e); } }, ms); t.unref?.(); return () => clearInterval(t); },
  };
}
module.exports = { createWorker, MAX_ATTEMPTS };

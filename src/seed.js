const { openDb } = require('./db');
const { hashPassword } = require('./auth');

function seed(db, { bulk = 0 } = {}) {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c) return;
  const now = Date.now(), H = 3600e3;
  const ph = hashPassword('password');
  const U = {}, T = {};
  db.transaction(() => {
    for (const [k, n] of [['alice', 'Alice Admin'], ['bob', 'Bob Lead'], ['carol', 'Carol Dev'], ['dave', 'Dave Support'], ['erin', 'Erin Viewer'], ['frank', 'Frank Ops']])
      U[k] = Number(db.prepare('INSERT INTO users(email,name,password_hash) VALUES (?,?,?)').run(`${k}@example.com`, n, ph).lastInsertRowid);
    for (const n of ['Support', 'Engineering', 'Payments']) T[n] = Number(db.prepare('INSERT INTO teams(name) VALUES (?)').run(n).lastInsertRowid);
    const m = (u, t, r) => db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(U[u], T[t], r);
    m('alice', 'Support', 'admin'); m('alice', 'Engineering', 'admin'); m('alice', 'Payments', 'admin');
    m('bob', 'Engineering', 'lead'); m('bob', 'Payments', 'member');
    m('carol', 'Engineering', 'member'); m('carol', 'Payments', 'lead');
    m('dave', 'Support', 'member'); m('erin', 'Engineering', 'viewer');
    m('frank', 'Support', 'lead'); m('frank', 'Payments', 'member');

    const ins = db.prepare(`INSERT INTO items(team_id,title,description,status,priority,assignee_id,creator_id,requires_approval,due_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const ev = db.prepare('INSERT INTO events(item_id,team_id,actor_id,type,data,created_at) VALUES (?,?,?,?,?,?)');
    const demo = [
      ['Engineering', 'Production API latency spike in eu-west', 'p99 > 4s since 09:10 UTC. Suspect connection pool exhaustion.', 'open', 4, null, 'bob', 0, now + 2 * H, 1 * H],
      ['Payments', 'Refund stuck for order #88213', 'Customer charged twice; refund job shows pending for 3 days.', 'in_progress', 3, 'carol', 'frank', 1, now - 5 * H, 60 * H],
      ['Payments', 'Chargeback evidence due Friday', 'Compile shipping proof and customer comms.', 'pending_approval', 3, 'frank', 'carol', 1, now + 20 * H, 3 * H],
      ['Support', 'Enterprise customer cannot export invoices', 'Acme Corp reports 500 on /invoices/export.', 'open', 3, null, 'dave', 0, null, 70 * H],
      ['Engineering', 'Rotate expiring TLS certificates', 'Three certificates expire in 9 days.', 'in_progress', 2, 'bob', 'alice', 0, now + 9 * 24 * H, 2 * H],
      ['Support', 'GDPR data-deletion request #442', 'Verify identity then delete within 30 days.', 'open', 2, null, 'dave', 1, now + 14 * 24 * H, 5 * H],
    ];
    for (const [t, title, d, st, p, as, cr, ap, due, age] of demo) {
      const id = Number(ins.run(T[t], title, d, st, p, as ? U[as] : null, U[cr], ap, due, now - age - 24 * H, now - age).lastInsertRowid);
      ev.run(id, T[t], U[cr], 'item.created', JSON.stringify({ title, priority: p }), now - age - 24 * H);
    }
    if (bulk) {
      const teams = Object.values(T), users = Object.values(U), sts = ['open', 'open', 'in_progress', 'in_progress', 'pending_approval', 'resolved', 'closed'];
      const words = ['payment', 'login', 'invoice', 'refund', 'outage', 'database', 'latency', 'export', 'compliance', 'audit', 'queue', 'webhook', 'customer', 'deploy', 'certificate'];
      const w = () => words[(Math.random() * words.length) | 0];
      for (let i = 0; i < bulk; i++) {
        const t = teams[i % 3], ts = now - ((Math.random() * 90 * 24 * H) | 0), st = sts[(Math.random() * sts.length) | 0];
        const as = st === 'open' ? null : users[(Math.random() * users.length) | 0];
        const id = Number(ins.run(t, `${w()} ${w()} issue #${i}`, `${w()} ${w()} ${w()} needs investigation`, st, 1 + ((Math.random() * 4) | 0), as, users[(Math.random() * users.length) | 0], i % 7 === 0 ? 1 : 0, Math.random() < 0.3 ? ts + 3 * 24 * H : null, ts, ts).lastInsertRowid);
        ev.run(id, t, U.alice, 'item.created', '{}', ts);
      }
    }
  })();
}

if (require.main === module) {
  const i = process.argv.indexOf('--bulk');
  const f = process.env.DB_FILE || './data/opsboard.db'; require('fs').mkdirSync(require('path').dirname(f), { recursive: true });
  const db = openDb(f);
  seed(db, { bulk: i > -1 ? +process.argv[i + 1] : 0 });
  console.log('seeded');
}
module.exports = { seed };

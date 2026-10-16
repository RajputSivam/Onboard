// Tests target the behaviours that would be most dangerous if wrong:
// double ownership, lost updates, duplicate creates, authorization leaks, workflow bypass, lost/duplicated async work.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const { createWorker, MAX_ATTEMPTS } = require('../src/worker');

let t;
test.before(async () => { t = await boot(); });
test.after(() => t.close());
const events = (id) => t.db.prepare('SELECT type FROM events WHERE item_id=? ORDER BY id').all(id).map((e) => e.type);

test('CONCURRENCY: simultaneous claims -> exactly one winner, loser gets 409, one history entry', async () => {
  const item = await t.mk('bob');
  const [a, b] = await Promise.all([t.as('bob')('POST', `/items/${item.id}/claim`, {}), t.as('carol')('POST', `/items/${item.id}/claim`, {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.error.code, 'ALREADY_CLAIMED');
  assert.ok(loser.body.error.current.assignee_id, 'loser receives current state to reconcile UI');
  assert.equal(events(item.id).filter((e) => e === 'item.claimed').length, 1);
  const final = t.db.prepare('SELECT assignee_id, status, version FROM items WHERE id=?').get(item.id);
  assert.equal(final.status, 'in_progress'); assert.equal(final.version, 2);
});

test('CONCURRENCY: winner repeating claim is idempotent (no extra event/version)', async () => {
  const item = await t.mk('bob');
  const r1 = await t.as('bob')('POST', `/items/${item.id}/claim`, {});
  const r2 = await t.as('bob')('POST', `/items/${item.id}/claim`, {});
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(r2.body.version, r1.body.version);
  assert.equal(events(item.id).filter((e) => e === 'item.claimed').length, 1);
});

test('STALE DATA: two edits from the same version -> second rejected with current state, no lost update', async () => {
  const item = await t.mk('bob');
  const a = await t.as('bob')('PATCH', `/items/${item.id}`, { version: item.version, title: 'Bob title' });
  const b = await t.as('alice')('PATCH', `/items/${item.id}`, { version: item.version, title: 'Alice title' });
  assert.equal(a.status, 200); assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'VERSION_CONFLICT');
  assert.equal(b.body.error.current.title, 'Bob title');
  assert.equal(t.db.prepare('SELECT title FROM items WHERE id=?').get(item.id).title, 'Bob title');
});

test('STALE DATA: missing version is rejected (428), comments do not invalidate versions', async () => {
  const item = await t.mk('bob');
  assert.equal((await t.as('bob')('PATCH', `/items/${item.id}`, { title: 'x' })).status, 428);
  await t.as('carol')('POST', `/items/${item.id}/comments`, { body: 'looking' });
  const ok = await t.as('bob')('PATCH', `/items/${item.id}`, { version: item.version, title: 'still fine' });
  assert.equal(ok.status, 200);
});

test('IDEMPOTENCY: replayed create returns same item, creates one row; key reuse w/ different body -> 422; key required', async () => {
  const body = { teamId: t.team('Engineering'), title: 'Dup-protected' }, h = { 'Idempotency-Key': 'same-key-1' };
  const r1 = await t.as('bob')('POST', '/items', body, h);
  const r2 = await t.as('bob')('POST', '/items', body, h);
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  assert.equal(r2.headers.get('idempotent-replay'), 'true');
  assert.equal(r1.body.id, r2.body.id);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM items WHERE title='Dup-protected'").get().c, 1);
  assert.equal((await t.as('bob')('POST', '/items', { ...body, title: 'Other' }, h)).status, 422);
  assert.equal((await t.as('bob')('POST', '/items', body)).status, 400);
  // keys are scoped per user
  assert.equal((await t.as('carol')('POST', '/items', body, h)).body.id !== r1.body.id, true);
});

test('IDEMPOTENCY: 20 parallel identical creates -> exactly one item', async () => {
  const body = { teamId: t.team('Engineering'), title: 'Burst create' }, h = { 'Idempotency-Key': 'burst-1' };
  const rs = await Promise.all(Array.from({ length: 20 }, () => t.as('bob')('POST', '/items', body, h)));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM items WHERE title='Burst create'").get().c, 1);
});

test('AUTHZ: non-members get 404 on every item route; lists never leak other teams', async () => {
  const item = await t.mk('bob'); // Engineering; dave is Support only
  const d = t.as('dave');
  for (const [m, p, b] of [['GET', `/items/${item.id}`], ['GET', `/items/${item.id}/events`], ['POST', `/items/${item.id}/comments`, { body: 'x' }],
    ['POST', `/items/${item.id}/claim`, {}], ['PATCH', `/items/${item.id}`, { version: 1, title: 'x' }], ['POST', `/items/${item.id}/transition`, { to: 'in_progress', version: 1 }]])
    assert.equal((await d(m, p, b)).status, 404, `${m} ${p}`);
  const list = await d('GET', '/items?limit=100');
  assert.ok(list.body.items.every((i) => i.team_name === 'Support'));
  assert.equal((await d('POST', '/items', { teamId: t.team('Engineering'), title: 'x' }, { 'Idempotency-Key': 'z1' })).status, 404);
  assert.equal((await t.raw('GET', '/items')).status, 401);
});

test('AUTHZ: role checks enforced server-side (viewer / member / lead)', async () => {
  const item = await t.mk('bob');
  assert.equal((await t.as('erin')('POST', `/items/${item.id}/comments`, { body: 'hi' })).status, 403);
  assert.equal((await t.as('erin')('POST', `/items/${item.id}/claim`, {})).status, 403);
  assert.equal((await t.as('erin')('POST', '/items', { teamId: t.team('Engineering'), title: 'x' }, { 'Idempotency-Key': 'v1' })).status, 403);
  assert.equal((await t.as('erin')('GET', `/items/${item.id}`)).status, 200); // viewers can read
  assert.equal((await t.as('carol')('POST', `/items/${item.id}/assign`, { version: item.version, assigneeId: t.users.carol })).status, 403); // member can't assign
  assert.equal((await t.as('carol')('POST', '/items', { teamId: t.team('Engineering'), title: 'x', priority: 4 }, { 'Idempotency-Key': 'u1' })).status, 403);
  assert.equal((await t.as('carol')('PATCH', `/items/${item.id}`, { version: item.version, title: 'hijack' })).status, 403); // not owner/creator
  assert.equal((await t.as('bob')('POST', `/items/${item.id}/assign`, { version: item.version, assigneeId: t.users.erin })).status, 422); // viewer can't own work
  assert.equal((await t.as('bob')('POST', `/items/${item.id}/assign`, { version: item.version, assigneeId: t.users.carol })).status, 200);
  assert.equal((await t.as('carol')('PUT', `/teams/${t.team('Engineering')}/members/${t.users.carol}`, { role: 'admin' })).status, 403);
});

test('AUTHZ: last admin cannot be demoted', async () => {
  const eng = t.team('Engineering');
  assert.equal((await t.as('alice')('PUT', `/teams/${eng}/members/${t.users.alice}`, { role: 'member' })).status, 409);
});

test('WORKFLOW: approval items cannot skip approval; no self-approval; invalid transitions rejected; history recorded', async () => {
  let it = await t.mk('carol', { requiresApproval: true });
  it = (await t.as('carol')('POST', `/items/${it.id}/claim`, {})).body;
  let r = await t.as('carol')('POST', `/items/${it.id}/transition`, { to: 'resolved', version: it.version });
  assert.equal(r.status, 403); // must go through approval
  r = await t.as('carol')('POST', `/items/${it.id}/transition`, { to: 'pending_approval', version: it.version });
  assert.equal(r.status, 200); it = r.body;
  r = await t.as('carol')('POST', `/items/${it.id}/transition`, { to: 'resolved', version: it.version });
  assert.equal(r.status, 403); // member can't approve
  // make carol a lead-assignee scenario: lead who owns the work still can't approve it
  t.db.prepare("UPDATE memberships SET role='lead' WHERE user_id=? AND team_id=?").run(t.users.carol, t.team('Engineering'));
  assert.match((await t.as('carol')('POST', `/items/${it.id}/transition`, { to: 'resolved', version: it.version })).body.error.message, /own work/);
  r = await t.as('bob')('POST', `/items/${it.id}/transition`, { to: 'resolved', version: it.version });
  assert.equal(r.status, 200); assert.equal(r.body.approved_by, t.users.bob);
  assert.equal((await t.as('bob')('POST', `/items/${it.id}/transition`, { to: 'in_progress', version: r.body.version })).status, 409); // invalid
  assert.deepEqual(events(it.id).filter((e) => e !== 'comment'), ['item.created', 'item.claimed', 'item.status', 'item.status']);
  t.db.prepare("UPDATE memberships SET role='member' WHERE user_id=? AND team_id=?").run(t.users.carol, t.team('Engineering'));
});

test('WORKFLOW: rejecting approval requires a reason', async () => {
  let it = await t.mk('carol', { requiresApproval: true });
  it = (await t.as('carol')('POST', `/items/${it.id}/claim`, {})).body;
  it = (await t.as('carol')('POST', `/items/${it.id}/transition`, { to: 'pending_approval', version: it.version })).body;
  assert.equal((await t.as('bob')('POST', `/items/${it.id}/transition`, { to: 'in_progress', version: it.version })).status, 400);
  assert.equal((await t.as('bob')('POST', `/items/${it.id}/transition`, { to: 'in_progress', version: it.version, note: 'missing evidence' })).status, 200);
});

test('HISTORY: comments & actions appear in order with actor; events API paginates', async () => {
  const it = await t.mk('bob');
  for (let i = 0; i < 5; i++) await t.as('carol')('POST', `/items/${it.id}/comments`, { body: `c${i}` });
  const p1 = (await t.as('bob')('GET', `/items/${it.id}/events?limit=3`)).body;
  assert.equal(p1.events.length, 3); assert.ok(p1.nextBefore);
  const p2 = (await t.as('bob')('GET', `/items/${it.id}/events?limit=3&before=${p1.nextBefore}`)).body;
  assert.equal(p2.events.length, 3); assert.equal(p2.nextBefore, null);
  assert.equal(p1.events[0].data.body, 'c4'); assert.equal(p1.events[0].actor_name, 'Carol Dev');
});

test('LISTING: keyset pagination has no duplicates/gaps; FTS search + view filters work', async () => {
  for (let i = 0; i < 12; i++) await t.mk('bob', { title: `Pagination zebra ${i}` });
  const seen = []; let cursor = null;
  do {
    const r = (await t.as('bob')('GET', `/items?q=zebra&limit=5${cursor ? `&cursor=${cursor}` : ''}`)).body;
    seen.push(...r.items.map((i) => i.id)); cursor = r.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 12); assert.equal(new Set(seen).size, 12);
  assert.ok((await t.as('bob')('GET', '/items?q=zeb')).body.items.length > 0, 'prefix search');
  assert.equal((await t.as('bob')('GET', '/items?view=bogus')).status, 400);
  const dash = (await t.as('bob')('GET', '/dashboard')).body;
  const urgent = (await t.as('bob')('GET', '/items?view=unassigned_urgent&limit=100')).body.items;
  assert.equal(dash.unassigned_urgent, urgent.length, 'dashboard count == list for same view');
});

test('ASYNC: notifications are created by the worker, idempotently, only for members, never for the actor', async () => {
  const it = await t.mk('bob');
  await t.as('carol')('POST', `/items/${it.id}/comments`, { body: 'ping' });
  const w = createWorker(t.db);
  w.runOnce(); w.runOnce();
  const n = t.db.prepare('SELECT * FROM notifications WHERE item_id=?').all(it.id);
  assert.deepEqual(n.map((x) => x.user_id), [t.users.bob]); // creator notified, actor (carol) not
  // re-running the same job must not duplicate
  t.db.prepare("UPDATE outbox SET status='pending', locked_until=NULL WHERE kind='notify'").run();
  w.runOnce();
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM notifications WHERE item_id=?').get(it.id).c, 1);
});

test('ASYNC: failing job is retried with backoff, then dead-lettered; crashed worker lease expires', async () => {
  let clock = 1_000_000, calls = 0;
  const now = () => clock;
  t.db.prepare("INSERT INTO outbox(kind,payload,next_run_at,created_at) VALUES ('flaky','{}',?,?)").run(clock, clock);
  const id = t.db.prepare("SELECT MAX(id) m FROM outbox").get().m;
  const w = createWorker(t.db, { now, handlers: { flaky() { calls++; if (calls < 3) throw new Error('boom'); } } });
  w.runOnce();
  let row = t.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
  assert.equal(row.status, 'pending'); assert.ok(row.next_run_at > clock); assert.equal(row.last_error, 'boom');
  assert.equal(w.runOnce().claimed, 0, 'not retried before backoff elapses');
  clock += 10_000; w.runOnce(); clock += 10_000; w.runOnce();
  assert.equal(t.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status, 'done');
  // poison job -> dead
  t.db.prepare("INSERT INTO outbox(kind,payload,next_run_at,created_at) VALUES ('poison','{}',?,?)").run(clock, clock);
  const pid = t.db.prepare("SELECT MAX(id) m FROM outbox").get().m;
  const w2 = createWorker(t.db, { now, handlers: { poison() { throw new Error('nope'); } } });
  for (let i = 0; i < MAX_ATTEMPTS; i++) { w2.runOnce(); clock += 10 * 60_000; }
  assert.equal(t.db.prepare('SELECT status FROM outbox WHERE id=?').get(pid).status, 'dead');
  // crash: claimed (leased) but never acked -> picked up again after lease expiry
  t.db.prepare("INSERT INTO outbox(kind,payload,next_run_at,locked_until,created_at) VALUES ('flaky','{}',?,?,?)").run(clock, clock + 30_000, clock);
  assert.equal(w.runOnce().claimed, 0);
  clock += 31_000; assert.equal(w.runOnce().ok, 1);
});

test('ATOMICITY: state change and its history/outbox rows commit together (rollback leaves nothing)', async () => {
  const it = await t.mk('bob');
  const before = { ev: events(it.id).length, ob: t.db.prepare('SELECT COUNT(*) c FROM outbox').get().c };
  t.db.exec("CREATE TRIGGER boom BEFORE INSERT ON outbox WHEN NEW.kind='notify' BEGIN SELECT RAISE(ABORT,'forced'); END");
  const r = await t.as('bob')('PATCH', `/items/${it.id}`, { version: it.version, title: 'should roll back' });
  t.db.exec('DROP TRIGGER boom');
  assert.equal(r.status, 500);
  assert.equal(t.db.prepare('SELECT title, version FROM items WHERE id=?').get(it.id).title, 'Test item');
  assert.equal(events(it.id).length, before.ev);
});

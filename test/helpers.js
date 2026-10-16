const { openDb } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

async function boot() {
  const db = openDb(); seed(db);
  const app = createApp(db);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const raw = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  const tokens = {};
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'])
    tokens[n] = (await raw('POST', '/login', { body: { email: `${n}@example.com`, password: 'password' } })).body.token;
  let k = 0;
  const as = (who) => (method, path, body, headers) => raw(method, path, { token: tokens[who], body, headers });
  const users = Object.fromEntries(db.prepare('SELECT id, email FROM users').all().map((u) => [u.email.split('@')[0], u.id]));
  const team = (name) => db.prepare('SELECT id FROM teams WHERE name=?').get(name).id;
  // creates an item through the real API
  const mk = async (who, over = {}) => (await as(who)('POST', '/items', { teamId: team('Engineering'), title: 'Test item', ...over }, { 'Idempotency-Key': `k${++k}-${Math.random()}` })).body;
  return { db, app, server, raw, as, users, team, mk, close: () => server.close() };
}
module.exports = { boot };

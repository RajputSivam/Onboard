const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { HttpError } = require('./errors');
const { createAuth } = require('./auth');
const { createService } = require('./service');
const { createHub } = require('./hub');

function createApp(db, { now = Date.now } = {}) {
  const hub = createHub();
  const publish = { team: hub.publishTeam, users: hub.publishUsers };
  const svc = createService(db, { now, publish });
  const auth = createAuth(db, now);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // ---- auth middleware -----------------------------------------------------
  const requireAuth = (req, _res, next) => {
    const h = req.get('Authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.path === '/stream' ? req.query.token : null);
    const user = auth.userFromToken(token);
    if (!user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in'));
    req.user = user; next();
  };

  // ---- idempotent mutation wrapper -----------------------------------------
  // Same (user, Idempotency-Key, body) => original response is replayed, nothing re-executes.
  // Same key with a different body => 422. Only successful responses are stored (failures may be retried).
  const mutating = (handler, { requireKey = false, status = 200 } = {}) => (req, res, next) => {
    try {
      const key = req.get('Idempotency-Key');
      if (requireKey && !key) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
      if (key && key.length > 100) throw new HttpError(400, 'VALIDATION', 'Idempotency-Key too long');
      const hash = crypto.createHash('sha256').update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`).digest('hex');
      const out = svc.run(() => {
        if (key) {
          const row = db.prepare('SELECT * FROM idempotency_keys WHERE user_id=? AND key=?').get(req.user.id, key);
          if (row) {
            if (row.request_hash !== hash) throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was already used for a different request');
            return { status: row.status, body: JSON.parse(row.response), replay: true };
          }
        }
        const body = handler(req);
        if (key) db.prepare('INSERT INTO idempotency_keys(user_id,key,request_hash,status,response,created_at) VALUES (?,?,?,?,?,?)')
          .run(req.user.id, key, hash, status, JSON.stringify(body), now());
        return { status, body };
      });
      if (out.replay) res.set('Idempotent-Replay', 'true');
      res.status(out.status).json(out.body);
    } catch (e) { next(e); }
  };
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw new HttpError(400, 'VALIDATION', 'Bad id'); return n; };

  // ---- routes ----------------------------------------------------------------
  const api = express.Router();
  api.post('/login', (req, res, next) => { try { res.json(auth.login(req.body?.email, req.body?.password)); } catch (e) { next(e); } });
  api.use(requireAuth);

  api.get('/me', (req, res) => res.json({ user: req.user, teams: svc.memberships(req.user.id) }));
  api.get('/dashboard', (req, res) => res.json(svc.dashboard(req.user.id)));
  api.get('/teams/:id/members', (req, res) => res.json({ members: svc.members(req.user.id, id(req)) }));
  api.put('/teams/:id/members/:userId', mutating((req) => svc.setMemberRole(req.user.id, id(req), Number(req.params.userId), req.body?.role)));

  api.get('/items', (req, res) => res.json(svc.listItems(req.user.id, req.query)));
  api.post('/items', mutating((req) => svc.createItem(req.user.id, req.body || {}), { requireKey: true, status: 201 }));
  api.get('/items/:id', (req, res) => res.json(svc.getItem(req.user.id, id(req))));
  api.patch('/items/:id', mutating((req) => svc.updateItem(req.user.id, id(req), req.body || {})));
  api.post('/items/:id/claim', mutating((req) => svc.claim(req.user.id, id(req), req.body?.version)));
  api.post('/items/:id/release', mutating((req) => svc.release(req.user.id, id(req), req.body?.version)));
  api.post('/items/:id/assign', mutating((req) => svc.assign(req.user.id, id(req), req.body || {})));
  api.post('/items/:id/transition', mutating((req) => svc.transition(req.user.id, id(req), req.body || {})));
  api.post('/items/:id/comments', mutating((req) => svc.addComment(req.user.id, id(req), req.body?.body), { status: 201 }));
  api.get('/items/:id/events', (req, res) => res.json(svc.listEvents(req.user.id, id(req), { before: req.query.before ? Number(req.query.before) : undefined, limit: req.query.limit })));

  api.get('/notifications', (req, res) => res.json(svc.notifications(req.user.id)));
  api.post('/notifications/read', (req, res) => res.json({ marked: svc.markRead(req.user.id) }));

  api.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    hub.add(res, req.user.id, svc.memberships(req.user.id).map((m) => m.team_id));
  });

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Unknown endpoint')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
  app.hub = hub; app.svc = svc;
  return app;
}
module.exports = { createApp };

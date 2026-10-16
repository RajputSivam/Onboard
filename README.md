# OpsBoard — Operations Under Pressure

Internal web app for coordinating operational work across teams: ownership, workflow with approvals, full history, realtime updates.

## Run
```bash
npm install
npm start            # http://localhost:3000   (creates ./data/opsboard.db and seeds demo data)
npm test             # 16 automated tests (Node's built-in runner)
npm run seed:bulk    # optional, on a FRESH DB (delete ./data first): seeds demo data + 20k items, then run npm start
```
Requires Node 20+ (tested on 22). Env: `PORT`, `DB_FILE`.

**Demo users** (password `password`): `alice@` admin of all teams · `bob@` lead Engineering · `carol@` member Eng / lead Payments · `dave@` member Support · `erin@` viewer Eng · `frank@` lead Support.
Open two browsers as different users to see claim races, stale-edit banners and realtime updates.

## Try the critical behaviours
1. **Claim race:** as bob and carol, open the same unassigned Engineering item and click *Take ownership* at once → one wins; the other's UI rolls back and shows the winner.
2. **Stale edit:** bob clicks *Edit*; alice changes the item; bob sees a banner, and saving is rejected (409) without overwriting.
3. **Approval:** `requires approval` items cannot be resolved directly; owner requests approval; a *different* lead approves (owners can't approve their own work).
4. **Authz:** log in as dave and `curl` an Engineering item id → 404; as erin, comment → 403.

## Layout
```
src/policy.js   roles, permissions, workflow rules (single source of truth)
src/service.js  all business logic + SQL; transactions, versioning, listing/search
src/worker.js   transactional-outbox worker (retry, backoff, dead-letter, lease)
src/app.js      HTTP API, auth middleware, idempotency wrapper, SSE
src/db.js       schema + indexes + FTS5          src/seed.js  demo/bulk data
public/         no-build frontend                test/        critical-behaviour tests
```
## API (all under `/api`, Bearer token)
`POST /login` · `GET /me` · `GET /dashboard` · `GET /items?q&team&status&priority&assignee&view&cursor&limit` · `POST /items` (Idempotency-Key required) · `GET|PATCH /items/:id` · `POST /items/:id/{claim,release,assign,transition,comments}` · `GET /items/:id/events?before` · `GET /teams/:id/members` · `PUT /teams/:id/members/:userId` · `GET /notifications` · `POST /notifications/read` · `GET /stream` (SSE)

Errors: `{error:{code,message,current?}}`. `409` carries `current` (latest item) for client reconciliation.

## Known limitations
- SQLite = single writer, single node. The in-memory SSE hub and worker assume one process (the outbox itself is multi-worker safe via leases; SSE would need Redis pub/sub to fan out across nodes).
- Auth is simple (scrypt + opaque server-side sessions); no rate limiting/lockout, no MFA; SSE passes the token in the query string (use a cookie or short-lived stream ticket in production).
- Idempotency keys and `done` outbox rows are never purged (add a TTL job).
- Multi-team list sorting uses a temp B-tree on the merged result; fine at tens of thousands of items, but a per-team merge or denormalized feed would be next.
- Dashboard "stale" threshold (48h) is a constant; no SLA configuration, no email/Slack delivery yet.
- Frontend is vanilla JS without component tests; the UI was not browser-automation tested.
- Team/user administration UI is not built (role changes are API-only).

## With another week
PostgreSQL + Redis pub/sub, org/team admin UI, saved views & @mentions, SLA timers via a scheduled outbox job, e2e (Playwright) tests, per-endpoint rate limits, OpenTelemetry traces on the outbox.

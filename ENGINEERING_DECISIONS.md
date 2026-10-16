# Engineering Decisions

## Assumptions
- A *work item* is a unit of operational work owned by exactly one **team**. Cross-team visibility = membership in that team.
- Roles are **per team**: `viewer` (read) < `member` (create, comment, claim, edit own) < `lead` (assign, approve, set urgent, close, edit any) < `admin` (manage roles). One user can hold different roles in different teams.
- "Requires approval" is a flag on the item (e.g. refunds, compliance). Approval must come from a lead **who is not the owner**.
- Single-region, single-node deployment for v1; designed so the DB and worker can be split out later.

## 1. SQLite (WAL) + Node/Express, behind a thin service layer
**Why:** one-day build, zero setup (`npm i && npm start`), but with real transactions, partial/composite indexes and FTS5. All SQL lives in `service.js`; HTTP only does auth, parsing and idempotency.
**Trade-off:** SQLite has a single writer. At the stated scale (thousands of users, tens of thousands of active items) writes are tiny and short, so this is fine; at several-thousand concurrent *writers* I would move to PostgreSQL (`SELECT … FOR UPDATE SKIP LOCKED` for the outbox, `tsvector`/GIN for search, partitioned `events`). The transaction boundaries and conditional-UPDATE patterns below translate 1:1.

## 2. Concurrency: optimistic locking + atomic claim, enforced in the database transaction
- Every item has a `version`. Edits/assign/transition **must** send the version they saw (`428` if missing). The write is `UPDATE … WHERE id=? AND version=?`; a mismatch returns **409 with the current item**, so the UI can show what changed instead of silently overwriting.
- **Claim** (the "two people take the same work" case) is a single transaction: if already owned by someone else → `409 ALREADY_CLAIMED` (with current state); if already owned by the *caller* → no-op `200` (so a retry is safe). Exactly one winner, one history entry (tested with parallel requests).
- Comments are append-only and do **not** bump `version`, so chatting never invalidates someone's in-progress edit.
- Every write transaction is `BEGIN IMMEDIATE`, so correctness doesn't depend on JS being single-threaded; it survives multiple Node processes on the same DB.

## 3. Idempotency keys on all mutations (and required on create)
A client that isn't sure whether a request succeeded can repeat it. `Idempotency-Key` + user + request hash → the original response is replayed (`Idempotent-Replay: true`); same key with a different body → `422`. The key check, the business write and the key record are in **one transaction**, so 20 parallel identical creates produce exactly one item. Only successes are stored (a failed attempt can legitimately be retried). The frontend generates one key per user action and reuses it on its automatic network-error retry.

## 4. Authorization: one policy module, enforced server-side, 404 for non-members
`policy.js` is the single source of truth for both **enforcement** (service layer, inside the transaction, against the *current* row — never trusting client state) and **UI hints** (`item.allowed` is returned so the UI shows exactly what the server will accept). Non-members receive `404`, not `403`, so item existence doesn't leak; list/search/dashboard queries are always scoped to the caller's teams in SQL. Workflow rules (valid transitions, approval required, no self-approval, rejection needs a reason, only leads set *urgent*) live in the same module. Role changes are themselves audited, and the last admin can't be demoted.

## 5. History + async work via event log and transactional outbox
- `events` is an **append-only** table (comments are events too). Every state change writes its event in the same transaction as the change, so history can't diverge from state and "important actions don't silently disappear".
- Notifications are **asynchronous**: the same transaction also inserts an `outbox` row. A worker claims due rows with a lease, runs the handler, and acks in the same transaction as the effect. Delivery is **at-least-once**; the notify handler is **idempotent** (`UNIQUE(user_id,event_id)` + `INSERT OR IGNORE`). Failures retry with exponential backoff and become `dead` after 5 attempts; a crashed worker's lease expires and the job is re-run. (All tested with an injectable clock.)
- Realtime uses SSE as a *hint* ("item 42 changed to v7"); clients re-fetch authoritative state. A dropped message is harmless, and on reconnect the client resyncs.

## 6. Scale-minded read path
Server-side filtering, **keyset pagination** (`updated_at,id` cursor; no OFFSET), FTS5 prefix search, composite indexes, and a single-pass `SUM(CASE…)` dashboard query. The browser only ever holds the loaded pages. Measured on a 50k-item seed: every list/search/dashboard call < 50 ms locally.

## Frontend state management
One state object, server is the source of truth. **Optimistic** only where safe and cheap to reconcile: *claim* (rolled back to the winner's state on 409) and *comment* (shown as "sending…", "failed → Retry" with the same idempotency key). Edits are pessimistic and version-checked; if the item changes while you edit, your draft is preserved, you get a banner, and a conflicting save is rejected with the latest state shown rather than overwritten.

## What I intentionally did not build
SSO/MFA, rate limiting, file attachments, per-item watchers/@mentions, SLA timers, email/Slack delivery (the outbox handler is the seam), a React build pipeline, and tag/custom-field support.

# OnBoard

**A work-item coordination app for teams handling operational requests.**

OpsBoard replaces scattered chat messages, spreadsheets and email threads with a single system where every request has an owner, a status, a priority and a complete history. It was built for the *Newtonite Software Engineering Challenge — Operations Under Pressure*.

---

## Features

- **Work items** with title, description, priority, status, owner, due date and full history.
- **Teams and roles** (viewer, member, lead, admin). A user can have a different role in each team. Permissions are enforced on the server, not only in the UI.
- **Workflow:** `open → in_progress → pending_approval → resolved → closed`, with an optional approval step. Owners cannot approve their own work.
- **Collaboration:** comments and an append-only activity timeline for every change.
- **Concurrency safety:**
  - Atomic "take ownership": only one user can win.
  - Version checks on edits, so stale updates are rejected instead of overwriting.
  - Idempotency keys, so repeated requests never create duplicates.
- **Overview dashboard:** my active work, awaiting my approval, unassigned and urgent, overdue, stale.
- **Search and filters** (full-text search, status, priority, team, assignee) with cursor-based pagination.
- **Realtime updates** (Server-Sent Events) and in-app notifications.
- **Reliable background processing** via a transactional outbox (retries, backoff, dead-letter).

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js, Express 5 |
| Database | SQLite (WAL mode, FTS5 search) via `better-sqlite3` |
| Frontend | Vanilla JavaScript, HTML, CSS (no build step) |
| Realtime | Server-Sent Events |
| Tests | Node's built-in test runner |

## Getting started

### Prerequisites
- **Node.js 20 or 22 (LTS)**. Node 22 is recommended.
- On Windows with Node 24 or newer, `better-sqlite3` may need to compile and requires Visual Studio Build Tools with the Windows SDK. Using Node 22 LTS avoids this.

### Install and run
```bash
git clone https://github.com/RajputSivam/Onboard.git
cd Onboard
npm install
npm start
```
Open **http://localhost:3000**.

The database is created automatically at `data/opsboard.db` and seeded with demo data on first run.

To use another port:
```bash
# macOS / Linux
PORT=3001 npm start
# Windows PowerShell
$env:PORT=3001; npm start
```

### Demo accounts
Password for all accounts: `password`

| Email | Role |
|---|---|
| `alice@example.com` | Admin (all teams) |
| `bob@example.com` | Lead (Engineering) |
| `carol@example.com` | Member (Engineering), Lead (Payments) |
| `dave@example.com` | Member (Support) |
| `erin@example.com` | Viewer (Engineering) |
| `frank@example.com` | Lead (Support), Member (Payments) |

Tip: open two browsers (or one normal and one incognito window) with different users to see ownership races, stale-edit warnings and realtime updates.

### Optional: large dataset
To test with about 20,000 items, delete the `data/` folder and run:
```bash
npm run seed:bulk
npm start
```

### Run the tests
```bash
npm test
```
16 automated tests cover the behaviours that would be most dangerous if wrong.

## Try the key behaviours

1. **Ownership race:** as `bob` and `carol`, open the same unassigned Engineering item and click *Take ownership* at the same time. One wins; the other sees the winner.
2. **Stale edit:** start editing an item as `bob`, change it as `alice`, then save as `bob`. The save is rejected and the latest version is shown.
3. **Approval:** on an item that requires approval, the owner requests approval and a *different* lead approves it.
4. **Authorization:** as `erin` (viewer), commenting or claiming is rejected. As `dave`, Engineering items are not visible at all.

## Project structure

```
src/
  policy.js    Roles, permissions and workflow rules (single source of truth)
  service.js   Business logic, transactions, versioning, search and listing
  worker.js    Background job worker (transactional outbox)
  app.js       HTTP API, authentication, idempotency, realtime stream
  db.js        Schema, indexes, full-text search
  seed.js      Demo and bulk data
public/        Frontend (index.html, app.js, style.css)
test/          Automated tests
ENGINEERING_DECISIONS.md   Key design decisions and trade-offs
```

## Design overview

```
Browser ──► Express API ──► Service + Policy ──► SQLite
   ▲                              │
   │                              ├─► events (append-only history)
   └──── SSE ◄────────────────────┴─► outbox ──► worker ──► notifications
```

Every state change runs in one database transaction that updates the item, writes its history event and queues any follow-up work. Side effects such as notifications run afterwards in a worker and are safe to retry. See [ENGINEERING_DECISIONS.md](ENGINEERING_DECISIONS.md) for the reasoning behind each choice.

## API summary

All endpoints are under `/api` and use a Bearer token (except login).

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/login` | Sign in |
| GET | `/me` | Current user and team roles |
| GET | `/dashboard` | Attention counts |
| GET | `/items` | List and search (`q`, `team`, `status`, `priority`, `assignee`, `view`, `cursor`, `limit`) |
| POST | `/items` | Create (requires `Idempotency-Key`) |
| GET / PATCH | `/items/:id` | Read / update (requires `version`) |
| POST | `/items/:id/claim` | Take ownership |
| POST | `/items/:id/release` | Release ownership |
| POST | `/items/:id/assign` | Assign (leads) |
| POST | `/items/:id/transition` | Change status |
| POST | `/items/:id/comments` | Add a comment |
| GET | `/items/:id/events` | Item history |
| GET / PUT | `/teams/:id/members` | List members / change role (admins) |
| GET / POST | `/notifications`, `/notifications/read` | Notifications |
| GET | `/stream` | Realtime events (SSE) |

Errors use the format `{ "error": { "code", "message", "current?" } }`. A `409` response includes the latest item so the client can reconcile.

## Known limitations

- SQLite allows a single writer and this version runs on a single node. For larger scale I would move to PostgreSQL, with Redis pub/sub for realtime fan-out.
- Authentication is basic (hashed passwords and server-side sessions). There is no rate limiting, lockout or MFA, and the SSE stream takes its token as a query parameter.
- Idempotency keys and completed outbox rows are not purged yet.
- Team and user administration has no UI; role changes are available through the API only.
- The frontend has no automated browser tests.
- Notifications are in-app only; email or chat delivery is not implemented (the outbox handler is the extension point).

## What I would do next

- Migrate to PostgreSQL and add Redis for multi-node realtime.
- Build an admin UI for teams and roles.
- Add SLA timers, saved views and @mentions.
- Add end-to-end tests (Playwright) and rate limiting.

## License

MIT

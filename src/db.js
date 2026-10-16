const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id), team_id INTEGER NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id));
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','pending_approval','resolved','closed')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  assignee_id INTEGER REFERENCES users(id), creator_id INTEGER NOT NULL REFERENCES users(id),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by INTEGER REFERENCES users(id), approved_at INTEGER,
  due_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,            -- optimistic concurrency token
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_team_updated ON items(team_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_team_status  ON items(team_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_assignee     ON items(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_items_due          ON items(due_at) WHERE due_at IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, description);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, description) VALUES (new.id, new.title, new.description); END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, description ON items BEGIN
  DELETE FROM items_fts WHERE rowid = old.id;
  INSERT INTO items_fts(rowid, title, description) VALUES (new.id, new.title, new.description); END;

-- Append-only history (also holds comments). Never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES items(id), team_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id, id DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id INTEGER NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
  status INTEGER NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key));

-- Transactional outbox: rows are written in the SAME transaction as the state change.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL, locked_until INTEGER,
  last_error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_run_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL, message TEXT NOT NULL, read_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (user_id, event_id));                    -- makes the notify job idempotent
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id DESC);
`;

function openDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
module.exports = { openDb };

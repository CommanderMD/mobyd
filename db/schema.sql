-- MOBY-D D1 schema v1. Separate `mobyd` D1 (isolated from helix-ai). Apply: wrangler d1 execute mobyd --file=db/schema.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,          -- ULID from the sender; idempotency key
  type        TEXT NOT NULL,                 -- job.state | heartbeat | decision | memory.index | session.turn | approval | proposal | session.conflict
  job_id      TEXT,
  state       TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',    -- JSON
  sender      TEXT NOT NULL CHECK (sender IN ('mac','cloud')),
  ts          TEXT NOT NULL,                 -- RFC 3339 from the sender
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS events_type_id ON events(type, id);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id);

CREATE TABLE IF NOT EXISTS jobs (
  job_id      TEXT PRIMARY KEY,              -- ULID
  action      TEXT NOT NULL,                 -- must exist in actions.json on the Mac
  params      TEXT NOT NULL DEFAULT '{}',    -- JSON
  risk        TEXT NOT NULL,                 -- read_only | writes_files | spends_money | touches_prod | irreversible
  state       TEXT NOT NULL CHECK (state IN ('proposed','approved','denied','running','done','failed','expired')),
  proposed_by TEXT NOT NULL,                 -- mac | cloud | commander
  decided_by  TEXT,                          -- owner telegram id, when approved/denied
  result      TEXT,                          -- JSON: {exit, stdout_tail, stderr_tail, ms}
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeats (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  host      TEXT NOT NULL,
  ts        TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT '{}'       -- JSON: {disk_free_gb, load, open_jobs, nemo_loaded}
);
CREATE INDEX IF NOT EXISTS heartbeats_ts ON heartbeats(ts);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id        TEXT PRIMARY KEY,       -- ULID
  event_ref          TEXT,                   -- the inbound event this decided on
  state_hash         TEXT NOT NULL,          -- sha256 of the JSON state NEMO saw (never the raw state)
  intent             TEXT NOT NULL, intent_p REAL NOT NULL,
  risk               TEXT NOT NULL, risk_p   REAL NOT NULL,
  needs_rag          REAL NOT NULL,
  complexity         REAL NOT NULL,          -- 0..1
  requires_approval  REAL NOT NULL,
  policy_rule        TEXT,                   -- id of the rule that fired
  outcome            TEXT NOT NULL,          -- blocked | approval_requested | ran | tier3
  owner_override     TEXT,                   -- approve | deny | null  (the training label)
  ts                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_index (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,          -- path in mobyd-shared
  kind        TEXT NOT NULL,                 -- note | lesson | file
  source      TEXT,                          -- JSON {author,title,chapter} for lessons; required when kind='lesson'
  ts          TEXT NOT NULL,
  CHECK (kind != 'lesson' OR source IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sessions (
  owner_id         TEXT PRIMARY KEY,         -- owner telegram id
  active_thread_id TEXT,
  last_turns       TEXT NOT NULL DEFAULT '[]', -- JSON, last 20 turns, <= 12k chars
  open_task        TEXT,
  working_files    TEXT NOT NULL DEFAULT '[]', -- JSON array of paths
  updated_by       TEXT NOT NULL CHECK (updated_by IN ('mac','cloud')),
  updated_at       TEXT NOT NULL
);

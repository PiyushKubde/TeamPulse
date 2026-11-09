-- Durable post-commit work: every event that triggers notifications or sends is written here first and marked done
-- only after all its handlers finished. Pending rows are replayed after a restart (handlers are idempotent).
CREATE TABLE event_outbox (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX event_outbox_pending ON event_outbox(status, created_at);

-- Backups made by the app (local verified copies; off-host encrypted copies in Embarko file storage).
CREATE TABLE backups (
  id           TEXT PRIMARY KEY,
  file         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  rows_summary TEXT NOT NULL,
  offsite_id   TEXT,
  offsite_status TEXT NOT NULL DEFAULT 'none' CHECK (offsite_status IN ('none','uploaded','failed','not_configured')),
  offsite_error TEXT,
  created_at   TEXT NOT NULL
);

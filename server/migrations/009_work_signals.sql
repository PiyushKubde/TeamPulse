-- Final sprint: proactive work signals (stalled work, approaching deadlines, unresolved blockers, repeated rework,
-- unverified impact, missing evidence, possible duplicate effort, unlinked completed work, reviews waiting).
-- Detected by deterministic rules; a signal is help to act, never a performance penalty. Additive only.
CREATE TABLE work_signals (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  related_id      TEXT,
  reason          TEXT NOT NULL,
  evidence_json   TEXT NOT NULL DEFAULT '[]',
  suggested_action TEXT NOT NULL,
  audience        TEXT NOT NULL CHECK (audience IN ('person','managers','both')),
  status          TEXT NOT NULL CHECK (status IN ('OPEN','DISMISSED','RESOLVED')),
  dedupe_key      TEXT NOT NULL UNIQUE,
  history_json    TEXT NOT NULL DEFAULT '[]',
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  resolved_at     TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX work_signals_org ON work_signals(org_id, status, severity);
CREATE INDEX work_signals_subject ON work_signals(subject_user_id, status);

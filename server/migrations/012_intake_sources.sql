-- foreign_keys: off
-- Task intake sources become a registry (server/automations/sources). The only schema change: intake_subscriptions.app may now also be 'teams'
-- (Microsoft Teams channel messages). SQLite cannot alter a CHECK, so the table is rebuilt (the documented 12-step procedure): every existing row is
-- copied unchanged, no column is added or dropped, and the index is recreated. slack_intake_items keeps pointing at the same table name.

CREATE TABLE intake_subscriptions_new (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id        TEXT REFERENCES teams(id) ON DELETE SET NULL,
  app            TEXT NOT NULL CHECK (app IN ('gmail','slack','teams')),
  connection_id  TEXT REFERENCES app_connections(id) ON DELETE SET NULL,
  trigger_key    TEXT NOT NULL,
  version        TEXT NOT NULL,
  script_id      TEXT,
  input_data     TEXT NOT NULL DEFAULT '{}',
  target_label   TEXT,
  token_hash     TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','FAILED','DELETED')),
  last_event_at  TEXT,
  last_error     TEXT,
  events_received INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  assign_from_mentions INTEGER NOT NULL DEFAULT 0
);

INSERT INTO intake_subscriptions_new (id, org_id, owner_id, team_id, app, connection_id, trigger_key, version, script_id, input_data, target_label, token_hash, status, last_event_at, last_error, events_received, created_at, updated_at, assign_from_mentions)
  SELECT id, org_id, owner_id, team_id, app, connection_id, trigger_key, version, script_id, input_data, target_label, token_hash, status, last_event_at, last_error, events_received, created_at, updated_at, assign_from_mentions
  FROM intake_subscriptions;

DROP TABLE intake_subscriptions;
ALTER TABLE intake_subscriptions_new RENAME TO intake_subscriptions;
CREATE INDEX intake_subscriptions_owner ON intake_subscriptions(org_id, owner_id, status);

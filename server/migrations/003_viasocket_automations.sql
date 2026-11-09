-- foreign_keys: off
-- viaSocket automations per person: one automation per owner (not per organization), personal notification
-- preferences, Gmail/Slack intake subscriptions, and context flows built in the embedded builder.

CREATE TABLE automation_workflows_new (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  use_case_key  TEXT NOT NULL REFERENCES automation_use_cases(key),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','NEEDS_SETUP','FAILED')),
  config        TEXT NOT NULL DEFAULT '{}',
  last_run_at   TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (org_id, use_case_key, owner_id)
);
INSERT INTO automation_workflows_new SELECT id, org_id, use_case_key, owner_id, status, config, last_run_at, last_error, created_at, updated_at FROM automation_workflows;
DROP TABLE automation_workflows;
ALTER TABLE automation_workflows_new RENAME TO automation_workflows;
CREATE INDEX automation_workflows_org ON automation_workflows(org_id, use_case_key, status);

-- A1: how one person wants to hear about their own task events (their own connection).
CREATE TABLE notification_prefs (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL DEFAULT 'none' CHECK (channel IN ('none','slack','gmail')),
  connection_id TEXT REFERENCES app_connections(id) ON DELETE SET NULL,
  slack_mode    TEXT CHECK (slack_mode IN ('user','channel')),
  slack_target  TEXT,
  slack_label   TEXT,
  events        TEXT NOT NULL DEFAULT '["task_assigned"]',
  updated_at    TEXT NOT NULL
);

-- C: a manager's Gmail/Slack subscription that turns incoming messages into pending task requests.
-- script_id is a credential (server only). Only the hash of the handler's bearer token is stored.
CREATE TABLE intake_subscriptions (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id        TEXT REFERENCES teams(id) ON DELETE SET NULL,
  app            TEXT NOT NULL CHECK (app IN ('gmail','slack')),
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
  updated_at     TEXT NOT NULL
);
CREATE INDEX intake_subscriptions_owner ON intake_subscriptions(org_id, owner_id, status);

-- D: flows a user built from a TeamPulse context (e.g. "task assigned to me" → Google Calendar). webhook_url is read
-- back from viaSocket (never from the browser) and is a credential: server only.
ALTER TABLE embed_flows ADD COLUMN context TEXT;
ALTER TABLE embed_flows ADD COLUMN app TEXT;
ALTER TABLE embed_flows ADD COLUMN webhook_url TEXT;

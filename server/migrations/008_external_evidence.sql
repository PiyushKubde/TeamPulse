-- Sprint 2: external work evidence (GitHub, Slack, Gmail, Google Calendar, Google Sheets) collected through viaSocket
-- triggers on each person's own connection. Additive only: no existing table changes.
-- Collection is not evaluation: evidence is stored and matched to tasks; nothing is assessed without a person asking.

-- Who a person is in each app (GitHub login, Slack user id, email). One owner per identity per organization, so
-- nobody can claim another person's commits or messages. source: 'connection' (read from their own connected
-- account) or 'declared' (entered by them, visible to their manager).
CREATE TABLE external_identities (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app        TEXT NOT NULL CHECK (app IN ('github','slack','gmail','google-calendar','google-sheets')),
  identity   TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('connection','declared')),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, app, identity)
);
CREATE INDEX external_identities_user ON external_identities(user_id, app);

-- One collection scope chosen by a person on their own connection: a repository, Slack channels, a Gmail label,
-- calendars, or one sheet. checkpoint = newest event time seen (older replays are not re-counted).
CREATE TABLE evidence_sources (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app             TEXT NOT NULL CHECK (app IN ('github','slack','gmail','google-calendar','google-sheets')),
  connection_id   TEXT REFERENCES app_connections(id) ON DELETE SET NULL,
  scope_json      TEXT NOT NULL,
  scope_label     TEXT NOT NULL,
  kinds_json      TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','NEEDS_RECONNECT','FAILED','DELETED')),
  checkpoint      TEXT,
  events_received INTEGER NOT NULL DEFAULT 0,
  last_event_at   TEXT,
  last_success_at TEXT,
  last_health_at  TEXT,
  last_error      TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX evidence_sources_owner ON evidence_sources(org_id, owner_id, status);

-- One viaSocket trigger flow per source and event kind. script_id is a credential (server only); only the hash of
-- the handler's bearer token is stored.
CREATE TABLE evidence_subscriptions (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES evidence_sources(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  version     TEXT NOT NULL,
  script_id   TEXT,
  input_data  TEXT NOT NULL DEFAULT '{}',
  token_hash  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','DELETED')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX evidence_subscriptions_source ON evidence_subscriptions(source_id);

-- Raw events as delivered, kept until processed (retry queue). payload_hash dedupes redelivery of the same event.
CREATE TABLE evidence_inbox (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES evidence_subscriptions(id) ON DELETE CASCADE,
  method          TEXT NOT NULL CHECK (method IN ('trigger','initial_sample')),
  payload         TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  result          TEXT,
  received_at     TEXT NOT NULL,
  processed_at    TEXT,
  UNIQUE (subscription_id, payload_hash)
);
CREATE INDEX evidence_inbox_status ON evidence_inbox(status, received_at);

-- Normalized evidence: one row per external event per organization (the same commit seen by two people's sources is
-- stored once). actor_user_id is set only through a known identity; attribution says how sure that is.
CREATE TABLE external_evidence (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id      TEXT REFERENCES evidence_sources(id) ON DELETE SET NULL,
  collector_id   TEXT NOT NULL REFERENCES users(id),
  connection_id  TEXT,
  app            TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  actor_identity TEXT,
  actor_user_id  TEXT REFERENCES users(id),
  attribution    TEXT NOT NULL CHECK (attribution IN ('self','member','external','unknown','disputed')),
  occurred_at    TEXT NOT NULL,
  title          TEXT,
  content        TEXT,
  resource_ref   TEXT,
  source_url     TEXT,
  parent_ref     TEXT,
  verification   TEXT NOT NULL CHECK (verification IN ('system_recorded','self_reported','reported_figure')),
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  method         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted','cancelled','inaccessible','removed_by_owner')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (org_id, app, external_id)
);
CREATE INDEX external_evidence_actor ON external_evidence(org_id, actor_user_id, occurred_at);
CREATE INDEX external_evidence_collector ON external_evidence(org_id, collector_id, occurred_at);
CREATE INDEX external_evidence_resource ON external_evidence(org_id, app, resource_ref);

-- Evidence ↔ task. contributor_id = whose contribution this evidence shows (never assumed to be the task owner).
-- status: suggested (by rules or AI) → confirmed / rejected by a person. share: individual | shared.
CREATE TABLE evidence_task_links (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  evidence_id    TEXT NOT NULL REFERENCES external_evidence(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  contributor_id TEXT REFERENCES users(id),
  method         TEXT NOT NULL CHECK (method IN ('explicit_ref','resource_ref','text_time','ai','manual')),
  confidence     REAL NOT NULL,
  explanation    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('suggested','confirmed','rejected')),
  share          TEXT NOT NULL DEFAULT 'individual' CHECK (share IN ('individual','shared')),
  decided_by     TEXT REFERENCES users(id),
  decided_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (evidence_id, task_id)
);
CREATE INDEX evidence_task_links_task ON evidence_task_links(task_id, status);

-- Collection history: subscriptions, initial samples, event processing, health checks.
CREATE TABLE evidence_sync_runs (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id   TEXT REFERENCES evidence_sources(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('subscribe','initial_sample','events','retry','health')),
  status      TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','PARTIAL')),
  items       INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX evidence_sync_runs_source ON evidence_sync_runs(source_id, started_at);

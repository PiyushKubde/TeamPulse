-- TeamPulse schema v1. UUID text primary keys, ISO-8601 UTC timestamps, organization scoping on every record.
-- Applied by server/migrate.js in a transaction and recorded in schema_migrations.

CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,
  settings    TEXT NOT NULL DEFAULT '{}',
  intake_token_hash TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  google_sub     TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name           TEXT NOT NULL,
  picture_url    TEXT,
  phone          TEXT,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX users_email ON users(lower(email));

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  manager_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (org_id, name)
);
CREATE INDEX teams_manager ON teams(org_id, manager_id);

-- One organization per user in this MVP (UNIQUE user_id).
CREATE TABLE memberships (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin','manager','employee')),
  team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  title       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX memberships_org ON memberships(org_id, role, status);
CREATE INDEX memberships_team ON memberships(team_id);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','manager','employee')),
  team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  accepted_by TEXT REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX invitations_email ON invitations(lower(email), status);
CREATE INDEX invitations_org ON invitations(org_id, status);

CREATE TABLE join_requests (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  decided_by  TEXT REFERENCES users(id),
  decided_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX join_requests_one_pending ON join_requests(user_id) WHERE status = 'pending';
CREATE INDEX join_requests_org ON join_requests(org_id, status);

CREATE TABLE employee_permissions (
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_create_tasks    INTEGER NOT NULL DEFAULT 0,
  can_create_directly INTEGER NOT NULL DEFAULT 0,
  can_self_assign     INTEGER NOT NULL DEFAULT 0,
  can_assign_others   INTEGER NOT NULL DEFAULT 0,
  approval_required   INTEGER NOT NULL DEFAULT 1,
  updated_by          TEXT REFERENCES users(id),
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  expected_outcome TEXT,
  created_by       TEXT NOT NULL REFERENCES users(id),
  assignee_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  priority         TEXT NOT NULL CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status           TEXT NOT NULL CHECK (status IN ('SUGGESTED','ASSIGNED','IN_PROGRESS','BLOCKED','SUBMITTED_FOR_REVIEW','COMPLETED','CANCELLED')),
  progress         INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  start_date       TEXT,
  due_at           TEXT,
  links            TEXT NOT NULL DEFAULT '[]',
  source_request_id TEXT,
  assigned_at      TEXT,
  started_at       TEXT,
  last_progress_at TEXT,
  status_changed_at TEXT NOT NULL,
  submitted_at     TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX tasks_org_status ON tasks(org_id, status);
CREATE INDEX tasks_assignee ON tasks(org_id, assignee_id, status);
CREATE INDEX tasks_team ON tasks(org_id, team_id);
CREATE INDEX tasks_due ON tasks(org_id, due_at);

CREATE TABLE task_requests (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id               TEXT REFERENCES teams(id) ON DELETE SET NULL,
  requested_by          TEXT REFERENCES users(id),
  source                TEXT NOT NULL DEFAULT 'internal' CHECK (source IN ('internal','external')),
  external_requester    TEXT,
  external_ref          TEXT,
  title                 TEXT NOT NULL,
  description           TEXT,
  reason                TEXT,
  expected_outcome      TEXT,
  suggested_priority    TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (suggested_priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  suggested_due_at      TEXT,
  suggested_assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CLARIFICATION_REQUESTED','WITHDRAWN')),
  decision_note         TEXT,
  decided_by            TEXT REFERENCES users(id),
  decided_at            TEXT,
  task_id               TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX task_requests_org ON task_requests(org_id, status);
CREATE INDEX task_requests_by ON task_requests(requested_by);
CREATE UNIQUE INDEX task_requests_external_ref ON task_requests(org_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE task_events (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   TEXT REFERENCES users(id),
  type       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events(task_id, created_at);
CREATE INDEX task_events_org ON task_events(org_id, created_at);

CREATE TABLE blockers (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reported_by         TEXT NOT NULL REFERENCES users(id),
  description         TEXT NOT NULL,
  dependency_owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  dependency_note     TEXT,
  is_external         INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  reported_at         TEXT NOT NULL,
  resolved_at         TEXT,
  resolved_by         TEXT REFERENCES users(id),
  resolution_note     TEXT,
  escalated_at        TEXT
);
CREATE INDEX blockers_task ON blockers(task_id, status);
CREATE INDEX blockers_org ON blockers(org_id, status);

CREATE TABLE completion_submissions (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submitted_by TEXT NOT NULL REFERENCES users(id),
  summary      TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','CHANGES_REQUESTED')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX completion_submissions_task ON completion_submissions(task_id, created_at);

CREATE TABLE impact_records (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id),
  task_id             TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  category            TEXT NOT NULL CHECK (category IN ('REVENUE_GROWTH','CUSTOMER_EXPERIENCE','TIME_SAVED','RELIABILITY','COST_REDUCTION','OPERATIONAL_EFFICIENCY','KNOWLEDGE_INNOVATION')),
  outcome_type        TEXT NOT NULL DEFAULT 'DELIVERED' CHECK (outcome_type IN ('DELIVERED','PREVENTION','RESEARCH','LEARNING')),
  previous_state      TEXT NOT NULL,
  work_performed      TEXT NOT NULL,
  result              TEXT NOT NULL,
  value_type          TEXT NOT NULL DEFAULT 'NONE' CHECK (value_type IN ('MEASURED','ESTIMATED','NONE')),
  measurable_value    REAL,
  measurement_unit    TEXT,
  is_reusable         INTEGER NOT NULL DEFAULT 0,
  is_quality          INTEGER NOT NULL DEFAULT 0,
  shared_outcome_key  TEXT,
  contributors        TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED')),
  verified_by         TEXT REFERENCES users(id),
  verified_at         TEXT,
  rejection_reason    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX impact_records_user ON impact_records(org_id, user_id, created_at);
CREATE INDEX impact_records_status ON impact_records(org_id, verification_status);

-- Links and uploaded files attached to a task, a completion submission or an impact record.
CREATE TABLE evidence (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('task','submission','impact')),
  owner_id    TEXT NOT NULL,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('link','file')),
  url         TEXT,
  label       TEXT,
  file_name   TEXT,
  mime_type   TEXT,
  size_bytes  INTEGER,
  storage_key TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX evidence_owner ON evidence(owner_type, owner_id);

CREATE TABLE manager_reviews (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('submission','impact')),
  subject_id   TEXT NOT NULL,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_id  TEXT NOT NULL REFERENCES users(id),
  decision     TEXT NOT NULL CHECK (decision IN ('APPROVED','CHANGES_REQUESTED','VERIFIED','REJECTED')),
  comment      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX manager_reviews_subject ON manager_reviews(subject_type, subject_id);

CREATE TABLE reflections (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  contribution TEXT,
  change_made  TEXT,
  blocked_by   TEXT,
  learned      TEXT,
  tomorrow     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (user_id, day)
);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  read_at     TEXT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, read_at, created_at);

-- One row per alert sent (or attempted) through an external channel (M91).
CREATE TABLE alert_deliveries (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  notification_id     TEXT REFERENCES notifications(id) ON DELETE SET NULL,
  user_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
  rule                TEXT NOT NULL,
  provider            TEXT NOT NULL DEFAULT 'm91',
  recipient           TEXT,
  status              TEXT NOT NULL CHECK (status IN ('QUEUED','SENDING','SENT','DELIVERED','FAILED','NOT_CONFIGURED','SKIPPED')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  provider_message_id TEXT,
  last_error          TEXT,
  dedupe_key          TEXT NOT NULL UNIQUE,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX alert_deliveries_org ON alert_deliveries(org_id, created_at);
CREATE INDEX alert_deliveries_pending ON alert_deliveries(status, next_attempt_at);
CREATE INDEX alert_deliveries_provider_id ON alert_deliveries(provider, provider_message_id);

-- Delivery callbacks, stored once per idempotency key.
CREATE TABLE alert_callbacks (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  delivery_id     TEXT REFERENCES alert_deliveries(id) ON DELETE SET NULL,
  payload         TEXT NOT NULL,
  received_at     TEXT NOT NULL
);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX audit_log_org ON audit_log(org_id, created_at);
CREATE INDEX audit_log_entity ON audit_log(entity_type, entity_id);

-- viaSocket: a user's connected app. auth_id never leaves the server.
CREATE TABLE app_connections (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_slug    TEXT NOT NULL,
  service_id  TEXT NOT NULL,
  auth_id     TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (user_id, auth_id)
);
CREATE INDEX app_connections_user ON app_connections(org_id, user_id);

-- The enabled-app flow that runs actions on one connection. script_id is a credential: server only.
CREATE TABLE enabled_apps (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_id    TEXT NOT NULL,
  service_id TEXT NOT NULL,
  script_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, auth_id)
);

-- Flows a user built in the ViaSocket Embed builder, as read back from viaSocket (never trusted from the browser).
CREATE TABLE embed_flows (
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flow_id     TEXT NOT NULL,
  title       TEXT,
  status      TEXT,
  last_action TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, flow_id)
);

-- Catalog of curated TeamPulse automations (seeded from code on start).
CREATE TABLE automation_use_cases (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  channels     TEXT NOT NULL DEFAULT '[]',
  available    INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

-- An organization's configured instance of a ready-made automation.
CREATE TABLE automation_workflows (
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
  UNIQUE (org_id, use_case_key)
);

CREATE TABLE automation_execution_logs (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id  TEXT REFERENCES automation_workflows(id) ON DELETE SET NULL,
  use_case_key TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','SKIPPED','UNKNOWN')),
  attempts     INTEGER NOT NULL DEFAULT 1,
  summary      TEXT,
  error        TEXT,
  input        TEXT,
  dedupe_key   TEXT UNIQUE,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX automation_execution_logs_org ON automation_execution_logs(org_id, started_at);
CREATE INDEX automation_execution_logs_status ON automation_execution_logs(status, use_case_key);

-- Weekly team reports, generated once per organization, team and week.
CREATE TABLE weekly_reports (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id    TEXT NOT NULL DEFAULT '',
  week_start TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, team_id, week_start)
);

-- Small facts the scheduler keeps between runs (and its lease, so overlapping runs never double-process).
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

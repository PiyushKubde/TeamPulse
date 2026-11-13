-- foreign_keys: off
-- Slack-driven task intake, assignment acceptance, transfers, meaningful-activity tracking and missed-deadline
-- explanations. Existing rows are copied unchanged: the rebuild only widens the status CHECK and adds nullable columns.
-- No data is dropped; the previous build still reads every old column.

CREATE TABLE tasks_new (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  expected_outcome TEXT,
  created_by       TEXT NOT NULL REFERENCES users(id),
  assignee_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  priority         TEXT NOT NULL CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status           TEXT NOT NULL CHECK (status IN ('SUGGESTED','PENDING_ACCEPTANCE','ASSIGNED','IN_PROGRESS','BLOCKED','SUBMITTED_FOR_REVIEW','COMPLETED','CANCELLED','DECLINED')),
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
  updated_at       TEXT NOT NULL,
  acceptance_state TEXT CHECK (acceptance_state IN ('pending','accepted','declined')),
  accepted_at      TEXT,
  declined_reason  TEXT,
  slack_message_ref TEXT,
  last_meaningful_at TEXT
);
INSERT INTO tasks_new (id, org_id, team_id, title, description, expected_outcome, created_by, assignee_id, priority, status, progress, start_date, due_at, links,
                       source_request_id, assigned_at, started_at, last_progress_at, status_changed_at, submitted_at, completed_at, created_at, updated_at)
SELECT id, org_id, team_id, title, description, expected_outcome, created_by, assignee_id, priority, status, progress, start_date, due_at, links,
       source_request_id, assigned_at, started_at, last_progress_at, status_changed_at, submitted_at, completed_at, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX tasks_org_status ON tasks(org_id, status);
CREATE INDEX tasks_assignee ON tasks(org_id, assignee_id, status);
CREATE INDEX tasks_team ON tasks(org_id, team_id);
CREATE INDEX tasks_due ON tasks(org_id, due_at);
-- One task per Slack message: a duplicate delivery can never create a second task.
CREATE UNIQUE INDEX tasks_slack_ref ON tasks(org_id, slack_message_ref) WHERE slack_message_ref IS NOT NULL;

-- Slack identities: trusted for assignment only when read from the person's own connection or set by a manager.
ALTER TABLE external_identities ADD COLUMN workspace_id TEXT;
ALTER TABLE external_identities ADD COLUMN mapped_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- A Slack intake channel creates tasks from @mentions only when switched to this mode (existing intakes keep creating requests).
ALTER TABLE intake_subscriptions ADD COLUMN assign_from_mentions INTEGER NOT NULL DEFAULT 0;

-- Every Slack message TeamPulse looked at in a task-intake channel, what became of it, and where it came from.
CREATE TABLE slack_intake_items (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES intake_subscriptions(id) ON DELETE SET NULL,
  external_ref    TEXT NOT NULL,
  channel_id      TEXT,
  message_ts      TEXT,
  thread_ts       TEXT,
  workspace_id    TEXT,
  sender_slack_id TEXT,
  sender_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  sender_name     TEXT,
  mentions        TEXT NOT NULL DEFAULT '[]',
  permalink       TEXT,
  text            TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('TASK_CREATED','NEEDS_MANAGER','IGNORED')),
  reason          TEXT,
  extraction      TEXT,
  extracted       TEXT,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  request_id      TEXT REFERENCES task_requests(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (org_id, external_ref)
);
CREATE INDEX slack_intake_items_org ON slack_intake_items(org_id, outcome, created_at);
CREATE INDEX slack_intake_items_thread ON slack_intake_items(org_id, channel_id, message_ts);

-- Who owned a task, when, why and how the owner answered. Append-only history; a transfer or reassignment closes a row and opens another.
CREATE TABLE task_assignments (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  source       TEXT NOT NULL CHECK (source IN ('SLACK_MENTION','TRANSFER','MANAGER')),
  state        TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','ACCEPTED','DECLINED','TRANSFERRED_OUT','SUPERSEDED')),
  assigned_by  TEXT REFERENCES users(id),
  transfer_id  TEXT,
  reason       TEXT,
  assigned_at  TEXT NOT NULL,
  responded_at TEXT,
  ended_at     TEXT
);
CREATE INDEX task_assignments_task ON task_assignments(task_id, assigned_at);
CREATE INDEX task_assignments_user ON task_assignments(org_id, user_id, state);

-- People involved who do not own the task. A requester is not an owner and a reviewer is not a contributor.
CREATE TABLE task_participants (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('REQUESTER','SUPPORT','REVIEWER')),
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, user_id, role)
);

CREATE TABLE task_transfers (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_user_id  TEXT NOT NULL REFERENCES users(id),
  to_user_id    TEXT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','DECLINED','CANCELLED')),
  decided_by    TEXT REFERENCES users(id),
  decision_note TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX task_transfers_task ON task_transfers(task_id, status);
CREATE INDEX task_transfers_to ON task_transfers(org_id, to_user_id, status);
-- At most one open transfer per task.
CREATE UNIQUE INDEX task_transfers_one_pending ON task_transfers(task_id) WHERE status = 'PENDING';

-- The reason an employee gives for missing a deadline. One per task and deadline; later context and every manager
-- review are new rows in deadline_explanation_entries, so nothing the employee wrote is ever overwritten.
CREATE TABLE deadline_explanations (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id),
  original_deadline TEXT NOT NULL,
  reason_category   TEXT NOT NULL CHECK (reason_category IN ('TECHNICAL_ISSUE','DEPENDENCY','CLIENT_RESPONSE','SCOPE_INCREASED','WORKLOAD_CONFLICT','ESTIMATE_WRONG','CLARIFICATION_PENDING','OTHER')),
  explanation       TEXT,
  evidence_links    TEXT NOT NULL DEFAULT '[]',
  review_status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','REVIEWED','ACCEPTED','NEEDS_CLARIFICATION','FOLLOW_UP_REQUIRED')),
  reviewed_by       TEXT REFERENCES users(id),
  reviewed_at       TEXT,
  submitted_at      TEXT NOT NULL,
  UNIQUE (task_id, original_deadline)
);
CREATE INDEX deadline_explanations_org ON deadline_explanations(org_id, review_status);

CREATE TABLE deadline_explanation_entries (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  explanation_id TEXT NOT NULL REFERENCES deadline_explanations(id) ON DELETE CASCADE,
  author_id      TEXT NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL CHECK (kind IN ('CONTEXT','REVIEW')),
  review_status  TEXT,
  body           TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX deadline_explanation_entries_exp ON deadline_explanation_entries(explanation_id, created_at);

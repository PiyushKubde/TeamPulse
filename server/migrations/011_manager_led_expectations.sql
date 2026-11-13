-- foreign_keys: off
-- Manager-led task expectations. tasks.priority becomes nullable (NULL = not confirmed by a manager, no invented MEDIUM) and
-- tasks.priority / tasks.due_at mean "confirmed value" only: suggestions, proposals and requests live in task_parameter_events,
-- so every reader of due_at (overdue, alerts, measurement) keeps working and an unconfirmed deadline can never be overdue.
-- Existing rows are copied unchanged. Existing priority/deadline values are recorded as CONFIRMED with source LEGACY, with the
-- original baseline rebuilt from the recorded priority_changed / deadline_changed events.

CREATE TABLE tasks_new (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  expected_outcome TEXT,
  created_by       TEXT NOT NULL REFERENCES users(id),
  assignee_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  priority         TEXT CHECK (priority IS NULL OR priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
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
  last_meaningful_at TEXT,
  origin           TEXT CHECK (origin IS NULL OR origin IN ('MANAGER','EMPLOYEE','SLACK','REQUEST'))
);
INSERT INTO tasks_new (id, org_id, team_id, title, description, expected_outcome, created_by, assignee_id, priority, status, progress, start_date, due_at, links,
                       source_request_id, assigned_at, started_at, last_progress_at, status_changed_at, submitted_at, completed_at, created_at, updated_at,
                       acceptance_state, accepted_at, declined_reason, slack_message_ref, last_meaningful_at)
SELECT id, org_id, team_id, title, description, expected_outcome, created_by, assignee_id, priority, status, progress, start_date, due_at, links,
       source_request_id, assigned_at, started_at, last_progress_at, status_changed_at, submitted_at, completed_at, created_at, updated_at,
       acceptance_state, accepted_at, declined_reason, slack_message_ref, last_meaningful_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX tasks_org_status ON tasks(org_id, status);
CREATE INDEX tasks_assignee ON tasks(org_id, assignee_id, status);
CREATE INDEX tasks_team ON tasks(org_id, team_id);
CREATE INDEX tasks_due ON tasks(org_id, due_at);
CREATE UNIQUE INDEX tasks_slack_ref ON tasks(org_id, slack_message_ref) WHERE slack_message_ref IS NOT NULL;

-- Whether the requester actually chose a priority (the old column holds a MEDIUM placeholder when they did not).
ALTER TABLE task_requests ADD COLUMN priority_stated INTEGER NOT NULL DEFAULT 1;

-- What the manager expects of a task. Only managers write these columns; an employee's wishes are change requests.
CREATE TABLE task_expectations (
  task_id                  TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  org_id                   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  complexity_expectation   TEXT CHECK (complexity_expectation IS NULL OR complexity_expectation IN ('L1','L2','L3','L4')),
  business_impact          TEXT,
  dependencies             TEXT,
  success_criteria         TEXT,
  context                  TEXT,
  work_type                TEXT,
  response_sla_amount      REAL CHECK (response_sla_amount IS NULL OR response_sla_amount > 0),
  response_sla_unit        TEXT CHECK (response_sla_unit IS NULL OR response_sla_unit IN ('working_hours','working_days')),
  factor_business_impact   INTEGER CHECK (factor_business_impact IS NULL OR factor_business_impact BETWEEN 1 AND 5),
  factor_urgency           INTEGER CHECK (factor_urgency IS NULL OR factor_urgency BETWEEN 1 AND 5),
  factor_dependencies      INTEGER CHECK (factor_dependencies IS NULL OR factor_dependencies BETWEEN 1 AND 5),
  factor_risk              INTEGER CHECK (factor_risk IS NULL OR factor_risk BETWEEN 1 AND 5),
  factor_strategic         INTEGER CHECK (factor_strategic IS NULL OR factor_strategic BETWEEN 1 AND 5),
  verified_incident        INTEGER NOT NULL DEFAULT 0,
  updated_by               TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX task_expectations_org ON task_expectations(org_id, work_type);

-- Append-only history of every expectation: what was confirmed, changed, suggested, proposed or rejected, by whom, from what source.
-- The baseline of an assessment is the first CONFIRMED value of a field. Values are JSON text.
CREATE TABLE task_parameter_events (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('CONFIRM','CHANGE','SUGGEST','PROPOSE','REJECT')),
  status     TEXT NOT NULL CHECK (status IN ('CONFIRMED','SUGGESTED','PROPOSED','REJECTED')),
  old_value  TEXT,
  new_value  TEXT,
  source     TEXT NOT NULL CHECK (source IN ('MANAGER','LEGACY','EMPLOYEE','SLACK_EXTRACTION','RECOMMENDATION','CHANGE_REQUEST','REQUEST_APPROVAL')),
  actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason     TEXT,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('HIGH','MEDIUM','LOW')),
  evidence   TEXT,
  based_on   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX task_parameter_events_task ON task_parameter_events(task_id, field, created_at);
CREATE INDEX task_parameter_events_open ON task_parameter_events(org_id, status, created_at);

-- An employee asks; the manager decides. Approval applies the change through the same path as a manager's own edit.
CREATE TABLE task_change_requests (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by  TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('DEADLINE','PRIORITY','SCOPE','CLARIFICATION')),
  proposed      TEXT NOT NULL DEFAULT '{}',
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','ANSWERED','WITHDRAWN')),
  decided_by    TEXT REFERENCES users(id),
  decision_note TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX task_change_requests_task ON task_change_requests(task_id, status);
CREATE INDEX task_change_requests_org ON task_change_requests(org_id, status, created_at);

-- Priority recommendations (never confirmed values): the factor scores, the explanation, the confidence, the configuration version.
CREATE TABLE priority_recommendations (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  score             REAL,
  raw_score         REAL NOT NULL,
  known_weight      REAL NOT NULL,
  suggested_priority TEXT CHECK (suggested_priority IS NULL OR suggested_priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  confidence        TEXT CHECK (confidence IS NULL OR confidence IN ('HIGH','MEDIUM','LOW')),
  factors           TEXT NOT NULL,
  config_version    TEXT NOT NULL,
  critical_review   INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACCEPTED','OVERRIDDEN','REJECTED','SUPERSEDED')),
  final_priority    TEXT,
  decided_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TEXT,
  decision_note     TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX priority_recommendations_task ON priority_recommendations(task_id, created_at);

-- ---------- Legacy baseline ----------
-- Priority: the original is the "from" of the first recorded change, else today's value.
INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       t.org_id, t.id, 'priority', 'CONFIRM', 'CONFIRMED', NULL,
       json_quote(COALESCE((SELECT json_extract(e.data, '$.from') FROM task_events e WHERE e.task_id = t.id AND e.type = 'priority_changed' ORDER BY e.created_at, e.rowid LIMIT 1), t.priority)),
       'LEGACY', t.created_by, 'Baseline rebuilt from the task history when the manager-led model was introduced.', t.created_at
FROM tasks t
WHERE COALESCE((SELECT json_extract(e.data, '$.from') FROM task_events e WHERE e.task_id = t.id AND e.type = 'priority_changed' ORDER BY e.created_at, e.rowid LIMIT 1), t.priority) IS NOT NULL;

INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       e.org_id, e.task_id, 'priority', 'CHANGE', 'CONFIRMED',
       CASE WHEN json_extract(e.data, '$.from') IS NULL THEN NULL ELSE json_quote(json_extract(e.data, '$.from')) END,
       CASE WHEN json_extract(e.data, '$.to') IS NULL THEN NULL ELSE json_quote(json_extract(e.data, '$.to')) END,
       'LEGACY', e.actor_id, json_extract(e.data, '$.reason'), e.created_at
FROM task_events e WHERE e.type = 'priority_changed' AND json_extract(e.data, '$.to') IS NOT NULL;

-- Deadline: the original is the "from" of the first recorded change (NULL = it had none), else today's value.
INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       t.org_id, t.id, 'deadline', 'CONFIRM', 'CONFIRMED', NULL,
       json_quote(CASE WHEN EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.type = 'deadline_changed')
                       THEN (SELECT json_extract(e.data, '$.from') FROM task_events e WHERE e.task_id = t.id AND e.type = 'deadline_changed' ORDER BY e.created_at, e.rowid LIMIT 1)
                       ELSE t.due_at END),
       'LEGACY', t.created_by, 'Baseline rebuilt from the task history when the manager-led model was introduced.', t.created_at
FROM tasks t
WHERE (CASE WHEN EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.type = 'deadline_changed')
            THEN (SELECT json_extract(e.data, '$.from') FROM task_events e WHERE e.task_id = t.id AND e.type = 'deadline_changed' ORDER BY e.created_at, e.rowid LIMIT 1)
            ELSE t.due_at END) IS NOT NULL;

INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       e.org_id, e.task_id, 'deadline', 'CHANGE', 'CONFIRMED',
       CASE WHEN json_extract(e.data, '$.from') IS NULL THEN NULL ELSE json_quote(json_extract(e.data, '$.from')) END,
       CASE WHEN json_extract(e.data, '$.to') IS NULL THEN NULL ELSE json_quote(json_extract(e.data, '$.to')) END,
       'LEGACY', e.actor_id, json_extract(e.data, '$.reason'), e.created_at
FROM task_events e WHERE e.type = 'deadline_changed' AND json_extract(e.data, '$.to') IS NOT NULL;

-- Expected outcome: its history was never recorded with values, so the baseline is what it is today.
INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       t.org_id, t.id, 'expected_outcome', 'CONFIRM', 'CONFIRMED', NULL, json_quote(t.expected_outcome),
       'LEGACY', t.created_by, 'Value as it was when the manager-led model was introduced (earlier edits were not recorded with values).', t.created_at
FROM tasks t WHERE t.expected_outcome IS NOT NULL AND t.expected_outcome != '';

-- Where the recorded history does not end at today's value (a value set outside the recorded edits), say so instead of hiding it.
INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       t.org_id, t.id, 'priority', 'CHANGE', 'CONFIRMED',
       (SELECT p.new_value FROM task_parameter_events p WHERE p.task_id = t.id AND p.field = 'priority' AND p.status = 'CONFIRMED' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1),
       json_quote(t.priority), 'LEGACY', NULL, 'The value on the task when the manager-led model was introduced (the recorded history did not lead to it).', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tasks t WHERE t.priority IS NOT NULL
  AND COALESCE((SELECT p.new_value FROM task_parameter_events p WHERE p.task_id = t.id AND p.field = 'priority' AND p.status = 'CONFIRMED' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1), '') != json_quote(t.priority);

INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       t.org_id, t.id, 'deadline', 'CHANGE', 'CONFIRMED',
       (SELECT p.new_value FROM task_parameter_events p WHERE p.task_id = t.id AND p.field = 'deadline' AND p.status = 'CONFIRMED' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1),
       json_quote(t.due_at), 'LEGACY', NULL, 'The value on the task when the manager-led model was introduced (the recorded history did not lead to it).', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tasks t WHERE t.due_at IS NOT NULL
  AND COALESCE((SELECT p.new_value FROM task_parameter_events p WHERE p.task_id = t.id AND p.field = 'deadline' AND p.status = 'CONFIRMED' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1), '') != json_quote(t.due_at);

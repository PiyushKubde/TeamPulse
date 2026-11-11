-- AI Work Measurement Engine, phase 1. Additive only: new tables, no change to existing ones, so code from before
-- this migration keeps working against the migrated database (rollback = deploy the previous build).
-- Nothing here is a score: assessments are per task and per dimension, with reasons, evidence and confidence;
-- every human change is a new row (the AI's original is never overwritten).

-- Versioned rubrics. org_id NULL = the built-in default (seeded from code). role_scope allows role-specific rubrics later.
CREATE TABLE evaluation_rubrics (
  id          TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  version     TEXT NOT NULL,
  role_scope  TEXT NOT NULL DEFAULT 'all',
  definition  TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX evaluation_rubrics_org ON evaluation_rubrics(org_id, key, is_active);

-- One row per analysis request. input_json is exactly what the model saw (for audit); input_hash dedupes identical inputs.
CREATE TABLE ai_evaluation_runs (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  subject_user_id TEXT NOT NULL REFERENCES users(id),
  requested_by    TEXT REFERENCES users(id),
  trigger         TEXT NOT NULL CHECK (trigger IN ('manual','submitted','approved','context_added','recovery')),
  input_hash      TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT,
  prompt_version  TEXT NOT NULL,
  rubric_id       TEXT NOT NULL REFERENCES evaluation_rubrics(id),
  rubric_version  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  output_json     TEXT,
  guardrails_json TEXT,
  usage_json      TEXT,
  latency_ms      INTEGER,
  assessment_id   TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ai_evaluation_runs_task ON ai_evaluation_runs(org_id, task_id, created_at);
CREATE INDEX ai_evaluation_runs_hash ON ai_evaluation_runs(task_id, subject_user_id, input_hash);
CREATE INDEX ai_evaluation_runs_status ON ai_evaluation_runs(status, updated_at);

-- A contribution assessment: one person's work on one task, for one evaluation period. Re-analysis creates a new
-- row and marks the previous one not current (kept, with its feedback).
CREATE TABLE contribution_assessments (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id),
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id             TEXT REFERENCES ai_evaluation_runs(id) ON DELETE SET NULL,
  rubric_id          TEXT NOT NULL REFERENCES evaluation_rubrics(id),
  rubric_version     TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT,
  prompt_version     TEXT NOT NULL,
  period_start       TEXT,
  period_end         TEXT,
  evidence_state     TEXT NOT NULL CHECK (evidence_state IN ('sufficient','partial','insufficient')),
  understanding      TEXT,
  summary            TEXT,
  impact_json        TEXT NOT NULL DEFAULT '{}',
  missing_json       TEXT NOT NULL DEFAULT '[]',
  context_json       TEXT NOT NULL DEFAULT '{}',
  guardrails_json    TEXT NOT NULL DEFAULT '[]',
  requires_employee_confirmation INTEGER NOT NULL DEFAULT 1,
  requires_manager_review        INTEGER NOT NULL DEFAULT 1,
  employee_status    TEXT NOT NULL DEFAULT 'PENDING' CHECK (employee_status IN ('PENDING','CONFIRMED','CORRECTION_PROPOSED','DISPUTED')),
  manager_status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (manager_status IN ('PENDING','APPROVED','ADJUSTED','DISPUTED')),
  is_current         INTEGER NOT NULL DEFAULT 1,
  superseded_by      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX contribution_assessments_current ON contribution_assessments(task_id, user_id) WHERE is_current = 1;
CREATE INDEX contribution_assessments_user ON contribution_assessments(org_id, user_id, period_end);

-- Dimension levels. complexity: 1-4 (L1-L4); others: 1-5. A manager adjustment inserts a new row (source manager)
-- and marks the previous one not effective; the AI's row stays.
CREATE TABLE assessment_dimensions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES contribution_assessments(id) ON DELETE CASCADE,
  dimension     TEXT NOT NULL CHECK (dimension IN ('complexity','impact','quality','ownership','problem_solving','collaboration')),
  state         TEXT NOT NULL CHECK (state IN ('assessed','insufficient_evidence','not_applicable')),
  level         INTEGER,
  confidence    REAL,
  reason        TEXT NOT NULL,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  source        TEXT NOT NULL CHECK (source IN ('ai','rules','manager')),
  author_id     TEXT REFERENCES users(id),
  change_reason TEXT,
  supersedes_id TEXT,
  is_effective  INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE INDEX assessment_dimensions_assessment ON assessment_dimensions(assessment_id, dimension, is_effective);

-- Employee confirmations, corrections, added context and disputes; manager approvals, adjustments and disputes.
-- Append-only: this is the assessment history.
CREATE TABLE assessment_feedback (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assessment_id   TEXT NOT NULL REFERENCES contribution_assessments(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  subject_user_id TEXT NOT NULL REFERENCES users(id),
  actor_id        TEXT NOT NULL REFERENCES users(id),
  actor_role      TEXT NOT NULL CHECK (actor_role IN ('employee','manager')),
  action          TEXT NOT NULL CHECK (action IN ('CONFIRM','PROPOSE_CORRECTION','ADD_CONTEXT','DISPUTE','APPROVE','ADJUST','MANAGER_DISPUTE')),
  dimension       TEXT,
  from_level      INTEGER,
  to_level        INTEGER,
  comment         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX assessment_feedback_assessment ON assessment_feedback(assessment_id, created_at);
CREATE INDEX assessment_feedback_task ON assessment_feedback(task_id, subject_user_id, action);

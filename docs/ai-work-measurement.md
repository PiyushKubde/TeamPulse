# AI Work Measurement Engine — phase 1

> You do your work. TeamPulse understands it, measures it, and makes your contribution visible.
> **Work volume is not work value.**

## What it does

When work is submitted for review (and again when it is approved), or when someone presses **Analyse my work**,
TeamPulse reads everything it already knows about the task and produces a structured, per-task assessment:

| Part | What it is |
| --- | --- |
| Complexity | L1 Routine · L2 Standard · L3 Complex · L4 Highly complex — from the work evidence, never from the title, priority or a self-assessed label |
| Impact, Quality, Ownership, Problem-solving, Collaboration | Level 1–5 **or** "not enough evidence" / "not applicable", each with a reason, a confidence and the evidence it cites |
| Impact view | Claimed (employee's account) · AI-estimated (not verified) · Evidence-supported (recorded outcome with evidence) · Manager-verified |
| Context | Blockers (outside the person's control → never counted against them), shared outcomes, effort (context only, never rewarded) |
| Missing information | What would make the assessment more reliable |

Employees confirm, suggest a correction, add context (then it re-analyses) or dispute. Managers approve, adjust one
level with a reason, or dispute. Nothing is overwritten: the AI's original stays, every change is a new row, and the
audit log records before/after. A person's **contribution profile** and the manager's **team overview** aggregate
assessments without ever producing a score or a ranking (the team list is alphabetical).

## How it is built

```
server/ai/provider.js            provider interface: anthropic (official SDK) | mock (simulated, dev only) | not configured
server/measurement/rubric.js     versioned default rubric (dimensions, complexity levels, fairness rules)
server/measurement/evidence-pack.js  deterministic evidence pack + signals; insufficient-evidence gate
server/measurement/schema.js     JSON Schema for structured output + strict validator
server/measurement/guardrails.js deterministic rules applied to every model answer
server/measurement/engine.js     runs: dedupe, async processing, retries, recovery, storage
server/measurement/assessments.js read, employee responses, manager review, profiles, team overview
public/js/views/contribution.js  task card, person profile, team overview
```

### Evidence pack

Built only from TeamPulse data: task description and expected outcome, progress notes, comments, reopen/reassign and
deadline/priority changes, blockers (with "outside the employee's control" when external or waiting on someone
else), completion submissions (marked **self-reported**), review decisions, attached evidence (labels and hosts —
**files and links are not opened** in this phase), impact records about the task (verification status, value type,
shared contributors), context the employee added, and collaboration already recorded (blockers they resolved and
comments on teammates' tasks while the task was open). Names are left out on purpose. The pack is deterministic, so
its SHA-256 dedupes identical inputs: the same evidence is never sent to the model twice.

Future phases plug normalized external evidence (GitHub, Slack, Gmail, Calendar, Sheets via ViaSocket) into
`EXTERNAL_SOURCES` with the same item shape. Nothing external is collected in phase 1, and activity volume is never
evidence of value.

### Guardrails (deterministic, after the model)

Version `guardrails-2026-11-v4` (stored with every run and assessment, part of the dedupe hash).

1. Citations must exist in the pack; invented references are removed. A rating left without a valid citation, or citing only the task description (which describes the request, not the work), becomes "not enough evidence".
2. Complexity L3+ needs corroboration beyond the employee's own account — an artefact (link/file), a blocker, a verified or evidenced outcome record, a review *with a comment*, a recorded event, or someone else's words — else it is capped at L2. A title, a priority, or the employee describing the work as "extremely complex" is not enough.
3. Problem-solving and collaboration above 3 need the same kind of corroboration (ownership is exempt: the employee's own updates and blocker reports are evidence of ownership).
4. Quality: structured signals first — a reopening after completion, "changes requested" review decisions. Text is a narrow secondary signal (failing tests, CI red, regression, rollback) that ignores negations and fixes ("no regressions", "fixed the failing tests", "added a regression test"). An unresolved problem (after the last approval, or a reopening) → at most 2, set by rules even if the model ignored it; rework before approval → at most 4; above 3 needs an approved review or validation evidence. TeamPulse has no structured test results yet.
5. Confidence is reported by the model and not calibrated; it is capped at 0.6 where only the employee's own account supports a rating, and at 0.5 where a rule changed the level.
6. Work not delivered because of a blocker outside the person's control: impact and quality are **not applicable**, with "not counted against them".
7. Impact above 3 needs a manager-verified outcome; the impact basis (verified / evidence-supported / claimed / none) is decided from records and shown. Shared outcomes are labelled as shared and counted once at team level.
8. Estimated outcomes containing numbers that do not appear in the human-written text of the evidence (ids and timestamps excluded) are dropped.
9. Too little evidence at all (no description, a one-line note such as "Done.", no evidence, no outcome record): **no model call**; every dimension is "not enough evidence", with what is missing.

Every adjustment is listed under "Rules TeamPulse applied" on the card.

### Provider

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `anthropic` for real analysis. `mock` = simulated keyword analyser for local development and demos — refused in production and labelled "Simulated — development only, not AI" everywhere |
| `ANTHROPIC_API_KEY` | Server-side key (never sent to the browser) |
| `AI_MODEL` | Default `claude-opus-5-5` |
| `AI_EFFORT` | `low` · `medium` (default) · `high` |
| `AI_TIMEOUT_MS` | Default 120000 |
| `AI_FALLBACKS` | Server-side fallback to another model if the primary declines a request on safety grounds (on by default; `off` to disable). The model that actually answered, the requested model and the hops are recorded per run and shown on the card |
| `AI_MODE` | `off` · `supervised` (default with a real provider: only `AI_SUPERVISED_TASKS`, admins only, no automatic runs, no notifications) · `on` (automatic on submit/approve) |
| `AI_SUPERVISED_TASKS` | `taskId:owner-email,…` — see [supervised-ai-validation.md](supervised-ai-validation.md) |

Calls use the official SDK (`@anthropic-ai/sdk` 1.3.0, pinned; it sends the key as a bearer credential and API
version `2026-10-21`; no sampling or thinking-budget parameters are sent — Claude Opus 5.5 always uses adaptive
thinking). The client is built with an explicit key, base URL, `logLevel: 'warn'` and OpenTelemetry off, so
environment variables cannot redirect, log or trace evaluation data. Structured outputs (`output_config.format` +
JSON Schema), an explicit base URL, a timeout, and the SDK's retries for 429/5xx/connection errors. The engine retries
an answer that fails validation once, re-queues retryable failures (max 3 attempts, also after a restart via the
15-minute scheduled job) and records model, prompt version, rubric version, token usage, latency and the exact input
for every run.

Evaluation: `eval/` (dataset of 14 fictional cases, runner, metrics) — see [eval/README.md](../eval/README.md).
`GET /api/tasks/:id/assessment/preview` shows exactly what would be sent (no call, no write).

Without a provider, the app says so: "Analyse" returns a clear 503, the card explains it, and nothing is pretended.
The insufficient-evidence rule still works without AI.

## Data (migration `007_work_measurement.sql`, additive only)

`evaluation_rubrics` (versioned, org-specific later) · `ai_evaluation_runs` (status, attempts, hash, input, output,
guardrails, usage, model, versions) · `contribution_assessments` (org, person, task, period, evidence state, impact
view, missing info, context, employee status, manager status, current/superseded) · `assessment_dimensions` (one row
per dimension per change; source ai/rules/manager; the effective row and the originals) · `assessment_feedback`
(append-only history of confirmations, corrections, context, disputes, approvals, adjustments).

No existing table is altered, so the previous build runs on a migrated database (verified). Production: the daily
verified backup runs before and independently of deploys; take a manual backup (`GET /tasks/alerts` triggers one when
due) before deploying this migration.

## Permissions

A person's assessments are visible to them, admins, and managers with them in scope — never to other employees,
even ones who can see the task. Nobody reviews the analysis of their own work. Other organizations get 404.

## Not in phase 1

Role-specific rubrics (structure exists, one default ships), reading file/link contents, external evidence
collection, period-level AI summaries (profiles are aggregated deterministically), and M91 alerts for assessments
(disputes and reviews notify in-app; M91 remains the human escalation channel for task alerts).

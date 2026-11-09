# Architecture and decisions

## Data model (migration `001_init.sql`)

All primary keys are UUIDs; every business row carries `org_id`; timestamps are ISO-8601 UTC.

```
organizations ─┬─ teams (manager_id → users)
               ├─ memberships (user_id UNIQUE, role admin|manager|employee, team_id, status)
               ├─ invitations (email, role, team, token_hash, status)     join_requests (user, status)
               ├─ employee_permissions (org_id, user_id) 5 flags
               ├─ tasks ─┬─ task_events (append-only history)
               │         ├─ blockers (dependency owner, external flag, resolution)
               │         ├─ completion_submissions ── manager_reviews (subject_type submission|impact)
               │         └─ evidence (owner_type task|submission|impact; link or private file)
               ├─ task_requests (status separate from task status; task_id once approved)
               ├─ impact_records (category, outcome type, value type, verification)
               ├─ reflections (user, day)
               ├─ notifications (dedupe_key UNIQUE) ── alert_deliveries (M91 queue) ── alert_callbacks (idempotency_key UNIQUE)
               ├─ app_connections / enabled_apps / embed_flows (viaSocket, server-only ids)
               ├─ automation_workflows (per org per use case) ── automation_execution_logs (dedupe_key UNIQUE)
               ├─ weekly_reports (org, team, week UNIQUE)
               └─ audit_log
users (google_sub UNIQUE nullable, email, email_verified, name, picture_url, phone, password_hash …) ── auth_tokens (006)
AI work measurement (007, additive): evaluation_rubrics · ai_evaluation_runs ── contribution_assessments ─┬─ assessment_dimensions (ai/rules/manager rows)
                                                                                                         └─ assessment_feedback (append-only history)
sessions (token_hash), oauth_states (state_hash, nonce, PKCE verifier)
automation_use_cases (catalog), app_state (scheduler lease)
```

## Authorization

`server/access.js` builds a context from the session cookie on every request: user → membership → org, role, managed teams, employee permissions. Nothing about role, organization or permission is read from the request body.

| | Employee | Manager | Admin |
| --- | --- | --- | --- |
| Tasks visible | assigned to or created by me | tasks of teams I manage, my people's tasks, tasks I created | whole org |
| Create task | per permissions (else becomes a request) | yes, in my teams | yes |
| Assign | self / own team, only with the matching permission | my teams' members | anyone in org |
| Review / approve | — | in scope, never own work | yes (may review own only as admin) |
| Verify impact | — | my people's, never own | yes, never own |
| Permissions | read own | my employees | all |
| Org settings, roles, teams, alert settings | — | invite employees to my teams, approve join requests | everything |

Out-of-scope records answer **404** so their existence is not revealed; roles that never have access answer **403**.

## Task status model

```
ASSIGNED ──start──▶ IN_PROGRESS ──submit──▶ SUBMITTED_FOR_REVIEW ──approve──▶ COMPLETED
   │  ▲               │   ▲   ▲                   │ request changes ──▶ IN_PROGRESS
   │  └─reassigned────┘   │   └─ all blockers resolved
   └──── report blocker ──┴──▶ BLOCKED
any open ──manager cancels (reason)──▶ CANCELLED ──restore──▶ ASSIGNED
COMPLETED ──manager reopens (reason, event "reopened")──▶ IN_PROGRESS
```

- **Unassigned** is derived (`assignee_id IS NULL`), not a status.
- **OVERDUE**: due date passed and not completed/cancelled; work submitted for review before the deadline is not overdue.
- **AT RISK**: active and not overdue, with ≤24h left and progress < 75%, or ≥75% of the window used with progress < 50%, or blocked with ≤48h left.
- `SUGGESTED` exists in the enum for completeness; suggestions are stored as `task_requests` (status `PENDING`, `APPROVED`, `REJECTED`, `CLARIFICATION_REQUESTED`, `WITHDRAWN`) so request and task statuses never mix.

## Measuring impact without a score

- Completion (task review) and impact (verification) are separate records and separate decisions.
- A value must have a unit and be marked **measured** or **estimated**; "no measurable value" stores no number. Measured and estimated totals are never added together.
- Learning records (failed experiments) cannot claim a value; prevention and research are first-class outcome types.
- A shared outcome key makes team totals count a shared result once.
- The weekly view lists missed commitments with their documented reasons; blockers (including external dependencies), reassignment and manager-driven priority/deadline changes mark a miss as "not counted against the person".

## Background work

- In-process event hub (`services/events.js`): services emit after commit; listeners raise in-app alerts, run the New Task Notification and process the M91 queue on the next tick, so integrations never slow or fail a request.
- Scheduled routes, called by Embarko with `Authorization: Bearer $CRON_SECRET`:
  - `GET /tasks/alerts` every 15 minutes: time-based rules, M91 queue, automation retries.
  - `GET /tasks/weekly-report` Mondays 09:05 Asia/Kolkata.
- **No duplicates after redeploys**: schedules live only in `embarko.json` (Embarko's source of truth), there is no in-process timer in production, a lease row in `app_state` stops overlapping alert runs, and every alert, delivery, automation run and weekly report has a unique dedupe key.

## Security

- Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` in production); only its SHA-256 is stored.
- CSRF: state-changing `/api` calls require `X-Requested-With: TeamPulse` (a cross-site form cannot set it) plus SameSite cookies. Machine endpoints (`/api/inbound/*`, `/api/webhooks/*`) use bearer/shared-secret tokens instead.
- Input validation on every field (`server/validate.js`); links must be http(s); CSV export guards against formula injection.
- Rate limits: auth 30/min/IP, API 600/min/IP, inbound 60/min/IP (in memory, single instance).
- Evidence files: type allowlist plus magic-byte check, 5 MB limit, stored under `DATA_DIR/uploads` (not the public Embarko file store, which serves public links), downloaded only through `/api/evidence/:id/download` after re-checking access, always as an attachment with a sandbox CSP.
- viaSocket `auth_id` and `script_id` never leave the server; the browser holds only the per-user embed token.
- Audit log for organization, team, membership, invitation, permission, automation, alert-setting and task-deletion changes.

## Decisions taken where the brief was open

| Question | Decision |
| --- | --- |
| Database | SQLite on Embarko's persistent `DATA_DIR` (no managed PostgreSQL there). |
| Framework | Express + vanilla JS, same as DealSaathi; no build step to fail on deploy. |
| Who may create an organization | Any signed-in user without one becomes the admin of the *new* org only. Turn off with `ALLOW_ORG_CREATION=false`. |
| One org per user | Yes for the MVP (`memberships.user_id` is unique). |
| Manager scope | Teams where they are the manager. |
| Employee "assign others" | Limited to their own team. |
| Direct creation | Requires `can_create_tasks` + `can_create_directly` and `approval_required` off; otherwise the task form files a request. |
| External requests | Always `PENDING` task requests, never tasks; idempotent by `externalRef`. |
| Automation runs | Use the configuring manager's own connection; skipped if they are no longer an active manager. `UNKNOWN` outcomes (maybe delivered) are never auto-retried. |

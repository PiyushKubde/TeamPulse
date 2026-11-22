# API reference

Base path `/api`. JSON in and out. The session is an httpOnly cookie set by `/auth/login`, `/auth/register` or
`/invitations/accept`. Every non-GET request must send `X-WorkPulse: 1` (CSRF guard).

**Errors**: `{ "error": { "code": "bad_request|unauthorized|forbidden|not_found|conflict|csrf|ai_not_configured|…", "message": "…", "details"?: … } }`.
Records outside the caller's scope answer **404**; actions the role can never take answer **403**.
**Lists** that page answer `{ items, page, pageSize, total }`. Input schemas are in `packages/shared/src/index.ts`.

## Auth & organization

| Method | Path | Notes |
|---|---|---|
| POST | /auth/register | `{ name, email, password }`; sends a verification email |
| POST | /auth/login · /auth/logout | |
| POST | /auth/forgot-password · /auth/reset-password · /auth/verify-email · /auth/resend-verification | single-use, expiring tokens |
| GET | /auth/me | user, active org, role, memberships |
| PATCH | /me · GET /me/profile | name, time zone |
| POST | /organizations · /organizations/:id/switch | creator becomes owner |
| GET/PATCH | /organization | settings (admins) |
| GET | /members · PATCH/DELETE /members/:userId | role/status changes are audited; last owner protected |
| GET/POST | /invitations · DELETE /invitations/:id | managers invite members into their own teams |
| GET | /invitations/lookup?token= · POST /invitations/accept | public |
| GET/POST | /teams · PATCH/DELETE /teams/:id · PUT /teams/:id/members | |
| GET/POST | /mentorships · DELETE /mentorships/:id | |
| GET | /audit-logs | admins |

## Work

| Method | Path | Notes |
|---|---|---|
| GET | /tasks | filters: `q, status[], priority[], projectId, assigneeId (id·me·none), goalId, category, provider (linear·jira-software-cloud·github·native), dueFrom, dueTo, parentId (id·none), archived, needsReview, sort, page, pageSize` |
| POST | /tasks · PATCH/DELETE /tasks/:id · POST /tasks/bulk | status timestamps, reopen count, recurrence, dependency cycle check |
| GET | /tasks/:id | details, subtasks, dependencies, blockers, attachments, assessments, conflicts |
| GET/POST | /tasks/:id/comments · DELETE /tasks/:id/comments/:commentId | |
| GET | /tasks/:id/activity | |
| POST | /tasks/:id/blockers · /blockers/:id/resolve | blocking/unblocking updates status |
| POST | /tasks/:id/attachments (multipart `file`) · GET /attachments/:id/download · DELETE /attachments/:id | type + magic-byte checks |
| PUT | /tasks/:id/assessment | quality 1–5 + impact; only the assignee's manager/admin, never own work |
| GET/POST | /task-templates · DELETE /task-templates/:id | |
| GET/POST | /projects · GET/PATCH/DELETE /projects/:id | |
| GET/POST | /goals · GET/PATCH/DELETE /goals/:id | |
| POST | /goals/:id/key-results · PATCH/DELETE /key-results/:id | progress derived from key results |
| GET | /planner/:date · PUT /planner · POST /planner/review | review requires a reason per unfinished planned task |
| GET/POST | /sessions · POST /sessions/start · /sessions/stop · DELETE /sessions/:id | adds tracked minutes to the task |

## Evidence, feedback, scoring

| Method | Path | Notes |
|---|---|---|
| GET | /evidence | `taskId, userId, kind, status, source, unmatched, page` |
| POST | /evidence (link) · /evidence/upload (multipart) | |
| GET | /evidence/:id/file | |
| POST | /evidence/:id/verify | `{ status, qualityScore?, impactNote?, note? }`, manager only |
| POST | /evidence/:id/match · DELETE /evidence/:id | |
| GET/POST | /feedback · GET /feedback/given · POST /feedback/:id/acknowledge | kinds MANAGER, MENTOR, SELF, PEER |
| GET/POST | /corrections · POST /corrections/:id/resolve | disputes |
| GET/POST | /scoring-models · PUT /scoring-models/target | new version per save |
| GET | /notifications · POST /notifications/read | |

## Analytics, performance, reports

| Method | Path | Notes |
|---|---|---|
| GET | /analytics/individual | `userId?, from?, to?, projectId?`: KPIs, explainable score, weekly series, workload, time allocation, lists |
| GET | /analytics/team | managers/admins; `teamId?, projectId?, from?, to?`: KPIs, weekly, member comparison, distributions, health |
| GET | /analytics/projects/:id | burn-up, status, contributions |
| GET | /performance/:userId · /performance/history?subject= · POST /performance/recalculate | |
| GET | /reports · /reports/daily · /reports/weekly · /reports/:id | `subject=user:<id>` or `team:<id>` |
| POST | /reports/generate | `{ kind, subject, date?, withAi? }` |
| GET | /reports/:id/export.csv · /reports/:id/export.pdf | |
| POST | /reports/:id/deliver | `{ channel: EMAIL \| SLACK }` to the caller's own destination |

## Company transparency, hierarchy and KPIs

Read-only company views (any member; see "Company transparency" in architecture.md for who sees whom). They never include tasks, evidence or comments.

| Method | Path | Notes |
|---|---|---|
| GET | /company/overview?days=7..180 | every visible person (value score, goal progress, KPI attainment, overall, health), the reporting tree (`depth`, `directReports`, `subtreeSize`, `rollupOverall`), teams/departments with roll-ups, summary, `transparency` (OPEN·PRIVATE) |
| GET | /company/people/:userId?days= | one scorecard: score dimensions with their inputs, chain of command, reports, peers, goals with key results, KPIs with readings, `canAddKpi` |
| GET | /company/cascade | goals (`parentId` tree, company objectives down to individuals) and KPIs (`goalId` links a KPI to an objective) |
| GET | /kpis?ownerId= | KPIs the caller may read |
| POST | /kpis | `name, unit, direction (HIGHER·LOWER), baseline, target, current, cadence, ownerId, teamId, goalId`. Own KPIs, or those of people you manage; owners/admins anyone |
| PATCH/DELETE | /kpis/:id · POST /kpis/:id/readings | same permission; a reading sets `current` and keeps the history |
| PATCH | /members/:userId | admins: `reportsToId` (null = top of the company). Loops and self-reporting answer 400 |
| POST/PATCH | /teams · /teams/:id | admins: `parentId` nests a team under a department. Loops answer 400 |
| PATCH | /organization | admins: `settings.transparency` = OPEN (default) or PRIVATE |

## AI

All answer `503 ai_not_configured` until AI is configured and `AI_DATA_POLICY_CONFIRMED=true`.

| Method | Path | Notes |
|---|---|---|
| GET | /ai/status | |
| POST | /ai/chat | `{ message, history[] }`, answers from scoped read-only tools; may return a task draft |
| POST | /ai/create-task · /ai/decompose · /ai/classify/:taskId · /ai/plan-day · /ai/analyze-work · /ai/evidence-summary/:id | drafts and suggestions only |

## Integrations

| Method | Path | Notes |
|---|---|---|
| GET | /integrations | catalog + the caller's connections |
| POST | /integrations/connect-setup | embed token + service id for the Connect popup |
| POST | /integrations/connect | `{ provider, authId }`; auth id must be the caller's own connection |
| GET | /integrations/connections | `scope=org` for admins (no secrets) |
| GET | /integrations/connections/:id/options | `fieldKey, search?, paginate?` |
| PATCH | /integrations/connections/:id | choices + sync mode; reconciles subscriptions and flows |
| POST | /integrations/connections/:id/backfill · /test-delivery | |
| POST | /integrations/disconnect | deletes flows and revokes the connection |
| GET | /integrations/sync-history · /integrations/sync-history/:id | |
| POST | /integrations/retry | failed, dead or waiting events |
| GET | /integrations/mappings · POST /integrations/mappings/:id/decision | approve re-applies waiting events |
| GET | /integrations/conflicts · POST /integrations/conflicts/:id/resolve | two-way conflicts |
| GET | /automations · /automations/:id/runs | Automation Center |
| POST | /integrations/events/:provider/:subscriptionId | **called by viaSocket handlers only**; `Authorization: Bearer <subscription token>`, body `{ event }` |

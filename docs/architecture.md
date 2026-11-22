# Architecture

## Processes

```
Browser (React SPA) ──/api──▶ API (Express)  ──▶ PostgreSQL (Prisma)
                                   │  ▲                ▲
                         enqueue   ▼  │ events         │
                               Redis (BullMQ) ──▶ Worker (ingest, outbound sync, imports, schedules)
                                                      │
viaSocket ◀── subscribe / flows / AI (viasocket-apps) ─┘
   │
   └── handler per subscription ──POST /api/integrations/events/:provider/:subscriptionId (Bearer)──▶ API
```

- The API never waits on an external app during a user request. Events are stored, then processed by the worker. Outbound
  status sync is queued.
- Tests run jobs inline (`enqueue` calls the processor directly when `NODE_ENV=test`).

## Folder structure

```
apps/api/
  prisma/schema.prisma, migrations/, seed.ts
  scripts/viasocket-selftest.ts         real viaSocket checks
  src/
    app.ts, server.ts, worker.ts
    config/env.ts (zod-validated), logger.ts (pino with secret redaction)
    lib/        prisma, scope (tenant + role scope), crypto (AES-GCM, hashes), errors, validate, audit, mailer, storage, dates
    middleware/auth.ts                   session cookie → user; org membership → scope
    modules/    auth, orgs, tasks, projects, goals, planner, evidence, analytics, people, reports, ai, integrations
    services/   performance (scoring engine), reports (content, CSV, PDF), notify, activity
    ai/         provider (viaSocket AI or OpenAI, strict JSON), features (drafts, plans, analyses), assistant (tool loop)
    integrations/
      catalog.ts                         allowlist of every app, trigger, action, key, version and id
      viasocket/client.ts, automations.ts
      connections.ts, flows.ts, delivery.ts, outbound.ts, backfill.ts, events.ts, ingest.ts
      providers/linear.ts, jira.ts, github.ts
      normalization/types.ts, status-mapping.ts, normalizer.ts
    jobs/       queues.ts, processors.ts, scheduled.ts
  test/         unit-*.test.ts, api-*.test.ts, fake-viasocket.ts, helpers.ts
apps/web/src/
  lib/          api client, auth context, range (URL filters), queries, types
  components/   ui (buttons, fields, cards, states), overlay (dialogs, menus, tabs), charts, layout/AppShell
  features/     auth, dashboard, planner, tasks, goals, projects, team, reviews, integrations, ai, reports, settings
packages/shared/src/index.ts             enums, zod input schemas, scoring defaults
e2e/journey.spec.ts
```

## Data model (summary)

All tenant rows carry `orgId`. `Task`, `Project`, `Goal`, `Evidence` and `TaskComment` are soft-deleted.

| Area | Tables |
|---|---|
| Identity | User, Session (hashed token), AuthToken (verify/reset, hashed) |
| Tenancy | Organization, OrganizationMember (role, status), Invitation (hashed token), Team, TeamMember, MentorAssignment |
| Work | Project, Task (+subtasks via parentId), TaskGoal, TaskDependency, TaskComment, TaskActivity, Attachment, TaskTemplate, Blocker, WorkSession, DailyPlan |
| Goals | Goal (period, status, progress), KeyResult, GoalUpdate (history) |
| Evidence | Evidence (received/verified/rejected, source metadata, AI summary, suggested match), EvidenceVerification (quality, impact note) |
| Integrations | IntegrationConnection (encrypted auth_id, settings, sync mode), IntegrationSubscription (encrypted script_id, hashed event token; also per-user action flows `flow:*`), TaskSource (unique orgId+provider+externalId), SyncEvent (unique orgId+provider+idempotencyKey), SyncMapping (versioned, approval), SyncCheckpoint, SyncConflict |
| Performance | ScoringModel (versioned weights), PerformanceSnapshot (weekly per user/team, components + inputs + model version), QualityAssessment |
| Reporting | Report (unique per kind/subject/period), ReportDelivery, Feedback, CorrectionRequest, Notification (dedupe key), AutomationExecution (dedupe key), AuditLog |

## Authorization

`buildCtx` (src/lib/scope.ts) runs on every request from the session, never from the request body:

| Role | Reads | Changes / assesses |
|---|---|---|
| Owner, Admin | everyone in the org (only members of this org) | anyone's work; never assess own work |
| Manager | self + members of teams they manage + mentees | their teams' members' work |
| Mentor | self + assigned mentees (read only) | own work; mentor feedback |
| Member | own work | own work |

Out-of-scope records answer **404**; actions a role can never take answer **403**. Every task query goes through
`taskScope(ctx)`; analytics intersect the requested people with `visibleUserIds`. Tests cover cross-tenant, cross-team,
mentor read-only and AI-tool scope.

## Company transparency (src/modules/company.ts)

The brief: everyone, from intern to CEO, is measurable in the open, so peers, mentors and managers can compare and leadership
can see how the company moves.

- **Structure.** `OrganizationMember.reportsToId` is the reporting line (a tree; the top reports to no one). `Team.parentId`
  nests teams under departments. Both are validated to stay trees (`assertValidReportingLine`, `assertValidTeamParent`).
- **What is measured.** Per person: the value score (the performance engine below), goal progress (mean of active goals) and
  KPI attainment (mean of KPIs, baseline → target, either direction). *Overall* is the plain average of those that exist.
  Task counts and hours are never ranked. Leaders and departments get a roll-up over everyone below them.
- **KPIs.** `Kpi` + `KpiReading`: a number someone is accountable for, with history. Everyone can own them, the CEO included.
- **Cascade.** `Goal.parentId` already existed; the cascade view shows company objectives → executives → departments → teams →
  people, with KPIs under the objective they serve.
- **Visibility.** `settings.transparency`: **OPEN** (default) lets every member *read* everyone's scorecard, goals and KPIs in
  the company views; **PRIVATE** limits the views to the lines the caller could already see (self, managed, mentees);
  owners/admins always see everyone. This is read-only: `taskScope`, evidence and edit rights are unchanged, and the company
  endpoints never return tasks, evidence or comments.
- **Scale.** One batched query scores everybody (`loadScoreInputsByUser`); results are cached for 45 s. About 150 people
  answer in roughly 0.4 s. `npm run db:seed:company -w @workpulse/api` builds a 146-person demo company ("Helios Corp") to try it.

## Performance engine (src/services/performance.ts)

Five weighted dimensions (default 30/25/20/15/10, configurable per org and role, versioned):

| Dimension | Formula | Without data |
|---|---|---|
| Impact | Σ points(impact) × complexity factor × (verified ? 1 : 0.5), divided by expected points for the period (default 10 per person per week). Points: Low 0.5, Medium 2, High 5, Critical 10 | excluded, listed as missing |
| Execution quality | mean of manager quality assessments (1–5) → 0–100 | excluded |
| Goal alignment | share of earned impact on goal-linked tasks | excluded |
| Delivery reliability | on-time ÷ judged commitments. Completed work is judged when completed; unfinished work when its deadline passes. Late work with an external or dependency blocker is excused (not counted) | excluded |
| Evidence completeness | medium+ outcomes with verified evidence ÷ medium+ outcomes | excluded |

`score = Σ value×weight ÷ Σ weight of dimensions with data`. Efficiency (estimate accuracy, cycle time, WIP, reopens)
is shown but never weighted. Snapshots store inputs, missing list, engine and model version. Past weeks are reused
once final, so dashboards don't recompute history. AI never sets any value here.

## Security

- Passwords: argon2id. Sessions: random 256-bit tokens stored as SHA-256, httpOnly + SameSite=Lax cookies.
- CSRF: every state-changing `/api` request must carry `X-WorkPulse: 1` (needs a CORS preflight cross-site; CORS is an allowlist).
- Helmet headers; rate limits on credential endpoints, AI and the API; body size limits.
- viaSocket `auth_id` and every `script_id` are AES-256-GCM encrypted at rest, used only for their owner, never returned.
- Event endpoint: per-subscription bearer token (stored hashed, timing-safe compare), idempotency key, stale-event guard; the payload is stored as untrusted data and validated by the adapter.
- Uploads: allowlisted MIME types, verified against magic bytes; size limit; served with `nosniff` and download disposition.
- CSV exports neutralise formula injection; logs redact tokens, passwords, auth ids and script ids.
- AI: strict JSON schemas, zod re-validation, ids checked against the candidate set, tools run under the caller's scope; no SQL, no data writes, no integration actions.

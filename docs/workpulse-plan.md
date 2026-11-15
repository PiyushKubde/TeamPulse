# WorkPulse — Implementation Plan (awaiting approval)

Status: **PROPOSED 2026-11-15. No application code has been changed.**
viaSocket skill: `viasocket-integrations/SKILL.md` updated to version `2026-11-14.1` (downloaded from
https://beta-flow.viasocket.com/documentation/skill-install.md). The full SDK skill (`skill.md?format=sdk`) and its
pages `app-integrations`, `actions-and-events`, `automations`, `setup` and `journey` were read in full (each ended in `END OF PAGE`).

---

## 0. What is in the repo today

| Area | Finding |
|---|---|
| Repo | `TeamPulse/`, git branch `claude/teampulse-mvp` (clean, in sync with `origin`), remote `github.com/PiyushKubde/TeamPulse`. The parent folder is not a git repo. |
| Product | "KONVO / TeamPulse": multi-tenant work-intelligence app: tasks, requests, evidence, AI contribution assessment, work signals, weekly reports, viaSocket Automation Center, M91 alerts. Conceptually ~60% overlap with WorkPulse. |
| Backend | Node ≥22 ESM **JavaScript** (no TS), Express 5, `node:sqlite` (SQLite, 12 hand-written SQL migrations), hand-rolled validation, cookie sessions, Google OIDC + email/password, nodemailer. |
| Frontend | Vanilla JS SPA in `public/` (no framework, no build), one 1,256-line CSS file. |
| AI | Anthropic SDK, viaSocket AI gateway, Google Gemini (behind privacy gates). No OpenAI. |
| viaSocket | `viasocket-apps@0.19.0` already used: connect, enable, subscribe, runAction, embed. |
| Tests | ~330 `node:test` tests + Playwright-style e2e scripts. `node_modules` not installed, so the current pass state is unverified. |
| Hosting | Embarko (`embarko.json`, cron schedules). Code comment: *"Embarko … offers SQLite (no managed PostgreSQL)"*. |
| Env | **No `.env` present** → no viaSocket keys, no AI key, no SMTP locally. |
| Local tools | Node 26.9, npm 11.19, Docker 29.7 (**daemon not running**), Homebrew PostgreSQL 18.4, Redis 8.6. |

## 1. Architectural decision

The requested stack (React + TS + Prisma + PostgreSQL + Redis/BullMQ) differs from the current stack in every
layer. Rather than port 22k lines piece by piece, **rebuild**, and use the old code only as a **reference** for
proven logic, which is rewritten in TypeScript.

**One real constraint:** Embarko does not offer PostgreSQL or Redis. The spec's stack needs a host that does
(Render, Railway, Fly.io, a VPS with Docker Compose, AWS). → **Decision D1 below.**

### Reuse as reference (ported to TS, not copied)
- viaSocket flow: per-user `auth_id` and server-only `script_id`s, ownership checks before any run, a per-subscription
  bearer token (stored hashed) for the events endpoint, handler built from a real `sampleEvent`.
- Google OIDC with PKCE, password hashing approach, session token hashing, email verification/reset tokens.
- Tenant rule: out-of-scope records answer **404**, never-allowed roles answer **403**; context built server-side only.
- Dedupe-key idempotency pattern; audit-log pattern; "AI never decides ratings" guardrails.

### Dropped
M91 alerting, Gemini/Anthropic/viaSocket-AI provider switching, MS Teams intake, Embarko cron (unless D1 = Embarko),
KONVO branding, vanilla SPA, `node:sqlite` layer, all old migrations.

### Repository replacement strategy
1. New branch `workpulse` from `claude/teampulse-mvp`. Old branch untouched → full history and rollback.
2. One commit removes `server/ public/ scripts/ test/ eval/ embarko.json` (if not Embarko) and old docs.
3. New npm-workspaces monorepo in the same repo (rename the repo later if desired):

```
apps/api/            Express + TS + Prisma + BullMQ
  prisma/            schema.prisma, migrations/, seed.ts
  src/
    app.ts, server.ts, worker.ts          (API process and job-worker process)
    config/          env (zod-validated), logger (pino)
    middleware/      auth, tenant, rbac, rate-limit, error, validate
    modules/         auth, orgs, teams, projects, goals, tasks, planner, evidence,
                     performance, analytics, reports, feedback, notifications, ai, admin
    integrations/
      viasocket/     client.ts, automations.ts (module from the skill), connections, subscriptions, events
      providers/     linear/ github/ jira/ slack/  (adapter.ts, schemas.ts, mapper.ts each)
      normalization/ normalizer.ts, status-mapping.ts, priority-mapping.ts, field-mapping.ts, validation.ts
    jobs/            queues.ts, ingest.ts, snapshots.ts, reports.ts, reminders.ts
apps/web/            Vite + React + TS + Tailwind + shadcn/ui + TanStack Query + Recharts
  src/{routes, features/*, components/ui, lib}
packages/shared/     zod schemas + enums shared by api and web (TaskStatus, Priority, DTOs)
e2e/                 Playwright
docker-compose.yml   postgres, redis, minio (S3), mailpit (dev SMTP)
```

## 2. Database schema (Prisma / PostgreSQL)

Every tenant row carries `orgId` (indexed, FK cascade on org delete). Every table has `createdAt`/`updatedAt`. Soft
delete (`deletedAt`) on Task, Project, Goal, Evidence, Comment only.

| Entity | Key fields | Constraints / indexes |
|---|---|---|
| User | email, passwordHash?, googleSub?, emailVerifiedAt, name | unique(email), unique(googleSub) |
| Session | userId, tokenHash, expiresAt, activeOrgId | unique(tokenHash) |
| AuthToken | userId, kind(VERIFY/RESET), tokenHash, expiresAt, usedAt | unique(tokenHash) |
| Organization | name, slug, settings(json: retention, approvals) | unique(slug) |
| OrganizationMember | orgId, userId, role(OWNER/ADMIN/MANAGER/MENTOR/MEMBER), status | unique(orgId,userId) |
| Invitation | orgId, email, role, teamId?, tokenHash, expiresAt, acceptedAt | unique(tokenHash) |
| Team / TeamMember | orgId, name, managerId / teamId, userId | unique(teamId,userId) |
| MentorAssignment | orgId, mentorId, menteeId | unique(orgId,mentorId,menteeId) |
| Project | orgId, teamId?, name, status, ownerId, startDate, targetDate | idx(orgId,status) |
| Goal | orgId, ownerId, teamId?, parentId?, period(DAILY/WEEKLY/MONTHLY/QUARTERLY), title, expectedOutcome, actualOutcome, progress(0-100, manual or KR-derived), status | idx(orgId,period,ownerId) |
| KeyResult | goalId, title, metricType, start, target, current, unit | — |
| GoalUpdate | goalId, authorId, progress, note (history) | — |
| Task | orgId, projectId?, parentId? (subtasks), title, description, status(7), priority(4), category, labels[], assigneeId?, creatorId, dueAt, startedAt, completedAt, estimateMins, actualMins, impactLevel(NONE/LOW/MEDIUM/HIGH/CRITICAL), complexity(1-5), recurrenceRule?, reopenCount, origin(NATIVE/EXTERNAL), archivedAt, deletedAt | idx(orgId,assigneeId,status), idx(orgId,dueAt), idx(orgId,projectId) |
| TaskGoal | taskId, goalId, contribution(weight) | unique(taskId,goalId) |
| TaskSource | taskId, orgId, provider, externalId, externalKey (ENG-42), sourceUrl, connectionId, externalUpdatedAt, externalRevision, lastSyncedAt, rawSnapshot(json) | **unique(orgId,provider,externalId)**, unique(taskId) |
| TaskDependency | taskId, dependsOnId | unique pair, no self |
| TaskComment / TaskActivity | taskId, authorId?, body / kind, from, to, actor(USER/SYNC/AI/SYSTEM) | idx(taskId,createdAt) |
| TaskTemplate | orgId, name, fields(json) | — |
| WorkSession | orgId, userId, taskId?, startedAt, endedAt, kind(FOCUS/MANUAL) | idx(userId,startedAt) |
| DailyPlan | orgId, userId, date, topOutcomes(json), checkIn, review, carryForward(json with reasons) | unique(userId,date) |
| Blocker | orgId, taskId, reportedById, reason, kind(INTERNAL/EXTERNAL/DEPENDENCY), resolvedAt | idx(orgId,resolvedAt) |
| Evidence | orgId, taskId, kind(COMMIT/PR/RELEASE/ISSUE_LINK/DOC/URL/FILE/SCREENSHOT/APPROVAL/DEPLOYMENT), url?, storageKey?, sourceMeta(json), aiSummary?, addedById | unique(orgId,kind,url) where url not null |
| EvidenceVerification | evidenceId, verifierId, status(RECEIVED/VERIFIED/REJECTED), qualityScore?, impactAssessment?, note | — |
| IntegrationConnection | orgId, userId, provider, authId (encrypted at rest), status(ACTIVE/EXPIRED/REVOKED), settings(json: picked team/project/repos, status map, syncMode) | unique(userId,provider,authId) |
| IntegrationSubscription | connectionId, triggerKey, version, scriptId (encrypted), inputData, handlerHash, tokenHash, status | unique(connectionId,triggerKey) |
| SyncEvent | orgId, subscriptionId, provider, idempotencyKey, payload(json), status(RECEIVED/PROCESSED/SKIPPED_STALE/FAILED/DEAD), attempts, error, receivedAt | **unique(subscriptionId,idempotencyKey)**, idx(status) |
| SyncMapping | orgId, provider, version, kind(STATUS/PRIORITY/FIELD), from, to, confidence, source(DEFAULT/USER/AI), approvedById?, active | unique(orgId,provider,kind,from,version) |
| SyncCheckpoint | connectionId, resource, cursor, lastRunAt | unique(connectionId,resource) |
| SyncConflict | taskId, field, internalValue, externalValue, resolvedById?, resolution | — |
| ScoringModel | orgId, name, role?, version, weights(json), active | unique(orgId,name,version) |
| PerformanceSnapshot | orgId, userId?, teamId?, periodStart, periodEnd, granularity(DAY/WEEK/MONTH), scoringModelId, components(json per dimension: value, inputs, missing[]), score, calculatedAt | unique(subject,period,granularity,scoringModelId) |
| PerformanceMetric | snapshotId, key, value, numerator, denominator | — (only if json proves insufficient) |
| Report | orgId, kind(DAILY/WEEKLY), subjectUserId?/teamId?, period, content(json), generatedById | unique(kind,subject,period) |
| ReportDelivery | reportId, channel(EMAIL/SLACK), status, error | — |
| Feedback | orgId, subjectUserId, authorId, kind(MANAGER/MENTOR/SELF/QUALITY), body, rating?, acknowledgedAt | — |
| CorrectionRequest | orgId, requesterId, targetType, targetId, reason, status, resolvedById | — |
| Notification | orgId, userId, kind, payload, readAt, dedupeKey | unique(dedupeKey) |
| AutomationExecution | orgId, userId, automation, scriptId?, status, attempts, error, dedupeKey | unique(dedupeKey) |
| AuditLog | orgId, actorId, action, targetType, targetId, diff(json), ip | idx(orgId,createdAt) |

The spec's separate `DailyReport`/`WeeklyReport` become one `Report` table with `kind`. `PerformanceMetric` is
created only if the snapshot JSON is not enough.

## 3. Roles and authorization (server-side)

| | Owner | Admin | Manager | Mentor | Member |
|---|---|---|---|---|---|
| Org settings, billing, delete org | ✓ | — | — | — | — |
| Members, roles, teams, scoring models | ✓ | ✓ | — | — | — |
| See tasks/analytics | org | org | teams they manage | assigned mentees (read-only) | own |
| Assessments / verify evidence | ✓ | ✓ | their reports, never own | feedback only | self-assessment |
| Integrations | own + org-level view | same | own | own | own |

Middleware chain: `authenticate → resolveTenant (membership of activeOrgId) → authorize(policy)`. Every Prisma query
goes through scoped helpers (`scopedTaskWhere(ctx)`) so `orgId` + visibility are always applied. Unit tests check
cross-tenant and cross-team access for every module.

## 4. Integrations: normalization engine

**Pipeline:**
`viaSocket handler → POST /api/integrations/events/:provider/:subscriptionId` (Bearer = per-subscription token,
hash-compared; rate-limited) → validate envelope → `SyncEvent` insert (unique idempotency key = provider event id /
`issueId:updatedAt`; a duplicate answers 200, nothing else happens) → **202** → BullMQ `ingest` job →
provider adapter (zod schema of the *real* payload) → deterministic mapper → normalizer applies the org's active
`SyncMapping` (status/priority/field) → **ordering guard**: skip if `externalUpdatedAt/revision ≤ stored`
(`SKIPPED_STALE`) → upsert `Task` + `TaskSource` by `(orgId, provider, externalId)` → write only **externally owned
fields** (title, description, status, priority, assignee, dueAt, project, labels); never impactLevel, evaluations,
evidence verification, feedback → `TaskActivity` (actor SYNC).

Retries: 5 attempts with exponential backoff, then `DEAD` (visible in Sync History with a Retry button).

**Unknown values** (a Linear state "QA Ready", an unknown Jira priority): the record is still imported (status falls
back to TODO and is flagged); AI may **suggest** a mapping + confidence → a pending `SyncMapping` → a user approves →
"Reprocess" re-runs the stored events. AI output is zod-validated against the fixed enums; AI never writes a task directly.

**Assignee mapping:** external user → member, by verified email match, else a manual mapping table in the
connection's settings. Unmapped = unassigned + flagged.

**Sync modes:** `IMPORT_ONLY` (one-time backfill), `ONE_WAY` (default: external → WorkPulse), `TWO_WAY` (opt-in, Linear
first): a WorkPulse status change → `Update_Issue_Status`. Conflict = both sides changed since `lastSyncedAt` →
`SyncConflict` row, the external value is not applied, the user resolves it in the UI.

## 5. viaSocket plan

**Three-line version:**
> Reply yes and I'll build this: each person clicks **Connect** on Linear, GitHub, Jira or Slack inside WorkPulse.
> Right after connecting they pick, once, which Linear team / Jira project / GitHub repos to bring in and which Slack
> channel gets their reports. From then on new and updated issues appear in WorkPulse automatically, PRs/commits/releases arrive as evidence, and reports post to Slack on schedule.

Feature: `app-integrations` (connect + triggers) and `automations` (webhook flows for outbound Slack/Gmail). SDK
`viasocket-apps` (installed 0.19.0; upgrade to latest and read its `.d.ts` before the first call). Every key and
version below was copied from the app pages on viasocket.com on 2026-11-15; each gets re-read from
`user.listActions(app)` and a real `sampleEvent` before code depends on it.

| app (slug) | action / trigger (key, version) | `inputData` key | who supplies it | when |
|---|---|---|---|---|
| linear | trigger `New_Issue_Created` v1 | `team_id` | the user, from their Linear teams (PICK via `Isuue_Status_Updated` v2 picker) | once, after Connect |
| linear | trigger `Updated_Issue` v2 | `team_id` | same stored choice | once, after Connect |
| linear | trigger `New_Issue_Comment` v1 | `team_id` | same stored choice | once, after Connect |
| linear | action `Update_Issue_Status` v3 (TWO_WAY only) | `teams` | stored team choice | once, after Connect |
| linear | action `Update_Issue_Status` v3 | `issue` | WorkPulse: the task's stored external id (the record names it) | per run |
| linear | action `Update_Issue_Status` v3 | `stateID` | the user's status map (internal status → a Linear state, PICK), set once when enabling two-way | once, at two-way setup |
| linear | backfill: `runCode` (Linear GraphQL with the connection) | team id, `updatedAfter` cursor | stored team + `SyncCheckpoint` | per run (import) |
| jira-software-cloud | trigger `New_Issue` v2 | `project` | the user picks a Jira project (PICK) | once, after Connect |
| jira-software-cloud | trigger `New_Issue` v2 | `status` | left out on purpose (all statuses) | — |
| jira-software-cloud | trigger `Updated_Issue` v4 | `project` / `status` | stored project / left out | once |
| jira-software-cloud | action `Find_Issue_via_JQL` v1 (backfill) | `jql` | WorkPulse builds `project = "<stored key>" AND updated >= "<checkpoint>"` from validated values only | per run |
| github | trigger `Pull_Request_Opens_or_Closes` v22 | `repoFullName` | the user picks repos (PICK) | once, after Connect |
| github | trigger `New_Commit_Pushed` v6 | `repoFullName`, `sha` | stored repo / `sha` (branch) decided from the trigger page before build | once |
| github | trigger `New_Release_Published` v6 | `repoFullName` | stored repo | once |
| github | trigger `When_a_new_issue_is_created` v7 | `repoFullName` | stored repo (only if the user turns on "import GitHub issues as tasks") | once |
| github | action `List_Pull_Requests` v4 (evidence backfill) | `repoFullName` / `updatedAfter` | stored repo / checkpoint | per run |
| slack | action `Send_Message` v107 (inside a per-user webhook flow) | `destination.messageto` | the user: "DM me" or "a channel" | once, at report setup |
| slack | action `Send_Message` v107 | `destination.channel_id` or `destination.userId` | the user (PICK) | once, at report setup |
| slack | action `Send_Message` v107 | `markdown_content` | WorkPulse report/notification text; AI may write the summary paragraph, which is validated and length-capped | per run |
| slack | action `Send_Message` v107 | threads, `tagged_users`, `buttons`, `schedule_type`, `bot_details` | left out on purpose | — |
| gmail | action `Send_Email` v55 (webhook flow) | `to` | WorkPulse: the user's verified email, or recipients the manager picks from org members | once, at setup |
| gmail | action `Send_Email` v55 | `subject`, `messageBody` | WorkPulse report content (AI summary validated) | per run |

**Who picks each action:** always WorkPulse's code, from a fixed allowlist (the table above). Outbound actions are
fixed in code, so each one is a **flow per user** (webhook trigger → one `Send_Message`/`Send_Email` step), as the
skill requires. WorkPulse's scheduler (BullMQ) decides *when* and POSTs the content. Inbound triggers are
`user.subscribe` with a handler that forwards to WorkPulse's events endpoint. **The AI never picks an action and no
app is enabled for AI tool use** (no enabled-app `script_id` given to the model).

**Where it runs:** all from the server; `auth_id` and every `script_id` stored encrypted, per user, with an ownership check
before use; the browser gets only that user's embed token for the Connect popup.

**Phase 2 apps** (triggers confirmed in the catalog; rows written when built): Trello (`Card_Updated` v1,
`Card_Archived` v2, …), Asana (`New_Task_Created_in_Selected_Project` v9, `New_Task_Completed` v5), ClickUp
(`When_a_new_task_is_created` v3, `When_a_task_is_updated` v6), Notion (`New_Data_Source_Item` v1,
`Data_Source_Item_Properties_Change` v1), Google Calendar, Google Sheets. **The Integrations Hub shows a card only for
an app whose adapter exists and has passed a real test.**

**Setup steps after your yes:** `npx -y viasocket-apps setup --no-open` prints a link → you click **Allow** → `.env`
gets the keys (I never see the secret) → `listConnections('apps-api-test-user')` check → you connect **test** Linear /
GitHub / Jira / Slack accounts through WorkPulse's own Connect button → each trigger sees one real event, each
action runs once on test data → `npx -y viasocket-apps check apps/api/src/integrations` → report every "Finished
when" line.

## 6. AI (OpenAI, structured outputs)

One `ai/` module: `chat.completions` with `response_format: json_schema` (strict) + zod re-validation. Features:
NL task creation (returns a draft the user confirms), decomposition (draft subtasks), classification
(category/complexity/impact suggestion), mapping suggestions, daily plan, blocker/deadline-risk detection, evidence
summary, daily/weekly summary text, assistant chat.

**Assistant tools** (function calling), each a server function that runs under the caller's auth context:
`list_my_tasks`, `get_task`, `list_goals`, `get_performance_snapshot`, `team_overview` (managers only),
`list_blockers`, `search_evidence`, `draft_task` (creates nothing; returns a draft for UI confirmation). No SQL, no
Prisma passthrough, no integration actions. Answers cite record ids; a missing metric is stated as missing.
**AI never sets a score or rating**; its suggestions are labelled "AI suggestion" and need a human to accept them.
Without `OPENAI_API_KEY`, AI features show "not configured" and everything else works.

## 7. Performance and impact engine

Per subject (user/team) and period, deterministic, versioned (`ScoringModel.version`):

| Dimension (default weight) | Computed from | Missing-data rule |
|---|---|---|
| Impact (30%) | Σ completed tasks' impactLevel × complexity factor, **verified evidence counted fully, unverified ×0.5**, normalised against the planned-impact baseline for the role | no impact-rated tasks → "insufficient data", weight redistributed and shown |
| Execution quality (25%) | manager/mentor quality assessments (1-5), reopen rate | no assessments → excluded, shown as missing |
| Goal alignment (20%) | share of completed **impact** (not count) linked to active goals; KR progress | — |
| Delivery reliability (15%) | on-time completions ÷ committed-with-due-date; tasks blocked by a resolved *external* blocker are excused | — |
| Evidence completeness (10%) | completed high/critical tasks with ≥1 verified evidence | — |
| Efficiency (diagnostic, 0%) | estimate vs actual, cycle time, WIP | shown, **not scored**, so hours never count as productivity |

`score = Σ(normalised_dimension × weight) / Σ(weights of dimensions with data) × 100`. Each snapshot stores inputs,
missing list, model version and time → the "Why this score?" drawer. Raw task count is never an input. Snapshots are
written nightly by a BullMQ job (and on demand); dashboards read snapshots plus a live "today" delta. Users can file a
correction request on any score component.

> Note: the spec lists *Efficiency* as a dimension but gives it no weight, and gives 10% to *Evidence completeness*.
> I followed the weights; Efficiency is shown but not scored. Say if you want it weighted.

## 8. Frontend modules

Shell: responsive sidebar (Personal / Team / Automation / System, as specified; Team items hidden by role), top bar
with global search (tasks, projects, people), org switcher, notifications, user menu, breadcrumbs, global date-range
filter (URL state).

Pages: Auth (login, register, verify, reset, accept invite) · Onboarding (create org) · My Dashboard · Daily Planner
(plan, check-in, focus timer, end-of-day review, carry-forward) · My Tasks (Kanban / List / Calendar / Timeline, filters,
bulk actions, task drawer with subtasks, deps, comments, evidence, activity) · Goals & OKRs · Projects · My Analytics ·
Team Overview · Team Analytics · Member Performance (comparison table → member profile) · Reviews & Feedback ·
Integrations Hub · Automation Center · Sync History · AI Assistant · Settings (profile, org, members, teams, roles,
scoring models, retention, audit log).

Charts: Recharts. **Every chart click sets a filter or navigates** (segment → filtered task list, person → profile,
project → project page). Each KPI has a tooltip with its definition and formula. Loading skeletons, empty states,
error states, toasts and confirm dialogs come from shared components.

## 9. Testing strategy

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | mappers per provider (fixtures = **real** captured payloads), status/priority normalization, ordering guard, idempotency, conflict detection, scoring math, goal progress, policy functions |
| API integration | Vitest + Supertest against a real Postgres test DB (Docker or local Homebrew), Redis | every route: auth, RBAC matrix, tenant isolation, ingestion endpoint (duplicate, out-of-order, invalid payload, bad token), reports |
| Frontend | Vitest + Testing Library | forms, filters, chart click → filter, error/empty states |
| E2E | Playwright | the spec's 18-step journey; steps 13-18 run only with `E2E_REAL_INTEGRATIONS=1` against test accounts |
| Real viaSocket | a manual + scripted report (`docs/viasocket-test-report.md`) | each trigger with a real event, each action with a real run; **mocked and real results kept separate** |

Integration failure tests (mocked SDK): invalid credentials, expired connection (`Auth data not found`), provider
5xx/timeout → retry/backoff → dead letter, 429, invalid payload, wrong tenant.

## 10. Security

argon2id passwords; httpOnly SameSite=Lax session cookie (hashed in DB, rotation on login); CSRF via SameSite plus an
origin check on mutations; helmet; CORS allowlist; rate limits (auth, events, AI); zod on every input; S3 uploads
with MIME + size validation, private bucket, signed URLs; `authId`/`scriptId` encrypted with AES-GCM using
`APP_ENCRYPTION_KEY`; pino redaction of tokens/secrets; event endpoint: per-subscription bearer token + idempotency +
payload size limit; audit log on role, scoring, assessment and integration changes; generic 500 messages.

## 11. Milestones (each ends with lint + typecheck + tests green, then a commit)

| # | Milestone | Done means |
|---|---|---|
| M0 | Branch, scaffold monorepo, docker-compose, env schema, CI scripts | `npm run dev` serves api and web; empty test suites pass |
| M1 | Prisma schema + migrations + seed; auth, orgs, invites, teams, roles, RBAC middleware | auth/RBAC/tenant tests pass; Playwright register → org → invite |
| M2 | Projects, tasks (all views, subtasks, deps, comments, attachments, recurrence, templates, bulk), goals/OKRs | CRUD tests + e2e steps 4-7 |
| M3 | viaSocket setup, Connect UI, **Linear** ingestion end-to-end (real), normalization engine, Sync History, retry/DLQ | a real Linear issue appears and updates in WorkPulse |
| M4 | GitHub evidence + Jira ingestion (real); evidence module + S3 uploads + verification | real PR → evidence on the matched task |
| M5 | Daily planner, focus sessions, performance engine, snapshots, individual dashboard | scoring unit tests; dashboard reads DB |
| M6 | Team/manager dashboard, member profiles, team health, interactive charts | e2e steps 10-11 |
| M7 | AI module + assistant tools (OpenAI) | grounded-answer tests with fixtures; tool auth tests |
| M8 | Reports (PDF/CSV), Slack/Gmail delivery flows (real), notifications, feedback, correction requests, audit, settings | e2e step 12; real Slack post |
| M9 | Two-way Linear sync + conflicts; phase-2 adapters only as time allows | conflict tests |
| M10 | Hardening, full test run, production build, deployment docs, final report | the spec's quality gate |

This is a large build that will run over many sessions. I will report status per milestone honestly
(COMPLETED / PARTIAL / BLOCKED).

## 12. Decisions needed from you

- **D1 Hosting:** keep Embarko (no Postgres/Redis → would force SQLite + in-process jobs) **or** move to a host with
  PostgreSQL + Redis (recommended; matches the spec). Local dev uses Docker Compose either way.
- **D2 AI provider:** the spec says OpenAI, so I need `OPENAI_API_KEY` (and a model choice, default `gpt-4.1`-class with
  structured outputs) **or** keep the existing Anthropic setup.
- **D3 Existing data:** is there live TeamPulse data (teampulse.embarko.app) to migrate, or start fresh? (Recommended: fresh.)
- **D4 Test accounts** for M3/M4/M8: a Linear workspace, a GitHub repo, a Jira Cloud project, a Slack workspace, all
  test or sandbox, not production.
- **D5** Start the Docker daemon (Docker Desktop), or let me use the Homebrew Postgres/Redis already installed.

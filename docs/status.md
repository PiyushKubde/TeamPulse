# Implementation status (2026-11-15)

Branch `workpulse`. The original `claude/teampulse-mvp` branch is untouched at `7c94b55`.

## Test and build results

| Check | Result |
|---|---|
| ESLint | 0 errors, 0 warnings |
| Prettier | clean |
| TypeScript (shared, api, web), strict + `noUncheckedIndexedAccess` | 0 errors |
| API unit + integration tests (Vitest, real PostgreSQL, mocked viaSocket/AI) | **103 passed** (7 files) |
| Web component tests (Vitest + Testing Library) | **16 passed** (3 files) |
| Playwright end-to-end (isolated DB, Chromium) | **7 passed, 1 skipped** (real-integration journey: BLOCKED) |
| Real viaSocket self-test | **12/12 passed** |
| `viasocket-apps check` | 0 FAIL, 0 WARN |
| Production build | passes; compiled API and worker start, serve requests and register schedules |
| Docker Compose | **not verified**: the Docker daemon was not running; the build used Homebrew PostgreSQL 18 and Redis 8 |

Bugs found by tests and fixed during the build: the auth rate limit covered `/auth/me` and locked out normal browsing; a
date-only range end excluded today's work; org-wide roles could address user ids of other orgs (data stayed filtered,
now 404); reliability ignored work finished early; Zod 4 records required every status key; `runHistory` read the wrong field.

## Milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Branch, monorepo, config, env schema | COMPLETED |
| M1 | Schema, migrations, seed; auth, orgs, invites, teams, roles, RBAC | COMPLETED |
| M2 | Projects, tasks (4 views, subtasks, deps, comments, attachments, recurrence, bulk), goals/OKRs | COMPLETED (templates: API only, no UI) |
| M3 | viaSocket setup, Connect, Linear ingestion, normalization, Sync History, retries/DLQ | PARTIAL: built and mock-tested; **live Linear BLOCKED** (no test workspace, no public URL) |
| M4 | GitHub evidence, Jira ingestion, evidence module + uploads + verification | PARTIAL: built and mock-tested; **live GitHub/Jira BLOCKED**; GitHub evidence backfill (`List_Pull_Requests`) not built |
| M5 | Planner, focus sessions, performance engine, snapshots, individual dashboard | COMPLETED |
| M6 | Team dashboard, member profiles, team health, interactive charts | COMPLETED |
| M7 | AI module and assistant | COMPLETED in code (mock-tested); real viaSocket structured call verified; off until `AI_DATA_POLICY_CONFIRMED=true` |
| M8 | Reports (PDF/CSV), Slack/Gmail delivery, notifications, feedback, corrections, audit, settings | PARTIAL: all built; **live Slack/Gmail delivery BLOCKED**; email needs SMTP |
| M9 | Two-way Linear sync + conflicts; phase-2 adapters | PARTIAL: two-way built and mock-tested (live BLOCKED); phase-2 apps NOT STARTED |
| M10 | Hardening, full test run, build, docs | COMPLETED |

## Feature completion

| Feature | Status | Test evidence |
|---|---|---|
| Authentication | COMPLETED | `api-auth.test.ts` (register/login/logout, argon2id, verify, reset ends sessions, CSRF); e2e steps 1–3 |
| Organizations, invitations, teams, roles | COMPLETED | `api-auth.test.ts`; e2e invite + accept |
| Task management | COMPLETED | `api-work.test.ts` (CRUD, filters, subtasks, deps/cycles, blockers, recurrence, bulk, attachments); web `pages.test.tsx`; e2e steps 6–7 |
| Goal management | COMPLETED | `api-work.test.ts` (KR-derived progress, history, permissions); e2e step 5 |
| Daily planner & sessions | COMPLETED | `api-work.test.ts` (plan, timer → effort, carry-forward reasons) |
| Evidence & verification | COMPLETED | `api-work.test.ts`, `api-integrations.test.ts` (GitHub evidence, unmatched never auto-applied); e2e step 8 |
| Linear integration | PARTIAL (live BLOCKED) | mock: 20 tests in `api-integrations.test.ts`; real: catalog keys/ids verified, checker 0 FAIL |
| GitHub integration | PARTIAL (live BLOCKED) | mock: per-repo subscriptions, PR → evidence, key matching; real: catalog verified |
| Jira integration | PARTIAL (live BLOCKED) | mock: adapter (envelope, ADF, JQL lists), two-way refused; real: catalog verified |
| Slack integration | PARTIAL | message → task: real subscription + real sample event verified, mock-tested (5 tests); live message not yet observed; `Send_Message` not run live |
| Normalization engine | COMPLETED (mock-verified) | `unit-normalization.test.ts`, ingestion tests (stale, duplicates, internal fields, mappings, reprocess) |
| Individual analytics | COMPLETED | `unit-performance.test.ts` (11 rules), `api-work.test.ts`; e2e step 9 |
| Team analytics | COMPLETED | `api-work.test.ts` (scope, filters); e2e steps 10–11; screenshots reviewed |
| AI assistant | COMPLETED (gated) | `api-ai.test.ts` (not-configured state, validation, invented ids dropped, out-of-scope tools refused, drafts don't write); real structured call PASS |
| Reporting | COMPLETED (Slack/email delivery BLOCKED live) | `api-work.test.ts` (daily/weekly, CSV, PDF, scoping); e2e step 12 |
| Notifications | PARTIAL | in-app + Slack escalation; scheduled jobs run against data; no email notifications for deadlines (reports only) |
| Feedback, corrections, audit, scoring models | COMPLETED | `api-work.test.ts`, `api-auth.test.ts` |
| Security | COMPLETED | tenant/role tests, encrypted ids, token hashing, CSRF, upload checks, CSV injection, rate limits |
| Data retention | PARTIAL | setting stored; no purge job yet |
| Trello, Asana, ClickUp, Notion, Google Calendar, Google Sheets | NOT STARTED | not shown in the Integrations Hub |

## Waiting on you

1. **Test accounts** for Linear, GitHub, Jira, Slack (and Gmail), connected through WorkPulse's Connect button.
2. **A public HTTPS URL** for the API (`PUBLIC_API_URL`): a tunnel for local testing, or the production host.
3. **Production host choice**, then the environment from `docs/deployment.md`.
5. **Email**: connect Gmail in Integrations as an owner/admin (or set SMTP) so verification, reset and invitation emails are sent.
6. **Rotate the viaSocket embed secret** before production (it was shared in chat).

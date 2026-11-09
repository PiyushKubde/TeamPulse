# TeamPulse

Team task management and impact tracking. **More tasks do not mean more productivity — value matters more than task count.**

TeamPulse helps managers see what each person is working on, what is pending, blocked, overdue or waiting for review, where people need help — and which meaningful, *verified* outcomes they delivered. Task counts are shown only as operational information; there is no productivity score.

## What is in the MVP

| Area | What works |
| --- | --- |
| Sign-in | Continue with Google (OAuth 2.0 / OpenID Connect, PKCE, state, nonce, RS256 ID-token verification). Identity = Google `sub`. |
| Organizations | Create an organization (creator becomes admin), invitations bound to a Google-verified email, join-by-code with manager/admin approval. No role is ever granted from an email domain. |
| Roles | Admin, Manager, Employee — enforced on the server for every route. Managers see only the teams they manage; other organizations are invisible (404). |
| Tasks | Full CRUD, assignment/reassignment, priorities, start/due dates, links, statuses `ASSIGNED → IN_PROGRESS → BLOCKED → SUBMITTED_FOR_REVIEW → COMPLETED`, `CANCELLED`, reopen/restore as recorded events. Overdue and at-risk are **derived**. |
| Permissions | Per-employee `can_create_tasks`, `can_create_directly`, `can_self_assign`, `can_assign_others`, `approval_required`; every change audited. |
| Task requests | Suggestions with reason/outcome/priority/deadline; approve (creates the official task), reject (reason required), ask for clarification. Request status separate from task status. |
| Blockers & history | Report/resolve/escalate blockers with dependency owner, time blocked; full activity history (creation, assignment, status, deadline, comments, blockers, submissions, reviews). |
| Review | Completion submissions with summary, outcome, evidence links and private file uploads; approve or request changes. Completion never verifies impact. |
| Impact | Impact records by category with before/work/after, measured vs **estimated** values, prevention/research/learning, shared-outcome de-duplication, manager verification with reasons. |
| Dashboards | Manager: counts, team workload, attention required, recent activity, verified team impact. Employee: my work, awaiting me, deadlines, feedback, my impact, daily reflection. |
| Reports | Weekly team summary, workload, status distribution, overdue, blocker history, contributions, verified impact — date and person filters, CSV export. |
| Alerts | In-app notifications for every alert rule; configurable thresholds; M91 delivery queue with retries, history and idempotent callbacks (**M91 API call pending — see below**). |
| Automation Center | ViaSocket: curated Connected Apps (Slack, Gmail, GitHub, Google Calendar, Google Sheets), three ready-made automations, and the full ViaSocket Embed builder. |

## Stack and decisions

The repository was empty; the stack follows the team's working DealSaathi project, which already runs on Embarko with ViaSocket:

- **Node.js 22.13+ / Express 5**, vanilla ES-module frontend (no build step) in `public/`.
- **SQLite** via Node's built-in `node:sqlite`, file under `DATA_DIR`. Embarko offers no managed PostgreSQL (its docs: "No managed database … use SQLite under DATA_DIR"), so PostgreSQL was not used. Schema changes are committed SQL migrations in `server/migrations/`, applied at start-up and by `npm run migrate`.
- **viasocket-apps** SDK for ViaSocket (server) and its browser half for the Connect popup; the prebuilt Embed for the full builder.
- **Embarko schedules** (`embarko.json`) for background jobs — no in-process timers in production.

More in [docs/architecture.md](docs/architecture.md).

## Run it locally

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in the Google values (see [docs/integrations.md](docs/integrations.md#google-sign-in)), then:

```bash
npm start
```

Open http://localhost:3000.

To try every role without Google, use development sign-in and the demo organization (never active in production):

```bash
DEV_LOGIN=1 npm run seed:demo
```

```bash
DEV_LOGIN=1 npm start
```

Then sign in as `manager@demo.teampulse`, `admin@demo.teampulse`, or employees `priya@`, `dev@`, `neha@demo.teampulse`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the server (applies pending migrations first) |
| `npm run dev` | Start with file watching |
| `npm run migrate` | Apply pending migrations and exit |
| `npm test` | Unit + API tests (`node:test`, in-memory database) |
| `npm run test:e2e` | Browser journeys in Chromium (Playwright) against a temporary server |
| `npm run lint` | ESLint |
| `npm run seed:demo` | Demo organization for local development |

## Configuration

Every secret comes from environment variables; see [.env.example](.env.example). Nothing secret is committed.

| Integration | Needed for | Without it |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Signing in | The login page says sign-in is not configured |
| `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET` | Connected apps, Slack/Gmail delivery, builder | Automation Center shows it is not configured; external requests and in-app alerts still work |
| `M91_AUTH_KEY`, `M91_CALLBACK_TOKEN` | M91 alerts | Alerts are in-app only |

## Deploying

See [docs/deployment-embarko.md](docs/deployment-embarko.md).

## Project layout

```
server/
  index.js            boot: config, database, integrations, HTTP
  app.js              routes, middleware (security headers, CSRF guard, rate limits, sessions), scheduled-job routes
  access.js           roles, scopes, task visibility — the authorization core
  auth/               Google OIDC and sessions
  services/           orgs, permissions, tasks, requests, impact, evidence, alerts, reports, dashboards
  integrations/       viaSocket gateway, connections, actions; M91 transport
  automations/        ready-made automations engine
  migrations/         committed SQL migrations
public/               single-page app (index.html, styles.css, js/)
test/                 API and business-rule tests
scripts/              demo seed, e2e journeys
docs/                 architecture, integrations, deployment
```

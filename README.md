# KONVO

**One workspace. Every task. Measurable impact.**

KONVO brings tasks from Linear, Jira and GitHub together with native tasks, then measures the *value* of the work:
impact, execution quality, delivery reliability, goal alignment and evidence. It never counts raw task volume or hours.

It does this in the open, for everyone from the CEO to an intern: reporting lines, departments, objectives and key results that
cascade down from the company, and KPIs for every person. The **Company** page shows the org chart with roll-ups, compares
peers, mentors, managers and departments, and opens any person's scorecard.

| | |
|---|---|
| `apps/api` | Node.js, TypeScript, Express 5, Prisma 7 (PostgreSQL), BullMQ (Redis), viaSocket (`viasocket-apps`) |
| `apps/web` | React 19, TypeScript, Vite, Tailwind CSS 4, Radix primitives, TanStack Query, React Hook Form, Recharts |
| `packages/shared` | Zod schemas, enums and DTO types shared by the API and the web app |
| `e2e` | Playwright end-to-end journey |
| `docs/` | [Architecture](docs/architecture.md) · [API](docs/api.md) · [Integrations](docs/integrations.md) · [viaSocket test report](docs/viasocket-test-report.md) · [Deployment](docs/deployment.md) · [Status](docs/status.md) |

## Local development

Requirements: Node.js 22.13+ (tested on 26.9) and npm 11. Nothing else: the database is a SQLite file and background
jobs run inside the API process, the same as on Embarko.

### 1. Configure

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste as APP_ENCRYPTION_KEY
```

For integrations and AI, add the three `VIASOCKET_*` values (see [Integrations](docs/integrations.md)); for phone alerts,
`M91_SEND_LINK` and `M91_API_KEY` (see [M91 alerting](docs/m91-alerting.md)).

### 2. Install, migrate, seed, run

```bash
npm install
npm run db:deploy        # apply migrations
npm run db:seed          # optional: demo organization "Northwind Labs (demo)"
npm run db:seed:company -w @workpulse/api   # optional: "Helios Corp", ~150 people with a CEO, departments, goals and KPIs
npm run dev              # API :4000 (with jobs and schedules), web :5173
```

Open http://localhost:5173. Demo accounts (seed only): `olivia@`, `marcus@`, `priya@`, `diego@`, `lena@`, `sam@demo.workpulse.dev`,
password `Password123`. Olivia is the owner, Marcus a manager, Sam a mentor. Never run the seed against production; it refuses
when `NODE_ENV=production`.

Without SMTP, emails (verification, reset, invitations) are written to the API log, and invitation links are shown to the
inviter to share by hand.

## Checks

```bash
npm run lint             # ESLint + Prettier
npm run typecheck        # all workspaces
npm test                 # API (unit + integration against PostgreSQL) and web component tests
npm run test:e2e         # Playwright; uses its own database (workpulse_e2e) and ports 4100/5180
npm run viasocket:selftest   # REAL viaSocket checks that need no connected app account
npm run build            # production build of all workspaces
```

The API tests reset `TEST_DATABASE_URL`, and `test:e2e` resets `workpulse_e2e`. Neither touches `DATABASE_URL`.
Integration and AI tests use a deterministic fake viaSocket transport. Real-account results are recorded separately in
[docs/viasocket-test-report.md](docs/viasocket-test-report.md).

## Production

```bash
npm ci && npm run build
npm start                # migrations, then one process: API, web app, background jobs
```

Hosted on Embarko as https://teampulse.embarko.app: see [docs/deployment.md](docs/deployment.md).

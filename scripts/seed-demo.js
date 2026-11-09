// `npm run seed:demo`: a demo organization for local development (use with DEV_LOGIN=1).
// Sign in on the login page as any of the emails below. Refuses to run in production.
import { join } from 'node:path'
import { loadConfig } from '../server/config.js'
import { openDatabase, now, uuid } from '../server/db.js'
import { upsertGoogleUser } from '../server/auth/google.js'
import { createOrganization } from '../server/services/orgs.js'
import { loadContext } from '../server/access.js'
import { createTask, changeStatus, updateProgress, reportBlocker, submitForReview } from '../server/services/tasks.js'
import { createRequestRecord } from '../server/services/requests.js'
import { createImpact, verifyImpact } from '../server/services/impact.js'
import { updatePermissions } from '../server/services/permissions.js'

const cfg = loadConfig()
if (cfg.production) { console.error('Refusing to seed demo data in production.'); process.exit(1) }
const db = openDatabase(join(cfg.dataDir, 'teampulse.db'))
if (db.prepare(`SELECT 1 FROM users WHERE email = 'admin@demo.teampulse'`).get()) { console.log('Demo data already present.'); process.exit(0) }

const user = (email, name) => upsertGoogleUser(db, { sub: `dev:${email}`, email, emailVerified: true, name })
const admin = user('admin@demo.teampulse', 'Asha Admin')
const org = createOrganization(db, admin, { name: 'Demo Co', teamName: 'Leadership' })
const ts = now()
const team = (name, managerId) => { const id = uuid(); db.prepare('INSERT INTO teams (id, org_id, name, manager_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, org.id, name, managerId, ts, ts); return id }
const member = (u, role, teamId) => db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(uuid(), org.id, u.id, role, teamId, ts, ts)
const manager = user('manager@demo.teampulse', 'Mohan Manager')
const platform = team('Platform', manager.id)
member(manager, 'manager', platform)
const priya = user('priya@demo.teampulse', 'Priya Sharma')
const dev = user('dev@demo.teampulse', 'Dev Patel')
const neha = user('neha@demo.teampulse', 'Neha Rao')
for (const u of [priya, dev, neha]) member(u, 'employee', platform)
const ctx = (u) => loadContext(db, db.prepare('SELECT * FROM users WHERE id = ?').get(u.id))
const H = 3600000
const at = (h) => new Date(Date.now() + h * H).toISOString()

const m = ctx(manager)
updatePermissions(db, m, neha.id, { can_create_tasks: true, can_create_directly: true, approval_required: false, can_self_assign: true })
const t1 = createTask(db, m, { title: 'Cut checkout API p95 latency below 200ms', expectedOutcome: 'Checkout p95 < 200ms at peak', priority: 'HIGH', assigneeId: priya.id, dueAt: at(30) }).task
changeStatus(db, ctx(priya), t1.id, { status: 'IN_PROGRESS' })
updateProgress(db, ctx(priya), t1.id, { progress: 55, note: 'Added response cache for catalog lookups' })
const t2 = createTask(db, m, { title: 'Migrate billing DB to managed Postgres', expectedOutcome: 'Zero-downtime migration, automated backups', priority: 'CRITICAL', assigneeId: dev.id, dueAt: at(20) }).task
changeStatus(db, ctx(dev), t2.id, { status: 'IN_PROGRESS' })
reportBlocker(db, ctx(dev), t2.id, { description: 'Waiting for the vendor to raise the connection limit', dependencyNote: 'Cloud vendor support ticket', isExternal: true })
const t3 = createTask(db, m, { title: 'Write on-call runbook for payments', expectedOutcome: 'New on-call engineers resolve P2s without escalation', priority: 'MEDIUM', assigneeId: neha.id, dueAt: at(-5) }).task
changeStatus(db, ctx(neha), t3.id, { status: 'IN_PROGRESS' })
const t4 = createTask(db, m, { title: 'Automate weekly invoice reconciliation', expectedOutcome: 'Finance saves 5h/week', priority: 'HIGH', assigneeId: priya.id, dueAt: at(72) }).task
changeStatus(db, ctx(priya), t4.id, { status: 'IN_PROGRESS' })
submitForReview(db, ctx(priya), t4.id, { summary: 'Script reconciles Stripe payouts with the ledger and flags mismatches', outcome: 'Ran on last 4 weeks: 100% match, 3 mismatches flagged correctly' })
createTask(db, m, { title: 'Evaluate feature-flag vendors', priority: 'LOW', dueAt: at(240) })
createRequestRecord(db, ctx(dev), { title: 'Add canary deploys for the API', reason: 'Two incidents last month shipped straight to 100% of traffic', expectedOutcome: 'Bad releases caught at 5% traffic', suggestedPriority: 'HIGH' })
const imp = createImpact(db, ctx(neha), { title: 'Removed flaky test suite from CI', category: 'TIME_SAVED', outcomeType: 'DELIVERED', previousState: 'CI failed ~1 in 5 runs from flaky integration tests; reruns cost ~6h/week team-wide', workPerformed: 'Isolated network calls behind fakes; quarantined 3 tests and fixed 9', result: 'Flaky failures down to ~1 in 60 runs over 2 weeks', valueType: 'ESTIMATED', measurableValue: 5, measurementUnit: 'hours/week', isQuality: true, evidenceLinks: [{ url: 'https://example.com/ci-dashboard' }] })
verifyImpact(db, m, imp.id, { decision: 'VERIFIED', comment: 'Matches the CI dashboard' })
createImpact(db, ctx(dev), { title: 'Prevented a disk-full outage on the queue cluster', category: 'RELIABILITY', outcomeType: 'PREVENTION', previousState: 'Queue disk usage was growing 4%/day with no alert', workPerformed: 'Added retention policy and a disk alert at 70%', result: 'Usage stable at 41%; alert tested', valueType: 'NONE' })
createImpact(db, ctx(priya), { title: 'Tried HTTP/3 for the mobile API', category: 'KNOWLEDGE_INNOVATION', outcomeType: 'LEARNING', previousState: 'Hypothesis: HTTP/3 would cut mobile latency', workPerformed: 'A/B test on 5% of traffic for a week', result: 'No measurable gain on our traffic; documented and dropped', valueType: 'NONE', isReusable: true })

console.log(`Demo organization "Demo Co" created. With DEV_LOGIN=1, sign in as:
  admin@demo.teampulse    (admin)
  manager@demo.teampulse  (manager of Platform)
  priya@demo.teampulse, dev@demo.teampulse, neha@demo.teampulse (employees)`)

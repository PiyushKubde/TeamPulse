// Helios Corp demo company: about 150 people with a real hierarchy, to show company-wide transparency at scale:
// CEO > executives > department heads > squad leads > people, mentors beside them, goals that cascade from company
// objectives down to individuals, KPIs for everyone from the CEO down, and eight weeks of work history.
// Sends nothing to anyone: every demo account has a placeholder phone marked "declined", so no alert invitation is ever
// created, and scheduled jobs only write in-app notifications for people without Slack.
// Two ways in: the CLI (prisma/seed-company.ts, development only) and the server at startup when DEMO_SEED=helios.
import { randomUUID } from 'node:crypto'
import { hash } from '@node-rs/argon2'
import { DEFAULT_WEIGHTS } from '@workpulse/shared'
import { prisma, type ImpactLevel, type TaskStatus } from '../lib/prisma.js'

export const HELIOS_SLUG = 'helios-demo'
const SLUG = HELIOS_SLUG
const DAY = 864e5
let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n))
const daysAgo = (n: number, h = 10) => new Date(Date.now() - n * DAY + (h - 12) * 36e5)

const FIRST = [
  'Aarav',
  'Meera',
  'Rohan',
  'Ananya',
  'Kabir',
  'Isha',
  'Vihaan',
  'Diya',
  'Arjun',
  'Saanvi',
  'Neil',
  'Tara',
  'Dev',
  'Riya',
  'Karan',
  'Nisha',
  'Samar',
  'Pooja',
  'Yash',
  'Leela',
  'Omar',
  'Zoya',
  'Ethan',
  'Maya',
  'Lucas',
  'Chloe',
  'Noah',
  'Priya',
  'Ivan',
  'Hana',
  'Marco',
  'Sofia',
  'Jonas',
  'Elena',
  'Tomas',
  'Aisha',
  'Felix',
  'Lina',
  'Hugo',
  'Nora',
]
const LAST = [
  'Mehta',
  'Sharma',
  'Iyer',
  'Nair',
  'Kapoor',
  'Reddy',
  'Bose',
  'Chopra',
  'Desai',
  'Rao',
  'Gill',
  'Menon',
  'Shah',
  'Verma',
  'Joshi',
  'Banerjee',
  'Khan',
  'Singh',
  'Patel',
  'Das',
  'Costa',
  'Weber',
  'Novak',
  'Silva',
  'Kim',
  'Park',
  'Rossi',
  'Ivanov',
  'Lopez',
  'Berg',
]
let nameN = 0
const usedNames = new Set<string>()
const nextName = () => {
  // 40 first names x 30 surnames only cycle through 120 distinct pairs, so later people get a middle initial.
  const first = FIRST[(nameN * 7 + 3) % FIRST.length]!
  const last = LAST[(nameN * 11 + 5) % LAST.length]!
  let n = `${first} ${last}`
  if (usedNames.has(n)) n = `${first} ${String.fromCharCode(65 + (nameN % 26))}. ${last}`
  for (let k = 0; usedNames.has(n); k++) n = `${first} ${String.fromCharCode(65 + ((nameN + k) % 26))}. ${last} ${k + 2}`
  nameN++
  usedNames.add(n)
  return n
}

// Departments under each executive: [name, squads, job title for people]
const EXECS: { title: string; dept: [string, [string, string], string][] }[] = [
  {
    title: 'Chief Technology Officer',
    dept: [
      ['Platform Engineering', ['Core Services', 'Infrastructure'], 'Software Engineer'],
      ['Product Engineering', ['Web', 'Mobile'], 'Software Engineer'],
      ['Data & AI', ['Data Platform', 'Applied AI'], 'Data Engineer'],
      ['Security & Reliability', ['SRE', 'Security'], 'Reliability Engineer'],
    ],
  },
  {
    title: 'Chief Operating Officer',
    dept: [
      ['Operations', ['Delivery', 'Vendor Management'], 'Operations Analyst'],
      ['People & Culture', ['Talent', 'People Programs'], 'People Partner'],
      ['Customer Support', ['Tier 1', 'Tier 2'], 'Support Specialist'],
    ],
  },
  {
    title: 'Chief Financial Officer',
    dept: [
      ['Finance', ['Accounting', 'Planning'], 'Finance Analyst'],
      ['Legal & Compliance', ['Contracts', 'Compliance'], 'Counsel'],
    ],
  },
  {
    title: 'Chief Product Officer',
    dept: [
      ['Product Management', ['Core Product', 'Growth Product'], 'Product Manager'],
      ['Design', ['Product Design', 'Brand'], 'Designer'],
    ],
  },
  {
    title: 'Chief Revenue Officer',
    dept: [
      ['Sales', ['Enterprise', 'Mid-market'], 'Account Executive'],
      ['Marketing', ['Demand', 'Content'], 'Marketing Specialist'],
      ['Customer Success', ['Onboarding', 'Renewals'], 'Success Manager'],
    ],
  },
]

interface P {
  id: string
  name: string
  email: string
  role: 'OWNER' | 'MANAGER' | 'MENTOR' | 'MEMBER'
  title: string
  reportsToId: string | null
  /** 0-1: how well this person is doing. Drives the demo data, so the company shows a realistic spread. */
  q: number
  /** Level of the person in the tree (0 = CEO). */
  level: number
  parentGoalId?: string
}
const people: P[] = []
const emailOf = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@helios.demo.konvo.dev`
const person = (role: P['role'], title: string, reportsToId: string | null, level: number, q?: number): P => {
  const name = nextName()
  const p: P = { id: randomUUID(), name, email: emailOf(name), role, title, reportsToId, level, q: q ?? clamp(0.3 + rand() * 0.7 + (rand() - 0.5) * 0.1) }
  people.push(p)
  return p
}

interface TeamRow {
  id: string
  name: string
  parentId: string | null
  managerId: string
  memberIds: string[]
}
const teams: TeamRow[] = []
const mentorships: { mentorId: string; menteeId: string }[] = []

// ───────────── Build the hierarchy ─────────────
const ceo = person('OWNER', 'Chief Executive Officer', null, 0, 0.82)
const deptHeads: P[] = []
const leads: P[] = []
const ics: P[] = []
const execs: P[] = []
for (const e of EXECS) {
  const exec = person('MANAGER', e.title, ceo.id, 1, clamp(0.55 + rand() * 0.4))
  execs.push(exec)
  for (const [deptName, squads, jobTitle] of e.dept) {
    const head = person('MANAGER', `Head of ${deptName}`, exec.id, 2, clamp(0.5 + rand() * 0.45))
    deptHeads.push(head)
    const deptTeam: TeamRow = { id: randomUUID(), name: deptName, parentId: null, managerId: head.id, memberIds: [head.id] }
    teams.push(deptTeam)
    const mentor = person('MENTOR', `Principal ${jobTitle}`, head.id, 3, clamp(0.65 + rand() * 0.3))
    deptTeam.memberIds.push(mentor.id)
    const mentees: P[] = []
    for (const squad of squads) {
      const lead = person('MANAGER', `${squad} Lead`, head.id, 3, clamp(0.45 + rand() * 0.5))
      leads.push(lead)
      const t: TeamRow = { id: randomUUID(), name: `${deptName}: ${squad}`, parentId: deptTeam.id, managerId: lead.id, memberIds: [lead.id] }
      teams.push(t)
      for (let i = 0; i < 3; i++) {
        const ic = person('MEMBER', jobTitle, lead.id, 4)
        ics.push(ic)
        t.memberIds.push(ic.id)
        if (mentees.length < 2 && i === 0) mentees.push(ic)
      }
    }
    for (const m of mentees) mentorships.push({ mentorId: mentor.id, menteeId: m.id })
  }
}

// ───────────── Goals: company objectives cascade down the reporting line ─────────────
interface GoalRow {
  id: string
  ownerId: string
  teamId: string | null
  parentId: string | null
  title: string
  period: 'QUARTERLY' | 'MONTHLY'
  progress: number
  status: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK'
  krs: { title: string; unit: string; start: number; target: number; current: number }[]
}
const goals: GoalRow[] = []
const teamOf = new Map<string, string>() // userId -> their squad (or department) team id
for (const t of teams) for (const m of t.memberIds) if (!teamOf.has(m) || t.parentId) teamOf.set(m, t.id)

const frac = (p: P) => clamp(p.q * 0.95 + (rand() - 0.5) * 0.25)
const statusOf = (f: number) => (f >= 0.65 ? 'ON_TRACK' : f >= 0.4 ? 'AT_RISK' : 'OFF_TRACK')
function addGoal(owner: P, title: string, parentId: string | null, krs: { title: string; unit: string; start: number; target: number }[]): GoalRow {
  const f = frac(owner)
  const withCurrent = krs.map((k) => ({ ...k, current: Math.round((k.start + (k.target - k.start) * clamp(f + (rand() - 0.5) * 0.2)) * 10) / 10 }))
  const progress = Math.round((withCurrent.reduce((a, k) => a + clamp((k.current - k.start) / (k.target - k.start)), 0) / withCurrent.length) * 100)
  const g: GoalRow = {
    id: randomUUID(),
    ownerId: owner.id,
    teamId: teamOf.get(owner.id) ?? null,
    parentId,
    title,
    period: 'QUARTERLY',
    progress,
    status: statusOf(progress / 100),
    krs: withCurrent,
  }
  goals.push(g)
  return g
}

const companyGoals = [
  addGoal(ceo, 'Reach $60M annual recurring revenue', null, [
    { title: 'Annual recurring revenue', unit: '$M', start: 42, target: 60 },
    { title: 'Net revenue retention', unit: '%', start: 104, target: 118 },
  ]),
  addGoal(ceo, 'Be the most reliable platform in our category', null, [
    { title: 'Platform uptime', unit: '%', start: 99.5, target: 99.99 },
    { title: 'Customer-reported incidents / month', unit: '', start: 14, target: 3 },
  ]),
  addGoal(ceo, 'Build a high-performing, transparent company', null, [
    { title: 'Employee engagement score', unit: 'pts', start: 68, target: 85 },
    { title: 'Regretted attrition', unit: '%', start: 14, target: 6 },
  ]),
]
const execGoalTitles = [
  ['Ship the platform roadmap on time', 'Cut infrastructure cost per customer'],
  ['Make operations scale without adding headcount', 'Reduce customer wait times'],
  ['Predictable, healthy cash position', 'Close the books faster and cleaner'],
  ['Grow product adoption', 'Raise customer satisfaction'],
  ['Hit the new-business plan', 'Grow expansion revenue'],
]
const execGoal = new Map<string, GoalRow[]>()
execs.forEach((e, i) => {
  const parent = companyGoals[i % companyGoals.length]!
  const gs = execGoalTitles[i]!.map((t, j) =>
    addGoal(e, t, j === 0 ? parent.id : companyGoals[(i + 1) % companyGoals.length]!.id, [{ title: `${t}: target`, unit: '%', start: 20, target: 100 }]),
  )
  execGoal.set(e.id, gs)
})
const goalOf = new Map<string, GoalRow>() // userId -> their primary goal
for (const e of execs) goalOf.set(e.id, execGoal.get(e.id)![0]!)
for (const h of deptHeads) {
  const parent = goalOf.get(h.reportsToId!)!
  goalOf.set(
    h.id,
    addGoal(h, `Deliver ${h.title.replace('Head of ', '')} commitments`, parent.id, [{ title: 'Commitments delivered', unit: '%', start: 30, target: 100 }]),
  )
}
for (const l of leads) {
  const parent = goalOf.get(l.reportsToId!)!
  goalOf.set(
    l.id,
    addGoal(l, `${l.title.replace(' Lead', '')} quarterly plan`, parent.id, [{ title: 'Plan milestones met', unit: '%', start: 25, target: 100 }]),
  )
}
for (const p of people.filter((x) => x.role === 'MENTOR')) {
  const parent = goalOf.get(p.reportsToId!)!
  goalOf.set(
    p.id,
    addGoal(p, 'Grow the capability of the team', parent.id, [{ title: 'Mentees reaching their growth goals', unit: '%', start: 0, target: 100 }]),
  )
}
for (const ic of ics) {
  const parent = goalOf.get(ic.reportsToId!)!
  goalOf.set(ic.id, addGoal(ic, `${ic.title}: own deliverables`, parent.id, [{ title: 'Deliverables shipped', unit: '%', start: 10, target: 100 }]))
}

// ───────────── KPIs ─────────────
interface KpiRow {
  id: string
  ownerId: string
  teamId: string | null
  goalId: string | null
  name: string
  unit: string
  direction: 'HIGHER' | 'LOWER'
  baseline: number
  target: number
  current: number
  readings: number[]
}
const kpis: KpiRow[] = []
function addKpi(owner: P, name: string, unit: string, direction: 'HIGHER' | 'LOWER', baseline: number, target: number, goalId?: string) {
  const f = clamp(frac(owner) + (rand() - 0.5) * 0.2)
  const current = Math.round((baseline + (target - baseline) * f) * 100) / 100
  const readings = Array.from(
    { length: 6 },
    (_, i) => Math.round((baseline + (current - baseline) * (i / 5) + (rand() - 0.5) * Math.abs(target - baseline) * 0.04) * 100) / 100,
  )
  readings[5] = current
  kpis.push({
    id: randomUUID(),
    ownerId: owner.id,
    teamId: teamOf.get(owner.id) ?? null,
    goalId: goalId ?? null,
    name,
    unit,
    direction,
    baseline,
    target,
    current,
    readings,
  })
}
// CEO
addKpi(ceo, 'Annual recurring revenue', '$M', 'HIGHER', 42, 60, companyGoals[0]!.id)
addKpi(ceo, 'Net promoter score', 'pts', 'HIGHER', 38, 60)
addKpi(ceo, 'Gross margin', '%', 'HIGHER', 68, 78)
addKpi(ceo, 'Employee engagement', 'pts', 'HIGHER', 68, 85, companyGoals[2]!.id)
// Executives
const byTitle = (t: string) => execs.find((e) => e.title.includes(t))!
addKpi(byTitle('Technology'), 'Platform uptime', '%', 'HIGHER', 99.5, 99.99, companyGoals[1]!.id)
addKpi(byTitle('Technology'), 'p95 API latency', 'ms', 'LOWER', 900, 300)
addKpi(byTitle('Technology'), 'Deploys per week', '', 'HIGHER', 8, 30)
addKpi(byTitle('Operating'), 'Support first-response time', 'min', 'LOWER', 95, 20)
addKpi(byTitle('Operating'), 'Delivery on-time rate', '%', 'HIGHER', 82, 96)
addKpi(byTitle('Financial'), 'Burn multiple', 'x', 'LOWER', 2.4, 1.2)
addKpi(byTitle('Financial'), 'Days to close the books', 'days', 'LOWER', 14, 5)
addKpi(byTitle('Product'), 'Weekly active accounts', 'k', 'HIGHER', 18, 30)
addKpi(byTitle('Product'), 'Activation within 7 days', '%', 'HIGHER', 41, 65)
addKpi(byTitle('Revenue'), 'New pipeline created', '$M', 'HIGHER', 6, 14)
addKpi(byTitle('Revenue'), 'Win rate', '%', 'HIGHER', 19, 31)
// Department heads and leads: one KPI each, ICs: about a third get one
for (const h of deptHeads) addKpi(h, `${h.title.replace('Head of ', '')} delivery health`, '%', 'HIGHER', 60, 95)
for (const l of leads) addKpi(l, `${l.title.replace(' Lead', '')} milestone completion`, '%', 'HIGHER', 40, 100)
for (const ic of ics) if (rand() < 0.35) addKpi(ic, 'Personal quality target', '%', 'HIGHER', 70, 95)

// ───────────── Tasks: eight weeks of real work, shaped by each person's q ─────────────
interface TaskRow {
  id: string
  assigneeId: string
  title: string
  status: TaskStatus
  impactLevel: ImpactLevel
  complexity: number
  startedAt: Date | null
  completedAt: Date | null
  dueAt: Date | null
  estimateMins: number
  actualMins: number
  goalId: string | null
}
const tasks: TaskRow[] = []
const VERBS = ['Ship', 'Fix', 'Draft', 'Review', 'Plan', 'Automate', 'Launch', 'Audit', 'Migrate', 'Document', 'Negotiate', 'Analyse']
const NOUNS = [
  'onboarding flow',
  'billing report',
  'renewal playbook',
  'incident runbook',
  'quarterly forecast',
  'access policy',
  'pricing page',
  'support macros',
  'data pipeline',
  'hiring plan',
  'vendor contract',
  'dashboard',
]
for (const p of people) {
  const n = 10
  for (let i = 0; i < n; i++) {
    const done = rand() < 0.45 + p.q * 0.5
    const age = 2 + Math.floor(rand() * 54) // days ago it was due
    const late = rand() > 0.35 + p.q * 0.6
    const r = rand()
    const impact: ImpactLevel = r < p.q * 0.35 ? 'CRITICAL' : r < p.q * 0.35 + 0.25 + p.q * 0.2 ? 'HIGH' : r < 0.85 ? 'MEDIUM' : 'LOW'
    const dueAt = daysAgo(age)
    const est = 120 + Math.floor(rand() * 600)
    tasks.push({
      id: randomUUID(),
      assigneeId: p.id,
      title: `${pick(VERBS)} ${pick(NOUNS)}`,
      status: done ? 'COMPLETED' : rand() < 0.5 ? 'IN_PROGRESS' : 'TODO',
      impactLevel: impact,
      complexity: 1 + Math.floor(rand() * 5),
      startedAt: daysAgo(age + 3),
      completedAt: done ? daysAgo(late ? age - 2 : age + 1) : null,
      dueAt,
      estimateMins: est,
      actualMins: done ? Math.round(est * (0.8 + rand() * 0.6)) : 0,
      goalId: rand() < 0.35 + p.q * 0.4 ? (goalOf.get(p.id)?.id ?? null) : null,
    })
  }
}

// ───────────── Write everything ─────────────
/** --reset removes the earlier demo company (its organization, and the demo accounts) so the seed can run again. */
async function reset(log: (m: string) => void) {
  const org = await prisma.organization.findFirst({ where: { slug: SLUG } })
  if (org) await prisma.organization.delete({ where: { id: org.id } })
  const gone = await prisma.user.deleteMany({ where: { email: { endsWith: '@helios.demo.konvo.dev' } } })
  log(`Removed the earlier demo company (${gone.count} demo accounts).`)
}

/** Creates the demo company unless it exists. Returns false when it was already there. */
export async function seedHelios(opts: { password: string; reset?: boolean; log?: (m: string) => void }): Promise<boolean> {
  const log = opts.log ?? ((m: string) => console.log(m))
  if (opts.reset) await reset(log)
  if (await prisma.organization.findFirst({ where: { slug: SLUG } })) {
    log(`Company demo already exists (slug ${SLUG}).`)
    return false
  }
  const passwordHash = await hash(opts.password, { memoryCost: 19456, timeCost: 2, parallelism: 1 })
  const org = await prisma.organization.create({
    data: {
      name: 'Helios Corp (demo, ~150 people)',
      slug: SLUG,
      settings: { retentionDays: 730, requireReportApproval: false, impactTargetPerWeek: 6, transparency: 'OPEN' },
    },
  })
  await prisma.user.createMany({
    data: people.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      passwordHash,
      emailVerifiedAt: new Date(),
      timezone: 'Asia/Kolkata',
      // Placeholder number, marked declined: no alert invitation is created or sent for demo people.
      phone: '910000000000',
      phoneAlertState: 'declined',
    })),
  })
  await prisma.organizationMember.createMany({
    data: people.map((p) => ({ orgId: org.id, userId: p.id, role: p.role, title: p.title, reportsToId: p.reportsToId })),
  })
  await prisma.scoringModel.create({ data: { orgId: org.id, name: 'Default', weights: DEFAULT_WEIGHTS, createdBy: ceo.id } })

  // Departments first, then squads (parent must exist).
  for (const t of teams.filter((x) => !x.parentId)) await prisma.team.create({ data: { id: t.id, orgId: org.id, name: t.name, managerId: t.managerId } })
  for (const t of teams.filter((x) => x.parentId))
    await prisma.team.create({ data: { id: t.id, orgId: org.id, name: t.name, managerId: t.managerId, parentId: t.parentId } })
  await prisma.teamMember.createMany({ data: teams.flatMap((t) => t.memberIds.map((userId) => ({ teamId: t.id, userId }))) })
  await prisma.mentorAssignment.createMany({ data: mentorships.map((m) => ({ orgId: org.id, ...m })) })

  // Goals: parents before children.
  const written = new Set<string>()
  const pending = [...goals]
  while (pending.length) {
    const ready = pending.filter((g) => !g.parentId || written.has(g.parentId))
    if (!ready.length) throw new Error('goal cascade has a loop')
    await prisma.goal.createMany({
      data: ready.map((g) => ({
        id: g.id,
        orgId: org.id,
        ownerId: g.ownerId,
        teamId: g.teamId,
        parentId: g.parentId,
        period: g.period,
        title: g.title,
        expectedOutcome: `${g.title}: measured by its key results.`,
        progress: g.progress,
        status: g.status,
        startDate: daysAgo(50),
        dueDate: daysAgo(-40),
      })),
    })
    await prisma.keyResult.createMany({
      data: ready.flatMap((g) => g.krs.map((k) => ({ goalId: g.id, title: k.title, unit: k.unit, start: k.start, target: k.target, current: k.current }))),
    })
    for (const g of ready) written.add(g.id)
    for (const g of ready) pending.splice(pending.indexOf(g), 1)
  }

  await prisma.kpi.createMany({
    data: kpis.map((k) => ({
      id: k.id,
      orgId: org.id,
      ownerId: k.ownerId,
      teamId: k.teamId,
      goalId: k.goalId,
      name: k.name,
      unit: k.unit,
      direction: k.direction,
      baseline: k.baseline,
      target: k.target,
      current: k.current,
      cadence: 'MONTHLY',
    })),
  })
  await prisma.kpiReading.createMany({
    data: kpis.flatMap((k) => k.readings.map((value, i) => ({ kpiId: k.id, value, authorId: k.ownerId, at: daysAgo((5 - i) * 30) }))),
  })

  const CHUNK = 400
  for (let i = 0; i < tasks.length; i += CHUNK) {
    await prisma.task.createMany({
      data: tasks.slice(i, i + CHUNK).map((t) => ({
        id: t.id,
        orgId: org.id,
        title: t.title,
        status: t.status,
        priority: 'MEDIUM' as const,
        assigneeId: t.assigneeId,
        creatorId: t.assigneeId,
        dueAt: t.dueAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        estimateMins: t.estimateMins,
        actualMins: t.actualMins,
        impactLevel: t.impactLevel,
        complexity: t.complexity,
      })),
    })
  }
  await prisma.taskGoal.createMany({ data: tasks.filter((t) => t.goalId).map((t) => ({ taskId: t.id, goalId: t.goalId! })) })

  // Managers rate most completed work (1-5), and good work usually has verified evidence behind it.
  const byId = new Map(people.map((p) => [p.id, p]))
  const done = tasks.filter((t) => t.status === 'COMPLETED')
  await prisma.qualityAssessment.createMany({
    data: done
      .filter(() => rand() < 0.75)
      .map((t) => {
        const p = byId.get(t.assigneeId)!
        return {
          orgId: org.id,
          taskId: t.id,
          assessorId: p.reportsToId ?? p.id,
          quality: Math.round(clamp(1 + p.q * 4 + (rand() - 0.5) * 1.6, 1, 5)),
        }
      }),
  })
  const KINDS = ['PULL_REQUEST', 'DOCUMENT', 'REPORT', 'DEPLOYMENT', 'APPROVAL'] as const
  const evidenceRows = done
    .filter((t) => t.impactLevel !== 'LOW' && t.impactLevel !== 'NONE')
    .filter((t) => rand() < 0.3 + byId.get(t.assigneeId)!.q * 0.65)
    .map((t) => ({
      orgId: org.id,
      taskId: t.id,
      kind: pick(KINDS),
      title: `Evidence: ${t.title}`,
      status: (rand() < 0.85 ? 'VERIFIED' : 'RECEIVED') as 'VERIFIED' | 'RECEIVED',
      addedById: t.assigneeId,
    }))
  for (let i = 0; i < evidenceRows.length; i += CHUNK) await prisma.evidence.createMany({ data: evidenceRows.slice(i, i + CHUNK) })

  log(
    `Created "${org.name}": ${people.length} people, ${teams.length} teams, ${goals.length} goals, ${kpis.length} KPIs, ${tasks.length} tasks, ${evidenceRows.length} evidence items.`,
  )
  log(`CEO login: ${ceo.email}  |  an executive: ${execs[0]!.email}  |  a person: ${ics[0]!.email}`)
  return true
}

// Sample data for a brand-new workspace, so every page has something to show on day one: five sample teammates, two
// teams, goals that cascade from a company objective, KPIs with history, and five weeks of work (with quality ratings
// and evidence). Everything created is listed in organization.settings.sample, and all of it disappears the moment real
// work arrives: the first task someone creates or an integration imports (or an admin removes it by hand).
//
// Sample teammates cannot sign in (no password) and cannot be emailed (.invalid addresses never deliver) or rung (no
// phone). Sample tasks never raise a phone alert (see isSampleTask in phone-alerts).
import { randomUUID } from 'node:crypto'
import { prisma, type ImpactLevel, type TaskStatus } from '../lib/prisma.js'
import { logger } from '../config/logger.js'

export interface SampleState {
  active: boolean
  createdAt?: string
  clearedAt?: string
  clearedBy?: 'first_task' | 'import' | 'removed'
  userIds?: string[]
  teamIds?: string[]
  goalIds?: string[]
  kpiIds?: string[]
  taskIds?: string[]
}

const DAY = 864e5
const at = (daysFromNow: number, hour = 11) => {
  const d = new Date(Date.now() + daysFromNow * DAY)
  d.setHours(hour, 0, 0, 0)
  return d
}
type Settings = Record<string, unknown> & { sample?: SampleState }
const settingsOf = (v: unknown): Settings => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Settings) : {})

/** The sample state of a workspace (inactive when it never had sample data). */
export async function sampleState(orgId: string): Promise<SampleState> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } })
  return settingsOf(org?.settings).sample ?? { active: false }
}

/** True for a task that belongs to a workspace's sample data (those never ring anyone's phone). */
export async function isSampleTask(orgId: string, taskId: string) {
  const s = await sampleState(orgId)
  return s.active && (s.taskIds ?? []).includes(taskId)
}

// ───────────── Creating ─────────────

interface Person {
  key: string
  name: string
  title: string
  role: 'MANAGER' | 'MENTOR' | 'MEMBER'
  reportsTo: string // a person key, or 'owner'
}
const PEOPLE: Person[] = [
  { key: 'maya', name: 'Maya Rao', title: 'Engineering Lead', role: 'MANAGER', reportsTo: 'owner' },
  { key: 'arjun', name: 'Arjun Mehta', title: 'Senior Software Engineer', role: 'MEMBER', reportsTo: 'maya' },
  { key: 'lena', name: 'Lena Fischer', title: 'Product Designer', role: 'MEMBER', reportsTo: 'maya' },
  { key: 'sam', name: 'Sam Okafor', title: 'Staff Engineer and Mentor', role: 'MENTOR', reportsTo: 'owner' },
  { key: 'priya', name: 'Priya Nair', title: 'Customer Success Manager', role: 'MEMBER', reportsTo: 'owner' },
]

interface TaskSpec {
  who: string // person key or 'owner'
  title: string
  impact: ImpactLevel
  status: TaskStatus
  /** Days from now: negative = in the past. Completed tasks finish on this day; open tasks are due on it. */
  day: number
  late?: boolean
  goal?: string // goal key
  quality?: number // 1-5, rated by the person's manager
  evidence?: 'VERIFIED' | 'RECEIVED'
}
const TASKS: TaskSpec[] = [
  // The person who created the workspace
  { who: 'owner', title: 'Set the quarterly objective for the team', impact: 'HIGH', status: 'COMPLETED', day: -30, goal: 'company' },
  { who: 'owner', title: 'Review pricing page with Customer Success', impact: 'MEDIUM', status: 'COMPLETED', day: -18, goal: 'company' },
  { who: 'owner', title: 'Close the partnership with Northwind', impact: 'CRITICAL', status: 'COMPLETED', day: -6, goal: 'company' },
  { who: 'owner', title: 'Prepare the monthly business review', impact: 'HIGH', status: 'IN_PROGRESS', day: 4, goal: 'company' },
  { who: 'owner', title: 'Hire a second product designer', impact: 'MEDIUM', status: 'TODO', day: 12 },
  // Maya, engineering lead
  {
    who: 'maya',
    title: 'Plan the self-serve onboarding release',
    impact: 'HIGH',
    status: 'COMPLETED',
    day: -27,
    goal: 'onboarding',
    quality: 5,
    evidence: 'VERIFIED',
  },
  {
    who: 'maya',
    title: 'Automate trial account setup',
    impact: 'CRITICAL',
    status: 'COMPLETED',
    day: -13,
    goal: 'onboarding',
    quality: 4,
    evidence: 'VERIFIED',
  },
  { who: 'maya', title: 'Fix flaky checkout tests', impact: 'MEDIUM', status: 'COMPLETED', day: -8, late: true, quality: 4 },
  { who: 'maya', title: 'Ship onboarding checklist to all new accounts', impact: 'HIGH', status: 'IN_PROGRESS', day: 5, goal: 'onboarding' },
  // Arjun, engineer
  { who: 'arjun', title: 'Cut signup page load time in half', impact: 'HIGH', status: 'COMPLETED', day: -24, goal: 'signup', quality: 5, evidence: 'VERIFIED' },
  { who: 'arjun', title: 'Cache the pricing API', impact: 'MEDIUM', status: 'COMPLETED', day: -16, goal: 'signup', quality: 4, evidence: 'VERIFIED' },
  { who: 'arjun', title: 'Remove the legacy signup form', impact: 'MEDIUM', status: 'COMPLETED', day: -9, goal: 'signup', quality: 3 },
  { who: 'arjun', title: 'Add single sign-on with Google', impact: 'HIGH', status: 'COMPLETED', day: -3, goal: 'onboarding', quality: 4, evidence: 'VERIFIED' },
  { who: 'arjun', title: 'Load-test the new signup flow', impact: 'MEDIUM', status: 'TODO', day: 7, goal: 'signup' },
  // Lena, designer
  {
    who: 'lena',
    title: 'Redesign the dashboard empty states',
    impact: 'MEDIUM',
    status: 'COMPLETED',
    day: -22,
    goal: 'dashboard',
    quality: 4,
    evidence: 'VERIFIED',
  },
  {
    who: 'lena',
    title: 'User interviews: first-week experience',
    impact: 'HIGH',
    status: 'COMPLETED',
    day: -12,
    goal: 'onboarding',
    quality: 5,
    evidence: 'VERIFIED',
  },
  { who: 'lena', title: 'New navigation prototype', impact: 'MEDIUM', status: 'COMPLETED', day: -5, late: true, goal: 'dashboard', quality: 3 },
  { who: 'lena', title: 'Design the onboarding checklist', impact: 'HIGH', status: 'IN_PROGRESS', day: 6, goal: 'onboarding' },
  // Sam, mentor
  { who: 'sam', title: 'Pair with Arjun on caching strategy', impact: 'MEDIUM', status: 'COMPLETED', day: -17, quality: 5 },
  { who: 'sam', title: 'Write the incident response runbook', impact: 'HIGH', status: 'COMPLETED', day: -10, quality: 4, evidence: 'VERIFIED' },
  { who: 'sam', title: 'Mentor Lena through her first design review', impact: 'MEDIUM', status: 'COMPLETED', day: -2, quality: 5 },
  { who: 'sam', title: 'Review the architecture of the billing service', impact: 'HIGH', status: 'IN_PROGRESS', day: 9 },
  // Priya, customer success
  {
    who: 'priya',
    title: 'Call the ten accounts most at risk of churning',
    impact: 'CRITICAL',
    status: 'COMPLETED',
    day: -20,
    goal: 'churn',
    quality: 5,
    evidence: 'VERIFIED',
  },
  { who: 'priya', title: 'Publish help articles for onboarding', impact: 'MEDIUM', status: 'COMPLETED', day: -11, goal: 'churn', quality: 4 },
  { who: 'priya', title: 'Quarterly review with Acme Corp', impact: 'HIGH', status: 'COMPLETED', day: -4, goal: 'churn', quality: 4, evidence: 'RECEIVED' },
  { who: 'priya', title: 'Launch the customer health score', impact: 'HIGH', status: 'TODO', day: 10, goal: 'churn' },
]

interface GoalSpec {
  key: string
  who: string
  title: string
  parent?: string
  team?: 'eng' | 'cs'
  krs: { title: string; unit: string; start: number; target: number; current: number }[]
}
const GOALS: GoalSpec[] = [
  {
    key: 'company',
    who: 'owner',
    title: 'Grow to 1,000 monthly active customers',
    krs: [
      { title: 'Monthly active customers', unit: 'customers', start: 620, target: 1000, current: 880 },
      { title: 'Net promoter score', unit: 'NPS', start: 31, target: 45, current: 41 },
    ],
  },
  {
    key: 'onboarding',
    who: 'maya',
    title: 'Ship self-serve onboarding',
    parent: 'company',
    team: 'eng',
    krs: [{ title: 'Onboarding steps automated', unit: 'steps', start: 0, target: 10, current: 9 }],
  },
  {
    key: 'churn',
    who: 'priya',
    title: 'Cut monthly churn to 3%',
    parent: 'company',
    team: 'cs',
    krs: [{ title: 'Monthly churn', unit: '%', start: 5.2, target: 3, current: 4 }],
  },
  {
    key: 'signup',
    who: 'arjun',
    title: 'Make signup twice as fast',
    parent: 'onboarding',
    team: 'eng',
    krs: [{ title: 'Signup time', unit: 'seconds', start: 4.2, target: 2.1, current: 2.2 }],
  },
  {
    key: 'dashboard',
    who: 'lena',
    title: 'A dashboard new users understand',
    parent: 'onboarding',
    team: 'eng',
    krs: [{ title: 'Screens redesigned', unit: 'screens', start: 0, target: 8, current: 5 }],
  },
]

interface KpiSpec {
  who: string
  name: string
  unit: string
  direction: 'HIGHER' | 'LOWER'
  baseline: number
  target: number
  readings: number[]
  goal?: string
  team?: 'eng' | 'cs'
}
const KPIS: KpiSpec[] = [
  {
    who: 'owner',
    name: 'Monthly active customers',
    unit: 'customers',
    direction: 'HIGHER',
    baseline: 620,
    target: 1000,
    readings: [650, 700, 752, 800, 845, 880],
    goal: 'company',
  },
  {
    who: 'maya',
    name: 'On-time delivery',
    unit: '%',
    direction: 'HIGHER',
    baseline: 60,
    target: 90,
    readings: [62, 68, 74, 79, 83, 86],
    team: 'eng',
  },
  {
    who: 'priya',
    name: 'Customer satisfaction (CSAT)',
    unit: '%',
    direction: 'HIGHER',
    baseline: 72,
    target: 90,
    readings: [73, 75, 78, 80, 82, 84],
    team: 'cs',
  },
  {
    who: 'arjun',
    name: 'Signup page load time',
    unit: 'seconds',
    direction: 'LOWER',
    baseline: 4.2,
    target: 1.5,
    readings: [4.1, 3.5, 2.9, 2.4, 2.0, 1.8],
    team: 'eng',
  },
]

const progressOf = (krs: GoalSpec['krs']) =>
  Math.round((krs.reduce((a, k) => a + Math.max(0, Math.min(1, (k.current - k.start) / (k.target - k.start))), 0) / krs.length) * 100)

/** Adds the sample team and its work to a new workspace and records what it added. Never throws: a workspace without
 *  sample data is still a working workspace. */
export async function createSampleData(orgId: string, ownerId: string) {
  try {
    const short = orgId
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 10)
      .toLowerCase()
    const id = new Map<string, string>([['owner', ownerId]])
    for (const p of PEOPLE) id.set(p.key, randomUUID())
    const userIds = PEOPLE.map((p) => id.get(p.key)!)
    const teams = { eng: randomUUID(), cs: randomUUID() }
    const goalId = new Map(GOALS.map((g) => [g.key, randomUUID()]))
    const kpiIds = KPIS.map(() => randomUUID())
    const taskIds = TASKS.map(() => randomUUID())

    await prisma.$transaction(async (tx) => {
      await tx.user.createMany({
        data: PEOPLE.map((p) => ({
          id: id.get(p.key)!,
          name: p.name,
          // .invalid never delivers (RFC 2606), so nothing can ever be emailed to a sample teammate.
          email: `${p.key}.${short}@sample.konvo.invalid`,
          passwordHash: null,
          emailVerifiedAt: new Date(),
          timezone: 'UTC',
        })),
      })
      await tx.organizationMember.createMany({
        data: PEOPLE.map((p) => ({ orgId, userId: id.get(p.key)!, role: p.role, title: p.title, reportsToId: id.get(p.reportsTo)! })),
      })
      await tx.team.create({ data: { id: teams.eng, orgId, name: 'Product & Engineering', managerId: id.get('maya')! } })
      await tx.team.create({ data: { id: teams.cs, orgId, name: 'Customer Success', managerId: ownerId } })
      await tx.teamMember.createMany({
        data: [
          ...['maya', 'arjun', 'lena', 'sam'].map((k) => ({ teamId: teams.eng, userId: id.get(k)! })),
          ...['owner', 'priya'].map((k) => ({ teamId: teams.cs, userId: id.get(k)! })),
        ],
      })
      await tx.mentorAssignment.createMany({ data: ['arjun', 'lena'].map((k) => ({ orgId, mentorId: id.get('sam')!, menteeId: id.get(k)! })) })

      for (const g of GOALS) {
        const progress = progressOf(g.krs)
        await tx.goal.create({
          data: {
            id: goalId.get(g.key)!,
            orgId,
            ownerId: id.get(g.who)!,
            teamId: g.team ? teams[g.team] : null,
            parentId: g.parent ? goalId.get(g.parent)! : null,
            period: 'QUARTERLY',
            title: g.title,
            expectedOutcome: `${g.title}: measured by its key results.`,
            progress,
            status: progress >= 65 ? 'ON_TRACK' : progress >= 40 ? 'AT_RISK' : 'OFF_TRACK',
            startDate: at(-45),
            dueDate: at(45),
            keyResults: { create: g.krs },
          },
        })
      }

      for (const [i, k] of KPIS.entries()) {
        await tx.kpi.create({
          data: {
            id: kpiIds[i]!,
            orgId,
            ownerId: id.get(k.who)!,
            teamId: k.team ? teams[k.team] : null,
            goalId: k.goal ? goalId.get(k.goal)! : null,
            name: k.name,
            unit: k.unit,
            direction: k.direction,
            baseline: k.baseline,
            target: k.target,
            current: k.readings.at(-1)!,
            cadence: 'WEEKLY',
            readings: { create: k.readings.map((value, w) => ({ value, authorId: id.get(k.who)!, at: at(-(5 - w) * 7) })) },
          },
        })
      }

      for (const [i, t] of TASKS.entries()) {
        const done = t.status === 'COMPLETED'
        const who = id.get(t.who)!
        const est = t.impact === 'CRITICAL' ? 480 : t.impact === 'HIGH' ? 300 : 180
        await tx.task.create({
          data: {
            id: taskIds[i]!,
            orgId,
            title: t.title,
            status: t.status,
            priority: t.impact === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
            impactLevel: t.impact,
            complexity: t.impact === 'CRITICAL' ? 4 : t.impact === 'HIGH' ? 3 : 2,
            assigneeId: who,
            creatorId: who,
            dueAt: done ? at(t.day + (t.late ? -2 : 1)) : at(t.day),
            startedAt: t.status === 'TODO' ? null : at(Math.min(t.day, 0) - 4),
            completedAt: done ? at(t.day) : null,
            estimateMins: est,
            actualMins: done ? Math.round(est * (t.late ? 1.3 : 0.9)) : t.status === 'IN_PROGRESS' ? Math.round(est * 0.4) : 0,
            goals: t.goal ? { create: [{ goalId: goalId.get(t.goal)! }] } : undefined,
          },
        })
        const manager = t.who === 'owner' ? null : id.get(PEOPLE.find((p) => p.key === t.who)!.reportsTo)!
        if (done && t.quality && manager) await tx.qualityAssessment.create({ data: { orgId, taskId: taskIds[i]!, assessorId: manager, quality: t.quality } })
        if (done && t.evidence)
          await tx.evidence.create({
            data: { orgId, taskId: taskIds[i]!, kind: 'DOCUMENT', title: `Evidence: ${t.title}`, status: t.evidence, addedById: who },
          })
      }

      const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } })
      const sample: SampleState = {
        active: true,
        createdAt: new Date().toISOString(),
        userIds,
        teamIds: Object.values(teams),
        goalIds: [...goalId.values()],
        kpiIds,
        taskIds,
      }
      await tx.organization.update({ where: { id: orgId }, data: { settings: { ...settingsOf(org.settings), sample } as never } })
    })
    logger.info({ orgId }, 'sample data added to new workspace')
  } catch (e) {
    logger.error({ orgId, err: e instanceof Error ? e.message : e }, 'sample data could not be added')
  }
}

// ───────────── Removing ─────────────

const forgetHooks: ((orgId: string) => void)[] = []
/** Lets caches (company scores) drop what they remember about a workspace once its sample data is gone. */
export function onSampleCleared(fn: (orgId: string) => void) {
  forgetHooks.push(fn)
}

/**
 * Removes a workspace's sample data, if it still has any. Real records that point at sample ones keep working: a real
 * goal under a sample objective, or a real task assigned to a sample teammate, simply loses that link.
 * Returns true when it removed something.
 */
export async function clearSampleData(orgId: string, by: NonNullable<SampleState['clearedBy']>): Promise<boolean> {
  const s = await sampleState(orgId)
  if (!s.active) return false
  const taskIds = s.taskIds ?? []
  const userIds = s.userIds ?? []
  await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction so two real tasks arriving together clear it once.
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } })
    const current = settingsOf(org.settings)
    if (!current.sample?.active) return
    if (taskIds.length) {
      await tx.notification.deleteMany({ where: { orgId, OR: taskIds.map((id) => ({ dedupeKey: { contains: id } })) } })
      await tx.evidence.deleteMany({ where: { orgId, taskId: { in: taskIds } } })
      await tx.task.deleteMany({ where: { orgId, id: { in: taskIds } } })
    }
    await tx.kpi.deleteMany({ where: { orgId, id: { in: s.kpiIds ?? [] } } })
    await tx.goal.deleteMany({ where: { orgId, id: { in: s.goalIds ?? [] } } })
    await tx.team.deleteMany({ where: { orgId, id: { in: s.teamIds ?? [] } } })
    if (userIds.length) {
      await tx.organizationMember.updateMany({ where: { orgId, reportsToId: { in: userIds } }, data: { reportsToId: null } })
      await tx.mentorAssignment.deleteMany({ where: { orgId, OR: [{ mentorId: { in: userIds } }, { menteeId: { in: userIds } }] } })
      await tx.organizationMember.deleteMany({ where: { orgId, userId: { in: userIds } } })
      // Sample teammates belong to this workspace only; their notifications and sessions go with them.
      await tx.user.deleteMany({ where: { id: { in: userIds }, email: { endsWith: '@sample.konvo.invalid' } } })
    }
    // Weekly snapshots so far were computed from sample work only.
    await tx.performanceSnapshot.deleteMany({ where: { orgId } })
    const sample: SampleState = { active: false, createdAt: s.createdAt, clearedAt: new Date().toISOString(), clearedBy: by }
    await tx.organization.update({ where: { id: orgId }, data: { settings: { ...current, sample } as never } })
  })
  for (const fn of forgetHooks) fn(orgId)
  logger.info({ orgId, by }, 'sample data removed')
  return true
}

/**
 * A new real task may point at sample records picked in the form (a sample teammate, goal, parent or dependency).
 * Those are about to disappear, so the links are dropped; a task meant for a sample teammate goes to its creator.
 */
export function withoutSampleRefs<T extends { assigneeId?: string | null; goalIds?: string[]; dependsOnIds?: string[]; parentId?: string | null }>(
  input: T,
  s: SampleState,
  creatorId: string,
): T {
  if (!s.active) return input
  const users = new Set(s.userIds ?? [])
  const goals = new Set(s.goalIds ?? [])
  const tasks = new Set(s.taskIds ?? [])
  return {
    ...input,
    ...(input.assigneeId && users.has(input.assigneeId) ? { assigneeId: creatorId } : {}),
    ...(input.goalIds ? { goalIds: input.goalIds.filter((g) => !goals.has(g)) } : {}),
    ...(input.dependsOnIds ? { dependsOnIds: input.dependsOnIds.filter((t) => !tasks.has(t)) } : {}),
    ...(input.parentId && tasks.has(input.parentId) ? { parentId: null } : {}),
  }
}

/** Call when real work arrives. Cheap when the workspace has no sample data. Never throws. */
export async function realWorkArrived(orgId: string, by: 'first_task' | 'import') {
  try {
    return await clearSampleData(orgId, by)
  } catch (e) {
    logger.error({ orgId, err: e instanceof Error ? e.message : e }, 'sample data could not be removed')
    return false
  }
}

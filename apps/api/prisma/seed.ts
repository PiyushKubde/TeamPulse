// DEVELOPMENT / DEMO SEED ONLY. Creates a clearly labelled demo organization with eight weeks of realistic history.
// Refuses to run in production. Every demo account uses the password below.
import { hash } from '@node-rs/argon2'
import { DEFAULT_WEIGHTS } from '@workpulse/shared'
import { prisma, type ImpactLevel, type Priority, type TaskStatus } from '../src/lib/prisma.js'
import { snapshot } from '../src/services/performance.js'

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.')
  process.exit(1)
}

const PASSWORD = 'Password123'
const DAY = 864e5
let seed = 42
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
const daysAgo = (n: number, h = 10) => new Date(Date.now() - n * DAY + (h - 12) * 36e5)

async function main() {
  const existing = await prisma.organization.findFirst({ where: { slug: 'northwind-demo' } })
  if (existing) {
    console.log('Demo organization already exists (slug northwind-demo). Delete it or reset the database to reseed.')
    return
  }
  const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 })
  const mk = (name: string, email: string) => prisma.user.create({ data: { name, email, passwordHash, emailVerifiedAt: new Date(), timezone: 'Asia/Kolkata' } })
  const [olivia, marcus, priya, diego, lena, sam] = await Promise.all([
    mk('Olivia Owner', 'olivia@demo.workpulse.dev'),
    mk('Marcus Manager', 'marcus@demo.workpulse.dev'),
    mk('Priya Patel', 'priya@demo.workpulse.dev'),
    mk('Diego Alvarez', 'diego@demo.workpulse.dev'),
    mk('Lena Fischer', 'lena@demo.workpulse.dev'),
    mk('Sam Mentor', 'sam@demo.workpulse.dev'),
  ])
  const org = await prisma.organization.create({
    data: { name: 'Northwind Labs (demo)', slug: 'northwind-demo', settings: { retentionDays: 730, requireReportApproval: false, impactTargetPerWeek: 10 } },
  })
  await prisma.organizationMember.createMany({
    data: [
      { orgId: org.id, userId: olivia.id, role: 'OWNER', title: 'Head of Product' },
      { orgId: org.id, userId: marcus.id, role: 'MANAGER', title: 'Engineering Manager' },
      { orgId: org.id, userId: priya.id, role: 'MEMBER', title: 'Senior Engineer' },
      { orgId: org.id, userId: diego.id, role: 'MEMBER', title: 'Engineer' },
      { orgId: org.id, userId: lena.id, role: 'MEMBER', title: 'Product Designer' },
      { orgId: org.id, userId: sam.id, role: 'MENTOR', title: 'Staff Engineer' },
    ],
  })
  await prisma.scoringModel.create({ data: { orgId: org.id, name: 'Default', weights: DEFAULT_WEIGHTS, createdBy: olivia.id } })
  const platform = await prisma.team.create({
    data: { orgId: org.id, name: 'Platform', managerId: marcus.id, members: { create: [{ userId: marcus.id }, { userId: priya.id }, { userId: diego.id }] } },
  })
  const growth = await prisma.team.create({ data: { orgId: org.id, name: 'Growth', managerId: marcus.id, members: { create: [{ userId: lena.id }] } } })
  await prisma.mentorAssignment.create({ data: { orgId: org.id, mentorId: sam.id, menteeId: diego.id } })

  const projects = await Promise.all([
    prisma.project.create({
      data: {
        orgId: org.id,
        teamId: platform.id,
        ownerId: marcus.id,
        name: 'Checkout revamp',
        description: 'Rebuild the payment flow to cut drop-off.',
        startDate: daysAgo(60),
        targetDate: daysAgo(-21),
      },
    }),
    prisma.project.create({
      data: {
        orgId: org.id,
        teamId: growth.id,
        ownerId: lena.id,
        name: 'Self-serve onboarding',
        description: 'New teams set up without a sales call.',
        startDate: daysAgo(45),
        targetDate: daysAgo(-35),
      },
    }),
    prisma.project.create({
      data: {
        orgId: org.id,
        teamId: platform.id,
        ownerId: priya.id,
        name: 'Platform reliability',
        description: 'Fewer incidents, faster recovery.',
        startDate: daysAgo(70),
        targetDate: daysAgo(5),
      },
    }),
  ])

  const goal = (
    ownerId: string,
    title: string,
    period: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'MILESTONE',
    start: number,
    due: number,
    krs: { title: string; start: number; target: number; current: number; unit: string }[],
    teamId?: string,
  ) =>
    prisma.goal.create({
      data: {
        orgId: org.id,
        ownerId,
        title,
        period,
        teamId,
        startDate: daysAgo(start),
        dueDate: daysAgo(due),
        expectedOutcome: `${title}: measurable by its key results.`,
        keyResults: { create: krs },
        progress: Math.round((krs.reduce((a, k) => a + Math.min(1, (k.current - k.start) / (k.target - k.start)), 0) / krs.length) * 100),
      },
    })
  const goals = await Promise.all([
    goal(
      marcus.id,
      'Cut checkout drop-off',
      'QUARTERLY',
      45,
      -45,
      [
        { title: 'Checkout completion rate', start: 61, target: 75, current: 68, unit: '%' },
        { title: 'p95 payment latency', start: 1800, target: 800, current: 1150, unit: 'ms' },
      ],
      platform.id,
    ),
    goal(
      lena.id,
      'Teams activate without help',
      'QUARTERLY',
      45,
      -45,
      [{ title: 'Self-serve activations / week', start: 4, target: 25, current: 11, unit: 'teams' }],
      growth.id,
    ),
    goal(priya.id, 'Reduce incident load', 'MONTHLY', 20, -10, [{ title: 'Sev-2+ incidents', start: 6, target: 1, current: 3, unit: '' }]),
    goal(diego.id, 'Ship saved cards', 'MILESTONE', 30, 2, [{ title: 'Saved-card checkout live', start: 0, target: 1, current: 0, unit: '' }]),
  ])

  const people = [
    { u: priya, project: [projects[0], projects[2]], goals: [goals[0], goals[2]], skill: 0.9 },
    { u: diego, project: [projects[0]], goals: [goals[0], goals[3]], skill: 0.65 },
    { u: lena, project: [projects[1]], goals: [goals[1]], skill: 0.8 },
    { u: marcus, project: [projects[0], projects[2]], goals: [goals[0]], skill: 0.75 },
  ]
  const titles: Record<string, string[]> = {
    'Checkout revamp': [
      'Card form validation',
      'Retry failed payments',
      'Saved cards API',
      'Checkout A/B test',
      '3-D Secure fallback',
      'Payment error copy',
      'Address autocomplete',
      'Fraud rule tuning',
    ],
    'Self-serve onboarding': [
      'Workspace setup wizard',
      'Invite teammates step',
      'Sample project template',
      'Onboarding email series',
      'Activation checklist',
      'Empty-state redesign',
    ],
    'Platform reliability': [
      'Alert noise reduction',
      'Database failover drill',
      'Queue backpressure',
      'Runbook for payments outage',
      'Error budget dashboard',
      'Rate limiter rollout',
    ],
  }
  const impacts: ImpactLevel[] = ['LOW', 'LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'CRITICAL', 'NONE']
  const priorities: Priority[] = ['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'CRITICAL']
  let keyN = 100
  for (const p of people) {
    for (let i = 0; i < 22; i++) {
      const project = pick(p.project)!
      const created = 56 - Math.floor(rand() * 56)
      const due = created - 2 - Math.floor(rand() * 12)
      const done = due > 0 ? rand() < p.skill + 0.1 : rand() < 0.25
      const late = done && rand() > p.skill
      const completed = done ? Math.max(0, late ? due - 1 - Math.floor(rand() * 3) : due + Math.floor(rand() * 2)) : null
      const status: TaskStatus = done
        ? 'COMPLETED'
        : due < 0
          ? pick(['TODO', 'IN_PROGRESS', 'BACKLOG'] as const)
          : pick(['IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'TODO'] as const)
      const impact = pick(impacts)
      const linked = rand() < 0.6
      const task = await prisma.task.create({
        data: {
          orgId: org.id,
          projectId: project.id,
          creatorId: p.u.id,
          assigneeId: p.u.id,
          title: `${pick(titles[project.name]!)}${rand() < 0.4 ? ` (${['phase 1', 'phase 2', 'follow-up', 'v2'][i % 4]})` : ''}`,
          description: 'Demo task created by the development seed.',
          status,
          priority: pick(priorities),
          impactLevel: impact,
          complexity: 1 + Math.floor(rand() * 5),
          category: project.name === 'Self-serve onboarding' ? pick(['Design', 'Research', 'Engineering']) : pick(['Engineering', 'Engineering', 'Operations']),
          dueAt: daysAgo(due, 17),
          createdAt: daysAgo(created),
          startedAt: status === 'TODO' || status === 'BACKLOG' ? null : daysAgo(Math.max(completed ?? 0, created - 2)),
          completedAt: completed == null ? null : daysAgo(completed, 15),
          estimateMins: pick([60, 120, 240, 480, null]),
          actualMins: done ? Math.floor(60 + rand() * 400) : Math.floor(rand() * 120),
          origin: rand() < 0.25 ? 'EXTERNAL' : 'NATIVE',
          reopenCount: rand() < 0.08 ? 1 : 0,
          goals: linked ? { create: [{ goalId: pick(p.goals)!.id }] } : undefined,
        },
      })
      if (task.origin === 'EXTERNAL') {
        keyN++
        await prisma.taskSource.create({
          data: {
            orgId: org.id,
            taskId: task.id,
            provider: 'linear',
            externalId: `demo-lin-${keyN}`,
            externalKey: `ENG-${keyN}`,
            sourceUrl: `https://linear.app/northwind-demo/issue/ENG-${keyN}`,
            externalUpdatedAt: task.updatedAt,
            lastExternal: {},
          },
        })
      }
      if (status === 'BLOCKED' || rand() < 0.1) {
        const kind = pick(['INTERNAL', 'EXTERNAL', 'DEPENDENCY'] as const)
        await prisma.blocker.create({
          data: {
            orgId: org.id,
            taskId: task.id,
            reportedById: p.u.id,
            kind,
            reason: pick([
              'Waiting for vendor API keys',
              'Design review pending',
              'Blocked by platform migration',
              'Unclear acceptance criteria',
              'Security sign-off needed',
            ]),
            createdAt: daysAgo(Math.max(0, due + 2)),
            resolvedAt: status === 'BLOCKED' ? null : daysAgo(Math.max(0, due)),
          },
        })
      }
      if (done && impact !== 'NONE' && rand() < 0.75) {
        const ev = await prisma.evidence.create({
          data: {
            orgId: org.id,
            taskId: task.id,
            kind: pick(['PULL_REQUEST', 'DEPLOYMENT', 'DOCUMENT', 'URL'] as const),
            source: 'MANUAL',
            title: pick(['Merged PR', 'Production deploy', 'Design spec', 'Experiment results']),
            url: 'https://example.com/demo-evidence',
            addedById: p.u.id,
            status: rand() < 0.6 ? 'VERIFIED' : 'RECEIVED',
            createdAt: daysAgo(completed ?? 0, 16),
          },
        })
        if (ev.status === 'VERIFIED' && p.u.id !== marcus.id)
          await prisma.evidenceVerification.create({
            data: { evidenceId: ev.id, verifierId: marcus.id, status: 'VERIFIED', qualityScore: 3 + Math.floor(rand() * 3) },
          })
      }
      if (done && p.u.id !== marcus.id && rand() < 0.5) {
        await prisma.qualityAssessment.create({
          data: {
            orgId: org.id,
            taskId: task.id,
            assessorId: marcus.id,
            quality: Math.max(1, Math.min(5, Math.round(2 + p.skill * 3 + (rand() - 0.5) * 2))),
            impact: rand() < 0.5 ? impact : null,
          },
        })
      }
      if (done) {
        await prisma.workSession.create({
          data: {
            orgId: org.id,
            userId: p.u.id,
            taskId: task.id,
            kind: 'FOCUS',
            startedAt: daysAgo(completed!, 11),
            endedAt: new Date(daysAgo(completed!, 11).getTime() + task.actualMins * 60000),
          },
        })
      }
      await prisma.taskActivity.create({ data: { taskId: task.id, kind: 'created', actorType: 'USER', actorId: p.u.id, createdAt: task.createdAt } })
    }
  }
  await prisma.feedback.createMany({
    data: [
      {
        orgId: org.id,
        subjectUserId: priya.id,
        authorId: marcus.id,
        kind: 'MANAGER',
        body: 'The payment retry work removed our biggest support driver. Great judgement on scope.',
        rating: 5,
        createdAt: daysAgo(9),
      },
      {
        orgId: org.id,
        subjectUserId: diego.id,
        authorId: sam.id,
        kind: 'MENTOR',
        body: 'Break larger tasks down earlier; your saved-cards spike would have surfaced the API gap sooner.',
        createdAt: daysAgo(6),
      },
      {
        orgId: org.id,
        subjectUserId: lena.id,
        authorId: marcus.id,
        kind: 'MANAGER',
        body: 'The setup wizard research changed the plan for the better. Please share evidence links on completed work.',
        rating: 4,
        createdAt: daysAgo(4),
      },
    ],
  })
  // Weekly snapshots for trends (the nightly job keeps these current).
  for (let w = 8; w >= 0; w--) {
    const now = new Date()
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7) - w * 7))
    const end = new Date(monday.getTime() + 7 * DAY)
    for (const u of [priya, diego, lena, marcus]) await snapshot(org.id, `user:${u.id}`, monday, end, 'WEEK')
    for (const t of [platform, growth]) await snapshot(org.id, `team:${t.id}`, monday, end, 'WEEK')
  }
  console.log(
    `Demo organization "${org.name}" created. Sign in as olivia@ / marcus@ / priya@ / diego@ / lena@ / sam@demo.workpulse.dev with password ${PASSWORD}`,
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

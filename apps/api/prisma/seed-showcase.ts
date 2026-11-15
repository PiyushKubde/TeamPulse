// SAMPLE DATA ONLY. Builds "M91 Showcase (sample data)": 14 people, 3 teams, 4 projects, goals with key results and
// 12 weeks of history (tasks from Slack, Linear, Jira, GitHub and WorkPulse; blockers, evidence, assessments, focus
// sessions, daily plans, feedback, sync events, deliveries, reports and weekly score snapshots) so every chart has data.
// The given owner is added as OWNER; nothing in their real organization is touched. Refuses to run in production.
//   npm run db:seed:showcase -w @workpulse/api -- you@example.com
import { hash } from '@node-rs/argon2'
import { DEFAULT_WEIGHTS } from '@workpulse/shared'
import { prisma, type BlockerKind, type ImpactLevel, type Priority, type Role, type TaskStatus } from '../src/lib/prisma.js'
import { snapshot } from '../src/services/performance.js'
import { generateReport } from '../src/modules/reports.js'

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to create sample data in production.')
  process.exit(1)
}
const ownerEmail = process.argv[2]?.toLowerCase()
if (!ownerEmail) {
  console.error('Usage: npm run db:seed:showcase -w @workpulse/api -- <owner email>')
  process.exit(1)
}

const SLUG = 'm91-showcase-sample'
const DAY = 864e5
let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
const chance = (p: number) => rand() < p
const at = (daysAgo: number, hour = 11) => {
  const d = new Date(Date.now() - daysAgo * DAY)
  d.setUTCHours(hour - 5, Math.floor(rand() * 60), 0, 0)
  return d
}

interface Person {
  name: string
  email: string
  role: Role
  title: string
  team: 'Platform' | 'Growth' | 'Mobile' | null
  /** 0–1: share of commitments finished on time */
  reliability: number
  /** weights over LOW/MEDIUM/HIGH/CRITICAL: what kind of work they tend to deliver */
  impactMix: [number, number, number, number]
  /** tasks per week */
  volume: number
  quality: number
}

const PEOPLE: Person[] = [
  {
    name: 'Meera Iyer',
    email: 'meera',
    role: 'ADMIN',
    title: 'Head of Engineering',
    team: null,
    reliability: 0.85,
    impactMix: [1, 2, 3, 2],
    volume: 1.2,
    quality: 4.3,
  },
  {
    name: 'Rahul Verma',
    email: 'rahul',
    role: 'MANAGER',
    title: 'Platform Lead',
    team: 'Platform',
    reliability: 0.8,
    impactMix: [2, 3, 3, 1],
    volume: 1.8,
    quality: 4,
  },
  {
    name: 'Sana Qureshi',
    email: 'sana',
    role: 'MANAGER',
    title: 'Growth Lead',
    team: 'Growth',
    reliability: 0.82,
    impactMix: [2, 3, 2, 1],
    volume: 1.6,
    quality: 4.1,
  },
  {
    name: 'Vikram Rao',
    email: 'vikram',
    role: 'MANAGER',
    title: 'Mobile Lead',
    team: 'Mobile',
    reliability: 0.75,
    impactMix: [2, 3, 2, 1],
    volume: 1.5,
    quality: 3.8,
  },
  {
    name: 'Kavya Nair',
    email: 'kavya',
    role: 'MENTOR',
    title: 'Staff Engineer',
    team: 'Platform',
    reliability: 0.9,
    impactMix: [1, 2, 3, 3],
    volume: 1.4,
    quality: 4.6,
  },
  // Few, big outcomes: should rank high on impact despite low task count.
  {
    name: 'Arjun Mehta',
    email: 'arjun',
    role: 'MEMBER',
    title: 'Senior Engineer',
    team: 'Platform',
    reliability: 0.88,
    impactMix: [1, 1, 4, 4],
    volume: 1.6,
    quality: 4.5,
  },
  // Many small tasks: high volume, modest impact. The product should not reward volume.
  {
    name: 'Neha Gupta',
    email: 'neha',
    role: 'MEMBER',
    title: 'Engineer',
    team: 'Platform',
    reliability: 0.78,
    impactMix: [7, 3, 1, 0],
    volume: 4.5,
    quality: 3.6,
  },
  {
    name: 'Rohan Das',
    email: 'rohan',
    role: 'MEMBER',
    title: 'Engineer',
    team: 'Platform',
    reliability: 0.6,
    impactMix: [3, 4, 2, 0],
    volume: 2.4,
    quality: 3.2,
  },
  {
    name: 'Priya Shah',
    email: 'priya',
    role: 'MEMBER',
    title: 'Product Designer',
    team: 'Growth',
    reliability: 0.86,
    impactMix: [2, 4, 3, 1],
    volume: 2.2,
    quality: 4.2,
  },
  {
    name: 'Aditya Kulkarni',
    email: 'aditya',
    role: 'MEMBER',
    title: 'Growth Engineer',
    team: 'Growth',
    reliability: 0.7,
    impactMix: [2, 3, 3, 1],
    volume: 2.6,
    quality: 3.7,
  },
  {
    name: 'Ishita Bose',
    email: 'ishita',
    role: 'MEMBER',
    title: 'Data Analyst',
    team: 'Growth',
    reliability: 0.92,
    impactMix: [2, 4, 2, 0],
    volume: 2,
    quality: 4.4,
  },
  {
    name: 'Karan Malhotra',
    email: 'karan',
    role: 'MEMBER',
    title: 'iOS Engineer',
    team: 'Mobile',
    reliability: 0.72,
    impactMix: [2, 3, 3, 1],
    volume: 2.3,
    quality: 3.9,
  },
  {
    name: 'Tanvi Joshi',
    email: 'tanvi',
    role: 'MEMBER',
    title: 'Android Engineer',
    team: 'Mobile',
    reliability: 0.55,
    impactMix: [3, 3, 2, 0],
    volume: 2.8,
    quality: 3.4,
  },
]

const PROJECTS = [
  {
    name: 'Flow builder 2.0',
    team: 'Platform',
    desc: 'Faster, more reliable automation runs.',
    items: [
      'Run queue backpressure',
      'Retry policy per step',
      'Step-level timeouts',
      'Execution log search',
      'Webhook signature check',
      'Flow version diff',
      'Cold-start optimisation',
      'Billing meter accuracy',
    ],
  },
  {
    name: 'Self-serve onboarding',
    team: 'Growth',
    desc: 'New workspaces activate without a sales call.',
    items: [
      'Template gallery',
      'Guided first flow',
      'Activation email series',
      'In-app checklist',
      'Pricing page experiment',
      'Signup funnel analysis',
      'Referral programme',
    ],
  },
  {
    name: 'Mobile app launch',
    team: 'Mobile',
    desc: 'iOS and Android apps for alerts and approvals.',
    items: ['Push notification service', 'Approval screen', 'Offline queue', 'Crash reporting', 'App Store listing', 'Biometric sign-in', 'Deep links'],
  },
  {
    name: 'Reliability & security',
    team: 'Platform',
    desc: 'SOC 2 readiness and fewer incidents.',
    items: ['Audit log export', 'Secrets rotation', 'On-call runbooks', 'DB failover drill', 'Dependency scanning', 'Rate limiter rollout'],
  },
] as const

const SLACK_REQUESTS = [
  'Deploy the hotfix for webhook retries',
  'Check why EU customers see slow runs',
  'Update the pricing FAQ before launch',
  'Prepare demo for Ashish sir on Friday',
  'Rotate the Stripe webhook secret',
  'Share activation numbers with marketing',
  'Fix the broken invite email link',
]
const BLOCKER_REASONS: Record<BlockerKind, string[]> = {
  EXTERNAL: ['Waiting for Apple review', 'Vendor API rate limit', 'Customer has not shared logs', 'Payment provider sandbox down'],
  DEPENDENCY: ['Blocked by Platform migration', 'Needs design sign-off', 'Waiting on data pipeline fix'],
  INTERNAL: ['Unclear acceptance criteria', 'Security review pending', 'Flaky CI on main'],
}

async function main() {
  const owner = await prisma.user.findUnique({ where: { email: ownerEmail } })
  if (!owner) throw new Error(`No WorkPulse account for ${ownerEmail}. Register first.`)
  const old = await prisma.organization.findUnique({ where: { slug: SLUG } })
  if (old) {
    await prisma.organization.delete({ where: { id: old.id } })
    console.log('Replaced the previous sample organization.')
  }
  const passwordHash = await hash('Password123', { memoryCost: 19456, timeCost: 2, parallelism: 1 })
  const org = await prisma.organization.create({
    data: { name: 'M91 Showcase (sample data)', slug: SLUG, settings: { retentionDays: 730, requireReportApproval: false, impactTargetPerWeek: 10 } },
  })
  await prisma.organizationMember.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER', title: 'Founder' } })
  await prisma.scoringModel.create({ data: { orgId: org.id, name: 'Default', weights: DEFAULT_WEIGHTS, createdBy: owner.id } })

  const users = new Map<string, { id: string; p: Person }>()
  for (const p of PEOPLE) {
    const email = `${p.email}@sample.workpulse.dev`
    const u = await prisma.user.upsert({
      where: { email },
      create: { email, name: p.name, passwordHash, emailVerifiedAt: new Date(), timezone: 'Asia/Kolkata' },
      update: { name: p.name },
    })
    await prisma.organizationMember.create({ data: { orgId: org.id, userId: u.id, role: p.role, title: p.title } })
    users.set(p.email, { id: u.id, p })
  }
  const lead = { Platform: users.get('rahul')!.id, Growth: users.get('sana')!.id, Mobile: users.get('vikram')!.id }
  const teams: Record<string, string> = {}
  for (const name of ['Platform', 'Growth', 'Mobile'] as const) {
    const members = PEOPLE.filter((p) => p.team === name).map((p) => ({ userId: users.get(p.email)!.id }))
    teams[name] = (await prisma.team.create({ data: { orgId: org.id, name, managerId: lead[name], members: { create: members } } })).id
  }
  await prisma.mentorAssignment.createMany({
    data: ['rohan', 'tanvi', 'aditya'].map((m) => ({ orgId: org.id, mentorId: users.get('kavya')!.id, menteeId: users.get(m)!.id })),
  })

  const projects: Record<string, { id: string; items: readonly string[] }> = {}
  for (const p of PROJECTS) {
    const pr = await prisma.project.create({
      data: {
        orgId: org.id,
        teamId: teams[p.team],
        ownerId: lead[p.team as keyof typeof lead],
        name: p.name,
        description: p.desc,
        startDate: at(90),
        targetDate: at(-30 - Math.floor(rand() * 30)),
      },
    })
    projects[p.name] = { id: pr.id, items: p.items }
  }

  // Goals: past quarters' results (achieved / missed) and current ones with key results.
  const goals: Record<string, string[]> = { Platform: [], Growth: [], Mobile: [] }
  const mkGoal = async (
    team: 'Platform' | 'Growth' | 'Mobile',
    ownerId: string,
    title: string,
    period: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'MILESTONE',
    start: number,
    due: number,
    status: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'ACHIEVED' | 'MISSED',
    krs: [string, number, number, number, string][],
  ) => {
    const progress = krs.length
      ? Math.round((krs.reduce((a, [, s, t, c]) => a + Math.max(0, Math.min(1, (c - s) / (t - s))), 0) / krs.length) * 100)
      : status === 'ACHIEVED'
        ? 100
        : 40
    const g = await prisma.goal.create({
      data: {
        orgId: org.id,
        ownerId,
        teamId: teams[team],
        title,
        period,
        startDate: at(start),
        dueDate: at(due),
        status,
        progress,
        expectedOutcome: `${title}, measured by its key results.`,
        actualOutcome: status === 'ACHIEVED' ? 'Delivered as planned.' : status === 'MISSED' ? 'Partially delivered; carried into next quarter.' : null,
        keyResults: { create: krs.map(([t, s, tg, c, u]) => ({ title: t, start: s, target: tg, current: c, unit: u })) },
      },
    })
    for (let i = 4; i >= 0; i--)
      await prisma.goalUpdate.create({
        data: {
          goalId: g.id,
          authorId: ownerId,
          progress: Math.round((progress * (5 - i)) / 5),
          status: i > 1 ? 'ON_TRACK' : status,
          note: i === 0 ? 'Weekly check-in' : null,
          createdAt: at(start - ((start - Math.max(due, 0)) * (5 - i)) / 5),
        },
      })
    goals[team]!.push(g.id)
  }
  await mkGoal('Platform', lead.Platform, 'Cut failed flow runs in half', 'QUARTERLY', 45, -45, 'ON_TRACK', [
    ['Failed runs per 1k', 18, 9, 12, ''],
    ['p95 run latency', 2400, 1200, 1600, 'ms'],
  ])
  await mkGoal('Platform', users.get('kavya')!.id, 'SOC 2 Type I ready', 'MILESTONE', 60, -20, 'AT_RISK', [['Controls implemented', 0, 42, 29, '']])
  await mkGoal('Platform', lead.Platform, 'Ship flow versioning', 'MONTHLY', 80, 50, 'ACHIEVED', [])
  await mkGoal('Growth', lead.Growth, 'Self-serve activation 25/week', 'QUARTERLY', 45, -45, 'ON_TRACK', [
    ['Activated workspaces / week', 8, 25, 17, 'teams'],
    ['Trial → paid', 4, 8, 6.1, '%'],
  ])
  await mkGoal('Growth', lead.Growth, 'Launch referral programme', 'MONTHLY', 70, 40, 'MISSED', [])
  await mkGoal('Mobile', lead.Mobile, 'Mobile apps live in both stores', 'MILESTONE', 60, -10, 'OFF_TRACK', [
    ['Store approvals', 0, 2, 1, ''],
    ['Beta testers', 0, 200, 140, 'users'],
  ])
  await mkGoal('Mobile', lead.Mobile, 'Crash-free sessions 99.5%', 'MONTHLY', 30, -2, 'ON_TRACK', [['Crash-free sessions', 97.8, 99.5, 99.1, '%']])

  // Tasks over 12 weeks.
  const levels: ImpactLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
  const pickImpact = (mix: number[]) => {
    const total = mix.reduce((a, b) => a + b, 0)
    let r = rand() * total
    for (let i = 0; i < 4; i++) if ((r -= mix[i]!) < 0) return levels[i]!
    return 'LOW'
  }
  let ext = 400
  let taskCount = 0
  const everyone = [
    ...users.values(),
    {
      id: owner.id,
      p: {
        ...PEOPLE[0]!,
        name: 'You',
        team: 'Platform' as const,
        volume: 1,
        reliability: 0.85,
        impactMix: [1, 2, 3, 1] as [number, number, number, number],
        quality: 4.2,
      },
    },
  ]
  for (const { id: userId, p } of everyone) {
    const teamName = p.team ?? 'Platform'
    const myProjects = PROJECTS.filter((x) => x.team === teamName || (teamName === 'Platform' && x.name === 'Reliability & security'))
    const n = Math.round(p.volume * 12 * (0.85 + rand() * 0.3))
    for (let i = 0; i < n; i++) {
      const proj = pick(myProjects)
      const created = 2 + Math.floor(rand() * 84)
      const span = 2 + Math.floor(rand() * 10)
      const due = created - span
      const finished = due > 1 ? chance(0.93) : due > -3 ? chance(0.35) : chance(0.05)
      const late = finished && !chance(p.reliability)
      const completedAgo = finished ? Math.max(0, late ? due - 1 - Math.floor(rand() * 4) : due + Math.floor(rand() * Math.max(1, span - 1))) : null
      const blocked = !finished && chance(0.18)
      const status: TaskStatus = finished
        ? 'COMPLETED'
        : blocked
          ? 'BLOCKED'
          : due < 0
            ? pick(['TODO', 'BACKLOG', 'TODO'] as const)
            : pick(['IN_PROGRESS', 'IN_REVIEW', 'TODO', 'IN_PROGRESS'] as const)
      const impact = chance(0.12) ? 'NONE' : pickImpact(p.impactMix)
      const source = pick(['native', 'native', 'linear', 'linear', 'jira', 'github', 'slack'] as const)
      const title =
        source === 'slack' ? pick(SLACK_REQUESTS) : `${pick(proj.items)}${chance(0.35) ? ` (${pick(['phase 2', 'follow-up', 'v2', 'edge cases'])})` : ''}`
      const goalPool = goals[teamName] ?? []
      const t = await prisma.task.create({
        data: {
          orgId: org.id,
          projectId: projects[proj.name]!.id,
          creatorId: userId,
          assigneeId: userId,
          title,
          description: source === 'slack' ? `From Slack:\n> ${title.toLowerCase()} please` : 'Sample task (generated).',
          status,
          priority: pick<Priority>(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'CRITICAL']),
          impactLevel: impact,
          complexity: 1 + Math.floor(rand() * 5),
          category:
            source === 'slack'
              ? 'From Slack'
              : pick(teamName === 'Growth' ? ['Experiment', 'Design', 'Analytics', 'Engineering'] : ['Engineering', 'Engineering', 'Operations', 'Security']),
          labels: chance(0.4) ? [pick(['customer', 'tech-debt', 'launch', 'bug', 'infra'])] : [],
          dueAt: at(due, 18),
          createdAt: at(created),
          startedAt: status === 'TODO' || status === 'BACKLOG' ? null : at(Math.min(created, (completedAgo ?? 0) + 1 + Math.floor(rand() * 4))),
          completedAt: completedAgo == null ? null : at(completedAgo, 16),
          estimateMins: pick([60, 90, 120, 240, 480, null]),
          actualMins: finished ? 45 + Math.floor(rand() * 500) : Math.floor(rand() * 200),
          origin: source === 'native' ? 'NATIVE' : 'EXTERNAL',
          reopenCount: finished && chance(0.07) ? 1 : 0,
          needsReview: source !== 'native' && chance(0.04),
          goals: goalPool.length && chance(impact === 'HIGH' || impact === 'CRITICAL' ? 0.8 : 0.4) ? { create: [{ goalId: pick(goalPool) }] } : undefined,
        },
      })
      taskCount++
      if (source !== 'native') {
        ext++
        const key = source === 'linear' ? `ENG-${ext}` : source === 'jira' ? `M91-${ext}` : source === 'github' ? `m91/flows#${ext}` : '#work-requests'
        const url =
          source === 'linear'
            ? `https://linear.app/m91/issue/${key}`
            : source === 'jira'
              ? `https://m91.atlassian.net/browse/${key}`
              : source === 'github'
                ? `https://github.com/m91/flows/issues/${ext}`
                : 'https://slack.com/app_redirect?channel=C0SAMPLE'
        await prisma.taskSource.create({
          data: {
            orgId: org.id,
            taskId: t.id,
            provider: source === 'jira' ? 'jira-software-cloud' : source,
            externalId: `sample-${source}-${ext}`,
            externalKey: key,
            sourceUrl: url,
            externalUpdatedAt: t.createdAt,
            lastSyncedAt: at(Math.max(0, completedAgo ?? 0)),
            lastExternal: {},
          },
        })
      }
      if (blocked || chance(0.12)) {
        const kind = pick<BlockerKind>(['EXTERNAL', 'DEPENDENCY', 'INTERNAL', 'INTERNAL'])
        const opened = Math.max(0, Math.min(created - 1, due + 2))
        await prisma.blocker.create({
          data: {
            orgId: org.id,
            taskId: t.id,
            reportedById: userId,
            kind,
            reason: pick(BLOCKER_REASONS[kind]),
            createdAt: at(opened),
            resolvedAt: blocked ? null : at(Math.max(0, opened - 1 - Math.floor(rand() * 3))),
            resolution: blocked ? null : 'Unblocked',
          },
        })
      }
      if (finished && impact !== 'NONE' && chance(impact === 'LOW' ? 0.35 : 0.85)) {
        const kind = pick(['PULL_REQUEST', 'PULL_REQUEST', 'DEPLOYMENT', 'DOCUMENT', 'RELEASE', 'URL'] as const)
        const verified = chance(0.65)
        const ev = await prisma.evidence.create({
          data: {
            orgId: org.id,
            taskId: t.id,
            kind,
            source: kind === 'PULL_REQUEST' || kind === 'RELEASE' ? 'GITHUB' : 'MANUAL',
            title:
              kind === 'PULL_REQUEST'
                ? `Merged PR #${100 + ext}: ${title}`
                : kind === 'DEPLOYMENT'
                  ? 'Production deploy'
                  : kind === 'RELEASE'
                    ? `Release v2.${ext % 40}`
                    : 'Design / spec document',
            url: `https://example.com/sample/${ext}`,
            externalId: `sample-ev-${t.id}`,
            addedById: userId,
            status: verified ? 'VERIFIED' : 'RECEIVED',
            createdAt: at(completedAgo!, 17),
          },
        })
        const verifier = p.team ? lead[p.team as keyof typeof lead] : owner.id
        if (verified && verifier !== userId)
          await prisma.evidenceVerification.create({
            data: {
              evidenceId: ev.id,
              verifierId: verifier,
              status: 'VERIFIED',
              qualityScore: Math.max(1, Math.min(5, Math.round(p.quality + (rand() - 0.5)))),
              impactNote: chance(0.3) ? pick(['Reduced support tickets', 'Conversion +2%', 'Failed runs -30%', 'Unblocked enterprise deal']) : null,
              createdAt: at(Math.max(0, completedAgo! - 1)),
            },
          })
      }
      const assessor = p.team ? lead[p.team as keyof typeof lead] : owner.id
      if (finished && assessor !== userId && chance(0.55))
        await prisma.qualityAssessment.create({
          data: {
            orgId: org.id,
            taskId: t.id,
            assessorId: assessor,
            quality: Math.max(1, Math.min(5, Math.round(p.quality + (rand() - 0.5) * 1.6))),
            impact: chance(0.5) ? impact : null,
            createdAt: at(Math.max(0, completedAgo! - 1)),
          },
        })
      if (finished || status === 'IN_PROGRESS') {
        const day = completedAgo ?? Math.floor(rand() * 5)
        await prisma.workSession.create({
          data: {
            orgId: org.id,
            userId,
            taskId: t.id,
            kind: 'FOCUS',
            startedAt: at(day, 10),
            endedAt: new Date(at(day, 10).getTime() + (40 + Math.floor(rand() * 180)) * 60000),
          },
        })
      }
      await prisma.taskActivity.create({
        data: {
          taskId: t.id,
          kind: source === 'native' ? 'created' : 'imported',
          actorType: source === 'native' ? 'USER' : source === 'slack' ? 'AI' : 'SYNC',
          actorId: source === 'native' ? userId : null,
          toValue: source === 'native' ? null : source,
          createdAt: t.createdAt,
        },
      })
      if (finished)
        await prisma.taskActivity.create({
          data: {
            taskId: t.id,
            kind: 'field_changed',
            field: 'status',
            fromValue: 'IN_PROGRESS',
            toValue: 'COMPLETED',
            actorType: source === 'native' ? 'USER' : 'SYNC',
            actorId: source === 'native' ? userId : null,
            createdAt: t.completedAt!,
          },
        })
    }
  }

  // Daily plans with reviews and carry-forward reasons (last 10 days, for the owner and two members).
  for (const uid of [owner.id, users.get('arjun')!.id, users.get('neha')!.id]) {
    for (let d = 10; d >= 1; d--) {
      const day = new Date(Date.now() - d * DAY)
      if ([0, 6].includes(day.getUTCDay())) continue
      const open = await prisma.task.findMany({ where: { orgId: org.id, assigneeId: uid }, take: 3, skip: d % 5, select: { id: true, title: true } })
      await prisma.dailyPlan.create({
        data: {
          orgId: org.id,
          userId: uid,
          date: day.toISOString().slice(0, 10),
          topOutcomes: open.map((t, i) => ({ text: t.title, taskId: t.id, done: i < 2 })),
          plannedTaskIds: open.map((t) => t.id),
          checkIn: 'Focus on the launch blockers first.',
          energy: 3 + (d % 3),
          review: 'Two of three outcomes done.',
          carryForward: open.slice(2).map((t) => ({ taskId: t.id, reason: 'Waiting on review' })),
          reviewedAt: day,
        },
      })
    }
  }

  // Feedback, a correction request, notifications.
  const fb = [
    ['rahul', 'arjun', 'MANAGER', 'The retry policy work removed our biggest source of failed runs. Excellent scoping.', 5],
    ['rahul', 'neha', 'MANAGER', 'Lots of tasks closed. Next quarter, let us aim for fewer, higher-impact outcomes.', 3],
    ['rahul', 'rohan', 'MANAGER', 'Several commitments slipped. Flag blockers earlier so we can help.', 3],
    ['kavya', 'rohan', 'MENTOR', 'Break work into smaller PRs; reviews will be faster.', null],
    ['sana', 'priya', 'MANAGER', 'The onboarding redesign moved activation. Please attach the experiment readout as evidence.', 4],
    ['vikram', 'tanvi', 'MANAGER', 'Store review delays were outside your control; the crash fixes were solid.', 4],
  ] as const
  for (const [from, to, kind, body, rating] of fb)
    await prisma.feedback.create({
      data: {
        orgId: org.id,
        authorId: users.get(from)!.id,
        subjectUserId: users.get(to)!.id,
        kind,
        body,
        rating,
        createdAt: at(3 + Math.floor(rand() * 20)),
        acknowledgedAt: chance(0.5) ? at(1) : null,
      },
    })
  const disputed = await prisma.task.findFirst({ where: { orgId: org.id, assigneeId: users.get('neha')!.id, status: 'COMPLETED' } })
  if (disputed)
    await prisma.correctionRequest.create({
      data: {
        orgId: org.id,
        requesterId: users.get('neha')!.id,
        targetType: 'TASK',
        targetId: disputed.id,
        field: 'impactLevel',
        reason: 'This fix unblocked two enterprise customers; impact should be HIGH, not LOW.',
      },
    })

  // Sync history and automation runs, as they look once integrations run for a while (sample rows, no live flows).
  const statuses = ['PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'SKIPPED_STALE', 'NEEDS_MAPPING', 'FAILED', 'DEAD'] as const
  for (let i = 0; i < 80; i++) {
    const provider = pick(['linear', 'linear', 'jira-software-cloud', 'github', 'slack'])
    const status = pick(statuses)
    await prisma.syncEvent.create({
      data: {
        orgId: org.id,
        provider,
        eventType: pick(
          provider === 'slack'
            ? ['New_Message_Posted_in_Channel_Instant']
            : provider === 'github'
              ? ['Pull_Request_Opens_or_Closes', 'New_Commit_Pushed']
              : ['New_Issue_Created', 'Updated_Issue'],
        ),
        idempotencyKey: `sample-${i}`,
        payload: { sample: true },
        status,
        attempts: status === 'DEAD' ? 5 : status === 'FAILED' ? 2 : 1,
        error:
          status === 'DEAD'
            ? 'Provider returned 503 after 5 attempts'
            : status === 'FAILED'
              ? 'Invalid payload: missing id'
              : status === 'NEEDS_MAPPING'
                ? 'Needs review: status "QA Ready"'
                : status === 'SKIPPED_STALE'
                  ? 'Event is not newer than the stored update.'
                  : null,
        receivedAt: at(Math.floor(rand() * 30)),
        processedAt: at(0),
      },
    })
  }
  await prisma.syncMapping.create({
    data: { orgId: org.id, provider: 'linear', kind: 'STATUS', fromValue: 'QA Ready', toValue: 'IN_REVIEW', confidence: 0.86, source: 'AI', active: false },
  })
  await prisma.syncMapping.create({
    data: {
      orgId: org.id,
      provider: 'jira-software-cloud',
      kind: 'PRIORITY',
      fromValue: 'P1 - Customer',
      toValue: 'HIGH',
      confidence: 0.74,
      source: 'AI',
      active: false,
    },
  })
  for (let i = 0; i < 24; i++) {
    const ok = chance(0.88)
    await prisma.automationExecution.create({
      data: {
        orgId: org.id,
        userId: owner.id,
        automation: pick(['slack_delivery', 'slack_delivery', 'gmail_delivery']),
        status: ok ? 'SUCCEEDED' : 'FAILED',
        attempts: ok ? 1 : 3,
        error: ok ? null : 'Slack answered channel_not_found',
        dedupeKey: `sample-exec-${org.id}-${i}`,
        createdAt: at(i),
        updatedAt: at(i),
      },
    })
  }

  // Weekly score snapshots for 12 weeks (people and teams), then reports.
  const monday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - ((new Date().getUTCDay() + 6) % 7)))
  const subjects = [...[...users.values()].map((u) => `user:${u.id}`), `user:${owner.id}`, ...Object.values(teams).map((t) => `team:${t}`)]
  for (let w = 12; w >= 0; w--) {
    const start = new Date(monday.getTime() - w * 7 * DAY)
    for (const s of subjects) await snapshot(org.id, s, start, new Date(start.getTime() + 7 * DAY), 'WEEK')
  }
  for (const s of [`user:${owner.id}`, ...Object.values(teams).map((t) => `team:${t}`)]) {
    for (const w of [1, 2, 3]) await generateReport(org.id, 'WEEKLY', s, new Date(monday.getTime() - w * 7 * DAY).toISOString().slice(0, 10), owner.id, false)
  }
  await generateReport(org.id, 'DAILY', `user:${owner.id}`, new Date(Date.now() - DAY).toISOString().slice(0, 10), owner.id, false)

  // Open the sample organization the next time the owner loads the app (switch back from the sidebar).
  await prisma.session.updateMany({ where: { userId: owner.id }, data: { activeOrgId: org.id } })
  console.log(
    `"${org.name}": ${PEOPLE.length + 1} people, ${taskCount} tasks over 12 weeks. Owner: ${ownerEmail}. Sample members sign in with password Password123 (e.g. rahul@sample.workpulse.dev).`,
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

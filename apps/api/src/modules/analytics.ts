import { Router } from 'express'
import { z } from 'zod'
import { rangeQuerySchema, type ScoreDimension } from '@workpulse/shared'
import { prisma, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { forbidden, notFound } from '../lib/errors.js'
import { assertCanSeeUser, assertManager, canSeeUser, scopedUserIds, taskScope, type Ctx } from '../lib/scope.js'
import { addDays, weekStart } from '../lib/dates.js'
import { ctxOf } from '../middleware/auth.js'
import { IMPACT_POINTS, computeScore, impactTarget, loadScoreInput, modelFor, snapshot } from '../services/performance.js'

export const analytics = Router()

// ───────────── Range & weeks ─────────────

const isMidnightUtc = (d: Date) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0

function resolveRange(q: { from?: Date; to?: Date }) {
  // A date-only "to" (YYYY-MM-DD) means the whole of that day.
  const to = q.to ? (isMidnightUtc(q.to) ? new Date(q.to.getTime() + 864e5 - 1) : q.to) : new Date()
  const from = q.from ?? new Date(to.getTime() - 8 * 7 * 864e5)
  if (to.getTime() - from.getTime() > 366 * 864e5) throw forbidden('Choose a range of at most one year.')
  return { from, to }
}

/** Monday-start UTC weeks covering [from, to]. */
export function weeksBetween(from: Date, to: Date) {
  const weeks: { start: Date; end: Date; label: string }[] = []
  let ws = weekStart(from.toISOString().slice(0, 10))
  while (Date.parse(`${ws}T00:00:00Z`) <= to.getTime()) {
    weeks.push({ start: new Date(`${ws}T00:00:00Z`), end: new Date(`${addDays(ws, 7)}T00:00:00Z`), label: ws })
    ws = addDays(ws, 7)
  }
  return weeks
}

/** A week's snapshot: reused once the week is over and was calculated after it ended; recalculated otherwise. */
async function weekScore(orgId: string, subject: string, start: Date, end: Date) {
  const existing = await prisma.performanceSnapshot.findFirst({
    where: { orgId, subject, granularity: 'WEEK', periodStart: start },
    orderBy: { calculatedAt: 'desc' },
  })
  if (existing && end < new Date() && existing.calculatedAt > end) {
    return {
      score: existing.score,
      components: existing.components as Record<string, { value: number | null }>,
      metrics: existing.metrics as Record<string, number>,
    }
  }
  const r = await snapshot(orgId, subject, start, end, 'WEEK')
  return {
    score: r.score,
    components: r.dimensions as unknown as Record<string, { value: number | null }>,
    metrics: { ...r.metrics, ...r.diagnostics } as unknown as Record<string, number>,
  }
}

async function liveScore(orgId: string, userIds: string[], from: Date, to: Date, role: string | null) {
  const model = await modelFor(orgId, role)
  const input = await loadScoreInput(orgId, userIds, from, to)
  const target = (await impactTarget(orgId)) * Math.max(1, userIds.length)
  return {
    ...computeScore({ ...input, impactTargetPerWeek: target }, model.weights as Record<ScoreDimension, number>),
    model: { name: model.name, version: model.version },
  }
}

// ───────────── Shared aggregates ─────────────

async function goalAchievement(orgId: string, where: Prisma.GoalWhereInput, from: Date, to: Date) {
  const goals = await prisma.goal.findMany({
    where: { orgId, deletedAt: null, ...where, dueDate: { gte: from, lte: to } },
    select: { status: true, progress: true },
  })
  const closed = goals.filter((g) => g.status === 'ACHIEVED' || g.status === 'MISSED')
  return {
    due: goals.length,
    achieved: goals.filter((g) => g.status === 'ACHIEVED').length,
    // Achievement rate counts only goals with a result; open ones show average progress instead.
    rate: closed.length ? Math.round((goals.filter((g) => g.status === 'ACHIEVED').length / closed.length) * 100) : null,
    avgProgress: goals.length ? Math.round(goals.reduce((a, g) => a + g.progress, 0) / goals.length) : null,
  }
}

const taskSelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  impactLevel: true,
  complexity: true,
  dueAt: true,
  completedAt: true,
  startedAt: true,
  createdAt: true,
  updatedAt: true,
  assigneeId: true,
  projectId: true,
  category: true,
  estimateMins: true,
  project: { select: { id: true, name: true } },
  source: { select: { provider: true } },
} satisfies Prisma.TaskSelect

// ───────────── Individual ─────────────

analytics.get('/analytics/individual', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, rangeQuerySchema)
  const userId = q.userId ?? ctx.userId
  assertCanSeeUser(ctx, userId)
  const { from, to } = resolveRange(q)
  const member = await prisma.organizationMember.findUnique({
    where: { orgId_userId: { orgId: ctx.orgId, userId } },
    include: { user: { select: { name: true } } },
  })
  if (!member) throw notFound('Person')

  const base: Prisma.TaskWhereInput = { AND: [taskScope(ctx), { assigneeId: userId, parentId: null }, q.projectId ? { projectId: q.projectId } : {}] }
  const [current, weeks, tasksInRange, openTasks, blockers, sessions, evidence, goals] = await Promise.all([
    liveScore(ctx.orgId, [userId], from, to, member.role),
    Promise.all(weeksBetween(from, to).map(async (w) => ({ ...w, ...(await weekScore(ctx.orgId, `user:${userId}`, w.start, w.end)) }))),
    prisma.task.findMany({ where: { AND: [base, { OR: [{ completedAt: { gte: from, lte: to } }, { dueAt: { gte: from, lte: to } }] }] }, select: taskSelect }),
    prisma.task.findMany({
      where: { AND: [base, { status: { notIn: ['COMPLETED', 'CANCELLED'] }, archivedAt: null }] },
      select: taskSelect,
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }],
    }),
    prisma.blocker.findMany({
      where: { orgId: ctx.orgId, task: { assigneeId: userId }, createdAt: { gte: from, lte: to } },
      select: { createdAt: true, resolvedAt: true, kind: true },
    }),
    prisma.workSession.findMany({
      where: { orgId: ctx.orgId, userId, startedAt: { gte: from, lte: to }, endedAt: { not: null } },
      select: { startedAt: true, endedAt: true, task: { select: { project: { select: { name: true } }, category: true } } },
    }),
    prisma.evidence.findMany({
      where: { orgId: ctx.orgId, deletedAt: null, task: { assigneeId: userId } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, title: true, kind: true, status: true, url: true, createdAt: true, task: { select: { id: true, title: true } } },
    }),
    goalAchievement(ctx.orgId, { ownerId: userId }, from, to),
  ])

  const weekly = weeks.map((w) => {
    const planned = tasksInRange.filter((t) => t.dueAt && t.dueAt >= w.start && t.dueAt < w.end && t.status !== 'CANCELLED').length
    const done = tasksInRange.filter((t) => t.completedAt && t.completedAt >= w.start && t.completedAt < w.end)
    return {
      week: w.label,
      planned,
      completed: done.length,
      impactPoints: Math.round(done.reduce((a, t) => a + IMPACT_POINTS[t.impactLevel], 0) * 10) / 10,
      score: w.score,
      impact: w.components.impact?.value ?? null,
      reliability: w.components.reliability?.value ?? null,
      blockers: blockers.filter((b) => b.createdAt >= w.start && b.createdAt < w.end).length,
    }
  })

  const byProject = new Map<string, { id: string | null; name: string; value: number }>()
  for (const t of openTasks) {
    const k = t.project?.id ?? 'none'
    const row = byProject.get(k) ?? { id: t.project?.id ?? null, name: t.project?.name ?? 'No project', value: 0 }
    row.value++
    byProject.set(k, row)
  }
  const time = new Map<string, number>()
  for (const s of sessions) {
    const key = s.task?.project?.name ?? s.task?.category ?? 'Unlinked'
    time.set(key, (time.get(key) ?? 0) + Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 60000))
  }
  const now = new Date()
  res.json({
    user: { id: userId, name: member.user.name, role: member.role },
    range: { from, to },
    score: current,
    kpis: {
      score: current.score,
      impact: current.dimensions.impact.value,
      goalAchievement: goals,
      reliability: current.dimensions.reliability.value,
      completedOutcomes: current.metrics.completed,
      highImpactCompleted: current.metrics.highImpactCompleted,
      activeBlockers: openTasks.filter((t) => t.status === 'BLOCKED').length,
    },
    weekly,
    workload: [...byProject.values()],
    workloadByStatus: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'].map((s) => ({
      status: s,
      value: openTasks.filter((t) => t.status === s).length,
    })),
    timeAllocation: [...time].map(([name, minutes]) => ({ name, minutes })),
    recentHighImpact: tasksInRange
      .filter((t) => t.status === 'COMPLETED' && (t.impactLevel === 'HIGH' || t.impactLevel === 'CRITICAL'))
      .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())
      .slice(0, 6),
    upcoming: openTasks.filter((t) => t.dueAt && t.dueAt >= now).slice(0, 8),
    delayed: openTasks.filter((t) => t.dueAt && t.dueAt < now),
    recentEvidence: evidence,
  })
})

// ───────────── Team ─────────────

analytics.get('/analytics/team', async (req, res) => {
  const ctx = ctxOf(req)
  assertManager(ctx)
  const q = query(req, rangeQuerySchema)
  const { from, to } = resolveRange(q)
  if (q.teamId && !ctx.orgWide && !ctx.managedTeamIds.includes(q.teamId)) throw notFound('Team')
  const userIds = (await scopedUserIds(ctx, { teamId: q.teamId })).filter((id) => ctx.orgWide || id !== ctx.userId || q.teamId)
  const members = await prisma.organizationMember.findMany({
    where: { orgId: ctx.orgId, userId: { in: userIds } },
    include: { user: { select: { id: true, name: true } } },
  })
  const projectFilter: Prisma.TaskWhereInput = q.projectId ? { projectId: q.projectId } : {}
  const base: Prisma.TaskWhereInput = { orgId: ctx.orgId, deletedAt: null, parentId: null, assigneeId: { in: userIds }, ...projectFilter }

  const [tasksInRange, openTasks, unassigned, blockers, team, goals, lastActivity, pendingReviews] = await Promise.all([
    prisma.task.findMany({
      where: { ...base, OR: [{ completedAt: { gte: from, lte: to } }, { dueAt: { gte: from, lte: to } }] },
      select: { ...taskSelect, blockers: { select: { kind: true } } },
    }),
    prisma.task.findMany({
      where: { ...base, status: { notIn: ['COMPLETED', 'CANCELLED'] }, archivedAt: null },
      select: { ...taskSelect, blockers: { where: { resolvedAt: null }, select: { createdAt: true } } },
    }),
    prisma.task.count({
      where: {
        orgId: ctx.orgId,
        deletedAt: null,
        archivedAt: null,
        assigneeId: null,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        ...(q.teamId ? { project: { teamId: q.teamId } } : {}),
        ...projectFilter,
      },
    }),
    prisma.blocker.findMany({
      where: { orgId: ctx.orgId, task: { assigneeId: { in: userIds }, ...projectFilter }, createdAt: { gte: new Date(from.getTime() - 30 * 864e5), lte: to } },
      select: { createdAt: true, resolvedAt: true, kind: true, task: { select: { projectId: true, project: { select: { name: true } } } } },
    }),
    q.teamId ? prisma.team.findUnique({ where: { id: q.teamId }, select: { id: true, name: true } }) : null,
    goalAchievement(
      ctx.orgId,
      q.teamId
        ? { OR: [{ teamId: q.teamId }, { ownerId: { in: userIds } }] }
        : { OR: [{ ownerId: { in: userIds } }, ...(ctx.managedTeamIds.length ? [{ teamId: { in: ctx.managedTeamIds } }] : [])] },
      from,
      to,
    ),
    prisma.taskActivity.groupBy({ by: ['actorId'], where: { actorId: { in: userIds } }, _max: { createdAt: true } }),
    prisma.evidence.count({ where: { orgId: ctx.orgId, deletedAt: null, status: 'RECEIVED', task: { assigneeId: { in: userIds }, status: 'COMPLETED' } } }),
  ])

  const weeks = weeksBetween(from, to)
  const teamSubject = q.teamId ? `team:${q.teamId}` : null
  const teamWeeks = teamSubject ? await Promise.all(weeks.map((w) => weekScore(ctx.orgId, teamSubject, w.start, w.end))) : null
  const now = new Date()

  const weekly = weeks.map((w, i) => {
    const done = tasksInRange.filter((t) => t.completedAt && t.completedAt >= w.start && t.completedAt < w.end)
    const due = tasksInRange.filter((t) => t.dueAt && t.dueAt >= w.start && t.dueAt < w.end && t.status !== 'CANCELLED')
    return {
      week: w.label,
      completed: done.length,
      onTime: done.filter((t) => t.dueAt && t.completedAt! <= t.dueAt).length,
      late: done.filter((t) => t.dueAt && t.completedAt! > t.dueAt).length,
      planned: due.length,
      impactPoints: Math.round(done.reduce((a, t) => a + IMPACT_POINTS[t.impactLevel], 0) * 10) / 10,
      highImpact: done.filter((t) => t.impactLevel === 'HIGH' || t.impactLevel === 'CRITICAL').length,
      score: teamWeeks?.[i]?.score ?? null,
      blockers: blockers.filter((b) => b.createdAt >= w.start && b.createdAt < w.end).length,
    }
  })

  // Per-member comparison (scores computed for the selected range).
  const lastByUser = new Map(lastActivity.map((a) => [a.actorId, a._max.createdAt]))
  const rows = await Promise.all(
    members.map(async (m) => {
      const s = await liveScore(ctx.orgId, [m.userId], from, to, m.role)
      const open = openTasks.filter((t) => t.assigneeId === m.userId)
      const g = await goalAchievement(ctx.orgId, { ownerId: m.userId }, from, to)
      const estimateHours = Math.round(open.reduce((a, t) => a + (t.estimateMins ?? 0), 0) / 60)
      return {
        userId: m.userId,
        name: m.user.name,
        role: m.role,
        title: m.title,
        score: s.score,
        impact: s.dimensions.impact.value,
        reliability: s.dimensions.reliability.value,
        deliveryRate: s.metrics.committed ? Math.round((s.metrics.onTime / s.metrics.committed) * 100) : null,
        goalsAchieved: g.achieved,
        goalsDue: g.due,
        completed: s.metrics.completed,
        highImpact: s.metrics.highImpactCompleted,
        impactPoints: s.metrics.impactPoints,
        activeTasks: open.length,
        inProgress: open.filter((t) => t.status === 'IN_PROGRESS' || t.status === 'IN_REVIEW').length,
        blockers: open.filter((t) => t.status === 'BLOCKED').length,
        overdue: open.filter((t) => t.dueAt && t.dueAt < now).length,
        estimateHours,
        missingDimensions: Object.entries(s.dimensions)
          .filter(([, d]) => d.value == null)
          .map(([k]) => k),
        lastActivity: lastByUser.get(m.userId) ?? null,
      }
    }),
  )

  const projects = new Map<string, { id: string; name: string; total: number; completed: number; blocked: number }>()
  for (const t of [...tasksInRange, ...openTasks]) {
    if (!t.project) continue
    const p = projects.get(t.project.id) ?? { id: t.project.id, name: t.project.name, total: 0, completed: 0, blocked: 0 }
    p.total++
    if (t.status === 'COMPLETED') p.completed++
    if (t.status === 'BLOCKED') p.blocked++
    projects.set(t.project.id, p)
  }

  const completedInRange = tasksInRange.filter((t) => t.status === 'COMPLETED' && t.completedAt && t.completedAt >= from && t.completedAt <= to)
  const dueClosed = tasksInRange.filter(
    (t) => t.dueAt && t.dueAt >= from && t.dueAt <= to && (t.status === 'COMPLETED' || t.dueAt < now) && t.status !== 'CANCELLED',
  )
  const cycle = completedInRange.filter((t) => t.startedAt)
  const avgOpen = rows.length ? rows.reduce((a, r) => a + r.activeTasks, 0) / rows.length : 0

  // Investigation signals, not judgements.
  const health = {
    overloaded: rows
      .filter((r) => r.activeTasks >= Math.max(8, avgOpen * 1.5) || r.estimateHours > 60)
      .map((r) => ({ userId: r.userId, name: r.name, activeTasks: r.activeTasks, estimateHours: r.estimateHours })),
    unbalanced: rows.length > 1 && Math.max(...rows.map((r) => r.activeTasks)) > 3 * Math.max(1, Math.min(...rows.map((r) => r.activeTasks))),
    excessiveWip: rows.filter((r) => r.inProgress > 4).map((r) => ({ userId: r.userId, name: r.name, inProgress: r.inProgress })),
    repeatedlyBlockedProjects: [
      ...blockers.reduce((m, b) => (b.task.project ? m.set(b.task.project.name, (m.get(b.task.project.name) ?? 0) + 1) : m), new Map<string, number>()),
    ]
      .filter(([, n]) => n >= 3)
      .map(([name, count]) => ({ name, count })),
    longBlocked: openTasks
      .filter((t) => t.blockers.some((b) => now.getTime() - b.createdAt.getTime() > 3 * 864e5))
      .map((t) => ({ id: t.id, title: t.title, assigneeId: t.assigneeId })),
    pendingReviews,
    unassignedWork: unassigned,
    delayedMilestones: await prisma.goal.count({
      where: {
        orgId: ctx.orgId,
        deletedAt: null,
        period: 'MILESTONE',
        dueDate: { lt: now },
        status: { in: ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] },
        ...(q.teamId ? { teamId: q.teamId } : { ownerId: { in: userIds } }),
      },
    }),
  }

  res.json({
    team,
    range: { from, to },
    memberCount: rows.length,
    kpis: {
      deliveryRate: dueClosed.length
        ? Math.round((dueClosed.filter((t) => t.status === 'COMPLETED' && t.completedAt! <= t.dueAt!).length / dueClosed.length) * 100)
        : null,
      highImpactOutcomes: completedInRange.filter((t) => t.impactLevel === 'HIGH' || t.impactLevel === 'CRITICAL').length,
      goalAchievement: goals,
      activeBlockers: openTasks.filter((t) => t.status === 'BLOCKED').length,
      overdue: openTasks.filter((t) => t.dueAt && t.dueAt < now).length,
      avgCycleHours: cycle.length
        ? Math.round((cycle.reduce((a, t) => a + (t.completedAt!.getTime() - t.startedAt!.getTime()) / 36e5, 0) / cycle.length) * 10) / 10
        : null,
      completedOutcomes: completedInRange.length,
    },
    weekly,
    members: rows,
    distribution: {
      byStatus: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'].map((s) => ({ status: s, value: openTasks.filter((t) => t.status === s).length })),
      byImpact: (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'] as const).map((l) => ({
        level: l,
        value: completedInRange.filter((t) => t.impactLevel === l).length,
      })),
      byCategory: [
        ...completedInRange.reduce((m, t) => m.set(t.category ?? 'Uncategorised', (m.get(t.category ?? 'Uncategorised') ?? 0) + 1), new Map<string, number>()),
      ].map(([name, value]) => ({ name, value })),
    },
    projects: [...projects.values()].map((p) => ({ ...p, progress: p.total ? Math.round((p.completed / p.total) * 100) : 0 })),
    blockers: {
      byKind: (['INTERNAL', 'EXTERNAL', 'DEPENDENCY'] as const).map((k) => ({
        kind: k,
        open: blockers.filter((b) => b.kind === k && !b.resolvedAt).length,
        resolved: blockers.filter((b) => b.kind === k && b.resolvedAt).length,
      })),
      avgResolutionHours: (() => {
        const r = blockers.filter((b) => b.resolvedAt)
        return r.length ? Math.round(r.reduce((a, b) => a + (b.resolvedAt!.getTime() - b.createdAt.getTime()) / 36e5, 0) / r.length) : null
      })(),
    },
    health,
  })
})

analytics.get('/analytics/projects/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const id = param(req, 'id')
  const project = await prisma.project.findFirst({
    where: { id, orgId: ctx.orgId, deletedAt: null },
    include: { owner: { select: { id: true, name: true } }, team: { select: { id: true, name: true } } },
  })
  if (!project) throw notFound('Project')
  const tasks = await prisma.task.findMany({
    where: { AND: [taskScope(ctx), { projectId: id, parentId: null }] },
    select: { ...taskSelect, assignee: { select: { id: true, name: true } } },
  })
  const weeks = weeksBetween(new Date(Date.now() - 12 * 7 * 864e5), new Date())
  const contributors = new Map<string, { userId: string; name: string; completed: number; impactPoints: number; open: number }>()
  for (const t of tasks) {
    if (!t.assignee) continue
    const c = contributors.get(t.assignee.id) ?? { userId: t.assignee.id, name: t.assignee.name, completed: 0, impactPoints: 0, open: 0 }
    if (t.status === 'COMPLETED') {
      c.completed++
      c.impactPoints += IMPACT_POINTS[t.impactLevel]
    } else if (t.status !== 'CANCELLED') c.open++
    contributors.set(t.assignee.id, c)
  }
  res.json({
    project,
    statusCounts: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'COMPLETED', 'CANCELLED'].map((s) => ({
      status: s,
      value: tasks.filter((t) => t.status === s).length,
    })),
    burnup: weeks.map((w) => ({
      week: w.label,
      scope: tasks.filter((t) => t.createdAt < w.end).length,
      completed: tasks.filter((t) => t.completedAt && t.completedAt < w.end).length,
    })),
    contributors: [...contributors.values()].filter((c) => canSeeUser(ctx, c.userId) || ctx.orgWide).sort((a, b) => b.impactPoints - a.impactPoints),
    overdue: tasks.filter((t) => t.dueAt && t.dueAt < new Date() && !['COMPLETED', 'CANCELLED'].includes(t.status)),
  })
})

// ───────────── Performance ─────────────

analytics.get('/performance/history', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, z.object({ subject: z.string().regex(/^(user|team):[0-9a-f-]{36}$/), from: z.coerce.date().optional() }))
  const [kind, id] = q.subject.split(':') as [string, string]
  if (kind === 'user') assertCanSeeUser(ctx, id)
  else if (!ctx.orgWide && !ctx.managedTeamIds.includes(id)) throw notFound('Team')
  const rows = await prisma.performanceSnapshot.findMany({
    where: { orgId: ctx.orgId, subject: q.subject, granularity: 'WEEK', periodStart: { gte: q.from ?? new Date(Date.now() - 26 * 7 * 864e5) } },
    orderBy: { periodStart: 'asc' },
    include: { scoringModel: { select: { name: true, version: true } } },
  })
  res.json({ snapshots: rows })
})

analytics.get('/performance/:userId', async (req, res) => {
  const ctx = ctxOf(req)
  const userId = param(req, 'userId')
  assertCanSeeUser(ctx, userId)
  const q = query(req, rangeQuerySchema)
  const { from, to } = resolveRange({ from: q.from ?? new Date(Date.now() - 28 * 864e5), to: q.to })
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } } })
  if (!member) throw notFound('Person')
  const result = await liveScore(ctx.orgId, [userId], from, to, member.role)
  res.json({ userId, range: { from, to }, ...result })
})

/** Recalculate stored weekly snapshots for a subject (e.g. after a correction). */
analytics.post('/performance/recalculate', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, z.object({ subject: z.string().regex(/^(user|team):[0-9a-f-]{36}$/), weeks: z.number().int().min(1).max(26).default(8) }))
  const [kind, id] = input.subject.split(':') as [string, string]
  if (kind === 'user') assertCanSeeUser(ctx, id)
  else if (!ctx.orgWide && !ctx.managedTeamIds.includes(id)) throw notFound('Team')
  const ws = weeksBetween(new Date(Date.now() - (input.weeks - 1) * 7 * 864e5), new Date())
  for (const w of ws) await snapshot(ctx.orgId, input.subject, w.start, w.end, 'WEEK')
  res.json({ recalculated: ws.length })
})

export const _test = { weeksBetween, resolveRange }
export type { Ctx }

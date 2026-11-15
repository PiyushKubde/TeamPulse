import { Router } from 'express'
import { z } from 'zod'
import { dailyPlanSchema, dailyReviewSchema, manualSessionSchema, startSessionSchema } from '@workpulse/shared'
import { prisma, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { badRequest, notFound } from '../lib/errors.js'
import { findEditableTask, findVisibleTask, taskScope, type Ctx } from '../lib/scope.js'
import { addDays, dayBounds, todayIn } from '../lib/dates.js'
import { ctxOf } from '../middleware/auth.js'
import { presentTask, taskInclude } from './tasks.js'

export const planner = Router()
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const tzOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } })).timezone

async function assertOwnTasks(ctx: Ctx, ids: string[] | undefined) {
  for (const id of ids ?? []) await findVisibleTask(ctx, id)
}

/** The daily workspace: plan + live data for the day. */
planner.get('/planner/:date', async (req, res) => {
  const ctx = ctxOf(req)
  const date = ymd.parse(req.params.date)
  const tz = await tzOf(ctx.userId)
  const [start, end] = dayBounds(date, tz)
  const soon = new Date(end.getTime() + 3 * 864e5)
  const mine: Prisma.TaskWhereInput = { AND: [taskScope(ctx), { assigneeId: ctx.userId, archivedAt: null }] }
  const [plan, inProgress, dueSoon, completed, blocked, sessions, goals] = await Promise.all([
    prisma.dailyPlan.findUnique({ where: { orgId_userId_date: { orgId: ctx.orgId, userId: ctx.userId, date } } }),
    prisma.task.findMany({ where: { AND: [mine, { status: { in: ['IN_PROGRESS', 'IN_REVIEW'] } }] }, include: taskInclude, orderBy: { priority: 'asc' } }),
    prisma.task.findMany({
      where: { AND: [mine, { status: { notIn: ['COMPLETED', 'CANCELLED'] }, dueAt: { lt: soon } }] },
      include: taskInclude,
      orderBy: { dueAt: 'asc' },
      take: 20,
    }),
    prisma.task.findMany({ where: { AND: [mine, { status: 'COMPLETED', completedAt: { gte: start, lt: end } }] }, include: taskInclude }),
    prisma.task.findMany({ where: { AND: [mine, { status: 'BLOCKED' }] }, include: { ...taskInclude, blockers: { where: { resolvedAt: null } } } }),
    prisma.workSession.findMany({
      where: { orgId: ctx.orgId, userId: ctx.userId, startedAt: { gte: start, lt: end } },
      include: { task: { select: { id: true, title: true } } },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.goal.findMany({
      where: {
        orgId: ctx.orgId,
        ownerId: ctx.userId,
        deletedAt: null,
        status: { in: ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] },
        startDate: { lte: end },
        dueDate: { gte: start },
      },
      select: { id: true, title: true, period: true, progress: true, status: true, dueDate: true },
    }),
  ])
  const planned = plan?.plannedTaskIds.length
    ? await prisma.task.findMany({ where: { AND: [taskScope(ctx), { id: { in: plan.plannedTaskIds } }] }, include: taskInclude })
    : []
  const now = Date.now()
  const focusMins = sessions.reduce((a, s) => a + Math.round(((s.endedAt?.getTime() ?? now) - s.startedAt.getTime()) / 60000), 0)
  const est = completed.reduce((a, t) => a + (t.estimateMins ?? 0), 0)
  const act = completed.reduce((a, t) => a + t.actualMins, 0)
  res.json({
    date,
    timezone: tz,
    plan,
    planned: planned.map((t) => presentTask(t, ctx)),
    inProgress: inProgress.map((t) => presentTask(t, ctx)),
    dueSoon: dueSoon.map((t) => presentTask(t, ctx)),
    completed: completed.map((t) => presentTask(t, ctx)),
    blocked: blocked.map((t) => ({ ...presentTask(t, ctx), blockerReasons: t.blockers.map((b) => b.reason) })),
    sessions,
    goals,
    effort: { focusMins, completedEstimateMins: est, completedActualMins: act, completedWithEstimates: completed.filter((t) => t.estimateMins).length },
    isToday: date === todayIn(tz),
  })
})

planner.put('/planner', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, dailyPlanSchema)
  await assertOwnTasks(ctx, input.plannedTaskIds)
  await assertOwnTasks(
    ctx,
    input.topOutcomes?.flatMap((o) => (o.taskId ? [o.taskId] : [])),
  )
  const data = { topOutcomes: input.topOutcomes, plannedTaskIds: input.plannedTaskIds, checkIn: input.checkIn, energy: input.energy }
  const plan = await prisma.dailyPlan.upsert({
    where: { orgId_userId_date: { orgId: ctx.orgId, userId: ctx.userId, date: input.date } },
    create: {
      orgId: ctx.orgId,
      userId: ctx.userId,
      date: input.date,
      ...data,
      topOutcomes: input.topOutcomes ?? [],
      plannedTaskIds: input.plannedTaskIds ?? [],
    },
    update: data,
  })
  res.json({ plan })
})

/** End-of-day review. Planned tasks that are not done must each carry a reason; they move to tomorrow's plan. */
planner.post('/planner/review', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, dailyReviewSchema)
  const plan = await prisma.dailyPlan.findUnique({ where: { orgId_userId_date: { orgId: ctx.orgId, userId: ctx.userId, date: input.date } } })
  if (!plan) throw badRequest('Plan the day before reviewing it.')
  const open = await prisma.task.findMany({ where: { id: { in: plan.plannedTaskIds }, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, select: { id: true } })
  const explained = new Set(input.carryForward.map((c) => c.taskId))
  const missing = open.filter((t) => !explained.has(t.id))
  if (missing.length) throw badRequest('Give a reason for every planned task that is not done.', { taskIds: missing.map((t) => t.id) })
  const next = addDays(input.date, 1)
  await prisma.$transaction([
    prisma.dailyPlan.update({ where: { id: plan.id }, data: { review: input.review, carryForward: input.carryForward, reviewedAt: new Date() } }),
    prisma.dailyPlan.upsert({
      where: { orgId_userId_date: { orgId: ctx.orgId, userId: ctx.userId, date: next } },
      create: { orgId: ctx.orgId, userId: ctx.userId, date: next, plannedTaskIds: [...explained] },
      update: {},
    }),
  ])
  for (const c of input.carryForward) {
    await prisma.taskActivity.create({ data: { taskId: c.taskId, kind: 'carried_forward', actorType: 'USER', actorId: ctx.userId, toValue: c.reason } })
  }
  res.json({ ok: true, nextDate: next })
})

// ───────────── Work sessions ─────────────

planner.get('/sessions', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }))
  const sessions = await prisma.workSession.findMany({
    where: { orgId: ctx.orgId, userId: ctx.userId, startedAt: { gte: q.from ?? new Date(Date.now() - 7 * 864e5), lte: q.to } },
    include: { task: { select: { id: true, title: true } } },
    orderBy: { startedAt: 'desc' },
  })
  res.json({ sessions, active: sessions.find((s) => !s.endedAt) ?? null })
})

async function stopActive(ctx: Ctx) {
  const active = await prisma.workSession.findFirst({ where: { orgId: ctx.orgId, userId: ctx.userId, endedAt: null } })
  if (!active) return null
  const endedAt = new Date()
  const mins = Math.max(0, Math.round((endedAt.getTime() - active.startedAt.getTime()) / 60000))
  await prisma.workSession.update({ where: { id: active.id }, data: { endedAt } })
  if (active.taskId && mins) await prisma.task.update({ where: { id: active.taskId }, data: { actualMins: { increment: mins } } })
  return { ...active, endedAt, minutes: mins }
}

planner.post('/sessions/start', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, startSessionSchema)
  if (input.taskId) await findEditableTask(ctx, input.taskId)
  await stopActive(ctx)
  const session = await prisma.workSession.create({
    data: { orgId: ctx.orgId, userId: ctx.userId, taskId: input.taskId ?? null, kind: input.kind, startedAt: new Date() },
  })
  if (input.taskId) {
    const t = await prisma.task.findUniqueOrThrow({ where: { id: input.taskId } })
    if (t.status === 'TODO' || t.status === 'BACKLOG')
      await prisma.task.update({ where: { id: t.id }, data: { status: 'IN_PROGRESS', startedAt: t.startedAt ?? new Date() } })
  }
  res.status(201).json({ session })
})

planner.post('/sessions/stop', async (req, res) => {
  const ctx = ctxOf(req)
  const stopped = await stopActive(ctx)
  if (!stopped) throw notFound('Active session')
  res.json({ session: stopped })
})

planner.post('/sessions', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, manualSessionSchema)
  if (input.endedAt.getTime() - input.startedAt.getTime() > 16 * 36e5) throw badRequest('A session can be at most 16 hours.')
  if (input.taskId) await findEditableTask(ctx, input.taskId)
  const session = await prisma.workSession.create({
    data: {
      orgId: ctx.orgId,
      userId: ctx.userId,
      taskId: input.taskId ?? null,
      kind: 'MANUAL',
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      note: input.note ?? null,
    },
  })
  const mins = Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 60000)
  if (input.taskId) await prisma.task.update({ where: { id: input.taskId }, data: { actualMins: { increment: mins } } })
  res.status(201).json({ session })
})

planner.delete('/sessions/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const s = await prisma.workSession.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId, userId: ctx.userId } })
  if (!s) throw notFound('Session')
  if (s.endedAt && s.taskId) {
    const mins = Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60000)
    const t = await prisma.task.findUnique({ where: { id: s.taskId } })
    if (t) await prisma.task.update({ where: { id: t.id }, data: { actualMins: Math.max(0, t.actualMins - mins) } })
  }
  await prisma.workSession.delete({ where: { id: s.id } })
  res.status(204).end()
})

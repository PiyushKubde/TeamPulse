import { Router } from 'express'
import { z } from 'zod'
import { GOAL_PERIODS, goalSchema, goalUpdateSchema, keyResultSchema, keyResultUpdateSchema } from '@workpulse/shared'
import { prisma, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { forbidden, notFound } from '../lib/errors.js'
import { assertCanSeeUser, canEditGoal, goalScope, type Ctx } from '../lib/scope.js'
import { ctxOf } from '../middleware/auth.js'

export const goals = Router()

/** Progress of a goal from its key results: mean of each KR's (current-start)/(target-start), clipped to 0-100. */
export function keyResultProgress(krs: { start: number; target: number; current: number }[]) {
  if (!krs.length) return null
  const parts = krs.map((kr) => {
    const span = kr.target - kr.start
    if (span === 0) return kr.current >= kr.target ? 1 : 0
    return Math.min(1, Math.max(0, (kr.current - kr.start) / span))
  })
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100)
}

const goalInclude = {
  owner: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  keyResults: { orderBy: { createdAt: 'asc' } },
  tasks: { select: { task: { select: { id: true, status: true, impactLevel: true, deletedAt: true } } } },
} satisfies Prisma.GoalInclude

const present = (ctx: Ctx, g: Prisma.GoalGetPayload<{ include: typeof goalInclude }>) => {
  const linked = g.tasks.map((t) => t.task).filter((t) => !t.deletedAt)
  return {
    ...g,
    tasks: undefined,
    linkedTasks: linked.length,
    completedTasks: linked.filter((t) => t.status === 'COMPLETED').length,
    highImpactCompleted: linked.filter((t) => t.status === 'COMPLETED' && (t.impactLevel === 'HIGH' || t.impactLevel === 'CRITICAL')).length,
    progressSource: g.keyResults.length ? 'key_results' : 'manual',
    canEdit: canEditGoal(ctx, g),
  }
}

goals.get('/goals', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(
    req,
    z.object({
      period: z.enum(GOAL_PERIODS).optional(),
      ownerId: z.string().uuid().optional(),
      teamId: z.string().uuid().optional(),
      active: z.coerce.boolean().optional(),
    }),
  )
  if (q.ownerId) assertCanSeeUser(ctx, q.ownerId)
  const where: Prisma.GoalWhereInput = {
    AND: [goalScope(ctx), { period: q.period, ownerId: q.ownerId, teamId: q.teamId }, q.active ? { status: { in: ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] } } : {}],
  }
  const list = await prisma.goal.findMany({ where, include: goalInclude, orderBy: [{ dueDate: 'asc' }] })
  res.json({ goals: list.map((g) => present(ctx, g)) })
})

goals.get('/goals/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const g = await prisma.goal.findFirst({
    where: { AND: [goalScope(ctx), { id: param(req, 'id') }] },
    include: {
      ...goalInclude,
      updates: { orderBy: { createdAt: 'desc' }, take: 50 },
      children: { select: { id: true, title: true, progress: true, status: true } },
    },
  })
  if (!g) throw notFound('Goal')
  res.json({ goal: { ...present(ctx, g), updates: g.updates, children: g.children } })
})

goals.post('/goals', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, goalSchema)
  const ownerId = input.ownerId ?? ctx.userId
  if (ownerId !== ctx.userId && !(ctx.orgWide || ctx.managedUserIds.includes(ownerId))) throw forbidden('You can set goals for yourself or people you manage.')
  if (input.teamId && !ctx.orgWide && !ctx.managedTeamIds.includes(input.teamId)) throw forbidden('Only the team manager sets team goals.')
  if (input.parentId && !(await prisma.goal.findFirst({ where: { id: input.parentId, orgId: ctx.orgId } }))) throw notFound('Parent goal')
  const { keyResults, ...fields } = input
  const progress = keyResults?.length ? (keyResultProgress(keyResults) ?? 0) : (fields.progress ?? 0)
  const goal = await prisma.goal.create({
    data: { ...fields, ownerId, orgId: ctx.orgId, progress, keyResults: keyResults?.length ? { create: keyResults } : undefined },
    include: goalInclude,
  })
  res.status(201).json({ goal: present(ctx, goal) })
})

async function editable(ctx: Ctx, id: string) {
  const g = await prisma.goal.findFirst({ where: { AND: [goalScope(ctx), { id }] }, include: { keyResults: true } })
  if (!g) throw notFound('Goal')
  if (!canEditGoal(ctx, g)) throw forbidden()
  return g
}

goals.patch('/goals/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const g = await editable(ctx, param(req, 'id'))
  const { note, ...input } = body(req, goalUpdateSchema)
  // With key results the progress is derived and cannot be typed over.
  if (g.keyResults.length) delete input.progress
  const goal = await prisma.goal.update({ where: { id: g.id }, data: input, include: goalInclude })
  if (input.progress !== undefined || input.status || note) {
    await prisma.goalUpdate.create({ data: { goalId: g.id, authorId: ctx.userId, progress: goal.progress, status: goal.status, note: note ?? null } })
  }
  res.json({ goal: present(ctx, goal) })
})

goals.delete('/goals/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const g = await editable(ctx, param(req, 'id'))
  await prisma.goal.update({ where: { id: g.id }, data: { deletedAt: new Date() } })
  res.status(204).end()
})

async function refreshProgress(goalId: string, authorId: string, note?: string) {
  const krs = await prisma.keyResult.findMany({ where: { goalId } })
  const progress = keyResultProgress(krs) ?? 0
  const goal = await prisma.goal.update({ where: { id: goalId }, data: { progress } })
  await prisma.goalUpdate.create({ data: { goalId, authorId, progress, status: goal.status, note: note ?? null } })
}

goals.post('/goals/:id/key-results', async (req, res) => {
  const ctx = ctxOf(req)
  const g = await editable(ctx, param(req, 'id'))
  const kr = await prisma.keyResult.create({ data: { ...body(req, keyResultSchema), goalId: g.id } })
  await refreshProgress(g.id, ctx.userId, `Added key result: ${kr.title}`)
  res.status(201).json({ keyResult: kr })
})

goals.patch('/key-results/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const kr = await prisma.keyResult.findUnique({ where: { id: param(req, 'id') } })
  if (!kr) throw notFound('Key result')
  await editable(ctx, kr.goalId)
  const input = body(req, keyResultUpdateSchema)
  const updated = await prisma.keyResult.update({ where: { id: kr.id }, data: { current: input.current } })
  await refreshProgress(kr.goalId, ctx.userId, input.note ?? `${kr.title}: ${kr.current} → ${input.current}`)
  res.json({ keyResult: updated })
})

goals.delete('/key-results/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const kr = await prisma.keyResult.findUnique({ where: { id: param(req, 'id') } })
  if (!kr) throw notFound('Key result')
  await editable(ctx, kr.goalId)
  await prisma.keyResult.delete({ where: { id: kr.id } })
  await refreshProgress(kr.goalId, ctx.userId, `Removed key result: ${kr.title}`)
  res.status(204).end()
})

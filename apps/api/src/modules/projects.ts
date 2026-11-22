import { Router } from 'express'
import { projectSchema, projectUpdateSchema } from '@workpulse/shared'
import { prisma } from '../lib/prisma.js'
import { body, param } from '../lib/validate.js'
import { forbidden, notFound } from '../lib/errors.js'
import { assertManager, projectScope, taskScope, type Ctx } from '../lib/scope.js'
import { audit } from '../lib/audit.js'
import { ctxOf } from '../middleware/auth.js'

export const projects = Router()

const canEditProject = (ctx: Ctx, p: { ownerId: string; teamId: string | null }) =>
  ctx.orgWide || p.ownerId === ctx.userId || Boolean(p.teamId && ctx.managedTeamIds.includes(p.teamId))

/** Progress = completed share of planned impact weight (not task count), with the count shown separately. */
const IMPACT_WEIGHT = { NONE: 1, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 5 } as const

projects.get('/projects', async (req, res) => {
  const ctx = ctxOf(req)
  const list = await prisma.project.findMany({
    where: projectScope(ctx),
    include: { owner: { select: { id: true, name: true } }, team: { select: { id: true, name: true } } },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  })
  const stats = await prisma.task.groupBy({
    by: ['projectId', 'status', 'impactLevel'],
    where: { AND: [taskScope(ctx), { projectId: { in: list.map((p) => p.id) }, parentId: null, archivedAt: null }] },
    _count: true,
  })
  const now = Date.now()
  res.json({
    projects: list.map((p) => {
      const rows = stats.filter((s) => s.projectId === p.id && s.status !== 'CANCELLED')
      const total = rows.reduce((a, r) => a + r._count * IMPACT_WEIGHT[r.impactLevel], 0)
      const done = rows.filter((r) => r.status === 'COMPLETED').reduce((a, r) => a + r._count * IMPACT_WEIGHT[r.impactLevel], 0)
      const count = rows.reduce((a, r) => a + r._count, 0)
      return {
        ...p,
        taskCount: count,
        completedCount: rows.filter((r) => r.status === 'COMPLETED').reduce((a, r) => a + r._count, 0),
        blockedCount: rows.filter((r) => r.status === 'BLOCKED').reduce((a, r) => a + r._count, 0),
        progress: total ? Math.round((done / total) * 100) : 0,
        overdue: Boolean(p.targetDate && p.targetDate.getTime() < now && p.status !== 'COMPLETED'),
        canEdit: canEditProject(ctx, p),
      }
    }),
  })
})

projects.get('/projects/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const p = await prisma.project.findFirst({
    where: { ...projectScope(ctx), id: param(req, 'id') },
    include: { owner: { select: { id: true, name: true } }, team: { select: { id: true, name: true } } },
  })
  if (!p) throw notFound('Project')
  res.json({ project: { ...p, canEdit: canEditProject(ctx, p) } })
})

projects.post('/projects', async (req, res) => {
  const ctx = ctxOf(req)
  assertManager(ctx)
  const input = body(req, projectSchema)
  if (input.teamId && !ctx.orgWide && !ctx.managedTeamIds.includes(input.teamId)) throw forbidden('Choose one of the teams you manage.')
  if (input.teamId && !(await prisma.team.findFirst({ where: { id: input.teamId, orgId: ctx.orgId } }))) throw notFound('Team')
  if (input.ownerId && !(await prisma.organizationMember.findFirst({ where: { orgId: ctx.orgId, userId: input.ownerId, status: 'ACTIVE' } })))
    throw notFound('Owner')
  const project = await prisma.project.create({ data: { ...input, orgId: ctx.orgId, ownerId: input.ownerId ?? ctx.userId } })
  await audit(req, ctx.orgId, 'project.create', { type: 'Project', id: project.id }, { name: project.name })
  res.status(201).json({ project })
})

projects.patch('/projects/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const p = await prisma.project.findFirst({ where: { ...projectScope(ctx), id: param(req, 'id') } })
  if (!p) throw notFound('Project')
  if (!canEditProject(ctx, p)) throw forbidden()
  const input = body(req, projectUpdateSchema)
  if (input.teamId && !(await prisma.team.findFirst({ where: { id: input.teamId, orgId: ctx.orgId } }))) throw notFound('Team')
  const project = await prisma.project.update({ where: { id: p.id }, data: input })
  res.json({ project })
})

projects.delete('/projects/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const p = await prisma.project.findFirst({ where: { ...projectScope(ctx), id: param(req, 'id') } })
  if (!p) throw notFound('Project')
  if (!canEditProject(ctx, p)) throw forbidden()
  await prisma.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } })
  await audit(req, ctx.orgId, 'project.delete', { type: 'Project', id: p.id })
  res.status(204).end()
})

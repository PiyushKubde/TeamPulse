// Feedback, self-assessment, correction requests, scoring models, notifications and the caller's profile.
import { Router } from 'express'
import { z } from 'zod'
import { correctionSchema, feedbackAckSchema, feedbackSchema, resolveCorrectionSchema, scoringModelSchema } from '@workpulse/shared'
import { prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { assertAdmin, assertCanSeeUser, canManageUser, findVisibleTask, type Ctx } from '../lib/scope.js'
import { audit } from '../lib/audit.js'
import { isValidTz } from '../lib/dates.js'
import { ctxOf, userOf } from '../middleware/auth.js'
import { notify } from '../services/notify.js'

export const people = Router()

// ───────────── Feedback ─────────────

/** Who may write which kind of feedback about whom. */
function assertCanGiveFeedback(ctx: Ctx, kind: string, subjectUserId: string) {
  if (kind === 'SELF') {
    if (subjectUserId !== ctx.userId) throw forbidden('A self-assessment is about yourself.')
    return
  }
  if (subjectUserId === ctx.userId) throw badRequest('Use a self-assessment for your own work.')
  if (kind === 'MANAGER' && !canManageUser(ctx, subjectUserId)) throw forbidden('Only their manager or an admin gives manager feedback.')
  if (kind === 'MENTOR' && !ctx.menteeIds.includes(subjectUserId)) throw forbidden('Only an assigned mentor gives mentor feedback.')
  if (kind === 'PEER') assertCanSeeUser(ctx, subjectUserId)
}

people.get('/feedback', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, z.object({ userId: z.string().uuid().optional() }))
  const subject = q.userId ?? ctx.userId
  assertCanSeeUser(ctx, subject)
  const rows = await prisma.feedback.findMany({ where: { orgId: ctx.orgId, subjectUserId: subject }, orderBy: { createdAt: 'desc' }, take: 100 })
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.authorId) } }, select: { id: true, name: true } })
  const names = new Map(users.map((u) => [u.id, u.name]))
  res.json({
    feedback: rows.map((r) => ({
      ...r,
      authorName: names.get(r.authorId) ?? null,
      canAcknowledge: r.subjectUserId === ctx.userId && !r.acknowledgedAt && r.kind !== 'SELF',
    })),
  })
})

/** Feedback given by the caller (manager/mentor review history). */
people.get('/feedback/given', async (req, res) => {
  const ctx = ctxOf(req)
  const rows = await prisma.feedback.findMany({
    where: { orgId: ctx.orgId, authorId: ctx.userId, kind: { not: 'SELF' } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.subjectUserId) } }, select: { id: true, name: true } })
  const names = new Map(users.map((u) => [u.id, u.name]))
  res.json({ feedback: rows.map((r) => ({ ...r, subjectName: names.get(r.subjectUserId) ?? null })) })
})

people.post('/feedback', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, feedbackSchema)
  assertCanGiveFeedback(ctx, input.kind, input.subjectUserId)
  if (input.taskId) await findVisibleTask(ctx, input.taskId)
  const row = await prisma.feedback.create({ data: { ...input, orgId: ctx.orgId, authorId: ctx.userId } })
  if (input.kind !== 'SELF') {
    await notify({
      orgId: ctx.orgId,
      userId: input.subjectUserId,
      kind: 'feedback',
      title: `New ${input.kind.toLowerCase()} feedback from ${userOf(req).name}`,
      link: '/reviews',
      dedupeKey: `feedback:${row.id}`,
    })
  }
  await audit(req, ctx.orgId, 'feedback.create', { type: 'Feedback', id: row.id }, { kind: input.kind, subjectUserId: input.subjectUserId })
  res.status(201).json({ feedback: row })
})

people.post('/feedback/:id/acknowledge', async (req, res) => {
  const ctx = ctxOf(req)
  const row = await prisma.feedback.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId, subjectUserId: ctx.userId } })
  if (!row) throw notFound('Feedback')
  const { response } = body(req, feedbackAckSchema)
  const updated = await prisma.feedback.update({ where: { id: row.id }, data: { acknowledgedAt: new Date(), response: response ?? null } })
  await notify({
    orgId: ctx.orgId,
    userId: row.authorId,
    kind: 'feedback_ack',
    title: 'Your feedback was acknowledged',
    link: `/members/${row.subjectUserId}`,
    dedupeKey: `feedback-ack:${row.id}`,
  })
  res.json({ feedback: updated })
})

// ───────────── Corrections (disputes) ─────────────

people.get('/corrections', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, z.object({ status: z.enum(['OPEN', 'ACCEPTED', 'REJECTED']).optional(), mine: z.coerce.boolean().optional() }))
  // Requesters see their own; managers see those from people they manage; admins see all.
  const where = {
    orgId: ctx.orgId,
    status: q.status,
    ...(q.mine || (!ctx.orgWide && ctx.role !== 'MANAGER')
      ? { requesterId: ctx.userId }
      : ctx.orgWide
        ? {}
        : { requesterId: { in: [ctx.userId, ...ctx.managedUserIds] } }),
  }
  const rows = await prisma.correctionRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.requesterId) } }, select: { id: true, name: true } })
  const names = new Map(users.map((u) => [u.id, u.name]))
  res.json({
    corrections: rows.map((r) => ({ ...r, requesterName: names.get(r.requesterId), canResolve: r.status === 'OPEN' && canManageUser(ctx, r.requesterId) })),
  })
})

people.post('/corrections', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, correctionSchema)
  // The target must be something about the requester that they can see.
  const ok =
    input.targetType === 'TASK'
      ? Boolean(await findVisibleTask(ctx, input.targetId))
      : input.targetType === 'SNAPSHOT'
        ? Boolean(await prisma.performanceSnapshot.findFirst({ where: { id: input.targetId, orgId: ctx.orgId, subject: `user:${ctx.userId}` } }))
        : input.targetType === 'ASSESSMENT'
          ? Boolean(await prisma.qualityAssessment.findFirst({ where: { id: input.targetId, orgId: ctx.orgId, task: { assigneeId: ctx.userId } } }))
          : input.targetType === 'FEEDBACK'
            ? Boolean(await prisma.feedback.findFirst({ where: { id: input.targetId, orgId: ctx.orgId, subjectUserId: ctx.userId } }))
            : Boolean(await prisma.evidence.findFirst({ where: { id: input.targetId, orgId: ctx.orgId, task: { assigneeId: ctx.userId } } }))
  if (!ok) throw notFound('Record')
  const row = await prisma.correctionRequest.create({ data: { ...input, orgId: ctx.orgId, requesterId: ctx.userId } })
  const managers = await prisma.team.findMany({
    where: { orgId: ctx.orgId, members: { some: { userId: ctx.userId } }, managerId: { not: null } },
    select: { managerId: true },
  })
  for (const m of managers)
    if (m.managerId && m.managerId !== ctx.userId)
      await notify({
        orgId: ctx.orgId,
        userId: m.managerId,
        kind: 'correction',
        title: `${userOf(req).name} asked for a correction`,
        body: input.reason,
        link: '/reviews',
        dedupeKey: `correction:${row.id}:${m.managerId}`,
      })
  await audit(req, ctx.orgId, 'correction.create', { type: 'CorrectionRequest', id: row.id }, input)
  res.status(201).json({ correction: row })
})

people.post('/corrections/:id/resolve', async (req, res) => {
  const ctx = ctxOf(req)
  const row = await prisma.correctionRequest.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId, status: 'OPEN' } })
  if (!row) throw notFound('Correction request')
  if (!canManageUser(ctx, row.requesterId)) throw forbidden()
  const input = body(req, resolveCorrectionSchema)
  const updated = await prisma.correctionRequest.update({
    where: { id: row.id },
    data: { status: input.status, resolution: input.resolution, resolvedById: ctx.userId, resolvedAt: new Date() },
  })
  await notify({
    orgId: ctx.orgId,
    userId: row.requesterId,
    kind: 'correction_resolved',
    title: `Correction request ${input.status.toLowerCase()}`,
    body: input.resolution,
    link: '/reviews',
    dedupeKey: `correction-done:${row.id}`,
  })
  await audit(req, ctx.orgId, 'correction.resolve', { type: 'CorrectionRequest', id: row.id }, input)
  res.json({ correction: updated })
})

// ───────────── Scoring models ─────────────

people.get('/scoring-models', async (req, res) => {
  const ctx = ctxOf(req)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { settings: true } })
  res.json({
    models: await prisma.scoringModel.findMany({ where: { orgId: ctx.orgId }, orderBy: [{ name: 'asc' }, { version: 'desc' }] }),
    impactTargetPerWeek: (org.settings as Record<string, unknown>).impactTargetPerWeek ?? 10,
  })
})

/** Saving a model creates a new version and deactivates the previous one, so old snapshots stay explainable. */
people.post('/scoring-models', async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const input = body(req, scoringModelSchema)
  const latest = await prisma.scoringModel.findFirst({ where: { orgId: ctx.orgId, name: input.name }, orderBy: { version: 'desc' } })
  const model = await prisma.$transaction(async (tx) => {
    await tx.scoringModel.updateMany({ where: { orgId: ctx.orgId, OR: [{ name: input.name }, { role: input.role ?? null }] }, data: { active: false } })
    return tx.scoringModel.create({
      data: {
        orgId: ctx.orgId,
        name: input.name,
        role: input.role ?? null,
        weights: input.weights,
        version: (latest?.version ?? 0) + 1,
        active: true,
        createdBy: ctx.userId,
      },
    })
  })
  await audit(req, ctx.orgId, 'scoring.update', { type: 'ScoringModel', id: model.id }, input)
  res.status(201).json({ model })
})

people.put('/scoring-models/target', async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const { impactTargetPerWeek } = body(req, z.object({ impactTargetPerWeek: z.number().min(1).max(200) }))
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId } })
  await prisma.organization.update({ where: { id: ctx.orgId }, data: { settings: { ...(org.settings as object), impactTargetPerWeek } } })
  await audit(req, ctx.orgId, 'scoring.target', { type: 'Organization', id: ctx.orgId }, { impactTargetPerWeek })
  res.json({ impactTargetPerWeek })
})

// ───────────── Notifications ─────────────

people.get('/notifications', async (req, res) => {
  const ctx = ctxOf(req)
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { orgId: ctx.orgId, userId: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.count({ where: { orgId: ctx.orgId, userId: ctx.userId, readAt: null } }),
  ])
  res.json({ items, unread })
})

people.post('/notifications/read', async (req, res) => {
  const ctx = ctxOf(req)
  const { ids } = body(req, z.object({ ids: z.array(z.string().uuid()).max(200).optional() }))
  await prisma.notification.updateMany({
    where: { orgId: ctx.orgId, userId: ctx.userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  })
  res.json({ ok: true })
})

// ───────────── Profile ─────────────

people.patch('/me', async (req, res) => {
  const user = userOf(req)
  const input = body(
    req,
    z.object({ name: z.string().trim().min(1).max(200).optional(), timezone: z.string().max(60).refine(isValidTz, 'Unknown time zone').optional() }),
  )
  const updated = await prisma.user.update({ where: { id: user.id }, data: input, select: { id: true, name: true, email: true, timezone: true } })
  res.json({ user: updated })
})

people.get('/me/profile', async (req, res) => {
  const user = userOf(req)
  res.json({
    user: await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, name: true, email: true, timezone: true, emailVerifiedAt: true } }),
  })
})

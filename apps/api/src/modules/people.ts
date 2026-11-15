// Feedback, self-assessment, correction requests, scoring models, notifications and the caller's profile.
import { Router } from 'express'
import { z } from 'zod'
import { correctionSchema, feedbackAckSchema, feedbackSchema, resolveCorrectionSchema, scoringModelSchema } from '@workpulse/shared'
import { prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js'
import * as m91 from '../lib/m91.js'
import { MOMENTS, ON_CALL_CONDITIONS, type Moment } from '../services/phone-alerts.js'
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

// ───────────── Phone alerts (M91, the person's own phone) ─────────────

const phoneStatus = async (userId: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true, phoneAlertState: true, alertPrefs: true } })
  const prefs = u.alertPrefs as Record<string, boolean>
  return {
    available: m91.platformConfigured(),
    phone: u.phone,
    state: u.phoneAlertState,
    moments: Object.entries(MOMENTS).map(([key, label]) => ({ key, label, on: prefs[key] !== false })),
    recent: await prisma.phoneAlert.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, title: true, status: true, decision: true, createdAt: true },
    }),
  }
}

const unavailable = () =>
  new HttpError(503, 'phone_alerts_unavailable', 'Phone alerts aren’t set up on this server yet. An administrator needs to add the M91 API key.')
const m91Message = (e: unknown) =>
  e instanceof m91.M91Error
    ? e.status === 0
      ? 'M91 couldn’t be reached. Try again in a minute.'
      : e.message
    : 'M91 couldn’t be reached. Try again in a minute.'

people.get('/me/phone-alerts', async (req, res) => {
  res.json(await phoneStatus(userOf(req).id))
})

/** Saves the number and sends the M91 invitation; the person accepts it in the M91 app. */
people.put('/me/phone', async (req, res) => {
  if (!m91.platformConfigured()) throw unavailable()
  const user = userOf(req)
  const { phone: raw } = body(req, z.object({ phone: z.string().min(6).max(20) }))
  const phone = m91.normalizePhone(raw)
  if (!phone) throw badRequest('Enter your mobile number with the country code, for example +91 98765 43210.')
  let state: string
  try {
    state = (await m91.invite(phone)).state
  } catch (e) {
    throw new HttpError(502, 'm91_invite_failed', `Couldn’t send the M91 invitation: ${m91Message(e)}`)
  }
  await prisma.user.update({ where: { id: user.id }, data: { phone, phoneAlertState: state } })
  res.json(await phoneStatus(user.id))
})

/** Re-reads the invitation (accepted yet?). Inviting again is how M91 reports the current state. */
people.post('/me/phone/refresh', async (req, res) => {
  if (!m91.platformConfigured()) throw unavailable()
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userOf(req).id } })
  if (!user.phone) throw badRequest('Add your number first.')
  try {
    const r = await m91.invite(user.phone)
    await prisma.user.update({ where: { id: user.id }, data: { phoneAlertState: r.state } })
  } catch (e) {
    throw new HttpError(502, 'm91_unreachable', m91Message(e))
  }
  res.json(await phoneStatus(user.id))
})

people.post('/me/phone/test', async (req, res) => {
  if (!m91.platformConfigured()) throw unavailable()
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userOf(req).id } })
  if (!user.phone) throw badRequest('Add your number first.')
  try {
    const r = await m91.personAlert(user.phone, {
      title: 'WorkPulse test: your phone alerts work',
      description: 'This is the kind of alert WorkPulse sends for the moments you chose. Nothing to do.',
      severity: 'LOW',
      customId: `test-${user.id}-${Date.now()}`,
      isAutoClose: true,
      responseOptions: [
        { label: 'It rang', effect: 'SHARED' },
        { label: 'Seen', effect: 'PERSONAL' },
      ],
    })
    if (r.delivered === 0)
      throw new HttpError(409, 'not_reachable', 'Nobody was reached: open the M91 app on your phone and accept the WorkPulse invitation, then try again.')
    res.json({ delivered: r.delivered })
  } catch (e) {
    if (e instanceof HttpError) throw e
    if (e instanceof m91.M91Error && e.status === 409) {
      await prisma.user.update({ where: { id: user.id }, data: { phoneAlertState: 'pending' } })
      throw new HttpError(409, 'not_accepted', 'Your phone hasn’t accepted the WorkPulse invitation yet. Open the M91 app, accept it, then try again.')
    }
    throw new HttpError(502, 'm91_failed', m91Message(e))
  }
})

people.patch('/me/alert-prefs', async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userOf(req).id } })
  const input = body(req, z.partialRecord(z.enum(Object.keys(MOMENTS) as [Moment, ...Moment[]]), z.boolean()))
  await prisma.user.update({ where: { id: user.id }, data: { alertPrefs: { ...(user.alertPrefs as object), ...input } } })
  res.json(await phoneStatus(user.id))
})

people.delete('/me/phone', async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userOf(req).id } })
  if (user.phone && m91.platformConfigured()) await m91.uninvite(user.phone).catch(() => undefined)
  await prisma.user.update({ where: { id: user.id }, data: { phone: null, phoneAlertState: null } })
  res.json(await phoneStatus(user.id))
})

// ───────────── On-call channel (owners and admins) ─────────────

let channelName: { name: string; at: number } | null = null

people.get('/alerts/on-call', async (req, res) => {
  assertAdmin(ctxOf(req))
  const configured = m91.channelConfigured()
  let channel: string | null = null
  let error: string | null = null
  if (configured) {
    // The connection test raises nothing; cached for a minute.
    if (channelName && Date.now() - channelName.at < 60_000) channel = channelName.name
    else
      try {
        channel = (await m91.channelInfo()).channel.name
        channelName = { name: channel, at: Date.now() }
      } catch (e) {
        error = m91Message(e)
      }
  }
  const open = await prisma.phoneAlert.findMany({ where: { userId: null, status: 'OPEN' }, select: { customId: true, createdAt: true } })
  const recent = await prisma.phoneAlert.findMany({
    where: { userId: null },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { id: true, title: true, severity: true, status: true, delivered: true, createdAt: true, closedAt: true },
  })
  res.json({
    configured,
    channel,
    error,
    personalAvailable: m91.platformConfigured(),
    conditions: ON_CALL_CONDITIONS.map((c) => ({ ...c, open: open.find((o) => o.customId === c.customId)?.createdAt ?? null })),
    recent,
  })
})

people.post('/alerts/on-call/test', async (req, res) => {
  assertAdmin(ctxOf(req))
  if (!m91.channelConfigured())
    throw new HttpError(409, 'not_configured', 'No on-call channel yet: add the channel’s send link to the server as M91_SEND_LINK.')
  try {
    const r = await m91.channelAlert({
      title: 'WorkPulse on-call test',
      description: `Sent by ${userOf(req).name} from the Phone alerts page. Nothing is wrong.`,
      severity: 'LOW',
      customId: `workpulse-test-${Date.now()}`,
      isAutoClose: true,
      responseOptions: [
        { label: 'It rang', effect: 'SHARED' },
        { label: 'Seen', effect: 'PERSONAL' },
      ],
    })
    if (r.delivered === 0)
      throw new HttpError(409, 'channel_empty', 'Nobody was reached: add people to the channel in the M91 app, and make sure they accepted the invitation.')
    res.json({ delivered: r.delivered })
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(502, 'm91_failed', m91Message(e))
  }
})

import { Router } from 'express'
import { z } from 'zod'
import {
  connectSchema,
  connectionSettingsSchema,
  mappingDecisionSchema,
  optionsQuerySchema,
  resolveConflictSchema,
  PRIORITIES,
  TASK_STATUSES,
} from '@workpulse/shared'
import { prisma, type IntegrationConnection, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { assertAdmin, findEditableTask } from '../lib/scope.js'
import { audit } from '../lib/audit.js'
import { decrypt } from '../lib/crypto.js'
import { env, viasocketConfigured } from '../config/env.js'
import { ctxOf } from '../middleware/auth.js'
import { enqueue } from '../jobs/queues.js'
import { PROVIDERS, provider, type ConnectionSettings } from '../integrations/catalog.js'
import {
  connectSetup,
  disconnect,
  ownConnection,
  pickerOptions,
  plannedSubscriptions,
  refreshConnectionHealth,
  saveConnection,
  syncSubscriptions,
} from '../integrations/connections.js'
import { ensureFlow, runFlow } from '../integrations/flows.js'
import { automationToken, runHistory } from '../integrations/viasocket/automations.js'

export const integrations = Router()

/** What the browser may see of a connection: never auth_id or script_ids. */
const presentConnection = (
  c: IntegrationConnection & {
    subscriptions?: { id: string; triggerKey: string; resource: string; status: string; lastEventAt: Date | null; createdAt: Date }[]
  },
) => ({
  id: c.id,
  provider: c.provider,
  label: c.label,
  status: c.status,
  syncMode: c.syncMode,
  settings: c.settings,
  lastError: c.lastError,
  lastSyncAt: c.lastSyncAt,
  createdAt: c.createdAt,
  subscriptions: c.subscriptions?.map((s) => ({
    id: s.id,
    triggerKey: s.triggerKey,
    resource: s.resource,
    status: s.status,
    lastEventAt: s.lastEventAt,
    createdAt: s.createdAt,
  })),
})

integrations.get('/integrations', async (req, res) => {
  const ctx = ctxOf(req)
  if (viasocketConfigured) await refreshConnectionHealth(ctx.userId).catch(() => undefined)
  const mine = await prisma.integrationConnection.findMany({
    where: { userId: ctx.userId, orgId: ctx.orgId, status: { not: 'REVOKED' } },
    include: { subscriptions: true },
    orderBy: { createdAt: 'asc' },
  })
  res.json({
    configured: viasocketConfigured,
    liveSyncAvailable: Boolean(env.PUBLIC_API_URL),
    providers: Object.values(PROVIDERS).map((p) => ({
      slug: p.slug,
      name: p.name,
      icon: p.icon,
      description: p.description,
      capabilities: p.capabilities,
      supportsTwoWay: p.supportsTwoWay,
      pickers: p.pickers.map((x) => ({ setting: x.setting, label: x.label, fieldKey: x.fieldKey })),
      verifiedLiveAt: p.verifiedLiveAt,
      connections: mine.filter((c) => c.provider === p.slug).map(presentConnection),
    })),
  })
})

integrations.post('/integrations/connect-setup', async (req, res) => {
  const ctx = ctxOf(req)
  const { provider: slug } = body(req, z.object({ provider: z.string().max(50) }))
  // The embed token is the one viaSocket value a browser may hold: it is signed for this user only.
  res.json(await connectSetup(ctx.userId, slug))
})

integrations.post('/integrations/connect', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, connectSchema)
  const conn = await saveConnection(ctx.orgId, ctx.userId, input.provider, input.authId)
  await audit(req, ctx.orgId, 'integration.connect', { type: 'IntegrationConnection', id: conn.id }, { provider: input.provider })
  res.status(201).json({ connection: presentConnection(conn) })
})

integrations.get('/integrations/connections', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, z.object({ scope: z.enum(['mine', 'org']).default('mine') }))
  if (q.scope === 'org') {
    assertAdmin(ctx)
    const rows = await prisma.integrationConnection.findMany({
      where: { orgId: ctx.orgId },
      include: { user: { select: { id: true, name: true } }, subscriptions: true },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ connections: rows.map((c) => ({ ...presentConnection(c), user: c.user })) })
  }
  const rows = await prisma.integrationConnection.findMany({
    where: { orgId: ctx.orgId, userId: ctx.userId },
    include: { subscriptions: true },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ connections: rows.map(presentConnection) })
})

integrations.get('/integrations/connections/:id/options', async (req, res) => {
  const ctx = ctxOf(req)
  const conn = await ownConnection(ctx.userId, ctx.orgId, param(req, 'id'))
  const q = query(req, optionsQuerySchema)
  const result = await pickerOptions(conn, q.fieldKey, q.search, q.paginate)
  res.json({
    options: result.options,
    hasMore: result.hasMore,
    paginate: result.paginate == null ? null : JSON.stringify(result.paginate),
    message: result.message ?? null,
  })
})

/** Save the once-after-Connect choices, then bring subscriptions/flows in line with them. */
integrations.patch('/integrations/connections/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const conn = await ownConnection(ctx.userId, ctx.orgId, param(req, 'id'))
  const def = provider(conn.provider)!
  const input = body(req, connectionSettingsSchema)
  const { syncMode, ...rest } = input
  if (syncMode === 'TWO_WAY' && !def.supportsTwoWay) throw badRequest(`${def.name} supports import-only and one-way sync.`)
  const settings = { ...(conn.settings as ConnectionSettings), ...rest }
  if (syncMode === 'TWO_WAY' && !Object.keys(settings.statusMap ?? {}).length)
    throw badRequest('Map WorkPulse statuses to Linear statuses before turning on two-way sync.')
  if (settings.userMap) {
    const ids = Object.values(settings.userMap)
    const n = await prisma.organizationMember.count({ where: { orgId: ctx.orgId, userId: { in: ids }, status: 'ACTIVE' } })
    if (n !== new Set(ids).size) throw badRequest('Every mapped person must be an active member.')
  }
  const updated = await prisma.integrationConnection.update({
    where: { id: conn.id },
    data: { settings: settings as Prisma.InputJsonValue, syncMode: syncMode ?? conn.syncMode },
  })
  let subscriptions: unknown = []
  let warning: string | null = null
  try {
    if (def.capabilities.includes('tasks') || def.capabilities.includes('evidence')) subscriptions = await syncSubscriptions(updated)
    if (conn.provider === 'slack' && settings.delivery) await ensureFlow(updated, 'slack_delivery', { resave: true })
    if (conn.provider === 'linear' && updated.syncMode === 'TWO_WAY') await ensureFlow(updated, 'linear_status', { resave: true })
  } catch (e) {
    warning = e instanceof Error ? e.message : 'Could not apply the change at viaSocket.'
  }
  await audit(req, ctx.orgId, 'integration.configure', { type: 'IntegrationConnection', id: conn.id }, {
    syncMode: updated.syncMode,
    ...rest,
  } as Prisma.InputJsonValue)
  const fresh = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id }, include: { subscriptions: true } })
  res.json({ connection: presentConnection(fresh), subscriptions, warning, planned: plannedSubscriptions(def, settings, fresh.syncMode).length })
})

integrations.post('/integrations/connections/:id/backfill', async (req, res) => {
  const ctx = ctxOf(req)
  const conn = await ownConnection(ctx.userId, ctx.orgId, param(req, 'id'))
  if (!['linear', 'jira-software-cloud'].includes(conn.provider)) throw badRequest('Import is available for Linear and Jira.')
  await enqueue('ingest', 'backfill', { connectionId: conn.id }, { jobId: `backfill:${conn.id}:${Math.floor(Date.now() / 60000)}` })
  res.status(202).json({ queued: true })
})

integrations.post('/integrations/connections/:id/test-delivery', async (req, res) => {
  const ctx = ctxOf(req)
  const conn = await ownConnection(ctx.userId, ctx.orgId, param(req, 'id'))
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { email: true, name: true } })
  const text = `WorkPulse test message for ${user.name}. Reports will arrive here.`
  if (conn.provider === 'slack') await runFlow(conn, 'slack_delivery', { text })
  else if (conn.provider === 'gmail') await runFlow(conn, 'gmail_delivery', { subject: 'WorkPulse test message', text }, { email: user.email })
  else throw badRequest('Only Slack and Gmail deliver messages.')
  res.json({ ok: true })
})

integrations.post('/integrations/disconnect', async (req, res) => {
  const ctx = ctxOf(req)
  const { connectionId } = body(req, z.object({ connectionId: z.string().uuid() }))
  const conn = await ownConnection(ctx.userId, ctx.orgId, connectionId)
  await disconnect(conn)
  await audit(req, ctx.orgId, 'integration.disconnect', { type: 'IntegrationConnection', id: conn.id }, { provider: conn.provider })
  res.json({ ok: true })
})

// ───────────── Sync history, retry ─────────────

integrations.get('/integrations/sync-history', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(
    req,
    z.object({
      status: z.enum(['RECEIVED', 'PROCESSING', 'PROCESSED', 'SKIPPED_STALE', 'SKIPPED_DUPLICATE', 'NEEDS_MAPPING', 'FAILED', 'DEAD']).optional(),
      provider: z.string().max(50).optional(),
      connectionId: z.string().uuid().optional(),
      all: z.coerce.boolean().optional(),
      page: z.coerce.number().int().min(1).default(1),
    }),
  )
  const myConnIds = (await prisma.integrationConnection.findMany({ where: { orgId: ctx.orgId, userId: ctx.userId }, select: { id: true } })).map((c) => c.id)
  const where: Prisma.SyncEventWhereInput = {
    AND: [
      q.all && ctx.orgWide ? { orgId: ctx.orgId } : { orgId: ctx.orgId, connectionId: { in: myConnIds } },
      { status: q.status, provider: q.provider, connectionId: q.connectionId },
    ],
  }
  const [items, total, counts] = await Promise.all([
    prisma.syncEvent.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: 50,
      skip: (q.page - 1) * 50,
      select: {
        id: true,
        provider: true,
        eventType: true,
        status: true,
        attempts: true,
        error: true,
        taskId: true,
        receivedAt: true,
        processedAt: true,
        subscription: { select: { triggerKey: true, resource: true } },
      },
    }),
    prisma.syncEvent.count({ where }),
    prisma.syncEvent.groupBy({ by: ['status'], where, _count: true }),
  ])
  res.json({ items, page: q.page, pageSize: 50, total, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) })
})

integrations.get('/integrations/sync-history/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const e = await prisma.syncEvent.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId }, include: { subscription: true } })
  const owner = e?.connectionId ? (await prisma.integrationConnection.findUnique({ where: { id: e.connectionId }, select: { userId: true } }))?.userId : null
  if (!e || (!ctx.orgWide && owner !== ctx.userId)) throw notFound('Event')
  res.json({ event: { ...e, subscription: e.subscription && { triggerKey: e.subscription.triggerKey, resource: e.subscription.resource } } })
})

integrations.post('/integrations/retry', async (req, res) => {
  const ctx = ctxOf(req)
  const { eventId } = body(req, z.object({ eventId: z.string().uuid() }))
  const e = await prisma.syncEvent.findFirst({ where: { id: eventId, orgId: ctx.orgId } })
  const owner = e?.connectionId ? (await prisma.integrationConnection.findUnique({ where: { id: e.connectionId }, select: { userId: true } }))?.userId : null
  if (!e || (!ctx.orgWide && owner !== ctx.userId)) throw notFound('Event')
  if (!['FAILED', 'DEAD', 'NEEDS_MAPPING'].includes(e.status)) throw conflict('Only failed events or events waiting for a mapping can be retried.')
  if (!e.subscriptionId) throw badRequest('Run the import again from the connection instead.')
  await prisma.syncEvent.update({ where: { id: e.id }, data: { status: 'RECEIVED', attempts: 0, error: null } })
  await enqueue('ingest', 'event', { eventId: e.id }, { jobId: `${e.id}:retry:${Date.now()}` })
  res.json({ ok: true })
})

// ───────────── Mappings ─────────────

integrations.get('/integrations/mappings', async (req, res) => {
  const ctx = ctxOf(req)
  const rows = await prisma.syncMapping.findMany({ where: { orgId: ctx.orgId }, orderBy: [{ active: 'asc' }, { provider: 'asc' }, { fromValue: 'asc' }] })
  res.json({ mappings: rows, canDecide: ctx.orgWide || ctx.role === 'MANAGER' })
})

/** A person approves (optionally changing the value) or rejects a mapping. Approving re-runs the events waiting for it. */
integrations.post('/integrations/mappings/:id/decision', async (req, res) => {
  const ctx = ctxOf(req)
  if (!ctx.orgWide && ctx.role !== 'MANAGER') throw forbidden()
  const m = await prisma.syncMapping.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId } })
  if (!m) throw notFound('Mapping')
  const input = body(req, mappingDecisionSchema)
  const allowed: readonly string[] = m.kind === 'STATUS' ? TASK_STATUSES : PRIORITIES
  const toValue = input.toValue ?? m.toValue
  if (!allowed.includes(toValue)) throw badRequest(`Choose one of: ${allowed.join(', ')}`)
  const updated = await prisma.syncMapping.update({
    where: { id: m.id },
    data: input.approve
      ? { active: true, toValue, source: input.toValue && input.toValue !== m.toValue ? 'USER' : m.source, approvedById: ctx.userId, approvedAt: new Date() }
      : { active: false, approvedAt: new Date(), approvedById: ctx.userId },
  })
  let reprocessed = 0
  if (input.approve) {
    const waiting = await prisma.syncEvent.findMany({
      where: { orgId: ctx.orgId, provider: m.provider, status: 'NEEDS_MAPPING', subscriptionId: { not: null } },
      select: { id: true },
    })
    for (const w of waiting) {
      // Reprocess as a new delivery of the same payload: clear the stored source timestamp guard for that task first.
      const ev = await prisma.syncEvent.update({ where: { id: w.id }, data: { status: 'RECEIVED', error: null } })
      if (ev.taskId) await prisma.taskSource.updateMany({ where: { taskId: ev.taskId }, data: { externalUpdatedAt: null } })
      await enqueue('ingest', 'event', { eventId: w.id }, { jobId: `${w.id}:remap:${Date.now()}` })
      reprocessed++
    }
  }
  await audit(req, ctx.orgId, 'mapping.decide', { type: 'SyncMapping', id: m.id }, { approve: input.approve, toValue })
  res.json({ mapping: updated, reprocessed })
})

// ───────────── Conflicts (two-way) ─────────────

integrations.get('/integrations/conflicts', async (req, res) => {
  const ctx = ctxOf(req)
  const rows = await prisma.syncConflict.findMany({
    where: {
      resolvedAt: null,
      task: {
        orgId: ctx.orgId,
        deletedAt: null,
        ...(ctx.orgWide ? {} : { OR: [{ assigneeId: ctx.userId }, { source: { connection: { userId: ctx.userId } } }] }),
      },
    },
    include: { task: { select: { id: true, title: true, source: { select: { provider: true, externalKey: true } } } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ conflicts: rows })
})

integrations.post('/integrations/conflicts/:id/resolve', async (req, res) => {
  const ctx = ctxOf(req)
  const c = await prisma.syncConflict.findUnique({ where: { id: param(req, 'id') } })
  if (!c || c.resolvedAt) throw notFound('Conflict')
  const task = await findEditableTask(ctx, c.taskId)
  const { keep } = body(req, resolveConflictSchema)
  const raw = JSON.parse(keep === 'internal' ? (c.internalValue ?? 'null') : (c.externalValue ?? 'null'))
  const value = c.field === 'dueAt' && raw ? new Date(raw) : raw
  await prisma.$transaction(async (tx) => {
    if (keep === 'external') await tx.task.update({ where: { id: task.id }, data: { [c.field]: value } })
    // Either way the chosen value becomes the agreed baseline for the next comparison.
    const src = await tx.taskSource.findUnique({ where: { taskId: task.id } })
    if (src) await tx.taskSource.update({ where: { id: src.id }, data: { lastExternal: { ...(src.lastExternal as object), [c.field]: raw } } })
    await tx.syncConflict.update({ where: { id: c.id }, data: { resolution: keep, resolvedById: ctx.userId, resolvedAt: new Date() } })
    await tx.taskActivity.create({
      data: { taskId: task.id, kind: 'conflict_resolved', actorType: 'USER', actorId: ctx.userId, field: c.field, toValue: keep },
    })
  })
  if (keep === 'internal' && c.field === 'status') await enqueue('ingest', 'outbound', { taskId: task.id, status: task.status })
  res.json({ ok: true })
})

// ───────────── Automation Center ─────────────

integrations.get('/automations', async (req, res) => {
  const ctx = ctxOf(req)
  const conns = await prisma.integrationConnection.findMany({
    where: { orgId: ctx.orgId, userId: ctx.userId, status: { not: 'REVOKED' } },
    include: { subscriptions: true },
  })
  const executions = await prisma.automationExecution.findMany({
    where: { orgId: ctx.orgId, OR: [{ userId: ctx.userId }, ...(ctx.orgWide ? [{ userId: null }] : [])] },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  })
  const eventStats = await prisma.syncEvent.groupBy({
    by: ['subscriptionId', 'status'],
    where: { subscriptionId: { in: conns.flatMap((c) => c.subscriptions.map((s) => s.id)) } },
    _count: true,
  })
  const prefs = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } } })
  res.json({
    workflows: conns.flatMap((c) =>
      c.subscriptions.map((s) => ({
        id: s.id,
        provider: c.provider,
        connectionId: c.id,
        kind: s.triggerKey.startsWith('flow:') ? 'action_flow' : 'event_subscription',
        name: s.triggerKey.startsWith('flow:')
          ? s.triggerKey.slice(5).replace('_', ' ')
          : `${s.triggerKey.replace(/_/g, ' ')}${s.resource ? ` · ${s.resource}` : ''}`,
        status: s.status,
        lastEventAt: s.lastEventAt,
        createdAt: s.createdAt,
        events: Object.fromEntries(eventStats.filter((e) => e.subscriptionId === s.id).map((e) => [e.status, e._count])),
      })),
    ),
    executions,
    scheduled: SCHEDULED_AUTOMATIONS,
    role: prefs?.role,
  })
})

/** Runs of one of the caller's own flows, from viaSocket (fields shown to users only, per the docs). */
integrations.get('/automations/:id/runs', async (req, res) => {
  const ctx = ctxOf(req)
  const s = await prisma.integrationSubscription.findFirst({ where: { id: param(req, 'id'), connection: { userId: ctx.userId, orgId: ctx.orgId } } })
  if (!s?.scriptIdEnc) throw notFound('Workflow')
  const token = await automationToken(ctx.userId)
  const rows = await runHistory(token, decrypt(s.scriptIdEnc))
  // Only the documented, user-facing fields; requestSnapshot (request headers) never leaves the server.
  res.json({
    runs: rows.map((r) => ({
      status: r.status ?? (r.stepOrderJsonData && JSON.stringify(r.stepOrderJsonData).includes('"400"') ? 'failed' : 'success'),
      createdAt: r.createdAt ?? r.requestTimestamp ?? null,
      console: r.console ?? null,
      steps: r.stepOrderJsonData ?? null,
      output: typeof r.output === 'string' ? r.output.slice(0, 2000) : null,
      flowHitId: r.flowHitId ?? r._id ?? null,
    })),
  })
})

export const SCHEDULED_AUTOMATIONS = [
  { key: 'morning_planning', name: 'Morning planning reminder', schedule: 'Weekdays 09:00 (your time zone)', channel: 'In-app, Slack if connected' },
  { key: 'deadline_reminders', name: 'Deadline reminders', schedule: 'Hourly', channel: 'In-app' },
  { key: 'overdue_scan', name: 'Overdue tasks', schedule: 'Hourly', channel: 'In-app' },
  { key: 'blocker_escalation', name: 'Blocker escalation (blocked > 48h)', schedule: 'Hourly', channel: 'In-app to managers, Slack if connected' },
  { key: 'daily_review', name: 'Daily review reminder', schedule: 'Weekdays 17:30 (your time zone)', channel: 'In-app' },
  { key: 'daily_report', name: 'Daily report', schedule: 'Weekdays 18:00 (your time zone)', channel: 'Slack if connected' },
  { key: 'weekly_report', name: 'Weekly report', schedule: 'Mondays 08:00 UTC', channel: 'In-app; Slack/email if connected' },
  { key: 'goal_recalc', name: 'Goal progress and performance snapshots', schedule: 'Nightly 02:00 UTC', channel: '—' },
] as const

// Phone alerts through M91.
//  • On-call: named conditions checked every minute in the API process → the on-call channel (send link).
//  • People: chosen moments → that person's own phone (API key), answered with buttons that KONVO acts on.
// Every alert has two answers and a customId naming the condition; it is closed when the condition clears, which
// re-arms it. Nothing here is wired into a generic error handler: only the conditions below ring anybody.
import { prisma } from '../lib/prisma.js'
import { logger } from '../config/logger.js'
import { env, isTest } from '../config/env.js'
import { redis, queue } from '../jobs/queues.js'
import * as m91 from '../lib/m91.js'
import { notify } from './notify.js'
import { chooseAssignee, recordAssignment } from './assignment.js'

// ───────────── Shared failure counters (API and worker both write them) ─────────────

export type Counter = 'ai' | 'email' | 'delivery'
export async function recordFailure(name: Counter) {
  if (isTest) return
  await redis()
    .incr(`wp:fail:${name}`)
    .catch(() => undefined)
}
export async function recordSuccess(name: Counter) {
  if (isTest) return
  await redis()
    .del(`wp:fail:${name}`)
    .catch(() => undefined)
}
/** Server errors per minute bucket, kept 10 minutes. Counting only; the monitor decides. */
export async function recordServerError() {
  if (isTest) return
  const k = `wp:5xx:${Math.floor(Date.now() / 60000)}`
  await redis()
    .multi()
    .incr(k)
    .expire(k, 600)
    .exec()
    .catch(() => undefined)
}
export async function heartbeat(name: 'worker' | 'hourly') {
  if (isTest) return
  await redis()
    .set(`wp:beat:${name}`, String(Date.now()))
    .catch(() => undefined)
}

// ───────────── On-call channel ─────────────

const OPS_ANSWERS: m91.ResponseOption[] = [
  { label: 'I’ll handle it', effect: 'SHARED' },
  { label: 'Seen', effect: 'PERSONAL' },
]

// Open on-call alerts are tracked in memory (loaded from the database once) so the checks still work while the
// database itself is the thing that is down. Database writes are best effort.
let openOps: Set<string> | null = null
async function opsState() {
  if (!openOps) {
    openOps = new Set(
      (await prisma.phoneAlert.findMany({ where: { userId: null, status: 'OPEN' }, select: { customId: true } }).catch(() => [])).map((a) => a.customId),
    )
  }
  return openOps
}

async function raiseOps(customId: string, severity: m91.AlertPayload['severity'], title: string, description: string) {
  const state = await opsState()
  if (state.has(customId)) return
  try {
    const r = await m91.channelAlert({ title, description, severity, customId, responseOptions: OPS_ANSWERS })
    state.add(customId)
    await prisma.phoneAlert.create({ data: { kind: 'ops', customId, severity, title, m91Id: r._id, delivered: r.delivered } }).catch(() => undefined)
    logger.warn({ customId, delivered: r.delivered }, 'on-call alert raised')
  } catch (e) {
    logger.error({ customId, err: e instanceof Error ? e.message : e }, 'could not raise on-call alert')
  }
}

async function clearOps(customId: string) {
  const state = await opsState()
  if (!state.has(customId)) return
  try {
    await m91.channelClose(customId)
  } catch (e) {
    // Already closed in the app (or never existed there): nothing left to close.
    if (!(e instanceof m91.M91Error && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN'))) {
      logger.error({ customId, err: e instanceof Error ? e.message : e }, 'could not close on-call alert')
      return
    }
  }
  state.delete(customId)
  await prisma.phoneAlert
    .updateMany({ where: { customId, userId: null, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } })
    .catch(() => undefined)
  logger.info({ customId }, 'on-call alert closed: condition cleared')
}

const set = (cond: boolean, customId: string, sev: m91.AlertPayload['severity'], title: string, desc: string) =>
  cond ? raiseOps(customId, sev, title, desc) : clearOps(customId)

/** What the on-call channel watches. Shown on the Phone alerts page; customIds match checkOps() below. */
export const ON_CALL_CONDITIONS = [
  { customId: 'workpulse-database-down', label: 'Database unreachable for 3 minutes', severity: 'CRITICAL' },
  { customId: 'workpulse-redis-down', label: 'Redis unreachable for 3 minutes', severity: 'CRITICAL' },
  { customId: 'workpulse-worker-stalled', label: 'Background worker stopped (imports, reminders, reports)', severity: 'HIGH' },
  { customId: 'workpulse-ingest-backlog', label: 'Over 200 app events waiting for 10 minutes', severity: 'HIGH' },
  { customId: 'workpulse-sync-dead-linear', label: 'Linear sync failing for good (3+ in an hour)', severity: 'HIGH' },
  { customId: 'workpulse-sync-dead-jira-software-cloud', label: 'Jira sync failing for good (3+ in an hour)', severity: 'HIGH' },
  { customId: 'workpulse-sync-dead-github', label: 'GitHub sync failing for good (3+ in an hour)', severity: 'HIGH' },
  { customId: 'workpulse-sync-dead-slack', label: 'Slack sync failing for good (3+ in an hour)', severity: 'HIGH' },
  { customId: 'workpulse-api-errors', label: 'Over 20 server errors in 5 minutes', severity: 'HIGH' },
  { customId: 'workpulse-email-failing', label: 'Email failing 3 times in a row', severity: 'HIGH' },
  { customId: 'workpulse-ai-failing', label: 'AI failing 5 times in a row', severity: 'MEDIUM' },
  { customId: 'workpulse-delivery-failing', label: 'Slack/Gmail delivery failing 5 times in a row', severity: 'MEDIUM' },
] as const

const streak = { db: 0, redis: 0, backlog: 0 }
const startedAt = Date.now()

/** One pass of every on-call condition. Runs every minute in the API process. */
export async function checkOps() {
  if (!m91.channelConfigured()) return
  // 1. Database and Redis reachability (3 checks in a row ≈ 3 minutes).
  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false)
  streak.db = dbOk ? 0 : streak.db + 1
  const redisOk = await redis()
    .ping()
    .then(() => true)
    .catch(() => false)
  streak.redis = redisOk ? 0 : streak.redis + 1
  await set(
    streak.db >= 3,
    'workpulse-database-down',
    'CRITICAL',
    'KONVO database unreachable',
    `The API has not reached PostgreSQL for ${streak.db} checks in a row. Every page and sync is failing.`,
  )
  await set(
    streak.redis >= 3,
    'workpulse-redis-down',
    'CRITICAL',
    'KONVO Redis unreachable',
    `The API has not reached Redis for ${streak.redis} checks in a row. Background jobs, imports and reminders are stopped.`,
  )
  if (!dbOk || !redisOk) return

  // 2. Worker alive and running its hourly job.
  const beat = Number(await redis().get('wp:beat:worker')) || 0
  const hourly = Number(await redis().get('wp:beat:hourly')) || 0
  const up = Date.now() - startedAt > 10 * 60000
  const workerDown = up && Date.now() - beat > 10 * 60000
  const hourlyLate = up && hourly > 0 && Date.now() - hourly > 2 * 36e5
  await set(
    workerDown || hourlyLate,
    'workpulse-worker-stalled',
    'HIGH',
    'KONVO background worker stopped',
    workerDown
      ? 'No heartbeat from the worker for over 10 minutes: imports, reminders and reports are not running.'
      : 'The hourly job has not run for over 2 hours: reminders, escalations and daily reports are not going out.',
  )

  // 3. Ingestion backlog (over 200 waiting for 10 checks).
  const waiting = await queue('ingest')
    .getWaitingCount()
    .catch(() => 0)
  streak.backlog = waiting > 200 ? streak.backlog + 1 : 0
  await set(
    streak.backlog >= 10,
    'workpulse-ingest-backlog',
    'HIGH',
    'KONVO sync backlog growing',
    `${waiting} app events have been waiting for over 10 minutes. New tasks from Slack, Linear, Jira and GitHub are delayed.`,
  )

  // 4. Events that failed for good, per app (3+ in the last hour).
  const dead = await prisma.syncEvent.groupBy({ by: ['provider'], where: { status: 'DEAD', processedAt: { gte: new Date(Date.now() - 36e5) } }, _count: true })
  for (const p of ['linear', 'jira-software-cloud', 'github', 'slack']) {
    const n = dead.find((d) => d.provider === p)?._count ?? 0
    await set(
      n >= 3,
      `workpulse-sync-dead-${p}`,
      'HIGH',
      `${p} sync failing in KONVO`,
      `${n} ${p} events failed after all retries in the last hour. Tasks from ${p} are missing; see Sync History.`,
    )
  }

  // 5. Server errors (over 20 in 5 minutes).
  const minute = Math.floor(Date.now() / 60000)
  const counts = await redis().mget(...[0, 1, 2, 3, 4].map((i) => `wp:5xx:${minute - i}`))
  const errors = counts.reduce((a, c) => a + (Number(c) || 0), 0)
  await set(
    errors > 20,
    'workpulse-api-errors',
    'HIGH',
    'KONVO API returning errors',
    `${errors} server errors in the last 5 minutes. People are seeing “Something went wrong”.`,
  )

  // 6–8. Email, AI and report delivery failing in a row.
  const fail = async (n: Counter) => Number(await redis().get(`wp:fail:${n}`)) || 0
  const email = await fail('email')
  await set(
    email >= 3,
    'workpulse-email-failing',
    'HIGH',
    'KONVO cannot send email',
    `${email} emails in a row failed. Verification, password reset and invitations are not arriving.`,
  )
  const ai = await fail('ai')
  await set(
    ai >= 5,
    'workpulse-ai-failing',
    'MEDIUM',
    'KONVO AI calls failing',
    `${ai} AI calls in a row failed. Tasks are still created and assigned, without AI.`,
  )
  const delivery = await fail('delivery')
  await set(delivery >= 5, 'workpulse-delivery-failing', 'MEDIUM', 'KONVO report delivery failing', `${delivery} Slack/Gmail deliveries in a row failed.`)
}

export function startOpsMonitor() {
  if (isTest || !m91.channelConfigured()) return
  const t = setInterval(() => checkOps().catch((e) => logger.error({ err: e?.message }, 'ops check failed')), 60_000)
  t.unref()
  logger.info('on-call monitor running (M91 channel)')
}

// ───────────── People ─────────────

export const MOMENTS = {
  task_assigned: 'A critical task, or one due within 24 hours, is assigned to you',
  blocker_escalation: 'A task you manage has been blocked for over 48 hours',
  task_overdue: 'Your critical task is overdue',
  correction: 'Someone disputes a rating or record you manage',
  connection_expired: 'Your app connection expired, so tasks stopped arriving',
} as const
export type Moment = keyof typeof MOMENTS

async function raiseForUser(input: {
  orgId: string
  userId: string
  kind: Moment
  refId: string
  customId: string
  payload: Omit<m91.AlertPayload, 'customId'>
}) {
  if (!m91.platformConfigured()) return
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { phone: true, phoneAlertState: true, alertPrefs: true } })
  if (!user?.phone || user.phoneAlertState !== 'accepted') return
  if ((user.alertPrefs as Record<string, boolean>)[input.kind] === false) return
  const open = await prisma.phoneAlert.findFirst({ where: { customId: input.customId, userId: input.userId, status: 'OPEN' } })
  if (open) return
  try {
    const r = await m91.personAlert(user.phone, { ...input.payload, customId: input.customId })
    await prisma.phoneAlert.create({
      data: {
        orgId: input.orgId,
        userId: input.userId,
        phone: user.phone,
        kind: input.kind,
        customId: input.customId,
        refId: input.refId,
        severity: input.payload.severity,
        title: input.payload.title,
        m91Id: r._id,
        delivered: r.delivered,
      },
    })
  } catch (e) {
    if (e instanceof m91.M91Error && (e.code === 'CHANNEL_EMPTY' || e.status === 409))
      await prisma.user.update({ where: { id: input.userId }, data: { phoneAlertState: 'pending' } })
    if (e instanceof m91.M91Error && e.status === 404) await prisma.user.update({ where: { id: input.userId }, data: { phoneAlertState: null } })
    logger.warn({ kind: input.kind, err: e instanceof Error ? e.message : e }, 'personal phone alert not sent')
  }
}

const taskIdFrom = (link?: string | null) => /\/tasks\/([0-9a-f-]{36})/.exec(link ?? '')?.[1] ?? null

/** Maps in-app notifications of the chosen moments to a phone alert. Runs in the worker (queued). */
export async function phoneAlertFromNotification(n: {
  orgId: string
  userId: string
  kind: string
  title: string
  body?: string | null
  link?: string | null
  dedupeKey: string
}) {
  if (!m91.platformConfigured()) return
  const taskId = taskIdFrom(n.link)
  if ((n.kind === 'task_assigned' || n.kind === 'external_task') && taskId) {
    const t = await prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, priority: true, dueAt: true, assigneeId: true, status: true, description: true },
    })
    if (!t || t.assigneeId !== n.userId || ['COMPLETED', 'CANCELLED'].includes(t.status)) return
    const dueSoon = Boolean(t.dueAt && t.dueAt.getTime() - Date.now() < 24 * 36e5)
    if (t.priority !== 'CRITICAL' && !dueSoon) return
    return raiseForUser({
      orgId: n.orgId,
      userId: n.userId,
      kind: 'task_assigned',
      refId: taskId,
      customId: `task-assigned-${taskId}`,
      payload: {
        title: `New ${t.priority === 'CRITICAL' ? 'critical ' : ''}task: ${t.title}`.slice(0, 200),
        description: [t.dueAt ? `Due ${t.dueAt.toUTCString().slice(0, 22)}` : null, t.description?.slice(0, 600), `${env.APP_URL}/tasks?task=${taskId}`]
          .filter(Boolean)
          .join('\n'),
        severity: t.priority === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
        responseOptions: [
          { label: 'On it', effect: 'SHARED' },
          { label: 'Can’t take it', effect: 'SHARED', required: ['note'] },
        ],
      },
    })
  }
  if (n.kind === 'blocker_escalation' && taskId) {
    return raiseForUser({
      orgId: n.orgId,
      userId: n.userId,
      kind: 'blocker_escalation',
      refId: taskId,
      customId: `blocker-${taskId}`,
      payload: {
        title: n.title.slice(0, 200),
        description: `${n.body ?? ''}\n${env.APP_URL}/tasks?task=${taskId}`,
        severity: 'MEDIUM',
        responseOptions: [
          { label: 'I’ll unblock it', effect: 'SHARED' },
          { label: 'Seen', effect: 'PERSONAL' },
        ],
      },
    })
  }
  if (n.kind === 'overdue' && taskId) {
    const t = await prisma.task.findUnique({ where: { id: taskId }, select: { priority: true } })
    if (t?.priority !== 'CRITICAL') return
    return raiseForUser({
      orgId: n.orgId,
      userId: n.userId,
      kind: 'task_overdue',
      refId: taskId,
      customId: `overdue-${taskId}`,
      payload: {
        title: n.title.slice(0, 200),
        description: `${env.APP_URL}/tasks?task=${taskId}`,
        severity: 'MEDIUM',
        responseOptions: [
          { label: 'Working on it', effect: 'SHARED' },
          { label: 'Need more time', effect: 'SHARED', required: ['note'] },
        ],
      },
    })
  }
  if (n.kind === 'correction') {
    const id = /^correction:([0-9a-f-]{36})/.exec(n.dedupeKey)?.[1]
    if (!id) return
    return raiseForUser({
      orgId: n.orgId,
      userId: n.userId,
      kind: 'correction',
      refId: id,
      customId: `correction-${id}`,
      payload: {
        title: n.title.slice(0, 200),
        description: `${n.body ?? ''}\n${env.APP_URL}/reviews?tab=corrections`,
        severity: 'LOW',
        responseOptions: [
          { label: 'I’ll review it', effect: 'SHARED' },
          { label: 'Seen', effect: 'PERSONAL' },
        ],
      },
    })
  }
}

export async function phoneAlertConnectionExpired(conn: { id: string; orgId: string; userId: string; provider: string }) {
  await raiseForUser({
    orgId: conn.orgId,
    userId: conn.userId,
    kind: 'connection_expired',
    refId: conn.id,
    customId: `connection-${conn.id}`,
    payload: {
      title: `Your ${conn.provider} connection to KONVO expired`,
      description: `Tasks from ${conn.provider} have stopped arriving. Reconnect: ${env.APP_URL}/integrations`,
      severity: 'LOW',
      responseOptions: [
        { label: 'I’ll reconnect', effect: 'SHARED' },
        { label: 'Seen', effect: 'PERSONAL' },
      ],
    },
  })
}

/** Has the situation behind an open personal alert cleared by itself? */
async function cleared(a: { kind: string; refId: string | null; userId: string | null }) {
  if (!a.refId) return true
  if (a.kind === 'task_assigned' || a.kind === 'task_overdue') {
    const t = await prisma.task.findUnique({ where: { id: a.refId }, select: { status: true, assigneeId: true, deletedAt: true, dueAt: true } })
    return (
      !t ||
      t.deletedAt != null ||
      ['COMPLETED', 'CANCELLED'].includes(t.status) ||
      t.assigneeId !== a.userId ||
      (a.kind === 'task_overdue' && Boolean(t.dueAt && t.dueAt > new Date()))
    )
  }
  if (a.kind === 'blocker_escalation') return (await prisma.task.findUnique({ where: { id: a.refId }, select: { status: true } }))?.status !== 'BLOCKED'
  if (a.kind === 'correction') return (await prisma.correctionRequest.findUnique({ where: { id: a.refId }, select: { status: true } }))?.status !== 'OPEN'
  if (a.kind === 'connection_expired')
    return (await prisma.integrationConnection.findUnique({ where: { id: a.refId }, select: { status: true } }))?.status !== 'EXPIRED'
  return false
}

async function comment(taskId: string, body: string) {
  await prisma.taskComment.create({ data: { taskId, body } })
}

/** Acts on a SHARED answer. Returns a short summary for the record. */
async function act(a: { kind: string; refId: string | null; userId: string | null; orgId: string | null }, label: string, note: string | null, by: string) {
  if (!a.refId || !a.userId || !a.orgId) return
  const task = a.kind.startsWith('task_') || a.kind === 'blocker_escalation' ? await prisma.task.findUnique({ where: { id: a.refId } }) : null
  if (a.kind === 'task_assigned' && task) {
    if (label === 'On it') {
      if (['TODO', 'BACKLOG'].includes(task.status))
        await prisma.task.update({ where: { id: task.id }, data: { status: 'IN_PROGRESS', startedAt: task.startedAt ?? new Date() } })
      await prisma.taskActivity.create({ data: { taskId: task.id, kind: 'phone_answer', actorType: 'USER', actorId: a.userId, toValue: 'On it (from phone)' } })
    } else {
      // Declined from the phone: re-assign to the next best fit, never back to the same person.
      const d = await chooseAssignee(a.orgId, task.creatorId, { title: task.title, description: task.description, category: task.category }, [a.userId])
      const next = d.userId === a.userId ? null : d.userId
      await prisma.task.update({ where: { id: task.id }, data: { assigneeId: next } })
      await comment(task.id, `**${by}** can’t take this (from phone): ${note ?? 'no reason given'}`)
      if (next) {
        await recordAssignment(task.id, d, null)
        await notify({
          orgId: a.orgId,
          userId: next,
          kind: 'task_assigned',
          title: `Assigned to you: ${task.title}`,
          link: `/tasks/${task.id}`,
          dedupeKey: `assigned:${task.id}:${next}`,
        })
      }
      if (task.creatorId !== a.userId)
        await notify({
          orgId: a.orgId,
          userId: task.creatorId,
          kind: 'task_declined',
          title: `${by} can’t take “${task.title}”`,
          body: note ?? undefined,
          link: `/tasks/${task.id}`,
          dedupeKey: `declined:${task.id}:${a.userId}`,
        })
    }
  }
  if (a.kind === 'task_overdue' && task) {
    await comment(task.id, `**${by}** (from phone): ${label}${note ? ` — ${note}` : ''}`)
    if (label !== 'Working on it') {
      const managers = await prisma.team.findMany({
        where: { orgId: a.orgId, managerId: { not: null }, members: { some: { userId: a.userId } } },
        select: { managerId: true },
      })
      for (const m of managers)
        if (m.managerId && m.managerId !== a.userId)
          await notify({
            orgId: a.orgId,
            userId: m.managerId,
            kind: 'needs_time',
            title: `${by} needs more time: ${task.title}`,
            body: note ?? undefined,
            link: `/tasks/${task.id}`,
            dedupeKey: `needs-time:${task.id}:${Date.now()}`,
          })
    }
  }
  if (a.kind === 'blocker_escalation' && task) {
    await comment(task.id, `**${by}** is unblocking this (from phone).`)
    if (task.assigneeId && task.assigneeId !== a.userId)
      await notify({
        orgId: a.orgId,
        userId: task.assigneeId,
        kind: 'unblocking',
        title: `${by} is unblocking “${task.title}”`,
        link: `/tasks/${task.id}`,
        dedupeKey: `unblocking:${task.id}:${a.userId}`,
      })
  }
}

/** Every minute in the worker: close alerts whose situation cleared, act on answers, close answered ones. */
export async function processPersonalAlerts() {
  if (!m91.platformConfigured()) return
  const open = await prisma.phoneAlert.findMany({ where: { status: 'OPEN', userId: { not: null } }, take: 200 })
  for (const a of open) {
    try {
      if (await cleared(a)) {
        await m91.personClose(a.phone!, a.customId).catch(() => undefined)
        await prisma.phoneAlert.update({ where: { id: a.id }, data: { status: 'CLOSED', closedAt: new Date() } })
        continue
      }
      const s = await m91.personRead(a.phone!, a.customId)
      if (s.decision) {
        const resp = s.responses.find((r) => r.effect === 'SHARED' && r.label === s.decision!.label)
        const by = (await prisma.user.findUnique({ where: { id: a.userId! }, select: { name: true } }))?.name ?? 'Someone'
        await act(a, s.decision.label, resp?.note ?? null, by)
        await m91.personClose(a.phone!, a.customId).catch(() => undefined)
        await prisma.phoneAlert.update({
          where: { id: a.id },
          data: { status: 'CLOSED', decision: s.decision.label, note: resp?.note ?? null, answeredBy: by, closedAt: new Date() },
        })
      } else if (s.status === 'RESOLVED' || s.resolvedAt) {
        // Ended without a SHARED decision (for example everyone answered “Seen”).
        await prisma.phoneAlert.update({ where: { id: a.id }, data: { status: 'CLOSED', closedAt: new Date() } })
      }
    } catch (e) {
      await prisma.phoneAlert.update({ where: { id: a.id }, data: { error: e instanceof Error ? e.message.slice(0, 300) : 'error' } })
    }
  }
}

// ───────────── Invitations (automatic) ─────────────

/** Saves a number and sends the M91 invitation right away. Returns the invitation state, or null when not possible. */
export async function connectPhone(userId: string, raw: string) {
  const phone = m91.normalizePhone(raw)
  if (!phone) return null
  await prisma.user.update({ where: { id: userId }, data: { phone, phoneAlertState: 'pending' } })
  if (!m91.platformConfigured()) return 'pending'
  try {
    const r = await m91.invite(phone)
    await prisma.user.update({ where: { id: userId }, data: { phoneAlertState: r.state } })
    return r.state
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : e }, 'M91 invitation not sent yet; the worker retries')
    return 'pending'
  }
}

/** Every 5 minutes in the worker: (re)send invitations and pick up acceptances, so nobody has to press anything. */
export async function syncPhoneInvitations() {
  if (!m91.platformConfigured()) return
  const users = await prisma.user.findMany({ where: { phone: { not: null }, OR: [{ phoneAlertState: null }, { phoneAlertState: 'pending' }] }, take: 200 })
  for (const u of users) {
    try {
      const r = await m91.invite(u.phone!)
      if (r.state === u.phoneAlertState) continue
      await prisma.user.update({ where: { id: u.id }, data: { phoneAlertState: r.state } })
      if (r.state === 'accepted') {
        const m = await prisma.organizationMember.findFirst({ where: { userId: u.id, status: 'ACTIVE' }, select: { orgId: true } })
        if (m)
          await notify({
            orgId: m.orgId,
            userId: u.id,
            kind: 'phone_connected',
            title: 'Phone alerts are on: urgent things will now ring your phone',
            link: '/alerts',
            dedupeKey: `phone-connected:${u.id}:${u.phone}`,
          })
      }
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e }, 'phone invitation sync failed for one user')
    }
  }
}

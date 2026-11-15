// Scheduled automations. Every notification and delivery has a dedupe key, so a re-run (retry, overlap) never
// sends twice. External delivery happens only to destinations the person connected and chose themselves.
import { prisma } from '../lib/prisma.js'
import { logger } from '../config/logger.js'
import { addDays, dayBounds, todayIn, tzOffsetMs, weekStart } from '../lib/dates.js'
import { notify } from '../services/notify.js'
import { snapshot } from '../services/performance.js'
import { keyResultProgress } from '../modules/goals.js'
import { generateReport } from '../modules/reports.js'
import { toMarkdown, type ReportContent } from '../services/reports.js'
import { deliverToSlack } from '../integrations/delivery.js'

const localHour = (tz: string, at = new Date()) => new Date(at.getTime() + tzOffsetMs(tz, at)).getUTCHours()
const localDow = (tz: string, at = new Date()) => new Date(at.getTime() + tzOffsetMs(tz, at)).getUTCDay()
const weekday = (tz: string) => ![0, 6].includes(localDow(tz))

async function activeMembers() {
  return prisma.organizationMember.findMany({
    where: { status: 'ACTIVE' },
    select: { orgId: true, userId: true, role: true, user: { select: { timezone: true, name: true } } },
  })
}

async function hasSlack(userId: string, orgId: string) {
  const c = await prisma.integrationConnection.findFirst({ where: { userId, orgId, provider: 'slack', status: 'ACTIVE' }, select: { settings: true } })
  return Boolean(c && (c.settings as { delivery?: unknown }).delivery)
}

async function slackSafe(userId: string, orgId: string, text: string, key: string) {
  if (!(await hasSlack(userId, orgId))) return
  await deliverToSlack(userId, orgId, text, key).catch((e) => logger.warn({ err: e?.message, key }, 'slack delivery failed'))
}

/** Hourly: deadlines, overdue, blocker escalation, planning and review reminders, daily reports. */
export async function hourly(now = new Date()) {
  const soon = new Date(now.getTime() + 24 * 36e5)
  const due = await prisma.task.findMany({
    where: { deletedAt: null, archivedAt: null, assigneeId: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED'] }, dueAt: { lte: soon } },
    select: { id: true, orgId: true, title: true, assigneeId: true, dueAt: true },
  })
  for (const t of due) {
    const overdue = t.dueAt! < now
    await notify({
      orgId: t.orgId,
      userId: t.assigneeId!,
      kind: overdue ? 'overdue' : 'deadline',
      title: overdue ? `Overdue: ${t.title}` : `Due within 24 hours: ${t.title}`,
      link: `/tasks/${t.id}`,
      dedupeKey: `${overdue ? 'overdue' : 'deadline'}:${t.id}:${t.dueAt!.toISOString()}`,
    })
  }

  // Blocked for more than 48 hours → the assignee's managers (an investigation signal, not a judgement).
  const stuck = await prisma.blocker.findMany({
    where: { resolvedAt: null, createdAt: { lt: new Date(now.getTime() - 48 * 36e5) } },
    include: { task: { select: { id: true, title: true, assigneeId: true, orgId: true } } },
  })
  for (const b of stuck) {
    const managers = await prisma.team.findMany({
      where: { orgId: b.orgId, managerId: { not: null }, members: { some: { userId: b.task.assigneeId ?? '' } } },
      select: { managerId: true },
    })
    for (const m of managers) {
      const key = `escalate:${b.id}:${m.managerId}`
      const fresh = !(await prisma.notification.findUnique({ where: { dedupeKey: key } }))
      await notify({
        orgId: b.orgId,
        userId: m.managerId!,
        kind: 'blocker_escalation',
        title: `Blocked for over 48h: ${b.task.title}`,
        body: b.reason,
        link: `/tasks/${b.task.id}`,
        dedupeKey: key,
      })
      if (fresh) await slackSafe(m.managerId!, b.orgId, `*Blocked for over 48 hours:* ${b.task.title}\nReason: ${b.reason}`, `slack:${key}`)
    }
  }

  for (const m of await activeMembers()) {
    const tz = m.user.timezone
    const h = localHour(tz, now)
    const today = todayIn(tz, now)
    if (!weekday(tz)) continue
    if (h === 9) {
      const plan = await prisma.dailyPlan.findUnique({ where: { orgId_userId_date: { orgId: m.orgId, userId: m.userId, date: today } } })
      if (!plan) {
        const key = `plan:${m.userId}:${m.orgId}:${today}`
        await notify({
          orgId: m.orgId,
          userId: m.userId,
          kind: 'planning',
          title: 'Plan your day: choose your top three outcomes',
          link: '/planner',
          dedupeKey: key,
        })
      }
    }
    if (h === 17) {
      const plan = await prisma.dailyPlan.findUnique({ where: { orgId_userId_date: { orgId: m.orgId, userId: m.userId, date: today } } })
      if (plan && !plan.reviewedAt)
        await notify({
          orgId: m.orgId,
          userId: m.userId,
          kind: 'review',
          title: 'Close your day: review what you delivered',
          link: '/planner',
          dedupeKey: `review:${m.userId}:${m.orgId}:${today}`,
        })
    }
    if (h === 18 && (await hasSlack(m.userId, m.orgId))) {
      const r = await generateReport(m.orgId, 'DAILY', `user:${m.userId}`, today, null, false)
      await slackSafe(m.userId, m.orgId, toMarkdown(r.content as unknown as ReportContent), `daily-report:${r.id}`)
    }
  }
}

/** Nightly: performance snapshots (this and last week) and goal progress recalculation. */
export async function nightly(now = new Date()) {
  const ws = weekStart(now.toISOString().slice(0, 10))
  const weeks = [addDays(ws, -7), ws].map((d) => [new Date(`${d}T00:00:00Z`), new Date(`${addDays(d, 7)}T00:00:00Z`)] as const)
  for (const m of await activeMembers())
    for (const [s, e] of weeks) await snapshot(m.orgId, `user:${m.userId}`, s, e, 'WEEK').catch((err) => logger.warn({ err: err?.message }, 'snapshot failed'))
  for (const t of await prisma.team.findMany({ select: { id: true, orgId: true } }))
    for (const [s, e] of weeks) await snapshot(t.orgId, `team:${t.id}`, s, e, 'WEEK').catch(() => undefined)

  const goals = await prisma.goal.findMany({ where: { deletedAt: null, status: { in: ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] } }, include: { keyResults: true } })
  for (const g of goals) {
    const progress = keyResultProgress(g.keyResults) ?? g.progress
    const span = g.dueDate.getTime() - g.startDate.getTime()
    const elapsed = span > 0 ? Math.min(100, Math.max(0, ((now.getTime() - g.startDate.getTime()) / span) * 100)) : 100
    // A signal for the owner, never a final verdict: only ON_TRACK goals move to AT_RISK automatically.
    const atRisk = g.status === 'ON_TRACK' && elapsed - progress > 30
    if (progress !== g.progress || atRisk) {
      await prisma.goal.update({ where: { id: g.id }, data: { progress, status: atRisk ? 'AT_RISK' : g.status } })
      await prisma.goalUpdate.create({
        data: {
          goalId: g.id,
          authorId: 'system',
          progress,
          status: atRisk ? 'AT_RISK' : g.status,
          note: atRisk ? `Automatic signal: ${Math.round(elapsed)}% of the time has passed, ${progress}% progress.` : 'Recalculated from key results.',
        },
      })
      if (atRisk)
        await notify({
          orgId: g.orgId,
          userId: g.ownerId,
          kind: 'goal_risk',
          title: `Goal at risk: ${g.title}`,
          link: `/goals`,
          dedupeKey: `goal-risk:${g.id}:${todayIn('UTC', now)}`,
        })
    }
  }
}

/** Mondays: last week's report for every person and team; delivered to Slack where the person set it up. */
export async function weeklyReports(now = new Date()) {
  const lastWeek = addDays(weekStart(now.toISOString().slice(0, 10)), -7)
  for (const m of await activeMembers()) {
    const r = await generateReport(m.orgId, 'WEEKLY', `user:${m.userId}`, lastWeek, null, false)
    await notify({
      orgId: m.orgId,
      userId: m.userId,
      kind: 'weekly_report',
      title: 'Your weekly report is ready',
      link: `/reports/${r.id}`,
      dedupeKey: `weekly:${r.id}`,
    })
    await slackSafe(m.userId, m.orgId, toMarkdown(r.content as unknown as ReportContent), `weekly-report:${r.id}`)
  }
  for (const t of await prisma.team.findMany({ where: { managerId: { not: null } } })) {
    const r = await generateReport(t.orgId, 'WEEKLY', `team:${t.id}`, lastWeek, null, false)
    await notify({
      orgId: t.orgId,
      userId: t.managerId!,
      kind: 'weekly_report',
      title: `Weekly report for ${t.name} is ready`,
      link: `/reports/${r.id}`,
      dedupeKey: `weekly:${r.id}:${t.managerId}`,
    })
    await slackSafe(t.managerId!, t.orgId, toMarkdown(r.content as unknown as ReportContent), `weekly-team-report:${r.id}`)
  }
}

export const _test = { localHour, dayBounds }

import PDFDocument from 'pdfkit'
import { prisma, type Prisma } from '../lib/prisma.js'
import { addDays, dayBounds, todayIn, weekStart } from '../lib/dates.js'
import { IMPACT_POINTS, snapshot } from './performance.js'

export interface ReportContent {
  title: string
  subjectName: string
  period: { start: string; end: string }
  sections: { heading: string; items: string[] }[]
  metrics: Record<string, number | string | null>
}

const fmtTask = (t: { title: string; impactLevel?: string; source?: { externalKey: string | null } | null }) =>
  `${t.title}${t.source?.externalKey ? ` (${t.source.externalKey})` : ''}${t.impactLevel && t.impactLevel !== 'NONE' ? ` · ${t.impactLevel.toLowerCase()} impact` : ''}`

async function subjectUsers(orgId: string, subject: string) {
  const [kind, id] = subject.split(':') as ['user' | 'team', string]
  if (kind === 'user') {
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { name: true, timezone: true } })
    return { userIds: [id], name: u.name, tz: u.timezone }
  }
  const team = await prisma.team.findFirstOrThrow({ where: { id, orgId }, select: { name: true, members: { select: { userId: true } } } })
  return { userIds: team.members.map((m) => m.userId), name: team.name, tz: 'UTC' }
}

export async function buildDaily(orgId: string, subject: string, date?: string): Promise<{ content: ReportContent; start: Date; end: Date }> {
  const { userIds, name, tz } = await subjectUsers(orgId, subject)
  const day = date ?? todayIn(tz)
  const [start, end] = dayBounds(day, tz)
  const base: Prisma.TaskWhereInput = { orgId, deletedAt: null, assigneeId: { in: userIds } }
  const include = { source: { select: { externalKey: true } } }
  const [plans, delivered, blockers, evidence, nextUp] = await Promise.all([
    prisma.dailyPlan.findMany({ where: { orgId, userId: { in: userIds }, date: day } }),
    prisma.task.findMany({ where: { ...base, status: 'COMPLETED', completedAt: { gte: start, lt: end } }, include }),
    prisma.task.findMany({
      where: { ...base, status: 'BLOCKED' },
      include: { ...include, blockers: { where: { resolvedAt: null }, select: { reason: true } } },
    }),
    prisma.evidence.findMany({
      where: { orgId, deletedAt: null, createdAt: { gte: start, lt: end }, task: { assigneeId: { in: userIds } } },
      select: { title: true, kind: true, status: true },
    }),
    prisma.task.findMany({
      where: { ...base, status: { in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] }, archivedAt: null },
      include,
      orderBy: [{ priority: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }],
      take: 5,
    }),
  ])
  const plannedIds = plans.flatMap((p) => p.plannedTaskIds)
  const planned = plannedIds.length ? await prisma.task.findMany({ where: { id: { in: plannedIds } }, include }) : []
  const incomplete = planned.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED')
  const reasons = new Map(plans.flatMap((p) => (p.carryForward as { taskId: string; reason: string }[]).map((c) => [c.taskId, c.reason] as const)))
  const outcomes = plans.flatMap((p) => (p.topOutcomes as { text: string; done: boolean }[]).map((o) => `${o.done ? '✓' : '○'} ${o.text}`))
  return {
    start,
    end,
    content: {
      title: `Daily report · ${name} · ${day}`,
      subjectName: name,
      period: { start: day, end: day },
      sections: [
        { heading: 'Planned outcomes', items: outcomes.length ? outcomes : planned.map((t) => `○ ${fmtTask(t)}`) },
        { heading: 'Delivered', items: delivered.map((t) => `✓ ${fmtTask(t)}`) },
        { heading: 'Not finished', items: incomplete.map((t) => `${fmtTask(t)}${reasons.get(t.id) ? ` — ${reasons.get(t.id)}` : ' — no reason given yet'}`) },
        { heading: 'Blockers', items: blockers.map((t) => `${fmtTask(t)}: ${t.blockers.map((b) => b.reason).join('; ') || 'no reason recorded'}`) },
        { heading: 'Evidence added', items: evidence.map((e) => `${e.title} (${e.kind.toLowerCase().replace('_', ' ')}, ${e.status.toLowerCase()})`) },
        { heading: 'Next priorities', items: nextUp.map((t) => fmtTask(t)) },
      ],
      metrics: { planned: planned.length, delivered: delivered.length, incomplete: incomplete.length, blockers: blockers.length, evidence: evidence.length },
    },
  }
}

export async function buildWeekly(orgId: string, subject: string, date?: string): Promise<{ content: ReportContent; start: Date; end: Date }> {
  const { userIds, name } = await subjectUsers(orgId, subject)
  // Default: the last full week.
  const ws = date ? weekStart(date) : addDays(weekStart(todayIn('UTC')), -7)
  const start = new Date(`${ws}T00:00:00Z`)
  const end = new Date(`${addDays(ws, 7)}T00:00:00Z`)
  const score = await snapshot(orgId, subject, start, end, 'WEEK')
  const base: Prisma.TaskWhereInput = { orgId, deletedAt: null, assigneeId: { in: userIds } }
  const include = { source: { select: { externalKey: true } }, project: { select: { name: true } } }
  const [done, blockers, goals, nextWeek] = await Promise.all([
    prisma.task.findMany({ where: { ...base, status: 'COMPLETED', completedAt: { gte: start, lt: end } }, include }),
    prisma.blocker.findMany({
      where: { orgId, createdAt: { lt: end }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }], task: { assigneeId: { in: userIds } } },
      include: { task: { select: { title: true } } },
    }),
    prisma.goal.findMany({
      where: { orgId, deletedAt: null, ownerId: { in: userIds }, startDate: { lt: end }, dueDate: { gte: start } },
      select: { title: true, progress: true, status: true },
    }),
    prisma.task.findMany({
      where: { ...base, status: { notIn: ['COMPLETED', 'CANCELLED'] }, dueAt: { gte: end, lt: new Date(end.getTime() + 7 * 864e5) } },
      include,
      orderBy: { dueAt: 'asc' },
    }),
  ])
  const projects = new Map<string, number>()
  for (const t of done) projects.set(t.project?.name ?? 'No project', (projects.get(t.project?.name ?? 'No project') ?? 0) + IMPACT_POINTS[t.impactLevel])
  const d = score.dimensions
  const pct = (v: number | null) => (v == null ? 'no data' : `${Math.round(v)}`)
  const weakest = Object.entries(d)
    .filter(([, x]) => x.value != null)
    .sort((a, b) => a[1].value! - b[1].value!)
    .slice(0, 2)
  const improvements = [
    ...weakest.filter(([, x]) => x.value! < 70).map(([k, x]) => `${k[0]!.toUpperCase()}${k.slice(1)} is ${pct(x.value)} / 100.`),
    ...Object.entries(d)
      .filter(([, x]) => x.missing)
      .map(([k, x]) => `${k[0]!.toUpperCase()}${k.slice(1)}: ${x.missing}`),
  ]
  return {
    start,
    end,
    content: {
      title: `Weekly report · ${name} · week of ${ws}`,
      subjectName: name,
      period: { start: ws, end: addDays(ws, 6) },
      sections: [
        {
          heading: 'Performance',
          items: [
            `Overall ${pct(score.score)}`,
            `Impact ${pct(d.impact.value)}`,
            `Execution quality ${pct(d.quality.value)}`,
            `Goal alignment ${pct(d.alignment.value)}`,
            `Delivery reliability ${pct(d.reliability.value)} (${score.metrics.onTime} of ${score.metrics.committed} on time${score.metrics.excusedLate ? `, ${score.metrics.excusedLate} late but externally blocked` : ''})`,
            `Evidence completeness ${pct(d.evidence.value)}`,
          ],
        },
        {
          heading: 'Major accomplishments',
          items: done
            .filter((t) => IMPACT_POINTS[t.impactLevel] >= IMPACT_POINTS.MEDIUM)
            .sort((a, b) => IMPACT_POINTS[b.impactLevel] - IMPACT_POINTS[a.impactLevel])
            .map((t) => fmtTask(t)),
        },
        { heading: 'Goal progress', items: goals.map((g) => `${g.title}: ${g.progress}% (${g.status.toLowerCase().replace('_', ' ')})`) },
        {
          heading: 'Project contributions (impact points)',
          items: [...projects].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}: ${Math.round(n * 10) / 10}`),
        },
        { heading: 'Blockers', items: blockers.map((b) => `${b.task.title}: ${b.reason}${b.resolvedAt ? ' (resolved)' : ''}`) },
        { heading: 'Improvement areas', items: improvements },
        { heading: "Next week's priorities", items: nextWeek.map((t) => fmtTask(t)) },
      ],
      metrics: {
        score: score.score,
        impact: d.impact.value,
        quality: d.quality.value,
        alignment: d.alignment.value,
        reliability: d.reliability.value,
        evidence: d.evidence.value,
        completed: score.metrics.completed,
        highImpact: score.metrics.highImpactCompleted,
        impactPoints: score.metrics.impactPoints,
      },
    },
  }
}

export function toMarkdown(c: ReportContent, aiSummary?: string | null) {
  const parts = [`*${c.title}*`]
  if (aiSummary) parts.push(`_Summary (AI-written, check against the data below):_ ${aiSummary}`)
  for (const s of c.sections) parts.push(`*${s.heading}*\n${s.items.length ? s.items.map((i) => `• ${i}`).join('\n') : '• None'}`)
  return parts.join('\n\n')
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(c: ReportContent) {
  const rows: unknown[][] = [['section', 'item']]
  for (const [k, v] of Object.entries(c.metrics)) rows.push(['metric', `${k}: ${v ?? 'no data'}`])
  for (const s of c.sections) for (const i of s.items) rows.push([s.heading, i])
  return rows.map((r) => r.map(csvCell).join(',')).join('\n')
}

export function toPdf(c: ReportContent, aiSummary?: string | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: c.title } })
    const chunks: Buffer[] = []
    doc.on('data', (b: Buffer) => chunks.push(b))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.fillColor('#0f1b33').fontSize(18).text(c.title)
    doc
      .moveDown(0.3)
      .fontSize(9)
      .fillColor('#5b6b85')
      .text(`Generated by KONVO on ${new Date().toISOString().slice(0, 10)}`)
    if (aiSummary) {
      doc.moveDown().fontSize(10).fillColor('#0f1b33').text('Summary (AI-written; check against the data below)', { underline: true })
      doc.fontSize(10).fillColor('#24324d').text(aiSummary)
    }
    for (const s of c.sections) {
      doc.moveDown().fontSize(12).fillColor('#1d4ed8').text(s.heading)
      doc.fontSize(10).fillColor('#24324d')
      if (!s.items.length) doc.text('None')
      for (const i of s.items) doc.text(`• ${i.replace(/[✓○]/g, '').trim()}`, { indent: 8 })
    }
    doc.end()
  })
}

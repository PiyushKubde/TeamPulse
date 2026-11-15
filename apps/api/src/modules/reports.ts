import { Router } from 'express'
import { z } from 'zod'
import { deliverReportSchema, generateReportSchema } from '@workpulse/shared'
import { prisma, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { forbidden, notFound } from '../lib/errors.js'
import { canSeeUser, type Ctx } from '../lib/scope.js'
import { audit } from '../lib/audit.js'
import { sendMail } from '../lib/mailer.js'
import { ctxOf, userOf } from '../middleware/auth.js'
import { buildDaily, buildWeekly, toCsv, toMarkdown, toPdf, type ReportContent } from '../services/reports.js'
import { summarizeReport } from '../ai/features.js'
import { deliverToSlack } from '../integrations/delivery.js'

export const reports = Router()

function assertSubject(ctx: Ctx, subject: string) {
  const [kind, id] = subject.split(':') as [string, string]
  if (kind === 'user' ? !canSeeUser(ctx, id) : !(ctx.orgWide || ctx.managedTeamIds.includes(id))) throw notFound('Report subject')
}

export async function generateReport(
  orgId: string,
  kind: 'DAILY' | 'WEEKLY',
  subject: string,
  date: string | undefined,
  generatedById: string | null,
  withAi: boolean,
) {
  const { content, start, end } = kind === 'DAILY' ? await buildDaily(orgId, subject, date) : await buildWeekly(orgId, subject, date)
  const aiSummary = withAi
    ? await summarizeReport(subject.startsWith('user:') ? subject.slice(5) : (generatedById ?? 'system'), content).catch(() => null)
    : null
  return prisma.report.upsert({
    where: { orgId_kind_subject_periodStart: { orgId, kind, subject, periodStart: start } },
    create: { orgId, kind, subject, periodStart: start, periodEnd: end, content: content as unknown as Prisma.InputJsonValue, aiSummary, generatedById },
    update: { periodEnd: end, content: content as unknown as Prisma.InputJsonValue, aiSummary, generatedById },
  })
}

async function findReport(ctx: Ctx, id: string) {
  const r = await prisma.report.findFirst({ where: { id, orgId: ctx.orgId }, include: { deliveries: { orderBy: { createdAt: 'desc' } } } })
  if (!r) throw notFound('Report')
  assertSubject(ctx, r.subject)
  return r
}

reports.get('/reports', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(
    req,
    z.object({
      kind: z.enum(['DAILY', 'WEEKLY']).optional(),
      subject: z
        .string()
        .regex(/^(user|team):[0-9a-f-]{36}$/)
        .optional(),
    }),
  )
  const subject = q.subject ?? `user:${ctx.userId}`
  assertSubject(ctx, subject)
  const items = await prisma.report.findMany({
    where: { orgId: ctx.orgId, subject, kind: q.kind },
    orderBy: { periodStart: 'desc' },
    take: 60,
    select: { id: true, kind: true, subject: true, periodStart: true, periodEnd: true, createdAt: true, aiSummary: true },
  })
  res.json({ items })
})

for (const kind of ['daily', 'weekly'] as const) {
  reports.get(`/reports/${kind}`, async (req, res) => {
    const ctx = ctxOf(req)
    const q = query(
      req,
      z.object({
        subject: z
          .string()
          .regex(/^(user|team):[0-9a-f-]{36}$/)
          .optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    const subject = q.subject ?? `user:${ctx.userId}`
    assertSubject(ctx, subject)
    const report = await generateReport(ctx.orgId, kind === 'daily' ? 'DAILY' : 'WEEKLY', subject, q.date, ctx.userId, false)
    res.json({ report })
  })
}

reports.post('/reports/generate', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, generateReportSchema.extend({ withAi: z.boolean().default(false) }))
  assertSubject(ctx, input.subject)
  const report = await generateReport(ctx.orgId, input.kind, input.subject, input.date, ctx.userId, input.withAi)
  res.status(201).json({ report })
})

reports.get('/reports/:id', async (req, res) => {
  const ctx = ctxOf(req)
  res.json({ report: await findReport(ctx, param(req, 'id')) })
})

reports.get('/reports/:id/export.csv', async (req, res) => {
  const ctx = ctxOf(req)
  const r = await findReport(ctx, param(req, 'id'))
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="workpulse-${r.kind.toLowerCase()}-${r.periodStart.toISOString().slice(0, 10)}.csv"`)
  res.send(toCsv(r.content as unknown as ReportContent))
})

reports.get('/reports/:id/export.pdf', async (req, res) => {
  const ctx = ctxOf(req)
  const r = await findReport(ctx, param(req, 'id'))
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="workpulse-${r.kind.toLowerCase()}-${r.periodStart.toISOString().slice(0, 10)}.pdf"`)
  res.send(await toPdf(r.content as unknown as ReportContent, r.aiSummary))
})

/** Send a report to the caller's own email or their own Slack destination (chosen once in Integrations). */
reports.post('/reports/:id/deliver', async (req, res) => {
  const ctx = ctxOf(req)
  const r = await findReport(ctx, param(req, 'id'))
  const { channel } = body(req, deliverReportSchema)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { settings: true } })
  const approval = (org.settings as Record<string, unknown>).requireReportApproval === true
  if (approval && r.subject.startsWith('team:') && !ctx.orgWide) throw forbidden('Your organization requires an admin to send team reports outside WorkPulse.')
  const content = r.content as unknown as ReportContent
  let status = 'SENT'
  let error: string | null = null
  let target = ''
  try {
    if (channel === 'EMAIL') {
      target = userOf(req).email
      const sent = await sendMail(target, content.title, toMarkdown(content, r.aiSummary).replace(/\*/g, ''))
      if (!sent.delivered) status = 'LOGGED'
    } else {
      target = 'slack'
      await deliverToSlack(ctx.userId, ctx.orgId, toMarkdown(content, r.aiSummary), `report:${r.id}:${Date.now()}`)
    }
  } catch (e) {
    status = 'FAILED'
    error = e instanceof Error ? e.message.slice(0, 300) : 'Delivery failed'
  }
  const delivery = await prisma.reportDelivery.create({ data: { reportId: r.id, channel, target, status, error } })
  await audit(req, ctx.orgId, 'report.deliver', { type: 'Report', id: r.id }, { channel, status })
  res.status(status === 'FAILED' ? 502 : 200).json({ delivery })
})

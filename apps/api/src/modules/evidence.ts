import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { EVIDENCE_KINDS, VERIFICATION_STATUSES, evidenceLinkSchema, matchEvidenceSchema, verifyEvidenceSchema } from '@workpulse/shared'
import { prisma, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { canManageUser, findEditableTask, findVisibleTask, taskScope, type Ctx } from '../lib/scope.js'
import { audit } from '../lib/audit.js'
import { env } from '../config/env.js'
import { ctxOf } from '../middleware/auth.js'
import { putFile, readLocal, signedUrl } from '../lib/storage.js'
import { logActivity } from '../services/activity.js'
import { notify } from '../services/notify.js'

export const evidence = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1 } })

/** Evidence the caller may see: on visible tasks, or unmatched provider items the caller collected. */
export function evidenceScope(ctx: Ctx): Prisma.EvidenceWhereInput {
  return {
    orgId: ctx.orgId,
    deletedAt: null,
    OR: [{ task: taskScope(ctx) }, { taskId: null, ...(ctx.orgWide ? {} : { addedById: ctx.userId }) }],
  }
}

const evidenceInclude = {
  task: { select: { id: true, title: true, assigneeId: true } },
  verifications: { orderBy: { createdAt: 'desc' }, take: 10 },
} satisfies Prisma.EvidenceInclude

evidence.get('/evidence', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(
    req,
    z.object({
      taskId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      kind: z.enum(EVIDENCE_KINDS).optional(),
      status: z.enum(VERIFICATION_STATUSES).optional(),
      source: z.enum(['MANUAL', 'GITHUB', 'LINEAR', 'JIRA', 'UPLOAD']).optional(),
      unmatched: z.coerce.boolean().optional(),
      page: z.coerce.number().int().min(1).default(1),
    }),
  )
  const where: Prisma.EvidenceWhereInput = {
    AND: [
      evidenceScope(ctx),
      { taskId: q.unmatched ? null : q.taskId, kind: q.kind, status: q.status, source: q.source },
      q.userId ? { task: { assigneeId: q.userId } } : {},
    ],
  }
  const [items, total] = await Promise.all([
    prisma.evidence.findMany({ where, include: evidenceInclude, orderBy: { createdAt: 'desc' }, take: 50, skip: (q.page - 1) * 50 }),
    prisma.evidence.count({ where }),
  ])
  const verifierIds = items.flatMap((e) => e.verifications.map((v) => v.verifierId))
  const users = await prisma.user.findMany({ where: { id: { in: verifierIds } }, select: { id: true, name: true } })
  const names = new Map(users.map((u) => [u.id, u.name]))
  res.json({
    items: items.map((e) => ({
      ...e,
      storageKey: undefined,
      verifications: e.verifications.map((v) => ({ ...v, verifierName: names.get(v.verifierId) ?? null })),
      canVerify: Boolean(e.task?.assigneeId && canManageUser(ctx, e.task.assigneeId)),
    })),
    page: q.page,
    pageSize: 50,
    total,
  })
})

evidence.post('/evidence', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, evidenceLinkSchema)
  const task = await findEditableTask(ctx, input.taskId)
  const row = await prisma.evidence.create({
    data: { orgId: ctx.orgId, taskId: task.id, kind: input.kind, title: input.title, url: input.url, source: 'MANUAL', addedById: ctx.userId },
  })
  await logActivity(task.id, 'evidence_added', 'USER', ctx.userId, input.title)
  res.status(201).json({ evidence: row })
})

evidence.post('/evidence/upload', upload.single('file'), async (req, res) => {
  const ctx = ctxOf(req)
  const fields = z
    .object({ taskId: z.string().uuid(), title: z.string().trim().min(1).max(200), kind: z.enum(['SCREENSHOT', 'FILE', 'DOCUMENT', 'REPORT']).default('FILE') })
    .parse(req.body)
  const task = await findEditableTask(ctx, fields.taskId)
  if (!req.file) throw badRequest('Choose a file.')
  const key = await putFile(ctx.orgId, req.file.originalname, req.file.mimetype, req.file.buffer)
  const kind = req.file.mimetype.startsWith('image/') && fields.kind === 'FILE' ? 'SCREENSHOT' : fields.kind
  const row = await prisma.evidence.create({
    data: {
      orgId: ctx.orgId,
      taskId: task.id,
      kind,
      title: fields.title,
      source: 'UPLOAD',
      storageKey: key,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      addedById: ctx.userId,
      sourceMeta: { fileName: req.file.originalname.slice(0, 200) },
    },
  })
  await logActivity(task.id, 'evidence_added', 'USER', ctx.userId, fields.title)
  res.status(201).json({ evidence: { ...row, storageKey: undefined } })
})

evidence.get('/evidence/:id/file', async (req, res) => {
  const ctx = ctxOf(req)
  const e = await prisma.evidence.findFirst({ where: { AND: [evidenceScope(ctx), { id: param(req, 'id') }] } })
  if (!e?.storageKey) throw notFound('File')
  const name = String((e.sourceMeta as Record<string, unknown>).fileName ?? 'evidence')
  const url = await signedUrl(e.storageKey, name)
  if (url) return res.redirect(url)
  res.setHeader('Content-Type', e.mimeType ?? 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'")
  res.send(await readLocal(e.storageKey))
})

/** Verify or reject. Quality (1-5) and an impact note are recorded separately from the verification itself. */
evidence.post('/evidence/:id/verify', async (req, res) => {
  const ctx = ctxOf(req)
  const e = await prisma.evidence.findFirst({ where: { AND: [evidenceScope(ctx), { id: param(req, 'id') }] }, include: { task: true } })
  if (!e) throw notFound('Evidence')
  if (!e.task?.assigneeId || !canManageUser(ctx, e.task.assigneeId))
    throw forbidden('Only the people who manage the assignee can verify evidence, and never their own.')
  const input = body(req, verifyEvidenceSchema)
  const [, v] = await prisma.$transaction([
    prisma.evidence.update({ where: { id: e.id }, data: { status: input.status } }),
    prisma.evidenceVerification.create({
      data: {
        evidenceId: e.id,
        verifierId: ctx.userId,
        status: input.status,
        qualityScore: input.qualityScore ?? null,
        impactNote: input.impactNote ?? null,
        note: input.note ?? null,
      },
    }),
  ])
  await logActivity(e.task.id, `evidence_${input.status.toLowerCase()}`, 'USER', ctx.userId, e.title)
  await audit(req, ctx.orgId, 'evidence.verify', { type: 'Evidence', id: e.id }, input)
  await notify({
    orgId: ctx.orgId,
    userId: e.task.assigneeId,
    kind: 'evidence_verified',
    title: `Evidence ${input.status === 'VERIFIED' ? 'verified' : 'rejected'}: ${e.title}`,
    link: `/tasks/${e.task.id}`,
    dedupeKey: `ev:${v.id}`,
  })
  res.json({ verification: v })
})

/** Attach (or detach) collected provider evidence to a task. A suggested match is never applied automatically. */
evidence.post('/evidence/:id/match', async (req, res) => {
  const ctx = ctxOf(req)
  const e = await prisma.evidence.findFirst({ where: { AND: [evidenceScope(ctx), { id: param(req, 'id') }] } })
  if (!e) throw notFound('Evidence')
  if (e.addedById !== ctx.userId && !ctx.orgWide) throw forbidden()
  const { taskId } = body(req, matchEvidenceSchema)
  if (taskId) await findVisibleTask(ctx, taskId)
  const updated = await prisma.evidence.update({ where: { id: e.id }, data: { taskId, suggestedTaskId: null } })
  if (taskId) await logActivity(taskId, 'evidence_added', 'USER', ctx.userId, e.title)
  res.json({ evidence: updated })
})

evidence.delete('/evidence/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const e = await prisma.evidence.findFirst({ where: { AND: [evidenceScope(ctx), { id: param(req, 'id') }] } })
  if (!e) throw notFound('Evidence')
  if (e.addedById !== ctx.userId && !ctx.orgWide) throw forbidden()
  if (e.status === 'VERIFIED' && !ctx.orgWide) throw forbidden('Verified evidence can only be removed by an admin.')
  await prisma.evidence.update({ where: { id: e.id }, data: { deletedAt: new Date() } })
  await audit(req, ctx.orgId, 'evidence.delete', { type: 'Evidence', id: e.id })
  res.status(204).end()
})

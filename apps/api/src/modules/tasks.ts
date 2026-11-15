import { Router } from 'express'
import multer from 'multer'
import {
  assessmentSchema,
  blockerSchema,
  bulkTaskSchema,
  commentSchema,
  resolveBlockerSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
  templateSchema,
} from '@workpulse/shared'
import type { z } from 'zod'
import { prisma, type Prisma, type TaskStatus } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { assertAssignable, canEditTask, canManageUser, findEditableTask, findVisibleTask, taskScope, type Ctx } from '../lib/scope.js'
import { audit } from '../lib/audit.js'
import { env } from '../config/env.js'
import { ctxOf } from '../middleware/auth.js'
import { logActivity, recordChanges } from '../services/activity.js'
import { notify } from '../services/notify.js'
import { deleteFile, putFile, readLocal, signedUrl } from '../lib/storage.js'
import { queueOutbound } from '../integrations/outbound.js'
import { chooseAssignee, recordAssignment, type AssignmentDecision } from '../services/assignment.js'

export const tasks = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1 } })

const PRIORITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const

export const taskInclude = {
  assignee: { select: { id: true, name: true } },
  project: { select: { id: true, name: true, teamId: true } },
  source: { select: { provider: true, externalKey: true, sourceUrl: true, lastSyncedAt: true } },
  goals: { select: { goal: { select: { id: true, title: true } } } },
  _count: { select: { subtasks: true, comments: true, evidence: true, blockers: { where: { resolvedAt: null } } } },
} satisfies Prisma.TaskInclude

type TaskWithIncludes = Prisma.TaskGetPayload<{ include: typeof taskInclude }>
export const presentTask = (t: TaskWithIncludes, ctx: Ctx) => ({
  ...t,
  goals: t.goals.map((g) => g.goal),
  openBlockers: t._count.blockers,
  canEdit: canEditTask(ctx, t),
})

/** Status side effects: timestamps, reopen counting. Returns the fields to write. */
export function statusEffects(
  prev: { status: TaskStatus; startedAt: Date | null; completedAt: Date | null; reopenCount: number },
  next: TaskStatus,
  now = new Date(),
) {
  const data: Prisma.TaskUncheckedUpdateInput = { status: next }
  if (next === prev.status) return data
  if ((next === 'IN_PROGRESS' || next === 'IN_REVIEW') && !prev.startedAt) data.startedAt = now
  if (next === 'COMPLETED') {
    data.completedAt = now
    if (!prev.startedAt) data.startedAt = now
  }
  if (prev.status === 'COMPLETED' && next !== 'COMPLETED') {
    data.completedAt = null
    if (next !== 'CANCELLED') data.reopenCount = prev.reopenCount + 1
  }
  return data
}

/** Next due date for a recurring task. */
export function nextOccurrence(rule: string, from: Date) {
  const d = new Date(from)
  if (rule === 'DAILY') d.setUTCDate(d.getUTCDate() + 1)
  else if (rule === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7)
  else if (rule === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + 1)
  else if (rule === 'WEEKDAYS') {
    do d.setUTCDate(d.getUTCDate() + 1)
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  }
  return d
}

async function assertNoCycle(taskId: string, dependsOnIds: string[]) {
  // Walk "depends on" edges from each new dependency; reaching taskId means a cycle.
  const seen = new Set<string>()
  let frontier = [...dependsOnIds]
  while (frontier.length) {
    if (frontier.includes(taskId)) throw badRequest('This dependency would create a cycle.')
    frontier.forEach((id) => seen.add(id))
    const edges = await prisma.taskDependency.findMany({ where: { taskId: { in: frontier } }, select: { dependsOnId: true } })
    frontier = edges.map((e) => e.dependsOnId).filter((id) => !seen.has(id))
  }
}

async function assertRefs(
  ctx: Ctx,
  input: { projectId?: string | null; parentId?: string | null; goalIds?: string[]; dependsOnIds?: string[]; assigneeId?: string | null },
) {
  if (input.projectId && !(await prisma.project.findFirst({ where: { id: input.projectId, orgId: ctx.orgId, deletedAt: null } }))) throw notFound('Project')
  if (input.parentId) await findVisibleTask(ctx, input.parentId)
  if (input.goalIds?.length) {
    const n = await prisma.goal.count({ where: { id: { in: input.goalIds }, orgId: ctx.orgId, deletedAt: null } })
    if (n !== new Set(input.goalIds).size) throw notFound('Goal')
  }
  if (input.dependsOnIds?.length) {
    const n = await prisma.task.count({ where: { AND: [taskScope(ctx), { id: { in: input.dependsOnIds } }] } })
    if (n !== new Set(input.dependsOnIds).size) throw notFound('Dependency task')
  }
  if (input.assigneeId) await assertAssignable(ctx, input.assigneeId)
}

export async function createTask(ctx: Ctx, input: z.infer<typeof taskCreateSchema>, actor: 'USER' | 'AI' = 'USER', opts: { namedPerson?: string | null } = {}) {
  let decision: AssignmentDecision | null = null
  if (input.assigneeId === 'auto') {
    decision = await chooseAssignee(ctx.orgId, ctx.userId, {
      title: input.title,
      description: input.description,
      category: input.category,
      namedPerson: opts.namedPerson,
    })
    input = { ...input, assigneeId: decision.userId }
  }
  await assertRefs(ctx, input as { assigneeId?: string | null })
  const { goalIds, dependsOnIds, ...fields } = input as Omit<typeof input, 'assigneeId'> & { assigneeId?: string | null }
  const status = fields.status ?? 'TODO'
  const now = new Date()
  const task = await prisma.task.create({
    data: {
      ...fields,
      status,
      orgId: ctx.orgId,
      creatorId: ctx.userId,
      // Unassigned by default only when explicitly null; otherwise the creator owns it.
      assigneeId: fields.assigneeId === undefined ? ctx.userId : fields.assigneeId,
      startedAt: status === 'IN_PROGRESS' || status === 'COMPLETED' ? now : null,
      completedAt: status === 'COMPLETED' ? now : null,
      goals: goalIds?.length ? { create: goalIds.map((goalId) => ({ goalId })) } : undefined,
      dependsOn: dependsOnIds?.length ? { create: dependsOnIds.map((dependsOnId) => ({ dependsOnId })) } : undefined,
    },
    include: taskInclude,
  })
  await logActivity(task.id, 'created', actor, ctx.userId)
  if (decision) await recordAssignment(task.id, decision, ctx.userId)
  if (task.assigneeId && task.assigneeId !== ctx.userId) {
    await notify({
      orgId: ctx.orgId,
      userId: task.assigneeId,
      kind: 'task_assigned',
      title: `New task: ${task.title}`,
      link: `/tasks/${task.id}`,
      dedupeKey: `assigned:${task.id}:${task.assigneeId}`,
    })
  }
  return task
}

export async function updateTask(ctx: Ctx, id: string, input: z.infer<typeof taskUpdateSchema>) {
  const before = await findEditableTask(ctx, id)
  if (before.parentId === null && input.parentId === id) throw badRequest('A task cannot be its own parent.')
  let decision: AssignmentDecision | null = null
  if (input.assigneeId === 'auto') {
    decision = await chooseAssignee(ctx.orgId, ctx.userId, {
      title: input.title ?? before.title,
      description: input.description ?? before.description,
      category: input.category ?? before.category,
    })
    input = { ...input, assigneeId: decision.userId }
  }
  await assertRefs(ctx, { ...input, assigneeId: input.assigneeId !== before.assigneeId ? input.assigneeId : undefined })
  const { goalIds, dependsOnIds, archived, ...fields } = input
  // Impact and complexity are planning judgements: the owner may set them, but a manager's verified assessment lives elsewhere.
  const data: Prisma.TaskUncheckedUpdateInput = { ...fields }
  if (fields.status) Object.assign(data, statusEffects(before, fields.status))
  if (archived !== undefined) data.archivedAt = archived ? new Date() : null
  if (dependsOnIds) await assertNoCycle(id, dependsOnIds)

  const task = await prisma.$transaction(async (tx) => {
    if (goalIds) {
      await tx.taskGoal.deleteMany({ where: { taskId: id, goalId: { notIn: goalIds } } })
      await tx.taskGoal.createMany({ data: goalIds.map((goalId) => ({ taskId: id, goalId })), skipDuplicates: true })
    }
    if (dependsOnIds) {
      await tx.taskDependency.deleteMany({ where: { taskId: id } })
      await tx.taskDependency.createMany({ data: dependsOnIds.map((dependsOnId) => ({ taskId: id, dependsOnId })) })
    }
    return tx.task.update({ where: { id }, data, include: taskInclude })
  })
  await recordChanges(id, before, task, 'USER', ctx.userId)
  if (decision) await recordAssignment(id, decision, ctx.userId)

  if (fields.status === 'COMPLETED' && before.status !== 'COMPLETED' && before.recurrenceRule) {
    const due = nextOccurrence(before.recurrenceRule, before.dueAt ?? new Date())
    await createTask(ctx, {
      title: before.title,
      description: before.description,
      priority: before.priority,
      category: before.category,
      labels: before.labels,
      projectId: before.projectId,
      assigneeId: before.assigneeId,
      dueAt: due,
      estimateMins: before.estimateMins,
      impactLevel: before.impactLevel,
      complexity: before.complexity,
      recurrenceRule: before.recurrenceRule as 'DAILY',
    })
  }
  if (input.assigneeId && input.assigneeId !== before.assigneeId && input.assigneeId !== ctx.userId) {
    await notify({
      orgId: ctx.orgId,
      userId: input.assigneeId,
      kind: 'task_assigned',
      title: `Assigned to you: ${task.title}`,
      link: `/tasks/${id}`,
      dedupeKey: `assigned:${id}:${input.assigneeId}`,
    })
  }
  await queueOutbound(id, before, task)
  return task
}

// ───────────── Routes ─────────────

tasks.get('/tasks', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, taskListQuerySchema)
  const arr = <T>(v: T | T[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])
  const and: Prisma.TaskWhereInput[] = [taskScope(ctx)]
  and.push(q.archived ? { archivedAt: { not: null } } : { archivedAt: null })
  if (q.q)
    and.push({
      OR: [
        { title: { contains: q.q, mode: 'insensitive' } },
        { description: { contains: q.q, mode: 'insensitive' } },
        { source: { externalKey: { equals: q.q, mode: 'insensitive' } } },
      ],
    })
  if (q.status) and.push({ status: { in: arr(q.status) } })
  if (q.priority) and.push({ priority: { in: arr(q.priority) } })
  if (q.projectId) and.push({ projectId: q.projectId })
  if (q.assigneeId) and.push({ assigneeId: q.assigneeId === 'me' ? ctx.userId : q.assigneeId === 'none' ? null : q.assigneeId })
  if (q.goalId) and.push({ goals: { some: { goalId: q.goalId } } })
  if (q.category) and.push({ category: q.category })
  if (q.provider) and.push(q.provider === 'native' ? { origin: 'NATIVE' } : { source: { provider: q.provider } })
  if (q.dueFrom || q.dueTo) and.push({ dueAt: { gte: q.dueFrom, lte: q.dueTo } })
  if (q.parentId) and.push({ parentId: q.parentId === 'none' ? null : q.parentId })
  if (q.needsReview) and.push({ needsReview: true })
  const where = { AND: and }
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    q.sort === 'dueAt'
      ? [{ dueAt: { sort: 'asc', nulls: 'last' } }]
      : q.sort === 'priority'
        ? [{ priority: 'asc' }]
        : [{ [q.sort]: q.sort === 'sortOrder' ? 'asc' : 'desc' }]
  const [items, total] = await Promise.all([
    prisma.task.findMany({ where, include: taskInclude, orderBy: [...orderBy, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.task.count({ where }),
  ])
  res.json({ items: items.map((t) => presentTask(t, ctx)), page: q.page, pageSize: q.pageSize, total })
})

tasks.post('/tasks', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await createTask(ctx, body(req, taskCreateSchema))
  res.status(201).json({ task: presentTask(task, ctx) })
})

tasks.get('/tasks/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const id = param(req, 'id')
  await findVisibleTask(ctx, id)
  const task = await prisma.task.findUniqueOrThrow({
    where: { id },
    include: {
      ...taskInclude,
      creator: { select: { id: true, name: true } },
      parent: { select: { id: true, title: true } },
      subtasks: {
        where: { deletedAt: null },
        select: { id: true, title: true, status: true, assignee: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      },
      dependsOn: { select: { dependsOn: { select: { id: true, title: true, status: true } } } },
      blocking: { select: { task: { select: { id: true, title: true, status: true } } } },
      blockers: { orderBy: { createdAt: 'desc' } },
      attachments: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
      assessments: { select: { id: true, quality: true, impact: true, note: true, assessorId: true, createdAt: true } },
      conflicts: { where: { resolvedAt: null } },
      source: true,
    },
  })
  const { source, ...rest } = task
  res.json({
    task: {
      ...presentTask(task, ctx),
      ...rest,
      goals: task.goals.map((g) => g.goal),
      dependsOn: task.dependsOn.map((d) => d.dependsOn),
      blocking: task.blocking.map((d) => d.task),
      // rawSnapshot is shown to editors only (it can hold external fields KONVO does not map).
      source: source && {
        provider: source.provider,
        externalKey: source.externalKey,
        sourceUrl: source.sourceUrl,
        lastSyncedAt: source.lastSyncedAt,
        externalUpdatedAt: source.externalUpdatedAt,
        raw: canEditTask(ctx, task) ? source.rawSnapshot : undefined,
      },
      canAssess: Boolean(task.assigneeId && canManageUser(ctx, task.assigneeId)),
    },
  })
})

tasks.patch('/tasks/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await updateTask(ctx, param(req, 'id'), body(req, taskUpdateSchema))
  res.json({ task: presentTask(task, ctx) })
})

tasks.delete('/tasks/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await findEditableTask(ctx, param(req, 'id'))
  await prisma.task.update({ where: { id: task.id }, data: { deletedAt: new Date() } })
  await logActivity(task.id, 'deleted', 'USER', ctx.userId)
  await audit(req, ctx.orgId, 'task.delete', { type: 'Task', id: task.id }, { title: task.title })
  res.status(204).end()
})

tasks.post('/tasks/bulk', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, bulkTaskSchema)
  let updated = 0
  const skipped: string[] = []
  for (const id of input.ids) {
    try {
      if (input.action === 'delete') {
        const t = await findEditableTask(ctx, id)
        await prisma.task.update({ where: { id: t.id }, data: { deletedAt: new Date() } })
      } else {
        const v = input.value ?? null
        const patch =
          input.action === 'status'
            ? { status: v as TaskStatus }
            : input.action === 'priority'
              ? { priority: v as 'LOW' }
              : input.action === 'assign'
                ? { assigneeId: v }
                : input.action === 'project'
                  ? { projectId: v }
                  : { archived: true }
        await updateTask(ctx, id, taskUpdateSchema.parse(patch))
      }
      updated++
    } catch {
      skipped.push(id)
    }
  }
  res.json({ updated, skipped })
})

// ───────────── Comments & activity ─────────────

tasks.get('/tasks/:id/comments', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await findVisibleTask(ctx, param(req, 'id'))
  const comments = await prisma.taskComment.findMany({ where: { taskId: task.id, deletedAt: null }, orderBy: { createdAt: 'asc' } })
  const authors = await prisma.user.findMany({
    where: { id: { in: comments.flatMap((c) => (c.authorId ? [c.authorId] : [])) } },
    select: { id: true, name: true },
  })
  const names = new Map(authors.map((a) => [a.id, a.name]))
  res.json({ comments: comments.map((c) => ({ ...c, authorName: c.authorId ? names.get(c.authorId) : c.externalId ? 'External' : null })) })
})

tasks.post('/tasks/:id/comments', async (req, res) => {
  const ctx = ctxOf(req)
  // Anyone who can see a task may comment on it (mentors included).
  const task = await findVisibleTask(ctx, param(req, 'id'))
  const { body: text } = body(req, commentSchema)
  const comment = await prisma.taskComment.create({ data: { taskId: task.id, authorId: ctx.userId, body: text } })
  await logActivity(task.id, 'commented', 'USER', ctx.userId)
  for (const uid of new Set([task.assigneeId, task.creatorId])) {
    if (uid && uid !== ctx.userId)
      await notify({
        orgId: ctx.orgId,
        userId: uid,
        kind: 'comment',
        title: `New comment on ${task.title}`,
        link: `/tasks/${task.id}`,
        dedupeKey: `comment:${comment.id}:${uid}`,
      })
  }
  res.status(201).json({ comment })
})

tasks.delete('/tasks/:id/comments/:commentId', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await findVisibleTask(ctx, param(req, 'id'))
  const comment = await prisma.taskComment.findFirst({ where: { id: param(req, 'commentId'), taskId: task.id } })
  if (!comment) throw notFound('Comment')
  if (comment.authorId !== ctx.userId && !ctx.orgWide) throw forbidden()
  await prisma.taskComment.update({ where: { id: comment.id }, data: { deletedAt: new Date() } })
  res.status(204).end()
})

tasks.get('/tasks/:id/activity', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await findVisibleTask(ctx, param(req, 'id'))
  const items = await prisma.taskActivity.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'desc' }, take: 200 })
  const users = await prisma.user.findMany({ where: { id: { in: items.flatMap((i) => (i.actorId ? [i.actorId] : [])) } }, select: { id: true, name: true } })
  const names = new Map(users.map((u) => [u.id, u.name]))
  res.json({ activity: items.map((i) => ({ ...i, actorName: i.actorId ? (names.get(i.actorId) ?? null) : null })) })
})

// ───────────── Blockers ─────────────

tasks.post('/tasks/:id/blockers', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await findEditableTask(ctx, param(req, 'id'))
  const input = body(req, blockerSchema)
  const blocker = await prisma.blocker.create({ data: { orgId: ctx.orgId, taskId: task.id, reportedById: ctx.userId, ...input } })
  if (task.status !== 'BLOCKED') await updateTask(ctx, task.id, { status: 'BLOCKED' })
  await logActivity(task.id, 'blocker_reported', 'USER', ctx.userId, input.reason)
  // Tell the people who manage the assignee.
  const managers = await prisma.team.findMany({
    where: { orgId: ctx.orgId, members: { some: { userId: task.assigneeId ?? ctx.userId } }, managerId: { not: null } },
    select: { managerId: true },
  })
  for (const m of managers) {
    if (m.managerId && m.managerId !== ctx.userId)
      await notify({
        orgId: ctx.orgId,
        userId: m.managerId,
        kind: 'blocker',
        title: `Blocked: ${task.title}`,
        body: input.reason,
        link: `/tasks/${task.id}`,
        dedupeKey: `blocker:${blocker.id}:${m.managerId}`,
      })
  }
  res.status(201).json({ blocker })
})

tasks.post('/blockers/:id/resolve', async (req, res) => {
  const ctx = ctxOf(req)
  const blocker = await prisma.blocker.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId } })
  if (!blocker) throw notFound('Blocker')
  const task = await findEditableTask(ctx, blocker.taskId)
  const { resolution } = body(req, resolveBlockerSchema)
  await prisma.blocker.update({ where: { id: blocker.id }, data: { resolvedAt: new Date(), resolution: resolution ?? null } })
  const open = await prisma.blocker.count({ where: { taskId: task.id, resolvedAt: null } })
  if (!open && task.status === 'BLOCKED') await updateTask(ctx, task.id, { status: 'IN_PROGRESS' })
  await logActivity(task.id, 'blocker_resolved', 'USER', ctx.userId, resolution)
  res.json({ ok: true })
})

// ───────────── Attachments ─────────────

tasks.post('/tasks/:id/attachments', upload.single('file'), async (req, res) => {
  const ctx = ctxOf(req)
  const task = await findEditableTask(ctx, param(req, 'id'))
  if (!req.file) throw badRequest('Choose a file.')
  const key = await putFile(ctx.orgId, req.file.originalname, req.file.mimetype, req.file.buffer)
  const attachment = await prisma.attachment.create({
    data: {
      orgId: ctx.orgId,
      taskId: task.id,
      uploadedBy: ctx.userId,
      fileName: req.file.originalname.slice(0, 200),
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storageKey: key,
    },
  })
  await logActivity(task.id, 'attachment_added', 'USER', ctx.userId, attachment.fileName)
  res.status(201).json({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes } })
})

tasks.get('/attachments/:id/download', async (req, res) => {
  const ctx = ctxOf(req)
  const a = await prisma.attachment.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId } })
  if (!a) throw notFound('Attachment')
  await findVisibleTask(ctx, a.taskId)
  const url = await signedUrl(a.storageKey, a.fileName)
  if (url) return res.redirect(url)
  res.setHeader('Content-Type', a.mimeType)
  res.setHeader('Content-Disposition', `attachment; filename="${a.fileName.replace(/"/g, '')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.send(await readLocal(a.storageKey))
})

tasks.delete('/attachments/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const a = await prisma.attachment.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId } })
  if (!a) throw notFound('Attachment')
  await findEditableTask(ctx, a.taskId)
  await prisma.attachment.delete({ where: { id: a.id } })
  await deleteFile(a.storageKey)
  res.status(204).end()
})

// ───────────── Quality assessment (manager/admin on someone else's task) ─────────────

tasks.put('/tasks/:id/assessment', async (req, res) => {
  const ctx = ctxOf(req)
  const task = await findVisibleTask(ctx, param(req, 'id'))
  if (!task.assigneeId || !canManageUser(ctx, task.assigneeId))
    throw forbidden('Only the people who manage the assignee can assess this work (never their own).')
  if (task.status !== 'COMPLETED') throw conflict('Assess a task once it is completed.')
  const input = body(req, assessmentSchema)
  const row = await prisma.qualityAssessment.upsert({
    where: { taskId_assessorId: { taskId: task.id, assessorId: ctx.userId } },
    create: { orgId: ctx.orgId, taskId: task.id, assessorId: ctx.userId, quality: input.quality, impact: input.impact ?? null, note: input.note ?? null },
    update: { quality: input.quality, impact: input.impact ?? null, note: input.note ?? null },
  })
  await logActivity(task.id, 'assessed', 'USER', ctx.userId, String(input.quality))
  await audit(req, ctx.orgId, 'task.assess', { type: 'Task', id: task.id }, input)
  await notify({
    orgId: ctx.orgId,
    userId: task.assigneeId,
    kind: 'assessment',
    title: `Your work on "${task.title}" was assessed`,
    link: `/tasks/${task.id}`,
    dedupeKey: `assess:${row.id}:${row.quality}:${row.impact}`,
  })
  res.json({ assessment: row })
})

// ───────────── Templates ─────────────

tasks.get('/task-templates', async (req, res) => {
  const ctx = ctxOf(req)
  res.json({ templates: await prisma.taskTemplate.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } }) })
})

tasks.post('/task-templates', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, templateSchema)
  const tpl = await prisma.taskTemplate.create({
    data: { orgId: ctx.orgId, name: input.name, fields: input.fields as Prisma.InputJsonValue, createdBy: ctx.userId },
  })
  res.status(201).json({ template: tpl })
})

tasks.delete('/task-templates/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const tpl = await prisma.taskTemplate.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId } })
  if (!tpl) throw notFound('Template')
  if (tpl.createdBy !== ctx.userId && !ctx.orgWide) throw forbidden()
  await prisma.taskTemplate.delete({ where: { id: tpl.id } })
  res.status(204).end()
})

export { PRIORITY_ORDER }

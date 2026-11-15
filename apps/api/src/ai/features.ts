// Structured AI workflows. Each returns a validated suggestion or draft; none of them writes data on its own.
import { z } from 'zod'
import { IMPACT_LEVELS, PRIORITIES, TASK_STATUSES } from '@workpulse/shared'
import { prisma } from '../lib/prisma.js'
import { taskScope, type Ctx } from '../lib/scope.js'
import { notFound } from '../lib/errors.js'
import type { ReportContent } from '../services/reports.js'
import { structured } from './provider.js'

const GROUNDING = 'Use only the data given. Never invent records, ids, people, numbers or dates. If something is missing, say what is missing.'

// ───────────── Task drafting ─────────────

export const taskDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable(),
  priority: z.enum(PRIORITIES),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  category: z.string().max(60).nullable(),
  suggestedImpact: z.enum(IMPACT_LEVELS),
  estimateMins: z.number().int().min(0).max(10000).nullable(),
  subtasks: z.array(z.string().min(1).max(200)).max(12),
  rationale: z.string().max(600),
})

export async function draftTask(ctx: Ctx, text: string, today: string) {
  const categories = await prisma.task.findMany({
    where: { orgId: ctx.orgId, category: { not: null } },
    distinct: ['category'],
    select: { category: true },
    take: 30,
  })
  return structured({
    userId: ctx.userId,
    name: 'task_draft',
    system: `You turn a person's request into a task draft for a work tracker. Today is ${today}. Resolve relative dates ("Friday") against today. Existing categories: ${categories.map((c) => c.category).join(', ') || 'none'}; reuse one when it fits. suggestedImpact is only a suggestion about business value: NONE for chores, CRITICAL only for outcomes the business depends on. ${GROUNDING}`,
    input: text,
    schema: taskDraftSchema,
  })
}

export async function decomposeTask(ctx: Ctx, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { AND: [taskScope(ctx), { id: taskId }] },
    select: { title: true, description: true, subtasks: { select: { title: true } } },
  })
  if (!task) throw notFound('Task')
  return structured({
    userId: ctx.userId,
    name: 'task_decomposition',
    system: `Break the task into 2-8 concrete, independently completable subtasks, each one an outcome, not an activity. Skip subtasks that already exist. ${GROUNDING}`,
    input: JSON.stringify({ title: task.title, description: task.description, existingSubtasks: task.subtasks.map((s) => s.title) }),
    schema: z.object({
      subtasks: z.array(z.object({ title: z.string().min(1).max(200), estimateMins: z.number().int().min(0).max(2400).nullable() })).max(8),
      notes: z.string().max(500),
    }),
  })
}

export async function classifyTask(ctx: Ctx, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { AND: [taskScope(ctx), { id: taskId }] },
    select: { title: true, description: true, labels: true, goals: { select: { goal: { select: { id: true, title: true } } } } },
  })
  if (!task) throw notFound('Task')
  const goals = await prisma.goal.findMany({
    where: {
      orgId: ctx.orgId,
      deletedAt: null,
      status: { in: ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] },
      OR: [{ ownerId: ctx.userId }, { team: { members: { some: { userId: ctx.userId } } } }],
    },
    select: { id: true, title: true },
    take: 30,
  })
  const out = await structured({
    userId: ctx.userId,
    name: 'task_classification',
    system: `Classify a work item. complexity is 1 (trivial) to 5 (very complex). suggestedGoalIds must be ids from the goals list, or empty. ${GROUNDING}`,
    input: JSON.stringify({ task: { title: task.title, description: task.description, labels: task.labels }, goals }),
    schema: z.object({
      category: z.string().max(60),
      complexity: z.number().int().min(1).max(5),
      suggestedImpact: z.enum(IMPACT_LEVELS),
      suggestedGoalIds: z.array(z.string()).max(5),
      ambiguous: z.boolean(),
      rationale: z.string().max(600),
    }),
  })
  const allowed = new Set(goals.map((g) => g.id))
  return { ...out, suggestedGoalIds: out.suggestedGoalIds.filter((id) => allowed.has(id)) }
}

// ───────────── Planning & analysis ─────────────

export async function planDay(ctx: Ctx, date: string) {
  const open = await prisma.task.findMany({
    where: { AND: [taskScope(ctx), { assigneeId: ctx.userId, status: { in: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] }, archivedAt: null }] },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      impactLevel: true,
      dueAt: true,
      estimateMins: true,
      goals: { select: { goal: { select: { title: true } } } },
    },
    take: 60,
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }],
  })
  if (!open.length) return { topOutcomes: [], orderedTaskIds: [], warnings: ['You have no open tasks assigned to you.'], rationale: '' }
  const out = await structured({
    userId: ctx.userId,
    name: 'daily_plan',
    tier: 'assistant',
    system: `Plan the person's day (${date}). Choose up to 3 expected outcomes that create the most value: weigh impact, goal links and deadlines over quick wins; do not plan blocked tasks. orderedTaskIds must be ids from the list (at most 8, realistic for one day using estimates). Warnings: overdue items, overload, missing estimates. ${GROUNDING}`,
    input: JSON.stringify(open.map((t) => ({ ...t, goals: t.goals.map((g) => g.goal.title) }))),
    schema: z.object({
      topOutcomes: z.array(z.object({ text: z.string().min(1).max(300), taskId: z.string().nullable() })).max(3),
      orderedTaskIds: z.array(z.string()).max(8),
      warnings: z.array(z.string().max(300)).max(5),
      rationale: z.string().max(800),
    }),
  })
  const ids = new Set(open.map((t) => t.id))
  return {
    ...out,
    topOutcomes: out.topOutcomes.map((o) => ({ ...o, taskId: o.taskId && ids.has(o.taskId) ? o.taskId : null })),
    orderedTaskIds: out.orderedTaskIds.filter((id) => ids.has(id)),
  }
}

export async function analyzeWork(ctx: Ctx, kind: 'blockers' | 'deadline_risk' | 'weekly_summary', userId: string) {
  const since = new Date(Date.now() - 14 * 864e5)
  const tasks = await prisma.task.findMany({
    where: { AND: [taskScope(ctx), { assigneeId: userId, OR: [{ status: { notIn: ['COMPLETED', 'CANCELLED'] } }, { completedAt: { gte: since } }] }] },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      impactLevel: true,
      dueAt: true,
      completedAt: true,
      startedAt: true,
      estimateMins: true,
      actualMins: true,
      blockers: { select: { reason: true, kind: true, createdAt: true, resolvedAt: true } },
      activity: { where: { kind: 'carried_forward' }, select: { toValue: true } },
    },
    take: 80,
  })
  const out = await structured({
    userId: ctx.userId,
    name: `analysis_${kind}`,
    tier: 'assistant',
    system:
      kind === 'blockers'
        ? `Find patterns in the blockers and postponements: recurring causes, dependencies, items carried forward repeatedly. Suggest concrete next steps. Blockers are investigation signals, not performance judgements. ${GROUNDING}`
        : kind === 'deadline_risk'
          ? `Identify open tasks at risk of missing their due date (now: ${new Date().toISOString()}): consider remaining estimate, status, blockers, postponements. Each finding names a task id from the data. ${GROUNDING}`
          : `Write a factual weekly summary of the person's last 14 days: outcomes delivered (weight by impact, not count), what is in progress, blockers. Do not rate the person. ${GROUNDING}`,
    input: JSON.stringify(tasks),
    schema: z.object({
      summary: z.string().max(1500),
      findings: z.array(z.object({ taskId: z.string().nullable(), finding: z.string().max(400), suggestion: z.string().max(400) })).max(10),
      missingData: z.array(z.string().max(200)).max(5),
    }),
  })
  const ids = new Set(tasks.map((t) => t.id))
  return { ...out, findings: out.findings.map((f) => ({ ...f, taskId: f.taskId && ids.has(f.taskId) ? f.taskId : null })), basedOnTasks: tasks.length }
}

// ───────────── Evidence & reports ─────────────

export async function summarizeEvidence(userId: string, evidence: { title: string; kind: string; url: string | null; sourceMeta: unknown }) {
  const out = await structured({
    userId,
    name: 'evidence_summary',
    system: `Summarise what this evidence item shows in 1-2 sentences. Say what it does NOT prove (a merged pull request does not prove business value). ${GROUNDING}`,
    input: JSON.stringify(evidence),
    schema: z.object({ summary: z.string().max(500) }),
  })
  return out.summary
}

/** Suggests which task a provider item (PR, commit, release) belongs to. Returned as a suggestion; a person applies it. */
export async function suggestEvidenceMatch(
  userId: string,
  item: { title: string; meta: unknown },
  candidates: { id: string; title: string; key: string | null }[],
) {
  if (!candidates.length) return null
  const out = await structured({
    userId,
    name: 'evidence_match',
    system: `Pick the task this code change most likely belongs to, or null when unsure. taskId must be one of the candidate ids. confidence 0-1. ${GROUNDING}`,
    input: JSON.stringify({ item, candidates }),
    schema: z.object({ taskId: z.string().nullable(), confidence: z.number().min(0).max(1), reason: z.string().max(300) }),
  })
  return out.taskId && candidates.some((c) => c.id === out.taskId) ? out : null
}

export async function summarizeReport(userId: string, content: ReportContent) {
  const out = await structured({
    userId,
    name: 'report_summary',
    system: `Write a 2-4 sentence summary of this work report for the person and their manager. Lead with value delivered. Mention blockers plainly. No ratings, no praise or blame. ${GROUNDING}`,
    input: JSON.stringify(content),
    schema: z.object({ summary: z.string().max(800) }),
  })
  return out.summary
}

// ───────────── Sync mapping suggestions ─────────────

export async function suggestMapping(userId: string, provider: string, kind: 'STATUS' | 'PRIORITY', fromValue: string) {
  const targets = kind === 'STATUS' ? TASK_STATUSES : PRIORITIES
  return structured({
    userId,
    name: 'mapping_suggestion',
    system: `Map a ${provider} ${kind.toLowerCase()} value to WorkPulse's fixed set: ${targets.join(', ')}. confidence 0-1; below 0.6 when the value is ambiguous. ${GROUNDING}`,
    input: JSON.stringify({ provider, kind, value: fromValue }),
    schema: z.object({ toValue: z.enum(targets as unknown as [string, ...string[]]), confidence: z.number().min(0).max(1), reason: z.string().max(300) }),
  })
}

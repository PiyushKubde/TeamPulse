// The assistant. The model never touches the database: each turn it either answers or asks for ONE tool from the
// fixed list below; WorkPulse validates the arguments, runs the tool under the caller's own permissions and sends
// the result back. All tools read, except create_task, which creates a task under the caller's own permissions and
// assigns it automatically (named person, else best fit).
import { z } from 'zod'
import { TASK_STATUSES, type ScoreDimension } from '@workpulse/shared'
import { prisma, type Prisma } from '../lib/prisma.js'
import { assertCanSeeUser, scopedUserIds, taskScope, type Ctx } from '../lib/scope.js'
import { HttpError } from '../lib/errors.js'
import { computeScore, impactTarget, loadScoreInput, modelFor } from '../services/performance.js'
import { structured } from './provider.js'
import { createTask } from '../modules/tasks.js'

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const who = z.union([z.literal('me'), uuid]).default('me')

const resolveUser = (ctx: Ctx, w: string) => {
  const id = w === 'me' ? ctx.userId : w
  assertCanSeeUser(ctx, id)
  return id
}
const range = (from?: string, to?: string) => ({
  from: from ? new Date(`${from}T00:00:00Z`) : new Date(Date.now() - 7 * 864e5),
  to: to ? new Date(`${to}T23:59:59Z`) : new Date(),
})

const taskFields = {
  id: true,
  title: true,
  status: true,
  priority: true,
  impactLevel: true,
  dueAt: true,
  completedAt: true,
  estimateMins: true,
  actualMins: true,
  assignee: { select: { name: true } },
  project: { select: { name: true } },
} satisfies Prisma.TaskSelect

export const TOOLS = {
  list_tasks: {
    description: 'Tasks of a person ("me" or a user id), filtered by status and by completion or due date range.',
    args: z.object({
      user: who,
      status: z.array(z.enum(TASK_STATUSES)).optional(),
      completedFrom: date.optional(),
      completedTo: date.optional(),
      dueBefore: date.optional(),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    run: async (ctx: Ctx, a: { user: string; status?: string[]; completedFrom?: string; completedTo?: string; dueBefore?: string; limit: number }) => {
      const userId = resolveUser(ctx, a.user)
      const where: Prisma.TaskWhereInput = {
        AND: [
          taskScope(ctx),
          { assigneeId: userId, status: a.status ? { in: a.status as never } : undefined },
          a.completedFrom || a.completedTo
            ? {
                completedAt: {
                  gte: a.completedFrom ? new Date(a.completedFrom) : undefined,
                  lte: a.completedTo ? new Date(`${a.completedTo}T23:59:59Z`) : undefined,
                },
              }
            : {},
          a.dueBefore ? { dueAt: { lte: new Date(`${a.dueBefore}T23:59:59Z`) } } : {},
        ],
      }
      return prisma.task.findMany({ where, select: taskFields, take: a.limit, orderBy: { updatedAt: 'desc' } })
    },
  },
  get_task: {
    description: 'One task with its blockers, evidence, goal links and recent activity.',
    args: z.object({ id: uuid }),
    run: async (ctx: Ctx, a: { id: string }) =>
      prisma.task.findFirst({
        where: { AND: [taskScope(ctx), { id: a.id }] },
        select: {
          ...taskFields,
          description: true,
          blockers: { select: { reason: true, kind: true, resolvedAt: true } },
          evidence: { where: { deletedAt: null }, select: { title: true, kind: true, status: true } },
          goals: { select: { goal: { select: { title: true } } } },
          activity: { take: 15, orderBy: { createdAt: 'desc' }, select: { kind: true, field: true, fromValue: true, toValue: true, createdAt: true } },
        },
      }),
  },
  list_goals: {
    description: 'Goals of a person with progress and status; active only by default.',
    args: z.object({ user: who, includeClosed: z.boolean().default(false) }),
    run: async (ctx: Ctx, a: { user: string; includeClosed: boolean }) =>
      prisma.goal.findMany({
        where: {
          orgId: ctx.orgId,
          deletedAt: null,
          ownerId: resolveUser(ctx, a.user),
          ...(a.includeClosed ? {} : { status: { in: ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] } }),
        },
        select: { id: true, title: true, period: true, progress: true, status: true, dueDate: true, expectedOutcome: true },
      }),
  },
  get_performance: {
    description: 'Explainable performance dimensions for a person over a date range (default last 7 days), including missing data.',
    args: z.object({ user: who, from: date.optional(), to: date.optional() }),
    run: async (ctx: Ctx, a: { user: string; from?: string; to?: string }) => {
      const userId = resolveUser(ctx, a.user)
      const { from, to } = range(a.from, a.to)
      const m = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } } })
      const model = await modelFor(ctx.orgId, m?.role)
      return computeScore(
        { ...(await loadScoreInput(ctx.orgId, [userId], from, to)), impactTargetPerWeek: await impactTarget(ctx.orgId) },
        model.weights as Record<ScoreDimension, number>,
      )
    },
  },
  team_overview: {
    description: 'Managers and admins only: per-person open tasks, in-progress count, blockers, overdue and completed impact for a team (or everyone visible).',
    args: z.object({ teamId: uuid.optional(), from: date.optional(), to: date.optional() }),
    run: async (ctx: Ctx, a: { teamId?: string; from?: string; to?: string }) => {
      if (!ctx.orgWide && ctx.role !== 'MANAGER') throw new HttpError(403, 'forbidden', 'team_overview is for managers and admins.')
      const ids = (await scopedUserIds(ctx, { teamId: a.teamId })).filter((id) => id !== ctx.userId)
      const { from, to } = range(a.from, a.to)
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      const tasks = await prisma.task.findMany({
        where: {
          orgId: ctx.orgId,
          deletedAt: null,
          assigneeId: { in: ids },
          OR: [{ status: { notIn: ['COMPLETED', 'CANCELLED'] } }, { completedAt: { gte: from, lte: to } }],
        },
        select: { assigneeId: true, status: true, dueAt: true, impactLevel: true, estimateMins: true },
      })
      const now = new Date()
      return users.map((u) => {
        const mine = tasks.filter((t) => t.assigneeId === u.id)
        const open = mine.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED')
        return {
          userId: u.id,
          name: u.name,
          openTasks: open.length,
          inProgress: open.filter((t) => t.status === 'IN_PROGRESS').length,
          blocked: open.filter((t) => t.status === 'BLOCKED').length,
          overdue: open.filter((t) => t.dueAt && t.dueAt < now).length,
          openEstimateHours: Math.round(open.reduce((s, t) => s + (t.estimateMins ?? 0), 0) / 60),
          completedHighImpact: mine.filter((t) => t.status === 'COMPLETED' && (t.impactLevel === 'HIGH' || t.impactLevel === 'CRITICAL')).length,
        }
      })
    },
  },
  list_blockers: {
    description: 'Open and recently resolved blockers of a person.',
    args: z.object({ user: who }),
    run: async (ctx: Ctx, a: { user: string }) =>
      prisma.blocker.findMany({
        where: {
          orgId: ctx.orgId,
          task: { assigneeId: resolveUser(ctx, a.user) },
          OR: [{ resolvedAt: null }, { resolvedAt: { gte: new Date(Date.now() - 30 * 864e5) } }],
        },
        select: { reason: true, kind: true, createdAt: true, resolvedAt: true, task: { select: { id: true, title: true } } },
      }),
  },
  list_postponed: {
    description: 'Tasks that were carried forward or had their due date moved more than once.',
    args: z.object({ user: who }),
    run: async (ctx: Ctx, a: { user: string }) => {
      const rows = await prisma.taskActivity.groupBy({
        by: ['taskId'],
        where: { task: { orgId: ctx.orgId, assigneeId: resolveUser(ctx, a.user), deletedAt: null }, OR: [{ kind: 'carried_forward' }, { field: 'dueAt' }] },
        _count: true,
        having: { taskId: { _count: { gt: 1 } } },
      })
      const tasks = await prisma.task.findMany({ where: { id: { in: rows.map((r) => r.taskId) } }, select: taskFields })
      return tasks.map((t) => ({ ...t, postponements: rows.find((r) => r.taskId === t.id)?._count }))
    },
  },
  effort_breakdown: {
    description: 'Tracked work-session minutes of a person by project and category over a range. Effort is not productivity.',
    args: z.object({ user: who, from: date.optional(), to: date.optional() }),
    run: async (ctx: Ctx, a: { user: string; from?: string; to?: string }) => {
      const { from, to } = range(a.from, a.to)
      const sessions = await prisma.workSession.findMany({
        where: { orgId: ctx.orgId, userId: resolveUser(ctx, a.user), startedAt: { gte: from, lte: to }, endedAt: { not: null } },
        select: { startedAt: true, endedAt: true, task: { select: { title: true, category: true, project: { select: { name: true } } } } },
      })
      const by = new Map<string, number>()
      for (const s of sessions) {
        const k = s.task?.project?.name ?? s.task?.category ?? 'Not linked to a task'
        by.set(k, (by.get(k) ?? 0) + Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 60000))
      }
      return { trackedSessions: sessions.length, minutesBy: Object.fromEntries(by) }
    },
  },
  search_evidence: {
    description: 'Evidence attached to a person’s tasks, with verification status.',
    args: z.object({ user: who, limit: z.number().int().min(1).max(30).default(15) }),
    run: async (ctx: Ctx, a: { user: string; limit: number }) =>
      prisma.evidence.findMany({
        where: { orgId: ctx.orgId, deletedAt: null, task: { assigneeId: resolveUser(ctx, a.user) } },
        select: { title: true, kind: true, status: true, url: true, createdAt: true, task: { select: { id: true, title: true } } },
        orderBy: { createdAt: 'desc' },
        take: a.limit,
      }),
  },
  create_task: {
    description:
      'Create a task now (it is saved immediately) and assign it automatically. Put a person in assigneeName only if the user named who should do it; otherwise leave it null and WorkPulse picks the best-fit teammate. Use one call per task.',
    args: z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(4000).nullable().default(null),
      priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
      dueDate: date.nullable().default(null),
      category: z.string().max(60).nullable().default(null),
      impact: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('NONE'),
      estimateMins: z.number().int().min(0).max(10000).nullable().default(null),
      assigneeName: z.string().max(200).nullable().default(null),
    }),
    run: async (
      ctx: Ctx,
      a: {
        title: string
        description: string | null
        priority: 'MEDIUM'
        dueDate: string | null
        category: string | null
        impact: 'NONE'
        estimateMins: number | null
        assigneeName: string | null
      },
    ) => {
      const task = await createTask(
        ctx,
        {
          title: a.title,
          description: a.description,
          priority: a.priority,
          dueAt: a.dueDate ? new Date(`${a.dueDate}T17:00:00`) : null,
          category: a.category,
          impactLevel: a.impact,
          estimateMins: a.estimateMins,
          assigneeId: 'auto',
        },
        'AI',
        { namedPerson: a.assigneeName },
      )
      const why = await prisma.taskActivity.findFirst({ where: { taskId: task.id, kind: 'auto_assigned' }, select: { toValue: true } })
      return {
        created: {
          id: task.id,
          title: task.title,
          assignee: task.assignee?.name ?? null,
          dueAt: task.dueAt,
          priority: task.priority,
          why: why?.toValue ?? null,
        },
      }
    },
  },
} as const

type ToolName = keyof typeof TOOLS
const TOOL_NAMES = Object.keys(TOOLS) as [ToolName, ...ToolName[]]

const turnSchema = z.object({
  type: z.enum(['tool_call', 'answer']),
  tool: z.enum(TOOL_NAMES).nullable(),
  /** The tool's arguments as a JSON string (validated per tool). */
  arguments: z.string().max(4000).nullable(),
  answer: z.string().max(6000).nullable(),
})

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function runAssistant(ctx: Ctx, history: ChatMessage[], message: string, userName: string) {
  const today = new Date().toISOString().slice(0, 10)
  const system = [
    `You are WorkPulse's work assistant for ${userName} (role ${ctx.role}). Today is ${today}.`,
    'Answer only from tool results. Never invent tasks, people, numbers or dates; if the data is missing, say exactly what is missing.',
    'WorkPulse measures value, not volume: weigh impact and outcomes over task counts; hours are effort, not productivity. Blockers and workload signals are prompts to investigate, never verdicts on a person. You never rate people.',
    'Each turn return either {type:"tool_call", tool, arguments (JSON string)} or {type:"answer", answer}. One tool per turn. Use "me" for the current user.',
    'Tools:',
    ...TOOL_NAMES.map((n) => `- ${n}: ${TOOLS[n].description} Arguments JSON schema: ${JSON.stringify(z.toJSONSchema(TOOLS[n].args))}`),
    'When the user asks for work to be done ("I need to…", "create a task…", "assign…"), call create_task right away without asking for confirmation; split clearly separate pieces of work into separate tasks. Afterwards say what was created, who it was assigned to and why.',
    'Answer in short markdown. Mention task titles, not ids.',
  ].join('\n')

  const transcript: string[] = history.slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
  transcript.push(`User: ${message}`)
  const toolsUsed: { tool: string; ok: boolean }[] = []
  const created: { id: string; title: string; assignee: string | null; why: string | null }[] = []

  for (let step = 0; step < 6; step++) {
    const turn = await structured({ userId: ctx.userId, name: 'assistant_turn', tier: 'assistant', system, input: transcript.join('\n\n'), schema: turnSchema })
    if (turn.type === 'answer' || !turn.tool) return { answer: turn.answer ?? 'I could not produce an answer.', toolsUsed, created }
    const tool = TOOLS[turn.tool]
    let result: unknown
    try {
      const args = tool.args.parse(JSON.parse(turn.arguments ?? '{}'))
      result = await (tool.run as (c: Ctx, a: unknown) => Promise<unknown>)(ctx, args)
      if (turn.tool === 'create_task') created.push((result as { created: (typeof created)[number] }).created)
      toolsUsed.push({ tool: turn.tool, ok: true })
    } catch (e) {
      // Out-of-scope people answer "not found": the assistant can never reach data the caller cannot.
      result = { error: e instanceof HttpError ? e.message : 'Invalid arguments for this tool.' }
      toolsUsed.push({ tool: turn.tool, ok: false })
    }
    transcript.push(`Assistant called ${turn.tool}(${turn.arguments})`, `Tool result: ${JSON.stringify(result).slice(0, 12000)}`)
  }
  return { answer: 'I needed too many steps to answer that. Try a narrower question.', toolsUsed, created }
}

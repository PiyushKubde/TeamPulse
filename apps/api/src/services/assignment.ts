// Automatic assignment. Used by every source: the task form ("Auto-assign"), the AI assistant, Slack messages and
// Linear/Jira/GitHub imports. A named person wins when the requester may assign them; otherwise AI picks the best fit
// from the people the requester may assign to (role, team, recent work, current load); without AI a keyword and
// workload rule decides. The choice and its reason are written to the task's activity, so it is always explainable.
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { buildCtx } from '../lib/scope.js'
import { logger } from '../config/logger.js'
import { aiStatus, structured } from '../ai/provider.js'

export interface AssignmentDecision {
  userId: string
  reason: string
  by: 'NAMED' | 'AI' | 'RULES' | 'SELF'
}

interface Candidate {
  userId: string
  name: string
  role: string
  title: string | null
  teams: string[]
  recent: string[]
  openTasks: number
  openHours: number
}

const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(sir|madam|ma'am|mr|ms|mrs|ji)\b\.?/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Exact, then unique partial (first name or contained) match; null when ambiguous or absent. */
export function matchMember(name: string | null | undefined, members: { userId: string; name: string }[]) {
  if (!name) return null
  const n = normalizeName(name)
  if (!n) return null
  const exact = members.filter((m) => m.name.toLowerCase() === n)
  if (exact.length === 1) return exact[0]!.userId
  const partial = members.filter((m) => {
    const full = m.name.toLowerCase()
    return full.includes(n) || n.includes(full) || full.split(' ')[0] === n.split(' ')[0]
  })
  return partial.length === 1 ? partial[0]!.userId : null
}

/** People the requester may assign work to: org-wide roles everyone, managers their teams' members, others themselves. */
async function assignableIds(orgId: string, requesterId: string) {
  const ctx = await buildCtx(requesterId, orgId)
  if (!ctx) return [requesterId]
  if (ctx.orgWide) return [...ctx.orgMemberIds]
  return [requesterId, ...ctx.managedUserIds]
}

async function profiles(orgId: string, ids: string[]): Promise<Candidate[]> {
  const since = new Date(Date.now() - 90 * 864e5)
  const members = await prisma.organizationMember.findMany({
    where: { orgId, userId: { in: ids }, status: 'ACTIVE' },
    select: {
      userId: true,
      role: true,
      title: true,
      user: { select: { name: true, teamMembers: { select: { team: { select: { name: true, orgId: true } } } } } },
    },
  })
  const [done, open] = await Promise.all([
    prisma.task.findMany({
      where: { orgId, assigneeId: { in: ids }, status: 'COMPLETED', completedAt: { gte: since }, deletedAt: null },
      select: { assigneeId: true, title: true, category: true },
      orderBy: { completedAt: 'desc' },
      take: 400,
    }),
    prisma.task.groupBy({
      by: ['assigneeId'],
      where: { orgId, assigneeId: { in: ids }, deletedAt: null, archivedAt: null, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      _count: true,
      _sum: { estimateMins: true },
    }),
  ])
  return members.map((m) => {
    const load = open.find((o) => o.assigneeId === m.userId)
    return {
      userId: m.userId,
      name: m.user.name,
      role: m.role,
      title: m.title,
      teams: m.user.teamMembers
        .map((t) => t.team)
        .filter((t) => t.orgId === orgId)
        .map((t) => t.name),
      recent: done
        .filter((d) => d.assigneeId === m.userId)
        .slice(0, 8)
        .map((d) => (d.category ? `${d.title} [${d.category}]` : d.title)),
      openTasks: load?._count ?? 0,
      openHours: Math.round((load?._sum.estimateMins ?? 0) / 60),
    }
  })
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])

/** Rule-based choice: overlap between the task's words and each person's title/team/recent work, minus load. */
export function ruleBasedChoice(text: string, candidates: Candidate[]) {
  const t = words(text)
  let best: { c: Candidate; score: number } | null = null
  for (const c of candidates) {
    const profile = words([c.title ?? '', ...c.teams, ...c.recent].join(' '))
    let overlap = 0
    for (const w of t) if (profile.has(w)) overlap++
    // Execution work goes to individual contributors before managers; heavy load lowers the score.
    const score = overlap * 3 - c.openTasks * 0.5 - (c.role === 'MEMBER' || c.role === 'MENTOR' ? 0 : 2)
    if (!best || score > best.score) best = { c, score }
  }
  return best?.c ?? null
}

const pickSchema = z.object({ userId: z.string().nullable(), reason: z.string().max(300) })

export async function chooseAssignee(
  orgId: string,
  requesterId: string,
  task: { title: string; description?: string | null; namedPerson?: string | null; category?: string | null },
): Promise<AssignmentDecision> {
  const ids = await assignableIds(orgId, requesterId)
  const candidates = await profiles(orgId, ids)
  if (task.namedPerson) {
    const all = await prisma.organizationMember.findMany({ where: { orgId, status: 'ACTIVE' }, select: { userId: true, user: { select: { name: true } } } })
    const named = matchMember(
      task.namedPerson,
      all.map((m) => ({ userId: m.userId, name: m.user.name })),
    )
    if (named && ids.includes(named)) return { userId: named, reason: `Asked for ${task.namedPerson}.`, by: 'NAMED' }
  }
  if (candidates.length <= 1) return { userId: requesterId, reason: 'You can only assign work to yourself.', by: 'SELF' }

  const text = [task.title, task.description, task.category].filter(Boolean).join('\n')
  if (aiStatus().configured) {
    try {
      const pick = await structured({
        userId: requesterId,
        name: 'auto_assign',
        system: [
          'Choose the one person who should own this task. Consider, in order: whose role, title and team fit the work; who has recently done similar work; who has capacity (fewer open tasks and estimated hours).',
          'Prefer individual contributors for execution work; give managers only management work (planning, hiring, reviews, decisions).',
          'userId must be one of the candidate ids. The reason is one short sentence a manager would accept, naming the deciding factor.',
          task.namedPerson ? `The request mentioned "${task.namedPerson}", who is not someone the requester can assign; choose the best alternative.` : '',
        ].join('\n'),
        input: JSON.stringify({ task: text.slice(0, 3000), candidates }),
        schema: pickSchema,
      })
      if (pick.userId && ids.includes(pick.userId)) return { userId: pick.userId, reason: pick.reason, by: 'AI' }
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e }, 'AI assignment failed; using rules')
    }
  }
  const c = ruleBasedChoice(text, candidates)
  if (!c) return { userId: requesterId, reason: 'No better fit found.', by: 'SELF' }
  return { userId: c.userId, reason: `Closest match to ${c.name}'s recent work and current load (${c.openTasks} open tasks).`, by: 'RULES' }
}

/** Writes the decision to the task's history so anyone can see who chose the assignee and why. */
export async function recordAssignment(taskId: string, d: AssignmentDecision, actorId: string | null) {
  const who = await prisma.user.findUnique({ where: { id: d.userId }, select: { name: true } })
  await prisma.taskActivity.create({
    data: {
      taskId,
      kind: 'auto_assigned',
      actorType: d.by === 'AI' ? 'AI' : d.by === 'NAMED' ? 'USER' : 'SYSTEM',
      actorId,
      toValue: `${who?.name ?? 'Someone'}: ${d.reason}`.slice(0, 500),
    },
  })
}

// Tenant and role scope. Every query on tenant-owned data goes through these helpers, so orgId and the caller's
// visibility are always applied server-side. Nothing here is read from the request body.
import type { Prisma, Role } from '../generated/prisma/client.js'
import { prisma } from './prisma.js'
import { forbidden, notFound } from './errors.js'

export interface Ctx {
  userId: string
  orgId: string
  role: Role
  /** OWNER or ADMIN: whole organization. */
  orgWide: boolean
  managedTeamIds: string[]
  /** People whose work this user may change/assess (self excluded). Empty for members and mentors. */
  managedUserIds: string[]
  /** People whose work this user may read: self + managed + mentees. null = everyone in the org. */
  visibleUserIds: string[] | null
  menteeIds: string[]
  /** Org-wide roles only: every member of this org (so "everyone" never reaches people of another org). */
  orgMemberIds: Set<string>
}

export async function buildCtx(userId: string, orgId: string): Promise<Ctx | null> {
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId, userId } } })
  if (!member || member.status !== 'ACTIVE') return null
  const orgWide = member.role === 'OWNER' || member.role === 'ADMIN'
  if (orgWide) {
    const all = await prisma.organizationMember.findMany({ where: { orgId }, select: { userId: true } })
    return {
      userId,
      orgId,
      role: member.role,
      orgWide,
      managedTeamIds: [],
      managedUserIds: [],
      visibleUserIds: null,
      menteeIds: [],
      orgMemberIds: new Set(all.map((m) => m.userId)),
    }
  }
  const [teams, mentees] = await Promise.all([
    member.role === 'MANAGER'
      ? prisma.team.findMany({ where: { orgId, managerId: userId }, select: { id: true, members: { select: { userId: true } } } })
      : Promise.resolve([]),
    prisma.mentorAssignment.findMany({ where: { orgId, mentorId: userId }, select: { menteeId: true } }),
  ])
  const managedUserIds = [...new Set(teams.flatMap((t) => t.members.map((m) => m.userId)))].filter((id) => id !== userId)
  const menteeIds = mentees.map((m) => m.menteeId)
  return {
    userId,
    orgId,
    role: member.role,
    orgWide,
    managedTeamIds: teams.map((t) => t.id),
    managedUserIds,
    menteeIds,
    visibleUserIds: [...new Set([userId, ...managedUserIds, ...menteeIds])],
    orgMemberIds: new Set(),
  }
}

export const canSeeUser = (ctx: Ctx, userId: string) => (ctx.visibleUserIds === null ? ctx.orgMemberIds.has(userId) : ctx.visibleUserIds.includes(userId))
/** Change, assess or verify someone's work: admins for anyone, managers for their teams' members. Never own work. */
export const canManageUser = (ctx: Ctx, userId: string) =>
  userId !== ctx.userId && (ctx.orgWide ? ctx.orgMemberIds.has(userId) : ctx.managedUserIds.includes(userId))

export function assertCanSeeUser(ctx: Ctx, userId: string) {
  if (!canSeeUser(ctx, userId)) throw notFound('Person')
}
export function assertManager(ctx: Ctx) {
  if (!ctx.orgWide && ctx.role !== 'MANAGER') throw forbidden()
}
export function assertAdmin(ctx: Ctx) {
  if (!ctx.orgWide) throw forbidden()
}

export function taskScope(ctx: Ctx): Prisma.TaskWhereInput {
  if (ctx.visibleUserIds === null) return { orgId: ctx.orgId, deletedAt: null }
  const or: Prisma.TaskWhereInput[] = [{ assigneeId: { in: ctx.visibleUserIds } }, { creatorId: ctx.userId }]
  if (ctx.managedTeamIds.length) or.push({ project: { teamId: { in: ctx.managedTeamIds } } })
  return { orgId: ctx.orgId, deletedAt: null, OR: or }
}

interface TaskLike {
  orgId: string
  assigneeId: string | null
  creatorId: string
  project?: { teamId: string | null } | null
}

export function canEditTask(ctx: Ctx, task: TaskLike) {
  if (task.orgId !== ctx.orgId) return false
  if (ctx.orgWide) return true
  if (task.assigneeId === ctx.userId || task.creatorId === ctx.userId) return true
  if (task.assigneeId && ctx.managedUserIds.includes(task.assigneeId)) return true
  return Boolean(task.project?.teamId && ctx.managedTeamIds.includes(task.project.teamId))
}

/** Loads a task the caller can see, or answers 404. */
export async function findVisibleTask(ctx: Ctx, id: string) {
  const task = await prisma.task.findFirst({ where: { AND: [taskScope(ctx), { id }] }, include: { project: { select: { teamId: true } } } })
  if (!task) throw notFound('Task')
  return task
}

export async function findEditableTask(ctx: Ctx, id: string) {
  const task = await findVisibleTask(ctx, id)
  if (!canEditTask(ctx, task)) throw forbidden('You can view this task but not change it.')
  return task
}

/** Assignee must be an active member the caller is allowed to assign to. */
export async function assertAssignable(ctx: Ctx, userId: string) {
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } } })
  if (!member || member.status !== 'ACTIVE') throw notFound('Assignee')
  if (userId === ctx.userId || ctx.orgWide || ctx.managedUserIds.includes(userId)) return
  throw forbidden('You can assign work only to yourself or to people you manage.')
}

export function projectScope(ctx: Ctx): Prisma.ProjectWhereInput {
  // Projects are org-wide reference data: every member can see project names and progress.
  return { orgId: ctx.orgId, deletedAt: null }
}

export function goalScope(ctx: Ctx): Prisma.GoalWhereInput {
  if (ctx.visibleUserIds === null) return { orgId: ctx.orgId, deletedAt: null }
  const or: Prisma.GoalWhereInput[] = [{ ownerId: { in: ctx.visibleUserIds } }]
  if (ctx.managedTeamIds.length) or.push({ teamId: { in: ctx.managedTeamIds } })
  // Team goals of teams I belong to.
  or.push({ team: { members: { some: { userId: ctx.userId } } } })
  return { orgId: ctx.orgId, deletedAt: null, OR: or }
}

export function canEditGoal(ctx: Ctx, goal: { ownerId: string; teamId: string | null }) {
  return (
    ctx.orgWide || goal.ownerId === ctx.userId || Boolean(goal.teamId && ctx.managedTeamIds.includes(goal.teamId)) || ctx.managedUserIds.includes(goal.ownerId)
  )
}

/** User ids for an analytics query, intersected with what the caller may see. */
export async function scopedUserIds(ctx: Ctx, opts: { teamId?: string; userId?: string }) {
  let ids: string[]
  if (opts.userId) {
    assertCanSeeUser(ctx, opts.userId)
    ids = [opts.userId]
  } else if (opts.teamId) {
    const team = await prisma.team.findFirst({ where: { id: opts.teamId, orgId: ctx.orgId }, select: { members: { select: { userId: true } } } })
    if (!team) throw notFound('Team')
    ids = team.members.map((m) => m.userId)
  } else {
    ids = (await prisma.organizationMember.findMany({ where: { orgId: ctx.orgId, status: 'ACTIVE' }, select: { userId: true } })).map((m) => m.userId)
  }
  return ctx.visibleUserIds === null ? ids : ids.filter((id) => ctx.visibleUserIds!.includes(id))
}

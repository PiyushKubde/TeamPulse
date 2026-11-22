// Company transparency: one open view of how the whole organization is doing, from the CEO down.
//  - /company/overview  every person's scorecard (value score, goal progress, KPI attainment), the reporting tree
//                       with roll-ups, and departments with roll-ups. Peers, mentors, managers and departments
//                       are compared from this one payload.
//  - /company/people/:id a person's full scorecard: dimensions, goals with key results, KPIs with their trend,
//                       the chain above them, their reports and their peers.
//  - /company/cascade   the goal tree (company objectives down to individuals) with KPIs under each objective.
//  - /kpis              KPIs for everyone, CEO included.
// Everything here is READ-ONLY for other people's work: it never exposes tasks, evidence or comments, and it does not
// change who may edit what. Organizations can switch transparency to PRIVATE (settings.transparency); then people see
// only the lines they could already see.
import { Router } from 'express'
import { z } from 'zod'
import { DEFAULT_WEIGHTS, kpiReadingSchema, kpiSchema, kpiUpdateSchema, type ScoreDimension } from '@workpulse/shared'
import { prisma, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { canManageUser, type Ctx } from '../lib/scope.js'
import { audit } from '../lib/audit.js'
import { ctxOf } from '../middleware/auth.js'
import { computeScore, impactTarget, loadScoreInputsByUser, modelFor, type ScoreResult } from '../services/performance.js'

export const company = Router()

// ───────────── Visibility ─────────────

/** OPEN (default) unless the organization switched transparency to PRIVATE. */
async function isOpen(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } })
  return (org?.settings as { transparency?: string } | null)?.transparency !== 'PRIVATE'
}

/** Who the caller may read in the company views. null = everyone in the organization (owners and admins always; everyone when open). */
async function readableIds(ctx: Ctx): Promise<Set<string> | null> {
  if (ctx.orgWide || (await isOpen(ctx.orgId))) return null
  return new Set(ctx.visibleUserIds ?? [])
}
const canRead = (readable: Set<string> | null, userId: string) => readable === null || readable.has(userId)

// ───────────── Scoring everyone (cached briefly: the page is read far more often than work changes) ─────────────

type Dimensions = ScoreResult['dimensions']
interface Scored {
  score: number | null
  dimensions: Dimensions
}
const CACHE_MS = 45_000
const scoreCache = new Map<string, { at: number; byUser: Map<string, Scored> }>()

async function scoreEveryone(orgId: string, days: number, roles: Map<string, string>) {
  const key = `${orgId}|${days}`
  const hit = scoreCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.byUser
  const to = new Date()
  const from = new Date(to.getTime() - days * 864e5)
  const userIds = [...roles.keys()]
  const [inputs, perPerson] = await Promise.all([loadScoreInputsByUser(orgId, userIds, from, to), impactTarget(orgId)])
  const models = new Map<string, Awaited<ReturnType<typeof modelFor>>>()
  const byUser = new Map<string, Scored>()
  for (const userId of userIds) {
    const role = roles.get(userId) ?? 'MEMBER'
    if (!models.has(role)) models.set(role, await modelFor(orgId, role))
    const weights = (models.get(role)!.weights ?? DEFAULT_WEIGHTS) as Record<ScoreDimension, number>
    const result = computeScore({ ...inputs.get(userId)!, impactTargetPerWeek: perPerson }, weights)
    byUser.set(userId, { score: result.score, dimensions: result.dimensions })
  }
  scoreCache.set(key, { at: Date.now(), byUser })
  return byUser
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n))
const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null
}

/** How far a KPI has moved from its baseline to its target, 0-100. Works for "lower is better" KPIs too. */
export function kpiAttainment(k: { direction: string; baseline: number; target: number; current: number }) {
  const span = k.direction === 'LOWER' ? k.baseline - k.target : k.target - k.baseline
  const moved = k.direction === 'LOWER' ? k.baseline - k.current : k.current - k.baseline
  if (span === 0) return k.direction === 'LOWER' ? (k.current <= k.target ? 100 : 0) : k.current >= k.target ? 100 : 0
  return Math.round(clampPct((moved / span) * 100))
}

export type Health = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'NO_DATA'
const healthOf = (overall: number | null): Health => (overall === null ? 'NO_DATA' : overall >= 70 ? 'ON_TRACK' : overall >= 45 ? 'AT_RISK' : 'OFF_TRACK')

const ACTIVE_GOALS = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'ACHIEVED'] as const

// ───────────── Overview ─────────────

async function buildOverview(ctx: Ctx, days: number) {
  const [readable, open] = await Promise.all([readableIds(ctx), isOpen(ctx.orgId)])
  const [members, teams, goals, kpis] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { orgId: ctx.orgId, status: 'ACTIVE' },
      select: { userId: true, role: true, title: true, reportsToId: true, user: { select: { name: true } } },
    }),
    prisma.team.findMany({
      where: { orgId: ctx.orgId },
      select: { id: true, name: true, parentId: true, managerId: true, members: { select: { userId: true } } },
    }),
    prisma.goal.findMany({ where: { orgId: ctx.orgId, deletedAt: null, status: { in: [...ACTIVE_GOALS] } }, select: { ownerId: true, progress: true } }),
    prisma.kpi.findMany({
      where: { orgId: ctx.orgId, deletedAt: null },
      select: { ownerId: true, direction: true, baseline: true, target: true, current: true },
    }),
  ])
  const scores = await scoreEveryone(ctx.orgId, days, new Map(members.map((m) => [m.userId, m.role])))

  const goalsBy = new Map<string, number[]>()
  for (const g of goals) goalsBy.set(g.ownerId, [...(goalsBy.get(g.ownerId) ?? []), g.progress])
  const kpisBy = new Map<string, number[]>()
  for (const k of kpis) kpisBy.set(k.ownerId, [...(kpisBy.get(k.ownerId) ?? []), kpiAttainment(k)])
  const teamsBy = new Map<string, string[]>()
  for (const t of teams) for (const m of t.members) teamsBy.set(m.userId, [...(teamsBy.get(m.userId) ?? []), t.id])

  const visible = members.filter((m) => canRead(readable, m.userId))
  const visibleIds = new Set(visible.map((m) => m.userId))
  const people = visible.map((m) => {
    const s = scores.get(m.userId)
    const goalProgress = mean(goalsBy.get(m.userId) ?? [])
    const kpi = mean(kpisBy.get(m.userId) ?? [])
    const score = s?.score != null ? Math.round(s.score) : null
    // "Overall" is the plain average of what exists: delivered value (score), goal progress and KPI attainment.
    const overall = mean([score, goalProgress, kpi])
    return {
      userId: m.userId,
      name: m.user.name,
      title: m.title,
      role: m.role,
      reportsToId: m.reportsToId && visibleIds.has(m.reportsToId) ? m.reportsToId : null,
      teamIds: teamsBy.get(m.userId) ?? [],
      score,
      dimensions: Object.fromEntries(Object.entries(s?.dimensions ?? {}).map(([k, d]) => [k, d.value])) as Record<string, number | null>,
      goalProgress,
      goalCount: (goalsBy.get(m.userId) ?? []).length,
      kpiAttainment: kpi,
      kpiCount: (kpisBy.get(m.userId) ?? []).length,
      overall,
      health: healthOf(overall),
      isMe: m.userId === ctx.userId,
    }
  })

  // Reporting tree: depth, direct reports, and a roll-up of everyone below (so a leader sees how their whole line does).
  const byId = new Map(people.map((p) => [p.userId, p]))
  const children = new Map<string, string[]>()
  for (const p of people) if (p.reportsToId) children.set(p.reportsToId, [...(children.get(p.reportsToId) ?? []), p.userId])
  const depth = new Map<string, number>()
  const subtree = new Map<string, string[]>()
  const walk = (id: string, d: number, seen: Set<string>): string[] => {
    if (seen.has(id)) return []
    seen.add(id)
    depth.set(id, d)
    const below = (children.get(id) ?? []).flatMap((c) => [c, ...walk(c, d + 1, seen)])
    subtree.set(id, below)
    return below
  }
  const seen = new Set<string>()
  for (const p of people) if (!p.reportsToId) walk(p.userId, 0, seen)
  for (const p of people) if (!seen.has(p.userId)) walk(p.userId, 0, seen) // a broken loop: still shown, at the top
  const people2 = people.map((p) => {
    const below = subtree.get(p.userId) ?? []
    return {
      ...p,
      depth: depth.get(p.userId) ?? 0,
      directReports: (children.get(p.userId) ?? []).length,
      subtreeSize: below.length,
      rollupOverall: below.length ? mean([p.overall, ...below.map((id) => byId.get(id)?.overall ?? null)]) : p.overall,
    }
  })

  // Departments: a team's roll-up covers its own members and everything in the teams below it.
  const teamKids = new Map<string, string[]>()
  for (const t of teams) if (t.parentId) teamKids.set(t.parentId, [...(teamKids.get(t.parentId) ?? []), t.id])
  const teamById = new Map(teams.map((t) => [t.id, t]))
  const memberIdsOf = (id: string, guard = new Set<string>()): string[] => {
    if (guard.has(id)) return []
    guard.add(id)
    const t = teamById.get(id)
    if (!t) return []
    return [...t.members.map((m) => m.userId), ...(teamKids.get(id) ?? []).flatMap((c) => memberIdsOf(c, guard))]
  }
  const teamsOut = teams.map((t) => {
    const ids = [...new Set(memberIdsOf(t.id))].filter((id) => visibleIds.has(id))
    const rows = ids.map((id) => byId.get(id)!)
    const overall = mean(rows.map((r) => r.overall))
    return {
      id: t.id,
      name: t.name,
      parentId: t.parentId,
      managerId: t.managerId && visibleIds.has(t.managerId) ? t.managerId : null,
      memberIds: t.members.map((m) => m.userId).filter((id) => visibleIds.has(id)),
      people: ids.length,
      score: mean(rows.map((r) => r.score)),
      goalProgress: mean(rows.map((r) => r.goalProgress)),
      kpiAttainment: mean(rows.map((r) => r.kpiAttainment)),
      overall,
      health: healthOf(overall),
    }
  })

  const companyOverall = mean(people2.map((p) => p.overall))
  return {
    days,
    transparency: open ? ('OPEN' as const) : ('PRIVATE' as const),
    me: ctx.userId,
    summary: {
      people: people2.length,
      overall: companyOverall,
      health: healthOf(companyOverall),
      onTrack: people2.filter((p) => p.health === 'ON_TRACK').length,
      atRisk: people2.filter((p) => p.health === 'AT_RISK').length,
      offTrack: people2.filter((p) => p.health === 'OFF_TRACK').length,
    },
    people: people2,
    teams: teamsOut,
  }
}

const daysQuery = z.object({ days: z.coerce.number().int().min(7).max(180).default(28) })

company.get('/company/overview', async (req, res) => {
  const ctx = ctxOf(req)
  const { days } = query(req, daysQuery)
  res.json(await buildOverview(ctx, days))
})

// ───────────── One person ─────────────

const presentKpi = (ctx: Ctx, k: Prisma.KpiGetPayload<{ include: { readings: true } }> & { owner?: { name: string } }) => ({
  id: k.id,
  name: k.name,
  unit: k.unit,
  direction: k.direction,
  baseline: k.baseline,
  target: k.target,
  current: k.current,
  cadence: k.cadence,
  ownerId: k.ownerId,
  ownerName: k.owner?.name ?? null,
  teamId: k.teamId,
  goalId: k.goalId,
  attainment: kpiAttainment(k),
  readings: k.readings.map((r) => ({ id: r.id, value: r.value, note: r.note, at: r.at })),
  canEdit: canEditKpi(ctx, k),
})

function canEditKpi(ctx: Ctx, k: { orgId: string; ownerId: string }) {
  return k.orgId === ctx.orgId && (ctx.orgWide || k.ownerId === ctx.userId || canManageUser(ctx, k.ownerId))
}

company.get('/company/people/:userId', async (req, res) => {
  const ctx = ctxOf(req)
  const userId = param(req, 'userId')
  const { days } = query(req, daysQuery)
  const overview = await buildOverview(ctx, days)
  const person = overview.people.find((p) => p.userId === userId)
  if (!person) throw notFound('Person')
  const byId = new Map(overview.people.map((p) => [p.userId, p]))
  const chain: { userId: string; name: string; title: string | null }[] = []
  for (let cur = person.reportsToId, i = 0; cur && i < 20; i++) {
    const p = byId.get(cur)
    if (!p) break
    chain.unshift({ userId: p.userId, name: p.name, title: p.title })
    cur = p.reportsToId
  }
  const brief = (p: (typeof overview.people)[number]) => ({
    userId: p.userId,
    name: p.name,
    title: p.title,
    role: p.role,
    overall: p.overall,
    health: p.health,
    score: p.score,
    goalProgress: p.goalProgress,
    kpiAttainment: p.kpiAttainment,
  })
  const [goals, kpis, why] = await Promise.all([
    prisma.goal.findMany({
      where: { orgId: ctx.orgId, ownerId: userId, deletedAt: null, status: { not: 'CANCELLED' } },
      include: { keyResults: { orderBy: { createdAt: 'asc' } }, team: { select: { id: true, name: true } } },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.kpi.findMany({
      where: { orgId: ctx.orgId, ownerId: userId, deletedAt: null },
      include: { readings: { orderBy: { at: 'desc' }, take: 24 } },
      orderBy: { createdAt: 'asc' },
    }),
    scoreEveryone(ctx.orgId, days, new Map([[userId, person.role]])).then((m) => m.get(userId)),
  ])
  res.json({
    person: { ...person, dimensionDetail: why?.dimensions ?? null },
    chain,
    reports: overview.people.filter((p) => p.reportsToId === userId).map(brief),
    peers: overview.people.filter((p) => p.userId !== userId && p.reportsToId === person.reportsToId).map(brief),
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      period: g.period,
      status: g.status,
      progress: g.progress,
      dueDate: g.dueDate,
      parentId: g.parentId,
      team: g.team,
      keyResults: g.keyResults.map((k) => ({ id: k.id, title: k.title, unit: k.unit, start: k.start, target: k.target, current: k.current })),
    })),
    kpis: kpis.map((k) => presentKpi(ctx, { ...k, readings: [...k.readings].reverse() })),
    canAddKpi: ctx.orgWide || userId === ctx.userId || canManageUser(ctx, userId),
  })
})

// ───────────── Goal cascade ─────────────

company.get('/company/cascade', async (req, res) => {
  const ctx = ctxOf(req)
  const readable = await readableIds(ctx)
  const [goals, kpis, owners] = await Promise.all([
    prisma.goal.findMany({
      where: { orgId: ctx.orgId, deletedAt: null, status: { not: 'CANCELLED' } },
      include: { keyResults: { orderBy: { createdAt: 'asc' } }, team: { select: { id: true, name: true } } },
      orderBy: [{ dueDate: 'asc' }],
    }),
    prisma.kpi.findMany({
      where: { orgId: ctx.orgId, deletedAt: null },
      include: { readings: { orderBy: { at: 'desc' }, take: 12 } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.organizationMember.findMany({
      where: { orgId: ctx.orgId, status: 'ACTIVE' },
      select: { userId: true, title: true, reportsToId: true, user: { select: { name: true } } },
    }),
  ])
  const who = new Map(owners.map((o) => [o.userId, o]))
  const keep = <T extends { ownerId: string }>(rows: T[]) => rows.filter((r) => canRead(readable, r.ownerId) && who.has(r.ownerId))
  res.json({
    goals: keep(goals).map((g) => ({
      id: g.id,
      title: g.title,
      period: g.period,
      status: g.status,
      progress: g.progress,
      dueDate: g.dueDate,
      parentId: g.parentId,
      team: g.team,
      ownerId: g.ownerId,
      ownerName: who.get(g.ownerId)!.user.name,
      ownerTitle: who.get(g.ownerId)!.title,
      keyResults: g.keyResults.map((k) => ({ id: k.id, title: k.title, unit: k.unit, start: k.start, target: k.target, current: k.current })),
    })),
    kpis: keep(kpis).map((k) => presentKpi(ctx, { ...k, readings: [...k.readings].reverse(), owner: { name: who.get(k.ownerId)!.user.name } })),
  })
})

// ───────────── KPIs ─────────────

const kpiInclude = { readings: { orderBy: { at: 'desc' as const }, take: 24 }, owner: { select: { name: true } } }

company.get('/kpis', async (req, res) => {
  const ctx = ctxOf(req)
  const q = query(req, z.object({ ownerId: z.string().uuid().optional() }))
  const readable = await readableIds(ctx)
  if (q.ownerId && !canRead(readable, q.ownerId)) throw notFound('Person')
  const kpis = await prisma.kpi.findMany({
    where: { orgId: ctx.orgId, deletedAt: null, ownerId: q.ownerId },
    include: kpiInclude,
    orderBy: { createdAt: 'asc' },
  })
  res.json({ kpis: kpis.filter((k) => canRead(readable, k.ownerId)).map((k) => presentKpi(ctx, { ...k, readings: [...k.readings].reverse() })) })
})

async function assertOwnerInOrg(ctx: Ctx, ownerId: string) {
  const m = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: ownerId } } })
  if (!m || m.status !== 'ACTIVE') throw notFound('Person')
}

company.post('/kpis', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, kpiSchema)
  const ownerId = input.ownerId ?? ctx.userId
  await assertOwnerInOrg(ctx, ownerId)
  if (!canEditKpi(ctx, { orgId: ctx.orgId, ownerId })) throw forbidden('You can set KPIs for yourself and for people you manage.')
  if (input.teamId && !(await prisma.team.findFirst({ where: { id: input.teamId, orgId: ctx.orgId } }))) throw notFound('Team')
  if (input.goalId && !(await prisma.goal.findFirst({ where: { id: input.goalId, orgId: ctx.orgId, deletedAt: null } }))) throw notFound('Goal')
  const current = input.current ?? input.baseline
  const kpi = await prisma.kpi.create({
    data: {
      orgId: ctx.orgId,
      ownerId,
      teamId: input.teamId ?? null,
      goalId: input.goalId ?? null,
      name: input.name,
      unit: input.unit ?? null,
      direction: input.direction,
      baseline: input.baseline,
      target: input.target,
      current,
      cadence: input.cadence,
      readings: { create: [{ value: current, authorId: ctx.userId, note: 'Starting value' }] },
    },
    include: kpiInclude,
  })
  await audit(req, ctx.orgId, 'kpi.create', { type: 'Kpi', id: kpi.id }, { name: input.name, ownerId })
  scoreCache.clear()
  res.status(201).json({ kpi: presentKpi(ctx, { ...kpi, readings: [...kpi.readings].reverse() }) })
})

async function loadEditableKpi(ctx: Ctx, id: string) {
  const k = await prisma.kpi.findFirst({ where: { id, orgId: ctx.orgId, deletedAt: null } })
  if (!k) throw notFound('KPI')
  if (!canEditKpi(ctx, k)) throw forbidden()
  return k
}

company.patch('/kpis/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const id = param(req, 'id')
  const input = body(req, kpiUpdateSchema)
  await loadEditableKpi(ctx, id)
  if (input.ownerId) {
    await assertOwnerInOrg(ctx, input.ownerId)
    if (!canEditKpi(ctx, { orgId: ctx.orgId, ownerId: input.ownerId })) throw forbidden()
  }
  const { current, ...rest } = input
  const kpi = await prisma.kpi.update({ where: { id }, data: { ...rest, ...(current !== undefined ? { current } : {}) }, include: kpiInclude })
  await audit(req, ctx.orgId, 'kpi.update', { type: 'Kpi', id }, input as Prisma.InputJsonValue)
  scoreCache.clear()
  res.json({ kpi: presentKpi(ctx, { ...kpi, readings: [...kpi.readings].reverse() }) })
})

company.post('/kpis/:id/readings', async (req, res) => {
  const ctx = ctxOf(req)
  const id = param(req, 'id')
  const input = body(req, kpiReadingSchema)
  await loadEditableKpi(ctx, id)
  await prisma.$transaction([
    prisma.kpiReading.create({ data: { kpiId: id, value: input.value, note: input.note ?? null, authorId: ctx.userId } }),
    prisma.kpi.update({ where: { id }, data: { current: input.value } }),
  ])
  const kpi = await prisma.kpi.findUniqueOrThrow({ where: { id }, include: kpiInclude })
  await audit(req, ctx.orgId, 'kpi.reading', { type: 'Kpi', id }, { value: input.value })
  scoreCache.clear()
  res.status(201).json({ kpi: presentKpi(ctx, { ...kpi, readings: [...kpi.readings].reverse() }) })
})

company.delete('/kpis/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const id = param(req, 'id')
  await loadEditableKpi(ctx, id)
  await prisma.kpi.update({ where: { id }, data: { deletedAt: new Date() } })
  await audit(req, ctx.orgId, 'kpi.delete', { type: 'Kpi', id })
  scoreCache.clear()
  res.status(204).end()
})

// ───────────── Structure checks (used by the member and team routes) ─────────────

/** Reporting lines must stay a tree: nobody may report to themselves or to someone below them. */
export async function assertValidReportingLine(orgId: string, userId: string, reportsToId: string | null | undefined) {
  if (!reportsToId) return
  if (reportsToId === userId) throw badRequest('Someone cannot report to themselves.')
  const manager = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId, userId: reportsToId } } })
  if (!manager || manager.status !== 'ACTIVE') throw badRequest('The person they report to must be an active member of this organization.')
  const members = await prisma.organizationMember.findMany({ where: { orgId }, select: { userId: true, reportsToId: true } })
  const up = new Map(members.map((m) => [m.userId, m.reportsToId]))
  for (let cur: string | null | undefined = reportsToId, i = 0; cur && i <= members.length; i++) {
    if (cur === userId) throw badRequest('That would make a loop: that person already reports (directly or indirectly) to them.')
    cur = up.get(cur)
  }
}

/** Departments must stay a tree as well. */
export async function assertValidTeamParent(orgId: string, teamId: string | null, parentId: string | null | undefined) {
  if (!parentId) return
  if (parentId === teamId) throw badRequest('A team cannot sit under itself.')
  const teams = await prisma.team.findMany({ where: { orgId }, select: { id: true, parentId: true } })
  const up = new Map(teams.map((t) => [t.id, t.parentId]))
  if (!up.has(parentId)) throw notFound('Parent team')
  for (let cur: string | null | undefined = parentId, i = 0; cur && i <= teams.length; i++) {
    if (teamId && cur === teamId) throw badRequest('That would put a team under one of its own sub-teams.')
    cur = up.get(cur)
  }
}

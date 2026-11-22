// Performance & impact engine. Deterministic and versioned: the same inputs and model always give the same score.
// Raw task count is never an input; hours never count as productivity; AI never sets any value here.
import { DEFAULT_WEIGHTS, SCORE_DIMENSIONS, type ScoreDimension } from '@workpulse/shared'
import { prisma, type ImpactLevel, type Prisma } from '../lib/prisma.js'

export const ENGINE_VERSION = 1

/** Impact points per level: one critical outcome is worth more than ten low ones. */
export const IMPACT_POINTS: Record<ImpactLevel, number> = { NONE: 0, LOW: 0.5, MEDIUM: 2, HIGH: 5, CRITICAL: 10 }
/** Complexity 1-5 → ×0.9 … ×1.3. */
export const complexityFactor = (c: number) => 0.8 + 0.1 * Math.min(5, Math.max(1, c))
/** Unverified work still counts, at half weight, until someone verifies its evidence. */
export const UNVERIFIED_FACTOR = 0.5
export const DEFAULT_IMPACT_TARGET_PER_WEEK = 10

export interface ScoreTask {
  id: string
  impactLevel: ImpactLevel
  complexity: number
  status: string
  dueAt: Date | null
  completedAt: Date | null
  startedAt: Date | null
  estimateMins: number | null
  actualMins: number
  reopenCount: number
  goalLinked: boolean
  verifiedEvidence: number
  anyEvidence: number
  /** Had an EXTERNAL or DEPENDENCY blocker: a late finish is excused (not penalised). */
  externallyBlocked: boolean
}

export interface ScoreInput {
  periodStart: Date
  periodEnd: Date
  /** Tasks completed in the period, or due in the period, or open with a due date before periodEnd. */
  tasks: ScoreTask[]
  /** Person-made quality assessments (1-5) of tasks completed in the period. */
  qualityScores: number[]
  /** Impact points expected per week for this subject (per person × team size for teams). */
  impactTargetPerWeek: number
  now?: Date
}

export interface DimensionResult {
  value: number | null
  weight: number
  /** Short explanation of the inputs, shown in "Why this score?". */
  inputs: Record<string, number | string>
  missing: string | null
}

export interface ScoreResult {
  engineVersion: number
  score: number | null
  dimensions: Record<ScoreDimension, DimensionResult>
  /** Weight of dimensions without data, redistributed to the rest. */
  excludedWeight: number
  diagnostics: {
    estimateAccuracy: number | null
    avgCycleHours: number | null
    workInProgress: number
    reopened: number
  }
  metrics: {
    completed: number
    highImpactCompleted: number
    impactPoints: number
    committed: number
    onTime: number
    excusedLate: number
    missed: number
    evidenceBacked: number
  }
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d
const clamp = (n: number) => Math.max(0, Math.min(100, n))

export function computeScore(input: ScoreInput, weights: Record<ScoreDimension, number> = DEFAULT_WEIGHTS): ScoreResult {
  const { periodStart, periodEnd } = input
  const now = input.now ?? new Date()
  const inPeriod = (d: Date | null) => Boolean(d && d >= periodStart && d < periodEnd)
  const completed = input.tasks.filter((t) => t.status === 'COMPLETED' && inPeriod(t.completedAt))

  // Impact: points earned vs. the expected points for the period length.
  const weeks = Math.max(1 / 7, (periodEnd.getTime() - periodStart.getTime()) / (7 * 864e5))
  const target = input.impactTargetPerWeek * weeks
  let impactPoints = 0
  let alignedPoints = 0
  for (const t of completed) {
    const p = IMPACT_POINTS[t.impactLevel] * complexityFactor(t.complexity) * (t.verifiedEvidence > 0 ? 1 : UNVERIFIED_FACTOR)
    impactPoints += p
    if (t.goalLinked) alignedPoints += p
  }
  const rated = completed.filter((t) => t.impactLevel !== 'NONE').length
  const impact: DimensionResult = {
    value: rated ? round(clamp((impactPoints / target) * 100)) : null,
    weight: weights.impact,
    inputs: { impactPoints: round(impactPoints, 2), target: round(target, 2), ratedOutcomes: rated },
    missing: rated ? null : 'No completed work with an impact rating in this period.',
  }

  // Execution quality: person-made assessments only.
  const q = input.qualityScores
  const quality: DimensionResult = {
    value: q.length ? round(((q.reduce((a, b) => a + b, 0) / q.length - 1) / 4) * 100) : null,
    weight: weights.quality,
    inputs: { assessments: q.length, average: q.length ? round(q.reduce((a, b) => a + b, 0) / q.length, 2) : '—' },
    missing: q.length ? null : 'No quality assessments of completed work yet.',
  }

  // Goal alignment: share of earned impact that advanced a goal.
  const alignment: DimensionResult = {
    value: impactPoints > 0 ? round((alignedPoints / impactPoints) * 100) : null,
    weight: weights.alignment,
    inputs: { alignedPoints: round(alignedPoints, 2), impactPoints: round(impactPoints, 2) },
    missing: impactPoints > 0 ? null : 'No impact-rated completed work to align with goals.',
  }

  // Delivery reliability. Each commitment (a task with a due date) is judged once: completed work in the period it was
  // completed (on time when finished by its due date); unfinished work in the period its deadline passed.
  // Late work that was blocked externally is excused: removed from the denominator, not counted as missed.
  let committed = 0
  let onTime = 0
  let excusedLate = 0
  let missed = 0
  for (const t of input.tasks) {
    if (!t.dueAt || t.status === 'CANCELLED') continue
    if (t.status === 'COMPLETED') {
      if (!inPeriod(t.completedAt)) continue
      if (t.completedAt! <= t.dueAt) {
        committed++
        onTime++
      } else if (t.externallyBlocked) excusedLate++
      else {
        committed++
        missed++
      }
    } else if (inPeriod(t.dueAt) && t.dueAt < now) {
      if (t.externallyBlocked) excusedLate++
      else {
        committed++
        missed++
      }
    }
    // Open and not yet due: not judged.
  }
  const reliability: DimensionResult = {
    value: committed ? round((onTime / committed) * 100) : null,
    weight: weights.reliability,
    inputs: { committed, onTime, missed, excusedLate },
    missing: committed ? null : 'No commitments with due dates fell in this period.',
  }

  // Evidence completeness: medium+ impact outcomes with at least one verified evidence item.
  const significant = completed.filter((t) => IMPACT_POINTS[t.impactLevel] >= IMPACT_POINTS.MEDIUM)
  const backed = significant.filter((t) => t.verifiedEvidence > 0).length
  const evidence: DimensionResult = {
    value: significant.length ? round((backed / significant.length) * 100) : null,
    weight: weights.evidence,
    inputs: { significantOutcomes: significant.length, withVerifiedEvidence: backed },
    missing: significant.length ? null : 'No medium-or-higher impact outcomes completed in this period.',
  }

  const dimensions = { impact, quality, alignment, reliability, evidence }
  let sum = 0
  let used = 0
  for (const key of SCORE_DIMENSIONS) {
    const d = dimensions[key]
    if (d.value != null && d.weight > 0) {
      sum += d.value * d.weight
      used += d.weight
    }
  }
  const totalWeight = SCORE_DIMENSIONS.reduce((a, k) => a + weights[k], 0)

  const withEst = completed.filter((t) => t.estimateMins && t.actualMins)
  const cycle = completed.filter((t) => t.startedAt && t.completedAt)
  return {
    engineVersion: ENGINE_VERSION,
    score: used ? round(sum / used) : null,
    dimensions,
    excludedWeight: totalWeight - used,
    diagnostics: {
      // 100 = estimates matched actual effort exactly. Shown, never scored.
      estimateAccuracy: withEst.length
        ? round(clamp(100 - (withEst.reduce((a, t) => a + Math.abs(t.actualMins - t.estimateMins!) / t.estimateMins!, 0) / withEst.length) * 100))
        : null,
      avgCycleHours: cycle.length ? round(cycle.reduce((a, t) => a + (t.completedAt!.getTime() - t.startedAt!.getTime()) / 36e5, 0) / cycle.length) : null,
      workInProgress: input.tasks.filter((t) => t.status === 'IN_PROGRESS' || t.status === 'IN_REVIEW').length,
      reopened: completed.filter((t) => t.reopenCount > 0).length,
    },
    metrics: {
      completed: completed.length,
      highImpactCompleted: completed.filter((t) => t.impactLevel === 'HIGH' || t.impactLevel === 'CRITICAL').length,
      impactPoints: round(impactPoints, 2),
      committed,
      onTime,
      excusedLate,
      missed,
      evidenceBacked: backed,
    },
  }
}

// ───────────── Loading inputs ─────────────

export async function loadScoreInput(orgId: string, userIds: string[], periodStart: Date, periodEnd: Date): Promise<Omit<ScoreInput, 'impactTargetPerWeek'>> {
  const tasks = await prisma.task.findMany({
    where: {
      orgId,
      deletedAt: null,
      assigneeId: { in: userIds },
      parentId: null,
      OR: [
        { completedAt: { gte: periodStart, lt: periodEnd } },
        { dueAt: { gte: periodStart, lt: periodEnd } },
        { status: { notIn: ['COMPLETED', 'CANCELLED'] }, dueAt: { lt: periodEnd } },
        { status: { in: ['IN_PROGRESS', 'IN_REVIEW'] } },
      ],
    },
    select: {
      id: true,
      impactLevel: true,
      complexity: true,
      status: true,
      dueAt: true,
      completedAt: true,
      startedAt: true,
      estimateMins: true,
      actualMins: true,
      reopenCount: true,
      _count: { select: { goals: true, evidence: { where: { status: 'VERIFIED', deletedAt: null } } } },
      evidence: { where: { deletedAt: null }, select: { id: true } },
      blockers: { where: { kind: { in: ['EXTERNAL', 'DEPENDENCY'] } }, select: { id: true } },
    },
  })
  const completedIds = tasks.filter((t) => t.status === 'COMPLETED').map((t) => t.id)
  const assessments = await prisma.qualityAssessment.findMany({ where: { orgId, taskId: { in: completedIds } }, select: { quality: true } })
  return {
    periodStart,
    periodEnd,
    tasks: tasks.map((t) => ({
      id: t.id,
      impactLevel: t.impactLevel,
      complexity: t.complexity,
      status: t.status,
      dueAt: t.dueAt,
      completedAt: t.completedAt,
      startedAt: t.startedAt,
      estimateMins: t.estimateMins,
      actualMins: t.actualMins,
      reopenCount: t.reopenCount,
      goalLinked: t._count.goals > 0,
      verifiedEvidence: t._count.evidence,
      anyEvidence: t.evidence.length,
      externallyBlocked: t.blockers.length > 0,
    })),
    qualityScores: assessments.map((a) => a.quality),
  }
}

/** The scoring model for a person: role-specific when one is active, else the org default. */
export async function modelFor(orgId: string, role?: string | null) {
  const models = await prisma.scoringModel.findMany({ where: { orgId, active: true }, orderBy: { version: 'desc' } })
  const model = models.find((m) => m.role === role) ?? models.find((m) => m.role === null) ?? models[0]
  if (model) return model
  return prisma.scoringModel.create({ data: { orgId, name: 'Default', weights: DEFAULT_WEIGHTS } })
}

export async function impactTarget(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } })
  const v = (org.settings as Record<string, unknown>).impactTargetPerWeek
  return typeof v === 'number' && v > 0 ? v : DEFAULT_IMPACT_TARGET_PER_WEEK
}

/** Computes and stores a snapshot. subject: "user:<id>" | "team:<id>". */
export async function snapshot(orgId: string, subject: string, periodStart: Date, periodEnd: Date, granularity: 'DAY' | 'WEEK' | 'MONTH') {
  const [kind, id] = subject.split(':') as ['user' | 'team', string]
  let userIds: string[]
  let role: string | null = null
  if (kind === 'user') {
    userIds = [id]
    role = (await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId, userId: id } }, select: { role: true } }))?.role ?? null
  } else {
    userIds = (await prisma.teamMember.findMany({ where: { teamId: id, team: { orgId } }, select: { userId: true } })).map((m) => m.userId)
  }
  const model = await modelFor(orgId, role)
  const input = await loadScoreInput(orgId, userIds, periodStart, periodEnd)
  const target = (await impactTarget(orgId)) * Math.max(1, userIds.length)
  const result = computeScore({ ...input, impactTargetPerWeek: target }, model.weights as Record<ScoreDimension, number>)
  const data = {
    periodEnd,
    score: result.score,
    components: {
      ...result.dimensions,
      excludedWeight: result.excludedWeight,
      engineVersion: result.engineVersion,
      modelVersion: model.version,
      modelName: model.name,
    } as unknown as Prisma.InputJsonValue,
    metrics: { ...result.metrics, ...result.diagnostics, members: userIds.length } as unknown as Prisma.InputJsonValue,
    calculatedAt: new Date(),
  }
  await prisma.performanceSnapshot.upsert({
    where: { orgId_subject_granularity_periodStart_scoringModelId: { orgId, subject, granularity, periodStart, scoringModelId: model.id } },
    create: { orgId, subject, granularity, periodStart, scoringModelId: model.id, ...data },
    update: data,
  })
  return { ...result, model: { id: model.id, name: model.name, version: model.version } }
}

/**
 * Score inputs for many people at once (one query for the tasks, one for the assessments), grouped by assignee.
 * The company views score every person, so this avoids two queries per person. Same task filter as loadScoreInput.
 */
export async function loadScoreInputsByUser(orgId: string, userIds: string[], periodStart: Date, periodEnd: Date) {
  const out = new Map<string, Omit<ScoreInput, 'impactTargetPerWeek'>>()
  for (const id of userIds) out.set(id, { periodStart, periodEnd, tasks: [], qualityScores: [] })
  if (!userIds.length) return out
  const tasks = await prisma.task.findMany({
    where: {
      orgId,
      deletedAt: null,
      assigneeId: { in: userIds },
      parentId: null,
      OR: [
        { completedAt: { gte: periodStart, lt: periodEnd } },
        { dueAt: { gte: periodStart, lt: periodEnd } },
        { status: { notIn: ['COMPLETED', 'CANCELLED'] }, dueAt: { lt: periodEnd } },
        { status: { in: ['IN_PROGRESS', 'IN_REVIEW'] } },
      ],
    },
    select: {
      id: true,
      assigneeId: true,
      impactLevel: true,
      complexity: true,
      status: true,
      dueAt: true,
      completedAt: true,
      startedAt: true,
      estimateMins: true,
      actualMins: true,
      reopenCount: true,
      _count: { select: { goals: true, evidence: { where: { status: 'VERIFIED', deletedAt: null } } } },
      evidence: { where: { deletedAt: null }, select: { id: true } },
      blockers: { where: { kind: { in: ['EXTERNAL', 'DEPENDENCY'] } }, select: { id: true } },
    },
  })
  const completed = tasks.filter((t) => t.status === 'COMPLETED')
  const assessments = await prisma.qualityAssessment.findMany({
    where: { orgId, taskId: { in: completed.map((t) => t.id) } },
    select: { taskId: true, quality: true },
  })
  const assigneeOf = new Map(completed.map((t) => [t.id, t.assigneeId!]))
  for (const t of tasks) {
    out.get(t.assigneeId!)!.tasks.push({
      id: t.id,
      impactLevel: t.impactLevel,
      complexity: t.complexity,
      status: t.status,
      dueAt: t.dueAt,
      completedAt: t.completedAt,
      startedAt: t.startedAt,
      estimateMins: t.estimateMins,
      actualMins: t.actualMins,
      reopenCount: t.reopenCount,
      goalLinked: t._count.goals > 0,
      verifiedEvidence: t._count.evidence,
      anyEvidence: t.evidence.length,
      externallyBlocked: t.blockers.length > 0,
    })
  }
  for (const a of assessments) {
    const who = assigneeOf.get(a.taskId)
    if (who) out.get(who)!.qualityScores.push(a.quality)
  }
  return out
}

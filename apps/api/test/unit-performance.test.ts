import { describe, expect, it } from 'vitest'
import { computeScore, type ScoreTask } from '../src/services/performance.js'

const start = new Date('2026-11-02T00:00:00Z')
const end = new Date('2026-11-09T00:00:00Z')
const mid = new Date('2026-11-05T12:00:00Z')
const now = new Date('2026-11-10T00:00:00Z')

const t = (over: Partial<ScoreTask> = {}): ScoreTask => ({
  id: Math.random().toString(36),
  impactLevel: 'LOW',
  complexity: 2,
  status: 'COMPLETED',
  dueAt: null,
  completedAt: mid,
  startedAt: new Date(mid.getTime() - 36e5),
  estimateMins: null,
  actualMins: 0,
  reopenCount: 0,
  goalLinked: false,
  verifiedEvidence: 0,
  anyEvidence: 0,
  externallyBlocked: false,
  ...over,
})
const score = (tasks: ScoreTask[], qualityScores: number[] = []) =>
  computeScore({ periodStart: start, periodEnd: end, tasks, qualityScores, impactTargetPerWeek: 10, now })

describe('performance engine', () => {
  it('one critical outcome outscores ten low-impact tasks', () => {
    const critical = score([t({ impactLevel: 'CRITICAL', verifiedEvidence: 1 })])
    const tenLow = score(Array.from({ length: 10 }, () => t({ impactLevel: 'LOW', verifiedEvidence: 1 })))
    expect(critical.dimensions.impact.value!).toBeGreaterThan(tenLow.dimensions.impact.value!)
  })
  it('never rewards raw volume: unrated tasks earn no impact', () => {
    const r = score(Array.from({ length: 50 }, () => t({ impactLevel: 'NONE' })))
    expect(r.dimensions.impact.value).toBeNull()
    expect(r.score).toBeNull()
  })
  it('unverified work counts at half weight', () => {
    const verified = score([t({ impactLevel: 'HIGH', verifiedEvidence: 1 })]).metrics.impactPoints
    const unverified = score([t({ impactLevel: 'HIGH' })]).metrics.impactPoints
    expect(unverified).toBeCloseTo(verified / 2)
  })
  it('does not penalise late work that was blocked externally', () => {
    const due = new Date('2026-11-04T00:00:00Z')
    const r = score([t({ dueAt: due, completedAt: mid, externallyBlocked: true }), t({ dueAt: due, completedAt: new Date('2026-11-03T00:00:00Z') })])
    expect(r.metrics).toMatchObject({ committed: 1, onTime: 1, excusedLate: 1, missed: 0 })
    expect(r.dimensions.reliability.value).toBe(100)
  })
  it('counts overdue open work as missed, but not open work that is not yet due', () => {
    const r = score([
      t({ status: 'IN_PROGRESS', completedAt: null, dueAt: new Date('2026-11-04T00:00:00Z') }),
      t({ status: 'TODO', completedAt: null, dueAt: new Date('2026-11-08T23:00:00Z') }),
    ])
    expect(r.metrics.missed).toBe(2) // both deadlines are before `now`
    const early = computeScore({
      periodStart: start,
      periodEnd: end,
      tasks: [t({ status: 'TODO', completedAt: null, dueAt: new Date('2026-11-08T23:00:00Z') })],
      qualityScores: [],
      impactTargetPerWeek: 10,
      now: new Date('2026-11-06T00:00:00Z'),
    })
    expect(early.metrics.committed).toBe(0)
    expect(early.dimensions.reliability.value).toBeNull()
  })
  it('shows missing dimensions and redistributes their weight', () => {
    const r = score([t({ impactLevel: 'HIGH', verifiedEvidence: 1, goalLinked: true })])
    expect(r.dimensions.quality.value).toBeNull()
    expect(r.dimensions.quality.missing).toMatch(/No quality assessments/)
    expect(r.dimensions.reliability.value).toBeNull()
    expect(r.excludedWeight).toBe(25 + 15)
    // Remaining: impact (5×1.0=5 of 10 → 50) ×30, alignment 100 ×20, evidence 100 ×10 → (1500+2000+1000)/60
    expect(r.score).toBeCloseTo(75, 0)
  })
  it('quality uses person-made assessments only', () => {
    expect(score([t()], [5, 5]).dimensions.quality.value).toBe(100)
    expect(score([t()], [1]).dimensions.quality.value).toBe(0)
    expect(score([t()], [3]).dimensions.quality.value).toBe(50)
  })
  it('goal alignment is the share of impact on goal-linked work', () => {
    const r = score([t({ impactLevel: 'HIGH', goalLinked: true }), t({ impactLevel: 'HIGH' })])
    expect(r.dimensions.alignment.value).toBe(50)
  })
  it('evidence completeness considers medium+ outcomes only', () => {
    const r = score([t({ impactLevel: 'MEDIUM', verifiedEvidence: 1 }), t({ impactLevel: 'HIGH' }), t({ impactLevel: 'LOW' })])
    expect(r.dimensions.evidence.inputs).toMatchObject({ significantOutcomes: 2, withVerifiedEvidence: 1 })
    expect(r.dimensions.evidence.value).toBe(50)
  })
  it('efficiency is diagnostic only and never changes the score', () => {
    const a = score([t({ impactLevel: 'HIGH', estimateMins: 60, actualMins: 60 })])
    const b = score([t({ impactLevel: 'HIGH', estimateMins: 60, actualMins: 600 })])
    expect(a.score).toBe(b.score)
    expect(a.diagnostics.estimateAccuracy).toBe(100)
    expect(b.diagnostics.estimateAccuracy).toBe(0)
  })
  it('uses custom weights', () => {
    const r = computeScore(
      { periodStart: start, periodEnd: end, tasks: [t({ impactLevel: 'CRITICAL', verifiedEvidence: 1 })], qualityScores: [1], impactTargetPerWeek: 10, now },
      { impact: 100, quality: 0, alignment: 0, reliability: 0, evidence: 0 },
    )
    expect(r.score).toBe(r.dimensions.impact.value)
  })
})

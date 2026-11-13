// Priority recommendation. A recommendation is advice to a manager, kept apart from the confirmed priority: it never writes the task's
// priority, never invents a score for a factor nobody supplied, and is stored with its factors, explanation, confidence and the
// configuration version it was computed with. Priority is context for measurement, never a performance score.
//
//   rawScore = SUM((factorScore / 5) * factorWeight)      (known factors only; weights sum to 100)
//   score    = rawScore / knownWeight * 100                (equals rawScore when every factor is known)
import { json, now, transaction, uuid } from '../db.js'
import { forbidden, invalid, notFound } from '../errors.js'
import { canManageTask, requireVisibleTask } from '../access.js'
import * as v from '../validate.js'
import { orgCalendar, orgTimezone, addWorkingTime } from '../time.js'
import { audit } from './audit.js'
import { emit } from './events.js'
import { applyConfirmed, ensureExpectations, getExpectations } from './task-parameters.js'

const HOUR = 3600000
export const FACTORS = ['businessImpact', 'urgency', 'dependencies', 'risk', 'strategic']
const LABEL = { businessImpact: 'Business impact', urgency: 'Urgency', dependencies: 'Dependencies', risk: 'Risk', strategic: 'Strategic importance' }
const COLUMN = { businessImpact: 'factor_business_impact', urgency: 'factor_urgency', dependencies: 'factor_dependencies', risk: 'factor_risk', strategic: 'factor_strategic' }

/** The initial configuration (to be validated); an organization may override pieces of it in settings.priorityModel. */
export const DEFAULT_MODEL = {
  version: 'priority-model-2026-11-v1',
  weights: { businessImpact: 30, urgency: 25, dependencies: 20, risk: 15, strategic: 10 },
  thresholds: { CRITICAL: 85, HIGH: 70, MEDIUM: 45 }, // anything lower is LOW (the 20-44 band and below)
  confidence: { HIGH: 85, MEDIUM: 60 }, minCoverage: 40, // share of the total weight that is known
  responseSla: { CRITICAL: { amount: 1, unit: 'working_hours' }, HIGH: { amount: 4, unit: 'working_hours' }, MEDIUM: { amount: 1, unit: 'working_days' }, LOW: { amount: 3, unit: 'working_days' } },
  completionTargetDays: { L1: 1, L2: 3, L3: 7, L4: 14 }
}

export function modelFor(db, orgId) {
  const o = json(db.prepare('SELECT settings FROM organizations WHERE id = ?').get(orgId)?.settings, {}).priorityModel
  if (!o || typeof o !== 'object') return DEFAULT_MODEL
  const weights = { ...DEFAULT_MODEL.weights, ...(o.weights || {}) }
  const sum = FACTORS.reduce((n, k) => n + (Number(weights[k]) || 0), 0)
  const thresholds = { ...DEFAULT_MODEL.thresholds, ...(o.thresholds || {}) }
  const ok = Math.abs(sum - 100) < 0.001 && FACTORS.every((k) => weights[k] >= 0) && thresholds.CRITICAL > thresholds.HIGH && thresholds.HIGH > thresholds.MEDIUM && thresholds.MEDIUM > 0
  return ok ? { ...DEFAULT_MODEL, weights, thresholds, version: `${DEFAULT_MODEL.version}+org` } : DEFAULT_MODEL
}

const classify = (score, t) => (score >= t.CRITICAL ? 'CRITICAL' : score >= t.HIGH ? 'HIGH' : score >= t.MEDIUM ? 'MEDIUM' : 'LOW')
const urgencyFromHours = (h) => (h <= 4 ? 5 : h <= 24 ? 4 : h <= 72 ? 3 : h <= 168 ? 2 : 1)

/** Pure scoring from factor scores (1-5 or null = unknown). */
export function scoreFactors(factors, model = DEFAULT_MODEL) {
  let raw = 0
  let known = 0
  const breakdown = FACTORS.map((k) => {
    const w = model.weights[k]
    const s = Number.isInteger(factors[k]?.score) && factors[k].score >= 1 && factors[k].score <= 5 ? factors[k].score : null
    if (s !== null) { raw += (s / 5) * w; known += w }
    return { key: k, label: LABEL[k], weight: w, score: s, known: s !== null, contribution: s === null ? null : Math.round((s / 5) * w * 100) / 100, explanation: factors[k]?.explanation || 'Unknown: not rated, so it adds nothing and is not guessed.', evidence: factors[k]?.evidence || [] }
  })
  const rawScore = Math.round(raw * 100) / 100
  const coverage = known
  if (coverage < model.minCoverage) return { rawScore, knownWeight: known, score: null, suggestedPriority: null, confidence: null, breakdown, insufficient: true }
  const score = Math.round((raw / known) * 10000) / 100
  return { rawScore, knownWeight: known, score, suggestedPriority: classify(score, model.thresholds), confidence: coverage >= model.confidence.HIGH ? 'HIGH' : coverage >= model.confidence.MEDIUM ? 'MEDIUM' : 'LOW', breakdown, insufficient: false }
}

/** Factor inputs for one task from what managers recorded (never from guesses). */
function factorInputs(db, task, ex, at = Date.now()) {
  const out = {}
  const rated = (k, what) => {
    const s = ex?.[COLUMN[k]] ?? null
    return s === null ? { score: null } : { score: s, explanation: `${what} rated ${s} of 5 by a manager.`, evidence: [{ kind: 'expectation', field: COLUMN[k], value: s }] }
  }
  out.businessImpact = rated('businessImpact', 'Business impact')
  out.dependencies = rated('dependencies', 'Dependencies')
  out.risk = rated('risk', 'Risk')
  out.strategic = rated('strategic', 'Strategic importance')
  const manual = rated('urgency', 'Urgency')
  if (manual.score !== null) out.urgency = manual
  else if (task.due_at) {
    const hours = (Date.parse(task.due_at) - at) / HOUR
    const s = urgencyFromHours(hours)
    out.urgency = { score: s, explanation: hours <= 0 ? 'The confirmed deadline has passed.' : `The confirmed deadline is in about ${Math.round(hours)} hours.`, evidence: [{ kind: 'deadline', dueAt: task.due_at }] }
  } else out.urgency = { score: null }
  const openBlockers = db.prepare(`SELECT id FROM blockers WHERE task_id = ? AND status = 'OPEN'`).all(task.id)
  if (openBlockers.length && out.dependencies.score !== null) out.dependencies.evidence = [...out.dependencies.evidence, ...openBlockers.map((b) => ({ kind: 'blocker', id: b.id }))]
  return out
}

const present = (r) => ({
  id: r.id, taskId: r.task_id, score: r.score, rawScore: r.raw_score, knownWeight: r.known_weight, suggestedPriority: r.suggested_priority, confidence: r.confidence,
  factors: json(r.factors, []), configVersion: r.config_version, criticalReview: Boolean(r.critical_review), requiresManagerConfirmation: true, status: r.status,
  finalPriority: r.final_priority, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
  note: r.suggested_priority ? 'A recommendation, not a decision. The manager confirms the priority.' : 'Not enough rated factors to recommend a priority. Nothing was guessed.'
})

export function listRecommendations(db, taskId) {
  return db.prepare('SELECT * FROM priority_recommendations WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20').all(taskId).map(present)
}

/** Computes and stores a recommendation. Does not touch the task's priority. */
export function recommendPriority(db, ctx, taskId) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (!canManageTask(db, ctx, task)) throw forbidden('Only the task’s manager can ask for a priority recommendation.')
  ensureExpectations(db, task)
  const ex = getExpectations(db, task.id)
  const model = modelFor(db, ctx.orgId)
  const s = scoreFactors(factorInputs(db, task, ex), model)
  const id = uuid()
  const ts = now()
  const criticalReview = s.suggestedPriority === 'CRITICAL' || Boolean(ex?.verified_incident)
  db.prepare(`UPDATE priority_recommendations SET status = 'SUPERSEDED' WHERE task_id = ? AND status = 'OPEN'`).run(task.id)
  db.prepare(`INSERT INTO priority_recommendations (id, org_id, task_id, score, raw_score, known_weight, suggested_priority, confidence, factors, config_version, critical_review, status, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`).run(id, ctx.orgId, task.id, s.score, s.rawScore, s.knownWeight, s.suggestedPriority, s.confidence, JSON.stringify(s.breakdown), model.version, criticalReview ? 1 : 0, ctx.user.id, ts)
  return present(db.prepare('SELECT * FROM priority_recommendations WHERE id = ?').get(id))
}

/** ACCEPT confirms the suggestion; OVERRIDE confirms the manager's own level (reason required, audited); REJECT dismisses it. */
export function decideRecommendation(db, ctx, taskId, recId, body) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (!canManageTask(db, ctx, task)) throw forbidden('Only the task’s manager can decide on a recommendation.')
  const r = db.prepare('SELECT * FROM priority_recommendations WHERE id = ? AND task_id = ?').get(v.id(recId, 'Recommendation', { required: true }), task.id)
  if (!r) throw notFound('Recommendation')
  if (r.status !== 'OPEN') throw invalid('That recommendation was already decided or replaced.')
  const decision = v.oneOf(body?.decision, 'Decision', ['ACCEPT', 'OVERRIDE', 'REJECT'], { required: true })
  const reason = v.text(body?.reason, 'Reason', { max: 1000, required: decision === 'OVERRIDE' })
  const ts = now()
  let finalPriority = null
  let status = 'REJECTED'
  if (decision === 'ACCEPT') {
    if (!r.suggested_priority) throw invalid('This recommendation has no priority to accept.')
    finalPriority = r.suggested_priority; status = 'ACCEPTED'
  } else if (decision === 'OVERRIDE') {
    finalPriority = v.oneOf(body?.priority, 'Priority', v.PRIORITIES, { required: true })
    if (finalPriority === r.suggested_priority) throw invalid('That is the recommended level: accept it instead of overriding.')
    status = 'OVERRIDDEN'
  }
  let changed = []
  const apply = () => {
    if (finalPriority) {
      changed = applyConfirmed(db, task, { priority: finalPriority }, { actorId: ctx.user.id, source: 'MANAGER', reason: reason || `Accepted the recommendation (${r.config_version}).`, basedOn: r.id, evidence: { recommendationId: r.id, suggested: r.suggested_priority, score: r.score, configVersion: r.config_version } })
    }
    db.prepare('UPDATE priority_recommendations SET status = ?, final_priority = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(status, finalPriority, ctx.user.id, ts, reason, r.id)
    if (decision === 'OVERRIDE') audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'priority.override', entityType: 'task', entityId: task.id, before: { recommended: r.suggested_priority, score: r.score }, after: { priority: finalPriority, reason } })
  }
  transaction(db, apply)
  if (changed.length) emit({ type: 'parameters.changed', orgId: ctx.orgId, taskId: task.id, actorId: ctx.user.id, fields: changed })
  return present(db.prepare('SELECT * FROM priority_recommendations WHERE id = ?').get(r.id))
}

/**
 * Unconfirmed suggestions for a task that has no confirmed deadline: a response target (from the priority and working calendar) and,
 * only when the manager gave a complexity expectation, a completion target. Always labelled unconfirmed; never stored as a deadline.
 */
export function suggestTargets(db, task, ex, at = Date.now()) {
  const model = modelFor(db, task.org_id)
  const tz = orgTimezone(db, task.org_id)
  const calendar = orgCalendar(db, task.org_id)
  const out = { unconfirmed: true, responseSla: null, completionTarget: null, calendar, timezone: tz, configVersion: model.version }
  if (!ex?.response_sla_amount && task.priority) {
    const sla = model.responseSla[task.priority]
    out.responseSla = { ...sla, basis: `The initial suggestion for ${task.priority.toLowerCase()} priority work (configurable, not a rule).`, respondBy: new Date(addWorkingTime(task.assigned_at ? Date.parse(task.assigned_at) : at, sla.amount, sla.unit, calendar, tz)).toISOString() }
  }
  if (!task.due_at && ex?.complexity_expectation && model.completionTargetDays[ex.complexity_expectation]) {
    const days = model.completionTargetDays[ex.complexity_expectation]
    out.completionTarget = { dueAt: new Date(addWorkingTime(task.assigned_at ? Date.parse(task.assigned_at) : at, days, 'working_days', calendar, tz)).toISOString(), basis: `${days} working day(s) for an expected ${ex.complexity_expectation} task (an initial, configurable suggestion).` }
  }
  return out
}

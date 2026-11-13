// Reading, confirming, correcting and reviewing assessments, and the per-person contribution profile.
// Visibility: a person's assessments are visible to that person, to admins, and to managers who have the person in
// scope — never to other employees (even ones who can see the task). Nobody reviews their own assessment.
// Nothing here ranks people or adds dimensions into a score.
import { json, now, transaction, uuid } from '../db.js'
import { AppError, forbidden, invalid, notFound } from '../errors.js'
import { canManageTask, isAdmin, isManager, managersForTask, requireManager, requireVisibleTask, scopeUserIds } from '../access.js'
import * as v from '../validate.js'
import { audit } from '../services/audit.js'
import { notifyInApp } from '../services/notify.js'
import { raiseAlert } from '../services/alerts.js'
import { CATEGORY_LABELS } from '../services/impact.js'
import { DIMENSIONS, LABELS, RATED } from './rubric.js'
import { aiStatus, requestAnalysis, PROMPT_VERSION } from './engine.js'
import { buildEvidencePack, hashInput, isInsufficient } from './evidence-pack.js'
import { GUARDRAIL_VERSION } from './guardrails.js'
import { rubricFor } from './rubric.js'
import { storeMatches } from '../evidence/matching.js'
import { canSeeEvidence } from '../evidence/service.js'

/** Resolves AI_MODE / AI_SUPERVISED_TASKS ("taskId:owner@email, …") into { mode, tasks: Map(taskId → email|null) }. */
export function aiMode(cfg, provider) {
  const ai = cfg.ai || {}
  const mode = ['off', 'supervised', 'on'].includes(ai.mode) ? ai.mode : provider.simulated ? 'on' : provider.configured ? 'supervised' : 'off'
  const tasks = new Map()
  for (const entry of String(ai.supervisedTasks || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, email] = entry.split(':').map((x) => x.trim())
    if (/^[0-9a-f-]{36}$/i.test(id)) tasks.set(id.toLowerCase(), email ? email.toLowerCase() : null)
  }
  return { mode, tasks }
}

function supervisedCheck(db, ctx, mode, task, provider) {
  // No provider at all: the engine answers (rules for too little evidence, otherwise a clear 503 "not configured").
  if (mode.mode === 'on' || !provider.configured) return
  if (mode.mode === 'off') throw new AppError(403, 'ai_off', 'AI analysis is switched off on this server (AI_MODE=off).')
  if (!isAdmin(ctx)) throw new AppError(403, 'ai_supervised', 'AI analysis is in supervised validation: only an administrator can start it, on a selected task.')
  if (!mode.tasks.has(task.id)) throw new AppError(403, 'ai_supervised', 'AI analysis is in supervised validation: this task is not one of the selected tasks (AI_SUPERVISED_TASKS). Nothing was sent.')
  const expected = mode.tasks.get(task.id)
  const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(task.assignee_id)?.email?.toLowerCase()
  if (expected && owner !== expected) throw new AppError(409, 'supervised_owner_mismatch', 'This task is not owned by the person named for the supervised test. Nothing was sent.')
}

const userName = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)
export const canSeeSubject = (db, ctx, userId) => userId === ctx.user.id || isAdmin(ctx) || (ctx.role === 'manager' && scopeUserIds(db, ctx).includes(userId))
const canReviewSubject = (db, ctx, userId) => isManager(ctx) && userId !== ctx.user.id && canSeeSubject(db, ctx, userId)
const levelText = (dim, level) => (level == null ? null : dim === 'complexity' ? `L${level}` : String(level))

function dimensionRows(db, assessmentId) {
  return db.prepare(`SELECT d.*, u.name AS author_name FROM assessment_dimensions d LEFT JOIN users u ON u.id = d.author_id WHERE d.assessment_id = ? ORDER BY d.created_at, d.rowid`).all(assessmentId)
}

function presentAssessment(db, a) {
  const ctxj = json(a.context_json, {})
  const refs = ctxj.refs || {}
  const resolve = (list) => list.map((r) => ({ ref: r, label: refs[r]?.label || r, kind: refs[r]?.kind || null, href: refs[r]?.href || (refs[r]?.taskId ? `#/tasks/${refs[r].taskId}` : null) }))
  const rows = dimensionRows(db, a.id)
  const dims = {}
  for (const k of DIMENSIONS) {
    const all = rows.filter((r) => r.dimension === k)
    const eff = all.find((r) => r.is_effective) || all.at(-1)
    const original = all[0]
    dims[k] = {
      key: k, label: LABELS[k], state: eff.state, level: eff.level, levelText: levelText(k, eff.level), confidence: eff.confidence, reason: eff.reason,
      evidence: resolve(json(eff.evidence_refs, [])), source: eff.source,
      original: original.id !== eff.id ? { state: original.state, level: original.level, levelText: levelText(k, original.level), reason: original.reason, source: original.source } : null,
      adjustments: all.filter((r) => r.source === 'manager').map((r) => ({ level: r.level, levelText: levelText(k, r.level), reason: r.change_reason, by: r.author_name, at: r.created_at }))
    }
  }
  const impact = json(a.impact_json, {})
  const named = (list = []) => list.map((x) => ({ ...x, categoryLabel: x.category ? CATEGORY_LABELS[x.category] : undefined, otherContributors: (x.otherContributors || []).map((id) => userName(db, id)) }))
  const feedback = db.prepare(`SELECT f.*, u.name AS actor_name FROM assessment_feedback f JOIN users u ON u.id = f.actor_id WHERE f.assessment_id = ? ORDER BY f.created_at, f.rowid`).all(a.id)
    .map((f) => ({ id: f.id, action: f.action, actorRole: f.actor_role, by: f.actor_name, dimension: f.dimension, dimensionLabel: f.dimension ? LABELS[f.dimension] : null, fromLevel: levelText(f.dimension, f.from_level), toLevel: levelText(f.dimension, f.to_level), comment: f.comment, at: f.created_at }))
  return {
    id: a.id, taskId: a.task_id, userId: a.user_id, userName: userName(db, a.user_id), isCurrent: Boolean(a.is_current),
    provider: a.provider, model: a.model, aiMeta: ctxj.ai ?? null, requestedModel: ctxj.requestedModel ?? null, fallback: ctxj.fallback ?? null, live: a.provider !== 'rules' && !ctxj.simulated,
    promptVersion: a.prompt_version, rubricVersion: a.rubric_version, guardrailVersion: ctxj.guardrailVersion ?? null, simulated: Boolean(ctxj.simulated),
    periodStart: a.period_start, periodEnd: a.period_end, createdAt: a.created_at,
    evidenceState: a.evidence_state, understanding: a.understanding, summary: a.summary,
    complexity: dims.complexity, dimensions: RATED.map((k) => dims[k]),
    impact: { basis: impact.basis ?? null, claimed: named(impact.claimed), estimated: (impact.estimated || []).map((e) => ({ ...e, evidence: resolve(e.refs || []) })), evidenceSupported: named(impact.evidenceSupported), verified: named(impact.verified) },
    missing: json(a.missing_json, []),
    context: {
      blockers: (ctxj.blockers || []).map((b) => ({ ...b, label: refs[b.ref]?.label })), blockedOutside: ctxj.blockedOutside, delivered: ctxj.delivered,
      blockerNote: ctxj.blockerNote, effort: ctxj.effort, regression: ctxj.regression, changesRequested: ctxj.changesRequested, reviewApproved: ctxj.reviewApproved,
      shared: (ctxj.shared || []).map((s) => ({ ...s, others: s.others.map((id) => userName(db, id)) })), sharedNote: ctxj.sharedNote, person: ctxj.person
    },
    guardrails: json(a.guardrails_json, []),
    employeeStatus: a.employee_status, managerStatus: a.manager_status,
    requiresEmployeeConfirmation: Boolean(a.requires_employee_confirmation), requiresManagerReview: Boolean(a.requires_manager_review),
    feedback
  }
}

function subjectOf(db, ctx, taskId) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (!task.assignee_id) return { task, subjectId: null }
  if (!canSeeSubject(db, ctx, task.assignee_id)) throw notFound('Assessment')
  return { task, subjectId: task.assignee_id }
}

export function getTaskAssessment(db, ctx, provider, taskId, mode = { mode: 'on', tasks: new Map() }) {
  let s
  try { s = subjectOf(db, ctx, taskId) } catch (error) { if (error.status === 404 && error.message.startsWith('Assessment')) return { hidden: true }; throw error }
  const { task, subjectId } = s
  const ai = { ...aiStatus(provider, mode), selectedForSupervisedTest: mode.mode === 'supervised' ? mode.tasks.has(task.id) : null }
  if (!subjectId) return { available: false, reason: 'This task has no owner yet.', ai }
  const current = db.prepare('SELECT * FROM contribution_assessments WHERE task_id = ? AND user_id = ? AND is_current = 1').get(task.id, subjectId)
  const lastRun = db.prepare('SELECT * FROM ai_evaluation_runs WHERE task_id = ? AND subject_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(task.id, subjectId)
  // Earlier analyses stay as they were, with the people's responses to them (shown so a re-analysis never hides a
  // manager's adjustment or an employee's dispute).
  const history = db.prepare('SELECT id, provider, model, evidence_state, employee_status, manager_status, created_at FROM contribution_assessments WHERE task_id = ? AND user_id = ? AND is_current = 0 ORDER BY created_at DESC').all(task.id, subjectId)
    .map((h) => ({
      id: h.id, provider: h.provider, model: h.model, evidenceState: h.evidence_state, employeeStatus: h.employee_status, managerStatus: h.manager_status, createdAt: h.created_at,
      responses: db.prepare(`SELECT f.action, f.actor_role, f.dimension, f.from_level, f.to_level, f.comment, f.created_at, u.name FROM assessment_feedback f JOIN users u ON u.id = f.actor_id WHERE f.assessment_id = ? ORDER BY f.created_at`).all(h.id)
        .map((f) => ({ action: f.action, actorRole: f.actor_role, by: f.name, dimension: f.dimension, dimensionLabel: f.dimension ? LABELS[f.dimension] : null, fromLevel: levelText(f.dimension, f.from_level), toLevel: levelText(f.dimension, f.to_level), comment: f.comment, at: f.created_at }))
    }))
  const mine = subjectId === ctx.user.id
  return {
    available: true, ai, subjectName: userName(db, subjectId), isMine: mine,
    run: lastRun ? { id: lastRun.id, status: lastRun.status, trigger: lastRun.trigger, error: lastRun.status === 'FAILED' ? lastRun.error : null, provider: lastRun.provider, createdAt: lastRun.created_at, finishedAt: lastRun.finished_at } : null,
    assessment: current ? presentAssessment(db, current) : null,
    history,
    can: {
      analyse: task.status !== 'CANCELLED' && (mode.mode === 'on' || !provider.configured ? (mine || canManageTask(db, ctx, task)) : mode.mode === 'supervised' && isAdmin(ctx) && mode.tasks.has(task.id)),
      preview: mine || canManageTask(db, ctx, task),
      respond: mine && Boolean(current),
      review: Boolean(current) && canReviewSubject(db, ctx, subjectId)
    }
  }
}

export function getAssessmentById(db, ctx, id) {
  const a = db.prepare('SELECT * FROM contribution_assessments WHERE id = ? AND org_id = ?').get(v.id(id, 'Assessment', { required: true }), ctx.orgId)
  if (!a || !canSeeSubject(db, ctx, a.user_id)) throw notFound('Assessment')
  requireVisibleTask(db, ctx, a.task_id)
  return presentAssessment(db, a)
}

export function analyseTask(db, ctx, provider, taskId, { trigger = 'manual', mode = { mode: 'on', tasks: new Map() } } = {}) {
  const { task, subjectId } = subjectOf(db, ctx, taskId)
  if (!subjectId) throw invalid('Assign the task before analysing it.')
  if (subjectId !== ctx.user.id && !canManageTask(db, ctx, task)) throw forbidden('Only the person doing the task or their manager can analyse it.')
  if (task.status === 'CANCELLED') throw invalid('A cancelled task is not analysed.')
  supervisedCheck(db, ctx, mode, task, provider)
  return requestAnalysis(db, provider, { task, subjectId, actorId: ctx.user.id, trigger, notify: mode.mode === 'on', allowReviewed: canReviewSubject(db, ctx, subjectId) })
}

/**
 * Exactly what would be sent to the AI for this task — built from existing KONVO data only, nothing fetched,
 * nothing written, no model call. For checking a task before a supervised test.
 */
export function previewAnalysis(db, ctx, provider, taskId, mode = { mode: 'on', tasks: new Map() }) {
  const { task, subjectId } = subjectOf(db, ctx, taskId)
  if (!subjectId) throw invalid('This task has no owner yet.')
  if (subjectId !== ctx.user.id && !canManageTask(db, ctx, task)) throw forbidden('Only the person doing the task or their manager can preview its analysis input.')
  const { pack, facts } = buildEvidencePack(db, task, subjectId)
  const insufficient = isInsufficient(facts)
  const rubric = rubricFor(db, task.org_id)
  const body = JSON.stringify(pack)
  let blockedBy = null
  try { supervisedCheck(db, ctx, mode, task, provider) } catch (error) { blockedBy = error.message }
  return {
    taskId: task.id, subject: userName(db, subjectId), insufficient, wouldCallModel: !insufficient && provider.configured,
    provider: insufficient ? 'rules' : provider.name, model: insufficient ? null : provider.model, simulated: Boolean(provider.simulated),
    promptVersion: PROMPT_VERSION, guardrailVersion: GUARDRAIL_VERSION, rubricVersion: rubric.version,
    inputHash: hashInput({ pack, prompt: PROMPT_VERSION, guardrails: GUARDRAIL_VERSION, rubric: rubric.version, provider: insufficient ? 'rules' : provider.name, model: insufficient ? null : provider.model }),
    bytes: Buffer.byteLength(body), itemCounts: pack.items.reduce((m, i) => ({ ...m, [i.kind]: (m[i.kind] || 0) + 1 }), {}),
    externalSources: 0, filesOpened: 0, mode: mode.mode, blockedBy, pack
  }
}

function currentFor(db, task, subjectId) {
  const a = db.prepare('SELECT * FROM contribution_assessments WHERE task_id = ? AND user_id = ? AND is_current = 1').get(task.id, subjectId)
  if (!a) throw new AppError(409, 'no_assessment', 'There is no analysis of this work yet.')
  return a
}
function readLevel(body) {
  const dimension = typeof body?.dimension === 'string' ? body.dimension.toLowerCase() : ''
  if (!DIMENSIONS.includes(dimension)) throw invalid(`Dimension must be one of ${DIMENSIONS.join(', ')}.`, { field: 'dimension' })
  const level = Number(body?.level)
  const max = dimension === 'complexity' ? 4 : 5
  if (!Number.isInteger(level) || level < 1 || level > max) throw invalid(`Choose a level from 1 to ${max}.`, { field: 'level' })
  return { dimension, level }
}
const effectiveRow = (db, assessmentId, dimension) => db.prepare('SELECT * FROM assessment_dimensions WHERE assessment_id = ? AND dimension = ? AND is_effective = 1').get(assessmentId, dimension)

/** The employee confirms, proposes a correction, disputes, or adds context. Nothing is overwritten. */
export function employeeRespond(db, ctx, taskId, body) {
  const { task, subjectId } = subjectOf(db, ctx, taskId)
  if (subjectId !== ctx.user.id) throw forbidden('Only the person whose work this is can respond to its analysis.')
  const a = currentFor(db, task, subjectId)
  const action = v.oneOf(body?.action, 'Action', ['CONFIRM', 'PROPOSE_CORRECTION', 'DISPUTE', 'ADD_CONTEXT'], { required: true })
  const comment = v.text(body?.comment, action === 'ADD_CONTEXT' ? 'Context' : 'Reason', { max: 2000, required: action !== 'CONFIRM' })
  let dimension = null; let fromLevel = null; let toLevel = null
  if (action === 'PROPOSE_CORRECTION') {
    const l = readLevel(body); dimension = l.dimension; toLevel = l.level
    fromLevel = effectiveRow(db, a.id, dimension)?.level ?? null
  }
  const status = { CONFIRM: 'CONFIRMED', PROPOSE_CORRECTION: 'CORRECTION_PROPOSED', DISPUTE: 'DISPUTED' }[action]
  const ts = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO assessment_feedback (id, org_id, assessment_id, task_id, subject_user_id, actor_id, actor_role, action, dimension, from_level, to_level, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), ctx.orgId, a.id, task.id, subjectId, ctx.user.id, action, dimension, fromLevel, toLevel, comment, ts)
    if (status) db.prepare('UPDATE contribution_assessments SET employee_status = ?, updated_at = ? WHERE id = ?').run(status, ts, a.id)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `assessment.employee_${action.toLowerCase()}`, entityType: 'assessment', entityId: a.id, before: { employeeStatus: a.employee_status }, after: { employeeStatus: status || a.employee_status, dimension, fromLevel, toLevel, comment } })
    if (action === 'DISPUTE') {
      // A dispute is a human intervention: an alert (in-app, and M91 when the org turned that rule on).
      raiseAlert(db, { orgId: ctx.orgId, rule: 'assessment_disputed', userIds: managersForTask(db, task).filter((m) => m !== ctx.user.id), taskId: task.id, title: `${ctx.user.name} disputes the analysis of “${task.title}”`, body: comment, link: `#/tasks/${task.id}`, anchor: `${a.id}:${ts}` })
    }
    if (action === 'PROPOSE_CORRECTION') {
      for (const m of managersForTask(db, task)) {
        if (m === ctx.user.id) continue
        notifyInApp(db, { orgId: ctx.orgId, userId: m, kind: 'assessment_feedback', title: `${ctx.user.name} ${action === 'DISPUTE' ? 'disputes' : 'proposes a correction to'} the analysis of “${task.title}”`, body: comment, link: `#/tasks/${task.id}`, taskId: task.id, dedupeKey: `assessment:${a.id}:${action}:${ts}` })
      }
    }
  })
  return { ok: true }
}

/** A manager approves, adjusts one dimension (reason required: a new row; the AI's stays), or disputes. */
export function managerReview(db, ctx, taskId, body) {
  requireManager(ctx)
  const { task, subjectId } = subjectOf(db, ctx, taskId)
  if (!subjectId || !canReviewSubject(db, ctx, subjectId)) throw forbidden(subjectId === ctx.user.id ? 'You cannot review the analysis of your own work.' : 'You cannot review this person\'s work.')
  const a = currentFor(db, task, subjectId)
  const action = v.oneOf(body?.action, 'Action', ['APPROVE', 'ADJUST', 'MANAGER_DISPUTE'], { required: true })
  const comment = v.text(body?.comment, 'Reason', { max: 2000, required: action !== 'APPROVE' })
  const ts = now()
  let change = null
  transaction(db, () => {
    if (action === 'ADJUST') {
      const { dimension, level } = readLevel(body)
      const prev = effectiveRow(db, a.id, dimension)
      db.prepare('UPDATE assessment_dimensions SET is_effective = 0 WHERE id = ?').run(prev.id)
      db.prepare(`INSERT INTO assessment_dimensions (id, org_id, assessment_id, dimension, state, level, confidence, reason, evidence_refs, source, author_id, change_reason, supersedes_id, is_effective, created_at)
                  VALUES (?, ?, ?, ?, 'assessed', ?, NULL, ?, ?, 'manager', ?, ?, ?, 1, ?)`)
        .run(uuid(), ctx.orgId, a.id, dimension, level, `Set by ${ctx.user.name}: ${comment}`, prev.evidence_refs, ctx.user.id, comment, prev.id, ts)
      change = { dimension, fromLevel: prev.level, toLevel: level }
    }
    db.prepare(`INSERT INTO assessment_feedback (id, org_id, assessment_id, task_id, subject_user_id, actor_id, actor_role, action, dimension, from_level, to_level, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manager', ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), ctx.orgId, a.id, task.id, subjectId, ctx.user.id, action, change?.dimension ?? null, change?.fromLevel ?? null, change?.toLevel ?? null, comment, ts)
    const status = { APPROVE: 'APPROVED', ADJUST: 'ADJUSTED', MANAGER_DISPUTE: 'DISPUTED' }[action]
    db.prepare('UPDATE contribution_assessments SET manager_status = ?, updated_at = ? WHERE id = ?').run(status, ts, a.id)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `assessment.manager_${action.toLowerCase()}`, entityType: 'assessment', entityId: a.id, before: { managerStatus: a.manager_status, ...(change ? { level: change.fromLevel } : {}) }, after: { managerStatus: status, ...(change || {}), reason: comment } })
    notifyInApp(db, { orgId: ctx.orgId, userId: subjectId, kind: 'assessment_review', title: `${ctx.user.name} ${action === 'APPROVE' ? 'approved' : action === 'ADJUST' ? 'adjusted' : 'disputed'} the analysis of “${task.title}”`, body: comment, link: `#/tasks/${task.id}`, taskId: task.id, dedupeKey: `assessment:${a.id}:${action}:${ts}` })
  })
  return { ok: true }
}

// ---------- profiles ----------
function period(q) {
  const to = v.dateTime(q?.to, 'To') || now()
  const from = v.dateTime(q?.from, 'From') || new Date(Date.parse(to) - 90 * 86400000).toISOString()
  return { from, to }
}

function verifiedOutcomes(db, orgId, userId, { from, to }) {
  return db.prepare(`SELECT * FROM impact_records WHERE org_id = ? AND verification_status = 'VERIFIED' AND COALESCE(verified_at, created_at) BETWEEN ? AND ? ORDER BY verified_at DESC`).all(orgId, from, to)
    .filter((r) => r.user_id === userId || json(r.contributors, []).includes(userId))
    .map((r) => {
      const others = [...new Set([r.user_id, ...json(r.contributors, [])])].filter((u) => u !== userId)
      const keyOthers = r.shared_outcome_key ? db.prepare(`SELECT DISTINCT user_id FROM impact_records WHERE org_id = ? AND shared_outcome_key = ? AND user_id != ?`).all(orgId, r.shared_outcome_key, userId).map((x) => x.user_id) : []
      const all = [...new Set([...others, ...keyOthers])]
      return {
        impactId: r.id, title: r.title, category: r.category, categoryLabel: CATEGORY_LABELS[r.category], result: r.result, taskId: r.task_id,
        value: r.value_type === 'NONE' ? null : { kind: r.value_type, amount: r.measurable_value, unit: r.measurement_unit },
        role: r.user_id === userId ? 'recorded by them' : 'named contributor', shared: all.length > 0, otherContributors: all.map((id) => userName(db, id)),
        outcomeKey: r.shared_outcome_key ? `shared:${r.shared_outcome_key}` : `impact:${r.id}`
      }
    })
}

function personSummary(db, ctx, userId, p) {
  const rows = db.prepare(`SELECT a.*, t.title AS task_title, t.status AS task_status FROM contribution_assessments a JOIN tasks t ON t.id = a.task_id
                           WHERE a.org_id = ? AND a.user_id = ? AND a.is_current = 1 AND COALESCE(a.period_end, a.created_at) BETWEEN ? AND ? ORDER BY a.period_end DESC`).all(ctx.orgId, userId, p.from, p.to)
  const items = rows.map((a) => {
    const eff = Object.fromEntries(DIMENSIONS.map((k) => [k, effectiveRow(db, a.id, k)]))
    return { a, eff }
  })
  const complexityMix = { L1: 0, L2: 0, L3: 0, L4: 0, insufficient: 0 }
  const dims = Object.fromEntries(RATED.map((k) => [k, { label: LABELS[k], assessed: 0, levels: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, insufficient: 0, notApplicable: 0, highlights: [] }]))
  let outsideHours = 0; let blockedItems = 0
  const reviews = { awaitingEmployee: 0, awaitingManager: 0, employeeDisputes: 0, managerAdjusted: 0, managerDisputed: 0 }
  const estimated = []
  for (const { a, eff } of items) {
    const c = eff.complexity
    if (c.state === 'assessed') complexityMix[`L${c.level}`]++; else complexityMix.insufficient++
    for (const k of RATED) {
      const d = eff[k]; const s = dims[k]
      if (d.state === 'assessed') { s.assessed++; s.levels[d.level]++; s.highlights.push({ taskId: a.task_id, taskTitle: a.task_title, level: d.level, complexity: c.level, reason: d.reason, source: d.source }) }
      else if (d.state === 'not_applicable') s.notApplicable++
      else s.insufficient++
    }
    const ctxj = json(a.context_json, {})
    const outside = (ctxj.blockers || []).filter((b) => b.outside)
    if (outside.length) { blockedItems++; outsideHours += outside.reduce((n, b) => n + (b.hours ?? Math.round((Date.now() - Date.parse(b.reportedAt)) / 3600000)), 0) }
    if (a.employee_status === 'PENDING') reviews.awaitingEmployee++
    if (a.manager_status === 'PENDING') reviews.awaitingManager++
    if (['CORRECTION_PROPOSED', 'DISPUTED'].includes(a.employee_status)) reviews.employeeDisputes++
    if (a.manager_status === 'ADJUSTED') reviews.managerAdjusted++
    if (a.manager_status === 'DISPUTED') reviews.managerDisputed++
    for (const e of json(a.impact_json, {}).estimated || []) estimated.push({ taskId: a.task_id, taskTitle: a.task_title, text: e.text })
  }
  // Highlights: the reasons behind the most complex, highest-rated work, so a manager need not open every task.
  for (const s of Object.values(dims)) s.highlights = s.highlights.sort((x, y) => (y.complexity ?? 0) - (x.complexity ?? 0) || y.level - x.level).slice(0, 3)
  const verified = verifiedOutcomes(db, ctx.orgId, userId, p)
  const work = items.map(({ a, eff }) => ({
    assessmentId: a.id, taskId: a.task_id, taskTitle: a.task_title, taskStatus: a.task_status, periodEnd: a.period_end, provider: a.provider, simulated: Boolean(json(a.context_json, {}).simulated),
    evidenceState: a.evidence_state, complexity: eff.complexity.state === 'assessed' ? `L${eff.complexity.level}` : null, employeeStatus: a.employee_status, managerStatus: a.manager_status,
    levels: Object.fromEntries(RATED.map((k) => [k, eff[k].state === 'assessed' ? eff[k].level : eff[k].state === 'not_applicable' ? 'n/a' : null]))
  }))
  return { complexityMix, dimensions: dims, verified, estimated, blockers: { itemsAffected: blockedItems, outsideControlHours: outsideHours }, reviews, work }
}

function narrative(s) {
  const parts = []
  const mix = Object.entries(s.complexityMix).filter(([k, n]) => n && k !== 'insufficient').map(([k, n]) => `${n}× ${k}`)
  parts.push(`${s.work.length} analysed piece(s) of work${mix.length ? ` (${mix.join(', ')})` : ''}${s.complexityMix.insufficient ? `; ${s.complexityMix.insufficient} without enough evidence to judge` : ''}.`)
  const q = s.dimensions.quality
  if (q.assessed) parts.push(`Quality assessed on ${q.assessed}: ${Object.entries(q.levels).filter(([, n]) => n).map(([l, n]) => `${n}× level ${l}`).join(', ')}.`)
  if (s.verified.length) parts.push(`${s.verified.length} manager-verified outcome(s)${s.verified.some((x) => x.shared) ? `, ${s.verified.filter((x) => x.shared).length} shared with others` : ''}.`)
  else parts.push('No manager-verified outcomes in this period.')
  if (s.blockers.itemsAffected) parts.push(`${s.blockers.itemsAffected} piece(s) of work were held up by blockers outside their control (about ${s.blockers.outsideControlHours}h) — context, not a fault.`)
  if (s.reviews.employeeDisputes) parts.push(`${s.reviews.employeeDisputes} analysis/analyses disputed or corrected by them.`)
  return parts.join(' ')
}

export function personProfile(db, ctx, userId, q = {}) {
  const uid = v.id(userId, 'Person', { required: true })
  const m = db.prepare(`SELECT m.role, m.title, u.name, t.name AS team FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND m.org_id = ?`).get(uid, ctx.orgId)
  if (!m || !canSeeSubject(db, ctx, uid)) throw notFound('Person')
  const p = period(q)
  const s = personSummary(db, ctx, uid, p)
  return {
    person: { id: uid, name: m.name, role: m.role, title: m.title, team: m.team }, period: p, ...s, narrative: narrative(s),
    canReview: canReviewSubject(db, ctx, uid),
    note: 'Decision support, not a score or a ranking. Levels are per task with reasons and evidence; estimates are labelled; managers make the judgement.'
  }
}

export function teamOverview(db, ctx, q = {}) {
  requireManager(ctx)
  const p = period(q)
  const ids = scopeUserIds(db, ctx).filter((id) => id !== ctx.user.id)
  const people = ids.length ? db.prepare(`SELECT m.user_id, m.role, m.title, u.name, t.name AS team FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN teams t ON t.id = m.team_id
                                          WHERE m.org_id = ? AND m.status = 'active' AND m.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY u.name COLLATE NOCASE`).all(ctx.orgId, ...ids) : []
  const teamOutcomes = new Map()
  const rows = people.map((x) => {
    const s = personSummary(db, ctx, x.user_id, p)
    for (const o of s.verified) if (!teamOutcomes.has(o.outcomeKey)) teamOutcomes.set(o.outcomeKey, o)
    return {
      userId: x.user_id, name: x.name, role: x.role, title: x.title, team: x.team,
      analysed: s.work.length, complexityMix: s.complexityMix, verifiedOutcomes: s.verified.length, sharedOutcomes: s.verified.filter((o) => o.shared).length,
      blockedByOthers: s.blockers.itemsAffected, awaitingYourReview: s.reviews.awaitingManager, disputes: s.reviews.employeeDisputes, insufficient: s.complexityMix.insufficient
    }
  })
  return {
    period: p, ordering: 'alphabetical', people: rows,
    team: { verifiedOutcomes: teamOutcomes.size, note: 'Shared outcomes are counted once for the team, however many people contributed.' },
    note: 'Listed alphabetically. Not a ranking: the number of tasks is not a measure of contribution. Open a person to see what their work involved and why.'
  }
}

// ---------- sprint 2: whole-work analysis and team intelligence ----------

const ANALYSE_LIMIT = 10
/**
 * "Analyse my work" (or a manager's "analyse this person"): refresh evidence matching for the person, then analyse each
 * recent task through the normal path — same supervised gate, data-policy gate, dedupe (unchanged input = no call),
 * reviewed-analysis protection and rate limit. Returns what happened per task; nothing is published anywhere.
 */
export function analyseWork(db, ctx, provider, mode, { userId } = {}) {
  const subject = userId ? v.id(userId, 'Person', { required: true }) : ctx.user.id
  if (subject !== ctx.user.id && !canReviewSubject(db, ctx, subject)) throw notFound('Person')
  const since = new Date(Date.now() - 60 * 86400000).toISOString()
  let rematched = 0
  for (const e of db.prepare(`SELECT * FROM external_evidence WHERE org_id = ? AND actor_user_id = ? AND status = 'active' AND occurred_at >= ?`).all(ctx.orgId, subject, since)) rematched += storeMatches(db, e)
  const tasks = db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND assignee_id = ? AND status IN ('IN_PROGRESS','BLOCKED','SUBMITTED_FOR_REVIEW','COMPLETED') AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`)
    .all(ctx.orgId, subject, new Date(Date.now() - 30 * 86400000).toISOString(), ANALYSE_LIMIT)
  const results = []
  for (const t of tasks) {
    try {
      const out = analyseTask(db, ctx, provider, t.id, { mode })
      results.push({ taskId: t.id, title: t.title, status: out.status })
    } catch (error) {
      results.push({ taskId: t.id, title: t.title, status: 'not_analysed', code: error.code || 'error', reason: error.message })
    }
  }
  return {
    subject: userName(db, subject), tasks: results.length, rematched, results,
    pendingConfirmations: db.prepare(`SELECT COUNT(*) AS n FROM evidence_task_links l JOIN external_evidence e ON e.id = l.evidence_id WHERE e.org_id = ? AND (l.contributor_id = ? OR e.actor_user_id = ?) AND l.status = 'suggested'`).get(ctx.orgId, subject, subject).n
  }
}

/**
 * Team Intelligence (managers): significant contributions with their reasons, open blockers (outside-control marked),
 * evidence needing a decision, and per person the overview — never a ranking or an activity count.
 */
export function teamIntelligence(db, ctx, q = {}) {
  requireManager(ctx)
  const overview = teamOverview(db, ctx, q)
  const ids = overview.people.map((p) => p.userId)
  const ph = ids.map(() => '?').join(',')
  const significant = ids.length ? db.prepare(`SELECT a.*, t.title AS task_title FROM contribution_assessments a JOIN tasks t ON t.id = a.task_id WHERE a.org_id = ? AND a.is_current = 1 AND a.user_id IN (${ph}) AND a.created_at >= ? ORDER BY a.created_at DESC LIMIT 200`).all(ctx.orgId, ...ids, overview.period.from) : []
  const sig = []
  for (const a of significant) {
    const c = effectiveRow(db, a.id, 'complexity')
    const imp = effectiveRow(db, a.id, 'impact')
    const verified = (json(a.impact_json, {}).verified || []).length
    if (!((c?.state === 'assessed' && c.level >= 3) || verified)) continue
    const ctxj = json(a.context_json, {})
    sig.push({
      assessmentId: a.id, taskId: a.task_id, taskTitle: a.task_title, userId: a.user_id, name: userName(db, a.user_id), at: a.created_at,
      complexity: c?.state === 'assessed' ? `L${c.level}` : null, complexityReason: c?.reason, impact: imp?.state === 'assessed' ? imp.level : null, verifiedOutcomes: verified,
      externalEvidence: (ctxj.external || []).filter((x) => x.author === 'employee').length > 0, sharedWithOthers: (ctxj.external || []).some((x) => x.author === 'teammate') || (ctxj.shared || []).length > 0,
      managerStatus: a.manager_status, employeeStatus: a.employee_status, simulated: Boolean(ctxj.simulated)
    })
  }
  const blockers = ids.length ? db.prepare(`SELECT b.*, t.title AS task_title, t.assignee_id FROM blockers b JOIN tasks t ON t.id = b.task_id WHERE b.org_id = ? AND b.status = 'OPEN' AND t.assignee_id IN (${ph}) ORDER BY b.reported_at`).all(ctx.orgId, ...ids)
    .map((b) => ({ id: b.id, taskId: b.task_id, taskTitle: b.task_title, userId: b.assignee_id, name: userName(db, b.assignee_id), description: b.description, outsideControl: Boolean(b.is_external) || Boolean(b.dependency_owner_id && b.dependency_owner_id !== b.assignee_id), since: b.reported_at, escalated: Boolean(b.escalated_at) })) : []
  const review = db.prepare(`SELECT e.* FROM external_evidence e WHERE e.org_id = ? AND e.status = 'active' AND (e.attribution IN ('disputed','unknown') OR EXISTS (SELECT 1 FROM evidence_task_links l WHERE l.evidence_id = e.id AND l.share = 'shared' AND l.status = 'suggested')) ORDER BY e.occurred_at DESC LIMIT 100`).all(ctx.orgId)
    .filter((e) => canSeeEvidence(db, ctx, e))
  return {
    ...overview, significant: sig.slice(0, 15), blockers,
    evidenceReview: { disputed: review.filter((e) => e.attribution === 'disputed').length, unknownAuthor: review.filter((e) => e.attribution === 'unknown').length, sharedPending: review.filter((e) => !['disputed', 'unknown'].includes(e.attribution)).length },
    note: 'Not a ranking. External activity (commits, messages, emails, meetings) is never counted; it only adds context to tasks people did.'
  }
}

// Impact records: what changed because of someone's work. Separate from task completion; verified by a manager.
// No scores: contributions are shown by category, evidence and verification status.
import { now, transaction, uuid, json } from '../db.js'
import { conflict, forbidden, invalid, notFound } from '../errors.js'
import { isManager, requireManager, requireVisibleTask, scopeUserIds } from '../access.js'
import * as v from '../validate.js'
import { listEvidence, setImpactVisibility } from './evidence.js'
import { notifyInApp } from './notify.js'
import { audit } from './audit.js'
import { emit } from './events.js'

export const CATEGORY_LABELS = {
  REVENUE_GROWTH: 'Revenue or growth', CUSTOMER_EXPERIENCE: 'Customer experience', TIME_SAVED: 'Time saved', RELIABILITY: 'Reliability',
  COST_REDUCTION: 'Cost reduction', OPERATIONAL_EFFICIENCY: 'Operational efficiency', KNOWLEDGE_INNOVATION: 'Knowledge sharing and innovation'
}

const visibleTo = (db, ctx, r) => r.org_id === ctx.orgId && (r.user_id === ctx.user.id || (isManager(ctx) && scopeUserIds(db, ctx).includes(r.user_id)))
setImpactVisibility(visibleTo)

function readFields(db, ctx, body, current = {}) {
  const pick = (k) => (body?.[k] !== undefined ? body[k] : current[k])
  const f = {
    title: v.text(pick('title'), 'Title', { required: true, max: 200 }),
    category: v.oneOf(pick('category'), 'Impact category', v.IMPACT_CATEGORIES, { required: true }),
    outcome_type: v.oneOf(pick('outcomeType'), 'Outcome type', v.OUTCOME_TYPES, { fallback: 'DELIVERED' }),
    previous_state: v.text(pick('previousState'), 'Problem or opportunity', { max: 4000 }) ?? '',
    work_performed: v.text(pick('workPerformed'), 'What was done', { max: 4000 }) ?? '',
    result: v.text(pick('result'), 'What changed', { max: 4000 }) ?? '',
    value_type: v.oneOf(pick('valueType'), 'Value type', v.VALUE_TYPES, { fallback: 'NONE' }),
    measurable_value: v.number(pick('measurableValue'), 'Measurable value'),
    measurement_unit: v.text(pick('measurementUnit'), 'Measurement unit', { max: 40 }),
    is_reusable: pick('isReusable') === true ? 1 : 0,
    is_quality: pick('isQuality') === true ? 1 : 0,
    shared_outcome_key: v.text(pick('sharedOutcomeKey'), 'Shared outcome', { max: 80 })
  }
  // Never invent a number: a value needs a unit and a stated kind (measured or estimated); none means none.
  if (f.value_type === 'NONE') { f.measurable_value = null; f.measurement_unit = null }
  else {
    if (f.measurable_value === null) throw invalid('Enter the value, or choose “No measurable value”.', { field: 'measurableValue' })
    if (!f.measurement_unit) throw invalid('Enter the unit of the value (e.g. hours/week, ₹, % fewer errors).', { field: 'measurementUnit' })
  }
  // An unsuccessful experiment is learning, not a business outcome: it carries no value.
  if (f.outcome_type === 'LEARNING' && f.value_type !== 'NONE') throw invalid('A learning record (an experiment that did not work out) cannot claim a business value. Choose “No measurable value”.', { field: 'valueType' })
  const contributors = pick('contributors')
  f.contributors = Array.isArray(contributors) ? contributors.slice(0, 20).map((c) => v.id(c, 'Contributor')) : json(current.contributors, [])
  for (const c of f.contributors) {
    if (!db.prepare(`SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?`).get(ctx.orgId, c)) throw invalid('Contributors must be members of your organization.')
  }
  if (f.contributors.length && !f.shared_outcome_key) f.shared_outcome_key = null
  return f
}

/**
 * Where a contribution stands, derived from existing records only (nothing is promoted automatically):
 *  CLAIMED   the contributor described it; nothing is attached
 *  SUPPORTED evidence (a link or file) is attached; no manager has judged it yet
 *  REVIEWED  a manager reviewed it and did not verify it (the reason is on the record); the contributor can correct and resubmit
 *  VERIFIED  a manager confirmed the result
 */
export function contributionStage(status, evidenceCount) {
  return status === 'VERIFIED' ? 'VERIFIED' : status === 'REJECTED' ? 'REVIEWED' : evidenceCount > 0 ? 'SUPPORTED' : 'CLAIMED'
}

export function presentImpact(db, r, { withEvidence = false } = {}) {
  const u = (id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)
  const evidenceCount = db.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE owner_type = 'impact' AND owner_id = ?`).get(r.id).n
  return {
    stage: contributionStage(r.verification_status, evidenceCount), evidenceCount,
    id: r.id, userId: r.user_id, userName: u(r.user_id), taskId: r.task_id,
    taskTitle: r.task_id ? db.prepare('SELECT title FROM tasks WHERE id = ?').get(r.task_id)?.title ?? null : null,
    title: r.title, category: r.category, categoryLabel: CATEGORY_LABELS[r.category], outcomeType: r.outcome_type,
    previousState: r.previous_state, workPerformed: r.work_performed, result: r.result,
    valueType: r.value_type, measurableValue: r.measurable_value, measurementUnit: r.measurement_unit, isEstimate: r.value_type === 'ESTIMATED',
    isReusable: Boolean(r.is_reusable), isQuality: Boolean(r.is_quality), sharedOutcomeKey: r.shared_outcome_key,
    contributors: json(r.contributors, []).map((id) => ({ id, name: u(id) })),
    verificationStatus: r.verification_status, verifiedByName: u(r.verified_by), verifiedAt: r.verified_at, rejectionReason: r.rejection_reason,
    createdAt: r.created_at, updatedAt: r.updated_at,
    ...(withEvidence ? {
      evidence: listEvidence(db, 'impact', r.id),
      reviews: db.prepare(`SELECT m.*, u.name AS reviewer FROM manager_reviews m JOIN users u ON u.id = m.reviewer_id WHERE m.subject_type = 'impact' AND m.subject_id = ? ORDER BY m.created_at`).all(r.id)
        .map((x) => ({ decision: x.decision, comment: x.comment, reviewer: x.reviewer, createdAt: x.created_at }))
    } : {})
  }
}

export function createImpact(db, ctx, body) {
  const f = readFields(db, ctx, body)
  const taskId = v.id(body?.taskId, 'Related task')
  if (taskId) {
    const t = requireVisibleTask(db, ctx, taskId)
    if (t.assignee_id !== ctx.user.id && t.created_by !== ctx.user.id && !isManager(ctx)) throw forbidden('You can link impact only to your own tasks.')
  }
  const links = v.links(body?.evidenceLinks, 'Evidence links')
  if (!f.previous_state && !f.work_performed && !f.result && !links.length) throw invalid('Add at least what you did, the problem or what changed, or a link to evidence. A short record is fine.')
  // An existing record of the same work is edited or extended, not repeated: the same person, the same title, within the last 90 days.
  const same = db.prepare(`SELECT id FROM impact_records WHERE org_id = ? AND user_id = ? AND lower(trim(title)) = lower(?) AND created_at >= ?`).get(ctx.orgId, ctx.user.id, f.title.toLowerCase(), new Date(Date.now() - 90 * 86400000).toISOString())
  if (same) throw conflict(`You already recorded a contribution called “${f.title}”. Edit it or add evidence to it instead of recording it again.`, 'duplicate_contribution')
  // The day the work happened (optional). Never in the future, and not older than a year; the record is dated by it.
  const on = v.dateOnly(body?.contributedOn, 'Date of contribution')
  if (on && (on > new Date().toISOString().slice(0, 10) || Date.parse(on) < Date.now() - 366 * 86400000)) throw invalid('The date of the contribution must be within the last year and not in the future.', { field: 'contributedOn' })
  const id = uuid()
  const ts = on ? `${on}T12:00:00.000Z` : now()
  transaction(db, () => {
    db.prepare(`INSERT INTO impact_records (id, org_id, user_id, task_id, title, category, outcome_type, previous_state, work_performed, result, value_type, measurable_value, measurement_unit,
                is_reusable, is_quality, shared_outcome_key, contributors, verification_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
      .run(id, ctx.orgId, ctx.user.id, taskId, f.title, f.category, f.outcome_type, f.previous_state, f.work_performed, f.result, f.value_type, f.measurable_value, f.measurement_unit,
        f.is_reusable, f.is_quality, f.shared_outcome_key, JSON.stringify(f.contributors), ts, now())
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'impact.recorded', entityType: 'impact', entityId: id, after: { title: f.title, taskId, contributedOn: on, evidenceLinks: links.length } })
    for (const l of links) {
      db.prepare(`INSERT INTO evidence (id, org_id, owner_type, owner_id, task_id, kind, url, label, created_by, created_at) VALUES (?, ?, 'impact', ?, ?, 'link', ?, ?, ?, ?)`).run(uuid(), ctx.orgId, id, taskId, l.url, l.label, ctx.user.id, ts)
    }
  })
  emit({ type: 'impact.submitted', orgId: ctx.orgId, impactId: id, actorId: ctx.user.id })
  return getImpact(db, ctx, id)
}

function requireImpact(db, ctx, id) {
  const r = db.prepare('SELECT * FROM impact_records WHERE id = ? AND org_id = ?').get(v.id(id, 'Impact record', { required: true }), ctx.orgId)
  if (!r || !visibleTo(db, ctx, r)) throw notFound('Impact record')
  return r
}

export function getImpact(db, ctx, id) {
  return presentImpact(db, requireImpact(db, ctx, id), { withEvidence: true })
}

export function updateImpact(db, ctx, id, body) {
  const r = requireImpact(db, ctx, id)
  if (r.user_id !== ctx.user.id) throw forbidden('Only the contributor can edit this record.')
  if (r.verification_status === 'VERIFIED') throw conflict('A verified record cannot be changed. Add a new record instead.', 'impact_verified')
  const f = readFields(db, ctx, body, {
    title: r.title, category: r.category, outcomeType: r.outcome_type, previousState: r.previous_state, workPerformed: r.work_performed, result: r.result,
    valueType: r.value_type, measurableValue: r.measurable_value, measurementUnit: r.measurement_unit, isReusable: Boolean(r.is_reusable), isQuality: Boolean(r.is_quality),
    sharedOutcomeKey: r.shared_outcome_key, contributors: json(r.contributors, [])
  })
  if (!f.previous_state && !f.work_performed && !f.result && !db.prepare(`SELECT 1 FROM evidence WHERE owner_type = 'impact' AND owner_id = ?`).get(r.id)) throw invalid('Keep at least what you did, the problem or what changed, or evidence. A short record is fine.')
  const changed = ['title', 'category', 'outcome_type', 'previous_state', 'work_performed', 'result', 'value_type', 'measurable_value', 'measurement_unit'].filter((k) => r[k] !== f[k])
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'impact.edited', entityType: 'impact', entityId: r.id, before: Object.fromEntries(changed.map((k) => [k, r[k]])), after: Object.fromEntries(changed.map((k) => [k, f[k]])) })
  // Editing a rejected record re-submits it for verification.
  db.prepare(`UPDATE impact_records SET title = ?, category = ?, outcome_type = ?, previous_state = ?, work_performed = ?, result = ?, value_type = ?, measurable_value = ?, measurement_unit = ?,
              is_reusable = ?, is_quality = ?, shared_outcome_key = ?, contributors = ?, verification_status = 'PENDING', rejection_reason = NULL, updated_at = ? WHERE id = ?`)
    .run(f.title, f.category, f.outcome_type, f.previous_state, f.work_performed, f.result, f.value_type, f.measurable_value, f.measurement_unit, f.is_reusable, f.is_quality, f.shared_outcome_key, JSON.stringify(f.contributors), now(), r.id)
  return getImpact(db, ctx, r.id)
}

/** A manager verifies or rejects a claim (a reason is required to reject). Never their own claim. */
export function verifyImpact(db, ctx, id, body) {
  requireManager(ctx)
  const r = requireImpact(db, ctx, id)
  if (r.user_id === ctx.user.id) throw forbidden('You cannot verify your own impact record.')
  const decision = v.oneOf(body?.decision, 'Decision', ['VERIFIED', 'REJECTED'], { required: true })
  const comment = v.text(body?.comment, decision === 'REJECTED' ? 'Rejection reason' : 'Comment', { max: 2000, required: decision === 'REJECTED' })
  const ts = now()
  transaction(db, () => {
    db.prepare(`UPDATE impact_records SET verification_status = ?, verified_by = ?, verified_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?`)
      .run(decision, ctx.user.id, ts, decision === 'REJECTED' ? comment : null, ts, r.id)
    db.prepare(`INSERT INTO manager_reviews (id, org_id, subject_type, subject_id, task_id, reviewer_id, decision, comment, created_at) VALUES (?, ?, 'impact', ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), ctx.orgId, r.id, r.task_id, ctx.user.id, decision, comment, ts)
    notifyInApp(db, { orgId: ctx.orgId, userId: r.user_id, kind: 'impact_review', title: decision === 'VERIFIED' ? `Impact verified: ${r.title}` : `Impact not verified: ${r.title}`, body: comment, link: `#/impact/${r.id}`, dedupeKey: `impact:${r.id}:${decision}:${ts}` })
  })
  return getImpact(db, ctx, r.id)
}

export function listImpact(db, ctx, q = {}) {
  const where = ['r.org_id = ?']
  const params = [ctx.orgId]
  if (q.userId) {
    const uid = v.id(q.userId, 'Person')
    if (uid !== ctx.user.id && !((isManager(ctx) && scopeUserIds(db, ctx).includes(uid)))) throw notFound('Person')
    where.push('r.user_id = ?'); params.push(uid)
  } else if (q.view === 'mine' || ctx.role === 'employee') {
    where.push('r.user_id = ?'); params.push(ctx.user.id)
  } else if (ctx.role === 'manager') {
    const ids = scopeUserIds(db, ctx)
    where.push(`r.user_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids)
  }
  if (q.status) { where.push('r.verification_status = ?'); params.push(v.oneOf(q.status, 'Status', ['PENDING', 'VERIFIED', 'REJECTED'])) }
  if (q.category) { where.push('r.category = ?'); params.push(v.oneOf(q.category, 'Category', v.IMPACT_CATEGORIES)) }
  if (q.from) { where.push('r.created_at >= ?'); params.push(v.dateTime(q.from, 'From')) }
  if (q.to) { where.push('r.created_at <= ?'); params.push(v.dateTime(q.to, 'To')) }
  return db.prepare(`SELECT r.* FROM impact_records r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 500`).all(...params).map((r) => presentImpact(db, r))
}

/**
 * Contributions per person, by category and evidence — never a single score. Verified values are summed per
 * category + unit + kind (measured vs estimated never mixed); a shared outcome counts once at team level.
 */
export function contributionSummary(db, ctx, q = {}) {
  const records = listImpact(db, ctx, q)
  const people = new Map()
  const teamTotals = new Map()
  const seenShared = new Set()
  for (const r of records) {
    if (!people.has(r.userId)) people.set(r.userId, { userId: r.userId, name: r.userName, byCategory: {}, verified: 0, pending: 0, rejected: 0, learning: 0, prevention: 0, reusable: 0, quality: 0, highlights: [] })
    const p = people.get(r.userId)
    p[r.verificationStatus.toLowerCase()]++
    if (r.outcomeType === 'LEARNING') p.learning++
    if (r.outcomeType === 'PREVENTION') p.prevention++
    if (r.isReusable) p.reusable++
    if (r.isQuality) p.quality++
    if (r.verificationStatus === 'VERIFIED') {
      p.byCategory[r.category] = (p.byCategory[r.category] || 0) + 1
      if (p.highlights.length < 3) p.highlights.push({ id: r.id, title: r.title, result: r.result, value: r.valueType === 'NONE' ? null : `${r.isEstimate ? '≈ ' : ''}${r.measurableValue} ${r.measurementUnit}${r.isEstimate ? ' (estimate)' : ''}` })
      if (r.valueType !== 'NONE') {
        const sharedKey = r.sharedOutcomeKey ? `shared:${r.sharedOutcomeKey}` : null
        if (sharedKey && seenShared.has(sharedKey)) continue
        if (sharedKey) seenShared.add(sharedKey)
        const k = `${r.category}|${r.measurementUnit}|${r.valueType}`
        const tt = teamTotals.get(k) || { category: r.category, categoryLabel: r.categoryLabel, unit: r.measurementUnit, valueType: r.valueType, total: 0, records: 0 }
        tt.total += r.measurableValue
        tt.records++
        teamTotals.set(k, tt)
      }
    }
  }
  return { people: [...people.values()], verifiedTotals: [...teamTotals.values()], recordCount: records.length }
}

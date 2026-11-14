// Missed deadlines: what happened is recorded once per deadline (task event "deadline_missed"), the responsible
// employee explains it, a manager reviews it. Nothing here scores anyone: a missed deadline is an operational signal,
// and the explanation (external dependency, scope change, unrealistic estimate...) is context the measurement uses.
// The employee's first explanation is never edited; later context and every review are new entries.
import { now, transaction, uuid, json } from '../db.js'
import { conflict, forbidden, notFound } from '../errors.js'
import { canManageTask, isManager, requireVisibleTask, taskScopeSql } from '../access.js'
import * as v from '../validate.js'
import { audit } from './audit.js'
import { emit } from './events.js'
import { deriveConditions, markDeadlineMissed, recordEvent } from './tasks.js'

export const REASONS = {
  TECHNICAL_ISSUE: 'Unexpected technical issue',
  DEPENDENCY: 'Dependency on another team or person',
  CLIENT_RESPONSE: 'Waiting for a client response',
  SCOPE_INCREASED: 'Scope increased',
  WORKLOAD_CONFLICT: 'Workload conflict',
  ESTIMATE_WRONG: 'Incorrect deadline estimation',
  CLARIFICATION_PENDING: 'Requirement clarification pending',
  OTHER: 'Other'
}
export const REVIEW_STATUSES = ['REVIEWED', 'ACCEPTED', 'NEEDS_CLARIFICATION', 'FOLLOW_UP_REQUIRED']

/** Every deadline this task missed (even if it was later completed or its deadline moved), oldest first. */
export function missedDeadlines(db, task) {
  const rows = db.prepare(`SELECT json_extract(data, '$.dueAt') AS due_at, json_extract(data, '$.ownerId') AS owner_id, created_at FROM task_events WHERE task_id = ? AND type = 'deadline_missed' ORDER BY created_at`).all(task.id)
  const out = rows.map((r) => ({ dueAt: r.due_at, ownerId: r.owner_id, at: r.created_at }))
  // Overdue right now but not yet written down by the scan: it is a miss all the same.
  if (task.due_at && deriveConditions(task).overdue && !out.some((m) => m.dueAt === task.due_at)) out.push({ dueAt: task.due_at, ownerId: task.assignee_id, at: task.due_at })
  return out
}

function entriesFor(db, id) {
  return db.prepare(`SELECT e.*, u.name FROM deadline_explanation_entries e JOIN users u ON u.id = e.author_id WHERE e.explanation_id = ? ORDER BY e.created_at, e.rowid`).all(id)
    .map((e) => ({ id: e.id, kind: e.kind, reviewStatus: e.review_status, body: e.body, authorName: e.name, authorId: e.author_id, createdAt: e.created_at }))
}

function present(db, r) {
  return {
    id: r.id, taskId: r.task_id, userId: r.user_id, userName: r.user_name ?? null, taskTitle: r.task_title ?? null, originalDeadline: r.original_deadline,
    reasonCategory: r.reason_category, reasonLabel: REASONS[r.reason_category], explanation: r.explanation, evidenceLinks: json(r.evidence_links, []),
    reviewStatus: r.review_status, reviewedByName: r.reviewer_name ?? null, reviewedAt: r.reviewed_at, submittedAt: r.submitted_at, entries: entriesFor(db, r.id)
  }
}
const SELECT = `SELECT x.*, u.name AS user_name, t.title AS task_title, rv.name AS reviewer_name FROM deadline_explanations x JOIN users u ON u.id = x.user_id JOIN tasks t ON t.id = x.task_id LEFT JOIN users rv ON rv.id = x.reviewed_by`

/** For the task page: the misses, which ones still need this person's explanation, and the explanations given. */
export function deadlineView(db, ctx, task) {
  const missed = missedDeadlines(db, task)
  const explanations = db.prepare(`${SELECT} WHERE x.task_id = ? ORDER BY x.submitted_at`).all(task.id).map((r) => present(db, r))
  const responsible = (m) => m.ownerId === ctx.user.id || task.assignee_id === ctx.user.id
  const needed = missed.filter((m) => !explanations.some((x) => x.originalDeadline === m.dueAt) && responsible(m))
  return {
    reasons: Object.entries(REASONS).map(([key, label]) => ({ key, label })),
    missed: missed.map((m) => ({ dueAt: m.dueAt, missedAt: m.at, explained: explanations.some((x) => x.originalDeadline === m.dueAt) })),
    explanationRequired: needed.map((m) => m.dueAt),
    explanations
  }
}

export function submitExplanation(db, ctx, taskId, body) {
  const t = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  const missed = missedDeadlines(db, t)
  const dueAt = body?.dueAt ? v.dateTime(body.dueAt, 'Deadline') : (missed.at(-1)?.dueAt ?? null)
  const miss = missed.find((m) => m.dueAt === dueAt)
  if (!miss) throw conflict('This task has not missed that deadline.', 'no_missed_deadline')
  if (miss.ownerId !== ctx.user.id && t.assignee_id !== ctx.user.id) throw forbidden('Only the person responsible for the task can explain a missed deadline.')
  const category = v.oneOf(body?.reasonCategory, 'Reason', Object.keys(REASONS), { required: true })
  const explanation = v.text(body?.explanation, 'Explanation', { required: category === 'OTHER', min: category === 'OTHER' ? 10 : 0, max: 4000 })
  const links = v.links(body?.evidenceLinks, 'Supporting links')
  const id = uuid()
  const ts = now()
  try {
    transaction(db, () => {
      markDeadlineMissed(db, t, ts)
      db.prepare(`INSERT INTO deadline_explanations (id, org_id, task_id, user_id, original_deadline, reason_category, explanation, evidence_links, review_status, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
        .run(id, t.org_id, t.id, ctx.user.id, dueAt, category, explanation, JSON.stringify(links), ts)
      recordEvent(db, t, ctx.user.id, 'deadline_explained', { explanationId: id, dueAt, reason: REASONS[category] })
      audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'deadline_explanation.submitted', entityType: 'task', entityId: t.id, after: { dueAt, category } })
    })
  } catch (error) {
    if (/UNIQUE/i.test(String(error.message))) throw conflict('This deadline already has an explanation. Add context to it instead.', 'explanation_exists')
    throw error
  }
  emit({ type: 'deadline.explanation_submitted', orgId: ctx.orgId, taskId: t.id, explanationId: id, actorId: ctx.user.id })
  return { id }
}

function requireExplanation(db, ctx, id) {
  const x = db.prepare('SELECT * FROM deadline_explanations WHERE id = ? AND org_id = ?').get(v.id(id, 'Explanation', { required: true }), ctx.orgId)
  if (!x) throw notFound('Explanation')
  const t = requireVisibleTask(db, ctx, x.task_id)
  return { x, t }
}

/** The employee adds to their explanation (for instance after a manager asks for clarification). The original stays as written. */
export function addContext(db, ctx, id, body) {
  const { x, t } = requireExplanation(db, ctx, id)
  if (x.user_id !== ctx.user.id) throw forbidden('Only the person who wrote the explanation can add to it.')
  const text = v.text(body?.body, 'Context', { required: true, min: 3, max: 4000 })
  db.prepare(`INSERT INTO deadline_explanation_entries (id, org_id, explanation_id, author_id, kind, body, created_at) VALUES (?, ?, ?, ?, 'CONTEXT', ?, ?)`).run(uuid(), x.org_id, x.id, ctx.user.id, text, now())
  recordEvent(db, t, ctx.user.id, 'deadline_context_added', { explanationId: x.id })
  emit({ type: 'deadline.explanation_context', orgId: ctx.orgId, taskId: t.id, explanationId: x.id, actorId: ctx.user.id })
  return { ok: true }
}

export function reviewExplanation(db, ctx, id, body) {
  const { x, t } = requireExplanation(db, ctx, id)
  if (!canManageTask(db, ctx, t)) throw forbidden('Only the task’s manager can review an explanation.')
  if (x.user_id === ctx.user.id) throw forbidden('You cannot review your own explanation. Another manager must.')
  const status = v.oneOf(body?.status, 'Decision', REVIEW_STATUSES, { required: true })
  const comment = v.text(body?.comment, 'Comment', { required: ['NEEDS_CLARIFICATION', 'FOLLOW_UP_REQUIRED'].includes(status), min: ['NEEDS_CLARIFICATION', 'FOLLOW_UP_REQUIRED'].includes(status) ? 3 : 0, max: 2000 })
  const ts = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO deadline_explanation_entries (id, org_id, explanation_id, author_id, kind, review_status, body, created_at) VALUES (?, ?, ?, ?, 'REVIEW', ?, ?, ?)`).run(uuid(), x.org_id, x.id, ctx.user.id, status, comment, ts)
    db.prepare('UPDATE deadline_explanations SET review_status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(status, ctx.user.id, ts, x.id)
    recordEvent(db, t, ctx.user.id, 'deadline_explanation_reviewed', { explanationId: x.id, status })
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'deadline_explanation.reviewed', entityType: 'task', entityId: t.id, before: { status: x.review_status }, after: { status } })
  })
  emit({ type: 'deadline.explanation_reviewed', orgId: ctx.orgId, taskId: t.id, explanationId: x.id, status, employeeId: x.user_id, actorId: ctx.user.id })
  return { status }
}

/** Manager queue and history of explanations in scope. */
export function listExplanations(db, ctx, { status } = {}) {
  if (!isManager(ctx)) throw forbidden('Only managers and admins can see the explanation queue.')
  const scope = taskScopeSql(ctx)
  const where = [scope.sql]
  const params = [...scope.params]
  if (status) { where.push('x.review_status = ?'); params.push(v.oneOf(status, 'Status', ['PENDING', ...REVIEW_STATUSES])) }
  return db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY x.submitted_at DESC LIMIT 200`).all(...params).map((r) => present(db, r))
}

/** Context for the measurement: what the record shows about a miss (never a score). */
export function deadlineContext(db, taskId) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  if (!t) return null
  const missed = missedDeadlines(db, t)
  if (!missed.length) return null
  const exp = db.prepare(`SELECT reason_category, explanation, review_status, original_deadline FROM deadline_explanations WHERE task_id = ? ORDER BY submitted_at`).all(t.id)
  const blockers = db.prepare('SELECT is_external, status FROM blockers WHERE task_id = ?').all(t.id)
  const changedDeadline = db.prepare(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND type = 'deadline_changed'`).get(t.id).n
  return {
    note: 'A missed deadline is an operational signal, not a measure of the person or the work. Weigh the circumstances below; do not lower any rating because of the miss alone.',
    missedDeadlines: missed.map((m) => m.dueAt),
    deadlineChanges: changedDeadline,
    blockersRecorded: blockers.length,
    externalBlockersRecorded: blockers.filter((b) => b.is_external).length,
    explanations: exp.map((e) => ({ deadline: e.original_deadline, reason: REASONS[e.reason_category], text: e.explanation, managerReview: e.review_status }))
  }
}

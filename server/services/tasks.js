// Tasks: creation (direct or as a request), assignment, status lifecycle, progress, comments, blockers and review.
// OVERDUE and AT RISK are derived from dates and progress, never stored as statuses.
import { now, transaction, uuid, json } from '../db.js'
import { AppError, conflict, forbidden, invalid, notFound } from '../errors.js'
import { assignableUserIds, canManageTask, isActiveMember, isManager, managersForTask, requireManageTask, requireVisibleTask, scopeUserIds, taskScopeSql } from '../access.js'
import * as v from '../validate.js'
import { audit } from './audit.js'
import { emit } from './events.js'
import { creationMode } from './permissions.js'
import { createRequestRecord } from './requests.js'
import { listEvidence } from './evidence.js'
import { orgTimezone } from '../time.js'
import { announceChange, applyConfirmed, readExpectations, suggestValues } from './task-parameters.js'

const HOUR = 3600000
const ACTIVE = ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED']
const OPEN = ['PENDING_ACCEPTANCE', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW']
export const PRIORITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }

/**
 * Derived conditions.
 * - overdue: has a deadline in the past and is not completed/cancelled; work submitted for review before the deadline is not overdue.
 * - atRisk: active, not yet overdue, and either ≤24h left with progress < 75%, ≥75% of the time window used with
 *   progress < 50%, or blocked with ≤48h left.
 */
export function deriveConditions(task, at = Date.now()) {
  const due = task.due_at ? Date.parse(task.due_at) : null
  const submittedInTime = task.status === 'SUBMITTED_FOR_REVIEW' && task.submitted_at && due && Date.parse(task.submitted_at) <= due
  const overdue = Boolean(due && due < at && !['COMPLETED', 'CANCELLED', 'DECLINED'].includes(task.status) && !submittedInTime)
  let atRisk = false
  if (!overdue && due && ACTIVE.includes(task.status)) {
    const left = due - at
    const startRef = Date.parse(task.start_date || task.assigned_at || task.created_at)
    const window = due - startRef
    const used = window > 0 ? (at - startRef) / window : 1
    atRisk = (left <= 24 * HOUR && task.progress < 75) || (used >= 0.75 && task.progress < 50) || (task.status === 'BLOCKED' && left <= 48 * HOUR)
  }
  return {
    overdue,
    atRisk,
    unassigned: !task.assignee_id && OPEN.includes(task.status),
    hoursOverdue: overdue ? Math.floor((at - due) / HOUR) : 0,
    hoursUntilDue: due && !overdue ? Math.floor((due - at) / HOUR) : null
  }
}

const userName = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)

/** The open (pending) transfer of a task, if any. */
export function pendingTransfer(db, taskId) {
  const r = db.prepare(`SELECT x.*, f.name AS from_name, o.name AS to_name FROM task_transfers x JOIN users f ON f.id = x.from_user_id JOIN users o ON o.id = x.to_user_id WHERE x.task_id = ? AND x.status = 'PENDING'`).get(taskId)
  return r ? { id: r.id, fromUserId: r.from_user_id, fromName: r.from_name, toUserId: r.to_user_id, toName: r.to_name, reason: r.reason, createdAt: r.created_at } : null
}

/** Records that real work moved (started, substantive progress, a blocker, evidence, a submission). Acceptance and views never call this. */
export function touchMeaningful(db, taskId, ts = now()) {
  db.prepare('UPDATE tasks SET last_meaningful_at = ? WHERE id = ?').run(ts, taskId)
}

/** Writes the "deadline_missed" history event once per deadline; it stays even after the task is completed or the deadline moves. */
export function markDeadlineMissed(db, task, at = now()) {
  if (!task.due_at) return false
  const seen = db.prepare(`SELECT 1 FROM task_events WHERE task_id = ? AND type = 'deadline_missed' AND json_extract(data, '$.dueAt') = ?`).get(task.id, task.due_at)
  if (seen) return false
  db.prepare('INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
    .run(uuid(), task.org_id, task.id, 'deadline_missed', JSON.stringify({ dueAt: task.due_at, status: task.status, ownerId: task.assignee_id }), at)
  return true
}

export function presentTask(db, ctx, t) {
  const d = deriveConditions(t)
  const blocker = t.status === 'BLOCKED' ? db.prepare(`SELECT reported_at FROM blockers WHERE task_id = ? AND status = 'OPEN' ORDER BY reported_at LIMIT 1`).get(t.id) : null
  const transfer = OPEN.includes(t.status) ? pendingTransfer(db, t.id) : null
  return {
    acceptanceState: t.acceptance_state, acceptedAt: t.accepted_at, declinedReason: t.declined_reason, slackMessageRef: t.slack_message_ref,
    fromSlack: Boolean(t.slack_message_ref), origin: t.origin, lastMeaningfulAt: t.last_meaningful_at, pendingTransfer: transfer,
    id: t.id, title: t.title, description: t.description, expectedOutcome: t.expected_outcome, priority: t.priority, status: t.status,
    progress: t.progress, startDate: t.start_date, dueAt: t.due_at, links: json(t.links, []),
    teamId: t.team_id, teamName: t.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(t.team_id)?.name ?? null : null,
    createdBy: t.created_by, createdByName: userName(db, t.created_by), assigneeId: t.assignee_id, assigneeName: userName(db, t.assignee_id),
    sourceRequestId: t.source_request_id, assignedAt: t.assigned_at, startedAt: t.started_at, lastProgressAt: t.last_progress_at,
    statusChangedAt: t.status_changed_at, submittedAt: t.submitted_at, completedAt: t.completed_at, createdAt: t.created_at, updatedAt: t.updated_at,
    ...d,
    blockedSince: blocker?.reported_at ?? null,
    blockedHours: blocker ? Math.floor((Date.now() - Date.parse(blocker.reported_at)) / HOUR) : null,
    canManage: ctx ? canManageTask(db, ctx, t) : false,
    isMine: ctx ? t.assignee_id === ctx.user.id : false
  }
}

export function recordEvent(db, task, actorId, type, data = {}) {
  db.prepare('INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), task.org_id, task.id, actorId, type, JSON.stringify(data), now())
}

const getTaskRow = (db, id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)

// ---------- list ----------
const SORTS = {
  due: `CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at`,
  priority: `CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END, t.due_at`,
  updated: 't.updated_at DESC',
  created: 't.created_at DESC',
  title: 't.title COLLATE NOCASE'
}

export function listTasks(db, ctx, q = {}) {
  const scope = taskScopeSql(ctx)
  const where = [scope.sql]
  const params = [...scope.params]
  if (q.view === 'mine') { where.push('t.assignee_id = ?'); params.push(ctx.user.id) }
  if (q.status) {
    const statuses = String(q.status).split(',').map((s) => v.oneOf(s, 'Status', v.TASK_STATUSES))
    where.push(`t.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses)
  } else if (q.includeClosed !== 'true') {
    where.push(`t.status NOT IN ('CANCELLED')`)
  }
  if (q.priority === 'UNRESOLVED') where.push('t.priority IS NULL')
  else if (q.priority) { where.push('t.priority = ?'); params.push(v.oneOf(q.priority, 'Priority', v.PRIORITIES)) }
  if (q.assigneeId === 'none') where.push('t.assignee_id IS NULL')
  else if (q.assigneeId) { where.push('t.assignee_id = ?'); params.push(v.id(q.assigneeId, 'Assignee')) }
  if (q.teamId) { where.push('t.team_id = ?'); params.push(v.id(q.teamId, 'Team')) }
  if (q.q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); const like = `%${String(q.q).slice(0, 100).replace(/[%_]/g, '')}%`; params.push(like, like) }
  const sort = SORTS[q.sort] || SORTS.due
  const rows = db.prepare(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT 500`).all(...params)
  let tasks = rows.map((t) => presentTask(db, ctx, t))
  if (q.condition === 'overdue') tasks = tasks.filter((t) => t.overdue)
  if (q.condition === 'at_risk') tasks = tasks.filter((t) => t.atRisk)
  if (q.condition === 'unassigned') tasks = tasks.filter((t) => t.unassigned)
  return tasks
}

export function getTaskDetail(db, ctx, id) {
  const t = requireVisibleTask(db, ctx, v.id(id, 'Task', { required: true }))
  const events = db.prepare(`SELECT e.*, u.name AS actor_name FROM task_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.task_id = ? ORDER BY e.created_at, e.rowid`).all(t.id)
    .map((e) => ({ id: e.id, type: e.type, actorName: e.actor_name, data: json(e.data, {}), createdAt: e.created_at }))
  const blockers = db.prepare(`SELECT b.*, r.name AS reporter_name, d.name AS dependency_owner_name, x.name AS resolver_name FROM blockers b
                               JOIN users r ON r.id = b.reported_by LEFT JOIN users d ON d.id = b.dependency_owner_id LEFT JOIN users x ON x.id = b.resolved_by
                               WHERE b.task_id = ? ORDER BY b.reported_at DESC`).all(t.id).map(presentBlocker)
  const submissions = db.prepare(`SELECT s.*, u.name AS submitter_name FROM completion_submissions s JOIN users u ON u.id = s.submitted_by WHERE s.task_id = ? ORDER BY s.created_at DESC`).all(t.id)
    .map((s) => ({
      id: s.id, summary: s.summary, outcome: s.outcome, status: s.status, submittedBy: s.submitter_name, createdAt: s.created_at,
      evidence: listEvidence(db, 'submission', s.id),
      reviews: db.prepare(`SELECT r.*, u.name AS reviewer_name FROM manager_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.subject_type = 'submission' AND r.subject_id = ? ORDER BY r.created_at`).all(s.id)
        .map((r) => ({ decision: r.decision, comment: r.comment, reviewer: r.reviewer_name, createdAt: r.created_at }))
    }))
  const impact = db.prepare(`SELECT id, title, category, verification_status FROM impact_records WHERE task_id = ? AND org_id = ?`).all(t.id, ctx.orgId)
    .map((r) => ({ id: r.id, title: r.title, category: r.category, verificationStatus: r.verification_status }))
  const task = presentTask(db, ctx, t)
  return {
    task, events, blockers, submissions, impact, evidence: listEvidence(db, 'task', t.id),
    allowed: allowedActions(db, ctx, t)
  }
}

/** What this user may do to this task right now (the server re-checks on every call). */
function allowedActions(db, ctx, t) {
  const manage = canManageTask(db, ctx, t)
  const assignee = t.assignee_id === ctx.user.id
  const s = t.status
  const transfer = OPEN.includes(s) ? pendingTransfer(db, t.id) : null
  return {
    accept: assignee && s === 'PENDING_ACCEPTANCE',
    decline: assignee && s === 'PENDING_ACCEPTANCE',
    transfer: assignee && ['PENDING_ACCEPTANCE', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(s) && !transfer,
    decideTransfer: Boolean(transfer && transfer.toUserId === ctx.user.id),
    cancelTransfer: Boolean(transfer && (transfer.fromUserId === ctx.user.id || manage)),
    edit: manage,
    assign: manage,
    delete: manage,
    start: assignee && s === 'ASSIGNED',
    progress: assignee && ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(s),
    block: (assignee || manage) && ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(s),
    submit: assignee && ['ASSIGNED', 'IN_PROGRESS'].includes(s),
    review: manage && s === 'SUBMITTED_FOR_REVIEW' && t.assignee_id !== ctx.user.id,
    cancel: manage && OPEN.includes(s),
    reopen: manage && s === 'COMPLETED',
    restore: manage && s === 'CANCELLED',
    comment: true
  }
}

// ---------- create ----------
function readTaskFields(db, ctx, body, { partial = false } = {}) {
  const out = {}
  const has = (k) => body?.[k] !== undefined
  if (!partial || has('title')) out.title = v.text(body?.title, 'Title', { required: true, max: 200 })
  if (!partial || has('description')) out.description = v.text(body?.description, 'Description', { max: 5000 })
  if (!partial || has('expectedOutcome')) out.expected_outcome = v.text(body?.expectedOutcome, 'Expected outcome', { max: 2000 })
  // No priority is a real state (not yet confirmed by a manager), never a silent MEDIUM.
  if (has('priority') && body.priority !== null && body.priority !== '') out.priority = v.oneOf(body.priority, 'Priority', v.PRIORITIES)
  else if (!partial) out.priority = null
  if (!partial || has('startDate')) out.start_date = v.dateOnly(body?.startDate, 'Start date')
  if (!partial || has('dueAt')) out.due_at = v.dateTime(body?.dueAt, 'Due date', { tz: orgTimezone(db, ctx.orgId) })
  if (!partial || has('links')) out.links = JSON.stringify(v.links(body?.links))
  if (!partial || has('teamId')) {
    const teamId = v.id(body?.teamId, 'Team')
    if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(teamId, ctx.orgId)) throw notFound('Team')
    if (teamId && ctx.role === 'manager' && !ctx.managedTeamIds.includes(teamId)) throw forbidden('You can create tasks only in teams you manage.')
    if (teamId && ctx.role === 'employee' && teamId !== ctx.teamId) throw forbidden('You can create tasks only in your own team.')
    out.team_id = teamId
  }
  if (out.start_date && out.due_at && out.due_at.slice(0, 10) < out.start_date) throw invalid('The due date cannot be before the start date.')
  return out
}

/** Checks that this context may assign the task to this person. Returns the assignee id or null. */
export function checkAssignee(db, ctx, assigneeId) {
  if (!assigneeId) return null
  v.id(assigneeId, 'Assignee')
  if (!isActiveMember(db, ctx.orgId, assigneeId)) throw invalid('The assignee must be an active member of your organization.')
  if (!assignableUserIds(db, ctx).includes(assigneeId)) {
    if (ctx.role === 'employee') {
      throw forbidden(assigneeId === ctx.user.id ? 'You do not have permission to assign tasks to yourself.' : 'You do not have permission to assign tasks to other people.')
    }
    throw forbidden('You can assign tasks only to members of teams you manage.')
  }
  return assigneeId
}

/**
 * Managers/admins create official tasks. Employees create directly only with can_create_tasks + can_create_directly
 * and no approval requirement; otherwise the same input becomes a task request for approval.
 */
// `internal` is set only by server code (request approval); it is never read from the HTTP body, so a client cannot claim a provenance or a source request.
export function createTask(db, ctx, body, internal = {}) {
  if (creationMode(ctx) === 'request') {
    const request = createRequestRecord(db, ctx, {
      title: body?.title, description: body?.description, reason: body?.reason || 'Created from the task form (approval required).',
      expectedOutcome: body?.expectedOutcome, suggestedPriority: body?.priority, suggestedDueAt: body?.dueAt, suggestedAssigneeId: body?.assigneeId, teamId: body?.teamId
    })
    return { mode: 'request', request }
  }
  if (ctx.role === 'employee' && !ctx.permissions.can_create_tasks) throw forbidden('You can suggest tasks, but not create them directly.')
  const f = readTaskFields(db, ctx, body)
  const exp = readExpectations(db, ctx.orgId, body)
  const assigneeId = checkAssignee(db, ctx, body?.assigneeId)
  const id = uuid()
  const ts = now()
  // Managers define the official expectations. An employee who may create tasks directly creates the task, but what they enter for
  // priority, deadline and the other expectations stays a proposal until a manager confirms it.
  const byManager = ctx.role !== 'employee'
  const origin = internal.origin || (byManager ? 'MANAGER' : 'EMPLOYEE')
  const teamId = f.team_id || (assigneeId ? db.prepare('SELECT team_id FROM memberships WHERE user_id = ?').get(assigneeId)?.team_id : null) || (ctx.role === 'manager' ? ctx.managedTeamIds[0] : ctx.teamId) || null
  const task = transaction(db, () => {
    db.prepare(`INSERT INTO tasks (id, org_id, team_id, title, description, expected_outcome, created_by, assignee_id, priority, status, progress, start_date, due_at, links,
                source_request_id, assigned_at, status_changed_at, created_at, updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ASSIGNED', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.orgId, teamId, f.title, f.description, null, ctx.user.id, assigneeId, null, f.start_date, null, f.links,
        internal.sourceRequestId ?? null, assigneeId ? ts : null, ts, ts, ts, origin)
    const t = getTaskRow(db, id)
    // Priority, deadline and expected outcome go in through the one path that records who confirmed (or proposed) them, when and from where.
    if (byManager) applyConfirmed(db, t, exp, { actorId: ctx.user.id, source: internal.confirmSource || 'MANAGER', reason: 'Set when the task was created.', quiet: true })
    else suggestValues(db, t, exp, { source: 'EMPLOYEE', actorId: ctx.user.id, reason: 'Entered by the person who created the task; a manager has not confirmed it.' })
    recordEvent(db, t, ctx.user.id, 'created', { title: f.title, priority: byManager ? (exp.priority ?? null) : null, fromRequest: internal.sourceRequestId ?? null })
    if (assigneeId) recordEvent(db, t, ctx.user.id, 'assigned', { to: assigneeId, toName: userName(db, assigneeId) })
    return getTaskRow(db, id)
  })
  if (!byManager) emit({ type: 'parameters.proposed', orgId: ctx.orgId, taskId: id, actorId: ctx.user.id, source: 'EMPLOYEE' })
  if (assigneeId) emit({ type: 'task.assigned', orgId: ctx.orgId, taskId: id, assigneeId, actorId: ctx.user.id })
  else emit({ type: 'task.created_unassigned', orgId: ctx.orgId, taskId: id, actorId: ctx.user.id })
  return { mode: 'direct', task: presentTask(db, ctx, task) }
}

// ---------- update ----------
export function updateTask(db, ctx, id, body) {
  const t = requireVisibleTask(db, ctx, v.id(id, 'Task', { required: true }))
  requireManageTask(db, ctx, t)
  if (['COMPLETED', 'CANCELLED'].includes(t.status)) throw conflict('Reopen or restore the task before editing it.', 'task_closed')
  const f = readTaskFields(db, ctx, body, { partial: true })
  const patch = readExpectations(db, ctx.orgId, body)
  const rest = Object.fromEntries(Object.entries(f).filter(([k]) => !['priority', 'due_at', 'expected_outcome'].includes(k)))
  if (!Object.keys(rest).length && !Object.keys(patch).length) throw invalid('Nothing to change.')
  const start = f.start_date !== undefined ? f.start_date : t.start_date
  const due = f.due_at !== undefined ? f.due_at : t.due_at
  if (start && due && due.slice(0, 10) < start) throw invalid('The due date cannot be before the start date.')
  let changed = []
  transaction(db, () => {
    if (Object.keys(rest).length) {
      const sets = Object.keys(rest).map((k) => `${k} = ?`).join(', ')
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(rest), now(), t.id)
      const other = Object.keys(rest).filter((k) => rest[k] !== t[k])
      if (other.length) recordEvent(db, t, ctx.user.id, 'edited', { fields: other })
    }
    // Priority, deadline and the other expectations: old values stay in the history, with who changed them and why.
    changed = applyConfirmed(db, t, patch, { actorId: ctx.user.id, reason: v.text(body?.reason, 'Reason', { max: 500 }) })
  })
  // The old deadline's alerts are closed; the new deadline is scanned afresh (alert keys carry the deadline).
  announceChange(t, ctx.user.id, changed)
  return presentTask(db, ctx, getTaskRow(db, t.id))
}

export function assignTask(db, ctx, id, body) {
  const t = requireVisibleTask(db, ctx, v.id(id, 'Task', { required: true }))
  const assigneeId = body?.assigneeId ? v.id(body.assigneeId, 'Assignee') : null
  const selfAssign = assigneeId === ctx.user.id && !t.assignee_id
  // Managers reassign; an employee may only take an unassigned task they can see if they may self-assign.
  if (!canManageTask(db, ctx, t) && !(selfAssign && ctx.permissions.can_self_assign)) throw forbidden('Only the task’s manager can assign or reassign it.')
  if (['COMPLETED', 'CANCELLED'].includes(t.status)) throw conflict('A completed or cancelled task cannot be reassigned.', 'task_closed')
  checkAssignee(db, ctx, assigneeId)
  if (assigneeId === t.assignee_id && t.status !== 'DECLINED') return presentTask(db, ctx, t)
  const ts = now()
  // Work that came through the acceptance workflow (pending, declined, or a Slack task being handed to someone new)
  // must be accepted by its new owner; every other task keeps the old immediate assignment.
  const needsAcceptance = Boolean(assigneeId && (['PENDING_ACCEPTANCE', 'DECLINED'].includes(t.status) || (t.slack_message_ref && ['ASSIGNED', 'IN_PROGRESS'].includes(t.status))))
  const reason = v.text(body?.reason, 'Reason', { max: 500 })
  let assignmentId = null
  transaction(db, () => {
    // A reassigned task goes back to ASSIGNED for its new owner (unless it is blocked or in review).
    const status = needsAcceptance ? 'PENDING_ACCEPTANCE' : ['IN_PROGRESS'].includes(t.status) ? 'ASSIGNED' : t.status
    const accState = needsAcceptance ? 'pending' : t.acceptance_state
    const accAt = needsAcceptance ? null : (t.accepted_at ? ts : t.accepted_at)
    db.prepare(`UPDATE tasks SET assignee_id = ?, assigned_at = ?, status = ?, status_changed_at = ?, acceptance_state = ?, accepted_at = ?, declined_reason = CASE WHEN ? THEN NULL ELSE declined_reason END, updated_at = ? WHERE id = ?`)
      .run(assigneeId, assigneeId ? ts : null, status, status !== t.status ? ts : t.status_changed_at, accState, accAt, needsAcceptance ? 1 : 0, ts, t.id)
    recordEvent(db, t, ctx.user.id, t.assignee_id ? 'reassigned' : 'assigned', { from: t.assignee_id, fromName: userName(db, t.assignee_id), to: assigneeId, toName: userName(db, assigneeId), reason })
    if (status !== t.status) recordEvent(db, t, ctx.user.id, 'status_changed', { from: t.status, to: status, reason: 'reassigned' })
    // A manager's reassignment settles any open transfer (the owner is chosen by the manager) and closes the open assignment.
    db.prepare(`UPDATE task_transfers SET status = 'CANCELLED', decided_by = ?, decided_at = ?, decision_note = 'The task was reassigned by a manager.' WHERE task_id = ? AND status = 'PENDING'`).run(ctx.user.id, ts, t.id)
    const hasHistory = db.prepare('SELECT 1 FROM task_assignments WHERE task_id = ?').get(t.id)
    if (hasHistory) db.prepare(`UPDATE task_assignments SET state = CASE WHEN state IN ('PENDING','ACCEPTED') THEN 'SUPERSEDED' ELSE state END, ended_at = ? WHERE task_id = ? AND ended_at IS NULL`).run(ts, t.id)
    if (assigneeId && (hasHistory || needsAcceptance)) {
      assignmentId = uuid()
      db.prepare(`INSERT INTO task_assignments (id, org_id, task_id, user_id, source, state, assigned_by, reason, assigned_at, responded_at) VALUES (?, ?, ?, ?, 'MANAGER', ?, ?, ?, ?, ?)`)
        .run(assignmentId, t.org_id, t.id, assigneeId, needsAcceptance ? 'PENDING' : 'ACCEPTED', ctx.user.id, reason, ts, needsAcceptance ? null : ts)
    }
  })
  if (needsAcceptance) emit({ type: 'assignment.created', orgId: ctx.orgId, taskId: t.id, assigneeId, assignmentId, actorId: ctx.user.id, via: 'manager' })
  else if (assigneeId) emit({ type: 'task.assigned', orgId: ctx.orgId, taskId: t.id, assigneeId, actorId: ctx.user.id })
  return presentTask(db, ctx, getTaskRow(db, t.id))
}

// ---------- status ----------
/** Allowed transitions and who may make them: 'assignee', 'manager' or both. */
const TRANSITIONS = {
  'ASSIGNED>IN_PROGRESS': ['assignee'],
  'IN_PROGRESS>ASSIGNED': ['assignee', 'manager'],
  'BLOCKED>IN_PROGRESS': ['assignee', 'manager'],
  'ASSIGNED>CANCELLED': ['manager'],
  'IN_PROGRESS>CANCELLED': ['manager'],
  'BLOCKED>CANCELLED': ['manager'],
  'SUBMITTED_FOR_REVIEW>CANCELLED': ['manager'],
  'COMPLETED>IN_PROGRESS': ['manager'], // reopen, recorded as an event
  'CANCELLED>ASSIGNED': ['manager'], // restore
  // Accepting and declining go through /accept and /decline; a manager may cancel work that was never accepted.
  'PENDING_ACCEPTANCE>CANCELLED': ['manager'],
  'DECLINED>CANCELLED': ['manager']
}

export function changeStatus(db, ctx, id, body) {
  const t = requireVisibleTask(db, ctx, v.id(id, 'Task', { required: true }))
  const to = v.oneOf(body?.status, 'Status', v.TASK_STATUSES, { required: true })
  if (to === 'BLOCKED') throw invalid('Report a blocker to mark a task blocked.')
  if (to === 'SUBMITTED_FOR_REVIEW') throw invalid('Submit the work for review to send it for review.')
  if (to === 'COMPLETED') throw invalid('A task is completed only when a manager approves its review submission.')
  const key = `${t.status}>${to}`
  const who = TRANSITIONS[key]
  if (!who) throw conflict(`A task cannot move from ${t.status} to ${to}.`, 'invalid_transition')
  const isAssignee = t.assignee_id === ctx.user.id
  const manage = canManageTask(db, ctx, t)
  if (!((who.includes('assignee') && isAssignee) || (who.includes('manager') && manage))) throw forbidden('You cannot make that status change.')
  if (key === 'BLOCKED>IN_PROGRESS') {
    const open = db.prepare(`SELECT COUNT(*) AS n FROM blockers WHERE task_id = ? AND status = 'OPEN'`).get(t.id).n
    if (open) throw conflict('Resolve the open blockers first.', 'blockers_open')
  }
  const reason = v.text(body?.reason, 'Reason', { max: 1000 })
  if ((to === 'CANCELLED' || key === 'COMPLETED>IN_PROGRESS') && !reason) throw invalid('Give a reason: it is kept in the task history.')
  const ts = now()
  transaction(db, () => {
    db.prepare(`UPDATE tasks SET status = ?, status_changed_at = ?, updated_at = ?, started_at = COALESCE(started_at, ?), completed_at = CASE WHEN ? = 'IN_PROGRESS' AND status = 'COMPLETED' THEN NULL ELSE completed_at END,
                last_progress_at = CASE WHEN ? = 'IN_PROGRESS' THEN ? ELSE last_progress_at END WHERE id = ?`)
      .run(to, ts, ts, to === 'IN_PROGRESS' ? ts : null, to, to, ts, t.id)
    const type = key === 'COMPLETED>IN_PROGRESS' ? 'reopened' : key === 'CANCELLED>ASSIGNED' ? 'restored' : 'status_changed'
    recordEvent(db, t, ctx.user.id, type, { from: t.status, to, reason })
    if (to === 'IN_PROGRESS') touchMeaningful(db, t.id, ts)
    // Closing a task settles an open transfer: nobody can accept ownership of finished work.
    if (to === 'CANCELLED') db.prepare(`UPDATE task_transfers SET status = 'CANCELLED', decided_by = ?, decided_at = ?, decision_note = 'The task was cancelled.' WHERE task_id = ? AND status = 'PENDING'`).run(ctx.user.id, ts, t.id)
  })
  emit({ type: 'task.status_changed', orgId: ctx.orgId, taskId: t.id, from: t.status, to, actorId: ctx.user.id })
  if (to === 'IN_PROGRESS') emit({ type: 'task.meaningful_activity', orgId: ctx.orgId, taskId: t.id, actorId: ctx.user.id })
  return presentTask(db, ctx, getTaskRow(db, t.id))
}

export function updateProgress(db, ctx, id, body) {
  const t = requireVisibleTask(db, ctx, v.id(id, 'Task', { required: true }))
  if (t.assignee_id !== ctx.user.id) throw forbidden('Only the person assigned to this task can update its progress.')
  if (!['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(t.status)) throw conflict('Progress can be updated only on active tasks.', 'task_not_active')
  const progress = v.int(body?.progress, 'Progress', { min: 0, max: 100, required: true })
  const note = v.text(body?.note, 'Note', { max: 2000 })
  const ts = now()
  // Re-saving the same percentage with no real note is not movement.
  const substantive = t.status === 'ASSIGNED' || progress !== t.progress || (note || '').length >= 15
  transaction(db, () => {
    // Updating progress on an ASSIGNED task starts it.
    const status = t.status === 'ASSIGNED' ? 'IN_PROGRESS' : t.status
    db.prepare(`UPDATE tasks SET progress = ?, status = ?, status_changed_at = ?, started_at = COALESCE(started_at, ?), last_progress_at = ?, updated_at = ? WHERE id = ?`)
      .run(progress, status, status !== t.status ? ts : t.status_changed_at, ts, ts, ts, t.id)
    if (status !== t.status) recordEvent(db, t, ctx.user.id, 'status_changed', { from: t.status, to: status })
    recordEvent(db, t, ctx.user.id, 'progress', { from: t.progress, to: progress, note })
    if (substantive) touchMeaningful(db, t.id, ts)
  })
  if (substantive) emit({ type: 'task.meaningful_activity', orgId: ctx.orgId, taskId: t.id, actorId: ctx.user.id })
  return presentTask(db, ctx, getTaskRow(db, t.id))
}

export function addComment(db, ctx, id, body) {
  const t = requireVisibleTask(db, ctx, v.id(id, 'Task', { required: true }))
  const text = v.text(body?.body, 'Comment', { required: true, max: 4000 })
  recordEvent(db, t, ctx.user.id, 'comment', { body: text })
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), t.id)
  emit({ type: 'task.commented', orgId: ctx.orgId, taskId: t.id, actorId: ctx.user.id })
  return { ok: true }
}

export function deleteTask(db, ctx, id) {
  const t = requireVisibleTask(db, ctx, v.id(id, 'Task', { required: true }))
  requireManageTask(db, ctx, t)
  const impact = db.prepare('SELECT COUNT(*) AS n FROM impact_records WHERE task_id = ?').get(t.id).n
  if (impact || t.status === 'COMPLETED') throw conflict('This task has completed work or impact records. Cancel it instead, so its history is kept.', 'task_has_history')
  transaction(db, () => {
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'task.deleted', entityType: 'task', entityId: t.id, before: { title: t.title, status: t.status, assignee_id: t.assignee_id } })
    db.prepare('UPDATE task_requests SET task_id = NULL WHERE task_id = ?').run(t.id)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id)
  })
  return { deleted: true }
}

// ---------- blockers ----------
function presentBlocker(b) {
  const end = b.resolved_at ? Date.parse(b.resolved_at) : Date.now()
  return {
    id: b.id, taskId: b.task_id, description: b.description, status: b.status, isExternal: Boolean(b.is_external),
    dependencyOwnerId: b.dependency_owner_id, dependencyOwnerName: b.dependency_owner_name ?? null, dependencyNote: b.dependency_note,
    reportedBy: b.reporter_name ?? null, reportedAt: b.reported_at, resolvedAt: b.resolved_at, resolvedBy: b.resolver_name ?? null,
    resolutionNote: b.resolution_note, escalatedAt: b.escalated_at, hoursOpen: Math.floor((end - Date.parse(b.reported_at)) / HOUR)
  }
}

export function reportBlocker(db, ctx, taskId, body) {
  const t = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (t.assignee_id !== ctx.user.id && !canManageTask(db, ctx, t)) throw forbidden('Only the assignee or the task’s manager can report a blocker.')
  if (!['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(t.status)) throw conflict('Blockers can be reported only on active tasks.', 'task_not_active')
  const description = v.text(body?.description, 'Description', { required: true, max: 2000 })
  const ownerId = v.id(body?.dependencyOwnerId, 'Dependency owner')
  if (ownerId && !isActiveMember(db, ctx.orgId, ownerId)) throw invalid('The dependency owner must be a member of your organization.')
  const note = v.text(body?.dependencyNote, 'Dependency', { max: 500 })
  const isExternal = body?.isExternal === true
  const id = uuid()
  const ts = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO blockers (id, org_id, task_id, reported_by, description, dependency_owner_id, dependency_note, is_external, status, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`)
      .run(id, ctx.orgId, t.id, ctx.user.id, description, ownerId, note, isExternal ? 1 : 0, ts)
    if (t.status !== 'BLOCKED') {
      db.prepare(`UPDATE tasks SET status = 'BLOCKED', status_changed_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, t.id)
      recordEvent(db, t, ctx.user.id, 'status_changed', { from: t.status, to: 'BLOCKED' })
    }
    recordEvent(db, t, ctx.user.id, 'blocker_reported', { blockerId: id, description, dependencyOwner: userName(db, ownerId), dependency: note, external: isExternal })
    if (t.assignee_id === ctx.user.id) touchMeaningful(db, t.id, ts)
  })
  emit({ type: 'blocker.reported', orgId: ctx.orgId, taskId: t.id, blockerId: id, actorId: ctx.user.id, priority: t.priority })
  if (t.assignee_id === ctx.user.id) emit({ type: 'task.meaningful_activity', orgId: ctx.orgId, taskId: t.id, actorId: ctx.user.id })
  return { id }
}

function requireBlocker(db, ctx, blockerId) {
  const b = db.prepare('SELECT * FROM blockers WHERE id = ? AND org_id = ?').get(v.id(blockerId, 'Blocker', { required: true }), ctx.orgId)
  if (!b) throw notFound('Blocker')
  // The dependency owner may act on the blocker that names them, even without access to the rest of the task.
  const t = b.dependency_owner_id === ctx.user.id ? db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(b.task_id, ctx.orgId) : requireVisibleTask(db, ctx, b.task_id)
  return { b, t }
}

export function resolveBlocker(db, ctx, blockerId, body) {
  const { b, t } = requireBlocker(db, ctx, blockerId)
  if (b.status === 'RESOLVED') throw conflict('This blocker is already resolved.')
  if (t.assignee_id !== ctx.user.id && !canManageTask(db, ctx, t) && b.dependency_owner_id !== ctx.user.id) throw forbidden('Only the assignee, the dependency owner or the task’s manager can resolve this blocker.')
  const note = v.text(body?.resolutionNote, 'Resolution note', { required: true, max: 2000 })
  const ts = now()
  let resumed = false
  transaction(db, () => {
    db.prepare(`UPDATE blockers SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ?`).run(ts, ctx.user.id, note, b.id)
    recordEvent(db, t, ctx.user.id, 'blocker_resolved', { blockerId: b.id, note })
    const open = db.prepare(`SELECT COUNT(*) AS n FROM blockers WHERE task_id = ? AND status = 'OPEN'`).get(t.id).n
    const current = getTaskRow(db, t.id)
    if (!open && current.status === 'BLOCKED') {
      db.prepare(`UPDATE tasks SET status = 'IN_PROGRESS', status_changed_at = ?, last_progress_at = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`).run(ts, ts, ts, ts, t.id)
      recordEvent(db, t, ctx.user.id, 'status_changed', { from: 'BLOCKED', to: 'IN_PROGRESS', reason: 'all blockers resolved' })
      resumed = true
    }
  })
  if (t.assignee_id === ctx.user.id) touchMeaningful(db, t.id, ts)
  emit({ type: 'blocker.resolved', orgId: ctx.orgId, taskId: t.id, blockerId: b.id, actorId: ctx.user.id })
  if (t.assignee_id === ctx.user.id) emit({ type: 'task.meaningful_activity', orgId: ctx.orgId, taskId: t.id, actorId: ctx.user.id })
  return { resolved: true, taskResumed: resumed }
}

export function escalateBlocker(db, ctx, blockerId) {
  const { b, t } = requireBlocker(db, ctx, blockerId)
  if (b.status !== 'OPEN') throw conflict('Only open blockers can be escalated.')
  if (t.assignee_id !== ctx.user.id && !canManageTask(db, ctx, t)) throw forbidden()
  db.prepare('UPDATE blockers SET escalated_at = ? WHERE id = ?').run(now(), b.id)
  recordEvent(db, t, ctx.user.id, 'blocker_escalated', { blockerId: b.id })
  emit({ type: 'blocker.escalated', orgId: ctx.orgId, taskId: t.id, blockerId: b.id, actorId: ctx.user.id })
  return { escalated: true }
}

export function listBlockers(db, ctx, { status = 'OPEN' } = {}) {
  const scope = taskScopeSql(ctx)
  const st = v.oneOf(status, 'Status', ['OPEN', 'RESOLVED'], { fallback: 'OPEN' })
  return db.prepare(`SELECT b.*, r.name AS reporter_name, d.name AS dependency_owner_name, x.name AS resolver_name, t.title AS task_title, t.priority, a.name AS assignee_name
                     FROM blockers b JOIN tasks t ON t.id = b.task_id JOIN users r ON r.id = b.reported_by LEFT JOIN users d ON d.id = b.dependency_owner_id
                     LEFT JOIN users x ON x.id = b.resolved_by LEFT JOIN users a ON a.id = t.assignee_id
                     WHERE b.status = ? AND b.org_id = ? AND ((${scope.sql}) OR b.dependency_owner_id = ?) ORDER BY b.reported_at`).all(st, ctx.orgId, ...scope.params, ctx.user.id)
    .map((b) => ({ ...presentBlocker(b), taskTitle: b.task_title, priority: b.priority, assigneeName: b.assignee_name }))
}

// ---------- completion and review ----------
export function submitForReview(db, ctx, taskId, body) {
  const t = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (t.assignee_id !== ctx.user.id) throw forbidden('Only the person assigned to this task can submit it for review.')
  if (!['ASSIGNED', 'IN_PROGRESS'].includes(t.status)) throw conflict(t.status === 'BLOCKED' ? 'Resolve the blockers before submitting.' : `A ${t.status} task cannot be submitted.`, 'invalid_transition')
  const summary = v.text(body?.summary, 'Work summary', { required: true, max: 4000 })
  const outcome = v.text(body?.outcome, 'Outcome achieved', { required: true, max: 4000 })
  const links = v.links(body?.evidenceLinks, 'Evidence links')
  const id = uuid()
  const ts = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO completion_submissions (id, org_id, task_id, submitted_by, summary, outcome, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
      .run(id, ctx.orgId, t.id, ctx.user.id, summary, outcome, ts, ts)
    for (const l of links) {
      db.prepare(`INSERT INTO evidence (id, org_id, owner_type, owner_id, task_id, kind, url, label, created_by, created_at) VALUES (?, ?, 'submission', ?, ?, 'link', ?, ?, ?, ?)`)
        .run(uuid(), ctx.orgId, id, t.id, l.url, l.label, ctx.user.id, ts)
    }
    db.prepare(`UPDATE tasks SET status = 'SUBMITTED_FOR_REVIEW', progress = 100, submitted_at = ?, status_changed_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, ts, ts, t.id)
    recordEvent(db, t, ctx.user.id, 'submitted_for_review', { submissionId: id, summary: summary.slice(0, 200) })
    touchMeaningful(db, t.id, ts)
    // Delivered after the deadline: the miss is recorded now, so it survives completion even if no scan saw it overdue.
    if (t.due_at && Date.parse(ts) > Date.parse(t.due_at)) markDeadlineMissed(db, t, ts)
    db.prepare(`UPDATE task_transfers SET status = 'CANCELLED', decided_by = ?, decided_at = ?, decision_note = 'The work was submitted for review.' WHERE task_id = ? AND status = 'PENDING'`).run(ctx.user.id, ts, t.id)
  })
  emit({ type: 'task.submitted', orgId: ctx.orgId, taskId: t.id, submissionId: id, actorId: ctx.user.id })
  emit({ type: 'task.meaningful_activity', orgId: ctx.orgId, taskId: t.id, actorId: ctx.user.id })
  return { submissionId: id }
}

/** A manager approves (→ COMPLETED) or requests changes (→ IN_PROGRESS). Completion never verifies impact. */
export function reviewSubmission(db, ctx, taskId, body) {
  const t = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  requireManageTask(db, ctx, t)
  if (t.assignee_id === ctx.user.id) throw forbidden('You cannot review your own work. Another manager must review it.')
  if (t.status !== 'SUBMITTED_FOR_REVIEW') throw conflict('This task is not waiting for review.', 'not_in_review')
  const sub = db.prepare(`SELECT * FROM completion_submissions WHERE task_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`).get(t.id)
  if (!sub) throw conflict('No pending submission to review.', 'no_submission')
  const decision = v.oneOf(body?.decision, 'Decision', ['APPROVED', 'CHANGES_REQUESTED'], { required: true })
  const comment = v.text(body?.comment, 'Review comment', { max: 4000, required: decision === 'CHANGES_REQUESTED' })
  const ts = now()
  transaction(db, () => {
    db.prepare('UPDATE completion_submissions SET status = ?, updated_at = ? WHERE id = ?').run(decision, ts, sub.id)
    db.prepare(`INSERT INTO manager_reviews (id, org_id, subject_type, subject_id, task_id, reviewer_id, decision, comment, created_at) VALUES (?, ?, 'submission', ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), ctx.orgId, sub.id, t.id, ctx.user.id, decision, comment, ts)
    if (decision === 'APPROVED') {
      db.prepare(`UPDATE tasks SET status = 'COMPLETED', completed_at = ?, status_changed_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, ts, t.id)
    } else {
      db.prepare(`UPDATE tasks SET status = 'IN_PROGRESS', submitted_at = NULL, status_changed_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, ts, t.id)
    }
    recordEvent(db, t, ctx.user.id, 'review_decision', { decision, comment, submissionId: sub.id })
    recordEvent(db, t, ctx.user.id, 'status_changed', { from: 'SUBMITTED_FOR_REVIEW', to: decision === 'APPROVED' ? 'COMPLETED' : 'IN_PROGRESS' })
  })
  emit({ type: 'task.reviewed', orgId: ctx.orgId, taskId: t.id, decision, actorId: ctx.user.id, assigneeId: t.assignee_id })
  return presentTask(db, ctx, getTaskRow(db, t.id))
}

export function reviewQueue(db, ctx) {
  if (!isManager(ctx)) return []
  return listTasks(db, ctx, { status: 'SUBMITTED_FOR_REVIEW' }).filter((t) => t.canManage && t.assigneeId !== ctx.user.id)
}

export { managersForTask, scopeUserIds, AppError }

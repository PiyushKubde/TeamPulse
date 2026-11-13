// What a manager expects of a task, and how it changes. The single write path for priority, deadline and the other expectations:
//   tasks.priority / tasks.due_at / tasks.expected_outcome and task_expectations hold CONFIRMED values only (NULL = not confirmed);
//   every confirmation, change, suggestion, proposal and rejection is a row in task_parameter_events (actor, source, reason, time).
// Suggestions (Slack extraction, recommendations) and proposals (employee-created tasks, change requests) never reach the columns that
// overdue logic, alerts and measurement read, so an unconfirmed deadline can never be overdue. Nothing here scores anyone.
import { now, transaction, uuid, json } from '../db.js'
import { conflict, forbidden, invalid, notFound } from '../errors.js'
import { canManageTask, isManager, requireManager, requireVisibleTask, taskScopeSql } from '../access.js'
import * as v from '../validate.js'
import { orgTimezone } from '../time.js'
import { audit } from './audit.js'
import { emit } from './events.js'

const enc = (x) => (x === undefined || x === null ? null : JSON.stringify(x))
const dec = (s) => { if (s === null || s === undefined) return null; try { return JSON.parse(s) } catch { return s } }
const nameOf = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export const TEXT_FIELDS = { businessImpact: 'business_impact', dependencies: 'dependencies', successCriteria: 'success_criteria', context: 'context', workType: 'work_type' }
export const FACTOR_COLUMNS = { businessImpact: 'factor_business_impact', urgency: 'factor_urgency', dependencies: 'factor_dependencies', risk: 'factor_risk', strategic: 'factor_strategic' }
/** history field name → patch key */
const FIELD_KEY = { priority: 'priority', deadline: 'dueAt', expected_outcome: 'expectedOutcome', complexity: 'complexityExpectation', business_impact: 'businessImpact', dependencies: 'dependencies', success_criteria: 'successCriteria', context: 'context', work_type: 'workType', response_sla: 'responseSla' }
const KEY_FIELD = Object.fromEntries(Object.entries(FIELD_KEY).map(([f, k]) => [k, f]))

export function ensureExpectations(db, task) {
  db.prepare('INSERT OR IGNORE INTO task_expectations (task_id, org_id, updated_at) VALUES (?, ?, ?)').run(task.id, task.org_id, now())
}
export const getExpectations = (db, taskId) => db.prepare('SELECT * FROM task_expectations WHERE task_id = ?').get(taskId) || null

function writeEvent(db, task, { field, kind, status, oldV, newV, source, actorId, reason = null, confidence = null, evidence = null, basedOn = null, ts = now() }) {
  const id = uuid()
  db.prepare(`INSERT INTO task_parameter_events (id, org_id, task_id, field, kind, status, old_value, new_value, source, actor_id, reason, confidence, evidence, based_on, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, task.org_id, task.id, field, kind, status, enc(oldV), enc(newV), source, actorId ?? null, reason, confidence, enc(evidence), basedOn, ts)
  return id
}
const taskEvent = (db, task, actorId, type, data) => db.prepare('INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uuid(), task.org_id, task.id, actorId ?? null, type, JSON.stringify(data), now())

/** Reads and validates the expectation fields of a request body. Only keys that are present are returned. */
export function readExpectations(db, orgId, body) {
  const p = {}
  const has = (k) => body?.[k] !== undefined
  if (has('priority') && body.priority !== null && body.priority !== '') p.priority = v.oneOf(body.priority, 'Priority', v.PRIORITIES)
  if (has('dueAt')) p.dueAt = v.dateTime(body.dueAt, 'Deadline', { tz: orgTimezone(db, orgId) })
  if (has('expectedOutcome')) p.expectedOutcome = v.text(body.expectedOutcome, 'Expected outcome', { max: 2000 })
  if (has('complexityExpectation')) p.complexityExpectation = body.complexityExpectation === null || body.complexityExpectation === '' || body.complexityExpectation === 'NOT_ASSESSED' ? null : v.oneOf(body.complexityExpectation, 'Complexity expectation', ['L1', 'L2', 'L3', 'L4'])
  if (has('businessImpact')) p.businessImpact = v.text(body.businessImpact, 'Business impact', { max: 2000 })
  if (has('dependencies')) p.dependencies = v.text(body.dependencies, 'Dependencies', { max: 2000 })
  if (has('successCriteria')) p.successCriteria = v.text(body.successCriteria, 'Success criteria', { max: 3000 })
  if (has('context')) p.context = v.text(body.context, 'Supporting context', { max: 4000 })
  if (has('workType')) p.workType = v.text(body.workType, 'Work type', { max: 40 })
  if (has('responseSla')) {
    const s = body.responseSla
    if (s === null || s === '') p.responseSla = null
    else {
      const amount = Number(s?.amount)
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) throw invalid('Response target must be a positive amount.', { field: 'responseSla' })
      p.responseSla = { amount, unit: v.oneOf(s?.unit, 'Response target unit', ['WORKING_HOURS', 'WORKING_DAYS'], { required: true }).toLowerCase() }
    }
  }
  if (has('factors')) {
    if (body.factors === null || typeof body.factors !== 'object') throw invalid('Factors must be an object.', { field: 'factors' })
    p.factors = {}
    for (const k of Object.keys(FACTOR_COLUMNS)) {
      if (body.factors[k] === undefined) continue
      p.factors[k] = body.factors[k] === null || body.factors[k] === '' ? null : v.int(body.factors[k], `Factor ${k}`, { min: 1, max: 5 })
    }
  }
  if (has('verifiedIncident')) p.verifiedIncident = v.bool(body.verifiedIncident, 'Verified incident')
  return p
}

const currentValues = (task, ex) => ({
  priority: task.priority, dueAt: task.due_at, expectedOutcome: task.expected_outcome, complexityExpectation: ex?.complexity_expectation ?? null,
  businessImpact: ex?.business_impact ?? null, dependencies: ex?.dependencies ?? null, successCriteria: ex?.success_criteria ?? null, context: ex?.context ?? null, workType: ex?.work_type ?? null,
  responseSla: ex?.response_sla_amount ? { amount: ex.response_sla_amount, unit: ex.response_sla_unit } : null
})

/**
 * Confirms values (a manager's own edit, an accepted suggestion or an approved change request) and records each change.
 * Runs inside the caller's transaction. Returns the history field names that changed. Never changes anything the patch omits.
 */
export function applyConfirmed(db, task, patch, { actorId, source = 'MANAGER', reason = null, basedOn = null, confidence = null, evidence = null, quiet = false } = {}) {
  ensureExpectations(db, task)
  const ex = getExpectations(db, task.id)
  const cur = currentValues(task, ex)
  const ts = now()
  const changed = []
  const record = (field, oldV, newV) => { writeEvent(db, task, { field, kind: oldV === null || oldV === undefined ? 'CONFIRM' : 'CHANGE', status: 'CONFIRMED', oldV, newV, source, actorId, reason, confidence, evidence, basedOn, ts }); changed.push(field) }

  if (patch.priority !== undefined && patch.priority !== cur.priority) {
    if (patch.priority === null) throw invalid('A confirmed priority cannot be cleared; choose a level.', { field: 'priority' })
    db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(patch.priority, ts, task.id)
    record('priority', cur.priority, patch.priority)
    if (!quiet) taskEvent(db, task, actorId, 'priority_changed', { from: cur.priority, to: patch.priority, reason })
  }
  if (patch.dueAt !== undefined && patch.dueAt !== cur.dueAt) {
    db.prepare('UPDATE tasks SET due_at = ?, updated_at = ? WHERE id = ?').run(patch.dueAt, ts, task.id)
    record('deadline', cur.dueAt, patch.dueAt)
    if (!quiet) taskEvent(db, task, actorId, 'deadline_changed', { from: cur.dueAt, to: patch.dueAt, reason })
  }
  if (patch.expectedOutcome !== undefined && patch.expectedOutcome !== cur.expectedOutcome) {
    db.prepare('UPDATE tasks SET expected_outcome = ?, updated_at = ? WHERE id = ?').run(patch.expectedOutcome, ts, task.id)
    record('expected_outcome', cur.expectedOutcome, patch.expectedOutcome)
  }
  const set = (col, val) => db.prepare(`UPDATE task_expectations SET ${col} = ?, updated_by = ?, updated_at = ? WHERE task_id = ?`).run(val, actorId ?? null, ts, task.id)
  if (patch.complexityExpectation !== undefined && patch.complexityExpectation !== cur.complexityExpectation) { set('complexity_expectation', patch.complexityExpectation); record('complexity', cur.complexityExpectation, patch.complexityExpectation) }
  for (const [key, col] of Object.entries(TEXT_FIELDS)) {
    if (patch[key] !== undefined && patch[key] !== cur[key]) { set(col, patch[key]); record(KEY_FIELD[key], cur[key], patch[key]) }
  }
  if (patch.responseSla !== undefined && !same(patch.responseSla, cur.responseSla)) {
    db.prepare('UPDATE task_expectations SET response_sla_amount = ?, response_sla_unit = ?, updated_by = ?, updated_at = ? WHERE task_id = ?').run(patch.responseSla?.amount ?? null, patch.responseSla?.unit ?? null, actorId ?? null, ts, task.id)
    record('response_sla', cur.responseSla, patch.responseSla)
  }
  if (patch.factors) {
    const before = Object.fromEntries(Object.keys(FACTOR_COLUMNS).map((k) => [k, ex?.[FACTOR_COLUMNS[k]] ?? null]))
    const after = { ...before, ...patch.factors }
    if (!same(before, after)) {
      for (const k of Object.keys(patch.factors)) set(FACTOR_COLUMNS[k], after[k])
      record('factors', before, after)
    }
  }
  if (patch.verifiedIncident !== undefined && Boolean(patch.verifiedIncident) !== Boolean(ex?.verified_incident)) {
    set('verified_incident', patch.verifiedIncident ? 1 : 0)
    record('verified_incident', Boolean(ex?.verified_incident), Boolean(patch.verifiedIncident))
  }
  const expectationFields = changed.filter((f) => !['priority', 'deadline'].includes(f))
  if (expectationFields.length && !quiet) taskEvent(db, task, actorId, 'expectations_changed', { fields: expectationFields, reason })
  return changed
}

/** Emits what other parts of the app react to; call after the transaction that applied the change has committed. */
export function announceChange(task, actorId, changed) {
  if (!changed.length) return
  if (changed.includes('deadline')) emit({ type: 'task.deadline_changed', orgId: task.org_id, taskId: task.id, actorId })
  emit({ type: 'parameters.changed', orgId: task.org_id, taskId: task.id, actorId, fields: changed })
}

/** Records values nobody has confirmed yet: SUGGESTED (Slack extraction, a recommendation) or PROPOSED (an employee's own creation). */
export function suggestValues(db, task, patch, { source, actorId = null, confidence = null, evidence = null, reason = null }) {
  const status = source === 'EMPLOYEE' || source === 'CHANGE_REQUEST' ? 'PROPOSED' : 'SUGGESTED'
  const open = new Map(openSuggestions(db, task.id).map((s) => [s.field, s]))
  const ts = now()
  let n = 0
  for (const [key, value] of Object.entries(patch)) {
    const field = KEY_FIELD[key]
    if (!field || value === undefined || value === null || value === '') continue
    if (open.has(field) && same(open.get(field).value, value)) continue
    writeEvent(db, task, { field, kind: status === 'PROPOSED' ? 'PROPOSE' : 'SUGGEST', status, oldV: null, newV: value, source, actorId, reason, confidence, evidence, ts })
    n++
  }
  return n
}

const presentEvent = (db, r) => ({
  id: r.id, field: r.field, kind: r.kind, status: r.status, oldValue: dec(r.old_value), value: dec(r.new_value), source: r.source, actorId: r.actor_id, actorName: nameOf(db, r.actor_id),
  reason: r.reason, confidence: r.confidence, evidence: dec(r.evidence), basedOn: r.based_on, createdAt: r.created_at
})

/** The newest event of each field, when that event is an unconfirmed suggestion or proposal. */
export function openSuggestions(db, taskId) {
  const latest = new Map()
  for (const r of db.prepare('SELECT * FROM task_parameter_events WHERE task_id = ? ORDER BY created_at, rowid').all(taskId)) latest.set(r.field, r)
  return [...latest.values()].filter((r) => r.status === 'SUGGESTED' || r.status === 'PROPOSED').map((r) => presentEvent(db, r))
}

export function acceptSuggestion(db, ctx, taskId, field, body) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (!canManageTask(db, ctx, task)) throw forbidden('Only the task’s manager can confirm a suggestion.')
  const s = openSuggestions(db, task.id).find((x) => x.field === field)
  if (!s) throw notFound('Suggestion')
  const key = FIELD_KEY[field]
  const patch = readExpectations(db, ctx.orgId, { [key]: body?.value !== undefined ? body.value : s.value })
  if (patch[key] === undefined) throw invalid('Choose a value to confirm.')
  const reason = v.text(body?.reason, 'Reason', { max: 1000 })
  let changed = []
  transaction(db, () => {
    changed = applyConfirmed(db, task, patch, { actorId: ctx.user.id, source: 'MANAGER', reason: reason || `Confirmed from a suggestion (${s.source.toLowerCase().replace('_', ' ')}).`, basedOn: s.id, confidence: s.confidence, evidence: { suggestion: s.value, suggestedBy: s.source, edited: body?.value !== undefined && !same(body.value, s.value) } })
    if (!changed.includes(field)) writeEvent(db, task, { field, kind: 'CONFIRM', status: 'CONFIRMED', oldV: null, newV: patch[key], source: 'MANAGER', actorId: ctx.user.id, reason, basedOn: s.id })
  })
  announceChange(task, ctx.user.id, changed)
  return { confirmed: field }
}

export function rejectSuggestion(db, ctx, taskId, field, body) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (!canManageTask(db, ctx, task)) throw forbidden('Only the task’s manager can reject a suggestion.')
  const s = openSuggestions(db, task.id).find((x) => x.field === field)
  if (!s) throw notFound('Suggestion')
  const reason = v.text(body?.reason, 'Reason', { max: 1000 })
  writeEvent(db, task, { field, kind: 'REJECT', status: 'REJECTED', oldV: s.value, newV: null, source: 'MANAGER', actorId: ctx.user.id, reason, basedOn: s.id })
  return { rejected: field }
}

// ---------- the task page ----------
function fieldView(db, field, value, events, suggestionByField) {
  const confirmed = [...events].reverse().find((e) => e.field === field && e.status === 'CONFIRMED')
  const suggestion = suggestionByField.get(field) || null
  const state = value !== null && value !== undefined ? 'CONFIRMED' : suggestion ? suggestion.status : 'UNRESOLVED'
  return { value: value ?? null, state, source: value !== null && value !== undefined ? (confirmed?.source ?? null) : null, confirmedBy: confirmed ? { id: confirmed.actor_id, name: nameOf(db, confirmed.actor_id) } : null, confirmedAt: confirmed?.created_at ?? null, suggestion }
}

/** Everything about a task's expectations: confirmed values with their source, open suggestions, the baseline, the history. */
export function parametersView(db, ctx, taskId, { recommendations = null, targets = null } = {}) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  const manage = canManageTask(db, ctx, task)
  const ex = getExpectations(db, task.id)
  const events = db.prepare('SELECT * FROM task_parameter_events WHERE task_id = ? ORDER BY created_at, rowid').all(task.id)
  const suggestions = openSuggestions(db, task.id)
  const byField = new Map(suggestions.map((s) => [s.field, s]))
  const cur = currentValues(task, ex)
  const baseline = {}
  for (const e of events) if (e.status === 'CONFIRMED' && !baseline[e.field]) baseline[e.field] = { value: dec(e.new_value), at: e.created_at, source: e.source, actorName: nameOf(db, e.actor_id) }
  const view = {
    taskId: task.id, canManage: manage, origin: task.origin,
    priority: fieldView(db, 'priority', cur.priority, events, byField),
    deadline: fieldView(db, 'deadline', cur.dueAt, events, byField),
    expectedOutcome: fieldView(db, 'expected_outcome', cur.expectedOutcome, events, byField),
    complexityExpectation: fieldView(db, 'complexity', cur.complexityExpectation, events, byField),
    businessImpact: fieldView(db, 'business_impact', cur.businessImpact, events, byField),
    dependencies: fieldView(db, 'dependencies', cur.dependencies, events, byField),
    successCriteria: fieldView(db, 'success_criteria', cur.successCriteria, events, byField),
    context: fieldView(db, 'context', cur.context, events, byField),
    workType: fieldView(db, 'work_type', cur.workType, events, byField),
    responseSla: fieldView(db, 'response_sla', cur.responseSla, events, byField),
    baseline, suggestions,
    history: events.slice().reverse().slice(0, 200).map((e) => presentEvent(db, e)),
    changeRequests: listChangeRequests(db, ctx, { taskId: task.id })
  }
  if (manage) {
    view.factors = Object.fromEntries(Object.entries(FACTOR_COLUMNS).map(([k, c]) => [k, ex?.[c] ?? null]))
    view.verifiedIncident = Boolean(ex?.verified_incident)
    view.recommendations = recommendations
    view.targets = targets
  }
  return view
}

// ---------- the manager's review queue ----------
/** Open tasks in the manager's scope whose priority or deadline is unresolved, suggested or proposed, or that have requests waiting. */
export function reviewQueue(db, ctx) {
  requireManager(ctx)
  const scope = taskScopeSql(ctx)
  const rows = db.prepare(`SELECT t.* FROM tasks t WHERE ${scope.sql} AND t.status NOT IN ('COMPLETED','CANCELLED','DECLINED') ORDER BY t.created_at DESC LIMIT 400`).all(...scope.params)
  const out = []
  for (const t of rows) {
    const suggestions = openSuggestions(db, t.id)
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM task_change_requests WHERE task_id = ? AND status = 'PENDING'`).get(t.id).n
    const unresolvedPriority = t.priority === null
    if (!unresolvedPriority && !suggestions.length && !pending) continue
    out.push({
      taskId: t.id, title: t.title, status: t.status, origin: t.origin, assigneeId: t.assignee_id, assigneeName: nameOf(db, t.assignee_id), createdAt: t.created_at,
      priority: t.priority, dueAt: t.due_at, priorityState: t.priority !== null ? 'CONFIRMED' : (suggestions.find((s) => s.field === 'priority')?.status || 'UNRESOLVED'),
      deadlineState: t.due_at ? 'CONFIRMED' : (suggestions.find((s) => s.field === 'deadline')?.status || 'UNRESOLVED'),
      suggestions, pendingChangeRequests: pending
    })
  }
  out.sort((a, b) => (b.suggestions.length + b.pendingChangeRequests) - (a.suggestions.length + a.pendingChangeRequests))
  return out
}

// ---------- change requests ----------
const CR_SCOPE_KEYS = ['expectedOutcome', 'successCriteria', 'dependencies', 'context', 'businessImpact', 'complexityExpectation', 'workType']
const presentRequest = (db, r) => ({
  id: r.id, taskId: r.task_id, taskTitle: db.prepare('SELECT title FROM tasks WHERE id = ?').get(r.task_id)?.title ?? null, kind: r.kind, proposed: json(r.proposed, {}), reason: r.reason, status: r.status,
  requestedBy: r.requested_by, requestedByName: nameOf(db, r.requested_by), decidedBy: r.decided_by, decidedByName: nameOf(db, r.decided_by), decisionNote: r.decision_note, decidedAt: r.decided_at, createdAt: r.created_at
})

export function listChangeRequests(db, ctx, { status, taskId } = {}) {
  const where = ['c.org_id = ?']
  const params = [ctx.orgId]
  if (taskId) { where.push('c.task_id = ?'); params.push(taskId) }
  if (status) { where.push('c.status = ?'); params.push(v.oneOf(status, 'Status', ['PENDING', 'APPROVED', 'REJECTED', 'ANSWERED', 'WITHDRAWN'])) }
  let rows
  if (isManager(ctx)) {
    const scope = taskScopeSql(ctx)
    rows = db.prepare(`SELECT c.* FROM task_change_requests c JOIN tasks t ON t.id = c.task_id WHERE ${where.join(' AND ')} AND (${scope.sql}) ORDER BY c.created_at DESC LIMIT 200`).all(...params, ...scope.params)
  } else {
    rows = db.prepare(`SELECT c.* FROM task_change_requests c WHERE ${where.join(' AND ')} AND c.requested_by = ? ORDER BY c.created_at DESC LIMIT 200`).all(...params, ctx.user.id)
  }
  return rows.map((r) => presentRequest(db, r))
}

/** The task's owner asks for a different deadline or priority, a scope change, or clarification. The manager decides. */
export function createChangeRequest(db, ctx, taskId, body) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (task.assignee_id !== ctx.user.id) throw forbidden('Only the person the task is assigned to can ask for a change. Managers edit the task directly.')
  if (['COMPLETED', 'CANCELLED', 'DECLINED'].includes(task.status)) throw conflict('This task is closed.', 'task_closed')
  const kind = v.oneOf(body?.kind, 'Kind', ['DEADLINE', 'PRIORITY', 'SCOPE', 'CLARIFICATION'], { required: true })
  const reason = v.text(body?.reason, kind === 'CLARIFICATION' ? 'Question' : 'Reason', { required: true, min: 3, max: 2000 })
  let proposed = {}
  if (kind === 'DEADLINE') {
    const dueAt = v.dateTime(body?.proposed?.dueAt, 'Proposed deadline', { required: true, tz: orgTimezone(db, ctx.orgId) })
    proposed = { dueAt }
  } else if (kind === 'PRIORITY') proposed = { priority: v.oneOf(body?.proposed?.priority, 'Proposed priority', v.PRIORITIES, { required: true }) }
  else if (kind === 'SCOPE') {
    const p = readExpectations(db, ctx.orgId, body?.proposed || {})
    proposed = Object.fromEntries(Object.entries(p).filter(([k]) => CR_SCOPE_KEYS.includes(k)))
    if (!Object.keys(proposed).length) throw invalid('Say what should change: the expected outcome, success criteria, dependencies, context, impact, complexity or work type.')
  }
  if (kind !== 'CLARIFICATION' && db.prepare(`SELECT 1 FROM task_change_requests WHERE task_id = ? AND kind = ? AND status = 'PENDING'`).get(task.id, kind)) throw conflict('There is already a pending request of this kind for the task.', 'request_pending')
  const id = uuid()
  db.prepare(`INSERT INTO task_change_requests (id, org_id, task_id, requested_by, kind, proposed, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`).run(id, ctx.orgId, task.id, ctx.user.id, kind, JSON.stringify(proposed), reason, now())
  db.prepare('INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uuid(), ctx.orgId, task.id, ctx.user.id, 'change_requested', JSON.stringify({ requestId: id, kind, reason }), now())
  emit({ type: 'change_request.created', orgId: ctx.orgId, taskId: task.id, requestId: id, kind, actorId: ctx.user.id })
  return presentRequest(db, db.prepare('SELECT * FROM task_change_requests WHERE id = ?').get(id))
}

export function withdrawChangeRequest(db, ctx, id) {
  const r = db.prepare('SELECT * FROM task_change_requests WHERE id = ? AND org_id = ?').get(v.id(id, 'Request', { required: true }), ctx.orgId)
  if (!r || r.requested_by !== ctx.user.id) throw notFound('Request')
  if (r.status !== 'PENDING') throw conflict('That request was already settled.', 'request_settled')
  db.prepare(`UPDATE task_change_requests SET status = 'WITHDRAWN', decided_at = ? WHERE id = ?`).run(now(), r.id)
  return { status: 'WITHDRAWN' }
}

/** APPROVE applies the change through the same path as a manager's edit (previous values stay in the history); REJECT and ANSWER only record the reply. */
export function decideChangeRequest(db, ctx, id, body) {
  const r = db.prepare('SELECT * FROM task_change_requests WHERE id = ? AND org_id = ?').get(v.id(id, 'Request', { required: true }), ctx.orgId)
  if (!r) throw notFound('Request')
  const task = requireVisibleTask(db, ctx, r.task_id)
  if (!canManageTask(db, ctx, task)) throw forbidden('Only the task’s manager can decide on a change request.')
  if (r.status !== 'PENDING') throw conflict('That request was already settled.', 'request_settled')
  const allowed = r.kind === 'CLARIFICATION' ? ['ANSWER'] : ['APPROVE', 'REJECT']
  const decision = v.oneOf(body?.decision, 'Decision', allowed, { required: true })
  const note = v.text(body?.note, decision === 'REJECT' ? 'Reason' : 'Note', { required: decision !== 'APPROVE', min: decision === 'APPROVE' ? 0 : 3, max: 2000 })
  const ts = now()
  let changed = []
  transaction(db, () => {
    if (decision === 'APPROVE') {
      const proposed = json(r.proposed, {})
      const edited = body?.value !== undefined ? readExpectations(db, ctx.orgId, r.kind === 'DEADLINE' ? { dueAt: body.value } : r.kind === 'PRIORITY' ? { priority: body.value } : body.value) : null
      const patch = edited && Object.keys(edited).length ? edited : readExpectations(db, ctx.orgId, proposed)
      changed = applyConfirmed(db, task, patch, { actorId: ctx.user.id, source: 'CHANGE_REQUEST', reason: note || r.reason, basedOn: r.id, evidence: { requestedBy: r.requested_by, requestId: r.id, kind: r.kind, approvedAsRequested: !edited } })
    }
    const status = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'ANSWERED'
    db.prepare('UPDATE task_change_requests SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?').run(status, ctx.user.id, note, ts, r.id)
    db.prepare('INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uuid(), ctx.orgId, task.id, ctx.user.id, 'change_decided', JSON.stringify({ requestId: r.id, kind: r.kind, decision: status, note }), ts)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `change_request.${status.toLowerCase()}`, entityType: 'task', entityId: task.id, before: { kind: r.kind, proposed: json(r.proposed, {}) }, after: { decision: status, note } })
  })
  announceChange(task, ctx.user.id, changed)
  emit({ type: 'change_request.decided', orgId: ctx.orgId, taskId: task.id, requestId: r.id, kind: r.kind, decision, requesterId: r.requested_by, actorId: ctx.user.id })
  return presentRequest(db, db.prepare('SELECT * FROM task_change_requests WHERE id = ?').get(r.id))
}

// Manager analytics over work expectations: individual, team and task/project views with filters.
// A composition layer, not a second system: tasks come from the same scoped query as the task list (taskScopeSql), overdue/at-risk from
// deriveConditions, complexity from the measurement module's effective assessments, verified outcomes from impact records (shared outcomes
// counted once), and the person / team figures from personProfile / teamOverview. Everything is computed from stored records the caller is
// authorised to see. There is no score and no ranking: priority and deadlines are the manager's expectations, never a performance measure,
// a missed deadline is shown with its context (approved changes, blockers) and not as a penalty, and task counts are never "productivity".
import { json } from '../db.js'
import { forbidden, invalid, notFound } from '../errors.js'
import { canManageTask, isAdmin, requireManager, requireVisibleTask, scopeUserIds, taskScopeSql } from '../access.js'
import * as v from '../validate.js'
import { deriveConditions } from './tasks.js'
import { openSuggestions } from './task-parameters.js'
import { observedComplexityByTask, personProfile, teamOverview } from '../measurement/assessments.js'
import { taskJourney } from '../intelligence/journeys.js'
import { CATEGORY_LABELS } from './impact.js'

const WEEK = 7 * 86400000
const CHUNK = 400
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const STATUSES = ['SUGGESTED', 'PENDING_ACCEPTANCE', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED', 'DECLINED']
const CLOSED = ['COMPLETED', 'CANCELLED', 'DECLINED']
const NOTES = [
  'Priority and deadlines are what managers expected. They are context for the work, never a performance score.',
  'A missed deadline is shown with its context (approved changes, blockers); it is not counted against anyone.',
  'Numbers of tasks are not a measure of contribution. Shared outcomes are counted once.'
]
const nameOf = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)
const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out }
const inRows = (db, sql, ids, ...extra) => chunks(ids).flatMap((c) => db.prepare(sql.replace('(?)', `(${c.map(() => '?').join(',')})`)).all(...c, ...extra))

/** Validates and normalises the filters of every analytics view. */
export function readFilters(db, ctx, q = {}) {
  const to = v.dateTime(q.to, 'To') || new Date().toISOString()
  const from = v.dateTime(q.from, 'From') || new Date(Date.parse(to) - 90 * 86400000).toISOString()
  if (from > to) throw invalid('The start of the date range is after its end.', { field: 'from' })
  const f = { from, to }
  if (q.userId) f.userId = v.id(q.userId, 'Employee')
  if (q.teamId) f.teamId = v.id(q.teamId, 'Team')
  if (q.priority) f.priority = v.oneOf(q.priority, 'Priority', [...PRIORITIES, 'UNRESOLVED'])
  if (q.complexity) f.complexity = v.oneOf(q.complexity, 'Complexity expectation', ['L1', 'L2', 'L3', 'L4', 'NOT_ASSESSED'])
  if (q.observedComplexity) f.observedComplexity = v.oneOf(q.observedComplexity, 'Observed complexity', ['L1', 'L2', 'L3', 'L4', 'NOT_ASSESSED'])
  if (q.status) f.status = v.oneOf(q.status, 'Status', STATUSES)
  if (q.deadline) f.deadline = v.oneOf(q.deadline, 'Deadline', ['CONFIRMED', 'NOT_CONFIRMED', 'OVERDUE', 'MISSED', 'MET'])
  if (q.outcome) f.outcome = v.oneOf(q.outcome, 'Outcome', ['VERIFIED', 'CLAIMED', 'NONE'])
  if (q.workType) f.workType = v.text(q.workType, 'Work type', { max: 40 })
  return f
}

/** The tasks in the caller's authorised scope that match the filters, with everything the views need, as plain rows. */
function collect(db, ctx, f, { subjectIds = null } = {}) {
  const scope = taskScopeSql(ctx)
  const where = [scope.sql, 'COALESCE(t.completed_at, t.updated_at) >= ?', 't.created_at <= ?']
  const params = [...scope.params, f.from, f.to]
  if (subjectIds) { where.push(`t.assignee_id IN (${subjectIds.map(() => '?').join(',') || 'NULL'})`); params.push(...subjectIds) }
  if (f.userId) { where.push('t.assignee_id = ?'); params.push(f.userId) }
  if (f.teamId) { where.push('t.team_id = ?'); params.push(f.teamId) }
  if (f.priority === 'UNRESOLVED') where.push('t.priority IS NULL')
  else if (f.priority) { where.push('t.priority = ?'); params.push(f.priority) }
  if (f.status) { where.push('t.status = ?'); params.push(f.status) }
  const tasks = db.prepare(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 1000`).all(...params)
  const ids = tasks.map((t) => t.id)
  const expectations = new Map(inRows(db, 'SELECT * FROM task_expectations WHERE task_id IN (?)', ids).map((r) => [r.task_id, r]))
  const observed = observedComplexityByTask(db, ctx.orgId, ids)
  const history = new Map()
  for (const e of inRows(db, `SELECT task_id, field, kind, status, source, new_value, created_at FROM task_parameter_events WHERE task_id IN (?) ORDER BY created_at, rowid`, ids)) {
    if (!history.has(e.task_id)) history.set(e.task_id, [])
    history.get(e.task_id).push(e)
  }
  const requests = new Map()
  for (const r of inRows(db, 'SELECT task_id, kind, status FROM task_change_requests WHERE task_id IN (?)', ids)) {
    if (!requests.has(r.task_id)) requests.set(r.task_id, [])
    requests.get(r.task_id).push(r)
  }
  const impact = new Map()
  for (const r of inRows(db, `SELECT task_id, id, title, category, user_id, verification_status, shared_outcome_key FROM impact_records WHERE task_id IN (?)`, ids)) {
    if (!impact.has(r.task_id)) impact.set(r.task_id, [])
    impact.get(r.task_id).push(r)
  }
  const blockers = new Map()
  for (const b of inRows(db, 'SELECT task_id, status FROM blockers WHERE task_id IN (?)', ids)) {
    if (!blockers.has(b.task_id)) blockers.set(b.task_id, { total: 0, open: 0 })
    const x = blockers.get(b.task_id); x.total++; if (b.status === 'OPEN') x.open++
  }
  const rows = []
  for (const t of tasks) {
    const ex = expectations.get(t.id) || null
    const c = deriveConditions(t)
    const h = history.get(t.id) || []
    const confirmed = (field) => h.filter((e) => e.field === field && e.status === 'CONFIRMED')
    const first = (field) => { const e = confirmed(field)[0]; return e ? json(e.new_value, null) : null }
    const changes = (field) => Math.max(0, confirmed(field).length - 1)
    const outcomes = impact.get(t.id) || []
    const verified = outcomes.filter((o) => o.verification_status === 'VERIFIED')
    const claimed = outcomes.filter((o) => o.verification_status === 'PENDING')
    const outcome = verified.length ? 'VERIFIED' : claimed.length ? 'CLAIMED' : 'NONE'
    // Task health, from the same definitions as the rest of the app (deriveConditions, status BLOCKED, the confirmed deadline). One bucket per open task,
    // in this order: overdue, blocked, at risk, no confirmed deadline (so it cannot be judged against one), on track. Closed tasks have none.
    const health = CLOSED.includes(t.status) ? null : c.overdue ? 'OVERDUE' : t.status === 'BLOCKED' ? 'BLOCKED' : c.atRisk ? 'AT_RISK' : !t.due_at ? 'UNCONFIRMED_DEADLINE' : 'ON_TRACK'
    const outcomeItems = outcomes.filter((o) => o.verification_status !== 'REJECTED').map((o) => ({ id: o.id, key: o.shared_outcome_key ? `shared:${o.shared_outcome_key}` : `impact:${o.id}`, title: o.title, category: CATEGORY_LABELS[o.category] || o.category, state: o.verification_status === 'VERIFIED' ? 'VERIFIED' : 'CLAIMED', shared: Boolean(o.shared_outcome_key), userId: o.user_id }))
    const doneAt = t.completed_at || null
    const missed = Boolean(t.due_at && doneAt && Date.parse(doneAt) > Date.parse(t.due_at))
    const met = Boolean(t.due_at && doneAt && !missed)
    const row = {
      id: t.id, title: t.title, status: t.status, teamId: t.team_id, assigneeId: t.assignee_id, assigneeName: nameOf(db, t.assignee_id), origin: t.origin,
      createdAt: t.created_at, completedAt: doneAt,
      priority: t.priority, priorityState: t.priority ? 'CONFIRMED' : (openSuggestions(db, t.id).find((s) => s.field === 'priority')?.status || 'UNRESOLVED'),
      deadline: t.due_at, deadlineState: t.due_at ? 'CONFIRMED' : (h.some((e) => e.field === 'deadline' && ['SUGGESTED', 'PROPOSED'].includes(e.status)) ? 'UNCONFIRMED' : 'NOT_SET'),
      originalPriority: first('priority'), originalDeadline: first('deadline'), priorityChanges: changes('priority'), deadlineChanges: changes('deadline'),
      complexityExpectation: ex?.complexity_expectation ?? null, observedComplexity: observed.get(t.id) ?? null, workType: ex?.work_type ?? null,
      overdue: c.overdue, atRisk: c.atRisk, missedDeadline: missed, metDeadline: met, health, progress: t.progress, lastMeaningfulAt: t.last_meaningful_at ?? null,
      awaitingReview: t.status === 'SUBMITTED_FOR_REVIEW', outcomeItems,
      blockers: blockers.get(t.id) || { total: 0, open: 0 }, pendingChangeRequests: (requests.get(t.id) || []).filter((r) => r.status === 'PENDING').length,
      changeRequests: (requests.get(t.id) || []).length,
      outcome, outcomeKeys: verified.map((o) => (o.shared_outcome_key ? `shared:${o.shared_outcome_key}` : `impact:${o.id}`))
    }
    if (f.complexity && (f.complexity === 'NOT_ASSESSED' ? row.complexityExpectation : row.complexityExpectation !== f.complexity)) continue
    if (f.observedComplexity && (f.observedComplexity === 'NOT_ASSESSED' ? row.observedComplexity : row.observedComplexity !== f.observedComplexity)) continue
    if (f.workType && (row.workType || '').toLowerCase() !== f.workType.toLowerCase()) continue
    if (f.outcome && row.outcome !== f.outcome) continue
    if (f.deadline === 'CONFIRMED' && !row.deadline) continue
    if (f.deadline === 'NOT_CONFIRMED' && row.deadline) continue
    if (f.deadline === 'OVERDUE' && !row.overdue) continue
    if (f.deadline === 'MISSED' && !row.missedDeadline) continue
    if (f.deadline === 'MET' && !row.metDeadline) continue
    rows.push(row)
  }
  return rows
}

const bump = (m, k) => { m[k] = (m[k] || 0) + 1 }

/** Aggregates one set of rows. Outcomes are deduplicated by outcome key so a shared outcome counts once. */
function summarise(rows, f) {
  const out = {
    tasks: rows.length, open: 0, completed: 0, overdue: 0, atRisk: 0, blocked: 0,
    byPriority: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNRESOLVED: 0 }, byStatus: {}, byComplexityExpectation: { L1: 0, L2: 0, L3: 0, L4: 0, NOT_ASSESSED: 0 }, byObservedComplexity: { L1: 0, L2: 0, L3: 0, L4: 0, NOT_ASSESSED: 0 },
    byWorkType: {}, byOrigin: {},
    deadlines: { confirmed: 0, notConfirmed: 0, met: 0, missed: 0, overdueNow: 0 },
    changes: { deadlineChanged: 0, priorityChanged: 0, tasksWithChanges: 0, requests: 0, pendingRequests: 0 },
    unresolved: { priority: 0, deadline: 0 }, awaitingReview: 0,
    health: { onTrack: 0, atRisk: 0, blocked: 0, overdue: 0, unconfirmedDeadline: 0 },
    outcomes: { verified: 0, claimed: 0, none: 0, distinctVerifiedOutcomes: 0 }
  }
  const keys = new Set()
  const weeks = new Map()
  const bucket = (iso) => Math.floor(Date.parse(iso) / WEEK) * WEEK
  for (const r of rows) {
    if (CLOSED.includes(r.status)) { if (r.status === 'COMPLETED') out.completed++ } else out.open++
    if (r.overdue) out.overdue++
    if (r.atRisk) out.atRisk++
    if (r.status === 'BLOCKED') out.blocked++
    if (r.awaitingReview) out.awaitingReview++
    if (r.health) out.health[{ ON_TRACK: 'onTrack', AT_RISK: 'atRisk', BLOCKED: 'blocked', OVERDUE: 'overdue', UNCONFIRMED_DEADLINE: 'unconfirmedDeadline' }[r.health]]++
    bump(out.byStatus, r.status)
    out.byPriority[r.priority || 'UNRESOLVED']++
    out.byComplexityExpectation[r.complexityExpectation || 'NOT_ASSESSED']++
    out.byObservedComplexity[r.observedComplexity || 'NOT_ASSESSED']++
    bump(out.byWorkType, r.workType || 'Not set'); bump(out.byOrigin, r.origin || 'LEGACY')
    if (r.deadline) { out.deadlines.confirmed++; if (r.metDeadline) out.deadlines.met++; if (r.missedDeadline) out.deadlines.missed++; if (r.overdue) out.deadlines.overdueNow++ } else out.deadlines.notConfirmed++
    out.changes.deadlineChanged += r.deadlineChanges; out.changes.priorityChanged += r.priorityChanges
    if (r.deadlineChanges || r.priorityChanges) out.changes.tasksWithChanges++
    out.changes.requests += r.changeRequests; out.changes.pendingRequests += r.pendingChangeRequests
    if (!r.priority) out.unresolved.priority++
    if (!r.deadline) out.unresolved.deadline++
    if (r.outcome === 'VERIFIED') out.outcomes.verified++; else if (r.outcome === 'CLAIMED') out.outcomes.claimed++; else out.outcomes.none++
    for (const k of r.outcomeKeys) keys.add(k)
    const created = bucket(r.createdAt)
    weeks.set(created, { ...(weeks.get(created) || { created: 0, completed: 0 }), created: (weeks.get(created)?.created || 0) + 1, completed: weeks.get(created)?.completed || 0 })
    if (r.completedAt && r.completedAt >= f.from && r.completedAt <= f.to) { const w = bucket(r.completedAt); const cur = weeks.get(w) || { created: 0, completed: 0 }; weeks.set(w, { ...cur, completed: cur.completed + 1 }) }
  }
  out.outcomes.distinctVerifiedOutcomes = keys.size
  out.trend = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([at, x]) => ({ weekStart: new Date(at).toISOString().slice(0, 10), ...x }))
  return out
}

const present = (rows) => rows.slice(0, 200)
const latest = (a, b) => (!a ? b : !b ? a : a > b ? a : b)

/**
 * The outcomes recorded on a set of tasks, as one list: a shared outcome appears once however many people or tasks record it, and
 * "verified" (a manager confirmed it) stays separate from "claimed" (recorded, not yet verified). Rejected records are left out.
 */
/**
 * Contributions recorded without a task (the task is optional) are outcomes too. They have no priority, status or deadline, so they are left out
 * whenever a task-specific filter is on, and otherwise follow the same date range and the same people the caller may see.
 */
function tasklessOutcomes(db, f, userIds) {
  if (['priority', 'complexity', 'observedComplexity', 'status', 'deadline', 'outcome', 'workType', 'teamId'].some((k) => f[k]) || !userIds.length) return []
  const ids = f.userId ? userIds.filter((id) => id === f.userId) : userIds
  if (!ids.length) return []
  return db.prepare(`SELECT * FROM impact_records WHERE task_id IS NULL AND verification_status != 'REJECTED' AND created_at >= ? AND created_at <= ? AND user_id IN (${ids.map(() => '?').join(',')})`).all(f.from, f.to, ...ids)
    .map((o) => ({ id: o.id, key: o.shared_outcome_key ? `shared:${o.shared_outcome_key}` : `impact:${o.id}`, title: o.title, category: CATEGORY_LABELS[o.category] || o.category, state: o.verification_status === 'VERIFIED' ? 'VERIFIED' : 'CLAIMED', shared: Boolean(o.shared_outcome_key), userId: o.user_id }))
}

function outcomeList(db, rows, extra = []) {
  const byKey = new Map()
  for (const o of extra) {
    const x = byKey.get(o.key) || { key: o.key, id: o.id, title: o.title, category: o.category, state: o.state, shared: o.shared, taskId: null, taskTitle: null, people: [] }
    if (o.state === 'VERIFIED') x.state = 'VERIFIED'
    const n = nameOf(db, o.userId)
    if (n && !x.people.includes(n)) x.people.push(n)
    byKey.set(o.key, x)
  }
  for (const r of rows) {
    for (const o of r.outcomeItems) {
      const x = byKey.get(o.key) || { key: o.key, id: o.id, title: o.title, category: o.category, state: o.state, shared: o.shared, taskId: r.id, taskTitle: r.title, people: [] }
      if (o.state === 'VERIFIED') x.state = 'VERIFIED'
      const n = nameOf(db, o.userId)
      if (n && !x.people.includes(n)) x.people.push(n)
      byKey.set(o.key, x)
    }
  }
  const all = [...byKey.values()].sort((a, b) => (a.state === b.state ? a.title.localeCompare(b.title) : a.state === 'VERIFIED' ? -1 : 1))
  return { verified: all.filter((x) => x.state === 'VERIFIED').length, claimed: all.filter((x) => x.state === 'CLAIMED').length, shared: all.filter((x) => x.shared).length, items: all.slice(0, 50) }
}

const ATTENTION_RANK = { OVERDUE: 1, REVIEW: 2, CHANGE_REQUEST: 3, BLOCKED: 4, UNCONFIRMED: 5 }
/**
 * What a manager may need to act on, from the same definitions as the rest of the app. Open tasks only; a task can appear once per reason.
 * Blocked work is listed as context for the manager (a blocker is not a fault of the owner).
 */
function attention(rows, limit = 30) {
  const items = []
  const totals = { OVERDUE: 0, REVIEW: 0, CHANGE_REQUEST: 0, BLOCKED: 0, UNCONFIRMED: 0 }
  const add = (r, kind, issue) => { totals[kind]++; items.push({ taskId: r.id, title: r.title, ownerName: r.assigneeName, status: r.status, kind, issue }) }
  for (const r of rows) {
    if (!r.health) continue
    if (r.overdue) add(r, 'OVERDUE', 'Past its confirmed deadline')
    if (r.awaitingReview) add(r, 'REVIEW', 'Submitted and waiting for a manager’s review')
    if (r.pendingChangeRequests) add(r, 'CHANGE_REQUEST', `${r.pendingChangeRequests} change request${r.pendingChangeRequests === 1 ? '' : 's'} waiting for a decision`)
    if (r.status === 'BLOCKED') add(r, 'BLOCKED', r.blockers.open ? `Blocked: ${r.blockers.open} open blocker${r.blockers.open === 1 ? '' : 's'}` : 'Marked as blocked')
    if (!r.priority || !r.deadline) add(r, 'UNCONFIRMED', !r.priority && !r.deadline ? 'No confirmed priority or deadline' : !r.priority ? 'No confirmed priority' : 'No confirmed deadline')
  }
  items.sort((a, b) => ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] || a.title.localeCompare(b.title))
  return { totals, items: items.slice(0, limit), more: Math.max(0, items.length - limit) }
}

// ---------- views ----------
/** One person: the measurement profile (complexity, verified outcomes) beside what was expected of their work. Self or a manager in scope. */
export function personAnalytics(db, ctx, userId, q = {}) {
  const uid = v.id(userId, 'Person', { required: true })
  const f = readFilters(db, ctx, { ...q, userId: undefined })
  // personProfile enforces who may see this person (self, their manager, admin) and answers 404 otherwise.
  const profile = personProfile(db, ctx, uid, { from: f.from, to: f.to })
  const rows = collect(db, { ...ctx }, { ...f }, { subjectIds: [uid] })
  const mine = uid === ctx.user.id
  return {
    view: 'person', filters: f, person: profile.person, period: profile.period, summary: summarise(rows, f), tasks: present(rows), truncated: rows.length > 200,
    outcomeList: outcomeList(db, rows, tasklessOutcomes(db, f, [uid])), attention: attention(rows), lastMeaningfulAt: rows.reduce((m, r) => latest(m, r.lastMeaningfulAt), null),
    recent: rows.slice().sort((a, b) => String(b.lastMeaningfulAt || b.createdAt).localeCompare(String(a.lastMeaningfulAt || a.createdAt))).slice(0, 8).map((r) => ({ id: r.id, title: r.title, status: r.status, health: r.health, at: r.lastMeaningfulAt || null, createdAt: r.createdAt })),
    measurement: { complexityMix: profile.complexityMix, verifiedOutcomes: profile.verified.length, sharedOutcomes: profile.verified.filter((o) => o.shared).length, narrative: profile.narrative },
    viewingOwn: mine, notes: NOTES
  }
}

/** The manager's team: every figure is limited to people and tasks in the caller's scope. */
export function teamAnalytics(db, ctx, q = {}) {
  requireManager(ctx)
  const f = readFilters(db, ctx, q)
  if (f.userId && !isAdmin(ctx) && !scopeUserIds(db, ctx).includes(f.userId)) throw notFound('Person')
  const rows = collect(db, ctx, f)
  const overview = teamOverview(db, ctx, { from: f.from, to: f.to })
  const people = overview.people.map((p) => {
    const mine = rows.filter((r) => r.assigneeId === p.userId)
    const s = summarise(mine, f)
    return { userId: p.userId, name: p.name, team: p.team, tasks: s.tasks, open: s.open, completed: s.completed, overdue: s.overdue, byPriority: s.byPriority, byStatus: s.byStatus, blocked: s.blocked, atRisk: s.atRisk, inProgress: s.byStatus.IN_PROGRESS || 0, awaitingReview: s.awaitingReview, health: s.health, lastMeaningfulAt: mine.reduce((m, r) => latest(m, r.lastMeaningfulAt), null), unresolvedPriority: s.unresolved.priority, verifiedOutcomes: p.verifiedOutcomes, sharedOutcomes: p.sharedOutcomes }
  })
  const teams = db.prepare('SELECT id, name FROM teams WHERE org_id = ?').all(ctx.orgId)
  const byTeam = teams.map((tm) => ({ teamId: tm.id, team: tm.name, rows: rows.filter((r) => r.teamId === tm.id) })).filter((x) => x.rows.length).map((x) => ({ teamId: x.teamId, team: x.team, ...summarise(x.rows, f) }))
  return { view: 'team', filters: f, period: overview.period, summary: summarise(rows, f), teams: byTeam, people: people.sort((a, b) => a.name.localeCompare(b.name)), ordering: 'alphabetical', tasks: present(rows), truncated: rows.length > 200,
    unassigned: (() => { const u = rows.filter((r) => !r.assigneeId); return { ...(({ tasks, open, completed, blocked, byStatus }) => ({ tasks, open, completed, blocked, byStatus }))(summarise(u, f)) } })(),
    outcomeList: outcomeList(db, rows, tasklessOutcomes(db, f, people.map((p) => p.userId))), attention: attention(rows), notes: NOTES }
}

/** A single task: expectations (original and revised), their history, change requests, blockers, outcomes and the journey. Managers of the task only. */
export function taskAnalytics(db, ctx, taskId) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (!canManageTask(db, ctx, task)) throw forbidden('Task analytics are for the task’s manager.')
  const rows = collect(db, ctx, { from: '1970-01-01T00:00:00.000Z', to: new Date(Date.now() + 86400000).toISOString() }, {}).filter((r) => r.id === task.id)
  const row = rows[0] || null
  const history = db.prepare('SELECT field, kind, status, source, old_value, new_value, actor_id, reason, confidence, created_at FROM task_parameter_events WHERE task_id = ? ORDER BY created_at, rowid').all(task.id)
    .map((e) => ({ field: e.field, kind: e.kind, status: e.status, source: e.source, oldValue: json(e.old_value, null), value: json(e.new_value, null), actorName: nameOf(db, e.actor_id), reason: e.reason, confidence: e.confidence, at: e.created_at }))
  const requests = db.prepare('SELECT * FROM task_change_requests WHERE task_id = ? ORDER BY created_at').all(task.id).map((r) => ({ id: r.id, kind: r.kind, status: r.status, reason: r.reason, proposed: json(r.proposed, {}), requestedBy: nameOf(db, r.requested_by), decidedBy: nameOf(db, r.decided_by), decisionNote: r.decision_note, createdAt: r.created_at, decidedAt: r.decided_at }))
  const blockers = db.prepare('SELECT id, description, status, reported_at, resolved_at FROM blockers WHERE task_id = ? ORDER BY reported_at').all(task.id)
  const outcomes = db.prepare('SELECT id, title, category, verification_status, shared_outcome_key FROM impact_records WHERE task_id = ? AND org_id = ?').all(task.id, ctx.orgId)
    .map((o) => ({ id: o.id, title: o.title, category: CATEGORY_LABELS[o.category] || o.category, state: o.verification_status, shared: Boolean(o.shared_outcome_key) }))
  const baseline = {}
  for (const e of history) if (e.status === 'CONFIRMED' && !(e.field in baseline)) baseline[e.field] = e.value
  const current = { priority: task.priority, deadline: task.due_at, expectedOutcome: task.expected_outcome }
  return {
    view: 'task', task: row, original: baseline, current, history, changeRequests: requests, blockers, outcomes,
    suggestions: openSuggestions(db, task.id), progress: task.progress, lastMeaningfulAt: task.last_meaningful_at ?? null,
    owner: task.assignee_id ? { id: task.assignee_id, name: nameOf(db, task.assignee_id) } : null,
    contributors: db.prepare('SELECT user_id, role FROM task_participants WHERE task_id = ? AND org_id = ? ORDER BY created_at').all(task.id, ctx.orgId).map((p) => ({ name: nameOf(db, p.user_id), role: p.role.toLowerCase() })),
    evidenceCount: db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE task_id = ? AND org_id = ?').get(task.id, ctx.orgId).n,
    journey: taskJourney(db, ctx, task.id), notes: NOTES
  }
}

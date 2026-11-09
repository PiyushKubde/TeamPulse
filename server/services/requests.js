// Task requests (suggestions). A request has its own status; approval creates an official task.
// External requests (from automations) always land here as PENDING; they are never auto-assigned.
import { now, transaction, uuid } from '../db.js'
import { conflict, forbidden, invalid, notFound } from '../errors.js'
import { isActiveMember, isAdmin, isManager, requireManager, scopeUserIds } from '../access.js'
import * as v from '../validate.js'
import { emit } from './events.js'
import { createTask } from './tasks.js'
import { notifyInApp } from './notify.js'

const userName = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)

function readRequestFields(db, orgId, body) {
  const f = {
    title: v.text(body?.title, 'Title', { required: true, max: 200 }),
    description: v.text(body?.description, 'Description', { max: 5000 }),
    reason: v.text(body?.reason, 'Reason', { max: 2000 }),
    expected_outcome: v.text(body?.expectedOutcome, 'Expected outcome', { max: 2000 }),
    suggested_priority: v.oneOf(body?.suggestedPriority, 'Suggested priority', v.PRIORITIES, { fallback: 'MEDIUM' }),
    suggested_due_at: v.dateTime(body?.suggestedDueAt, 'Suggested deadline'),
    suggested_assignee_id: v.id(body?.suggestedAssigneeId, 'Suggested assignee')
  }
  if (f.suggested_assignee_id && !isActiveMember(db, orgId, f.suggested_assignee_id)) throw invalid('The suggested assignee must be a member of your organization.')
  return f
}

/** An employee's (or anyone's) suggestion. Anyone in the organization may suggest. */
export function createRequestRecord(db, ctx, body) {
  const f = readRequestFields(db, ctx.orgId, body)
  if (!f.reason) throw invalid('Reason is required: say why this task is needed.', { field: 'reason' })
  let teamId = v.id(body?.teamId, 'Team') || ctx.teamId || null
  if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(teamId, ctx.orgId)) throw notFound('Team')
  const id = uuid()
  const ts = now()
  db.prepare(`INSERT INTO task_requests (id, org_id, team_id, requested_by, source, title, description, reason, expected_outcome, suggested_priority, suggested_due_at, suggested_assignee_id, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
    .run(id, ctx.orgId, teamId, ctx.user.id, f.title, f.description, f.reason, f.expected_outcome, f.suggested_priority, f.suggested_due_at, f.suggested_assignee_id, ts, ts)
  emit({ type: 'request.created', orgId: ctx.orgId, requestId: id, actorId: ctx.user.id })
  return getRequest(db, ctx, id)
}

/** From the external-request automation: authenticated by the org's intake token, idempotent by externalRef. */
export function createExternalRequest(db, orgId, body, { defaultTeamId = null } = {}) {
  const f = readRequestFields(db, orgId, { ...body, suggestedAssigneeId: null })
  const externalRef = v.text(body?.externalRef, 'externalRef', { max: 200 })
  const requester = v.text(body?.requester, 'requester', { max: 200 })
  if (externalRef) {
    const existing = db.prepare('SELECT id, status FROM task_requests WHERE org_id = ? AND external_ref = ?').get(orgId, externalRef)
    if (existing) return { id: existing.id, status: existing.status, duplicate: true }
  }
  const teamId = defaultTeamId && db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(defaultTeamId, orgId) ? defaultTeamId : null
  const id = uuid()
  const ts = now()
  db.prepare(`INSERT INTO task_requests (id, org_id, team_id, requested_by, source, external_requester, external_ref, title, description, reason, expected_outcome, suggested_priority, suggested_due_at, status, created_at, updated_at)
              VALUES (?, ?, ?, NULL, 'external', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
    .run(id, orgId, teamId, requester, externalRef, f.title, f.description, f.reason || 'External request', f.expected_outcome, f.suggested_priority, f.suggested_due_at, ts, ts)
  emit({ type: 'request.created', orgId, requestId: id, external: true })
  return { id, status: 'PENDING', duplicate: false }
}

function present(db, r) {
  return {
    id: r.id, title: r.title, description: r.description, reason: r.reason, expectedOutcome: r.expected_outcome,
    suggestedPriority: r.suggested_priority, suggestedDueAt: r.suggested_due_at, suggestedAssigneeId: r.suggested_assignee_id, suggestedAssigneeName: userName(db, r.suggested_assignee_id),
    teamId: r.team_id, teamName: r.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(r.team_id)?.name ?? null : null,
    source: r.source, externalRequester: r.external_requester, requestedBy: r.requested_by, requestedByName: userName(db, r.requested_by),
    status: r.status, decisionNote: r.decision_note, decidedByName: userName(db, r.decided_by), decidedAt: r.decided_at, taskId: r.task_id,
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}

/** Requests this context may see: own; managers their teams' (and their people's); admins all. */
function requestScope(db, ctx) {
  if (isAdmin(ctx)) return { sql: 'r.org_id = ?', params: [ctx.orgId] }
  if (ctx.role === 'manager') {
    const people = scopeUserIds(db, ctx)
    const teams = ctx.managedTeamIds
    return {
      sql: `r.org_id = ? AND (r.requested_by IN (${people.map(() => '?').join(',')})${teams.length ? ` OR r.team_id IN (${teams.map(() => '?').join(',')})` : ''})`,
      params: [ctx.orgId, ...people, ...teams]
    }
  }
  return { sql: 'r.org_id = ? AND r.requested_by = ?', params: [ctx.orgId, ctx.user.id] }
}

export function listRequests(db, ctx, q = {}) {
  const s = requestScope(db, ctx)
  const where = [s.sql]
  const params = [...s.params]
  if (q.status) { where.push('r.status = ?'); params.push(v.oneOf(q.status, 'Status', ['PENDING', 'APPROVED', 'REJECTED', 'CLARIFICATION_REQUESTED', 'WITHDRAWN'])) }
  if (q.mine === 'true') { where.push('r.requested_by = ?'); params.push(ctx.user.id) }
  return db.prepare(`SELECT r.* FROM task_requests r WHERE ${where.join(' AND ')} ORDER BY CASE r.status WHEN 'PENDING' THEN 0 WHEN 'CLARIFICATION_REQUESTED' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 300`)
    .all(...params).map((r) => present(db, r))
}

function requireRequest(db, ctx, id) {
  const s = requestScope(db, ctx)
  const r = db.prepare(`SELECT r.* FROM task_requests r WHERE r.id = ? AND ${s.sql}`).get(v.id(id, 'Request', { required: true }), ...s.params)
  if (!r) throw notFound('Task request')
  return r
}

export function getRequest(db, ctx, id) {
  return present(db, requireRequest(db, ctx, id))
}

/** Approve (creates the official task), reject (reason required) or ask for clarification (question required). */
export function decideRequest(db, ctx, id, body) {
  requireManager(ctx)
  const r = requireRequest(db, ctx, id)
  if (!['PENDING', 'CLARIFICATION_REQUESTED'].includes(r.status)) throw conflict(`This request is already ${r.status.toLowerCase()}.`, 'request_decided')
  if (r.requested_by === ctx.user.id && !isAdmin(ctx)) throw forbidden('You cannot approve your own request.')
  const decision = v.oneOf(body?.decision, 'Decision', ['APPROVE', 'REJECT', 'CLARIFY'], { required: true })
  const note = v.text(body?.note, decision === 'REJECT' ? 'Rejection reason' : decision === 'CLARIFY' ? 'Question' : 'Note', { max: 2000, required: decision !== 'APPROVE' })
  const ts = now()
  if (decision !== 'APPROVE') {
    const status = decision === 'REJECT' ? 'REJECTED' : 'CLARIFICATION_REQUESTED'
    db.prepare('UPDATE task_requests SET status = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(status, note, ctx.user.id, ts, ts, r.id)
    if (r.requested_by) {
      notifyInApp(db, { orgId: ctx.orgId, userId: r.requested_by, kind: 'request_decision', title: decision === 'REJECT' ? `Request not approved: ${r.title}` : `Question about your request: ${r.title}`, body: note, link: '#/requests', dedupeKey: `request:${r.id}:${status}:${ts}` })
    }
    return getRequest(db, ctx, r.id)
  }
  // Approval: the manager may adjust priority, deadline, team and assignee; assignment rules are the manager's own.
  const result = transaction(db, () => {
    const created = createTask(db, ctx, {
      title: r.title, description: r.description, expectedOutcome: r.expected_outcome,
      priority: body?.priority ?? r.suggested_priority, dueAt: body?.dueAt !== undefined ? body.dueAt : r.suggested_due_at,
      teamId: body?.teamId !== undefined ? body.teamId : (r.team_id && (isAdmin(ctx) || ctx.managedTeamIds.includes(r.team_id)) ? r.team_id : null),
      assigneeId: body?.assigneeId !== undefined ? body.assigneeId : r.suggested_assignee_id, links: [], _sourceRequestId: r.id
    })
    db.prepare(`UPDATE task_requests SET status = 'APPROVED', decision_note = ?, decided_by = ?, decided_at = ?, task_id = ?, updated_at = ? WHERE id = ?`).run(note, ctx.user.id, ts, created.task.id, ts, r.id)
    return created
  })
  if (r.requested_by) notifyInApp(db, { orgId: ctx.orgId, userId: r.requested_by, kind: 'request_decision', title: `Request approved: ${r.title}`, body: note, link: `#/tasks/${result.task.id}`, dedupeKey: `request:${r.id}:APPROVED` })
  return { ...getRequest(db, ctx, r.id), task: result.task }
}

/** The requester answers a clarification (or edits a pending request); it goes back to PENDING. */
export function updateRequest(db, ctx, id, body) {
  const r = requireRequest(db, ctx, id)
  if (r.requested_by !== ctx.user.id) throw forbidden('Only the person who made this request can change it.')
  if (!['PENDING', 'CLARIFICATION_REQUESTED'].includes(r.status)) throw conflict('This request has already been decided.', 'request_decided')
  const f = readRequestFields(db, ctx.orgId, { title: r.title, description: r.description, reason: r.reason, expectedOutcome: r.expected_outcome, suggestedPriority: r.suggested_priority, suggestedDueAt: r.suggested_due_at, suggestedAssigneeId: r.suggested_assignee_id, ...body })
  const ts = now()
  db.prepare(`UPDATE task_requests SET title = ?, description = ?, reason = ?, expected_outcome = ?, suggested_priority = ?, suggested_due_at = ?, suggested_assignee_id = ?, status = 'PENDING', updated_at = ? WHERE id = ?`)
    .run(f.title, f.description, f.reason, f.expected_outcome, f.suggested_priority, f.suggested_due_at, f.suggested_assignee_id, ts, r.id)
  if (r.status === 'CLARIFICATION_REQUESTED' && r.decided_by) {
    notifyInApp(db, { orgId: ctx.orgId, userId: r.decided_by, kind: 'request_clarified', title: `${ctx.user.name} answered your question: ${f.title}`, link: '#/requests', dedupeKey: `request:${r.id}:clarified:${ts}` })
  }
  return getRequest(db, ctx, r.id)
}

export function withdrawRequest(db, ctx, id) {
  const r = requireRequest(db, ctx, id)
  if (r.requested_by !== ctx.user.id) throw forbidden('Only the person who made this request can withdraw it.')
  if (!['PENDING', 'CLARIFICATION_REQUESTED'].includes(r.status)) throw conflict('This request has already been decided.', 'request_decided')
  db.prepare(`UPDATE task_requests SET status = 'WITHDRAWN', updated_at = ? WHERE id = ?`).run(now(), r.id)
  return getRequest(db, ctx, r.id)
}

export const pendingRequestCount = (db, ctx) => (isManager(ctx) ? listRequests(db, ctx, { status: 'PENDING' }).filter((r) => r.requestedBy !== ctx.user.id || isAdmin(ctx)).length : 0)

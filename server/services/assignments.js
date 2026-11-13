// The acceptance workflow: a task created from Slack waits for its tagged person (PENDING_ACCEPTANCE); that person
// accepts, declines (with a reason) or proposes a transfer to a teammate, who must accept before ownership moves.
// Every ownership change is a row in task_assignments / task_transfers plus a task event, never an overwrite.
// Notifications and alerts are raised by the event listeners in alerts.js, so they survive a restart via the outbox.
import { now, transaction, uuid, json } from '../db.js'
import { conflict, forbidden, invalid, notFound } from '../errors.js'
import { canManageTask, isActiveMember, requireVisibleTask, taskScopeSql } from '../access.js'
import * as v from '../validate.js'
import { audit } from './audit.js'
import { emit } from './events.js'
import { recordEvent, pendingTransfer } from './tasks.js'
import { suggestValues } from './task-parameters.js'

const userName = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)
const getTask = (db, id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
const TRANSFERABLE = ['PENDING_ACCEPTANCE', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED']

/**
 * Creates a task for a person tagged in a Slack message. Not a user action: called by the Slack intake with the
 * intake owner as `creatorId` (the requester is recorded on the task, never made its owner).
 * One task per Slack message (unique slack_message_ref), so a repeated delivery cannot create a second one.
 */
export function createIntakeTask(db, { orgId, creatorId, teamId, assigneeId, title, description, expectedOutcome = null, priority = null, dueAt = null, priorityConfidence = null, deadlineConfidence = null, slackRef, requester = {}, support = [], reviewers = [], extraction = null }) {
  const ts = now()
  const id = uuid()
  const assignmentId = uuid()
  transaction(db, () => {
    db.prepare(`INSERT INTO tasks (id, org_id, team_id, title, description, expected_outcome, created_by, assignee_id, priority, status, progress, due_at, links, assigned_at,
                acceptance_state, slack_message_ref, status_changed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_ACCEPTANCE', 0, ?, '[]', ?, 'pending', ?, ?, ?, ?)`)
      .run(id, orgId, teamId, title, description, null, creatorId, assigneeId, null, null, ts, slackRef, ts, ts, ts)
    db.prepare("UPDATE tasks SET origin = 'SLACK' WHERE id = ?").run(id)
    const t = getTask(db, id)
    // What the message said about priority, deadline and outcome is a suggestion with its source and confidence, never a confirmed value:
    // the columns stay empty until a manager confirms, so an unconfirmed deadline can never be overdue or raise a deadline alert.
    const evidence = { slackRef, extractedAt: ts, extraction: extraction || 'deterministic' }
    suggestValues(db, t, { priority, dueAt, expectedOutcome }, { source: 'SLACK_EXTRACTION', actorId: creatorId, confidence: null, evidence, reason: 'Read from the Slack message by fixed rules; not confirmed.' })
    for (const [field, conf] of [['priority', priorityConfidence], ['deadline', deadlineConfidence]]) if (conf) db.prepare("UPDATE task_parameter_events SET confidence = ? WHERE task_id = ? AND field = ? AND status = 'SUGGESTED'").run(conf, id, field)
    recordEvent(db, t, creatorId, 'created', { title, priority: null, fromSlack: true, requester: requester.name || null, extraction })
    recordEvent(db, t, creatorId, 'assigned', { to: assigneeId, toName: userName(db, assigneeId), via: 'slack_mention', awaitingAcceptance: true })
    db.prepare(`INSERT INTO task_assignments (id, org_id, task_id, user_id, source, state, assigned_by, assigned_at) VALUES (?, ?, ?, ?, 'SLACK_MENTION', 'PENDING', ?, ?)`)
      .run(assignmentId, orgId, id, assigneeId, creatorId, ts)
    const add = (userId, role) => { if (userId && userId !== assigneeId) db.prepare(`INSERT INTO task_participants (id, org_id, task_id, user_id, role, source, created_at) VALUES (?, ?, ?, ?, ?, 'slack', ?) ON CONFLICT DO NOTHING`).run(uuid(), orgId, id, userId, role, ts) }
    add(requester.userId, 'REQUESTER')
    for (const u of support) add(u, 'SUPPORT')
    for (const u of reviewers) add(u, 'REVIEWER')
  })
  emit({ type: 'assignment.created', orgId, taskId: id, assigneeId, assignmentId, actorId: creatorId, via: 'slack' })
  emit({ type: 'parameters.proposed', orgId, taskId: id, actorId: creatorId, source: 'SLACK_EXTRACTION' })
  return { taskId: id, assignmentId }
}

function ownTask(db, ctx, taskId) {
  const t = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  if (t.assignee_id !== ctx.user.id) throw forbidden('Only the person this task is assigned to can do that.')
  return t
}

function noOpenTransfer(db, t) {
  if (pendingTransfer(db, t.id)) throw conflict('A transfer of this task is waiting for an answer. Cancel it first.', 'transfer_pending')
}

export function acceptAssignment(db, ctx, taskId) {
  const t = ownTask(db, ctx, taskId)
  if (t.status !== 'PENDING_ACCEPTANCE') throw conflict('This task is not waiting for your answer.', 'not_pending_acceptance')
  noOpenTransfer(db, t)
  const ts = now()
  transaction(db, () => {
    const moved = db.prepare(`UPDATE tasks SET status = 'ASSIGNED', acceptance_state = 'accepted', accepted_at = ?, status_changed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_ACCEPTANCE' AND assignee_id = ?`).run(ts, ts, ts, t.id, ctx.user.id).changes
    if (!moved) throw conflict('This task is not waiting for your answer.', 'not_pending_acceptance')
    db.prepare(`UPDATE task_assignments SET state = 'ACCEPTED', responded_at = ? WHERE task_id = ? AND user_id = ? AND state = 'PENDING' AND ended_at IS NULL`).run(ts, t.id, ctx.user.id)
    recordEvent(db, t, ctx.user.id, 'assignment_accepted', { by: ctx.user.name })
    recordEvent(db, t, ctx.user.id, 'status_changed', { from: 'PENDING_ACCEPTANCE', to: 'ASSIGNED', reason: 'accepted' })
  })
  emit({ type: 'assignment.accepted', orgId: ctx.orgId, taskId: t.id, assigneeId: ctx.user.id, actorId: ctx.user.id })
  return { status: 'ASSIGNED', acceptedAt: ts }
}

export function declineAssignment(db, ctx, taskId, body) {
  const t = ownTask(db, ctx, taskId)
  if (t.status !== 'PENDING_ACCEPTANCE') throw conflict('This task is not waiting for your answer.', 'not_pending_acceptance')
  noOpenTransfer(db, t)
  const reason = v.text(body?.reason, 'Reason', { required: true, min: 3, max: 1000 })
  const ts = now()
  transaction(db, () => {
    const moved = db.prepare(`UPDATE tasks SET status = 'DECLINED', acceptance_state = 'declined', declined_reason = ?, status_changed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_ACCEPTANCE' AND assignee_id = ?`).run(reason, ts, ts, t.id, ctx.user.id).changes
    if (!moved) throw conflict('This task is not waiting for your answer.', 'not_pending_acceptance')
    db.prepare(`UPDATE task_assignments SET state = 'DECLINED', responded_at = ?, ended_at = ?, reason = ? WHERE task_id = ? AND user_id = ? AND state = 'PENDING' AND ended_at IS NULL`).run(ts, ts, reason, t.id, ctx.user.id)
    recordEvent(db, t, ctx.user.id, 'assignment_declined', { by: ctx.user.name, reason })
    recordEvent(db, t, ctx.user.id, 'status_changed', { from: 'PENDING_ACCEPTANCE', to: 'DECLINED', reason })
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'assignment.declined', entityType: 'task', entityId: t.id, before: { status: t.status }, after: { status: 'DECLINED', reason } })
  })
  emit({ type: 'assignment.declined', orgId: ctx.orgId, taskId: t.id, assigneeId: ctx.user.id, actorId: ctx.user.id, reason })
  return { status: 'DECLINED' }
}

// ---------- transfers ----------
/** Who the current owner may hand the task to: active members of their own team (never themselves, never another organization). */
export function transferCandidates(db, ctx) {
  if (!ctx.teamId) return []
  return db.prepare(`SELECT m.user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.team_id = ? AND m.status = 'active' AND m.user_id != ? ORDER BY u.name`)
    .all(ctx.orgId, ctx.teamId, ctx.user.id).map((r) => ({ userId: r.user_id, name: r.name }))
}

export function proposeTransfer(db, ctx, taskId, body) {
  const t = ownTask(db, ctx, taskId)
  if (!TRANSFERABLE.includes(t.status)) throw conflict('This task cannot be transferred in its current state.', 'invalid_transition')
  const toId = v.id(body?.toUserId, 'New owner', { required: true })
  const reason = v.text(body?.reason, 'Reason', { required: true, min: 3, max: 1000 })
  if (toId === ctx.user.id) throw invalid('Choose someone other than yourself.')
  if (!isActiveMember(db, ctx.orgId, toId)) throw invalid('The new owner must be an active member of your team.')
  const toTeam = db.prepare('SELECT team_id FROM memberships WHERE org_id = ? AND user_id = ?').get(ctx.orgId, toId)?.team_id
  if (!ctx.teamId || toTeam !== ctx.teamId) throw forbidden('You can transfer a task only to someone in your own team.')
  noOpenTransfer(db, t)
  const id = uuid()
  const ts = now()
  try {
    transaction(db, () => {
      db.prepare(`INSERT INTO task_transfers (id, org_id, task_id, from_user_id, to_user_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`).run(id, ctx.orgId, t.id, ctx.user.id, toId, reason, ts)
      recordEvent(db, t, ctx.user.id, 'transfer_proposed', { transferId: id, to: toId, toName: userName(db, toId), reason })
    })
  } catch (error) {
    if (/UNIQUE/i.test(String(error.message))) throw conflict('A transfer of this task is already waiting for an answer.', 'transfer_pending')
    throw error
  }
  emit({ type: 'transfer.proposed', orgId: ctx.orgId, taskId: t.id, transferId: id, fromUserId: ctx.user.id, toUserId: toId, actorId: ctx.user.id })
  return { transferId: id, status: 'PENDING' }
}

function requireTransfer(db, ctx, id) {
  const x = db.prepare('SELECT * FROM task_transfers WHERE id = ? AND org_id = ?').get(v.id(id, 'Transfer', { required: true }), ctx.orgId)
  if (!x) throw notFound('Transfer')
  const t = getTask(db, x.task_id)
  const involved = x.to_user_id === ctx.user.id || x.from_user_id === ctx.user.id || (t && canManageTask(db, ctx, t))
  if (!involved || !t) throw notFound('Transfer')
  return { x, t }
}

/** The proposed new owner answers. Ownership moves only on ACCEPT. */
export function decideTransfer(db, ctx, transferId, body) {
  const { x, t } = requireTransfer(db, ctx, transferId)
  if (x.to_user_id !== ctx.user.id) throw forbidden('Only the person the task is offered to can answer a transfer.')
  if (x.status !== 'PENDING') throw conflict('This transfer was already settled.', 'transfer_settled')
  const decision = v.oneOf(body?.decision, 'Decision', ['ACCEPT', 'DECLINE'], { required: true })
  const note = v.text(body?.note, decision === 'DECLINE' ? 'Reason' : 'Note', { required: decision === 'DECLINE', min: decision === 'DECLINE' ? 3 : 0, max: 1000 })
  if (!TRANSFERABLE.includes(t.status)) throw conflict('This task can no longer be transferred.', 'invalid_transition')
  const ts = now()
  let assignmentId = null
  transaction(db, () => {
    const settled = db.prepare(`UPDATE task_transfers SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'`).run(decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED', ctx.user.id, note, ts, x.id).changes
    if (!settled) throw conflict('This transfer was already settled.', 'transfer_settled')
    if (decision === 'DECLINE') {
      recordEvent(db, t, ctx.user.id, 'transfer_declined', { transferId: x.id, by: ctx.user.name, reason: note })
      return
    }
    // The new owner accepted: ownership moves now and their own inactivity clock starts from this moment.
    const status = t.status === 'IN_PROGRESS' || t.status === 'PENDING_ACCEPTANCE' ? 'ASSIGNED' : t.status
    db.prepare(`UPDATE tasks SET assignee_id = ?, assigned_at = ?, status = ?, status_changed_at = ?, acceptance_state = 'accepted', accepted_at = ?, declined_reason = NULL, updated_at = ? WHERE id = ?`)
      .run(x.to_user_id, ts, status, status !== t.status ? ts : t.status_changed_at, ts, ts, t.id)
    db.prepare(`UPDATE task_assignments SET state = 'TRANSFERRED_OUT', ended_at = ? WHERE task_id = ? AND ended_at IS NULL`).run(ts, t.id)
    assignmentId = uuid()
    db.prepare(`INSERT INTO task_assignments (id, org_id, task_id, user_id, source, state, assigned_by, transfer_id, reason, assigned_at, responded_at) VALUES (?, ?, ?, ?, 'TRANSFER', 'ACCEPTED', ?, ?, ?, ?, ?)`)
      .run(assignmentId, t.org_id, t.id, x.to_user_id, x.from_user_id, x.id, x.reason, ts, ts)
    recordEvent(db, t, ctx.user.id, 'transfer_accepted', { transferId: x.id, from: x.from_user_id, fromName: userName(db, x.from_user_id), to: x.to_user_id, toName: userName(db, x.to_user_id), initiatedBy: x.from_user_id, reason: x.reason })
    recordEvent(db, t, ctx.user.id, 'reassigned', { from: x.from_user_id, fromName: userName(db, x.from_user_id), to: x.to_user_id, toName: userName(db, x.to_user_id), reason: `Transfer: ${x.reason}` })
    if (status !== t.status) recordEvent(db, t, ctx.user.id, 'status_changed', { from: t.status, to: status, reason: 'transfer accepted' })
  })
  emit({ type: 'transfer.decided', orgId: ctx.orgId, taskId: t.id, transferId: x.id, decision, fromUserId: x.from_user_id, toUserId: x.to_user_id, actorId: ctx.user.id, assignmentId, note })
  return { status: decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED', taskId: t.id }
}

/** The proposer withdraws, or a manager settles, an open transfer: the current owner keeps the task. */
export function cancelTransfer(db, ctx, transferId, body) {
  const { x, t } = requireTransfer(db, ctx, transferId)
  if (x.from_user_id !== ctx.user.id && !canManageTask(db, ctx, t)) throw forbidden('Only the person who proposed the transfer, or the task’s manager, can cancel it.')
  if (x.status !== 'PENDING') throw conflict('This transfer was already settled.', 'transfer_settled')
  const note = v.text(body?.note, 'Note', { max: 1000 })
  const ts = now()
  transaction(db, () => {
    const settled = db.prepare(`UPDATE task_transfers SET status = 'CANCELLED', decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'`).run(ctx.user.id, note, ts, x.id).changes
    if (!settled) throw conflict('This transfer was already settled.', 'transfer_settled')
    recordEvent(db, t, ctx.user.id, 'transfer_cancelled', { transferId: x.id, by: ctx.user.name, note })
  })
  emit({ type: 'transfer.decided', orgId: ctx.orgId, taskId: t.id, transferId: x.id, decision: 'CANCEL', fromUserId: x.from_user_id, toUserId: x.to_user_id, actorId: ctx.user.id, note })
  return { status: 'CANCELLED' }
}

// ---------- what a person and their manager see ----------
const presentTransfer = (r) => ({ id: r.id, taskId: r.task_id, taskTitle: r.task_title, fromUserId: r.from_user_id, fromName: r.from_name, toUserId: r.to_user_id, toName: r.to_name, reason: r.reason, status: r.status, decisionNote: r.decision_note, decidedByName: r.decided_by_name, decidedAt: r.decided_at, createdAt: r.created_at })
const TRANSFER_SELECT = `SELECT x.*, f.name AS from_name, o.name AS to_name, d.name AS decided_by_name, t.title AS task_title FROM task_transfers x JOIN users f ON f.id = x.from_user_id JOIN users o ON o.id = x.to_user_id LEFT JOIN users d ON d.id = x.decided_by JOIN tasks t ON t.id = x.task_id`

/** Everything waiting on this person: tasks to accept and transfers offered to them. */
export function myInbox(db, ctx) {
  const awaiting = db.prepare(`SELECT t.id, t.title, t.priority, t.due_at, t.assigned_at, t.description, t.slack_message_ref FROM tasks t WHERE t.org_id = ? AND t.assignee_id = ? AND t.status = 'PENDING_ACCEPTANCE' ORDER BY t.assigned_at`).all(ctx.orgId, ctx.user.id)
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority, dueAt: t.due_at, assignedAt: t.assigned_at, fromSlack: Boolean(t.slack_message_ref), requesterName: db.prepare('SELECT sender_name FROM slack_intake_items WHERE task_id = ?').get(t.id)?.sender_name ?? null, pendingTransfer: pendingTransfer(db, t.id) }))
  const offered = db.prepare(`${TRANSFER_SELECT} WHERE x.org_id = ? AND x.to_user_id = ? AND x.status = 'PENDING' ORDER BY x.created_at`).all(ctx.orgId, ctx.user.id).map(presentTransfer)
  const mineOut = db.prepare(`${TRANSFER_SELECT} WHERE x.org_id = ? AND x.from_user_id = ? AND x.status = 'PENDING' ORDER BY x.created_at`).all(ctx.orgId, ctx.user.id).map(presentTransfer)
  const declined = db.prepare(`SELECT id, title, declined_reason, status_changed_at FROM tasks WHERE org_id = ? AND assignee_id = ? AND status = 'DECLINED' ORDER BY status_changed_at DESC LIMIT 20`).all(ctx.orgId, ctx.user.id)
    .map((t) => ({ id: t.id, title: t.title, reason: t.declined_reason, at: t.status_changed_at }))
  return { awaitingAcceptance: awaiting, transfersOfferedToMe: offered, transfersIProposed: mineOut, declinedByMe: declined, candidates: transferCandidates(db, ctx) }
}

/** The ownership story of one task: who was tagged, who accepted, every transfer, the Slack message it came from. */
export function taskWorkflow(db, ctx, taskId) {
  const t = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  const assignments = db.prepare(`SELECT a.*, u.name, b.name AS by_name FROM task_assignments a JOIN users u ON u.id = a.user_id LEFT JOIN users b ON b.id = a.assigned_by WHERE a.task_id = ? ORDER BY a.assigned_at, a.rowid`).all(t.id)
    .map((a) => ({ id: a.id, userId: a.user_id, name: a.name, source: a.source, state: a.state, assignedByName: a.by_name, reason: a.reason, assignedAt: a.assigned_at, respondedAt: a.responded_at, endedAt: a.ended_at }))
  const transfers = db.prepare(`${TRANSFER_SELECT} WHERE x.task_id = ? ORDER BY x.created_at`).all(t.id).map(presentTransfer)
  const participants = db.prepare(`SELECT p.role, p.user_id, u.name FROM task_participants p JOIN users u ON u.id = p.user_id WHERE p.task_id = ? ORDER BY p.role, u.name`).all(t.id).map((p) => ({ role: p.role, userId: p.user_id, name: p.name }))
  const s = db.prepare('SELECT * FROM slack_intake_items WHERE task_id = ?').get(t.id)
  const source = s ? { channelId: s.channel_id, threadTs: s.thread_ts, senderName: s.sender_name, senderUserId: s.sender_user_id, permalink: s.permalink, text: s.text, mentions: json(s.mentions, []), extraction: s.extraction, receivedAt: s.created_at } : null
  return { assignments, transfers, participants, source, candidates: t.assignee_id === ctx.user.id ? transferCandidates(db, ctx) : [] }
}

/** Transfers in this person's scope (managers), newest first, for the assignment dashboard. */
export function transfersInScope(db, ctx, { limit = 60 } = {}) {
  const scope = taskScopeSql(ctx)
  return db.prepare(`${TRANSFER_SELECT} WHERE ${scope.sql} ORDER BY x.created_at DESC LIMIT ?`).all(...scope.params, limit).map(presentTransfer)
}

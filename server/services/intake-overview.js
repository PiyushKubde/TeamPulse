// The manager's view of Slack-originated work: where each task came from, who was tagged, who owns it now, whether it is
// moving, and what is waiting on a manager (declines, transfers, unmapped people, explanations). Operational information
// only: no ranking, no score, nothing derived from task counts or message volume.
import { json } from '../db.js'
import { forbidden } from '../errors.js'
import { isManager, scopeUserIds, taskScopeSql } from '../access.js'
import * as v from '../validate.js'
import { presentTask } from './tasks.js'
import { transfersInScope } from './assignments.js'
import { listExplanations } from './deadline-explanations.js'
import { listSlackIdentities } from './slack-identities.js'
import { LADDER } from './alerts.js'

const HOUR = 3600000

export function intakeOverview(db, ctx, q = {}) {
  if (!isManager(ctx)) throw forbidden('Only managers and admins can see the Slack intake dashboard.')
  const scope = taskScopeSql(ctx)
  const where = [scope.sql, 't.slack_message_ref IS NOT NULL']
  const params = [...scope.params]
  if (q.assigneeId) { where.push('t.assignee_id = ?'); params.push(v.id(q.assigneeId, 'Employee')) }
  if (q.teamId) { where.push('t.team_id = ?'); params.push(v.id(q.teamId, 'Team')) }
  if (q.status) {
    const statuses = String(q.status).split(',').map((s) => v.oneOf(s, 'Status', v.TASK_STATUSES))
    where.push(`t.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses)
  }
  if (q.acceptance === 'transfer_pending') where.push(`EXISTS (SELECT 1 FROM task_transfers x WHERE x.task_id = t.id AND x.status = 'PENDING' AND x.org_id = t.org_id)`)
  else if (q.acceptance) { where.push('t.acceptance_state = ?'); params.push(v.oneOf(q.acceptance, 'Assignment state', ['PENDING', 'ACCEPTED', 'DECLINED']).toLowerCase()) }
  if (q.severity) {
    const rule = LADDER[v.oneOf(q.severity, 'Severity', Object.keys(LADDER))]
    where.push('EXISTS (SELECT 1 FROM notifications n WHERE n.task_id = t.id AND n.kind = ?)'); params.push(rule)
  }
  if (q.due === 'week') {
    where.push(`t.due_at IS NOT NULL AND t.due_at <= ? AND t.status NOT IN ('COMPLETED','CANCELLED','DECLINED')`)
    params.push(new Date(Date.now() + 7 * 86400000).toISOString())
  }
  const rows = db.prepare(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 300`).all(...params)
  let tasks = rows.map((t) => {
    const p = presentTask(db, ctx, t)
    const src = db.prepare('SELECT sender_name, permalink, channel_id FROM slack_intake_items WHERE task_id = ?').get(t.id)
    const tagged = db.prepare(`SELECT u.id, u.name FROM task_assignments a JOIN users u ON u.id = a.user_id WHERE a.task_id = ? AND a.source = 'SLACK_MENTION' ORDER BY a.assigned_at LIMIT 1`).get(t.id)
    const moved = t.accepted_at ? Math.max(Date.parse(t.accepted_at), t.last_meaningful_at ? Date.parse(t.last_meaningful_at) : 0) : null
    return {
      ...p, requesterName: src?.sender_name ?? null, permalink: src?.permalink ?? null, channelId: src?.channel_id ?? null,
      taggedUserId: tagged?.id ?? null, taggedName: tagged?.name ?? null,
      hoursSinceMovement: moved && ['ASSIGNED', 'IN_PROGRESS'].includes(t.status) ? Math.floor((Date.now() - moved) / HOUR) : null,
      openBlockers: db.prepare(`SELECT COUNT(*) AS n FROM blockers WHERE task_id = ? AND status = 'OPEN'`).get(t.id).n,
      evidenceCount: db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?').get(t.id).n,
      transfers: db.prepare('SELECT COUNT(*) AS n FROM task_transfers WHERE task_id = ?').get(t.id).n,
      alerts: Object.entries(LADDER).filter(([, rule]) => db.prepare('SELECT 1 FROM notifications WHERE task_id = ? AND kind = ?').get(t.id, rule)).map(([sev]) => sev)
    }
  })
  if (q.due === 'overdue') tasks = tasks.filter((t) => t.overdue)

  // Slack messages that need a manager before they can become a task.
  const people = scopeUserIds(db, ctx)
  const needManager = db.prepare(`SELECT i.*, r.status AS request_status, s.owner_id FROM slack_intake_items i LEFT JOIN task_requests r ON r.id = i.request_id LEFT JOIN intake_subscriptions s ON s.id = i.subscription_id WHERE i.org_id = ? AND i.outcome = 'NEEDS_MANAGER' ORDER BY i.created_at DESC LIMIT 100`).all(ctx.orgId)
    .filter((i) => !people || people.includes(i.owner_id))
    .map((i) => ({ id: i.id, reason: i.reason, text: i.text, senderName: i.sender_name, mentions: json(i.mentions, []), permalink: i.permalink, requestId: i.request_id, requestStatus: i.request_status, createdAt: i.created_at }))

  const missed = db.prepare(`SELECT e.created_at AS at, json_extract(e.data, '$.dueAt') AS due_at, t.id, t.title, t.status, t.assignee_id, u.name AS owner_name FROM task_events e JOIN tasks t ON t.id = e.task_id LEFT JOIN users u ON u.id = t.assignee_id WHERE e.type = 'deadline_missed' AND ${scope.sql} ORDER BY e.created_at DESC LIMIT 100`).all(...scope.params)
    .map((m) => ({ taskId: m.id, title: m.title, status: m.status, ownerName: m.owner_name, dueAt: m.due_at, missedAt: m.at, explained: Boolean(db.prepare('SELECT 1 FROM deadline_explanations WHERE task_id = ? AND original_deadline = ?').get(m.id, m.due_at)) }))

  const explanations = listExplanations(db, ctx)
  const transfers = transfersInScope(db, ctx)
  const ids = listSlackIdentities(db, ctx)
  const count = (fn) => tasks.filter(fn).length
  return {
    summary: {
      pendingAcceptance: count((t) => t.status === 'PENDING_ACCEPTANCE'), accepted: count((t) => t.acceptanceState === 'accepted'), declined: count((t) => t.status === 'DECLINED'),
      pendingTransfers: transfers.filter((x) => x.status === 'PENDING').length, needManager: needManager.filter((n) => n.requestStatus === 'PENDING' || !n.requestStatus).length,
      overdue: count((t) => t.overdue), explanationsToReview: explanations.filter((x) => x.reviewStatus === 'PENDING' || x.reviewStatus === 'NEEDS_CLARIFICATION').length, unresolvedPeople: ids.unresolved.length
    },
    tasks, transfers, needManager, missed, explanations, identities: ids
  }
}

// Dashboards. Task counts are operational information only; contribution is shown through verified impact.
import { json } from '../db.js'
import { isManager, scopeUserIds, taskScopeSql } from '../access.js'
import { listTasks, reviewQueue } from './tasks.js'
import { contributionSummary, listImpact } from './impact.js'
import { listRequests } from './requests.js'
import { getReflection } from './reflections.js'
import { orgSettings } from './orgs.js'

const HOUR = 3600000

export function recentActivity(db, ctx, limit = 25) {
  const scope = taskScopeSql(ctx)
  return db.prepare(`SELECT e.*, u.name AS actor_name, t.title AS task_title FROM task_events e JOIN tasks t ON t.id = e.task_id LEFT JOIN users u ON u.id = e.actor_id
                     WHERE ${scope.sql} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`).all(...scope.params, limit)
    .map((e) => ({ id: e.id, type: e.type, taskId: e.task_id, taskTitle: e.task_title, actorName: e.actor_name, data: json(e.data, {}), createdAt: e.created_at }))
}

function attention(db, ctx, tasks, th) {
  const at = Date.now()
  const out = []
  for (const t of tasks) {
    if (t.overdue) out.push({ kind: 'overdue', severity: 3, task: t, detail: `${t.hoursOverdue}h past the deadline` })
    if (t.unassigned && at - Date.parse(t.createdAt) > th.unassignedHours * HOUR) out.push({ kind: 'unassigned', severity: 2, task: t, detail: 'No owner yet' })
    else if (t.unassigned) out.push({ kind: 'unassigned', severity: 1, task: t, detail: 'No owner yet' })
    if (t.status === 'BLOCKED' && t.blockedHours !== null && t.blockedHours >= th.blockerUnresolvedHours) out.push({ kind: 'blocked_long', severity: 3, task: t, detail: `Blocked for ${t.blockedHours}h` })
    if (t.status === 'ASSIGNED' && t.assigneeId && t.assignedAt && at - Date.parse(t.assignedAt) > th.notStartedHours * HOUR) out.push({ kind: 'not_started', severity: 1, task: t, detail: 'Assigned but not started' })
    if (t.status === 'IN_PROGRESS' && at - Date.parse(t.lastProgressAt || t.startedAt || t.statusChangedAt) > th.noProgressHours * HOUR) out.push({ kind: 'no_progress', severity: 2, task: t, detail: `No progress update for ${th.noProgressHours}h+` })
    if (t.status === 'SUBMITTED_FOR_REVIEW' && t.canManage && t.assigneeId !== ctx.user.id) out.push({ kind: 'awaiting_review', severity: 2, task: t, detail: 'Waiting for your review' })
    if (t.atRisk) out.push({ kind: 'at_risk', severity: 2, task: t, detail: t.hoursUntilDue !== null ? `${t.hoursUntilDue}h left at ${t.progress}%` : 'At risk' })
  }
  return out.sort((a, b) => b.severity - a.severity).slice(0, 40)
}

export function managerDashboard(db, ctx) {
  const th = orgSettings(db, ctx.orgId).alerts.thresholds
  const tasks = listTasks(db, ctx, { includeClosed: 'true' })
  const members = scopeUserIds(db, ctx)
  const people = db.prepare(`SELECT m.user_id, u.name, u.picture_url, m.role, t.name AS team_name FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN teams t ON t.id = m.team_id
                             WHERE m.org_id = ? AND m.status = 'active' AND m.user_id IN (${members.map(() => '?').join(',')}) ORDER BY u.name`).all(ctx.orgId, ...members)
  const open = tasks.filter((t) => ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW'].includes(t.status))
  const count = (fn) => tasks.filter(fn).length
  const workload = people.map((p) => {
    const mine = open.filter((t) => t.assigneeId === p.user_id)
    return {
      userId: p.user_id, name: p.name, pictureUrl: p.picture_url, role: p.role, teamName: p.team_name,
      active: mine.length, inProgress: mine.filter((t) => t.status === 'IN_PROGRESS').length, blocked: mine.filter((t) => t.status === 'BLOCKED').length,
      inReview: mine.filter((t) => t.status === 'SUBMITTED_FOR_REVIEW').length, overdue: mine.filter((t) => t.overdue).length,
      dueSoon: mine.filter((t) => !t.overdue && t.hoursUntilDue !== null && t.hoursUntilDue <= 72).length,
      critical: mine.filter((t) => t.priority === 'CRITICAL').length
    }
  })
  const since = new Date(Date.now() - 30 * 86400000).toISOString()
  const impact = contributionSummary(db, ctx, { status: 'VERIFIED', from: since })
  return {
    role: ctx.role,
    counts: {
      teamMembers: people.length,
      active: open.length,
      pending: count((t) => t.status === 'ASSIGNED'),
      inProgress: count((t) => t.status === 'IN_PROGRESS'),
      blocked: count((t) => t.status === 'BLOCKED'),
      completed: count((t) => t.status === 'COMPLETED'),
      overdue: count((t) => t.overdue),
      unassigned: count((t) => t.unassigned),
      awaitingReview: reviewQueue(db, ctx).length,
      atRisk: count((t) => t.atRisk),
      pendingRequests: listRequests(db, ctx, { status: 'PENDING' }).length,
      pendingImpact: listImpact(db, ctx, { status: 'PENDING' }).filter((r) => r.userId !== ctx.user.id).length
    },
    workload,
    attention: attention(db, ctx, open, th),
    activity: recentActivity(db, ctx),
    impact: {
      periodDays: 30,
      verifiedTotals: impact.verifiedTotals,
      recent: listImpact(db, ctx, { status: 'VERIFIED' }).slice(0, 6),
      people: impact.people
    }
  }
}

export function employeeDashboard(db, ctx) {
  const mine = listTasks(db, ctx, { view: 'mine', includeClosed: 'true' })
  const active = mine.filter((t) => ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(t.status))
  const changesRequested = new Set(db.prepare(`SELECT s.task_id FROM completion_submissions s WHERE s.submitted_by = ? AND s.status = 'CHANGES_REQUESTED'
                                               AND NOT EXISTS (SELECT 1 FROM completion_submissions s2 WHERE s2.task_id = s.task_id AND s2.created_at > s.created_at)`).all(ctx.user.id).map((r) => r.task_id))
  const awaitingMe = [
    ...active.filter((t) => t.status === 'ASSIGNED').map((t) => ({ kind: 'start', task: t, detail: 'Not started yet' })),
    ...active.filter((t) => t.status === 'IN_PROGRESS' && changesRequested.has(t.id)).map((t) => ({ kind: 'changes_requested', task: t, detail: 'Your manager asked for changes' }))
  ]
  const clarifications = listRequests(db, ctx, { status: 'CLARIFICATION_REQUESTED', mine: 'true' })
  const feedback = db.prepare(`SELECT r.*, u.name AS reviewer, COALESCE(t.title, i.title) AS subject_title, COALESCE(r.task_id, i.task_id) AS tid, i.id AS impact_id
                               FROM manager_reviews r JOIN users u ON u.id = r.reviewer_id
                               LEFT JOIN completion_submissions s ON r.subject_type = 'submission' AND s.id = r.subject_id
                               LEFT JOIN impact_records i ON r.subject_type = 'impact' AND i.id = r.subject_id
                               LEFT JOIN tasks t ON t.id = s.task_id
                               WHERE r.org_id = ? AND (s.submitted_by = ? OR i.user_id = ?) ORDER BY r.created_at DESC LIMIT 8`).all(ctx.orgId, ctx.user.id, ctx.user.id)
    .map((r) => ({ subjectType: r.subject_type, decision: r.decision, comment: r.comment, reviewer: r.reviewer, title: r.subject_title, taskId: r.tid, impactId: r.impact_id, createdAt: r.created_at }))
  return {
    role: ctx.role,
    counts: {
      active: active.length,
      awaitingMe: awaitingMe.length + clarifications.length,
      pending: mine.filter((t) => t.status === 'ASSIGNED').length,
      inProgress: mine.filter((t) => t.status === 'IN_PROGRESS').length,
      blocked: mine.filter((t) => t.status === 'BLOCKED').length,
      overdue: mine.filter((t) => t.overdue).length,
      inReview: mine.filter((t) => t.status === 'SUBMITTED_FOR_REVIEW').length,
      dueSoon: active.filter((t) => !t.overdue && t.hoursUntilDue !== null && t.hoursUntilDue <= 72).length
    },
    awaitingMe,
    clarifications,
    upcoming: active.filter((t) => t.dueAt && !t.overdue).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).slice(0, 8),
    overdue: mine.filter((t) => t.overdue),
    blocked: active.filter((t) => t.status === 'BLOCKED'),
    inReview: mine.filter((t) => t.status === 'SUBMITTED_FOR_REVIEW'),
    feedback,
    impact: listImpact(db, ctx, { view: 'mine' }).slice(0, 6),
    reflection: getReflection(db, ctx)
  }
}

export function dashboard(db, ctx) {
  return isManager(ctx) ? { manager: managerDashboard(db, ctx), personal: employeeDashboard(db, ctx) } : { personal: employeeDashboard(db, ctx) }
}

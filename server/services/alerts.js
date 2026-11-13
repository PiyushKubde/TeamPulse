// Alerts: rules evaluated on events and on a schedule. Every alert is an in-app notification; alerts whose rule has
// M91 turned on are also queued for M91 delivery, with retries, history and idempotent callbacks.
import { createHash, timingSafeEqual } from 'node:crypto'
import { now, transaction, uuid } from '../db.js'
import { invalid } from '../errors.js'
import { managersForTask, requireAdmin } from '../access.js'
import { deriveConditions, markDeadlineMissed } from './tasks.js'
import { notifyInApp } from './notify.js'
import { audit } from './audit.js'
import { orgSettings } from './orgs.js'
import { ALERT_RULES, DEFAULT_ALERT_SETTINGS, THRESHOLD_LIMITS } from './alert-rules.js'
import { REASONS } from './deadline-explanations.js'
import { orgTimezone } from '../time.js'

const HOUR = 3600000
const MAX_ATTEMPTS = 5
const backoffMs = (attempt) => Math.min(60 * 60000, 2 ** (attempt - 1) * 60000) // 1m, 2m, 4m, 8m...

/**
 * Raises one alert for a set of recipients. The dedupe key (rule + subject + anchor + user) makes it safe to evaluate
 * the same condition on every run: each person hears about it once.
 */
export function raiseAlert(db, { orgId, rule, userIds, taskId = null, title, body = null, link = null, anchor }) {
  const settings = orgSettings(db, orgId).alerts
  let created = 0
  for (const userId of new Set(userIds.filter(Boolean))) {
    const dedupeKey = `${rule}:${taskId || '-'}:${anchor}:${userId}`
    const notificationId = notifyInApp(db, { orgId, userId, kind: rule, title, body, link, taskId, dedupeKey })
    if (!notificationId) continue
    created++
    if (settings.m91Enabled && settings.rules[rule]?.m91) {
      const user = db.prepare('SELECT email, phone FROM users WHERE id = ?').get(userId)
      const ts = now()
      db.prepare(`INSERT INTO alert_deliveries (id, org_id, notification_id, user_id, task_id, rule, provider, recipient, status, attempts, next_attempt_at, dedupe_key, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'm91', ?, 'QUEUED', 0, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
        .run(uuid(), orgId, notificationId, userId, taskId, rule, user?.phone || null, ts, `m91:${dedupeKey}`, ts, ts)
    }
  }
  return created
}

const taskLink = (id) => `#/tasks/${id}`
const nameOf = (db, id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone'
/** A deadline as people read it: in the organization's timezone, not the server's. */
function dueText(iso, db, orgId) {
  const tz = orgTimezone(db, orgId)
  const d = new Date(iso)
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)} (${tz})`
}
/** Time during which a task's clock was paused because a transfer was waiting for an answer, between `sinceMs` and `atMs`. */
function pausedMs(db, taskId, sinceMs, atMs) {
  let total = 0
  for (const x of db.prepare('SELECT status, created_at, decided_at FROM task_transfers WHERE task_id = ?').all(taskId)) {
    const start = Math.max(Date.parse(x.created_at), sinceMs)
    const end = Math.min(x.status === 'PENDING' || !x.decided_at ? atMs : Date.parse(x.decided_at), atMs)
    if (end > start) total += end - start
  }
  return total
}

/** Event-driven alerts and notices. Registered as an event listener by the app. */
export function handleEvent(db, e) {
  const task = e.taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(e.taskId) : null
  switch (e.type) {
    case 'task.assigned':
      if (!task || e.assigneeId === e.actorId) return
      raiseAlert(db, { orgId: e.orgId, rule: 'task_assigned', userIds: [e.assigneeId], taskId: task.id, title: `New task: ${task.title}`, body: `${nameOf(db, e.actorId)} assigned you a ${task.priority ? `${task.priority.toLowerCase()} priority ` : ''}task${task.due_at ? ` due ${task.due_at.slice(0, 16).replace('T', ' ')} UTC` : ''}.`, link: taskLink(task.id), anchor: task.assigned_at })
      return
    case 'task.created_unassigned':
      return
    // ---- Slack / acceptance workflow ----
    case 'assignment.created': {
      if (!task) return
      const requester = db.prepare('SELECT sender_name FROM slack_intake_items WHERE task_id = ?').get(task.id)?.sender_name
      const who = e.via === 'slack' ? `${requester || 'Someone'} tagged ${nameOf(db, e.assigneeId)} in Slack` : e.via === 'transfer' ? `${nameOf(db, e.actorId)} handed this over` : `${nameOf(db, e.actorId)} assigned ${nameOf(db, e.assigneeId)}`
      const body = [`${who}.`, task.description ? task.description.slice(0, 280) : null, (task.priority ? `Priority: ${task.priority.toLowerCase()}.` : 'Priority: not set yet.'), task.due_at ? `Due ${dueText(task.due_at, db, task.org_id)}.` : 'No confirmed deadline yet.', 'Accept, decline or transfer it in KONVO.'].filter(Boolean).join(' ')
      raiseAlert(db, { orgId: e.orgId, rule: 'task_assignment', userIds: [e.assigneeId], taskId: task.id, title: `New task: ${task.title}`, body, link: taskLink(task.id), anchor: e.assignmentId })
      return
    }
    case 'assignment.accepted':
    case 'assignment.declined': {
      if (!task) return
      const accepted = e.type === 'assignment.accepted'
      for (const m of managersForTask(db, task).filter((id) => id !== e.actorId)) {
        notifyInApp(db, { orgId: e.orgId, userId: m, kind: accepted ? 'assignment_accepted' : 'assignment_declined', title: `${nameOf(db, e.actorId)} ${accepted ? 'accepted' : 'declined'}: ${task.title}`, body: accepted ? 'The task is now in their active work.' : `Reason: ${String(e.reason || '').slice(0, 300)}. It needs a new owner or more detail.`, link: taskLink(task.id), taskId: task.id, dedupeKey: `${e.type}:${task.id}:${task.status_changed_at}:${m}` })
      }
      return
    }
    case 'transfer.proposed': {
      if (!task) return
      notifyInApp(db, { orgId: e.orgId, userId: e.toUserId, kind: 'transfer_offered', title: `${nameOf(db, e.fromUserId)} offers you a task: ${task.title}`, body: 'Accept it to become its owner, or decline with a reason.', link: taskLink(task.id), taskId: task.id, dedupeKey: `transfer-offered:${e.transferId}` })
      for (const m of managersForTask(db, task).filter((id) => id !== e.fromUserId && id !== e.toUserId)) notifyInApp(db, { orgId: e.orgId, userId: m, kind: 'transfer_pending', title: `Transfer proposed: ${task.title}`, body: `${nameOf(db, e.fromUserId)} → ${nameOf(db, e.toUserId)}. Ownership changes only if ${nameOf(db, e.toUserId)} accepts.`, link: taskLink(task.id), taskId: task.id, dedupeKey: `transfer-pending:${e.transferId}:${m}` })
      return
    }
    case 'transfer.decided': {
      if (!task) return
      const verb = { ACCEPT: 'accepted', DECLINE: 'declined', CANCEL: 'cancelled' }[e.decision]
      const why = e.note ? ` ${String(e.note).slice(0, 300)}` : ''
      const notice = (userId, title, body) => notifyInApp(db, { orgId: e.orgId, userId, kind: `transfer_${verb}`, title, body, link: taskLink(task.id), taskId: task.id, dedupeKey: `transfer-${verb}:${e.transferId}:${userId}` })
      if (e.decision === 'CANCEL') { if (e.actorId !== e.toUserId) notice(e.toUserId, `Transfer withdrawn: ${task.title}`, 'You no longer need to answer it.') } else if (e.fromUserId !== e.actorId) notice(e.fromUserId, `Transfer ${verb}: ${task.title}`, e.decision === 'ACCEPT' ? `${nameOf(db, e.toUserId)} is now the owner.` : `${nameOf(db, e.toUserId)} declined, so it stays with you.${why}`)
      for (const m of managersForTask(db, task).filter((id) => id !== e.actorId && id !== e.fromUserId)) notice(m, `Transfer ${verb}: ${task.title}`, `${nameOf(db, e.fromUserId)} → ${nameOf(db, e.toUserId)}.${why}`)
      // A transfer is a new assignment: the new owner hears about it (LOW), and the previous owner's history stays.
      if (e.decision === 'ACCEPT' && e.assignmentId) raiseAlert(db, { orgId: e.orgId, rule: 'task_assignment', userIds: [e.toUserId], taskId: task.id, title: `Task handed to you: ${task.title}`, body: `${nameOf(db, e.fromUserId)} transferred it to you and you accepted. ${task.due_at ? `Due ${dueText(task.due_at, db, task.org_id)}.` : 'No confirmed deadline yet.'}`, link: taskLink(task.id), anchor: e.assignmentId })
      return
    }
    // ---- manager-led expectations ----
    case 'parameters.proposed': {
      if (!task) return
      const bySlack = e.source === 'SLACK_EXTRACTION'
      for (const m of managersForTask(db, task).filter((id) => id !== e.actorId || bySlack)) notifyInApp(db, { orgId: e.orgId, userId: m, kind: 'parameters_review', title: `Confirm priority and deadline: ${task.title}`, body: bySlack ? 'Taken from a Slack message. Nothing is confirmed until you confirm it.' : `${nameOf(db, e.actorId)} created this task. What they entered is a proposal until you confirm it.`, link: taskLink(task.id), taskId: task.id, dedupeKey: `params-review:${task.id}:${m}` })
      return
    }
    case 'parameters.changed': {
      if (!task || !task.assignee_id || task.assignee_id === e.actorId) return
      const names = { priority: 'priority', deadline: 'deadline', expected_outcome: 'expected outcome', complexity: 'complexity expectation', business_impact: 'business impact', dependencies: 'dependencies', success_criteria: 'success criteria', context: 'context', work_type: 'work type', response_sla: 'response target', factors: 'priority factors', verified_incident: 'incident flag' }
      const fields = (e.fields || []).filter((f) => !['factors', 'verified_incident'].includes(f))
      if (!fields.length) return
      notifyInApp(db, { orgId: e.orgId, userId: task.assignee_id, kind: 'task_expectations_changed', title: `Updated by ${nameOf(db, e.actorId)}: ${task.title}`, body: `Changed: ${fields.map((f) => names[f] || f).join(', ')}.`, link: taskLink(task.id), taskId: task.id, dedupeKey: `params-changed:${task.id}:${task.updated_at}` })
      return
    }
    case 'change_request.created': {
      if (!task) return
      const label = { DEADLINE: 'a different deadline', PRIORITY: 'a different priority', SCOPE: 'a scope change', CLARIFICATION: 'clarification' }[e.kind] || 'a change'
      for (const m of managersForTask(db, task).filter((id) => id !== e.actorId)) notifyInApp(db, { orgId: e.orgId, userId: m, kind: 'change_request', title: `${nameOf(db, e.actorId)} asks for ${label}: ${task.title}`, body: 'Approve, reject or answer it on the task. Nothing changes until you decide.', link: taskLink(task.id), taskId: task.id, dedupeKey: `change-request:${e.requestId}:${m}` })
      return
    }
    case 'change_request.decided': {
      if (!task || !e.requesterId) return
      const verb = { APPROVE: 'approved', REJECT: 'not approved', ANSWER: 'answered' }[e.decision] || 'decided'
      const note = db.prepare('SELECT decision_note FROM task_change_requests WHERE id = ?').get(e.requestId)?.decision_note
      notifyInApp(db, { orgId: e.orgId, userId: e.requesterId, kind: 'change_request_decided', title: `Your request was ${verb}: ${task.title}`, body: note ? String(note).slice(0, 400) : null, link: taskLink(task.id), taskId: task.id, dedupeKey: `change-request-decided:${e.requestId}` })
      return
    }
    case 'deadline.explanation_submitted':
    case 'deadline.explanation_context': {
      if (!task) return
      const x = db.prepare('SELECT * FROM deadline_explanations WHERE id = ?').get(e.explanationId)
      if (!x) return
      const latest = db.prepare('SELECT id FROM deadline_explanation_entries WHERE explanation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(x.id)?.id || 'first'
      for (const m of managersForTask(db, task).filter((id) => id !== e.actorId)) notifyInApp(db, { orgId: e.orgId, userId: m, kind: 'deadline_explanation', title: `${nameOf(db, x.user_id)} ${e.type.endsWith('context') ? 'added to' : 'explained'} a missed deadline: ${task.title}`, body: `Reason: ${REASONS[x.reason_category]}. Waiting for your review.`, link: taskLink(task.id), taskId: task.id, dedupeKey: `deadline-explanation:${x.id}:${latest}:${m}` })
      return
    }
    case 'deadline.explanation_reviewed': {
      if (!task) return
      const last = db.prepare(`SELECT id, body FROM deadline_explanation_entries WHERE explanation_id = ? AND kind = 'REVIEW' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(e.explanationId)
      notifyInApp(db, { orgId: e.orgId, userId: e.employeeId, kind: 'deadline_explanation_reviewed', title: `Your explanation was reviewed: ${task.title}`, body: `${String(e.status).replace(/_/g, ' ').toLowerCase()}${last?.body ? ` — ${last.body.slice(0, 300)}` : ''}`, link: taskLink(task.id), taskId: task.id, dedupeKey: `deadline-reviewed:${last?.id || e.explanationId}` })
      return
    }
    case 'blocker.reported': {
      if (!task) return
      const managers = managersForTask(db, task).filter((id) => id !== e.actorId)
      if (task.priority === 'CRITICAL') {
        raiseAlert(db, { orgId: e.orgId, rule: 'critical_blocked', userIds: [task.assignee_id, ...managers].filter((id) => id !== e.actorId), taskId: task.id, title: `Critical task blocked: ${task.title}`, body: `${nameOf(db, e.actorId)} reported a blocker.`, link: taskLink(task.id), anchor: e.blockerId })
      } else {
        for (const m of managers) notifyInApp(db, { orgId: e.orgId, userId: m, kind: 'blocker', title: `Blocked: ${task.title}`, body: `${nameOf(db, e.actorId)} reported a blocker.`, link: taskLink(task.id), taskId: task.id, dedupeKey: `blocker:${e.blockerId}:${m}` })
      }
      return
    }
    case 'blocker.escalated':
      if (!task) return
      for (const m of managersForTask(db, task).filter((id) => id !== e.actorId)) notifyInApp(db, { orgId: e.orgId, userId: m, kind: 'blocker_escalated', title: `Escalated blocker: ${task.title}`, link: taskLink(task.id), taskId: task.id, dedupeKey: `escalated:${e.blockerId}:${m}` })
      return
    case 'task.submitted':
      if (!task) return
      raiseAlert(db, { orgId: e.orgId, rule: 'submitted_for_review', userIds: managersForTask(db, task).filter((id) => id !== e.actorId), taskId: task.id, title: `Ready for review: ${task.title}`, body: `${nameOf(db, e.actorId)} submitted this task for review.`, link: taskLink(task.id), anchor: e.submissionId })
      return
    case 'task.reviewed':
      if (!task || !e.assigneeId) return
      notifyInApp(db, { orgId: e.orgId, userId: e.assigneeId, kind: 'review_decision', title: e.decision === 'APPROVED' ? `Approved: ${task.title}` : `Changes requested: ${task.title}`, link: taskLink(task.id), taskId: task.id, dedupeKey: `reviewed:${task.id}:${task.updated_at}` })
      return
    case 'task.status_changed':
      if (!task || !task.assignee_id || e.actorId === task.assignee_id) return
      if (['CANCELLED'].includes(e.to) || (e.from === 'COMPLETED' && e.to === 'IN_PROGRESS')) {
        notifyInApp(db, { orgId: e.orgId, userId: task.assignee_id, kind: 'status', title: e.to === 'CANCELLED' ? `Cancelled: ${task.title}` : `Reopened: ${task.title}`, link: taskLink(task.id), taskId: task.id, dedupeKey: `status:${task.id}:${task.status_changed_at}` })
      }
      return
    case 'request.created': {
      const r = db.prepare('SELECT * FROM task_requests WHERE id = ?').get(e.requestId)
      if (!r) return
      const managers = r.team_id ? [db.prepare('SELECT manager_id FROM teams WHERE id = ?').get(r.team_id)?.manager_id].filter(Boolean) : []
      const recipients = managers.length ? managers : db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'`).all(r.org_id).map((x) => x.user_id)
      for (const m of recipients.filter((id) => id !== r.requested_by)) {
        notifyInApp(db, { orgId: r.org_id, userId: m, kind: 'task_request', title: `${r.source === 'external' ? 'External request' : `${nameOf(db, r.requested_by)} suggested a task`}: ${r.title}`, link: '#/requests', dedupeKey: `request:${r.id}:${m}` })
      }
      return
    }
    case 'impact.submitted': {
      const r = db.prepare('SELECT * FROM impact_records WHERE id = ?').get(e.impactId)
      if (!r) return
      const m = db.prepare(`SELECT t.manager_id FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?`).get(r.user_id)?.manager_id
      if (m && m !== r.user_id) notifyInApp(db, { orgId: r.org_id, userId: m, kind: 'impact_submitted', title: `${nameOf(db, r.user_id)} recorded an outcome: ${r.title}`, link: `#/impact/${r.id}`, dedupeKey: `impact_submitted:${r.id}` })
    }
  }
}

/** The scheduled scan: time-based rules across every organization. Safe to run any number of times. */
export function scanAlerts(db, at = Date.now()) {
  let raised = 0
  const orgs = db.prepare('SELECT id FROM organizations').all()
  for (const { id: orgId } of orgs) {
    const th = orgSettings(db, orgId).alerts.thresholds
    const tasks = db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND status IN ('PENDING_ACCEPTANCE','ASSIGNED','IN_PROGRESS','BLOCKED','SUBMITTED_FOR_REVIEW')`).all(orgId)
    for (const t of tasks) {
      const d = deriveConditions(t, at)
      const due = t.due_at ? Date.parse(t.due_at) : null
      const managers = () => managersForTask(db, t)
      const accepting = t.status === 'PENDING_ACCEPTANCE'
      // While a transfer waits for an answer nobody is idle: the inactivity clocks stand still.
      const paused = Boolean(db.prepare(`SELECT 1 FROM task_transfers WHERE task_id = ? AND status = 'PENDING'`).get(t.id))
      if (d.overdue) {
        // The miss is written into the task history once per deadline, so it survives completion and a moved deadline.
        markDeadlineMissed(db, t, new Date(at).toISOString())
        raised += raiseAlert(db, { orgId, rule: 'deadline_missed', userIds: [t.assignee_id, ...managers()], taskId: t.id, title: `Deadline missed: ${t.title}`, body: `It was due ${dueText(t.due_at, db, orgId)}.${t.assignee_id ? ' The owner must say what got in the way.' : ''}`, link: taskLink(t.id), anchor: t.due_at })
        if (t.assignee_id) raised += raiseAlert(db, { orgId, rule: 'deadline_explanation_required', userIds: [t.assignee_id], taskId: t.id, title: `Explain the missed deadline: ${t.title}`, body: 'Tell your manager why it was not done by the deadline, so the delay is understood.', link: taskLink(t.id), anchor: t.due_at })
      } else if (due && t.assignee_id && ['PENDING_ACCEPTANCE', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(t.status) && due - at <= th.deadlineApproachingHours * HOUR) {
        const left = Math.max(0, due - at)
        raised += raiseAlert(db, { orgId, rule: 'deadline_approaching', userIds: [t.assignee_id, ...managers()], taskId: t.id, title: `Due soon: ${t.title}`, body: `Owner ${nameOf(db, t.assignee_id)}. Due ${dueText(t.due_at, db, orgId)}, in ${left >= HOUR ? `about ${Math.round(left / HOUR)}h` : `${Math.round(left / 60000)} min`}. Progress ${t.progress}%.${accepting ? ' Not accepted yet.' : ''}`, link: taskLink(t.id), anchor: t.due_at })
      }
      if (!accepting && !paused) {
        // The clock of work that went through acceptance starts when the owner accepted, not when it was created.
        const startedFrom = t.accepted_at || t.assigned_at
        if (t.status === 'ASSIGNED' && t.assignee_id && startedFrom && at - Date.parse(startedFrom) > th.notStartedHours * HOUR) {
          raised += raiseAlert(db, { orgId, rule: 'not_started', userIds: [t.assignee_id], taskId: t.id, title: `Not started yet: ${t.title}`, body: `Assigned over ${th.notStartedHours}h ago.`, link: taskLink(t.id), anchor: startedFrom })
        }
        const lastProgress = t.last_progress_at || t.started_at || t.status_changed_at
        if (t.status === 'IN_PROGRESS' && at - Date.parse(lastProgress) > th.noProgressHours * HOUR) {
          raised += raiseAlert(db, { orgId, rule: 'no_progress', userIds: [t.assignee_id, ...managers()], taskId: t.id, title: `No progress for ${th.noProgressHours}h: ${t.title}`, link: taskLink(t.id), anchor: lastProgress })
        }
        // MEDIUM: no meaningful movement since the owner accepted (accepting alone, views and sync never count). One alert per idle stretch.
        if (t.accepted_at && t.assignee_id && ['ASSIGNED', 'IN_PROGRESS'].includes(t.status)) {
          const base = Math.max(Date.parse(t.accepted_at), t.last_meaningful_at ? Date.parse(t.last_meaningful_at) : 0)
          const idle = at - base - pausedMs(db, t.id, base, at)
          if (idle > th.noMovementHours * HOUR) {
            raised += raiseAlert(db, { orgId, rule: 'no_movement', userIds: managers(), taskId: t.id, title: `No movement for ${Math.floor(idle / HOUR)}h: ${t.title}`,
              body: `Owner ${nameOf(db, t.assignee_id)}. Assigned ${dueText(t.assigned_at, db, orgId)}. Last meaningful activity: ${t.last_meaningful_at && Date.parse(t.last_meaningful_at) >= Date.parse(t.accepted_at) ? dueText(t.last_meaningful_at, db, orgId) : 'none since they accepted'}. Idle for ${Math.floor(idle / HOUR)}h.`, link: taskLink(t.id), anchor: new Date(base).toISOString() })
          }
        }
      }
      if (!t.assignee_id && at - Date.parse(t.created_at) > th.unassignedHours * HOUR) {
        raised += raiseAlert(db, { orgId, rule: 'unassigned', userIds: managers(), taskId: t.id, title: `Unassigned for ${th.unassignedHours}h+: ${t.title}`, link: taskLink(t.id), anchor: t.created_at })
      }
    }
    for (const b of db.prepare(`SELECT b.*, t.title, t.id AS tid FROM blockers b JOIN tasks t ON t.id = b.task_id WHERE b.org_id = ? AND b.status = 'OPEN'`).all(orgId)) {
      if (at - Date.parse(b.reported_at) > th.blockerUnresolvedHours * HOUR) {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(b.tid)
        raised += raiseAlert(db, { orgId, rule: 'blocker_unresolved', userIds: managersForTask(db, task), taskId: b.tid, title: `Blocker unresolved for ${th.blockerUnresolvedHours}h+: ${b.title}`, body: b.description, link: taskLink(b.tid), anchor: b.id })
      }
    }
  }
  return raised
}

/** How hard M91 chases each alert (it decides re-rings and phone calls, so CRITICAL is never used automatically). */
export const RULE_SEVERITY = { deadline_missed: 'CRITICAL', deadline_approaching: 'HIGH', no_movement: 'MEDIUM', task_assignment: 'LOW', deadline_explanation_required: 'LOW', critical_blocked: 'HIGH', blocker_unresolved: 'MEDIUM', no_progress: 'MEDIUM', unassigned: 'MEDIUM', not_started: 'LOW', task_assigned: 'LOW', submitted_for_review: 'LOW', evidence_attribution_review: 'MEDIUM', assessment_disputed: 'MEDIUM', evidence_attribution_note: 'LOW', impact_verification_needed: 'LOW' }
/** The escalation ladder: which rule is each M91 severity for the assignment workflow. */
export const LADDER = { LOW: 'task_assignment', MEDIUM: 'no_movement', HIGH: 'deadline_approaching', CRITICAL: 'deadline_missed' }

/** The M91 customId for a delivery: stable per condition and person, at most 200 characters. */
export const m91CustomId = (dedupeKey) => `tp-${createHash('sha256').update(String(dedupeKey)).digest('hex').slice(0, 40)}`

/** Sends queued M91 deliveries: claim → send → SENT, retry with backoff, or FAILED / SKIPPED / NOT_CONFIGURED. */
export async function processDeliveries(db, transport, { limit = 50 } = {}) {
  const due = db.prepare(`SELECT * FROM alert_deliveries WHERE status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`).all(now(), limit)
  const result = { sent: 0, failed: 0, retrying: 0, notConfigured: 0, skipped: 0 }
  for (const d of due) {
    // Atomic claim: a concurrent run cannot send the same delivery twice.
    const claimed = db.prepare(`UPDATE alert_deliveries SET status = 'SENDING', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'QUEUED'`).run(now(), d.id).changes
    if (!claimed) continue
    const n = d.notification_id ? db.prepare('SELECT * FROM notifications WHERE id = ?').get(d.notification_id) : null
    const user = d.user_id ? db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(d.user_id) : null
    try {
      // Channel mode: one alert per condition for the whole channel (the person is dropped from the key), so a
      // condition that concerns several people rings the channel once; M91 absorbs the repeats of an open customId.
      const key = transport.mode === 'channel' ? d.dedupe_key.replace(/:[^:]+$/, '') : d.dedupe_key
      const out = await transport.send({ title: n?.title || d.rule, body: n?.body || null, link: null, recipient: user, idempotencyKey: m91CustomId(key), severity: RULE_SEVERITY[d.rule] || 'MEDIUM' })
      db.prepare(`UPDATE alert_deliveries SET status = 'SENT', provider_message_id = ?, recipient = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(out?.providerMessageId ? String(out.providerMessageId).slice(0, 200) : null, user?.phone || null, now(), d.id)
      result.sent++
    } catch (error) {
      const attempts = d.attempts + 1
      const msg = String(error?.message || error).slice(0, 300)
      if (error?.notConfigured) {
        db.prepare(`UPDATE alert_deliveries SET status = 'NOT_CONFIGURED', last_error = ?, updated_at = ? WHERE id = ?`).run(msg, now(), d.id)
        result.notConfigured++
      } else if (error?.code === 'NO_PHONE') {
        db.prepare(`UPDATE alert_deliveries SET status = 'SKIPPED', last_error = ?, updated_at = ? WHERE id = ?`).run(msg, now(), d.id)
        result.skipped++
      } else if (error?.retryable === true && attempts < MAX_ATTEMPTS) {
        db.prepare(`UPDATE alert_deliveries SET status = 'QUEUED', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`).run(msg, new Date(Date.now() + backoffMs(attempts)).toISOString(), now(), d.id)
        result.retrying++
      } else {
        console.log(`[m91] delivery ${d.id} (${d.rule}) failed: ${msg}`)
        db.prepare(`UPDATE alert_deliveries SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`).run(msg, now(), d.id)
        result.failed++
      }
    }
  }
  return result
}

/**
 * Closes the M91 alerts whose condition is over: everything for a completed or cancelled task, and blocker alerts
 * once its blockers are resolved. A person is never left being rung about something already handled.
 */
export async function closeResolvedAlerts(db, transport, event) {
  if (!transport.ready || !event.taskId) return 0
  let rules = null
  if (event.type === 'blocker.resolved') rules = ['critical_blocked', 'blocker_unresolved']
  else if (event.type === 'task.reviewed' && event.decision === 'APPROVED') rules = 'all'
  else if (event.type === 'task.status_changed' && ['COMPLETED', 'CANCELLED'].includes(event.to)) rules = 'all'
  else if (event.type === 'task.assigned') rules = ['unassigned']
  // The condition behind each of these is over: real movement ends an idle stretch, a moved deadline ends the old deadline's
  // alerts (the new deadline is scanned afresh), an answered assignment is no longer news, a new owner starts a new clock.
  else if (event.type === 'task.meaningful_activity') rules = ['no_movement']
  else if (event.type === 'task.deadline_changed') rules = ['deadline_approaching', 'deadline_missed']
  else if (event.type === 'assignment.accepted' || event.type === 'assignment.declined') rules = ['task_assignment']
  else if (event.type === 'transfer.decided' && event.decision === 'ACCEPT') rules = ['no_movement', 'task_assignment']
  if (!rules) return 0
  const open = db.prepare(`SELECT * FROM alert_deliveries WHERE task_id = ? AND closed_at IS NULL AND status IN ('SENT','DELIVERED') AND provider_message_id IS NOT NULL`).all(event.taskId)
    .filter((d) => rules === 'all' || rules.includes(d.rule))
  let closed = 0
  for (const d of open) {
    try {
      await transport.close({ phone: d.recipient, alertId: d.provider_message_id })
      db.prepare('UPDATE alert_deliveries SET closed_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), d.id)
      closed++
    } catch (error) {
      console.log(`[m91] could not close alert for delivery ${d.id}: ${String(error?.message || error).slice(0, 200)}`)
    }
  }
  return closed
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * An M91 callback ("answered" or "closed"). Authenticated by M91_CALLBACK_TOKEN in the URL; stored once per
 * idempotencyKey (M91 retries). The body is only a signal: M91's callback signature cannot be verified yet, so the
 * alert is read back from M91 and only what M91 returns is recorded.
 */
export async function handleCallback(db, transport, { token, expectedToken, rawBody, idempotencyHeader }) {
  if (!expectedToken) return { status: 503, body: { error: 'callbacks_not_configured' } }
  if (!token || !safeEqual(token, expectedToken)) return { status: 401, body: { error: 'unauthorized' } }
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')
  if (raw.length > 64 * 1024) return { status: 413, body: { error: 'too_large' } }
  let payload
  try { payload = raw ? JSON.parse(raw) : {} } catch { return { status: 400, body: { error: 'invalid_json' } } }
  const keySource = payload?.idempotencyKey || idempotencyHeader
  const key = keySource ? `k:${String(keySource).slice(0, 200)}` : `b:${createHash('sha256').update(raw).digest('hex')}`
  const inserted = db.prepare(`INSERT INTO alert_callbacks (id, provider, idempotency_key, payload, received_at) VALUES (?, 'm91', ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`)
    .run(uuid(), key, raw.slice(0, 64 * 1024), now()).changes
  if (!inserted) return { status: 200, body: { ok: true, duplicate: true } }
  const alertId = typeof payload?.alert?.id === 'string' ? payload.alert.id.slice(0, 100) : null
  const d = alertId ? db.prepare(`SELECT * FROM alert_deliveries WHERE provider = 'm91' AND provider_message_id = ?`).get(alertId) : null
  if (!d) return { status: 202, body: { ok: true, matched: false } }
  db.prepare('UPDATE alert_callbacks SET delivery_id = ? WHERE idempotency_key = ?').run(d.id, key)
  let alert
  try {
    alert = await transport.getAlert(alertId, d.recipient)
  } catch (error) {
    // Not acknowledged as processed: allow M91's retry to try again.
    db.prepare('DELETE FROM alert_callbacks WHERE idempotency_key = ?').run(key)
    console.log(`[m91] could not read alert back: ${String(error?.message || error).slice(0, 200)}`)
    return { status: 503, body: { error: 'read_back_failed' } }
  }
  const responses = Array.isArray(alert?.responses) ? alert.responses : []
  const answer = alert?.decision || responses.at(-1) || null
  const ts = now()
  // Normalize labels for comparison: NFC, trim, lowercase. This handles straight vs. curly apostrophes,
  // capitalization differences, and leading/trailing whitespace from different M91 encoding paths.
  const normalizeLabel = (s) => String(s || '').normalize('NFC').trim().toLowerCase()
  transaction(db, () => {
    if (answer && !d.responded_at) {
      const note = responses.find((r) => normalizeLabel(r.label) === normalizeLabel(answer.label))?.note ?? null
      db.prepare(`UPDATE alert_deliveries SET status = 'DELIVERED', response_label = ?, response_effect = ?, response_note = ?, responded_by = ?, responded_at = ?, updated_at = ? WHERE id = ?`)
        .run(String(answer.label || '').slice(0, 100), answer.effect || null, note ? String(note).slice(0, 1000) : null, typeof answer.by === 'string' ? answer.by.slice(0, 100) : null, answer.at || ts, ts, d.id)
      const task = d.task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(d.task_id) : null
      if (task) db.prepare('INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuid(), task.org_id, task.id, d.user_id, 'alert_response', JSON.stringify({ rule: d.rule, response: [answer.label, note].filter(Boolean).join(' — ').slice(0, 500) }), ts)
    } else if (d.status === 'SENT') {
      db.prepare(`UPDATE alert_deliveries SET status = 'DELIVERED', updated_at = ? WHERE id = ?`).run(ts, d.id)
    }
    if (alert?.status && alert.status !== 'OPEN' && !d.closed_at) db.prepare('UPDATE alert_deliveries SET closed_at = ?, updated_at = ? WHERE id = ?').run(alert.resolvedAt || ts, ts, d.id)
  })
  return { status: 200, body: { ok: true, matched: true } }
}

// ---------- settings and history (admin) ----------
export function getAlertSettings(db, ctx, transport) {
  const s = orgSettings(db, ctx.orgId).alerts
  return {
    ...s,
    rules: Object.entries(ALERT_RULES).map(([key, r]) => ({ key, label: r.label, recipients: r.recipients, threshold: r.threshold, m91: Boolean(s.rules[key]?.m91) })),
    limits: THRESHOLD_LIMITS,
    m91: transport.status()
  }
}

export function updateAlertSettings(db, ctx, body, transport) {
  requireAdmin(ctx)
  const org = db.prepare('SELECT settings FROM organizations WHERE id = ?').get(ctx.orgId)
  const settings = JSON.parse(org.settings || '{}')
  const before = orgSettings(db, ctx.orgId).alerts
  const next = { ...DEFAULT_ALERT_SETTINGS, ...before, thresholds: { ...before.thresholds }, rules: { ...before.rules } }
  if (body?.m91Enabled !== undefined) next.m91Enabled = body.m91Enabled === true
  if (body?.thresholds) {
    for (const [k, [min, max]] of Object.entries(THRESHOLD_LIMITS)) {
      if (body.thresholds[k] === undefined) continue
      const n = Number(body.thresholds[k])
      if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${k} must be between ${min} and ${max} hours.`)
      next.thresholds[k] = Math.round(n * 10) / 10
    }
  }
  if (body?.rules) {
    for (const [k, r] of Object.entries(body.rules)) {
      if (!ALERT_RULES[k]) throw invalid(`Unknown alert rule ${k}.`)
      next.rules[k] = { m91: r?.m91 === true }
    }
  }
  settings.alerts = next
  db.prepare('UPDATE organizations SET settings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), now(), ctx.orgId)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'alert_settings.updated', entityType: 'organization', entityId: ctx.orgId, before, after: next })
  return getAlertSettings(db, ctx, transport)
}

export function alertHistory(db, ctx, { limit = 100 } = {}) {
  const rows = ctx.role === 'admin'
    ? db.prepare(`SELECT d.*, u.name FROM alert_deliveries d LEFT JOIN users u ON u.id = d.user_id WHERE d.org_id = ? ORDER BY d.created_at DESC LIMIT ?`).all(ctx.orgId, limit)
    : db.prepare(`SELECT d.*, u.name FROM alert_deliveries d LEFT JOIN users u ON u.id = d.user_id WHERE d.org_id = ? AND d.user_id = ? ORDER BY d.created_at DESC LIMIT ?`).all(ctx.orgId, ctx.user.id, limit)
  return rows.map((d) => ({ id: d.id, rule: d.rule, severity: RULE_SEVERITY[d.rule] || 'MEDIUM', ruleLabel: ALERT_RULES[d.rule]?.label || d.rule, recipientName: d.name, status: d.status, attempts: d.attempts, lastError: d.last_error,
    response: d.response_label ? { label: d.response_label, note: d.response_note, at: d.responded_at } : null, closedAt: d.closed_at, taskId: d.task_id, createdAt: d.created_at, updatedAt: d.updated_at }))
}

export function retryDelivery(db, ctx, id) {
  requireAdmin(ctx)
  const n = db.prepare(`UPDATE alert_deliveries SET status = 'QUEUED', next_attempt_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status IN ('FAILED','NOT_CONFIGURED')`).run(now(), now(), id, ctx.orgId).changes
  if (!n) throw invalid('Only failed or not-configured alerts can be retried.')
  return { queued: true }
}

// Alerts: rules evaluated on events and on a schedule. Every alert is an in-app notification; alerts whose rule has
// M91 turned on are also queued for M91 delivery, with retries, history and idempotent callbacks.
import { createHash, timingSafeEqual } from 'node:crypto'
import { now, transaction, uuid } from '../db.js'
import { invalid } from '../errors.js'
import { managersForTask, requireAdmin } from '../access.js'
import { deriveConditions } from './tasks.js'
import { notifyInApp } from './notify.js'
import { audit } from './audit.js'
import { orgSettings } from './orgs.js'
import { ALERT_RULES, DEFAULT_ALERT_SETTINGS, THRESHOLD_LIMITS } from './alert-rules.js'

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
      db.prepare(`INSERT INTO alert_deliveries (id, org_id, notification_id, user_id, rule, provider, recipient, status, attempts, next_attempt_at, dedupe_key, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'm91', ?, 'QUEUED', 0, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
        .run(uuid(), orgId, notificationId, userId, rule, user?.phone || user?.email || null, ts, `m91:${dedupeKey}`, ts, ts)
    }
  }
  return created
}

const taskLink = (id) => `#/tasks/${id}`
const nameOf = (db, id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone'

/** Event-driven alerts and notices. Registered as an event listener by the app. */
export function handleEvent(db, e) {
  const task = e.taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(e.taskId) : null
  switch (e.type) {
    case 'task.assigned':
      if (!task || e.assigneeId === e.actorId) return
      raiseAlert(db, { orgId: e.orgId, rule: 'task_assigned', userIds: [e.assigneeId], taskId: task.id, title: `New task: ${task.title}`, body: `${nameOf(db, e.actorId)} assigned you a ${task.priority.toLowerCase()} priority task${task.due_at ? ` due ${task.due_at.slice(0, 16).replace('T', ' ')} UTC` : ''}.`, link: taskLink(task.id), anchor: task.assigned_at })
      return
    case 'task.created_unassigned':
      return
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
    const tasks = db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND status IN ('ASSIGNED','IN_PROGRESS','BLOCKED','SUBMITTED_FOR_REVIEW')`).all(orgId)
    for (const t of tasks) {
      const d = deriveConditions(t, at)
      const due = t.due_at ? Date.parse(t.due_at) : null
      const managers = () => managersForTask(db, t)
      if (d.overdue) {
        raised += raiseAlert(db, { orgId, rule: 'deadline_missed', userIds: [t.assignee_id, ...managers()], taskId: t.id, title: `Deadline missed: ${t.title}`, body: `It was due ${t.due_at.slice(0, 16).replace('T', ' ')} UTC.`, link: taskLink(t.id), anchor: t.due_at })
      } else if (due && t.assignee_id && ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(t.status) && due - at <= th.deadlineApproachingHours * HOUR) {
        raised += raiseAlert(db, { orgId, rule: 'deadline_approaching', userIds: [t.assignee_id], taskId: t.id, title: `Due soon: ${t.title}`, body: `Due in about ${Math.max(0, Math.round((due - at) / HOUR))}h. Progress ${t.progress}%.`, link: taskLink(t.id), anchor: t.due_at })
      }
      if (t.status === 'ASSIGNED' && t.assignee_id && t.assigned_at && at - Date.parse(t.assigned_at) > th.notStartedHours * HOUR) {
        raised += raiseAlert(db, { orgId, rule: 'not_started', userIds: [t.assignee_id], taskId: t.id, title: `Not started yet: ${t.title}`, body: `Assigned over ${th.notStartedHours}h ago.`, link: taskLink(t.id), anchor: t.assigned_at })
      }
      const lastProgress = t.last_progress_at || t.started_at || t.status_changed_at
      if (t.status === 'IN_PROGRESS' && at - Date.parse(lastProgress) > th.noProgressHours * HOUR) {
        raised += raiseAlert(db, { orgId, rule: 'no_progress', userIds: [t.assignee_id, ...managers()], taskId: t.id, title: `No progress for ${th.noProgressHours}h: ${t.title}`, link: taskLink(t.id), anchor: lastProgress })
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

/** Sends queued M91 deliveries: claim → send → SENT, retry with backoff, or FAILED / NOT_CONFIGURED. */
export async function processDeliveries(db, transport, { limit = 50 } = {}) {
  const due = db.prepare(`SELECT * FROM alert_deliveries WHERE status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`).all(now(), limit)
  const result = { sent: 0, failed: 0, retrying: 0, notConfigured: 0 }
  for (const d of due) {
    // Atomic claim: a concurrent run cannot send the same delivery twice.
    const claimed = db.prepare(`UPDATE alert_deliveries SET status = 'SENDING', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'QUEUED'`).run(now(), d.id).changes
    if (!claimed) continue
    const n = d.notification_id ? db.prepare('SELECT * FROM notifications WHERE id = ?').get(d.notification_id) : null
    const user = d.user_id ? db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(d.user_id) : null
    try {
      const out = await transport.send({ title: n?.title || d.rule, body: n?.body || null, link: n?.link || null, recipient: user, idempotencyKey: d.dedupe_key })
      db.prepare(`UPDATE alert_deliveries SET status = 'SENT', provider_message_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`).run(out?.providerMessageId ? String(out.providerMessageId).slice(0, 200) : null, now(), d.id)
      result.sent++
    } catch (error) {
      const attempts = d.attempts + 1
      const msg = String(error?.message || error).slice(0, 300)
      if (error?.notConfigured) {
        db.prepare(`UPDATE alert_deliveries SET status = 'NOT_CONFIGURED', last_error = ?, updated_at = ? WHERE id = ?`).run(msg, now(), d.id)
        result.notConfigured++
      } else if (error?.retryable !== false && attempts < MAX_ATTEMPTS) {
        db.prepare(`UPDATE alert_deliveries SET status = 'QUEUED', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`).run(msg, new Date(Date.now() + backoffMs(attempts)).toISOString(), now(), d.id)
        result.retrying++
      } else {
        db.prepare(`UPDATE alert_deliveries SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`).run(msg, now(), d.id)
        result.failed++
      }
    }
  }
  return result
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * A delivery callback. Authenticated by the shared M91_CALLBACK_TOKEN; stored once per idempotency key (the
 * Idempotency-Key header or a hash of the raw body), so a provider retry never applies twice.
 */
export function handleCallback(db, transport, { token, expectedToken, rawBody, idempotencyHeader }) {
  if (!expectedToken) return { status: 503, body: { error: 'callbacks_not_configured' } }
  if (!token || !safeEqual(token, expectedToken)) return { status: 401, body: { error: 'unauthorized' } }
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')
  if (raw.length > 64 * 1024) return { status: 413, body: { error: 'too_large' } }
  let payload
  try { payload = raw ? JSON.parse(raw) : {} } catch { return { status: 400, body: { error: 'invalid_json' } } }
  const key = idempotencyHeader ? `h:${String(idempotencyHeader).slice(0, 200)}` : `b:${createHash('sha256').update(raw).digest('hex')}`
  return transaction(db, () => {
    const inserted = db.prepare(`INSERT INTO alert_callbacks (id, provider, idempotency_key, payload, received_at) VALUES (?, 'm91', ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`)
      .run(uuid(), key, raw.slice(0, 64 * 1024), now()).changes
    if (!inserted) return { status: 200, body: { ok: true, duplicate: true } }
    const parsed = transport.parseCallback(payload)
    if (!parsed?.providerMessageId) return { status: 202, body: { ok: true, matched: false } }
    const d = db.prepare(`SELECT * FROM alert_deliveries WHERE provider = 'm91' AND provider_message_id = ?`).get(String(parsed.providerMessageId))
    if (!d) return { status: 202, body: { ok: true, matched: false } }
    db.prepare('UPDATE alert_callbacks SET delivery_id = ? WHERE idempotency_key = ?').run(d.id, key)
    const status = parsed.status === 'FAILED' ? 'FAILED' : 'DELIVERED'
    // Never move a delivery backwards (e.g. a late "delivered" after a "failed" stays failed only if it really failed).
    if (d.status !== 'DELIVERED') db.prepare(`UPDATE alert_deliveries SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(status, status === 'FAILED' ? String(parsed.response || 'Provider reported failure').slice(0, 300) : null, now(), d.id)
    if (parsed.response && d.user_id && d.notification_id) {
      const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(d.notification_id)
      if (n?.task_id) {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(n.task_id)
        if (task) db.prepare('INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(uuid(), task.org_id, task.id, d.user_id, 'alert_response', JSON.stringify({ rule: d.rule, response: String(parsed.response).slice(0, 500) }), now())
      }
    }
    return { status: 200, body: { ok: true, matched: true } }
  })
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
  return rows.map((d) => ({ id: d.id, rule: d.rule, ruleLabel: ALERT_RULES[d.rule]?.label || d.rule, recipientName: d.name, status: d.status, attempts: d.attempts, lastError: d.last_error, createdAt: d.created_at, updatedAt: d.updated_at }))
}

export function retryDelivery(db, ctx, id) {
  requireAdmin(ctx)
  const n = db.prepare(`UPDATE alert_deliveries SET status = 'QUEUED', next_attempt_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status IN ('FAILED','NOT_CONFIGURED')`).run(now(), now(), id, ctx.orgId).changes
  if (!n) throw invalid('Only failed or not-configured alerts can be retried.')
  return { queued: true }
}

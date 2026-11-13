// Proactive work signals: deterministic rules over KONVO records (no AI call). Each signal has a reason, the
// records behind it, a severity, a suggested next action, a status and a history. A signal is help to act — never a
// performance penalty; blockers outside someone's control say so. Detection is idempotent (one row per condition,
// updated on every run) and a signal whose condition is gone resolves itself.
import { json, now, uuid } from '../db.js'
import { forbidden, invalid, notFound } from '../errors.js'
import { isAdmin, isManager, managersForTask, scopeUserIds } from '../access.js'
import { orgSettings } from '../services/orgs.js'
import { raiseAlert } from '../services/alerts.js'
import { audit } from '../services/audit.js'
import * as v from '../validate.js'

const HOUR = 3600000
const DAY = 24 * HOUR
const words = (t) => new Set(String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
export const SIGNAL_KINDS = {
  stalled: 'Stalled work', deadline: 'Deadline approaching', blocker: 'Unresolved blocker', rework: 'Repeated rework', unverified_impact: 'Outcome waiting for verification',
  missing_evidence: 'Completed work without evidence', duplicate_effort: 'Possible duplicate effort', unlinked_work: 'Work not linked to a task', awaiting_review: 'Waiting for a review'
}

/** Runs every rule for one organization; returns { opened, updated, resolved }. */
export function detectSignals(db, orgId) {
  const th = orgSettings(db, orgId).alerts.thresholds
  const at = Date.now()
  const found = []
  const add = (s) => found.push(s)
  const open = db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND status IN ('ASSIGNED','IN_PROGRESS','BLOCKED','SUBMITTED_FOR_REVIEW')`).all(orgId)
  for (const t of open) {
    if (t.status === 'IN_PROGRESS' && t.assignee_id) {
      const last = Date.parse(t.last_progress_at || t.started_at || t.status_changed_at)
      if (at - last > th.noProgressHours * HOUR) add({ kind: 'stalled', severity: at - last > 2 * th.noProgressHours * HOUR ? 'medium' : 'low', subject: t.assignee_id, task: t, key: `stalled:${t.id}`, audience: 'both',
        reason: `No progress update for ${Math.floor((at - last) / HOUR)} hours.`, evidence: [{ label: 'Last update', at: new Date(last).toISOString() }], action: 'Ask whether something is in the way, or post a progress note.' })
    }
    if (t.due_at && t.status !== 'SUBMITTED_FOR_REVIEW') {
      const left = Date.parse(t.due_at) - at
      if (left > 0 && left <= 48 * HOUR && t.progress < 75) add({ kind: 'deadline', severity: left <= 12 * HOUR ? 'high' : 'medium', subject: t.assignee_id, task: t, key: `deadline:${t.id}:${t.due_at}`, audience: 'both',
        reason: `Due in ${Math.max(1, Math.floor(left / HOUR))} hours at ${t.progress}% progress.`, evidence: [{ label: 'Due', at: t.due_at }], action: 'Agree on scope or a new date early, or ask for help.' })
    }
  }
  for (const b of db.prepare(`SELECT b.*, t.title, t.priority, t.assignee_id, t.org_id AS torg FROM blockers b JOIN tasks t ON t.id = b.task_id WHERE b.org_id = ? AND b.status = 'OPEN'`).all(orgId)) {
    const hours = Math.floor((at - Date.parse(b.reported_at)) / HOUR)
    if (hours < th.blockerUnresolvedHours) continue
    const outside = Boolean(b.is_external) || Boolean(b.dependency_owner_id && b.dependency_owner_id !== b.assignee_id)
    add({ kind: 'blocker', severity: b.priority === 'CRITICAL' || hours > 3 * th.blockerUnresolvedHours ? 'high' : 'medium', subject: b.assignee_id, task: { id: b.task_id, title: b.title, assignee_id: b.assignee_id, org_id: b.torg }, key: `blocker:${b.id}`, audience: 'managers', related: b.id,
      reason: `Blocked for ${hours} hours: ${String(b.description).slice(0, 160)}${outside ? ' — outside their control' : ''}.`, evidence: [{ label: 'Blocker', at: b.reported_at }], action: outside ? 'Escalate with the external party or re-plan; this is not on the person.' : 'Help remove the blocker or re-plan the task.' })
  }
  for (const r of db.prepare(`SELECT task_id, COUNT(*) AS n, MAX(created_at) AS last FROM manager_reviews WHERE org_id = ? AND subject_type = 'submission' AND decision = 'CHANGES_REQUESTED' GROUP BY task_id HAVING n >= 2`).all(orgId)) {
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND status != 'COMPLETED' AND status != 'CANCELLED'`).get(r.task_id)
    if (t) add({ kind: 'rework', severity: 'medium', subject: t.assignee_id, task: t, key: `rework:${t.id}:${r.n}`, audience: 'both',
      reason: `Changes were requested ${r.n} times.`, evidence: [{ label: 'Last review', at: r.last }], action: 'Clarify the acceptance criteria together — repeated rework usually means unclear requirements, not poor effort.' })
  }
  for (const i of db.prepare(`SELECT * FROM impact_records WHERE org_id = ? AND verification_status = 'PENDING' AND created_at < ?`).all(orgId, new Date(at - 3 * DAY).toISOString())) {
    const significant = i.value_type !== 'NONE'
    add({ kind: 'unverified_impact', severity: significant ? 'medium' : 'low', subject: i.user_id, task: i.task_id ? { id: i.task_id } : null, key: `unverified_impact:${i.id}`, audience: 'managers', related: i.id,
      reason: `“${String(i.title).slice(0, 100)}” is claimed${significant ? ` with a ${i.value_type.toLowerCase()} value (${i.measurable_value} ${i.measurement_unit})` : ''} and not verified for ${Math.floor((at - Date.parse(i.created_at)) / DAY)} days.`,
      evidence: [{ label: 'Outcome record', href: `#/impact/${i.id}` }], action: 'Verify it or say what evidence is missing.', significant })
  }
  for (const t of db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND status IN ('SUBMITTED_FOR_REVIEW','COMPLETED') AND COALESCE(completed_at, submitted_at) > ?`).all(orgId, new Date(at - 14 * DAY).toISOString())) {
    const hasEvidence = db.prepare(`SELECT 1 FROM evidence WHERE task_id = ? LIMIT 1`).get(t.id) || db.prepare(`SELECT 1 FROM evidence_task_links WHERE task_id = ? AND status != 'rejected' LIMIT 1`).get(t.id) || db.prepare(`SELECT 1 FROM impact_records WHERE task_id = ? LIMIT 1`).get(t.id)
    if (!hasEvidence && t.assignee_id) add({ kind: 'missing_evidence', severity: 'low', subject: t.assignee_id, task: t, key: `missing_evidence:${t.id}`, audience: 'person',
      reason: 'Delivered, but nothing shows the work or its result (no link, file, app evidence or outcome).', evidence: [], action: 'Add a link to the PR/document or record the outcome — it makes your contribution visible.' })
  }
  // Possible duplicate effort: two open tasks of different people with very similar titles.
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i]; const b = open[j]
      if (!a.assignee_id || !b.assignee_id || a.assignee_id === b.assignee_id) continue
      const wa = words(a.title); const wb = words(b.title)
      const shared = [...wa].filter((w) => wb.has(w)).length
      if (shared >= 3 && shared / Math.min(wa.size, wb.size) >= 0.6) {
        const ids = [a.id, b.id].sort()
        add({ kind: 'duplicate_effort', severity: 'medium', subject: null, task: a, key: `duplicate_effort:${ids.join(':')}`, audience: 'managers', related: b.id,
          reason: `“${a.title}” and “${b.title}” look like the same work for two people.`, evidence: [{ label: a.title, href: `#/tasks/${a.id}` }, { label: b.title, href: `#/tasks/${b.id}` }], action: 'Check whether they overlap; merge or split them clearly.' })
      }
    }
  }
  for (const e of db.prepare(`SELECT * FROM external_evidence WHERE org_id = ? AND status = 'active' AND kind IN ('pr_merged','release') AND actor_user_id IS NOT NULL AND occurred_at < ?
                              AND NOT EXISTS (SELECT 1 FROM evidence_task_links l WHERE l.evidence_id = external_evidence.id AND l.status != 'rejected')`).all(orgId, new Date(at - DAY).toISOString())) {
    add({ kind: 'unlinked_work', severity: 'low', subject: e.actor_user_id, task: null, key: `unlinked_work:${e.id}`, audience: 'person', related: e.id,
      reason: `${e.kind === 'pr_merged' ? 'A merged pull request' : 'A release'} (“${String(e.title).slice(0, 100)}”) is not linked to any task.`, evidence: [{ label: e.title, href: e.source_url || '#/evidence' }], action: 'Link it to the task it belongs to, so it counts as part of that work.' })
  }
  for (const a of db.prepare(`SELECT a.*, t.title FROM contribution_assessments a JOIN tasks t ON t.id = a.task_id WHERE a.org_id = ? AND a.is_current = 1 AND a.manager_status = 'PENDING' AND a.provider != 'rules' AND a.created_at < ?`).all(orgId, new Date(at - 2 * DAY).toISOString())) {
    add({ kind: 'awaiting_review', severity: a.employee_status === 'DISPUTED' ? 'high' : 'low', subject: a.user_id, task: { id: a.task_id, title: a.title }, key: `awaiting_review:${a.id}`, audience: 'managers', related: a.id,
      reason: `The analysis of “${String(a.title).slice(0, 100)}” has waited ${Math.floor((at - Date.parse(a.created_at)) / DAY)} days for your review${a.employee_status === 'DISPUTED' ? ' and the employee disputes it' : ''}.`, evidence: [{ label: 'Task', href: `#/tasks/${a.task_id}` }], action: 'Approve, adjust or dispute it.' })
  }
  for (const s of db.prepare(`SELECT s.*, t.title, t.assignee_id FROM completion_submissions s JOIN tasks t ON t.id = s.task_id WHERE s.org_id = ? AND s.status = 'PENDING' AND t.status = 'SUBMITTED_FOR_REVIEW' AND s.created_at < ?`).all(orgId, new Date(at - DAY).toISOString())) {
    add({ kind: 'awaiting_review', severity: 'medium', subject: s.assignee_id, task: { id: s.task_id, title: s.title }, key: `awaiting_review:submission:${s.id}`, audience: 'managers', related: s.id,
      reason: `“${String(s.title).slice(0, 100)}” was submitted ${Math.floor((at - Date.parse(s.created_at)) / HOUR)} hours ago and is not reviewed yet.`, evidence: [{ label: 'Task', href: `#/tasks/${s.task_id}` }], action: 'Review the submission so the work can be completed.' })
  }

  const ts = now()
  let opened = 0; let updated = 0; let resolved = 0
  const seen = new Set()
  for (const s of found) {
    seen.add(s.key)
    const row = db.prepare('SELECT * FROM work_signals WHERE dedupe_key = ?').get(s.key)
    if (!row) {
      db.prepare(`INSERT INTO work_signals (id, org_id, kind, severity, subject_user_id, task_id, related_id, reason, evidence_json, suggested_action, audience, status, dedupe_key, history_json, first_seen_at, last_seen_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`)
        .run(uuid(), orgId, s.kind, s.severity, s.subject || null, s.task?.id || null, s.related || null, s.reason, JSON.stringify(s.evidence), s.action, s.audience, s.key, JSON.stringify([{ at: ts, event: 'detected' }]), ts, ts, ts)
      opened++
      // Human interventions only: a significant unverified impact claim (M91 per the org's rule setting, off by default).
      if (s.kind === 'unverified_impact' && s.significant && s.task?.id) {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(s.task.id)
        if (task) raiseAlert(db, { orgId, rule: 'impact_verification_needed', userIds: managersForTask(db, task).filter((m) => m !== s.subject), taskId: task.id, title: 'An impact claim waits for your verification', body: s.reason, link: `#/impact/${s.related}`, anchor: s.related })
      }
    } else if (row.status === 'OPEN' || row.status === 'RESOLVED') {
      // Updated text and severity; a resolved signal whose condition is back reopens (history says so).
      const history = json(row.history_json, [])
      if (row.status === 'RESOLVED') history.push({ at: ts, event: 'reopened' })
      db.prepare(`UPDATE work_signals SET severity = ?, reason = ?, evidence_json = ?, suggested_action = ?, status = 'OPEN', resolved_at = NULL, last_seen_at = ?, history_json = ?, updated_at = ? WHERE id = ?`)
        .run(s.severity, s.reason, JSON.stringify(s.evidence), s.action, ts, JSON.stringify(history.slice(-20)), ts, row.id)
      updated++
    }
  }
  for (const row of db.prepare(`SELECT * FROM work_signals WHERE org_id = ? AND status = 'OPEN'`).all(orgId)) {
    if (seen.has(row.dedupe_key)) continue
    const history = json(row.history_json, []); history.push({ at: ts, event: 'resolved (condition no longer present)' })
    db.prepare(`UPDATE work_signals SET status = 'RESOLVED', resolved_at = ?, history_json = ?, updated_at = ? WHERE id = ?`).run(ts, JSON.stringify(history.slice(-20)), ts, row.id)
    resolved++
  }
  return { opened, updated, resolved }
}

export function detectAll(db) {
  const out = { opened: 0, updated: 0, resolved: 0 }
  for (const { id } of db.prepare('SELECT id FROM organizations').all()) {
    const r = detectSignals(db, id)
    out.opened += r.opened; out.updated += r.updated; out.resolved += r.resolved
  }
  return out
}

/** Detection on read at most every 10 minutes per organization (the scheduled job also runs it). */
function freshen(db, orgId) {
  const key = `signals_last:${orgId}`
  const last = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value
  if (last && Date.now() - Date.parse(last) < 10 * 60000) return
  detectSignals(db, orgId)
  db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, now(), now())
}

const visible = (db, ctx, s) => {
  if (s.org_id !== ctx.orgId) return false
  const mine = s.subject_user_id === ctx.user.id
  const asManager = isAdmin(ctx) || (ctx.role === 'manager' && (s.subject_user_id ? scopeUserIds(db, ctx).includes(s.subject_user_id) && s.subject_user_id !== ctx.user.id : true))
  if (s.audience === 'person') return mine
  if (s.audience === 'managers') return asManager && (s.kind !== 'duplicate_effort' || isManager(ctx))
  return mine || asManager
}

export function presentSignal(db, s) {
  const task = s.task_id ? db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(s.task_id) : null
  return {
    id: s.id, kind: s.kind, kindLabel: SIGNAL_KINDS[s.kind] || s.kind, severity: s.severity, status: s.status, reason: s.reason, action: s.suggested_action,
    evidence: json(s.evidence_json, []), task: task ? { id: task.id, title: task.title } : null,
    personId: s.subject_user_id, personName: s.subject_user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(s.subject_user_id)?.name : null,
    firstSeenAt: s.first_seen_at, lastSeenAt: s.last_seen_at, resolvedAt: s.resolved_at, history: json(s.history_json, [])
  }
}

/** scope: 'mine' (signals about my own work) | 'team' (managers: their people's). status default OPEN. */
export function listSignals(db, ctx, q = {}) {
  freshen(db, ctx.orgId)
  const scope = q.scope === 'team' ? 'team' : 'mine'
  if (scope === 'team' && !isManager(ctx)) throw forbidden('Only managers see team signals.')
  const status = q.status ? v.oneOf(q.status, 'Status', ['OPEN', 'DISMISSED', 'RESOLVED']) : 'OPEN'
  const order = { high: 0, medium: 1, low: 2 }
  return db.prepare(`SELECT * FROM work_signals WHERE org_id = ? AND status = ? ORDER BY last_seen_at DESC LIMIT 300`).all(ctx.orgId, status)
    .filter((s) => visible(db, ctx, s) && (scope === 'mine' ? s.subject_user_id === ctx.user.id : s.subject_user_id !== ctx.user.id))
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((s) => presentSignal(db, s))
}

/** Dismiss (with a reason) or mark resolved. Recorded in the signal's history and the audit log. */
export function actOnSignal(db, ctx, id, body) {
  const s = db.prepare('SELECT * FROM work_signals WHERE id = ? AND org_id = ?').get(v.id(id, 'Signal', { required: true }), ctx.orgId)
  if (!s || !visible(db, ctx, s)) throw notFound('Signal')
  const action = v.oneOf(body?.action, 'Action', ['DISMISS', 'RESOLVE'], { required: true })
  const reason = v.text(body?.reason, 'Reason', { max: 500, required: action === 'DISMISS' })
  if (s.status !== 'OPEN') throw invalid('This signal is not open.')
  const history = json(s.history_json, []); history.push({ at: now(), event: action === 'DISMISS' ? 'dismissed' : 'resolved', by: ctx.user.name, reason })
  db.prepare(`UPDATE work_signals SET status = ?, resolved_at = ?, history_json = ?, updated_at = ? WHERE id = ?`).run(action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED', now(), JSON.stringify(history.slice(-20)), now(), s.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `signal.${action.toLowerCase()}`, entityType: 'work_signal', entityId: s.id, after: { kind: s.kind, reason } })
  return presentSignal(db, db.prepare('SELECT * FROM work_signals WHERE id = ?').get(s.id))
}

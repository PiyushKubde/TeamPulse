// Ready-made TeamPulse automations. They act only through TeamPulse's own rules: notifications send messages,
// external intake creates task REQUESTS (never official tasks), and the weekly report reads the owner's own scope.
import { createHash, randomBytes } from 'node:crypto'
import { now, transaction, uuid, json } from '../db.js'
import { AppError, conflict, invalid, notFound } from '../errors.js'
import { loadContext, isManager, requireManager } from '../access.js'
import { audit } from '../services/audit.js'
import { createExternalRequest } from '../services/requests.js'
import { notifyInApp } from '../services/notify.js'
import { startOfWeek, weeklySummary, weeklyText } from '../services/reports.js'
import { requireOwnConnection } from '../integrations/connections.js'
import { sendThrough, slackChannels } from '../integrations/actions.js'
import * as v from '../validate.js'

export const USE_CASES = [
  { key: 'new_task_notification', name: 'New Task Notification', description: 'When a task is assigned in TeamPulse, notify the employee through Slack or Gmail.', channels: ['slack', 'gmail'], available: true },
  { key: 'external_request_intake', name: 'External Request → Task Request', description: 'When a configured external request arrives (for example from a Gmail, Slack or form flow you build in ViaSocket), create a TeamPulse task request for manager approval. Never assigned automatically.', channels: ['webhook'], available: true },
  { key: 'weekly_team_report', name: 'Weekly Team Report', description: 'Every Monday, generate the weekly team summary (verified outcomes, blockers, missed commitments) and deliver it through Slack or Gmail.', channels: ['slack', 'gmail'], available: true },
  { key: 'github_evidence', name: 'GitHub PR → Task Evidence', description: 'Attach merged pull requests to task evidence. Coming next: build it today in the Advanced Builder with the GitHub app.', channels: ['github'], available: false },
  { key: 'calendar_deadlines', name: 'Deadlines in Google Calendar', description: 'Create a calendar event for each task deadline. Coming next.', channels: ['google-calendar'], available: false },
  { key: 'sheets_reporting', name: 'Weekly report to Google Sheets', description: 'Append the weekly summary to a Google Sheet. Coming next.', channels: ['google-sheets'], available: false }
]

export function seedUseCases(db) {
  const ts = now()
  for (const u of USE_CASES) {
    db.prepare(`INSERT INTO automation_use_cases (key, name, description, channels, available, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description, channels = excluded.channels, available = excluded.available, updated_at = excluded.updated_at`)
      .run(u.key, u.name, u.description, JSON.stringify(u.channels), u.available ? 1 : 0, ts)
  }
}

const useCase = (key) => {
  const u = USE_CASES.find((x) => x.key === key)
  if (!u) throw notFound('Automation')
  return u
}

const workflowRow = (db, orgId, key) => db.prepare('SELECT * FROM automation_workflows WHERE org_id = ? AND use_case_key = ?').get(orgId, key)

function presentWorkflow(db, w) {
  if (!w) return null
  const cfg = json(w.config, {})
  return {
    id: w.id, status: w.status, ownerId: w.owner_id, ownerName: db.prepare('SELECT name FROM users WHERE id = ?').get(w.owner_id)?.name,
    config: { channel: cfg.channel ?? null, connectionId: cfg.connectionId ?? null, slackChannelId: cfg.slackChannelId ?? null, slackChannelLabel: cfg.slackChannelLabel ?? null, emailTo: cfg.emailTo ?? null, defaultTeamId: cfg.defaultTeamId ?? null },
    lastRunAt: w.last_run_at, lastError: w.last_error, updatedAt: w.updated_at
  }
}

export function listAutomations(db, ctx, vs) {
  const logs = (key) => db.prepare(`SELECT * FROM automation_execution_logs WHERE org_id = ? AND use_case_key = ? ORDER BY started_at DESC LIMIT 10`).all(ctx.orgId, key).map(presentLog)
  const org = db.prepare('SELECT intake_token_hash FROM organizations WHERE id = ?').get(ctx.orgId)
  return {
    viasocketConfigured: vs.configured,
    canConfigure: isManager(ctx),
    automations: USE_CASES.map((u) => ({ ...u, workflow: presentWorkflow(db, workflowRow(db, ctx.orgId, u.key)), recentRuns: isManager(ctx) ? logs(u.key) : [], ...(u.key === 'external_request_intake' ? { tokenIssued: Boolean(org.intake_token_hash) } : {}) }))
  }
}

const presentLog = (l) => ({ id: l.id, useCase: l.use_case_key, trigger: l.trigger, status: l.status, attempts: l.attempts, summary: l.summary, error: l.error, subjectType: l.subject_type, subjectId: l.subject_id, startedAt: l.started_at, finishedAt: l.finished_at })

export function executionHistory(db, ctx, { limit = 100 } = {}) {
  requireManager(ctx)
  return db.prepare('SELECT * FROM automation_execution_logs WHERE org_id = ? ORDER BY started_at DESC LIMIT ?').all(ctx.orgId, limit).map(presentLog)
}

/**
 * Configure (and optionally activate) a message-sending automation. The connection must be the configuring
 * manager's own; runs then use it. Without viaSocket configured, it is saved as NEEDS_SETUP, never as active.
 */
export async function configureAutomation(db, ctx, vs, key, body) {
  requireManager(ctx)
  const u = useCase(key)
  if (!u.available) throw conflict('This automation is not available yet. Build it in the Advanced Builder.', 'not_available')
  const existing = workflowRow(db, ctx.orgId, key)
  let cfg = {}
  if (key === 'external_request_intake') {
    const defaultTeamId = v.id(body?.defaultTeamId, 'Default team')
    if (defaultTeamId && !db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(defaultTeamId, ctx.orgId)) throw notFound('Team')
    cfg = { defaultTeamId }
  } else {
    const channel = v.oneOf(body?.channel, 'Channel', ['SLACK', 'GMAIL'], { required: true }).toLowerCase()
    const conn = requireOwnConnection(db, ctx, body?.connectionId, channel)
    cfg = { channel, connectionId: conn.id }
    if (channel === 'slack') {
      const slackChannelId = v.text(body?.slackChannelId, 'Slack channel', { required: true, max: 40 })
      if (!/^[A-Za-z0-9_-]{2,40}$/.test(slackChannelId)) throw invalid('Choose a Slack channel.')
      if (vs.configured && body?.verifyChannel !== false) {
        const channels = await slackChannels(db, vs, ctx, conn.id)
        const hit = channels.find((c) => c.value === slackChannelId)
        if (!hit) throw invalid('That Slack channel is not in your workspace’s channel list.')
        cfg.slackChannelLabel = hit.label
      } else cfg.slackChannelLabel = v.text(body?.slackChannelLabel, 'Channel name', { max: 80 })
      cfg.slackChannelId = slackChannelId
    }
    if (channel === 'gmail' && key === 'weekly_team_report') cfg.emailTo = body?.emailTo ? v.email(body.emailTo, 'Send report to') : ctx.user.email
  }
  const activate = body?.activate !== false
  const status = key !== 'external_request_intake' && !vs.configured ? 'NEEDS_SETUP' : activate ? 'ACTIVE' : 'PAUSED'
  const ts = now()
  transaction(db, () => {
    if (existing) db.prepare('UPDATE automation_workflows SET owner_id = ?, config = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(ctx.user.id, JSON.stringify(cfg), status, ts, existing.id)
    else db.prepare('INSERT INTO automation_workflows (id, org_id, use_case_key, owner_id, status, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), ctx.orgId, key, ctx.user.id, status, JSON.stringify(cfg), ts, ts)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'automation.configured', entityType: 'automation_workflow', entityId: key, before: existing ? { status: existing.status, config: json(existing.config, {}) } : null, after: { status, config: cfg } })
  })
  return presentWorkflow(db, workflowRow(db, ctx.orgId, key))
}

export function setAutomationStatus(db, ctx, vs, key, body) {
  requireManager(ctx)
  useCase(key)
  const w = workflowRow(db, ctx.orgId, key)
  if (!w) throw conflict('Set this automation up first.', 'not_configured')
  const to = v.oneOf(body?.status, 'Status', ['ACTIVE', 'PAUSED'], { required: true })
  if (to === 'ACTIVE' && key !== 'external_request_intake' && !vs.configured) throw new AppError(503, 'viasocket_not_configured', 'ViaSocket is not configured on this server, so this automation cannot run.')
  db.prepare('UPDATE automation_workflows SET status = ?, last_error = CASE WHEN ? = \'ACTIVE\' THEN NULL ELSE last_error END, updated_at = ? WHERE id = ?').run(to, to, now(), w.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `automation.${to.toLowerCase()}`, entityType: 'automation_workflow', entityId: key, before: { status: w.status }, after: { status: to } })
  return presentWorkflow(db, workflowRow(db, ctx.orgId, key))
}

// ---------- runs ----------
function startLog(db, { orgId, workflowId, key, trigger, subjectType, subjectId, dedupeKey, input }) {
  const id = uuid()
  const r = db.prepare(`INSERT INTO automation_execution_logs (id, org_id, workflow_id, use_case_key, trigger, subject_type, subject_id, status, input, dedupe_key, started_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(id, orgId, workflowId, key, trigger, subjectType, subjectId, input ? JSON.stringify(input) : null, dedupeKey, now())
  return r.changes ? id : null
}

function finishLog(db, id, w, out) {
  const ts = now()
  db.prepare('UPDATE automation_execution_logs SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?').run(out.status, out.summary ?? null, out.error ?? null, ts, id)
  if (!w) return
  if (out.status === 'SUCCEEDED') db.prepare(`UPDATE automation_workflows SET last_run_at = ?, last_error = NULL, status = CASE WHEN status = 'FAILED' THEN 'ACTIVE' ELSE status END, updated_at = ? WHERE id = ?`).run(ts, ts, w.id)
  else if (out.status === 'FAILED') {
    // Three failures in a row mark the automation FAILED so a manager sees it; it keeps its configuration.
    const lastThree = db.prepare(`SELECT status FROM automation_execution_logs WHERE workflow_id = ? AND status IN ('SUCCEEDED','FAILED') ORDER BY started_at DESC LIMIT 3`).all(w.id)
    const failed = lastThree.length === 3 && lastThree.every((r) => r.status === 'FAILED')
    db.prepare('UPDATE automation_workflows SET last_run_at = ?, last_error = ?, status = ?, updated_at = ? WHERE id = ?').run(ts, out.error ?? null, failed ? 'FAILED' : w.status, ts, w.id)
  }
}

/** Builds the owner's context; the run is skipped if the owner is no longer an active manager of this org. */
function ownerContext(db, w) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(w.owner_id)
  const ctx = user ? loadContext(db, user) : null
  if (!ctx?.membership || ctx.orgId !== w.org_id || !isManager(ctx)) return null
  return ctx
}

/** Automation 1. Called on task.assigned. Idempotent per task assignment. */
export async function runNewTaskNotification(db, vs, event, { trigger = 'event', retryOf = null } = {}) {
  const w = workflowRow(db, event.orgId, 'new_task_notification')
  if (!w || w.status === 'PAUSED' || w.status === 'NEEDS_SETUP') return null
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(event.taskId, event.orgId)
  if (!task || !task.assignee_id) return null
  const dedupeKey = retryOf ? null : `new_task_notification:${task.id}:${task.assignee_id}:${task.assigned_at}`
  const logId = retryOf || startLog(db, { orgId: event.orgId, workflowId: w.id, key: 'new_task_notification', trigger, subjectType: 'task', subjectId: task.id, dedupeKey })
  if (!logId) return null
  const owner = ownerContext(db, w)
  if (!owner) { finishLog(db, logId, w, { status: 'FAILED', error: 'The person who set up this automation is no longer an active manager. Set it up again.' }); return logId }
  const assignee = db.prepare('SELECT name, email FROM users WHERE id = ?').get(task.assignee_id)
  const cfg = json(w.config, {})
  const appUrl = event.appUrl || ''
  const text = [`${assignee.name}, you have a new ${task.priority.toLowerCase()} priority task: ${task.title}`,
    task.expected_outcome ? `Expected outcome: ${task.expected_outcome}` : null,
    task.due_at ? `Due: ${task.due_at.slice(0, 16).replace('T', ' ')} UTC` : null,
    appUrl ? `Open it: ${appUrl}/#/tasks/${task.id}` : null].filter(Boolean).join('\n')
  const out = await sendThrough(db, vs, owner, cfg, { subject: `New task: ${task.title}`, text, to: assignee.email })
  finishLog(db, logId, w, out)
  return logId
}

/** Automation 3. Weekly report for each org with the automation active (or in-app only when not set up). */
export async function runWeeklyReports(db, vs, { at = new Date(), appUrl = '' } = {}) {
  const week = startOfWeek(at)
  const weekStart = week.toISOString().slice(0, 10)
  const results = []
  for (const org of db.prepare('SELECT * FROM organizations').all()) {
    const w = workflowRow(db, org.id, 'weekly_team_report')
    // The report is generated in the scope of the automation owner, or of an admin when not set up.
    const ownerId = w?.owner_id || db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`).get(org.id)?.user_id
    if (!ownerId) continue
    const ctx = loadContext(db, db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId))
    if (!ctx?.membership || !isManager(ctx)) continue
    // Last full week: the report sent on Monday covers the week that just ended.
    const prev = new Date(week.getTime() - 7 * 86400000).toISOString().slice(0, 10)
    const summary = weeklySummary(db, ctx, { weekStart: prev })
    const inserted = db.prepare(`INSERT INTO weekly_reports (id, org_id, team_id, week_start, summary, created_at) VALUES (?, ?, '', ?, ?, ?) ON CONFLICT (org_id, team_id, week_start) DO NOTHING`)
      .run(uuid(), org.id, prev, JSON.stringify(summary), now()).changes
    if (inserted) {
      for (const m of db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND role IN ('admin','manager') AND status = 'active'`).all(org.id)) {
        notifyInApp(db, { orgId: org.id, userId: m.user_id, kind: 'weekly_report', title: `Weekly team summary ready (week of ${prev})`, link: `#/reports?type=weekly&weekStart=${prev}`, dedupeKey: `weekly:${org.id}:${prev}:${m.user_id}` })
      }
    }
    if (!w || w.status !== 'ACTIVE' && w.status !== 'FAILED') { results.push({ org: org.id, delivered: false, reason: w ? w.status : 'not set up' }); continue }
    const logId = startLog(db, { orgId: org.id, workflowId: w.id, key: 'weekly_team_report', trigger: 'schedule', subjectType: 'week', subjectId: prev, dedupeKey: `weekly_team_report:${org.id}:${prev}` })
    if (!logId) { results.push({ org: org.id, delivered: false, reason: 'already sent' }); continue }
    const owner = ownerContext(db, w)
    if (!owner) { finishLog(db, logId, w, { status: 'FAILED', error: 'The person who set up this automation is no longer an active manager.' }); continue }
    const cfg = json(w.config, {})
    const text = weeklyText(summary, org.name) + (appUrl ? `\n\nFull report: ${appUrl}/#/reports?type=weekly&weekStart=${prev}` : '')
    const out = await sendThrough(db, vs, owner, cfg, { subject: `TeamPulse weekly summary — week of ${prev}`, text, to: cfg.emailTo || owner.user.email })
    finishLog(db, logId, w, out)
    results.push({ org: org.id, delivered: out.status === 'SUCCEEDED', status: out.status })
  }
  return { weekStart, results }
}

/** Retries FAILED runs (never UNKNOWN ones: those may have been delivered). At most 3 attempts per run. */
export async function retryFailedRuns(db, vs, { appUrl = '', orgId = null, logId = null } = {}) {
  const rows = logId
    ? db.prepare(`SELECT * FROM automation_execution_logs WHERE id = ? AND org_id = ? AND status = 'FAILED'`).all(logId, orgId)
    : db.prepare(`SELECT * FROM automation_execution_logs WHERE status = 'FAILED' AND attempts < 3 AND use_case_key = 'new_task_notification' AND started_at > ?`).all(new Date(Date.now() - 86400000).toISOString())
  let retried = 0
  for (const l of rows) {
    const claimed = db.prepare(`UPDATE automation_execution_logs SET status = 'RUNNING', attempts = attempts + 1, error = NULL WHERE id = ? AND status = 'FAILED'`).run(l.id).changes
    if (!claimed) continue
    retried++
    if (l.use_case_key === 'new_task_notification') await runNewTaskNotification(db, vs, { orgId: l.org_id, taskId: l.subject_id, appUrl }, { trigger: 'retry', retryOf: l.id })
    else if (l.use_case_key === 'weekly_team_report') {
      db.prepare(`UPDATE automation_execution_logs SET status = 'FAILED', error = 'Weekly reports are retried by the next scheduled run.' WHERE id = ?`).run(l.id)
    }
  }
  return { retried }
}

// ---------- Automation 2: external requests ----------
export const hashIntakeToken = (t) => createHash('sha256').update(String(t)).digest('hex')

/** Issues (or rotates) the organization's intake token. Shown once; only its hash is stored. */
export function issueIntakeToken(db, ctx) {
  requireManager(ctx)
  const token = `tpi_${randomBytes(24).toString('base64url')}`
  db.prepare('UPDATE organizations SET intake_token_hash = ?, updated_at = ? WHERE id = ?').run(hashIntakeToken(token), now(), ctx.orgId)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'intake_token.issued', entityType: 'organization', entityId: ctx.orgId })
  // A manager's intake defaults to their own team, so the requests reach them; admins see every request anyway.
  const defaultTeamId = ctx.role === 'manager' ? ctx.managedTeamIds[0] || null : null
  const existing = workflowRow(db, ctx.orgId, 'external_request_intake')
  if (!existing) {
    db.prepare(`INSERT INTO automation_workflows (id, org_id, use_case_key, owner_id, status, config, created_at, updated_at) VALUES (?, ?, 'external_request_intake', ?, 'ACTIVE', ?, ?, ?)`)
      .run(uuid(), ctx.orgId, ctx.user.id, JSON.stringify({ defaultTeamId }), now(), now())
  } else if (!json(existing.config, {}).defaultTeamId && defaultTeamId) {
    db.prepare('UPDATE automation_workflows SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...json(existing.config, {}), defaultTeamId }), now(), existing.id)
  }
  return { token }
}

/** POST /api/inbound/task-requests: creates a PENDING task request. Never an official task, never assigned. */
export function receiveExternalRequest(db, token, body) {
  if (typeof token !== 'string' || !token.startsWith('tpi_') || token.length > 100) throw new AppError(401, 'unauthorized', 'A valid intake token is required.')
  const org = db.prepare('SELECT * FROM organizations WHERE intake_token_hash = ?').get(hashIntakeToken(token))
  if (!org) throw new AppError(401, 'unauthorized', 'A valid intake token is required.')
  const w = workflowRow(db, org.id, 'external_request_intake')
  if (!w || w.status !== 'ACTIVE') throw new AppError(409, 'automation_paused', 'This organization has paused external requests.')
  const cfg = json(w.config, {})
  const logId = startLog(db, { orgId: org.id, workflowId: w.id, key: 'external_request_intake', trigger: 'webhook', subjectType: 'task_request', subjectId: null, dedupeKey: null })
  try {
    const out = createExternalRequest(db, org.id, body, { defaultTeamId: cfg.defaultTeamId })
    db.prepare('UPDATE automation_execution_logs SET subject_id = ? WHERE id = ?').run(out.id, logId)
    finishLog(db, logId, w, { status: out.duplicate ? 'SKIPPED' : 'SUCCEEDED', summary: out.duplicate ? 'Duplicate externalRef: existing request kept.' : 'Task request created for manager approval.' })
    return out
  } catch (error) {
    finishLog(db, logId, w, { status: 'FAILED', error: String(error.message).slice(0, 300) })
    throw error
  }
}

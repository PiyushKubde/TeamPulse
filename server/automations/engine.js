// Ready-made KONVO automations. They act only through KONVO's own rules: notifications send messages,
// intake creates task REQUESTS (never official tasks), and reports read the owner's own scope.
// Every automation belongs to one person and runs only on that person's own connection.
import { createHash, randomBytes } from 'node:crypto'
import { now, transaction, uuid, json } from '../db.js'
import { AppError, conflict, invalid, notFound } from '../errors.js'
import { canManageTask, loadContext, isManager, requireManager } from '../access.js'
import { audit } from '../services/audit.js'
import { createExternalRequest } from '../services/requests.js'
import { notifyInApp } from '../services/notify.js'
import { startOfWeek, weeklySummary, weeklyText } from '../services/reports.js'
import { requireOwnConnection } from '../integrations/connections.js'
import { sendThrough, slackChannels, slackUsers } from '../integrations/actions.js'
import * as v from '../validate.js'

export const USE_CASES = [
  { key: 'new_task_notification', name: 'Team task notifications', description: 'When a task in your team is assigned: post it to a team Slack channel, message you in Slack, email you, or email the assignee — from your own Slack or Gmail. (Employees turn on their own notifications in Settings → Profile.)', channels: ['slack', 'gmail'], available: true },
  { key: 'weekly_team_report', name: 'Weekly team report', description: 'Every Monday, your team’s report for the week that ended — verified outcomes, contributions, blockers, missed commitments with reasons — delivered to Slack or Gmail. Managers get their own team; admins get the whole organization.', channels: ['slack', 'gmail'], available: true },
  { key: 'gmail_slack_intake', name: 'Gmail / Slack intake → task requests', description: 'Emails with a chosen Gmail label, or messages in a chosen Slack channel, become pending task requests for your team. Nothing is ever assigned or approved automatically.', channels: ['gmail', 'slack'], available: true },
  { key: 'context_flows', name: 'Flows built in context', description: 'Flows people build from a KONVO screen (My Tasks, Reports, Team Tasks) receive their own KONVO events.', channels: [], available: true, hidden: true },
  { key: 'external_request_intake', name: 'Any other source → task requests (web address)', description: 'Any other system or ViaSocket flow can post a request to a KONVO web address with a token. It becomes a pending task request — never assigned automatically.', channels: ['webhook'], available: true }
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

const workflowRow = (db, orgId, key, ownerId) => db.prepare('SELECT * FROM automation_workflows WHERE org_id = ? AND use_case_key = ? AND owner_id = ?').get(orgId, key, ownerId)

function presentWorkflow(db, w) {
  if (!w) return null
  const cfg = json(w.config, {})
  return {
    id: w.id, status: w.status, ownerId: w.owner_id, ownerName: db.prepare('SELECT name FROM users WHERE id = ?').get(w.owner_id)?.name,
    config: { channel: cfg.channel ?? null, connectionId: cfg.connectionId ?? null, target: cfg.target ?? null, slackChannelId: cfg.slackChannelId ?? null, slackUserId: cfg.slackUserId ?? null, slackChannelLabel: cfg.slackChannelLabel ?? null, emailTo: cfg.emailTo ?? null, defaultTeamId: cfg.defaultTeamId ?? null },
    lastRunAt: w.last_run_at, lastError: w.last_error, updatedAt: w.updated_at
  }
}

const presentLog = (l) => ({ id: l.id, useCase: l.use_case_key, trigger: l.trigger, status: l.status, attempts: l.attempts, summary: l.summary, error: l.error, subjectType: l.subject_type, subjectId: l.subject_id, startedAt: l.started_at, finishedAt: l.finished_at })

/** The current user's own automations, their recent runs, and (for admins) who else in the org has what running. */
export function listAutomations(db, ctx, vs) {
  const mineLogs = (key) => db.prepare(`SELECT l.* FROM automation_execution_logs l LEFT JOIN automation_workflows w ON w.id = l.workflow_id
                                       WHERE l.org_id = ? AND l.use_case_key = ? AND (w.owner_id = ? OR (l.workflow_id IS NULL AND ? = 1)) ORDER BY l.started_at DESC LIMIT 10`)
    .all(ctx.orgId, key, ctx.user.id, ctx.role === 'admin' ? 1 : 0).map(presentLog)
  const org = db.prepare('SELECT intake_token_hash FROM organizations WHERE id = ?').get(ctx.orgId)
  const others = ctx.role === 'admin'
    ? db.prepare(`SELECT w.use_case_key, w.status, u.name FROM automation_workflows w JOIN users u ON u.id = w.owner_id WHERE w.org_id = ? AND w.owner_id != ? ORDER BY u.name`).all(ctx.orgId, ctx.user.id)
    : []
  return {
    viasocketConfigured: vs.configured,
    canConfigure: isManager(ctx),
    automations: USE_CASES.filter((u) => !u.hidden).map((u) => ({
      ...u,
      workflow: presentWorkflow(db, workflowRow(db, ctx.orgId, u.key, ctx.user.id)),
      recentRuns: isManager(ctx) ? mineLogs(u.key) : [],
      othersRunning: others.filter((o) => o.use_case_key === u.key).map((o) => ({ name: o.name, status: o.status })),
      ...(u.key === 'external_request_intake' ? { tokenIssued: Boolean(org.intake_token_hash) } : {})
    }))
  }
}

export function executionHistory(db, ctx, { limit = 100 } = {}) {
  requireManager(ctx)
  const rows = ctx.role === 'admin'
    ? db.prepare('SELECT * FROM automation_execution_logs WHERE org_id = ? ORDER BY started_at DESC LIMIT ?').all(ctx.orgId, limit)
    : db.prepare(`SELECT l.* FROM automation_execution_logs l LEFT JOIN automation_workflows w ON w.id = l.workflow_id LEFT JOIN intake_subscriptions s ON s.id = l.subject_id
                  WHERE l.org_id = ? AND (w.owner_id = ? OR s.owner_id = ?) ORDER BY l.started_at DESC LIMIT ?`).all(ctx.orgId, ctx.user.id, ctx.user.id, limit)
  return rows.map(presentLog)
}

/**
 * Checks a delivery choice on the user's own connection: { channel, connectionId, target, slackChannelId | slackUserId, emailTo }.
 * Slack targets are checked against the live picker of that connection (never a typed id).
 */
async function readDelivery(db, vs, ctx, body, { targets, emailToAllowed = false }) {
  const channel = v.oneOf(body?.channel, 'Channel', ['SLACK', 'GMAIL'], { required: true }).toLowerCase()
  const conn = requireOwnConnection(db, ctx, body?.connectionId, channel)
  const target = v.oneOf(body?.target, 'Send to', targets[channel], { required: true }).toLowerCase()
  const cfg = { channel, connectionId: conn.id, target }
  if (channel === 'slack') {
    const isDm = target === 'me'
    const id = v.text(isDm ? body?.slackUserId : body?.slackChannelId, isDm ? 'Your Slack user' : 'Slack channel', { required: true, max: 40 })
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(id)) throw invalid(isDm ? 'Choose yourself from the list.' : 'Choose a Slack channel.')
    const list = isDm ? await slackUsers(db, vs, ctx, conn.id) : await slackChannels(db, vs, ctx, conn.id)
    const hit = list.find((o) => o.value === id)
    if (!hit) throw invalid(isDm ? 'That person is not in your Slack workspace’s list.' : 'That channel is not in your Slack workspace’s channel list.')
    if (isDm) cfg.slackUserId = id
    else cfg.slackChannelId = id
    cfg.slackChannelLabel = hit.label
  }
  if (channel === 'gmail' && emailToAllowed && target === 'recipients') cfg.emailTo = body?.emailTo ? v.email(body.emailTo, 'Send to') : ctx.user.email
  return cfg
}

/** Configure (and activate) one of the current user's automations. Without viaSocket it is saved as NEEDS_SETUP. */
export async function configureAutomation(db, ctx, vs, key, body) {
  requireManager(ctx)
  const u = useCase(key)
  if (key === 'gmail_slack_intake') throw invalid('Set up Gmail / Slack intake from its own form.')
  const existing = workflowRow(db, ctx.orgId, key, ctx.user.id)
  let cfg = {}
  if (key === 'external_request_intake') {
    const defaultTeamId = v.id(body?.defaultTeamId, 'Default team')
    if (defaultTeamId && !db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(defaultTeamId, ctx.orgId)) throw notFound('Team')
    cfg = { defaultTeamId }
  } else if (key === 'new_task_notification') {
    cfg = await readDelivery(db, vs, ctx, body, { targets: { slack: ['CHANNEL', 'ME'], gmail: ['ASSIGNEE', 'ME'] } })
  } else {
    cfg = await readDelivery(db, vs, ctx, body, { targets: { slack: ['CHANNEL', 'ME'], gmail: ['RECIPIENTS', 'ME'] }, emailToAllowed: true })
  }
  if (cfg.channel === 'slack' && cfg.slackChannelId) assertNoIntakeLoop(db, ctx.orgId, cfg.slackChannelId)
  const status = key !== 'external_request_intake' && !vs.configured ? 'NEEDS_SETUP' : body?.activate === false ? 'PAUSED' : 'ACTIVE'
  const ts = now()
  transaction(db, () => {
    if (existing) db.prepare('UPDATE automation_workflows SET config = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(JSON.stringify(cfg), status, ts, existing.id)
    else db.prepare('INSERT INTO automation_workflows (id, org_id, use_case_key, owner_id, status, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), ctx.orgId, key, ctx.user.id, status, JSON.stringify(cfg), ts, ts)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'automation.configured', entityType: 'automation_workflow', entityId: key, before: existing ? { status: existing.status, config: json(existing.config, {}) } : null, after: { status, config: cfg } })
  })
  void u
  return presentWorkflow(db, workflowRow(db, ctx.orgId, key, ctx.user.id))
}

/** A Slack channel used for outgoing KONVO posts must never be an intake channel (and vice versa): no loops. */
export function assertNoIntakeLoop(db, orgId, channelId) {
  const intake = db.prepare(`SELECT 1 FROM intake_subscriptions WHERE org_id = ? AND app = 'slack' AND status IN ('ACTIVE','PAUSED') AND input_data LIKE ?`).get(orgId, `%"${channelId}"%`)
  if (intake) throw conflict('That Slack channel is an intake channel: posting KONVO messages there would turn them into new requests. Choose another channel.', 'intake_loop')
}

export function setAutomationStatus(db, ctx, vs, key, body) {
  requireManager(ctx)
  useCase(key)
  const w = workflowRow(db, ctx.orgId, key, ctx.user.id)
  if (!w) throw conflict('Set this automation up first.', 'not_configured')
  const to = v.oneOf(body?.status, 'Status', ['ACTIVE', 'PAUSED'], { required: true })
  if (to === 'ACTIVE' && key !== 'external_request_intake' && !vs.configured) throw new AppError(503, 'viasocket_not_configured', 'ViaSocket is not configured on this server, so this automation cannot run.')
  db.prepare('UPDATE automation_workflows SET status = ?, last_error = CASE WHEN ? = \'ACTIVE\' THEN NULL ELSE last_error END, updated_at = ? WHERE id = ?').run(to, to, now(), w.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `automation.${to.toLowerCase()}`, entityType: 'automation_workflow', entityId: key, before: { status: w.status }, after: { status: to } })
  return presentWorkflow(db, workflowRow(db, ctx.orgId, key, ctx.user.id))
}

// ---------- runs ----------
export function startLog(db, { orgId, workflowId = null, key, trigger, subjectType = null, subjectId = null, dedupeKey = null, input = null }) {
  const id = uuid()
  const r = db.prepare(`INSERT INTO automation_execution_logs (id, org_id, workflow_id, use_case_key, trigger, subject_type, subject_id, status, input, dedupe_key, started_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(id, orgId, workflowId, key, trigger, subjectType, subjectId, input ? JSON.stringify(input) : null, dedupeKey, now())
  return r.changes ? id : null
}

export function finishLog(db, id, w, out) {
  const ts = now()
  db.prepare('UPDATE automation_execution_logs SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?').run(out.status, out.summary ?? null, out.error ?? null, ts, id)
  if (!w) return
  if (out.status === 'SUCCEEDED') db.prepare(`UPDATE automation_workflows SET last_run_at = ?, last_error = NULL, status = CASE WHEN status = 'FAILED' THEN 'ACTIVE' ELSE status END, updated_at = ? WHERE id = ?`).run(ts, ts, w.id)
  else if (out.status === 'FAILED') {
    // Three failures in a row mark the automation FAILED so its owner sees it; it keeps its configuration.
    const lastThree = db.prepare(`SELECT status FROM automation_execution_logs WHERE workflow_id = ? AND status IN ('SUCCEEDED','FAILED') ORDER BY started_at DESC LIMIT 3`).all(w.id)
    const failed = lastThree.length === 3 && lastThree.every((r) => r.status === 'FAILED')
    db.prepare('UPDATE automation_workflows SET last_run_at = ?, last_error = ?, status = ?, updated_at = ? WHERE id = ?').run(ts, out.error ?? null, failed ? 'FAILED' : w.status, ts, w.id)
  }
}

/** The person's own context; null when they are no longer an active member of that org (their automations stop). */
export function userContext(db, userId, orgId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  const ctx = user ? loadContext(db, user) : null
  if (!ctx?.membership || ctx.orgId !== orgId) return null
  return ctx
}

function taskMessage(db, task, appUrl, { forAssignee }) {
  const assignee = db.prepare('SELECT name, email FROM users WHERE id = ?').get(task.assignee_id)
  const lines = [forAssignee ? `${assignee.name}, you have a new ${task.priority ? `${task.priority.toLowerCase()} priority ` : ''}task: ${task.title}` : `New ${task.priority ? `${task.priority.toLowerCase()} priority ` : ''}task for ${assignee.name}: ${task.title}`,
    task.expected_outcome ? `Expected outcome: ${task.expected_outcome}` : null,
    task.due_at ? `Due: ${task.due_at.slice(0, 16).replace('T', ' ')} UTC` : null,
    appUrl ? `Open it: ${appUrl}/#/tasks/${task.id}` : null].filter(Boolean)
  return { text: lines.join('\n'), assignee }
}

/** A1: the assignee's own notification preference, on their own connection. */
async function runPersonalNotification(db, vs, task, { appUrl, retryOf = null, trigger }) {
  const pref = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ? AND org_id = ?').get(task.assignee_id, task.org_id)
  if (!pref || pref.channel === 'none' || !pref.connection_id || !json(pref.events, []).includes('task_assigned')) return null
  const logId = retryOf || startLog(db, { orgId: task.org_id, key: 'new_task_notification', trigger, subjectType: 'task', subjectId: task.id, dedupeKey: `ntn:a1:${task.id}:${task.assignee_id}:${task.assigned_at}`, input: { variant: 'personal', userId: task.assignee_id } })
  if (!logId) return null
  const ctx = userContext(db, task.assignee_id, task.org_id)
  if (!ctx) { finishLog(db, logId, null, { status: 'SKIPPED', error: 'The assignee is no longer an active member.' }); return logId }
  const { text, assignee } = taskMessage(db, task, appUrl, { forAssignee: true })
  const cfg = pref.channel === 'gmail' ? { channel: 'gmail', connectionId: pref.connection_id }
    : { channel: 'slack', connectionId: pref.connection_id, ...(pref.slack_mode === 'user' ? { slackUserId: pref.slack_target } : { slackChannelId: pref.slack_target }), slackChannelLabel: pref.slack_label }
  const out = await sendThrough(db, vs, ctx, cfg, { subject: `New task: ${task.title}`, text, to: assignee.email })
  finishLog(db, logId, null, { ...out, summary: out.summary ? `${assignee.name}’s own ${pref.channel === 'gmail' ? 'Gmail' : 'Slack'}: ${out.summary}` : undefined })
  return logId
}

/** A2: a manager's team notification, for tasks that manager manages; on the manager's own connection. */
async function runTeamNotification(db, vs, task, w, { appUrl, retryOf = null, trigger }) {
  const owner = userContext(db, w.owner_id, task.org_id)
  const logId = retryOf || startLog(db, { orgId: task.org_id, workflowId: w.id, key: 'new_task_notification', trigger, subjectType: 'task', subjectId: task.id, dedupeKey: `ntn:a2:${w.id}:${task.id}:${task.assigned_at}`, input: { variant: 'team', workflowId: w.id } })
  if (!logId) return null
  if (!owner || !isManager(owner)) { finishLog(db, logId, w, { status: 'FAILED', error: 'The person who set up this automation is no longer an active manager. Set it up again.' }); return logId }
  const cfg = json(w.config, {})
  const { text, assignee } = taskMessage(db, task, appUrl, { forAssignee: cfg.target === 'assignee' })
  const to = cfg.target === 'assignee' ? assignee.email : owner.user.email
  const out = await sendThrough(db, vs, owner, cfg, { subject: `New task: ${task.title}`, text, to })
  finishLog(db, logId, w, out)
  return logId
}

/** Automation A (A1 + A2). Called on task.assigned. Idempotent per assignment and recipient. */
export async function runNewTaskNotification(db, vs, event, { trigger = 'event' } = {}) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(event.taskId, event.orgId)
  if (!task || !task.assignee_id || !vs.configured) return []
  const ran = []
  ran.push(await runPersonalNotification(db, vs, task, { appUrl: event.appUrl, trigger }))
  const workflows = db.prepare(`SELECT * FROM automation_workflows WHERE org_id = ? AND use_case_key = 'new_task_notification' AND status IN ('ACTIVE','FAILED')`).all(task.org_id)
  for (const w of workflows) {
    const owner = userContext(db, w.owner_id, task.org_id)
    // Only the managers who manage this task hear about it (scope), and never about assigning to themselves twice.
    if (owner && !canManageTask(db, owner, task)) continue
    if (owner && json(w.config, {}).target === 'me' && task.assignee_id === w.owner_id && db.prepare(`SELECT 1 FROM notification_prefs WHERE user_id = ? AND channel != 'none'`).get(w.owner_id)) continue
    ran.push(await runTeamNotification(db, vs, task, w, { appUrl: event.appUrl, trigger }))
  }
  return ran.filter(Boolean)
}

/**
 * Automation B. One report per manager (their teams) and per admin (the whole organization), for the week that just
 * ended; the in-app notice always, Slack/Gmail when that person set it up. Each report and each delivery exists once.
 */
export async function runWeeklyReports(db, vs, { at = new Date(), appUrl = '' } = {}) {
  const prev = new Date(startOfWeek(at).getTime() - 7 * 86400000).toISOString().slice(0, 10)
  const results = []
  for (const org of db.prepare('SELECT * FROM organizations').all()) {
    const owners = db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND role IN ('admin','manager') AND status = 'active'`).all(org.id)
    for (const { user_id: ownerId } of owners) {
      const ctx = userContext(db, ownerId, org.id)
      if (!ctx || !isManager(ctx)) continue
      const summary = weeklySummary(db, ctx, { weekStart: prev })
      const scope = ctx.role === 'admin' ? 'organization' : 'team'
      const inserted = db.prepare(`INSERT INTO weekly_reports (id, org_id, team_id, week_start, summary, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, team_id, week_start) DO NOTHING`)
        .run(uuid(), org.id, `user:${ownerId}`, prev, JSON.stringify({ scope, ...summary }), now()).changes
      if (inserted) notifyInApp(db, { orgId: org.id, userId: ownerId, kind: 'weekly_report', title: `Your ${scope} report for the week of ${prev} is ready`, link: `#/reports?type=weekly&weekStart=${prev}`, dedupeKey: `weekly:${org.id}:${prev}:${ownerId}` })
      if (inserted) await dispatchContextFlows(db, vs, { orgId: org.id, userId: ownerId, context: 'weekly_report_ready', payload: { event: 'weekly_report.ready', scope, weekStart: prev, ...weeklyPayload(summary), text: weeklyText(summary, org.name), url: appUrl ? `${appUrl}/#/reports?type=weekly&weekStart=${prev}` : null } })
      const w = workflowRow(db, org.id, 'weekly_team_report', ownerId)
      if (!w || !['ACTIVE', 'FAILED'].includes(w.status) || !vs.configured) { results.push({ org: org.id, owner: ownerId, delivered: false, reason: w ? w.status : 'not set up' }); continue }
      const logId = startLog(db, { orgId: org.id, workflowId: w.id, key: 'weekly_team_report', trigger: 'schedule', subjectType: 'week', subjectId: prev, dedupeKey: `weekly_team_report:${w.id}:${prev}` })
      if (!logId) { results.push({ org: org.id, owner: ownerId, delivered: false, reason: 'already sent' }); continue }
      const cfg = json(w.config, {})
      const text = weeklyText(summary, `${org.name}${scope === 'team' ? ` — ${ctx.user.name}’s teams` : ''}`) + (appUrl ? `\n\nFull report: ${appUrl}/#/reports?type=weekly&weekStart=${prev}` : '')
      const out = await sendThrough(db, vs, ctx, cfg, { subject: `KONVO weekly summary — week of ${prev}`, text, to: cfg.target === 'recipients' ? (cfg.emailTo || ctx.user.email) : ctx.user.email })
      finishLog(db, logId, w, out)
      results.push({ org: org.id, owner: ownerId, delivered: out.status === 'SUCCEEDED', status: out.status })
    }
  }
  return { weekStart: prev, results }
}

const weeklyPayload = (s) => ({ verifiedOutcomes: s.verifiedOutcomes.length, contributions: s.significantContributions.length, unresolvedBlockers: s.unresolvedBlockers.length, missedCommitments: s.missedCommitments.length, completedTasks: s.completedTasks })

// D: flows a user built from a KONVO context receive that user's own events. Imported lazily to avoid a cycle.
async function dispatchContextFlows(db, vs, args) {
  const { dispatchContext } = await import('./context-flows.js')
  return dispatchContext(db, vs, args)
}

/** Retries FAILED notification runs (never UNKNOWN ones: those may have been delivered). At most 3 attempts. */
export async function retryFailedRuns(db, vs, { appUrl = '', orgId = null, logId = null } = {}) {
  const rows = logId
    ? db.prepare(`SELECT * FROM automation_execution_logs WHERE id = ? AND org_id = ? AND status = 'FAILED'`).all(logId, orgId)
    : db.prepare(`SELECT * FROM automation_execution_logs WHERE status = 'FAILED' AND attempts < 3 AND use_case_key = 'new_task_notification' AND started_at > ?`).all(new Date(Date.now() - 86400000).toISOString())
  let retried = 0
  for (const l of rows) {
    if (l.use_case_key !== 'new_task_notification') continue
    const claimed = db.prepare(`UPDATE automation_execution_logs SET status = 'RUNNING', attempts = attempts + 1, error = NULL WHERE id = ? AND status = 'FAILED'`).run(l.id).changes
    if (!claimed) continue
    retried++
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(l.subject_id)
    const input = json(l.input, {})
    if (!task) { finishLog(db, l.id, null, { status: 'SKIPPED', error: 'The task no longer exists.' }); continue }
    if (input.variant === 'personal') await runPersonalNotification(db, vs, task, { appUrl, retryOf: l.id, trigger: 'retry' })
    else {
      const w = db.prepare('SELECT * FROM automation_workflows WHERE id = ?').get(input.workflowId || l.workflow_id)
      if (w) await runTeamNotification(db, vs, task, w, { appUrl, retryOf: l.id, trigger: 'retry' })
      else finishLog(db, l.id, null, { status: 'SKIPPED', error: 'The automation was removed.' })
    }
  }
  return { retried }
}

// ---------- A1 settings: my notifications ----------
export function getNotificationPrefs(db, ctx) {
  const p = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(ctx.user.id)
  return { channel: p?.channel || 'none', connectionId: p?.connection_id || null, slackMode: p?.slack_mode || null, slackTarget: p?.slack_target || null, slackLabel: p?.slack_label || null, events: json(p?.events, ['task_assigned']) }
}

export async function saveNotificationPrefs(db, ctx, vs, body) {
  const channel = v.oneOf(body?.channel, 'Channel', ['NONE', 'SLACK', 'GMAIL'], { required: true }).toLowerCase()
  const row = { channel, connection_id: null, slack_mode: null, slack_target: null, slack_label: null }
  if (channel !== 'none') {
    if (!vs.configured) throw new AppError(503, 'viasocket_not_configured', 'ViaSocket is not configured on this server.')
    const cfg = await readDelivery(db, vs, ctx, { ...body, channel, target: channel === 'gmail' ? 'ME' : body?.slackMode === 'user' ? 'ME' : 'CHANNEL' }, { targets: { slack: ['CHANNEL', 'ME'], gmail: ['ME'] } })
    row.connection_id = cfg.connectionId
    if (channel === 'slack') { row.slack_mode = cfg.slackUserId ? 'user' : 'channel'; row.slack_target = cfg.slackUserId || cfg.slackChannelId; row.slack_label = cfg.slackChannelLabel }
    if (row.slack_mode === 'channel') assertNoIntakeLoop(db, ctx.orgId, row.slack_target)
  }
  db.prepare(`INSERT INTO notification_prefs (user_id, org_id, channel, connection_id, slack_mode, slack_target, slack_label, events, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id) DO UPDATE SET org_id = excluded.org_id, channel = excluded.channel, connection_id = excluded.connection_id, slack_mode = excluded.slack_mode,
              slack_target = excluded.slack_target, slack_label = excluded.slack_label, events = excluded.events, updated_at = excluded.updated_at`)
    .run(ctx.user.id, ctx.orgId, row.channel, row.connection_id, row.slack_mode, row.slack_target, row.slack_label, JSON.stringify(['task_assigned']), now())
  return getNotificationPrefs(db, ctx)
}

/** "Send me a test": one message to the user themselves, on their own connection, only when they press it. */
export async function sendTestToSelf(db, ctx, vs, body) {
  const cfg = await readDelivery(db, vs, ctx, { ...body, target: body?.channel?.toLowerCase?.() === 'gmail' ? 'ME' : body?.target || 'ME' }, { targets: { slack: ['CHANNEL', 'ME'], gmail: ['ME'] } })
  const logId = startLog(db, { orgId: ctx.orgId, key: 'new_task_notification', trigger: 'test', subjectType: 'user', subjectId: ctx.user.id, input: { variant: 'test' } })
  const out = await sendThrough(db, vs, ctx, cfg, { subject: 'KONVO test message', text: `This is a test from KONVO, sent because ${ctx.user.name} pressed “Send a test”. No action is needed.`, to: ctx.user.email })
  finishLog(db, logId, null, out)
  return out
}

// ---------- token-based intake (any other source) ----------
export const hashIntakeToken = (t) => createHash('sha256').update(String(t)).digest('hex')

/** Issues (or rotates) the organization's intake token. Shown once; only its hash is stored. */
export function issueIntakeToken(db, ctx) {
  requireManager(ctx)
  const token = `tpi_${randomBytes(24).toString('base64url')}`
  db.prepare('UPDATE organizations SET intake_token_hash = ?, updated_at = ? WHERE id = ?').run(hashIntakeToken(token), now(), ctx.orgId)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'intake_token.issued', entityType: 'organization', entityId: ctx.orgId })
  // A manager's intake defaults to their own team, so the requests reach them; admins see every request anyway.
  const defaultTeamId = ctx.role === 'manager' ? ctx.managedTeamIds[0] || null : null
  const existing = db.prepare(`SELECT * FROM automation_workflows WHERE org_id = ? AND use_case_key = 'external_request_intake' ORDER BY created_at LIMIT 1`).get(ctx.orgId)
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
  const w = db.prepare(`SELECT * FROM automation_workflows WHERE org_id = ? AND use_case_key = 'external_request_intake' ORDER BY created_at LIMIT 1`).get(org.id)
  if (!w || w.status !== 'ACTIVE') throw new AppError(409, 'automation_paused', 'This organization has paused external requests.')
  const cfg = json(w.config, {})
  const logId = startLog(db, { orgId: org.id, workflowId: w.id, key: 'external_request_intake', trigger: 'webhook', subjectType: 'task_request' })
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

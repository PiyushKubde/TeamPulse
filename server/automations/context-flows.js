// D. Selected viaSocket apps in context. From a KONVO screen a user opens the prebuilt UI restricted to the few
// apps and events that make sense there (filteredServices); the flow they publish starts from a KONVO event,
// which KONVO POSTs to that flow's own URL — only that user's own events.
// https://viasocket.com/docs/embed.md?format=sdk — sections 1, 2, 4a
import { now } from '../db.js'
import { AppError, invalid } from '../errors.js'
import { canManageTask, isManager } from '../access.js'
import { requireViasocket, viasocketError, redact } from '../integrations/errors.js'
import { startLog, finishLog, userContext } from './engine.js'

/** Each context: where it is shown, who may use it, the curated events, and a sample of what the flow receives. */
export const CONTEXTS = {
  task_assigned_to_me: {
    label: 'When a task is assigned to me', where: 'My Tasks', managersOnly: false,
    apps: { 'google-sheets': ['Add_New_Row_to_Sheet'], slack: ['Send_Message'], gmail: ['Send_Email'], 'google-calendar': ['Create_Calendar_Event'] },
    sample: { event: 'task.assigned', task: { id: 'tsk_sample', title: 'Cut checkout latency below 200ms', description: 'Profile the checkout API', expectedOutcome: 'p95 < 200ms', priority: 'HIGH', dueAt: '2026-11-20T18:00:00.000Z', assignedBy: 'Mohan Manager', url: 'https://teampulse.embarko.app/#/tasks/tsk_sample' } }
  },
  weekly_report_ready: {
    label: 'When my weekly report is ready', where: 'Reports', managersOnly: true,
    apps: { 'google-sheets': ['Add_New_Row_to_Sheet', 'Add_Multiple_Rows'], slack: ['Send_Message'], gmail: ['Send_Email'] },
    sample: { event: 'weekly_report.ready', scope: 'team', weekStart: '2026-11-02', verifiedOutcomes: 3, contributions: 5, unresolvedBlockers: 1, missedCommitments: 1, completedTasks: 7, text: 'Demo Co: Weekly team summary — week of 2026-11-02 …', url: 'https://teampulse.embarko.app/#/reports?type=weekly' }
  },
  task_completed_in_my_team: {
    label: 'When a task in my team is completed', where: 'Team Tasks', managersOnly: true,
    apps: { github: ['Create_Issue', 'Add_Comment_to_Issue'], 'google-sheets': ['Add_New_Row_to_Sheet'], slack: ['Send_Message'] },
    sample: { event: 'task.completed', task: { id: 'tsk_sample', title: 'Automate invoice reconciliation', expectedOutcome: 'Finance saves 5h/week', assignee: 'Priya Sharma', completedAt: '2026-11-09T10:00:00.000Z', url: 'https://teampulse.embarko.app/#/tasks/tsk_sample' } }
  }
}

export function requireContext(ctx, key) {
  const c = CONTEXTS[key]
  if (!c) throw invalid('Unknown automation context.')
  if (c.managersOnly && !isManager(ctx)) throw new AppError(403, 'forbidden', 'Only managers can automate this.')
  return c
}

const idCache = new Map() // app → { at, ids: { key: actionId } }
async function actionIdsFor(vs, userId, app) {
  const hit = idCache.get(app)
  if (hit && Date.now() - hit.at < 3600000) return hit.ids
  const listing = await vs.listActions(userId, app)
  const ids = Object.fromEntries((listing.actions || []).map((a) => [a.key, a.actionId]))
  idCache.set(app, { at: Date.now(), ids })
  return ids
}

/** What the browser needs to open the restricted builder for a context: the user's token and the filter. */
export async function contextEmbed(vs, ctx, key, { app } = {}) {
  requireViasocket(vs)
  const c = requireContext(ctx, key)
  const apps = app ? (c.apps[app] ? { [app]: c.apps[app] } : null) : c.apps
  if (!apps) throw invalid('That app is not offered here.')
  try {
    const filteredServices = {}
    const serviceIds = {}
    for (const [slug, keys] of Object.entries(apps)) {
      const serviceId = await vs.serviceIdFor(slug)
      const ids = await actionIdsFor(vs, ctx.user.id, slug)
      const chosen = keys.map((k) => ids[k]).filter(Boolean)
      if (!chosen.length) continue
      serviceIds[slug] = serviceId
      filteredServices[serviceId] = Object.fromEntries(chosen.map((id) => [id, true]))
    }
    return { token: await vs.token(ctx.user.id), serviceIds, filteredServices, dummyPayload: c.sample, meta: key, label: c.label }
  } catch (error) {
    throw viasocketError(error, 'open the builder')
  }
}

/** Sends one KONVO event to every active flow the user built for that context. Logged; never throws. */
export async function dispatchContext(db, vs, { orgId, userId, context, payload }) {
  if (!vs.configured) return 0
  const flows = db.prepare(`SELECT * FROM embed_flows WHERE org_id = ? AND user_id = ? AND context = ? AND status = 'active' AND webhook_url IS NOT NULL`).all(orgId, userId, context)
  let sent = 0
  for (const f of flows) {
    const logId = startLog(db, { orgId, key: 'context_flows', trigger: context, subjectType: 'flow', subjectId: f.flow_id, dedupeKey: payload?.dedupe ? `ctx:${f.flow_id}:${payload.dedupe}` : null })
    if (!logId) continue
    try {
      const res = await fetch(f.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, dedupe: undefined }), signal: AbortSignal.timeout(15000) })
      const text = await res.text().catch(() => '')
      if (res.ok) { sent++; finishLog(db, logId, null, { status: 'SUCCEEDED', summary: `Sent to your flow “${f.title || f.flow_id}”.` }) }
      else {
        finishLog(db, logId, null, { status: 'FAILED', error: `Your flow answered ${res.status}: ${redact(text).slice(0, 200)}` })
        if (/paused/i.test(text)) db.prepare(`UPDATE embed_flows SET status = 'paused', updated_at = ? WHERE user_id = ? AND flow_id = ?`).run(now(), userId, f.flow_id)
      }
    } catch (error) {
      finishLog(db, logId, null, { status: 'UNKNOWN', error: `No answer from your flow (${error.name}).` })
    }
  }
  return sent
}

/** Event listener: task assigned → the assignee's flows; task completed → the flows of managers who manage it. */
export async function onTaskEvent(db, vs, e, appUrl) {
  if (!vs.configured) return
  const task = e.taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(e.taskId) : null
  if (!task) return
  const by = e.actorId ? db.prepare('SELECT name FROM users WHERE id = ?').get(e.actorId)?.name : null
  const url = appUrl ? `${appUrl}/#/tasks/${task.id}` : null
  if (e.type === 'task.assigned' && task.assignee_id) {
    await dispatchContext(db, vs, { orgId: task.org_id, userId: task.assignee_id, context: 'task_assigned_to_me', payload: { event: 'task.assigned', dedupe: `${task.id}:${task.assigned_at}`, task: { id: task.id, title: task.title, description: task.description, expectedOutcome: task.expected_outcome, priority: task.priority, dueAt: task.due_at, assignedBy: by, url } } })
  }
  if (e.type === 'task.reviewed' && e.decision === 'APPROVED') {
    const assignee = task.assignee_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(task.assignee_id)?.name : null
    const owners = db.prepare(`SELECT DISTINCT user_id FROM embed_flows WHERE org_id = ? AND context = 'task_completed_in_my_team' AND status = 'active'`).all(task.org_id)
    for (const { user_id: uid } of owners) {
      const ctx = userContext(db, uid, task.org_id)
      if (!ctx || !isManager(ctx) || !canManageTask(db, ctx, task)) continue
      await dispatchContext(db, vs, { orgId: task.org_id, userId: uid, context: 'task_completed_in_my_team', payload: { event: 'task.completed', dedupe: `${task.id}:${task.completed_at}`, task: { id: task.id, title: task.title, expectedOutcome: task.expected_outcome, assignee, completedAt: task.completed_at, url } } })
    }
  }
}

/** The contexts this person may build from, optionally only those offering one app (for Connected Apps). */
export function listContexts(ctx, app) {
  return Object.entries(CONTEXTS)
    .filter(([, c]) => !c.managersOnly || isManager(ctx))
    .filter(([, c]) => !app || c.apps[app])
    .map(([key, c]) => ({ key, label: c.label, where: c.where, apps: Object.keys(c.apps) }))
}

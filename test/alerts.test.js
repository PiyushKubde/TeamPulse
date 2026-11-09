import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'
import { scanAlerts, processDeliveries, handleCallback } from '../server/services/alerts.js'

const H = 3600000
const iso = (ms) => new Date(ms).toISOString()

/** A stand-in M91 transport: records sends; fails on demand. */
function fakeM91({ failTimes = 0, retryable = true } = {}) {
  const m = { sent: [], fails: failTimes }
  return Object.assign(m, {
    name: 'm91', configured: true, ready: true,
    status: () => ({ state: 'ready', message: 'fake' }),
    closed: [],
    async send(msg) {
      if (m.fails > 0) { m.fails--; const e = new Error('provider 503'); e.retryable = retryable; throw e }
      m.sent.push(msg); return { providerMessageId: `msg-${m.sent.length}` }
    },
    async getAlert(id) { return { _id: id, status: 'RESOLVED', decision: { label: 'I’m on it', effect: 'SHARED', by: 'u1', at: new Date().toISOString() }, responses: [{ label: 'I’m on it', effect: 'SHARED', note: 'restarting it' }], resolvedAt: new Date().toISOString() } },
    async close(args) { m.closed.push(args); return { closed: true } }
  })
}

async function enableM91(t, s) {
  const r = await t.call('/api/alerts/settings', { method: 'PATCH', as: s.admin, body: { m91Enabled: true, thresholds: { deadlineApproachingHours: 6 } } })
  assert.equal(r.status, 200)
}

test('events raise in-app notifications; assignment, critical blocker and review submission', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Outage fix', priority: 'CRITICAL', assigneeId: s.employee.id } })
    await t.settled()
    const eve = await t.call('/api/notifications', { as: s.employee })
    assert.equal(eve.body.notifications[0].kind, 'task_assigned')
    assert.equal(eve.body.unread, 1)
    await t.call(`/api/tasks/${c.body.task.id}/blockers`, { method: 'POST', as: s.employee, body: { description: 'Need vendor fix' } })
    await t.settled()
    const mona = await t.call('/api/notifications', { as: s.manager })
    assert.ok(mona.body.notifications.some((n) => n.kind === 'critical_blocked'))
    await t.call(`/api/blockers/${t.db.prepare('SELECT id FROM blockers').get().id}/resolve`, { method: 'POST', as: s.employee, body: { resolutionNote: 'fixed' } })
    await t.call(`/api/tasks/${c.body.task.id}/submit`, { method: 'POST', as: s.employee, body: { summary: 's', outcome: 'o' } })
    await t.settled()
    assert.ok((await t.call('/api/notifications', { as: s.manager })).body.notifications.some((n) => n.kind === 'submitted_for_review'))
    // Mark all read.
    await t.call('/api/notifications/read', { method: 'POST', as: s.employee, body: { ids: 'all' } })
    assert.equal((await t.call('/api/notifications', { as: s.employee })).body.unread, 0)
    // Without M91 enabled there are no external deliveries.
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM alert_deliveries').get().n, 0)
  } finally { await t.close() }
})

test('scheduled scan: thresholds, recipients, and each alert only once', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const late = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Late', assigneeId: s.employee.id } })
    const soon = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Soon', assigneeId: s.employee.id } })
    const orphan = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Orphan' } })
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - H), late.body.task.id)
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() + 2 * H), soon.body.task.id)
    t.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(iso(Date.now() - 3 * H), orphan.body.task.id)
    t.db.prepare('UPDATE tasks SET assigned_at = ? WHERE id = ?').run(iso(Date.now() - 30 * H), soon.body.task.id)
    await t.settled()
    const first = scanAlerts(t.db)
    const kinds = t.db.prepare(`SELECT kind, user_id FROM notifications WHERE kind NOT IN ('task_assigned')`).all()
    assert.ok(kinds.some((k) => k.kind === 'deadline_missed' && k.user_id === s.employee.id))
    assert.ok(kinds.some((k) => k.kind === 'deadline_missed' && k.user_id === s.manager.id), 'missed deadline goes to the manager too')
    assert.ok(kinds.some((k) => k.kind === 'deadline_approaching' && k.user_id === s.employee.id))
    assert.ok(kinds.some((k) => k.kind === 'unassigned' && k.user_id === s.manager.id))
    assert.ok(kinds.some((k) => k.kind === 'not_started' && k.user_id === s.employee.id))
    assert.ok(first >= 5)
    assert.equal(scanAlerts(t.db), 0, 'a second run raises nothing new')
    // A changed deadline is a new condition.
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - 2 * H), late.body.task.id)
    assert.equal(scanAlerts(t.db), 2)
  } finally { await t.close() }
})

test('M91: queued per rule, retried with backoff, history kept; not-configured transport falls back to in-app', async () => {
  const m91 = fakeM91({ failTimes: 1 })
  const t = await startApp({ m91 })
  try {
    const s = seedOrg(t.db)
    await enableM91(t, s)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Ship', assigneeId: s.employee.id } })
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - H), c.body.task.id)
    await t.settled()
    scanAlerts(t.db)
    // task_assigned is in-app only by default; deadline_missed goes to M91 for assignee and manager.
    const rows = t.db.prepare('SELECT * FROM alert_deliveries').all()
    assert.deepEqual([...new Set(rows.map((r) => r.rule))], ['deadline_missed'])
    assert.equal(rows.length, 2)
    const r1 = await processDeliveries(t.db, m91)
    assert.equal(r1.retrying, 1)
    assert.equal(r1.sent, 1)
    t.db.prepare(`UPDATE alert_deliveries SET next_attempt_at = ? WHERE status = 'QUEUED'`).run(iso(Date.now() - 1000))
    const r2 = await processDeliveries(t.db, m91)
    assert.equal(r2.sent, 1)
    const hist = await t.call('/api/alerts/history', { as: s.admin })
    assert.ok(hist.body.every((d) => d.status === 'SENT'))
    assert.equal(hist.body.find((d) => d.attempts === 2).ruleLabel, 'Deadline missed')
  } finally { await t.close() }

  // The real (pending) transport: deliveries are marked NOT_CONFIGURED, in-app notifications still exist.
  const t2 = await startApp()
  try {
    const s = seedOrg(t2.db)
    await enableM91(t2, s)
    const c = await t2.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Ship', assigneeId: s.employee.id } })
    t2.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - H), c.body.task.id)
    scanAlerts(t2.db)
    const { createM91Transport } = await import('../server/integrations/m91.js')
    const out = await processDeliveries(t2.db, createM91Transport({}))
    assert.equal(out.notConfigured, 2)
    assert.equal(t2.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'deadline_missed'`).get().n, 2)
    const settings = await t2.call('/api/alerts/settings', { as: s.admin })
    assert.equal(settings.body.m91.state, 'not_configured')
    assert.equal((await t2.call('/api/alerts/settings', { method: 'PATCH', as: s.manager, body: { m91Enabled: false } })).status, 403)
    assert.equal((await t2.call('/api/alerts/settings', { method: 'PATCH', as: s.admin, body: { thresholds: { noProgressHours: 1 } } })).status, 400)
  } finally { await t2.close() }
})

test('M91 callbacks: token required, idempotent, matched to the delivery', async () => {
  const m91 = fakeM91()
  const t = await startApp({ m91, cfgOverrides: { m91: { callbackToken: 'cb-secret-123' } } })
  try {
    const s = seedOrg(t.db)
    await enableM91(t, s)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Ship', assigneeId: s.employee.id } })
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - H), c.body.task.id)
    scanAlerts(t.db)
    await processDeliveries(t.db, m91)
    const body = JSON.stringify({ event: 'answered', alert: { id: 'msg-1' }, response: { label: 'I’m on it' }, idempotencyKey: 'msg-1-r0' })
    assert.equal((await t.call('/api/webhooks/m91', { method: 'POST', raw: body, headers: { 'Content-Type': 'application/json' } })).status, 401)
    const ok = await t.call('/api/webhooks/m91?token=cb-secret-123', { method: 'POST', raw: body, headers: { 'Content-Type': 'application/json' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.matched, true)
    const dup = await t.call('/api/webhooks/m91?token=cb-secret-123', { method: 'POST', raw: body, headers: { 'Content-Type': 'application/json' } })
    assert.equal(dup.body.duplicate, true)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM alert_callbacks').get().n, 1)
    assert.equal(t.db.prepare(`SELECT status FROM alert_deliveries WHERE provider_message_id = 'msg-1'`).get().status, 'DELIVERED')
    assert.ok(t.db.prepare(`SELECT 1 FROM task_events WHERE type = 'alert_response'`).get(), 'the person’s answer is returned to the task')
    const d = t.db.prepare(`SELECT * FROM alert_deliveries WHERE provider_message_id = 'msg-1'`).get()
    assert.equal(d.response_label, 'I’m on it', 'the answer read back from M91 is recorded')
    assert.equal(d.response_note, 'restarting it')
    assert.ok(d.closed_at, 'a resolved alert is marked closed')
    const unknown = await handleCallback(t.db, m91, { token: 'cb-secret-123', expectedToken: 'cb-secret-123', rawBody: Buffer.from('{"other":1}') })
    assert.equal(unknown.body.matched, false)
  } finally { await t.close() }
})

test('scheduled routes need CRON_SECRET; a run reports what it did', async () => {
  const t = await startApp()
  try {
    seedOrg(t.db)
    assert.equal((await t.call('/tasks/alerts')).status, 401)
    assert.equal((await t.call('/tasks/alerts', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
    const r = await t.call('/tasks/alerts', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.equal(r.status, 200)
    assert.match(r.text, /Alerts raised/)
    const w = await t.call('/tasks/weekly-report', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.equal(w.status, 200)
    const w2 = await t.call('/tasks/weekly-report', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.equal(w2.status, 200)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM weekly_reports').get().n, 2, 'one per organization, not duplicated by a second run')
  } finally { await t.close() }
})

test('M91: alerts are closed when the task is completed (resolution)', async () => {
  const m91 = fakeM91()
  const t = await startApp({ m91 })
  try {
    const s = seedOrg(t.db)
    await enableM91(t, s)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Ship', assigneeId: s.employee.id } })
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - H), c.body.task.id)
    t.db.prepare(`UPDATE users SET phone = '+919876543210'`).run()
    scanAlerts(t.db)
    await processDeliveries(t.db, m91)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries WHERE status = 'SENT'`).get().n, 2)
    await t.call(`/api/tasks/${c.body.task.id}/status`, { method: 'POST', as: s.manager, body: { status: 'CANCELLED', reason: 'Descoped' } })
    await t.settled()
    assert.equal(m91.closed.length, 2)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries WHERE closed_at IS NOT NULL`).get().n, 2)
  } finally { await t.close() }
})

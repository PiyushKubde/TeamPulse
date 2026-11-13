// The M91 escalation ladder (LOW / MEDIUM / HIGH / CRITICAL) for Slack-assigned work, the clocks behind it, the
// missed-deadline explanation workflow, measurement integration, the migration on populated data and scheduler safety.
// M91 is a recording stand-in: nothing here claims live M91 delivery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../server/db.js'
import { scanAlerts, processDeliveries } from '../server/services/alerts.js'
import { runAlertJob } from '../server/app.js'
import { buildEvidencePack } from '../server/measurement/evidence-pack.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { startApp, seedOrg } from './helpers.js'
import { setup, addIntake, post, tag, taskOf, slackTask, plain, fakeM91, SLACK, H, iso } from './slack-helpers.js'

const enableM91 = async (t, s, thresholds) => assert.equal((await t.call('/api/alerts/settings', { method: 'PATCH', as: s.admin, body: { m91Enabled: true, ...(thresholds ? { thresholds } : {}) } })).status, 200)
const notes = (t, kind, userId) => plain(t.db.prepare(`SELECT * FROM notifications WHERE kind = ? ${userId ? 'AND user_id = ?' : ''} ORDER BY created_at, rowid`).all(...[kind, userId].filter(Boolean)))
const deliveries = (t, rule) => plain(t.db.prepare('SELECT * FROM alert_deliveries WHERE rule = ? ORDER BY created_at, rowid').all(rule))
const sentAs = (m91, severity) => m91.sent.filter((x) => x.severity === severity)
const setDue = (t, id, ms) => t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(ms), id)
const submitAndApprove = async (t, s, taskId) => {
  assert.equal((await t.call(`/api/tasks/${taskId}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Fixed the failing payment retries and added a regression test.', outcome: 'Payments no longer fail.' } })).status, 200)
  assert.equal((await t.call(`/api/tasks/${taskId}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED' } })).status, 200)
  await t.settled()
}

// ---------- LOW ----------
test('LOW: a Slack task raises one LOW alert for the assignee, which is retired once they answer', async () => {
  const m91 = fakeM91()
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s)
    const { taskId } = await slackTask(t, s, sub, { text: `${tag(SLACK.eve)} please investigate the payment failure issue by tomorrow` })
    const low = sentAs(m91, 'LOW')
    assert.equal(low.length, 1); assert.match(low[0].title, /^New task: Investigate the payment failure issue/)
    assert.match(low[0].body, /Dana Director tagged Eve Employee in Slack/); assert.match(low[0].body, /Due /); assert.match(low[0].body, /Priority: medium/)
    const d = deliveries(t, 'task_assignment')
    assert.equal(d.length, 1); assert.equal(d[0].task_id, taskId); assert.equal(d[0].user_id, s.employee.id); assert.equal(d[0].status, 'SENT'); assert.equal(d[0].org_id, s.org.id)
    assert.equal(notes(t, 'task_assignment', s.employee.id).length, 1, 'the in-app notification is separate from M91')
    assert.equal(sentAs(m91, 'MEDIUM').length + sentAs(m91, 'HIGH').length + sentAs(m91, 'CRITICAL').length, 0, 'assigned is not late or problematic')
    // Answering retires it.
    await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.employee }); await t.settled()
    assert.equal(m91.closed.length, 1); assert.ok(deliveries(t, 'task_assignment')[0].closed_at)
  } finally { await t.close() }
})

test('LOW: M91 failing never loses the in-app notification, and a retry does not duplicate the alert', async () => {
  const m91 = fakeM91({ failTimes: 1 })
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s)
    const { taskId } = await slackTask(t, s, sub)
    assert.equal(notes(t, 'task_assignment', s.employee.id).length, 1)
    let d = deliveries(t, 'task_assignment')
    assert.equal(d.length, 1); assert.equal(d[0].status, 'QUEUED'); assert.equal(d[0].attempts, 1); assert.match(d[0].last_error, /503/)
    t.db.prepare(`UPDATE alert_deliveries SET next_attempt_at = ? WHERE status = 'QUEUED'`).run(iso(Date.now() - 1000))
    const r = await processDeliveries(t.db, m91)
    assert.equal(r.sent, 1)
    d = deliveries(t, 'task_assignment')
    assert.equal(d.length, 1, 'still one alert'); assert.equal(d[0].status, 'SENT'); assert.equal(d[0].attempts, 2)
    assert.equal(sentAs(m91, 'LOW').length, 1, 'M91 received it once')
    assert.equal(taskOf(t, taskId).status, 'PENDING_ACCEPTANCE')
  } finally { await t.close() }
})

// ---------- MEDIUM ----------
test('MEDIUM: no meaningful movement after acceptance alerts the manager once per idle stretch and is resolved by real progress', async () => {
  const m91 = fakeM91()
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s)
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const T = Date.now()
    scanAlerts(t.db, T + 23 * H)
    assert.equal(notes(t, 'no_movement').length, 0, 'not before the 24h default')
    // Acceptance alone is not movement: 25h after accepting, the task is idle.
    scanAlerts(t.db, T + 25 * H)
    const n = notes(t, 'no_movement')
    assert.equal(n.length, 1); assert.equal(n[0].user_id, s.manager.id, 'the manager hears about it')
    assert.match(n[0].title, /^No movement for 25h: /); assert.match(n[0].body, /Owner Eve Employee/); assert.match(n[0].body, /Assigned /); assert.match(n[0].body, /none since they accepted/); assert.match(n[0].body, /Idle for 25h/)
    assert.equal(n[0].link, `#/tasks/${taskId}`)
    scanAlerts(t.db, T + 26 * H); scanAlerts(t.db, T + 30 * H)
    assert.equal(notes(t, 'no_movement').length, 1, 'the same unresolved condition does not alert again')
    await processDeliveries(t.db, m91)
    assert.equal(sentAs(m91, 'MEDIUM').length, 1)
    // Opening, commenting and an unchanged re-save are not movement.
    await t.call(`/api/tasks/${taskId}`, { as: s.employee })
    await t.call(`/api/tasks/${taskId}/comments`, { method: 'POST', as: s.employee, body: { body: 'looking at it' } })
    assert.equal(taskOf(t, taskId).last_meaningful_at, null)
    // Real progress resolves the alert (M91 closed, history kept) …
    const closedBefore = m91.closed.length // accepting already retired the LOW alert
    const p = await t.call(`/api/tasks/${taskId}/progress`, { method: 'POST', as: s.employee, body: { progress: 30, note: 'Reproduced the failure in staging' } })
    assert.equal(p.status, 200); await t.settled()
    assert.ok(taskOf(t, taskId).last_meaningful_at)
    assert.equal(m91.closed.length, closedBefore + 1); assert.ok(deliveries(t, 'no_movement')[0].closed_at); assert.equal(notes(t, 'no_movement').length, 1)
    // … and a later idle stretch is a new alert.
    scanAlerts(t.db, Date.now() + 25 * H)
    assert.equal(notes(t, 'no_movement').length, 2)
  } finally { await t.close() }
})

test('MEDIUM: what counts as movement, and what does not', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const last = () => taskOf(t, taskId).last_meaningful_at
    assert.equal(last(), null)
    // Re-saving 0% with no note does not count (nothing changed) …
    await t.call(`/api/tasks/${taskId}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    const started = last(); assert.ok(started, 'starting work is movement')
    await new Promise((r) => setTimeout(r, 5))
    await t.call(`/api/tasks/${taskId}/progress`, { method: 'POST', as: s.employee, body: { progress: 0 } })
    assert.equal(last(), started, 'an unchanged percentage with no note is not movement')
    await t.call(`/api/tasks/${taskId}/progress`, { method: 'POST', as: s.employee, body: { progress: 0, note: 'ok' } })
    assert.equal(last(), started, 'a two-letter note is not substantive')
    await new Promise((r) => setTimeout(r, 5))
    await t.call(`/api/tasks/${taskId}/progress`, { method: 'POST', as: s.employee, body: { progress: 40 } })
    const afterProgress = last(); assert.ok(afterProgress > started)
    // A manager's blocker report does not move the owner's clock; the owner's own does. Evidence by the owner does.
    await new Promise((r) => setTimeout(r, 5))
    await t.call(`/api/tasks/${taskId}/blockers`, { method: 'POST', as: s.manager, body: { description: 'Waiting on credentials from the payments vendor' } })
    assert.equal(last(), afterProgress)
    const open = (await t.call(`/api/blockers`, { as: s.manager })).body[0]
    await t.call(`/api/blockers/${open.id}/resolve`, { method: 'POST', as: s.manager, body: { resolutionNote: 'Credentials arrived' } })
    assert.equal(last(), afterProgress, 'a manager resolving it is not the owner moving')
    await new Promise((r) => setTimeout(r, 5))
    await t.call(`/api/evidence/task/${taskId}/links`, { method: 'POST', as: s.employee, body: { url: 'https://github.com/acme/shop/pull/9', label: 'Fix PR' } })
    assert.ok(last() > afterProgress, 'work evidence from the owner is movement')
    await new Promise((r) => setTimeout(r, 5))
    const before = last()
    await t.call(`/api/evidence/task/${taskId}/links`, { method: 'POST', as: s.manager, body: { url: 'https://example.com/spec', label: 'Spec' } })
    assert.equal(last(), before, 'evidence added by someone else does not move the owner’s clock')
  } finally { await t.close() }
})

test('MEDIUM: configurable threshold; pending-acceptance and declined tasks have no clock; pending transfer pauses it; a new owner starts fresh', async () => {
  const m91 = fakeM91()
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s, { noMovementHours: 48 })
    assert.equal((await t.call('/api/alerts/settings', { method: 'PATCH', as: s.admin, body: { thresholds: { noMovementHours: 0 } } })).status, 400)
    assert.equal((await t.call('/api/alerts/settings', { method: 'PATCH', as: s.manager, body: { thresholds: { noMovementHours: 12 } } })).status, 403)
    const waiting = await slackTask(t, s, sub, { text: `${tag(SLACK.ed)} please fix the signup bug` })
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const T0 = Date.parse(taskOf(t, taskId).accepted_at)
    scanAlerts(t.db, T0 + 25 * H)
    assert.equal(notes(t, 'no_movement').length, 0, 'configured to 48h')
    assert.equal(notes(t, 'no_movement').filter((x) => x.task_id === waiting.taskId).length, 0)
    scanAlerts(t.db, T0 + 200 * H)
    assert.deepEqual(notes(t, 'no_movement').map((x) => x.task_id), [taskId], 'the task nobody accepted has no inactivity clock, however long it waits')
    // A pending transfer pauses the clock: Eve offers it at +1h and Ed answers at +21h (20h paused).
    await t.call('/api/alerts/settings', { method: 'PATCH', as: s.admin, body: { thresholds: { noMovementHours: 24 } } })
    t.db.prepare('DELETE FROM notifications WHERE kind = ?').run('no_movement')
    const p = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'swap' } })
    t.db.prepare('UPDATE task_transfers SET created_at = ? WHERE id = ?').run(iso(T0 + H), p.body.transferId)
    scanAlerts(t.db, T0 + 25 * H)
    assert.equal(notes(t, 'no_movement').length, 0, 'paused while the transfer waits')
    await t.call(`/api/transfers/${p.body.transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'DECLINE', note: 'busy' } })
    t.db.prepare('UPDATE task_transfers SET decided_at = ? WHERE id = ?').run(iso(T0 + 21 * H), p.body.transferId)
    scanAlerts(t.db, T0 + 25 * H)
    assert.equal(notes(t, 'no_movement').length, 0, '25h minus 20h paused = 5h idle')
    scanAlerts(t.db, T0 + 46 * H)
    assert.match(notes(t, 'no_movement')[0].title, /^No movement for 26h/, 'the paused time is not counted against anyone')
    // A new owner starts a fresh clock even though the task is old. (The fabricated pause above lies in the future of the
    // real clock; move it into the past so it cannot overlap the new owner's clock, as a real one never would.)
    t.db.prepare('UPDATE task_transfers SET created_at = ?, decided_at = ?').run(iso(Date.now() - 200 * H), iso(Date.now() - 180 * H))
    t.db.prepare('UPDATE tasks SET accepted_at = ? WHERE id = ?').run(iso(Date.now() - 30 * H), taskId)
    t.db.prepare('DELETE FROM notifications WHERE kind = ?').run('no_movement')
    const p2 = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'really swap' } })
    await t.call(`/api/transfers/${p2.body.transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'ACCEPT' } })
    const now = Date.now()
    scanAlerts(t.db, now + 10 * H)
    assert.equal(notes(t, 'no_movement').length, 0, 'Ed’s clock began when he accepted')
    scanAlerts(t.db, now + 25 * H)
    const n = notes(t, 'no_movement')
    assert.equal(n.length, 1); assert.match(n[0].body, /Owner Ed Employee/)
  } finally { await t.close() }
})

// ---------- HIGH ----------
test('HIGH: deadline approaching alerts owner and manager once; short deadlines alert early; moving the deadline resets; completing resolves', async () => {
  const m91 = fakeM91()
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s)
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    setDue(t, taskId, Date.now() + 10 * H)
    scanAlerts(t.db)
    assert.deepEqual(notes(t, 'deadline_approaching').map((n) => n.user_id).sort(), [s.employee.id, s.manager.id].sort())
    await processDeliveries(t.db, m91)
    const high = sentAs(m91, 'HIGH'); assert.equal(high.length, 2)
    assert.match(high[0].title, /^Due soon: /); assert.match(high[0].body, /Owner Eve Employee/); assert.match(high[0].body, /\(UTC\)/); assert.match(high[0].body, /in about 10h/)
    scanAlerts(t.db); scanAlerts(t.db, Date.now() + H)
    assert.equal(notes(t, 'deadline_approaching').length, 2, 'not repeated on every scheduler run')
    // A task given a short deadline is warned at once, not after it has passed.
    const short = await slackTask(t, s, sub, { accept: true })
    setDue(t, short.taskId, Date.now() + 2 * H)
    scanAlerts(t.db)
    assert.ok(notes(t, 'deadline_approaching').some((n) => n.task_id === short.taskId))
    assert.equal(notes(t, 'deadline_missed').length, 0)
    // The manager moves the deadline: the old alerts close, the new deadline is scanned afresh.
    const closedBefore = m91.closed.length
    assert.equal((await t.call(`/api/tasks/${taskId}`, { method: 'PATCH', as: s.manager, body: { dueAt: iso(Date.now() + 60 * H), reason: 'Scope changed' } })).status, 200)
    await t.settled()
    assert.ok(m91.closed.length > closedBefore, 'M91 alerts for the old deadline were closed')
    const before = notes(t, 'deadline_approaching').length
    scanAlerts(t.db); assert.equal(notes(t, 'deadline_approaching').length, before, 'far away again: nothing new')
    scanAlerts(t.db, Date.now() + 50 * H)
    assert.equal(notes(t, 'deadline_approaching').length, before + 2, 'the new deadline is its own condition')
    // Completing before the deadline resolves what is open.
    await processDeliveries(t.db, m91)
    const open = () => t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries WHERE task_id = ? AND closed_at IS NULL AND status = 'SENT'`).get(short.taskId).n
    assert.ok(open() > 0)
    assert.equal((await t.call(`/api/tasks/${short.taskId}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Done early with a regression test.', outcome: 'Fixed.' } })).status, 200)
    assert.equal((await t.call(`/api/tasks/${short.taskId}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED' } })).status, 200)
    await t.settled()
    assert.equal(open(), 0)
  } finally { await t.close() }
})

test('HIGH: the warning window is configurable; a date without a time ends the day in the organization timezone', async () => {
  const { t, s, sub } = await setup()
  try {
    await enableM91(t, s, { deadlineApproachingHours: 6 })
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    setDue(t, taskId, Date.now() + 10 * H)
    scanAlerts(t.db); assert.equal(notes(t, 'deadline_approaching').length, 0, '10h away is outside a 6h window')
    scanAlerts(t.db, Date.now() + 5 * H); assert.equal(notes(t, 'deadline_approaching').length, 2)
    // Defaults: 24h before the deadline, 24h of no movement.
    const set = (await t.call('/api/alerts/settings', { as: s.admin })).body
    assert.equal(set.thresholds.noMovementHours, 24)
    assert.equal(set.rules.find((r) => r.key === 'no_movement').threshold, 'noMovementHours')
    // Timezone: a date alone means 23:59 where the organization is.
    assert.equal((await t.call('/api/organization', { method: 'PATCH', as: s.admin, body: { name: 'Acme', timezone: 'Not/AZone' } })).status, 400)
    assert.equal((await t.call('/api/organization', { method: 'PATCH', as: s.manager, body: { name: 'Acme', timezone: 'Asia/Kolkata' } })).status, 403)
    assert.equal((await t.call('/api/organization', { method: 'PATCH', as: s.admin, body: { name: 'Acme', timezone: 'Asia/Kolkata' } })).body.timezone, 'Asia/Kolkata')
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Quarterly close', assigneeId: s.employee.id, dueAt: '2026-11-20' } })
    assert.equal(c.body.task.dueAt, '2026-11-20T18:29:00.000Z')
    await t.call('/api/organization', { method: 'PATCH', as: s.admin, body: { name: 'Acme', timezone: 'America/New_York' } })
    const d = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Annual audit', assigneeId: s.employee.id, dueAt: '2026-07-01' } })
    assert.equal(d.body.task.dueAt, '2026-07-02T03:59:00.000Z', 'daylight saving is applied (EDT, UTC-4)')
  } finally { await t.close() }
})

// ---------- CRITICAL and missed deadlines ----------
test('CRITICAL: a missed deadline alerts once, is written into the history, and the owner is asked to explain', async () => {
  const m91 = fakeM91()
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s)
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const due = Date.now() - H
    setDue(t, taskId, due)
    const raised = scanAlerts(t.db)
    assert.deepEqual(notes(t, 'deadline_missed').map((n) => n.user_id).sort(), [s.employee.id, s.manager.id].sort())
    assert.equal(notes(t, 'deadline_explanation_required', s.employee.id).length, 1)
    assert.ok(raised >= 3)
    await processDeliveries(t.db, m91)
    const crit = sentAs(m91, 'CRITICAL'); assert.equal(crit.length, 2); assert.match(crit[0].body, /It was due /); assert.match(crit[0].body, /must say what got in the way/)
    // Not repeated, however long it stays overdue.
    assert.equal(scanAlerts(t.db), 0); assert.equal(scanAlerts(t.db, Date.now() + H), 0)
    const missed = () => plain(t.db.prepare(`SELECT data FROM task_events WHERE task_id = ? AND type = 'deadline_missed'`).all(taskId))
    assert.equal(missed().length, 1); assert.equal(JSON.parse(missed()[0].data).dueAt, iso(due))
    // The condition stays visible: the task is overdue and the explanation is still required.
    const w = (await t.call(`/api/tasks/${taskId}/workflow`, { as: s.employee })).body.deadline
    assert.deepEqual(w.explanationRequired, [iso(due)]); assert.equal(w.missed[0].explained, false)
    assert.equal((await t.call(`/api/tasks/${taskId}`, { as: s.employee })).body.task.overdue, true)
    // A moved deadline keeps the old miss; missing the new one is a new, second record and alert.
    await t.call(`/api/tasks/${taskId}`, { method: 'PATCH', as: s.manager, body: { dueAt: iso(Date.now() + 48 * H), reason: 'Customer agreed' } })
    await t.settled()
    assert.equal(missed().length, 1, 'history of the first miss is kept')
    assert.equal((await t.call(`/api/tasks/${taskId}`, { as: s.employee })).body.task.overdue, false)
    setDue(t, taskId, Date.now() - 2 * H)
    scanAlerts(t.db)
    assert.equal(missed().length, 2); assert.equal(notes(t, 'deadline_missed').length, 4)
    // Completing late does not erase the miss.
    await submitAndApprove(t, s, taskId)
    assert.equal(missed().length, 2)
    assert.equal(taskOf(t, taskId).status, 'COMPLETED')
    assert.deepEqual((await t.call(`/api/tasks/${taskId}/workflow`, { as: s.employee })).body.deadline.missed.length, 2)
  } finally { await t.close() }
})

test('CRITICAL: M91 failing is retried without duplicating the alert, and the in-app notifications stand alone', async () => {
  const m91 = fakeM91()
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s)
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    m91.fails = 2 // M91 goes down now, after the assignment traffic
    setDue(t, taskId, Date.now() - H)
    scanAlerts(t.db)
    const r1 = await processDeliveries(t.db, m91)
    assert.equal(r1.retrying, 2); assert.equal(r1.sent, 0)
    assert.equal(notes(t, 'deadline_missed').length, 2, 'in-app notifications do not depend on M91')
    assert.equal(deliveries(t, 'deadline_missed').length, 2)
    t.db.prepare(`UPDATE alert_deliveries SET next_attempt_at = ? WHERE status = 'QUEUED'`).run(iso(Date.now() - 1000))
    const r2 = await processDeliveries(t.db, m91)
    assert.equal(r2.sent, 2)
    scanAlerts(t.db, Date.now() + 5 * H)
    await processDeliveries(t.db, m91)
    assert.equal(sentAs(m91, 'CRITICAL').length, 2, 'two people, one alert each, never more')
    assert.equal(deliveries(t, 'deadline_missed').length, 2)
  } finally { await t.close() }
})

test('missed-deadline explanation: required, validated, stored once, reviewed by a manager, never overwritten', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const submit = (body, as = s.employee) => t.call(`/api/tasks/${taskId}/deadline-explanation`, { method: 'POST', as, body })
    assert.equal((await submit({ reasonCategory: 'DEPENDENCY' })).body.error.code, 'no_missed_deadline', 'nothing to explain before the deadline passes')
    const due = Date.now() - 3 * H
    setDue(t, taskId, due); scanAlerts(t.db); await t.settled()
    assert.deepEqual((await t.call(`/api/tasks/${taskId}/workflow`, { as: s.manager })).body.deadline.explanationRequired, [], 'the manager is not the one asked')
    assert.equal((await submit({})).status, 400, 'a reason is required')
    assert.equal((await submit({ reasonCategory: 'LAZY' })).status, 400)
    assert.equal((await submit({ reasonCategory: 'OTHER' })).status, 400, 'Other needs a written explanation')
    assert.equal((await submit({ reasonCategory: 'OTHER', explanation: 'too short' })).status, 400)
    assert.equal((await submit({ reasonCategory: 'DEPENDENCY', evidenceLinks: [{ url: 'javascript:alert(1)' }] })).status, 400, 'links are http(s) only')
    assert.equal((await submit({ reasonCategory: 'DEPENDENCY' }, s.manager)).status, 403, 'only the person responsible explains')
    assert.equal((await submit({ reasonCategory: 'DEPENDENCY' }, s.employee2)).status, 404)
    assert.equal((await submit({ reasonCategory: 'DEPENDENCY' }, s.otherAdmin)).status, 404)
    const ok = await submit({ reasonCategory: 'DEPENDENCY', explanation: 'Waiting for the vendor to rotate the API key.', evidenceLinks: [{ url: 'https://vendor.example.com/ticket/42', label: 'Vendor ticket' }] })
    assert.equal(ok.status, 201)
    const row = plain(t.db.prepare('SELECT * FROM deadline_explanations WHERE id = ?').all(ok.body.id))[0]
    assert.equal(row.task_id, taskId); assert.equal(row.org_id, s.org.id); assert.equal(row.user_id, s.employee.id); assert.equal(row.original_deadline, iso(due))
    assert.equal(row.reason_category, 'DEPENDENCY'); assert.equal(row.explanation, 'Waiting for the vendor to rotate the API key.'); assert.equal(row.review_status, 'PENDING'); assert.ok(row.submitted_at)
    assert.deepEqual(JSON.parse(row.evidence_links), [{ url: 'https://vendor.example.com/ticket/42', label: 'Vendor ticket' }])
    assert.equal((await submit({ reasonCategory: 'TECHNICAL_ISSUE' })).body.error.code, 'explanation_exists')
    assert.deepEqual((await t.call(`/api/tasks/${taskId}/workflow`, { as: s.employee })).body.deadline.explanationRequired, [])
    await t.settled()
    assert.ok(notes(t, 'deadline_explanation', s.manager.id).length === 1, 'the manager is told an explanation awaits review')
    // Review.
    const review = (body, as = s.manager) => t.call(`/api/deadline-explanations/${ok.body.id}/review`, { method: 'POST', as, body })
    assert.equal((await review({ status: 'ACCEPTED' }, s.employee)).status, 403)
    assert.equal((await review({ status: 'ACCEPTED' }, s.manager2)).status, 404, 'another team’s manager cannot see it')
    assert.equal((await review({ status: 'NEEDS_CLARIFICATION' })).status, 400, 'asking needs a question')
    assert.equal((await review({ status: 'PERFECT' })).status, 400)
    assert.equal((await review({ status: 'NEEDS_CLARIFICATION', comment: 'Which vendor ticket, and when did you chase it?' })).status, 200)
    await t.settled()
    assert.match(notes(t, 'deadline_explanation_reviewed', s.employee.id)[0].body, /needs clarification — Which vendor ticket/)
    // The employee adds context; the original stays exactly as written.
    assert.equal((await t.call(`/api/deadline-explanations/${ok.body.id}/context`, { method: 'POST', as: s.manager, body: { body: 'x y z' } })).status, 403)
    assert.equal((await t.call(`/api/deadline-explanations/${ok.body.id}/context`, { method: 'POST', as: s.employee, body: { body: 'Ticket 42, chased on Monday and again Wednesday.' } })).status, 200)
    assert.equal((await review({ status: 'ACCEPTED', comment: 'Understood; the dependency was outside your control.' })).status, 200)
    const x = (await t.call(`/api/tasks/${taskId}/workflow`, { as: s.employee })).body.deadline.explanations[0]
    assert.equal(x.explanation, 'Waiting for the vendor to rotate the API key.'); assert.equal(x.reviewStatus, 'ACCEPTED'); assert.equal(x.reviewedByName, 'Mona Manager')
    assert.deepEqual(x.entries.map((e) => [e.kind, e.reviewStatus, e.authorName]), [['REVIEW', 'NEEDS_CLARIFICATION', 'Mona Manager'], ['CONTEXT', null, 'Eve Employee'], ['REVIEW', 'ACCEPTED', 'Mona Manager']])
    assert.equal(x.entries[0].body, 'Which vendor ticket, and when did you chase it?', 'earlier manager comments are preserved')
    // Queue, history after completion, scope.
    assert.equal((await t.call('/api/deadline-explanations', { as: s.employee })).status, 403)
    assert.equal((await t.call('/api/deadline-explanations?status=PENDING', { as: s.manager })).body.length, 0)
    assert.equal((await t.call('/api/deadline-explanations?status=ACCEPTED', { as: s.manager })).body.length, 1)
    assert.equal((await t.call('/api/deadline-explanations', { as: s.manager2 })).body.length, 0)
    await submitAndApprove(t, s, taskId)
    const ov = (await t.call('/api/slack-intake/overview', { as: s.manager })).body
    assert.equal(ov.missed.length, 1); assert.equal(ov.missed[0].explained, true); assert.equal(ov.missed[0].status, 'COMPLETED', 'the miss stays in the history after completion')
    assert.equal(ov.summary.explanationsToReview, 0)
    const audit = t.db.prepare(`SELECT action FROM audit_log WHERE action LIKE 'deadline_explanation.%'`).all().map((a) => a.action)
    assert.ok(audit.includes('deadline_explanation.submitted') && audit.includes('deadline_explanation.reviewed'))
  } finally { await t.close() }
})

test('an explanation can be given after completion, and a late submission is recorded as a miss without any scan', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    setDue(t, taskId, Date.now() - H) // no scheduler run at all
    await submitAndApprove(t, s, taskId)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND type = 'deadline_missed'`).get(taskId).n, 1)
    assert.equal(taskOf(t, taskId).status, 'COMPLETED')
    const r = await t.call(`/api/tasks/${taskId}/deadline-explanation`, { method: 'POST', as: s.employee, body: { reasonCategory: 'SCOPE_INCREASED', explanation: 'The requirements doubled after the first review.' } })
    assert.equal(r.status, 201)
  } finally { await t.close() }
})

// ---------- measurement ----------
const rate = (level, refs) => ({ state: 'assessed', level, confidence: 0.8, reason: 'Rated from the cited evidence.', evidence_refs: refs })
function scriptedProvider() {
  const p = { configured: true, name: 'scripted', model: 'scripted-v1', packs: [] }
  p.generate = async ({ user }) => {
    const pack = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1))
    p.packs.push(pack)
    const sub = pack.items.filter((i) => i.kind === 'submission').map((i) => i.ref)
    return { output: { understanding: 'Understood.', complexity: { state: 'assessed', level: 'L3', confidence: 0.85, reason: 'Judged from the work.', evidence_refs: sub },
      dimensions: { impact: { state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'None.', evidence_refs: [] }, quality: rate(4, sub), ownership: rate(4, sub), problem_solving: rate(4, sub), collaboration: { state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'None.', evidence_refs: [] } },
      contribution_summary: 'Summary.', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: '' }, model: 'scripted-v1', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  return p
}
const WORK = { summary: 'Investigated logs across cart, payments and inventory. Found the root cause: a race condition between the reservation and the payment capture. Added a regression test and a dashboard.', outcome: 'Checkout failures stopped in staging.' }

test('measurement: ownership provenance is explicit, others are separate, and a missed deadline never lowers a rating', async () => {
  const ai = scriptedProvider()
  const app = await startApp({ ai })
  try {
    const org = seedOrg(app.db)
    for (const [who, id] of [[org.employee, SLACK.eve], [org.employee2, SLACK.ed]]) assert.equal((await app.call('/api/slack-identities', { method: 'POST', as: org.manager, body: { userId: who.id, slackUserId: id } })).status, 201)
    const intake = addIntake(app, org)
    const finish = async (text, { late = false } = {}) => {
      const made = await post(app, intake, { text })
      const id = made.body.taskId
      await app.settled()
      assert.equal((await app.call(`/api/tasks/${id}/accept`, { method: 'POST', as: org.employee })).status, 200)
      await app.call(`/api/tasks/${id}/progress`, { method: 'POST', as: org.employee, body: { progress: 50, note: 'Reproduced the race condition in staging with a failing test.' } })
      if (late) {
        await app.call(`/api/tasks/${id}/blockers`, { method: 'POST', as: org.employee, body: { description: 'Waiting for the payment vendor to fix their sandbox', isExternal: true } })
        const open = (await app.call('/api/blockers', { as: org.employee })).body.find((b) => b.taskId === id)
        await app.call(`/api/blockers/${open.id}/resolve`, { method: 'POST', as: org.employee, body: { resolutionNote: 'Vendor fixed the sandbox' } })
        app.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - 5 * H), id)
        assert.equal((await app.call(`/api/tasks/${id}/deadline-explanation`, { method: 'POST', as: org.employee, body: { reasonCategory: 'DEPENDENCY', explanation: 'The vendor sandbox was down for two days.' } })).status, 201)
      }
      assert.equal((await app.call(`/api/tasks/${id}/submit`, { method: 'POST', as: org.employee, body: { ...WORK, evidenceLinks: [{ url: 'https://github.com/acme/shop/pull/481', label: 'PR 481' }] } })).status, 200)
      assert.equal((await app.call(`/api/tasks/${id}/review`, { method: 'POST', as: org.manager, body: { decision: 'APPROVED' } })).status, 200)
      await app.settled(); await measurementSettled()
      assert.equal((await app.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: org.employee })).status, 200)
      await measurementSettled(); await app.settled()
      return { id, view: (await app.call(`/api/tasks/${id}/assessment`, { as: org.employee })).body }
    }
    const onTime = await finish(`${tag(SLACK.eve)} please fix the intermittent checkout failures, with help from ${tag(SLACK.ed)}, by tomorrow`)
    const late = await finish(`${tag(SLACK.eve)} please fix the intermittent checkout failures again, by tomorrow`, { late: true })
    // The engine also analyses on its own triggers (submitted, approved), so take the latest pack of each task.
    const latest = (late) => ai.packs.filter((p) => /again/.test(p.task.title) === late).at(-1)
    const [a, b] = [latest(false), latest(true)]
    assert.equal(a.task.title, 'Fix the intermittent checkout failures', 'no dangling "with help from" once the people are removed')
    // Initial Slack assignment is distinguishable from accepted ownership; others are separate and not credited as owners.
    for (const pack of [a, b]) {
      assert.equal(pack.ownership.proposedBy, 'a tag in a Slack message'); assert.equal(pack.ownership.employeeWasTheInitialTag, true)
      assert.equal(pack.ownership.employeeAcceptedOwnership, true); assert.ok(pack.ownership.employeeAcceptedAt)
    }
    assert.equal(a.ownership.othersInvolved.supportingContributors, 1); assert.equal(b.ownership.othersInvolved.supportingContributors, 0)
    assert.match(a.ownership.note, /Declining.*not a mark against the employee/)
    // The miss is context, with its circumstances.
    assert.equal(a.deadline, undefined)
    assert.equal(b.deadline.missedDeadlines.length, 1); assert.equal(b.deadline.externalBlockersRecorded, 1); assert.equal(b.deadline.explanations[0].reason, 'Dependency on another team or person')
    assert.match(b.deadline.note, /operational signal, not a measure/)
    // Same evidence, same ratings: the late task is not rated lower for being late.
    const levels = (v) => v.assessment.dimensions.map((d) => `${d.key}:${d.level}`).sort().join(',')
    assert.equal(levels(late.view), levels(onTime.view))
    assert.doesNotMatch(JSON.stringify(late.view), /"(score|rank|ranking|penalty)"\s*:/i)
    // The reviewer-facing rules are in the prompt the model gets.
    const { systemPrompt } = await import('../server/measurement/engine.js')
    const { rubricFor } = await import('../server/measurement/rubric.js')
    const prompt = systemPrompt(rubricFor(app.db, org.org.id))
    assert.match(prompt, /never a measure of the person or the work/); assert.match(prompt, /Declining, asking for clarification or handing a task to a teammate is not a mark against the employee/)
    // Shared outcomes and the requester: the requester is a participant, never the owner.
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM task_participants WHERE role = ?').get('SUPPORT').n, 1)
    const pack = buildEvidencePack(app.db, taskOf(app, onTime.id), org.employee2.id).pack
    assert.equal(pack.ownership.employeeWasTheInitialTag, false); assert.equal(pack.ownership.employeeAcceptedOwnership, false, 'being listed as support is not ownership')
  } finally { await app.close() }
})

test('measurement: declining or handing over a task leaves no mark in the pack', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const p = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'Ed knows this better' } })
    await t.call(`/api/transfers/${p.body.transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'ACCEPT' } })
    const eve = buildEvidencePack(t.db, taskOf(t, taskId), s.employee.id).pack.ownership
    assert.equal(eve.handedToATeammate, true); assert.equal(eve.employeeAcceptedOwnership, true); assert.equal(eve.employeeDeclined, false)
    const ed = buildEvidencePack(t.db, taskOf(t, taskId), s.employee2.id).pack.ownership
    assert.equal(ed.receivedByTransfer, true); assert.equal(ed.employeeWasTheInitialTag, false)
    const w = await slackTask(t, s, sub, { text: `${tag(SLACK.eve)} please fix the signup bug` })
    await t.call(`/api/tasks/${w.taskId}/decline`, { method: 'POST', as: s.employee, body: { reason: 'On leave' } })
    assert.equal(buildEvidencePack(t.db, taskOf(t, w.taskId), s.employee.id).pack.ownership.employeeDeclined, true)
  } finally { await t.close() }
})

// ---------- scheduler: idempotent, recoverable ----------
test('scheduler: repeat runs are idempotent and queued alerts survive a restart', async () => {
  const m91 = fakeM91()
  const { t, s, sub } = await setup({ m91 })
  try {
    await enableM91(t, s)
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    setDue(t, taskId, Date.now() - H)
    const job = (transport) => runAlertJob({ db: t.db, vs: { configured: false }, m91: transport, cfg: t.cfg })
    // The first run raises the escalation, but M91 is down: the alerts stay queued in the database.
    const down = fakeM91({ failTimes: 99 })
    const first = await job(down)
    assert.match(first.text, /Alerts raised/); assert.equal(down.sent.length, 0)
    const queued = () => t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries WHERE rule = 'deadline_missed' AND status = 'QUEUED'`).get().n
    assert.equal(queued(), 2)
    const counts = () => [t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, t.db.prepare('SELECT COUNT(*) AS n FROM alert_deliveries').get().n, t.db.prepare(`SELECT COUNT(*) AS n FROM task_events WHERE type = 'deadline_missed'`).get().n]
    const afterFirst = counts()
    // "Restart": a brand-new process and transport pick the queue up from the database and deliver it.
    const restarted = fakeM91()
    t.db.prepare(`UPDATE alert_deliveries SET next_attempt_at = ? WHERE status = 'QUEUED'`).run(iso(Date.now() - 1000))
    for (let i = 0; i < 3; i++) await job(restarted)
    assert.deepEqual(counts(), afterFirst, 'running the job again changes nothing')
    assert.equal(queued(), 0); assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries WHERE status IN ('QUEUED','SENDING')`).get().n, 0, 'nothing is left stuck')
    assert.equal(sentAs(restarted, 'CRITICAL').length, 2, 'each person was alerted exactly once, after the restart')
    // The event outbox replays what a crash left pending: the assignment alert is rebuilt, not lost.
    const { recoverOutbox } = await import('../server/services/events.js')
    t.db.prepare(`INSERT INTO event_outbox (id, type, payload, status, attempts, created_at, updated_at) VALUES ('pending-1', 'assignment.created', ?, 'PENDING', 1, ?, ?)`)
      .run(JSON.stringify({ type: 'assignment.created', orgId: s.org.id, taskId, assigneeId: s.employee.id, assignmentId: 'lost-assignment', actorId: s.manager.id, via: 'slack' }), iso(Date.now() - 600000), iso(Date.now() - 600000))
    assert.equal(recoverOutbox({ olderThanMs: 0 }), 1); await t.settled()
    assert.equal(deliveries(t, 'task_assignment').filter((d) => d.dedupe_key.includes('lost-assignment')).length, 1)
    assert.equal(recoverOutbox({ olderThanMs: 0 }), 0, 'and is not replayed twice')
  } finally { await t.close() }
})

// ---------- migration on populated data ----------
test('migration 010 keeps every existing task and everything that points at it', () => {
  const dir = new URL('../server/migrations/', import.meta.url)
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  db.exec('PRAGMA foreign_keys = OFF')
  for (const f of files.filter((x) => x < '010')) { db.exec(readFileSync(new URL(f, dir), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, 'x') }
  db.exec('PRAGMA foreign_keys = ON')
  const ts = new Date().toISOString()
  const run = (sql, ...a) => db.prepare(sql).run(...a)
  run(`INSERT INTO organizations (id, name, join_code, created_at, updated_at) VALUES ('o1','Acme','J1',?,?)`, ts, ts)
  for (const u of ['u1', 'u2']) run(`INSERT INTO users (id, google_sub, email, name, created_at, updated_at) VALUES (?,?,?,?,?,?)`, u, `s-${u}`, `${u}@x.co`, u, ts, ts)
  const statuses = ['SUGGESTED', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED']
  statuses.forEach((st, i) => run(`INSERT INTO tasks (id, org_id, title, created_by, assignee_id, priority, status, progress, due_at, status_changed_at, created_at, updated_at) VALUES (?, 'o1', ?, 'u1', 'u2', 'HIGH', ?, ?, ?, ?, ?, ?)`, `t${i}`, `Task ${i}`, st, i * 10, iso(Date.now() + i * H), ts, ts, ts))
  run(`INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES ('e1','o1','t1','u1','created','{}',?)`, ts)
  run(`INSERT INTO blockers (id, org_id, task_id, reported_by, description, reported_at) VALUES ('b1','o1','t3','u2','Waiting',?)`, ts)
  run(`INSERT INTO completion_submissions (id, org_id, task_id, submitted_by, summary, outcome, created_at, updated_at) VALUES ('s1','o1','t5','u2','Did it','Done',?,?)`, ts, ts)
  run(`INSERT INTO evidence (id, org_id, owner_type, owner_id, task_id, kind, url, created_by, created_at) VALUES ('ev1','o1','task','t1','t1','link','https://x.co','u2',?)`, ts)
  run(`INSERT INTO notifications (id, org_id, user_id, kind, title, task_id, dedupe_key, created_at) VALUES ('n1','o1','u2','task_assigned','Hi','t1','d1',?)`, ts)
  run(`INSERT INTO external_identities (id, org_id, user_id, app, identity, source, created_at) VALUES ('i1','o1','u2','slack','U0OLD00001','declared',?)`, ts)
  const before = plain(db.prepare('SELECT * FROM tasks ORDER BY id').all())
  const applied = migrate(db)
  assert.deepEqual(applied, ['010_slack_task_intake.sql'])
  const after = plain(db.prepare('SELECT * FROM tasks ORDER BY id').all())
  assert.equal(after.length, 7)
  for (const [i, row] of before.entries()) for (const [k, val] of Object.entries(row)) assert.equal(after[i][k], val, `task ${row.id}.${k} unchanged`)
  for (const row of after) { assert.equal(row.acceptance_state, null); assert.equal(row.slack_message_ref, null); assert.equal(row.last_meaningful_at, null) }
  for (const [table, n] of [['task_events', 1], ['blockers', 1], ['completion_submissions', 1], ['evidence', 1], ['notifications', 1], ['external_identities', 1]]) assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c, n, `${table} kept`)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.deepEqual(plain(db.prepare(`SELECT mapped_by, workspace_id FROM external_identities`).all()), [{ mapped_by: null, workspace_id: null }], 'old self-declared identities stay unconfirmed')
  // The rebuilt table accepts the new states and still rejects nonsense; children still cascade.
  run(`INSERT INTO tasks (id, org_id, title, created_by, priority, status, status_changed_at, created_at, updated_at) VALUES ('n1','o1','New','u1','LOW','PENDING_ACCEPTANCE',?,?,?)`, ts, ts, ts)
  run(`INSERT INTO tasks (id, org_id, title, created_by, priority, status, status_changed_at, created_at, updated_at) VALUES ('n2','o1','New','u1','LOW','DECLINED',?,?,?)`, ts, ts, ts)
  assert.throws(() => run(`INSERT INTO tasks (id, org_id, title, created_by, priority, status, status_changed_at, created_at, updated_at) VALUES ('n3','o1','New','u1','LOW','WHATEVER',?,?,?)`, ts, ts, ts))
  run(`DELETE FROM tasks WHERE id = 't1'`)
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM task_events WHERE task_id = 't1'`).get().c, 0, 'ON DELETE CASCADE still works')
  assert.deepEqual(migrate(db), [], 'idempotent')
})

// ---------- regression: the existing lifecycle ----------
test('regression: ordinary manager-assigned tasks keep their immediate assignment and are untouched by the acceptance workflow', async () => {
  const { t, s } = await setup()
  try {
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Plain task', assigneeId: s.employee.id } })
    assert.equal(c.body.task.status, 'ASSIGNED'); assert.equal(c.body.task.acceptanceState, null); assert.equal(c.body.task.fromSlack, false)
    const d = (await t.call(`/api/tasks/${c.body.task.id}`, { as: s.employee })).body
    assert.equal(d.allowed.accept, false); assert.equal(d.allowed.decline, false); assert.equal(d.allowed.start, true); assert.equal(d.allowed.transfer, true, 'any owner may offer a task to a teammate')
    const re = await t.call(`/api/tasks/${c.body.task.id}/assign`, { method: 'POST', as: s.manager, body: { assigneeId: s.employee2.id } })
    assert.equal(re.body.status, 'ASSIGNED', 'a plain reassignment is still immediate')
    scanAlerts(t.db, Date.now() + 100 * H)
    assert.equal(notes(t, 'no_movement').length, 0, 'the movement clock applies only to work that went through acceptance')
  } finally { await t.close() }
})

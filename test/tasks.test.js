import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'
import { deriveConditions } from '../server/services/tasks.js'

const H = 3600000
const iso = (ms) => new Date(ms).toISOString()

test('manager creates and assigns; employee lifecycle through review to completion; reopen is an event', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Cut API latency', expectedOutcome: 'p95 < 200ms', priority: 'HIGH', assigneeId: s.employee.id, dueAt: iso(Date.now() + 72 * H), links: [{ url: 'https://example.com/spec' }] } })
    assert.equal(c.status, 201)
    const id = c.body.task.id
    assert.equal(c.body.task.status, 'ASSIGNED')
    assert.equal(c.body.task.teamId, s.teamA)

    // Only the assignee starts it; the manager cannot jump to COMPLETED.
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee2, body: { status: 'IN_PROGRESS' } })).status, 404)
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'COMPLETED' } })).status, 400)
    const started = await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    assert.equal(started.body.status, 'IN_PROGRESS')
    const prog = await t.call(`/api/tasks/${id}/progress`, { method: 'POST', as: s.employee, body: { progress: 60, note: 'cache added' } })
    assert.equal(prog.body.progress, 60)
    assert.equal((await t.call(`/api/tasks/${id}/progress`, { method: 'POST', as: s.manager, body: { progress: 90 } })).status, 403)

    // Submission → not completed until approved.
    const sub = await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Added cache', outcome: 'p95 is 150ms', evidenceLinks: [{ url: 'https://github.com/x/pr/1', label: 'PR' }] } })
    assert.equal(sub.status, 200)
    let d = await t.call(`/api/tasks/${id}`, { as: s.manager })
    assert.equal(d.body.task.status, 'SUBMITTED_FOR_REVIEW')
    assert.equal(d.body.allowed.review, true)
    assert.equal(d.body.submissions[0].evidence[0].label, 'PR')

    // Changes requested needs a comment and sends it back to IN_PROGRESS.
    assert.equal((await t.call(`/api/tasks/${id}/review`, { method: 'POST', as: s.manager, body: { decision: 'CHANGES_REQUESTED' } })).status, 400)
    const back = await t.call(`/api/tasks/${id}/review`, { method: 'POST', as: s.manager, body: { decision: 'CHANGES_REQUESTED', comment: 'Add a load test' } })
    assert.equal(back.body.status, 'IN_PROGRESS')
    await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Load tested', outcome: 'p95 150ms at 2x load' } })
    assert.equal((await t.call(`/api/tasks/${id}/review`, { method: 'POST', as: s.employee, body: { decision: 'APPROVED' } })).status, 403, 'employees cannot approve')
    const done = await t.call(`/api/tasks/${id}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED', comment: 'Great' } })
    assert.equal(done.body.status, 'COMPLETED')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM impact_records WHERE task_id = ?`).get(id).n, 0, 'completion does not create or verify impact')

    // Reopen needs a reason and is recorded.
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'IN_PROGRESS' } })).status, 400)
    const re = await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'IN_PROGRESS', reason: 'Regression found' } })
    assert.equal(re.body.status, 'IN_PROGRESS')
    d = await t.call(`/api/tasks/${id}`, { as: s.employee })
    const types = d.body.events.map((e) => e.type)
    for (const ty of ['created', 'assigned', 'status_changed', 'progress', 'submitted_for_review', 'review_decision', 'reopened']) assert.ok(types.includes(ty), ty)
    assert.equal(d.body.submissions.length, 2)
  } finally { await t.close() }
})

test('invalid transitions are refused', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const { body } = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'x', assigneeId: s.employee.id } })
    const id = body.task.id
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'ASSIGNED' } })).status, 409)
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'BLOCKED' } })).status, 400)
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'SUBMITTED_FOR_REVIEW' } })).status, 400)
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'CANCELLED', reason: 'meh' } })).status, 403)
    const cancelled = await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'CANCELLED', reason: 'Priority changed' } })
    assert.equal(cancelled.body.status, 'CANCELLED')
    assert.equal((await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'a', outcome: 'b' } })).status, 409)
    const restored = await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'ASSIGNED', reason: 'Back on' } })
    assert.equal(restored.body.status, 'ASSIGNED')
  } finally { await t.close() }
})

test('employee permissions: suggest only by default; direct creation; self vs others assignment; audited', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Default: the create form becomes a request.
    const r1 = await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Write runbook', reason: 'On-call pain' } })
    assert.equal(r1.status, 201)
    assert.equal(r1.body.mode, 'request')
    assert.equal(r1.body.request.status, 'PENDING')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0)

    // can_create_tasks alone is still approval (can_create_directly + no approval_required needed).
    await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.manager, body: { can_create_tasks: true } })
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Still a request', reason: 'r' } })).body.mode, 'request')

    const p = await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.manager, body: { can_create_directly: true, approval_required: false } })
    assert.deepEqual(p.body.changed.sort(), ['approval_required', 'can_create_directly'])
    const direct = await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Direct unassigned' } })
    assert.equal(direct.body.mode, 'direct')
    assert.equal(direct.body.task.assigneeId, null)

    // Creating does not imply assigning.
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Self', assigneeId: s.employee.id } })).status, 403)
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Other', assigneeId: s.employee2.id } })).status, 403)
    await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.manager, body: { can_self_assign: true } })
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Self', assigneeId: s.employee.id } })).status, 201)
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Other', assigneeId: s.employee2.id } })).status, 403)
    await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.manager, body: { can_assign_others: true } })
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Other', assigneeId: s.employee2.id } })).status, 201)
    // Assigning others is limited to the employee's own team.
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Cross team', assigneeId: s.outsider.id } })).status, 403)
    // Employees cannot change permissions, including their own.
    assert.equal((await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.employee, body: { can_assign_others: true } })).status, 403)
    const audit = await t.call('/api/audit', { as: s.manager })
    assert.equal(audit.body.filter((a) => a.action === 'permissions.updated').length, 4)
    assert.deepEqual(audit.body.at(-1).after, { can_create_tasks: true })
  } finally { await t.close() }
})

test('overdue and at-risk are derived, not stored', () => {
  const at = Date.parse('2026-11-09T12:00:00Z')
  const base = { status: 'IN_PROGRESS', progress: 20, created_at: '2026-11-01T00:00:00Z', assigned_at: '2026-11-01T00:00:00Z', assignee_id: 'u' }
  assert.equal(deriveConditions({ ...base, due_at: '2026-11-09T11:00:00Z' }, at).overdue, true)
  assert.equal(deriveConditions({ ...base, due_at: '2026-11-09T11:00:00Z' }, at).hoursOverdue, 1)
  assert.equal(deriveConditions({ ...base, due_at: '2026-11-09T11:00:00Z', status: 'COMPLETED' }, at).overdue, false)
  assert.equal(deriveConditions({ ...base, due_at: '2026-11-09T11:00:00Z', status: 'CANCELLED' }, at).overdue, false)
  // Submitted before the deadline: not overdue while waiting for review. Submitted after: overdue.
  assert.equal(deriveConditions({ ...base, status: 'SUBMITTED_FOR_REVIEW', due_at: '2026-11-09T11:00:00Z', submitted_at: '2026-11-09T10:00:00Z' }, at).overdue, false)
  assert.equal(deriveConditions({ ...base, status: 'SUBMITTED_FOR_REVIEW', due_at: '2026-11-09T11:00:00Z', submitted_at: '2026-11-09T11:30:00Z' }, at).overdue, true)
  assert.equal(deriveConditions({ ...base, due_at: null }, at).overdue, false)
  // At risk: 10h left at 20%.
  assert.equal(deriveConditions({ ...base, due_at: '2026-11-09T22:00:00Z' }, at).atRisk, true)
  assert.equal(deriveConditions({ ...base, progress: 90, due_at: '2026-11-09T22:00:00Z' }, at).atRisk, false)
  // Plenty of time.
  assert.equal(deriveConditions({ ...base, due_at: '2026-11-30T00:00:00Z' }, at).atRisk, false)
  // Blocked close to the deadline.
  assert.equal(deriveConditions({ ...base, status: 'BLOCKED', progress: 80, due_at: '2026-11-11T00:00:00Z' }, at).atRisk, true)
  assert.equal(deriveConditions({ ...base, assignee_id: null, status: 'ASSIGNED' }, at).unassigned, true)
})

test('overdue filter and dashboard counts come from deadlines', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Late', assigneeId: s.employee.id, dueAt: iso(Date.now() - 2 * H) } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Fine', assigneeId: s.employee.id, dueAt: iso(Date.now() + 200 * H) } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Nobody' } })
    const overdue = await t.call('/api/tasks?condition=overdue', { as: s.manager })
    assert.deepEqual(overdue.body.map((x) => x.title), ['Late'])
    const dash = await t.call('/api/dashboard', { as: s.manager })
    assert.equal(dash.body.manager.counts.overdue, 1)
    assert.equal(dash.body.manager.counts.unassigned, 1)
    assert.equal(dash.body.manager.counts.pending, 3)
    assert.ok(dash.body.manager.attention.some((a) => a.kind === 'overdue' && a.task.title === 'Late'))
    const eve = dash.body.manager.workload.find((w) => w.name === 'Eve Employee')
    assert.equal(eve.active, 2)
    assert.equal(eve.overdue, 1)
    const emp = await t.call('/api/dashboard', { as: s.employee })
    assert.equal(emp.body.manager, undefined)
    assert.equal(emp.body.personal.counts.overdue, 1)
    assert.equal(emp.body.personal.awaitingMe.length, 2)
  } finally { await t.close() }
})

test('blockers: report → BLOCKED, duration, escalation, resolution resumes the task; deleting keeps history rules', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const { body } = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Migrate DB', assigneeId: s.employee.id } })
    const id = body.task.id
    await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    const b = await t.call(`/api/tasks/${id}/blockers`, { method: 'POST', as: s.employee, body: { description: 'Waiting for DBA access', dependencyOwnerId: s.employee2.id } })
    assert.equal(b.status, 200)
    let d = await t.call(`/api/tasks/${id}`, { as: s.manager })
    assert.equal(d.body.task.status, 'BLOCKED')
    assert.equal(d.body.blockers[0].dependencyOwnerName, 'Ed Employee')
    assert.equal(d.body.task.blockedHours, 0)
    // Cannot submit while blocked; cannot move to IN_PROGRESS while a blocker is open.
    assert.equal((await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'a', outcome: 'b' } })).status, 409)
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })).status, 409)
    assert.equal((await t.call(`/api/blockers/${b.body.id}/escalate`, { method: 'POST', as: s.employee })).status, 200)
    const open = await t.call('/api/blockers', { as: s.manager })
    assert.equal(open.body.length, 1)
    assert.ok(open.body[0].escalatedAt)
    // The dependency owner may resolve it; a note is required.
    assert.equal((await t.call(`/api/blockers/${b.body.id}/resolve`, { method: 'POST', as: s.employee2, body: {} })).status, 400)
    const r = await t.call(`/api/blockers/${b.body.id}/resolve`, { method: 'POST', as: s.employee2, body: { resolutionNote: 'Access granted' } })
    assert.equal(r.body.taskResumed, true)
    d = await t.call(`/api/tasks/${id}`, { as: s.manager })
    assert.equal(d.body.task.status, 'IN_PROGRESS')
    assert.ok(d.body.events.some((e) => e.type === 'blocker_resolved'))
    // Delete (manager only) is audited.
    assert.equal((await t.call(`/api/tasks/${id}`, { method: 'DELETE', as: s.employee })).status, 403)
    assert.equal((await t.call(`/api/tasks/${id}`, { method: 'DELETE', as: s.manager })).status, 200)
    assert.ok(t.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'task.deleted'`).get())
  } finally { await t.close() }
})

test('reassignment, deadline change with reason, search/sort/filter', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const { body } = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Alpha report', assigneeId: s.employee.id, priority: 'LOW' } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Beta fix', assigneeId: s.employee.id, priority: 'CRITICAL' } })
    const id = body.task.id
    const re = await t.call(`/api/tasks/${id}/assign`, { method: 'POST', as: s.manager, body: { assigneeId: s.employee2.id, reason: 'Load balancing' } })
    assert.equal(re.body.assigneeName, 'Ed Employee')
    const due = iso(Date.now() + 48 * H)
    const up = await t.call(`/api/tasks/${id}`, { method: 'PATCH', as: s.manager, body: { dueAt: due, priority: 'HIGH', reason: 'Customer escalation' } })
    assert.equal(up.body.priority, 'HIGH')
    const d = await t.call(`/api/tasks/${id}`, { as: s.manager })
    assert.ok(d.body.events.some((e) => e.type === 'deadline_changed' && e.data.reason === 'Customer escalation'))
    assert.ok(d.body.events.some((e) => e.type === 'reassigned'))
    assert.equal((await t.call(`/api/tasks/${id}`, { as: s.employee })).status, 404, 'previous assignee no longer sees it')
    const sorted = await t.call('/api/tasks?sort=priority', { as: s.manager })
    assert.equal(sorted.body[0].title, 'Beta fix')
    assert.deepEqual((await t.call('/api/tasks?q=alpha', { as: s.manager })).body.map((x) => x.title), ['Alpha report'])
    assert.deepEqual((await t.call('/api/tasks?priority=CRITICAL', { as: s.manager })).body.map((x) => x.title), ['Beta fix'])
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'bad', links: [{ url: 'javascript:alert(1)' }] } })).status, 400)
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: '' } })).status, 400)
  } finally { await t.close() }
})

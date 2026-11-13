import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'
import { deriveConditions } from '../server/services/tasks.js'
import { scoreFactors, DEFAULT_MODEL } from '../server/services/priority-model.js'
import { addWorkingTime, DEFAULT_CALENDAR } from '../server/time.js'

const H = 3600000
const iso = (ms) => new Date(ms).toISOString()
const plain = (rows) => JSON.parse(JSON.stringify(rows))

async function boot() {
  const t = await startApp()
  const s = seedOrg(t.db)
  const make = async (body, as = s.manager) => (await t.call('/api/tasks', { method: 'POST', as, body: { assigneeId: s.employee.id, ...body } }))
  const params = async (id, as = s.manager) => (await t.call(`/api/tasks/${id}/parameters`, { as })).body
  return { t, s, make, params }
}

test('manager creation confirms priority, deadline and every expectation, with who/when/source recorded', async () => {
  const { t, s, make, params } = await boot()
  try {
    const due = iso(Date.now() + 48 * H)
    const c = await make({ title: 'Cut API latency', expectedOutcome: 'p95 < 200ms', priority: 'HIGH', dueAt: due, complexityExpectation: 'L3', businessImpact: 'Checkout conversion', dependencies: 'Platform team cache', successCriteria: 'p95 under 200ms for a week', context: 'See incident 42', workType: 'Performance' })
    assert.equal(c.status, 201)
    const id = c.body.task.id
    const row = t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    assert.equal(row.priority, 'HIGH'); assert.equal(row.due_at, due); assert.equal(row.origin, 'MANAGER')
    const p = await params(id)
    assert.equal(p.priority.state, 'CONFIRMED'); assert.equal(p.priority.confirmedBy.name, 'Mona Manager'); assert.equal(p.priority.source, 'MANAGER')
    assert.equal(p.deadline.state, 'CONFIRMED'); assert.equal(p.complexityExpectation.value, 'L3'); assert.equal(p.workType.value, 'Performance')
    assert.equal(p.successCriteria.value, 'p95 under 200ms for a week'); assert.equal(p.businessImpact.state, 'CONFIRMED')
    assert.equal(p.baseline.priority.value, 'HIGH'); assert.equal(p.baseline.deadline.value, due)
    assert.ok(p.history.every((e) => e.actorName === 'Mona Manager' && e.source === 'MANAGER'))
    // The employee sees the confirmed expectations but not the manager-only recommendation machinery.
    const e = await params(id, s.employee)
    assert.equal(e.priority.value, 'HIGH'); assert.equal(e.canManage, false); assert.equal(e.recommendations, undefined); assert.equal(e.factors, undefined)
    // Invalid values are refused with a clear error.
    assert.equal((await make({ title: 'x1', priority: 'URGENT!' })).status, 400)
    assert.equal((await make({ title: 'x2', complexityExpectation: 'L9' })).status, 400)
    assert.equal((await make({ title: 'x3', dueAt: 'not a date' })).status, 400)
  } finally { await t.close() }
})

test('a task without a confirmed priority is UNRESOLVED, never MEDIUM, and no reader fails on it', async () => {
  const { t, s, make, params } = await boot()
  try {
    const c = await make({ title: 'Priority to be decided' })
    assert.equal(c.status, 201)
    const id = c.body.task.id
    assert.equal(c.body.task.priority, null)
    assert.equal(t.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id).priority, null)
    const p = await params(id)
    assert.equal(p.priority.state, 'UNRESOLVED'); assert.equal(p.deadline.state, 'UNRESOLVED')
    // Every reader that touches priority survives NULL.
    for (const [path, as] of [['/api/tasks', s.manager], [`/api/tasks/${id}`, s.manager], [`/api/tasks/${id}`, s.employee], ['/api/tasks?priority=UNRESOLVED', s.manager], ['/api/tasks?sort=priority', s.manager], ['/api/dashboard', s.manager], ['/api/dashboard', s.employee], ['/api/assignments/inbox', s.employee], ['/api/parameter-review', s.manager]]) {
      const r = await t.call(path, { as })
      assert.ok(r.status < 400, `${path} → ${r.status}`)
    }
    const filtered = await t.call('/api/tasks?priority=UNRESOLVED', { as: s.manager })
    assert.deepEqual(filtered.body.map((x) => x.id), [id])
    await t.settled()
    const note = t.db.prepare(`SELECT body, title FROM notifications WHERE user_id = ? AND task_id = ?`).get(s.employee.id, id)
    assert.ok(note, 'the assignee is still told about the task'); assert.doesNotMatch(`${note.title} ${note.body}`, /null|undefined|medium/i)
    // A priority cannot be cleared once confirmed.
    await t.call(`/api/tasks/${id}`, { method: 'PATCH', as: s.manager, body: { priority: 'LOW' } })
    assert.equal((await t.call(`/api/tasks/${id}`, { method: 'PATCH', as: s.manager, body: { priority: null, title: 'Renamed' } })).status, 200)
    assert.equal(t.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id).priority, 'LOW', 'null in a patch means "not changing", never "clear"')
  } finally { await t.close() }
})

test('changing a confirmed value keeps the original as the baseline and records actor, reason and time', async () => {
  const { t, s, make, params } = await boot()
  try {
    const d1 = iso(Date.now() + 24 * H); const d2 = iso(Date.now() + 96 * H)
    const id = (await make({ title: 'Report', priority: 'MEDIUM', dueAt: d1 })).body.task.id
    const r = await t.call(`/api/tasks/${id}`, { method: 'PATCH', as: s.manager, body: { priority: 'CRITICAL', dueAt: d2, reason: 'Customer escalation' } })
    assert.equal(r.status, 200)
    const p = await params(id)
    assert.equal(p.priority.value, 'CRITICAL'); assert.equal(p.deadline.value, d2)
    assert.equal(p.baseline.priority.value, 'MEDIUM', 'the original manager parameter stays the baseline'); assert.equal(p.baseline.deadline.value, d1)
    const change = p.history.find((e) => e.field === 'priority' && e.kind === 'CHANGE')
    assert.equal(change.oldValue, 'MEDIUM'); assert.equal(change.value, 'CRITICAL'); assert.equal(change.reason, 'Customer escalation'); assert.equal(change.actorName, 'Mona Manager')
    // The existing task activity history still records the change (reports and the journey read it).
    const kinds = t.db.prepare('SELECT type FROM task_events WHERE task_id = ?').all(id).map((e) => e.type)
    assert.ok(kinds.includes('priority_changed') && kinds.includes('deadline_changed'))
    // Employees never edit confirmed values.
    assert.equal((await t.call(`/api/tasks/${id}`, { method: 'PATCH', as: s.employee, body: { priority: 'LOW' } })).status, 403)
    assert.equal(t.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id).priority, 'CRITICAL')
  } finally { await t.close() }
})

test('employee-created values stay PROPOSED until a manager confirms; an unconfirmed deadline is never overdue', async () => {
  const { t, s, params } = await boot()
  try {
    const grant = await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.manager, body: { can_create_directly: true, approval_required: false, can_self_assign: true } })
    assert.equal(grant.status, 200)
    const past = iso(Date.now() - 5 * H)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'My own task', priority: 'CRITICAL', dueAt: past, expectedOutcome: 'Done well', assigneeId: s.employee.id } })
    assert.equal(c.status, 201)
    const id = c.body.task.id
    const row = t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    assert.equal(row.priority, null); assert.equal(row.due_at, null); assert.equal(row.expected_outcome, null); assert.equal(row.origin, 'EMPLOYEE')
    assert.equal(deriveConditions(row).overdue, false, 'a proposed deadline never makes a task overdue')
    const p = await params(id)
    assert.equal(p.priority.state, 'PROPOSED'); assert.equal(p.priority.suggestion.value, 'CRITICAL'); assert.equal(p.priority.suggestion.source, 'EMPLOYEE'); assert.equal(p.deadline.state, 'PROPOSED')
    // The manager's review queue shows it; the employee cannot use the queue or confirm anything.
    const q = (await t.call('/api/parameter-review', { as: s.manager })).body
    assert.equal(q.length, 1); assert.equal(q[0].taskId, id); assert.equal(q[0].priorityState, 'PROPOSED'); assert.equal(q[0].deadlineState, 'PROPOSED')
    assert.equal((await t.call('/api/parameter-review', { as: s.employee })).status, 403)
    assert.equal((await t.call(`/api/tasks/${id}/parameters/priority/accept`, { method: 'POST', as: s.employee, body: {} })).status, 403)
    // Confirming it (here with an edited deadline) makes it real, and the proposal is kept in the history.
    const later = iso(Date.now() + 72 * H)
    assert.equal((await t.call(`/api/tasks/${id}/parameters/priority/accept`, { method: 'POST', as: s.manager, body: { value: 'HIGH', reason: 'Not that urgent' } })).status, 200)
    assert.equal((await t.call(`/api/tasks/${id}/parameters/deadline/accept`, { method: 'POST', as: s.manager, body: { value: later } })).status, 200)
    const after = await params(id)
    assert.equal(after.priority.state, 'CONFIRMED'); assert.equal(after.priority.value, 'HIGH'); assert.equal(after.deadline.value, later)
    assert.ok(after.history.some((e) => e.status === 'PROPOSED' && e.value === 'CRITICAL'), 'the original proposal is preserved')
    assert.equal((await t.call('/api/parameter-review', { as: s.manager })).body.some((x) => x.taskId === id && x.priorityState !== 'CONFIRMED'), false)
    // A manager can also reject a suggestion; it stays unresolved.
    const c2 = await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Another', priority: 'LOW', assigneeId: s.employee.id } })
    assert.equal((await t.call(`/api/tasks/${c2.body.task.id}/parameters/priority/reject`, { method: 'POST', as: s.manager, body: { reason: 'Needs real triage' } })).status, 200)
    assert.equal((await params(c2.body.task.id)).priority.state, 'UNRESOLVED')
  } finally { await t.close() }
})

test('Slack-style suggestions never touch confirmed columns, overdue state or alerts', async () => {
  const { t, s, make, params } = await boot()
  try {
    const id = (await make({ title: 'From chat' })).body.task.id
    const row = t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    const { suggestValues } = await import('../server/services/task-parameters.js')
    suggestValues(t.db, row, { priority: 'HIGH', dueAt: iso(Date.now() - 3 * H) }, { source: 'SLACK_EXTRACTION', actorId: s.manager.id, confidence: 'MEDIUM', evidence: { slackRef: 'slack:C1:1.1', extractedAt: iso(Date.now()), extraction: 'deterministic' } })
    const p = await params(id)
    assert.equal(p.priority.state, 'SUGGESTED'); assert.equal(p.priority.suggestion.confidence, 'MEDIUM'); assert.equal(p.priority.suggestion.evidence.slackRef, 'slack:C1:1.1')
    const fresh = t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    assert.equal(fresh.priority, null); assert.equal(fresh.due_at, null); assert.equal(deriveConditions(fresh).overdue, false)
    // The alert scan has nothing to raise for a task with no confirmed deadline.
    const { scanAlerts } = await import('../server/services/alerts.js')
    scanAlerts(t.db); await t.settled()
    const late = t.db.prepare('SELECT title FROM notifications WHERE task_id = ?').all(id).filter((n) => /overdue|due soon|deadline|late/i.test(n.title))
    assert.deepEqual(late, [], 'no overdue or deadline alert for an unconfirmed deadline')
  } finally { await t.close() }
})

test('change requests: the assignee asks, the manager decides, values change only on approval', async () => {
  const { t, s, make, params } = await boot()
  try {
    const d1 = iso(Date.now() + 24 * H); const d2 = iso(Date.now() + 120 * H)
    const id = (await make({ title: 'Migrate', priority: 'HIGH', dueAt: d1, expectedOutcome: 'Migrated' })).body.task.id
    const ask = (body, as = s.employee) => t.call(`/api/tasks/${id}/change-requests`, { method: 'POST', as, body })
    assert.equal((await ask({ kind: 'DEADLINE', proposed: { dueAt: d2 }, reason: 'Vendor is late' }, s.employee2)).status, 404, 'someone outside the task cannot ask')
    assert.equal((await ask({ kind: 'DEADLINE', proposed: { dueAt: d2 }, reason: 'x' }, s.manager)).status, 403, 'managers edit directly')
    const r = await ask({ kind: 'DEADLINE', proposed: { dueAt: d2 }, reason: 'Vendor is late' })
    assert.equal(r.status, 201); assert.equal(r.body.status, 'PENDING')
    assert.equal(t.db.prepare('SELECT due_at FROM tasks WHERE id = ?').get(id).due_at, d1, 'nothing changes until the manager decides')
    assert.equal((await ask({ kind: 'DEADLINE', proposed: { dueAt: d2 }, reason: 'Again' })).status, 409, 'one pending request per kind')
    assert.equal((await ask({ kind: 'PRIORITY', proposed: { priority: 'LOW' }, reason: 'Less important now' })).status, 201)
    // Review queue and the task show it; managers get notified.
    await t.settled()
    assert.ok((await t.call('/api/parameter-review', { as: s.manager })).body.some((x) => x.taskId === id && x.pendingChangeRequests === 2))
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'change_request'`).get(s.manager.id))
    assert.equal((await t.call(`/api/change-requests/${r.body.id}/decision`, { method: 'POST', as: s.employee, body: { decision: 'APPROVE' } })).status, 403)
    const ok = await t.call(`/api/change-requests/${r.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE', note: 'Fine, vendor slipped' } })
    assert.equal(ok.status, 200); assert.equal(ok.body.status, 'APPROVED')
    assert.equal(t.db.prepare('SELECT due_at FROM tasks WHERE id = ?').get(id).due_at, d2)
    const p = await params(id)
    assert.equal(p.baseline.deadline.value, d1); const ch = p.history.find((e) => e.field === 'deadline' && e.kind === 'CHANGE')
    assert.equal(ch.source, 'CHANGE_REQUEST'); assert.equal(ch.oldValue, d1); assert.equal(ch.actorName, 'Mona Manager'); assert.equal(ch.evidence.requestedBy, s.employee.id)
    assert.equal((await t.call(`/api/change-requests/${r.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE' } })).status, 409, 'cannot be decided twice')
    // Rejection needs a reason and leaves the value alone; the requester is told.
    const pr = t.db.prepare(`SELECT id FROM task_change_requests WHERE task_id = ? AND kind = 'PRIORITY'`).get(id).id
    assert.equal((await t.call(`/api/change-requests/${pr}/decision`, { method: 'POST', as: s.manager, body: { decision: 'REJECT' } })).status, 400)
    assert.equal((await t.call(`/api/change-requests/${pr}/decision`, { method: 'POST', as: s.manager, body: { decision: 'REJECT', note: 'Still high' } })).status, 200)
    assert.equal(t.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id).priority, 'HIGH')
    await t.settled()
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'change_request_decided'`).get(s.employee.id))
    // Clarification is answered, never approved; scope changes apply through the same path; withdrawing works.
    const q = await ask({ kind: 'CLARIFICATION', reason: 'Which environment?' })
    assert.equal((await t.call(`/api/change-requests/${q.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE' } })).status, 400)
    assert.equal((await t.call(`/api/change-requests/${q.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'ANSWER', note: 'Production' } })).body.status, 'ANSWERED')
    const sc = await ask({ kind: 'SCOPE', proposed: { successCriteria: 'Only the EU region' }, reason: 'Scope is too wide' })
    assert.equal(sc.status, 201)
    assert.equal((await t.call(`/api/change-requests/${sc.body.id}/withdraw`, { method: 'POST', as: s.employee })).body.status, 'WITHDRAWN')
    const sc2 = await ask({ kind: 'SCOPE', proposed: { successCriteria: 'Only the EU region' }, reason: 'Scope is too wide' })
    await t.call(`/api/change-requests/${sc2.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE' } })
    assert.equal((await params(id)).successCriteria.value, 'Only the EU region')
    // Requests are scoped: the employee sees only their own, the other team's manager sees none.
    assert.ok((await t.call('/api/change-requests', { as: s.employee })).body.every((x) => x.requestedBy === s.employee.id))
    assert.equal((await t.call('/api/change-requests', { as: s.manager2 })).body.length, 0)
    assert.equal((await t.call(`/api/change-requests/${pr}/decision`, { method: 'POST', as: s.manager2, body: { decision: 'ANSWER', note: 'hi' } })).status, 404)
  } finally { await t.close() }
})

test('priority recommendation: weighted formula, unknown factors, thresholds, confidence, Critical needs a manager', async () => {
  // The pure model.
  const all = (n) => Object.fromEntries(['businessImpact', 'urgency', 'dependencies', 'risk', 'strategic'].map((k) => [k, { score: n }]))
  assert.equal(scoreFactors(all(5)).score, 100); assert.equal(scoreFactors(all(5)).suggestedPriority, 'CRITICAL')
  assert.equal(scoreFactors(all(3)).score, 60); assert.equal(scoreFactors(all(3)).suggestedPriority, 'MEDIUM')
  assert.equal(scoreFactors(all(1)).score, 20); assert.equal(scoreFactors(all(1)).suggestedPriority, 'LOW')
  const mixed = scoreFactors({ businessImpact: { score: 5 }, urgency: { score: 4 }, dependencies: { score: 3 }, risk: { score: 3 }, strategic: { score: 2 } })
  assert.equal(mixed.rawScore, 75); assert.equal(mixed.score, 75); assert.equal(mixed.suggestedPriority, 'HIGH'); assert.equal(mixed.confidence, 'HIGH')
  assert.deepEqual(plain(Object.entries(DEFAULT_MODEL.weights)), [['businessImpact', 30], ['urgency', 25], ['dependencies', 20], ['risk', 15], ['strategic', 10]])
  const partial = scoreFactors({ businessImpact: { score: 5 }, urgency: { score: 3 }, dependencies: { score: 3 } }) // risk and strategic unknown
  assert.equal(partial.knownWeight, 75); assert.equal(partial.confidence, 'MEDIUM'); assert.ok(partial.breakdown.filter((b) => !b.known).length === 2)
  assert.ok(partial.breakdown.filter((b) => !b.known).every((b) => b.score === null && b.contribution === null), 'unknown factors are never given an invented score')
  assert.equal(scoreFactors({ businessImpact: { score: 5 } }).suggestedPriority, null, 'too little is known to recommend anything')
  assert.equal(scoreFactors({}).insufficient, true)

  const { t, s, make } = await boot().then(({ t, s, make }) => ({ t, s, make }))
  try {
    const rec = (id, as = s.manager) => t.call(`/api/tasks/${id}/priority-recommendation`, { method: 'POST', as })
    // Keywords alone never produce Critical or anything else.
    const kw = (await make({ title: 'URGENT CRITICAL production outage ASAP', description: 'critical urgent emergency' })).body.task.id
    const r0 = await rec(kw)
    assert.equal(r0.status, 201); assert.equal(r0.body.suggestedPriority, null); assert.equal(r0.body.score, null)
    assert.equal((await t.call(`/api/tasks/${kw}/priority-recommendation/${r0.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'ACCEPT' } })).status, 400)
    // Manager-rated factors give a recommendation with explanations, evidence and a config version.
    const id = (await make({ title: 'Payments down', factors: { businessImpact: 5, urgency: 5, dependencies: 5, risk: 5, strategic: 5 } })).body.task.id
    assert.equal((await rec(id, s.employee)).status, 403)
    const r = (await rec(id)).body
    assert.equal(r.score, 100); assert.equal(r.suggestedPriority, 'CRITICAL'); assert.equal(r.confidence, 'HIGH'); assert.equal(r.criticalReview, true); assert.equal(r.requiresManagerConfirmation, true)
    assert.match(r.configVersion, /^priority-model-/); assert.equal(r.factors.length, 5); assert.ok(r.factors.every((f) => f.explanation && Array.isArray(f.evidence)))
    assert.equal(t.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id).priority, null, 'recommending never sets the priority')
    // Override needs a reason and a different level; it is audited; the recommendation history is kept.
    assert.equal((await t.call(`/api/tasks/${id}/priority-recommendation/${r.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'OVERRIDE', priority: 'HIGH' } })).status, 400)
    assert.equal((await t.call(`/api/tasks/${id}/priority-recommendation/${r.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'OVERRIDE', priority: 'CRITICAL', reason: 'same' } })).status, 400)
    const ov = await t.call(`/api/tasks/${id}/priority-recommendation/${r.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'OVERRIDE', priority: 'HIGH', reason: 'Workaround exists' } })
    assert.equal(ov.status, 200); assert.equal(ov.body.status, 'OVERRIDDEN'); assert.equal(ov.body.finalPriority, 'HIGH')
    assert.equal(t.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id).priority, 'HIGH')
    const a = t.db.prepare(`SELECT * FROM audit_log WHERE action = 'priority.override' AND entity_id = ?`).get(id)
    assert.ok(a); assert.equal(a.actor_id, s.manager.id)
    assert.ok(t.db.prepare(`SELECT 1 FROM task_parameter_events WHERE task_id = ? AND field = 'priority' AND status = 'CONFIRMED' AND based_on = ?`).get(id, r.id))
    // A new recommendation supersedes an open one; the deadline feeds urgency only when confirmed.
    const id2 = (await make({ title: 'Soon', dueAt: iso(Date.now() + 2 * H), factors: { businessImpact: 3, dependencies: 3 } })).body.task.id
    const a1 = (await rec(id2)).body; const a2 = (await rec(id2)).body
    assert.equal(a2.factors.find((f) => f.key === 'urgency').score, 5)
    assert.equal(t.db.prepare('SELECT status FROM priority_recommendations WHERE id = ?').get(a1.id).status, 'SUPERSEDED')
    const acc = await t.call(`/api/tasks/${id2}/priority-recommendation/${a2.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'ACCEPT' } })
    assert.equal(acc.body.status, 'ACCEPTED'); assert.equal(t.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id2).priority, a2.suggestedPriority)
    // Another team's manager cannot see or use it.
    assert.equal((await rec(id2, s.manager2)).status, 404)
  } finally { await t.close() }
})

test('deadline intelligence: response target is unconfirmed and separate; the official deadline stays NULL', async () => {
  const { t, make, params } = await boot()
  try {
    const id = (await make({ title: 'No deadline yet', priority: 'CRITICAL', complexityExpectation: 'L2' })).body.task.id
    const p = await params(id)
    assert.equal(p.deadline.value, null); assert.equal(p.targets.unconfirmed, true)
    assert.equal(p.targets.responseSla.amount, 1); assert.equal(p.targets.responseSla.unit, 'working_hours')
    assert.ok(p.targets.responseSla.respondBy); assert.ok(p.targets.completionTarget.dueAt); assert.match(p.targets.completionTarget.basis, /3 working day/)
    assert.equal(t.db.prepare('SELECT due_at FROM tasks WHERE id = ?').get(id).due_at, null, 'suggested targets are never stored as the deadline')
    // Without a complexity expectation there is no completion target to suggest.
    const id2 = (await make({ title: 'No complexity', priority: 'LOW' })).body.task.id
    const p2 = await params(id2)
    assert.equal(p2.targets.completionTarget, null); assert.equal(p2.targets.responseSla.amount, 3); assert.equal(p2.targets.responseSla.unit, 'working_days')
    // A manager-set response target replaces the default suggestion and is kept separately from the deadline.
    const id3 = (await make({ title: 'Own SLA', priority: 'LOW', responseSla: { amount: 2, unit: 'WORKING_HOURS' } })).body.task.id
    const p3 = await params(id3)
    assert.equal(p3.responseSla.value.amount, 2); assert.equal(p3.targets.responseSla, null); assert.equal(p3.deadline.value, null)
  } finally { await t.close() }
})

test('working calendar: working time skips nights and weekends in the organization time zone', () => {
  // Fri 2026-11-13 17:00 UTC; a UTC calendar of Mon-Fri 09:00-18:00.
  const fri17 = Date.parse('2026-11-13T17:00:00Z')
  assert.equal(iso(addWorkingTime(fri17, 1, 'working_hours', DEFAULT_CALENDAR, 'UTC')), '2026-11-13T18:00:00.000Z')
  assert.equal(iso(addWorkingTime(fri17, 2, 'working_hours', DEFAULT_CALENDAR, 'UTC')), '2026-11-16T10:00:00.000Z', 'the second hour is Monday morning')
  assert.equal(iso(addWorkingTime(Date.parse('2026-11-13T08:00:00Z'), 1, 'working_days', DEFAULT_CALENDAR, 'UTC')), '2026-11-13T18:00:00.000Z', 'before opening, a working day is that day’s window')
  // Asia/Kolkata (UTC+5:30): 09:00 IST on Monday is 03:30 UTC.
  assert.equal(iso(addWorkingTime(Date.parse('2026-11-14T10:00:00Z'), 1, 'working_hours', DEFAULT_CALENDAR, 'Asia/Kolkata')), '2026-11-16T04:30:00.000Z')
})

test('organization working calendar is configurable and validated', async () => {
  const { t, s } = await boot()
  try {
    const bad = await t.call('/api/organization', { method: 'PATCH', as: s.admin, body: { name: 'Acme', timezone: 'UTC', workingCalendar: { days: [1], start: '18:00', end: '09:00' } } })
    assert.equal(bad.status, 400)
    const ok = await t.call('/api/organization', { method: 'PATCH', as: s.admin, body: { name: 'Acme', timezone: 'UTC', workingCalendar: { days: [0, 1, 2, 3, 4], start: '08:00', end: '16:00' } } })
    assert.equal(ok.status, 200)
    assert.deepEqual(plain((await t.call('/api/organization', { as: s.admin })).body.workingCalendar), { days: [0, 1, 2, 3, 4], start: '08:00', end: '16:00' })
  } finally { await t.close() }
})

test('requests: a requester who chose no priority leaves it unresolved; approval confirms what the manager chooses', async () => {
  const { t, s } = await boot()
  try {
    const rq = await t.call('/api/requests', { method: 'POST', as: s.employee, body: { title: 'Please fix the build', reason: 'It is slow', expectedOutcome: 'Fast build' } })
    assert.equal(rq.status, 201); assert.equal(rq.body.suggestedPriority, null)
    const ap = await t.call(`/api/requests/${rq.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE', assigneeId: s.employee.id } })
    assert.equal(ap.status, 200)
    const task = t.db.prepare('SELECT * FROM tasks WHERE source_request_id = ?').get(rq.body.id)
    assert.equal(task.priority, null, 'no priority was chosen by anyone'); assert.equal(task.origin, 'REQUEST')
    const rq2 = await t.call('/api/requests', { method: 'POST', as: s.employee, body: { title: 'Urgent one', reason: 'Customers waiting', suggestedPriority: 'HIGH' } })
    assert.equal(rq2.body.suggestedPriority, 'HIGH')
    await t.call(`/api/requests/${rq2.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE', assigneeId: s.employee.id } })
    const task2 = t.db.prepare('SELECT * FROM tasks WHERE source_request_id = ?').get(rq2.body.id)
    assert.equal(task2.priority, 'HIGH')
    const ev = t.db.prepare(`SELECT source FROM task_parameter_events WHERE task_id = ? AND field = 'priority'`).get(task2.id)
    assert.equal(ev.source, 'REQUEST_APPROVAL', 'the approving manager confirmed the requester’s suggestion')
  } finally { await t.close() }
})

// ---------- migration 011 on populated data ----------
test('migration 011 keeps existing tasks and confirms their values as LEGACY, rebuilding the original baseline from history', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { DatabaseSync } = await import('node:sqlite')
  const { migrate } = await import('../server/db.js')
  const dir = new URL('../server/migrations/', import.meta.url)
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  db.exec('PRAGMA foreign_keys = OFF')
  for (const f of files.filter((x) => x < '011')) { db.exec(readFileSync(new URL(f, dir), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, 'x') }
  db.exec('PRAGMA foreign_keys = ON')
  const ts = '2026-10-01T10:00:00.000Z'
  const run = (sql, ...a) => db.prepare(sql).run(...a)
  run(`INSERT INTO organizations (id, name, join_code, created_at, updated_at) VALUES ('o1','Acme','J1',?,?)`, ts, ts)
  for (const u of ['u1', 'u2']) run(`INSERT INTO users (id, google_sub, email, name, created_at, updated_at) VALUES (?,?,?,?,?,?)`, u, `s-${u}`, `${u}@x.co`, u, ts, ts)
  const task = (id, priority, due, outcome) => run(`INSERT INTO tasks (id, org_id, title, expected_outcome, created_by, assignee_id, priority, status, progress, due_at, status_changed_at, created_at, updated_at) VALUES (?, 'o1', ?, ?, 'u1', 'u2', ?, 'IN_PROGRESS', 10, ?, ?, ?, ?)`, id, `Task ${id}`, outcome, priority, due, ts, ts, ts)
  task('plain', 'HIGH', '2026-12-01T10:00:00.000Z', 'Ship it')
  task('moved', 'CRITICAL', '2026-12-10T10:00:00.000Z', null)
  task('nodue', 'LOW', null, null)
  const ev = (id, task_id, type, data, at) => run(`INSERT INTO task_events (id, org_id, task_id, actor_id, type, data, created_at) VALUES (?, 'o1', ?, 'u1', ?, ?, ?)`, id, task_id, type, JSON.stringify(data), at)
  ev('e1', 'moved', 'priority_changed', { from: 'MEDIUM', to: 'HIGH', reason: 'bigger' }, '2026-10-02T10:00:00.000Z')
  ev('e2', 'moved', 'priority_changed', { from: 'HIGH', to: 'CRITICAL' }, '2026-10-03T10:00:00.000Z')
  ev('e3', 'moved', 'deadline_changed', { from: '2026-11-20T10:00:00.000Z', to: '2026-12-10T10:00:00.000Z', reason: 'slip' }, '2026-10-04T10:00:00.000Z')
  run(`INSERT INTO blockers (id, org_id, task_id, reported_by, description, reported_at) VALUES ('b1','o1','moved','u2','Waiting',?)`, ts)
  const before = plain(db.prepare('SELECT * FROM tasks ORDER BY id').all())
  assert.deepEqual(migrate(db), ['011_manager_led_expectations.sql'])
  const after = plain(db.prepare('SELECT * FROM tasks ORDER BY id').all())
  assert.equal(after.length, 3)
  for (const [i, row] of before.entries()) for (const [k, val] of Object.entries(row)) assert.equal(after[i][k], val, `task ${row.id}.${k} unchanged`)
  assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blockers').get().n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, 3)
  const events = (id, field) => plain(db.prepare('SELECT * FROM task_parameter_events WHERE task_id = ? AND field = ? ORDER BY created_at, rowid').all(id, field))
  // The original baseline is what the manager set first, not the latest value.
  const pri = events('moved', 'priority')
  assert.equal(JSON.parse(pri[0].new_value), 'MEDIUM'); assert.equal(pri[0].source, 'LEGACY'); assert.equal(pri[0].status, 'CONFIRMED'); assert.equal(pri[0].kind, 'CONFIRM')
  assert.deepEqual(pri.slice(1).map((e) => JSON.parse(e.new_value)), ['HIGH', 'CRITICAL']); assert.equal(pri[1].reason, 'bigger')
  const dl = events('moved', 'deadline')
  assert.equal(JSON.parse(dl[0].new_value), '2026-11-20T10:00:00.000Z'); assert.equal(JSON.parse(dl.at(-1).new_value), '2026-12-10T10:00:00.000Z')
  assert.equal(JSON.parse(events('plain', 'priority')[0].new_value), 'HIGH'); assert.equal(JSON.parse(events('plain', 'expected_outcome')[0].new_value), 'Ship it')
  assert.equal(events('nodue', 'deadline').length, 0, 'a task that never had a deadline gets no invented baseline')
  assert.equal(events('moved', 'expected_outcome').length, 0)
  // The rebuilt table accepts NULL priority and the new origin values, and still rejects nonsense.
  run(`INSERT INTO tasks (id, org_id, title, created_by, priority, status, status_changed_at, created_at, updated_at, origin) VALUES ('n1','o1','New','u1',NULL,'ASSIGNED',?,?,?,'SLACK')`, ts, ts, ts)
  assert.throws(() => run(`INSERT INTO tasks (id, org_id, title, created_by, priority, status, status_changed_at, created_at, updated_at) VALUES ('n2','o1','New','u1','URGENT','ASSIGNED',?,?,?)`, ts, ts, ts))
  assert.throws(() => run(`INSERT INTO tasks (id, org_id, title, created_by, priority, status, status_changed_at, created_at, updated_at, origin) VALUES ('n3','o1','New','u1',NULL,'ASSIGNED',?,?,?,'ROBOT')`, ts, ts, ts))
  assert.deepEqual(migrate(db), [], 'running it again changes nothing')
})

test('measurement: the evidence pack carries original and revised expectations, history and change requests; fairness rules are in the prompt', async () => {
  const { buildEvidencePack } = await import('../server/measurement/evidence-pack.js')
  const { systemPrompt, PROMPT_VERSION } = await import('../server/measurement/engine.js')
  const { rubricFor } = await import('../server/measurement/rubric.js')
  const { suggestValues } = await import('../server/services/task-parameters.js')
  const { t, s, make } = await boot()
  try {
    const d1 = iso(Date.now() + 2 * 24 * H); const d2 = iso(Date.now() + 9 * 24 * H)
    const id = (await make({ title: 'Rebuild search', priority: 'MEDIUM', dueAt: d1, expectedOutcome: 'Search under 100ms', complexityExpectation: 'L3', successCriteria: 'p95 < 100ms' })).body.task.id
    await t.call(`/api/tasks/${id}`, { method: 'PATCH', as: s.manager, body: { priority: 'CRITICAL', reason: 'Escalated' } })
    const cr = await t.call(`/api/tasks/${id}/change-requests`, { method: 'POST', as: s.employee, body: { kind: 'DEADLINE', proposed: { dueAt: d2 }, reason: 'Index rebuild takes longer' } })
    await t.call(`/api/change-requests/${cr.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE', note: 'Agreed' } })
    suggestValues(t.db, t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), { workType: 'Search' }, { source: 'EMPLOYEE', actorId: s.employee.id })
    const { pack } = buildEvidencePack(t.db, t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), s.employee.id)
    const e = pack.expectations
    assert.equal(e.priority.original, 'MEDIUM'); assert.equal(e.priority.current, 'CRITICAL'); assert.equal(e.priority.changes, 1)
    assert.equal(e.deadline.original, d1); assert.equal(e.deadline.current, d2); assert.equal(e.deadline.changes, 1)
    assert.equal(e.complexityExpectation, 'L3'); assert.equal(e.successCriteria, 'p95 < 100ms')
    assert.equal(e.changeRequests.length, 1); assert.equal(e.changeRequests[0].status, 'APPROVED'); assert.equal(e.changeRequests[0].kind, 'DEADLINE')
    assert.deepEqual(e.unconfirmed.map((x) => x.field), ['work_type'], 'a proposed value is listed as unconfirmed, not as an expectation')
    assert.equal(pack.task.priorityConfirmed, true)
    // A task with no confirmed priority is handled without inventing one.
    const bare = (await make({ title: 'No priority' })).body.task.id
    const { pack: p2 } = buildEvidencePack(t.db, t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(bare), s.employee.id)
    assert.equal(p2.task.priority, null); assert.equal(p2.task.priorityConfirmed, false); assert.equal(p2.expectations.priority.original, null)
    const prompt = systemPrompt(rubricFor(t.db, s.org.id))
    assert.match(prompt, /ORIGINAL expectations/); assert.match(prompt, /priority is never evidence of complexity, quality or contribution/); assert.match(prompt, /never a reason to lower a rating/)
    assert.equal(PROMPT_VERSION, 'work-eval-2026-11-v5')
  } finally { await t.close() }
})

test('a client cannot claim a provenance: _origin, _confirmSource and _sourceRequestId in a request body are ignored', async () => {
  const { t, s } = await boot()
  try {
    const r = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Spoof', priority: 'HIGH', assigneeId: s.employee.id, _origin: 'SLACK', _confirmSource: 'REQUEST_APPROVAL', _sourceRequestId: 'whatever' } })
    assert.equal(r.status, 201)
    const row = t.db.prepare('SELECT origin, source_request_id FROM tasks WHERE id = ?').get(r.body.task.id)
    assert.equal(row.origin, 'MANAGER'); assert.equal(row.source_request_id, null)
    assert.equal(t.db.prepare(`SELECT source FROM task_parameter_events WHERE task_id = ? AND field = 'priority'`).get(r.body.task.id).source, 'MANAGER')
  } finally { await t.close() }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

const H = 3600000
const D = 24 * H
const iso = (ms) => new Date(ms).toISOString()

async function boot() {
  const t = await startApp()
  const s = seedOrg(t.db)
  const make = async (body, as = s.manager) => (await t.call('/api/tasks', { method: 'POST', as, body: { assigneeId: s.employee.id, ...body } })).body.task
  const team = (q = '', as = s.manager) => t.call(`/api/analytics/team${q}`, { as })
  const impact = (taskId, userId, extra = {}) => t.db.prepare(`INSERT INTO impact_records (id, org_id, user_id, task_id, title, category, previous_state, work_performed, result, value_type, measurable_value, measurement_unit, shared_outcome_key, verification_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Outcome', 'TIME_SAVED', 'slow', 'fixed', 'fast', 'MEASURED', 10, 'hours', ?, ?, ?, ?)`).run(`imp-${Math.random().toString(36).slice(2)}`, s.org.id, userId, taskId, extra.key ?? null, extra.status ?? 'VERIFIED', iso(Date.now()), iso(Date.now()))
  return { t, s, make, team, impact }
}

test('team analytics: summaries by priority, complexity expectation, work type and deadline state, with every filter', async () => {
  const { t, s, make, team } = await boot()
  try {
    const a = await make({ title: 'A', priority: 'CRITICAL', dueAt: iso(Date.now() + 2 * D), complexityExpectation: 'L4', workType: 'Incident' })
    const b = await make({ title: 'B', priority: 'LOW', dueAt: iso(Date.now() - 2 * D), complexityExpectation: 'L1', workType: 'Chore', assigneeId: s.employee2.id })
    const c = await make({ title: 'C' }) // no priority, no deadline, no complexity
    await t.call(`/api/tasks/${a.id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    const r = await team()
    assert.equal(r.status, 200)
    const x = r.body.summary
    assert.equal(x.tasks, 3); assert.deepEqual(x.byPriority, { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 1, UNRESOLVED: 1 })
    assert.equal(x.unresolved.priority, 1); assert.equal(x.unresolved.deadline, 1); assert.equal(x.deadlines.confirmed, 2); assert.equal(x.deadlines.notConfirmed, 1)
    assert.equal(x.overdue, 1, 'only the confirmed, passed deadline is overdue'); assert.equal(x.byComplexityExpectation.L4, 1); assert.equal(x.byComplexityExpectation.NOT_ASSESSED, 1)
    assert.equal(x.byWorkType.Incident, 1); assert.equal(x.byWorkType['Not set'], 1); assert.equal(x.byStatus.IN_PROGRESS, 1)
    assert.equal(r.body.ordering, 'alphabetical'); assert.ok(r.body.notes.some((n) => /never a performance score/i.test(n)))
    assert.ok(r.body.people.every((p) => !('rank' in p) && !('score' in p)), 'no ranking and no score')
    const ids = async (q) => (await team(q)).body.tasks.map((y) => y.id).sort()
    assert.deepEqual(await ids('?priority=CRITICAL'), [a.id]); assert.deepEqual(await ids('?priority=UNRESOLVED'), [c.id])
    assert.deepEqual(await ids(`?userId=${s.employee2.id}`), [b.id]); assert.deepEqual(await ids('?complexity=L4'), [a.id]); assert.deepEqual(await ids('?complexity=NOT_ASSESSED'), [c.id])
    assert.deepEqual(await ids('?status=IN_PROGRESS'), [a.id]); assert.deepEqual(await ids('?deadline=OVERDUE'), [b.id]); assert.deepEqual(await ids('?deadline=NOT_CONFIRMED'), [c.id])
    assert.deepEqual(await ids('?workType=chore'), [b.id]); assert.deepEqual(await ids(`?teamId=${s.teamA}`), [a.id, b.id, c.id].sort()); assert.deepEqual(await ids(`?teamId=${s.teamB}`), [])
    assert.deepEqual(await ids(`?from=${encodeURIComponent(iso(Date.now() + 10 * D))}&to=${encodeURIComponent(iso(Date.now() + 20 * D))}`), [], 'a future range matches nothing')
    assert.equal((await team('?priority=URGENT')).status, 400); assert.equal((await team('?from=2026-12-01&to=2026-01-01')).status, 400)
    assert.ok((await team('?teamId=nonsense')).status >= 400 || (await team('?teamId=nonsense')).body.tasks.length === 0)
  } finally { await t.close() }
})

test('team analytics respect scope: other teams, other organizations and employees see nothing they should not', async () => {
  const { t, s, make, team } = await boot()
  try {
    await make({ title: 'Platform work', priority: 'HIGH' })
    assert.equal((await team('', s.manager2)).body.summary.tasks, 0, 'another team’s manager sees none of it')
    assert.equal((await team('', s.admin)).status, 403, 'an admin who manages no team has no team analytics: admin is not manager')
    assert.equal((await team('', s.otherAdmin)).status, 403, 'another organization’s admin sees none of it')
    assert.equal((await team('', s.employee)).status, 403, 'employees have no team analytics')
    assert.equal((await team(`?userId=${s.employee.id}`, s.manager2)).status, 404, 'cannot ask about people outside the scope')
  } finally { await t.close() }
})

test('person analytics: self or the person’s manager, with the measurement profile; tenant and team isolation hold', async () => {
  const { t, s, make } = await boot()
  try {
    await make({ title: 'Mine', priority: 'MEDIUM', dueAt: iso(Date.now() + D), complexityExpectation: 'L2' })
    const person = (uid, as) => t.call(`/api/analytics/person/${uid}`, { as })
    const m = await person(s.employee.id, s.manager)
    assert.equal(m.status, 200); assert.equal(m.body.person.name, 'Eve Employee'); assert.equal(m.body.summary.tasks, 1); assert.equal(m.body.tasks[0].complexityExpectation, 'L2')
    assert.ok(m.body.measurement && 'complexityMix' in m.body.measurement); assert.equal(m.body.viewingOwn, false)
    const own = await person(s.employee.id, s.employee)
    assert.equal(own.status, 200); assert.equal(own.body.viewingOwn, true)
    assert.equal((await person(s.employee.id, s.employee2)).status, 404, 'a colleague cannot read it')
    assert.equal((await person(s.employee.id, s.manager2)).status, 404, 'a manager of another team cannot read it')
    assert.equal((await person(s.employee.id, s.otherAdmin)).status, 404, 'another organization cannot read it')
    assert.ok([400, 404].includes((await person('not-a-user', s.manager)).status), 'a malformed id is refused')
    assert.equal((await t.call(`/api/analytics/person/${s.employee.id}?priority=HIGH`, { as: s.manager })).body.summary.tasks, 0)
  } finally { await t.close() }
})

test('task analytics: original and revised expectations, history, change requests; managers of the task only', async () => {
  const { t, s, make } = await boot()
  try {
    const d1 = iso(Date.now() + 2 * D); const d2 = iso(Date.now() + 6 * D)
    const task = await make({ title: 'Move data', priority: 'MEDIUM', dueAt: d1 })
    await t.call(`/api/tasks/${task.id}`, { method: 'PATCH', as: s.manager, body: { priority: 'HIGH', reason: 'Customer asked' } })
    const cr = await t.call(`/api/tasks/${task.id}/change-requests`, { method: 'POST', as: s.employee, body: { kind: 'DEADLINE', proposed: { dueAt: d2 }, reason: 'Dependency slipped' } })
    await t.call(`/api/change-requests/${cr.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE', note: 'OK' } })
    const r = await t.call(`/api/analytics/task/${task.id}`, { as: s.manager })
    assert.equal(r.status, 200)
    assert.equal(r.body.original.priority, 'MEDIUM'); assert.equal(r.body.original.deadline, d1); assert.equal(r.body.current.priority, 'HIGH'); assert.equal(r.body.current.deadline, d2)
    assert.equal(r.body.task.priorityChanges, 1); assert.equal(r.body.task.deadlineChanges, 1); assert.equal(r.body.task.changeRequests, 1)
    assert.equal(r.body.changeRequests[0].status, 'APPROVED'); assert.equal(r.body.changeRequests[0].requestedBy, 'Eve Employee')
    assert.ok(r.body.history.some((e) => e.field === 'priority' && e.oldValue === 'MEDIUM' && e.value === 'HIGH' && e.reason === 'Customer asked'))
    assert.ok(r.body.journey && Array.isArray(r.body.journey.steps))
    assert.equal((await t.call(`/api/analytics/task/${task.id}`, { as: s.employee })).status, 403)
    assert.equal((await t.call(`/api/analytics/task/${task.id}`, { as: s.manager2 })).status, 404)
    assert.equal((await t.call(`/api/analytics/task/${task.id}`, { as: s.otherAdmin })).status, 404)
  } finally { await t.close() }
})

test('outcomes: verified outcomes count once even when shared; claimed outcomes are not verified', async () => {
  const { t, s, make, team, impact } = await boot()
  try {
    const a = await make({ title: 'Shared A', priority: 'HIGH' })
    const b = await make({ title: 'Shared B', priority: 'HIGH', assigneeId: s.employee2.id })
    const c = await make({ title: 'Claimed only', priority: 'LOW' })
    impact(a.id, s.employee.id, { key: 'launch-2026' }); impact(b.id, s.employee2.id, { key: 'launch-2026' })
    impact(c.id, s.employee.id, { status: 'PENDING' })
    const r = (await team()).body.summary.outcomes
    assert.equal(r.verified, 2, 'two tasks have a verified outcome'); assert.equal(r.distinctVerifiedOutcomes, 1, 'but it is one shared outcome'); assert.equal(r.claimed, 1)
    assert.deepEqual((await team('?outcome=CLAIMED')).body.tasks.map((x) => x.id), [c.id])
    assert.equal((await team('?outcome=VERIFIED')).body.tasks.length, 2)
  } finally { await t.close() }
})

test('a missed deadline is context, not a penalty: approved changes are shown beside it and no score exists', async () => {
  const { t, s, make, team } = await boot()
  try {
    const task = await make({ title: 'Late one', priority: 'HIGH', dueAt: iso(Date.now() + D) })
    t.db.prepare(`UPDATE tasks SET status = 'COMPLETED', completed_at = ? WHERE id = ?`).run(iso(Date.now() + 3 * D), task.id)
    await t.call(`/api/tasks/${task.id}`, { method: 'PATCH', as: s.manager, body: { dueAt: iso(Date.now() + 2 * D), reason: 'Scope grew' } }).catch(() => null)
    const row = (await team()).body.tasks.find((x) => x.id === task.id)
    assert.equal(row.missedDeadline, true); assert.ok(row.deadlineChanges >= 0); assert.equal('score' in row, false)
    const body = JSON.stringify((await team()).body)
    assert.doesNotMatch(body, /"(score|rank|ranking|performance|productivity)"/i)
  } finally { await t.close() }
})

test('dashboard data: health buckets are exclusive and add up, people carry their own status counts, nothing is invented', async () => {
  const { t, s, make, team } = await boot()
  try {
    const mk = (title, extra = {}) => make({ title, priority: 'MEDIUM', ...extra })
    await mk('Overdue one', { dueAt: iso(Date.now() - 2 * D) })
    const blocked = await mk('Blocked one', { dueAt: iso(Date.now() + 9 * D) })
    const onTrack = await mk('On track one', { dueAt: iso(Date.now() + 9 * D) })
    const review = await mk('In review', { dueAt: iso(Date.now() + 9 * D), assigneeId: s.employee2.id })
    await mk('At risk one', { dueAt: iso(Date.now() + 6 * H) })
    const noDeadline = await make({ title: 'No deadline yet' })
    const done = await mk('Done one', { dueAt: iso(Date.now() + 9 * D) })
    const loose = await mk('Nobody yet', { assigneeId: null, dueAt: iso(Date.now() + 9 * D) })
    t.db.prepare(`UPDATE tasks SET status = 'BLOCKED' WHERE id = ?`).run(blocked.id)
    t.db.prepare(`UPDATE tasks SET status = 'SUBMITTED_FOR_REVIEW', submitted_at = ? WHERE id = ?`).run(iso(Date.now()), review.id)
    t.db.prepare(`UPDATE tasks SET status = 'COMPLETED', completed_at = ? WHERE id = ?`).run(iso(Date.now()), done.id)
    t.db.prepare('UPDATE tasks SET last_meaningful_at = ? WHERE id = ?').run('2026-11-10T10:00:00.000Z', onTrack.id)
    void loose
    const d = (await team()).body
    const h = d.summary.health
    assert.deepEqual(h, { onTrack: 3, atRisk: 1, blocked: 1, overdue: 1, unconfirmedDeadline: 1 }, 'on track = open, a confirmed deadline, not overdue, blocked or at risk')
    assert.equal(h.onTrack + h.atRisk + h.blocked + h.overdue + h.unconfirmedDeadline, d.summary.open, 'every open task is in exactly one bucket')
    assert.equal(d.tasks.find((x) => x.id === done.id).health, null, 'a completed task has no health')
    assert.equal(d.tasks.find((x) => x.id === noDeadline.id).health, 'UNCONFIRMED_DEADLINE')
    // People: their own counts, so the stacked bar reconciles with the total once unassigned work is added.
    const eve = d.people.find((p) => p.userId === s.employee.id)
    assert.equal(eve.blocked, 1); assert.equal(eve.byStatus.COMPLETED, 1); assert.equal(eve.lastMeaningfulAt, '2026-11-10T10:00:00.000Z'); assert.equal(typeof eve.health.onTrack, 'number')
    const ed = d.people.find((p) => p.userId === s.employee2.id)
    assert.equal(ed.awaitingReview, 1); assert.equal(ed.lastMeaningfulAt, null, 'no meaningful activity is shown as none, never invented')
    assert.equal(d.unassigned.tasks, 1)
    assert.equal(d.people.reduce((n, p) => n + p.tasks, 0) + d.unassigned.tasks, d.summary.tasks, 'people + unassigned = total')
    // Needs attention: the same definitions, each task once per reason, ordered by urgency; unconfirmed is context, not a fault.
    const a = d.attention
    assert.deepEqual(a.totals, { OVERDUE: 1, REVIEW: 1, CHANGE_REQUEST: 0, BLOCKED: 1, UNCONFIRMED: 1 })
    assert.deepEqual(a.items.map((x) => x.kind), ['OVERDUE', 'REVIEW', 'BLOCKED', 'UNCONFIRMED'])
    assert.equal(a.items[0].title, 'Overdue one'); assert.equal(a.items[0].ownerName, 'Eve Employee'); assert.match(a.items[3].issue, /No confirmed priority or deadline/)
    // A pending change request is listed with its task.
    await t.call(`/api/tasks/${onTrack.id}/change-requests`, { method: 'POST', as: s.employee, body: { kind: 'PRIORITY', proposed: { priority: 'LOW' }, reason: 'Less urgent now' } })
    assert.equal((await team()).body.attention.totals.CHANGE_REQUEST, 1)
    // Another team's manager sees none of it; an employee gets no team view.
    assert.deepEqual((await team('', s.manager2)).body.summary.health, { onTrack: 0, atRisk: 0, blocked: 0, overdue: 0, unconfirmedDeadline: 0 })
    assert.equal((await team('', s.manager2)).body.attention.items.length, 0)
    assert.equal((await team('', s.employee)).status, 403)
  } finally { await t.close() }
})

test('dashboard data: outcomes list counts a shared outcome once and keeps verified apart from claimed; the task view carries progress, people and suggestions', async () => {
  const { t, s, make, team, impact } = await boot()
  try {
    const a = await make({ title: 'Launch A', priority: 'HIGH' })
    const b = await make({ title: 'Launch B', priority: 'HIGH', assigneeId: s.employee2.id })
    const c = await make({ title: 'Claimed only', priority: 'LOW' })
    impact(a.id, s.employee.id, { key: 'launch' }); impact(b.id, s.employee2.id, { key: 'launch' }); impact(c.id, s.employee.id, { status: 'PENDING' })
    impact(c.id, s.employee.id, { status: 'REJECTED' })
    const o = (await team()).body.outcomeList
    assert.equal(o.verified, 1, 'one shared outcome, however many people recorded it'); assert.equal(o.claimed, 1); assert.equal(o.shared, 1)
    const shared = o.items.find((x) => x.shared)
    assert.deepEqual(shared.people.sort(), ['Ed Employee', 'Eve Employee']); assert.equal(shared.state, 'VERIFIED')
    assert.equal(o.items.length, 2, 'rejected records are not listed')
    // The task view.
    t.db.prepare('UPDATE tasks SET progress = 40 WHERE id = ?').run(c.id)
    t.db.prepare(`INSERT INTO task_participants (id, org_id, task_id, user_id, role, source, created_at) VALUES ('p1', ?, ?, ?, 'SUPPORT', 'test', ?)`).run(s.org.id, c.id, s.employee2.id, iso(Date.now()))
    const grant = await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.manager, body: { can_create_directly: true, approval_required: false, can_self_assign: true } })
    assert.equal(grant.status, 200)
    const mine = (await t.call('/api/tasks', { method: 'POST', as: s.employee, body: { title: 'Proposed by Eve', priority: 'HIGH', assigneeId: s.employee.id } })).body.task
    const tv = (await t.call(`/api/analytics/task/${c.id}`, { as: s.manager })).body
    assert.equal(tv.progress, 40); assert.equal(tv.owner.name, 'Eve Employee'); assert.deepEqual(tv.contributors, [{ name: 'Ed Employee', role: 'support' }]); assert.equal(typeof tv.evidenceCount, 'number')
    const pv = (await t.call(`/api/analytics/task/${mine.id}`, { as: s.manager })).body
    assert.equal(pv.suggestions.find((x) => x.field === 'priority').status, 'PROPOSED', 'a proposal is shown as a proposal, never as the current value')
    assert.equal(pv.current.priority, null)
    // The person view carries its own outcome and attention lists, only for people the caller may see.
    const person = (await t.call(`/api/analytics/person/${s.employee.id}`, { as: s.manager })).body
    assert.ok(person.outcomeList.items.length >= 1); assert.ok(Array.isArray(person.recent)); assert.ok('attention' in person)
    assert.equal((await t.call(`/api/analytics/person/${s.employee.id}`, { as: s.manager2 })).status, 404)
  } finally { await t.close() }
})

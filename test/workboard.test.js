// The team workboard: the five-column view of the existing task lifecycle (read-only), its filters, paging, permissions and tenant isolation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg, makeUser, addMember } from './helpers.js'

const H = 3600000
const iso = (ms) => new Date(ms).toISOString()
const titles = (col) => col.tasks.map((x) => x.title).sort()

async function build(t, s) {
  const make = async (title, body = {}, as = s.manager) => (await t.call('/api/tasks', { method: 'POST', as, body: { title, ...body } })).body.task
  const as = (u) => ({ as: u })
  const todo = await make('Todo task', { assigneeId: s.employee.id, priority: 'HIGH', dueAt: iso(Date.now() + 72 * H) })
  const prog = await make('Progress task', { assigneeId: s.employee.id, priority: 'LOW', dueAt: iso(Date.now() + 24 * H) })
  await t.call(`/api/tasks/${prog.id}/status`, { method: 'POST', ...as(s.employee), body: { status: 'IN_PROGRESS' } })
  const late = await make('Late progress task', { assigneeId: s.employee2.id, priority: 'CRITICAL', dueAt: iso(Date.now() + 72 * H) })
  await t.call(`/api/tasks/${late.id}/status`, { method: 'POST', ...as(s.employee2), body: { status: 'IN_PROGRESS' } })
  t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - 5 * H), late.id) // overdue and still in progress
  const blocked = await make('Blocked task', { assigneeId: s.employee.id })
  await t.call(`/api/tasks/${blocked.id}/status`, { method: 'POST', ...as(s.employee), body: { status: 'IN_PROGRESS' } })
  assert.equal((await t.call(`/api/tasks/${blocked.id}/blockers`, { method: 'POST', ...as(s.employee), body: { description: 'Vendor API access', isExternal: true } })).status, 200)
  t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(iso(Date.now() - 2 * H), blocked.id) // overdue AND blocked: counted once as a task
  const review = await make('Review task', { assigneeId: s.employee.id })
  await t.call(`/api/tasks/${review.id}/status`, { method: 'POST', ...as(s.employee), body: { status: 'IN_PROGRESS' } })
  assert.equal((await t.call(`/api/tasks/${review.id}/submit`, { method: 'POST', ...as(s.employee), body: { summary: 'Done', outcome: 'It works' } })).status, 200)
  const doneIds = []
  for (let i = 0; i < 3; i++) {
    const d = await make(`Done task ${i}`, { assigneeId: s.employee.id })
    await t.call(`/api/tasks/${d.id}/status`, { method: 'POST', ...as(s.employee), body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${d.id}/submit`, { method: 'POST', ...as(s.employee), body: { summary: 'Done', outcome: 'Shipped' } })
    assert.equal((await t.call(`/api/tasks/${d.id}/review`, { method: 'POST', ...as(s.manager), body: { decision: 'APPROVED' } })).status, 200)
    t.db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(iso(Date.now() - (3 - i) * H), d.id) // Done task 2 is the most recent
    doneIds.push(d.id)
  }
  const unassigned = await make('Nobody task')
  const pending = await make('Pending acceptance task', { assigneeId: s.employee.id })
  t.db.prepare(`UPDATE tasks SET status = 'PENDING_ACCEPTANCE', acceptance_state = 'pending' WHERE id = ?`).run(pending.id)
  const declined = await make('Declined task', { assigneeId: s.employee.id })
  t.db.prepare(`UPDATE tasks SET status = 'DECLINED', acceptance_state = 'declined' WHERE id = ?`).run(declined.id)
  const cancelled = await make('Cancelled task', { assigneeId: s.employee.id })
  await t.call(`/api/tasks/${cancelled.id}/status`, { method: 'POST', ...as(s.manager), body: { status: 'CANCELLED', reason: 'No longer needed' } })
  return { todo, prog, late, blocked, review, doneIds, unassigned, pending, declined, cancelled }
}

test('every task lands in the column its real status maps to, counts match, overdue is derived and nothing is counted twice', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    await build(t, s)
    const r = await t.call('/api/workboard', { as: s.manager })
    assert.equal(r.status, 200)
    const c = r.body.columns
    assert.deepEqual(titles(c.todo), ['Declined task', 'Nobody task', 'Pending acceptance task', 'Todo task'], 'accepted, awaiting acceptance and declined work waits in To do')
    assert.deepEqual(titles(c.in_progress), ['Late progress task', 'Progress task'])
    assert.deepEqual(titles(c.blocked), ['Blocked task'], 'a blocked task stays blocked even though it is also overdue')
    assert.deepEqual(titles(c.in_review), ['Review task'], 'submitted work is in review, never Done')
    assert.deepEqual(titles(c.done), ['Done task 0', 'Done task 1', 'Done task 2'])
    assert.equal(c.done.tasks[0].title, 'Done task 2', 'most recently completed first')
    for (const k of Object.keys(c)) assert.equal(c[k].count, c[k].tasks.length, `${k} count matches its cards`)
    const all = Object.values(c).flatMap((x) => x.tasks.map((y) => y.id))
    assert.equal(new Set(all).size, all.length, 'a task appears once')
    assert.ok(!all.includes(t.db.prepare(`SELECT id FROM tasks WHERE title = 'Cancelled task'`).get().id), 'cancelled tasks are not on the board')

    // Overdue is a condition, not a status: the overdue tasks sit in their own columns.
    const by = (title) => Object.values(c).flatMap((x) => x.tasks).find((x) => x.title === title)
    assert.equal(by('Late progress task').overdue, true)
    assert.equal(by('Late progress task').column, 'in_progress')
    assert.equal(by('Blocked task').overdue, true)
    assert.equal(by('Blocked task').externalBlocker, true)
    assert.equal(by('Todo task').overdue, false)
    assert.equal(by('Nobody task').overdue, false, 'a missing deadline is never overdue')
    assert.equal(by('Nobody task').dueAt, null)
    assert.equal(by('Nobody task').unassigned, true)
    assert.equal(by('Nobody task').assigneeName, null, 'an unassigned task is not given an owner')
    assert.equal(by('Nobody task').priority, null, 'an unconfirmed priority stays empty')
    assert.equal(by('Pending acceptance task').awaitingAcceptance, true)
    assert.equal(by('Todo task').awaitingAcceptance, false)
    assert.equal(by('Declined task').declined, true)
    assert.equal(by('Review task').status, 'SUBMITTED_FOR_REVIEW')
    assert.ok(!('description' in by('Todo task')), 'the card carries no description')

    // 8 open tasks (todo 4, progress 2, blocked 1, review 1); overdue 2 (one is blocked, one in progress); attention = overdue or blocked = 2 tasks, not 3.
    assert.deepEqual(r.body.metrics, { active: 8, inProgress: 2, blocked: 1, overdue: 2, completed: 3, attention: 2 })
  } finally { await t.close() }
})

test('search, assignee, priority, deadline and metric filters use real task data and combine', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    await build(t, s)
    const get = async (qs, as = s.manager) => (await t.call(`/api/workboard?${qs}`, { as })).body
    const open = (b) => ['todo', 'in_progress', 'blocked', 'in_review'].flatMap((k) => b.columns[k].tasks.map((x) => x.title)).sort()

    assert.deepEqual(open(await get('q=progress')), ['Late progress task', 'Progress task'])
    assert.deepEqual((await get('q=progress')).columns.done.tasks, [], 'search narrows Done as well')
    assert.deepEqual(open(await get(`assigneeId=${s.employee2.id}`)), ['Late progress task'])
    assert.deepEqual(open(await get('assigneeId=none')), ['Nobody task'])
    assert.deepEqual(open(await get('priority=HIGH')), ['Todo task'])
    assert.deepEqual(open(await get('priority=unresolved')).includes('Nobody task'), true)
    assert.deepEqual(open(await get('deadline=overdue')), ['Blocked task', 'Late progress task'])
    assert.deepEqual(open(await get('deadline=none')).includes('Nobody task'), true)
    assert.equal(open(await get('deadline=week')).includes('Nobody task'), false, 'no deadline is not "due this week"')
    assert.deepEqual(open(await get('deadline=week')).sort(), ['Progress task', 'Todo task'].sort())

    const active = await get('kpi=active')
    assert.equal(open(active).length, 8, 'Active is every non-completed card')
    assert.equal(active.columns.done.skipped, true, 'metrics describe open work; Done is left out')
    assert.deepEqual(open(await get('kpi=in_progress')), ['Late progress task', 'Progress task'])
    assert.deepEqual(open(await get('kpi=blocked')), ['Blocked task'])
    const comp = await get('kpi=completed')
    assert.equal(open(comp).length, 0, 'Completed shows no open work')
    assert.equal(comp.columns.done.count, 3, 'Completed shows the Done column')
    assert.deepEqual(open(await get('kpi=overdue')), ['Blocked task', 'Late progress task'], 'overdue spans statuses')
    assert.deepEqual(open(await get('kpi=overdue&assigneeId=' + s.employee2.id)), ['Late progress task'], 'a metric combines with the other filters')
    assert.equal((await get('kpi=overdue')).metrics.active, 8, 'metrics always describe the whole scope, not the filtered view')

    for (const bad of ['kpi=nope', 'deadline=soon', 'priority=urgent', 'assigneeId=x', 'doneLimit=0', 'doneOffset=-1']) assert.equal((await t.call(`/api/workboard?${bad}`, { as: s.manager })).status, 400, bad)
  } finally { await t.close() }
})

test('Done is paged, newest first, and never loads the whole history', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const { doneIds } = await build(t, s)
    const page1 = (await t.call('/api/workboard?doneLimit=2', { as: s.manager })).body.columns.done
    assert.equal(page1.count, 3)
    assert.equal(page1.tasks.length, 2)
    assert.equal(page1.hasMore, true)
    assert.equal(page1.tasks[0].id, doneIds[2])
    const page2 = (await t.call('/api/workboard?doneLimit=2&doneOffset=2', { as: s.manager })).body.columns.done
    assert.deepEqual(page2.tasks.map((x) => x.id), [doneIds[0]])
    assert.equal(page2.hasMore, false)
    assert.equal((await t.call('/api/workboard?doneLimit=9999', { as: s.manager })).status, 200, 'an oversized page is clamped, not trusted')
  } finally { await t.close() }
})

test('permissions and tenant isolation are enforced on the server', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    await build(t, s)
    // The outsider (another team) and the other manager see none of team A's work; another organization never sees it.
    const mine = async (u) => (await t.call('/api/workboard', { as: u })).body
    const count = (b) => Object.values(b.columns).reduce((n, c) => n + c.tasks.length, 0)
    assert.equal(count(await mine(s.outsider)), 0)
    assert.equal(count(await mine(s.manager2)), 0)
    assert.equal(count(await mine(s.otherAdmin)), 0)
    assert.equal((await mine(s.otherAdmin)).metrics.active, 0)

    // An employee sees only their own tasks: not a colleague's, not the unassigned one, and no one else's name in the assignee list.
    const ev = await mine(s.employee)
    const evTitles = Object.values(ev.columns).flatMap((c) => c.tasks.map((x) => x.title))
    assert.ok(!evTitles.includes('Late progress task') && !evTitles.includes('Nobody task'))
    assert.ok(evTitles.includes('Todo task'))
    assert.ok(ev.people.every((p) => p.userId === s.employee.id))
    assert.ok(Object.values(ev.columns).flatMap((c) => c.tasks).every((x) => x.canManage === false))
    // Passing someone else's id as a filter widens nothing.
    const peek = (await t.call(`/api/workboard?assigneeId=${s.employee2.id}`, { as: s.employee })).body
    assert.equal(count(peek), 0)

    // A task of another organization cannot be reached by a filter or by guessing.
    const other = makeUser(t.db, { name: 'Gina Globex' })
    addMember(t.db, s.otherOrg.id, other, 'manager', null)
    assert.equal((await t.call('/api/workboard', { as: { cookie: '' } })).status, 401)
  } finally { await t.close() }
})

test('moving cards cannot bypass acceptance, submission or manager approval (the existing transition rules decide)', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const k = await build(t, s)
    const move = (id, status, as, reason) => t.call(`/api/tasks/${id}/status`, { method: 'POST', as, body: { status, reason } })
    // To do → In progress is the owner's move only.
    assert.equal((await move(k.todo.id, 'IN_PROGRESS', s.manager)).status, 403, 'a manager cannot start somebody else’s work')
    assert.equal((await move(k.todo.id, 'IN_PROGRESS', s.employee2)).status, 404, 'a stranger cannot even see it')
    assert.equal((await move(k.todo.id, 'IN_PROGRESS', s.employee)).status, 200)
    assert.equal((await move(k.todo.id, 'ASSIGNED', s.employee)).status, 200, 'and back to To do')
    // Awaiting acceptance cannot be started by dragging; it goes through accept.
    assert.equal((await move(k.pending.id, 'IN_PROGRESS', s.employee)).status, 409)
    assert.equal((await move(k.pending.id, 'ASSIGNED', s.manager)).status, 409)
    // Nothing can be dragged into Blocked, In review or Done.
    assert.equal((await move(k.prog.id, 'BLOCKED', s.employee)).status, 400)
    assert.equal((await move(k.prog.id, 'SUBMITTED_FOR_REVIEW', s.employee)).status, 400)
    assert.equal((await move(k.review.id, 'COMPLETED', s.employee)).status, 400)
    assert.equal((await move(k.review.id, 'COMPLETED', s.manager)).status, 400, 'not even a manager skips the review')
    assert.equal((await move(k.review.id, 'IN_PROGRESS', s.manager)).status, 409, 'In review → In progress is a review decision, not a drag')
    // Blocked stays blocked until the blocker is resolved.
    assert.equal((await move(k.blocked.id, 'IN_PROGRESS', s.employee)).status, 409)
    // Reopening a Done task is a manager decision with a reason.
    assert.equal((await move(k.doneIds[0], 'IN_PROGRESS', s.employee)).status, 403)
    assert.equal((await move(k.doneIds[0], 'IN_PROGRESS', s.manager)).status, 400, 'a reason is required')
    assert.equal((await move(k.doneIds[0], 'IN_PROGRESS', s.manager, 'Regression found')).status, 200)
    const after = (await t.call('/api/workboard', { as: s.manager })).body.columns
    assert.ok(titles(after.in_progress).includes('Done task 0'), 'a reopened task follows its real status back to In progress')
    assert.equal(after.done.count, 2)
    assert.ok(t.db.prepare(`SELECT 1 FROM task_events WHERE task_id = ? AND type = 'reopened'`).get(k.doneIds[0]), 'the reopening is in the audit trail')
    // The refused moves changed nothing.
    assert.equal(t.db.prepare('SELECT status FROM tasks WHERE id = ?').get(k.review.id).status, 'SUBMITTED_FOR_REVIEW')
    assert.equal(t.db.prepare('SELECT status FROM tasks WHERE id = ?').get(k.pending.id).status, 'PENDING_ACCEPTANCE')
  } finally { await t.close() }
})

test('the board reports the organization timezone its date buckets and labels use', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/workboard', { as: s.manager })
    assert.equal(r.body.timezone, 'UTC')
    t.db.prepare('UPDATE organizations SET settings = ? WHERE id = ?').run(JSON.stringify({ timezone: 'Pacific/Kiritimati' }), s.org.id) // UTC+14
    assert.equal((await t.call('/api/workboard', { as: s.manager })).body.timezone, 'Pacific/Kiritimati')
  } finally { await t.close() }
})

test('the reviewer path (profile → assessment) is limited to the people a reviewer is responsible for, and never to other organizations', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const k = await build(t, s)
    const get = (path, as) => t.call(path, { as }).then((r) => r.status)
    // The team's manager reviews their own team's people and tasks.
    assert.equal(await get(`/api/contribution/people/${s.employee.id}`, s.manager), 200)
    assert.equal(await get(`/api/tasks/${k.todo.id}/assessment`, s.manager), 200)
    // An admin sees the whole organization; a manager of another team, another organization and a colleague see nothing of this person.
    assert.equal(await get(`/api/contribution/people/${s.employee.id}`, s.admin), 200)
    for (const who of [s.manager2, s.otherAdmin, s.employee2, s.outsider]) assert.equal(await get(`/api/contribution/people/${s.employee.id}`, who), 404, 'out of scope answers 404, not 403')
    for (const who of [s.manager2, s.otherAdmin, s.employee2]) assert.equal(await get(`/api/tasks/${k.todo.id}/assessment`, who), 404)
    // A person sees their own profile (and so can correct it), but the team views are for managers.
    assert.equal(await get(`/api/contribution/people/${s.employee.id}`, s.employee), 200)
    assert.equal(await get('/api/contribution/intelligence', s.employee), 403)
    // Reviewing is not editing the employee's side: a manager cannot answer on the employee's behalf, nor can the employee approve.
    assert.equal((await t.call(`/api/tasks/${k.todo.id}/assessment/respond`, { method: 'POST', as: s.manager, body: { action: 'CONFIRM' } })).status, 403)
    assert.equal((await t.call(`/api/tasks/${k.todo.id}/assessment/review`, { method: 'POST', as: s.employee, body: { action: 'APPROVE' } })).status, 403)
    // Roles are only admin, manager and employee: there is no mentor or captain role in the data model.
    assert.throws(() => t.db.prepare(`UPDATE memberships SET role = 'mentor' WHERE user_id = ?`).run(s.employee.id), /constraint/i)
  } finally { await t.close() }
})

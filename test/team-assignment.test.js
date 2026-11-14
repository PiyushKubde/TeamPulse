// An existing employee created without a team can later be assigned one; the manager then sees them and their work;
// another team's manager and the admin-as-admin do not get that team's work.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg, makeUser, addMember } from './helpers.js'

test('unassigned employee → admin assigns team → manager sees them and their task; isolation holds', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const late = makeUser(t.db, { name: 'Late Joiner' })
    addMember(t.db, s.org.id, late, 'employee', null)

    // Admin sees them as unassigned; the org summary says so.
    const sys = await t.call('/api/admin/system', { as: s.admin })
    assert.equal(sys.body.organization.unassigned, 1)
    const members = (await t.call('/api/members', { as: s.admin })).body
    assert.equal(members.find((m) => m.userId === late.id).teamId, null)

    // Manager of Platform does not see them yet.
    const before = (await t.call('/api/members', { as: s.manager })).body.filter((m) => m.inScope).map((m) => m.userId)
    assert.ok(!before.includes(late.id))

    // Cross-org and non-admin assignment are refused.
    assert.equal((await t.call(`/api/members/${late.id}`, { method: 'PATCH', as: s.admin, body: { teamId: s.otherOrg.teamId || s.otherOrg.id } })).status, 404)
    assert.equal((await t.call(`/api/members/${late.id}`, { method: 'PATCH', as: s.employee, body: { teamId: s.teamA } })).status, 403)
    assert.equal((await t.call(`/api/members/${late.id}`, { method: 'PATCH', as: s.manager2, body: { teamId: s.teamB } })).status, 403)

    // Admin assigns; exactly one membership remains.
    assert.equal((await t.call(`/api/members/${late.id}`, { method: 'PATCH', as: s.admin, body: { teamId: s.teamA } })).status, 200)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get(late.id).n, 1)
    const after = (await t.call('/api/members', { as: s.manager })).body.filter((m) => m.inScope).map((m) => m.userId)
    assert.ok(after.includes(late.id))

    // Manager assigns a task; the employee sees it; the manager sees it in the team view.
    const made = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Late task', assigneeId: late.id } })
    assert.equal(made.status, 201)
    assert.ok((await t.call('/api/tasks?view=mine', { as: late })).body.some((x) => x.title === 'Late task'))
    assert.ok((await t.call(`/api/tasks?assigneeId=${late.id}`, { as: s.manager })).body.some((x) => x.title === 'Late task'))
    const team = (await t.call('/api/contribution/team', { as: s.manager })).body
    assert.ok(JSON.stringify(team).includes(late.id))

    // Another team's manager and the admin (not managing this team) cannot read it.
    assert.equal((await t.call(`/api/tasks/${made.body.task.id}`, { as: s.manager2 })).status, 404)
    assert.equal((await t.call(`/api/tasks/${made.body.task.id}`, { as: s.admin })).status, 404)

    // Transfer: task history stays with the person; the new team's manager takes over visibility.
    assert.equal((await t.call(`/api/members/${late.id}`, { method: 'PATCH', as: s.admin, body: { teamId: s.teamB } })).status, 200)
    assert.equal((await t.call(`/api/tasks/${made.body.task.id}`, { as: s.manager2 })).status, 200)
    assert.ok((await t.call('/api/tasks?view=mine', { as: late })).body.some((x) => x.title === 'Late task'))
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get(late.id).n, 1)
  } finally { await t.close() }
})

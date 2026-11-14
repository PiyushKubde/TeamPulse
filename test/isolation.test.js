import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

test('organization isolation: another org’s admin sees nothing of this org', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const task = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Secret roadmap', assigneeId: s.employee.id, priority: 'HIGH' } })
    assert.equal(task.status, 201)
    const id = task.body.task.id
    for (const path of [`/api/tasks/${id}`]) assert.equal((await t.call(path, { as: s.otherAdmin })).status, 404)
    assert.equal((await t.call('/api/tasks', { as: s.otherAdmin })).body.length, 0)
    assert.equal((await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.otherAdmin, body: { status: 'CANCELLED', reason: 'x' } })).status, 404)
    assert.equal((await t.call(`/api/tasks/${id}/comments`, { method: 'POST', as: s.otherAdmin, body: { body: 'hi' } })).status, 404)
    const members = await t.call('/api/members', { as: s.otherAdmin })
    assert.ok(members.body.every((m) => m.name === 'Zed OtherOrg'))
    // Cannot assign across organizations either.
    const cross = await t.call('/api/tasks', { method: 'POST', as: s.otherAdmin, body: { title: 'x', assigneeId: s.employee.id } })
    assert.equal(cross.status, 400)
    assert.equal((await t.call(`/api/permissions/${s.employee.id}`, { method: 'PATCH', as: s.otherAdmin, body: { can_create_tasks: true } })).status, 404)
  } finally { await t.close() }
})

test('manager scope: a manager cannot see or manage another team’s people or tasks', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const sales = await t.call('/api/tasks', { method: 'POST', as: s.manager2, body: { title: 'Sales deck', assigneeId: s.outsider.id } })
    assert.equal(sales.status, 201)
    assert.equal((await t.call(`/api/tasks/${sales.body.task.id}`, { as: s.manager })).status, 404)
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Poach', assigneeId: s.outsider.id } })).status, 403)
    assert.equal((await t.call(`/api/permissions/${s.outsider.id}`, { method: 'PATCH', as: s.manager, body: { can_create_tasks: true } })).status, 403)
    const perms = await t.call('/api/permissions', { as: s.manager })
    assert.deepEqual(perms.body.map((p) => p.name).sort(), ['Ed Employee', 'Eve Employee'])
    // An admin runs the organization but is not a manager: no authority over a team's work unless assigned to manage that team.
    assert.equal((await t.call(`/api/tasks/${sales.body.task.id}`, { as: s.admin })).status, 404)
    assert.equal((await t.call('/api/reports/workload', { as: s.admin })).status, 403)
    // Employees see only their own work.
    assert.equal((await t.call(`/api/tasks/${sales.body.task.id}`, { as: s.employee })).status, 404)
    // Reports and team endpoints are manager-only.
    assert.equal((await t.call('/api/reports/workload', { as: s.employee })).status, 403)
    assert.equal((await t.call('/api/permissions', { as: s.employee })).status, 403)
    assert.equal((await t.call('/api/teams', { method: 'POST', as: s.manager, body: { name: 'Shadow' } })).status, 403)
  } finally { await t.close() }
})

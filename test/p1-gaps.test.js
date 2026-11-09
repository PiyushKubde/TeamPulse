import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

const H = 3600000
test('employee dashboard shows completed tasks separately', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Done one', assigneeId: s.employee.id } })
    await t.call(`/api/tasks/${c.body.task.id}/submit`, { method: 'POST', as: s.employee, body: { summary: 's', outcome: 'o' } })
    await t.call(`/api/tasks/${c.body.task.id}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED' } })
    const d = await t.call('/api/dashboard', { as: s.employee })
    assert.equal(d.body.personal.counts.completed, 1)
    assert.deepEqual(d.body.personal.completed.map((x) => x.title), ['Done one'])
    assert.equal(d.body.personal.counts.active, 0, 'completed is not counted as active')
  } finally { await t.close() }
})

test('manager sees per-person help signals (not a ranking); only people in scope', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const a = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Late', assigneeId: s.employee.id } })
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(new Date(Date.now() - H).toISOString(), a.body.task.id)
    const b = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Stuck', assigneeId: s.employee2.id } })
    await t.call(`/api/tasks/${b.body.task.id}/blockers`, { method: 'POST', as: s.employee2, body: { description: 'Waiting for access' } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager2, body: { title: 'Other team', assigneeId: s.outsider.id } })
    const d = await t.call('/api/dashboard', { as: s.manager })
    const names = d.body.manager.needsHelp.map((p) => p.name).sort()
    assert.deepEqual(names, ['Ed Employee', 'Eve Employee'])
    assert.ok(d.body.manager.needsHelp.find((p) => p.name === 'Eve Employee').reasons.some((r) => r.kind === 'overdue'))
    assert.ok(d.body.manager.needsHelp.find((p) => p.name === 'Ed Employee').reasons.some((r) => r.kind === 'blocked'))
    assert.equal('score' in d.body.manager.needsHelp[0], false)
  } finally { await t.close() }
})

test('weekly summary exports as CSV', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/reports/weekly.csv', { as: s.manager })
    assert.equal(r.status, 200)
    assert.match(r.text, /^section,person,item,detail,status/)
    assert.equal((await t.call('/api/reports/weekly.csv', { as: s.employee })).status, 403)
  } finally { await t.close() }
})

test('flow run history only for the user’s own recorded flows; contexts filtered by role and app', async () => {
  const runs = []
  const vs = { configured: true, flowRuns: async (u, id) => { runs.push({ u, id }); return [{ id: 'h1', status: 'success', createdAt: '2026-11-09T10:00:00Z' }, { id: 'h2', status: 'failed', error: 'Sheet not found', createdAt: '2026-11-09T09:00:00Z' }] }, listFlows: async () => [{ id: 'scriMine', status: 'active', title: 'Mine', webhook: 'https://flow.sokt.io/func/scriMine' }] }
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    await t.call('/api/viasocket/embed-flows/scriMine/sync', { method: 'POST', as: s.employee, body: { context: 'task_assigned_to_me' } })
    const r = await t.call('/api/viasocket/embed-flows/scriMine/runs', { as: s.employee })
    assert.deepEqual(r.body.map((x) => x.status), ['success', 'failed'])
    assert.equal(r.body[1].error, 'Sheet not found')
    assert.equal((await t.call('/api/viasocket/embed-flows/scriMine/runs', { as: s.employee2 })).status, 404, 'another user cannot read it')
    assert.equal(runs.length, 1)
    const ec = await t.call('/api/viasocket/contexts?app=github', { as: s.employee })
    assert.deepEqual(ec.body, [], 'GitHub builder is manager-only')
    const mc = await t.call('/api/viasocket/contexts?app=github', { as: s.manager })
    assert.deepEqual(mc.body.map((c) => c.key), ['task_completed_in_my_team'])
    assert.deepEqual((await t.call('/api/viasocket/contexts?app=google-calendar', { as: s.employee })).body.map((c) => c.key), ['task_assigned_to_me'])
  } finally { await t.close() }
})

test('intake refuses to switch on until it has read a real message it can map', async () => {
  let sample = {}
  const vs = {
    configured: true, serviceIdFor: async () => 'rowo0bqrhj5g', versions: async () => ({ service: { auth_type: 'Auth2.0' } }),
    listConnections: async (u) => [{ id: `auth_${u.slice(0, 4)}`, service_id: 'rowo0bqrhj5g', isExpired: false }],
    listOptions: async () => ({ options: [{ label: 'TeamPulse', value: 'Label_7' }] }),
    sampleEvent: async () => sample, subscribe: async () => ({ scriptId: 'scriSub' })
  }
  const t = await startApp({ vs, cfgOverrides: { appUrl: 'https://teampulse.test' } })
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/viasocket/connections', { method: 'POST', as: s.manager, body: { app: 'gmail', authId: `auth_${s.manager.id.slice(0, 4)}` } })
    const body = { app: 'gmail', connectionId: c.body.id, target: 'Label_7' }
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body })).body.error.code, 'no_sample')
    sample = { weird: 'shape' }
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body })).body.error.code, 'unmapped_sample')
    sample = { id: 'm9', subject: 'Real subject', from: 'a@b.co', snippet: 'x' }
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body })).status, 201)
  } finally { await t.close() }
})

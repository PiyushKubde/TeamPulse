import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

test('suggest → clarify → answer → approve creates an official task; request and task statuses stay separate', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    assert.equal((await t.call('/api/requests', { method: 'POST', as: s.employee, body: { title: 'No reason' } })).status, 400)
    const r = await t.call('/api/requests', { method: 'POST', as: s.employee, body: { title: 'Automate invoices', description: 'Script it', reason: 'Saves 5h/week', expectedOutcome: 'Invoices in 1 click', suggestedPriority: 'HIGH', suggestedDueAt: '2026-12-01' } })
    assert.equal(r.status, 201)
    const id = r.body.id
    assert.equal((await t.call(`/api/requests/${id}`, { as: s.manager2 })).status, 404, 'other team manager cannot see it')
    assert.equal((await t.call(`/api/requests/${id}/decision`, { method: 'POST', as: s.employee, body: { decision: 'APPROVE' } })).status, 403)
    const q = await t.call(`/api/requests/${id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'CLARIFY', note: 'Which system?' } })
    assert.equal(q.body.status, 'CLARIFICATION_REQUESTED')
    const ans = await t.call(`/api/requests/${id}`, { method: 'PATCH', as: s.employee, body: { description: 'Script it in the billing system' } })
    assert.equal(ans.body.status, 'PENDING')
    const ok = await t.call(`/api/requests/${id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'APPROVE', assigneeId: s.employee.id } })
    assert.equal(ok.body.status, 'APPROVED')
    assert.equal(ok.body.task.status, 'ASSIGNED')
    assert.equal(ok.body.task.assigneeId, s.employee.id)
    assert.equal(ok.body.task.priority, 'HIGH')
    assert.equal(ok.body.task.sourceRequestId, id)
    assert.equal((await t.call(`/api/requests/${id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'REJECT', note: 'x' } })).status, 409)
    const notes = await t.call('/api/notifications', { as: s.employee })
    assert.ok(notes.body.notifications.some((n) => n.title.startsWith('Request approved')))
  } finally { await t.close() }
})

test('reject requires a reason; withdraw by requester only', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const a = await t.call('/api/requests', { method: 'POST', as: s.employee, body: { title: 'A', reason: 'r' } })
    assert.equal((await t.call(`/api/requests/${a.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'REJECT' } })).status, 400)
    const rej = await t.call(`/api/requests/${a.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'REJECT', note: 'Out of scope this quarter' } })
    assert.equal(rej.body.status, 'REJECTED')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0)
    const b = await t.call('/api/requests', { method: 'POST', as: s.employee, body: { title: 'B', reason: 'r' } })
    assert.equal((await t.call(`/api/requests/${b.body.id}/withdraw`, { method: 'POST', as: s.manager })).status, 403)
    assert.equal((await t.call(`/api/requests/${b.body.id}/withdraw`, { method: 'POST', as: s.employee })).body.status, 'WITHDRAWN')
  } finally { await t.close() }
})

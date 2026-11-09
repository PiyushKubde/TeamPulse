import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

const record = (over = {}) => ({ title: 'Faster deploys', category: 'TIME_SAVED', previousState: 'Deploys took 40 min', workPerformed: 'Parallelised CI', result: 'Deploys take 12 min', valueType: 'MEASURED', measurableValue: 28, measurementUnit: 'min per deploy', ...over })

test('impact: submit, verification separate from completion, reasons for rejection, no self-verification', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/impact', { method: 'POST', as: s.employee, body: record({ evidenceLinks: [{ url: 'https://ci.example.com/run/1' }] }) })
    assert.equal(r.status, 201)
    assert.equal(r.body.verificationStatus, 'PENDING')
    assert.equal(r.body.evidence.length, 1)
    assert.equal((await t.call(`/api/impact/${r.body.id}`, { as: s.employee2 })).status, 404, 'peers do not see it')
    assert.equal((await t.call(`/api/impact/${r.body.id}`, { as: s.manager2 })).status, 404, 'other managers do not see it')
    assert.equal((await t.call(`/api/impact/${r.body.id}/verification`, { method: 'POST', as: s.employee, body: { decision: 'VERIFIED' } })).status, 403)
    assert.equal((await t.call(`/api/impact/${r.body.id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'REJECTED' } })).status, 400)
    const rej = await t.call(`/api/impact/${r.body.id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'REJECTED', comment: 'Need the before/after CI timings' } })
    assert.equal(rej.body.verificationStatus, 'REJECTED')
    assert.equal(rej.body.rejectionReason, 'Need the before/after CI timings')
    const edit = await t.call(`/api/impact/${r.body.id}`, { method: 'PATCH', as: s.employee, body: { result: 'Deploys take 12 min (median of 50 runs)' } })
    assert.equal(edit.body.verificationStatus, 'PENDING', 'editing re-submits')
    const ver = await t.call(`/api/impact/${r.body.id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'VERIFIED' } })
    assert.equal(ver.body.verificationStatus, 'VERIFIED')
    assert.equal(ver.body.reviews.length, 2)
    assert.equal((await t.call(`/api/impact/${r.body.id}`, { method: 'PATCH', as: s.employee, body: { title: 'x' } })).status, 409)
    const mgrOwn = await t.call('/api/impact', { method: 'POST', as: s.manager, body: record() })
    assert.equal((await t.call(`/api/impact/${mgrOwn.body.id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'VERIFIED' } })).status, 403)
  } finally { await t.close() }
})

test('measurement rules: no invented values, estimates labelled, learning carries no value, shared outcomes count once', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    assert.equal((await t.call('/api/impact', { method: 'POST', as: s.employee, body: record({ measurableValue: null }) })).status, 400)
    assert.equal((await t.call('/api/impact', { method: 'POST', as: s.employee, body: record({ measurementUnit: '' }) })).status, 400)
    const none = await t.call('/api/impact', { method: 'POST', as: s.employee, body: record({ valueType: 'NONE', measurableValue: 999, measurementUnit: 'x' }) })
    assert.equal(none.body.measurableValue, null, 'a value is dropped when the kind is none')
    assert.equal((await t.call('/api/impact', { method: 'POST', as: s.employee, body: record({ outcomeType: 'LEARNING' }) })).status, 400)
    const learn = await t.call('/api/impact', { method: 'POST', as: s.employee, body: record({ title: 'Tried edge caching', outcomeType: 'LEARNING', valueType: 'NONE', result: 'Did not help; ruled out' }) })
    assert.equal(learn.status, 201)
    const est = await t.call('/api/impact', { method: 'POST', as: s.employee, body: record({ title: 'Churn fix', category: 'REVENUE_GROWTH', valueType: 'ESTIMATED', measurableValue: 50000, measurementUnit: '₹/month', sharedOutcomeKey: 'churn-q4' }) })
    assert.equal(est.body.isEstimate, true)
    const est2 = await t.call('/api/impact', { method: 'POST', as: s.employee2, body: record({ title: 'Churn fix (my part)', category: 'REVENUE_GROWTH', valueType: 'ESTIMATED', measurableValue: 50000, measurementUnit: '₹/month', sharedOutcomeKey: 'churn-q4' }) })
    for (const id of [est.body.id, est2.body.id, learn.body.id]) await t.call(`/api/impact/${id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'VERIFIED' } })
    const sum = await t.call('/api/impact-summary', { as: s.manager })
    const rev = sum.body.verifiedTotals.filter((x) => x.category === 'REVENUE_GROWTH')
    assert.equal(rev.length, 1)
    assert.equal(rev[0].total, 50000, 'shared outcome counted once')
    assert.equal(rev[0].valueType, 'ESTIMATED')
    const eve = sum.body.people.find((p) => p.name === 'Eve Employee')
    assert.equal(eve.learning, 1)
    assert.equal('score' in eve, false, 'no single productivity score')
  } finally { await t.close() }
})

test('weekly view documents missed commitments and does not count external blockers against the person', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const monday = new Date()
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
    monday.setUTCHours(0, 0, 0, 0)
    const due = new Date(Math.min(monday.getTime() + 3600000, Date.now() - 60000)).toISOString()
    const a = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Vendor API', assigneeId: s.employee.id } })
    const b = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Docs', assigneeId: s.employee2.id } })
    t.db.prepare('UPDATE tasks SET due_at = ?').run(due)
    await t.call(`/api/tasks/${a.body.task.id}/blockers`, { method: 'POST', as: s.employee, body: { description: 'Vendor sandbox down', isExternal: true } })
    const w = await t.call(`/api/reports/weekly?weekStart=${monday.toISOString().slice(0, 10)}`, { as: s.manager })
    assert.equal(w.status, 200)
    const vendor = w.body.missedCommitments.find((m) => m.task === 'Vendor API')
    assert.equal(vendor.countedAgainstPerson, false)
    assert.match(vendor.reasons[0], /external dependency/)
    assert.equal(w.body.missedCommitments.find((m) => m.task === 'Docs').countedAgainstPerson, true)
    assert.equal(w.body.unresolvedBlockers.length, 1)
    void b
  } finally { await t.close() }
})

// The contribution record (the existing impact record, presented as a contribution): partial records, the four honest states, audit,
// duplicates, dates, permissions, and the product rule that volume is never value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

const H = 3600000
const full = (over = {}) => ({ title: 'Removed the race in checkout reservations', category: 'RELIABILITY', previousState: 'Some orders were charged twice under load', workPerformed: 'Traced it to a reservation race and added an idempotent token', result: 'No double charges in staging load tests', ...over })

test('a short record is accepted; an empty one is not; records are dated, audited and not repeated', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const post = (body, as = s.employee) => t.call('/api/impact', { method: 'POST', as, body })
    // Partial: a title, a category and one sentence.
    const short = await post({ title: 'Wrote the on-call runbook', category: 'KNOWLEDGE_INNOVATION', workPerformed: 'Documented the top five P2 playbooks' })
    assert.equal(short.status, 201)
    assert.equal(short.body.previousState, '', 'what was not written stays empty: nothing is filled in')
    assert.equal(short.body.stage, 'CLAIMED')
    // Nothing to show at all: refused. Evidence alone is enough to start.
    assert.equal((await post({ title: 'Something', category: 'RELIABILITY' })).status, 400)
    const onlyEvidence = await post({ title: 'Dashboard for queue depth', category: 'OPERATIONAL_EFFICIENCY', evidenceLinks: [{ url: 'https://grafana.example.com/d/queues' }] })
    assert.equal(onlyEvidence.status, 201)
    assert.equal(onlyEvidence.body.stage, 'SUPPORTED')
    // The same contribution is not recorded twice.
    const again = await post({ title: '  wrote the ON-CALL runbook ', category: 'KNOWLEDGE_INNOVATION', workPerformed: 'Again' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'duplicate_contribution')
    // The date of the contribution: optional, never in the future or more than a year back; the record is dated by it.
    const day = new Date(Date.now() - 5 * 24 * H).toISOString().slice(0, 10)
    const dated = await post(full({ title: 'Dated work', contributedOn: day }))
    assert.equal(dated.status, 201)
    assert.equal(dated.body.createdAt.slice(0, 10), day)
    assert.equal((await post(full({ title: 'Future work', contributedOn: new Date(Date.now() + 3 * 24 * H).toISOString().slice(0, 10) }))).status, 400)
    assert.equal((await post(full({ title: 'Ancient work', contributedOn: '2020-01-01' }))).status, 400)
    // History: recording and editing are in the audit log with what changed.
    const edit = await t.call(`/api/impact/${short.body.id}`, { method: 'PATCH', as: s.employee, body: { result: 'On-call engineers resolved the next P2 without escalating' } })
    assert.equal(edit.status, 200)
    const log = t.db.prepare(`SELECT action, before_json, after_json FROM audit_log WHERE entity_type = 'impact' AND entity_id = ? ORDER BY created_at, rowid`).all(short.body.id)
    assert.deepEqual(log.map((x) => x.action), ['impact.recorded', 'impact.edited'])
    assert.equal(JSON.parse(log[1].after_json).result, 'On-call engineers resolved the next P2 without escalating')
    assert.equal(JSON.parse(log[1].before_json).result, '')
  } finally { await t.close() }
})

test('a claim is never promoted on its own: claimed → supported → reviewed → verified, each by a real action', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const c = (await t.call('/api/impact', { method: 'POST', as: s.employee, body: full() })).body
    const stage = async (as = s.employee) => (await t.call(`/api/impact/${c.id}`, { as })).body.stage
    assert.equal(await stage(), 'CLAIMED')
    // Attaching evidence makes it supported, and nothing more: the status is still pending.
    assert.equal((await t.call(`/api/evidence/impact/${c.id}/links`, { method: 'POST', as: s.employee, body: { url: 'https://github.com/acme/shop/pull/481', label: 'PR 481' } })).status, 200)
    assert.equal(await stage(), 'SUPPORTED')
    assert.equal((await t.call(`/api/impact/${c.id}`, { as: s.employee })).body.verificationStatus, 'PENDING')
    // Only a manager verifies, never the contributor, never a manager of another team.
    const verify = (as, body) => t.call(`/api/impact/${c.id}/verification`, { method: 'POST', as, body })
    assert.equal((await verify(s.employee, { decision: 'VERIFIED' })).status, 403)
    assert.equal((await verify(s.manager2, { decision: 'VERIFIED' })).status, 404)
    assert.equal(await stage(), 'SUPPORTED', 'refused attempts changed nothing')
    // A manager who is not convinced says why: reviewed, not verified. The contributor can correct it.
    assert.equal((await verify(s.manager, { decision: 'REJECTED' })).status, 400, 'a reason is required')
    assert.equal((await verify(s.manager, { decision: 'REJECTED', comment: 'The PR does not show the load test result' })).status, 200)
    assert.equal(await stage(), 'REVIEWED')
    const fixed = await t.call(`/api/impact/${c.id}`, { method: 'PATCH', as: s.employee, body: { result: 'No double charges across 3 load-test runs (link in the PR)' } })
    assert.equal(fixed.body.stage, 'SUPPORTED', 'a correction puts it back in front of the manager')
    assert.equal((await verify(s.manager, { decision: 'VERIFIED', comment: 'Confirmed in the load test report' })).status, 200)
    assert.equal(await stage(), 'VERIFIED')
    assert.equal((await t.call(`/api/impact/${c.id}`, { method: 'PATCH', as: s.employee, body: { result: 'Changed after verification' } })).status, 409, 'a verified record cannot be quietly rewritten')
    // The manager sees the whole story, a peer sees nothing, another organization sees nothing.
    assert.equal((await t.call(`/api/impact/${c.id}`, { as: s.manager })).status, 200)
    for (const who of [s.employee2, s.manager2, s.otherAdmin]) assert.equal((await t.call(`/api/impact/${c.id}`, { as: who })).status, 404)
  } finally { await t.close() }
})

test('volume is not value: ten routine tasks do not outrank one verified hard problem, and nothing is scored or ranked', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Eve solves one difficult problem and records it with evidence; a manager verifies it.
    const hard = (await t.call('/api/impact', { method: 'POST', as: s.employee, body: full({ evidenceLinks: [{ url: 'https://github.com/acme/shop/pull/481' }] }) })).body
    await t.call(`/api/impact/${hard.id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'VERIFIED' } })
    // Ed completes ten routine tasks, each approved.
    for (let i = 0; i < 10; i++) {
      const task = (await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: `Routine task ${i}`, assigneeId: s.employee2.id } })).body.task
      await t.call(`/api/tasks/${task.id}/status`, { method: 'POST', as: s.employee2, body: { status: 'IN_PROGRESS' } })
      await t.call(`/api/tasks/${task.id}/submit`, { method: 'POST', as: s.employee2, body: { summary: 'Done', outcome: 'Done' } })
      assert.equal((await t.call(`/api/tasks/${task.id}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED' } })).status, 200)
    }
    const profile = async (who) => (await t.call(`/api/contribution/people/${who.id}`, { as: s.manager })).body
    const eve = await profile(s.employee)
    const ed = await profile(s.employee2)
    assert.equal(eve.verified.length, 1, 'the hard problem is a verified outcome')
    assert.equal(ed.verified.length, 0, 'ten completed tasks are not an outcome: completion is not impact')
    // No number anywhere can turn volume into a rating: no score, rank, rating or productivity fields, in any manager-facing payload.
    const payloads = [eve, ed, (await t.call('/api/contribution/team', { as: s.manager })).body, (await t.call('/api/analytics/team', { as: s.manager })).body,
      (await t.call('/api/impact-summary', { as: s.manager })).body, (await t.call('/api/contribution/intelligence', { as: s.manager })).body]
    for (const p of payloads) assert.doesNotMatch(JSON.stringify(p), /"(score|rank|ranking|rating|productivity|leaderboard)"\s*:/i)
    // People are listed alphabetically whatever they completed (Ed has ten completed tasks, Eve has one verified outcome).
    const team = (await t.call('/api/analytics/team', { as: s.manager })).body
    const names = team.people.map((p) => p.name)
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)))
    assert.equal(team.people.find((p) => p.userId === s.employee2.id).completed, 10)
    // A claim that nobody verified is not counted as a verified outcome in the team's outcomes.
    await t.call('/api/impact', { method: 'POST', as: s.employee2, body: full({ title: 'Claimed but unverified', result: 'It got better' }) })
    const after = (await t.call('/api/analytics/team', { as: s.manager })).body.outcomeList
    assert.equal(after.verified, 1)
    assert.equal(after.claimed, 1)
    assert.deepEqual(after.items.filter((i) => i.state === 'VERIFIED').map((i) => i.title), ['Removed the race in checkout reservations'])
  } finally { await t.close() }
})

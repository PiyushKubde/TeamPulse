import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

test('evidence files: type and content checked, private, downloadable only by people who can see the task', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Design', assigneeId: s.employee.id } })
    const id = c.body.task.id
    const up = (as, body, type, name = 'shot.png') => t.call(`/api/evidence/task/${id}/files`, { method: 'POST', as, raw: body, headers: { 'Content-Type': type, 'X-File-Name': name } })
    assert.equal((await up(s.employee, Buffer.from('<html><script>'), 'text/html', 'x.html')).status, 400)
    assert.equal((await up(s.employee, Buffer.from('not a png'), 'image/png')).status, 400)
    assert.equal((await up(s.outsider, PNG, 'image/png')).status, 404)
    const ok = await up(s.employee, PNG, 'image/png')
    assert.equal(ok.status, 200)
    const d = await t.call(`/api/tasks/${id}`, { as: s.manager })
    const file = d.body.evidence.find((e) => e.kind === 'file')
    assert.equal(file.url, `/api/evidence/${ok.body.id}/download`)
    const dl = await fetch(t.base + file.url, { headers: { cookie: s.manager.cookie } })
    assert.equal(dl.status, 200)
    assert.match(dl.headers.get('content-disposition'), /attachment/)
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG)
    assert.equal((await fetch(t.base + file.url, { headers: { cookie: s.outsider.cookie } })).status, 404)
    assert.equal((await fetch(t.base + file.url)).status, 401)
    assert.equal((await fetch(`${t.base}/uploads/${s.org.id}/${ok.body.id}.png`)).status, 404, 'not served statically')
    assert.equal((await t.call(`/api/evidence/${ok.body.id}`, { method: 'DELETE', as: s.manager })).status, 403)
    assert.equal((await t.call(`/api/evidence/${ok.body.id}`, { method: 'DELETE', as: s.employee })).status, 200)
  } finally { await t.close() }
})

test('reports: filters, CSV export with formula-injection guard, manager scope', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: '=HYPERLINK("evil")', assigneeId: s.employee.id, dueAt: new Date(Date.now() - 3600000).toISOString() } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager2, body: { title: 'Sales thing', assigneeId: s.outsider.id } })
    const w = await t.call('/api/reports/workload', { as: s.manager })
    assert.deepEqual(w.body.rows.map((r) => r.person).sort(), ['Ed Employee', 'Eve Employee', 'Mona Manager'])
    const o = await t.call('/api/reports/overdue', { as: s.manager })
    assert.equal(o.body.rows.length, 1)
    const csv = await t.call('/api/reports/overdue.csv', { as: s.manager })
    assert.match(csv.headers.get('content-type'), /text\/csv/)
    assert.match(csv.text, /^task,assignee,priority/)
    assert.match(csv.text, /"'=HYPERLINK\(""evil""\)"/)
    const filtered = await t.call(`/api/reports/workload?userId=${s.employee.id}`, { as: s.manager })
    assert.equal(filtered.body.rows.length, 1)
    assert.equal((await t.call(`/api/reports/workload?userId=${s.outsider.id}`, { as: s.manager })).status, 400)
    for (const type of ['status', 'blockers', 'contributions', 'impact', 'weekly']) assert.equal((await t.call(`/api/reports/${type}?from=2026-01-01`, { as: s.manager })).status, 200, type)
    assert.equal((await t.call('/api/reports/nope', { as: s.manager })).status, 400)
    // An admin has no authority over people's work unless assigned to manage a team: reports are manager-only.
    assert.equal((await t.call('/api/reports/status?from=2026-01-01', { as: s.admin })).status, 403)
  } finally { await t.close() }
})

test('daily reflection saves and updates per day', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/reflections', { method: 'PUT', as: s.employee, body: { contribution: 'Unblocked deploys', learned: 'CI caching' } })
    assert.equal(r.body.contribution, 'Unblocked deploys')
    await t.call('/api/reflections', { method: 'PUT', as: s.employee, body: { contribution: 'Unblocked deploys', tomorrow: 'Docs' } })
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM reflections').get().n, 1)
    assert.equal((await t.call('/api/reflections/today', { as: s.employee })).body.tomorrow, 'Docs')
  } finally { await t.close() }
})

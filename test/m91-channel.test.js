// M91 channel mode (send link). A fake fetch stands in for M91: no real alert is sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createM91Transport } from '../server/integrations/m91.js'
import { raiseAlert, processDeliveries, closeResolvedAlerts } from '../server/services/alerts.js'
import { redact } from '../server/ai/redact.js'
import { startApp, seedOrg } from './helpers.js'

const LINK = 'https://m91-api.msg91.com/s/sk_testchannellink0123456789abcdef'
function fakeM91() {
  const calls = []
  const open = new Map()
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null })
    const body = init.body ? JSON.parse(init.body) : {}
    if (url === LINK && init.method === 'POST') {
      const dup = open.has(body.customId)
      if (!dup) open.set(body.customId, `alert_${open.size + 1}`)
      return new Response(JSON.stringify({ success: true, data: { _id: open.get(body.customId), channelName: 'New test', delivered: dup ? 0 : 2, deduplicated: dup } }), { status: dup ? 200 : 201 })
    }
    if (url === `${LINK}/close`) return new Response(JSON.stringify({ success: true, data: { closed: true } }), { status: 200 })
    return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: `no ${url.replace(LINK, '<link>')}` } }), { status: 404 })
  }
  return { calls, fetchImpl }
}

test('channel mode: one alert per condition for the whole channel, no phone, no invite, closes on resolve', async () => {
  const f = fakeM91()
  const m91 = createM91Transport({ sendLink: LINK, callbackUrl: 'https://teampulse.test/api/webhooks/m91?token=x' }, f.fetchImpl)
  assert.equal(m91.mode, 'channel'); assert.equal(m91.ready, true); assert.equal(m91.status().state, 'ready')
  assert.deepEqual(await m91.invite('+91 98765 43210'), { phone: '919876543210', state: 'channel', reachable: null })
  assert.equal(f.calls.length, 0, 'no invite call in channel mode')
  const t = await startApp({ m91 })
  try {
    const s = seedOrg(t.db)
    t.db.prepare(`UPDATE organizations SET settings = ? WHERE id = ?`).run(JSON.stringify({ alerts: { m91Enabled: true } }), s.org.id)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Payments outage follow-up', priority: 'CRITICAL', assigneeId: s.employee.id } })
    const taskId = c.body.task.id
    // One condition for two people (assignee + manager) → one channel alert.
    raiseAlert(t.db, { orgId: s.org.id, rule: 'critical_blocked', userIds: [s.employee.id, s.manager.id], taskId, title: 'Critical task blocked: Payments outage follow-up', anchor: 'b1' })
    const out = await processDeliveries(t.db, m91)
    assert.equal(out.sent, 2, 'both deliveries recorded')
    const posts = f.calls.filter((x) => x.url === LINK && x.method === 'POST')
    assert.equal(posts.length, 2); assert.equal(posts[0].body.customId, posts[1].body.customId, 'same condition → same customId → M91 rings once')
    assert.equal(posts[0].body.phone, undefined, 'no phone in channel mode')
    assert.equal(posts[0].headers.Authorization, undefined, 'the link is the credential; no bearer header')
    assert.equal(posts[0].body.severity, 'HIGH'); assert.equal(posts[0].body.isAutoClose, true)
    assert.match(posts[0].body.title, /^(Eve Employee|Mona Manager): Critical task blocked/)
    assert.equal(posts[1].body.title.includes('Critical task blocked'), true)
    // Resolving the condition closes the alert by its M91 id.
    await closeResolvedAlerts(t.db, m91, { type: 'task.status_changed', taskId, to: 'CANCELLED' })
    assert.ok(f.calls.some((x) => x.url === `${LINK}/close` && x.body.alertId === 'alert_1'))
    // Sprint 2 interventions use the same path (severity MEDIUM), and only when the org switched the rule on.
    raiseAlert(t.db, { orgId: s.org.id, rule: 'assessment_disputed', userIds: [s.manager.id], taskId, title: 'Eve disputes the analysis', anchor: 'a1' })
    await processDeliveries(t.db, m91)
    assert.equal(f.calls.filter((x) => x.url === LINK).at(-1).body.severity, 'MEDIUM')
    // The link never appears in stored errors or logs (redaction knows it).
    assert.equal(redact(`failed calling ${LINK}`).includes(LINK), false)
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM alert_deliveries').all())
    assert.equal(dump.includes('sk_testchannellink'), false)
  } finally { await t.close() }
})

test('channel mode: an invalid link is reported, not used; an empty channel is a clear failure', async () => {
  const bad = createM91Transport({ sendLink: 'https://example.com/s/whatever' }, async () => { throw new Error('must not be called') })
  assert.equal(bad.ready, false); assert.equal(bad.status().state, 'invalid_link')
  const empty = createM91Transport({ sendLink: LINK }, async () => new Response(JSON.stringify({ success: false, error: { code: 'CHANNEL_EMPTY', message: 'nobody' } }), { status: 409 }))
  await assert.rejects(empty.send({ title: 'Something happened', recipient: { name: 'Eve' }, idempotencyKey: 'k' }), /Nobody in the M91 channel/)
})

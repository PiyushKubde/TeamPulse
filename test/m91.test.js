// The M91 transport against the documented contract (https://m91-api.msg91.com/api/public/api.md), with fetch
// stubbed. These check the exact requests TeamPulse makes; they are not a live call to M91.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createM91Transport, m91Phone } from '../server/integrations/m91.js'

const KEY = 'm91sk_test_abcdefghijkl'
function stubFetch(responses) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  }
  return { f, calls }
}

test('phones become digits with country code, no plus', () => {
  assert.equal(m91Phone('+91 98765-43210'), '919876543210')
  assert.equal(m91Phone('123'), null)
})

test('not configured: refuses to send, says what is missing', async () => {
  const t = createM91Transport({})
  assert.equal(t.ready, false)
  assert.equal(t.status().state, 'not_configured')
  await assert.rejects(t.send({ title: 'x', recipient: { phone: '+919876543210' } }), (e) => e.notConfigured)
  assert.equal(createM91Transport({ apiKey: 'nope' }).status().state, 'invalid_key')
})

test('send: POST /api/v1/alerts with bearer key and the documented body; reads data._id', async () => {
  const { f, calls } = stubFetch([{ status: 201, body: { success: true, data: { _id: 'a1', delivered: 1 } } }])
  const t = createM91Transport({ apiKey: KEY, callbackUrl: 'https://tp.example/api/webhooks/m91?token=x' }, f)
  const out = await t.send({ title: 'Deadline missed: Ship', body: 'It was due', recipient: { name: 'Eve', phone: '+91 98765 43210' }, idempotencyKey: 'tp-abc', severity: 'HIGH' })
  assert.deepEqual(out, { providerMessageId: 'a1', delivered: 1, deduplicated: false })
  assert.equal(calls[0].url, 'https://m91-api.msg91.com/api/v1/alerts')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`)
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['callbackUrl', 'customId', 'description', 'isAutoClose', 'other', 'phone', 'responseOptions', 'severity', 'title'])
  assert.equal(calls[0].body.phone, '919876543210')
  assert.equal(calls[0].body.severity, 'HIGH')
  assert.equal(calls[0].body.customId, 'tp-abc')
  assert.deepEqual(calls[0].body.responseOptions.map((o) => o.effect), ['SHARED', 'PERSONAL'])
  assert.ok(calls[0].body.responseOptions.every((o) => o.label.length <= 24))
})

test('send errors: 429/5xx/network retryable; 4xx not; not_a_recipient invites; no phone skipped', async () => {
  for (const [res, retryable] of [[{ status: 429, body: { success: false, error: { code: 'RATE_LIMITED', message: 'slow down' } } }, true], [{ status: 503, body: null }, true], [new TypeError('fetch failed'), true], [{ status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'bad' } } }, false]]) {
    const { f } = stubFetch([res])
    await assert.rejects(createM91Transport({ apiKey: KEY }, f).send({ title: 'Title here', recipient: { phone: '919876543210' } }), (e) => e.retryable === retryable)
  }
  const { f, calls } = stubFetch([{ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'not_a_recipient' } } }, { status: 201, body: { success: true, data: { phone: '919876543210', state: 'pending', reachable: false } } }])
  await assert.rejects(createM91Transport({ apiKey: KEY }, f).send({ title: 'Title here', recipient: { name: 'Eve', phone: '919876543210' } }), (e) => /must accept/.test(e.message) && !e.retryable)
  assert.equal(calls[1].url, 'https://m91-api.msg91.com/api/v1/recipients')
  assert.deepEqual(calls[1].body, { phone: '919876543210', label: 'TeamPulse alerts' })
  const { f: f2 } = stubFetch([{ status: 409, body: { success: false, error: { code: 'CHANNEL_EMPTY', message: 'x' } } }])
  await assert.rejects(createM91Transport({ apiKey: KEY }, f2).send({ title: 'Title here', recipient: { name: 'Eve', phone: '919876543210' } }), (e) => e.code === 'CHANNEL_EMPTY' && !e.retryable)
  await assert.rejects(createM91Transport({ apiKey: KEY }, stubFetch([]).f).send({ title: 'Title here', recipient: { name: 'Eve' } }), (e) => e.code === 'NO_PHONE')
})

test('read back and close use the documented paths', async () => {
  const { f, calls } = stubFetch([{ status: 200, body: { success: true, data: { _id: 'a1', status: 'OPEN', decision: null } } }, { status: 200, body: { success: true, data: { _id: 'a1', status: 'RESOLVED' } } }, { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'already_resolved' } } }])
  const t = createM91Transport({ apiKey: KEY }, f)
  assert.equal((await t.getAlert('a1', '+919876543210')).status, 'OPEN')
  assert.equal(calls[0].url, 'https://m91-api.msg91.com/api/v1/alerts/a1?phone=919876543210')
  assert.deepEqual(await t.close({ phone: '919876543210', alertId: 'a1' }), { closed: true })
  assert.deepEqual(calls[1].body, { phone: '919876543210', alertId: 'a1' })
  assert.equal(calls[1].url, 'https://m91-api.msg91.com/api/v1/alerts/close')
  assert.equal((await t.close({ phone: '919876543210', alertId: 'a1' })).alreadyClosed, true)
})

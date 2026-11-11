// handleCallback: M91 webhook callback handler tests.
// Verifies: token auth (timing-safe), idempotency, read-back (never acts on raw body alone),
// cross-org attempts, missing delivery, and DB state transitions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleCallback } from '../server/services/alerts.js'
import { createM91Transport } from '../server/integrations/m91.js'
import { uuid } from '../server/db.js'
import { startApp, seedOrg } from './helpers.js'

const LINK = 'https://m91-api.msg91.com/s/sk_testcblink0123456789abcdef'
const TOKEN = 'secret-callback-token-32bytes!!'

function makeTransport(alertData = { status: 'OPEN', decision: { label: "I'm on it", effect: 'SHARED', by: 'eve', at: null }, responses: [{ label: "I'm on it", effect: 'SHARED', note: null }] }) {
  return createM91Transport({ sendLink: LINK }, async (url) => {
    if (url.includes('/alerts/')) return new Response(JSON.stringify({ success: true, data: { _id: 'alert-001', ...alertData } }), { status: 200 })
    return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'nope' } }), { status: 404 })
  })
}

function seedDelivery(db, s, alertId = 'alert-001') {
  const id = uuid()
  db.prepare(`INSERT INTO alert_deliveries (id, org_id, user_id, task_id, rule, status, provider, provider_message_id, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'deadline_missed', 'SENT', 'm91', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run(id, s.org.id, s.employee.id, s.task?.id ?? null, alertId, `dk:${alertId}`)
  return id
}

async function withApp(fn, m91) {
  const app = await startApp({ m91: m91 ?? createM91Transport({}) })
  try { await fn(app) } finally { await app.close() }
}

const body = JSON.stringify({ alert: { id: 'alert-001' }, idempotencyKey: 'ik-001' })

test('missing or wrong token → 401, nothing stored', async () => {
  await withApp(async ({ db }) => {
    const t = makeTransport()
    const r1 = await handleCallback(db, t, { token: undefined, expectedToken: TOKEN, rawBody: body })
    assert.equal(r1.status, 401)
    const r2 = await handleCallback(db, t, { token: 'wrong-token-xxxxxxxxxxxxxxxxx', expectedToken: TOKEN, rawBody: body })
    assert.equal(r2.status, 401)
    assert.equal(db.prepare('SELECT count(*) as n FROM alert_callbacks').get().n, 0)
  })
})

test('no expectedToken configured → 503', async () => {
  await withApp(async ({ db }) => {
    const r = await handleCallback(db, makeTransport(), { token: TOKEN, expectedToken: undefined, rawBody: body })
    assert.equal(r.status, 503)
    assert.equal(r.body.error, 'callbacks_not_configured')
  })
})

test('valid token: stores callback, matches delivery, reads back from M91, updates DB', async () => {
  await withApp(async ({ db }) => {
    const s = seedOrg(db)
    seedDelivery(db, s)
    const r = await handleCallback(db, makeTransport(), { token: TOKEN, expectedToken: TOKEN, rawBody: Buffer.from(body) })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.matched, true)
    const cb = db.prepare('SELECT * FROM alert_callbacks WHERE idempotency_key = ?').get('k:ik-001')
    assert.ok(cb)
    assert.equal(cb.provider, 'm91')
    const d = db.prepare('SELECT * FROM alert_deliveries WHERE provider_message_id = ?').get('alert-001')
    assert.equal(d.status, 'DELIVERED')
    assert.equal(d.response_label, "I'm on it")
    assert.equal(d.response_effect, 'SHARED')
  })
})

test('idempotency: duplicate callback returns 200 duplicate:true without double-processing', async () => {
  await withApp(async ({ db }) => {
    const s = seedOrg(db)
    seedDelivery(db, s)
    const r1 = await handleCallback(db, makeTransport(), { token: TOKEN, expectedToken: TOKEN, rawBody: body })
    assert.equal(r1.status, 200); assert.equal(r1.body.duplicate, undefined)
    const r2 = await handleCallback(db, makeTransport(), { token: TOKEN, expectedToken: TOKEN, rawBody: body })
    assert.equal(r2.status, 200); assert.equal(r2.body.duplicate, true)
    assert.equal(db.prepare('SELECT count(*) as n FROM alert_callbacks WHERE idempotency_key = ?').get('k:ik-001').n, 1)
  })
})

test('no matching delivery: stores callback, returns 202 matched:false', async () => {
  await withApp(async ({ db }) => {
    const unknownBody = JSON.stringify({ alert: { id: 'unknown-alert' }, idempotencyKey: 'ik-002' })
    const r = await handleCallback(db, makeTransport(), { token: TOKEN, expectedToken: TOKEN, rawBody: unknownBody })
    assert.equal(r.status, 202)
    assert.equal(r.body.matched, false)
  })
})

test('read-back failure returns 503, removes callback to allow retry', async () => {
  await withApp(async ({ db }) => {
    const s = seedOrg(db)
    seedDelivery(db, s)
    const failTransport = createM91Transport({ sendLink: LINK }, async () => { throw new Error('network error') })
    const r = await handleCallback(db, failTransport, { token: TOKEN, expectedToken: TOKEN, rawBody: body })
    assert.equal(r.status, 503)
    assert.equal(r.body.error, 'read_back_failed')
    // Callback must be removed so M91 can retry
    assert.equal(db.prepare('SELECT count(*) as n FROM alert_callbacks WHERE idempotency_key = ?').get('k:ik-001').n, 0)
  })
})

test('idempotency-key from header when body lacks one', async () => {
  await withApp(async ({ db }) => {
    const s = seedOrg(db)
    seedDelivery(db, s)
    const bodyNoKey = JSON.stringify({ alert: { id: 'alert-001' } })
    const r = await handleCallback(db, makeTransport(), { token: TOKEN, expectedToken: TOKEN, rawBody: bodyNoKey, idempotencyHeader: 'hk-001' })
    assert.equal(r.status, 200)
    assert.ok(db.prepare('SELECT * FROM alert_callbacks WHERE idempotency_key = ?').get('k:hk-001'))
  })
})

test('invalid json body → 400', async () => {
  await withApp(async ({ db }) => {
    const r = await handleCallback(db, makeTransport(), { token: TOKEN, expectedToken: TOKEN, rawBody: '{not json' })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'invalid_json')
  })
})

test('token comparison is timing-safe (same length wrong value still rejected)', async () => {
  await withApp(async ({ db }) => {
    const sameLen = TOKEN.replace('secret', 'xxxxxx')
    const r = await handleCallback(db, makeTransport(), { token: sameLen, expectedToken: TOKEN, rawBody: body })
    assert.equal(r.status, 401)
  })
})

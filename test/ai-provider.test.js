// The real Anthropic provider code (official SDK) against a LOCAL fake Messages API. No live call is made: this
// checks the request we send, how responses, usage, fallbacks and errors are read, and that failures never
// become assessments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createAiProvider, ProviderError } from '../server/ai/provider.js'
import { OUTPUT_SCHEMA } from '../server/measurement/schema.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { startApp, seedOrg } from './helpers.js'

const VALID = {
  understanding: 'u', complexity: { state: 'assessed', level: 'L2', confidence: 0.7, reason: 'r', evidence_refs: ['submission-1'] },
  dimensions: Object.fromEntries(['impact', 'quality', 'ownership', 'problem_solving', 'collaboration'].map((k) => [k, { state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'n', evidence_refs: [] }])),
  contribution_summary: 's', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: ''
}
const message = (over = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(VALID) }], stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 0 }, ...over })

async function fakeApi(handler) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
      const out = handler(seen.length, seen.at(-1))
      if (out === 'hang') return
      res.writeHead(out.status || 200, { 'content-type': 'application/json', 'request-id': `req_${seen.length}`, 'retry-after-ms': '1', ...(out.headers || {}) })
      res.end(JSON.stringify(out.body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}
const provider = (url, ai = {}) => createAiProvider({ production: true, ai: { provider: 'anthropic', apiKey: 'sk-ant-test-not-real', baseUrl: url, timeoutMs: 2000, ...ai } })
const call = (p) => p.generate({ system: 'sys', user: 'Evidence pack (JSON). {"items":[]}', schema: OUTPUT_SCHEMA })

test('request matches the installed SDK: model, structured output, effort, server-side fallback, key header', async () => {
  const api = await fakeApi(() => ({ body: message() }))
  try {
    const out = await call(provider(api.url))
    const r = api.seen[0]
    assert.equal(r.method, 'POST'); assert.equal(r.url.split('?')[0], '/v1/messages')
    // SDK 1.3.0 sends the key as a bearer credential and pins API version 2026-10-21 (which rejects sampling params
    // and thinking budgets — none are sent).
    assert.equal(r.headers.authorization, 'Bearer sk-ant-test-not-real'); assert.equal(r.headers['anthropic-version'], '2026-10-21')
    assert.match(r.headers['anthropic-beta'], /server-side-fallback-2026-07-01/)
    assert.equal(r.body.model, 'claude-opus-5-5'); assert.equal(r.body.fallbacks, 'default'); assert.equal(r.body.max_tokens, 16000)
    assert.deepEqual(r.body.output_config, { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } })
    assert.equal(r.body.thinking, undefined, 'Opus 5.5 thinking is always on; no thinking/budget params are sent')
    assert.equal(r.body.temperature, undefined); assert.equal(r.body.betas, undefined)
    assert.equal(r.body.system, 'sys'); assert.equal(r.body.messages[0].role, 'user')
    assert.deepEqual(out.output, VALID, 'thinking blocks ignored; text parsed')
    assert.equal(out.model, 'claude-opus-5-5'); assert.equal(out.fallback.used, false)
    assert.deepEqual(out.usage, { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 0, cache_creation_input_tokens: null })
  } finally { await api.close() }
})

test('AI_FALLBACKS=off uses the plain endpoint without the fallback fields', async () => {
  const api = await fakeApi(() => ({ body: message() }))
  try {
    await call(provider(api.url, { fallbacks: false }))
    assert.equal(api.seen[0].url.split('?')[0], '/v1/messages'); assert.equal(api.seen[0].body.fallbacks, undefined)
    assert.doesNotMatch(api.seen[0].headers['anthropic-beta'] || '', /fallback/)
  } finally { await api.close() }
})

test('a fallback is recorded transparently: served model, requested model, hops', async () => {
  const api = await fakeApi(() => ({ body: message({ model: 'claude-opus-5', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: JSON.stringify(VALID) }], usage: { input_tokens: 10, output_tokens: 5, iterations: [{ type: 'message' }, { type: 'fallback_message' }] } }) }))
  try {
    const out = await call(provider(api.url))
    assert.equal(out.model, 'claude-opus-5')
    assert.deepEqual(out.fallback, { used: true, requestedModel: 'claude-opus-5-5', servedModel: 'claude-opus-5', hops: [{ from: 'claude-opus-5-5', to: 'claude-opus-5' }] })
  } finally { await api.close() }
})

test('errors: invalid key is clear and not retried; 5xx retried; overload gives up retryable; timeout; refusal; truncation; bad JSON', async () => {
  const cases = [
    { h: () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }), code: 'auth', retryable: false, calls: 1, msg: /rejected the API key \(401\).*ANTHROPIC_API_KEY/ },
    { h: () => ({ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } } }), code: 'not_found', retryable: false, calls: 1, msg: /AI_MODEL/ },
    { h: () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format: bad schema' } } }), code: 'bad_request', retryable: false, calls: 1, msg: /bad schema/ },
    { h: () => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }), code: 'provider_error', retryable: true, calls: 3 },
    { h: () => ({ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } }), code: 'rate_limited', retryable: true, calls: 3 },
    { h: () => ({ body: message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] }) }), code: 'refused', retryable: false, calls: 1, msg: /declined.*cyber/ },
    { h: () => ({ body: message({ stop_reason: 'max_tokens' }) }), code: 'truncated', retryable: true, calls: 1 },
    { h: () => ({ body: message({ content: [{ type: 'text', text: 'Sure! Here is my analysis:' }] }) }), code: 'invalid_output', retryable: true, calls: 1 }
  ]
  for (const c of cases) {
    const api = await fakeApi(c.h)
    try {
      await assert.rejects(call(provider(api.url)), (e) => {
        assert.ok(e instanceof ProviderError, String(e)); assert.equal(e.code, c.code); assert.equal(e.retryable, c.retryable)
        if (c.msg) assert.match(e.message, c.msg)
        assert.doesNotMatch(e.message, /sk-ant-test-not-real/, 'the key never appears in messages')
        return true
      })
      assert.equal(api.seen.length, c.calls, `${c.code}: SDK retry count`)
    } finally { await api.close() }
  }
  // A transient 500 followed by success: the SDK retries and the call succeeds.
  const flaky = await fakeApi((n) => (n === 1 ? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'oops' } } } : { body: message() }))
  try { assert.deepEqual((await call(provider(flaky.url))).output, VALID); assert.equal(flaky.seen.length, 2) } finally { await flaky.close() }
  // No answer in time: a retryable timeout (SDK retries disabled here to keep the test fast).
  const slow = await fakeApi(() => 'hang')
  try {
    await assert.rejects(call(provider(slow.url, { timeoutMs: 200, maxRetries: 0 })), (e) => e.code === 'timeout' && e.retryable === true)
  } finally { await slow.close() }
})

test('environment cannot redirect, log or trace evaluation data', async () => {
  const saved = { b: process.env.ANTHROPIC_BASE_URL, t: process.env.ANTHROPIC_AUTH_TOKEN }
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/evil'; process.env.ANTHROPIC_AUTH_TOKEN = 'other-token'
  try {
    const p = createAiProvider({ production: true, ai: { provider: 'anthropic', apiKey: 'sk-ant-test-not-real' } })
    assert.equal(p.baseUrl, 'https://api.anthropic.com')
  } finally {
    if (saved.b === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.b
    if (saved.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved.t
  }
})

test('through the app: a rejected key fails the run with a clear message and creates no assessment or notification; a fallback is shown', async () => {
  const api = await fakeApi(() => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }))
  const t = await startApp({ ai: provider(api.url) })
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Write the partner API guide', description: 'Partners need a guide to the orders API with authentication and pagination examples.', assigneeId: s.employee.id } })
    const id = c.body.task.id
    await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Wrote the guide with curl examples for auth and pagination.', outcome: 'Guide published on the partner portal.' } })
    await t.settled(); await measurementSettled(); await t.settled()
    const notesBefore = t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n
    const r = await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.employee })
    assert.ok([200].includes(r.status))
    await measurementSettled(); await t.settled()
    const v = (await t.call(`/api/tasks/${id}/assessment`, { as: s.employee })).body
    assert.equal(v.run.status, 'FAILED'); assert.match(v.run.error, /rejected the API key \(401\)/)
    assert.equal(v.assessment, null)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments').get().n, 0)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, notesBefore)
  } finally { await t.close(); await api.close() }

  const fb = await fakeApi(() => ({ body: message({ model: 'claude-opus-5', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: JSON.stringify(VALID) }] }) }))
  const t2 = await startApp({ ai: provider(fb.url) })
  try {
    const s = seedOrg(t2.db)
    const c = await t2.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Write the partner API guide', description: 'Partners need a guide to the orders API with authentication and pagination examples.', assigneeId: s.employee.id } })
    const id = c.body.task.id
    await t2.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    await t2.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Wrote the guide with curl examples for auth and pagination.', outcome: 'Guide published on the partner portal.' } })
    await t2.settled(); await measurementSettled(); await t2.settled()
    const a = (await t2.call(`/api/tasks/${id}/assessment`, { as: s.employee })).body.assessment
    assert.equal(a.model, 'claude-opus-5'); assert.equal(a.requestedModel, 'claude-opus-5-5'); assert.equal(a.fallback.used, true); assert.equal(a.live, true)
    const run = t2.db.prepare(`SELECT * FROM ai_evaluation_runs WHERE status = 'SUCCEEDED'`).get()
    assert.equal(run.model, 'claude-opus-5'); assert.equal(JSON.parse(run.usage_json).fallback.servedModel, 'claude-opus-5')
  } finally { await t2.close(); await fb.close() }
})

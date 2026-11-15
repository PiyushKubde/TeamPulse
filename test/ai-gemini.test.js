// Direct Gemini provider, tested with a MOCK client only (fictional data, no network, no key). Checks the privacy gate,
// the request we would send, how answers, usage and errors are read, that there is never a fallback to another
// provider, and the whole path through the assessment engine (record, audit fields, manager authority).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '@google/genai'
import { createAiProvider, readGeminiResponse, ProviderError } from '../server/ai/provider.js'
import { OUTPUT_SCHEMA } from '../server/measurement/schema.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { startApp, seedOrg } from './helpers.js'

const KEY = 'AIza-test-key-0123456789'
const VALID = {
  understanding: 'u', complexity: { state: 'assessed', level: 'L2', confidence: 0.7, reason: 'r', evidence_refs: ['submission-1'] },
  dimensions: Object.fromEntries(['impact', 'quality', 'ownership', 'problem_solving', 'collaboration'].map((k) => [k, { state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'n', evidence_refs: [] }])),
  contribution_summary: 's', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: ''
}
const reply = (over = {}) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(VALID) }] } }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 210, thoughtsTokenCount: 40, totalTokenCount: 1150 }, modelVersion: 'test-model-001', responseId: 'resp-1', ...over
})
const mockClient = (handler) => { const calls = []; return { calls, models: { generateContent: async (req) => { calls.push(req); return handler(req, calls.length) } } } }
const cfg = (over = {}) => ({ production: true, ai: { provider: 'gemini', geminiApiKey: KEY, geminiModel: 'test-model', geminiPolicyConfirmed: true, ...over } })
const call = (p) => p.generate({ system: 'sys', user: 'Evidence pack (JSON). {"items":[]}', schema: OUTPUT_SCHEMA })

test('the privacy gate, the key and the model are all required: otherwise nothing can be sent', async () => {
  const client = mockClient(() => reply())
  const gate = createAiProvider(cfg({ geminiPolicyConfirmed: false }), { genai: client })
  assert.equal(gate.configured, false); assert.match(gate.reason, /AI_GEMINI_POLICY_CONFIRMED/)
  await assert.rejects(call(gate), (e) => e instanceof ProviderError && e.code === 'not_configured')
  assert.equal(createAiProvider(cfg({ geminiApiKey: '' }), { genai: client }).configured, false)
  assert.match(createAiProvider(cfg({ geminiModel: '' }), { genai: client }).reason, /GEMINI_MODEL/)
  assert.equal(client.calls.length, 0, 'no request was made')
  const { loadConfig } = await import('../server/config.js')
  assert.equal(loadConfig().ai.geminiPolicyConfirmed, false, 'the gate defaults to false')
  assert.equal(loadConfig().ai.geminiModel, '', 'there is no default model')
})

test('request: the chosen model, our prompt, JSON schema output and no tools; the answer carries real usage and model', async () => {
  const client = mockClient(() => reply())
  const p = createAiProvider(cfg(), { genai: client })
  assert.equal(p.name, 'gemini'); assert.equal(p.model, 'test-model'); assert.equal(p.backup, undefined)
  const r = await call(p)
  const req = client.calls[0]
  assert.equal(req.model, 'test-model'); assert.equal(req.config.systemInstruction, 'sys')
  assert.equal(req.config.responseMimeType, 'application/json'); assert.deepEqual(req.config.responseJsonSchema, OUTPUT_SCHEMA)
  assert.equal(req.config.tools, undefined, 'no tools: no search or code execution')
  assert.equal(r.provider, 'gemini'); assert.equal(r.model, 'test-model-001'); assert.deepEqual(r.output, VALID)
  assert.deepEqual(r.usage, { input_tokens: 900, output_tokens: 210, thoughts_tokens: 40, cached_tokens: null, total_tokens: 1150 })
  assert.equal(r.fallback.used, false); assert.equal(r.fallback.modelConfirmed, true)
})

test('answers and failures are classified: nothing malformed becomes an assessment', () => {
  const bad = (res) => { try { readGeminiResponse(res, 'm'); return null } catch (e) { return e } }
  assert.equal(bad({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }).code, 'refused')
  assert.equal(bad(reply({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] })).code, 'refused')
  const cut = bad(reply({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a":' }] } }] })); assert.equal(cut.code, 'truncated'); assert.equal(cut.retryable, true)
  assert.equal(bad(reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] })).code, 'invalid_output')
  assert.equal(bad(reply({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })).code, 'invalid_output')
  assert.equal(bad(reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[1]' }] } }] })).code, 'invalid_output')
  assert.equal(bad(reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking', thought: true }, { text: JSON.stringify(VALID) }] } }] })), null, 'thought parts are ignored')
})

test('errors: auth, rate limit, timeout, server and network failures are mapped, never leak the key, and never reach another provider', async () => {
  const fail = async (err) => { const p = createAiProvider(cfg({ apiKey: 'sk-anthropic-should-not-be-used', viasocketPolicyConfirmed: true }), { genai: mockClient(() => { throw err }), vs: { configured: true, aiSend() { throw new Error('viaSocket must not be called') } } }); try { await call(p); return null } catch (e) { return e } }
  const api = (status, message = `bad ${KEY}`) => new ApiError({ status, message })
  const cases = [[api(401), 'auth', false], [api(403), 'auth', false], [api(404), 'not_found', false], [api(400), 'bad_request', false], [api(429), 'rate_limited', true], [api(503), 'provider_error', true],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout', true], [new TypeError('fetch failed'), 'network', true], [new Error('weird'), 'unknown', false]]
  for (const [err, code, retryable] of cases) {
    const e = await fail(err)
    assert.ok(e instanceof ProviderError, `${code} is a ProviderError`); assert.equal(e.code, code); assert.equal(e.retryable, retryable)
    assert.ok(!e.message.includes(KEY), 'the key never appears in an error message')
  }
})

test('through the app: assessed on Gemini with provider, model, versions and usage on the record; thin evidence never leaves KONVO; only the manager approves', async () => {
  const client = mockClient(() => reply())
  const t = await startApp({ ai: createAiProvider(cfg(), { genai: client }) })
  try {
    const s = seedOrg(t.db)
    const make = async (title, description, summary, outcome) => {
      const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title, description, assigneeId: s.employee.id } }); const id = c.body.task.id
      await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
      await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary, outcome } })
      await t.settled(); await measurementSettled(); await t.settled(); return id
    }
    const thin = await make('Fix it', null, 'Done.', 'Done.')
    assert.equal(client.calls.length, 0, 'a task with too little evidence is answered by rules and nothing is sent to Gemini')
    assert.equal((await t.call(`/api/tasks/${thin}/assessment`, { as: s.employee })).body.assessment?.provider ?? 'rules', 'rules')

    const id = await make('Write the partner API guide', 'Partners need a guide to the orders API with authentication and pagination examples.', 'Wrote the guide with curl examples for auth and pagination, reviewed with two partners.', 'Guide published on the partner portal.')
    assert.equal(client.calls.length, 1, 'one request for the task with real evidence')
    const text = JSON.stringify(client.calls[0].contents)
    assert.ok(!text.includes(s.employee.email) && !text.includes('Eve Employee'), 'the evidence pack carries no name or email')
    const row = t.db.prepare('SELECT * FROM contribution_assessments WHERE task_id = ?').get(id)
    assert.equal(row.provider, 'gemini'); assert.equal(row.model, 'test-model-001'); assert.ok(row.prompt_version && row.rubric_version)
    const run = t.db.prepare('SELECT * FROM ai_evaluation_runs WHERE task_id = ? ORDER BY created_at DESC').get(id)
    assert.equal(run.status, 'SUCCEEDED'); assert.match(run.usage_json || '', /"input_tokens":900/)

    // Manager keeps final authority: the employee and the admin cannot approve it, the manager can.
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.employee, body: { action: 'APPROVE' } })).status, 403)
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.admin, body: { action: 'APPROVE' } })).status, 403)
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'APPROVE' } })).status, 200)
  } finally { await t.close() }
})

test('through the app: a Gemini failure fails the run, creates no assessment, and does not call anything else', async () => {
  const client = mockClient(() => { throw new ApiError({ status: 401, message: 'API key not valid' }) })
  const t = await startApp({ ai: createAiProvider(cfg(), { genai: client }) })
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Write the partner API guide', description: 'Partners need a guide to the orders API with authentication and pagination examples.', assigneeId: s.employee.id } })
    const id = c.body.task.id
    await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Wrote the guide with curl examples for auth and pagination.', outcome: 'Guide published on the partner portal.' } })
    await t.settled(); await measurementSettled(); await t.settled()
    const v = (await t.call(`/api/tasks/${id}/assessment`, { as: s.employee })).body
    assert.equal(v.run.status, 'FAILED'); assert.match(v.run.error, /rejected the API key/)
    assert.equal(v.assessment, null)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments').get().n, 0)
  } finally { await t.close() }
})

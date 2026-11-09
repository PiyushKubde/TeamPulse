// viaSocket built-in AI as the primary provider, Anthropic as the backup. viaSocket is a stand-in gateway and
// Anthropic a local fake Messages API: no live call. Proves the request we send, the backup on every kind of failure,
// and that the assessment records which provider and model actually answered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createAiProvider, ProviderError } from '../server/ai/provider.js'
import { OUTPUT_SCHEMA, validateOutput } from '../server/measurement/schema.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { startApp, seedOrg } from './helpers.js'

const VALID = {
  understanding: 'u', complexity: { state: 'assessed', level: 'L2', confidence: 0.7, reason: 'r', evidence_refs: ['submission-1'] },
  dimensions: Object.fromEntries(['impact', 'quality', 'ownership', 'problem_solving', 'collaboration'].map((k) => [k, { state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'n', evidence_refs: [] }])),
  contribution_summary: 's', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: ''
}
class VsError extends Error { constructor(status, body) { super(`viaSocket ${status}`); this.status = status; this.body = body } }
function stubVs(answer) {
  const calls = []
  return { calls, configured: true, aiSend: async (identifier, params) => { calls.push({ identifier, params }); return answer(calls.length, params) } }
}
async function fakeAnthropic() {
  let n = 0
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { n++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(VALID) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })) }) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => n, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}
const cfg = (extra = {}) => ({ production: true, ai: { provider: 'viasocket', timeoutMs: 2000, maxRetries: 0, ...extra } })
const gen = (p) => p.generate({ system: 'SYS', user: 'Evidence pack (JSON). {"items":[]}', schema: OUTPUT_SCHEMA, validate: validateOutput, context: { orgId: 'org-1', runId: 'run-1' } })

test('viaSocket request: own identifier, fresh thread per call, json_schema, our prompt + no-browse, chosen model', async () => {
  const vs = stubVs(() => ({ threadId: 't', messageId: 'msg-1', content: VALID, finishReason: 'completed' }))
  const p = createAiProvider(cfg(), { vs })
  assert.equal(p.name, 'viasocket'); assert.equal(p.model, 'anthropic/claude-sonnet-5-5'); assert.equal(p.backup, undefined)
  const r1 = await gen(p); await gen(p)
  const [a, b] = vs.calls
  assert.equal(a.identifier, 'teampulse-ai-org-1')
  assert.match(a.params.threadId, /^tp-eval-run-1-[a-z0-9]+$/); assert.notEqual(a.params.threadId, b.params.threadId)
  assert.equal(a.params.responseType, 'json_schema'); assert.deepEqual(a.params.jsonSchema, { name: 'contribution_assessment', schema: OUTPUT_SCHEMA, strict: true })
  assert.equal(a.params.service, 'anthropic'); assert.equal(a.params.model, 'claude-sonnet-5-5')
  assert.match(a.params.prompt, /^SYS/); assert.match(a.params.prompt, /Do not search the web/)
  assert.equal(a.params.tools, undefined); assert.equal(a.params.mcpServers, undefined); assert.equal(a.params.delivery, undefined)
  assert.deepEqual(r1.output, VALID); assert.equal(r1.provider, 'viasocket')
  assert.equal(r1.fallback.modelConfirmed, false, 'viaSocket sync replies do not name the model: recorded as unconfirmed')
  const custom = createAiProvider(cfg({ viasocketService: 'openai', viasocketModel: 'gpt-6.1-sol' }), { vs })
  await gen(custom); assert.equal(vs.calls.at(-1).params.service, 'openai')
})

test('viaSocket answers as a JSON string are parsed; prose, truncation, tool calls, errors are clear when there is no backup', async () => {
  assert.deepEqual((await gen(createAiProvider(cfg(), { vs: stubVs(() => ({ content: JSON.stringify(VALID), finishReason: 'completed' })) }))).output, VALID)
  const cases = [
    [() => ({ content: 'Here is my assessment: the work was good.', finishReason: 'completed' }), 'invalid_output', /prose/],
    [() => ({ content: VALID, finishReason: 'truncated' }), 'truncated'],
    [() => ({ content: '', finishReason: 'tool_call' }), 'invalid_output', /tool/],
    [() => { throw new VsError(401) }, 'auth', /viaSocket keys/],
    [() => { throw new VsError(400, { data: { detail: { error: 'model or service does not exist!' } } }) }, 'bad_request', /does not exist/],
    [() => { throw new VsError(429) }, 'rate_limited'],
    [() => { throw new VsError(500) }, 'provider_error'],
    [() => { throw new VsError(null) }, 'network'],
    [() => new Promise(() => {}), 'timeout']
  ]
  for (const [answer, code, msg] of cases) {
    await assert.rejects(gen(createAiProvider(cfg({ timeoutMs: 150 }), { vs: stubVs(answer) })), (e) => { assert.ok(e instanceof ProviderError); assert.equal(e.code, code); if (msg) assert.match(e.message, msg); return true })
  }
})

test('with ANTHROPIC_API_KEY: any viaSocket failure — error or invalid answer — goes to Anthropic once, recorded', async () => {
  const api = await fakeAnthropic()
  try {
    const backupCfg = (vsAnswer) => createAiProvider(cfg({ apiKey: 'sk-ant-test-not-real', baseUrl: api.url }), { vs: stubVs(vsAnswer) })
    const p = backupCfg(() => ({ content: VALID, finishReason: 'completed' }))
    assert.deepEqual(p.backup, { name: 'anthropic', model: 'claude-opus-5-5' })
    assert.equal((await gen(p)).provider, 'viasocket'); assert.equal(api.calls(), 0, 'no backup call when viaSocket works')
    for (const failing of [() => { throw new VsError(500) }, () => ({ content: 'prose', finishReason: 'completed' }), () => ({ content: { understanding: 'only this' }, finishReason: 'completed' })]) {
      const before = api.calls()
      const r = await gen(backupCfg(failing))
      assert.equal(api.calls(), before + 1)
      assert.equal(r.provider, 'anthropic'); assert.equal(r.model, 'claude-opus-5-5')
      assert.equal(r.fallback.used, true); assert.equal(r.fallback.kind, 'provider_backup'); assert.equal(r.fallback.requestedModel, 'anthropic/claude-sonnet-5-5')
      assert.ok(r.fallback.primaryError)
    }
    // viaSocket keys missing but an Anthropic key present: Anthropic is used directly, and the log says why.
    const only = createAiProvider(cfg({ apiKey: 'sk-ant-test-not-real', baseUrl: api.url }), { vs: { configured: false } })
    assert.equal(only.name, 'anthropic'); assert.match(only.note, /viaSocket is not configured/)
    assert.equal(createAiProvider(cfg(), { vs: { configured: false } }).configured, false)
  } finally { await api.close() }
})

test('through the app: viaSocket fails, Anthropic answers; the assessment and run say so', async () => {
  const api = await fakeAnthropic()
  const vs = stubVs(() => { throw new VsError(500) })
  const ai = createAiProvider(cfg({ apiKey: 'sk-ant-test-not-real', baseUrl: api.url, mode: 'on' }), { vs })
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Write the partner API guide', description: 'Partners need a guide to the orders API with authentication and pagination examples.', assigneeId: s.employee.id } })
    const id = c.body.task.id
    await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Wrote the guide with curl examples for auth and pagination.', outcome: 'Guide published.' } })
    await t.settled(); await measurementSettled(); await t.settled()
    const v = (await t.call(`/api/tasks/${id}/assessment`, { as: s.employee })).body
    assert.equal(v.ai.provider, 'viasocket')
    assert.equal(v.assessment.provider, 'anthropic'); assert.equal(v.assessment.model, 'claude-opus-5-5')
    assert.equal(v.assessment.fallback.kind, 'provider_backup'); assert.match(v.assessment.fallback.primaryError, /provider_error/)
    assert.equal(vs.calls[0].identifier, `teampulse-ai-${s.org.id}`)
    const run = t.db.prepare(`SELECT * FROM ai_evaluation_runs WHERE status = 'SUCCEEDED'`).get()
    assert.equal(run.provider, 'viasocket'); assert.equal(run.model, 'claude-opus-5-5')
    assert.equal(JSON.parse(run.usage_json).fallback.kind, 'provider_backup')
  } finally { await t.close(); await api.close() }
})

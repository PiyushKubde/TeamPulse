// Pre-deployment checks for viaSocket-primary + Anthropic-backup (no live calls: a stand-in viaSocket gateway and a
// local fake Anthropic API). One section per required check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createAiProvider, BACKUP_ON } from '../server/ai/provider.js'
import { OUTPUT_SCHEMA, validateOutput } from '../server/measurement/schema.js'
import { measurementSettled, startRun } from '../server/measurement/engine.js'
import { aiMode } from '../server/measurement/assessments.js'
import { startApp, seedOrg, adminManages } from './helpers.js'

const ANTHROPIC_KEY = 'sk-ant-api03-TESTKEY-not-real-0123456789abcdef'
const VS_SECRET = 'vs-embed-secret-TESTVALUE-0123456789abcdef'
const none = () => ({ state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'n', evidence_refs: [] })
const VALID = { understanding: 'u', complexity: { state: 'assessed', level: 'L2', confidence: 0.7, reason: 'r', evidence_refs: ['submission-1'] }, dimensions: { impact: none(), quality: none(), ownership: none(), problem_solving: none(), collaboration: none() }, contribution_summary: 's', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: '' }
// An answer that breaks the rules: L4 from the title alone, an invented reference, quality 5 with no evidence.
const BAD = { ...VALID, complexity: { state: 'assessed', level: 'L4', confidence: 0.99, reason: 'Critical task', evidence_refs: ['task'] }, dimensions: { ...VALID.dimensions, quality: { state: 'assessed', level: 5, confidence: 0.99, reason: 'Tests all pass', evidence_refs: ['test-run-1'] } }, estimated_outcomes: [{ description: 'Saves 400 hours a year', basis_refs: ['submission-1'] }] }

class VsError extends Error { constructor(status, message = `viaSocket ${status}`, body) { super(message); this.status = status; this.body = body } }
function stubVs(answer) {
  const calls = []
  return { calls, configured: true, aiSend: async (identifier, params) => { calls.push({ identifier, params }); return answer(calls.length, params) } }
}
async function fakeAnthropic(respond = () => ({ body: msg(VALID) })) {
  const seen = []
  const server = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { seen.push(JSON.parse(b)); const o = respond(seen.length); res.writeHead(o.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o.body)) }) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}
const msg = (output, model = 'claude-opus-5-5') => ({ id: 'msg', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
const provider = (vs, api, extra = {}) => createAiProvider({ production: true, viasocket: { secret: VS_SECRET }, ai: { provider: 'viasocket', viasocketPolicyConfirmed: true, apiKey: ANTHROPIC_KEY, baseUrl: api?.url, timeoutMs: 1500, maxRetries: 0, ...extra } }, { vs })
const gen = (p) => p.generate({ system: 'S', user: 'Evidence pack (JSON). {"items":[]}', schema: OUTPUT_SCHEMA, validate: validateOutput, context: { orgId: 'o', runId: 'r' } })

async function submitted(t, s, who = 'employee') {
  const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Write the partner API guide', description: 'Partners need a guide to the orders API with authentication and pagination examples.', assigneeId: s[who].id } })
  const id = c.body.task.id
  await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s[who], body: { status: 'IN_PROGRESS' } })
  await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s[who], body: { summary: 'Wrote the guide with curl examples for auth and pagination.', outcome: 'Guide published.' } })
  await t.settled(); await measurementSettled(); await t.settled()
  return id
}
const analyse = async (t, as, id) => { const r = await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as }); await measurementSettled(); await t.settled(); return r }
const view = async (t, as, id) => (await t.call(`/api/tasks/${id}/assessment`, { as })).body

// ---------- 1. fallback scope ----------
test('1a. backup only for provider failures, timeouts, malformed answers and validation failures', async () => {
  const api = await fakeAnthropic()
  try {
    const goes = {
      'viaSocket 500': () => { throw new VsError(500) }, 'viaSocket 502': () => { throw new VsError(502) },
      'viaSocket 429': () => { throw new VsError(429) }, 'viaSocket credentials rejected (401)': () => { throw new VsError(401) },
      'network': () => { throw new VsError(null, 'Request to https://api.viasocket.com/embed/ai/message failed: ECONNRESET') },
      'timeout': () => new Promise(() => {}), 'prose': () => ({ content: 'The work looks good.', finishReason: 'completed' }),
      'truncated': () => ({ content: VALID, finishReason: 'truncated' }), 'tool call': () => ({ content: '', finishReason: 'tool_call' }),
      'fails validation': () => ({ content: { ...VALID, score: 9 }, finishReason: 'completed' })
    }
    for (const [name, answer] of Object.entries(goes)) {
      const before = api.seen.length
      // Only the 'timeout' case needs a short timeout; a tight one for the others made this fail under CPU load (a slow loopback call counted as a timeout).
      const r = await gen(provider(stubVs(answer), api, { timeoutMs: name === 'timeout' ? 150 : 5000 }))
      assert.equal(r.provider, 'anthropic', name); assert.equal(api.seen.length, before + 1, name)
    }
    const stays = {
      'refused / bad request (400)': [() => { throw new VsError(400, 'AI service refused', { data: { detail: { error: 'refused' } } }) }, 'bad_request'],
      'invalid model or service (422)': [() => { throw new VsError(422, 'Validation error') }, 'bad_request'],
      'our own invalid request': [() => { throw new VsError(null, 'ai.send: threadId is letters, digits, - and _, up to 100 characters') }, 'client_error'],
      'unexpected exception': [() => { throw new TypeError('x is undefined') }, null]
    }
    for (const [name, [answer, code]] of Object.entries(stays)) {
      const before = api.seen.length
      await assert.rejects(gen(provider(stubVs(answer), api)), (e) => (code ? e.code === code : e instanceof TypeError), name)
      assert.equal(api.seen.length, before, `${name}: no backup call`)
    }
    assert.deepEqual([...BACKUP_ON].sort(), ['auth', 'invalid_output', 'network', 'provider_error', 'rate_limited', 'timeout', 'truncated'])
  } finally { await api.close() }
})

test('1b. KONVO authorization, permission and business-rule refusals call no provider at all', async () => {
  const api = await fakeAnthropic()
  const vs = stubVs(() => ({ content: VALID, finishReason: 'completed' }))
  const t = await startApp({ ai: provider(vs, api), cfgOverrides: { ai: { mode: 'supervised' } } })
  try {
    const s = seedOrg(t.db)
    const id = await submitted(t, s)
    adminManages(t.db, s.admin, s.teamA) // the supervised run is an admin's, and an admin sees work only in a team they manage
    const codes = []
    codes.push((await analyse(t, s.admin, id)).body.error.code) // not selected
    t.app.locals.aiMode.tasks.set(id, 'someone.else@example.com')
    codes.push((await analyse(t, s.admin, id)).body.error.code) // wrong owner
    t.app.locals.aiMode.tasks.set(id, s.employee.email)
    codes.push((await analyse(t, s.manager, id)).status) // the team's former manager: no longer responsible, out of scope
    codes.push((await analyse(t, s.employee, id)).status)
    codes.push((await analyse(t, s.otherAdmin, id)).status) // another organization
    codes.push((await analyse(t, s.outsider, id)).status) // out of scope
    assert.deepEqual(codes, ['ai_supervised', 'supervised_owner_mismatch', 404, 403, 404, 404])
    assert.equal(vs.calls.length, 0); assert.equal(api.seen.length, 0)
    // Manager-reviewed analysis: the employee cannot replace it; nothing is sent.
    t.app.locals.aiMode.mode = 'on'
    await analyse(t, s.employee, id)
    const sent = vs.calls.length
    await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.admin, body: { action: 'APPROVE' } })
    await t.call(`/api/tasks/${id}/comments`, { method: 'POST', as: s.employee, body: { body: 'Added the pagination example for cursors.' } })
    assert.equal((await analyse(t, s.employee, id)).body.error.code, 'assessment_reviewed')
    assert.equal(vs.calls.length, sent); assert.equal(api.seen.length, 0)
  } finally { await t.close(); await api.close() }
  // Data policy not confirmed: viaSocket is not used, and the Anthropic backup is NOT used instead.
  const p = createAiProvider({ production: true, ai: { provider: 'viasocket', apiKey: ANTHROPIC_KEY } }, { vs: stubVs(() => ({ content: VALID })) })
  assert.equal(p.configured, false); assert.match(p.reason, /retention, deletion and training policies are not confirmed/)
})

// ---------- 2. no duplicates, no overwrite ----------
test('2a. viaSocket timeout + Anthropic retry: exactly one assessment; the late viaSocket answer is discarded', async () => {
  const api = await fakeAnthropic()
  let release
  const late = new Promise((r) => { release = r })
  const vs = stubVs(() => late.then(() => ({ content: { ...VALID, understanding: 'LATE' }, finishReason: 'completed' })))
  const t = await startApp({ ai: provider(vs, api, { timeoutMs: 100, mode: 'on' }) })
  try {
    const s = seedOrg(t.db)
    const id = await submitted(t, s)
    const count = () => t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments WHERE task_id = ?').get(id).n
    assert.equal(count(), 1); assert.equal(api.seen.length, 1)
    release(); await new Promise((r) => setTimeout(r, 50)); await measurementSettled(); await t.settled()
    assert.equal(count(), 1, 'late answer created nothing')
    const v = await view(t, s.employee, id)
    assert.notEqual(v.assessment.understanding, 'LATE'); assert.equal(v.assessment.aiMeta.answeredBy, 'anthropic')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM ai_evaluation_runs WHERE task_id = ?`).get(id).n, 1)
    // The same run started twice (e.g. retry timer + scheduled recovery): the atomic claim lets only one through.
    const runId = t.db.prepare(`SELECT id FROM ai_evaluation_runs WHERE task_id = ?`).get(id).id
    t.db.prepare(`UPDATE ai_evaluation_runs SET status = 'QUEUED' WHERE id = ?`).run(runId)
    t.db.prepare(`UPDATE contribution_assessments SET is_current = 1 WHERE task_id = ?`).run(id)
    await Promise.all([startRun(t.db, t.app.locals.ai, runId), startRun(t.db, t.app.locals.ai, runId)])
    assert.equal(count(), 1, 'second processing refused (stale: the assessment is newer than the run)')
  } finally { await t.close(); await api.close() }
})

test('2b. a slow run never replaces an analysis a manager reviewed meanwhile', async () => {
  const api = await fakeAnthropic()
  let gate = null
  const vs = stubVs(() => (gate ? gate.then(() => { throw new VsError(504) }) : { content: VALID, finishReason: 'completed' }))
  const t = await startApp({ ai: provider(vs, api, { mode: 'on', timeoutMs: 5000 }) })
  try {
    const s = seedOrg(t.db)
    const id = await submitted(t, s)
    const first = (await view(t, s.manager, id)).assessment
    let open; gate = new Promise((r) => { open = r })
    await t.call(`/api/tasks/${id}/comments`, { method: 'POST', as: s.employee, body: { body: 'Added cursor pagination examples.' } })
    const pending = t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.employee }) // slow: viaSocket waits, then fails → backup
    await new Promise((r) => setTimeout(r, 100))
    await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'ADJUST', dimension: 'quality', level: 3, comment: 'Needs a reviewer from the partner team.' } })
    open(); await pending; await measurementSettled(); await t.settled()
    const v = await view(t, s.manager, id)
    assert.equal(v.assessment.id, first.id, 'the reviewed assessment is still current')
    assert.equal(v.assessment.managerStatus, 'ADJUSTED')
    assert.equal(v.run.status, 'FAILED'); assert.match(v.run.error, /manager reviewed the analysis while this one was running/)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments WHERE task_id = ?').get(id).n, 1)
  } finally { await t.close(); await api.close() }
})

// ---------- 3. credentials ----------
test('3. keys never reach logs, API responses, the AI conversation, or the database — even when errors echo them', async () => {
  const api = await fakeAnthropic((n) => (n === 1 ? { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${ANTHROPIC_KEY}` } } } : { body: msg(VALID) }))
  const vs = stubVs((n) => {
    if (n <= 2) throw new VsError(500, `upstream said: secret=${VS_SECRET} Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop`)
    if (n === 4) throw new VsError(400, 'refused', { data: { detail: { error: `rejected key ${ANTHROPIC_KEY} and ${VS_SECRET}` } } }) // detail is passed through to the stored error
    return { content: VALID, finishReason: 'completed' }
  })
  const logs = []
  const orig = { log: console.log, error: console.error, warn: console.warn }
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); }
  const t = await startApp({ ai: provider(vs, api, { mode: 'on' }) })
  try {
    const s = seedOrg(t.db)
    const id = await submitted(t, s) // viaSocket 500 echoing the secret → Anthropic 401 echoing its key → run fails
    const id2 = await submitted(t, s) // viaSocket 500 → Anthropic OK
    await submitted(t, s) // viaSocket OK
    const id4 = await submitted(t, s) // viaSocket 400 whose detail echoes both keys → no backup, run fails with a redacted message
    assert.match((await view(t, s.manager, id4)).run.error, /rejected key \[redacted\] and \[redacted\]/)
    const responses = await Promise.all([
      t.call('/api/session', { as: s.manager }), t.call('/api/health'), t.call(`/api/tasks/${id}/assessment`, { as: s.manager }),
      t.call(`/api/tasks/${id2}/assessment`, { as: s.manager }), t.call(`/api/tasks/${id2}/assessment/preview`, { as: s.manager }),
      t.call(`/api/contribution/people/${s.employee.id}`, { as: s.manager })
    ])
    const tables = t.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name)
    const dbDump = tables.map((n) => JSON.stringify(t.db.prepare(`SELECT * FROM ${n}`).all())).join('\n')
    const conversation = JSON.stringify(vs.calls) + JSON.stringify(api.seen)
    for (const [where, text] of [['logs', logs.join('\n')], ['responses', responses.map((r) => r.text).join('\n')], ['database', dbDump], ['AI conversation', conversation]]) {
      for (const secret of [ANTHROPIC_KEY, VS_SECRET, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0']) assert.ok(!text.includes(secret), `${where} contains a credential`)
    }
    assert.ok(dbDump.includes('[redacted]'), 'the echoed values were redacted, not just absent')
    assert.equal((await view(t, s.manager, id)).run.status, 'FAILED')
  } finally { Object.assign(console, orig); await t.close(); await api.close() }
})

// ---------- 4. metadata ----------
test('4. every assessment records the primary provider, who answered, the model, and why a fallback happened', async () => {
  const api = await fakeAnthropic()
  let mode = 'ok'
  const vs = stubVs(() => { if (mode === 'fail') throw new VsError(503); return { messageId: 'vs-msg-1', content: VALID, finishReason: 'completed' } })
  const t = await startApp({ ai: provider(vs, api, { mode: 'on' }) })
  try {
    const s = seedOrg(t.db)
    const direct = (await view(t, s.manager, await submitted(t, s))).assessment.aiMeta
    assert.deepEqual(direct, { primaryProvider: 'viasocket', requestedModel: 'anthropic/claude-sonnet-5-5', answeredBy: 'viasocket', answeredModel: 'anthropic/claude-sonnet-5-5', modelConfirmed: false, fallbackUsed: false, fallbackKind: null, fallbackReason: null, requestId: 'vs-msg-1' })
    mode = 'fail'
    const backup = (await view(t, s.manager, await submitted(t, s))).assessment.aiMeta
    assert.equal(backup.primaryProvider, 'viasocket'); assert.equal(backup.answeredBy, 'anthropic'); assert.equal(backup.answeredModel, 'claude-opus-5-5')
    assert.equal(backup.modelConfirmed, true); assert.equal(backup.fallbackUsed, true); assert.equal(backup.fallbackKind, 'provider_backup')
    assert.match(backup.fallbackReason, /provider_error: viaSocket AI failed \(503\)/)
    // Rules-only (too little evidence) also carries the metadata.
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Fix it', assigneeId: s.employee.id } })
    await t.call(`/api/tasks/${c.body.task.id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${c.body.task.id}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Done.', outcome: 'Done.' } })
    await t.settled(); await measurementSettled(); await t.settled()
    const rules = (await view(t, s.manager, c.body.task.id)).assessment.aiMeta
    assert.equal(rules.answeredBy, 'rules'); assert.equal(rules.fallbackUsed, false); assert.equal(rules.answeredModel, null)
    // Every stored assessment has the metadata; runs and audit carry it too.
    for (const a of t.db.prepare('SELECT context_json FROM contribution_assessments').all()) assert.ok(JSON.parse(a.context_json).ai?.answeredBy)
    for (const a of t.db.prepare(`SELECT after_json FROM audit_log WHERE action = 'assessment.created'`).all()) assert.ok(JSON.parse(a.after_json).ai?.answeredBy)
    assert.ok(t.db.prepare(`SELECT usage_json FROM ai_evaluation_runs WHERE provider = 'viasocket' AND status = 'SUCCEEDED'`).all().every((r) => JSON.parse(r.usage_json).answeredBy))
  } finally { await t.close(); await api.close() }
})

// ---------- 5. guardrails for every provider ----------
test('5. the same rule-breaking answer is corrected identically whether viaSocket or the Anthropic backup produced it', async () => {
  const results = {}
  for (const path of ['viasocket', 'backup']) {
    const api = await fakeAnthropic(() => ({ body: msg(BAD) }))
    const vs = stubVs(() => { if (path === 'backup') throw new VsError(500); return { content: BAD, finishReason: 'completed' } })
    const t = await startApp({ ai: provider(vs, api, { mode: 'on' }) })
    try {
      const s = seedOrg(t.db)
      const a = (await view(t, s.manager, await submitted(t, s))).assessment
      assert.equal(a.aiMeta.answeredBy, path === 'backup' ? 'anthropic' : 'viasocket')
      results[path] = { complexity: a.complexity.levelText, quality: a.dimensions.find((d) => d.key === 'quality').state, estimated: a.impact.estimated.length, notes: a.guardrails.length }
    } finally { await t.close(); await api.close() }
  }
  assert.deepEqual(results.viasocket, results.backup)
  assert.equal(results.viasocket.complexity, 'L2', 'L4 from the title alone is capped')
  assert.equal(results.viasocket.quality, 'insufficient_evidence', 'invented reference removed')
  assert.equal(results.viasocket.estimated, 0, 'invented number dropped')
})

// ---------- 6. supervised by default ----------
test('6. with viaSocket + backup configured, mode defaults to supervised and nothing is analysed automatically', async () => {
  const api = await fakeAnthropic()
  const vs = stubVs(() => ({ content: VALID, finishReason: 'completed' }))
  const p = provider(vs, api)
  assert.equal(aiMode({ ai: {} }, p).mode, 'supervised')
  const t = await startApp({ ai: p, cfgOverrides: { ai: {} } })
  try {
    const s = seedOrg(t.db)
    const id = await submitted(t, s)
    await t.call(`/api/tasks/${id}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED' } })
    await t.settled(); await measurementSettled()
    assert.equal(vs.calls.length + api.seen.length, 0)
    assert.equal((await t.call('/api/health')).body.aiMode, 'supervised')
  } finally { await t.close(); await api.close() }
})

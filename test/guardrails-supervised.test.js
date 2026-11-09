// Phase 1.1: the tightened guardrails (quality signals, corroboration by author, task-only citations, confidence
// ceiling, number checks, impact basis) and the supervised live-AI validation mode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { reportsQualityProblem } from '../server/measurement/evidence-pack.js'
import { aiMode } from '../server/measurement/assessments.js'

const none = () => ({ state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'n', evidence_refs: [] })
const rate = (level, refs, confidence = 0.9) => ({ state: 'assessed', level, confidence, reason: 'r', evidence_refs: refs })
const out = (o = {}) => ({
  understanding: 'u', complexity: o.complexity || { state: 'insufficient_evidence', level: 'none', confidence: 0.3, reason: 'n', evidence_refs: [] },
  dimensions: { impact: none(), quality: none(), ownership: none(), problem_solving: none(), collaboration: none(), ...(o.dims || {}) },
  contribution_summary: 's', estimated_outcomes: o.estimated || [], missing_information: [], blocker_note: '', shared_contribution_note: ''
})
const scripted = (fn) => { const p = { configured: true, name: 'scripted', model: 'scripted-v1', calls: 0 }; p.generate = async ({ user }) => { p.calls++; const pack = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1)); return { output: fn(pack), model: 'scripted-v1', usage: null } }; return p }
const refs = (pack, kind, author) => pack.items.filter((i) => i.kind === kind && (!author || i.author === author)).map((i) => i.ref)

async function work(t, s, { description = 'Partners need a guide to the orders API with authentication and pagination examples for the v2 launch.', summary = 'Wrote the guide with curl examples for auth and pagination.', comments = [] } = {}) {
  const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Write the partner API guide', description, assigneeId: s.employee.id } })
  const id = c.body.task.id
  await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
  for (const [who, body] of comments) await t.call(`/api/tasks/${id}/comments`, { method: 'POST', as: s[who], body: { body } })
  await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s.employee, body: { summary, outcome: 'Guide published.' } })
  await t.settled(); await measurementSettled(); await t.settled()
  return id
}
async function analyse(t, as, id) {
  const r = await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as })
  await measurementSettled(); await t.settled()
  return { r, v: (await t.call(`/api/tasks/${id}/assessment`, { as })).body }
}
const dim = (v, k) => v.assessment.dimensions.find((d) => d.key === k)

test('quality text signal: problems reported, but not negations, fixes or regression tests', () => {
  for (const p of ['Tests are failing in CI for rounding', '3 tests still failing in checkout', 'CI is red on main since this merged', 'This regressed the export', 'Regression: totals broke after release', 'We rolled back the release', 'test failures in payments'])
    assert.equal(reportsQualityProblem(p), true, p)
  for (const p of ['Added a regression test for lowercase codes', 'No regressions found in staging', 'Fixed the failing tests from yesterday', 'all tests pass now', 'Resolved the CI is red issue by pinning the version', 'without breaking the API', 'regression suite green'])
    assert.equal(reportsQualityProblem(p), false, p)
})

test('corroboration is judged by author: the employee\'s own comment cannot make work L4; a manager\'s can', async () => {
  const ai = scripted((pack) => out({ complexity: { state: 'assessed', level: 'L4', confidence: 0.9, reason: 'r', evidence_refs: [...refs(pack, 'comment', 'employee'), ...refs(pack, 'comment', 'manager')] } }))
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const own = await work(t, s, { comments: [['employee', 'This turned out to be a very deep, novel, cross-system investigation.']] })
    assert.equal((await analyse(t, s.employee, own)).v.assessment.complexity.levelText, 'L2')
    const mgr = await work(t, s, { comments: [['manager', 'Confirmed: this needed changes across billing, orders and the partner gateway.']] })
    assert.equal((await analyse(t, s.employee, mgr)).v.assessment.complexity.levelText, 'L4')
  } finally { await t.close() }
})

test('a rating that cites only the task description is not a rating; confidence is capped when only self-reported', async () => {
  const ai = scripted((pack) => out({
    complexity: { state: 'assessed', level: 'L2', confidence: 0.95, reason: 'r', evidence_refs: refs(pack, 'submission') },
    dims: { quality: rate(5, ['task']), ownership: rate(4, refs(pack, 'submission'), 0.95) }
  }))
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const { v } = await analyse(t, s.employee, await work(t, s))
    assert.equal(dim(v, 'quality').state, 'insufficient_evidence')
    assert.ok(v.assessment.guardrails.some((n) => /cited only the task description/.test(n)))
    assert.equal(dim(v, 'ownership').confidence, 0.6); assert.equal(v.assessment.complexity.confidence, 0.6)
    assert.ok(v.assessment.guardrails.some((n) => /Confidence capped at 0.6/.test(n)))
    assert.equal(v.assessment.impact.basis, 'claimed')
  } finally { await t.close() }
})

test('numbers in estimates must appear in the human text of the evidence (not in ids or timestamps)', async () => {
  const year = String(new Date().getUTCFullYear()) // in every timestamp of the pack, in none of its human text
  const ai = scripted((pack) => out({
    complexity: { state: 'assessed', level: 'L2', confidence: 0.7, reason: 'r', evidence_refs: refs(pack, 'submission') },
    estimated: [{ description: `Saves ${year} hours a week`, basis_refs: refs(pack, 'submission') }, { description: 'Guide covers 12 endpoints', basis_refs: refs(pack, 'submission') }]
  }))
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const { v } = await analyse(t, s.employee, await work(t, s, { summary: 'Wrote the guide covering all 12 endpoints with curl examples.' }))
    const texts = v.assessment.impact.estimated.map((e) => e.text)
    assert.deepEqual(texts, ['Guide covers 12 endpoints'], 'a number that only matches a timestamp is dropped')
  } finally { await t.close() }
})

test('supervised mode: default for a real provider; admin only; selected task with the right owner; no automatic runs, events or notifications', async () => {
  assert.equal(aiMode({ ai: {} }, { configured: true }).mode, 'supervised')
  assert.equal(aiMode({ ai: {} }, { configured: true, simulated: true }).mode, 'on')
  assert.equal(aiMode({ ai: {} }, { configured: false }).mode, 'off')
  assert.equal(aiMode({ ai: { mode: 'on' } }, { configured: true }).mode, 'on')
  const ai = scripted((pack) => out({ complexity: { state: 'assessed', level: 'L2', confidence: 0.7, reason: 'r', evidence_refs: refs(pack, 'submission') } }))
  const t = await startApp({ ai, cfgOverrides: { ai: { mode: 'supervised' } } })
  try {
    const s = seedOrg(t.db)
    const id = await work(t, s)
    assert.equal(ai.calls, 0, 'no automatic analysis on submission')
    assert.equal((await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.admin })).body.error.code, 'ai_supervised', 'not selected')
    const view = (await t.call(`/api/tasks/${id}/assessment`, { as: s.admin })).body
    assert.equal(view.ai.mode, 'supervised'); assert.equal(view.ai.selectedForSupervisedTest, false); assert.equal(view.can.analyse, false)
    // Selected, but named for the wrong owner → refused before anything is sent.
    t.app.locals.aiMode.tasks.set(id, 'someone.else@example.com')
    assert.equal((await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.admin })).body.error.code, 'supervised_owner_mismatch')
    t.app.locals.aiMode.tasks.set(id, s.employee.email)
    assert.equal((await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.manager })).status, 403, 'admins only')
    assert.equal((await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.employee })).status, 403)
    assert.equal(ai.calls, 0)
    // Preview: exactly what would be sent; nothing written, nothing fetched.
    const count = (tb) => t.db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n
    const tables = ['ai_evaluation_runs', 'contribution_assessments', 'notifications', 'alert_deliveries', 'automation_execution_logs', 'event_outbox', 'audit_log', 'task_events']
    const before = Object.fromEntries(tables.map((x) => [x, count(x)]))
    const taskBefore = t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    const pv = await t.call(`/api/tasks/${id}/assessment/preview`, { as: s.admin })
    assert.equal(pv.status, 200); assert.equal(pv.body.wouldCallModel, true); assert.equal(pv.body.externalSources, 0); assert.equal(pv.body.filesOpened, 0)
    assert.ok(pv.body.pack.items.some((i) => i.kind === 'submission')); assert.equal(pv.body.blockedBy, null)
    assert.equal((await t.call(`/api/tasks/${id}/assessment/preview`, { as: s.outsider })).status, 404)
    assert.deepEqual(Object.fromEntries(tables.map((x) => [x, count(x)])), before, 'preview writes nothing')
    // The supervised run: one model call, one run, one assessment, one audit row — and nothing else.
    const r = await analyse(t, s.admin, id)
    assert.equal(r.r.status, 200); assert.equal(ai.calls, 1)
    const after = Object.fromEntries(tables.map((x) => [x, count(x)]))
    assert.deepEqual({ ...after, ai_evaluation_runs: before.ai_evaluation_runs + 1, contribution_assessments: before.contribution_assessments + 1, audit_log: before.audit_log + 1 }, after)
    assert.equal(after.notifications, before.notifications, 'no notification'); assert.equal(after.event_outbox, before.event_outbox, 'no event emitted')
    assert.equal(after.alert_deliveries, before.alert_deliveries, 'no M91'); assert.equal(after.automation_execution_logs, before.automation_execution_logs, 'no Slack/Gmail/flows')
    assert.deepEqual(t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), taskBefore, 'the task itself is untouched')
    const audit = t.db.prepare(`SELECT * FROM audit_log WHERE action = 'assessment.created' ORDER BY created_at DESC`).get()
    assert.equal(audit.actor_id, s.admin.id)
    assert.equal(r.v.assessment.live, true); assert.equal(r.v.assessment.simulated, false)
  } finally { await t.close() }
  const off = await startApp({ ai: scripted(() => out()), cfgOverrides: { ai: { mode: 'off' } } })
  try {
    const s = seedOrg(off.db)
    const id = await work(off, s)
    assert.equal((await off.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.admin })).body.error.code, 'ai_off')
  } finally { await off.close() }
})

test('re-analysis never hides earlier human responses', async () => {
  let level = 'L2'
  const ai = scripted((pack) => out({ complexity: { state: 'assessed', level, confidence: 0.7, reason: 'r', evidence_refs: refs(pack, 'submission') }, dims: { quality: rate(4, refs(pack, 'submission')) } }))
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const id = await work(t, s)
    await analyse(t, s.employee, id)
    await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'ADJUST', dimension: 'quality', level: 3, comment: 'No validation shown.' } })
    await t.call(`/api/tasks/${id}/comments`, { method: 'POST', as: s.employee, body: { body: 'Linked the review thread with partners.' } })
    level = 'L3'
    const { v } = await analyse(t, s.employee, id)
    const earlier = v.history[0]
    assert.ok(earlier.responses.some((x) => x.action === 'ADJUST' && x.comment === 'No validation shown.' && x.by === 'Mona Manager'))
  } finally { await t.close() }
})

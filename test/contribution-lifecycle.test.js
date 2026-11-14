// The task-driven contribution lifecycle: a submitted task is assessed automatically; routine work and work without enough evidence are recorded but
// not queued; a meaningful contribution waits for a manager, who approves, adjusts or disputes it; repeated events never make a second assessment;
// without AI the task workflow still works and says so; and the admin's system view is for admins only and shows no secret.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'
import { measurementSettled, onWorkEvent } from '../server/measurement/engine.js'
import { lifecycleOfAssessment } from '../server/measurement/lifecycle.js'

// ---------- a scripted "reasonable" model: complexity from what the work describes, citing it ----------
const none = () => ({ state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'No evidence for this.', evidence_refs: [] })
const rate = (level, refs) => ({ state: 'assessed', level, confidence: 0.8, reason: 'Rated from the cited evidence.', evidence_refs: refs })
const refsOf = (pack, kind) => pack.items.filter((i) => i.kind === kind).map((i) => i.ref)
function scripted() {
  const p = { configured: true, name: 'scripted', model: 'scripted-v1', calls: 0 }
  p.generate = async ({ user }) => {
    p.calls++
    const pack = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1))
    const deep = /investigat|root cause|race condition|across (?:three|multiple) services|novel/i.test(JSON.stringify(pack.items) + (pack.task.description || ''))
    const work = [...refsOf(pack, 'submission'), ...refsOf(pack, 'evidence')]
    const level = deep ? 'L4' : 'L1'
    return { model: 'scripted-v1', usage: { input_tokens: 1, output_tokens: 1 }, output: {
      understanding: 'Understood from the evidence.',
      complexity: { state: 'assessed', level, confidence: 0.85, reason: 'From the evidence.', evidence_refs: deep ? work : refsOf(pack, 'submission') },
      dimensions: { impact: none(), quality: rate(3, refsOf(pack, 'submission')), ownership: rate(4, refsOf(pack, 'submission')), problem_solving: deep ? rate(5, work) : none(), collaboration: none() },
      contribution_summary: 'Summary.', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: ''
    } }
  }
  return p
}

async function submitTask(t, { manager, employee }, { title, description, summary, outcome, links = [] }) {
  const c = await t.call('/api/tasks', { method: 'POST', as: manager, body: { title, description, assigneeId: employee.id, expectedOutcome: 'Working as described.' } })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  const id = c.body.task.id
  await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: employee, body: { status: 'IN_PROGRESS' } })
  const s = await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: employee, body: { summary, outcome, evidenceLinks: links.map((url) => ({ url, label: url.split('/').pop() })) } })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  return id
}
const settle = async (t) => { await t.settled(); await measurementSettled(); await t.settled(); await measurementSettled() }
const ROUTINE = { title: 'Rename the settings button', description: 'Rename the button label on the settings page to match the new copy from marketing.', summary: 'Renamed the button label on the settings page.', outcome: 'Label updated.' }
const COMPLEX = {
  title: 'Fix intermittent checkout failures', description: 'Checkout fails for about 2% of users with no clear error. Needs investigation across three services (cart, payments, inventory).',
  summary: 'Investigated logs across cart, payments and inventory. Found the root cause: a race condition between the inventory reservation and payment capture. Designed a novel idempotent reservation token and added a regression test.',
  outcome: 'Checkout failures stopped in staging.', links: ['https://github.com/acme/shop/pull/481', 'https://grafana.acme.test/d/checkout']
}
const lifecycleOf = (t, id) => { const a = t.db.prepare('SELECT * FROM contribution_assessments WHERE task_id = ? AND is_current = 1').get(id); return a ? lifecycleOfAssessment(t.db, a) : null }

test('routine work, work without enough evidence and a meaningful contribution take different paths; only the meaningful one waits for a manager', async () => {
  const t = await startApp({ ai: scripted() })
  try {
    const s = seedOrg(t.db)
    const routine = await submitTask(t, s, ROUTINE)
    const thin = await submitTask(t, s, { title: 'Fix it', summary: 'Done.', outcome: 'Done.' })
    const hard = await submitTask(t, s, COMPLEX)
    await settle(t)
    // Each completed task is assessed on its own, with no one asking for it.
    assert.equal(lifecycleOf(t, routine), 'ROUTINE')
    assert.equal(lifecycleOf(t, thin), 'NOT_ENOUGH_EVIDENCE')
    assert.equal(lifecycleOf(t, hard), 'SUBMITTED_FOR_REVIEW')
    // The manager's queue holds the meaningful one only: not the routine task, not the one with too little evidence.
    const team = (await t.call('/api/contribution/team', { as: s.manager })).body.people.find((p) => p.userId === s.employee.id)
    assert.equal(team.awaitingYourReview, 1)
    assert.equal(team.routine, 1); assert.equal(team.notEnoughEvidence, 1); assert.equal(team.approved, 0)
    const queue = (await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'review' } })).body
    const analyses = JSON.stringify(queue.items.filter((i) => i.text.startsWith('Analysis')))
    assert.match(analyses, /Fix intermittent checkout failures/)
    assert.doesNotMatch(analyses, /Rename the settings button|Fix it/)
    // The profile says where each piece of work stands, so nothing is guessed on the screen.
    const work = (await t.call(`/api/contribution/people/${s.employee.id}`, { as: s.manager })).body.work
    assert.deepEqual(Object.fromEntries(work.map((w) => [w.taskTitle, w.lifecycle])), { 'Rename the settings button': 'ROUTINE', 'Fix it': 'NOT_ENOUGH_EVIDENCE', 'Fix intermittent checkout failures': 'SUBMITTED_FOR_REVIEW' })
    const insufficient = (await t.call(`/api/tasks/${thin}/assessment`, { as: s.employee })).body.assessment
    assert.equal(insufficient.evidenceState, 'insufficient'); assert.equal(insufficient.complexity.level, null, 'nothing invented')
    // A manager can still open and review routine work if they want to.
    assert.equal((await t.call(`/api/tasks/${routine}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'APPROVE' } })).status, 200)
    assert.equal(lifecycleOf(t, routine), 'APPROVED')
  } finally { await t.close() }
})

test('a manager approves, adjusts or disputes; the employee cannot approve their own; the decision leaves the queue and joins the history', async () => {
  const t = await startApp({ ai: scripted() })
  try {
    const s = seedOrg(t.db)
    const a = await submitTask(t, s, { ...COMPLEX, title: 'Fix checkout failures A' })
    const b = await submitTask(t, s, { ...COMPLEX, title: 'Fix checkout failures B' })
    const c = await submitTask(t, s, { ...COMPLEX, title: 'Fix checkout failures C' })
    await settle(t)
    const row = async () => (await t.call('/api/contribution/team', { as: s.manager })).body.people.find((p) => p.userId === s.employee.id)
    assert.equal((await row()).awaitingYourReview, 3)
    const review = (id, as, body) => t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as, body })
    // Not the employee, not another team's manager, not a manager on their own work.
    assert.equal((await review(a, s.employee, { action: 'APPROVE' })).status, 403, 'employees never approve their own assessment')
    assert.equal((await review(a, s.manager2, { action: 'APPROVE' })).status, 404)
    assert.equal(lifecycleOf(t, a), 'SUBMITTED_FOR_REVIEW')
    assert.equal((await review(a, s.manager, { action: 'APPROVE' })).status, 200); assert.equal(lifecycleOf(t, a), 'APPROVED')
    assert.equal((await review(b, s.manager, { action: 'ADJUST', dimension: 'quality', level: 2, comment: 'Monitoring is not in place yet.' })).status, 200); assert.equal(lifecycleOf(t, b), 'ADJUSTED')
    assert.equal((await review(c, s.manager, { action: 'MANAGER_DISPUTE' })).status, 400, 'a reason is required')
    assert.equal((await review(c, s.manager, { action: 'MANAGER_DISPUTE', comment: 'The PR does not show a regression test.' })).status, 200); assert.equal(lifecycleOf(t, c), 'DISPUTED')
    const after = await row()
    assert.equal(after.awaitingYourReview, 0, 'decided work is history, not queue')
    assert.equal(after.approved, 2, 'approved and adjusted both count as manager-reviewed contributions')
    // The employee sees the outcome and the reasons.
    const mine = (await t.call(`/api/tasks/${c}/assessment`, { as: s.employee })).body.assessment
    assert.equal(mine.managerStatus, 'DISPUTED')
    assert.ok(mine.feedback.some((f) => f.actorRole === 'manager' && /regression test/.test(f.comment || '')))
  } finally { await t.close() }
})

test('repeated submission events and retries never create a second assessment or a second model call', async () => {
  const ai = scripted()
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const id = await submitTask(t, s, COMPLEX)
    await settle(t)
    const calls = ai.calls
    assert.equal(calls, 1)
    const event = { type: 'task.submitted', orgId: s.org.id, taskId: id, actorId: s.employee.id }
    for (let i = 0; i < 4; i++) onWorkEvent(t.db, ai, event, { mode: 'on' })
    for (let i = 0; i < 3; i++) assert.equal((await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.employee })).body.status, 'unchanged')
    await settle(t)
    assert.equal(ai.calls, calls, 'identical input is never sent again')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments WHERE task_id = ?').get(id).n, 1)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM ai_evaluation_runs WHERE task_id = ? AND status = 'SUCCEEDED'`).get(id).n, 1)
    // A decided assessment is not replaced by an automatic event either.
    await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'APPROVE' } })
    onWorkEvent(t.db, ai, { ...event, type: 'task.reviewed', decision: 'APPROVED' }, { mode: 'on' })
    await settle(t)
    assert.equal(lifecycleOf(t, id), 'APPROVED'); assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments WHERE task_id = ?').get(id).n, 1)
  } finally { await t.close() }
})

test('without AI the task workflow still completes, nothing is pretended, and the state is explained', async () => {
  const t = await startApp() // no provider configured
  try {
    const s = seedOrg(t.db)
    const id = await submitTask(t, s, COMPLEX) // submitting works
    await settle(t)
    assert.equal((await t.call(`/api/tasks/${id}`, { as: s.employee })).body.task.status, 'SUBMITTED_FOR_REVIEW')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments').get().n, 0, 'no invented assessment, no deterministic stand-in presented as AI')
    const view = (await t.call(`/api/tasks/${id}/assessment`, { as: s.employee })).body
    assert.equal(view.assessment, null); assert.equal(view.ai.configured, false); assert.ok(view.ai.reason || view.ai.configured === false)
    assert.equal((await t.call('/api/session', { as: s.employee })).body.integrations.ai, 'not_configured')
    assert.equal((await t.call(`/api/tasks/${id}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED' } })).status, 200, 'the manager’s own task review is unaffected')
    assert.equal((await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.employee })).status, 503)
    assert.equal((await t.call('/api/contribution/team', { as: s.manager })).body.people.find((p) => p.userId === s.employee.id).awaitingYourReview, 0)
  } finally { await t.close() }
})

test('the admin system view is for admins only, lists the exact steps to turn AI on, and never contains a secret', async () => {
  const t = await startApp({ cfgOverrides: { ai: { provider: 'viasocket', apiKey: 'sk-TEST-SECRET-VALUE', viasocketPolicyConfirmed: false, mode: '', supervisedTasks: '' } } })
  try {
    const s = seedOrg(t.db)
    for (const who of [s.manager, s.employee, s.manager2]) assert.equal((await t.call('/api/admin/system', { as: who })).status, 403, 'managers and employees do not get the system view')
    assert.equal((await t.call('/api/admin/system')).status, 401)
    const r = await t.call('/api/admin/system', { as: s.admin })
    assert.equal(r.status, 200)
    assert.equal(r.body.organization.name, 'Acme')
    assert.equal(r.body.organization.members.employee, 3); assert.equal(r.body.organization.members.manager, 2)
    assert.equal(r.body.ai.configured, false); assert.equal(r.body.ai.live, false); assert.equal(r.body.ai.requestedProvider, 'viasocket'); assert.equal(r.body.ai.policyConfirmed, false)
    assert.ok(r.body.ai.steps.some((x) => /AI_VIASOCKET_POLICY_CONFIRMED=true/.test(x)) && r.body.ai.steps.some((x) => /AI_MODE=on/.test(x)))
    assert.doesNotMatch(r.text, /sk-TEST-SECRET-VALUE|apiKey|embed_secret|token/i, 'configured / not configured only')
    // Another organization's admin sees only their own organization.
    const other = (await t.call('/api/admin/system', { as: s.otherAdmin })).body
    assert.equal(other.organization.name, 'Globex'); assert.equal(other.organization.members.employee, 0)
  } finally { await t.close() }
})

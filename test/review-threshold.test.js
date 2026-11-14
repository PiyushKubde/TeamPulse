// The exact rules that decide whether an assessment is queued for a manager (see docs/contribution-review-rules.md), one rule per test,
// and the controlled backlog workflow for tasks that were submitted before assessments existed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { lifecycleOfAssessment, isMeaningful, MEANINGFUL_LEVEL } from '../server/measurement/lifecycle.js'

const none = () => ({ state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'No evidence for this.', evidence_refs: [] })
const rate = (level, refs) => ({ state: 'assessed', level, confidence: 0.8, reason: 'Rated from the cited evidence.', evidence_refs: refs })
const refsOf = (pack, kind) => pack.items.filter((i) => i.kind === kind).map((i) => i.ref)

/** A model whose complexity / impact rating is chosen by a marker in the task title: "[c3]" complexity L3, "[i3]" impact 3. */
function scripted() {
  const p = { configured: true, name: 'scripted', model: 'scripted-v1', calls: 0 }
  p.generate = async ({ user }) => {
    p.calls++
    const pack = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1))
    const title = pack.task.title
    const c = Number(/\[c(\d)\]/.exec(title)?.[1] || 1)
    const i = Number(/\[i(\d)\]/.exec(title)?.[1] || 0)
    const sub = [...refsOf(pack, 'submission'), ...refsOf(pack, 'evidence')]
    return { model: 'scripted-v1', usage: { input_tokens: 1, output_tokens: 1 }, output: {
      understanding: 'Understood from the evidence.',
      complexity: rate(`L${c}`, sub),
      dimensions: { impact: i ? rate(i, sub) : none(), quality: rate(3, sub), ownership: rate(3, sub), problem_solving: none(), collaboration: none() },
      contribution_summary: 'Summary.', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: ''
    } }
  }
  return p
}

let prs = 100
const BODY = 'Wrote the migration, ran it against a copy of production data, checked row counts and added a rollback script for the release.'
async function submit(t, { manager, employee }, title, { thin = false } = {}) {
  const c = await t.call('/api/tasks', { method: 'POST', as: manager, body: { title, description: thin ? '' : 'Move the orders table to the new schema without downtime.', assigneeId: employee.id } })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  const id = c.body.task.id
  await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: employee, body: { status: 'IN_PROGRESS' } })
  const r = await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: employee, body: thin ? { summary: 'Done.', outcome: 'Done.' } : { summary: BODY, outcome: 'Migrated, no downtime.', evidenceLinks: [{ url: 'https://github.com/acme/shop/pull/' + (++prs), label: 'PR' }] } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return id
}
const settle = async (t) => { await t.settled(); await measurementSettled(); await t.settled(); await measurementSettled() }
const current = (t, id) => t.db.prepare('SELECT * FROM contribution_assessments WHERE task_id = ? AND is_current = 1').get(id)
const lifecycle = (t, id) => { const a = current(t, id); return a ? lifecycleOfAssessment(t.db, a) : null }
const queue = async (t, as) => JSON.stringify((await t.call('/api/assistant/ask', { method: 'POST', as, body: { team: true, intent: 'review' } })).body.items.filter((i) => i.text.startsWith('Analysis')))

test('the review threshold: routine work is recorded but not queued; meaningful work is; no evidence is never a verdict', async () => {
  assert.equal(MEANINGFUL_LEVEL, 3)
  const t = await startApp({ ai: scripted() })
  try {
    const s = seedOrg(t.db)
    const ids = {
      lowComplexity: await submit(t, s, 'Routine change [c1]'),
      l2: await submit(t, s, 'Small change [c2]'),
      l3: await submit(t, s, 'Hard change [c3]'),
      l4: await submit(t, s, 'Very hard change [c4]'),
      impact3: await submit(t, s, 'Quiet but important [c1][i3]'),
      thin: await submit(t, s, 'Fix it', { thin: true })
    }
    await settle(t)
    assert.equal(lifecycle(t, ids.lowComplexity), 'ROUTINE', 'complexity 1 is routine')
    assert.equal(lifecycle(t, ids.l2), 'ROUTINE', 'complexity 2 is below the threshold')
    assert.equal(lifecycle(t, ids.l3), 'SUBMITTED_FOR_REVIEW', 'complexity 3 meets the threshold')
    assert.equal(lifecycle(t, ids.l4), 'SUBMITTED_FOR_REVIEW')
    assert.equal(lifecycle(t, ids.impact3), 'SUBMITTED_FOR_REVIEW', 'an impact estimate of 3 meets the threshold even for simple work')
    assert.equal(lifecycle(t, ids.thin), 'NOT_ENOUGH_EVIDENCE', 'too little to judge is its own state, not a low score')
    const q = await queue(t, s.manager)
    for (const queued of ['Hard change', 'Very hard change', 'Quiet but important']) assert.match(q, new RegExp(queued))
    for (const quiet of ['Routine change', 'Small change', 'Fix it']) assert.doesNotMatch(q, new RegExp(quiet), `${quiet} is recorded, not queued`)
    // Every assessment is still recorded and open to a manager who wants to look.
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments').get().n, 6)
    // Not enough evidence: nothing was rated, nothing was invented, and nothing says the person did poorly.
    const thin = (await t.call(`/api/tasks/${ids.thin}/assessment`, { as: s.manager })).body.assessment
    assert.equal(thin.evidenceState, 'insufficient'); assert.equal(thin.complexity.level, null)
    const people = (await t.call('/api/contribution/team', { as: s.manager })).body.people.find((p) => p.userId === s.employee.id)
    assert.equal(people.awaitingYourReview, 3); assert.equal(people.routine, 2); assert.equal(people.notEnoughEvidence, 1)
    assert.ok(!JSON.stringify(people).match(/rank|score|leaderboard/i), 'no score or ranking')
  } finally { await t.close() }
})

test('corrected and disputed assessments stay visible to the manager, whatever the complexity or evidence', async () => {
  const t = await startApp({ ai: scripted() })
  try {
    const s = seedOrg(t.db)
    const routine = await submit(t, s, 'Routine change [c1]')
    const thin = await submit(t, s, 'Fix it', { thin: true })
    await settle(t)
    assert.equal(lifecycle(t, routine), 'ROUTINE'); assert.equal(lifecycle(t, thin), 'NOT_ENOUGH_EVIDENCE')
    // The employee says routine work was understated, and that "not enough evidence" is wrong: both now need a manager.
    assert.equal((await t.call(`/api/tasks/${routine}/assessment/respond`, { method: 'POST', as: s.employee, body: { action: 'PROPOSE_CORRECTION', dimension: 'complexity', level: 4, comment: 'There was a data migration behind this.' } })).status, 200)
    assert.equal((await t.call(`/api/tasks/${thin}/assessment/respond`, { method: 'POST', as: s.employee, body: { action: 'DISPUTE', comment: 'The work is in the repository, it was not read.' } })).status, 200)
    assert.equal(lifecycle(t, routine), 'SUBMITTED_FOR_REVIEW'); assert.equal(lifecycle(t, thin), 'SUBMITTED_FOR_REVIEW')
    const q = await queue(t, s.manager)
    assert.match(q, /Routine change/); assert.match(q, /Fix it/)
    // A decided assessment leaves the queue but stays in the record, with its reason.
    assert.equal((await t.call(`/api/tasks/${routine}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'MANAGER_DISPUTE', comment: 'The migration was a one-line change.' } })).status, 200)
    assert.equal(lifecycle(t, routine), 'DISPUTED')
    assert.doesNotMatch(await queue(t, s.manager), /Routine change/)
    const work = (await t.call(`/api/contribution/people/${s.employee.id}`, { as: s.manager })).body.work
    assert.equal(work.find((w) => w.taskTitle === 'Routine change [c1]').lifecycle, 'DISPUTED', 'a disputed assessment remains visible on the person’s record')
  } finally { await t.close() }
})

test('isMeaningful is a pure function of the assessment: the same rules the queue uses', async () => {
  const t = await startApp({ ai: scripted() })
  try {
    const s = seedOrg(t.db)
    const id = await submit(t, s, 'Hard change [c3]')
    await settle(t)
    const a = current(t, id)
    assert.equal(isMeaningful(t.db, a), true)
    assert.equal(isMeaningful(t.db, { ...a, provider: 'rules' }), false, 'a rules answer (no evidence) is never meaningful on its own')
    assert.equal(isMeaningful(t.db, { ...a, evidence_state: 'insufficient' }), false)
    assert.equal(isMeaningful(t.db, { ...a, provider: 'rules', employee_status: 'DISPUTED' }), true, 'but a dispute by the employee is')
  } finally { await t.close() }
})

// ------------------------------------------------------------------ the controlled backlog
test('backlog: nothing is assessed automatically; a manager starts it, only when AI is on, once, and a reviewed assessment is never touched', async () => {
  const ai = scripted()
  const t = await startApp({ ai, cfgOverrides: { ai: { mode: 'supervised' } } }) // supervised: nothing runs on submission, like work submitted before AI was on
  try {
    const s = seedOrg(t.db)
    const a = await submit(t, s, 'Hard change [c3]')
    const b = await submit(t, s, 'Routine change [c1]')
    const c = await submit(t, s, 'Fix it', { thin: true })
    // Another team's work, and a task that was never submitted.
    const sales = await t.call('/api/tasks', { method: 'POST', as: s.manager2, body: { title: 'Sales deck', assigneeId: s.outsider.id } })
    await t.call(`/api/tasks/${sales.body.task.id}/status`, { method: 'POST', as: s.outsider, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${sales.body.task.id}/submit`, { method: 'POST', as: s.outsider, body: { summary: BODY, outcome: 'Done.' } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Not submitted yet', assigneeId: s.employee.id } })
    await settle(t)
    assert.equal(ai.calls, 0); assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments').get().n, 0)

    const status = async (as) => (await t.call('/api/assessments/backlog', { as }))
    const mine = await status(s.manager)
    assert.equal(mine.status, 200); assert.equal(mine.body.total, 3, 'only this manager’s team, only submitted work'); assert.equal(mine.body.ai.ready, false); assert.equal(mine.body.ai.state, 'supervised')
    assert.equal((await status(s.manager2)).body.total, 1)
    assert.equal((await status(s.employee)).status, 403); assert.equal((await status(s.admin)).status, 403, 'an admin is not a manager')
    const start = (as, body = {}) => t.call('/api/assessments/backlog/start', { method: 'POST', as, body })
    // AI not allowed to run in bulk right now: refused, nothing sent.
    assert.equal((await start(s.manager)).status, 409); assert.equal(ai.calls, 0)
    // Switching AI on does not start anything by itself.
    t.app.locals.aiMode.mode = 'on'
    await settle(t); assert.equal(ai.calls, 0, 'switching AI on does not backfill history')
    assert.equal((await start(s.employee)).status, 403); assert.equal((await start(s.admin)).status, 403)
    // The manager starts it: three assessments, one model call each for the two with evidence, none for the thin one.
    const r = await start(s.manager)
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.started.length, 3); assert.equal(r.body.remaining, 0)
    await settle(t)
    assert.equal(ai.calls, 2, 'the task with too little evidence is answered by rules, with no model call')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments WHERE org_id = ?').get(s.org.id).n, 3, 'the other team’s task was not touched')
    assert.equal(lifecycle(t, a), 'SUBMITTED_FOR_REVIEW'); assert.equal(lifecycle(t, b), 'ROUTINE'); assert.equal(lifecycle(t, c), 'NOT_ENOUGH_EVIDENCE')
    // Idempotent: starting again does nothing, creates no second assessment or run.
    const runs = t.db.prepare('SELECT COUNT(*) AS n FROM ai_evaluation_runs').get().n
    const again = await start(s.manager)
    assert.equal(again.status, 200); assert.equal(again.body.started.length, 0)
    await settle(t)
    assert.equal(ai.calls, 2); assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM ai_evaluation_runs').get().n, runs)
    assert.equal((await status(s.manager)).body.total, 0)
    // A reviewed assessment is respected: even when new evidence arrives, the backlog never re-runs it.
    assert.equal((await t.call(`/api/tasks/${a}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'APPROVE' } })).status, 200)
    await t.call(`/api/tasks/${a}/comments`, { method: 'POST', as: s.employee, body: { body: 'Added a rollback test afterwards.' } })
    await start(s.manager); await settle(t)
    assert.equal(lifecycle(t, a), 'APPROVED'); assert.equal(ai.calls, 2)
    // Audited.
    assert.ok(t.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'assessment.backlog_started' AND actor_id = ?`).get(s.manager.id).n >= 1)
    // The admin sees a number for the organization (nothing about people or tasks), and the other team’s task is the one left.
    const sys = (await t.call('/api/admin/system', { as: s.admin })).body
    assert.equal(sys.unassessedSubmitted, 1); assert.ok(!JSON.stringify(sys).includes('Sales deck'))
  } finally { await t.close() }
})

test('backlog: with AI off or not configured nothing can be started and the reason is given', async () => {
  const t = await startApp() // no provider
  try {
    const s = seedOrg(t.db)
    await submit(t, s, 'Hard change [c3]')
    const st = (await t.call('/api/assessments/backlog', { as: s.manager })).body
    assert.equal(st.total, 1); assert.equal(st.ai.ready, false); assert.equal(st.ai.state, 'not_configured'); assert.match(st.ai.reason, /not configured/i)
    const r = await t.call('/api/assessments/backlog/start', { method: 'POST', as: s.manager, body: {} })
    assert.equal(r.status, 409)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM ai_evaluation_runs').get().n, 0)
  } finally { await t.close() }
})

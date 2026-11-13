// AI Work Measurement Engine — the ten required scenarios. The model is replaced by deterministic scripted
// providers (no network, no key). Several scripts deliberately behave like a BAD model (inflating complexity,
// citing evidence that does not exist, rating quality 5 on reopened work) to prove the engine's rules hold anyway.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startApp, seedOrg, makeUser, addMember } from './helpers.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { validateOutput } from '../server/measurement/schema.js'

// ---------- scripted providers ----------
const none = (reason = 'No evidence for this.') => ({ state: 'insufficient_evidence', level: 0, confidence: 0.3, reason, evidence_refs: [] })
const rate = (level, refs, reason = 'Rated from the cited evidence.', confidence = 0.8) => ({ state: 'assessed', level, confidence, reason, evidence_refs: refs })
function output({ complexity = ['none', []], impact = none(), quality = none(), ownership = none(), problem_solving = none(), collaboration = none(), estimated = [] } = {}) {
  const [level, refs] = complexity
  return {
    understanding: 'Understood from the evidence.',
    complexity: level === 'none' ? { state: 'insufficient_evidence', level: 'none', confidence: 0.3, reason: 'Not enough.', evidence_refs: [] } : { state: 'assessed', level, confidence: 0.85, reason: 'Judged from the work.', evidence_refs: refs },
    dimensions: { impact, quality, ownership, problem_solving, collaboration },
    contribution_summary: 'Summary.', estimated_outcomes: estimated, missing_information: [], blocker_note: '', shared_contribution_note: ''
  }
}
function scripted(fn, { name = 'scripted', model = 'scripted-v1' } = {}) {
  const p = { configured: true, name, model, calls: 0, packs: [] }
  p.generate = async ({ user, schema, system }) => {
    assert.ok(schema && system.includes('Work volume is not work value'))
    p.calls++
    const pack = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1))
    p.packs.push(pack)
    return { output: fn(pack, p.calls), model, usage: { input_tokens: 100, output_tokens: 50 } }
  }
  return p
}
const refsOf = (pack, kind) => pack.items.filter((i) => i.kind === kind).map((i) => i.ref)

// A "reasonable" model: complexity from what the work describes, citing it.
const reasonable = scripted((pack) => {
  const deep = /investigat|root cause|race condition|across (?:three|multiple) services|novel/i.test(JSON.stringify(pack.items) + (pack.task.description || ''))
  const work = [...refsOf(pack, 'submission'), ...refsOf(pack, 'evidence')]
  return output({
    complexity: [deep ? 'L4' : 'L1', deep ? work : refsOf(pack, 'submission')],
    quality: rate(pack.signals.reviewApproved ? 4 : 3, refsOf(pack, 'submission')),
    ownership: rate(4, refsOf(pack, 'submission')),
    problem_solving: deep ? rate(5, work) : none()
  })
})

// ---------- helpers driving the real API ----------
async function doWork(t, { manager, employee }, { title, description = null, summary, outcome, links = [], notes = [], approve = true, priority = 'MEDIUM' }) {
  const c = await t.call('/api/tasks', { method: 'POST', as: manager, body: { title, description, priority, assigneeId: employee.id, expectedOutcome: description ? 'Working as described.' : undefined } })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  const id = c.body.task.id
  await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: employee, body: { status: 'IN_PROGRESS' } })
  for (const n of notes) await t.call(`/api/tasks/${id}/progress`, { method: 'POST', as: employee, body: { progress: 50, note: n } })
  if (summary) {
    const s = await t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: employee, body: { summary, outcome, evidenceLinks: links.map((url) => ({ url, label: url.split('/').pop() })) } })
    assert.equal(s.status, 200, JSON.stringify(s.body))
    if (approve) assert.equal((await t.call(`/api/tasks/${id}/review`, { method: 'POST', as: manager, body: { decision: 'APPROVED' } })).status, 200)
  }
  return id
}
async function analyse(t, as, id) {
  await t.settled(); await measurementSettled()
  const r = await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as })
  assert.ok([200].includes(r.status), JSON.stringify(r.body))
  await measurementSettled(); await t.settled()
  return (await t.call(`/api/tasks/${id}/assessment`, { as })).body
}
const dim = (view, key) => view.assessment.dimensions.find((d) => d.key === key)
const COMPLEX = {
  title: 'Fix intermittent checkout failures',
  description: 'Checkout fails for about 2% of users with no clear error. Needs investigation across three services (cart, payments, inventory).',
  summary: 'Investigated logs across cart, payments and inventory. Found the root cause: a race condition between the inventory reservation and payment capture. Designed a novel idempotent reservation token, added a regression test and a dashboard.',
  outcome: 'Checkout failures stopped in staging; monitoring in production.',
  links: ['https://github.com/acme/shop/pull/481', 'https://grafana.acme.test/d/checkout']
}

// ---------- Scenario 1 ----------
test('scenario 1 — ticket count fairness: 9 simple tasks are not ranked above 2 complex ones', async () => {
  const t = await startApp({ ai: reasonable })
  try {
    const s = seedOrg(t.db)
    const zara = makeUser(t.db, { name: 'Zara Many' }); addMember(t.db, s.org.id, zara, 'employee', s.teamA)
    const bea = makeUser(t.db, { name: 'Bea Deep' }); addMember(t.db, s.org.id, bea, 'employee', s.teamA)
    for (let i = 1; i <= 9; i++) {
      const id = await doWork(t, { manager: s.manager, employee: zara }, { title: `Rename label ${i}`, description: 'Rename the button label on the settings page to match the new copy document from marketing.', summary: `Renamed the button label number ${i} as asked in the copy document.`, outcome: 'Label updated.' })
      await analyse(t, zara, id)
    }
    for (let i = 1; i <= 2; i++) {
      const id = await doWork(t, { manager: s.manager, employee: bea }, { ...COMPLEX, title: `${COMPLEX.title} (${i})` })
      await analyse(t, bea, id)
    }
    const team = await t.call('/api/contribution/team', { as: s.manager })
    assert.equal(team.status, 200)
    assert.equal(team.body.ordering, 'alphabetical')
    const names = team.body.people.map((p) => p.name)
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'alphabetical, not by volume')
    assert.ok(names.indexOf('Bea Deep') < names.indexOf('Zara Many'), 'the person with fewer tasks is not pushed down')
    assert.doesNotMatch(JSON.stringify(team.body), /"(score|rank|ranking|productivity)"\s*:/i, 'no score or rank anywhere')
    const z = team.body.people.find((p) => p.name === 'Zara Many'); const b = team.body.people.find((p) => p.name === 'Bea Deep')
    assert.equal(z.complexityMix.L1, 9); assert.equal(b.complexityMix.L4, 2)
    const prof = await t.call(`/api/contribution/people/${bea.id}`, { as: s.manager })
    assert.match(prof.body.narrative, /2× L4/)
    assert.equal(prof.body.dimensions.problem_solving.highlights[0].level, 5)
    assert.ok(prof.body.dimensions.problem_solving.highlights[0].reason, 'manager sees why without opening tasks')
  } finally { await t.close() }
})

// ---------- Scenario 2 ----------
test('scenario 2 — complexity: a routine config change is not L4 even if the model or a CRITICAL label says so; real investigation keeps L4', async () => {
  const inflate = scripted((pack) => {
    if (/SMTP/.test(pack.task.title)) return output({ complexity: ['L4', ['task']] }) // bad model: "it's CRITICAL, so L4"
    if (/self-described/.test(pack.task.title)) return output({ complexity: ['L4', refsOf(pack, 'submission')] }) // only the employee's own words
    return output({ complexity: ['L4', [...refsOf(pack, 'submission'), ...refsOf(pack, 'evidence'), ...refsOf(pack, 'review')]] })
  })
  const t = await startApp({ ai: inflate })
  try {
    const s = seedOrg(t.db)
    const routine = await doWork(t, s, { title: 'Change SMTP port to 587', description: 'Update the SMTP port value in the mail settings file from 25 to 587 as per the provider notice.', priority: 'CRITICAL', summary: 'Changed the port value in the settings file and restarted the service.', outcome: 'Port is 587.' })
    const v1 = await analyse(t, s.employee, routine)
    assert.equal(v1.assessment.complexity.levelText, 'L2', 'capped: a label is not evidence')
    assert.ok(v1.assessment.guardrails.some((n) => /title or priority label is not enough/.test(n)))
    assert.equal(v1.assessment.complexity.original, null, 'the cap is applied before storing; the note explains it')
    const self = await doWork(t, s, { title: 'Task self-described as very hard', description: 'Make the export work for the finance team, they reported it is broken for large files.', summary: 'This was extremely complex and novel work involving deep investigation.', outcome: 'Export works.' })
    assert.equal((await analyse(t, s.employee, self)).assessment.complexity.levelText, 'L2', 'L3+ needs corroboration beyond the employee\'s own words')
    const complex = await doWork(t, s, COMPLEX)
    const v3 = await analyse(t, s.employee, complex)
    assert.equal(v3.assessment.complexity.levelText, 'L4')
    assert.ok(v3.assessment.complexity.evidence.some((e) => e.kind === 'evidence' && /pull\/481/.test(e.href)), 'evidence used is shown with links')
  } finally { await t.close() }
})

// ---------- Scenario 3 ----------
test('scenario 3 — insufficient evidence: "Done." produces no invented complexity, quality or impact, and no AI call', async () => {
  const eager = scripted(() => output({ complexity: ['L4', ['task']], quality: rate(5, ['task']), impact: rate(5, ['task']) }))
  const t = await startApp({ ai: eager })
  try {
    const s = seedOrg(t.db)
    const id = await doWork(t, s, { title: 'Fix it', summary: 'Done.', outcome: 'Done.' })
    await t.settled(); await measurementSettled()
    const v = await analyse(t, s.employee, id)
    assert.equal(eager.calls, 0, 'nothing to analyse, so the model is never asked')
    const a = v.assessment
    assert.equal(a.provider, 'rules'); assert.equal(a.evidenceState, 'insufficient')
    assert.equal(a.complexity.state, 'insufficient_evidence'); assert.equal(a.complexity.level, null)
    for (const d of a.dimensions) { assert.equal(d.state, 'insufficient_evidence'); assert.equal(d.level, null) }
    assert.deepEqual(a.impact.verified, []); assert.deepEqual(a.impact.estimated, [])
    assert.ok(a.missing.some((m) => /Evidence of the work/.test(m)))
  } finally { await t.close() }
  // With enough text the model is asked — but citations it invents are removed and the rating dropped.
  const fake = scripted(() => output({ complexity: ['L3', ['evidence-9']], quality: rate(5, ['test-run-1']), estimated: [{ description: 'Saves 40 hours per month', basis_refs: ['submission-1'] }] }))
  const t2 = await startApp({ ai: fake })
  try {
    const s = seedOrg(t2.db)
    const id = await doWork(t2, s, { title: 'Improve the export', description: 'Finance asked for the monthly export to include cost centres and to stop timing out on big months.', summary: 'Added cost centres to the export query and paginated it.', outcome: 'Export includes cost centres.' })
    const a = (await analyse(t2, s.employee, id)).assessment
    assert.equal(a.complexity.state, 'insufficient_evidence', 'invented reference removed → no basis')
    assert.equal(dim({ assessment: a }, 'quality').state, 'insufficient_evidence')
    assert.ok(a.guardrails.some((n) => /do not exist in the evidence/.test(n)))
    assert.deepEqual(a.impact.estimated, [], 'a number not present in the evidence is dropped')
    assert.ok(a.guardrails.some((n) => /numbers not found in the evidence \(40\)/.test(n)))
  } finally { await t2.close() }
})

// ---------- Scenario 4 ----------
test('scenario 4 — quality reflects regressions, failing tests and rework, whatever the model says', async () => {
  const flattering = scripted((pack) => output({ complexity: ['L2', refsOf(pack, 'submission')], quality: rate(5, refsOf(pack, 'submission'), 'Excellent work.') }))
  const t = await startApp({ ai: flattering })
  try {
    const s = seedOrg(t.db)
    const id = await doWork(t, s, { title: 'Ship discount codes', description: 'Customers need discount codes at checkout for the spring campaign, with validation of expiry dates.', summary: 'Implemented discount codes with expiry validation.', outcome: 'Codes work at checkout.' })
    const r = await t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'IN_PROGRESS', reason: 'Regression: checkout totals broke for orders without a code after release.' } })
    assert.equal(r.status, 200)
    const q = dim(await analyse(t, s.employee, id), 'quality')
    assert.equal(q.level, 2, 'reopened after a regression → at most 2')
    assert.match(q.reason, /regression/i)
    // Failing tests at review time, fixed and then approved: rework, not a regression → at most 4.
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Add VAT to invoices', description: 'Invoices must show VAT per line for EU customers from next month onward.', assigneeId: s.employee.id } })
    const id2 = c.body.task.id
    await t.call(`/api/tasks/${id2}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${id2}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Added VAT per invoice line.', outcome: 'VAT shown.' } })
    await t.call(`/api/tasks/${id2}/review`, { method: 'POST', as: s.manager, body: { decision: 'CHANGES_REQUESTED', comment: 'Tests are failing in CI for the rounding cases.' } })
    await t.call(`/api/tasks/${id2}/submit`, { method: 'POST', as: s.employee, body: { summary: 'Fixed rounding; all tests pass now.', outcome: 'VAT shown and rounded correctly.' } })
    await t.call(`/api/tasks/${id2}/review`, { method: 'POST', as: s.manager, body: { decision: 'APPROVED' } })
    const q2 = dim(await analyse(t, s.employee, id2), 'quality')
    assert.equal(q2.level, 4, 'rework before approval caps quality at 4')
    // Writing that you ADDED a regression test is validation, not a regression: no cap.
    const id3 = await doWork(t, s, { title: 'Harden the coupon parser', description: 'Coupon codes with lowercase letters are rejected at checkout; make parsing case-insensitive.', summary: 'Made parsing case-insensitive and added a regression test for lowercase codes.', outcome: 'Lowercase codes accepted.' })
    assert.equal(dim(await analyse(t, s.employee, id3), 'quality').level, 5, 'no false regression from "regression test"')
  } finally { await t.close() }
  // The model ignoring a regression entirely: rules still rate quality from the record.
  const silent = scripted((pack) => output({ complexity: ['L2', refsOf(pack, 'submission')] }))
  const t2 = await startApp({ ai: silent })
  try {
    const s = seedOrg(t2.db)
    const id = await doWork(t2, s, { title: 'Ship discount codes', description: 'Customers need discount codes at checkout for the spring campaign, with validation of expiry dates.', summary: 'Implemented discount codes.', outcome: 'Codes work.' })
    await t2.call(`/api/tasks/${id}/status`, { method: 'POST', as: s.manager, body: { status: 'IN_PROGRESS', reason: 'Regression found in production.' } })
    const q = dim(await analyse(t2, s.employee, id), 'quality')
    assert.equal(q.state, 'assessed'); assert.equal(q.level, 2); assert.equal(q.source, 'rules')
  } finally { await t2.close() }
})

// ---------- Scenario 5 ----------
test('scenario 5 — an external blocker is context, not performance', async () => {
  const harsh = scripted((pack) => output({
    complexity: ['L3', [...refsOf(pack, 'update'), ...refsOf(pack, 'blocker')]],
    impact: rate(1, refsOf(pack, 'blocker'), 'Nothing delivered.'), quality: rate(1, refsOf(pack, 'blocker'), 'Not finished.'),
    ownership: rate(4, [...refsOf(pack, 'blocker'), ...refsOf(pack, 'update')], 'Reported and escalated the blocker promptly.')
  }))
  const t = await startApp({ ai: harsh })
  try {
    const s = seedOrg(t.db)
    const id = await doWork(t, s, { title: 'Integrate payout API', description: 'Connect our payouts to the bank partner API so sellers get paid daily instead of weekly.', notes: ['Built the payout client and mapped the partner schema; waiting for sandbox credentials from the bank.'] })
    const b = await t.call(`/api/tasks/${id}/blockers`, { method: 'POST', as: s.employee, body: { description: 'Bank partner sandbox is down and they have not issued credentials.', dependencyNote: 'Bank partner API', isExternal: true } })
    assert.equal(b.status, 200, JSON.stringify(b.body))
    const v = await analyse(t, s.employee, id)
    for (const k of ['impact', 'quality']) {
      const d = dim(v, k)
      assert.equal(d.state, 'not_applicable', `${k} is not judged while blocked externally`); assert.equal(d.level, null)
      assert.match(d.reason, /outside the employee's control/)
    }
    assert.equal(dim(v, 'ownership').level, 4, 'how the blocker was handled still counts')
    assert.equal(v.assessment.context.blockedOutside, true)
    assert.equal(v.assessment.context.blockers[0].outside, true)
    const prof = await t.call(`/api/contribution/people/${s.employee.id}`, { as: s.manager })
    assert.equal(prof.body.blockers.itemsAffected, 1)
    assert.match(prof.body.narrative, /outside their control.*not a fault/)
  } finally { await t.close() }
})

// ---------- Scenario 6 ----------
test('scenario 6 — a shared outcome is not credited in full to each person, and counts once for the team', async () => {
  const ai = scripted((pack) => output({ complexity: ['L3', refsOf(pack, 'submission')], impact: rate(4, refsOf(pack, 'impact'), 'Cut manual reconciliation time.') }))
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const ids = []
    for (const who of [s.employee, s.employee2]) {
      const id = await doWork(t, { manager: s.manager, employee: who }, { title: `Reconciliation automation (${who.name})`, description: 'Automate the nightly reconciliation between orders and payments, which finance does by hand today.', summary: 'Built my half of the reconciliation job.', outcome: 'Job runs nightly.' })
      const imp = await t.call('/api/impact', { method: 'POST', as: who, body: { taskId: id, title: 'Automated nightly reconciliation', category: 'TIME_SAVED', previousState: 'Finance reconciled by hand every morning.', workPerformed: 'Built part of the job.', result: 'Reconciliation is automatic.', valueType: 'MEASURED', measurableValue: 10, measurementUnit: 'hours/week', sharedOutcomeKey: 'recon-2026' } })
      assert.equal(imp.status, 201, JSON.stringify(imp.body))
      assert.equal((await t.call(`/api/impact/${imp.body.id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'VERIFIED' } })).status, 200)
      ids.push(id)
    }
    const v = await analyse(t, s.employee, ids[0])
    const i = dim(v, 'impact')
    assert.match(i.reason, /Shared outcome.*not attributed to this person alone/)
    assert.equal(v.assessment.impact.verified[0].shared, true)
    assert.deepEqual(v.assessment.impact.verified[0].otherContributors, ['Ed Employee'])
    const prof = await t.call(`/api/contribution/people/${s.employee.id}`, { as: s.manager })
    assert.equal(prof.body.verified.length, 1); assert.equal(prof.body.verified[0].shared, true)
    const team = await t.call('/api/contribution/team', { as: s.manager })
    assert.equal(team.body.team.verifiedOutcomes, 1, 'one shared outcome, counted once for the team')
    assert.equal(team.body.people.filter((p) => p.sharedOutcomes === 1).length, 2, 'each person shows it as shared')
  } finally { await t.close() }
})

// ---------- Scenario 7 ----------
test('scenario 7 — the employee corrects or disputes: saved, original kept, manager told', async () => {
  const t = await startApp({ ai: reasonable })
  try {
    const s = seedOrg(t.db)
    const id = await doWork(t, s, { title: 'Update the onboarding checklist', description: 'Update the onboarding checklist document for new support agents with the new tooling steps.', summary: 'Rewrote the checklist with the new tooling steps and screenshots.', outcome: 'Checklist updated.' })
    const v = await analyse(t, s.employee, id)
    assert.equal(v.assessment.complexity.levelText, 'L1')
    const bad = await t.call(`/api/tasks/${id}/assessment/respond`, { method: 'POST', as: s.employee, body: { action: 'PROPOSE_CORRECTION', dimension: 'complexity', level: 3 } })
    assert.equal(bad.status, 400, 'a reason is required')
    const r = await t.call(`/api/tasks/${id}/assessment/respond`, { method: 'POST', as: s.employee, body: { action: 'PROPOSE_CORRECTION', dimension: 'complexity', level: 3, comment: 'I also had to migrate the whole doc to the new wiki and re-verify every link.' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const a = r.body.assessment
    assert.equal(a.employeeStatus, 'CORRECTION_PROPOSED')
    assert.equal(a.complexity.levelText, 'L1', 'the effective level does not change on the employee\'s word')
    const f = a.feedback.find((x) => x.action === 'PROPOSE_CORRECTION')
    assert.equal(f.fromLevel, 'L1'); assert.equal(f.toLevel, 'L3'); assert.match(f.comment, /new wiki/)
    const rows = t.db.prepare('SELECT * FROM assessment_dimensions WHERE assessment_id = ? AND dimension = ?').all(a.id, 'complexity')
    assert.equal(rows.length, 1); assert.equal(rows[0].source, 'ai'); assert.equal(rows[0].level, 1)
    const d = await t.call(`/api/tasks/${id}/assessment/respond`, { method: 'POST', as: s.employee, body: { action: 'DISPUTE', comment: 'The analysis misses the migration work.' } })
    assert.equal(d.body.assessment.employeeStatus, 'DISPUTED')
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'assessment_feedback'`).get(s.manager.id), 'manager notified')
    // Added context feeds the next analysis (as self-reported), which supersedes but keeps the original.
    await t.call(`/api/tasks/${id}/assessment/respond`, { method: 'POST', as: s.employee, body: { action: 'ADD_CONTEXT', comment: 'Migrated 40 pages to the new wiki.' } })
    const v2 = await analyse(t, s.employee, id)
    assert.notEqual(v2.assessment.id, a.id); assert.ok(v2.history.some((h) => h.id === a.id), 'the earlier assessment is kept in history')
    assert.ok(reasonable.packs.at(-1).items.some((i) => i.kind === 'context' && i.selfReported))
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM assessment_feedback WHERE assessment_id = ?').get(a.id).n, 3, 'old feedback preserved')
    // Others cannot respond on someone's behalf, or review their own.
    assert.equal((await t.call(`/api/tasks/${id}/assessment/respond`, { method: 'POST', as: s.manager, body: { action: 'CONFIRM' } })).status, 403)
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.employee, body: { action: 'APPROVE' } })).status, 403)
  } finally { await t.close() }
})

// ---------- Scenario 8 ----------
test('scenario 8 — a manager adjusts with a reason; history and audit keep the AI original', async () => {
  const t = await startApp({ ai: reasonable })
  try {
    const s = seedOrg(t.db)
    const id = await doWork(t, s, COMPLEX)
    const v = await analyse(t, s.employee, id)
    assert.equal(dim(v, 'quality').level, 4)
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'ADJUST', dimension: 'quality', level: 3 } })).status, 400, 'reason required')
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'ADJUST', dimension: 'quality', level: 9, comment: 'x' } })).status, 400)
    const r = await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'ADJUST', dimension: 'quality', level: 3, comment: 'The production monitoring is not in place yet.' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const q = dim(r.body, 'quality')
    assert.equal(q.level, 3); assert.equal(q.source, 'manager')
    assert.equal(q.original.level, 4); assert.equal(q.original.source, 'ai')
    assert.equal(q.adjustments[0].reason, 'The production monitoring is not in place yet.'); assert.equal(q.adjustments[0].by, 'Mona Manager')
    assert.equal(r.body.assessment.managerStatus, 'ADJUSTED')
    const rows = t.db.prepare(`SELECT * FROM assessment_dimensions WHERE assessment_id = ? AND dimension = 'quality' ORDER BY created_at, rowid`).all(r.body.assessment.id)
    assert.equal(rows.length, 2); assert.equal(rows[0].is_effective, 0); assert.equal(rows[0].level, 4); assert.equal(rows[1].supersedes_id, rows[0].id)
    const au = t.db.prepare(`SELECT * FROM audit_log WHERE action = 'assessment.manager_adjust'`).get()
    assert.deepEqual(JSON.parse(au.before_json), { managerStatus: 'PENDING', level: 4 })
    assert.equal(JSON.parse(au.after_json).reason, 'The production monitoring is not in place yet.')
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'assessment_review'`).get(s.employee.id))
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'MANAGER_DISPUTE' } })).status, 400)
    assert.equal((await t.call(`/api/tasks/${id}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'APPROVE' } })).body.assessment.managerStatus, 'APPROVED')
    // A manager never reviews the analysis of their own work.
    const own = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Plan Q1 roadmap', description: 'Draft the Q1 roadmap with the team leads and agree on the top three bets for the quarter.', assigneeId: s.manager.id } })
    const oid = own.body.task.id
    await t.call(`/api/tasks/${oid}/status`, { method: 'POST', as: s.manager, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${oid}/submit`, { method: 'POST', as: s.manager, body: { summary: 'Drafted the roadmap with the leads.', outcome: 'Roadmap agreed.' } })
    await analyse(t, s.manager, oid)
    assert.equal((await t.call(`/api/tasks/${oid}/assessment/review`, { method: 'POST', as: s.manager, body: { action: 'APPROVE' } })).status, 403)
  } finally { await t.close() }
})

// ---------- Scenario 9 ----------
test('scenario 9 — organization isolation and person-level privacy', async () => {
  const t = await startApp({ ai: reasonable })
  try {
    const s = seedOrg(t.db)
    const id = await doWork(t, s, COMPLEX)
    const v = await analyse(t, s.employee, id)
    const aid = v.assessment.id
    for (const who of [s.otherAdmin, s.outsider, s.manager2]) {
      assert.equal((await t.call(`/api/tasks/${id}/assessment`, { as: who })).status, 404, who.name)
      assert.equal((await t.call(`/api/assessments/${aid}`, { as: who })).status, 404, who.name)
      assert.equal((await t.call(`/api/contribution/people/${s.employee.id}`, { as: who })).status, 404, who.name)
      assert.equal((await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: who })).status, 404, who.name)
    }
    assert.equal((await t.call('/api/contribution/team', { as: s.employee })).status, 403)
    assert.equal((await t.call(`/api/contribution/people/${s.employee2.id}`, { as: s.employee })).status, 404, 'employees cannot see a teammate\'s profile')
    assert.equal((await t.call(`/api/contribution/people/${s.employee.id}`, { as: s.employee })).status, 200, 'but can see their own')
    assert.equal((await t.call(`/api/assessments/${aid}`, { as: s.admin })).status, 200)
    const otherTeam = await t.call('/api/contribution/team', { as: s.manager2 })
    assert.ok(!otherTeam.body.people.some((p) => p.userId === s.employee.id))
    const otherOrg = await t.call('/api/contribution/team', { as: s.otherAdmin })
    assert.deepEqual(otherOrg.body.people, [])
  } finally { await t.close() }
})

// ---------- Scenario 10 + engine behaviour ----------
test('scenario 10 / engine — dedupe, auto-analysis, failures, not configured, schema validation', async () => {
  const ai = scripted((pack) => output({ complexity: ['L2', refsOf(pack, 'submission')] }))
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const id = await doWork(t, s, { title: 'Tidy the release notes', description: 'Collect the merged changes of the sprint into release notes for the customer success team.', summary: 'Wrote the release notes from the merged PR list.', outcome: 'Notes published.' })
    await t.settled(); await measurementSettled(); await t.settled(); await measurementSettled()
    assert.ok(ai.calls >= 1, 'analysed automatically on submission/approval')
    const before = ai.calls
    const again = await t.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.employee })
    assert.equal(again.body.status, 'unchanged'); assert.equal(ai.calls, before, 'identical input → no second model call')
    const run = t.db.prepare(`SELECT * FROM ai_evaluation_runs WHERE status = 'SUCCEEDED' AND provider = 'scripted' ORDER BY created_at DESC`).get()
    assert.equal(run.model, 'scripted-v1'); assert.equal(run.prompt_version, 'work-eval-2026-11-v5'); assert.equal(JSON.parse(run.guardrails_json).version, 'guardrails-2026-11-v5'); assert.equal(run.rubric_version, 'default-2026-11-v2')
    assert.ok(JSON.parse(run.input_json).pack.items.length, 'the exact model input is kept for audit')
    assert.equal(JSON.parse(run.usage_json).input_tokens, 100)
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'assessment_ready'`).get(s.employee.id))
  } finally { await t.close() }

  // Provider failures: non-retryable → FAILED with a message; invalid output twice → FAILED.
  const { ProviderError } = await import('../server/ai/provider.js')
  const broken = { configured: true, name: 'broken', model: 'b1', generate: async () => { throw new ProviderError('auth', 'The AI provider rejected the API key.', false) } }
  const t2 = await startApp({ ai: broken })
  try {
    const s = seedOrg(t2.db)
    const id = await doWork(t2, s, { title: 'Write the API guide', description: 'Write a guide for partners on how to use the orders API, with authentication and pagination examples.', summary: 'Wrote the guide with examples.', outcome: 'Guide published.' })
    const v = await analyse(t2, s.employee, id)
    assert.equal(v.run.status, 'FAILED'); assert.match(v.run.error, /rejected the API key/); assert.equal(v.assessment, null)
  } finally { await t2.close() }
  const garbage = scripted(() => ({ understanding: 'x' }))
  const t3 = await startApp({ ai: garbage })
  try {
    const s = seedOrg(t3.db)
    const id = await doWork(t3, s, { title: 'Write the API guide', description: 'Write a guide for partners on how to use the orders API, with authentication and pagination examples.', summary: 'Wrote the guide with examples.', outcome: 'Guide published.', approve: false })
    const v = await analyse(t3, s.employee, id)
    assert.equal(v.run.status, 'FAILED'); assert.match(v.run.error, /did not match the required structure/)
  } finally { await t3.close() }

  // No provider: sufficient evidence → a clear 503, nothing pretended; health and session say so.
  const t4 = await startApp()
  try {
    const s = seedOrg(t4.db)
    const id = await doWork(t4, s, { title: 'Write the API guide', description: 'Write a guide for partners on how to use the orders API, with authentication and pagination examples.', summary: 'Wrote the guide with examples.', outcome: 'Guide published.' })
    const r = await t4.call(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', as: s.employee })
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'ai_not_configured')
    assert.equal((await t4.call(`/api/tasks/${id}/assessment`, { as: s.employee })).body.ai.configured, false)
    assert.equal((await t4.call('/api/health')).body.ai, 'not_configured')
    assert.equal(t4.db.prepare('SELECT COUNT(*) AS n FROM contribution_assessments').get().n, 0)
  } finally { await t4.close() }

  // The validator rejects extra fields, bad enums and out-of-range confidence.
  const good = output({ complexity: ['L2', ['task']] })
  assert.doesNotThrow(() => validateOutput(structuredClone(good)))
  assert.throws(() => validateOutput({ ...structuredClone(good), score: 9 }), /not allowed/)
  assert.throws(() => validateOutput({ ...structuredClone(good), complexity: { ...good.complexity, level: 'L5' } }), /level/)
  assert.throws(() => validateOutput({ ...structuredClone(good), dimensions: { ...good.dimensions, quality: { ...good.dimensions.quality, confidence: 1.5 } } }), /confidence/)
})

test('scenario 10 — migration 007 is additive only (safe to roll the code back)', () => {
  const sql = readFileSync(new URL('../server/migrations/007_work_measurement.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '')
  const statements = sql.split(';').map((x) => x.trim()).filter(Boolean)
  for (const st of statements) assert.match(st, /^CREATE (TABLE|INDEX|UNIQUE INDEX) /, st.slice(0, 60))
  assert.doesNotMatch(sql, /\b(ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO)\b/i)
})

test('simulated provider is refused in production', async () => {
  const { createAiProvider } = await import('../server/ai/provider.js')
  assert.equal(createAiProvider({ production: true, ai: { provider: 'mock' } }).configured, false)
  assert.equal(createAiProvider({ production: false, ai: { provider: 'mock' } }).simulated, true)
  assert.equal(createAiProvider({ production: true, ai: { provider: 'anthropic', apiKey: '' } }).configured, false)
  const p = createAiProvider({ production: true, ai: { provider: 'anthropic', apiKey: 'sk-test-not-real' } })
  assert.equal(p.configured, true); assert.equal(p.model, 'claude-opus-5-5')
})

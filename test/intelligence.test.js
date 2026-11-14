// Final sprint: AI Work Assistant (day digest + questions), contribution journeys, Manager Copilot, proactive signals,
// optional AI write-up. Records only; the AI is a scripted stand-in where used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { now, uuid } from '../server/db.js'
import { startApp, seedOrg } from './helpers.js'
import { detectSignals } from '../server/intelligence/signals.js'
import { taskRef } from '../server/evidence/matching.js'
import { ProviderError } from '../server/ai/provider.js'

const ago = (h) => new Date(Date.now() - h * 3600000).toISOString()
async function task(t, s, title, extra = {}, who = 'employee') {
  const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title, description: `${title} — details.`, assigneeId: s[who].id, ...extra } })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  return c.body.task.id
}
const start = (t, s, id, who = 'employee') => t.call(`/api/tasks/${id}/status`, { method: 'POST', as: s[who], body: { status: 'IN_PROGRESS' } })
const note = (t, s, id, text, who = 'employee') => t.call(`/api/tasks/${id}/progress`, { method: 'POST', as: s[who], body: { progress: 50, note: text } })
const submit = (t, s, id, who = 'employee') => t.call(`/api/tasks/${id}/submit`, { method: 'POST', as: s[who], body: { summary: 'Done the work with tests.', outcome: 'It works in staging.' } })
const review = (t, s, id, decision, comment) => t.call(`/api/tasks/${id}/review`, { method: 'POST', as: s.manager, body: { decision, comment } })
function evidence(t, s, { app = 'github', kind = 'pr_merged', title, actor, collector, taskId, status = 'confirmed', at = now(), url = null, attribution = 'self' }) {
  const id = uuid()
  t.db.prepare(`INSERT INTO external_evidence (id, org_id, collector_id, app, external_id, kind, actor_user_id, attribution, occurred_at, title, content, resource_ref, source_url, verification, metadata_json, method, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'acme/shop', ?, 'system_recorded', '{}', 'trigger', 'active', ?, ?)`).run(id, s.org.id, collector || actor, app, `x:${id}`, kind, actor, attribution, at, title, title, url, at, at)
  if (taskId) t.db.prepare(`INSERT INTO evidence_task_links (id, org_id, evidence_id, task_id, contributor_id, method, confidence, explanation, status, share, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'explicit_ref', 0.95, 'ref', ?, ?, ?, ?)`)
    .run(uuid(), s.org.id, id, taskId, actor, status, actor === t.db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(taskId).assignee_id ? 'individual' : 'shared', at, at)
  return id
}

test('Analyse my day: completed, delivered, progressed and blocked work, highlights, missing context, priorities — from records only', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const a = await task(t, s, 'Fix checkout double booking'); await start(t, s, a); await note(t, s, a, 'Investigated logs and found the root cause in the queue consumer.'); await submit(t, s, a); await review(t, s, a, 'APPROVED')
    evidence(t, s, { title: `${taskRef(a)} Idempotent booking handler`, actor: s.employee.id, taskId: a })
    const b = await task(t, s, 'Write partner API guide'); await start(t, s, b); await note(t, s, b, 'Drafted the authentication section.')
    const c = await task(t, s, 'Integrate bank payouts'); await start(t, s, c)
    await t.call(`/api/tasks/${c}/blockers`, { method: 'POST', as: s.employee, body: { description: 'Bank sandbox is down', isExternal: true } })
    const d = await task(t, s, 'Update the status page copy'); await start(t, s, d); await submit(t, s, d) // delivered, no evidence
    const r = await t.call('/api/assistant/day', { as: s.employee })
    assert.equal(r.status, 200)
    const dg = r.body
    assert.deepEqual(dg.completed.map((x) => x.title), ['Fix checkout double booking'])
    assert.deepEqual(dg.delivered.map((x) => x.title), ['Update the status page copy'])
    assert.deepEqual(dg.progressed.map((x) => x.title), ['Write partner API guide'])
    assert.deepEqual(dg.blocked.map((x) => x.title), ['Integrate bank payouts'])
    assert.match(dg.summary, /^You completed "Fix checkout double booking"/)
    assert.ok(dg.highlights.some((h) => h.text === 'Fix checkout double booking' && /merged|completed/.test(h.why)))
    assert.ok(dg.missing.some((m) => /Update the status page copy/.test(m.text)), 'delivered without evidence is flagged')
    assert.equal(dg.basis, 'records')
    assert.doesNotMatch(JSON.stringify(dg), /"(score|rank|productivity)"\s*:/)
    // Another person's day is visible to their manager, not to a peer or another organization.
    assert.equal((await t.call(`/api/assistant/day?userId=${s.employee.id}`, { as: s.manager })).status, 200)
    assert.equal((await t.call(`/api/assistant/day?userId=${s.employee.id}`, { as: s.employee2 })).status, 404)
    assert.equal((await t.call(`/api/assistant/day?userId=${s.employee.id}`, { as: s.otherAdmin })).status, 404)
    // A different day with nothing recorded says so, without inventing work.
    const empty = (await t.call('/api/assistant/day?day=2020-01-01', { as: s.employee })).body
    assert.match(empty.summary, /No recorded work/)
    // Priorities: requested changes first.
    const e = await task(t, s, 'Tune cache TTL'); await start(t, s, e); await submit(t, s, e); await review(t, s, e, 'CHANGES_REQUESTED', 'TTL too long')
    const p = (await t.call('/api/assistant/day', { as: s.employee })).body.priorities
    assert.match(p[0].text, /requested changes on "Tune cache TTL"/)
  } finally { await t.close() }
})

test('assistant questions: real, scoped answers with links; unknown questions are not faked', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const a = await task(t, s, 'Checkout latency below 200ms'); await start(t, s, a); await note(t, s, a, 'Profiled the slow query.')
    const b = await task(t, s, 'Onboarding doc refresh')
    evidence(t, s, { title: 'PR: cache catalog lookups', actor: s.employee.id, taskId: a, url: 'https://github.com/acme/shop/pull/9' })
    const ask = (body) => t.call('/api/assistant/ask', { method: 'POST', as: s.employee, body })
    const today = await ask({ question: 'What did I accomplish today?' })
    assert.equal(today.body.intent, 'accomplished_today'); assert.ok(today.body.items.every((i) => i.href))
    const pending = await ask({ question: 'What is still pending?' })
    assert.deepEqual(pending.body.items.map((i) => i.text).sort(), ['Checkout latency below 200ms', 'Onboarding doc refresh'])
    assert.equal((await ask({ question: 'What should I focus on next?' })).body.intent, 'focus')
    const found = await ask({ question: 'Find evidence for checkout latency' })
    assert.equal(found.body.taskId, a); assert.ok(found.body.items.some((i) => /cache catalog lookups/.test(i.text)))
    const which = await ask({ question: 'Find evidence' })
    assert.match(which.body.answer, /Which task/)
    const hard = await ask({ question: 'What difficult problems did I solve?' })
    assert.match(hard.body.answer, /has been analysed as complex yet|From the analyses/)
    const week = await ask({ question: 'Summarize my work this week' })
    assert.equal(week.body.intent, 'week')
    const unknown = await ask({ question: 'Write me a poem about Kubernetes' })
    assert.equal(unknown.body.intent, null); assert.ok(unknown.body.suggestions.length >= 7)
    // An employee cannot use the team copilot.
    assert.equal((await t.call('/api/assistant/ask', { method: 'POST', as: s.employee, body: { team: true, intent: 'blocked' } })).status, 403)
    void b
  } finally { await t.close() }
})

test('contribution journey: one piece of work across sources, facts vs stage reading, grouped evidence, contributors, missing steps', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const a = await task(t, s, 'Fix double booking'); await start(t, s, a)
    await note(t, s, a, 'Reproduced it and found the root cause: redelivered messages.')
    for (let i = 1; i <= 4; i++) evidence(t, s, { kind: 'commit', title: `${taskRef(a)} step ${i}`, actor: s.employee.id, taskId: a })
    evidence(t, s, { kind: 'review_comment', title: 'Review comment on PR #41', actor: s.employee2.id, collector: s.employee.id, taskId: a, attribution: 'member' })
    evidence(t, s, { kind: 'pr_merged', title: 'PR #41: idempotent handler', actor: s.employee.id, taskId: a, url: 'https://github.com/acme/shop/pull/41' })
    evidence(t, s, { app: 'slack', kind: 'message', title: 'customer confirmed the fix', actor: s.employee.id, taskId: a, status: 'suggested' })
    t.db.prepare(`UPDATE evidence_task_links SET confidence = 0.5 WHERE status = 'suggested'`).run()
    await submit(t, s, a); await review(t, s, a, 'APPROVED')
    const imp = await t.call('/api/impact', { method: 'POST', as: s.employee, body: { taskId: a, title: 'No more double bookings', category: 'RELIABILITY', previousState: '1 in 400 booked twice', workPerformed: 'Idempotent handler', result: 'Zero duplicates for a week', valueType: 'NONE' } })
    await t.call(`/api/impact/${imp.body.id}/verification`, { method: 'POST', as: s.manager, body: { decision: 'VERIFIED' } })
    const j = (await t.call(`/api/journeys/${a}`, { as: s.employee })).body
    const reached = j.stages.filter((x) => x.reached).map((x) => x.key)
    for (const k of ['planned', 'investigated', 'implemented', 'reviewed', 'delivered', 'accepted', 'outcome']) assert.ok(reached.includes(k), k)
    const commits = j.steps.filter((x) => /series/.test(x.title))
    assert.equal(commits.length, 1, 'four commits are one step')
    assert.ok(j.steps.every((x) => x.fact === true && x.stageBy === 'rule' && x.source && x.at), 'facts with source; stage is a rule-based reading')
    const reviewStep = j.steps.find((x) => /Review comment/.test(x.title))
    assert.equal(reviewStep.author.name, 'Ed Employee', 'original author kept')
    assert.ok(j.contributors.some((c) => c.name === 'Ed Employee'), 'shared contribution visible')
    assert.equal(j.outcome, 'verified')
    assert.equal(j.possibleLinks.length, 1, 'a weak suggestion is listed apart, not used as a step')
    assert.ok(j.missing.some((m) => /possible evidence link/.test(m)))
    // A bare completed task: missing steps are stated, nothing is filled in.
    const b = await task(t, s, 'Rename a column'); await start(t, s, b); await submit(t, s, b); await review(t, s, b, 'APPROVED')
    const jb = (await t.call(`/api/journeys/${b}`, { as: s.employee })).body
    assert.ok(jb.missing.some((m) => /No evidence/.test(m))); assert.ok(jb.missing.some((m) => /No outcome is recorded/.test(m)))
    assert.equal(jb.steps.filter((x) => x.stage === 'implemented').length, 0, 'no invented implementation step')
    // The list: one journey per task, never one per event; scoped.
    const list = (await t.call('/api/journeys', { as: s.employee })).body
    assert.equal(list.journeys.filter((x) => x.taskId === a).length, 1)
    assert.equal((await t.call(`/api/journeys?userId=${s.employee.id}`, { as: s.employee2 })).status, 404)
    assert.equal((await t.call(`/api/journeys/${a}`, { as: s.otherAdmin })).status, 404)
    assert.equal((await t.call(`/api/journeys?userId=${s.employee.id}`, { as: s.manager })).status, 200)
  } finally { await t.close() }
})

test("Manager Copilot: grounded, scoped to the manager's people, no rankings", async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const a = await task(t, s, 'Payout integration'); await start(t, s, a)
    await t.call(`/api/tasks/${a}/blockers`, { method: 'POST', as: s.employee, body: { description: 'Vendor sandbox down', isExternal: true } })
    const b = await task(t, s, 'Release notes', {}, 'employee2'); await start(t, s, b, 'employee2'); await submit(t, s, b, 'employee2')
    const o = await t.call('/api/tasks', { method: 'POST', as: s.manager2, body: { title: 'Sales deck', assigneeId: s.outsider.id } })
    await t.call(`/api/tasks/${o.body.task.id}/status`, { method: 'POST', as: s.outsider, body: { status: 'IN_PROGRESS' } })
    await t.call(`/api/tasks/${o.body.task.id}/blockers`, { method: 'POST', as: s.outsider, body: { description: 'Waiting on pricing' } })
    const ask = (as, intent) => t.call('/api/assistant/ask', { method: 'POST', as, body: { team: true, intent } })
    const blocked = (await ask(s.manager, 'blocked')).body
    assert.deepEqual(blocked.items.map((i) => i.text), ['Eve Employee: Payout integration'])
    assert.match(blocked.items[0].detail, /outside their control/)
    assert.ok(blocked.items.every((i) => i.href.startsWith('#/tasks/')))
    assert.deepEqual((await ask(s.manager2, 'blocked')).body.items.map((i) => i.text), ['Olly Sales: Sales deck'], 'another manager sees only their own people')
    const review = (await ask(s.manager, 'review')).body
    assert.ok(review.items.some((i) => /Submission: Ed Employee — Release notes/.test(i.text)), JSON.stringify(review))
    const today = (await ask(s.manager, 'team_today')).body
    assert.ok(today.items.every((i) => !/Olly|Sales deck/.test(i.text)))
    assert.match(today.note, /Not a ranking/)
    for (const intent of ['team_week', 'complex_solved', 'verified', 'delays', 'help', 'attention']) {
      const r = await ask(s.manager, intent)
      assert.equal(r.status, 200, intent); assert.ok(r.body.answer, intent)
      assert.doesNotMatch(JSON.stringify(r.body), /"(score|rank|commits|messages|emails)"\s*:/i)
    }
    assert.equal((await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: 'Who is blocked and why?' } })).body.intent, 'blocked')
    assert.equal((await ask(s.otherAdmin, 'blocked')).body.items?.length ?? 0, 0, 'another organization sees nothing')

    // Intent classification: add/remove verb must win over team_members noun match
    const q = (question) => t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question } })
    assert.equal((await q('add new team member to my team alice@example.com')).body.intent, 'add_to_team', 'add + team member + email → add_to_team')
    assert.equal((await q('I want this employee in my team alice@example.com')).body.intent, 'add_to_team', 'want + team + email → add_to_team')
    assert.equal((await q('invite bob@example.com to my team')).body.intent, 'add_to_team', 'invite + email → add_to_team')
    assert.equal((await q('who is in my team')).body.intent, 'team_members', 'who + in my team → team_members')
    assert.equal((await q('show me my team members')).body.intent, 'team_members', 'show team members → team_members')
    assert.equal((await q('remove alice@example.com from my team')).body.intent, 'remove_from_team', 'remove + email → remove_from_team')

    // Self-addition: manager adds themselves
    const selfAdd = (await q(`add me to my team ${s.manager.email}`)).body
    assert.ok(selfAdd.intent === 'add_to_team', 'self-add intent fires')
    assert.ok(/already|membership|admin/i.test(selfAdd.answer), 'self-add explains membership status')

    // find_employee: returns employee from same org
    const found = (await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'find_employee', question: `find ${s.employee.email}` } })).body
    assert.ok(found.items.length, 'find_employee returns match')
    assert.equal(found.items[0].email, s.employee.email)

    // team_members: manager with assigned team sees members
    const members = (await ask(s.manager, 'team_members')).body
    assert.ok(members.items.length, 'manager with assigned team sees members')
    assert.ok(members.items.every((i) => i.href), 'each member has a link')
  } finally { await t.close() }
})

test('proactive signals: detected by rules, deduplicated, resolved when fixed, dismissable with history, visible to the right people', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const stalled = await task(t, s, 'Stalled migration'); await start(t, s, stalled)
    t.db.prepare('UPDATE tasks SET last_progress_at = ?, started_at = ? WHERE id = ?').run(ago(100), ago(100), stalled)
    const due = await task(t, s, 'Due soon task', { dueAt: new Date(Date.now() + 6 * 3600000).toISOString() }); await start(t, s, due)
    const blk = await task(t, s, 'Blocked payouts', { priority: 'CRITICAL' }); await start(t, s, blk)
    await t.call(`/api/tasks/${blk}/blockers`, { method: 'POST', as: s.employee, body: { description: 'Bank down', isExternal: true } })
    t.db.prepare('UPDATE blockers SET reported_at = ? WHERE task_id = ?').run(ago(30), blk)
    const rw = await task(t, s, 'Search page'); await start(t, s, rw)
    for (let i = 0; i < 2; i++) { await submit(t, s, rw); await review(t, s, rw, 'CHANGES_REQUESTED', 'Missing pagination') }
    const done = await task(t, s, 'Copy tweak'); await start(t, s, done); await submit(t, s, done); await review(t, s, done, 'APPROVED')
    const imp = await t.call('/api/impact', { method: 'POST', as: s.employee, body: { taskId: done, title: 'Faster refunds', category: 'CUSTOMER_EXPERIENCE', previousState: 'slow', workPerformed: 'fix', result: 'fast', valueType: 'ESTIMATED', measurableValue: 30, measurementUnit: '% faster' } })
    t.db.prepare('UPDATE impact_records SET created_at = ? WHERE id = ?').run(ago(24 * 5), imp.body.id)
    await task(t, s, 'Build invoice export service'); await task(t, s, 'Build invoice export service v2', {}, 'employee2')
    const pr = evidence(t, s, { title: 'PR #99 merged', actor: s.employee.id, at: ago(48) })
    const out = detectSignals(t.db, s.org.id)
    assert.ok(out.opened >= 7, JSON.stringify(out) + JSON.stringify(t.db.prepare('SELECT kind, subject_user_id FROM work_signals').all()))
    const kinds = (rows) => [...new Set(rows.map((x) => x.kind))].sort()
    const mine = (await t.call('/api/signals', { as: s.employee })).body
    const team = (await t.call('/api/signals?scope=team', { as: s.manager })).body
    assert.deepEqual(kinds(mine), ['deadline', 'rework', 'stalled', 'unlinked_work'].sort())
    assert.ok(kinds(team).includes('blocker') && kinds(team).includes('unverified_impact') && kinds(team).includes('duplicate_effort'))
    const blocker = team.find((x) => x.kind === 'blocker')
    assert.equal(blocker.severity, 'high'); assert.match(blocker.reason, /outside their control/); assert.match(blocker.action, /not on the person/)
    assert.match(mine.find((x) => x.kind === 'rework').action, /not poor effort/)
    assert.equal((await t.call('/api/signals?scope=team', { as: s.employee })).status, 403)
    assert.equal((await t.call('/api/signals?scope=team', { as: s.otherAdmin })).status, 403, 'an admin who manages no team has no team signals')
    assert.equal((await t.call('/api/signals?scope=team', { as: s.manager2 })).body.filter((x) => x.personId === s.employee.id).length, 0)
    // Dedupe: running again creates nothing new.
    assert.equal(detectSignals(t.db, s.org.id).opened, 0)
    // Significant unverified impact → an in-app alert for the manager (M91 only if the org turned that rule on; it is off).
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'impact_verification_needed'`).get(s.manager.id))
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries`).get().n, 0)
    // Fixing the condition resolves the signal; history records it.
    await t.call(`/api/work-evidence/${pr}/links`, { method: 'POST', as: s.employee, body: { taskId: done } })
    detectSignals(t.db, s.org.id)
    const resolved = (await t.call('/api/signals?status=RESOLVED', { as: s.employee })).body.find((x) => x.kind === 'unlinked_work')
    assert.ok(resolved); assert.match(resolved.history.at(-1).event, /resolved/)
    // Dismiss needs a reason, is audited and stays dismissed on the next run.
    const st = mine.find((x) => x.kind === 'stalled')
    assert.equal((await t.call(`/api/signals/${st.id}`, { method: 'POST', as: s.employee, body: { action: 'DISMISS' } })).status, 400)
    const d = await t.call(`/api/signals/${st.id}`, { method: 'POST', as: s.employee, body: { action: 'DISMISS', reason: 'Waiting on design until Monday.' } })
    assert.equal(d.body.status, 'DISMISSED'); assert.equal(d.body.history.at(-1).reason, 'Waiting on design until Monday.')
    detectSignals(t.db, s.org.id)
    assert.ok(!(await t.call('/api/signals', { as: s.employee })).body.some((x) => x.id === st.id))
    assert.equal((await t.call(`/api/signals/${st.id}`, { method: 'POST', as: s.employee2, body: { action: 'RESOLVE' } })).status, 404)
    assert.ok(t.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'signal.dismiss'`).get())
  } finally { await t.close() }
})

test('AI write-up of the day: off unless analysis is fully on; invented references dropped; failure leaves the digest', async () => {
  const none = await startApp()
  try {
    const s = seedOrg(none.db)
    assert.equal((await none.call('/api/assistant/day/ai', { method: 'POST', as: s.employee, body: {} })).body.error.code, 'ai_not_configured')
  } finally { await none.close() }
  let fail = false
  const ai = { configured: true, name: 'scripted', model: 's1', async generate({ user }) {
    if (fail) throw new ProviderError('timeout', 'slow', true)
    const facts = JSON.parse(user.slice(user.indexOf('{')))
    return { output: { summary: 'You fixed the booking bug.', highlights: [{ text: 'Booking fix', ref: facts.items[0].id }, { text: 'Invented', ref: 'not-a-task' }] }, model: 's1' }
  } }
  const sup = await startApp({ ai, cfgOverrides: { ai: { mode: 'supervised' } } })
  try {
    const s = seedOrg(sup.db)
    assert.equal((await sup.call('/api/assistant/day/ai', { method: 'POST', as: s.employee, body: {} })).body.error.code, 'ai_supervised')
  } finally { await sup.close() }
  const t = await startApp({ ai })
  try {
    const s = seedOrg(t.db)
    const a = await task(t, s, 'Fix booking bug'); await start(t, s, a); await note(t, s, a, 'Found the cause.')
    const r = await t.call('/api/assistant/day/ai', { method: 'POST', as: s.employee, body: {} })
    assert.equal(r.status, 200); assert.equal(r.body.ai.summary, 'You fixed the booking bug.')
    assert.deepEqual(r.body.ai.highlights.map((h) => h.text), ['Booking fix'], 'an invented reference is dropped')
    assert.equal(r.body.basis, 'records', 'the facts are still the records')
    fail = true
    const f = await t.call('/api/assistant/day/ai', { method: 'POST', as: s.employee, body: {} })
    assert.equal(f.status, 502); assert.match(f.body.error.message, /summary above is complete/)
    assert.equal((await t.call('/api/assistant/day', { as: s.employee })).body.progressed.length, 1, 'work data untouched')
  } finally { await t.close() }
})

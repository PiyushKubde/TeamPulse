// Slack task intake, mention-based assignment, and the accept / decline / transfer workflow.
// No live Slack or viaSocket: events are posted to the real HTTP route the way viaSocket's handler does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARKER, LEGACY_MARKER } from '../server/integrations/actions.js'
import { interpretMessage, parseDeadline } from '../server/automations/slack-tasks.js'
import { setup, addIntake, post, tag, taskOf, counts, slackTask, plain, SLACK, WS, CH } from './slack-helpers.js'

const BASE = Date.UTC(2026, 10, 12, 8, 0, 0) / 1000 // 2026-11-12 08:00 UTC = 13:30 in Asia/Kolkata
const at = (n = 0) => `${BASE + n}.000100`

// ---------- extraction ----------
test('extraction: tasks versus conversation, and nothing invented', () => {
  const say = (text) => interpretMessage(text, { tz: 'UTC', nowMs: BASE * 1000 })
  for (const [text, kind] of [['Anyone up for lunch today?', 'QUESTION'], ['Good morning team', 'GREETING'], ['Status update: working on the invoice export', 'STATUS_UPDATE'],
    ['The payment bug is fixed and deployed', 'COMPLETED'], ['I am blocked by the vendor API and cannot proceed', 'BLOCKER'], ['We had a long meeting about pricing yesterday', 'DISCUSSION']]) {
    const x = say(text)
    assert.equal(x.kind, kind, text); assert.equal(x.isTask, false, text)
  }
  const x = say(`${tag(SLACK.eve)} please investigate the payment failure issue and fix it by tomorrow`)
  assert.equal(x.kind, 'TASK_REQUEST'); assert.equal(x.isTask, true)
  assert.equal(x.title, 'Investigate the payment failure issue and fix it')
  assert.equal(x.priority, null, 'priority not stated → not invented'); assert.equal(x.expectedOutcome, null)
  assert.deepEqual(x.roles, [{ slackUserId: SLACK.eve, role: 'PRIMARY' }])
  assert.equal(say(`${tag(SLACK.eve)} please fix the login bug, with help from ${tag(SLACK.ed)}, by tomorrow`).title, 'Fix the login bug')
  assert.equal(say(`${tag(SLACK.eve)} fix the login bug cc ${tag(SLACK.ed)}`).title, 'Fix the login bug')
  const none = say('please look into the invoice export')
  assert.equal(none.dueAt, null, 'no deadline stated → none')
  assert.equal(say('please update the pricing page, urgent').priority, 'HIGH')
  assert.equal(say('please update the pricing page whenever').priority, 'LOW')
  assert.equal(say('please do it').isTask, false, 'too little detail for a task')
})

test('deadlines: only what the words settle, in the organization timezone, never in the past', () => {
  const now = BASE * 1000 // Thu 2026-11-12 08:00 UTC
  const at = (text, tz = 'UTC') => parseDeadline(text, { tz, nowMs: now })?.iso ?? null
  assert.equal(at('fix it by tomorrow'), '2026-11-13T23:59:00.000Z')
  assert.equal(at('fix it by tomorrow', 'Asia/Kolkata'), '2026-11-13T18:29:00.000Z', 'end of day in Kolkata, not in UTC')
  assert.equal(at('send it by tomorrow 5pm', 'Asia/Kolkata'), '2026-11-13T11:30:00.000Z')
  assert.equal(at('send it today EOD'), '2026-11-12T23:59:00.000Z')
  assert.equal(at('ready by friday'), '2026-11-13T23:59:00.000Z')
  assert.equal(at('ready by 2026-12-01'), '2026-12-01T23:59:00.000Z')
  assert.equal(at('ready on 20 Nov'), '2026-11-20T23:59:00.000Z')
  assert.equal(at('within 2 hours'), '2026-11-12T10:00:00.000Z')
  assert.equal(at('in 3 days'), '2026-11-15T23:59:00.000Z')
  assert.equal(at('ready by thursday'), null, 'a weekday that is today is ambiguous')
  assert.equal(at('ready by next friday'), null, '"next Friday" is ambiguous')
  assert.equal(at('soon'), null); assert.equal(at('sometime next week'), null)
  assert.equal(at('do it today by 7am'), null, 'already past')
  assert.equal(at('new year 1 jan'), '2027-01-01T23:59:00.000Z')
})

// ---------- Slack intake ----------
test('Slack message → task for the tagged person: requester, source, deadline, notification', async () => {
  const { t, s, sub } = await setup()
  try {
    await t.call('/api/organization', { method: 'PATCH', as: s.admin, body: { name: 'Acme', timezone: 'Asia/Kolkata' } })
    const text = `${tag(SLACK.eve)}, please investigate the payment failure issue and fix it by tomorrow`
    const r = await post(t, sub, { text, ts: at(), extra: { permalink: 'https://acme.slack.com/archives/C0TEST0001/p1' } })
    assert.equal(r.status, 200); assert.equal(r.body.status, 'created')
    const task = taskOf(t, r.body.taskId)
    assert.equal(task.status, 'PENDING_ACCEPTANCE'); assert.equal(task.acceptance_state, 'pending'); assert.equal(task.accepted_at, null)
    assert.equal(task.assignee_id, s.employee.id, 'the tagged, mapped person is the initial assignee')
    assert.equal(task.created_by, s.manager.id, 'the requester does not become the creator or owner')
    assert.equal(task.title, 'Investigate the payment failure issue and fix it')
    assert.equal(task.description, 'please investigate the payment failure issue and fix it by tomorrow', 'no stray punctuation where the tag was')
    // What Slack said is a suggestion until a manager confirms it: the confirmed columns stay empty.
    assert.equal(task.due_at, null, 'a deadline read from Slack is not a confirmed deadline'); assert.equal(task.priority, null, 'no priority stated → unresolved, never a silent MEDIUM'); assert.equal(task.origin, 'SLACK')
    const sug = t.db.prepare("SELECT * FROM task_parameter_events WHERE task_id = ? AND field = 'deadline' AND status = 'SUGGESTED'").get(task.id)
    assert.equal(JSON.parse(sug.new_value), '2026-11-13T18:29:00.000Z', 'tomorrow, end of day in the organization timezone'); assert.equal(sug.source, 'SLACK_EXTRACTION'); assert.equal(sug.confidence, 'MEDIUM')
    assert.equal(JSON.parse(sug.evidence).slackRef, `slack:${CH}:${at()}`)
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM task_parameter_events WHERE task_id = ? AND field = 'priority'").get(task.id).n, 0, 'nothing was said about priority, so nothing is invented')
    assert.equal(task.team_id, s.teamA)
    // The source is kept for audit and traceability.
    const item = t.db.prepare('SELECT * FROM slack_intake_items WHERE task_id = ?').get(task.id)
    assert.equal(item.outcome, 'TASK_CREATED'); assert.equal(item.text, text); assert.equal(item.channel_id, CH); assert.equal(item.message_ts, at())
    assert.equal(item.workspace_id, WS); assert.equal(item.sender_slack_id, SLACK.dana); assert.equal(item.sender_name, 'Dana Director')
    assert.deepEqual(JSON.parse(item.mentions), [SLACK.eve]); assert.equal(item.permalink, 'https://acme.slack.com/archives/C0TEST0001/p1'); assert.equal(item.extraction, 'deterministic')
    assert.equal(task.slack_message_ref, `slack:${CH}:${at()}`)
    const kinds = t.db.prepare('SELECT type FROM task_events WHERE task_id = ? ORDER BY created_at, rowid').all(task.id).map((e) => e.type)
    assert.deepEqual(kinds, ['created', 'assigned'])
    const a = t.db.prepare('SELECT * FROM task_assignments WHERE task_id = ?').all(task.id)
    assert.equal(a.length, 1); assert.equal(a[0].source, 'SLACK_MENTION'); assert.equal(a[0].state, 'PENDING'); assert.equal(a[0].user_id, s.employee.id)
    // The assignee is told, with what they need to decide.
    await t.settled()
    const n = t.db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND task_id = ?`).get(s.employee.id, task.id)
    assert.equal(n.kind, 'task_assignment'); assert.equal(n.title, 'New task: Investigate the payment failure issue and fix it'); assert.equal(n.link, `#/tasks/${task.id}`)
    assert.match(n.body, /Dana Director tagged Eve Employee in Slack/); assert.match(n.body, /Priority: not set yet/); assert.match(n.body, /No confirmed deadline yet/); assert.match(n.body, /Accept, decline or transfer/)
    // They see it as awaiting their answer; nobody else does.
    const inbox = await t.call('/api/assignments/inbox', { as: s.employee })
    assert.equal(inbox.body.awaitingAcceptance.length, 1); assert.equal(inbox.body.awaitingAcceptance[0].requesterName, 'Dana Director')
    assert.equal((await t.call('/api/assignments/inbox', { as: s.employee2 })).body.awaitingAcceptance.length, 0)
    // The workflow view tells the ownership story.
    const w = (await t.call(`/api/tasks/${task.id}/workflow`, { as: s.manager })).body
    assert.equal(w.source.senderName, 'Dana Director'); assert.equal(w.assignments[0].name, 'Eve Employee')
  } finally { await t.close() }
})

test('ordinary conversation, bots and KONVO messages never become tasks; chat is not kept', async () => {
  const { t, sub } = await setup()
  try {
    const before = counts(t)
    for (const text of ['Anyone up for lunch today?', 'Good morning team', 'Status update: working on the invoice export', 'The payment bug is fixed and deployed', `${tag(SLACK.eve)} thanks!`, 'I am blocked by the vendor API and cannot proceed']) {
      const r = await post(t, sub, { text })
      assert.equal(r.body.status, 'ignored', text)
    }
    assert.equal((await post(t, sub, { text: 'please fix the deploy pipeline now', bot: true })).body.reason, 'posted by a bot')
    assert.equal((await post(t, sub, { text: `${MARKER} New task assigned to you` })).body.reason, 'sent by KONVO')
    assert.equal((await post(t, sub, { text: `${LEGACY_MARKER} New task assigned to you` })).body.reason, 'sent by KONVO', 'messages sent before the rename are still recognised as our own')
    assert.deepEqual(counts(t), before, 'no task and no request')
    const bot = t.db.prepare(`SELECT * FROM slack_intake_items WHERE reason = 'posted by a bot'`).get()
    assert.equal(bot.text, null, 'bot and KONVO messages keep no text')
    // The scheduled job erases the excerpt of chat after 24 hours (the approved retention): not before, and only chat.
    const { purgeIgnoredText, IGNORED_TEXT_RETENTION_DAYS } = await import('../server/automations/slack-tasks.js')
    assert.equal(IGNORED_TEXT_RETENTION_DAYS, 1)
    const chat = () => t.db.prepare(`SELECT COUNT(*) AS n FROM slack_intake_items WHERE text IS NOT NULL AND outcome = 'IGNORED'`).get().n
    assert.equal(chat(), 6)
    t.db.prepare(`UPDATE slack_intake_items SET created_at = ? WHERE outcome = 'IGNORED'`).run(new Date(Date.now() - 12 * 3600000).toISOString())
    assert.equal(purgeIgnoredText(t.db), 0); assert.equal(chat(), 6, 'a 12-hour-old excerpt is still kept')
    t.db.prepare(`UPDATE slack_intake_items SET created_at = ? WHERE outcome = 'IGNORED'`).run(new Date(Date.now() - 25 * 3600000).toISOString())
    assert.equal(purgeIgnoredText(t.db), 6); assert.equal(chat(), 0, 'a 25-hour-old excerpt is erased')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM slack_intake_items WHERE sender_name IS NOT NULL AND outcome = 'IGNORED'`).get().n, 0, 'with the sender name')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM slack_intake_items WHERE outcome = 'IGNORED'`).get().n, 9, 'the duplicate-protection records stay')
  } finally { await t.close() }
})

test('no guessed ownership: no tag, a name without a tag, an unmapped or unconfirmed tag, several tags all go to a manager', async () => {
  const { t, s, sub } = await setup()
  try {
    const asManager = async (text, reason) => {
      const r = await post(t, sub, { text })
      assert.equal(r.body.status, 'needs_manager', text); assert.match(r.body.reason, reason, text)
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'no task was created')
      return r
    }
    await asManager('Please investigate the payment failure issue by tomorrow', /Nobody was tagged/)
    await asManager('Eve please investigate the payment failure issue', /Nobody was tagged/) // a display name is never matched
    const ghost = await asManager(`${tag(SLACK.ghost)} please investigate the payment failure issue`, /not mapped to a KONVO person/)
    await asManager(`${tag(SLACK.eve)} and ${tag(SLACK.ed)} please fix the login bug`, /2 people were tagged/)
    // The Slack message waits as a normal pending request, the manager is notified, the message is preserved.
    const req = t.db.prepare('SELECT * FROM task_requests WHERE id = ?').get(ghost.body.requestId)
    assert.equal(req.status, 'PENDING'); assert.equal(req.source, 'external'); assert.match(req.description, new RegExp(SLACK.ghost)); assert.equal(req.suggested_assignee_id, null)
    await t.settled()
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'task_request'`).get(s.manager.id), 'the manager is notified')
    const item = t.db.prepare(`SELECT * FROM slack_intake_items WHERE request_id = ?`).get(req.id)
    assert.equal(item.outcome, 'NEEDS_MANAGER'); assert.match(item.text, /payment failure/)
    // Managers see the Slack ids that still need a mapping.
    const ids = (await t.call('/api/slack-identities', { as: s.manager })).body
    assert.ok(ids.unresolved.some((u) => u.slackUserId === SLACK.ghost && u.reason === 'unmapped'))
    // An unconfirmed self-declaration is only a claim.
    const claim = await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee2, body: { app: 'slack', identity: 'U0ED000099' } })
    assert.equal(claim.status, 200)
    await asManager(`${tag('U0ED000099')} please fix the login bug`, /unconfirmed claim/)
    assert.ok((await t.call('/api/slack-identities', { as: s.manager })).body.unresolved.some((u) => u.slackUserId === 'U0ED000099' && u.reason === 'unconfirmed' && u.claimedByName === 'Ed Employee'))
    // Once the manager confirms it, the same tag assigns.
    assert.equal((await t.call('/api/slack-identities', { method: 'POST', as: s.manager, body: { userId: s.employee2.id, slackUserId: 'U0ED000099' } })).status, 201)
    const ok = await post(t, sub, { text: `${tag('U0ED000099')} please fix the login bug` })
    assert.equal(ok.body.status, 'created'); assert.equal(taskOf(t, ok.body.taskId).assignee_id, s.employee2.id)
  } finally { await t.close() }
})

test('supporting contributors, reviewers and the requester are recorded separately from the owner', async () => {
  const { t, s, sub } = await setup()
  try {
    const r = await post(t, sub, { text: `${tag(SLACK.eve)} please fix the login bug, with help from ${tag(SLACK.ed)}`, user: SLACK.mona, userName: 'Mona M' })
    assert.equal(r.body.status, 'created')
    assert.equal(taskOf(t, r.body.taskId).assignee_id, s.employee.id, 'one primary, so no manager clarification')
    const p = plain(t.db.prepare('SELECT role, user_id FROM task_participants WHERE task_id = ?').all(r.body.taskId))
    assert.deepEqual(p, [{ role: 'SUPPORT', user_id: s.employee2.id }])
    const r2 = await post(t, sub, { text: `${tag(SLACK.eve)} please fix the signup bug, reviewer ${tag(SLACK.ed)}` })
    assert.deepEqual(plain(t.db.prepare('SELECT role FROM task_participants WHERE task_id = ?').all(r2.body.taskId)), [{ role: 'REVIEWER' }])
    // A mapped sender is recorded as the requester, never as the owner.
    const r3 = await post(t, sub, { text: `${tag(SLACK.eve)} please fix the billing bug`, user: SLACK.ed, userName: 'ed' })
    assert.deepEqual(plain(t.db.prepare('SELECT role, user_id FROM task_participants WHERE task_id = ?').all(r3.body.taskId)), [{ role: 'REQUESTER', user_id: s.employee2.id }])
    assert.equal(taskOf(t, r3.body.taskId).assignee_id, s.employee.id)
  } finally { await t.close() }
})

test('duplicate Slack deliveries never create a second task; thread context supplies the work', async () => {
  const { t, s, sub } = await setup()
  try {
    const text = `${tag(SLACK.eve)} please fix the login bug`
    const first = await post(t, sub, { text, ts: at(5) })
    const again = await post(t, sub, { text, ts: at(5) })
    const third = await Promise.all([post(t, sub, { text, ts: at(5) }), post(t, sub, { text, ts: at(5) })])
    assert.equal(first.body.status, 'created'); assert.equal(again.body.status, 'duplicate'); assert.ok(third.every((x) => x.body.status === 'duplicate'))
    assert.equal(counts(t).tasks, 1); assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM task_assignments').get().n, 1)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM slack_intake_items').get().n, 1)
    // A reply in a thread can carry the request while the parent describes the work.
    const parent = await post(t, sub, { text: 'Checkout page returns a 500 error since the last deploy', ts: at(10) })
    assert.equal(parent.body.status, 'ignored')
    const reply = await post(t, sub, { text: `${tag(SLACK.eve)} can you take this? by tomorrow`, ts: at(20), thread_ts: at(10) })
    assert.equal(reply.body.status, 'created')
    const task = taskOf(t, reply.body.taskId)
    assert.equal(task.title, 'Checkout page returns a 500 error since the last deploy'); assert.match(task.description, /Checkout page returns a 500/)
    assert.equal(task.due_at, null)
    assert.equal(JSON.parse(t.db.prepare("SELECT new_value FROM task_parameter_events WHERE task_id = ? AND field = 'deadline' AND status = 'SUGGESTED'").get(task.id).new_value), '2026-11-13T23:59:00.000Z', 'the suggested deadline is relative to when the reply was posted')
    const item = t.db.prepare('SELECT thread_ts, extracted FROM slack_intake_items WHERE task_id = ?').get(task.id)
    assert.equal(item.thread_ts, at(10)); assert.equal(JSON.parse(item.extracted).usedThreadContext, true)
    // A thread reply is not read by an intake that only creates requests.
    const legacy = addIntake(t, s, { assign: false })
    assert.equal((await post(t, legacy, { text: 'ok please look at this', ts: at(30), thread_ts: at(10) })).body.status, 'ignored')
  } finally { await t.close() }
})

test('the channel setting: pause, mode switch (owner only), requests mode unchanged, tagged person outside the owner’s teams', async () => {
  const { t, s, sub } = await setup()
  try {
    // Olly (mapped, but in another team) is outside the manager's teams.
    const out = await post(t, sub, { text: `${tag(SLACK.olly)} please fix the login bug` })
    assert.equal(out.body.status, 'needs_manager'); assert.match(out.body.reason, /outside the teams/)
    // Only a manager switches the mode; an employee cannot.
    assert.equal((await t.call(`/api/intakes/${sub.id}/mode`, { method: 'POST', as: s.employee, body: { assignFromMentions: false } })).status, 403)
    assert.equal((await t.call(`/api/intakes/${sub.id}/mode`, { method: 'POST', as: s.manager2, body: { assignFromMentions: false } })).status, 404, 'another manager cannot touch it')
    assert.equal((await t.call(`/api/intakes/${sub.id}/mode`, { method: 'POST', as: s.manager, body: { assignFromMentions: false } })).body.assignFromMentions, false)
    const before = counts(t)
    const legacy = await post(t, sub, { text: `${tag(SLACK.eve)} please fix the billing bug` })
    assert.equal(legacy.body.status, 'created'); assert.ok(legacy.body.requestId, 'request mode still creates a pending request')
    assert.deepEqual(counts(t), { tasks: before.tasks, requests: before.requests + 1 })
    await t.call(`/api/intakes/${sub.id}/mode`, { method: 'POST', as: s.manager, body: { assignFromMentions: true } })
    // Paused → ignored.
    assert.equal((await t.call(`/api/intakes/${sub.id}/status`, { method: 'POST', as: s.manager, body: { status: 'PAUSED' } })).status, 200)
    assert.deepEqual((await post(t, sub, { text: `${tag(SLACK.eve)} please fix the search bug` })).body, { status: 'ignored', reason: 'intake paused' })
    // Wrong token.
    assert.equal((await t.call(`/api/viasocket/events/${sub.id}`, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: { event: {} } })).status, 401)
    // The status view counts what happened.
    const list = (await t.call('/api/intakes', { as: s.manager })).body.find((i) => i.id === sub.id)
    assert.equal(list.assignFromMentions, true); assert.equal(list.needManager, 1)
  } finally { await t.close() }
})

test('Slack identity mapping: only managers, only their people, confirmed mappings are protected', async () => {
  const { t, s } = await setup()
  try {
    const map = (as, body) => t.call('/api/slack-identities', { method: 'POST', as, body })
    assert.equal((await map(s.employee, { userId: s.employee.id, slackUserId: 'U0SELF0001' })).status, 403, 'an employee cannot map themselves into assignments')
    assert.equal((await map(s.manager, { userId: s.outsider.id, slackUserId: 'U0OUT00001' })).status, 403, 'not in this manager’s teams')
    assert.equal((await map(s.manager, { userId: s.employee.id, slackUserId: 'not an id' })).status, 400)
    assert.equal((await map(s.manager, { userId: s.otherAdmin.id, slackUserId: 'U0OTHER001' })).status, 404, 'another organization’s person is not found')
    assert.equal((await map(s.manager, { userId: s.employee2.id, slackUserId: SLACK.eve })).body.error.code, 'identity_taken', 'a confirmed mapping is not silently reassigned')
    assert.equal((await t.call('/api/slack-identities', { as: s.employee })).status, 403)
    // An employee cannot delete a mapping a manager confirmed (nor take their Slack id).
    const list = (await t.call('/api/slack-identities', { as: s.manager })).body
    const eve = list.mappings.find((m) => m.slackUserId === SLACK.eve)
    assert.equal(eve.confirmed, true)
    assert.equal((await t.call(`/api/work-evidence/identities/${eve.id}`, { method: 'DELETE', as: s.employee })).status, 403)
    assert.equal((await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee2, body: { app: 'slack', identity: SLACK.eve } })).body.error.code, 'identity_taken')
    assert.equal((await t.call(`/api/slack-identities/${eve.id}`, { method: 'DELETE', as: s.manager })).status, 200)
    assert.equal((await t.call(`/api/slack-identities/${eve.id}`, { method: 'DELETE', as: s.manager })).status, 404)
    const audit = t.db.prepare(`SELECT action FROM audit_log WHERE entity_type = 'external_identity' ORDER BY created_at`).all().map((a) => a.action)
    assert.ok(audit.includes('slack_identity.mapped') && audit.includes('slack_identity.removed'))
  } finally { await t.close() }
})

// ---------- employee actions ----------
test('accept: ownership acknowledged, the task enters active work, the manager is told', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub)
    assert.equal((await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.employee2 })).status, 404, 'a teammate cannot answer for them')
    assert.equal((await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.manager })).status, 403, 'nor can the manager')
    assert.equal((await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.otherAdmin })).status, 404, 'another organization cannot see it')
    // Until accepted it cannot be worked on.
    assert.equal((await t.call(`/api/tasks/${taskId}/progress`, { method: 'POST', as: s.employee, body: { progress: 10 } })).status, 409)
    assert.equal((await t.call(`/api/tasks/${taskId}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })).status, 409)
    const a = await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.employee })
    assert.equal(a.status, 200); assert.equal(a.body.status, 'ASSIGNED')
    const task = taskOf(t, taskId)
    assert.equal(task.status, 'ASSIGNED'); assert.equal(task.acceptance_state, 'accepted'); assert.ok(task.accepted_at); assert.equal(task.last_meaningful_at, null, 'accepting is not movement')
    assert.equal(t.db.prepare('SELECT state FROM task_assignments WHERE task_id = ?').get(taskId).state, 'ACCEPTED')
    assert.equal((await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.employee })).status, 409, 'answered once')
    await t.settled()
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'assignment_accepted'`).get(s.manager.id))
    assert.deepEqual(t.db.prepare('SELECT type FROM task_events WHERE task_id = ? ORDER BY created_at, rowid').all(taskId).map((e) => e.type), ['created', 'assigned', 'assignment_accepted', 'status_changed'])
    // It now behaves like any active task.
    assert.equal((await t.call(`/api/tasks/${taskId}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })).status, 200)
  } finally { await t.close() }
})

test('decline: a reason is required, the manager decides next, nothing is deleted or penalised', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub)
    assert.equal((await t.call(`/api/tasks/${taskId}/decline`, { method: 'POST', as: s.employee, body: {} })).status, 400)
    assert.equal((await t.call(`/api/tasks/${taskId}/decline`, { method: 'POST', as: s.employee, body: { reason: 'no' } })).status, 400, 'a real reason')
    const d = await t.call(`/api/tasks/${taskId}/decline`, { method: 'POST', as: s.employee, body: { reason: 'I am on leave this week' } })
    assert.equal(d.status, 200)
    const task = taskOf(t, taskId)
    assert.equal(task.status, 'DECLINED'); assert.equal(task.declined_reason, 'I am on leave this week'); assert.equal(task.assignee_id, s.employee.id, 'the original assignment is not overwritten')
    const a = t.db.prepare('SELECT * FROM task_assignments WHERE task_id = ?').get(taskId)
    assert.equal(a.state, 'DECLINED'); assert.equal(a.reason, 'I am on leave this week'); assert.ok(a.responded_at)
    await t.settled()
    const note = t.db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND kind = 'assignment_declined'`).get(s.manager.id)
    assert.match(note.body, /on leave/)
    // It is not Eve's workload, not overdue, and raises no inactivity alerts, however long it waits.
    const { scanAlerts } = await import('../server/services/alerts.js')
    t.db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 3600000).toISOString(), taskId)
    assert.equal(scanAlerts(t.db, Date.now() + 200 * 3600000), 0)
    const dash = (await t.call('/api/dashboard', { as: s.manager })).body
    assert.ok(!JSON.stringify(dash.attention || []).includes(taskId), 'a declined task is not an overdue item against anyone')
    // The manager sees it in the dashboard, then reassigns: the new owner must accept, and the history keeps the decline.
    const ov = (await t.call('/api/slack-intake/overview', { as: s.manager })).body
    assert.equal(ov.summary.declined, 1); assert.equal(ov.tasks[0].declinedReason, 'I am on leave this week')
    const re = await t.call(`/api/tasks/${taskId}/assign`, { method: 'POST', as: s.manager, body: { assigneeId: s.employee2.id, reason: 'Eve is on leave' } })
    assert.equal(re.status, 200); assert.equal(re.body.status, 'PENDING_ACCEPTANCE')
    assert.deepEqual(plain(t.db.prepare('SELECT user_id, source, state FROM task_assignments WHERE task_id = ? ORDER BY assigned_at, rowid').all(taskId)),
      [{ user_id: s.employee.id, source: 'SLACK_MENTION', state: 'DECLINED' }, { user_id: s.employee2.id, source: 'MANAGER', state: 'PENDING' }])
    assert.equal(taskOf(t, taskId).declined_reason, null)
    await t.settled()
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'task_assignment'`).get(s.employee2.id), 'the new owner is asked too')
    assert.equal((await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.employee2 })).status, 200)
  } finally { await t.close() }
})

test('transfer: the new owner must accept; ownership changes only then; history is kept', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const propose = (body, as = s.employee) => t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as, body })
    // Who may receive: same team only, never yourself, never another organization.
    assert.equal((await propose({ toUserId: s.employee.id, reason: 'x y z' })).status, 400)
    assert.equal((await propose({ toUserId: s.outsider.id, reason: 'handing over' })).status, 403, 'another team')
    assert.equal((await propose({ toUserId: s.otherAdmin.id, reason: 'handing over' })).status, 400, 'another organization')
    assert.equal((await propose({ toUserId: s.employee2.id })).status, 400, 'a reason is required')
    assert.equal((await propose({ toUserId: s.employee.id, reason: 'handing over' }, s.employee2)).status, 404, 'a teammate who is not the owner cannot even see the task')
    assert.equal((await propose({ toUserId: s.employee2.id, reason: 'handing over' }, s.manager)).status, 403, 'only the owner proposes')
    const p = await propose({ toUserId: s.employee2.id, reason: 'Ed knows the payments code' })
    assert.equal(p.status, 201)
    const transferId = p.body.transferId
    // Until Ed accepts, Eve is still the owner; a second proposal is refused.
    assert.equal(taskOf(t, taskId).assignee_id, s.employee.id)
    assert.equal((await propose({ toUserId: s.employee2.id, reason: 'again please' })).status, 409)
    await t.settled()
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'transfer_offered'`).get(s.employee2.id), 'the proposed owner is notified')
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'transfer_pending'`).get(s.manager.id), 'the manager is notified')
    const inbox = (await t.call('/api/assignments/inbox', { as: s.employee2 })).body
    assert.equal(inbox.transfersOfferedToMe[0].taskTitle.startsWith('Investigate'), true)
    assert.equal((await t.call(`/api/tasks/${taskId}`, { as: s.employee2 })).status, 200, 'Ed can open the task offered to him')
    assert.equal((await t.call(`/api/tasks/${taskId}`, { as: s.outsider })).status, 404)
    // Eve can neither decide her own transfer nor answer for Ed.
    assert.equal((await t.call(`/api/transfers/${transferId}/decision`, { method: 'POST', as: s.employee, body: { decision: 'ACCEPT' } })).status, 403)
    assert.equal((await t.call(`/api/transfers/${transferId}/decision`, { method: 'POST', as: s.outsider, body: { decision: 'ACCEPT' } })).status, 404)
    const ov = (await t.call('/api/slack-intake/overview', { as: s.manager })).body
    assert.equal(ov.summary.pendingTransfers, 1); assert.equal(ov.transfers[0].status, 'PENDING')
    // Ed accepts.
    const acc = await t.call(`/api/transfers/${transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'ACCEPT' } })
    assert.equal(acc.status, 200); assert.equal(acc.body.status, 'ACCEPTED')
    const task = taskOf(t, taskId)
    assert.equal(task.assignee_id, s.employee2.id); assert.equal(task.status, 'ASSIGNED'); assert.equal(task.acceptance_state, 'accepted'); assert.equal(task.accepted_at, task.assigned_at, 'Ed’s own clock starts when he accepted')
    assert.deepEqual(plain(t.db.prepare('SELECT user_id, source, state FROM task_assignments WHERE task_id = ? ORDER BY assigned_at, rowid').all(taskId)),
      [{ user_id: s.employee.id, source: 'SLACK_MENTION', state: 'TRANSFERRED_OUT' }, { user_id: s.employee2.id, source: 'TRANSFER', state: 'ACCEPTED' }])
    const tr = t.db.prepare('SELECT * FROM task_transfers WHERE id = ?').get(transferId)
    assert.equal(tr.status, 'ACCEPTED'); assert.equal(tr.from_user_id, s.employee.id); assert.equal(tr.to_user_id, s.employee2.id); assert.equal(tr.reason, 'Ed knows the payments code'); assert.ok(tr.decided_at); assert.equal(tr.decided_by, s.employee2.id)
    const ev = t.db.prepare(`SELECT data FROM task_events WHERE task_id = ? AND type = 'transfer_accepted'`).get(taskId)
    assert.equal(JSON.parse(ev.data).fromName, 'Eve Employee'); assert.equal(JSON.parse(ev.data).toName, 'Ed Employee')
    assert.equal((await t.call(`/api/transfers/${transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'ACCEPT' } })).status, 409, 'settled once')
    await t.settled()
    for (const [who, kind] of [[s.employee, 'transfer_accepted'], [s.manager, 'transfer_accepted'], [s.employee2, 'task_assignment']]) assert.ok(t.db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND kind = ?').get(who.id, kind), `${kind} for ${who.id}`)
    // The previous owner still sees the history; the manager sees the whole story.
    assert.equal((await t.call(`/api/tasks/${taskId}`, { as: s.employee })).status, 200)
    const w = (await t.call(`/api/tasks/${taskId}/workflow`, { as: s.manager })).body
    assert.equal(w.transfers.length, 1); assert.equal(w.assignments.length, 2)
  } finally { await t.close() }
})

test('transfer declined or withdrawn: the owner keeps the task and the record stays', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub, { accept: true })
    const p = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'swap please' } })
    assert.equal((await t.call(`/api/transfers/${p.body.transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'DECLINE' } })).status, 400, 'a reason is required')
    assert.equal((await t.call(`/api/transfers/${p.body.transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'DECLINE', note: 'I am full this week' } })).status, 200)
    assert.equal(taskOf(t, taskId).assignee_id, s.employee.id)
    assert.equal(t.db.prepare('SELECT state FROM task_assignments WHERE task_id = ?').all(taskId).length, 1, 'no new assignment')
    await t.settled()
    assert.match(t.db.prepare(`SELECT body FROM notifications WHERE user_id = ? AND kind = 'transfer_declined'`).get(s.employee.id).body, /full this week/)
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'transfer_declined'`).get(s.manager.id))
    const kept = t.db.prepare('SELECT * FROM task_transfers WHERE id = ?').get(p.body.transferId)
    assert.equal(kept.status, 'DECLINED'); assert.equal(kept.decision_note, 'I am full this week')
    // A new offer, withdrawn by the proposer, or settled by the manager.
    const p2 = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'one more try' } })
    assert.equal((await t.call(`/api/transfers/${p2.body.transferId}/cancel`, { method: 'POST', as: s.employee2, body: {} })).status, 403)
    assert.equal((await t.call(`/api/transfers/${p2.body.transferId}/cancel`, { method: 'POST', as: s.manager, body: { note: 'Eve keeps it' } })).status, 200)
    const p3 = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'third time' } })
    assert.equal((await t.call(`/api/transfers/${p3.body.transferId}/cancel`, { method: 'POST', as: s.employee, body: {} })).status, 200)
    assert.deepEqual(t.db.prepare('SELECT status FROM task_transfers ORDER BY created_at, rowid').all().map((x) => x.status), ['DECLINED', 'CANCELLED', 'CANCELLED'])
    // A manager's reassignment settles an open transfer.
    const p4 = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'fourth time' } })
    await t.call(`/api/tasks/${taskId}/assign`, { method: 'POST', as: s.manager, body: { assigneeId: s.employee2.id } })
    assert.equal(t.db.prepare('SELECT status FROM task_transfers WHERE id = ?').get(p4.body.transferId).status, 'CANCELLED')
    assert.equal(taskOf(t, taskId).status, 'PENDING_ACCEPTANCE', 'a Slack task handed to someone new must be accepted by them')
  } finally { await t.close() }
})

test('a task waiting on a transfer answer cannot be accepted or declined; a pending task can be transferred before answering', async () => {
  const { t, s, sub } = await setup()
  try {
    const { taskId } = await slackTask(t, s, sub)
    const p = await t.call(`/api/tasks/${taskId}/transfer`, { method: 'POST', as: s.employee, body: { toUserId: s.employee2.id, reason: 'not my area' } })
    assert.equal(p.status, 201)
    assert.equal((await t.call(`/api/tasks/${taskId}/accept`, { method: 'POST', as: s.employee })).body.error.code, 'transfer_pending')
    assert.equal((await t.call(`/api/tasks/${taskId}/decline`, { method: 'POST', as: s.employee, body: { reason: 'not my area' } })).body.error.code, 'transfer_pending')
    assert.equal((await t.call(`/api/transfers/${p.body.transferId}/decision`, { method: 'POST', as: s.employee2, body: { decision: 'ACCEPT' } })).status, 200)
    const task = taskOf(t, taskId)
    assert.equal(task.assignee_id, s.employee2.id); assert.equal(task.status, 'ASSIGNED', 'accepting the transfer is the new owner’s acceptance'); assert.equal(task.acceptance_state, 'accepted')
    assert.equal(t.db.prepare(`SELECT state FROM task_assignments WHERE task_id = ? AND user_id = ?`).get(taskId, s.employee.id).state, 'TRANSFERRED_OUT')
  } finally { await t.close() }
})

test('the manager’s Slack dashboard: sources, owners, filters, nothing ranked', async () => {
  const { t, s, sub } = await setup()
  try {
    const a = await slackTask(t, s, sub, { accept: true, text: `${tag(SLACK.eve)} please fix the login bug` })
    const b = await slackTask(t, s, sub, { text: `${tag(SLACK.ed)} please fix the signup bug` })
    const get = async (q = '', as = s.manager) => (await t.call(`/api/slack-intake/overview${q}`, { as })).body
    const all = await get()
    assert.equal(all.tasks.length, 2); assert.equal(all.summary.pendingAcceptance, 1); assert.equal(all.summary.accepted, 1)
    const row = all.tasks.find((x) => x.id === a.taskId)
    assert.equal(row.requesterName, 'Dana Director'); assert.equal(row.taggedName, 'Eve Employee'); assert.equal(row.assigneeName, 'Eve Employee'); assert.equal(row.fromSlack, true)
    assert.equal((await get(`?assigneeId=${s.employee2.id}`)).tasks[0].id, b.taskId)
    assert.equal((await get('?acceptance=pending')).tasks[0].id, b.taskId)
    assert.equal((await get('?status=ASSIGNED')).tasks[0].id, a.taskId)
    assert.equal((await get('?severity=LOW')).tasks.length, 2, 'both were assigned (LOW alert)')
    assert.equal((await get('?severity=CRITICAL')).tasks.length, 0)
    assert.equal((await get(`?teamId=${s.teamB}`)).tasks.length, 0)
    assert.equal((await t.call('/api/slack-intake/overview', { as: s.employee })).status, 403)
    assert.equal((await get('', s.manager2)).tasks.length, 0, 'another team’s manager sees none of it')
    assert.equal((await t.call('/api/slack-intake/overview', { as: s.otherAdmin })).status, 403, 'another organization’s admin (no team to manage) sees none of it')
    assert.equal((await t.call('/api/slack-intake/overview', { as: s.admin })).status, 403, 'an admin who manages no team is not a manager')
    assert.ok(!Object.keys(all).some((k) => /rank|leader|score/i.test(k)))
  } finally { await t.close() }
})

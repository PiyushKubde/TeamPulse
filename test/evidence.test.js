// Sprint 2: external evidence from GitHub, Slack, Gmail, Google Calendar and Google Sheets. viaSocket is a stand-in
// gateway (mocked responses shaped like the catalog's sample_output); events reach the real webhook with the bearer
// token from the handler code TeamPulse gave viaSocket. No live integration is claimed by these tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { now, uuid } from '../server/db.js'
import { startApp, seedOrg } from './helpers.js'
import { retryInbox } from '../server/evidence/ingest.js'
import { buildEvidencePack } from '../server/measurement/evidence-pack.js'
import { applyGuardrails } from '../server/measurement/guardrails.js'
import { measurementSettled } from '../server/measurement/engine.js'
import { taskRef } from '../server/evidence/matching.js'

const OPTIONS = {
  github: [{ label: 'acme/shop', value: 'acme/shop' }],
  slack: [{ label: 'eng-payments', value: 'C0PAYMENTS' }, { label: 'dm', value: 'D0PRIVATE1' }],
  gmail: [{ label: 'Work/TeamPulse', value: 'Label_42' }],
  'google-calendar': [{ label: 'Work', value: 'eve@example.com' }],
  'google-sheets': [{ label: 'Ops tracker', value: 'SS_1' }]
}
function stubVs({ samples = {}, expired = false } = {}) {
  const calls = { subscribe: [], setFlowStatus: [], sampleEvent: [], listConnections: 0 }
  const vs = {
    configured: true, calls, conns: new Map(),
    serviceIdFor: async (slug) => `svc-${slug}`,
    versions: async () => ({ service: { auth_type: 'Auth2.0' } }),
    listConnections: async (userId) => { calls.listConnections++; return (vs.conns.get(userId) || []).map((id) => ({ id, isExpired: expired })) },
    listOptions: async (userId, slug, key, { fieldKey, existingFields }) => ({ options: fieldKey === 'sheet_id' ? (existingFields?.spreadSheet_id === 'SS_1' ? [{ label: 'Q4', value: '0' }] : []) : OPTIONS[slug] || [] }),
    sampleEvent: async (triggerId, authId, authType, inputData) => { calls.sampleEvent.push({ triggerId, inputData }); return samples[triggerId] ?? {} },
    subscribe: async (userId, slug, key, opts) => { calls.subscribe.push({ userId, slug, key, ...opts }); return { scriptId: `script-${calls.subscribe.length}` } },
    setFlowStatus: async (userId, scriptId, status) => { calls.setFlowStatus.push({ userId, scriptId, status }) }
  }
  return vs
}
function connect(t, vs, s, who, app, label = null) {
  const id = uuid()
  const authId = `auth_${app.replace(/-/g, '_')}_${who.id.slice(0, 6)}`
  t.db.prepare(`INSERT INTO app_connections (id, org_id, user_id, app_slug, service_id, auth_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, t.db.prepare('SELECT org_id FROM memberships WHERE user_id = ?').get(who.id).org_id, who.id, app, `svc-${app}`, authId, label, now(), now())
  vs.conns.set(who.id, [...(vs.conns.get(who.id) || []), authId])
  return id
}
const tokensOf = (vs) => vs.calls.subscribe.map((x) => ({ key: x.key, token: /Bearer (tpv_[A-Za-z0-9_-]+)/.exec(x.code)[1], url: /"https:\/\/teampulse\.test(\/api\/work-evidence\/events\/[0-9a-f-]{36})"/.exec(x.code)[1] }))
async function deliver(t, sub, event) {
  const res = await fetch(`${t.base}${sub.url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${sub.token}` }, body: JSON.stringify({ event }) })
  return { status: res.status, body: await res.json() }
}
async function source(t, as, body) { return t.call('/api/work-evidence/sources', { method: 'POST', as, body }) }
const ev = (t, where = '1=1', ...p) => t.db.prepare(`SELECT * FROM external_evidence WHERE ${where} ORDER BY created_at`).all(...p)

// Fixtures shaped like the catalog sample_output of each trigger (keys read on 2026-11-09).
const PR = (n, { merged = false, action = 'opened', login = 'eve-gh', title = 'Idempotent reservation token', body = 'Fixes the double booking.' } = {}) => ({ action, number: n, sender: { login }, repository: { full_name: 'acme/shop' }, pull_request: { id: 9000 + n, number: n, user: { login }, state: merged ? 'closed' : 'open', title, body, merged, merged_at: merged ? '2026-11-08T10:00:00Z' : null, html_url: `https://github.com/acme/shop/pull/${n}`, additions: 120, deletions: 30, created_at: '2026-11-07T09:00:00Z', changed_files: 4, requested_reviewers: [{ login: 'ed-gh' }] } })
const COMMIT = (sha, msg, login = 'eve-gh') => ({ sha, commit: { message: msg, author: { name: 'Eve', email: 'eve@example.com', date: '2026-11-07T12:00:00Z' } }, author: { login }, html_url: `https://github.com/acme/shop/commit/${sha}` })
const SLACK = (ts, text, user = 'U0EVE0001', extra = {}) => ({ ts, text, type: 'message', user, channel: 'C0PAYMENTS', ...extra })
const MAIL = (id, extra = {}) => ({ rawId: id, threadId: `th-${id}`, subject: 'Re: Refund delay for order 4471', bodyPlain: 'Found the cause: the refund queue was paused. Restarted it.\n\nOn Mon, Nov 3, 2026 at 10:00 Customer wrote:\n> Where is my refund?', From: { name: 'Customer', email: 'buyer@client.test' }, To: [{ email: 'eve@example.com' }], date: '2026-11-07T11:00:00Z', messageUrl: `https://mail.google.com/mail/u/0/#inbox/${id}`, attachmentCount: 1, attachmentDetails: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1200, url: 'https://secret-download-url.test/x' }], ...extra })
const EVENT = (id, extra = {}) => ({ id, summary: 'Payments incident review', status: 'confirmed', start: { dateTime: '2026-11-07T14:00:00Z' }, end: { dateTime: '2026-11-07T14:45:00Z' }, organizer: { email: 'mona@example.com' }, attendees: [{ email: 'mona@example.com' }, { email: 'eve@example.com', self: true, responseStatus: 'accepted' }], htmlLink: `https://calendar.google.com/event?eid=${id}`, calendarId: 'eve@example.com', description: 'Root cause and follow-ups.', ...extra })
const ROW = (row, values) => ({ values, _sheet_id: '0', _rowNumber: row, _spreadsheet_id: 'SS_1' })

async function setup(opts) {
  const vs = stubVs(opts)
  const t = await startApp({ vs })
  const s = seedOrg(t.db)
  return { t, vs, s }
}

test('GitHub: PRs, commits and review comments ingested; merge updates the same evidence; duplicates ignored; attribution by identity', async () => {
  const { t, vs, s } = await setup({ samples: { rowru54g3wrd: PR(41) } })
  try {
    const conn = connect(t, vs, s, s.employee, 'github', 'eve-gh')
    const r = await source(t, s.employee, { app: 'github', connectionId: conn, scope: { value: 'acme/shop' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.results.map((x) => x.status), ['active', 'active', 'active'])
    assert.deepEqual(vs.calls.subscribe.map((x) => [x.key, x.version, x.authId]), [['Pull_Request_Opens_or_Closes', 'v22', 'auth_github_' + s.employee.id.slice(0, 6)], ['New_Commit_Pushed', 'v6', 'auth_github_' + s.employee.id.slice(0, 6)], ['new-pull-request-review-comment', 'v1', 'auth_github_' + s.employee.id.slice(0, 6)]])
    assert.deepEqual(vs.calls.subscribe[1].inputData, { repoFullName: 'acme/shop', sha: 'main' })
    assert.equal(ev(t).length, 1, 'initial sync: the latest real PR from the sample')
    assert.equal(ev(t)[0].method, 'initial_sample'); assert.equal(ev(t)[0].attribution, 'self', 'identity read from the connection label (eve-gh)')
    const [prs, commits, reviews] = tokensOf(vs)
    assert.equal((await deliver(t, prs, PR(41, { merged: true, action: 'closed' }))).status, 200)
    const pr = ev(t, `external_id = 'pr:acme/shop#41'`)
    assert.equal(pr.length, 1, 'opened → merged is one evidence row'); assert.equal(pr[0].kind, 'pr_merged')
    assert.equal(JSON.parse(pr[0].metadata_json).merged, true)
    assert.equal((await deliver(t, prs, PR(41, { merged: true, action: 'closed' }))).body.status, 'duplicate')
    await deliver(t, commits, { commits: [COMMIT('a1', 'Add reservation token'), COMMIT('a2', 'Handle retries'), COMMIT('a3', 'Test redelivery')] })
    assert.equal(ev(t, `kind = 'commit'`).length, 3)
    await deliver(t, reviews, { body: 'Should this be idempotent per version?', path: 'booking.js', html_url: 'https://github.com/acme/shop/pull/41#r1', comment_id: 77, review_id: 5, created_at: '2026-11-07T13:00:00Z', author_login: 'ed-gh', pull_request_number: 41, pull_request_title: 'Idempotent reservation token', repository_full_name: 'acme/shop' })
    const rc = ev(t, `kind = 'review_comment'`)[0]
    assert.equal(rc.attribution, 'unknown', 'ed-gh is nobody known yet: never guessed'); assert.equal(rc.parent_ref, 'pr:acme/shop#41')
    // Ed declares his GitHub login → his earlier evidence becomes his.
    assert.equal((await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee2, body: { app: 'github', identity: 'ed-gh' } })).status, 200)
    assert.equal(ev(t, `kind = 'review_comment'`)[0].actor_user_id, s.employee2.id)
    assert.equal((await t.call('/api/work-evidence/identities', { method: 'POST', as: s.outsider, body: { app: 'github', identity: 'ed-gh' } })).body.error.code, 'identity_taken', 'nobody can claim it again')
    const src = (await t.call('/api/work-evidence/sources', { as: s.employee })).body[0]
    assert.equal(src.status, 'ACTIVE'); assert.ok(src.lastSuccessAt); assert.equal(src.checkpoint, '2026-11-08T10:00:00.000Z', 'checkpoint = newest event time')
  } finally { await t.close() }
})

test('Slack: channel messages and thread replies; bots, TeamPulse posts and DMs ignored; deleted messages handled', async () => {
  const { t, vs, s } = await setup()
  try {
    const conn = connect(t, vs, s, s.employee, 'slack')
    assert.equal((await source(t, s.employee, { app: 'slack', connectionId: conn, scope: { value: 'D0PRIVATE1' } })).status, 400, 'direct messages are never collected')
    const r = await source(t, s.employee, { app: 'slack', connectionId: conn, scope: { value: 'C0PAYMENTS' } })
    assert.equal(r.status, 200)
    assert.deepEqual(vs.calls.subscribe.map((x) => [x.key, x.version, x.inputData]), [['New_Message_in_Channels', 'v25', { channel_id: ['C0PAYMENTS'] }], ['New_Thread_Message_Instant', 'v1', { channel: 'C0PAYMENTS' }]])
    await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee, body: { app: 'slack', identity: 'U0EVE0001' } })
    const [msgs, threads] = tokensOf(vs)
    await deliver(t, msgs, SLACK('1762500000.000100', 'Root cause: the queue consumer restarts mid-batch.'))
    await deliver(t, threads, SLACK('1762500100.000200', 'Pushed a fix for the redelivery case.', 'U0EVE0001', { thread_ts: '1762500000.000100' }))
    for (const ignored of [SLACK('1762500200.0003', 'Deploy finished', 'U0BOT', { bot_id: 'B1' }), SLACK('1762500300.0004', 'Weekly report\n_Sent by TeamPulse_'), SLACK('1762500400.0005', 'joined', 'U0X', { subtype: 'channel_join' })]) {
      assert.equal((await deliver(t, msgs, ignored)).body.status, 'ignored')
    }
    const rows = ev(t)
    assert.equal(rows.length, 2); assert.equal(rows[1].kind, 'thread_reply'); assert.equal(rows[1].parent_ref, 'slack:C0PAYMENTS:1762500000.000100')
    assert.equal(rows[0].verification, 'self_reported', 'a message is a person’s account, not proof')
    await deliver(t, msgs, { type: 'message', subtype: 'message_deleted', channel: 'C0PAYMENTS', deleted_ts: '1762500000.000100' })
    const del = ev(t, `external_id = 'slack:C0PAYMENTS:1762500000.000100'`)[0]
    assert.equal(del.status, 'deleted'); assert.equal(del.content, null)
  } finally { await t.close() }
})

test('Gmail: label-scoped received and sent mail; quoted replies and attachment URLs not stored; external senders marked external', async () => {
  const { t, vs, s } = await setup()
  try {
    const conn = connect(t, vs, s, s.employee, 'gmail', 'eve@example.com')
    const r = await source(t, s.employee, { app: 'gmail', connectionId: conn, scope: { value: 'Label_42' } })
    assert.equal(r.status, 200)
    assert.deepEqual(vs.calls.subscribe[0].inputData, { thread: 'include_replies', query: ['label'], searchFields: { label: ['Label_42'] } })
    assert.equal(vs.calls.subscribe[1].key, 'New_Email_Sent')
    const [received, sent] = tokensOf(vs)
    await deliver(t, received, MAIL('m1'))
    await deliver(t, sent, { date: '2026-11-07T12:00:00Z', rawId: 'm2', rawPayloadHeaders: { To: 'buyer@client.test', From: 'Eve <eve@example.com>', Subject: 'Refund issued' } })
    const [inMail, outMail] = ev(t)
    assert.equal(inMail.attribution, 'external'); assert.equal(inMail.actor_identity, 'buyer@client.test')
    assert.doesNotMatch(inMail.content, /Where is my refund/, 'quoted reply stripped')
    assert.doesNotMatch(inMail.metadata_json, /secret-download-url/, 'attachment metadata only')
    assert.equal(outMail.kind, 'email_sent'); assert.equal(outMail.attribution, 'self')
    assert.equal((await deliver(t, received, { subject: 'no id' })).body.status, 'failed', 'invalid source data is a failure, not a guess')
  } finally { await t.close() }
})

test('Google Calendar: meetings with role and duration; private, declined and out-of-office entries ignored; cancellation recorded', async () => {
  const { t, vs, s } = await setup()
  try {
    const conn = connect(t, vs, s, s.employee, 'google-calendar', 'eve@example.com')
    assert.equal((await source(t, s.employee, { app: 'google-calendar', connectionId: conn, scope: { value: 'eve@example.com' } })).status, 200)
    assert.deepEqual(vs.calls.subscribe[0].inputData, { calendarId: ['eve@example.com'] })
    const [events] = tokensOf(vs)
    await deliver(t, events, EVENT('e1'))
    for (const x of [EVENT('e2', { visibility: 'private' }), EVENT('e3', { attendees: [{ email: 'eve@example.com', self: true, responseStatus: 'declined' }] }), EVENT('e4', { eventType: 'outOfOffice' })]) assert.equal((await deliver(t, events, x)).body.status, 'ignored')
    const m = ev(t)[0]
    assert.equal(m.kind, 'meeting'); assert.equal(m.attribution, 'self')
    assert.deepEqual([JSON.parse(m.metadata_json).role, JSON.parse(m.metadata_json).durationMinutes], ['attendee', 45])
    await deliver(t, events, EVENT('e1', { status: 'cancelled' }))
    assert.equal(ev(t)[0].status, 'cancelled')
  } finally { await t.close() }
})

test('Google Sheets: one sheet; rows are reported figures; an edited row keeps its previous values', async () => {
  const { t, vs, s } = await setup()
  try {
    const conn = connect(t, vs, s, s.employee, 'google-sheets')
    assert.equal((await source(t, s.employee, { app: 'google-sheets', connectionId: conn, scope: { value: 'SS_1' } })).status, 400, 'a sheet must be chosen')
    assert.equal((await source(t, s.employee, { app: 'google-sheets', connectionId: conn, scope: { value: 'SS_1', sheet: '9' } })).status, 400, 'only sheets the account offers')
    assert.equal((await source(t, s.employee, { app: 'google-sheets', connectionId: conn, scope: { value: 'SS_1', sheet: '0' } })).status, 200)
    assert.deepEqual(vs.calls.subscribe[0].inputData, { spreadSheet_id: 'SS_1', sheet_id: '0', column_key: true, record_type: 'new_update' })
    const [rows] = tokensOf(vs)
    await deliver(t, rows, ROW(7, { Metric: 'Refund time (h)', Before: '48', After: '12' }))
    await deliver(t, rows, ROW(7, { Metric: 'Refund time (h)', Before: '48', After: '10' }))
    const r = ev(t)
    assert.equal(r.length, 1); assert.equal(r[0].verification, 'reported_figure')
    const meta = JSON.parse(r[0].metadata_json)
    assert.equal(meta.values.After, '10'); assert.equal(meta.previous.After, '12')
    assert.match(r[0].source_url, /docs\.google\.com\/spreadsheets\/d\/SS_1\/edit#gid=0/)
  } finally { await t.close() }
})

test('connection permissions, organization isolation and webhook authentication', async () => {
  const { t, vs, s } = await setup()
  try {
    const conn = connect(t, vs, s, s.employee, 'slack')
    assert.equal((await source(t, s.employee2, { app: 'slack', connectionId: conn, scope: { value: 'C0PAYMENTS' } })).status, 404, 'another person’s connection')
    assert.equal((await source(t, s.employee, { app: 'slack', connectionId: conn, scope: { value: 'C0SOMEONE' } })).status, 400, 'a scope the account does not offer')
    assert.equal((await source(t, s.employee, { app: 'jira', connectionId: conn, scope: { value: 'x' } })).status, 400)
    await source(t, s.employee, { app: 'slack', connectionId: conn, scope: { value: 'C0PAYMENTS' } })
    await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee, body: { app: 'slack', identity: 'U0EVE0001' } })
    const [msgs] = tokensOf(vs)
    await deliver(t, msgs, SLACK('1762500000.000100', 'Root cause found in the consumer.'))
    const id = ev(t)[0].id
    assert.equal((await t.call(`/api/work-evidence/${id}`, { as: s.otherAdmin })).status, 404)
    assert.equal((await t.call(`/api/work-evidence/${id}`, { as: s.outsider })).status, 404, 'another team’s employee')
    assert.equal((await t.call(`/api/work-evidence/${id}`, { as: s.manager2 })).status, 404, 'a manager without them in scope')
    assert.equal((await t.call(`/api/work-evidence/${id}`, { as: s.manager })).status, 200)
    assert.equal((await t.call('/api/work-evidence?view=mine', { as: s.otherAdmin })).body.length, 0)
    assert.equal((await t.call(`/api/work-evidence/sources?userId=${s.employee.id}`, { as: s.outsider })).status, 404)
    assert.equal((await fetch(`${t.base}${msgs.url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer tpv_wrong' }, body: '{}' })).status, 401)
    assert.equal((await fetch(`${t.base}/api/work-evidence/events/${uuid()}`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${msgs.token}` }, body: '{}' })).status, 401, 'a token works for its own subscription only')
    // Expired connection: refused with a clear message.
    vs.listConnections = async () => [{ id: `auth_slack_${s.employee.id.slice(0, 6)}`, isExpired: true }]
    assert.equal((await source(t, s.employee, { app: 'slack', connectionId: conn, scope: { value: 'C0PAYMENTS' } })).body.error.code, 'connection_expired')
  } finally { await t.close() }
})

test('incremental sync, retry after failure, rate limit, health check, pause and disconnect', async () => {
  const { t, vs, s } = await setup()
  try {
    const conn = connect(t, vs, s, s.employee, 'slack')
    await source(t, s.employee, { app: 'slack', connectionId: conn, scope: { value: 'C0PAYMENTS' } })
    const [msgs] = tokensOf(vs)
    await deliver(t, msgs, SLACK('1762500000.000100', 'first'))
    await deliver(t, msgs, SLACK('1762600000.000100', 'second'))
    let src = t.db.prepare('SELECT * FROM evidence_sources').get()
    assert.equal(src.events_received, 2); assert.equal(src.checkpoint, new Date(1762600000000).toISOString())
    // A crash between receiving and processing: the row waits as RECEIVED; the scheduled retry processes it.
    const sub = t.db.prepare('SELECT * FROM evidence_subscriptions LIMIT 1').get()
    t.db.prepare(`INSERT INTO evidence_inbox (id, org_id, subscription_id, method, payload, payload_hash, status, attempts, received_at) VALUES (?, ?, ?, 'trigger', ?, 'h1', 'RECEIVED', 0, ?)`)
      .run(uuid(), s.org.id, sub.id, JSON.stringify(SLACK('1762700000.000100', 'third')), new Date(Date.now() - 120000).toISOString())
    assert.equal(retryInbox(t.db).processed, 1)
    assert.equal(ev(t).length, 3)
    // A bad event fails, is retried up to the limit, and tells the owner in the app after repeated failures — no M91.
    for (let i = 0; i < 3; i++) await deliver(t, msgs, { text: `no ts ${i}`, channel: 'C0PAYMENTS' })
    retryInbox(t.db)
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'evidence_sync_error'`).get(s.employee.id))
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries`).get().n, 0)
    for (let i = 0; i < 6; i++) retryInbox(t.db)
    assert.ok(t.db.prepare(`SELECT MAX(attempts) AS n FROM evidence_inbox WHERE status = 'FAILED'`).get().n <= 5, 'retries stop at the limit')
    // Health check: the connection disappears on viaSocket → NEEDS_RECONNECT, without any write to the app.
    vs.conns.set(s.employee.id, [])
    const { checkSourceHealth } = await import('../server/evidence/sources.js')
    assert.equal((await checkSourceHealth(t.db, vs)).checked, 1)
    src = t.db.prepare('SELECT * FROM evidence_sources').get()
    assert.equal(src.status, 'NEEDS_RECONNECT')
    // Pause: viaSocket flows paused, events ignored.
    vs.conns.set(s.employee.id, [`auth_slack_${s.employee.id.slice(0, 6)}`])
    t.db.prepare(`UPDATE evidence_sources SET status = 'ACTIVE'`).run()
    assert.equal((await t.call(`/api/work-evidence/sources/${src.id}/status`, { method: 'POST', as: s.employee, body: { status: 'PAUSED' } })).status, 200)
    assert.deepEqual(vs.calls.setFlowStatus.map((x) => x.status), [2, 2])
    assert.equal((await deliver(t, msgs, SLACK('1764000000.0001', 'while paused'))).body.status, 'ignored')
    // Disconnecting the account stops collection.
    t.db.prepare(`UPDATE evidence_sources SET status = 'ACTIVE'`).run(); t.db.prepare(`UPDATE evidence_subscriptions SET status = 'ACTIVE'`).run()
    vs.revokeConnection = async () => {}; vs.listFlows = async () => []
    assert.equal((await t.call(`/api/viasocket/connections/${conn}`, { method: 'DELETE', as: s.employee })).status, 200)
    assert.equal(t.db.prepare('SELECT status FROM evidence_sources').get().status, 'NEEDS_RECONNECT')
    // Rate limit on one subscription (answered before the paused check).
    let limited = 0
    for (let i = 0; i < 125; i++) if ((await deliver(t, msgs, SLACK(`17630000${i}.0001`, `burst ${i}`))).status === 429) limited++
    assert.ok(limited > 0)
  } finally { await t.close() }
})

test('matching: explicit reference, unmatched, wrong suggestion rejected and never re-suggested, manual link', async () => {
  const { t, vs, s } = await setup()
  try {
    const task = (await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Fix double booking in checkout', description: 'Shipments are booked twice after the queue migration.', assigneeId: s.employee.id } })).body.task
    await t.call(`/api/tasks/${task.id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    const other = (await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Update the onboarding doc', assigneeId: s.employee.id } })).body.task
    const conn = connect(t, vs, s, s.employee, 'slack')
    await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee, body: { app: 'slack', identity: 'U0EVE0001' } })
    await source(t, s.employee, { app: 'slack', connectionId: conn, scope: { value: 'C0PAYMENTS' } })
    const [msgs] = tokensOf(vs)
    const ts = (n) => `${Math.floor(Date.now() / 1000) + n}.000100`
    await deliver(t, msgs, SLACK(ts(1), `${taskRef(task.id)}: found the root cause of the double booking`))
    await deliver(t, msgs, SLACK(ts(2), 'Lunch at 1?'))
    await deliver(t, msgs, SLACK(ts(3), 'Double booking checkout fix is ready for review'))
    const list = (await t.call('/api/work-evidence?view=mine', { as: s.employee })).body
    const byText = (re) => list.find((x) => re.test(x.title))
    const explicit = byText(/root cause/)
    assert.equal(explicit.linkState, 'suggested'); assert.equal(explicit.links[0].method, 'explicit_ref'); assert.equal(explicit.links[0].usedInAnalysis, true)
    assert.equal(byText(/Lunch/).linkState, 'unmatched', 'unrelated messages stay unmatched — no task is invented')
    const wordy = byText(/ready for review/)
    assert.equal(wordy.links[0].method, 'text_time'); assert.equal(wordy.links[0].usedInAnalysis, false, 'uncertain matches stay out of analyses until confirmed')
    // The employee rejects a wrong suggestion; re-matching never brings it back.
    await t.call(`/api/work-evidence-links/${wordy.links[0].id}`, { method: 'POST', as: s.employee, body: { action: 'REJECT' } })
    await t.call('/api/contribution/analyse', { method: 'POST', as: s.employee, body: {} })
    assert.equal(t.db.prepare('SELECT status FROM evidence_task_links WHERE id = ?').get(wordy.links[0].id).status, 'rejected')
    // …and links it to the right task by hand (confirmed).
    const linked = await t.call(`/api/work-evidence/${wordy.id}/links`, { method: 'POST', as: s.employee, body: { taskId: other.id } })
    assert.equal(linked.body.links.find((l) => l.taskId === other.id).status, 'confirmed')
    // No task request or task was created from any message.
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM task_requests').get().n, 0)
  } finally { await t.close() }
})

test('shared contributions, "not mine", manager resolution, removal, and M91 only when it matters', async () => {
  const { t, vs, s } = await setup()
  try {
    t.db.prepare(`UPDATE organizations SET settings = ? WHERE id = ?`).run(JSON.stringify({ alerts: { m91Enabled: true } }), s.org.id)
    const task = (await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Reservation token', description: 'Make bookings idempotent.', assigneeId: s.employee.id } })).body.task
    await t.call(`/api/tasks/${task.id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    const conn = connect(t, vs, s, s.employee, 'github', 'eve-gh')
    await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee2, body: { app: 'github', identity: 'ed-gh' } })
    await source(t, s.employee, { app: 'github', connectionId: conn, scope: { value: 'acme/shop' }, kinds: ['commits'] })
    const [commits] = tokensOf(vs)
    const at = new Date().toISOString()
    await deliver(t, commits, { commits: [{ ...COMMIT('b1', `${taskRef(task.id)} add token`), commit: { message: `${taskRef(task.id)} add token`, author: { date: at } } }, { ...COMMIT('b2', `${taskRef(task.id)} fix race`, 'ed-gh'), commit: { message: `${taskRef(task.id)} fix race`, author: { date: at } } }] })
    const edCommit = ev(t, `external_id = 'commit:acme/shop@b2'`)[0]
    const link = t.db.prepare('SELECT * FROM evidence_task_links WHERE evidence_id = ?').get(edCommit.id)
    assert.equal(link.contributor_id, s.employee2.id); assert.equal(link.share, 'shared', 'Ed’s commit on Eve’s task: shared, never Eve’s')
    // In Eve's evidence pack, Ed's commit is a teammate's work; her own commit is hers.
    const { pack, facts } = buildEvidencePack(t.db, t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id), s.employee.id)
    const ext = pack.items.filter((i) => i.kind === 'external')
    assert.deepEqual(ext.map((i) => i.author).sort(), ['employee', 'teammate'])
    assert.ok(facts.external.some((x) => x.author === 'teammate'))
    // "Not mine": Eve disputes her attributed commit → link stops counting; managers alerted (M91 only once the task is assessed).
    const eveCommit = ev(t, `external_id = 'commit:acme/shop@b1'`)[0]
    assert.equal((await t.call(`/api/work-evidence/${eveCommit.id}/dispute`, { method: 'POST', as: s.employee, body: { reason: 'Paired commit — Ed wrote most of it.' } })).body.attribution, 'disputed')
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'evidence_attribution_note'`).get(s.manager.id))
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries`).get().n, 0, 'not consequential yet: no M91')
    assert.equal(buildEvidencePack(t.db, t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id), s.employee.id).pack.items.filter((i) => i.kind === 'external').length, 1, 'disputed evidence no longer used')
    // The manager resolves it: Ed's work.
    const res = await t.call(`/api/work-evidence/${eveCommit.id}/attribution`, { method: 'POST', as: s.manager, body: { userId: s.employee2.id, reason: 'Checked with both.' } })
    assert.equal(res.body.attribution, 'member'); assert.equal(res.body.actorId, s.employee2.id)
    assert.equal((await t.call(`/api/work-evidence/${eveCommit.id}/attribution`, { method: 'POST', as: s.employee, body: { userId: s.employee.id } })).status, 403)
    // Shared ownership resolved by the manager.
    const shared = await t.call(`/api/work-evidence-links/${link.id}/share`, { method: 'POST', as: s.manager, body: { share: 'SHARED', contributorId: s.employee2.id } })
    assert.equal(shared.status, 200)
    assert.ok(t.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'evidence.attribution_resolved'`).get())
    // The collector removes evidence: content gone, links dropped, row kept as removed.
    await t.call(`/api/work-evidence/${edCommit.id}`, { method: 'DELETE', as: s.employee2 }).then((r) => assert.equal(r.status, 403, 'only the collector: ' + JSON.stringify(r.body) + JSON.stringify(ev(t, 'id = ?', edCommit.id).map((x) => [x.attribution, x.actor_user_id === s.employee2.id]))))
    assert.equal((await t.call(`/api/work-evidence/${edCommit.id}`, { method: 'DELETE', as: s.employee })).status, 200)
    assert.equal(ev(t, `id = ?`, edCommit.id)[0].content, null)
    // Consequential dispute: the task now has an assessment → M91 delivery queued (rule on by default).
    t.db.prepare(`INSERT INTO contribution_assessments (id, org_id, user_id, task_id, rubric_id, rubric_version, provider, prompt_version, evidence_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'rubric-default-v2', 'default-2026-11-v2', 'rules', 'x', 'partial', ?, ?)`).run(uuid(), s.org.id, s.employee.id, task.id, now(), now())
    await deliver(t, commits, { commits: [{ ...COMMIT('b3', `${taskRef(task.id)} docs`), commit: { message: `${taskRef(task.id)} docs`, author: { date: at } } }] })
    const third = ev(t, `external_id = 'commit:acme/shop@b3'`)[0]
    await t.call(`/api/work-evidence/${third.id}/dispute`, { method: 'POST', as: s.employee, body: { reason: 'Not mine.' } })
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries WHERE rule = 'evidence_attribution_review'`).get().n, 1)
  } finally { await t.close() }
})

test('analysis with external evidence: grouped, cited only when linked, guardrails hold; collection never calls the AI', async () => {
  const none = () => ({ state: 'insufficient_evidence', level: 0, confidence: 0.3, reason: 'n', evidence_refs: [] })
  let lastPack = null
  const ai = { configured: true, name: 'scripted', model: 'scripted-v1', calls: 0 }
  ai.generate = async ({ user }) => {
    ai.calls++
    const pack = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1)); lastPack = pack
    const ext = pack.items.filter((i) => i.kind === 'external'); const cand = pack.items.filter((i) => i.kind === 'candidate')
    const sheet = ext.find((i) => i.app === 'Google Sheets'); const team = ext.find((i) => i.author === 'teammate'); const own = ext.find((i) => i.author === 'employee' && i.app === 'GitHub')
    return { model: 'scripted-v1', usage: null, output: {
      understanding: 'u', observed_facts: [{ fact: 'PR #41 was merged', refs: [own.ref] }, { fact: 'made up', refs: [cand[0].ref] }],
      complexity: { state: 'assessed', level: 'L3', confidence: 0.8, reason: 'r', evidence_refs: [own.ref, cand[0].ref] },
      dimensions: { impact: { state: 'assessed', level: 3, confidence: 0.8, reason: 'tracker shows faster refunds', evidence_refs: [sheet.ref] }, quality: none(), ownership: { state: 'assessed', level: 4, confidence: 0.8, reason: 'r', evidence_refs: [team.ref] }, problem_solving: { state: 'assessed', level: 4, confidence: 0.8, reason: 'r', evidence_refs: [own.ref] }, collaboration: none() },
      contribution_summary: 's', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: '',
      evidence_matches: cand.map((c) => ({ ref: c.ref, relevant: true, reason: 'about the same fix' }))
    } }
  }
  const vs = stubVs()
  const t = await startApp({ vs, ai })
  try {
    const s = seedOrg(t.db)
    const task = (await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Fix double booking', description: 'Bookings are duplicated after the queue migration; make the handler idempotent.', assigneeId: s.employee.id } })).body.task
    await t.call(`/api/tasks/${task.id}/status`, { method: 'POST', as: s.employee, body: { status: 'IN_PROGRESS' } })
    const ref = taskRef(task.id)
    const at = new Date().toISOString()
    const gh = connect(t, vs, s, s.employee, 'github', 'eve-gh')
    await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee2, body: { app: 'github', identity: 'ed-gh' } })
    await source(t, s.employee, { app: 'github', connectionId: gh, scope: { value: 'acme/shop' }, kinds: ['pull_requests', 'commits'] })
    const sh = connect(t, vs, s, s.employee, 'google-sheets')
    await source(t, s.employee, { app: 'google-sheets', connectionId: sh, scope: { value: 'SS_1', sheet: '0' } })
    const sl = connect(t, vs, s, s.employee, 'slack')
    await t.call('/api/work-evidence/identities', { method: 'POST', as: s.employee, body: { app: 'slack', identity: 'U0EVE0001' } })
    await source(t, s.employee, { app: 'slack', connectionId: sl, scope: { value: 'C0PAYMENTS' }, kinds: ['messages'] })
    const [prs, commits, rows, msgs] = tokensOf(vs)
    await deliver(t, prs, { ...PR(41, { merged: true, action: 'closed', title: `${ref} Idempotent reservation token` }), pull_request: { ...PR(41, { merged: true }).pull_request, title: `${ref} Idempotent reservation token`, merged_at: at } })
    await deliver(t, commits, { commits: [1, 2, 3, 4, 5].map((i) => ({ ...COMMIT(`c${i}`, `${ref} step ${i}`), commit: { message: `${ref} step ${i}`, author: { date: at } } })).concat([{ ...COMMIT('c9', `${ref} race fix`, 'ed-gh'), commit: { message: `${ref} race fix`, author: { date: at } } }]) })
    await deliver(t, rows, ROW(3, { Task: ref, Metric: 'Duplicate bookings/week', Before: '40', After: '0' }))
    await deliver(t, msgs, SLACK(`${Math.floor(Date.now() / 1000)}.000500`, 'Talked to finance about refunds for the duplicates'))
    assert.equal(ai.calls, 0, 'collection alone never runs an AI analysis')
    const before = ev(t).length
    await t.call(`/api/tasks/${task.id}/assessment/analyse`, { method: 'POST', as: s.employee }); await measurementSettled(); await t.settled()
    assert.equal(ai.calls, 1)
    const ext = lastPack.items.filter((i) => i.kind === 'external')
    assert.equal(ext.filter((i) => /series/.test(i.eventType)).length, 1, 'five commits by the same person are one item')
    assert.ok(ext.some((i) => i.author === 'teammate'), 'Ed’s commit is present as a teammate’s work')
    assert.ok(lastPack.items.some((i) => i.kind === 'candidate'), 'the unlinked Slack message is offered as a candidate only')
    assert.doesNotMatch(JSON.stringify(lastPack), /"commitCount"|"messages":\s*\d|"count"/, 'no activity counts in the pack')
    const a = (await t.call(`/api/tasks/${task.id}/assessment`, { as: s.employee })).body.assessment
    const dim = (k) => a.dimensions.find((d) => d.key === k)
    assert.equal(dim('ownership').state, 'insufficient_evidence', 'never rated from a teammate’s work')
    assert.equal(dim('impact').level, 2, 'a spreadsheet figure alone caps impact at 2')
    assert.ok(a.guardrails.some((n) => /not linked to this task/.test(n)), 'candidate citation removed')
    assert.ok(a.complexity.evidence.every((e) => e.kind !== 'candidate'))
    const facts = JSON.parse(t.db.prepare('SELECT context_json FROM contribution_assessments WHERE id = ?').get(a.id).context_json).observedFacts
    assert.deepEqual(facts.map((f) => f.fact), ['PR #41 was merged'], 'a "fact" without linked evidence is dropped')
    // The AI's proposed match is stored as a suggestion for the employee to confirm (never confirmed, below the analysis threshold).
    const ai2 = t.db.prepare(`SELECT * FROM evidence_task_links WHERE method = 'ai'`).all()
    assert.equal(ai2.length, 1); assert.equal(ai2[0].status, 'suggested'); assert.ok(ai2[0].confidence < 0.85)
    assert.equal(ev(t).length, before, 'analysis does not create evidence')
    // Team Intelligence: no activity counts, alphabetical, review queue visible.
    const intel = await t.call('/api/contribution/intelligence', { as: s.manager })
    assert.equal(intel.status, 200)
    assert.doesNotMatch(JSON.stringify(intel.body), /"(commits|messages|emails|meetings|score|rank)"\s*:/i)
    assert.equal(intel.body.ordering, 'alphabetical')
    assert.equal((await t.call('/api/contribution/intelligence', { as: s.employee })).status, 403)
  } finally { await t.close() }
})

test('guardrails directly: external evidence by others never credits the employee; candidates never citable', () => {
  const pack = { task: { title: 't' }, items: [
    { ref: 'external-1', kind: 'external', author: 'teammate', verification: 'system_recorded', title: 'Ed: race fix' },
    { ref: 'external-2', kind: 'external', author: 'employee', verification: 'self_reported', text: 'I fixed it' },
    { ref: 'candidate-1', kind: 'candidate', title: 'unrelated' }] }
  const facts = { refs: { task: { kind: 'task' }, 'external-1': { kind: 'external' }, 'external-2': { kind: 'external' }, 'candidate-1': { kind: 'candidate', evidenceId: 'e1' } }, impacts: [], claims: [], signals: { qualityConcerns: [], changesRequested: 0, approved: false }, regression: false, delivered: true, blockedOutside: false, evidenceItems: 0 }
  const rate = (level, refs) => ({ state: 'assessed', level, confidence: 0.9, reason: 'r', evidence_refs: refs })
  const out = applyGuardrails({
    understanding: 'u', observed_facts: [], complexity: { state: 'assessed', level: 'L4', confidence: 0.9, reason: 'r', evidence_refs: ['external-2'] },
    dimensions: { impact: rate(2, ['external-2']), quality: rate(4, ['external-1']), ownership: rate(5, ['candidate-1']), problem_solving: rate(5, ['external-1']), collaboration: rate(4, ['external-2']) },
    contribution_summary: 's', estimated_outcomes: [], missing_information: [], blocker_note: '', shared_contribution_note: '', evidence_matches: [{ ref: 'external-1', relevant: true, reason: 'x' }]
  }, { pack, facts, task: { description: 'd', expected_outcome: 'e' } })
  assert.equal(out.complexity.level, 2, 'the employee’s own message cannot make work L3+')
  assert.equal(out.dimensions.quality.state, 'insufficient_evidence'); assert.equal(out.dimensions.problem_solving.state, 'insufficient_evidence')
  assert.equal(out.dimensions.ownership.state, 'insufficient_evidence', 'a candidate is not evidence')
  assert.equal(out.dimensions.collaboration.level, 3, 'self-reported only: capped')
  assert.deepEqual(out.matches, [], 'matches only for candidates')
})

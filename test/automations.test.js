// Automation logic against a stand-in with the viasocket-apps 0.19 gateway shape. These prove KONVO's own rules
// (scoping, idempotency, loops, approval); they are NOT live viaSocket tests — those run against the real service.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { startApp, seedOrg } from './helpers.js'
import { migrate } from '../server/db.js'

const SERVICE = { slack: 'rowbu58rc', gmail: 'rowo0bqrhj5g', github: 'rowcqz5hd8o5', 'google-calendar': 'rowkhibv5efp', 'google-sheets': 'rowqm5xi2' }
const ACTIONS = {
  slack: [{ key: 'Send_Message', actionId: 'row1jrbor', version: 'V107' }, { key: 'New_Message_Posted_in_Channel_Instant', actionId: 'rowo0opjzsgk', version: 'V2' }],
  gmail: [{ key: 'Send_Email', actionId: 'rowogelpy0h6', version: 'V55' }, { key: 'New_Email_Arrives', actionId: 'row9ls2itxoc', version: 'V11' }],
  'google-sheets': [{ key: 'Add_New_Row_to_Sheet', actionId: 'rowxsuumuqrt', version: 'V66' }, { key: 'Add_Multiple_Rows', actionId: 'rowfudy5tu2q', version: 'V15' }],
  'google-calendar': [{ key: 'Create_Calendar_Event', actionId: 'rowuitv4m6uy', version: 'V23' }],
  github: [{ key: 'Create_Issue', actionId: 'rowgh1', version: 'V3' }]
}

function fakeVs({ fail = null } = {}) {
  const v = { configured: true, runs: [], connections: new Map(), flows: new Map(), subscriptions: [], statuses: [] }
  const flowsOf = (u) => v.flows.get(u) || v.flows.set(u, []).get(u)
  Object.assign(v, {
    serviceIdFor: async (slug) => SERVICE[slug],
    versions: async () => ({ service: { auth_type: 'Auth2.0' } }),
    token: async (userId) => `embed-token-for-${userId}`,
    listConnections: async (userId) => v.connections.get(userId) || [],
    revokeConnection: async () => ({}),
    listFlows: async (userId) => flowsOf(userId),
    setFlowStatus: async (userId, scriptId, status) => { v.statuses.push({ userId, scriptId, status }) },
    listActions: async (userId, app) => ({ app, serviceId: SERVICE[app], actions: ACTIONS[app] || [] }),
    findEnabled: async () => null,
    enable: async (userId, app, authId) => { const id = `scri${app}${userId.slice(0, 6)}${flowsOf(userId).length}`; flowsOf(userId).push({ id, serviceId: SERVICE[app], authId, status: 'active' }); return { scriptId: id } },
    listOptions: async (userId, app, key, params) => {
      if (params.fieldKey === 'destination.channel_id' || params.fieldKey === 'channel_id') return { options: [{ label: '#team', value: 'C123' }, { label: '#intake', value: 'C999' }] }
      if (params.fieldKey === 'destination.userId') return { options: [{ label: 'Me', value: 'U1' }] }
      if (params.fieldKey === 'searchFields.label') return { options: [{ label: 'TeamPulse', value: 'Label_7' }] }
      return { options: [] }
    },
    runAction: async (scriptId, key, input, version) => {
      v.runs.push({ scriptId, key, input, version })
      if (fail === 'error') { const e = new Error('Slack said channel_not_found'); e.status = 400; throw e }
      if (fail === 'timeout') { const e = new Error('socket hang up'); e.status = undefined; throw e }
      return key === 'Send_Message' ? { ok: true, ts: '1700.1', channel: 'C123' } : { id: 'gmail-msg-1', threadId: 't' }
    },
    sampleEvent: async (triggerId) => (triggerId === 'row9ls2itxoc' ? { id: 'm1', subject: 'Export is broken', from: 'Customer <c@example.com>', snippet: 'CSV export fails' } : { text: 'Please add SSO', user: 'U5', ts: '1.1', channel: 'C999' }),
    subscribe: async (userId, app, key, params) => { v.subscriptions.push({ userId, app, key, params }); return { scriptId: `scrisub${v.subscriptions.length}` } }
  })
  return v
}

async function connect(t, vs, user, app) {
  const authId = `auth_${app}_${user.id.slice(0, 6)}`
  vs.connections.set(user.id, [...(vs.connections.get(user.id) || []), { id: authId, service_id: SERVICE[app], isExpired: false }])
  const r = await t.call('/api/viasocket/connections', { method: 'POST', as: user, body: { app, authId } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}

test('without ViaSocket credentials: clear errors, nothing pretends to work', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    assert.equal((await t.call('/api/viasocket/token?apps=slack', { as: s.manager })).body.error.code, 'viasocket_not_configured')
    assert.equal((await t.call('/api/automations', { as: s.manager })).body.viasocketConfigured, false)
    assert.equal((await t.call('/api/viasocket/connections', { as: s.manager })).body.apps.length, 5)
    assert.equal((await t.call('/api/notifications/prefs', { method: 'PUT', as: s.employee, body: { channel: 'slack' } })).status, 503)
    assert.equal((await t.call('/api/viasocket/context/task_assigned_to_me', { as: s.employee })).status, 503)
  } finally { await t.close() }
})

test('connections: only the user’s own viaSocket connection, curated apps only, ids never reach the browser', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    assert.equal((await t.call('/api/viasocket/token?apps=hubspot', { as: s.manager })).status, 400)
    assert.equal((await t.call('/api/viasocket/connections', { method: 'POST', as: s.manager, body: { app: 'slack', authId: 'auth_not_mine' } })).status, 403)
    const c = await connect(t, vs, s.manager, 'slack')
    assert.equal(JSON.stringify(c).includes('auth_'), false)
    assert.equal((await t.call(`/api/viasocket/connections/${c.id}/slack-channels`, { as: s.manager2 })).status, 404)
    assert.deepEqual((await t.call(`/api/viasocket/connections/${c.id}/slack-users`, { as: s.manager })).body, [{ label: 'Me', value: 'U1' }])
  } finally { await t.close() }
})

test('A1: an employee’s own Slack DM; A2: the manager’s team channel — each on its own account, by key and pinned version', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const mine = await connect(t, vs, s.employee, 'slack')
    const p = await t.call('/api/notifications/prefs', { method: 'PUT', as: s.employee, body: { channel: 'slack', connectionId: mine.id, slackMode: 'user', slackUserId: 'U1' } })
    assert.equal(p.status, 200, JSON.stringify(p.body))
    assert.equal((await t.call('/api/notifications/prefs', { method: 'PUT', as: s.employee2, body: { channel: 'slack', connectionId: mine.id, slackMode: 'user', slackUserId: 'U1' } })).status, 404, 'cannot use someone else’s connection')
    const team = await connect(t, vs, s.manager, 'slack')
    const w = await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'slack', connectionId: team.id, target: 'channel', slackChannelId: 'C123' } })
    assert.equal(w.body.status, 'ACTIVE')
    assert.equal((await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.employee, body: { channel: 'slack', connectionId: mine.id, target: 'channel', slackChannelId: 'C123' } })).status, 403)
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Fix login', assigneeId: s.employee.id } })
    await t.settled()
    assert.equal(vs.runs.length, 2)
    const dm = vs.runs.find((r) => r.input.destination.messageto === 'user')
    const ch = vs.runs.find((r) => r.input.destination.messageto === 'channel')
    assert.deepEqual(dm.input.destination, { messageto: 'user', userId: ['U1'] })
    assert.match(dm.input.markdown_content, /Eve Employee, you have a new medium priority task: Fix login/)
    assert.match(dm.input.markdown_content, /Sent by KONVO/)
    assert.doesNotMatch(JSON.stringify(dm.input), /TeamPulse/, 'an outgoing Slack message carries the current product name only')
    assert.equal(dm.key, 'Send_Message'); assert.equal(dm.version, 'v107')
    assert.ok(dm.scriptId !== ch.scriptId, 'each person’s own enabled flow')
    assert.ok(vs.flows.get(s.employee.id).some((f) => f.id === dm.scriptId))
    assert.ok(vs.flows.get(s.manager.id).some((f) => f.id === ch.scriptId))
    // Another manager's team: manager's A2 does not fire, the assignee's A1 does not exist.
    await t.call('/api/tasks', { method: 'POST', as: s.manager2, body: { title: 'Sales deck', assigneeId: s.outsider.id } })
    await t.settled()
    assert.equal(vs.runs.length, 2, 'out of scope: nobody notified')
    // Re-emitting the same assignment does not send twice.
    const { runNewTaskNotification } = await import('../server/automations/engine.js')
    const task = t.db.prepare(`SELECT * FROM tasks WHERE title = 'Fix login'`).get()
    await runNewTaskNotification(t.db, vs, { orgId: s.org.id, taskId: task.id })
    assert.equal(vs.runs.length, 2)
    // Pausing A2 stops it; A1 still works.
    await t.call('/api/automations/new_task_notification/status', { method: 'POST', as: s.manager, body: { status: 'PAUSED' } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Another', assigneeId: s.employee.id } })
    await t.settled()
    assert.equal(vs.runs.length, 3)
  } finally { await t.close() }
})

test('A2 via Gmail to the assignee; failures logged, retried, three in a row → FAILED; unknown never auto-retried', async () => {
  const vs = fakeVs({ fail: 'error' })
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const c = await connect(t, vs, s.manager, 'gmail')
    await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'gmail', connectionId: c.id, target: 'assignee' } })
    for (const n of [1, 2, 3]) await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: `T${n}`, assigneeId: s.employee.id } })
    await t.settled()
    assert.equal(vs.runs[0].input.to, s.employee.email)
    assert.equal(vs.runs[0].key, 'Send_Email'); assert.equal(vs.runs[0].version, 'v55')
    const sentEmail = JSON.stringify(vs.runs[0].input)
    assert.match(sentEmail, /Sent by KONVO/); assert.doesNotMatch(sentEmail, /TeamPulse/, 'an outgoing email carries the current product name only (sender name included)')
    assert.match(sentEmail, /KONVO/)
    const list = await t.call('/api/automations', { as: s.manager })
    const ntn = list.body.automations.find((a) => a.key === 'new_task_notification')
    assert.equal(ntn.workflow.status, 'FAILED')
    vs.runAction = async () => ({ id: 'gmail-ok' })
    assert.equal((await t.call(`/api/automations/runs/${ntn.recentRuns[0].id}/retry`, { method: 'POST', as: s.manager })).body.retried, 1)
    assert.equal((await t.call('/api/automations', { as: s.manager })).body.automations.find((a) => a.key === 'new_task_notification').workflow.status, 'ACTIVE')
  } finally { await t.close() }
  const vs2 = fakeVs({ fail: 'timeout' })
  const t2 = await startApp({ vs: vs2 })
  try {
    const s = seedOrg(t2.db)
    const c = await connect(t2, vs2, s.manager, 'slack')
    await t2.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'slack', connectionId: c.id, target: 'channel', slackChannelId: 'C123' } })
    await t2.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'T', assigneeId: s.employee.id } })
    await t2.settled()
    assert.equal((await t2.call('/api/automations/runs', { as: s.manager })).body[0].status, 'UNKNOWN')
    assert.match((await t2.call('/tasks/alerts', { headers: { Authorization: 'Bearer test-cron-secret' } })).text, /automation retries 0/)
  } finally { await t2.close() }
})

test('B: one report per manager (their teams) and per admin (whole org), delivered once per week', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const g = await connect(t, vs, s.manager, 'gmail')
    await t.call('/api/automations/weekly_team_report', { method: 'PUT', as: s.manager, body: { channel: 'gmail', connectionId: g.id, target: 'recipients', emailTo: 'leads@example.com' } })
    const sl = await connect(t, vs, s.admin, 'slack')
    await t.call('/api/automations/weekly_team_report', { method: 'PUT', as: s.admin, body: { channel: 'slack', connectionId: sl.id, target: 'channel', slackChannelId: 'C123' } })
    const r = await t.call('/tasks/weekly-report', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.match(r.text, /delivered by Slack\/Gmail 2/)
    assert.equal(vs.runs.length, 2)
    assert.equal(vs.runs.find((x) => x.key === 'Send_Email').input.to, 'leads@example.com')
    assert.match(vs.runs.find((x) => x.key === 'Send_Email').input.messageBody, /Mona Manager’s teams/)
    assert.match(vs.runs.find((x) => x.key === 'Send_Message').input.markdown_content, /Verified outcomes/)
    await t.call('/tasks/weekly-report', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.equal(vs.runs.length, 2, 'not sent twice')
    // In-app report for every manager and admin, once: admin, manager, manager2 (Acme) + other org admin.
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM weekly_reports').get().n, 4)
    const scopes = t.db.prepare(`SELECT summary FROM weekly_reports`).all().map((x) => JSON.parse(x.summary).scope).sort()
    assert.deepEqual(scopes, ['organization', 'organization', 'team', 'team'])
  } finally { await t.close() }
})

test('C: Gmail label / Slack channel intake → pending requests only; duplicates, own messages, bots and wrong tokens rejected', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs, cfgOverrides: { appUrl: 'https://teampulse.test' } })
  try {
    const s = seedOrg(t.db)
    const g = await connect(t, vs, s.manager, 'gmail')
    const sl = await connect(t, vs, s.manager, 'slack')
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.employee, body: { app: 'gmail', connectionId: g.id, target: 'Label_7' } })).status, 403)
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { app: 'gmail', connectionId: g.id, target: 'Label_typed' } })).status, 400)
    const preview = await t.call('/api/intakes/sample', { method: 'POST', as: s.manager, body: { app: 'gmail', connectionId: g.id, target: 'Label_7' } })
    assert.equal(preview.body.preview.title, 'Export is broken')
    const gi = await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { app: 'gmail', connectionId: g.id, target: 'Label_7' } })
    assert.equal(gi.status, 201, JSON.stringify(gi.body))
    const sub = vs.subscriptions[0]
    assert.equal(sub.app, 'gmail'); assert.equal(sub.key, 'New_Email_Arrives'); assert.equal(sub.params.version, 'v11')
    assert.deepEqual(sub.params.inputData, { thread: 'first_email_only', query: ['label'], searchFields: { label: ['Label_7'] } })
    const token = sub.params.code.match(/Bearer (tpe_[A-Za-z0-9_-]+)/)[1]
    assert.ok(sub.params.code.includes(`https://teampulse.test/api/viasocket/events/${gi.body.id}`))
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM intake_subscriptions WHERE token_hash = ?').get(token).n, 0, 'token not stored in clear')
    const post = (id, tok, event) => t.call(`/api/viasocket/events/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: { event } })
    assert.equal((await post(gi.body.id, 'tpe_wrong', {})).status, 401)
    const ev = { id: 'm1', subject: 'Export is broken', from: 'Customer <c@example.com>', snippet: 'CSV export fails since Monday' }
    assert.equal((await post(gi.body.id, token, ev)).body.status, 'created')
    assert.equal((await post(gi.body.id, token, ev)).body.status, 'duplicate')
    // Our own emails are ignored under the current name and under the name used before the rename (those are still in people's mailboxes).
    assert.equal((await post(gi.body.id, token, { id: 'm2', subject: 'New task: x', snippet: 'Hi\n\nSent by TeamPulse' })).body.status, 'ignored')
    assert.equal((await post(gi.body.id, token, { id: 'm2b', subject: 'New task: y', snippet: 'Hi\n\nSent by KONVO' })).body.status, 'ignored')
    assert.equal((await post(gi.body.id, token, { id: 'm2c', subject: 'Weekly summary', from: 'TeamPulse <no-reply@example.com>', snippet: 'Summary' })).body.status, 'ignored', 'former sender name')
    assert.equal((await post(gi.body.id, token, { id: 'm2d', subject: 'Weekly summary', from: 'KONVO <no-reply@example.com>', snippet: 'Summary' })).body.status, 'ignored', 'current sender name')
    const reqs = await t.call('/api/requests', { as: s.manager })
    assert.equal(reqs.body.length, 1)
    assert.equal(reqs.body[0].status, 'PENDING'); assert.equal(reqs.body[0].source, 'external'); assert.equal(reqs.body[0].suggestedAssigneeId, null)
    assert.equal(reqs.body[0].teamId, s.teamA)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'never a task')
    // Slack: intake channel cannot be an outbound channel and vice versa (no loops); bots ignored.
    await t.call('/api/automations/weekly_team_report', { method: 'PUT', as: s.manager, body: { channel: 'slack', connectionId: sl.id, target: 'channel', slackChannelId: 'C123' } })
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { app: 'slack', connectionId: sl.id, target: 'C123' } })).body.error.code, 'intake_loop')
    const si = await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { app: 'slack', connectionId: sl.id, target: 'C999' } })
    assert.equal(si.status, 201)
    assert.equal((await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'slack', connectionId: sl.id, target: 'channel', slackChannelId: 'C999' } })).body.error.code, 'intake_loop')
    const stok = vs.subscriptions[1].params.code.match(/Bearer (tpe_[A-Za-z0-9_-]+)/)[1]
    assert.equal((await post(si.body.id, stok, { text: 'Deploy done', bot_id: 'B1', ts: '2.2', channel: 'C999' })).body.status, 'ignored')
    assert.equal((await post(si.body.id, stok, { text: 'Please add SSO to the admin app', user: 'U5', ts: '3.3', channel: 'C999' })).body.status, 'created')
    // Other managers do not see this team's intake requests; pausing stops intake; the other org sees nothing.
    assert.equal((await t.call('/api/requests', { as: s.manager2 })).body.length, 0)
    assert.equal((await t.call('/api/intakes', { as: s.manager2 })).body.length, 0)
    await t.call(`/api/intakes/${si.body.id}/status`, { method: 'POST', as: s.manager, body: { status: 'PAUSED' } })
    assert.deepEqual(vs.statuses.at(-1), { userId: s.manager.id, scriptId: 'scrisub2', status: 2 })
    assert.equal((await post(si.body.id, stok, { text: 'Another', user: 'U5', ts: '4.4' })).body.status, 'ignored')
    const runs = await t.call('/api/automations/runs', { as: s.manager })
    assert.ok(runs.body.some((r) => r.useCase === 'gmail_slack_intake' && r.status === 'SUCCEEDED'))
  } finally { await t.close() }
})

test('D: context builder is restricted to the curated apps; only the user’s own events reach their own flows', async () => {
  const vs = fakeVs()
  const posted = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://flow.sokt.io/') ? (posted.push({ url, body: JSON.parse(init.body) }), new Response('{"ok":true}', { status: 200 })) : realFetch(url, init))
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const e = await t.call('/api/viasocket/context/task_assigned_to_me', { as: s.employee })
    assert.deepEqual(e.body.filteredServices.rowqm5xi2, { rowxsuumuqrt: true })
    assert.ok(!('rowcqz5hd8o5' in e.body.filteredServices), 'GitHub not offered here')
    assert.equal(e.body.token, `embed-token-for-${s.employee.id}`)
    assert.equal((await t.call('/api/viasocket/context/weekly_report_ready', { as: s.employee })).status, 403)
    // A flow the employee published from My Tasks (read back from viaSocket, URL never from the browser).
    vs.flows.set(s.employee.id, [{ id: 'scriFlowE', title: 'Tasks to Sheets', status: 'active', webhook: 'https://flow.sokt.io/func/scriFlowE' }])
    vs.flows.set(s.employee2.id, [{ id: 'scriFlowX', title: 'Other', status: 'active', webhook: 'https://flow.sokt.io/func/scriFlowX' }])
    assert.equal((await t.call('/api/viasocket/embed-flows/scriFlowE/sync', { method: 'POST', as: s.employee, body: { context: 'task_assigned_to_me', app: 'google-sheets' } })).body.context, 'task_assigned_to_me')
    await t.call('/api/viasocket/embed-flows/scriFlowX/sync', { method: 'POST', as: s.employee2, body: { context: 'task_assigned_to_me' } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Ship it', assigneeId: s.employee.id } })
    await t.settled()
    assert.equal(posted.length, 1)
    assert.equal(posted[0].url, 'https://flow.sokt.io/func/scriFlowE')
    assert.equal(posted[0].body.task.title, 'Ship it')
    assert.equal(posted[0].body.dedupe, undefined)
  } finally { globalThis.fetch = realFetch; await t.close() }
})

test('migration 003 keeps existing automations and their run history (table rebuild with foreign keys intact)', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  for (const f of ['001_init.sql', '002_m91_responses.sql']) { db.exec(readFileSync(new URL(`../server/migrations/${f}`, import.meta.url), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, 'x') }
  const ts = new Date().toISOString()
  db.prepare(`INSERT INTO organizations (id, name, join_code, created_at, updated_at) VALUES ('o1','O','J1',?,?)`).run(ts, ts)
  db.prepare(`INSERT INTO users (id, google_sub, email, name, created_at, updated_at) VALUES ('u1','s1','a@b.co','A',?,?)`).run(ts, ts)
  db.prepare(`INSERT INTO automation_use_cases (key, name, description, updated_at) VALUES ('weekly_team_report','W','d',?)`).run(ts)
  db.prepare(`INSERT INTO automation_workflows (id, org_id, use_case_key, owner_id, status, config, created_at, updated_at) VALUES ('w1','o1','weekly_team_report','u1','ACTIVE','{}',?,?)`).run(ts, ts)
  db.prepare(`INSERT INTO automation_execution_logs (id, org_id, workflow_id, use_case_key, trigger, status, started_at) VALUES ('l1','o1','w1','weekly_team_report','schedule','SUCCEEDED',?)`).run(ts)
  assert.deepEqual(migrate(db), ['003_viasocket_automations.sql', '004_outbox.sql', '005_backup_restore_check.sql', '006_email_password_auth.sql', '007_work_measurement.sql', '008_external_evidence.sql', '009_work_signals.sql', '010_slack_task_intake.sql'])
  assert.equal(db.prepare('SELECT workflow_id FROM automation_execution_logs').get().workflow_id, 'w1', 'run history still points at its automation')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM automation_workflows').get().n, 1)
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
})

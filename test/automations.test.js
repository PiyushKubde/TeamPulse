import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg } from './helpers.js'

/** A stand-in viaSocket gateway with the same shape as integrations/viasocket.js. */
function fakeVs({ fail = null } = {}) {
  const v = { configured: true, runs: [], connections: new Map(), flows: [] }
  Object.assign(v, {
    serviceIdFor: async (slug) => ({ slack: 'rowbu58rc', gmail: 'rowo0bqrhj5g', github: 'rowcqz5hd8o5', 'google-calendar': 'rowkhibv5efp', 'google-sheets': 'rowqm5xi2' })[slug],
    versionIdFor: async (sid, actionId, ver) => `${actionId}_${ver}`,
    token: async (userId) => `embed-token-for-${userId}`,
    listConnections: async (userId) => v.connections.get(userId) || [],
    revokeConnection: async () => ({}),
    listFlows: async () => v.flows,
    enable: async (userId, serviceId, authId) => { const id = `scri${serviceId}${v.flows.length}`; v.flows.push({ id, serviceId, authId, status: 'active' }); return { scriptId: id } },
    setFlowStatus: async () => ({}),
    listOptions: async () => ({ options: [{ label: '#team', value: 'C123' }] }),
    runAction: async (scriptId, versionId, input) => {
      v.runs.push({ scriptId, versionId, input })
      if (fail === 'error') { const e = new Error('Slack said channel_not_found'); e.status = 400; throw e }
      if (fail === 'timeout') { const e = new Error('socket hang up'); e.status = undefined; throw e }
      return versionId.startsWith('row1jrbor') ? { ok: true, ts: '1700.1', channel: 'C123' } : { id: 'gmail-msg-1', threadId: 't' }
    }
  })
  return v
}

async function connect(t, vs, user, app) {
  const authId = `auth_${app}_${user.id.slice(0, 6)}`
  vs.connections.set(user.id, [...(vs.connections.get(user.id) || []), { id: authId, service_id: await vs.serviceIdFor(app), isExpired: false }])
  const r = await t.call('/api/viasocket/connections', { method: 'POST', as: user, body: { app, authId } })
  assert.equal(r.status, 200)
  return r.body
}

test('without ViaSocket credentials: clear errors, nothing pretends to work', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const tok = await t.call('/api/viasocket/token?apps=slack', { as: s.manager })
    assert.equal(tok.status, 503)
    assert.equal(tok.body.error.code, 'viasocket_not_configured')
    const list = await t.call('/api/automations', { as: s.manager })
    assert.equal(list.body.viasocketConfigured, false)
    const conns = await t.call('/api/viasocket/connections', { as: s.manager })
    assert.equal(conns.body.configured, false)
    assert.equal(conns.body.apps.length, 5)
    assert.equal((await t.call('/api/automations/new_task_notification/status', { method: 'POST', as: s.manager, body: { status: 'ACTIVE' } })).status, 409)
  } finally { await t.close() }
})

test('connections: only the user’s own viaSocket connection can be saved; curated apps only', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const tok = await t.call('/api/viasocket/token?apps=slack,gmail', { as: s.manager })
    assert.equal(tok.body.token, `embed-token-for-${s.manager.id}`)
    assert.equal(tok.body.serviceIds.slack, 'rowbu58rc')
    assert.equal((await t.call('/api/viasocket/token?apps=hubspot', { as: s.manager })).status, 400)
    assert.equal((await t.call('/api/viasocket/connections', { method: 'POST', as: s.manager, body: { app: 'slack', authId: 'auth_not_mine' } })).status, 403)
    const c = await connect(t, vs, s.manager, 'slack')
    assert.equal(c.status, 'active')
    assert.equal(JSON.stringify(c).includes('auth_'), false, 'auth_id never reaches the browser')
    // Another user cannot use it.
    assert.equal((await t.call(`/api/viasocket/connections/${c.id}/slack-channels`, { as: s.manager2 })).status, 404)
    const ch = await t.call(`/api/viasocket/connections/${c.id}/slack-channels`, { as: s.manager })
    assert.deepEqual(ch.body, [{ label: '#team', value: 'C123' }])
  } finally { await t.close() }
})

test('Automation 1: New Task Notification runs on assignment via Slack, logs success, dedupes', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const c = await connect(t, vs, s.manager, 'slack')
    const w = await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'slack', connectionId: c.id, slackChannelId: 'C123' } })
    assert.equal(w.status, 200)
    assert.equal(w.body.status, 'ACTIVE')
    assert.equal(w.body.config.slackChannelLabel, '#team')
    assert.equal((await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.employee, body: { channel: 'slack', connectionId: c.id, slackChannelId: 'C123' } })).status, 403)
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Fix login', assigneeId: s.employee.id } })
    await t.settled()
    assert.equal(vs.runs.length, 1)
    assert.match(vs.runs[0].input.markdown_content, /Eve Employee, you have a new medium priority task: Fix login/)
    assert.deepEqual(vs.runs[0].input.destination, { messageto: 'channel', channel_id: ['C123'] })
    const runs = await t.call('/api/automations/runs', { as: s.manager })
    assert.equal(runs.body[0].status, 'SUCCEEDED')
    assert.match(runs.body[0].summary, /ts 1700.1/)
    // Pausing stops runs.
    await t.call('/api/automations/new_task_notification/status', { method: 'POST', as: s.manager, body: { status: 'PAUSED' } })
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Another', assigneeId: s.employee.id } })
    await t.settled()
    assert.equal(vs.runs.length, 1)
  } finally { await t.close() }
})

test('Automation 1 via Gmail; failures are logged, retried, and three in a row mark it FAILED; unknown is never auto-retried', async () => {
  const vs = fakeVs({ fail: 'error' })
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const c = await connect(t, vs, s.manager, 'gmail')
    await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'gmail', connectionId: c.id } })
    for (const n of [1, 2, 3]) await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: `T${n}`, assigneeId: s.employee.id } })
    await t.settled()
    assert.equal(vs.runs[0].input.to, s.employee.email)
    const list = await t.call('/api/automations', { as: s.manager })
    const ntn = list.body.automations.find((a) => a.key === 'new_task_notification')
    assert.equal(ntn.workflow.status, 'FAILED')
    assert.match(ntn.workflow.lastError, /channel_not_found/)
    assert.equal(ntn.recentRuns.every((r) => r.status === 'FAILED'), true)
    // Manual retry after the problem is fixed.
    vs.runAction = async () => ({ id: 'gmail-ok' })
    const r = await t.call(`/api/automations/runs/${ntn.recentRuns[0].id}/retry`, { method: 'POST', as: s.manager })
    assert.equal(r.body.retried, 1)
    const after = await t.call('/api/automations', { as: s.manager })
    assert.equal(after.body.automations.find((a) => a.key === 'new_task_notification').workflow.status, 'ACTIVE')
  } finally { await t.close() }

  const vs2 = fakeVs({ fail: 'timeout' })
  const t2 = await startApp({ vs: vs2 })
  try {
    const s = seedOrg(t2.db)
    const c = await connect(t2, vs2, s.manager, 'slack')
    await t2.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'slack', connectionId: c.id, slackChannelId: 'C123' } })
    await t2.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'T', assigneeId: s.employee.id } })
    await t2.settled()
    assert.equal((await t2.call('/api/automations/runs', { as: s.manager })).body[0].status, 'UNKNOWN')
    const r = await t2.call('/tasks/alerts', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.match(r.text, /automation retries 0/)
  } finally { await t2.close() }
})

test('Automation 2: external requests become PENDING task requests only, idempotent by externalRef', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const noAuth = await t.call('/api/inbound/task-requests', { method: 'POST', body: { title: 'x' } })
    assert.equal(noAuth.status, 401)
    assert.equal((await t.call('/api/automations/external_request_intake/token', { method: 'POST', as: s.employee })).status, 403)
    const tok = await t.call('/api/automations/external_request_intake/token', { method: 'POST', as: s.manager })
    assert.match(tok.body.token, /^tpi_/)
    await t.call('/api/automations/external_request_intake', { method: 'PUT', as: s.manager, body: { defaultTeamId: s.teamA } })
    const headers = { Authorization: `Bearer ${tok.body.token}` }
    const r = await t.call('/api/inbound/task-requests', { method: 'POST', headers, body: { title: 'Customer: export broken', description: 'From support inbox', requester: 'support@customer.com', externalRef: 'gmail-123', suggestedPriority: 'HIGH' } })
    assert.equal(r.status, 201)
    const dup = await t.call('/api/inbound/task-requests', { method: 'POST', headers, body: { title: 'Customer: export broken', externalRef: 'gmail-123' } })
    assert.equal(dup.body.duplicate, true)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'never an official task')
    const reqs = await t.call('/api/requests', { as: s.manager })
    assert.equal(reqs.body.length, 1)
    assert.equal(reqs.body[0].source, 'external')
    assert.equal(reqs.body[0].status, 'PENDING')
    assert.equal(reqs.body[0].suggestedAssigneeId, null)
    // Other org's managers do not see it; a bad body is rejected and logged.
    assert.equal((await t.call('/api/requests', { as: s.otherAdmin })).body.length, 0)
    assert.equal((await t.call('/api/inbound/task-requests', { method: 'POST', headers, body: { title: '' } })).status, 400)
    const runs = await t.call('/api/automations/runs', { as: s.manager })
    assert.deepEqual(runs.body.map((x) => x.status).sort(), ['FAILED', 'SKIPPED', 'SUCCEEDED'])
    await t.call('/api/automations/external_request_intake/status', { method: 'POST', as: s.manager, body: { status: 'PAUSED' } })
    assert.equal((await t.call('/api/inbound/task-requests', { method: 'POST', headers, body: { title: 'y' } })).status, 409)
  } finally { await t.close() }
})

test('Automation 3: weekly report is generated once and delivered through the configured channel', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    const c = await connect(t, vs, s.admin, 'gmail')
    const w = await t.call('/api/automations/weekly_team_report', { method: 'PUT', as: s.admin, body: { channel: 'gmail', connectionId: c.id, emailTo: 'leads@example.com' } })
    assert.equal(w.body.config.emailTo, 'leads@example.com')
    const r = await t.call('/tasks/weekly-report', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.match(r.text, /delivered 1/)
    assert.equal(vs.runs.length, 1)
    assert.equal(vs.runs[0].input.to, 'leads@example.com')
    assert.match(vs.runs[0].input.messageBody, /Verified outcomes/)
    await t.call('/tasks/weekly-report', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.equal(vs.runs.length, 1, 'not sent twice for the same week')
    const preview = await t.call('/api/automations/weekly_team_report/preview', { method: 'POST', as: s.admin, body: {} })
    assert.match(preview.body.text, /Missed commitments/)
  } finally { await t.close() }
})

test('embed flows are recorded from viaSocket, not from the browser; disconnect pauses automations using it', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const s = seedOrg(t.db)
    vs.flows.push({ id: 'scriEmbed1', title: 'GitHub PR to evidence', status: 'active' })
    const ok = await t.call('/api/viasocket/embed-flows/scriEmbed1/sync', { method: 'POST', as: s.manager })
    assert.equal(ok.body.status, 'active')
    const gone = await t.call('/api/viasocket/embed-flows/scriFake99/sync', { method: 'POST', as: s.manager })
    assert.equal(gone.body.status, 'deleted')
    assert.deepEqual((await t.call('/api/viasocket/embed-flows', { as: s.manager })).body.map((f) => f.flowId), ['scriEmbed1'])
    const c = await connect(t, vs, s.manager, 'slack')
    await t.call('/api/automations/new_task_notification', { method: 'PUT', as: s.manager, body: { channel: 'slack', connectionId: c.id, slackChannelId: 'C123' } })
    assert.equal((await t.call(`/api/viasocket/connections/${c.id}`, { method: 'DELETE', as: s.manager2 })).status, 404)
    await t.call(`/api/viasocket/connections/${c.id}`, { method: 'DELETE', as: s.manager })
    const a = await t.call('/api/automations', { as: s.manager })
    assert.equal(a.body.automations.find((x) => x.key === 'new_task_notification').workflow.status, 'NEEDS_SETUP')
  } finally { await t.close() }
})

// Connections for task intake: each manager connects their own account (Gmail, Slack, Microsoft Teams). KONVO owns organizations, teams, users and
// permissions; viaSocket only holds the external app connection, always under the KONVO user's own id: no organization identity is invented for it.
// A stand-in with the viasocket-apps 0.19 gateway shape: these prove KONVO's own rules, they are NOT live viaSocket tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg, adminManages } from './helpers.js'

const SERVICE = { slack: 'rowbu58rc', gmail: 'rowo0bqrhj5g', microsftteams: 'rowxzmscatfe' }

function fakeVs() {
  const v = { configured: true, connections: new Map(), subscriptions: [], statuses: [], revoked: [], tokens: [], optionIds: [] }
  Object.assign(v, {
    serviceIdFor: async (slug) => SERVICE[slug], versions: async () => ({ service: { auth_type: 'Auth2.0' } }),
    token: async (id) => { v.tokens.push(id); return `embed-token-for-${id}` },
    listConnections: async (id) => v.connections.get(id) || [], revokeConnection: async (id, authId) => { v.revoked.push({ id, authId }) },
    listFlows: async () => [], listActions: async (u, app) => ({ app, serviceId: SERVICE[app], actions: [] }),
    setFlowStatus: async (id, scriptId, status) => { v.statuses.push({ id, scriptId, status }) },
    listOptions: async (id) => { v.optionIds.push(id); return { options: [{ label: '#intake', value: 'C111' }, { label: '#requests', value: 'C222' }] } },
    sampleEvent: async () => ({ text: 'Please add SSO', user: 'U5', ts: '1.1', channel: 'C111' }),
    subscribe: async (id, app, key, params) => { v.subscriptions.push({ id, app, key, params }); return { scriptId: `script${v.subscriptions.length}` } }
  })
  return v
}
const connect = async (t, vs, as, slug = 'slack') => {
  const authId = `auth_${slug}_${as.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`
  vs.connections.set(as.id, [...(vs.connections.get(as.id) || []), { id: authId, service_id: SERVICE[slug], isExpired: false }])
  const r = await t.call('/api/viasocket/connections', { method: 'POST', as, body: { app: slug, authId } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body
}

test('personal connections: isolation, team scope, permissions, duplicates, expiry and a safe disconnect', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs, cfgOverrides: { appUrl: 'https://teampulse.test' } })
  try {
    const s = seedOrg(t.db)
    const mine = await connect(t, vs, s.manager); const theirs = await connect(t, vs, s.manager2)
    const intake = (as, body) => t.call('/api/intakes', { method: 'POST', as, body })
    const body = { app: 'slack', connectionId: mine.id, target: 'C111' }
    // Employees and admins without a team cannot create intake; a manager only for teams they manage.
    assert.equal((await intake(s.employee, body)).status, 403)
    assert.equal((await intake(s.admin, body)).status, 403, 'an admin does not inherit manager authority')
    assert.equal((await intake(s.manager, { ...body, teamId: s.teamB })).status, 403, 'only a team the manager manages')
    const made = await intake(s.manager, body)
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const row = t.db.prepare('SELECT * FROM intake_subscriptions WHERE id = ?').get(made.body.id)
    assert.deepEqual({ org: row.org_id, owner: row.owner_id, conn: row.connection_id, app: row.app, team: row.team_id, trigger: row.trigger_key, version: row.version, status: row.status, events: row.events_received },
      { org: s.org.id, owner: s.manager.id, conn: mine.id, app: 'slack', team: s.teamA, trigger: 'New_Message_Posted_in_Channel_Instant', version: 'v2', status: 'ACTIVE', events: 0 })
    // An admin assigned to manage a team gets manager authority for that team only.
    adminManages(t.db, s.admin, s.leadershipTeam)
    const adminConn = await connect(t, vs, s.admin)
    assert.equal((await intake(s.admin, { app: 'slack', connectionId: adminConn.id, target: 'C111', teamId: s.teamA })).status, 403, 'not for a team the admin does not manage')
    assert.equal((await intake(s.admin, { app: 'slack', connectionId: adminConn.id, target: 'C111', teamId: s.leadershipTeam })).status, 201)
    // Duplicates: the same connection and target again is refused; another target works.
    assert.equal((await intake(s.manager, body)).body.error.code, 'intake_exists')
    assert.equal((await intake(s.manager, { ...body, target: 'C222' })).status, 201)
    // Another manager, and even an admin, can neither see nor use, reconnect or disconnect this connection or its intakes.
    assert.deepEqual((await t.call('/api/viasocket/connections', { as: s.manager2 })).body.connections.map((c) => c.id), [theirs.id])
    assert.equal((await intake(s.manager2, { app: 'slack', connectionId: mine.id, target: 'C111', teamId: s.teamB })).status, 404)
    assert.equal((await t.call(`/api/intakes/targets?app=slack&connectionId=${mine.id}`, { as: s.manager2 })).status, 404)
    assert.equal((await t.call(`/api/viasocket/connections/${mine.id}/reconnect`, { as: s.admin })).status, 404)
    assert.equal((await t.call(`/api/viasocket/connections/${mine.id}`, { method: 'DELETE', as: s.manager2 })).status, 404)
    assert.equal((await t.call('/api/intakes', { as: s.manager2 })).body.length, 0)
    assert.equal((await t.call(`/api/intakes/${made.body.id}/status`, { method: 'POST', as: s.manager2, body: { status: 'PAUSED' } })).status, 404)
    // The owner pauses and resumes.
    assert.equal((await t.call(`/api/intakes/${made.body.id}/status`, { method: 'POST', as: s.manager, body: { status: 'PAUSED' } })).status, 200)
    assert.deepEqual(vs.statuses.at(-1), { id: s.manager.id, scriptId: 'script1', status: 2 })
    assert.equal((await t.call(`/api/intakes/${made.body.id}/status`, { method: 'POST', as: s.manager, body: { status: 'ACTIVE' } })).status, 200)
    // Expiry: a clear message for the owner, and no new intake on it.
    vs.connections.get(s.manager.id)[0].isExpired = true
    const exp = await t.call(`/api/intakes/targets?app=slack&connectionId=${mine.id}`, { as: s.manager })
    assert.equal(exp.status, 409); assert.equal(exp.body.error.code, 'connection_expired'); assert.match(exp.body.error.message, /Reconnect it in the Automation Center/)
    vs.connections.get(s.manager.id)[0].isExpired = false
    // Disconnecting pauses every dependent intake before the connection is revoked and removed; history stays.
    vs.statuses.length = 0
    assert.equal((await t.call(`/api/viasocket/connections/${mine.id}`, { method: 'DELETE', as: s.manager })).status, 200)
    assert.deepEqual(vs.statuses.map((x) => [x.id, x.status]), [[s.manager.id, 2], [s.manager.id, 2]])
    assert.deepEqual(vs.revoked.map((x) => x.id), [s.manager.id])
    const rows = t.db.prepare('SELECT status, last_error FROM intake_subscriptions WHERE owner_id = ?').all(s.manager.id)
    assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.status === 'PAUSED' && /disconnected/.test(r.last_error)))
    // Architecture: KONVO owns organizations and permissions. viaSocket only ever sees a KONVO user's own id, never an invented organization identity.
    const userIds = new Set(t.db.prepare('SELECT id FROM users').all().map((u) => u.id))
    const seen = [...vs.tokens, ...vs.optionIds, ...vs.statuses.map((x) => x.id), ...vs.revoked.map((x) => x.id), ...vs.subscriptions.map((x) => x.id)]
    assert.ok(seen.length > 5 && seen.every((id) => userIds.has(id)), `every viaSocket identity is a KONVO user id (${[...new Set(seen)].filter((id) => !userIds.has(id))})`)
    const cols = t.db.prepare('PRAGMA table_info(app_connections)').all().map((c) => c.name)
    assert.ok(!cols.includes('vs_user') && !cols.includes('scope'), 'no viaSocket identity or organization scope is stored on a connection')
    assert.equal((await t.call('/api/viasocket/token?apps=slack&scope=organization', { as: s.admin })).status, 200); assert.equal(vs.tokens.at(-1), s.admin.id, 'a requested organization scope is ignored: the token is the person’s own')
  } finally { await t.close() }
})

test('Microsoft Teams on a manager’s own connection: the registry pipeline end to end, pending requests only', async () => {
  const vs = fakeVs()
  const T = '0a1b2c3d-1111-4222-8333-444455556666'; const CH = '19:abc123@thread.tacv2'
  vs.listOptions = async (id, app, key, params) => { vs.optionIds.push(id); return params.fieldKey === 'team_id' ? { options: [{ label: 'Platform Team', value: T }] } : { options: [{ label: 'task-requests', value: CH }] } }
  vs.sampleEvent = async () => ({ id: '1', messageType: 'message', from: { user: { id: '5f1e2d3c-aaaa-4bbb-8ccc-ddddeeeeffff', displayName: 'Dana' } }, body: { content: 'Investigate payment failures' }, channelIdentity: { teamId: T, channelId: CH } })
  const t = await startApp({ vs, cfgOverrides: { appUrl: 'https://teampulse.test' } })
  try {
    const s = seedOrg(t.db)
    const conn = await connect(t, vs, s.manager, 'microsftteams')
    const made = await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { app: 'teams', connectionId: conn.id, parent: T, target: CH } })
    assert.equal(made.status, 201, JSON.stringify(made.body)); assert.equal(vs.subscriptions[0].id, s.manager.id)
    const token = vs.subscriptions[0].params.code.match(/Bearer (tpe_[A-Za-z0-9_-]+)/)[1]
    const ev = { id: '2', messageType: 'message', from: { user: { id: '5f1e2d3c-aaaa-4bbb-8ccc-ddddeeeeffff', displayName: 'Dana' } }, body: { content: 'Investigate payment failures' }, channelIdentity: { teamId: T, channelId: CH } }
    const post = () => t.call(`/api/viasocket/events/${made.body.id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { event: ev } })
    assert.equal((await post()).body.status, 'created'); assert.equal((await post()).body.status, 'duplicate')
    assert.equal((await t.call('/api/requests', { as: s.manager })).body.length, 1); assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0)
    assert.equal((await t.call('/api/requests', { as: s.manager2 })).body.length, 0)
  } finally { await t.close() }
})

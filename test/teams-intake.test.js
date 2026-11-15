// Task intake source registry and Microsoft Teams. A stand-in with the viasocket-apps 0.19 gateway shape: these prove KONVO's own rules
// (the registry, parsing, idempotency, no automatic assignment, permissions, isolation); they are NOT live viaSocket or Microsoft tests.
// Trigger details used here were read from viaSocket's catalog (viasocket.catalog.versions('rowxzmscatfe')) on 2026-11-15.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { startApp, seedOrg } from './helpers.js'
import { migrate } from '../server/db.js'
import { SOURCES, SOURCE_KEYS, publicSources, parseEvent } from '../server/automations/sources/index.js'
import { parseTeams } from '../server/automations/sources/teams.js'

const TEAM = '0a1b2c3d-1111-4222-8333-444455556666'
const CHANNEL = '19:abc123@thread.tacv2'
const AAD = '5f1e2d3c-aaaa-4bbb-8ccc-ddddeeeeffff'
const msg = (over = {}) => ({
  id: '1700000000001', messageType: 'message', createdDateTime: '2026-11-15T10:00:00Z',
  from: { user: { id: AAD, displayName: 'Dana Director' } },
  body: { contentType: 'text', content: 'Please investigate the payment failures before Friday' },
  channelIdentity: { teamId: TEAM, channelId: CHANNEL }, mentions: [], webUrl: 'https://teams.microsoft.com/l/message/x', ...over
})

test('registry: Gmail, Slack and Teams are registered; Gmail and Slack keep their exact triggers; Teams uses the catalog values', () => {
  assert.deepEqual(SOURCE_KEYS, ['gmail', 'slack', 'teams'])
  assert.deepEqual(SOURCES.gmail.trigger, { key: 'New_Email_Arrives', version: 'v11', triggerId: 'row9ls2itxoc' })
  assert.deepEqual(SOURCES.slack.trigger, { key: 'New_Message_Posted_in_Channel_Instant', version: 'v2', triggerId: 'rowo0opjzsgk' })
  assert.deepEqual(SOURCES.teams.trigger, { key: 'New_Channel_Message', version: 'v2', triggerId: 'rowsfn4nr5vx' })
  assert.equal(SOURCES.teams.slug, 'microsftteams')
  for (const k of SOURCE_KEYS) assert.equal(SOURCES[k].kind, 'communication', `${k} is a communication source`)
  assert.equal(SOURCES.slack.supportsMentionAssign, true); assert.equal(SOURCES.teams.supportsMentionAssign, false); assert.equal(SOURCES.gmail.supportsMentionAssign, false)
  const pub = JSON.stringify(publicSources())
  assert.ok(!/rowsfn4nr5vx|row9ls2itxoc|rowo0opjzsgk|New_Channel_Message/.test(pub), 'the UI list carries no trigger ids')
  assert.equal(publicSources().find((x) => x.app === 'teams').parentNoun, 'Team')
  assert.ok(!SOURCE_KEYS.some((k) => /jira|asana|trello|linear|clickup/.test(k)), 'work-management tools are not registered as chat sources')
})

test('Teams parser: plain text, HTML, mentions and the normalized shape', () => {
  const plain = parseEvent('teams', msg())
  assert.equal(plain.title, 'Please investigate the payment failures before Friday'); assert.equal(plain.requester, 'Dana Director')
  assert.equal(plain.externalRef, `teams:${TEAM}:${CHANNEL}:1700000000001`); assert.deepEqual(plain.missing, []); assert.equal(plain.ignore, null)
  assert.equal(plain.senderId, AAD); assert.equal(plain.permalink, 'https://teams.microsoft.com/l/message/x')
  const html = parseTeams(msg({ body: { contentType: 'html', content: '<p>Hi <at id="0">Eve</at>, fix the <b>export</b> &amp; report</p><script>alert(1)</script>' }, mentions: [{ id: 0, mentionText: 'Eve', mentioned: { user: { id: AAD, displayName: 'Eve' } } }, { mentioned: { user: { id: 'not-a-guid' } } }] }))
  assert.equal(html.title, 'Hi Eve, fix the export & report'); assert.ok(!html.description.includes('<') && !html.description.includes('alert'))
  assert.deepEqual(html.mentions, [AAD], 'only well-formed Azure AD ids are kept')
  assert.equal(parseTeams(msg({ webUrl: 'https://evil.example/l/message/x' })).permalink, null, 'a link outside Microsoft Teams is dropped')
})

test('Teams parser: what is ignored, and what cannot be imported safely', () => {
  const why = (over) => parseTeams(msg(over)).ignore
  assert.equal(why({ messageType: 'systemEventMessage' }), 'a system message')
  assert.equal(why({ deletedDateTime: '2026-11-15T11:00:00Z' }), 'a deleted message')
  assert.equal(why({ replyToId: '1699999999999' }), 'a thread reply')
  assert.equal(why({ from: { application: { id: 'app1', displayName: 'Jenkins' } } }), 'posted by an app or bot')
  assert.equal(why({ body: { contentType: 'text', content: 'New task for you\n\nSent by KONVO' } }), 'sent by KONVO')
  assert.equal(why({ body: { contentType: 'text', content: 'New task for you\n\nSent by TeamPulse' } }), 'sent by KONVO', 'former product name too')
  const noId = parseTeams(msg({ id: undefined })); assert.equal(noId.externalRef, null); assert.deepEqual(noId.missing, ['message id'])
  const empty = parseTeams(msg({ body: { content: '' } })); assert.equal(empty.title, null); assert.ok(empty.missing.includes('message text'))
  // The subscription's own team and channel stand in when an event does not carry channelIdentity.
  const scoped = parseTeams(msg({ channelIdentity: undefined }), { scope: { team_id: [TEAM], channel_id: [CHANNEL] } })
  assert.equal(scoped.externalRef, `teams:${TEAM}:${CHANNEL}:1700000000001`)
  assert.deepEqual(parseTeams(msg({ channelIdentity: undefined })).missing, ['team or channel'])
  // The existing sources still parse as before through the registry.
  assert.equal(parseEvent('slack', { text: 'Please add SSO', ts: '1.1', channel: 'C1' }).externalRef, 'slack:C1:1.1')
  assert.equal(parseEvent('gmail', { id: 'g1', subject: 'S', snippet: 'b' }, { account: 'acct-x' }).externalRef, 'gmail:acct-x:g1')
})

// ---- the pipeline through the app, with a viaSocket stand-in
const SERVICE = { microsftteams: 'rowxzmscatfe', slack: 'rowbu58rc', gmail: 'rowo0bqrhj5g' }
function fakeVs() {
  const v = { configured: true, connections: new Map(), subscriptions: [], statuses: [], optionCalls: [] }
  Object.assign(v, {
    serviceIdFor: async (slug) => SERVICE[slug],
    versions: async () => ({ service: { auth_type: 'Auth2.0' } }),
    listConnections: async (userId) => v.connections.get(userId) || [],
    listFlows: async () => [], revokeConnection: async () => ({}), listActions: async (u, app) => ({ app, serviceId: SERVICE[app], actions: [] }),
    setFlowStatus: async (userId, scriptId, status) => { v.statuses.push({ userId, scriptId, status }) },
    listOptions: async (userId, app, key, params) => {
      v.optionCalls.push({ app, key, ...params })
      if (params.fieldKey === 'team_id') return { options: [{ label: 'Platform Team', value: TEAM }, { label: 'Sales Team', value: 'team-sales' }] }
      if (params.fieldKey === 'channel_id') return { options: String(params.existingFields?.team_id) === TEAM ? [{ label: 'task-requests', value: CHANNEL }, { label: 'General', value: '19:general@thread.tacv2' }] : [] }
      return { options: [] }
    },
    sampleEvent: async () => msg(),
    subscribe: async (userId, app, key, params) => { v.subscriptions.push({ userId, app, key, params }); return { scriptId: `scriteams${v.subscriptions.length}` } }
  })
  return v
}
async function connectTeams(t, vs, user) {
  const authId = `auth_teams_${user.id.slice(0, 6)}`
  vs.connections.set(user.id, [{ id: authId, service_id: SERVICE.microsftteams, isExpired: false }])
  const r = await t.call('/api/viasocket/connections', { method: 'POST', as: user, body: { app: 'microsftteams', authId } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body
}

test('Teams intake: connect, pick a Team then a channel from live options, switch on; events become pending requests only', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs, cfgOverrides: { appUrl: 'https://teampulse.test' } })
  try {
    const s = seedOrg(t.db)
    const conn = await connectTeams(t, vs, s.manager)
    // The source list and the pickers: Teams first, then that Team's channels.
    assert.ok((await t.call('/api/intakes/sources', { as: s.manager })).body.some((x) => x.app === 'teams'))
    assert.equal((await t.call('/api/intakes/sources', { as: s.employee })).status, 403)
    const teams = await t.call(`/api/intakes/targets?app=teams&connectionId=${conn.id}`, { as: s.manager })
    assert.deepEqual(teams.body.options.map((o) => o.label), ['Platform Team', 'Sales Team'])
    const channels = await t.call(`/api/intakes/targets?app=teams&connectionId=${conn.id}&parent=${TEAM}`, { as: s.manager })
    assert.deepEqual(channels.body.options.map((o) => o.label), ['task-requests', 'General'])
    assert.deepEqual(vs.optionCalls.at(-1).existingFields, { team_id: [TEAM] }, 'channels are listed for the chosen team only')
    // Only the manager (not an employee), only live options, only the user's own connection.
    const body = { app: 'teams', connectionId: conn.id, parent: TEAM, target: CHANNEL }
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.employee, body })).status, 403)
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { ...body, target: '19:typed@thread.tacv2' } })).status, 400, 'a typed channel id is refused')
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { ...body, parent: 'team-typed' } })).status, 400, 'a typed team id is refused')
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { app: 'teams', connectionId: conn.id, target: CHANNEL } })).status, 400, 'the Team is required')
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager2, body })).status >= 400, true, 'another manager cannot use this connection')
    const made = await t.call('/api/intakes', { method: 'POST', as: s.manager, body: { ...body, assignFromMentions: true } })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.equal(made.body.assignFromMentions, false, 'Teams never assigns from mentions')
    assert.equal(made.body.source, 'Microsoft Teams'); assert.equal(made.body.target, 'Platform Team › task-requests')
    const sub = vs.subscriptions[0]
    assert.equal(sub.app, 'microsftteams'); assert.equal(sub.key, 'New_Channel_Message'); assert.equal(sub.params.version, 'v2')
    assert.deepEqual(sub.params.inputData, { team_id: [TEAM], channel_id: [CHANNEL] })
    assert.equal((await t.call('/api/intakes', { method: 'POST', as: s.manager, body })).body.error.code, 'intake_exists', 'one intake per channel')
    assert.equal((await t.call(`/api/intakes/${made.body.id}/mode`, { method: 'POST', as: s.manager, body: { assignFromMentions: true } })).status, 400, 'the mention mode is refused for Teams')
    // Events: bearer token per subscription, idempotent, ignores bots, replies and its own messages; never a task.
    const token = sub.params.code.match(/Bearer (tpe_[A-Za-z0-9_-]+)/)[1]
    const post = (id, tok, event) => t.call(`/api/viasocket/events/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: { event } })
    assert.equal((await post(made.body.id, 'tpe_wrong', msg())).status, 401)
    assert.equal((await post(made.body.id, token, msg())).body.status, 'created')
    assert.equal((await post(made.body.id, token, msg())).body.status, 'duplicate', 'the same event again is not a second request')
    assert.equal((await post(made.body.id, token, msg({ id: '2', replyToId: '1' }))).body.status, 'ignored')
    assert.equal((await post(made.body.id, token, msg({ id: '3', from: { application: { id: 'a', displayName: 'Bot' } } }))).body.status, 'ignored')
    assert.equal((await post(made.body.id, token, msg({ id: '4', body: { content: 'Hi\n\nSent by KONVO' } }))).body.status, 'ignored')
    assert.equal((await post(made.body.id, token, msg({ id: undefined }))).body.status, 'ignored', 'no stable message id: nothing is imported')
    assert.match(t.db.prepare('SELECT last_error FROM intake_subscriptions WHERE id = ?').get(made.body.id).last_error, /no message id/)
    const reqs = (await t.call('/api/requests', { as: s.manager })).body
    assert.equal(reqs.length, 1); assert.equal(reqs[0].status, 'PENDING'); assert.equal(reqs[0].suggestedAssigneeId, null); assert.equal(reqs[0].teamId, s.teamA)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'nothing is assigned or approved from a Teams message')
    // Isolation: another team's manager sees neither the intake nor the request; the other organization's admin neither.
    assert.equal((await t.call('/api/requests', { as: s.manager2 })).body.length, 0)
    assert.equal((await t.call('/api/intakes', { as: s.manager2 })).body.length, 0)
    assert.equal((await t.call('/api/intakes', { as: s.otherAdmin })).status >= 400 || (await t.call('/api/intakes', { as: s.otherAdmin })).body.length === 0, true)
    // Pause stops intake.
    await t.call(`/api/intakes/${made.body.id}/status`, { method: 'POST', as: s.manager, body: { status: 'PAUSED' } })
    assert.deepEqual(vs.statuses.at(-1), { userId: s.manager.id, scriptId: 'scriteams1', status: 2 })
    assert.equal((await post(made.body.id, token, msg({ id: '9' }))).body.status, 'ignored')
    // Only the request text and its reference are kept for a Teams message; ignored messages leave no text behind.
    const stored = JSON.stringify(t.db.prepare('SELECT * FROM automation_execution_logs').all())
    assert.ok(!stored.includes('replyToId') && !stored.includes('Sent by KONVO'), 'ignored message text is not stored in the run log')
  } finally { await t.close() }
})

test('migration 012 keeps every intake subscription and accepts Teams', () => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON')
  // Bring a database to migration 011 exactly as production would be, with one Slack and one Gmail intake, then apply only 012.
  const dir = new URL('../server/migrations/', import.meta.url)
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  for (const f of files.filter((x) => x < '012')) {
    const sql = readFileSync(new URL(f, dir), 'utf8'); const off = sql.startsWith('-- foreign_keys: off')
    if (off) db.exec('PRAGMA foreign_keys = OFF'); db.exec('BEGIN'); db.exec(sql); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, 'x'); db.exec('COMMIT'); if (off) db.exec('PRAGMA foreign_keys = ON')
  }
  const T = 'now'
  db.exec(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('u1', 'a@x.com', 'A', '${T}', '${T}')`)
  db.exec(`INSERT INTO organizations (id, name, join_code, created_at, updated_at) VALUES ('o1', 'Org', 'J', '${T}', '${T}')`)
  for (const [id, app] of [['i1', 'slack'], ['i2', 'gmail']]) db.exec(`INSERT INTO intake_subscriptions (id, org_id, owner_id, app, trigger_key, version, input_data, target_label, token_hash, status, events_received, assign_from_mentions, created_at, updated_at) VALUES ('${id}', 'o1', 'u1', '${app}', 'k', 'v1', '{"a":1}', 'label-${app}', 'hash-${id}', 'ACTIVE', 7, ${app === 'slack' ? 1 : 0}, '${T}', '${T}')`)
  db.exec(`INSERT INTO slack_intake_items (id, org_id, subscription_id, external_ref, channel_id, message_ts, outcome, created_at) VALUES ('s1', 'o1', 'i1', 'slack:C1:1.1', 'C1', '1.1', 'IGNORED', '${T}')`)
  assert.throws(() => db.exec(`INSERT INTO intake_subscriptions (id, org_id, owner_id, app, trigger_key, version, token_hash, status, created_at, updated_at) VALUES ('x', 'o1', 'u1', 'teams', 'k', 'v1', 'h', 'ACTIVE', '${T}', '${T}')`), 'Teams is not allowed before 012')
  assert.deepEqual(migrate(db), ['012_intake_sources.sql'])
  const rows = db.prepare('SELECT id, app, target_label, events_received, assign_from_mentions, input_data, token_hash FROM intake_subscriptions ORDER BY id').all().map((r) => ({ ...r }))
  assert.deepEqual(rows, [
    { id: 'i1', app: 'slack', target_label: 'label-slack', events_received: 7, assign_from_mentions: 1, input_data: '{"a":1}', token_hash: 'hash-i1' },
    { id: 'i2', app: 'gmail', target_label: 'label-gmail', events_received: 7, assign_from_mentions: 0, input_data: '{"a":1}', token_hash: 'hash-i2' }
  ])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM slack_intake_items WHERE subscription_id = ?').get('i1').n, 1, 'Slack intake items still point at their intake')
  db.exec(`INSERT INTO intake_subscriptions (id, org_id, owner_id, app, trigger_key, version, token_hash, status, created_at, updated_at) VALUES ('t1', 'o1', 'u1', 'teams', 'New_Channel_Message', 'v2', 'h', 'ACTIVE', '${T}', '${T}')`)
  assert.throws(() => db.exec(`INSERT INTO intake_subscriptions (id, org_id, owner_id, app, trigger_key, version, token_hash, status, created_at, updated_at) VALUES ('y', 'o1', 'u1', 'jira', 'k', 'v1', 'h2', 'ACTIVE', '${T}', '${T}')`), 'unknown sources are still refused by the database')
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})

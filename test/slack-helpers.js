// Shared fixtures for the Slack intake / acceptance / escalation tests: an organization with confirmed Slack mappings, a
// Slack intake subscription that assigns from mentions (no live Slack or viaSocket: events are posted the way viaSocket's
// handler would), and a stand-in M91 transport. Nothing here talks to a real service.
import { startApp, seedOrg } from './helpers.js'
import { uuid, now } from '../server/db.js'
import { sha256 } from '../server/auth/sessions.js'

export const H = 3600000
export const iso = (ms) => new Date(ms).toISOString()
export const CH = 'C0TEST0001'
export const WS = 'T0ACME0001'
export const SLACK = { eve: 'U0EVE00001', ed: 'U0ED000002', olly: 'U0OLLY0003', dana: 'U0DANA0004', ghost: 'U0GHOST005', mona: 'U0MONA0006' }

/** A stand-in M91 transport: records sends and closes; fails on demand. */
export function fakeM91({ failTimes = 0, retryable = true } = {}) {
  const m = { sent: [], closed: [], fails: failTimes }
  return Object.assign(m, {
    name: 'm91', configured: true, ready: true,
    status: () => ({ state: 'ready', message: 'fake' }),
    async send(msg) {
      if (m.fails > 0) { m.fails--; const e = new Error('provider 503'); e.retryable = retryable; throw e }
      m.sent.push(msg); return { providerMessageId: `msg-${m.sent.length}` }
    },
    async getAlert() { return { status: 'OPEN' } },
    async close(args) { m.closed.push(args); return { closed: true } }
  })
}

/** A Slack intake that assigns from @mentions, owned by `owner` (default: the team manager). */
export function addIntake(t, s, { assign = true, owner = s.manager, teamId = s.teamA } = {}) {
  const id = uuid()
  const token = `tpe_${id}`
  const ts = now()
  t.db.prepare(`INSERT INTO intake_subscriptions (id, org_id, owner_id, team_id, app, trigger_key, version, input_data, target_label, token_hash, status, assign_from_mentions, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'slack', 'New_Message_Posted_in_Channel_Instant', 'v2', '{}', '#teampulse-task-testing', ?, 'ACTIVE', ?, ?, ?)`).run(id, s.org.id, owner.id, teamId, sha256(token), assign ? 1 : 0, ts, ts)
  return { id, token }
}

let counter = 0
/** Posts one Slack message to an intake exactly as viaSocket's handler would. */
export function post(t, sub, { text, user = SLACK.dana, userName = 'Dana Director', ts, thread_ts, bot = false, extra = {} }) {
  counter++
  const event = { text, user, user_name: userName, ts: ts ?? `${Math.floor(Date.now() / 1000)}.${String(100000 + counter)}`, channel: CH, team: WS, ...(thread_ts ? { thread_ts } : {}), ...(bot ? { bot_id: 'B0BOT00001' } : {}), ...extra }
  return t.call(`/api/viasocket/events/${sub.id}`, { method: 'POST', headers: { Authorization: `Bearer ${sub.token}` }, body: { event } })
}

/** An organization with the manager's confirmed Slack mappings for Eve and Ed, an admin-confirmed one for Olly (another team). */
export async function setup({ m91, assign = true, cfgOverrides } = {}) {
  const t = await startApp({ m91, cfgOverrides })
  const s = seedOrg(t.db)
  const map = async (as, who, slackUserId) => { const r = await t.call('/api/slack-identities', { method: 'POST', as, body: { userId: who.id, slackUserId, workspaceId: WS } }); if (r.status !== 201) throw new Error(`mapping failed: ${r.status} ${JSON.stringify(r.body)}`) }
  await map(s.manager, s.employee, SLACK.eve)
  await map(s.manager, s.employee2, SLACK.ed)
  await map(s.admin, s.outsider, SLACK.olly)
  return { t, s, sub: addIntake(t, s, { assign }) }
}

/** node:sqlite rows have a null prototype; copy them so strict deep-equal against plain objects works. */
export const plain = (rows) => rows.map((r) => ({ ...r }))
export const tag = (id) => `<@${id}>`
export const taskOf = (t, id) => t.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
export const counts = (t) => ({ tasks: t.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, requests: t.db.prepare('SELECT COUNT(*) AS n FROM task_requests').get().n })

/** A Slack task assigned to Eve, optionally accepted. Returns { taskId }. */
export async function slackTask(t, s, sub, { text, accept = false, ts } = {}) {
  const r = await post(t, sub, { text: text ?? `${tag(SLACK.eve)} please investigate the payment failure issue and fix it`, ts })
  if (r.body.status !== 'created') throw new Error(`task not created: ${JSON.stringify(r.body)}`)
  await t.settled()
  if (accept) { const a = await t.call(`/api/tasks/${r.body.taskId}/accept`, { method: 'POST', as: s.employee }); if (a.status !== 200) throw new Error(`accept failed: ${JSON.stringify(a.body)}`) }
  await t.settled()
  return { taskId: r.body.taskId }
}

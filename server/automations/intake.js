// C. Gmail / Slack intake → PENDING task requests.
// A manager subscribes their own Gmail (a label) or Slack (one channel) with viaSocket's trigger; the handler runs on
// viaSocket and posts each event to TeamPulse with a bearer token for that one subscription (only its hash is stored).
// Each event becomes at most one pending task request (idempotent by message id). Nothing is ever assigned or approved.
// https://viasocket.com/docs/skill/actions-and-events.md?format=sdk — "Events"
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { now, uuid, json } from '../db.js'
import { AppError, conflict, invalid, notFound, forbidden } from '../errors.js'
import { isAdmin, requireManager } from '../access.js'
import { audit } from '../services/audit.js'
import { createExternalRequest } from '../services/requests.js'
import { requireActiveConnection, pickOptions, MARKER } from '../integrations/actions.js'
import { requireViasocket, viasocketError } from '../integrations/errors.js'
import { startLog, finishLog } from './engine.js'
import * as v from '../validate.js'
import { extractMentions, processSlackTask } from './slack-tasks.js'

// Keys, versions and trigger ids from the trigger pages, confirmed with user.listActions() on 2026-11-09.
export const TRIGGERS = {
  gmail: { slug: 'gmail', app: 'Gmail', key: 'New_Email_Arrives', version: 'v11', triggerId: 'row9ls2itxoc', pickField: 'searchFields.label', pickExisting: { thread: 'first_email_only', query: ['label'] } },
  slack: { slug: 'slack', app: 'Slack', key: 'New_Message_Posted_in_Channel_Instant', version: 'v2', triggerId: 'rowo0opjzsgk', pickField: 'channel_id', pickExisting: {} }
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex')

/** The choices for one intake: the user's Gmail labels or Slack channels, live from their own connection. */
export async function intakeTargets(db, vs, ctx, app, connectionId, { search } = {}) {
  requireManager(ctx)
  const t = TRIGGERS[app]
  if (!t) throw invalid('Choose Gmail or Slack.')
  return pickOptions(db, vs, ctx, connectionId, { slug: t.slug, app: t.app, eventKey: t.key, version: t.version, fieldKey: t.pickField, existingFields: t.pickExisting, search })
}

function inputFor(app, target) {
  return app === 'gmail'
    ? { thread: 'first_email_only', query: ['label'], searchFields: { label: [target] } }
    : { channel_id: [target] }
}

function present(db, r) {
  const outcomes = r.app === 'slack' ? Object.fromEntries(db.prepare('SELECT outcome, COUNT(*) AS n FROM slack_intake_items WHERE subscription_id = ? GROUP BY outcome').all(r.id).map((o) => [o.outcome, o.n])) : {}
  return {
    assignFromMentions: Boolean(r.assign_from_mentions), tasksCreated: outcomes.TASK_CREATED || 0, needManager: outcomes.NEEDS_MANAGER || 0, ignored: outcomes.IGNORED || 0,
    id: r.id, app: r.app, target: r.target_label, status: r.status, teamId: r.team_id,
    teamName: r.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(r.team_id)?.name ?? null : null,
    ownerName: db.prepare('SELECT name FROM users WHERE id = ?').get(r.owner_id)?.name, mine: undefined,
    eventsReceived: r.events_received, lastEventAt: r.last_event_at, lastError: r.last_error, createdAt: r.created_at
  }
}

export function listIntakes(db, ctx) {
  requireManager(ctx)
  const rows = isAdmin(ctx)
    ? db.prepare(`SELECT * FROM intake_subscriptions WHERE org_id = ? AND status != 'DELETED' ORDER BY created_at DESC`).all(ctx.orgId)
    : db.prepare(`SELECT * FROM intake_subscriptions WHERE org_id = ? AND owner_id = ? AND status != 'DELETED' ORDER BY created_at DESC`).all(ctx.orgId, ctx.user.id)
  return rows.map((r) => ({ ...present(db, r), mine: r.owner_id === ctx.user.id }))
}

/** Outgoing TeamPulse posts must never land in an intake channel: refuse a Slack intake on a channel we post to. */
function assertNotOutbound(db, orgId, channelId) {
  const used = db.prepare(`SELECT config FROM automation_workflows WHERE org_id = ? AND status != 'PAUSED'`).all(orgId).some((w) => json(w.config, {}).slackChannelId === channelId)
    || db.prepare(`SELECT 1 FROM notification_prefs WHERE org_id = ? AND channel = 'slack' AND slack_mode = 'channel' AND slack_target = ?`).get(orgId, channelId)
  if (used) throw conflict('TeamPulse already posts notifications or reports to that channel; using it for intake would turn them into new requests. Choose a separate intake channel.', 'intake_loop')
}

/**
 * Creates the viaSocket subscription on the manager's own connection. body: { app, connectionId, target, targetLabel, teamId }.
 * The target must be one of the live options (a Gmail label / Slack channel id), never a typed id.
 */
export async function createIntake(db, vs, ctx, body, { appUrl }) {
  requireManager(ctx)
  requireViasocket(vs)
  if (!/^https:\/\//.test(appUrl || '')) throw new AppError(409, 'needs_public_url', 'Intake needs the app’s public https address (APP_URL), so viaSocket can deliver events to it.')
  const app = v.oneOf(body?.app, 'App', ['GMAIL', 'SLACK'], { required: true }).toLowerCase()
  const t = TRIGGERS[app]
  const conn = await requireActiveConnection(db, vs, ctx, body?.connectionId, t)
  const target = v.text(body?.target, app === 'gmail' ? 'Gmail label' : 'Slack channel', { required: true, max: 120 })
  const { options } = await intakeTargets(db, vs, ctx, app, conn.id)
  const hit = options.find((o) => o.value === target)
  if (!hit) throw invalid(app === 'gmail' ? 'Choose one of your Gmail labels.' : 'Choose one of your Slack channels.')
  if (app === 'slack') assertNotOutbound(db, ctx.orgId, target)
  let teamId = v.id(body?.teamId, 'Team') || (ctx.role === 'manager' ? ctx.managedTeamIds[0] : ctx.teamId) || null
  if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(teamId, ctx.orgId)) throw notFound('Team')
  if (teamId && ctx.role === 'manager' && !ctx.managedTeamIds.includes(teamId)) throw forbidden('Requests can go only to a team you manage.')
  const inputData = inputFor(app, target)
  // Mapping is only trusted once it has read a real message from this exact label/channel (sampleEvent).
  let sample
  try {
    const authType = (await vs.versions(conn.service_id))?.service?.auth_type || 'Auth2.0'
    sample = await vs.sampleEvent(t.triggerId, conn.auth_id, authType, inputData)
  } catch (error) {
    throw viasocketError(error, `read a sample ${t.app} message`)
  }
  const mapped = parseEvent(app, sample)
  console.log(`[intake] ${app} sample before switch-on: keys ${keyPaths(sample).slice(0, 40).join(', ')}; ${mapped.title && mapped.externalRef ? 'mapped' : 'NOT mapped'}`)
  if (!sample || !Object.keys(sample).length) throw new AppError(409, 'no_sample', `No message found in that ${app === 'gmail' ? 'label' : 'channel'} yet. Send one test message there, then switch the intake on.`)
  if (!mapped.title || !mapped.externalRef) throw new AppError(409, 'unmapped_sample', `TeamPulse could not read a title and a message id from the latest ${t.app} message, so the intake was not switched on. Fields seen: ${keyPaths(sample).slice(0, 15).join(', ')}.`)
  const dup = db.prepare(`SELECT 1 FROM intake_subscriptions WHERE org_id = ? AND owner_id = ? AND app = ? AND status IN ('ACTIVE','PAUSED') AND input_data = ?`).get(ctx.orgId, ctx.user.id, app, JSON.stringify(inputData))
  if (dup) throw conflict('You already have an intake on that label or channel.', 'intake_exists')

  // Only a Slack channel can assign from @mentions; it is opt-in so existing intakes keep creating requests.
  const assignFromMentions = app === 'slack' && body?.assignFromMentions === true ? 1 : 0
  const id = uuid()
  const token = `tpe_${randomBytes(24).toString('base64url')}`
  const url = `${appUrl}/api/viasocket/events/${id}`
  // Runs on viaSocket once per event: forwards the event, authenticated for this one subscription.
  const handler = `const res = await axios.post(${JSON.stringify(url)}, { event: context.req.body }, { headers: { authorization: ${JSON.stringify(`Bearer ${token}`)} } })
return res.data`
  let sub
  try {
    sub = await vs.subscribe(ctx.user.id, t.slug, t.key, { authId: conn.auth_id, inputData, version: t.version, code: handler, description: `TeamPulse intake: ${hit.label} → task requests` })
  } catch (error) {
    throw viasocketError(error, `switch on the ${t.app} intake`)
  }
  console.log(`[viasocket] subscribed ${t.slug} ${t.key} ${t.version} for user ${ctx.user.id} (intake ${id})`)
  const ts = now()
  db.prepare(`INSERT INTO intake_subscriptions (id, org_id, owner_id, team_id, app, connection_id, trigger_key, version, script_id, input_data, target_label, token_hash, status, assign_from_mentions, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`)
    .run(id, ctx.orgId, ctx.user.id, teamId, app, conn.id, t.key, t.version, sub.scriptId, JSON.stringify(inputData), hit.label, sha(token), assignFromMentions, ts, ts)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'intake.created', entityType: 'intake_subscription', entityId: id, after: { app, target: hit.label, teamId, assignFromMentions: Boolean(assignFromMentions) } })
  return { ...present(db, db.prepare('SELECT * FROM intake_subscriptions WHERE id = ?').get(id)), mine: true }
}

/** Switch a Slack intake between "pending requests" and "tasks for the tagged person". Only its owner (or an admin). */
export function setIntakeMode(db, ctx, id, body) {
  requireManager(ctx)
  const r = requireOwnIntake(db, ctx, id)
  if (r.app !== 'slack') throw invalid('Only a Slack intake can assign from mentions.')
  const on = v.bool(body?.assignFromMentions, 'Assign from mentions')
  db.prepare('UPDATE intake_subscriptions SET assign_from_mentions = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, now(), r.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'intake.mode_changed', entityType: 'intake_subscription', entityId: r.id, before: { assignFromMentions: Boolean(r.assign_from_mentions) }, after: { assignFromMentions: on } })
  return { assignFromMentions: on }
}

function requireOwnIntake(db, ctx, id) {
  const r = db.prepare(`SELECT * FROM intake_subscriptions WHERE id = ? AND org_id = ? AND status != 'DELETED'`).get(v.id(id, 'Intake', { required: true }), ctx.orgId)
  if (!r || (r.owner_id !== ctx.user.id && !isAdmin(ctx))) throw notFound('Intake')
  return r
}

/** Pause (2), resume (1) or remove (0) the subscription on viaSocket, then here. Admins may pause anyone's. */
export async function setIntakeStatus(db, vs, ctx, id, body) {
  requireManager(ctx)
  const r = requireOwnIntake(db, ctx, id)
  const to = v.oneOf(body?.status, 'Status', ['ACTIVE', 'PAUSED', 'DELETED'], { required: true })
  if (to === 'ACTIVE' && r.owner_id !== ctx.user.id) throw forbidden('Only its owner can resume an intake.')
  if (r.script_id) {
    try { await vs.setFlowStatus(r.owner_id, r.script_id, to === 'ACTIVE' ? 1 : to === 'PAUSED' ? 2 : 0) } catch (error) { throw viasocketError(error, 'change the intake') }
  }
  db.prepare('UPDATE intake_subscriptions SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(to, now(), r.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `intake.${to.toLowerCase()}`, entityType: 'intake_subscription', entityId: r.id, before: { status: r.status } })
  return { status: to }
}

/** A real sample event for the chosen label/channel, from viaSocket (no side effects): what a request would look like. */
export async function sampleIntake(db, vs, ctx, body) {
  requireManager(ctx)
  const app = v.oneOf(body?.app, 'App', ['GMAIL', 'SLACK'], { required: true }).toLowerCase()
  const t = TRIGGERS[app]
  const conn = await requireActiveConnection(db, vs, ctx, body?.connectionId, t)
  const target = v.text(body?.target, 'Target', { required: true, max: 120 })
  let event
  try {
    const authType = (await vs.versions(conn.service_id))?.service?.auth_type || 'Auth2.0'
    event = await vs.sampleEvent(t.triggerId, conn.auth_id, authType, inputFor(app, target))
  } catch (error) {
    throw viasocketError(error, `read a sample ${t.app} event`)
  }
  // Key paths only go to the log (never values): enough to check the mapping against the real shape.
  console.log(`[intake] ${app} sample keys: ${keyPaths(event).slice(0, 60).join(', ')}`)
  const parsed = parseEvent(app, event)
  return { found: Boolean(event && Object.keys(event).length), preview: parsed, keys: keyPaths(event).slice(0, 60) }
}

function keyPaths(o, prefix = '', out = [], depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return out
  for (const [k, val] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k
    out.push(p)
    if (val && typeof val === 'object' && !Array.isArray(val)) keyPaths(val, p, out, depth + 1)
  }
  return out
}

const first = (...vals) => vals.find((x) => typeof x === 'string' && x.trim())?.trim() ?? null
const header = (headers, name) => (Array.isArray(headers) ? headers.find((h) => String(h?.name).toLowerCase() === name)?.value : null)
const unwrapEvent = (e) => (e && typeof e === 'object' && e.event && typeof e.event === 'object' && !e.subject && !e.text ? e.event : e)

/** Maps a Gmail or Slack event to a request: { title, description, requester, externalRef, ignore? }. */
export function parseEvent(app, raw, { threads = false } = {}) {
  const e = unwrapEvent(Array.isArray(raw) ? raw[0] : raw) || {}
  if (app === 'gmail') {
    const h = e.payload?.headers
    const subject = first(e.subject, e.Subject, header(h, 'subject'))
    const from = first(e.from, e.From, e.sender, e.senderEmail, header(h, 'from'))
    const body = first(e.textPlain, e.text, e.body, e.plainBody, e.bodyText, e.snippet, e.textHtml?.replace?.(/<[^>]+>/g, ' '))
    const id = first(e.messageId, e.message_id, e.id, header(h, 'message-id'))
    const ownMessage = (body || '').includes(MARKER) || /\bTeamPulse\b/.test(from || '')
    return { title: subject || (body ? body.split('\n')[0].slice(0, 120) : null), description: body ? body.slice(0, 4000) : null, requester: from, externalRef: id ? `gmail:${id}` : null, ignore: ownMessage ? 'sent by TeamPulse' : null }
  }
  const text = first(e.text, e.message?.text)
  const bot = Boolean(e.bot_id || e.bot_profile || e.subtype === 'bot_message' || e.message?.bot_id)
  const ts = first(e.ts, e.event_ts, e.message?.ts)
  const channel = first(e.channel, e.channel_id, e.message?.channel)
  const ownMessage = (text || '').includes(MARKER)
  const senderId = first(e.user, e.user_id, e.message?.user)
  const teamId = first(e.team, e.team_id, e.user_team, e.message?.team)
  const permalink = first(e.permalink, e.message?.permalink)
  const threadTs = first(e.thread_ts, e.message?.thread_ts)
  return {
    title: text ? text.split('\n')[0].replace(/[*_`]/g, '').slice(0, 120) : null, description: text ? text.slice(0, 4000) : null,
    requester: first(e.user_name, e.username, e.user_profile?.real_name, e.user), externalRef: ts ? `slack:${channel || ''}:${ts}` : null,
    // Task-from-mention intakes also read thread replies (a reply can carry the real request); requests ignore them as before.
    ignore: ownMessage ? 'sent by TeamPulse' : bot ? 'posted by a bot' : !threads && e.thread_ts && e.thread_ts !== e.ts ? 'a thread reply' : null,
    text, mentions: extractMentions(text), senderId: senderId && /^[UW][A-Z0-9]{6,20}$/.test(senderId) ? senderId : null, ts, threadTs, channel,
    teamId: teamId && /^[A-Z0-9]{6,20}$/.test(teamId) ? teamId : null,
    permalink: permalink && /^https:\/\/([a-z0-9-]+\.)*slack\.com\//i.test(permalink) ? permalink : null
  }
}

/** POST /api/viasocket/events/:id — one event from viaSocket. Answers 2xx for anything handled, so it is not retried. */
export function receiveIntakeEvent(db, id, bearer, body) {
  const r = typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? db.prepare('SELECT * FROM intake_subscriptions WHERE id = ?').get(id) : null
  const given = Buffer.from(sha(String(bearer || '')))
  if (!r || !bearer || !timingSafeEqual(given, Buffer.from(r.token_hash))) throw new AppError(401, 'unauthorized', 'Unauthorized')
  if (r.status !== 'ACTIVE') return { status: 'ignored', reason: 'intake paused' }
  const assigning = r.app === 'slack' && r.assign_from_mentions === 1
  const parsed = parseEvent(r.app, body?.event ?? body, { threads: assigning })
  console.log(`[intake] ${r.app} event for intake ${r.id}: keys ${keyPaths(body?.event ?? body).slice(0, 40).join(', ')}; ${parsed.ignore ? `ignored (${parsed.ignore})` : parsed.title ? 'mapped' : 'no title'}`)
  const logId = startLog(db, { orgId: r.org_id, key: 'gmail_slack_intake', trigger: r.app, subjectType: 'intake', subjectId: r.id })
  const ts = now()
  db.prepare('UPDATE intake_subscriptions SET events_received = events_received + 1, last_event_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, r.id)
  if (assigning) {
    try {
      const out = processSlackTask(db, r, parsed)
      finishLog(db, logId, null, { status: out.status === 'created' || out.status === 'needs_manager' ? 'SUCCEEDED' : 'SKIPPED', summary: { created: 'Task created for the tagged person.', needs_manager: `Needs a manager: ${out.reason}`, duplicate: 'Already received.', ignored: `Ignored: ${out.reason}` }[out.status] })
      return out
    } catch (error) {
      db.prepare('UPDATE intake_subscriptions SET last_error = ? WHERE id = ?').run(String(error.message).slice(0, 300), r.id)
      finishLog(db, logId, null, { status: 'FAILED', error: String(error.message).slice(0, 300) })
      return { status: 'failed', error: error.message }
    }
  }
  if (parsed.ignore || !parsed.title) {
    finishLog(db, logId, null, { status: 'SKIPPED', summary: `Ignored: ${parsed.ignore || 'no subject or text'}` })
    return { status: 'ignored', reason: parsed.ignore || 'empty' }
  }
  try {
    const out = createExternalRequest(db, r.org_id, {
      title: parsed.title.length >= 1 ? parsed.title : 'Request', description: parsed.description, requester: parsed.requester, externalRef: parsed.externalRef,
      reason: `Arrived by ${r.app === 'gmail' ? `email (Gmail label “${r.target_label}”)` : `Slack (${r.target_label})`}.`, suggestedPriority: 'MEDIUM'
    }, { defaultTeamId: r.team_id })
    db.prepare('UPDATE automation_execution_logs SET subject_type = ?, subject_id = ? WHERE id = ?').run('intake', r.id, logId)
    finishLog(db, logId, null, { status: out.duplicate ? 'SKIPPED' : 'SUCCEEDED', summary: out.duplicate ? 'Already received: the existing request was kept.' : `Pending task request created: ${parsed.title.slice(0, 80)}` })
    return { status: out.duplicate ? 'duplicate' : 'created', requestId: out.id }
  } catch (error) {
    db.prepare('UPDATE intake_subscriptions SET last_error = ? WHERE id = ?').run(String(error.message).slice(0, 300), r.id)
    finishLog(db, logId, null, { status: 'FAILED', error: String(error.message).slice(0, 300) })
    return { status: 'failed', error: error.message }
  }
}

/** When a connection is disconnected, its intakes stop (paused on viaSocket already by the disconnect). */
export function pauseIntakesForConnection(db, connectionId) {
  db.prepare(`UPDATE intake_subscriptions SET status = 'PAUSED', last_error = 'The connected account was disconnected.', updated_at = ? WHERE connection_id = ? AND status = 'ACTIVE'`).run(now(), connectionId)
}

export { audit }

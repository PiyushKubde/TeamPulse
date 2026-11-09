// Running allowlisted viaSocket actions on a user's own connection, in the documented order (viasocket-apps 0.19):
// live connection check → that connection's enabled-app flow (script_id, server only; enabled once) → runAction by key
// with a pinned version. https://viasocket.com/docs/skill/actions-and-events.md?format=sdk
import { now } from '../db.js'
import { AppError } from '../errors.js'
import { requireOwnConnection } from './connections.js'
import { redact, requireViasocket, viasocketError } from './errors.js'

// Keys and versions from the app pages, confirmed with user.listActions() on 2026-11-09.
export const ACTIONS = {
  gmail_send_email: { slug: 'gmail', app: 'Gmail', key: 'Send_Email', version: 'v55', actionId: 'rowogelpy0h6', check: 'check the Gmail Sent folder' },
  slack_send_message: { slug: 'slack', app: 'Slack', key: 'Send_Message', version: 'v107', actionId: 'row1jrbor', check: 'check the Slack channel' }
}

/** Every message TeamPulse sends carries this line, so the intake (C) recognises and ignores its own messages. */
export const MARKER = 'Sent by TeamPulse'

export async function requireActiveConnection(db, vs, ctx, connectionId, action) {
  requireViasocket(vs)
  const row = requireOwnConnection(db, ctx, connectionId, action.slug)
  let live
  try { live = await vs.listConnections(ctx.user.id) } catch (error) { throw viasocketError(error, `check your ${action.app} connection`) }
  const match = live.find((c) => c.id === row.auth_id)
  if (!match) throw new AppError(409, 'connection_missing', `This ${action.app} connection no longer exists on ViaSocket. Connect ${action.app} again in the Automation Center.`)
  if (match.isExpired) throw new AppError(409, 'connection_expired', `This ${action.app} connection has expired. Reconnect it in the Automation Center.`)
  return row
}

/**
 * The enabled-app flow for exactly this connection: the stored one if viaSocket still has it, else the user's existing
 * flow for this auth_id, else a new enable(slug, auth_id). A paused one is resumed, never enabled twice.
 */
async function scriptIdFor(db, vs, userId, connection) {
  const flows = await vs.listFlows(userId)
  const stored = db.prepare('SELECT script_id FROM enabled_apps WHERE user_id = ? AND auth_id = ?').get(userId, connection.auth_id)
  const known = stored && flows.find((f) => f.id === stored.script_id && f.status !== 'deleted')
  const flow = known || flows.find((f) => f.authId === connection.auth_id && f.serviceId === connection.service_id && f.status !== 'deleted')
  if (flow?.status === 'paused') await vs.setFlowStatus(userId, flow.id, 1)
  const scriptId = flow?.id || (await vs.enable(userId, connection.app_slug, connection.auth_id)).scriptId
  if (!flow) console.log(`[viasocket] enabled ${connection.app_slug} for user ${userId}`)
  if (stored?.script_id !== scriptId) {
    db.prepare(`INSERT INTO enabled_apps (user_id, auth_id, service_id, script_id, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (user_id, auth_id) DO UPDATE SET script_id = excluded.script_id, service_id = excluded.service_id`).run(userId, connection.auth_id, connection.service_id, scriptId, now())
  }
  return scriptId
}

/**
 * Runs one action for `ctx.user` on their own connection. Never throws: returns
 * { outcome: 'answered', result } | { outcome: 'failed', reason } | { outcome: 'unknown', reason }.
 */
export async function runOnce(db, vs, ctx, connectionId, actionName, inputData) {
  const action = ACTIONS[actionName]
  let scriptId
  try {
    const connection = await requireActiveConnection(db, vs, ctx, connectionId, action)
    scriptId = await scriptIdFor(db, vs, ctx.user.id, connection)
  } catch (error) {
    return { outcome: 'failed', notSent: true, reason: (error instanceof AppError ? error : viasocketError(error, `prepare ${action.app}`)).message }
  }
  try {
    const result = await vs.runAction(scriptId, action.key, inputData, action.version)
    console.log(`[viasocket] ran ${action.slug} ${action.key} ${action.version} for user ${ctx.user.id}: answered`)
    return { outcome: 'answered', result }
  } catch (error) {
    if (error?.status === null || error?.status === undefined) return { outcome: 'unknown', reason: `No answer from ViaSocket, so it is not known whether ${action.app} acted: ${action.check} before retrying.` }
    console.log(`[action] ${action.app} ${action.key} ${action.version} failed: HTTP ${error.status}`)
    return { outcome: 'failed', reason: redact(error?.body?.errorMsg?.message || error?.message || 'ViaSocket refused the action.').slice(0, 300) }
  }
}

const unwrap = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r)
function explicitFailure(result, core) {
  if (core?.success === false || result?.success === false || core?.ok === false || core?.error) {
    return String((typeof core.message === 'string' && core.message) || (typeof core.error === 'string' && core.error) || core.error?.message || 'The app reported a failure.').slice(0, 300)
  }
  return null
}

export function readGmailResult(result) {
  const core = unwrap(result)
  if (!core || typeof core !== 'object') return { ok: false, reason: 'Gmail returned no message details.' }
  const failure = explicitFailure(result, core)
  if (failure) return { ok: false, reason: failure }
  if (typeof core.id !== 'string') return { ok: false, unknown: true, reason: 'ViaSocket answered without a Gmail message id, so the send cannot be confirmed.' }
  return { ok: true, providerId: core.id }
}

export function readSlackResult(result) {
  const core = unwrap(result)
  if (!core || typeof core !== 'object') return { ok: false, reason: 'Slack returned no message details.' }
  const failure = explicitFailure(result, core)
  if (failure) return { ok: false, reason: failure }
  const ts = typeof core.ts === 'string' ? core.ts : typeof core.message?.ts === 'string' ? core.message.ts : null
  if (!ts) return { ok: false, unknown: true, reason: 'ViaSocket answered without a Slack message timestamp, so the post cannot be confirmed.' }
  return { ok: true, providerId: ts }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const bodyToHtml = (text) => String(text).trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
/** Gmail Send_Email v55 inputData. from, cc, bcc, replyTo, attachments, labelIds left out on purpose. */
export const gmailInput = ({ to, subject, body, fromName }) => ({ to, subject, messageBody: bodyToHtml(body), ...(fromName ? { fromName } : {}) })
/** Slack Send_Message v107 inputData: a channel or a direct message; every other key left out on purpose. */
export const slackInput = ({ channelId, userId, text }) => (userId
  ? { destination: { messageto: 'user', userId: [userId] }, markdown_content: text }
  : { destination: { messageto: 'channel', channel_id: [channelId] }, markdown_content: text })

/**
 * Options of a PICK key for the user's own connection: { options, hasMore, paginate, message }.
 * `eventKey` is the action or trigger key, `version` its pinned version.
 */
export async function pickOptions(db, vs, ctx, connectionId, { slug, app, eventKey, version, fieldKey, existingFields = {}, search, paginate }) {
  const connection = await requireActiveConnection(db, vs, ctx, connectionId, { slug, app })
  try {
    const out = await vs.listOptions(ctx.user.id, slug, eventKey, { fieldKey, authId: connection.auth_id, existingFields, version, ...(search ? { search } : {}), ...(paginate ? { paginate } : {}) })
    console.log(`[viasocket] listOptions ${slug} ${eventKey} ${fieldKey} for user ${ctx.user.id}: ${(out.options || []).length} option(s)${out.message ? ', with a message' : ''}`)
    return { options: (out.options || []).map((o) => ({ label: String(o.label), value: String(o.value) })), hasMore: Boolean(out.hasMore), paginate: out.paginate ?? null, message: out.message || null }
  } catch (error) {
    throw viasocketError(error, `list your ${app} options`)
  }
}

const SM = ACTIONS.slack_send_message
/** The user's Slack channels (Send_Message's destination.channel_id). */
export async function slackChannels(db, vs, ctx, connectionId, { search } = {}) {
  return (await pickOptions(db, vs, ctx, connectionId, { slug: SM.slug, app: SM.app, eventKey: SM.key, version: SM.version, fieldKey: 'destination.channel_id', existingFields: { destination: { messageto: 'channel' } }, search })).options
}
/** The people of the user's Slack workspace (Send_Message's destination.userId), for "message me". */
export async function slackUsers(db, vs, ctx, connectionId, { search } = {}) {
  return (await pickOptions(db, vs, ctx, connectionId, { slug: SM.slug, app: SM.app, eventKey: SM.key, version: SM.version, fieldKey: 'destination.userId', existingFields: { destination: { messageto: 'user' } }, search })).options
}

/**
 * Sends one message through Slack or Gmail and reads the provider's own id back.
 * config: { channel: 'slack'|'gmail', connectionId, slackChannelId?, slackUserId?, slackChannelLabel? }
 */
export async function sendThrough(db, vs, ctx, config, { subject, text, to }) {
  const isGmail = config.channel === 'gmail'
  const ran = await runOnce(db, vs, ctx, config.connectionId, isGmail ? 'gmail_send_email' : 'slack_send_message',
    isGmail ? gmailInput({ to, subject, body: `${text}\n\n${MARKER}`, fromName: 'TeamPulse' })
      : slackInput({ channelId: config.slackChannelId, userId: config.slackUserId, text: `*${subject}*\n${text}\n_${MARKER}_` }))
  if (ran.outcome !== 'answered') return { status: ran.outcome === 'unknown' ? 'UNKNOWN' : 'FAILED', error: ran.reason }
  const read = isGmail ? readGmailResult(ran.result) : readSlackResult(ran.result)
  if (!read.ok) { console.log(`[viasocket] ${config.channel} send not confirmed: ${read.unknown ? 'no provider id' : 'refused'}`); return { status: read.unknown ? 'UNKNOWN' : 'FAILED', error: read.reason } }
  console.log(`[viasocket] ${config.channel} send confirmed by the provider (id present)`)
  return { status: 'SUCCEEDED', summary: isGmail ? `Gmail accepted the email (message ${read.providerId})` : `Posted to Slack ${config.slackChannelLabel || (config.slackUserId ? 'direct message' : 'channel')} (ts ${read.providerId})` }
}

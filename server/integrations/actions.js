// Running allowlisted viaSocket actions on a user's own connection, in the documented order:
// live connection check → enabled app (script_id, server only) → version id → runAction.
// Action ids, versions and input shapes are the ones DealSaathi runs live (Slack Send_Message v107, Gmail Send Email V55).
import { now } from '../db.js'
import { AppError } from '../errors.js'
import { requireOwnConnection } from './connections.js'
import { redact, requireViasocket, viasocketError } from './errors.js'

export const ACTIONS = {
  gmail_send_email: { slug: 'gmail', app: 'Gmail', actionId: 'rowogelpy0h6', version: 'V55', check: 'check the Gmail Sent folder' },
  slack_send_message: { slug: 'slack', app: 'Slack', actionId: 'row1jrbor', version: 'V107', check: 'check the Slack channel' }
}

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

async function scriptIdFor(db, vs, userId, connection) {
  const flows = await vs.listFlows(userId)
  const stored = db.prepare('SELECT script_id FROM enabled_apps WHERE user_id = ? AND auth_id = ?').get(userId, connection.auth_id)
  const known = stored && flows.find((f) => f.id === stored.script_id)
  const flow = known && known.status !== 'deleted' ? known : flows.find((f) => f.serviceId === connection.service_id && f.authId === connection.auth_id && f.status !== 'deleted')
  if (flow?.status === 'paused') await vs.setFlowStatus(userId, flow.id, 1)
  const scriptId = flow?.id || (await vs.enable(userId, connection.service_id, connection.auth_id)).scriptId
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
export async function runOnce(db, vs, ctx, connectionId, actionKey, inputData) {
  const action = ACTIONS[actionKey]
  let scriptId
  let versionId
  try {
    const connection = await requireActiveConnection(db, vs, ctx, connectionId, action)
    scriptId = await scriptIdFor(db, vs, ctx.user.id, connection)
    versionId = await vs.versionIdFor(connection.service_id, action.actionId, action.version)
  } catch (error) {
    return { outcome: 'failed', notSent: true, reason: (error instanceof AppError ? error : viasocketError(error, `prepare ${action.app}`)).message }
  }
  try {
    return { outcome: 'answered', result: await vs.runAction(scriptId, versionId, inputData) }
  } catch (error) {
    if (error?.status === null || error?.status === undefined) return { outcome: 'unknown', reason: `No answer from ViaSocket, so it is not known whether ${action.app} acted: ${action.check} before retrying.` }
    return { outcome: 'failed', reason: redact(error?.message || 'ViaSocket refused the action.').slice(0, 300) }
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
export const gmailInput = ({ to, subject, body, fromName }) => ({ to, subject, messageBody: bodyToHtml(body), ...(fromName ? { fromName } : {}) })
export const slackInput = ({ channelId, text }) => ({ destination: { messageto: 'channel', channel_id: [channelId] }, markdown_content: text })

/** The user's Slack channels, for choosing where a notification goes (Send_Message's destination.channel_id picker). */
export async function slackChannels(db, vs, ctx, connectionId) {
  const action = ACTIONS.slack_send_message
  const connection = await requireActiveConnection(db, vs, ctx, connectionId, action)
  try {
    const versionId = await vs.versionIdFor(connection.service_id, action.actionId, action.version)
    const { options } = await vs.listOptions(ctx.user.id, versionId, { fieldKey: 'destination.channel_id', authId: connection.auth_id, existingFields: { destination: { messageto: 'channel' } } })
    return options.map((o) => ({ label: String(o.label), value: String(o.value) }))
  } catch (error) {
    throw viasocketError(error, 'list your Slack channels')
  }
}

/** Sends one message through Slack or Gmail and reads the provider's own id back. */
export async function sendThrough(db, vs, ctx, config, { subject, text, to }) {
  const isGmail = config.channel === 'gmail'
  const ran = await runOnce(db, vs, ctx, config.connectionId, isGmail ? 'gmail_send_email' : 'slack_send_message',
    isGmail ? gmailInput({ to, subject, body: text, fromName: 'TeamPulse' }) : slackInput({ channelId: config.slackChannelId, text: `*${subject}*\n${text}` }))
  if (ran.outcome !== 'answered') return { status: ran.outcome === 'unknown' ? 'UNKNOWN' : 'FAILED', error: ran.reason }
  const read = isGmail ? readGmailResult(ran.result) : readSlackResult(ran.result)
  if (!read.ok) return { status: read.unknown ? 'UNKNOWN' : 'FAILED', error: read.reason }
  return { status: 'SUCCEEDED', summary: isGmail ? `Gmail accepted the email (message ${read.providerId})` : `Posted to Slack ${config.slackChannelLabel || 'channel'} (ts ${read.providerId})` }
}

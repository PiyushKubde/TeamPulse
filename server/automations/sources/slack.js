// Slack as a task-intake source: one channel on the manager's own workspace connection. Messages become pending requests, or (opt-in per
// intake) tasks for the people tagged, which needs confirmed Slack identity mappings (services/slack-identities.js).
import { json } from '../../db.js'
import { conflict } from '../../errors.js'
import { isOwnMessage } from '../../integrations/actions.js'
import { extractMentions } from '../slack-tasks.js'
import { first } from './util.js'

/** Slack event → normalized message (see sources/index.js). */
export function parseSlack(e, { threads = false } = {}) {
  const text = first(e.text, e.message?.text)
  const bot = Boolean(e.bot_id || e.bot_profile || e.subtype === 'bot_message' || e.message?.bot_id)
  const ts = first(e.ts, e.event_ts, e.message?.ts)
  const channel = first(e.channel, e.channel_id, e.message?.channel)
  const ownMessage = isOwnMessage(text)
  const senderId = first(e.user, e.user_id, e.message?.user)
  const teamId = first(e.team, e.team_id, e.user_team, e.message?.team)
  const permalink = first(e.permalink, e.message?.permalink)
  const threadTs = first(e.thread_ts, e.message?.thread_ts)
  return {
    title: text ? text.split('\n')[0].replace(/[*_`]/g, '').slice(0, 120) : null, description: text ? text.slice(0, 4000) : null,
    requester: first(e.user_name, e.username, e.user_profile?.real_name, e.user), externalRef: ts ? `slack:${channel || ''}:${ts}` : null,
    missing: [...(text ? [] : ['message text']), ...(ts ? [] : ['message timestamp'])],
    // Task-from-mention intakes also read thread replies (a reply can carry the real request); requests ignore them as before.
    ignore: ownMessage ? 'sent by KONVO' : bot ? 'posted by a bot' : !threads && e.thread_ts && e.thread_ts !== e.ts ? 'a thread reply' : null,
    text, mentions: extractMentions(text), senderId: senderId && /^[UW][A-Z0-9]{6,20}$/.test(senderId) ? senderId : null, ts, threadTs, channel,
    teamId: teamId && /^[A-Z0-9]{6,20}$/.test(teamId) ? teamId : null,
    permalink: permalink && /^https:\/\/([a-z0-9-]+\.)*slack\.com\//i.test(permalink) ? permalink : null
  }
}

/** Outgoing KONVO posts must never land in an intake channel: refuse a Slack intake on a channel we post to. */
function assertNotOutbound(db, orgId, channelId) {
  const used = db.prepare(`SELECT config FROM automation_workflows WHERE org_id = ? AND status != 'PAUSED'`).all(orgId).some((w) => json(w.config, {}).slackChannelId === channelId)
    || db.prepare(`SELECT 1 FROM notification_prefs WHERE org_id = ? AND channel = 'slack' AND slack_mode = 'channel' AND slack_target = ?`).get(orgId, channelId)
  if (used) throw conflict('KONVO already posts notifications or reports to that channel; using it for intake would turn them into new requests. Choose a separate intake channel.', 'intake_loop')
}

export const SLACK = {
  app: 'slack', slug: 'slack', name: 'Slack', kind: 'communication',
  trigger: { key: 'New_Message_Posted_in_Channel_Instant', version: 'v2', triggerId: 'rowo0opjzsgk' },
  target: { noun: 'Slack channel', field: 'channel_id', existing: {}, hint: 'Use a channel only for requests — not one KONVO posts notifications or reports to.', choose: 'Choose one of your Slack channels.' },
  inputFor: (target) => ({ channel_id: [target] }),
  parse: parseSlack,
  accountScoped: false,
  requiresRef: false,
  supportsMentionAssign: true, // opt-in per intake; needs confirmed identity mappings
  outboundGuard: assertNotOutbound,
  unmappedWhere: 'title: text; message id: ts',
  reason: (label) => `Arrived by Slack (${label}).`
}

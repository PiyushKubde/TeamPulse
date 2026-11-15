// Microsoft Teams as a task-intake source: one channel of one Team, on the manager's own Microsoft connection.
// Trigger details come from viaSocket's catalog (viasocket.catalog.versions('rowxzmscatfe'), read 2026-11-15), not guessed:
//   service rowxzmscatfe, slug microsftteams, OAuth 2.0
//   trigger New_Channel_Message, trigger_id rowsfn4nr5vx, published version V2; inputs team_id (the user's joined teams) and channel_id (that team's channels)
//   event: id, body.content, from.user.{id,displayName}, from.application, webUrl, mentions[], messageType, replyToId, deletedDateTime,
//          channelIdentity.{teamId,channelId}, createdDateTime
// Only top-level channel messages are received (thread replies, chats and 1:1 messages are other triggers and are NOT used).
// The sender is an Azure AD user id with a display name and no email, so a message can only ever become a pending request here: nothing is
// assigned or approved from a Teams message. A confirmed identity mapping would be needed before any assignment mode could exist.
import { isOwnMessage } from '../../integrations/actions.js'
import { first, obj, htmlToText } from './util.js'

const AAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Teams channel message event → normalized message (see sources/index.js). `scope` is the subscription's own input (team and channel). */
export function parseTeams(e, { scope = null } = {}) {
  const body = obj(e.body)
  const raw = first(body?.content)
  const html = String(body?.contentType || '').toLowerCase() === 'html' || /<\/?[a-z][^>]*>/i.test(raw || '')
  const text = raw ? (html ? htmlToText(raw.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, '$1')) : raw)?.trim() || null : null
  const id = first(e.id)
  const team = first(e.channelIdentity?.teamId, scope?.team_id?.[0], scope?.team_id)
  const channel = first(e.channelIdentity?.channelId, scope?.channel_id?.[0], scope?.channel_id)
  const user = obj(e.from?.user)
  const app = obj(e.from?.application) || obj(e.from?.device)
  const type = first(e.messageType) || 'message'
  const ignore = isOwnMessage(text) ? 'sent by KONVO'
    : type !== 'message' ? 'a system message'
      : e.deletedDateTime ? 'a deleted message'
        : e.replyToId ? 'a thread reply'
          : !user && app ? 'posted by an app or bot' : null
  const link = first(e.webUrl)
  const mentions = (Array.isArray(e.mentions) ? e.mentions : []).map((m) => first(m?.mentioned?.user?.id)).filter((x) => x && AAD_ID.test(x))
  return {
    title: text ? text.split('\n').map((l) => l.trim()).find(Boolean).replace(/[*_`]/g, '').slice(0, 120) : null, description: text ? text.slice(0, 4000) : null,
    requester: first(user?.displayName)?.slice(0, 200) ?? null,
    externalRef: id && team && channel ? `teams:${team}:${channel}:${id}` : null,
    missing: [...(text ? [] : ['message text']), ...(id ? [] : ['message id']), ...(team && channel ? [] : ['team or channel'])],
    ignore, text, mentions: [...new Set(mentions)], senderId: first(user?.id) && AAD_ID.test(user.id) ? user.id : null, channel,
    permalink: link && /^https:\/\/([a-z0-9-]+\.)*(teams\.microsoft\.com|teams\.live\.com)\//i.test(link) ? link : null
  }
}

export const TEAMS = {
  app: 'teams', slug: 'microsftteams', name: 'Microsoft Teams', kind: 'communication',
  trigger: { key: 'New_Channel_Message', version: 'v2', triggerId: 'rowsfn4nr5vx' },
  // Two live pickers: the Team first (parent), then one of its channels.
  target: { noun: 'Teams channel', field: 'channel_id', existing: {}, hint: 'Use a channel only for requests. Replies in a thread and private chats are not read.', choose: 'Choose one of your Teams channels.',
    parent: { noun: 'Team', field: 'team_id', existingKey: 'team_id' } },
  inputFor: (target, parent) => ({ team_id: [parent], channel_id: [target] }),
  parse: parseTeams,
  accountScoped: false,
  requiresRef: true, // a stable team + channel + message id is required, so a repeated delivery is always recognised
  supportsMentionAssign: false,
  unmappedWhere: 'title: body.content; message id: id; team and channel: channelIdentity.teamId and channelIdentity.channelId',
  reason: (label) => `Arrived by Microsoft Teams (${label}).`,
  noRefMessage: (p) => `The Teams message had no ${p.missing.join(' or ') || 'message id'}, so it was not imported.`
}

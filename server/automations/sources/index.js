// Task-intake source registry. One entry per communication source; the common pipeline (automations/intake.js) knows nothing about any
// particular app, it asks the entry. To add Google Chat, Outlook or another communication source: add a module here that exports
// a descriptor (like TEAMS) and a parser, and register it below. No change to the pipeline is needed.
//
// A source descriptor:
//   app                  stored in intake_subscriptions.app (lower case; the table CHECK must list it: migration 012 added 'teams')
//   slug / name          the viaSocket app slug and the display name
//   kind                 'communication' (messages become pending requests). Work-management sources (Jira, Asana, Trello, Linear, ClickUp) are a
//                        different kind: their records are tasks already, so they must be linked or imported, never turned into duplicate requests.
//   trigger              { key, version, triggerId } from viasocket.catalog.versions(serviceId); never guessed
//   target               { noun, field, existing, hint, choose, parent? }: what the user picks, from live options on their own connection
//   inputFor(target, parent)   the trigger input for the chosen target
//   parse(event, opts)   source-specific event → NormalizedMessage (below). The event content is untrusted data.
//   accountScoped        the connected account is part of the deduplication key (Gmail mailboxes)
//   requiresRef          nothing is imported without a stable message reference
//   supportsMentionAssign  tasks for tagged people (opt-in, needs confirmed identity mappings); only Slack today
//   outboundGuard(db, orgId, target)  optional: refuse a target KONVO itself posts to
//
// NormalizedMessage: { title, description, requester, externalRef, missing[], ignore?, ...source extras (text, mentions, senderId, ...) }
import { GMAIL, GMAIL_ID_FIELDS, gmailRef } from './gmail.js'
import { SLACK } from './slack.js'
import { TEAMS } from './teams.js'

export { GMAIL_ID_FIELDS, gmailRef }
export const SOURCES = Object.freeze({ gmail: GMAIL, slack: SLACK, teams: TEAMS })
export const SOURCE_KEYS = Object.freeze(Object.keys(SOURCES))

export const getSource = (app) => SOURCES[String(app || '').toLowerCase()] ?? null

/** The sources the UI may offer: no triggers, ids or functions, only what a person needs to choose. */
export const publicSources = () => SOURCE_KEYS.map((k) => {
  const s = SOURCES[k]
  return { app: s.app, slug: s.slug, name: s.name, kind: s.kind, targetNoun: s.target.noun, parentNoun: s.target.parent?.noun ?? null, hint: s.target.hint, supportsMentionAssign: Boolean(s.supportsMentionAssign) }
})

const unwrapEvent = (e) => (e && typeof e === 'object' && e.event && typeof e.event === 'object' && !e.subject && !e.text ? e.event : e)

/** Maps one source's raw event to a NormalizedMessage. `opts` carries { threads, account, scope } for the parsers that need them. */
export function parseEvent(app, raw, opts = {}) {
  const src = getSource(app)
  if (!src) throw new Error(`Unknown intake source: ${app}`)
  const e = unwrapEvent(Array.isArray(raw) ? raw[0] : raw) || {}
  return src.parse(e, opts)
}

// Slack message → task. Deterministic, rule-based extraction: nothing is sent to an AI provider (so no privacy approval is
// needed) and every result is labelled extraction "deterministic". The tagged person owns the task only when their Slack id
// is mapped to a TeamPulse person by a manager; the extractor never invents an owner, deadline, priority or outcome.
import { now, transaction, uuid } from '../db.js'
import { loadContext, assignableUserIds, isManager } from '../access.js'
import { createExternalRequest } from '../services/requests.js'
import { createIntakeTask } from '../services/assignments.js'
import { resolveSlackUser } from '../services/slack-identities.js'
import { addDays, orgTimezone, zonedParts, zonedTimeToMs } from '../time.js'

const MENTION_RE = /<@([UW][A-Z0-9]{6,20})(?:\|[^>]*)?>/g
export const extractMentions = (text) => [...new Set([...String(text || '').matchAll(MENTION_RE)].map((m) => m[1]))]

/** Slack markup → plain text (people are removed, links keep their label, entities decoded). */
export function plainText(text) {
  return String(text || '')
    .replace(MENTION_RE, ' ')
    .replace(/<!(?:channel|here|everyone)[^>]*>/g, ' ')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[*_`~]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

// ---------- who is tagged, and in which role ----------
const SUPPORT_BEFORE = /(?:\bcc\b|\bcc'ing\b|\bfyi\b|looping in|loop in|with help from|help from|support from|along with|together with|\bwith)\s*:?\s*(?:,|and|&)?\s*$/i
const REVIEWER_BEFORE = /(?:reviewer|review(?:ed)? by|review from|for review by|sign[- ]?off from|approval from)\s*:?\s*(?:,|and|&)?\s*$/i

/** Each tagged person with a role: PRIMARY (asked to do the work), SUPPORT (helps) or REVIEWER. */
export function mentionRoles(text) {
  const out = []
  const src = String(text || '')
  for (const m of src.matchAll(MENTION_RE)) {
    if (out.some((o) => o.slackUserId === m[1])) continue
    const before = src.slice(Math.max(0, m.index - 30), m.index).replace(MENTION_RE, '@x')
    out.push({ slackUserId: m[1], role: REVIEWER_BEFORE.test(before) ? 'REVIEWER' : SUPPORT_BEFORE.test(before) ? 'SUPPORT' : 'PRIMARY' })
  }
  return out
}

// ---------- is it a task? ----------
const REQUEST_CUE = /\b(please|pls|kindly|can you|could you|would you|will you|need you to|needs? to be|i need|we need|take care of|take this|handle this|own this|your task|assigning you|assigned to you)\b/i
const IMPERATIVE_START = /^(investigate|fix|build|create|update|review|prepare|send|check|look into|follow up|deploy|write|set up|implement|schedule|share|ship|resolve|draft|test|migrate|add|remove|document|analy[sz]e|design|plan|finish|complete|submit|collect|verify|reproduce|debug|refactor|upgrade|roll ?back|raise|file|book|order|reach out|get|make|run|prepare|compile|audit|clean up|cleanup|investigate)\b/i
const GREETING = /^(hi|hello|hey|thanks|thank you|thx|good (morning|evening|afternoon)|gm|congrats|welcome|lol|ok|okay|sure|cool|nice|great)\b/i
const COMPLETED = /^(done|completed|fixed|shipped|merged|deployed|resolved|finished)\b|\b(is|are|was|were|has been|have been) (now )?(done|completed|fixed|shipped|merged|deployed|resolved|finished)\b/i
const STATUS_UPDATE = /^(status( update)?|fyi|heads[- ]up|wip|eod update|update:)|\b(working on|in progress|will update|on it)\b/i
const BLOCKER = /\b(blocked|stuck|can'?t proceed|cannot proceed|escalat(e|ing|ion))\b/i

/** Kind of message: TASK_REQUEST | QUESTION | STATUS_UPDATE | COMPLETED | BLOCKER | GREETING | DISCUSSION. */
export function classify(text) {
  const body = plainText(text)
  if (!body) return 'DISCUSSION'
  const request = REQUEST_CUE.test(body) || IMPERATIVE_START.test(body.replace(/^[\s,:;-]+/, ''))
  if (request) return 'TASK_REQUEST'
  if (GREETING.test(body) && body.split(/\s+/).length <= 8) return 'GREETING'
  if (COMPLETED.test(body)) return 'COMPLETED'
  if (BLOCKER.test(body)) return 'BLOCKER'
  if (STATUS_UPDATE.test(body)) return 'STATUS_UPDATE'
  if (body.includes('?')) return 'QUESTION'
  return 'DISCUSSION'
}

// ---------- deadline ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/**
 * A deadline only when the words settle it: "tomorrow", "today / EOD", "by Friday", "on 20 Nov", "2026-12-01", "in 3 days",
 * "within 2 hours", each with an optional time ("by 5pm", "at 14:30"). Dates have no time → end of day in the organization's
 * timezone. Anything vague ("soon", "next week", "next Friday", a weekday that is today) is left unset. Never in the past.
 * Returns { iso, matched } or null.
 */
export function parseDeadline(text, { tz = 'UTC', nowMs = Date.now() } = {}) {
  const t = plainText(text).toLowerCase()
  const today = zonedParts(nowMs, tz)
  const ymd = { year: today.year, month: today.month, day: today.day }
  let date = null
  let matched = null
  let m

  // Relative durations are exact instants (hours/minutes) or whole calendar days.
  if ((m = t.match(/\b(?:in|within)\s+(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(minute|min|hour|hr|day|week)s?\b/))) {
    const n = NUMBER_WORDS[m[1]] ?? Number(m[1])
    const unit = m[2]
    if (unit.startsWith('min') || unit.startsWith('h')) {
      const ms = nowMs + n * (unit.startsWith('min') ? 60000 : 3600000)
      return { iso: new Date(ms).toISOString(), matched: m[0] }
    }
    date = addDays(ymd, unit === 'week' ? n * 7 : n)
    matched = m[0]
  } else if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    date = { year: +m[1], month: +m[2], day: +m[3] }
    matched = m[0]
  } else if ((m = t.match(/\bday after tomorrow\b/))) {
    date = addDays(ymd, 2); matched = m[0]
  } else if ((m = t.match(/\btomorrow\b/))) {
    date = addDays(ymd, 1); matched = m[0]
  } else if ((m = t.match(/\b(today|tonight|eod|end of (?:the )?day|cob)\b/))) {
    date = ymd; matched = m[0]
  } else if ((m = t.match(/\b(next\s+)?(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)day\b/))) {
    const target = WEEKDAYS.indexOf(m[2].slice(0, 3))
    const diff = (target - today.weekday + 7) % 7
    // "next Friday" and a weekday that is today are ambiguous in plain English: leave the deadline unset.
    if (m[1] || diff === 0) return null
    date = addDays(ymd, diff); matched = m[0]
  } else if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/)) || (m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/))) {
    const [day, mon] = /^\d/.test(m[1]) ? [+m[1], m[2]] : [+m[2], m[1]]
    let cand = { year: today.year, month: MONTHS.indexOf(mon) + 1, day }
    const beforeToday = (c) => c.month < ymd.month || (c.month === ymd.month && c.day < ymd.day)
    if (beforeToday(cand)) cand = { ...cand, year: today.year + 1 }
    if (day < 1 || day > 31) return null
    date = cand; matched = m[0]
  }
  if (!date) return null

  // Optional time of day, only next to a date.
  let hour = 23, minute = 59
  const tm = t.match(/\b(?:at|by|before|until)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || t.match(/\b(?:at|by|before|until)\s*([01]?\d|2[0-3]):([0-5]\d)\b/)
  if (tm) {
    hour = Number(tm[1])
    minute = Number(tm[2] || 0)
    if (tm[3]) { if (hour < 1 || hour > 12) return null; hour = (hour % 12) + (tm[3] === 'pm' ? 12 : 0) }
    matched = `${matched} ${tm[0].trim()}`
  } else if (/\bnoon\b/.test(t)) { hour = 12; minute = 0 }
  const ms = zonedTimeToMs({ ...date, hour, minute }, tz)
  if (!Number.isFinite(ms) || ms <= nowMs) return null
  return { iso: new Date(ms).toISOString(), matched }
}

// ---------- the rest of the fields: only what the message says ----------
const PRIORITY_RULES = [
  ['CRITICAL', /\b(p0|sev ?1|critical|outage|production (?:is )?down)\b/i],
  ['HIGH', /\b(urgent|asap|p1|high priority|top priority|immediately|right away)\b/i],
  ['LOW', /\b(low priority|p3|no rush|whenever|when you (?:get|have) (?:a )?(?:chance|time))\b/i],
  ['MEDIUM', /\b(medium priority|normal priority|p2)\b/i]
]
const firstSentence = (s) => s.split(/(?<=[.!?])\s+|\n/)[0] || ''
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * { isTask, kind, title, description, expectedOutcome, priority (null when not stated), dueAt, dependencies, possibleBlockers, context, roles }.
 * `context` is the parent message of a thread, when known; it can supply the work description for a short reply like
 * "@Priya can you take this?" (the reply's own deadline and priority still count).
 */
export function interpretMessage(text, { tz = 'UTC', nowMs = Date.now(), context = null } = {}) {
  const kind = classify(text)
  const roles = mentionRoles(text)
  const own = plainText(text).replace(/^[\s,:;-]+/, '') // "@Priya, please…" leaves a stray comma once the tag is removed
  const combined = context ? `${own}\n${plainText(context)}` : own
  const deadline = parseDeadline(own, { tz, nowMs }) || (context ? parseDeadline(plainText(context), { tz, nowMs }) : null)
  const priority = PRIORITY_RULES.find(([, re]) => re.test(own))?.[0] || null
  let head = firstSentence(own.replace(/^[\s,:;-]+/, ''))
  if (deadline?.matched) head = head.replace(new RegExp(`\\s*\\b(?:by|on|before|until|till)?\\s*${deadline.matched.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}`, 'i'), '')
  // Once the people are removed, a role cue can be left dangling at the end ("..., with help from").
  for (let i = 0; i < 2; i++) head = head.replace(/[\s,;:–-]*\b(?:with help from|help from|support from|along with|together with|looping in|loop in|cc'?ing|cc|fyi|reviewer|review(?:ed)? by|with)\s*[,;:]?\s*$/i, '')
  head = head.replace(/^(hi|hey|hello)\b[, ]*/i, '').replace(/^(please|pls|kindly)\b[, ]*/i, '')
    .replace(/^(?:can|could|would|will) you(?: please)?\b[, ]*/i, '').replace(/^(?:i|we) need you to\b\s*/i, '').replace(/^need you to\b\s*/i, '')
    .replace(/[\s,;:–-]+$/, '').replace(/\?+$/, '').trim()
  // A reply that only points at the parent ("take this", "handle that") borrows the parent's first sentence as the title.
  const vague = !head || head.split(/\s+/).length < 3 || /^(take|handle|own|look at|do|check|see) (this|that|it)\b/i.test(head)
  if (vague && context) head = firstSentence(plainText(context).replace(/^[\s,:;-]+/, '')).replace(/[\s,;:–-]+$/, '').replace(/\?+$/, '').trim()
  const title = capital(head).slice(0, 180)
  const outcome = combined.match(/\b(?:so that|so we can|to ensure|expected outcome:?|goal is|goal:)\s+([^.\n]{5,200})/i)?.[1]?.trim() || null
  const deps = [...combined.matchAll(/\bdepends? on\s+([^.\n]{3,120})/gi)].map((m) => m[1].trim())
  const blockers = [...combined.matchAll(/\b(?:blocked by|waiting (?:on|for))\s+([^.\n]{3,120})/gi)].map((m) => m[1].trim())
  const enough = title.split(/\s+/).length >= 3 && title.length >= 8
  return {
    kind, isTask: kind === 'TASK_REQUEST' && enough, title, description: combined.slice(0, 4000), expectedOutcome: outcome, priority,
    dueAt: deadline?.iso ?? null, dependencies: deps, possibleBlockers: blockers, context: context ? plainText(context).slice(0, 1000) : null, roles,
    reason: kind !== 'TASK_REQUEST' ? `Not a task request (${kind.toLowerCase().replace('_', ' ')}).` : enough ? null : 'Not enough detail to make a task.'
  }
}

// Retention policy, approved by the owner as 24 hours (docs/slack-task-intake.md, "Data retention"). Why it exists: a thread reply
// such as "@Priya can you take this?" is only actionable with its parent message, and the parent is usually ordinary chat that
// was (correctly) not turned into a task. So an excerpt of non-task messages is held briefly, then erased. Without it, no chat
// would be stored at all and thread replies could only use a parent that itself became a task or a manager request.
export const IGNORED_TEXT_RETENTION_DAYS = 1

/** Erases the text of messages that did not become a task once they are `days` old (the scheduled job calls this). Tasks, requests and manager-routed messages are never touched. */
export function purgeIgnoredText(db, days = IGNORED_TEXT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  return db.prepare(`UPDATE slack_intake_items SET text = NULL, sender_name = NULL WHERE outcome = 'IGNORED' AND text IS NOT NULL AND created_at < ?`).run(cutoff).changes
}

// ---------- the intake ----------
const WHY = {
  unmapped: 'is not mapped to a TeamPulse person yet',
  unconfirmed: 'only has an unconfirmed claim on that Slack identity',
  workspace_mismatch: 'is mapped to a Slack user in a different workspace',
  inactive: 'is no longer an active member'
}

/**
 * One Slack event from an intake subscription that assigns from mentions. Returns { status, taskId?, requestId?, reason? } where
 * status is created | needs_manager | ignored | duplicate. Safe to call twice with the same message (unique per org + ref).
 */
export function processSlackTask(db, sub, p, { nowMs = Date.now() } = {}) {
  const orgId = sub.org_id
  const ref = p.externalRef
  if (!ref) return { status: 'ignored', reason: 'no message id' }
  if (db.prepare('SELECT 1 FROM slack_intake_items WHERE org_id = ? AND external_ref = ?').get(orgId, ref)) return { status: 'duplicate' }
  const ts = now()
  const base = { id: uuid(), org_id: orgId, subscription_id: sub.id, external_ref: ref, channel_id: p.channel, message_ts: p.ts, thread_ts: p.threadTs, workspace_id: p.teamId, sender_slack_id: p.senderId, mentions: JSON.stringify(p.mentions || []), permalink: p.permalink }
  const sender = p.senderId ? resolveSlackUser(db, orgId, p.senderId, p.teamId) : null
  const senderUserId = sender?.trusted ? sender.userId : null
  const senderName = (senderUserId && db.prepare('SELECT name FROM users WHERE id = ?').get(senderUserId)?.name) || p.requester || null
  const save = (outcome, reason, extra = {}) => {
    // Task messages keep their text as the task's source. Other messages keep a short excerpt (so a later thread reply can use
    // its parent as context) that the scheduled job erases after IGNORED_TEXT_RETENTION_DAYS; bot and TeamPulse messages keep nothing.
    const keepText = !p.ignore
    const excerpt = outcome === 'IGNORED' ? 500 : 4000
    db.prepare(`INSERT INTO slack_intake_items (id, org_id, subscription_id, external_ref, channel_id, message_ts, thread_ts, workspace_id, sender_slack_id, sender_user_id, sender_name, mentions, permalink, text, outcome, reason, extraction, extracted, task_id, request_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(base.id, orgId, sub.id, ref, base.channel_id, base.message_ts, base.thread_ts, base.workspace_id, base.sender_slack_id, senderUserId, keepText ? senderName : null, base.mentions, base.permalink,
        keepText ? String(p.text || '').slice(0, excerpt) : null, outcome, reason, extra.extraction ?? null, extra.extracted ? JSON.stringify(extra.extracted) : null, extra.taskId ?? null, extra.requestId ?? null, ts)
  }

  if (p.ignore) { save('IGNORED', p.ignore); return { status: 'ignored', reason: p.ignore } }

  const parent = p.threadTs && p.threadTs !== p.ts ? db.prepare('SELECT text FROM slack_intake_items WHERE org_id = ? AND channel_id = ? AND message_ts = ? AND text IS NOT NULL').get(orgId, p.channel, p.threadTs) : null
  const tz = orgTimezone(db, orgId)
  // "tomorrow" means tomorrow from when the message was posted, even if the delivery reaches us later.
  const postedMs = Number(p.ts) * 1000
  const x = interpretMessage(p.text, { tz, nowMs: Number.isFinite(postedMs) && postedMs > 1e12 ? postedMs : nowMs, context: parent?.text || null })
  const summary = { kind: x.kind, title: x.title, priority: x.priority, dueAt: x.dueAt, expectedOutcome: x.expectedOutcome, dependencies: x.dependencies, possibleBlockers: x.possibleBlockers, usedThreadContext: Boolean(parent) }
  if (!x.isTask) { save('IGNORED', x.reason, { extraction: 'deterministic', extracted: summary }); return { status: 'ignored', reason: x.reason } }

  // Who owns it: exactly one tagged person who asks to do the work and whose Slack identity a manager confirmed.
  const primaries = x.roles.filter((r) => r.role === 'PRIMARY')
  let problem = null
  let assigneeId = null
  if (!primaries.length) problem = 'Nobody was tagged to do the work. Who should own it?'
  else if (primaries.length > 1) problem = `${primaries.length} people were tagged and the message does not say who owns the work. Who should?`
  else {
    const r = resolveSlackUser(db, orgId, primaries[0].slackUserId, p.teamId)
    if (!r.trusted) problem = `The person tagged (${primaries[0].slackUserId}) ${WHY[r.reason] || 'cannot be matched'}. Map their Slack identity, then assign the task.`
    else {
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.owner_id)
      const ctx = owner ? loadContext(db, owner) : null
      if (!ctx?.membership || !isManager(ctx)) problem = 'The manager who set up this intake can no longer assign work.'
      else if (!assignableUserIds(db, ctx).includes(r.userId)) problem = 'The person tagged is outside the teams of the manager who set up this intake.'
      else assigneeId = r.userId
    }
  }
  const trustedOf = (role) => x.roles.filter((r) => r.role === role).map((r) => resolveSlackUser(db, orgId, r.slackUserId, p.teamId)).filter((r) => r.trusted).map((r) => r.userId)

  return transaction(db, () => {
    if (assigneeId) {
      const teamId = db.prepare('SELECT team_id FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, assigneeId)?.team_id || sub.team_id || null
      const { taskId } = createIntakeTask(db, {
        orgId, creatorId: sub.owner_id, teamId, assigneeId, title: x.title, description: x.description, expectedOutcome: x.expectedOutcome, priority: x.priority || 'MEDIUM',
        dueAt: x.dueAt, slackRef: ref, requester: { userId: senderUserId, name: senderName }, support: trustedOf('SUPPORT'), reviewers: trustedOf('REVIEWER'), extraction: 'deterministic'
      })
      save('TASK_CREATED', null, { extraction: 'deterministic', extracted: summary, taskId })
      return { status: 'created', taskId }
    }
    const req = createExternalRequest(db, orgId, {
      title: x.title, description: [x.description, `Tagged in Slack: ${(p.mentions || []).join(', ') || 'nobody'}`].join('\n\n').slice(0, 5000), requester: senderName, externalRef: ref,
      reason: `Slack task message that needs a manager: ${problem}`, suggestedPriority: x.priority || 'MEDIUM', suggestedDueAt: x.dueAt
    }, { defaultTeamId: sub.team_id })
    save('NEEDS_MANAGER', problem, { extraction: 'deterministic', extracted: summary, requestId: req.id })
    return { status: 'needs_manager', requestId: req.id, reason: problem }
  })
}

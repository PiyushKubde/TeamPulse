// The five evidence collectors. Each one: the viaSocket triggers it subscribes to (keys, versions and trigger ids read
// from the live catalog with user.listActions / catalog.versions on 2026-11-09), how the person picks the scope on
// their own connection, the trigger inputData for that scope, and normalize(): one raw event → normalized items.
//
// Field mapping follows the catalog's sample_output where the connector publishes one (GitHub PR and review comment,
// Slack channel message, Gmail, Calendar, Sheets). For triggers whose catalog sample is empty (GitHub commits, issues,
// issue comments, releases; Slack thread replies) the mapping reads the standard GitHub/Slack API shapes and is
// checked against a real sample from the person's own scope before the trigger is switched on (sources.js).
// Nothing is guessed silently: an event without an id is rejected, without an author it is "unknown".
import { isOwnMessage } from '../integrations/actions.js'

const str = (...vals) => vals.find((x) => (typeof x === 'string' && x.trim()) || typeof x === 'number')
const s = (...vals) => { const v = str(...vals); return v === undefined ? null : String(v).trim() }
const clip = (t, n) => (t == null ? null : String(t).length > n ? `${String(t).slice(0, n)}…` : String(t))
const iso = (v) => { if (v == null || v === '') return null; const n = typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN; const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString() }
const firstLine = (t) => (t ? String(t).split('\n').find((l) => l.trim())?.trim().slice(0, 160) ?? null : null)
const unwrap = (e) => (e && typeof e === 'object' && e.event && typeof e.event === 'object' && Object.keys(e).length <= 2 ? e.event : e)

// ---------- GitHub ----------
const GH = 'https://github.com'
function ghRepo(e, scope) { return s(e.repository?.full_name, e.repository_full_name, e.repo, scope?.repo) }
export const github = {
  app: 'github', label: 'GitHub',
  scopeHelp: 'Choose a repository. The connected GitHub account needs admin access to it so viaSocket can add a webhook.',
  pick: { field: 'repoFullName', key: 'Pull_Request_Opens_or_Closes', version: 'v22', existing: {} },
  scopeFrom: ({ value, label, branch }) => ({ scope: { repo: value, branch: branch || 'main' }, label: label || value }),
  kinds: {
    pull_requests: { key: 'Pull_Request_Opens_or_Closes', version: 'v22', triggerId: 'rowru54g3wrd', label: 'Pull requests opened or closed (incl. merged)', input: (sc) => ({ repoFullName: sc.repo }) },
    commits: { key: 'New_Commit_Pushed', version: 'v6', triggerId: 'rowaygkq46ev', label: 'Commits pushed to a branch', input: (sc) => ({ repoFullName: sc.repo, sha: sc.branch || 'main' }) },
    review_comments: { key: 'new-pull-request-review-comment', version: 'v1', triggerId: 'row3mze15rcy', label: 'Pull request review comments', input: (sc) => ({ repoFullName: sc.repo }) },
    issues: { key: 'When_a_new_issue_is_created', version: 'v7', triggerId: 'rowbsm4g8zdq', label: 'New issues', input: (sc) => ({ repoFullName: sc.repo }) },
    issue_comments: { key: 'When_a_new_comment_is_added_to_an_issue', version: 'v6', triggerId: 'row4lbsfdxj9', label: 'Issue comments', input: (sc) => ({ repoFullName: sc.repo }) },
    releases: { key: 'New_Release_Published', version: 'v6', triggerId: 'rowi8rqh3mlu', label: 'Releases published', input: (sc) => ({ repoFullName: sc.repo }) }
  },
  defaultKinds: ['pull_requests', 'commits', 'review_comments'],
  normalize(kind, raw, scope) {
    const e = unwrap(raw) || {}
    const repo = ghRepo(e, scope)
    if (kind === 'pull_requests') {
      const pr = e.pull_request || e
      const number = s(e.number, pr.number)
      if (!repo || !number) return { error: 'pull request without repository or number' }
      const merged = pr.merged === true || Boolean(pr.merged_at)
      const action = s(e.action) || (merged ? 'closed' : pr.state === 'closed' ? 'closed' : 'opened')
      return [{
        externalId: `pr:${repo}#${number}`, kind: merged ? 'pr_merged' : action === 'closed' ? 'pr_closed' : action === 'opened' || action === 'reopened' ? 'pr_opened' : 'pr_updated',
        actorIdentity: s(pr.user?.login), occurredAt: iso(pr.merged_at) || iso(pr.closed_at) || iso(pr.updated_at) || iso(pr.created_at),
        title: s(pr.title) ? `PR #${number}: ${pr.title}` : `PR #${number}`, content: clip(pr.body, 1200), resourceRef: repo,
        sourceUrl: s(pr.html_url) || `${GH}/${repo}/pull/${number}`, parentRef: null, verification: 'system_recorded',
        metadata: { repo, number: Number(number), state: s(pr.state), merged, mergedBy: merged ? s(pr.merged_by?.login, e.sender?.login) : null, additions: pr.additions ?? null, deletions: pr.deletions ?? null, changedFiles: pr.changed_files ?? null, reviewersRequested: Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers.length : null, headRef: s(pr.head?.ref) }
      }]
    }
    if (kind === 'commits') {
      const list = Array.isArray(e.commits) ? e.commits : Array.isArray(raw) ? raw : [e]
      const out = []
      for (const c of list) {
        const sha = s(c.sha, c.id)
        if (!repo || !sha) continue
        const message = s(c.commit?.message, c.message)
        out.push({
          externalId: `commit:${repo}@${sha}`, kind: 'commit', actorIdentity: s(c.author?.login, c.author?.username, c.committer?.username, c.commit?.author?.email, c.author?.email),
          occurredAt: iso(c.commit?.author?.date) || iso(c.timestamp) || iso(c.commit?.committer?.date), title: firstLine(message), content: clip(message, 600),
          resourceRef: repo, sourceUrl: s(c.html_url, c.url?.startsWith?.('https://github.com') ? c.url : null) || `${GH}/${repo}/commit/${sha}`,
          parentRef: scope?.branch ? `branch:${repo}:${scope.branch}` : null, verification: 'system_recorded', metadata: { repo, sha, branch: scope?.branch || null }
        })
      }
      return out.length ? out : { error: 'commit event without repository or sha' }
    }
    if (kind === 'review_comments') {
      const id = s(e.comment_id, e.comment?.id, e.id)
      const pr = s(e.pull_request_number, e.pull_request?.number)
      if (!repo || !id) return { error: 'review comment without repository or id' }
      return [{
        externalId: `prcomment:${repo}:${id}`, kind: 'review_comment', actorIdentity: s(e.author_login, e.comment?.user?.login, e.user?.login),
        occurredAt: iso(e.created_at) || iso(e.comment?.created_at), title: `Review comment on PR #${pr}${s(e.pull_request_title) ? `: ${e.pull_request_title}` : ''}`,
        content: clip(s(e.body, e.comment?.body), 800), resourceRef: repo, sourceUrl: s(e.html_url, e.comment?.html_url), parentRef: pr ? `pr:${repo}#${pr}` : null,
        verification: 'system_recorded', metadata: { repo, pullRequest: pr ? Number(pr) : null, path: s(e.path), reviewId: s(e.review_id), inReplyTo: s(e.in_reply_to_id) }
      }]
    }
    if (kind === 'issues' || kind === 'issue_comments') {
      const issue = e.issue || e
      const number = s(issue.number, e.number)
      if (kind === 'issues') {
        if (!repo || !number) return { error: 'issue without repository or number' }
        return [{ externalId: `issue:${repo}#${number}`, kind: 'issue_opened', actorIdentity: s(issue.user?.login, e.sender?.login), occurredAt: iso(issue.created_at) || iso(issue.updated_at), title: `Issue #${number}: ${s(issue.title) || ''}`.trim(), content: clip(issue.body, 1000), resourceRef: repo, sourceUrl: s(issue.html_url) || `${GH}/${repo}/issues/${number}`, parentRef: null, verification: 'system_recorded', metadata: { repo, number: Number(number), state: s(issue.state), labels: Array.isArray(issue.labels) ? issue.labels.map((l) => s(l?.name, l)).filter(Boolean).slice(0, 10) : [] } }]
      }
      const c = e.comment || e
      const id = s(c.id, e.comment_id)
      if (!repo || !id) return { error: 'issue comment without repository or id' }
      return [{ externalId: `issuecomment:${repo}:${id}`, kind: 'issue_comment', actorIdentity: s(c.user?.login, e.sender?.login), occurredAt: iso(c.created_at), title: `Comment on issue #${number}${s(issue.title) ? `: ${issue.title}` : ''}`, content: clip(c.body, 800), resourceRef: repo, sourceUrl: s(c.html_url), parentRef: number ? `issue:${repo}#${number}` : null, verification: 'system_recorded', metadata: { repo, issue: number ? Number(number) : null } }]
    }
    if (kind === 'releases') {
      const r = e.release || e
      const id = s(r.id, r.tag_name)
      if (!repo || !id) return { error: 'release without repository or id' }
      return [{ externalId: `release:${repo}:${id}`, kind: 'release', actorIdentity: s(r.author?.login, e.sender?.login), occurredAt: iso(r.published_at) || iso(r.created_at), title: `Release ${s(r.name, r.tag_name)}`, content: clip(r.body, 1000), resourceRef: repo, sourceUrl: s(r.html_url), parentRef: null, verification: 'system_recorded', metadata: { repo, tag: s(r.tag_name) } }]
    }
    return { error: `unknown GitHub kind ${kind}` }
  }
}

// ---------- Slack ----------
export const slack = {
  app: 'slack', label: 'Slack',
  scopeHelp: 'Choose work channels only. Direct messages are never collected.',
  pick: { field: 'channel_id', key: 'New_Message_in_Channels', version: 'v25', existing: {} },
  scopeFrom: ({ value, label }) => ({ scope: { channel: value }, label: label ? `#${String(label).replace(/^#/, '')}` : value }),
  kinds: {
    messages: { key: 'New_Message_in_Channels', version: 'v25', triggerId: 'rowhgo2uqw41', label: 'Messages in the channel', input: (sc) => ({ channel_id: [sc.channel] }) },
    thread_replies: { key: 'New_Thread_Message_Instant', version: 'v1', triggerId: 'rowhqxbjvzav', label: 'Thread replies in the channel', input: (sc) => ({ channel: sc.channel }) }
  },
  defaultKinds: ['messages', 'thread_replies'],
  validateScope: (sc) => (/^D/.test(String(sc.channel)) ? 'Direct messages are not collected. Choose a channel.' : null),
  normalize(kind, raw, scope) {
    const e = unwrap(raw) || {}
    const m = e.message && typeof e.message === 'object' && !e.text ? { ...e.message, channel: e.channel ?? e.message.channel } : e
    const channel = s(m.channel, m.channel_id, scope?.channel)
    if (s(m.subtype) === 'message_deleted' || s(e.subtype) === 'message_deleted') {
      const ts = s(e.deleted_ts, m.deleted_ts, e.previous_message?.ts)
      return ts && channel ? [{ externalId: `slack:${channel}:${ts}`, deleted: true }] : { ignore: 'deletion without a message id' }
    }
    if (s(m.subtype) === 'message_changed' && e.message) return this.normalize(kind, { ...e.message, channel }, scope)
    if (String(channel || '').startsWith('D')) return { ignore: 'direct message' }
    if (m.bot_id || m.bot_profile || m.subtype === 'bot_message') return { ignore: 'posted by a bot' }
    if (m.subtype && !['thread_broadcast', 'file_share'].includes(m.subtype)) return { ignore: `Slack ${m.subtype}` }
    const text = s(m.text)
    if (text && isOwnMessage(text)) return { ignore: 'sent by KONVO' }
    const ts = s(m.ts, m.event_ts)
    if (!channel || !ts) return { error: 'message without channel or ts' }
    if (!text && !(Array.isArray(m.files) && m.files.length)) return { ignore: 'empty message' }
    const threadTs = s(m.thread_ts)
    const reply = Boolean(threadTs && threadTs !== ts)
    return [{
      externalId: `slack:${channel}:${ts}`, kind: reply ? 'thread_reply' : 'message', actorIdentity: s(m.user, m.user_id),
      occurredAt: iso(ts), title: firstLine(text) || '(file shared)', content: clip(text, 1200), resourceRef: `slack:${channel}`,
      sourceUrl: null, parentRef: reply ? `slack:${channel}:${threadTs}` : null, verification: 'self_reported',
      metadata: { channel, channelLabel: scope?.channelLabel || null, files: Array.isArray(m.files) ? m.files.slice(0, 5).map((f) => ({ name: s(f.name), mimetype: s(f.mimetype), size: f.size ?? null })) : [] }
    }]
  }
}

// ---------- Gmail ----------
function stripQuoted(body) {
  if (!body) return null
  const lines = String(body).split(/\r?\n/)
  const cut = lines.findIndex((l) => /^On .{4,200} wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From: .+/.test(l.trim()))
  return lines.slice(0, cut > 0 ? cut : lines.length).filter((l) => !l.trim().startsWith('>')).join('\n').trim()
}
const emailOf = (v) => { const t = s(v?.email, v?.address, v); if (!t) return null; const m = /<([^>]+)>/.exec(t); return (m ? m[1] : t).trim().toLowerCase() }
const emailsOf = (v) => (Array.isArray(v) ? v : v == null ? [] : typeof v === 'string' ? v.split(',') : [v]).map(emailOf).filter(Boolean)
export const gmail = {
  app: 'gmail', label: 'Gmail',
  scopeHelp: 'Choose one Gmail label (e.g. "Work/KONVO"). Only emails with that label are collected — never your whole mailbox.',
  pick: { field: 'searchFields.label', key: 'New_Email_Arrives', version: 'v11', existing: { thread: 'include_replies', query: ['label'] } },
  scopeFrom: ({ value, label }) => ({ scope: { label: value }, label: `label “${label || value}”` }),
  kinds: {
    received: { key: 'New_Email_Arrives', version: 'v11', triggerId: 'row9ls2itxoc', label: 'Emails received with the label', input: (sc) => ({ thread: 'include_replies', query: ['label'], searchFields: { label: [sc.label] } }) },
    sent: { key: 'New_Email_Sent', version: 'v6', triggerId: 'row3otsjmkon', label: 'Emails you sent with the label', input: (sc) => ({ thread: 'include_replies', query: ['label'], searchFields: { label: [sc.label] } }) }
  },
  defaultKinds: ['received', 'sent'],
  normalize(kind, raw) {
    const e = unwrap(Array.isArray(raw) ? raw[0] : raw) || {}
    const h = e.rawPayloadHeaders || {}
    const id = s(e.rawId, e.id, e.messageId)
    if (!id) return { error: 'email without a message id' }
    const subject = s(e.subject, h.Subject)
    const from = emailOf(e.From) || emailOf(h.From)
    const to = emailsOf(e.To).concat(emailsOf(h.To)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 8)
    const body = stripQuoted(s(e.bodyPlain, e.textPlain, e.snippet))
    if (isOwnMessage(body)) return { ignore: 'sent by KONVO' }
    return [{
      externalId: `gmail:${id}`, kind: kind === 'sent' ? 'email_sent' : 'email_received', actorIdentity: kind === 'sent' ? null : from,
      occurredAt: iso(e.rawInternalDate) || iso(e.date) || iso(h.Date), title: subject || '(no subject)', content: clip(body, 1000),
      resourceRef: s(e.threadId) ? `gmail-thread:${e.threadId}` : null, sourceUrl: s(e.messageUrl), parentRef: s(e.threadId) ? `gmail-thread:${e.threadId}` : null,
      verification: 'self_reported',
      metadata: { from, to, threadId: s(e.threadId), attachments: Array.isArray(e.attachmentDetails) ? e.attachmentDetails.slice(0, 10).map((a) => ({ filename: s(a.filename), mimeType: s(a.mimeType), size: a.size ?? null })) : [] }
    }]
  }
}

// ---------- Google Calendar ----------
const SKIP_EVENT_TYPES = new Set(['outOfOffice', 'workingLocation', 'focusTime', 'birthday'])
export const calendar = {
  app: 'google-calendar', label: 'Google Calendar',
  scopeHelp: 'Choose a work calendar. Private events, declined events, out-of-office and working-location entries are ignored.',
  pick: { field: 'calendarId', key: 'New_or_Updated_Event', version: 'v30', existing: {} },
  scopeFrom: ({ value, label }) => ({ scope: { calendar: value }, label: label || value }),
  kinds: { events: { key: 'New_or_Updated_Event', version: 'v30', triggerId: 'rowmgg40hg3s', label: 'Events created or updated', input: (sc) => ({ calendarId: [sc.calendar] }) } },
  defaultKinds: ['events'],
  normalize(kind, raw) {
    const e = unwrap(raw) || {}
    const id = s(e.id, e.iCalUID)
    if (!id) return { error: 'event without an id' }
    if (['private', 'confidential'].includes(s(e.visibility))) return { ignore: 'private event' }
    if (SKIP_EVENT_TYPES.has(s(e.eventType))) return { ignore: `${e.eventType} entry` }
    const me = Array.isArray(e.attendees) ? e.attendees.find((a) => a?.self) : null
    if (me && me.responseStatus === 'declined') return { ignore: 'declined by you' }
    const organizer = emailOf(e.organizer)
    const start = iso(e.start?.dateTime) || iso(e.start?.date)
    const end = iso(e.end?.dateTime) || iso(e.end?.date)
    return [{
      externalId: `gcal:${id}`, kind: 'meeting', actorIdentity: null, occurredAt: start || iso(e.updated) || iso(e.created),
      title: s(e.summary) || '(no title)', content: clip(e.description, 800), resourceRef: s(e.calendarId) ? `gcal:${e.calendarId}` : null,
      sourceUrl: s(e.htmlLink), parentRef: s(e.recurringEventId) ? `gcal:${e.recurringEventId}` : null, verification: 'self_reported',
      status: s(e.status) === 'cancelled' ? 'cancelled' : 'active',
      metadata: { start, end, durationMinutes: start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 60000) : null, organizer, role: me?.organizer || (organizer && me?.email && organizer === emailOf(me.email)) ? 'organizer' : me ? 'attendee' : 'calendar_owner', attendees: Array.isArray(e.attendees) ? e.attendees.slice(0, 20).map((a) => emailOf(a)).filter(Boolean) : [], location: clip(e.location, 120) }
    }]
  }
}

// ---------- Google Sheets ----------
export const sheets = {
  app: 'google-sheets', label: 'Google Sheets',
  scopeHelp: 'Choose one tracker sheet. Values are recorded as reported figures, never as verified results.',
  pick: { field: 'spreadSheet_id', key: 'Row_Added_Or_Updated', version: 'v11', existing: {} },
  subPick: { field: 'sheet_id', existing: (spreadsheet) => ({ spreadSheet_id: spreadsheet }) },
  scopeFrom: ({ value, label, sheet, sheetLabel }) => ({ scope: { spreadsheet: value, sheet }, label: `${label || value}${sheetLabel ? ` › ${sheetLabel}` : ''}` }),
  kinds: { rows: { key: 'Row_Added_Or_Updated', version: 'v11', triggerId: 'rowyysj8ut82', label: 'Rows added or updated', input: (sc) => ({ spreadSheet_id: sc.spreadsheet, sheet_id: sc.sheet, column_key: true, record_type: 'new_update' }) } },
  defaultKinds: ['rows'],
  validateScope: (sc) => (!sc.sheet ? 'Choose a sheet inside the spreadsheet.' : null),
  normalize(kind, raw, scope) {
    const e = unwrap(raw) || {}
    const values = e.values && typeof e.values === 'object' ? e.values : null
    const ssId = s(e._spreadsheet_id, scope?.spreadsheet)
    const sheetId = s(e._sheet_id, scope?.sheet)
    const row = s(e._rowNumber)
    if (!values || !ssId || !row) return { error: 'row without values, spreadsheet or row number' }
    const entries = Object.entries(values).slice(0, 30).map(([k, v]) => [String(k).slice(0, 60), clip(v == null ? '' : String(v), 200)])
    if (!entries.some(([, v]) => v)) return { ignore: 'empty row' }
    return [{
      externalId: `gsheet:${ssId}:${sheetId}:${row}`, kind: 'sheet_row', actorIdentity: null, occurredAt: null, // rows carry no time: the receipt time is used
      title: entries.slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ').slice(0, 160), content: entries.map(([k, v]) => `${k}: ${v}`).join('\n').slice(0, 1500),
      resourceRef: `gsheet:${ssId}:${sheetId}`, sourceUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(ssId)}/edit${sheetId ? `#gid=${encodeURIComponent(sheetId)}` : ''}`,
      parentRef: null, verification: 'reported_figure', metadata: { spreadsheet: ssId, sheet: sheetId, row: Number(row), values: Object.fromEntries(entries) }
    }]
  }
}

export const COLLECTORS = { github, slack, gmail, 'google-calendar': calendar, 'google-sheets': sheets }
export const collectorFor = (app) => COLLECTORS[app] || null

// Gmail as a task-intake source: a label on the manager's own mailbox. Each labelled email becomes at most one pending task request.
import { isOwnMessage } from '../../integrations/actions.js'
import { first, header, person, htmlToText, sha } from './util.js'

// Where the Gmail message id is looked for, in this order (the first is Gmail's own immutable id for the message in that mailbox).
export const GMAIL_ID_FIELDS = ['rawId', 'id', 'messageId', 'message_id', 'Message-ID header']
const MAX_REF_ID = 100

/**
 * The deduplication key for one Gmail message: the connected Gmail account (the mailbox) plus the message id. A Gmail id is only unique
 * inside one mailbox, and the same email delivered to two mailboxes is two different messages for two different managers, so the account is
 * part of the key. Requests are additionally unique per organization (task_requests.org_id + external_ref).
 */
export function gmailRef(account, id, kind = 'gmail') {
  if (!account || !id) return null
  const body = id.length > MAX_REF_ID ? `h:${sha(id).slice(0, 40)}` : id
  return `gmail:${account}:${kind === 'rfc' ? 'rfc:' : ''}${body}`
}

/** Gmail event → normalized message (see sources/index.js). */
export function parseGmail(e, { account = null } = {}) {
  const hdr = (name) => first(header(e.rawPayloadHeaders, name), header(e.payload?.headers, name), header(e.headers, name))
  const subject = first(e.subject, e.Subject, hdr('subject'))
  const from = first(person(e.From), person(e.from), person(e.sender), e.senderEmail, hdr('from'))
  const body = first(e.bodyPlain, e.textPlain, e.text, e.body, e.plainBody, e.bodyText, e.snippet) ?? htmlToText(first(e.bodyHtml, e.textHtml))
  const gmailId = first(e.rawId, e.id, e.messageId, e.message_id)
  const rfcId = (first(hdr('message-id'), e['Message-ID'], e.messageIdHeader) || '').replace(/^<|>$/g, '').trim() || null
  const externalRef = gmailId ? gmailRef(account, gmailId) : gmailRef(account, rfcId, 'rfc')
  const ownMessage = isOwnMessage(body) || /\b(?:KONVO|TeamPulse)\b/.test(from || '')
  const firstLine = body ? body.split('\n').map((l) => l.trim()).find(Boolean) : null
  const attachments = Number(e.attachmentCount) > 0 ? Number(e.attachmentCount) : (Array.isArray(e.attachmentDetails) ? e.attachmentDetails.length : 0)
  const note = attachments ? `\n\n(${attachments} attachment${attachments === 1 ? '' : 's'} in the email were not imported.)` : ''
  const missing = []
  if (!(gmailId || rfcId)) missing.push('message id')
  else if (!account) missing.push('source account')
  return {
    title: (subject || firstLine?.slice(0, 120) || '(no subject)').slice(0, 200),
    description: body || note ? `${(body || '').slice(0, 3800)}${note}`.trim() : null,
    requester: from ? from.slice(0, 200) : null, externalRef, missing, ignore: ownMessage ? 'sent by KONVO' : null
  }
}

export const GMAIL = {
  app: 'gmail', slug: 'gmail', name: 'Gmail', kind: 'communication',
  trigger: { key: 'New_Email_Arrives', version: 'v11', triggerId: 'row9ls2itxoc' },
  // The target is a Gmail label, picked from the live list on the user's own connection.
  target: { noun: 'Gmail label', field: 'searchFields.label', existing: { thread: 'first_email_only', query: ['label'] }, hint: 'Create a label such as “KONVO” in Gmail and apply it to emails that should become requests.', choose: 'Choose one of your Gmail labels.' },
  inputFor: (target) => ({ thread: 'first_email_only', query: ['label'], searchFields: { label: [target] } }),
  parse: parseGmail,
  accountScoped: true, // the mailbox is part of the deduplication key
  requiresRef: true, // without a stable id a repeated delivery could not be recognised, so nothing is imported
  supportsMentionAssign: false,
  unmappedWhere: `title: subject, headers or body; message id: ${GMAIL_ID_FIELDS.join(', ')}`,
  reason: (label) => `Arrived by email (Gmail label “${label}”).`,
  noRefMessage: (p) => `The email had no ${p.missing.join(' or ') || 'message id'}, so it was not imported.`
}

// Ingestion: viaSocket delivers each trigger event to POST /api/evidence/events/:subscriptionId with that
// subscription's bearer token. The raw event is written to the inbox first (deduplicated by content hash), then
// normalized, attributed and stored; anything that fails stays in the inbox and is retried by the scheduled job.
// Collection never starts an AI analysis.
import { createHash, timingSafeEqual } from 'node:crypto'
import { json, now, transaction, uuid } from '../db.js'
import { AppError } from '../errors.js'
import { redact } from '../ai/redact.js'
import { notifyInApp } from '../services/notify.js'
import { collectorFor } from './collectors.js'
import { storeMatches } from './matching.js'

const sha = (x) => createHash('sha256').update(String(x)).digest('hex')
const MAX_PAYLOAD = 64 * 1024
export const MAX_ATTEMPTS = 5

/** Who an external identity belongs to in this organization: declared/connection identities, then member emails. */
export function resolveIdentity(db, orgId, app, identity) {
  if (!identity) return null
  const id = String(identity).trim().toLowerCase()
  const hit = db.prepare('SELECT user_id FROM external_identities WHERE org_id = ? AND app = ? AND identity = ?').get(orgId, app, id)
  if (hit) return hit.user_id
  if (id.includes('@')) {
    const byEmail = db.prepare(`SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? AND lower(u.email) = ?`).get(orgId, id)
    if (byEmail) return byEmail.id
    const anyApp = db.prepare('SELECT user_id FROM external_identities WHERE org_id = ? AND identity = ?').get(orgId, id)
    if (anyApp) return anyApp.user_id
  }
  return null
}

/**
 * Attribution of one normalized item collected by `collectorId`:
 *  - Gmail sent mail, calendar events and sheet rows are the collector's own (their mailbox, calendar, tracker);
 *  - otherwise the event's author through a known identity: self / member; an email address of nobody here: external;
 *    an author nobody has claimed (or none in the event): unknown — visible, never guessed.
 */
function attribute(db, orgId, app, item, collectorId) {
  if (!item.actorIdentity && ['email_sent', 'meeting', 'sheet_row'].includes(item.kind)) return { actor: collectorId, attribution: 'self' }
  const user = resolveIdentity(db, orgId, app, item.actorIdentity)
  if (user) return { actor: user, attribution: user === collectorId ? 'self' : 'member' }
  if (item.actorIdentity && String(item.actorIdentity).includes('@')) return { actor: null, attribution: 'external' }
  return { actor: null, attribution: 'unknown' }
}

function storeItem(db, sub, source, item, method, receivedAt) {
  const ts = now()
  const existing = db.prepare('SELECT * FROM external_evidence WHERE org_id = ? AND app = ? AND external_id = ?').get(source.org_id, source.app, item.externalId)
  if (item.deleted) {
    if (!existing) return { outcome: 'ignored', reason: 'deletion of an event never collected' }
    db.prepare(`UPDATE external_evidence SET status = 'deleted', content = NULL, updated_at = ? WHERE id = ?`).run(ts, existing.id)
    return { outcome: 'deleted', id: existing.id }
  }
  // A disputed or manually corrected attribution is kept; otherwise attribution is recomputed (identities may be newer).
  const att = existing && ['disputed'].includes(existing.attribution) ? { actor: existing.actor_user_id, attribution: existing.attribution } : attribute(db, source.org_id, source.app, item, source.owner_id)
  const occurredAt = item.occurredAt || receivedAt
  const metadata = JSON.stringify(item.metadata || {})
  if (existing) {
    if (existing.status === 'removed_by_owner') return { outcome: 'ignored', reason: 'removed by its owner' }
    // Updates to the same event (a PR closed and merged, a calendar event changed, a sheet row edited): one row, the
    // newest state; the previous values of a sheet row are kept in metadata.previous.
    const meta = source.app === 'google-sheets' ? JSON.stringify({ ...JSON.parse(metadata), previous: json(existing.metadata_json, {}).values || null }) : metadata
    db.prepare(`UPDATE external_evidence SET kind = ?, actor_identity = COALESCE(?, actor_identity), actor_user_id = ?, attribution = ?, occurred_at = ?, title = ?, content = ?, resource_ref = ?, source_url = COALESCE(?, source_url),
                parent_ref = ?, verification = ?, metadata_json = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(item.kind, item.actorIdentity ?? null, att.actor, att.attribution, occurredAt, item.title ?? null, item.content ?? null, item.resourceRef ?? null, item.sourceUrl ?? null, item.parentRef ?? null, item.verification, meta, item.status || 'active', ts, existing.id)
    return { outcome: 'updated', id: existing.id }
  }
  const id = uuid()
  db.prepare(`INSERT INTO external_evidence (id, org_id, source_id, collector_id, connection_id, app, external_id, kind, actor_identity, actor_user_id, attribution, occurred_at, title, content, resource_ref, source_url, parent_ref, verification, metadata_json, method, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, source.org_id, source.id, source.owner_id, source.connection_id, source.app, item.externalId, item.kind, item.actorIdentity ?? null, att.actor, att.attribution, occurredAt, item.title ?? null, item.content ?? null,
      item.resourceRef ?? null, item.sourceUrl ?? null, item.parentRef ?? null, item.verification, metadata, method, item.status || 'active', ts, ts)
  return { outcome: 'created', id }
}

/** Normalizes and stores one inbox row. Never throws: the row records what happened. */
export function processInboxRow(db, row) {
  const sub = db.prepare('SELECT * FROM evidence_subscriptions WHERE id = ?').get(row.subscription_id)
  const source = sub && db.prepare('SELECT * FROM evidence_sources WHERE id = ?').get(sub.source_id)
  const ts = now()
  const mark = (status, extra = {}) => db.prepare('UPDATE evidence_inbox SET status = ?, attempts = attempts + 1, error = ?, result = ?, processed_at = ? WHERE id = ?')
    .run(status, extra.error ? redact(extra.error).slice(0, 300) : null, extra.result ? JSON.stringify(extra.result) : null, status === 'FAILED' ? null : ts, row.id)
  if (!source || source.status === 'DELETED') { mark('IGNORED', { result: { reason: 'source removed' } }); return { status: 'IGNORED' } }
  const collector = collectorFor(source.app)
  let raw
  try { raw = JSON.parse(row.payload) } catch { mark('FAILED', { error: 'unreadable payload' }); return { status: 'FAILED' } }
  let items
  try { items = collector.normalize(sub.kind, raw, { ...json(source.scope_json, {}), channelLabel: source.scope_label }) } catch (error) { items = { error: `normalizer: ${error.message}` } }
  if (items?.ignore) { mark('IGNORED', { result: { reason: items.ignore } }); return { status: 'IGNORED', reason: items.ignore } }
  if (items?.error || !Array.isArray(items)) {
    const error = items?.error || 'nothing could be read from the event'
    mark('FAILED', { error })
    db.prepare('UPDATE evidence_sources SET last_error = ?, consecutive_errors = consecutive_errors + 1, updated_at = ? WHERE id = ?').run(redact(error).slice(0, 300), ts, source.id)
    return { status: 'FAILED', error }
  }
  try {
    const results = transaction(db, () => {
      const out = []
      for (const item of items) {
        const r = storeItem(db, sub, source, item, row.method, row.received_at)
        if (r.id && (r.outcome === 'created' || r.outcome === 'updated')) storeMatches(db, db.prepare('SELECT * FROM external_evidence WHERE id = ?').get(r.id))
        out.push(r)
      }
      const newest = items.map((i) => i.occurredAt).filter(Boolean).sort().at(-1) || null
      db.prepare(`UPDATE evidence_sources SET events_received = events_received + 1, last_event_at = ?, last_success_at = ?, last_error = NULL, consecutive_errors = 0,
                  checkpoint = CASE WHEN ? IS NOT NULL AND (checkpoint IS NULL OR ? > checkpoint) THEN ? ELSE checkpoint END, updated_at = ? WHERE id = ?`).run(row.received_at, ts, newest, newest, newest, ts, source.id)
      return out
    })
    mark('PROCESSED', { result: results.map((r) => r.outcome) })
    return { status: 'PROCESSED', results }
  } catch (error) {
    mark('FAILED', { error: error.message })
    db.prepare('UPDATE evidence_sources SET last_error = ?, consecutive_errors = consecutive_errors + 1, updated_at = ? WHERE id = ?').run(redact(error.message).slice(0, 300), ts, source.id)
    return { status: 'FAILED', error: error.message }
  }
}

/** Writes one delivered event to the inbox (deduplicated) and processes it. */
export function acceptEvent(db, sub, payload, method = 'trigger') {
  const text = JSON.stringify(payload ?? null)
  if (text.length > MAX_PAYLOAD) throw new AppError(413, 'too_large', 'Event too large.')
  const hash = sha(text)
  const dup = db.prepare('SELECT id, status FROM evidence_inbox WHERE subscription_id = ? AND payload_hash = ?').get(sub.id, hash)
  if (dup) return { status: 'duplicate', inboxId: dup.id }
  const id = uuid()
  db.prepare(`INSERT INTO evidence_inbox (id, org_id, subscription_id, method, payload, payload_hash, status, attempts, received_at) VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED', 0, ?)`)
    .run(id, sub.org_id, sub.id, method, text, hash, now())
  const out = processInboxRow(db, db.prepare('SELECT * FROM evidence_inbox WHERE id = ?').get(id))
  return { status: out.status.toLowerCase(), inboxId: id }
}

/** POST /api/evidence/events/:id — authenticated by the subscription's own bearer token (only its hash is stored). */
export function receiveEvidenceEvent(db, id, bearer, body) {
  const sub = typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? db.prepare('SELECT * FROM evidence_subscriptions WHERE id = ?').get(id) : null
  const given = Buffer.from(sha(String(bearer || '')))
  if (!sub || !bearer || !timingSafeEqual(given, Buffer.from(sub.token_hash))) throw new AppError(401, 'unauthorized', 'Unauthorized')
  const source = db.prepare('SELECT status FROM evidence_sources WHERE id = ?').get(sub.source_id)
  if (sub.status !== 'ACTIVE' || source?.status !== 'ACTIVE') return { status: 'ignored', reason: 'collection paused' }
  return acceptEvent(db, sub, body?.event ?? body, 'trigger')
}

/**
 * Scheduled retry: inbox rows still RECEIVED (crash between write and processing) or FAILED (fewer than MAX_ATTEMPTS).
 * A source that keeps failing tells its owner in the app once a day — never through M91.
 */
export function retryInbox(db, { limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - 60000).toISOString()
  const rows = db.prepare(`SELECT * FROM evidence_inbox WHERE (status = 'RECEIVED' AND received_at < ?) OR (status = 'FAILED' AND attempts < ?) ORDER BY received_at LIMIT ?`).all(cutoff, MAX_ATTEMPTS, limit)
  let processed = 0
  for (const r of rows) if (processInboxRow(db, r).status !== 'FAILED') processed++
  for (const s of db.prepare(`SELECT * FROM evidence_sources WHERE consecutive_errors >= 3 AND status = 'ACTIVE'`).all()) {
    notifyInApp(db, { orgId: s.org_id, userId: s.owner_id, kind: 'evidence_sync_error', title: `Evidence collection from ${s.scope_label} keeps failing`, body: s.last_error, link: '#/evidence', dedupeKey: `evidence-sync-error:${s.id}:${now().slice(0, 10)}` })
  }
  return { retried: rows.length, processed }
}

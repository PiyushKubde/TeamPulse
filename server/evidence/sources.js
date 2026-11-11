// Evidence sources: a person chooses, on their OWN connection, what TeamPulse may collect (a repository, channels, a
// Gmail label, a calendar, one sheet) and which event kinds. For each kind TeamPulse subscribes the viaSocket trigger
// on that connection (user.subscribe — the same documented mechanism as the Gmail/Slack intake). viaSocket runs the
// handler for each event and posts it to TeamPulse with a bearer token for that one subscription.
// Initial sync = the latest real event from the scope (catalog sampleEvent, read-only), which also proves the
// mapping; there is no full-history backfill by design. Nothing is ever written to the external apps.
import { createHash, randomBytes } from 'node:crypto'
import { json, now, transaction, uuid } from '../db.js'
import { AppError, conflict, forbidden, invalid, notFound } from '../errors.js'
import { isAdmin, scopeUserIds } from '../access.js'
import { audit } from '../services/audit.js'
import { requireActiveConnection, pickOptions } from '../integrations/actions.js'
import { requireViasocket, viasocketError } from '../integrations/errors.js'
import { COLLECTORS, collectorFor } from './collectors.js'
import { acceptEvent } from './ingest.js'
import * as v from '../validate.js'

const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const APPS = Object.keys(COLLECTORS)
const requireApp = (app) => { const c = collectorFor(String(app || '')); if (!c) throw invalid(`Choose one of: ${APPS.join(', ')}.`); return c }
function syncRun(db, orgId, sourceId, kind, status, { items = 0, error = null, startedAt = now() } = {}) {
  db.prepare(`INSERT INTO evidence_sync_runs (id, org_id, source_id, kind, status, items, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), orgId, sourceId, kind, status, items, error ? String(error).slice(0, 300) : null, startedAt, now())
}

/** What can be collected per app, for the "Add a source" form. */
export function catalog() {
  return Object.values(COLLECTORS).map((c) => ({ app: c.app, label: c.label, help: c.scopeHelp, kinds: Object.entries(c.kinds).map(([k, t]) => ({ kind: k, label: t.label, trigger: t.key, version: t.version, default: c.defaultKinds.includes(k) })), needsSubPick: Boolean(c.subPick) }))
}

/** Scope choices from the person's own connection (repositories, channels, labels, calendars, spreadsheets/sheets). */
export async function scopeOptions(db, vs, ctx, { app, connectionId, parent, search }) {
  const c = requireApp(app)
  const sub = parent && c.subPick
  return pickOptions(db, vs, ctx, connectionId, {
    slug: c.app, app: c.label, eventKey: c.pick.key, version: c.pick.version,
    fieldKey: sub ? c.subPick.field : c.pick.field, existingFields: sub ? c.subPick.existing(parent) : c.pick.existing, search
  })
}

function present(db, s) {
  const subs = db.prepare(`SELECT kind, trigger_key, version, status FROM evidence_subscriptions WHERE source_id = ? AND status != 'DELETED'`).all(s.id)
  const counts = db.prepare(`SELECT l.status, COUNT(*) AS n FROM external_evidence e LEFT JOIN evidence_task_links l ON l.evidence_id = e.id WHERE e.source_id = ? AND e.status = 'active' GROUP BY l.status`).all(s.id)
  const failed = db.prepare(`SELECT COUNT(*) AS n FROM evidence_inbox i JOIN evidence_subscriptions x ON x.id = i.subscription_id WHERE x.source_id = ? AND i.status = 'FAILED'`).get(s.id).n
  return {
    id: s.id, app: s.app, appLabel: collectorFor(s.app)?.label, scope: s.scope_label, status: s.status, kinds: subs.map((x) => ({ kind: x.kind, label: collectorFor(s.app)?.kinds[x.kind]?.label || x.kind, status: x.status })),
    lastEventAt: s.last_event_at, lastSuccessAt: s.last_success_at, lastHealthAt: s.last_health_at, lastError: s.last_error, checkpoint: s.checkpoint,
    collectionErrors: failed, ownerId: s.owner_id, createdAt: s.created_at,
    linkState: Object.fromEntries(counts.map((r) => [r.status || 'unmatched', r.n])),
    history: db.prepare('SELECT kind, status, items, error, started_at FROM evidence_sync_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 8').all(s.id).map((r) => ({ kind: r.kind, status: r.status, items: r.items, error: r.error, at: r.started_at }))
  }
}

export function listSources(db, ctx, { userId } = {}) {
  const uid = userId || ctx.user.id
  if (uid !== ctx.user.id && !(isAdmin(ctx) || (ctx.role === 'manager' && scopeUserIds(db, ctx).includes(uid)))) throw notFound('Person')
  return db.prepare(`SELECT * FROM evidence_sources WHERE org_id = ? AND owner_id = ? AND status != 'DELETED' ORDER BY created_at DESC`).all(ctx.orgId, uid).map((s) => present(db, s))
}

/**
 * Creates a source and its trigger subscriptions on the person's own connection.
 * body: { app, connectionId, scope: { value, label, sheet?, sheetLabel?, branch? }, kinds: [] }
 */
export async function createSource(db, vs, ctx, body, { appUrl }) {
  requireViasocket(vs)
  if (!/^https:\/\//.test(appUrl || '')) throw new AppError(409, 'needs_public_url', 'Evidence collection needs the app’s public https address (APP_URL), so viaSocket can deliver events to it.')
  const c = requireApp(body?.app)
  const conn = await requireActiveConnection(db, vs, ctx, body?.connectionId, { slug: c.app, app: c.label })
  const value = v.text(body?.scope?.value, 'Scope', { required: true, max: 300 })
  // The scope must be one of the live options of this connection — never a typed id (no reaching into others' data).
  const { options } = await scopeOptions(db, vs, ctx, { app: c.app, connectionId: conn.id, search: undefined })
  const hit = options.find((o) => o.value === value)
  if (!hit) throw invalid(`Choose one of the options your ${c.label} account offers.`)
  let sheet = null
  let sheetLabel = null
  if (c.subPick) {
    sheet = v.text(body?.scope?.sheet, 'Sheet', { required: true, max: 120 })
    const subOpts = (await scopeOptions(db, vs, ctx, { app: c.app, connectionId: conn.id, parent: value })).options
    const sh = subOpts.find((o) => o.value === sheet)
    if (!sh) throw invalid('Choose one of the sheets in that spreadsheet.')
    sheetLabel = sh.label
  }
  const { scope, label } = c.scopeFrom({ value, label: hit.label, sheet, sheetLabel, branch: v.text(body?.scope?.branch, 'Branch', { max: 120 }) })
  const scopeError = c.validateScope?.(scope)
  if (scopeError) throw invalid(scopeError)
  const kinds = (Array.isArray(body?.kinds) && body.kinds.length ? body.kinds : c.defaultKinds).map(String)
  for (const k of kinds) if (!c.kinds[k]) throw invalid(`Unknown ${c.label} event kind: ${k}.`)
  const dup = db.prepare(`SELECT 1 FROM evidence_sources WHERE org_id = ? AND owner_id = ? AND app = ? AND scope_json = ? AND status != 'DELETED'`).get(ctx.orgId, ctx.user.id, c.app, JSON.stringify(scope))
  if (dup) throw conflict('You already collect from that scope.', 'source_exists')

  // The person's identity in this app, read from their own connection's label when it is one (email or login).
  identityFromConnection(db, ctx, c.app, conn.label)
  const id = uuid()
  const ts = now()
  db.prepare(`INSERT INTO evidence_sources (id, org_id, owner_id, app, connection_id, scope_json, scope_label, kinds_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
    .run(id, ctx.orgId, ctx.user.id, c.app, conn.id, JSON.stringify(scope), label, JSON.stringify(kinds), ts, ts)
  const authType = await vs.versions(conn.service_id).then((x) => x?.service?.auth_type || 'Auth2.0').catch(() => 'Auth2.0')
  const results = []
  for (const kind of kinds) {
    const t = c.kinds[kind]
    const inputData = t.input(scope)
    // 1. A real sample from this exact scope (read-only): proves the mapping before anything is switched on.
    let sample = null
    try { sample = await vs.sampleEvent(t.triggerId, conn.auth_id, authType, inputData) } catch (error) {
      results.push({ kind, status: 'failed', error: viasocketError(error, `read a sample ${c.label} event`).message }); syncRun(db, ctx.orgId, id, 'initial_sample', 'FAILED', { error: error.message }); continue
    }
    const hasSample = sample && typeof sample === 'object' && Object.keys(sample).length > 0
    if (hasSample) {
      const mapped = c.normalize(kind, sample, scope)
      if (mapped?.error) { results.push({ kind, status: 'unmapped', error: `TeamPulse could not read this ${c.label} event (${mapped.error}), so it was not switched on.` }); syncRun(db, ctx.orgId, id, 'initial_sample', 'FAILED', { error: mapped.error }); continue }
    }
    // 2. Subscribe the trigger on the person's own connection.
    const subId = uuid()
    const token = `tpv_${randomBytes(24).toString('base64url')}`
    const url = `${appUrl}/api/work-evidence/events/${subId}`
    const handler = `const res = await axios.post(${JSON.stringify(url)}, { event: context.req.body }, { headers: { authorization: ${JSON.stringify(`Bearer ${token}`)} } })
return res.data`
    let created
    try {
      created = await vs.subscribe(ctx.user.id, c.app, t.key, { authId: conn.auth_id, inputData, version: t.version, code: handler, description: `TeamPulse evidence: ${label} (${t.label})` })
    } catch (error) {
      results.push({ kind, status: 'failed', error: viasocketError(error, `switch on ${c.label} ${t.label}`).message }); syncRun(db, ctx.orgId, id, 'subscribe', 'FAILED', { error: error.message }); continue
    }
    console.log(`[viasocket] subscribed ${c.app} ${t.key} ${t.version} for user ${ctx.user.id} (evidence source ${id})`)
    db.prepare(`INSERT INTO evidence_subscriptions (id, org_id, source_id, kind, trigger_key, version, script_id, input_data, token_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
      .run(subId, ctx.orgId, id, kind, t.key, t.version, created?.scriptId || null, JSON.stringify(inputData), sha(token), ts, ts)
    syncRun(db, ctx.orgId, id, 'subscribe', 'SUCCEEDED')
    // 3. Initial sync: the sample is the latest real event of this scope; it is collected like any other.
    if (hasSample) {
      const out = acceptEvent(db, db.prepare('SELECT * FROM evidence_subscriptions WHERE id = ?').get(subId), sample, 'initial_sample')
      syncRun(db, ctx.orgId, id, 'initial_sample', out.status === 'failed' ? 'FAILED' : 'SUCCEEDED', { items: out.status === 'processed' ? 1 : 0 })
    }
    results.push({ kind, status: 'active', initialEvent: hasSample })
  }
  const active = results.filter((r) => r.status === 'active').length
  if (!active) db.prepare(`UPDATE evidence_sources SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`).run(results.map((r) => r.error).filter(Boolean).join(' · ').slice(0, 300) || 'Nothing could be switched on.', now(), id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'evidence_source.created', entityType: 'evidence_source', entityId: id, after: { app: c.app, scope: label, kinds: results } })
  return { source: present(db, db.prepare('SELECT * FROM evidence_sources WHERE id = ?').get(id)), results }
}

function requireOwnSource(db, ctx, id) {
  const s = db.prepare(`SELECT * FROM evidence_sources WHERE id = ? AND org_id = ? AND status != 'DELETED'`).get(v.id(id, 'Source', { required: true }), ctx.orgId)
  if (!s || (s.owner_id !== ctx.user.id && !isAdmin(ctx))) throw notFound('Source')
  return s
}

/** Pause (2), resume (1) or remove (0) every trigger flow of the source on viaSocket, then here. */
export async function setSourceStatus(db, vs, ctx, id, body) {
  const s = requireOwnSource(db, ctx, id)
  const to = v.oneOf(body?.status, 'Status', ['ACTIVE', 'PAUSED', 'DELETED'], { required: true })
  if (to === 'ACTIVE' && s.owner_id !== ctx.user.id) throw forbidden('Only its owner can resume collection.')
  requireViasocket(vs)
  for (const sub of db.prepare(`SELECT * FROM evidence_subscriptions WHERE source_id = ? AND status != 'DELETED' AND script_id IS NOT NULL`).all(s.id)) {
    try { await vs.setFlowStatus(s.owner_id, sub.script_id, to === 'ACTIVE' ? 1 : to === 'PAUSED' ? 2 : 0) } catch (error) { throw viasocketError(error, 'change the collection') }
  }
  transaction(db, () => {
    db.prepare(`UPDATE evidence_subscriptions SET status = ?, updated_at = ? WHERE source_id = ? AND status != 'DELETED'`).run(to, now(), s.id)
    db.prepare('UPDATE evidence_sources SET status = ?, last_error = NULL, consecutive_errors = 0, updated_at = ? WHERE id = ?').run(to, now(), s.id)
  })
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `evidence_source.${to.toLowerCase()}`, entityType: 'evidence_source', entityId: s.id, before: { status: s.status } })
  return { status: to }
}

/** When a connection is disconnected, its sources stop and say why. */
export function stopSourcesForConnection(db, connectionId) {
  db.prepare(`UPDATE evidence_sources SET status = 'NEEDS_RECONNECT', last_error = 'The connected account was disconnected.', updated_at = ? WHERE connection_id = ? AND status IN ('ACTIVE','PAUSED')`).run(now(), connectionId)
}

/**
 * Health check (scheduled, at most hourly per source): the connection still exists on viaSocket and is not expired.
 * Read-only; one listConnections call per owner per run.
 */
export async function checkSourceHealth(db, vs, { maxOwners = 50 } = {}) {
  if (!vs?.configured) return { checked: 0 }
  const due = new Date(Date.now() - 3600000).toISOString()
  const rows = db.prepare(`SELECT s.*, c.auth_id FROM evidence_sources s LEFT JOIN app_connections c ON c.id = s.connection_id WHERE s.status IN ('ACTIVE','NEEDS_RECONNECT') AND (s.last_health_at IS NULL OR s.last_health_at < ?)`).all(due)
  const byOwner = new Map()
  for (const r of rows) byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) || []), r])
  let checked = 0
  for (const [owner, list] of [...byOwner].slice(0, maxOwners)) {
    let live
    try { live = await vs.listConnections(owner) } catch (error) {
      for (const s of list) { db.prepare('UPDATE evidence_sources SET last_health_at = ?, last_error = ? WHERE id = ?').run(now(), `Health check: ${String(error.message).slice(0, 200)}`, s.id); syncRun(db, s.org_id, s.id, 'health', 'FAILED', { error: error.message }) }
      continue
    }
    for (const s of list) {
      const c = s.auth_id && live.find((x) => x.id === s.auth_id)
      const ok = Boolean(c && !c.isExpired)
      const status = ok ? (s.status === 'NEEDS_RECONNECT' && c ? 'ACTIVE' : s.status) : 'NEEDS_RECONNECT'
      db.prepare('UPDATE evidence_sources SET status = ?, last_health_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, now(), ok ? s.last_error : (c ? 'The connection has expired. Reconnect it in the Automation Center.' : 'The connection no longer exists on viaSocket.'), now(), s.id)
      syncRun(db, s.org_id, s.id, 'health', ok ? 'SUCCEEDED' : 'FAILED', { error: ok ? null : 'connection missing or expired' })
      checked++
    }
  }
  return { checked }
}

// ---------- identities ----------
function identityFromConnection(db, ctx, app, label) {
  const raw = String(label || '').trim().toLowerCase()
  const value = app === 'github' ? raw.replace(/^@/, '') : raw
  if (!value || !IDENTITY_RE[app] || app === 'slack' || !IDENTITY_RE[app].test(value)) return
  if (db.prepare('SELECT 1 FROM external_identities WHERE org_id = ? AND app = ? AND identity = ?').get(ctx.orgId, app, value)) return
  db.prepare(`INSERT INTO external_identities (id, org_id, user_id, app, identity, source, created_at) VALUES (?, ?, ?, ?, ?, 'connection', ?)`).run(uuid(), ctx.orgId, ctx.user.id, app, value, now())
}

export function listIdentities(db, ctx, userId = ctx.user.id) {
  if (userId !== ctx.user.id && !(isAdmin(ctx) || (ctx.role === 'manager' && scopeUserIds(db, ctx).includes(userId)))) throw notFound('Person')
  return db.prepare('SELECT id, app, identity, source, created_at FROM external_identities WHERE org_id = ? AND user_id = ? ORDER BY app').all(ctx.orgId, userId)
    .map((r) => ({ id: r.id, app: r.app, identity: r.identity, source: r.source, createdAt: r.created_at }))
}

const IDENTITY_RE = { github: /^[a-z0-9](?:[a-z0-9-]{0,38})$/i, slack: /^[UW][A-Z0-9]{6,20}$/, gmail: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'google-calendar': /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'google-sheets': /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }
/** Declares "this is me" in an app. One owner per identity in the organization; a claimed identity cannot be taken. */
export function addIdentity(db, ctx, body) {
  const app = requireApp(body?.app).app
  const raw = v.text(body?.identity, 'Identity', { required: true, max: 200 })
  const identity = app === 'slack' ? raw.toUpperCase() : raw.toLowerCase()
  if (!IDENTITY_RE[app].test(identity)) throw invalid(app === 'github' ? 'Enter your GitHub username.' : app === 'slack' ? 'Choose your Slack user (an id like U0123ABCD).' : 'Enter an email address.')
  const taken = db.prepare('SELECT user_id FROM external_identities WHERE org_id = ? AND app = ? AND identity = ?').get(ctx.orgId, app, app === 'slack' ? identity : identity)
  if (taken && taken.user_id !== ctx.user.id) throw conflict('Someone in your organization already uses that identity. Ask your manager if it is yours.', 'identity_taken')
  if (taken) return listIdentities(db, ctx)
  const memberEmail = identity.includes('@') && db.prepare(`SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? AND lower(u.email) = ? AND u.id != ?`).get(ctx.orgId, identity, ctx.user.id)
  if (memberEmail) throw conflict('That email belongs to another member of your organization.', 'identity_taken')
  db.prepare(`INSERT INTO external_identities (id, org_id, user_id, app, identity, source, created_at) VALUES (?, ?, ?, ?, ?, 'declared', ?)`).run(uuid(), ctx.orgId, ctx.user.id, app, app === 'slack' ? identity : identity, now())
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'identity.declared', entityType: 'external_identity', entityId: null, after: { app, identity } })
  reattribute(db, ctx.orgId, app, identity)
  return listIdentities(db, ctx)
}

export function removeIdentity(db, ctx, id) {
  const r = db.prepare('SELECT * FROM external_identities WHERE id = ? AND org_id = ? AND user_id = ?').get(String(id), ctx.orgId, ctx.user.id)
  if (!r) throw notFound('Identity')
  db.prepare('DELETE FROM external_identities WHERE id = ?').run(r.id)
  // Evidence attributed through it becomes unknown again (never silently kept as theirs).
  db.prepare(`UPDATE external_evidence SET actor_user_id = NULL, attribution = 'unknown', updated_at = ? WHERE org_id = ? AND app = ? AND lower(actor_identity) = ? AND attribution IN ('self','member') AND actor_user_id = ?`).run(now(), ctx.orgId, r.app, r.identity.toLowerCase(), ctx.user.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'identity.removed', entityType: 'external_identity', entityId: r.id, before: { app: r.app, identity: r.identity } })
  return listIdentities(db, ctx)
}

/** Evidence with this identity and no owner yet gets one (never overrides a disputed or already attributed row). */
function reattribute(db, orgId, app, identity) {
  const user = db.prepare('SELECT user_id FROM external_identities WHERE org_id = ? AND app = ? AND identity = ?').get(orgId, app, identity)?.user_id
  if (!user) return
  for (const e of db.prepare(`SELECT id, collector_id FROM external_evidence WHERE org_id = ? AND app = ? AND lower(actor_identity) = lower(?) AND attribution = 'unknown'`).all(orgId, app, identity)) {
    db.prepare('UPDATE external_evidence SET actor_user_id = ?, attribution = ?, updated_at = ? WHERE id = ?').run(user, user === e.collector_id ? 'self' : 'member', now(), e.id)
  }
}

export { json }

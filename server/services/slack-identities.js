// Slack user id → KONVO person, per organization (external_identities, app = 'slack').
// A person may declare their own Slack id, but a declaration is only a claim: tasks are assigned through a Slack tag
// only when a manager confirmed the mapping (mapped_by). Display names are never used to find a person.
import { now, uuid, json } from '../db.js'
import { conflict, forbidden, invalid, notFound } from '../errors.js'
import { isActiveMember, isAdmin, isStaff, scopeUserIds } from '../access.js'
import * as v from '../validate.js'
import { audit } from './audit.js'

export const SLACK_ID_RE = /^[UW][A-Z0-9]{6,20}$/
export const WORKSPACE_RE = /^[A-Z0-9]{6,20}$/

/** { userId, trusted, reason } for a tagged Slack user. Only trusted === true may become an assignee. */
export function resolveSlackUser(db, orgId, slackUserId, workspaceId = null) {
  const row = db.prepare(`SELECT * FROM external_identities WHERE org_id = ? AND app = 'slack' AND identity = ?`).get(orgId, String(slackUserId || '').toUpperCase())
  if (!row) return { userId: null, trusted: false, reason: 'unmapped' }
  if (!row.mapped_by) return { userId: row.user_id, trusted: false, reason: 'unconfirmed' }
  if (row.workspace_id && workspaceId && row.workspace_id !== workspaceId) return { userId: row.user_id, trusted: false, reason: 'workspace_mismatch' }
  if (!isActiveMember(db, orgId, row.user_id)) return { userId: row.user_id, trusted: false, reason: 'inactive' }
  return { userId: row.user_id, trusted: true, reason: null }
}

function requireMapper(ctx) {
  if (!isStaff(ctx)) throw forbidden('Only managers and admins can map Slack identities.')
}

const present = (r) => ({ id: r.id, userId: r.user_id, name: r.name, email: r.email, slackUserId: r.identity, workspaceId: r.workspace_id, confirmed: Boolean(r.mapped_by), confirmedByName: r.mapper_name ?? null, source: r.source, createdAt: r.created_at })

/** Map (or confirm a person's own claim of) a Slack id. A manager can only map people in their scope. */
export function mapSlackIdentity(db, ctx, body) {
  requireMapper(ctx)
  const userId = v.id(body?.userId, 'Person', { required: true })
  const slackUserId = v.text(body?.slackUserId, 'Slack user id', { required: true, max: 30 }).toUpperCase()
  if (!SLACK_ID_RE.test(slackUserId)) throw invalid('That is not a Slack user id. It looks like U0123ABCD.', { field: 'slackUserId' })
  const workspaceId = body?.workspaceId ? v.text(body.workspaceId, 'Slack workspace id', { max: 30 }).toUpperCase() : null
  if (workspaceId && !WORKSPACE_RE.test(workspaceId)) throw invalid('That is not a Slack workspace id. It looks like T0123ABCD.', { field: 'workspaceId' })
  if (!isActiveMember(db, ctx.orgId, userId)) throw notFound('Person')
  if (!isAdmin(ctx) && !scopeUserIds(db, ctx).includes(userId)) throw forbidden('You can map Slack identities only for people in your teams.')
  const ts = now()
  const existing = db.prepare(`SELECT * FROM external_identities WHERE org_id = ? AND app = 'slack' AND identity = ?`).get(ctx.orgId, slackUserId)
  let id
  if (existing) {
    if (existing.user_id !== userId && existing.mapped_by) throw conflict('That Slack user is already mapped to someone else. Remove that mapping first.', 'identity_taken')
    id = existing.id
    // Either confirming this person's own claim, or replacing an unconfirmed claim by someone else.
    db.prepare('UPDATE external_identities SET user_id = ?, mapped_by = ?, workspace_id = ? WHERE id = ?').run(userId, ctx.user.id, workspaceId ?? existing.workspace_id, id)
  } else {
    id = uuid()
    db.prepare(`INSERT INTO external_identities (id, org_id, user_id, app, identity, source, mapped_by, workspace_id, created_at) VALUES (?, ?, ?, 'slack', ?, 'declared', ?, ?, ?)`).run(id, ctx.orgId, userId, slackUserId, ctx.user.id, workspaceId, ts)
  }
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'slack_identity.mapped', entityType: 'external_identity', entityId: id, before: existing ? { userId: existing.user_id, confirmed: Boolean(existing.mapped_by) } : null, after: { userId, slackUserId, workspaceId } })
  return { id, confirmed: true }
}

export function removeSlackIdentity(db, ctx, id) {
  requireMapper(ctx)
  const r = db.prepare(`SELECT * FROM external_identities WHERE id = ? AND org_id = ? AND app = 'slack'`).get(v.id(id, 'Mapping', { required: true }), ctx.orgId)
  if (!r) throw notFound('Mapping')
  if (!isAdmin(ctx) && !scopeUserIds(db, ctx).includes(r.user_id)) throw notFound('Mapping')
  db.prepare('DELETE FROM external_identities WHERE id = ?').run(r.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'slack_identity.removed', entityType: 'external_identity', entityId: r.id, before: { userId: r.user_id, slackUserId: r.identity } })
  return { removed: true }
}

/** Mappings in this manager's scope, and Slack ids that were tagged in task messages but cannot be used yet. */
export function listSlackIdentities(db, ctx) {
  requireMapper(ctx)
  const people = isAdmin(ctx) ? null : scopeUserIds(db, ctx)
  const rows = db.prepare(`SELECT e.*, u.name, u.email, m.name AS mapper_name FROM external_identities e JOIN users u ON u.id = e.user_id LEFT JOIN users m ON m.id = e.mapped_by WHERE e.org_id = ? AND e.app = 'slack' ORDER BY u.name`).all(ctx.orgId)
    .filter((r) => !people || people.includes(r.user_id)).map(present)
  const seen = new Map()
  for (const item of db.prepare(`SELECT mentions, text, created_at, workspace_id FROM slack_intake_items WHERE org_id = ? ORDER BY created_at DESC LIMIT 500`).all(ctx.orgId)) {
    for (const id of json(item.mentions, [])) {
      if (seen.has(id)) { seen.get(id).count++; continue }
      const r = resolveSlackUser(db, ctx.orgId, id, item.workspace_id)
      if (!r.trusted) seen.set(id, { slackUserId: id, reason: r.reason, claimedByName: r.userId ? db.prepare('SELECT name FROM users WHERE id = ?').get(r.userId)?.name ?? null : null, claimedByUserId: r.userId, lastSeenAt: item.created_at, count: 1 })
    }
  }
  return { mappings: rows, unresolved: [...seen.values()] }
}

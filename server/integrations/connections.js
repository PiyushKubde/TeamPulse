// A user's connected apps (https://viasocket.com/docs/skill/connect.md). auth_id and script_id never leave the server.
import { now, transaction, uuid } from '../db.js'
import { AppError, notFound } from '../errors.js'
import { requireCurated, curatedApps } from './apps.js'
import { requireViasocket, viasocketError } from './errors.js'

const AUTH_ID_RE = /^[A-Za-z0-9_]{3,120}$/

function present(row, live) {
  return {
    id: row.id, app: row.app_slug, label: row.label, createdAt: row.created_at,
    status: live === undefined ? 'unknown' : !live ? 'missing' : live.isExpired ? 'expired' : 'active'
  }
}

/** The per-user embed token and the curated apps' service ids, for the Connect popup and the embed. */
export async function embedToken(vs, userId, slugs = []) {
  requireViasocket(vs)
  try {
    const token = await vs.token(userId)
    const serviceIds = {}
    for (const s of slugs) { requireCurated(s); serviceIds[s] = await vs.serviceIdFor(s) }
    return { token, serviceIds }
  } catch (error) {
    throw viasocketError(error, 'prepare your connection')
  }
}

export async function listConnections(db, vs, ctx) {
  const rows = db.prepare('SELECT * FROM app_connections WHERE user_id = ? AND org_id = ? ORDER BY created_at DESC').all(ctx.user.id, ctx.orgId)
  const apps = await curatedApps(vs)
  if (!vs.configured || !rows.length) return { configured: vs.configured, apps, connections: rows.map((r) => present(r)), live: false }
  try {
    const live = await vs.listConnections(ctx.user.id)
    const byId = new Map(live.map((c) => [c.id, c]))
    return { configured: true, apps, connections: rows.map((r) => present(r, byId.get(r.auth_id) || null)), live: true }
  } catch (error) {
    return { configured: true, apps, connections: rows.map((r) => present(r)), live: false, error: viasocketError(error, 'read your connections').message }
  }
}

/** Saves what the Connect popup produced, after checking with viaSocket that this user really owns that connection. */
export async function saveConnection(db, vs, ctx, body) {
  requireViasocket(vs)
  const app = requireCurated(String(body?.app || ''))
  const authId = body?.authId
  if (typeof authId !== 'string' || !AUTH_ID_RE.test(authId)) throw new AppError(400, 'validation_failed', 'Not a valid connection id.')
  let live
  let serviceId
  try {
    serviceId = await vs.serviceIdFor(app.slug)
    live = await vs.listConnections(ctx.user.id)
  } catch (error) {
    throw viasocketError(error, 'check the new connection')
  }
  const match = live.find((c) => c.id === authId)
  if (!match) throw new AppError(403, 'connection_not_yours', 'ViaSocket has no such connection for your account, so it was not saved.')
  if (match.service_id && match.service_id !== serviceId) throw new AppError(400, 'connection_app_mismatch', 'That connection belongs to a different app.')
  const label = typeof match.connection_label === 'string' ? match.connection_label.replace(/[{}"]/g, '').slice(0, 120) : null
  const ts = now()
  db.prepare(`INSERT INTO app_connections (id, org_id, user_id, app_slug, service_id, auth_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, auth_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`)
    .run(uuid(), ctx.orgId, ctx.user.id, app.slug, serviceId, authId, label, ts, ts)
  return present(db.prepare('SELECT * FROM app_connections WHERE user_id = ? AND auth_id = ?').get(ctx.user.id, authId), match)
}

export function requireOwnConnection(db, ctx, id, slug) {
  const row = db.prepare('SELECT * FROM app_connections WHERE id = ? AND user_id = ? AND org_id = ?').get(String(id || ''), ctx.user.id, ctx.orgId)
  if (!row) throw notFound('Connection')
  if (slug && row.app_slug !== slug) throw new AppError(400, 'wrong_app', `Choose a connected ${slug} account.`)
  return row
}

export async function reconnectDetails(db, vs, ctx, id) {
  requireViasocket(vs)
  const row = requireOwnConnection(db, ctx, id)
  const { token } = await embedToken(vs, ctx.user.id)
  return { token, serviceId: row.service_id, authId: row.auth_id, app: row.app_slug }
}

/** Pauses the flows TeamPulse enabled on it, revokes it on viaSocket, then forgets it. Automations using it need setup again. */
export async function disconnect(db, vs, ctx, id) {
  requireViasocket(vs)
  const row = requireOwnConnection(db, ctx, id)
  let stillThere = false
  try {
    const live = await vs.listConnections(ctx.user.id)
    stillThere = live.some((c) => c.id === row.auth_id)
    if (stillThere) {
      for (const { script_id } of db.prepare('SELECT script_id FROM enabled_apps WHERE user_id = ? AND auth_id = ?').all(ctx.user.id, row.auth_id)) await vs.setFlowStatus(ctx.user.id, script_id, 2)
      await vs.revokeConnection(ctx.user.id, row.auth_id)
    }
  } catch (error) {
    throw viasocketError(error, 'disconnect this account')
  }
  transaction(db, () => {
    db.prepare('DELETE FROM enabled_apps WHERE user_id = ? AND auth_id = ?').run(ctx.user.id, row.auth_id)
    db.prepare('DELETE FROM app_connections WHERE id = ?').run(row.id)
    for (const w of db.prepare(`SELECT * FROM automation_workflows WHERE org_id = ? AND owner_id = ?`).all(ctx.orgId, ctx.user.id)) {
      const cfg = JSON.parse(w.config || '{}')
      if (cfg.connectionId === row.id) db.prepare(`UPDATE automation_workflows SET status = 'NEEDS_SETUP', last_error = 'The connected account was disconnected.', updated_at = ? WHERE id = ?`).run(now(), w.id)
    }
  })
  return { disconnected: true, revokedOnViasocket: stillThere }
}

// ---------- Embed builder flows (prebuilt UI) ----------
/** Records a flow the user published/paused/deleted in the embed, read back from viaSocket (never trusted from the browser). */
export async function syncEmbedFlow(db, vs, ctx, flowId) {
  requireViasocket(vs)
  if (typeof flowId !== 'string' || !/^[A-Za-z0-9_-]{3,80}$/.test(flowId)) throw new AppError(400, 'validation_failed', 'Not a valid flow id.')
  let flows
  try { flows = await vs.listFlows(ctx.user.id) } catch (error) { throw viasocketError(error, 'read your automations') }
  const flow = flows.find((f) => f.id === flowId)
  const ts = now()
  if (!flow || flow.status === 'deleted') {
    db.prepare('DELETE FROM embed_flows WHERE user_id = ? AND flow_id = ?').run(ctx.user.id, flowId)
    return { flowId, status: 'deleted' }
  }
  db.prepare(`INSERT INTO embed_flows (org_id, user_id, flow_id, title, status, last_action, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, flow_id) DO UPDATE SET title = excluded.title, status = excluded.status, last_action = excluded.last_action, updated_at = excluded.updated_at`)
    .run(ctx.orgId, ctx.user.id, flowId, String(flow.title || flow.name || '').slice(0, 200) || null, String(flow.status || 'unknown'), 'sync', ts)
  return { flowId, status: flow.status, title: flow.title || null }
}

export function listEmbedFlows(db, ctx) {
  return db.prepare('SELECT flow_id, title, status, updated_at FROM embed_flows WHERE user_id = ? AND org_id = ? ORDER BY updated_at DESC').all(ctx.user.id, ctx.orgId)
    .map((f) => ({ flowId: f.flow_id, title: f.title, status: f.status, updatedAt: f.updated_at }))
}

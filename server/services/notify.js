// In-app notifications. Always written; external alerts (M91) are layered on top in services/alerts.js.
import { now, uuid } from '../db.js'

/** Creates one notification unless the same dedupe key was already used. Returns the id, or null if a duplicate. */
export function notifyInApp(db, { orgId, userId, kind, title, body = null, link = null, taskId = null, dedupeKey }) {
  const id = uuid()
  const r = db.prepare(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, link, task_id, dedupe_key, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(id, orgId, userId, kind, String(title).slice(0, 200), body ? String(body).slice(0, 1000) : null, link, taskId, dedupeKey || `${kind}:${id}`, now())
  return r.changes ? id : null
}

export function listNotifications(db, ctx, { unreadOnly = false, limit = 50 } = {}) {
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND org_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(ctx.user.id, ctx.orgId, limit)
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND org_id = ? AND read_at IS NULL').get(ctx.user.id, ctx.orgId).n
  return {
    unread,
    notifications: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, taskId: r.task_id, read: Boolean(r.read_at), createdAt: r.created_at }))
  }
}

export function markRead(db, ctx, ids) {
  const ts = now()
  if (ids === 'all') return db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(ts, ctx.user.id).changes
  let n = 0
  for (const id of ids) n += db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(ts, id, ctx.user.id).changes
  return n
}

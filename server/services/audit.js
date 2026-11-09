import { now, uuid } from '../db.js'

/** Records a sensitive operation. before/after are stored as JSON for the audit history. */
export function audit(db, { orgId, actorId, action, entityType, entityId, before, after }) {
  db.prepare(`INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id, before_json, after_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), orgId ?? null, actorId ?? null, action, entityType, entityId ?? null,
      before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), now())
}

export function listAudit(db, orgId, { entityType, limit = 100 } = {}) {
  const rows = entityType
    ? db.prepare(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? AND a.entity_type = ? ORDER BY a.created_at DESC LIMIT ?`).all(orgId, entityType, limit)
    : db.prepare(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT ?`).all(orgId, limit)
  return rows.map((r) => ({
    id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, actor: r.actor_name,
    before: r.before_json ? JSON.parse(r.before_json) : null, after: r.after_json ? JSON.parse(r.after_json) : null, createdAt: r.created_at
  }))
}

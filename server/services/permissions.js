// Per-employee task permissions, set by their manager (or an admin). Every change is audited.
import { now } from '../db.js'
import { forbidden, invalid, notFound } from '../errors.js'
import { PERMISSION_KEYS, employeePermissions, isAdmin, requireManager, scopeUserIds } from '../access.js'
import * as v from '../validate.js'
import { audit } from './audit.js'

export function listPermissions(db, ctx) {
  requireManager(ctx)
  const scope = new Set(scopeUserIds(db, ctx))
  return db.prepare(`SELECT m.user_id, u.name, u.email, t.name AS team_name FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN teams t ON t.id = m.team_id
                     WHERE m.org_id = ? AND m.role = 'employee' AND m.status = 'active' ORDER BY u.name`).all(ctx.orgId)
    .filter((r) => scope.has(r.user_id))
    .map((r) => ({ userId: r.user_id, name: r.name, email: r.email, teamName: r.team_name, permissions: employeePermissions(db, ctx.orgId, r.user_id) }))
}

export function updatePermissions(db, ctx, userId, body) {
  requireManager(ctx)
  v.id(userId, 'Employee', { required: true })
  const m = db.prepare(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`).get(ctx.orgId, userId)
  if (!m) throw notFound('Employee')
  if (m.role !== 'employee') throw invalid('Permissions apply to employees; managers and admins already have them.')
  if (!isAdmin(ctx) && !scopeUserIds(db, ctx).includes(userId)) throw forbidden('You can change permissions only for employees in teams you manage.')
  const before = employeePermissions(db, ctx.orgId, userId)
  const after = { ...before }
  for (const k of PERMISSION_KEYS) if (body?.[k] !== undefined) after[k] = v.bool(body[k], k)
  // Direct creation implies creation; assigning is never implied by creating.
  if (after.can_create_directly && !after.can_create_tasks) after.can_create_tasks = true
  const changed = PERMISSION_KEYS.filter((k) => before[k] !== after[k])
  if (!changed.length) return { permissions: before, changed: [] }
  db.prepare(`INSERT INTO employee_permissions (org_id, user_id, can_create_tasks, can_create_directly, can_self_assign, can_assign_others, approval_required, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (org_id, user_id) DO UPDATE SET can_create_tasks = excluded.can_create_tasks, can_create_directly = excluded.can_create_directly,
                can_self_assign = excluded.can_self_assign, can_assign_others = excluded.can_assign_others, approval_required = excluded.approval_required,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(ctx.orgId, userId, ...PERMISSION_KEYS.map((k) => (after[k] ? 1 : 0)), ctx.user.id, now())
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'permissions.updated', entityType: 'employee_permissions', entityId: userId,
    before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) })
  return { permissions: after, changed }
}

/** How a task created by this context is handled: directly, or as a request for approval. */
export function creationMode(ctx) {
  const p = ctx.permissions
  if (ctx.role !== 'employee') return 'direct'
  if (p.can_create_tasks && p.can_create_directly && !p.approval_required) return 'direct'
  return 'request'
}

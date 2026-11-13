// Who may see and do what. Every route builds a context from the session on the server; nothing about role,
// organization or permissions is taken from the browser. Records outside a user's scope answer 404.
import { now } from './db.js'
import { forbidden, notFound } from './errors.js'

export const PERMISSION_KEYS = ['can_create_tasks', 'can_create_directly', 'can_self_assign', 'can_assign_others', 'approval_required']
const DEFAULT_PERMISSIONS = { can_create_tasks: false, can_create_directly: false, can_self_assign: false, can_assign_others: false, approval_required: true }

export function employeePermissions(db, orgId, userId) {
  const row = db.prepare('SELECT * FROM employee_permissions WHERE org_id = ? AND user_id = ?').get(orgId, userId)
  if (!row) return { ...DEFAULT_PERMISSIONS }
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, Boolean(row[k])]))
}

/** The signed-in user's organization context, or null membership when they have not joined one. */
export function loadContext(db, user) {
  const m = db.prepare(`SELECT m.*, o.name AS org_name FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ?`).get(user.id)
  if (!m || m.status !== 'active') return { user, membership: null, deactivated: Boolean(m) }
  // Admins have org-wide access, but also load their directly managed teams for the Manager experience.
  const managedTeamIds = (m.role === 'manager' || m.role === 'admin')
    ? db.prepare('SELECT id FROM teams WHERE org_id = ? AND manager_id = ?').all(m.org_id, user.id).map((r) => r.id)
    : []
  const ctx = {
    user,
    orgId: m.org_id,
    orgName: m.org_name,
    role: m.role,
    teamId: m.team_id,
    managedTeamIds,
    membership: m,
    permissions: m.role === 'employee' ? employeePermissions(db, m.org_id, user.id) : { can_create_tasks: true, can_create_directly: true, can_self_assign: true, can_assign_others: true, approval_required: false }
  }
  return ctx
}

export const isAdmin = (ctx) => ctx.role === 'admin'
export const isManager = (ctx) => ctx.role === 'manager' || ctx.role === 'admin'

export function requireManager(ctx) {
  if (!isManager(ctx)) throw forbidden('Only managers and admins can do that.')
}
export function requireAdmin(ctx) {
  if (!isAdmin(ctx)) throw forbidden('Only organization admins can do that.')
}

/** User ids this context may see as people: admin → whole org; manager → their teams' members + self; employee → self. */
export function scopeUserIds(db, ctx) {
  if (isAdmin(ctx)) return db.prepare(`SELECT user_id FROM memberships WHERE org_id = ?`).all(ctx.orgId).map((r) => r.user_id)
  if (ctx.role === 'manager') {
    const ids = new Set([ctx.user.id])
    if (ctx.managedTeamIds.length) {
      const ph = ctx.managedTeamIds.map(() => '?').join(',')
      for (const r of db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND team_id IN (${ph})`).all(ctx.orgId, ...ctx.managedTeamIds)) ids.add(r.user_id)
    }
    return [...ids]
  }
  return [ctx.user.id]
}

/** Members of the same org this context may assign work to (respecting employee permissions). */
export function assignableUserIds(db, ctx) {
  if (isManager(ctx)) {
    return scopeUserIds(db, ctx).filter((id) => isActiveMember(db, ctx.orgId, id))
  }
  const ids = []
  if (ctx.permissions.can_self_assign) ids.push(ctx.user.id)
  if (ctx.permissions.can_assign_others && ctx.teamId) {
    for (const r of db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND team_id = ? AND status = 'active' AND user_id != ?`).all(ctx.orgId, ctx.teamId, ctx.user.id)) ids.push(r.user_id)
  }
  return ids
}

export function isActiveMember(db, orgId, userId) {
  return Boolean(db.prepare(`SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`).get(orgId, userId))
}

/** SQL (alias t) restricting tasks to what this context may see. */
export function taskScopeSql(ctx, alias = 't') {
  if (isAdmin(ctx)) return { sql: `${alias}.org_id = ?`, params: [ctx.orgId] }
  // Whoever proposed or was proposed a transfer of a task can see that task (so the proposed owner can decide).
  const transfer = ` OR EXISTS (SELECT 1 FROM task_transfers x WHERE x.task_id = ${alias}.id AND x.org_id = ? AND (x.to_user_id = ? OR x.from_user_id = ?))`
  const transferParams = [ctx.orgId, ctx.user.id, ctx.user.id]
  if (ctx.role === 'manager') {
    const ph = ctx.managedTeamIds.map(() => '?').join(',')
    const teamClause = ctx.managedTeamIds.length
      ? ` OR ${alias}.team_id IN (${ph}) OR ${alias}.assignee_id IN (SELECT user_id FROM memberships WHERE org_id = ? AND team_id IN (${ph}))`
      : ''
    return {
      sql: `${alias}.org_id = ? AND (${alias}.created_by = ? OR ${alias}.assignee_id = ?${teamClause}${transfer})`,
      params: [ctx.orgId, ctx.user.id, ctx.user.id, ...(ctx.managedTeamIds.length ? [...ctx.managedTeamIds, ctx.orgId, ...ctx.managedTeamIds] : []), ...transferParams]
    }
  }
  return { sql: `${alias}.org_id = ? AND (${alias}.assignee_id = ? OR ${alias}.created_by = ?${transfer})`, params: [ctx.orgId, ctx.user.id, ctx.user.id, ...transferParams] }
}

/** The task if this context may see it; another org's task or one out of scope answers 404 (existence not revealed). */
export function requireVisibleTask(db, ctx, taskId) {
  const scope = taskScopeSql(ctx)
  const task = typeof taskId === 'string' ? db.prepare(`SELECT t.* FROM tasks t WHERE t.id = ? AND ${scope.sql}`).get(taskId, ...scope.params) : null
  if (!task) throw notFound('Task')
  return task
}

/** Managers manage tasks in their scope; admins manage every task of the org. */
export function canManageTask(db, ctx, task) {
  if (task.org_id !== ctx.orgId) return false
  if (isAdmin(ctx)) return true
  if (ctx.role !== 'manager') return false
  if (task.created_by === ctx.user.id) return true
  if (task.team_id && ctx.managedTeamIds.includes(task.team_id)) return true
  if (task.assignee_id && scopeUserIds(db, ctx).includes(task.assignee_id) && task.assignee_id !== ctx.user.id) return true
  return false
}

export function requireManageTask(db, ctx, task) {
  if (!canManageTask(db, ctx, task)) throw forbidden('Only the task’s manager can do that.')
}

/** The managers (and admins) who should hear about a task: the team's manager, or every admin when it has none. */
export function managersForTask(db, task) {
  const ids = new Set()
  if (task.team_id) {
    const team = db.prepare('SELECT manager_id FROM teams WHERE id = ?').get(task.team_id)
    if (team?.manager_id) ids.add(team.manager_id)
  }
  if (!ids.size && task.assignee_id) {
    const m = db.prepare(`SELECT t.manager_id FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND m.org_id = ?`).get(task.assignee_id, task.org_id)
    if (m?.manager_id) ids.add(m.manager_id)
  }
  if (!ids.size) for (const r of db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'`).all(task.org_id)) ids.add(r.user_id)
  return [...ids]
}

export const stamp = now

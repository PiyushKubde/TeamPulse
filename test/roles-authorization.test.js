// The three roles are enforced by the server, not by the navigation.
//   employee: their own work.  manager: the work of the people in the teams they manage.  admin: running the organization.
// An admin is NOT a manager: no authority over people's work unless explicitly assigned to manage a team (teams.manager_id).
import test from 'node:test'
import assert from 'node:assert/strict'
import { startApp, seedOrg, adminManages } from './helpers.js'

async function boot() {
  const t = await startApp()
  const s = seedOrg(t.db)
  const made = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Platform task', assigneeId: s.employee.id } })
  assert.equal(made.status, 201)
  const taskId = made.body.task.id
  const other = await t.call('/api/tasks', { method: 'POST', as: s.manager2, body: { title: 'Sales task', assigneeId: s.outsider.id } })
  assert.equal(other.status, 201)
  const status = async (path, as, opts = {}) => (await t.call(path, { as, ...opts })).status
  return { t, s, taskId, otherTaskId: other.body.task.id, status }
}

// Endpoints that are about authority over people's work. Employees: never. Admins: only through a team they are assigned to manage.
const MANAGER_ONLY = ['/api/reports/status?from=2026-01-01', '/api/reports/workload', '/api/contribution/team', '/api/analytics/team', '/api/slack-intake/overview', '/api/signals?scope=team']
// Endpoints that are about running the organization. Employees: never. Managers: never (or only for their own teams, see below).
const ADMIN_ONLY = ['/api/admin/system']

test('employee: own work only — every manager and admin endpoint refuses', async () => {
  const { t, s, taskId, otherTaskId, status } = await boot()
  try {
    for (const p of [...MANAGER_ONLY, ...ADMIN_ONLY, '/api/permissions', '/api/invitations', '/api/join-requests', '/api/audit']) assert.equal(await status(p, s.employee), 403, p)
    for (const [p, body] of [['/api/teams', { name: 'Mine' }], ['/api/invitations', { email: 'x@example.com', role: 'employee' }]]) assert.equal(await status(p, s.employee, { method: 'POST', body }), 403, p)
    assert.equal(await status(`/api/members/${s.employee2.id}`, s.employee, { method: 'PATCH', body: { role: 'manager' } }), 403)
    assert.equal(await status(`/api/members/${s.employee.id}`, s.employee, { method: 'PATCH', body: { role: 'admin' } }), 403, 'cannot promote yourself')
    assert.equal(await status('/api/organization', s.employee, { method: 'PATCH', body: { name: 'Mine' } }), 403)
    assert.equal(await status(`/api/permissions/${s.employee.id}`, s.employee, { method: 'PATCH', body: { can_create_tasks: true } }), 403, 'cannot grant yourself permissions')
    // Their own work and history are theirs.
    assert.equal(await status(`/api/tasks/${taskId}`, s.employee), 200)
    assert.equal(await status(`/api/tasks/${taskId}/assessment`, s.employee), 200)
    assert.equal(await status(`/api/contribution/people/${s.employee.id}`, s.employee), 200)
    // …and nobody else's.
    assert.equal(await status(`/api/tasks/${otherTaskId}`, s.employee), 404)
    assert.equal(await status(`/api/contribution/people/${s.employee2.id}`, s.employee), 404)
    assert.equal(await status(`/api/tasks/${taskId}/assessment/review`, s.employee, { method: 'POST', body: { action: 'APPROVE' } }), 403, 'cannot review an assessment, even their own')
    assert.equal(await status('/api/assessments/backlog', s.employee), 403)
    assert.equal(await status('/api/assessments/backlog/start', s.employee, { method: 'POST', body: {} }), 403)
  } finally { await t.close() }
})

test('manager: the team’s work, assignments, reviews and verification — and not administration', async () => {
  const { t, s, taskId, otherTaskId, status } = await boot()
  try {
    for (const p of ['/api/reports/status?from=2026-01-01', '/api/reports/workload', '/api/contribution/team', '/api/analytics/team', '/api/slack-intake/overview', '/api/permissions', '/api/members', '/api/signals?scope=team']) assert.equal(await status(p, s.manager), 200, p)
    assert.equal(await status(`/api/tasks/${taskId}`, s.manager), 200)
    assert.equal(await status(`/api/contribution/people/${s.employee.id}`, s.manager), 200)
    assert.equal(await status('/api/assessments/backlog', s.manager), 200)
    // Not another team’s work (404, not 403: it does not exist for them).
    assert.equal(await status(`/api/tasks/${otherTaskId}`, s.manager), 404)
    assert.equal(await status(`/api/tasks/${otherTaskId}/assessment`, s.manager), 404)
    assert.equal(await status(`/api/contribution/people/${s.outsider.id}`, s.manager), 404)
    assert.equal(await status(`/api/tasks/${otherTaskId}/assessment/review`, s.manager, { method: 'POST', body: { action: 'APPROVE' } }), 404)
    // Not administration of the organization, its integrations or its system settings.
    assert.equal(await status('/api/admin/system', s.manager), 403)
    assert.equal(await status('/api/organization', s.manager, { method: 'PATCH', body: { name: 'Mine' } }), 403)
    assert.equal(await status('/api/organization/join-code', s.manager, { method: 'POST' }), 403)
    assert.equal(await status('/api/teams', s.manager, { method: 'POST', body: { name: 'Shadow' } }), 403)
    assert.equal(await status(`/api/members/${s.employee.id}`, s.manager, { method: 'PATCH', body: { role: 'admin' } }), 403, 'cannot make anyone an admin')
    assert.equal(await status(`/api/members/${s.manager.id}`, s.manager, { method: 'PATCH', body: { role: 'admin' } }), 403, 'cannot promote themselves')
  } finally { await t.close() }
})

test('admin is not a manager: runs the organization, has no authority over people’s work', async () => {
  const { t, s, taskId, otherTaskId, status } = await boot()
  try {
    // Administration: yes.
    for (const p of ['/api/admin/system', '/api/members', '/api/invitations', '/api/teams', '/api/permissions', '/api/audit', '/api/organization']) assert.equal(await status(p, s.admin), 200, p)
    const perms = await t.call('/api/permissions', { as: s.admin })
    assert.ok(perms.body.some((x) => x.name === 'Eve Employee') && perms.body.some((x) => x.name === 'Olly Sales'), 'an admin sets permissions for every employee in the organization, across teams')
    assert.equal(await status('/api/teams', s.admin, { method: 'POST', body: { name: 'Design' } }), 200)
    assert.equal(await status(`/api/permissions/${s.employee.id}`, s.admin, { method: 'PATCH', body: { can_create_tasks: true } }), 200)
    // The organization’s first team has no manager: the admin is not made one.
    assert.equal(t.db.prepare('SELECT manager_id FROM teams WHERE id = ?').get(s.leadershipTeam).manager_id, null)
    // Authority over work: no. Not reports, not team intelligence, not people’s tasks, assessments, profiles, reviews or verification.
    for (const p of MANAGER_ONLY) assert.equal(await status(p, s.admin), 403, p)
    for (const id of [taskId, otherTaskId]) {
      assert.equal(await status(`/api/tasks/${id}`, s.admin), 404, 'task')
      assert.equal(await status(`/api/tasks/${id}/assessment`, s.admin), 404, 'assessment')
      assert.ok([403, 404].includes(await status(`/api/tasks/${id}/assessment/review`, s.admin, { method: 'POST', body: { action: 'APPROVE' } })), 'review is refused')
      assert.ok([403, 404].includes(await status(`/api/tasks/${id}/assessment/analyse`, s.admin, { method: 'POST' })), 'assessment run is refused')
    }
    assert.equal(await status(`/api/contribution/people/${s.employee.id}`, s.admin), 404)
    assert.equal(await status(`/api/analytics/person/${s.employee.id}`, s.admin), 404)
    assert.equal(await status('/api/assessments/backlog', s.admin), 403)
    assert.equal(await status('/api/assessments/backlog/start', s.admin, { method: 'POST', body: {} }), 403)
    assert.equal(await status('/api/tasks', s.admin, { method: 'POST', body: { title: 'Direct', assigneeId: s.employee.id } }), 403, 'cannot assign work to people they do not manage')
    assert.equal((await t.call('/api/tasks?view=team', { as: s.admin })).body.length ?? 0, 0)
    // An employee’s contribution record is not an admin’s to read or verify either.
    const rec = await t.call('/api/impact', { method: 'POST', as: s.employee, body: { title: 'Mentored two new joiners through onboarding', summary: 'Ran four sessions and wrote the checklist they use.', impactType: 'PEOPLE', contributedOn: new Date().toISOString().slice(0, 10) } })
    if (rec.status === 201) {
      const id = rec.body.id || rec.body.record?.id
      assert.equal(await status(`/api/impact/${id}`, s.admin), 404)
      assert.equal(await status(`/api/impact/${id}/verification`, s.admin, { method: 'POST', body: { verificationStatus: 'VERIFIED', note: 'ok' } }), 404)
      assert.equal(await status(`/api/impact/${id}/verification`, s.manager, { method: 'POST', body: { verificationStatus: 'VERIFIED', note: 'ok' } }) < 500, true)
    }
  } finally { await t.close() }
})

test('admin acts as a manager only through an explicit team assignment, and only for that team', async () => {
  const { t, s, taskId, otherTaskId, status } = await boot()
  try {
    adminManages(t.db, s.admin, s.teamA) // the explicit, authorized assignment (an admin does this in Teams & members)
    for (const p of ['/api/reports/workload', '/api/contribution/team', '/api/analytics/team']) assert.equal(await status(p, s.admin), 200, p)
    assert.equal(await status(`/api/tasks/${taskId}`, s.admin), 200)
    assert.equal(await status(`/api/tasks/${taskId}/assessment`, s.admin), 200)
    assert.equal(await status(`/api/contribution/people/${s.employee.id}`, s.admin), 200)
    // Only that team: nothing of the other team, even though they are the organization’s admin.
    assert.equal(await status(`/api/tasks/${otherTaskId}`, s.admin), 404)
    assert.equal(await status(`/api/contribution/people/${s.outsider.id}`, s.admin), 404)
    assert.equal(await status(`/api/tasks/${otherTaskId}/assessment/review`, s.admin, { method: 'POST', body: { action: 'APPROVE' } }), 404)
    // The former manager of that team no longer has authority over it.
    assert.equal(await status(`/api/contribution/people/${s.employee.id}`, s.manager), 404)
    // Someone else’s authorization is not borrowed: a manager cannot assign themselves as another team’s manager.
    assert.equal(await status(`/api/teams/${s.teamB}`, s.manager, { method: 'PATCH', body: { managerId: s.manager.id } }), 403)
    // Unassigned again → the authority is gone.
    adminManages(t.db, { id: null }, s.teamA)
    assert.equal(await status('/api/contribution/team', s.admin), 403)
  } finally { await t.close() }
})

test('other organizations see nothing, whatever their role', async () => {
  const { t, s, taskId, status } = await boot()
  try {
    for (const p of [`/api/tasks/${taskId}`, `/api/tasks/${taskId}/assessment`, `/api/contribution/people/${s.employee.id}`, `/api/analytics/person/${s.employee.id}`]) assert.equal(await status(p, s.otherAdmin), 404, p)
    assert.equal(await status(`/api/members/${s.employee.id}`, s.otherAdmin, { method: 'PATCH', body: { role: 'manager' } }) >= 400, true)
    assert.equal(await status(`/api/permissions/${s.employee.id}`, s.otherAdmin, { method: 'PATCH', body: { can_create_tasks: true } }), 404)
  } finally { await t.close() }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, makeUser, seedOrg } from './helpers.js'

test('a new user creates an organization and becomes its admin', async () => {
  const t = await startApp()
  try {
    const u = makeUser(t.db, { name: 'Founder' })
    const r = await t.call('/api/organizations', { method: 'POST', as: u, body: { name: 'New Co' } })
    assert.equal(r.status, 200)
    const s = await t.call('/api/session', { as: u })
    assert.equal(s.body.membership.role, 'admin')
    const again = await t.call('/api/organizations', { method: 'POST', as: u, body: { name: 'Second' } })
    assert.equal(again.status, 409)
  } finally { await t.close() }
})

test('invitation: only the invited, Google-verified email can accept; role comes from the invitation', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'newbie@example.com', role: 'employee' } })
    assert.equal(inv.status, 200)
    assert.match(inv.body.link, /#\/invite\//)
    // Managers cannot invite managers or admins.
    assert.equal((await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'boss@example.com', role: 'admin' } })).status, 403)

    const wrong = makeUser(t.db, { name: 'Wrong', email: 'someone@example.com' })
    const seen = await t.call(`/api/onboarding?inviteToken=${inv.body.token}`, { as: wrong })
    assert.equal(seen.body.invitations[0].emailMatches, false)
    const denied = await t.call(`/api/invitations/${inv.body.id}/accept`, { method: 'POST', as: wrong })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'invitation_email_mismatch')

    const right = makeUser(t.db, { name: 'Newbie', email: 'newbie@example.com' })
    const listed = await t.call('/api/onboarding', { as: right })
    assert.equal(listed.body.invitations.length, 1, 'found by verified email without the link')
    const ok = await t.call(`/api/invitations/${inv.body.id}/accept`, { method: 'POST', as: right })
    assert.equal(ok.status, 200)
    const sess = await t.call('/api/session', { as: right })
    assert.equal(sess.body.membership.role, 'employee')
    assert.equal(sess.body.membership.teamId, s.teamA)
  } finally { await t.close() }
})

test('join by code needs approval; nobody gets a role from their email domain', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const org = await t.call('/api/organization', { as: s.admin })
    const sameDomain = makeUser(t.db, { name: 'Same Domain', email: 'ceo@example.com' })
    assert.equal((await t.call('/api/session', { as: sameDomain })).body.membership, null)
    const req = await t.call('/api/join-requests', { method: 'POST', as: sameDomain, body: { joinCode: org.body.joinCode, message: 'Hi' } })
    assert.equal(req.status, 200)
    assert.equal((await t.call('/api/tasks', { as: sameDomain })).status, 403, 'still no access while pending')
    const employeesSeeCode = await t.call('/api/organization', { as: s.employee })
    assert.equal(employeesSeeCode.body.joinCode, null)
    const list = await t.call('/api/join-requests', { as: s.manager })
    assert.equal(list.body.length, 1)
    // A manager cannot grant admin.
    assert.equal((await t.call(`/api/join-requests/${req.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'approve', role: 'admin' } })).status, 403)
    const ok = await t.call(`/api/join-requests/${req.body.id}/decision`, { method: 'POST', as: s.manager, body: { decision: 'approve' } })
    assert.equal(ok.body.role, 'employee')
    assert.equal(ok.body.teamId, s.teamA)
  } finally { await t.close() }
})

test('admin role management: last admin protected; deactivation ends sessions and access', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    assert.equal((await t.call(`/api/members/${s.admin.id}`, { method: 'PATCH', as: s.admin, body: { role: 'manager' } })).status, 409)
    assert.equal((await t.call(`/api/members/${s.employee.id}`, { method: 'PATCH', as: s.manager, body: { role: 'admin' } })).status, 403)
    const r = await t.call(`/api/members/${s.employee2.id}`, { method: 'PATCH', as: s.admin, body: { status: 'deactivated' } })
    assert.equal(r.status, 200)
    assert.equal((await t.call('/api/tasks', { as: s.employee2 })).status, 401)
    const audit = await t.call('/api/audit', { as: s.admin })
    assert.ok(audit.body.some((a) => a.action === 'member.updated'))
  } finally { await t.close() }
})

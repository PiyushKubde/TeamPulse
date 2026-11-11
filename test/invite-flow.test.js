// Tests for: invitation acceptance flow, admin+manager permissions, AI employee management tools
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, makeUser, seedOrg, addTeam, addMember } from './helpers.js'
import { createOrganization } from '../server/services/orgs.js'
import { randomToken } from '../server/auth/sessions.js'

// ───────────────────── Invitation flow ─────────────────────

test('GET /api/invite/:token returns valid info for a pending invitation', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'jane@example.com', role: 'employee' } })
    assert.equal(inv.status, 200)
    const info = await t.call(`/api/invite/${inv.body.token}`)
    assert.equal(info.status, 200)
    assert.equal(info.body.valid, true)
    assert.equal(info.body.email, 'jane@example.com')
    assert.equal(info.body.role, 'employee')
    assert.equal(info.body.orgName, 'Acme')
    assert.equal(info.body.hasAccount, false, 'new invitee has no account')
  } finally { await t.close() }
})

test('GET /api/invite/:token reports hasAccount=true for existing verified users', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Create an account for the invitee first
    makeUser(t.db, { name: 'Existing Jane', email: 'jane@example.com' })
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'jane@example.com', role: 'employee' } })
    const info = await t.call(`/api/invite/${inv.body.token}`)
    assert.equal(info.body.valid, true)
    assert.equal(info.body.hasAccount, true)
  } finally { await t.close() }
})

test('GET /api/invite/:token returns valid=false for unknown tokens', async () => {
  const t = await startApp()
  try {
    const r = await t.call('/api/invite/not-a-real-token-at-all-xyz')
    assert.equal(r.status, 200)
    assert.equal(r.body.valid, false)
    assert.equal(r.body.reason, 'invalid')
  } finally { await t.close() }
})

test('POST /auth/register-and-accept: new user registers and joins in one step', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'newjane@example.com', role: 'employee' } })
    assert.equal(inv.status, 200)
    const reg = await t.call('/auth/register-and-accept', {
      method: 'POST',
      body: { name: 'Jane New', password: 'CorrectHorseBatteryStaple!1', confirmPassword: 'CorrectHorseBatteryStaple!1', inviteToken: inv.body.token }
    })
    assert.equal(reg.status, 200, reg.text)
    assert.ok(reg.cookie, 'session cookie set')
    // Session reflects membership
    const sess = await t.call('/api/session', { headers: { cookie: reg.cookie } })
    assert.equal(sess.body.membership.role, 'employee')
    assert.equal(sess.body.user.email, 'newjane@example.com')
    // Invitation is now accepted
    const inv2 = t.db.prepare(`SELECT status FROM invitations WHERE id = ?`).get(inv.body.id)
    assert.equal(inv2.status, 'accepted')
  } finally { await t.close() }
})

test('POST /auth/register-and-accept: does not create org, goes straight to workspace', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'alice@example.com', role: 'employee' } })
    const reg = await t.call('/auth/register-and-accept', {
      method: 'POST',
      body: { name: 'Alice', password: 'CorrectHorseBatteryStaple!1', confirmPassword: 'CorrectHorseBatteryStaple!1', inviteToken: inv.body.token }
    })
    assert.equal(reg.status, 200)
    // No org-creation flow: session has a membership immediately
    const sess = await t.call('/api/session', { headers: { cookie: reg.cookie } })
    assert.ok(sess.body.membership, 'has membership without going through onboarding')
    assert.equal(sess.body.membership.orgId, s.org.id)
  } finally { await t.close() }
})

test('POST /auth/register-and-accept: rejects mismatched password', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'bob@example.com', role: 'employee' } })
    const r = await t.call('/auth/register-and-accept', {
      method: 'POST',
      body: { name: 'Bob', password: 'CorrectHorseBatteryStaple!1', confirmPassword: 'DifferentPassword!2', inviteToken: inv.body.token }
    })
    assert.ok(r.status >= 400, `should fail, got ${r.status}`)
  } finally { await t.close() }
})

test('POST /auth/register-and-accept: rejects if account with that email already exists', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    makeUser(t.db, { name: 'Existing Bob', email: 'bob@example.com' })
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'bob@example.com', role: 'employee' } })
    const r = await t.call('/auth/register-and-accept', {
      method: 'POST',
      body: { name: 'Bob Dup', password: 'CorrectHorseBatteryStaple!1', confirmPassword: 'CorrectHorseBatteryStaple!1', inviteToken: inv.body.token }
    })
    assert.ok(r.status >= 400, `duplicate account should be rejected, got ${r.status}`)
  } finally { await t.close() }
})

test('POST /auth/register-and-accept: rejects expired invitation', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'carol@example.com', role: 'employee' } })
    // Expire the invitation
    t.db.prepare(`UPDATE invitations SET expires_at = 1 WHERE id = ?`).run(inv.body.id)
    const r = await t.call('/auth/register-and-accept', {
      method: 'POST',
      body: { name: 'Carol', password: 'CorrectHorseBatteryStaple!1', confirmPassword: 'CorrectHorseBatteryStaple!1', inviteToken: inv.body.token }
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'invitation_invalid')
  } finally { await t.close() }
})

test('existing user signed in with matching email can accept via /api/invitations/:id/accept', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'dan@example.com', role: 'employee' } })
    const user = makeUser(t.db, { name: 'Dan', email: 'dan@example.com' })
    const ok = await t.call(`/api/invitations/${inv.body.id}/accept`, { method: 'POST', as: user })
    assert.equal(ok.status, 200, ok.text)
    const sess = await t.call('/api/session', { as: user })
    assert.equal(sess.body.membership.role, 'employee')
  } finally { await t.close() }
})

test('wrong-email user cannot accept an invitation (email mismatch)', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'right@example.com', role: 'employee' } })
    const wrong = makeUser(t.db, { name: 'Wrong', email: 'wrong@example.com' })
    const denied = await t.call(`/api/invitations/${inv.body.id}/accept`, { method: 'POST', as: wrong })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'invitation_email_mismatch')
  } finally { await t.close() }
})

// ───────────────────── Admin + Manager permissions ─────────────────────

test('admin set as team manager_id gets managedTeamIds populated', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Set the admin as manager_id of teamA
    t.db.prepare('UPDATE teams SET manager_id = ? WHERE id = ?').run(s.admin.id, s.teamA)
    const sess = await t.call('/api/session', { as: s.admin })
    assert.ok(sess.body.membership.managedTeamIds.includes(s.teamA), 'admin should have teamA in managedTeamIds')
  } finally { await t.close() }
})

test('admin can access manager-only contribution intelligence endpoint', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Admin can access manager-only team intelligence
    const r = await t.call('/api/contribution/team', { as: s.admin })
    assert.equal(r.status, 200, 'admin can access manager contribution/team endpoint')
  } finally { await t.close() }
})

test('admin without managed team still gets Manager Copilot access', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Admin has no teams managed
    const r = await t.call('/api/assistant/copilot', { method: 'POST', as: s.admin, body: { question: 'What is the team doing?' } })
    assert.notEqual(r.status, 403, 'admin should not get 403 on copilot')
  } finally { await t.close() }
})

// ───────────────────── AI employee management tools ─────────────────────

test('manager copilot: find_employee returns matched org member', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: `find employee ${s.employee.email}` } })
    assert.equal(r.status, 200, r.text)
    const { intent, items } = r.body
    assert.equal(intent, 'find_employee')
    assert.ok(items.some((i) => i.email === s.employee.email), 'found by email')
  } finally { await t.close() }
})

test('manager copilot: team_members lists employees in managed team', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: 'who is in my team?' } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.intent, 'team_members')
    assert.ok(r.body.items.length >= 2, 'at least two members in teamA')
  } finally { await t.close() }
})

test('manager copilot: org_teams lists all teams', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: 'what teams exist in the organization?' } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.intent, 'org_teams')
    assert.ok(r.body.items.length >= 2, 'at least Platform and Sales teams')
  } finally { await t.close() }
})

test('manager copilot: add_to_team returns pending confirmation before executing', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: `add ${s.employee.email} to my team` } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.intent, 'add_to_team')
    // Should return a pending confirmation or "already in team" — not an executed action
    const noExecution = !r.body.extra?.executed
    assert.ok(noExecution, 'must not execute without confirmation')
    // No membership change should have happened without confirmation
    const m = t.db.prepare(`SELECT team_id FROM memberships WHERE user_id = ? AND org_id = ?`).get(s.employee.id, s.org.id)
    assert.equal(m.team_id, s.teamA, 'team not changed without confirmation')
  } finally { await t.close() }
})

test('manager copilot: add_to_team executes when confirmed', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Admin confirms adding outsider to teamA
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.admin, body: { team: true, question: `add ${s.outsider.email} to team`, confirmed: true, action: 'add_to_team', userId: s.outsider.id, teamId: s.teamA } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.executed, true, 'executed flag should be in the response')
    const m = t.db.prepare(`SELECT team_id FROM memberships WHERE user_id = ? AND org_id = ?`).get(s.outsider.id, s.org.id)
    assert.equal(m.team_id, s.teamA, 'outsider moved to teamA after confirmed add')
  } finally { await t.close() }
})

test('manager copilot: remove_from_team returns pending confirmation before executing', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: `remove employee ${s.employee.email} from team` } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.intent, 'remove_from_team')
    assert.equal(r.body.pendingConfirmation, true, 'must ask for confirmation')
    // No change without confirmation
    const m = t.db.prepare(`SELECT team_id FROM memberships WHERE user_id = ? AND org_id = ?`).get(s.employee.id, s.org.id)
    assert.equal(m.team_id, s.teamA, 'team not changed without confirmation')
  } finally { await t.close() }
})

test('manager copilot: remove_from_team executes when confirmed', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: 'remove from team', confirmed: true, action: 'remove_from_team', userId: s.employee.id } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.executed, true, 'executed flag should be in the response')
    const m = t.db.prepare(`SELECT team_id FROM memberships WHERE user_id = ? AND org_id = ?`).get(s.employee.id, s.org.id)
    assert.equal(m.team_id, null, 'employee removed from team after confirmation')
  } finally { await t.close() }
})

test('employee cannot use team copilot', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.employee, body: { team: true, question: 'who is on my team?' } })
    assert.equal(r.status, 403)
  } finally { await t.close() }
})

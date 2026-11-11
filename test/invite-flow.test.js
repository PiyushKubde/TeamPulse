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
    // hasAccount is not returned to unauthenticated callers (privacy fix)
    assert.equal(info.body.hasAccount, undefined, 'unauthenticated callers must not learn account existence')
  } finally { await t.close() }
})

test('GET /api/invite/:token does not reveal hasAccount to unauthenticated callers even when account exists', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    makeUser(t.db, { name: 'Existing Jane', email: 'jane@example.com' })
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'jane@example.com', role: 'employee' } })
    const info = await t.call(`/api/invite/${inv.body.token}`)
    assert.equal(info.body.valid, true)
    assert.equal(info.body.hasAccount, undefined, 'account existence must not be revealed to unauthenticated callers')
  } finally { await t.close() }
})

test('GET /api/invite/:token returns hasAccount=true when authenticated with matching email', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const existingUser = makeUser(t.db, { name: 'Existing Jane', email: 'jane@example.com' })
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'jane@example.com', role: 'employee' } })
    // Authenticated as the invited user — their own hasAccount is revealed
    const info = await t.call(`/api/invite/${inv.body.token}`, { as: existingUser })
    assert.equal(info.body.valid, true)
    assert.equal(info.body.hasAccount, true, 'authenticated matching-email caller sees hasAccount')
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

test('manager copilot: add_to_team executes when confirmed with server token', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Step 1: get pendingConfirmation with a server-issued confirmToken (teamId required when multiple teams exist)
    const r1 = await t.call('/api/assistant/ask', { method: 'POST', as: s.admin, body: { team: true, question: `add ${s.outsider.email} to team`, teamId: s.teamA } })
    assert.equal(r1.status, 200, r1.text)
    assert.equal(r1.body.pendingConfirmation, true)
    assert.ok(r1.body.confirmToken, 'confirmToken must be returned')
    // Step 2: execute with the token (no userId/teamId in the body — server resolves from token)
    const r2 = await t.call('/api/assistant/ask', { method: 'POST', as: s.admin, body: { team: true, intent: 'add_to_team', confirmToken: r1.body.confirmToken } })
    assert.equal(r2.status, 200, r2.text)
    assert.equal(r2.body.executed, true, 'executed flag should be in the response')
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

test('manager copilot: remove_from_team executes when confirmed with server token', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Step 1: get pendingConfirmation with a server-issued confirmToken
    const r1 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: `remove employee ${s.employee.email} from team` } })
    assert.equal(r1.status, 200, r1.text)
    assert.equal(r1.body.pendingConfirmation, true)
    assert.ok(r1.body.confirmToken, 'confirmToken must be returned')
    // Step 2: execute with the token
    const r2 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'remove_from_team', confirmToken: r1.body.confirmToken } })
    assert.equal(r2.status, 200, r2.text)
    assert.equal(r2.body.executed, true, 'executed flag should be in the response')
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

// ───────────────────── Confirmation token security ─────────────────────

test('confirmToken: expired token is rejected', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r1 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: `remove employee ${s.employee.email} from team` } })
    assert.ok(r1.body.confirmToken)
    // Tamper: use a fake token
    const r2 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'remove_from_team', confirmToken: 'not-a-real-token-at-all' } })
    assert.equal(r2.status, 200)
    assert.equal(r2.body.error, true, 'fake token must be rejected')
    // Real token still works (not consumed by fake attempt)
    const r3 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'remove_from_team', confirmToken: r1.body.confirmToken } })
    assert.equal(r3.body.executed, true, 'real token still valid')
  } finally { await t.close() }
})

test('confirmToken: token is single-use (cannot be reused)', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r1 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: `remove employee ${s.employee.email} from team` } })
    const token = r1.body.confirmToken
    assert.ok(token)
    // First use — succeeds
    const r2 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'remove_from_team', confirmToken: token } })
    assert.equal(r2.body.executed, true)
    // Second use with same token — rejected
    const r3 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'remove_from_team', confirmToken: token } })
    assert.equal(r3.body.error, true, 'reused token must be rejected')
  } finally { await t.close() }
})

test('confirmToken: cross-user token theft is rejected', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Manager gets a token for their operation
    const r1 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, question: `remove employee ${s.employee.email} from team` } })
    const token = r1.body.confirmToken
    assert.ok(token)
    // Admin tries to use the manager's token — different userId, must be rejected
    const r2 = await t.call('/api/assistant/ask', { method: 'POST', as: s.admin, body: { team: true, intent: 'remove_from_team', confirmToken: token } })
    assert.equal(r2.body.error, true, 'cross-user token theft must be rejected')
    // Manager can still use their own token
    const r3 = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'remove_from_team', confirmToken: token } })
    assert.equal(r3.body.executed, true)
  } finally { await t.close() }
})

test('confirmToken: confirmed: true alone is no longer accepted', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // Old insecure pattern: confirmed: true with client-supplied userId/teamId
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.admin, body: { team: true, intent: 'add_to_team', confirmed: true, action: 'add_to_team', userId: s.outsider.id, teamId: s.teamA } })
    assert.equal(r.status, 200)
    // Should NOT execute (no confirmToken supplied)
    assert.ok(!r.body.executed, 'confirmed: true alone must not execute the action')
    const m = t.db.prepare(`SELECT team_id FROM memberships WHERE user_id = ? AND org_id = ?`).get(s.outsider.id, s.org.id)
    assert.notEqual(m.team_id, s.teamA, 'membership must not change without a valid confirmToken')
  } finally { await t.close() }
})

// ───────────────────── Copilot invite-to-workspace ─────────────────────

test('add_to_team: returns notFound with email when employee not in org', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/assistant/ask', { method: 'POST', as: s.manager, body: { team: true, intent: 'add_to_team', question: 'Add unknown@external.com to my team' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.intent, 'add_to_team')
    assert.equal(r.body.notFound, true)
    assert.equal(r.body.email, 'unknown@external.com')
  } finally { await t.close() }
})

test('POST /api/invitations: manager can create invitation from copilot flow', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'newperson@example.com', role: 'employee' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.email, 'newperson@example.com')
    assert.ok(r.body.link, 'invitation link returned')
    assert.match(r.body.link, /#\/invite\//, 'link uses invite hash route')
  } finally { await t.close() }
})

test('POST /api/invitations: duplicate active invitation returns revoked + new (not error)', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r1 = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'dup@example.com', role: 'employee' } })
    assert.equal(r1.status, 200)
    // Second invite for same email revokes the first and issues a new one
    const r2 = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'dup@example.com', role: 'employee' } })
    assert.equal(r2.status, 200)
    assert.ok(r2.body.link, 'new invitation link returned')
    assert.notEqual(r2.body.id, r1.body.id, 'a new invitation was created')
  } finally { await t.close() }
})

test('POST /api/invitations: manager cannot invite outside their org scope', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // A manager with no managed team cannot invite
    const unassigned = makeUser(t.db, { name: 'Unassigned Mgr' })
    addMember(t.db, s.org.id, unassigned, 'manager', null)
    const r = await t.call('/api/invitations', { method: 'POST', as: unassigned, body: { email: 'outside@example.com', role: 'employee' } })
    assert.equal(r.status, 403)
  } finally { await t.close() }
})

test('POST /api/invitations: admin can invite org-wide', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/invitations', { method: 'POST', as: s.admin, body: { email: 'admin-invite@example.com', role: 'employee' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.email, 'admin-invite@example.com')
  } finally { await t.close() }
})

test('POST /api/invitations: cannot invite existing org member', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const r = await t.call('/api/invitations', { method: 'POST', as: s.admin, body: { email: s.employee.email, role: 'employee' } })
    assert.equal(r.status, 409)
  } finally { await t.close() }
})

test('POST /auth/register-and-accept: returns email_exists_sign_in when account exists', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    makeUser(t.db, { name: 'Existing Bob', email: 'bob@example.com' })
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'bob@example.com', role: 'employee' } })
    const r = await t.call('/auth/register-and-accept', {
      method: 'POST',
      body: { name: 'Bob Dup', password: 'CorrectHorseBatteryStaple!1', confirmPassword: 'CorrectHorseBatteryStaple!1', inviteToken: inv.body.token }
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'email_exists_sign_in')
  } finally { await t.close() }
})

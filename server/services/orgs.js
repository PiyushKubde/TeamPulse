// Organizations, teams, members, invitations and join requests.
import { randomBytes } from 'node:crypto'
import { now, transaction, uuid, json } from '../db.js'
import { AppError, conflict, forbidden, invalid, notFound } from '../errors.js'
import { isAdmin, isStaff, requireAdmin, requireStaff, scopeUserIds } from '../access.js'
import { randomToken, sha256 } from '../auth/sessions.js'
import * as v from '../validate.js'
import { audit } from './audit.js'
import { notifyInApp } from './notify.js'
import { DEFAULT_ALERT_SETTINGS } from './alert-rules.js'
import { orgTimezone, validTimezone, orgCalendar, validCalendar } from '../time.js'

const ROLES = ['admin', 'manager', 'employee']
const joinCode = () => randomBytes(5).toString('hex').toUpperCase()

export function orgSettings(db, orgId) {
  const row = db.prepare('SELECT settings FROM organizations WHERE id = ?').get(orgId)
  const s = json(row?.settings, {})
  return { ...s, alerts: { ...DEFAULT_ALERT_SETTINGS, ...(s.alerts || {}), thresholds: { ...DEFAULT_ALERT_SETTINGS.thresholds, ...(s.alerts?.thresholds || {}) }, rules: { ...DEFAULT_ALERT_SETTINGS.rules, ...(s.alerts?.rules || {}) } } }
}

/** A signed-in user without an organization creates one and becomes its first admin. */
export function createOrganization(db, user, body, { allowed = true } = {}) {
  if (!allowed) throw forbidden('Creating new organizations is turned off on this server. Ask an admin for an invitation.')
  const existing = db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(user.id)
  if (existing) throw conflict('You already belong to an organization.', 'already_member')
  const name = v.text(body?.name, 'Organization name', { required: true, min: 2, max: 120 })
  const teamName = v.text(body?.teamName, 'First team name', { max: 80 }) || 'General'
  const ts = now()
  const orgId = uuid()
  const teamId = uuid()
  transaction(db, () => {
    db.prepare('INSERT INTO organizations (id, name, join_code, settings, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(orgId, name, joinCode(), '{}', user.id, ts, ts)
    db.prepare('INSERT INTO teams (id, org_id, name, manager_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(teamId, orgId, teamName, null, ts, ts) // no manager yet: an admin becomes one only by being assigned
    db.prepare('INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuid(), orgId, user.id, 'admin', teamId, 'active', ts, ts)
    audit(db, { orgId, actorId: user.id, action: 'organization.created', entityType: 'organization', entityId: orgId, after: { name } })
  })
  return { id: orgId, name }
}

export function getOrganization(db, ctx) {
  const o = db.prepare('SELECT * FROM organizations WHERE id = ?').get(ctx.orgId)
  return {
    id: o.id, name: o.name, createdAt: o.created_at,
    // The join code lets people ask to join; it never grants access by itself (approval is required).
    joinCode: isStaff(ctx) ? o.join_code : null,
    intakeConfigured: Boolean(o.intake_token_hash),
    timezone: orgTimezone(db, ctx.orgId),
    workingCalendar: orgCalendar(db, ctx.orgId)
  }
}

export function updateOrganization(db, ctx, body) {
  requireAdmin(ctx)
  const before = getOrganization(db, ctx)
  const name = v.text(body?.name, 'Organization name', { required: true, min: 2, max: 120 })
  let timezone = before.timezone
  if (body?.timezone !== undefined) {
    if (!validTimezone(body.timezone)) throw invalid('Choose a valid timezone, for example Asia/Kolkata or America/New_York.', { field: 'timezone' })
    timezone = body.timezone
  }
  let workingCalendar = before.workingCalendar
  if (body?.workingCalendar !== undefined) {
    if (!validCalendar(body.workingCalendar)) throw invalid('Working calendar needs days (0-6), a start and an end time like 09:00 and 18:00.', { field: 'workingCalendar' })
    workingCalendar = { days: body.workingCalendar.days, start: body.workingCalendar.start, end: body.workingCalendar.end }
  }
  const settings = json(db.prepare('SELECT settings FROM organizations WHERE id = ?').get(ctx.orgId)?.settings, {})
  db.prepare('UPDATE organizations SET name = ?, settings = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify({ ...settings, timezone, workingCalendar }), now(), ctx.orgId)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'organization.updated', entityType: 'organization', entityId: ctx.orgId, before: { name: before.name, timezone: before.timezone }, after: { name, timezone } })
  return getOrganization(db, ctx)
}

export function rotateJoinCode(db, ctx) {
  requireAdmin(ctx)
  const code = joinCode()
  db.prepare('UPDATE organizations SET join_code = ?, updated_at = ? WHERE id = ?').run(code, now(), ctx.orgId)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'organization.join_code_rotated', entityType: 'organization', entityId: ctx.orgId })
  return { joinCode: code }
}

// ---------- teams ----------
export function listTeams(db, ctx) {
  const rows = db.prepare(`SELECT t.*, u.name AS manager_name, (SELECT COUNT(*) FROM memberships m WHERE m.team_id = t.id AND m.status = 'active') AS member_count
                           FROM teams t LEFT JOIN users u ON u.id = t.manager_id WHERE t.org_id = ? ORDER BY t.name`).all(ctx.orgId)
  return rows.map((t) => ({ id: t.id, name: t.name, managerId: t.manager_id, managerName: t.manager_name, memberCount: t.member_count, managedByMe: t.manager_id === ctx.user.id }))
}

function requireTeam(db, ctx, teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(teamId, ctx.orgId)
  if (!team) throw notFound('Team')
  return team
}

function checkManagerCandidate(db, ctx, managerId) {
  if (!managerId) return null
  v.id(managerId, 'Manager')
  const m = db.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`).get(ctx.orgId, managerId)
  if (!m) throw invalid('The team manager must be an active member of this organization.')
  if (!['manager', 'admin'].includes(m.role)) throw invalid('The team manager must have the Manager or Admin role.')
  return managerId
}

export function createTeam(db, ctx, body) {
  requireAdmin(ctx)
  const name = v.text(body?.name, 'Team name', { required: true, max: 80 })
  const managerId = checkManagerCandidate(db, ctx, body?.managerId)
  if (db.prepare('SELECT 1 FROM teams WHERE org_id = ? AND lower(name) = lower(?)').get(ctx.orgId, name)) throw conflict('A team with that name already exists.')
  const id = uuid()
  const ts = now()
  db.prepare('INSERT INTO teams (id, org_id, name, manager_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, ctx.orgId, name, managerId, ts, ts)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'team.created', entityType: 'team', entityId: id, after: { name, managerId } })
  return { id, name, managerId }
}

export function updateTeam(db, ctx, teamId, body) {
  requireAdmin(ctx)
  const team = requireTeam(db, ctx, teamId)
  const name = body?.name !== undefined ? v.text(body.name, 'Team name', { required: true, max: 80 }) : team.name
  const managerId = body?.managerId !== undefined ? checkManagerCandidate(db, ctx, body.managerId) : team.manager_id
  db.prepare('UPDATE teams SET name = ?, manager_id = ?, updated_at = ? WHERE id = ?').run(name, managerId, now(), team.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'team.updated', entityType: 'team', entityId: team.id, before: { name: team.name, managerId: team.manager_id }, after: { name, managerId } })
  return { id: team.id, name, managerId }
}

export function deleteTeam(db, ctx, teamId) {
  requireAdmin(ctx)
  const team = requireTeam(db, ctx, teamId)
  const members = db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE team_id = ? AND status = 'active'`).get(team.id).n
  if (members) throw conflict('Move this team’s members to another team before deleting it.', 'team_not_empty')
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'team.deleted', entityType: 'team', entityId: team.id, before: { name: team.name } })
  return { deleted: true }
}

// ---------- members ----------
export function listMembers(db, ctx, { includeInactive = false } = {}) {
  const visible = new Set(scopeUserIds(db, ctx))
  const rows = db.prepare(`SELECT m.*, u.name, u.email, u.picture_url, u.phone, u.last_login_at, t.name AS team_name
                           FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN teams t ON t.id = m.team_id
                           WHERE m.org_id = ? ${includeInactive ? '' : "AND m.status = 'active'"} ORDER BY u.name`).all(ctx.orgId)
  // Everyone can see the names of colleagues (for display); contact details only within scope.
  return rows.map((r) => ({
    userId: r.user_id, name: r.name, role: r.role, teamId: r.team_id, teamName: r.team_name, status: r.status, title: r.title,
    pictureUrl: r.picture_url, inScope: visible.has(r.user_id),
    email: visible.has(r.user_id) || isStaff(ctx) ? r.email : null,
    phone: isAdmin(ctx) || r.user_id === ctx.user.id ? r.phone : null,
    lastLoginAt: visible.has(r.user_id) ? r.last_login_at : null
  }))
}

export function updateMember(db, ctx, userId, body) {
  v.id(userId, 'Member')
  const m = db.prepare('SELECT * FROM memberships WHERE org_id = ? AND user_id = ?').get(ctx.orgId, userId)
  if (!m) throw notFound('Member')
  const changes = {}
  if (body?.role !== undefined) {
    requireAdmin(ctx)
    const role = String(body.role).toLowerCase()
    if (!ROLES.includes(role)) throw invalid('Role must be admin, manager or employee.')
    if (m.role === 'admin' && role !== 'admin') {
      const admins = db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'`).get(ctx.orgId).n
      if (admins <= 1) throw conflict('An organization needs at least one admin. Make someone else an admin first.', 'last_admin')
    }
    changes.role = role
  }
  if (body?.teamId !== undefined) {
    const teamId = body.teamId ? requireTeam(db, ctx, body.teamId).id : null
    if (!isAdmin(ctx)) {
      // Managers may move employees only between teams they manage.
      requireStaff(ctx)
      if (m.role !== 'employee' || !ctx.managedTeamIds.includes(m.team_id) || !teamId || !ctx.managedTeamIds.includes(teamId)) throw forbidden('Managers can only move employees between teams they manage.')
    }
    changes.team_id = teamId
  }
  if (body?.status !== undefined) {
    requireAdmin(ctx)
    const status = String(body.status)
    if (!['active', 'deactivated'].includes(status)) throw invalid('Status must be active or deactivated.')
    if (userId === ctx.user.id && status === 'deactivated') throw conflict('You cannot deactivate yourself.')
    if (status === 'deactivated' && m.role === 'admin') {
      const admins = db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'`).get(ctx.orgId).n
      if (admins <= 1) throw conflict('An organization needs at least one active admin.', 'last_admin')
    }
    changes.status = status
  }
  if (body?.title !== undefined) {
    if (!isStaff(ctx) && userId !== ctx.user.id) throw forbidden()
    changes.title = v.text(body.title, 'Title', { max: 80 })
  }
  if (!Object.keys(changes).length) throw invalid('Nothing to change.')
  const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ')
  transaction(db, () => {
    db.prepare(`UPDATE memberships SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(changes), now(), m.id)
    if (changes.status === 'deactivated') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    // A demoted manager stops managing teams.
    if (changes.role === 'employee') db.prepare('UPDATE teams SET manager_id = NULL, updated_at = ? WHERE org_id = ? AND manager_id = ?').run(now(), ctx.orgId, userId)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'member.updated', entityType: 'membership', entityId: userId, before: { role: m.role, team_id: m.team_id, status: m.status, title: m.title }, after: changes })
  })
  return { updated: true }
}

// ---------- invitations ----------
export function createInvitation(db, ctx, body, { appUrl = '' } = {}) {
  requireStaff(ctx)
  const email = v.email(body?.email)
  const role = String(body?.role || 'employee').toLowerCase()
  if (!ROLES.includes(role)) throw invalid('Role must be admin, manager or employee.')
  if (!isAdmin(ctx) && role !== 'employee') throw forbidden('Managers can invite employees only. Ask an admin to invite managers or admins.')
  let teamId = body?.teamId ? requireTeam(db, ctx, v.id(body.teamId, 'Team')).id : null
  if (!isAdmin(ctx)) {
    if (!teamId) teamId = ctx.managedTeamIds[0] || null
    if (!teamId || !ctx.managedTeamIds.includes(teamId)) throw forbidden('Managers can invite people only into teams they manage.')
  }
  const member = db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = ?`).get(email)
  if (member) throw conflict('That person already belongs to an organization.', 'already_member')
  const token = randomToken()
  const id = uuid()
  const ts = now()
  transaction(db, () => {
    db.prepare(`UPDATE invitations SET status = 'revoked', updated_at = ? WHERE org_id = ? AND lower(email) = ? AND status = 'pending'`).run(ts, ctx.orgId, email)
    db.prepare(`INSERT INTO invitations (id, org_id, email, role, team_id, token_hash, invited_by, status, expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, ctx.orgId, email, role, teamId, sha256(token), ctx.user.id, new Date(Date.now() + 14 * 86400000).toISOString(), ts, ts)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'invitation.created', entityType: 'invitation', entityId: id, after: { email, role, teamId } })
  })
  return { id, email, role, teamId, link: `${appUrl}/#/invite/${token}`, token }
}

export function listInvitations(db, ctx) {
  requireStaff(ctx)
  return db.prepare(`SELECT i.*, t.name AS team_name, u.name AS invited_by_name FROM invitations i LEFT JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.invited_by
                     WHERE i.org_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`).all(ctx.orgId)
    .filter((i) => isAdmin(ctx) || ctx.managedTeamIds.includes(i.team_id))
    .map((i) => ({ id: i.id, email: i.email, role: i.role, teamId: i.team_id, teamName: i.team_name, invitedBy: i.invited_by_name, expiresAt: i.expires_at, expired: i.expires_at < now(), createdAt: i.created_at }))
}

export function revokeInvitation(db, ctx, id) {
  requireStaff(ctx)
  const i = db.prepare(`SELECT * FROM invitations WHERE id = ? AND org_id = ? AND status = 'pending'`).get(v.id(id, 'Invitation', { required: true }), ctx.orgId)
  if (!i || (!isAdmin(ctx) && !ctx.managedTeamIds.includes(i.team_id))) throw notFound('Invitation')
  db.prepare(`UPDATE invitations SET status = 'revoked', updated_at = ? WHERE id = ?`).run(now(), i.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'invitation.revoked', entityType: 'invitation', entityId: i.id, before: { email: i.email } })
  return { revoked: true }
}

/** Pending invitations for a signed-in user without an org: by token, or matching their Google-verified email. */
export function invitationsFor(db, user, token) {
  const rows = []
  if (token) {
    const byToken = db.prepare(`SELECT i.*, o.name AS org_name FROM invitations i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash = ? AND i.status = 'pending'`).get(sha256(String(token)))
    if (byToken) rows.push(byToken)
  }
  if (user.email_verified) {
    for (const r of db.prepare(`SELECT i.*, o.name AS org_name FROM invitations i JOIN organizations o ON o.id = i.org_id WHERE lower(i.email) = ? AND i.status = 'pending'`).all(user.email.toLowerCase())) {
      if (!rows.some((x) => x.id === r.id)) rows.push(r)
    }
  }
  return rows.filter((r) => r.expires_at > now()).map((r) => ({
    id: r.id, orgName: r.org_name, role: r.role, email: r.email,
    emailMatches: user.email_verified && r.email.toLowerCase() === user.email.toLowerCase()
  }))
}

/** Look up a pending invitation by token (public — no auth required). Returns null when not found/expired. */
export function getInvitationByToken(db, token) {
  if (!token || typeof token !== 'string') return null
  const i = db.prepare(`SELECT i.*, o.name AS org_name, u.name AS invited_by_name FROM invitations i JOIN organizations o ON o.id = i.org_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ? AND i.status = 'pending'`).get(sha256(token))
  if (!i || i.expires_at < now()) return null
  return { id: i.id, email: i.email, role: i.role, orgName: i.org_name, invitedBy: i.invited_by_name, teamId: i.team_id, expiresAt: i.expires_at }
}

/** Accepting requires the invitation's email to equal the user's verified email. */
export function acceptInvitation(db, user, invitationId) {
  if (db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(user.id)) throw conflict('You already belong to an organization.', 'already_member')
  const i = db.prepare(`SELECT * FROM invitations WHERE id = ? AND status = 'pending'`).get(v.id(invitationId, 'Invitation', { required: true }))
  if (!i || i.expires_at < now()) throw notFound('Invitation')
  if (!user.email_verified || i.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError(403, 'invitation_email_mismatch', `This invitation was sent to ${i.email}. Sign in with that email to accept it.`)
  }
  const ts = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(uuid(), i.org_id, user.id, i.role, i.team_id, ts, ts)
    db.prepare(`UPDATE invitations SET status = 'accepted', accepted_by = ?, updated_at = ? WHERE id = ?`).run(user.id, ts, i.id)
    db.prepare(`UPDATE join_requests SET status = 'withdrawn', updated_at = ? WHERE user_id = ? AND status = 'pending'`).run(ts, user.id)
    audit(db, { orgId: i.org_id, actorId: user.id, action: 'invitation.accepted', entityType: 'membership', entityId: user.id, after: { role: i.role, team_id: i.team_id } })
    notifyInApp(db, { orgId: i.org_id, userId: i.invited_by, kind: 'member_joined', title: `${user.name} joined the organization`, link: '#/settings/members', dedupeKey: `joined:${i.id}` })
  })
  return { orgId: i.org_id, role: i.role }
}

// ---------- join requests ----------
export function requestToJoin(db, user, body) {
  if (db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(user.id)) throw conflict('You already belong to an organization.', 'already_member')
  const code = v.text(body?.joinCode, 'Join code', { required: true, max: 20 }).toUpperCase()
  const org = db.prepare('SELECT * FROM organizations WHERE join_code = ?').get(code)
  if (!org) throw notFound('An organization with that join code')
  if (db.prepare(`SELECT 1 FROM join_requests WHERE user_id = ? AND status = 'pending'`).get(user.id)) throw conflict('You already have a pending request. Wait for a decision or withdraw it first.', 'request_pending')
  const id = uuid()
  const ts = now()
  const message = v.text(body?.message, 'Message', { max: 500 })
  transaction(db, () => {
    db.prepare(`INSERT INTO join_requests (id, org_id, user_id, message, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(id, org.id, user.id, message, ts, ts)
    for (const a of db.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND role IN ('admin','manager') AND status = 'active'`).all(org.id)) {
      notifyInApp(db, { orgId: org.id, userId: a.user_id, kind: 'join_request', title: `${user.name} asked to join ${org.name}`, body: message, link: '#/settings/members', dedupeKey: `join:${id}:${a.user_id}` })
    }
  })
  return { id, orgName: org.name, status: 'pending' }
}

export function myJoinRequest(db, user) {
  const r = db.prepare(`SELECT j.*, o.name AS org_name FROM join_requests j JOIN organizations o ON o.id = j.org_id WHERE j.user_id = ? ORDER BY j.created_at DESC LIMIT 1`).get(user.id)
  return r ? { id: r.id, orgName: r.org_name, status: r.status, createdAt: r.created_at } : null
}

export function withdrawJoinRequest(db, user) {
  db.prepare(`UPDATE join_requests SET status = 'withdrawn', updated_at = ? WHERE user_id = ? AND status = 'pending'`).run(now(), user.id)
  return { withdrawn: true }
}

export function listJoinRequests(db, ctx) {
  requireStaff(ctx)
  return db.prepare(`SELECT j.*, u.name, u.email, u.email_verified FROM join_requests j JOIN users u ON u.id = j.user_id WHERE j.org_id = ? AND j.status = 'pending' ORDER BY j.created_at`).all(ctx.orgId)
    .map((r) => ({ id: r.id, name: r.name, email: r.email, emailVerified: Boolean(r.email_verified), message: r.message, createdAt: r.created_at }))
}

/** Approve (as employee by default; only admins can grant manager/admin) or reject. */
export function decideJoinRequest(db, ctx, id, body) {
  requireStaff(ctx)
  const r = db.prepare(`SELECT * FROM join_requests WHERE id = ? AND org_id = ? AND status = 'pending'`).get(v.id(id, 'Request', { required: true }), ctx.orgId)
  if (!r) throw notFound('Join request')
  const decision = String(body?.decision || '')
  if (!['approve', 'reject'].includes(decision)) throw invalid('Decision must be approve or reject.')
  const ts = now()
  if (decision === 'reject') {
    db.prepare(`UPDATE join_requests SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`).run(ctx.user.id, ts, ts, r.id)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'join_request.rejected', entityType: 'join_request', entityId: r.id })
    return { status: 'rejected' }
  }
  const role = String(body?.role || 'employee').toLowerCase()
  if (!ROLES.includes(role)) throw invalid('Role must be admin, manager or employee.')
  if (role !== 'employee' && !isAdmin(ctx)) throw forbidden('Only admins can grant the manager or admin role.')
  let teamId = body?.teamId ? requireTeam(db, ctx, v.id(body.teamId, 'Team')).id : null
  if (!isAdmin(ctx)) {
    teamId = teamId || ctx.managedTeamIds[0] || null
    if (!teamId || !ctx.managedTeamIds.includes(teamId)) throw forbidden('Managers can add people only to teams they manage.')
  }
  if (db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(r.user_id)) throw conflict('That person already joined an organization.', 'already_member')
  transaction(db, () => {
    db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(uuid(), ctx.orgId, r.user_id, role, teamId, ts, ts)
    db.prepare(`UPDATE join_requests SET status = 'approved', team_id = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`).run(teamId, ctx.user.id, ts, ts, r.id)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'join_request.approved', entityType: 'membership', entityId: r.user_id, after: { role, team_id: teamId } })
  })
  return { status: 'approved', role, teamId }
}

// ---------- profile ----------
export function updateProfile(db, user, body) {
  const phone = body?.phone === '' || body?.phone === null ? null : v.text(body?.phone, 'Phone', { max: 20 })
  if (phone && !/^\+?[0-9]{8,15}$/.test(phone.replace(/[\s-]/g, ''))) throw invalid('Phone must be digits with an optional + and country code, e.g. +919876543210.')
  db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?').run(phone ? phone.replace(/[\s-]/g, '') : null, now(), user.id)
  return { phone }
}

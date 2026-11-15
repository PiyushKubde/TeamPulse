import { Router } from 'express'
import {
  DEFAULT_WEIGHTS,
  acceptInviteSchema,
  createOrgSchema,
  inviteSchema,
  mentorSchema,
  teamMembersSchema,
  teamSchema,
  updateMemberSchema,
  updateOrgSchema,
} from '@workpulse/shared'
import { z } from 'zod'
import { prisma, type Prisma } from '../lib/prisma.js'
import { body, param, query } from '../lib/validate.js'
import { randomToken, sha256 } from '../lib/crypto.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { audit } from '../lib/audit.js'
import { assertAdmin, assertManager } from '../lib/scope.js'
import { sendMail } from '../lib/mailer.js'
import { env } from '../config/env.js'
import { ctxOf, requireAuth, requireOrg, userOf } from '../middleware/auth.js'
import { hashPassword, startSession } from './auth.js'

export const orgs = Router()

const slugify = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'org'
  }-${randomToken(3)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')}`

/** Create an organization; the creator becomes its owner and it gets the default scoring model. */
orgs.post('/organizations', requireAuth, async (req, res) => {
  const user = userOf(req)
  const { name } = body(req, createOrgSchema)
  const org = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name, slug: slugify(name), settings: { retentionDays: 730, requireReportApproval: false } } })
    await tx.organizationMember.create({ data: { orgId: org.id, userId: user.id, role: 'OWNER' } })
    await tx.scoringModel.create({ data: { orgId: org.id, name: 'Default', weights: DEFAULT_WEIGHTS, createdBy: user.id } })
    await tx.session.update({ where: { id: req.auth!.sessionId }, data: { activeOrgId: org.id } })
    return org
  })
  await audit(req, org.id, 'org.create', { type: 'Organization', id: org.id }, { name })
  res.status(201).json({ organization: org })
})

orgs.post('/organizations/:id/switch', requireAuth, async (req, res) => {
  const orgId = param(req, 'id')
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId, userId: userOf(req).id } } })
  if (!member || member.status !== 'ACTIVE') throw notFound('Organization')
  await prisma.session.update({ where: { id: req.auth!.sessionId }, data: { activeOrgId: orgId } })
  res.json({ activeOrgId: orgId })
})

orgs.get('/organization', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId } })
  res.json({ organization: org, role: ctx.role })
})

orgs.patch('/organization', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const input = body(req, updateOrgSchema)
  const current = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId } })
  const settings = { ...(current.settings as Record<string, unknown>), ...(input.settings ?? {}) }
  const org = await prisma.organization.update({ where: { id: ctx.orgId }, data: { name: input.name, settings: settings as Prisma.InputJsonValue } })
  await audit(req, ctx.orgId, 'org.update', { type: 'Organization', id: ctx.orgId }, input as Prisma.InputJsonValue)
  res.json({ organization: org })
})

// ───────────── Members ─────────────

orgs.get('/members', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  const members = await prisma.organizationMember.findMany({
    where: { orgId: ctx.orgId },
    include: { user: { select: { id: true, name: true, email: true, teamMembers: { select: { team: { select: { id: true, name: true, orgId: true } } } } } } },
    orderBy: { createdAt: 'asc' },
  })
  // Everyone sees the directory (names, roles, teams) so they can assign and mention; emails only for admins/managers.
  const showEmail = ctx.orgWide || ctx.role === 'MANAGER'
  res.json({
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: showEmail || m.userId === ctx.userId ? m.user.email : null,
      role: m.role,
      title: m.title,
      status: m.status,
      teams: m.user.teamMembers
        .map((t) => t.team)
        .filter((t) => t.orgId === ctx.orgId)
        .map(({ id, name }) => ({ id, name })),
      managed: ctx.orgWide || ctx.managedUserIds.includes(m.userId),
    })),
  })
})

orgs.patch('/members/:userId', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const userId = param(req, 'userId')
  const input = body(req, updateMemberSchema)
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } } })
  if (!member) throw notFound('Member')
  // Only an owner grants or removes ownership; the last owner cannot be demoted or suspended.
  if ((input.role === 'OWNER' || member.role === 'OWNER') && ctx.role !== 'OWNER') throw forbidden('Only an owner can change ownership.')
  if (member.role === 'OWNER' && ((input.role && input.role !== 'OWNER') || input.status === 'SUSPENDED')) {
    const owners = await prisma.organizationMember.count({ where: { orgId: ctx.orgId, role: 'OWNER', status: 'ACTIVE' } })
    if (owners <= 1) throw conflict('An organization needs at least one active owner.')
  }
  const updated = await prisma.organizationMember.update({ where: { id: member.id }, data: input })
  await audit(req, ctx.orgId, 'member.update', { type: 'User', id: userId }, { from: { role: member.role, status: member.status }, to: input })
  res.json({ member: updated })
})

orgs.delete('/members/:userId', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const userId = param(req, 'userId')
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } } })
  if (!member) throw notFound('Member')
  if (member.role === 'OWNER') throw conflict('Transfer ownership before removing an owner.')
  await prisma.$transaction([
    prisma.teamMember.deleteMany({ where: { userId, team: { orgId: ctx.orgId } } }),
    prisma.mentorAssignment.deleteMany({ where: { orgId: ctx.orgId, OR: [{ mentorId: userId }, { menteeId: userId }] } }),
    prisma.task.updateMany({ where: { orgId: ctx.orgId, assigneeId: userId, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, data: { assigneeId: null } }),
    prisma.organizationMember.delete({ where: { id: member.id } }),
  ])
  await audit(req, ctx.orgId, 'member.remove', { type: 'User', id: userId })
  res.status(204).end()
})

// ───────────── Invitations ─────────────

orgs.get('/invitations', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertManager(ctx)
  const invitations = await prisma.invitation.findMany({
    where: { orgId: ctx.orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, ...(ctx.orgWide ? {} : { invitedBy: ctx.userId }) },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, role: true, teamId: true, expiresAt: true, createdAt: true },
  })
  res.json({ invitations })
})

orgs.post('/invitations', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertManager(ctx)
  const input = body(req, inviteSchema)
  // Managers invite members into the teams they manage; admins invite anyone with any non-owner role.
  if (!ctx.orgWide) {
    if (input.role !== 'MEMBER') throw forbidden('Managers can invite members only.')
    if (!input.teamId || !ctx.managedTeamIds.includes(input.teamId)) throw forbidden('Choose one of the teams you manage.')
  }
  if (input.teamId && !(await prisma.team.findFirst({ where: { id: input.teamId, orgId: ctx.orgId } }))) throw notFound('Team')
  const existing = await prisma.organizationMember.findFirst({ where: { orgId: ctx.orgId, user: { email: input.email } } })
  if (existing) throw conflict('This person is already a member.')
  const token = randomToken()
  const invitation = await prisma.invitation.create({
    data: {
      orgId: ctx.orgId,
      email: input.email,
      role: input.role,
      teamId: input.teamId ?? null,
      invitedBy: ctx.userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 7 * 864e5),
    },
  })
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId } })
  const link = `${env.APP_URL}/accept-invite?token=${token}`
  const mail = await sendMail(
    input.email,
    `You're invited to ${org.name} on WorkPulse`,
    `${userOf(req).name} invited you to join ${org.name} on WorkPulse.\n\nAccept: ${link}\n\nThis invitation expires in 7 days.`,
  )
  await audit(req, ctx.orgId, 'invitation.create', { type: 'Invitation', id: invitation.id }, { email: input.email, role: input.role })
  // Without email delivery the inviter gets the link to share by hand.
  res
    .status(201)
    .json({
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
      link: mail.delivered ? null : link,
    })
})

orgs.delete('/invitations/:id', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertManager(ctx)
  const inv = await prisma.invitation.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId, ...(ctx.orgWide ? {} : { invitedBy: ctx.userId }) } })
  if (!inv) throw notFound('Invitation')
  await prisma.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } })
  res.status(204).end()
})

/** Public: what an invitation is for (org name, email), so the accept page can show it. */
orgs.get('/invitations/lookup', async (req, res) => {
  const { token } = query(req, z.object({ token: z.string().min(20).max(200) }))
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, include: { org: { select: { name: true } } } })
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw notFound('Invitation')
  const hasAccount = Boolean(await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } }))
  res.json({ email: inv.email, organization: inv.org.name, role: inv.role, hasAccount })
})

/** Accept an invitation: signed in with the invited email, or a new account created with a password. */
orgs.post('/invitations/accept', async (req, res) => {
  const input = body(req, acceptInviteSchema)
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(input.token) } })
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw badRequest('This invitation is invalid or has expired.')
  let userId: string
  if (req.auth) {
    if (req.auth.user.email !== inv.email) throw forbidden(`This invitation is for ${inv.email}. Sign in with that email to accept it.`)
    userId = req.auth.user.id
  } else {
    if (await prisma.user.findUnique({ where: { email: inv.email } })) throw forbidden('Sign in to accept this invitation.')
    if (!input.name || !input.password) throw badRequest('Name and password are required to create your account.')
    // The invite link reached this inbox, so the email counts as verified.
    const user = await prisma.user.create({
      data: { email: inv.email, name: input.name, passwordHash: await hashPassword(input.password), emailVerifiedAt: new Date() },
    })
    userId = user.id
  }
  await prisma.$transaction(async (tx) => {
    await tx.organizationMember.upsert({
      where: { orgId_userId: { orgId: inv.orgId, userId } },
      create: { orgId: inv.orgId, userId, role: inv.role },
      update: { status: 'ACTIVE' },
    })
    if (inv.teamId) await tx.teamMember.upsert({ where: { teamId_userId: { teamId: inv.teamId, userId } }, create: { teamId: inv.teamId, userId }, update: {} })
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } })
  })
  if (req.auth) await prisma.session.update({ where: { id: req.auth.sessionId }, data: { activeOrgId: inv.orgId } })
  else await startSession(res, userId)
  await audit(null, inv.orgId, 'invitation.accept', { type: 'Invitation', id: inv.id }, { userId })
  res.json({ orgId: inv.orgId })
})

// ───────────── Teams ─────────────

orgs.get('/teams', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  const teams = await prisma.team.findMany({
    where: { orgId: ctx.orgId },
    include: { manager: { select: { id: true, name: true } }, members: { select: { user: { select: { id: true, name: true } } } } },
    orderBy: { name: 'asc' },
  })
  res.json({
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      manager: t.manager,
      members: t.members.map((m) => m.user),
      canManage: ctx.orgWide || ctx.managedTeamIds.includes(t.id),
    })),
  })
})

async function assertMemberWithRole(orgId: string, userId: string, roles: string[]) {
  const m = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId, userId } } })
  if (!m || m.status !== 'ACTIVE') throw notFound('Member')
  if (!roles.includes(m.role)) throw badRequest(`This person needs one of these roles first: ${roles.join(', ')}.`)
}

orgs.post('/teams', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const input = body(req, teamSchema)
  if (input.managerId) await assertMemberWithRole(ctx.orgId, input.managerId, ['OWNER', 'ADMIN', 'MANAGER'])
  if (await prisma.team.findFirst({ where: { orgId: ctx.orgId, name: input.name } })) throw conflict('A team with this name exists.')
  const team = await prisma.team.create({ data: { orgId: ctx.orgId, name: input.name, managerId: input.managerId ?? null } })
  await audit(req, ctx.orgId, 'team.create', { type: 'Team', id: team.id }, { name: input.name })
  res.status(201).json({ team })
})

orgs.patch('/teams/:id', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const id = param(req, 'id')
  const input = body(req, teamSchema.partial())
  if (!(await prisma.team.findFirst({ where: { id, orgId: ctx.orgId } }))) throw notFound('Team')
  if (input.managerId) await assertMemberWithRole(ctx.orgId, input.managerId, ['OWNER', 'ADMIN', 'MANAGER'])
  const team = await prisma.team.update({ where: { id }, data: input })
  await audit(req, ctx.orgId, 'team.update', { type: 'Team', id }, input as Prisma.InputJsonValue)
  res.json({ team })
})

orgs.delete('/teams/:id', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const id = param(req, 'id')
  if (!(await prisma.team.findFirst({ where: { id, orgId: ctx.orgId } }))) throw notFound('Team')
  await prisma.team.delete({ where: { id } })
  await audit(req, ctx.orgId, 'team.delete', { type: 'Team', id })
  res.status(204).end()
})

/** Replace a team's members. Admins any team; managers their own teams. */
orgs.put('/teams/:id/members', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  const id = param(req, 'id')
  if (!ctx.orgWide && !ctx.managedTeamIds.includes(id)) throw forbidden()
  const { userIds } = body(req, teamMembersSchema)
  if (!(await prisma.team.findFirst({ where: { id, orgId: ctx.orgId } }))) throw notFound('Team')
  const valid = await prisma.organizationMember.count({ where: { orgId: ctx.orgId, userId: { in: userIds }, status: 'ACTIVE' } })
  if (valid !== new Set(userIds).size) throw badRequest('Every team member must be an active member of the organization.')
  await prisma.$transaction([
    prisma.teamMember.deleteMany({ where: { teamId: id, userId: { notIn: userIds } } }),
    prisma.teamMember.createMany({ data: userIds.map((userId) => ({ teamId: id, userId })), skipDuplicates: true }),
  ])
  await audit(req, ctx.orgId, 'team.members', { type: 'Team', id }, { userIds })
  res.json({ ok: true })
})

// ───────────── Mentors ─────────────

orgs.get('/mentorships', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  const rows = await prisma.mentorAssignment.findMany({
    where: { orgId: ctx.orgId, ...(ctx.orgWide ? {} : { OR: [{ mentorId: ctx.userId }, { menteeId: ctx.userId }] }) },
    include: { mentor: { select: { id: true, name: true } }, mentee: { select: { id: true, name: true } } },
  })
  res.json({ mentorships: rows.map((r) => ({ id: r.id, mentor: r.mentor, mentee: r.mentee })) })
})

orgs.post('/mentorships', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const input = body(req, mentorSchema)
  if (input.mentorId === input.menteeId) throw badRequest('A person cannot mentor themselves.')
  await assertMemberWithRole(ctx.orgId, input.mentorId, ['OWNER', 'ADMIN', 'MANAGER', 'MENTOR'])
  await assertMemberWithRole(ctx.orgId, input.menteeId, ['ADMIN', 'MANAGER', 'MENTOR', 'MEMBER'])
  const row = await prisma.mentorAssignment.upsert({
    where: { orgId_mentorId_menteeId: { orgId: ctx.orgId, ...input } },
    create: { orgId: ctx.orgId, ...input },
    update: {},
  })
  await audit(req, ctx.orgId, 'mentorship.create', { type: 'MentorAssignment', id: row.id }, input)
  res.status(201).json({ mentorship: row })
})

orgs.delete('/mentorships/:id', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const row = await prisma.mentorAssignment.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId } })
  if (!row) throw notFound('Mentorship')
  await prisma.mentorAssignment.delete({ where: { id: row.id } })
  res.status(204).end()
})

// ───────────── Audit log ─────────────

orgs.get('/audit-logs', requireOrg, async (req, res) => {
  const ctx = ctxOf(req)
  assertAdmin(ctx)
  const q = query(req, z.object({ page: z.coerce.number().int().min(1).default(1), action: z.string().max(60).optional() }))
  const where = { orgId: ctx.orgId, ...(q.action ? { action: { startsWith: q.action } } : {}) }
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, skip: (q.page - 1) * 50 }),
    prisma.auditLog.count({ where }),
  ])
  const actors = await prisma.user.findMany({ where: { id: { in: items.flatMap((i) => (i.actorId ? [i.actorId] : [])) } }, select: { id: true, name: true } })
  const names = new Map(actors.map((a) => [a.id, a.name]))
  res.json({ items: items.map((i) => ({ ...i, actorName: i.actorId ? (names.get(i.actorId) ?? null) : 'System' })), page: q.page, pageSize: 50, total })
})

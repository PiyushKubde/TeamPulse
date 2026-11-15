import { describe, expect, it } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { devOutbox } from '../src/lib/mailer.js'
import { client, orgWithPeople, signUp } from './helpers.js'

const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)?.[1]

describe('authentication', () => {
  it('registers, signs out, signs in, and rejects a wrong password', async () => {
    const { c, email } = await signUp('Ada')
    expect((await c.get('/api/auth/me')).body.user.email).toBe(email)
    await c.post('/api/auth/logout').expect(204)
    expect((await c.get('/api/auth/me')).status).toBe(401)
    expect((await c.post('/api/auth/login').send({ email, password: 'wrong-password1' })).status).toBe(401)
    await c.post('/api/auth/login').send({ email, password: 'Password123' }).expect(200)
    expect((await c.get('/api/auth/me')).status).toBe(200)
  })

  it('rejects weak passwords and duplicate emails', async () => {
    const c = client()
    expect((await c.post('/api/auth/register').send({ name: 'A', email: 'a@x.com', password: 'short' })).status).toBe(400)
    const { email } = await signUp('Dup')
    expect((await client().post('/api/auth/register').send({ name: 'B', email, password: 'Password123' })).status).toBe(409)
  })

  it('stores only argon2id password hashes', async () => {
    const { user } = await signUp('Hash')
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(row.passwordHash).toMatch(/^\$argon2id\$/)
  })

  it('verifies email with a one-time token', async () => {
    const { c, email, user } = await signUp('Verify')
    const token = tokenFrom(devOutbox.filter((m) => m.to === email).at(-1)!.text)!
    await c.post('/api/auth/verify-email').send({ token }).expect(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull()
    expect((await c.post('/api/auth/verify-email').send({ token })).status).toBe(400) // single use
  })

  it('resets a password and ends existing sessions; unknown emails get the same answer', async () => {
    const { c, email } = await signUp('Reset')
    const anon = client()
    expect((await anon.post('/api/auth/forgot-password').send({ email: 'nobody@example.com' })).body).toEqual({ ok: true })
    await anon.post('/api/auth/forgot-password').send({ email }).expect(200)
    const token = tokenFrom(devOutbox.filter((m) => m.to === email && m.subject.includes('Reset')).at(-1)!.text)!
    await anon.post('/api/auth/reset-password').send({ token, password: 'NewPassword456' }).expect(200)
    expect((await c.get('/api/auth/me')).status).toBe(401)
    await anon.post('/api/auth/login').send({ email, password: 'NewPassword456' }).expect(200)
  })

  it('requires the CSRF header on state-changing requests', async () => {
    const { c } = await signUp('Csrf')
    const res = await c.agent.post('/api/organizations').send({ name: 'No header' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('csrf')
  })
})

describe('organizations and invitations', () => {
  it('creates an org with the creator as owner and a default scoring model', async () => {
    const { c } = await signUp('Founder')
    const org = (await c.post('/api/organizations').send({ name: 'Initech' }).expect(201)).body.organization
    const me = (await c.get('/api/auth/me')).body
    expect(me).toMatchObject({ activeOrgId: org.id, role: 'OWNER' })
    expect(await prisma.scoringModel.count({ where: { orgId: org.id } })).toBe(1)
  })

  it('invites a new person who accepts and joins the team', async () => {
    const { owner, team } = await orgWithPeople()
    const inv = await owner.c.post('/api/invitations').send({ email: 'new.hire@example.com', role: 'MEMBER', teamId: team.id }).expect(201)
    expect(inv.body.link).toMatch(/accept-invite\?token=/) // no SMTP: the link is returned to share by hand
    const token = tokenFrom(inv.body.link)!
    const guest = client()
    expect((await guest.get(`/api/invitations/lookup?token=${token}`)).body).toMatchObject({
      email: 'new.hire@example.com',
      organization: 'Acme',
      hasAccount: false,
    })
    await guest.post('/api/invitations/accept').send({ token, name: 'New Hire', password: 'Password123' }).expect(200)
    const me = (await guest.get('/api/auth/me')).body
    expect(me.role).toBe('MEMBER')
    expect(await prisma.teamMember.count({ where: { teamId: team.id, user: { email: 'new.hire@example.com' } } })).toBe(1)
    expect((await guest.post('/api/invitations/accept').send({ token, name: 'X', password: 'Password123' })).status).toBe(400)
  })

  it('lets managers invite members only into their own teams', async () => {
    const { manager, team, team2 } = await orgWithPeople()
    await manager.c.post('/api/invitations').send({ email: 'm1@example.com', role: 'MEMBER', teamId: team.id }).expect(201)
    expect((await manager.c.post('/api/invitations').send({ email: 'm2@example.com', role: 'MEMBER', teamId: team2.id })).status).toBe(403)
    expect((await manager.c.post('/api/invitations').send({ email: 'm3@example.com', role: 'ADMIN', teamId: team.id })).status).toBe(403)
  })

  it('switches between organizations the user belongs to only', async () => {
    const { owner } = await orgWithPeople()
    const second = (await owner.c.post('/api/organizations').send({ name: 'Second' })).body.organization
    const first = (await owner.c.get('/api/auth/me')).body.organizations.find((o: { name: string }) => o.name === 'Acme')
    await owner.c.post(`/api/organizations/${first.id}/switch`).expect(200)
    expect((await owner.c.get('/api/auth/me')).body.activeOrgId).toBe(first.id)
    const stranger = await signUp('Stranger')
    expect((await stranger.c.post(`/api/organizations/${second.id}/switch`)).status).toBe(404)
  })

  it('protects the last owner and audits role changes', async () => {
    const { owner, org, member } = await orgWithPeople()
    expect((await owner.c.patch(`/api/members/${owner.user.id}`).send({ role: 'ADMIN' })).status).toBe(409)
    await owner.c.patch(`/api/members/${member.user.id}`).send({ role: 'MANAGER' }).expect(200)
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'member.update' } })).toBe(1)
    expect((await member.c.patch(`/api/members/${owner.user.id}`).send({ role: 'MEMBER' })).status).toBe(403)
  })
})

describe('tenant isolation and role scope', () => {
  it('never exposes another organization’s records', async () => {
    const a = await orgWithPeople()
    const b = await signUp('Rival')
    await b.c.post('/api/organizations').send({ name: 'Rival Co' })
    const task = (await a.owner.c.post('/api/tasks').send({ title: 'Secret plan' })).body.task
    expect((await b.c.get(`/api/tasks/${task.id}`)).status).toBe(404)
    expect((await b.c.patch(`/api/tasks/${task.id}`).send({ title: 'pwned' })).status).toBe(404)
    expect((await b.c.get('/api/tasks')).body.items).toHaveLength(0)
    expect((await b.c.get(`/api/analytics/individual?userId=${a.owner.user.id}`)).status).toBe(404)
    expect((await b.c.get(`/api/feedback?userId=${a.member.user.id}`)).status).toBe(404)
  })

  it('managers see their team, not other teams; members see only their own work', async () => {
    const { manager, member, other } = await orgWithPeople()
    const mine = (await member.c.post('/api/tasks').send({ title: 'Member task' })).body.task
    const theirs = (await other.c.post('/api/tasks').send({ title: 'Other team task' })).body.task
    expect((await manager.c.get(`/api/tasks/${mine.id}`)).status).toBe(200)
    expect((await manager.c.get(`/api/tasks/${theirs.id}`)).status).toBe(404)
    expect((await member.c.get(`/api/tasks/${theirs.id}`)).status).toBe(404)
    expect((await manager.c.patch(`/api/tasks/${mine.id}`).send({ priority: 'HIGH' })).status).toBe(200)
    expect((await manager.c.get(`/api/analytics/individual?userId=${other.user.id}`)).status).toBe(404)
    expect((await member.c.get('/api/analytics/team')).status).toBe(403)
  })

  it('mentors read their mentees’ work but cannot change it', async () => {
    const { mentor, member, other } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Mentee work' })).body.task
    expect((await mentor.c.get(`/api/tasks/${t.id}`)).status).toBe(200)
    expect((await mentor.c.patch(`/api/tasks/${t.id}`).send({ title: 'changed' })).status).toBe(403)
    await mentor.c.post(`/api/tasks/${t.id}/comments`).send({ body: 'Nice approach' }).expect(201)
    await mentor.c.post('/api/feedback').send({ subjectUserId: member.user.id, kind: 'MENTOR', body: 'Great progress on tests' }).expect(201)
    expect((await mentor.c.post('/api/feedback').send({ subjectUserId: other.user.id, kind: 'MENTOR', body: 'Not my mentee' })).status).toBe(403)
  })

  it('members cannot assign work to people they do not manage', async () => {
    const { member, other, manager } = await orgWithPeople()
    expect((await member.c.post('/api/tasks').send({ title: 'x', assigneeId: other.user.id })).status).toBe(403)
    await manager.c.post('/api/tasks').send({ title: 'For member', assigneeId: member.user.id }).expect(201)
  })

  it('only admins manage teams, scoring models and see the audit log', async () => {
    const { owner, manager } = await orgWithPeople()
    expect((await manager.c.post('/api/teams').send({ name: 'New' })).status).toBe(403)
    expect((await manager.c.get('/api/audit-logs')).status).toBe(403)
    expect(
      (await manager.c.post('/api/scoring-models').send({ name: 'Eng', weights: { impact: 40, quality: 20, alignment: 20, reliability: 10, evidence: 10 } }))
        .status,
    ).toBe(403)
    const m = await owner.c
      .post('/api/scoring-models')
      .send({ name: 'Default', weights: { impact: 40, quality: 20, alignment: 20, reliability: 10, evidence: 10 } })
      .expect(201)
    expect(m.body.model.version).toBe(2)
    expect((await owner.c.get('/api/audit-logs')).body.items.length).toBeGreaterThan(0)
  })
})

describe('verification email delivery', () => {
  it('tells the user when no email sender is set up, instead of pretending it was sent', async () => {
    const { c } = await signUp('NoMail')
    const me = (await c.get('/api/auth/me')).body
    expect(me.mailConfigured).toBe(false)
    const r = await c.post('/api/auth/resend-verification')
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe('mail_not_configured')
  })
})

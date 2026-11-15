import request from 'supertest'
import { createApp } from '../src/app.js'
import { prisma } from '../src/lib/prisma.js'

export const app = createApp()

export type Agent = ReturnType<typeof request.agent>

/** A signed-in client. Every mutating call carries the CSRF header like the web app does. */
export function client() {
  const agent = request.agent(app)
  const wrap = (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (url: string) => agent[method](url).set('X-WorkPulse', '1')
  return { agent, get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), del: wrap('delete') }
}
export type Client = ReturnType<typeof client>

let n = 0
export async function signUp(name = 'User') {
  const c = client()
  const email = `${name.toLowerCase().replace(/\W/g, '')}${++n}@example.com`
  const res = await c.post('/api/auth/register').send({ name, email, password: 'Password123' })
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { c, user: res.body.user as { id: string; email: string; name: string }, email }
}

/** An organization with an owner, a manager with a team (one member), a second team's member, and a mentor. */
export async function orgWithPeople() {
  const owner = await signUp('Owner')
  const org = (await owner.c.post('/api/organizations').send({ name: 'Acme' })).body.organization as { id: string }
  const join = async (name: string, role: string) => {
    const p = await signUp(name)
    await prisma.organizationMember.create({ data: { orgId: org.id, userId: p.user.id, role: role as never } })
    await prisma.session.updateMany({ where: { userId: p.user.id }, data: { activeOrgId: org.id } })
    return p
  }
  const manager = await join('Manager', 'MANAGER')
  const member = await join('Member', 'MEMBER')
  const other = await join('Other', 'MEMBER')
  const mentor = await join('Mentor', 'MENTOR')
  const team = await prisma.team.create({
    data: { orgId: org.id, name: 'Core', managerId: manager.user.id, members: { create: [{ userId: member.user.id }, { userId: manager.user.id }] } },
  })
  const team2 = await prisma.team.create({ data: { orgId: org.id, name: 'Growth', members: { create: [{ userId: other.user.id }] } } })
  await prisma.mentorAssignment.create({ data: { orgId: org.id, mentorId: mentor.user.id, menteeId: member.user.id } })
  return { org, owner, manager, member, other, mentor, team, team2 }
}

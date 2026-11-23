import { describe, expect, it } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { isSampleTask, sampleState } from '../src/services/sample-data.js'
import { signUp } from './helpers.js'

async function newWorkspace(sampleData?: boolean) {
  const owner = await signUp('Founder')
  const org = (
    await owner.c
      .post('/api/organizations')
      .send({ name: 'Startup', ...(sampleData === undefined ? {} : { sampleData }) })
      .expect(201)
  ).body.organization as { id: string }
  return { owner, org }
}
const people = async (c: Awaited<ReturnType<typeof signUp>>['c']) =>
  ((await c.get('/api/company/overview?days=56').expect(200)).body.people as { userId: string; name: string; overall: number | null }[]) ?? []

describe('sample data in a new workspace', () => {
  it('fills every page on day one: a team, goals, KPIs and weeks of work', async () => {
    const { owner, org } = await newWorkspace(true)
    const s = await sampleState(org.id)
    expect(s.active).toBe(true)
    const everyone = await people(owner.c)
    expect(everyone).toHaveLength(6)
    expect(everyone.filter((p) => p.overall !== null).length).toBeGreaterThanOrEqual(5)
    expect(await prisma.task.count({ where: { orgId: org.id } })).toBe(s.taskIds!.length)
    expect(await prisma.goal.count({ where: { orgId: org.id, parentId: { not: null } } })).toBeGreaterThan(0)
    expect(await prisma.kpiReading.count({ where: { kpi: { orgId: org.id } } })).toBeGreaterThan(10)
    // Sample teammates can never sign in, be emailed or be rung.
    const fake = await prisma.user.findMany({ where: { id: { in: s.userIds } } })
    expect(fake.every((u) => u.passwordHash === null && u.phone === null && u.email.endsWith('.invalid'))).toBe(true)
    // The owner can see it is sample data (the web app shows a banner from this).
    const settings = (await owner.c.get('/api/organization').expect(200)).body.organization.settings
    expect(settings.sample.active).toBe(true)
  })

  it('disappears when the first real task is created, leaving that task intact', async () => {
    const { owner, org } = await newWorkspace(true)
    const s = await sampleState(org.id)
    const sampleGoal = s.goalIds![0]!
    // Even a task pointed at a sample teammate and a sample goal is accepted: it comes to its creator instead.
    const res = await owner.c
      .post('/api/tasks')
      .send({ title: 'My first real task', assigneeId: s.userIds![0], goalIds: [sampleGoal] })
      .expect(201)
    expect(res.body.task.assigneeId).toBe(owner.user.id)

    const after = await sampleState(org.id)
    expect(after).toMatchObject({ active: false, clearedBy: 'first_task' })
    expect(await prisma.task.findMany({ where: { orgId: org.id }, select: { title: true } })).toEqual([{ title: 'My first real task' }])
    expect(await prisma.user.count({ where: { id: { in: s.userIds } } })).toBe(0)
    expect(await prisma.goal.count({ where: { orgId: org.id } })).toBe(0)
    expect(await prisma.kpi.count({ where: { orgId: org.id } })).toBe(0)
    expect(await prisma.team.count({ where: { orgId: org.id } })).toBe(0)
    expect((await people(owner.c)).map((p) => p.userId)).toEqual([owner.user.id])
    // A second task does not try again.
    await owner.c.post('/api/tasks').send({ title: 'Second task' }).expect(201)
    expect(await prisma.task.count({ where: { orgId: org.id } })).toBe(2)
  })

  it('keeps real records that point at sample ones', async () => {
    const { owner, org } = await newWorkspace(true)
    const s = await sampleState(org.id)
    const mine = await prisma.goal.create({
      data: {
        orgId: org.id,
        ownerId: owner.user.id,
        parentId: s.goalIds![0],
        period: 'QUARTERLY',
        title: 'My own goal',
        startDate: new Date(),
        dueDate: new Date(),
      },
    })
    await owner.c.post('/api/tasks').send({ title: 'Real work' }).expect(201)
    const kept = await prisma.goal.findUniqueOrThrow({ where: { id: mine.id } })
    expect(kept.parentId).toBeNull()
  })

  it('an admin can remove it at once; a member cannot', async () => {
    const { owner, org } = await newWorkspace(true)
    const member = await signUp('Teammate')
    await prisma.organizationMember.create({ data: { orgId: org.id, userId: member.user.id, role: 'MEMBER' } })
    await prisma.session.updateMany({ where: { userId: member.user.id }, data: { activeOrgId: org.id } })
    expect((await member.c.del('/api/organization/sample-data')).status).toBe(403)
    expect((await owner.c.del('/api/organization/sample-data').expect(200)).body.removed).toBe(true)
    expect((await owner.c.del('/api/organization/sample-data').expect(200)).body.removed).toBe(false)
    expect(await sampleState(org.id)).toMatchObject({ active: false, clearedBy: 'removed' })
    expect(await prisma.task.count({ where: { orgId: org.id } })).toBe(0)
  })

  it('never rings a phone for sample work', async () => {
    const { org } = await newWorkspace(true)
    const s = await sampleState(org.id)
    expect(await isSampleTask(org.id, s.taskIds![0]!)).toBe(true)
    expect(await isSampleTask(org.id, 'not-a-sample-task')).toBe(false)
  })

  it('can be skipped, and is off when the server setting is off', async () => {
    const off = await newWorkspace(false)
    expect((await sampleState(off.org.id)).active).toBe(false)
    expect(await prisma.task.count({ where: { orgId: off.org.id } })).toBe(0)
    const byDefault = await newWorkspace() // SAMPLE_DATA=false in the test environment
    expect((await sampleState(byDefault.org.id)).active).toBe(false)
  })
})

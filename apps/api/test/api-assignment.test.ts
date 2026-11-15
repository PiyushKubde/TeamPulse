import { describe, expect, it } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { matchMember, ruleBasedChoice } from '../src/services/assignment.js'
import { env } from '../src/config/env.js'
import { orgWithPeople } from './helpers.js'
import { fakeViasocket } from './fake-viasocket.js'

describe('automatic assignment', () => {
  it('matches names politely and only when unambiguous', () => {
    const people = [
      { userId: 'a', name: 'Neha Gupta' },
      { userId: 'b', name: 'Neha Sharma' },
      { userId: 'c', name: 'Ashish Rao' },
    ]
    expect(matchMember('neha gupta', people)).toBe('a')
    expect(matchMember('Ashish sir', people)).toBe('c')
    expect(matchMember('Neha', people)).toBeNull()
    expect(matchMember('Ravi', people)).toBeNull()
  })

  it('rules prefer matching recent work and lighter load', () => {
    const base = { role: 'MEMBER', title: null, teams: [], openHours: 0 }
    const pick = ruleBasedChoice('Fix Android crash on login', [
      { ...base, userId: 'ios', name: 'iOS dev', recent: ['iOS push notifications'], openTasks: 1 },
      { ...base, userId: 'android', name: 'Android dev', recent: ['Android crash reporting', 'login screen'], openTasks: 3 },
    ])
    expect(pick?.userId).toBe('android')
  })

  it('the task form "auto" assigns via AI within the caller’s team', async () => {
    const { manager, member } = await orgWithPeople()
    fakeViasocket.aiQueue.push({ userId: member.user.id, reason: 'Member has done similar work.' })
    const t = (await manager.c.post('/api/tasks').send({ title: 'Migrate billing', assigneeId: 'auto' }).expect(201)).body.task
    expect(t.assigneeId).toBe(member.user.id)
    const act = await prisma.taskActivity.findFirstOrThrow({ where: { taskId: t.id, kind: 'auto_assigned' } })
    expect(act.toValue).toContain('similar work')
  })

  it('without AI, rules still assign; members always get their own tasks', async () => {
    const { manager, member } = await orgWithPeople()
    const saved = env.AI_PROVIDER
    env.AI_PROVIDER = ''
    try {
      const t = (await manager.c.post('/api/tasks').send({ title: 'Something', assigneeId: 'auto' }).expect(201)).body.task
      expect([manager.user.id, member.user.id]).toContain(t.assigneeId)
      const m = (await member.c.post('/api/tasks').send({ title: 'Mine', assigneeId: 'auto' }).expect(201)).body.task
      expect(m.assigneeId).toBe(member.user.id)
    } finally {
      env.AI_PROVIDER = saved
    }
  })
})

describe('imported tasks', () => {
  it('open Linear issues without an assignee are auto-assigned; finished ones are not', async () => {
    const { owner } = await orgWithPeople()
    const { applyTask } = await import('../src/integrations/normalization/normalizer.js')
    const conn = await prisma.integrationConnection.create({
      data: {
        orgId: (await prisma.organization.findFirstOrThrow()).id,
        userId: owner.user.id,
        provider: 'linear',
        authIdEnc: 'x',
        authIdHash: 'h',
        settings: {},
      },
    })
    const base = {
      provider: 'linear',
      externalKey: null,
      description: null,
      rawPriority: '3',
      assignee: null,
      dueAt: null,
      labels: [],
      sourceUrl: null,
      externalUpdatedAt: new Date(),
      revision: null,
      deleted: false,
    }
    fakeViasocket.aiQueue.push({ userId: owner.user.id, reason: 'fits' })
    const open = await applyTask(conn, { ...base, externalId: 'o1', title: 'Open issue', rawStatus: 'Todo', rawStatusCategory: 'unstarted' })
    const done = await applyTask(conn, { ...base, externalId: 'd1', title: 'Done issue', rawStatus: 'Done', rawStatusCategory: 'completed' })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: open.taskId! } })).assigneeId).not.toBeNull()
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done.taskId! } })).assigneeId).toBeNull()
  })
})

// MOCKED AI: the fake viaSocket transport answers with queued JSON. These tests prove WorkPulse's guardrails.
import { describe, expect, it } from 'vitest'
import { env } from '../src/config/env.js'
import { prisma } from '../src/lib/prisma.js'
import { orgWithPeople } from './helpers.js'
import { fakeViasocket } from './fake-viasocket.js'

describe('AI configuration', () => {
  it('reports "not configured" without credentials; the rest still works', async () => {
    const { member } = await orgWithPeople()
    const saved = env.AI_PROVIDER
    env.AI_PROVIDER = ''
    try {
      const s = (await member.c.get('/api/ai/status')).body
      expect(s).toMatchObject({ configured: false })
      const r = await member.c.post('/api/ai/create-task').send({ text: 'Write the launch post by Friday' })
      expect(r.status).toBe(503)
      expect(r.body.error.code).toBe('ai_not_configured')
      await member.c.post('/api/tasks').send({ title: 'Works without AI' }).expect(201)
    } finally {
      env.AI_PROVIDER = saved
    }
  })
  it('is on by default when the viaSocket keys are present', async () => {
    const { member } = await orgWithPeople()
    expect((await member.c.get('/api/ai/status')).body).toMatchObject({ configured: true, provider: 'viasocket' })
  })
})

describe('structured AI workflows', () => {
  it('drafts a task from natural language without creating it', async () => {
    const { member } = await orgWithPeople()
    fakeViasocket.aiQueue.push({
      title: 'Write launch post',
      description: null,
      priority: 'HIGH',
      dueDate: '2026-11-20',
      category: 'Marketing',
      suggestedImpact: 'MEDIUM',
      estimateMins: 90,
      subtasks: ['Outline', 'Draft'],
      rationale: 'Launch depends on it',
    })
    const r = (await member.c.post('/api/ai/create-task').send({ text: 'Write the launch post by Friday, high priority' }).expect(200)).body
    expect(r.draft).toMatchObject({ title: 'Write launch post', priority: 'HIGH' })
    expect(await prisma.task.count()).toBe(0)
  })

  it('discards AI answers that fail validation', async () => {
    const { member } = await orgWithPeople()
    fakeViasocket.aiQueue.push({ title: '', priority: 'URGENT!!' })
    const r = await member.c.post('/api/ai/create-task').send({ text: 'something' })
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe('ai_invalid')
  })

  it('drops invented task ids from the daily plan', async () => {
    const { member } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Real task', impactLevel: 'HIGH' })).body.task
    fakeViasocket.aiQueue.push({
      topOutcomes: [
        { text: 'Ship it', taskId: t.id },
        { text: 'Fake', taskId: 'made-up-id' },
      ],
      orderedTaskIds: [t.id, 'made-up-id'],
      warnings: [],
      rationale: 'r',
    })
    const r = (await member.c.post('/api/ai/plan-day').send({ date: '2026-11-16' }).expect(200)).body
    expect(r.orderedTaskIds).toEqual([t.id])
    expect(r.topOutcomes[1].taskId).toBeNull()
  })
})

describe('assistant', () => {
  it('answers from tool results run under the caller’s permissions', async () => {
    const { member } = await orgWithPeople()
    await member.c.post('/api/tasks').send({ title: 'Migrate billing', impactLevel: 'CRITICAL' })
    fakeViasocket.aiQueue.push({ type: 'tool_call', tool: 'list_tasks', arguments: '{"user":"me"}', answer: null })
    fakeViasocket.aiQueue.push((msg: string) => ({
      type: 'answer',
      tool: null,
      arguments: null,
      answer: msg.includes('Migrate billing') ? 'You are working on Migrate billing.' : 'No data',
    }))
    const r = (await member.c.post('/api/ai/chat').send({ message: 'What am I working on?' }).expect(200)).body
    expect(r.answer).toBe('You are working on Migrate billing.')
    expect(r.toolsUsed).toEqual([{ tool: 'list_tasks', ok: true }])
  })

  it('cannot reach people outside the caller’s scope, even when the model asks', async () => {
    const { member, other } = await orgWithPeople()
    await other.c.post('/api/tasks').send({ title: 'Confidential roadmap' })
    fakeViasocket.aiQueue.push({ type: 'tool_call', tool: 'list_tasks', arguments: JSON.stringify({ user: other.user.id }), answer: null })
    fakeViasocket.aiQueue.push({ type: 'tool_call', tool: 'team_overview', arguments: '{}', answer: null })
    fakeViasocket.aiQueue.push((msg: string) => ({
      type: 'answer',
      tool: null,
      arguments: null,
      answer: msg.includes('Confidential roadmap') ? 'LEAKED' : 'I cannot see that.',
    }))
    const r = (await member.c.post('/api/ai/chat').send({ message: 'Show me what Other is doing' }).expect(200)).body
    expect(r.answer).toBe('I cannot see that.')
    expect(r.toolsUsed).toEqual([
      { tool: 'list_tasks', ok: false },
      { tool: 'team_overview', ok: false },
    ])
  })

  it('creates the task right away and assigns the named person', async () => {
    const { manager, member } = await orgWithPeople()
    fakeViasocket.aiQueue.push({
      type: 'tool_call',
      tool: 'create_task',
      arguments: JSON.stringify({ title: 'Deploy the M91 feature', dueDate: '2026-11-16', priority: 'HIGH', assigneeName: 'member' }),
      answer: null,
    })
    fakeViasocket.aiQueue.push({ type: 'answer', tool: null, arguments: null, answer: 'Created and assigned to Member.' })
    const r = (await manager.c.post('/api/ai/chat').send({ message: 'deploy the m91 feature today, assign it to member' }).expect(200)).body
    expect(r.created).toHaveLength(1)
    expect(r.created[0]).toMatchObject({ title: 'Deploy the M91 feature', assignee: 'Member' })
    expect(await prisma.task.findFirstOrThrow({ where: { title: 'Deploy the M91 feature' } })).toMatchObject({
      assigneeId: member.user.id,
      priority: 'HIGH',
      creatorId: manager.user.id,
    })
  })

  it('picks the best fit when nobody is named, and never someone outside the caller’s reach', async () => {
    const { manager, member, other } = await orgWithPeople()
    fakeViasocket.aiQueue.push({ type: 'tool_call', tool: 'create_task', arguments: JSON.stringify({ title: 'Write release notes' }), answer: null })
    // The model tries to pick someone the manager does not manage: refused, rules decide instead.
    fakeViasocket.aiQueue.push({ userId: other.user.id, reason: 'x' })
    fakeViasocket.aiQueue.push({ type: 'answer', tool: null, arguments: null, answer: 'Done.' })
    await manager.c.post('/api/ai/chat').send({ message: 'someone should write the release notes' }).expect(200)
    const t = await prisma.task.findFirstOrThrow({ where: { title: 'Write release notes' } })
    expect([manager.user.id, member.user.id]).toContain(t.assigneeId)
    expect(t.assigneeId).not.toBe(other.user.id)
  })
})

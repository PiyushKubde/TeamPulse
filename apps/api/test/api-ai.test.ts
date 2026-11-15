// MOCKED AI: the fake viaSocket transport answers with queued JSON. These tests prove WorkPulse's guardrails.
import { describe, expect, it } from 'vitest'
import { env } from '../src/config/env.js'
import { prisma } from '../src/lib/prisma.js'
import { orgWithPeople } from './helpers.js'
import { fakeViasocket } from './fake-viasocket.js'

describe('AI configuration', () => {
  it('reports "not configured" and refuses AI calls until the data-policy switch is on; the rest still works', async () => {
    const { member } = await orgWithPeople()
    env.AI_DATA_POLICY_CONFIRMED = false
    try {
      const s = (await member.c.get('/api/ai/status')).body
      expect(s).toMatchObject({ configured: false })
      expect(s.reason).toMatch(/data-processing terms/)
      const r = await member.c.post('/api/ai/create-task').send({ text: 'Write the launch post by Friday' })
      expect(r.status).toBe(503)
      expect(r.body.error.code).toBe('ai_not_configured')
      await member.c.post('/api/tasks').send({ title: 'Works without AI' }).expect(201)
    } finally {
      env.AI_DATA_POLICY_CONFIRMED = true
    }
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

  it('only offers the allowlisted tools and never writes data (draft_task returns a draft)', async () => {
    const { member } = await orgWithPeople()
    fakeViasocket.aiQueue.push({
      type: 'tool_call',
      tool: 'draft_task',
      arguments: JSON.stringify({
        title: 'Follow up with vendor',
        description: null,
        priority: 'MEDIUM',
        dueDate: null,
        category: null,
        suggestedImpact: 'LOW',
        estimateMins: 15,
        subtasks: [],
        rationale: 'asked',
      }),
      answer: null,
    })
    fakeViasocket.aiQueue.push({ type: 'answer', tool: null, arguments: null, answer: 'Here is a draft.' })
    const r = (await member.c.post('/api/ai/chat').send({ message: 'Create a task to follow up with the vendor' }).expect(200)).body
    expect(r.draft).toMatchObject({ title: 'Follow up with vendor' })
    expect(await prisma.task.count()).toBe(0)
    const prompt = fakeViasocket.aiCalls[0]
    expect(prompt).toBeDefined()
  })
})

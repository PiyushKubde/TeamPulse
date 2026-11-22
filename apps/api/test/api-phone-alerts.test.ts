// MOCKED M91: fetch to m91-api.msg91.com is answered by a fake. Real calls are recorded in docs/m91-alerting.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../src/config/env.js'
import { prisma } from '../src/lib/prisma.js'
import { checkOps, processPersonalAlerts, syncPhoneInvitations } from '../src/services/phone-alerts.js'
import { client, orgWithPeople } from './helpers.js'

interface Call {
  method: string
  url: string
  body: Record<string, unknown> | null
}
let calls: Call[] = []
let inviteState = 'pending'
let decision: { label: string; note: string | null } | null = null
const realFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  inviteState = 'pending'
  decision = null
  env.M91_API_KEY = 'm91sk_test'
  env.M91_SEND_LINK = 'https://m91-api.msg91.com/s/sk_test'
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://m91-api.msg91.com')) return realFetch(input, init)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method: init?.method ?? 'GET', url, body })
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
    if (url.endsWith('/recipients')) return ok({ phone: body.phone, state: inviteState, reachable: inviteState === 'accepted' })
    if (url.endsWith('/alerts') || url.endsWith('/s/sk_test')) return ok({ _id: 'a1', delivered: 1 })
    if (url.includes('/alerts/close') || url.endsWith('/close')) return ok({ _id: 'a1', status: 'RESOLVED' })
    if (url.includes('/alerts/'))
      return ok({
        _id: 'a1',
        customId: 'x',
        status: decision ? 'RESOLVED' : 'OPEN',
        decision: decision && { label: decision.label, effect: 'SHARED' },
        responses: decision ? [{ label: decision.label, effect: 'SHARED', note: decision.note }] : [],
        resolvedAt: null,
      })
    return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'x' } }), { status: 404 })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  env.M91_API_KEY = undefined
  env.M91_SEND_LINK = undefined
})

async function connectPhone(c: Awaited<ReturnType<typeof orgWithPeople>>['member']['c']) {
  await c.put('/api/me/phone').send({ phone: '+91 98765 43210' }).expect(200)
  inviteState = 'accepted'
  return (await c.post('/api/me/phone/refresh').expect(200)).body
}

describe('automatic invitation at sign-up', () => {
  it('requires a number, invites it to M91 on sign-up, and notices acceptance in the background', async () => {
    const c = client()
    const email = `ring-${Date.now()}@x.com`
    expect((await c.post('/api/auth/register').send({ name: 'Ring', email, password: 'Password123' })).status).toBe(400)
    await c.post('/api/auth/register').send({ name: 'Ring', email, password: 'Password123', phone: '+91 98765 11111' }).expect(201)
    expect(calls.find((x) => x.url.endsWith('/recipients'))?.body).toMatchObject({ phone: '919876511111' })
    expect((await c.get('/api/auth/me')).body.phoneAlerts).toMatchObject({ available: true, hasPhone: true, state: 'pending' })

    const { member } = await orgWithPeople() // signed up with a number too, so their invitation is pending
    inviteState = 'accepted'
    await syncPhoneInvitations()
    expect((await c.get('/api/auth/me')).body.phoneAlerts.state).toBe('accepted')
    const notices = () => prisma.notification.count({ where: { userId: member.user.id, kind: 'phone_connected' } })
    expect(await notices()).toBe(1)
    await syncPhoneInvitations() // accepted numbers are left alone: no second notice
    expect(await notices()).toBe(1)
  })
})

describe('personal phone alerts', () => {
  it('invites the number (normalised) and reports acceptance', async () => {
    const { member } = await orgWithPeople()
    calls = []
    const r = await member.c.put('/api/me/phone').send({ phone: '+91 98765 43210' }).expect(200)
    expect(r.body).toMatchObject({ available: true, phone: '919876543210', state: 'pending' })
    expect(calls[0]).toMatchObject({ method: 'POST', body: { phone: '919876543210', label: 'KONVO' } })
    expect((await member.c.put('/api/me/phone').send({ phone: '12' })).status).toBe(400)
    inviteState = 'accepted'
    expect((await member.c.post('/api/me/phone/refresh')).body.state).toBe('accepted')
  })

  it('a critical task assigned to you rings your phone with two answers; switched off, it does not', async () => {
    const { manager, member } = await orgWithPeople()
    await connectPhone(member.c)
    calls = []
    await manager.c.post('/api/tasks').send({ title: 'Restore payments', priority: 'CRITICAL', assigneeId: member.user.id }).expect(201)
    const alert = calls.find((c) => c.url.endsWith('/api/v1/alerts'))!
    expect(alert.body).toMatchObject({
      phone: '919876543210',
      severity: 'HIGH',
      responseOptions: [
        { label: 'On it', effect: 'SHARED' },
        { label: 'Can’t take it', effect: 'SHARED', required: ['note'] },
      ],
    })
    expect(String(alert.body!.customId)).toMatch(/^task-assigned-/)
    // Ordinary, not-urgent work does not ring anybody.
    calls = []
    await manager.c.post('/api/tasks').send({ title: 'Tidy docs', priority: 'LOW', assigneeId: member.user.id }).expect(201)
    expect(calls.filter((c) => c.url.endsWith('/api/v1/alerts'))).toHaveLength(0)
    await member.c.patch('/api/me/alert-prefs').send({ task_assigned: false }).expect(200)
    await manager.c.post('/api/tasks').send({ title: 'Another fire', priority: 'CRITICAL', assigneeId: member.user.id }).expect(201)
    expect(calls.filter((c) => c.url.endsWith('/api/v1/alerts'))).toHaveLength(0)
  })

  it('“Can’t take it” passes the task to the next best person with the reason', async () => {
    const { manager, member } = await orgWithPeople()
    await connectPhone(member.c)
    const t = (await manager.c.post('/api/tasks').send({ title: 'Restore payments', priority: 'CRITICAL', assigneeId: member.user.id }).expect(201)).body.task
    decision = { label: 'Can’t take it', note: 'On leave today' }
    const savedAi = env.AI_PROVIDER
    env.AI_PROVIDER = ''
    try {
      await processPersonalAlerts()
    } finally {
      env.AI_PROVIDER = savedAi
    }
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id }, include: { comments: true } })
    expect(after.assigneeId).toBe(manager.user.id)
    expect(after.comments[0]!.body).toContain('On leave today')
    expect((await prisma.phoneAlert.findFirstOrThrow()).status).toBe('CLOSED')
    expect(calls.some((c) => c.url.endsWith('/alerts/close'))).toBe(true)
  })

  it('“On it” starts the task; a finished task closes its alert by itself', async () => {
    const { manager, member } = await orgWithPeople()
    await connectPhone(member.c)
    const t = (await manager.c.post('/api/tasks').send({ title: 'Ship fix', priority: 'CRITICAL', assigneeId: member.user.id })).body.task
    decision = { label: 'On it', note: null }
    await processPersonalAlerts()
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('IN_PROGRESS')
    decision = null
    const t2 = (await manager.c.post('/api/tasks').send({ title: 'Second', priority: 'CRITICAL', assigneeId: member.user.id })).body.task
    await member.c.patch(`/api/tasks/${t2.id}`).send({ status: 'COMPLETED' })
    await processPersonalAlerts()
    expect((await prisma.phoneAlert.findFirstOrThrow({ where: { refId: t2.id } })).status).toBe('CLOSED')
  })

  it('without M91 set up, the number is still saved (the worker invites it later) and a test says clearly why it cannot ring', async () => {
    const { member } = await orgWithPeople()
    env.M91_API_KEY = undefined
    calls = []
    const r = await member.c.put('/api/me/phone').send({ phone: '+919876543210' }).expect(200)
    expect(r.body).toMatchObject({ available: false, phone: '919876543210' })
    expect(calls).toHaveLength(0)
    const t = await member.c.post('/api/me/phone/test')
    expect(t.status).toBe(503)
    expect(t.body.error.message).toMatch(/administrator needs to add the M91 API key/)
  })
})

describe('inviting a teammate with their number', () => {
  it('sends the M91 invitation at once and pre-fills the number when they join', async () => {
    const { owner } = await orgWithPeople()
    calls = []
    const email = `newbie-${Date.now()}@x.com`
    const r = await owner.c.post('/api/invitations').send({ email, role: 'MEMBER', phone: '+91 98765 22222' }).expect(201)
    expect(calls.find((x) => x.url.endsWith('/recipients'))?.body).toMatchObject({ phone: '919876522222' })
    expect((await owner.c.post('/api/invitations').send({ email: `x${email}`, role: 'MEMBER', phone: '12' })).status).toBe(400)

    const token = new URL(r.body.link).searchParams.get('token')!
    const guest = client()
    expect((await guest.get('/api/invitations/lookup').query({ token })).body.phone).toBe('+919876522222')
    // Joining without typing the number again uses the one the inviter gave.
    await guest.post('/api/invitations/accept').send({ token, name: 'New Bie', password: 'Password123' }).expect(200)
    const me = await guest.get('/api/auth/me').expect(200)
    expect(me.body.phoneAlerts).toMatchObject({ hasPhone: true })
  })
})

describe('on-call channel', () => {
  it('raises one alert for a named condition and closes it when the condition clears', async () => {
    const { org } = await orgWithPeople()
    for (let i = 0; i < 3; i++)
      await prisma.syncEvent.create({
        data: { orgId: org.id, provider: 'linear', eventType: 'x', idempotencyKey: `d${i}`, payload: {}, status: 'DEAD', processedAt: new Date() },
      })
    await checkOps()
    await checkOps()
    const raised = calls.filter((c) => c.url.endsWith('/s/sk_test') && c.method === 'POST')
    expect(raised).toHaveLength(1)
    expect(raised[0]!.body).toMatchObject({
      customId: 'workpulse-sync-dead-linear',
      severity: 'HIGH',
      responseOptions: [{ effect: 'SHARED' }, { effect: 'PERSONAL' }],
    })
    await prisma.syncEvent.updateMany({ data: { status: 'PROCESSED' } })
    await checkOps()
    expect(calls.some((c) => c.url.endsWith('/s/sk_test/close') && c.body?.customId === 'workpulse-sync-dead-linear')).toBe(true)
  })
})

describe('on-call page', () => {
  it('shows the channel, conditions and history to admins only; test alert reports how many were reached', async () => {
    const { owner, member } = await orgWithPeople()
    expect((await member.c.get('/api/alerts/on-call')).status).toBe(403)
    const r = (await owner.c.get('/api/alerts/on-call').expect(200)).body
    expect(r).toMatchObject({ configured: true, personalAvailable: true })
    expect(r.conditions.length).toBeGreaterThan(5)
    expect((await owner.c.post('/api/alerts/on-call/test').expect(200)).body).toEqual({ delivered: 1 })
    const sent = calls.find((c) => c.method === 'POST' && c.url.endsWith('/s/sk_test'))!
    expect(sent.body).toMatchObject({ severity: 'LOW', isAutoClose: true })
    expect((sent.body!.responseOptions as unknown[]).length).toBe(2)
    expect((await member.c.post('/api/alerts/on-call/test')).status).toBe(403)
  })
})

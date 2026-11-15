import { describe, expect, it } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { orgWithPeople, signUp } from './helpers.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

describe('tasks', () => {
  it('creates, updates, lists with filters and soft-deletes', async () => {
    const { owner } = await orgWithPeople()
    const project = (await owner.c.post('/api/projects').send({ name: 'Checkout' }).expect(201)).body.project
    const t = (
      await owner.c
        .post('/api/tasks')
        .send({ title: 'Payment form', projectId: project.id, priority: 'HIGH', impactLevel: 'HIGH', dueAt: '2026-12-01', labels: ['web'] })
        .expect(201)
    ).body.task
    expect(t).toMatchObject({ status: 'TODO', assigneeId: owner.user.id, origin: 'NATIVE' })
    await owner.c.post('/api/tasks').send({ title: 'Other', priority: 'LOW' })
    expect((await owner.c.get(`/api/tasks?projectId=${project.id}`)).body.total).toBe(1)
    expect((await owner.c.get('/api/tasks?priority=HIGH&priority=LOW')).body.total).toBe(2)
    expect((await owner.c.get('/api/tasks?q=payment')).body.items[0].id).toBe(t.id)
    expect((await owner.c.get('/api/tasks?provider=native')).body.total).toBe(2)

    const done = (await owner.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })).body.task
    expect(done.completedAt).not.toBeNull()
    const reopened = (await owner.c.patch(`/api/tasks/${t.id}`).send({ status: 'IN_PROGRESS' })).body.task
    expect(reopened).toMatchObject({ reopenCount: 1, completedAt: null })
    const activity = (await owner.c.get(`/api/tasks/${t.id}/activity`)).body.activity
    expect(activity.some((a: { field: string }) => a.field === 'status')).toBe(true)

    await owner.c.del(`/api/tasks/${t.id}`).expect(204)
    expect((await owner.c.get(`/api/tasks/${t.id}`)).status).toBe(404)
  })

  it('supports subtasks, dependencies (no cycles) and goal links', async () => {
    const { owner } = await orgWithPeople()
    const a = (await owner.c.post('/api/tasks').send({ title: 'A' })).body.task
    const b = (await owner.c.post('/api/tasks').send({ title: 'B', dependsOnIds: [a.id] })).body.task
    const sub = (await owner.c.post('/api/tasks').send({ title: 'A.1', parentId: a.id })).body.task
    const detail = (await owner.c.get(`/api/tasks/${a.id}`)).body.task
    expect(detail.subtasks.map((s: { id: string }) => s.id)).toEqual([sub.id])
    expect(detail.blocking.map((s: { id: string }) => s.id)).toEqual([b.id])
    expect((await owner.c.patch(`/api/tasks/${a.id}`).send({ dependsOnIds: [b.id] })).status).toBe(400)
    const goal = (await owner.c.post('/api/goals').send({ title: 'Launch', period: 'QUARTERLY', startDate: '2026-10-01', dueDate: '2026-12-31' })).body.goal
    await owner.c
      .patch(`/api/tasks/${b.id}`)
      .send({ goalIds: [goal.id] })
      .expect(200)
    expect((await owner.c.get(`/api/tasks?goalId=${goal.id}`)).body.total).toBe(1)
  })

  it('reporting a blocker blocks the task; resolving the last one unblocks it', async () => {
    const { manager, member } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Integrate API', status: 'IN_PROGRESS' })).body.task
    const blocker = (await member.c.post(`/api/tasks/${t.id}/blockers`).send({ reason: 'Waiting for vendor keys', kind: 'EXTERNAL' }).expect(201)).body.blocker
    expect((await member.c.get(`/api/tasks/${t.id}`)).body.task.status).toBe('BLOCKED')
    expect((await manager.c.get('/api/notifications')).body.items.some((n: { kind: string }) => n.kind === 'blocker')).toBe(true)
    await member.c.post(`/api/blockers/${blocker.id}/resolve`).send({ resolution: 'Keys received' }).expect(200)
    expect((await member.c.get(`/api/tasks/${t.id}`)).body.task.status).toBe('IN_PROGRESS')
  })

  it('creates the next occurrence when a recurring task completes', async () => {
    const { owner } = await orgWithPeople()
    const t = (await owner.c.post('/api/tasks').send({ title: 'Weekly sync notes', recurrenceRule: 'WEEKLY', dueAt: '2026-11-06T10:00:00Z' })).body.task
    await owner.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })
    const next = await prisma.task.findFirst({ where: { title: 'Weekly sync notes', status: 'TODO' } })
    expect(next?.dueAt?.toISOString()).toBe('2026-11-13T10:00:00.000Z')
  })

  it('bulk actions skip tasks the caller cannot change', async () => {
    const { manager, member, other } = await orgWithPeople()
    const m = (await member.c.post('/api/tasks').send({ title: 'm' })).body.task
    const o = (await other.c.post('/api/tasks').send({ title: 'o' })).body.task
    const r = (await manager.c.post('/api/tasks/bulk').send({ ids: [m.id, o.id], action: 'priority', value: 'CRITICAL' })).body
    expect(r).toEqual({ updated: 1, skipped: [o.id] })
  })

  it('validates and stores attachments; rejects content that does not match its type', async () => {
    const { owner } = await orgWithPeople()
    const t = (await owner.c.post('/api/tasks').send({ title: 'Design' })).body.task
    await owner.c.post(`/api/tasks/${t.id}/attachments`).attach('file', PNG, { filename: 'mock.png', contentType: 'image/png' }).expect(201)
    const bad = await owner.c
      .post(`/api/tasks/${t.id}/attachments`)
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' })
    expect(bad.status).toBe(400)
    const exe = await owner.c
      .post(`/api/tasks/${t.id}/attachments`)
      .attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' })
    expect(exe.status).toBe(400)
  })

  it('only the assignee’s manager assesses completed work, never their own', async () => {
    const { manager, member, owner } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Feature' })).body.task
    expect((await manager.c.put(`/api/tasks/${t.id}/assessment`).send({ quality: 4 })).status).toBe(409)
    await member.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })
    expect((await member.c.put(`/api/tasks/${t.id}/assessment`).send({ quality: 5 })).status).toBe(403)
    await manager.c.put(`/api/tasks/${t.id}/assessment`).send({ quality: 4, impact: 'HIGH' }).expect(200)
    const own = (await owner.c.post('/api/tasks').send({ title: 'Owner own' })).body.task
    await owner.c.patch(`/api/tasks/${own.id}`).send({ status: 'COMPLETED' })
    expect((await owner.c.put(`/api/tasks/${own.id}/assessment`).send({ quality: 5 })).status).toBe(403)
  })
})

describe('goals and OKRs', () => {
  it('derives progress from key results, keeps history, and ignores task counts', async () => {
    const { owner } = await orgWithPeople()
    const g = (
      await owner.c
        .post('/api/goals')
        .send({
          title: 'Grow activation',
          period: 'QUARTERLY',
          startDate: '2026-10-01',
          dueDate: '2026-12-31',
          keyResults: [{ title: 'Activation %', start: 20, target: 40, current: 20 }],
        })
        .expect(201)
    ).body.goal
    expect(g.progress).toBe(0)
    for (let i = 0; i < 5; i++) {
      const t = (await owner.c.post('/api/tasks').send({ title: `t${i}`, goalIds: [g.id] })).body.task
      await owner.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })
    }
    expect((await owner.c.get(`/api/goals/${g.id}`)).body.goal).toMatchObject({ progress: 0, completedTasks: 5, progressSource: 'key_results' })
    const kr = g.keyResults[0]
    await owner.c.patch(`/api/key-results/${kr.id}`).send({ current: 30 }).expect(200)
    const after = (await owner.c.get(`/api/goals/${g.id}`)).body.goal
    expect(after.progress).toBe(50)
    expect(after.updates.length).toBeGreaterThan(0)
    // With key results, progress cannot be typed over.
    await owner.c.patch(`/api/goals/${g.id}`).send({ progress: 99 })
    expect((await owner.c.get(`/api/goals/${g.id}`)).body.goal.progress).toBe(50)
  })

  it('members set their own goals; managers set goals for their people only', async () => {
    const { manager, member, other } = await orgWithPeople()
    await member.c.post('/api/goals').send({ title: 'Mine', period: 'WEEKLY', startDate: '2026-11-09', dueDate: '2026-11-15' }).expect(201)
    expect(
      (await member.c.post('/api/goals').send({ title: 'For other', period: 'WEEKLY', startDate: '2026-11-09', dueDate: '2026-11-15', ownerId: other.user.id }))
        .status,
    ).toBe(403)
    await manager.c
      .post('/api/goals')
      .send({ title: 'For member', period: 'MONTHLY', startDate: '2026-11-01', dueDate: '2026-11-30', ownerId: member.user.id })
      .expect(201)
    expect(
      (await manager.c.post('/api/goals').send({ title: 'x', period: 'MONTHLY', startDate: '2026-11-01', dueDate: '2026-11-30', ownerId: other.user.id }))
        .status,
    ).toBe(403)
  })
})

describe('daily planner and work sessions', () => {
  it('plans, tracks focus time into actual effort, and requires reasons for carried-forward work', async () => {
    const { member } = await orgWithPeople()
    const a = (await member.c.post('/api/tasks').send({ title: 'Write spec', estimateMins: 60 })).body.task
    const b = (await member.c.post('/api/tasks').send({ title: 'Review PR' })).body.task
    await member.c
      .put('/api/planner')
      .send({ date: '2026-11-16', topOutcomes: [{ text: 'Spec approved', taskId: a.id }], plannedTaskIds: [a.id, b.id] })
      .expect(200)
    await member.c.post('/api/sessions/start').send({ taskId: a.id }).expect(201)
    expect((await member.c.get(`/api/tasks/${a.id}`)).body.task.status).toBe('IN_PROGRESS')
    await prisma.workSession.updateMany({ where: { taskId: a.id }, data: { startedAt: new Date(Date.now() - 45 * 60000) } })
    expect((await member.c.post('/api/sessions/stop')).body.session.minutes).toBe(45)
    expect((await member.c.get(`/api/tasks/${a.id}`)).body.task.actualMins).toBe(45)
    await member.c.patch(`/api/tasks/${a.id}`).send({ status: 'COMPLETED' })

    const missing = await member.c.post('/api/planner/review').send({ date: '2026-11-16', review: 'Good day', carryForward: [] })
    expect(missing.status).toBe(400)
    expect(missing.body.error.details.taskIds).toEqual([b.id])
    await member.c
      .post('/api/planner/review')
      .send({ date: '2026-11-16', review: 'Good day', carryForward: [{ taskId: b.id, reason: 'Author still fixing tests' }] })
      .expect(200)
    const next = await prisma.dailyPlan.findFirst({ where: { date: '2026-11-17' } })
    expect(next?.plannedTaskIds).toEqual([b.id])
    const view = (await member.c.get('/api/planner/2026-11-16')).body
    expect(view.plan.topOutcomes[0].text).toBe('Spec approved')
  })

  it('cannot plan or time someone else’s tasks', async () => {
    const { member, other } = await orgWithPeople()
    const o = (await other.c.post('/api/tasks').send({ title: 'theirs' })).body.task
    expect((await member.c.put('/api/planner').send({ date: '2026-11-16', plannedTaskIds: [o.id] })).status).toBe(404)
    expect((await member.c.post('/api/sessions/start').send({ taskId: o.id })).status).toBe(404)
  })
})

describe('evidence and verification', () => {
  it('records received → verified separately from quality and impact, by the manager only', async () => {
    const { manager, member } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Launch page', impactLevel: 'HIGH' })).body.task
    const ev = (
      await member.c
        .post('/api/evidence')
        .send({ taskId: t.id, kind: 'DEPLOYMENT', title: 'Production deploy', url: 'https://acme.example/launch' })
        .expect(201)
    ).body.evidence
    expect(ev.status).toBe('RECEIVED')
    expect((await member.c.post(`/api/evidence/${ev.id}/verify`).send({ status: 'VERIFIED' })).status).toBe(403)
    await manager.c.post(`/api/evidence/${ev.id}/verify`).send({ status: 'VERIFIED', qualityScore: 4, impactNote: 'Conversion +3%' }).expect(200)
    const list = (await manager.c.get(`/api/evidence?taskId=${t.id}`)).body.items
    expect(list[0]).toMatchObject({ status: 'VERIFIED' })
    expect(list[0].verifications[0]).toMatchObject({ qualityScore: 4, impactNote: 'Conversion +3%' })
    expect((await member.c.post('/api/evidence').send({ taskId: t.id, kind: 'URL', title: 'x', url: 'javascript:alert(1)' })).status).toBe(400)
  })

  it('uploads evidence files with type checks', async () => {
    const { member } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Screens' })).body.task
    const r = await member.c
      .post('/api/evidence/upload')
      .field('taskId', t.id)
      .field('title', 'Screenshot')
      .attach('file', PNG, { filename: 's.png', contentType: 'image/png' })
      .expect(201)
    expect(r.body.evidence.kind).toBe('SCREENSHOT')
    const file = await member.c.get(`/api/evidence/${r.body.evidence.id}/file`)
    expect(file.status).toBe(200)
    expect(file.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('analytics and reports', () => {
  it('computes individual analytics from real data and explains missing dimensions', async () => {
    const { manager, member } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Big outcome', impactLevel: 'CRITICAL', dueAt: new Date(Date.now() + 864e5).toISOString() }))
      .body.task
    await member.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })
    await manager.c.put(`/api/tasks/${t.id}/assessment`).send({ quality: 5 })
    const a = (await member.c.get('/api/analytics/individual')).body
    expect(a.kpis.completedOutcomes).toBe(1)
    expect(a.kpis.highImpactCompleted).toBe(1)
    expect(a.score.dimensions.quality.value).toBe(100)
    expect(a.score.dimensions.reliability.value).toBe(100)
    expect(a.score.dimensions.alignment.value).toBe(0)
    expect(a.weekly.length).toBeGreaterThan(0)
  })

  it('team analytics: managers see their team, filters apply, members are refused', async () => {
    const { manager, member, team, owner } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Team work', impactLevel: 'HIGH' })).body.task
    await member.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })
    const r = (await manager.c.get(`/api/analytics/team?teamId=${team.id}`)).body
    expect(r.members.map((m: { name: string }) => m.name).sort()).toEqual(['Manager', 'Member'])
    expect(r.kpis.highImpactOutcomes).toBe(1)
    expect(r.health).toHaveProperty('overloaded')
    expect((await manager.c.get(`/api/analytics/team?teamId=${(await prisma.team.findFirst({ where: { name: 'Growth' } }))!.id}`)).status).toBe(404)
    expect((await owner.c.get('/api/analytics/team')).body.memberCount).toBe(5)
  })

  it('generates daily and weekly reports with CSV and PDF export', async () => {
    const { member } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Release v2', impactLevel: 'HIGH' })).body.task
    await member.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })
    const daily = (await member.c.get('/api/reports/daily')).body.report
    expect(daily.content.sections.find((s: { heading: string }) => s.heading === 'Delivered').items[0]).toContain('Release v2')
    const weekly = (
      await member.c
        .post('/api/reports/generate')
        .send({ kind: 'WEEKLY', subject: `user:${member.user.id}`, date: new Date().toISOString().slice(0, 10) })
        .expect(201)
    ).body.report
    expect(weekly.content.sections.map((s: { heading: string }) => s.heading)).toContain('Major accomplishments')
    const csv = await member.c.get(`/api/reports/${weekly.id}/export.csv`).expect(200)
    expect(csv.text).toContain('section,item')
    const pdf = await member.c
      .get(`/api/reports/${weekly.id}/export.pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
    expect((await member.c.get('/api/reports')).body.items.length).toBe(2)
  })

  it('report subjects are scoped: no reports about people you cannot see', async () => {
    const { member, other } = await orgWithPeople()
    expect((await member.c.post('/api/reports/generate').send({ kind: 'DAILY', subject: `user:${other.user.id}` })).status).toBe(404)
  })
})

describe('feedback and corrections', () => {
  it('runs the feedback → acknowledgement and dispute → resolution loop', async () => {
    const { manager, member } = await orgWithPeople()
    const fb = (
      await manager.c
        .post('/api/feedback')
        .send({ subjectUserId: member.user.id, kind: 'MANAGER', body: 'Strong ownership of the launch', rating: 4 })
        .expect(201)
    ).body.feedback
    await member.c.post(`/api/feedback/${fb.id}/acknowledge`).send({ response: 'Thanks!' }).expect(200)
    await member.c.post('/api/feedback').send({ subjectUserId: member.user.id, kind: 'SELF', body: 'I delivered the launch' }).expect(201)
    expect((await member.c.post('/api/feedback').send({ subjectUserId: manager.user.id, kind: 'MANAGER', body: 'nope' })).status).toBe(403)
    const t = (await member.c.post('/api/tasks').send({ title: 'Mis-rated' })).body.task
    const cr = (
      await member.c
        .post('/api/corrections')
        .send({ targetType: 'TASK', targetId: t.id, field: 'impactLevel', reason: 'This unblocked the whole release; impact should be HIGH.' })
        .expect(201)
    ).body.correction
    expect((await member.c.post(`/api/corrections/${cr.id}/resolve`).send({ status: 'ACCEPTED', resolution: 'self' })).status).toBe(403)
    await manager.c.post(`/api/corrections/${cr.id}/resolve`).send({ status: 'ACCEPTED', resolution: 'Agreed, updated to HIGH.' }).expect(200)
  })
})

describe('notifications', () => {
  it('lists and marks notifications read', async () => {
    const { manager, member } = await orgWithPeople()
    await manager.c.post('/api/tasks').send({ title: 'Assigned', assigneeId: member.user.id })
    const n = (await member.c.get('/api/notifications')).body
    expect(n.unread).toBe(1)
    await member.c.post('/api/notifications/read').send({}).expect(200)
    expect((await member.c.get('/api/notifications')).body.unread).toBe(0)
  })

  it('a user without an organization cannot reach org routes', async () => {
    const { c } = await signUp('Lonely')
    expect((await c.get('/api/tasks')).status).toBe(403)
  })
})

describe('date ranges', () => {
  it('a date-only "to" includes work completed later that same day', async () => {
    const { member } = await orgWithPeople()
    const t = (await member.c.post('/api/tasks').send({ title: 'Done today', impactLevel: 'HIGH' })).body.task
    await member.c.patch(`/api/tasks/${t.id}`).send({ status: 'COMPLETED' })
    const today = new Date().toISOString().slice(0, 10)
    const a = (await member.c.get(`/api/analytics/individual?to=${today}`)).body
    expect(a.kpis.completedOutcomes).toBe(1)
  })
})

describe('delivery errors are explained in plain language', () => {
  it('Slack not connected, connected in another organization, and email without a sender', async () => {
    const { member } = await orgWithPeople()
    const report = (await member.c.post('/api/reports/generate').send({ kind: 'DAILY', subject: `user:${member.user.id}` })).body.report
    const r1 = await member.c.post(`/api/reports/${report.id}/deliver`).send({ channel: 'SLACK' })
    expect(r1.status).toBe(409)
    expect(r1.body.error.message).toMatch(/Slack isn’t connected yet. Open Integrations/)
    // A Slack connection that belongs to the same person's other organization.
    const other = await prisma.organization.create({ data: { name: 'Other Org', slug: 'other-org-x' } })
    await prisma.integrationConnection.create({
      data: { orgId: other.id, userId: member.user.id, provider: 'slack', authIdEnc: 'x', authIdHash: 'h2', settings: {} },
    })
    const r2 = await member.c.post(`/api/reports/${report.id}/deliver`).send({ channel: 'SLACK' })
    expect(r2.body.error.message).toMatch(/connected in your other organization \(Other Org\), not this one/)
    const r3 = await member.c.post(`/api/reports/${report.id}/deliver`).send({ channel: 'EMAIL' })
    expect(r3.status).toBe(409)
    expect(r3.body.error.message).toMatch(/Email isn’t set up yet/)
    const history = (await member.c.get(`/api/reports/${report.id}`)).body.report.deliveries
    expect(history[0].error).toMatch(/Email isn’t set up yet/)
  })
})

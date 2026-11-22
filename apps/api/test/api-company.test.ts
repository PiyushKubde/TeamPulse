import { describe, expect, it } from 'vitest'
import { kpiAttainment } from '../src/modules/company.js'
import { orgWithPeople } from './helpers.js'

type Person = { userId: string; depth: number; subtreeSize: number; directReports: number; reportsToId: string | null; rollupOverall: number | null }

async function withLines() {
  const t = await orgWithPeople()
  const set = (who: { user: { id: string } }, boss: { user: { id: string } } | null) =>
    t.owner.c.patch(`/api/members/${who.user.id}`).send({ reportsToId: boss ? boss.user.id : null })
  await set(t.manager, t.owner).expect(200)
  await set(t.mentor, t.owner).expect(200)
  await set(t.member, t.manager).expect(200)
  await set(t.other, t.manager).expect(200)
  return t
}

describe('reporting lines and departments', () => {
  it('only admins set them, and loops are refused', async () => {
    const t = await withLines()
    expect((await t.member.c.patch(`/api/members/${t.member.user.id}`).send({ reportsToId: t.owner.user.id })).status).toBe(403)
    // The owner reporting to their own report would be a loop; so would reporting to oneself.
    expect((await t.owner.c.patch(`/api/members/${t.owner.user.id}`).send({ reportsToId: t.member.user.id })).status).toBe(400)
    expect((await t.owner.c.patch(`/api/members/${t.member.user.id}`).send({ reportsToId: t.member.user.id })).status).toBe(400)
    const members = (await t.owner.c.get('/api/members')).body.members as { userId: string; reportsToId: string | null }[]
    expect(members.find((m) => m.userId === t.member.user.id)?.reportsToId).toBe(t.manager.user.id)
  })

  it('keeps departments a tree', async () => {
    const t = await withLines()
    await t.owner.c.patch(`/api/teams/${t.team2.id}`).send({ parentId: t.team.id }).expect(200)
    expect((await t.owner.c.patch(`/api/teams/${t.team.id}`).send({ parentId: t.team2.id })).status).toBe(400)
    expect((await t.owner.c.patch(`/api/teams/${t.team.id}`).send({ parentId: t.team.id })).status).toBe(400)
    const teams = (await t.owner.c.get('/api/teams')).body.teams as { id: string; parentId: string | null }[]
    expect(teams.find((x) => x.id === t.team2.id)?.parentId).toBe(t.team.id)
  })
})

describe('company overview', () => {
  it('shows the whole tree to everyone, with roll-ups', async () => {
    const t = await withLines()
    const o = (await t.member.c.get('/api/company/overview').expect(200)).body
    expect(o.transparency).toBe('OPEN')
    const people = o.people as Person[]
    expect(people).toHaveLength(5)
    const top = people.find((p) => p.userId === t.owner.user.id)!
    expect(top).toMatchObject({ depth: 0, subtreeSize: 4, directReports: 2 })
    expect(people.find((p) => p.userId === t.member.user.id)).toMatchObject({ depth: 2, reportsToId: t.manager.user.id })
    // No task detail is ever part of the company view.
    expect(JSON.stringify(o)).not.toMatch(/"tasks"|"comments"|"attachments"|"activity"/)
    expect(o.teams.length).toBe(2)
  })

  it('scopes to the lines a person could already see when the company is private', async () => {
    const t = await withLines()
    await t.owner.c
      .patch('/api/organization')
      .send({ settings: { transparency: 'PRIVATE' } })
      .expect(200)
    const mine = (await t.member.c.get('/api/company/overview').expect(200)).body
    expect(mine.transparency).toBe('PRIVATE')
    expect((mine.people as Person[]).map((p) => p.userId)).toEqual([t.member.user.id])
    expect((await t.member.c.get(`/api/company/people/${t.other.user.id}`)).status).toBe(404)
    // Owners still see everyone, and the flag reports the real setting.
    const all = (await t.owner.c.get('/api/company/overview').expect(200)).body
    expect(all.transparency).toBe('PRIVATE')
    expect(all.people).toHaveLength(5)
  })

  it('gives a person scorecard with their chain, reports and peers', async () => {
    const t = await withLines()
    const card = (await t.other.c.get(`/api/company/people/${t.member.user.id}`).expect(200)).body
    expect(card.chain.map((c: { userId: string }) => c.userId)).toEqual([t.owner.user.id, t.manager.user.id])
    expect(card.peers.map((p: { userId: string }) => p.userId)).toEqual([t.other.user.id])
    expect(card.person.dimensionDetail).toBeTruthy()
  })
})

describe('kpis', () => {
  const base = { name: 'Uptime', unit: '%', baseline: 99, target: 100, direction: 'HIGHER', cadence: 'MONTHLY' }

  it('measures progress from baseline to target, either direction', () => {
    expect(kpiAttainment({ direction: 'HIGHER', baseline: 0, target: 10, current: 5 })).toBe(50)
    expect(kpiAttainment({ direction: 'LOWER', baseline: 900, target: 300, current: 600 })).toBe(50)
    expect(kpiAttainment({ direction: 'LOWER', baseline: 900, target: 300, current: 1200 })).toBe(0)
    expect(kpiAttainment({ direction: 'HIGHER', baseline: 5, target: 5, current: 5 })).toBe(100)
  })

  it('lets anyone, the owner of the company included, own KPIs and log readings', async () => {
    const t = await withLines()
    const mine = (
      await t.owner.c
        .post('/api/kpis')
        .send({ ...base, name: 'Revenue', baseline: 40, target: 60 })
        .expect(201)
    ).body.kpi
    expect(mine).toMatchObject({ ownerId: t.owner.user.id, current: 40, attainment: 0 })
    const after = (await t.owner.c.post(`/api/kpis/${mine.id}/readings`).send({ value: 50, note: 'Q3' }).expect(201)).body.kpi
    expect(after).toMatchObject({ current: 50, attainment: 50 })
    expect(after.readings.map((r: { value: number }) => r.value)).toEqual([40, 50])
    // Everyone can read it...
    const seen = (await t.other.c.get(`/api/kpis?ownerId=${t.owner.user.id}`).expect(200)).body.kpis
    expect(seen).toHaveLength(1)
    expect(seen[0].canEdit).toBe(false)
    // ...but only the owner (or someone who manages them) can change it.
    expect((await t.other.c.post(`/api/kpis/${mine.id}/readings`).send({ value: 60 })).status).toBe(403)
    expect((await t.other.c.del(`/api/kpis/${mine.id}`)).status).toBe(403)
  })

  it('lets a manager set KPIs for their people, but not for others', async () => {
    const t = await withLines()
    await t.manager.c
      .post('/api/kpis')
      .send({ ...base, ownerId: t.member.user.id })
      .expect(201)
    expect((await t.manager.c.post('/api/kpis').send({ ...base, ownerId: t.mentor.user.id })).status).toBe(403)
    expect((await t.other.c.post('/api/kpis').send({ ...base, ownerId: t.member.user.id })).status).toBe(403)
  })

  it('feeds the goal cascade and the overview', async () => {
    const t = await withLines()
    const goal = (await t.owner.c.post('/api/goals').send({ title: 'Grow', period: 'QUARTERLY', startDate: '2026-10-01', dueDate: '2026-12-31' }).expect(201))
      .body.goal
    await t.owner.c
      .post('/api/kpis')
      .send({ ...base, goalId: goal.id })
      .expect(201)
    const cascade = (await t.member.c.get('/api/company/cascade').expect(200)).body
    expect(cascade.goals.map((g: { id: string }) => g.id)).toContain(goal.id)
    expect(cascade.kpis[0]).toMatchObject({ goalId: goal.id, ownerName: expect.any(String) })
    const ov = (await t.member.c.get('/api/company/overview').expect(200)).body.people as { userId: string; kpiCount: number }[]
    expect(ov.find((p) => p.userId === t.owner.user.id)?.kpiCount).toBe(1)
  })
})

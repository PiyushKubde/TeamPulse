import { describe, expect, it } from 'vitest'
import { orgWithPeople, signUp } from './helpers.js'

// SQLite allows one writer at a time. Simultaneous writes, including transactions on other pooled connections, must
// wait their turn (busy timeout) instead of failing with "database is locked" (a 500 seen in the e2e run).
describe('simultaneous writes', () => {
  it('many people creating organizations and tasks at once all succeed', async () => {
    const people = await Promise.all(Array.from({ length: 8 }, (_, i) => signUp(`Busy${i}`)))
    const orgs = await Promise.all(people.map((p, i) => p.c.post('/api/organizations').send({ name: `Busy Org ${i}` })))
    expect(orgs.map((r) => r.status)).toEqual(people.map(() => 201))

    const { manager, member } = await orgWithPeople()
    const tasks = await Promise.all(
      Array.from({ length: 30 }, (_, i) => manager.c.post('/api/tasks').send({ title: `Parallel ${i}`, assigneeId: member.user.id })),
    )
    expect(tasks.filter((r) => r.status !== 201).map((r) => `${r.status} ${JSON.stringify(r.body)}`)).toEqual([])
  })
})

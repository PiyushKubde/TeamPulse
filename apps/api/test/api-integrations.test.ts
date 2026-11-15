// MOCKED integration tests: the viaSocket transport is a deterministic fake (test/fake-viasocket.ts).
// They prove WorkPulse's own logic; real-account results are recorded separately in docs/viasocket-test-report.md.
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { processSyncEvent, MAX_ATTEMPTS } from '../src/integrations/ingest.js'
import { app, orgWithPeople, type Client } from './helpers.js'
import { fakeViasocket } from './fake-viasocket.js'

const issue = (over: Record<string, unknown> = {}) => ({
  id: 'lin_123',
  identifier: 'ENG-42',
  title: 'Implement authentication',
  state: { name: 'In Progress', type: 'started' },
  priority: 2,
  assignee: null,
  url: 'https://linear.app/acme/issue/ENG-42',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...over,
})

/** Connects Linear for the client, picks a team, and returns the subscription tokens captured from the handlers. */
async function connectLinear(c: Client, userId: string, settings: Record<string, unknown> = { teamId: 'team-1' }) {
  fakeViasocket.addConnection(userId, 'linear', 'auth-linear-1')
  const conn = (await c.post('/api/integrations/connect').send({ provider: 'linear', authId: 'auth-linear-1' }).expect(201)).body.connection
  const patched = await c.patch(`/api/integrations/connections/${conn.id}`).send(settings).expect(200)
  const subs = fakeViasocket.subscriptions.filter((s) => s.user === userId)
  const handlers = Object.fromEntries(
    subs.map((s) => {
      const url = /"(https:[^"]+)"/.exec(s.code!)![1]!
      const token = /Bearer ([\w-]+)/.exec(s.code!)![1]!
      return [s.trigger, { path: new URL(url).pathname, token }]
    }),
  )
  return { conn, patched: patched.body, handlers }
}

const deliver = (h: { path: string; token: string }, event: unknown) => request(app).post(h.path).set('authorization', `Bearer ${h.token}`).send({ event })

describe('connections', () => {
  it('refuses an auth_id that is not the user’s own connection', async () => {
    const { member, other } = await orgWithPeople()
    fakeViasocket.addConnection(other.user.id, 'linear', 'auth-of-other')
    const r = await member.c.post('/api/integrations/connect').send({ provider: 'linear', authId: 'auth-of-other' })
    expect(r.status).toBe(400)
  })

  it('stores auth_id and script_ids encrypted and never returns them', async () => {
    const { member } = await orgWithPeople()
    const { conn } = await connectLinear(member.c, member.user.id)
    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id }, include: { subscriptions: true } })
    expect(row.authIdEnc).not.toContain('auth-linear-1')
    expect(row.subscriptions.every((s) => s.scriptIdEnc && !s.scriptIdEnc.startsWith('scri-'))).toBe(true)
    const listed = JSON.stringify((await member.c.get('/api/integrations')).body)
    expect(listed).not.toContain('auth-linear-1')
    expect(listed).not.toContain('scri-')
  })

  it('subscribes the catalog triggers with the team chosen once after Connect', async () => {
    const { member } = await orgWithPeople()
    await connectLinear(member.c, member.user.id)
    expect(fakeViasocket.subscriptions.map((s) => `${s.trigger}:${JSON.stringify(s.inputData)}`).sort()).toEqual([
      'New_Issue_Comment:{"team_id":"team-1"}',
      'New_Issue_Created:{"team_id":"team-1"}',
      'Updated_Issue:{"team_id":"team-1"}',
    ])
  })

  it('another user cannot use or configure someone else’s connection', async () => {
    const { member, manager } = await orgWithPeople()
    const { conn } = await connectLinear(member.c, member.user.id)
    expect((await manager.c.patch(`/api/integrations/connections/${conn.id}`).send({ teamId: 'x' })).status).toBe(404)
    expect((await manager.c.get(`/api/integrations/connections/${conn.id}/options?fieldKey=team_id`)).status).toBe(404)
    expect((await manager.c.post('/api/integrations/disconnect').send({ connectionId: conn.id })).status).toBe(404)
  })

  it('records provider failures (rate limit / downtime) on the connection instead of crashing', async () => {
    const { member } = await orgWithPeople()
    fakeViasocket.failSubscribe = 'Too many requests'
    const { patched } = await connectLinear(member.c, member.user.id)
    expect(patched.connection.status).toBe('ERROR')
    expect(patched.connection.lastError).toContain('Too many requests')
  })

  it('disconnect deletes the flows and revokes the connection', async () => {
    const { member } = await orgWithPeople()
    const { conn } = await connectLinear(member.c, member.user.id)
    await member.c.post('/api/integrations/disconnect').send({ connectionId: conn.id }).expect(200)
    expect(fakeViasocket.deleted).toHaveLength(3)
    expect(fakeViasocket.revoked).toEqual(['auth-linear-1'])
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe('REVOKED')
  })

  it('marks expired connections so the UI offers Reconnect', async () => {
    const { member } = await orgWithPeople()
    const { conn } = await connectLinear(member.c, member.user.id)
    fakeViasocket.connections.set(member.user.id, [{ id: 'auth-linear-1', service_id: 'svc-linear', isExpired: true }])
    const list = (await member.c.get('/api/integrations')).body
    expect(list.providers.find((p: { slug: string }) => p.slug === 'linear').connections[0]).toMatchObject({ id: conn.id, status: 'EXPIRED' })
  })
})

describe('event ingestion', () => {
  it('rejects bad tokens, unknown subscriptions and malformed bodies', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    const h = handlers.New_Issue_Created!
    expect((await request(app).post(h.path).set('authorization', 'Bearer wrong-token-wrong-token').send({ event: issue() })).status).toBe(401)
    expect((await request(app).post(h.path.replace('/linear/', '/github/')).set('authorization', `Bearer ${h.token}`).send({ event: issue() })).status).toBe(
      401,
    )
    expect(
      (
        await request(app)
          .post('/api/integrations/events/linear/00000000-0000-0000-0000-000000000000')
          .set('authorization', `Bearer ${h.token}`)
          .send({ event: issue() })
      ).status,
    ).toBe(401)
    expect((await deliver(h, 'not an object')).status).toBe(400)
  })

  it('creates a normalized task from the spec’s Linear example', async () => {
    const { member } = await orgWithPeople()
    await prisma.user.update({ where: { id: member.user.id }, data: { email: 'alex@example.com' } })
    const { handlers } = await connectLinear(member.c, member.user.id)
    const r = await deliver(handlers.New_Issue_Created!, {
      action: 'create',
      type: 'Issue',
      data: issue({ assignee: { id: 'u1', name: 'Alex', email: 'Alex@Example.com' } }),
    })
    expect(r.status).toBe(202)
    const src = await prisma.taskSource.findFirstOrThrow({ where: { externalId: 'lin_123' }, include: { task: true } })
    expect(src).toMatchObject({ provider: 'linear', externalKey: 'ENG-42', sourceUrl: 'https://linear.app/acme/issue/ENG-42' })
    expect(src.task).toMatchObject({
      title: 'Implement authentication',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      assigneeId: member.user.id,
      origin: 'EXTERNAL',
      needsReview: false,
    })
    expect((await prisma.syncEvent.findFirstOrThrow()).status).toBe('PROCESSED')
  })

  it('absorbs duplicate deliveries (webhook retries) idempotently', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, issue()).expect(202)
    const dup = await deliver(handlers.New_Issue_Created!, issue())
    expect(dup.body).toEqual({ ok: true, duplicate: true })
    expect(await prisma.task.count()).toBe(1)
    expect(await prisma.syncEvent.count()).toBe(1)
  })

  it('skips out-of-order (stale) updates using the source timestamp', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.Updated_Issue!, issue({ title: 'Newest title', updatedAt: '2026-11-03T00:00:00.000Z' })).expect(202)
    await deliver(handlers.Updated_Issue!, issue({ title: 'Older title', updatedAt: '2026-11-02T00:00:00.000Z' })).expect(202)
    expect((await prisma.task.findFirstOrThrow()).title).toBe('Newest title')
    expect(await prisma.syncEvent.count({ where: { status: 'SKIPPED_STALE' } })).toBe(1)
  })

  it('applies updates and status changes; completion sets completedAt', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, issue()).expect(202)
    await deliver(
      handlers.Updated_Issue!,
      issue({ state: { name: 'Done', type: 'completed' }, priority: 1, dueDate: '2026-11-30', updatedAt: '2026-11-04T00:00:00.000Z' }),
    ).expect(202)
    const t = await prisma.task.findFirstOrThrow()
    expect(t).toMatchObject({ status: 'COMPLETED', priority: 'CRITICAL' })
    expect(t.completedAt).not.toBeNull()
    expect(t.dueAt?.toISOString().slice(0, 10)).toBe('2026-11-30')
  })

  it('never overwrites internal-only fields (impact, assessments, evidence verification, feedback)', async () => {
    const { member, manager } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, issue({ state: { name: 'Done', type: 'completed' } })).expect(202)
    const t = await prisma.task.findFirstOrThrow()
    await prisma.task.update({ where: { id: t.id }, data: { impactLevel: 'CRITICAL', complexity: 5, assigneeId: member.user.id } })
    await manager.c.put(`/api/tasks/${t.id}/assessment`).send({ quality: 5, impact: 'CRITICAL' }).expect(200)
    const ev = (await member.c.post('/api/evidence').send({ taskId: t.id, kind: 'URL', title: 'Doc', url: 'https://x.example' })).body.evidence
    await manager.c.post(`/api/evidence/${ev.id}/verify`).send({ status: 'VERIFIED' }).expect(200)
    // A hostile payload carrying internal field names is ignored: only mapped external fields are applied.
    await deliver(
      handlers.Updated_Issue!,
      issue({
        title: 'Renamed',
        state: { name: 'Done', type: 'completed' },
        impactLevel: 'NONE',
        complexity: 1,
        needsReview: true,
        updatedAt: '2026-11-05T00:00:00.000Z',
      }),
    ).expect(202)
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id }, include: { assessments: true, evidence: true } })
    expect(after).toMatchObject({ title: 'Renamed', impactLevel: 'CRITICAL', complexity: 5 })
    expect(after.assessments[0]).toMatchObject({ quality: 5, impact: 'CRITICAL' })
    expect(after.evidence[0]!.status).toBe('VERIFIED')
  })

  it('one-way: the external value wins for external fields; an unmapped assignee never clears the WorkPulse assignee', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, issue()).expect(202)
    const t = await prisma.task.findFirstOrThrow()
    await member.c.patch(`/api/tasks/${t.id}`).send({ title: 'Local edit', assigneeId: member.user.id }).expect(200)
    await deliver(handlers.Updated_Issue!, issue({ title: 'Remote edit', updatedAt: '2026-11-02T00:00:00.000Z' })).expect(202)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ title: 'Remote edit', assigneeId: member.user.id })
  })

  it('two-way: a field changed on both sides becomes a conflict a person resolves', async () => {
    const { member } = await orgWithPeople()
    const { conn, handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, issue()).expect(202)
    await member.c
      .patch(`/api/integrations/connections/${conn.id}`)
      .send({ syncMode: 'TWO_WAY', statusMap: { COMPLETED: 'state-done', IN_PROGRESS: 'state-doing' } })
      .expect(200)
    const t = await prisma.task.findFirstOrThrow()
    await member.c.patch(`/api/tasks/${t.id}`).send({ title: 'Local title' }).expect(200)
    await deliver(handlers.Updated_Issue!, issue({ title: 'Remote title', updatedAt: '2026-11-02T00:00:00.000Z' })).expect(202)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).title).toBe('Local title')
    const conflicts = (await member.c.get('/api/integrations/conflicts')).body.conflicts
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ field: 'title', externalValue: '"Remote title"' })
    await member.c.post(`/api/integrations/conflicts/${conflicts[0].id}/resolve`).send({ keep: 'external' }).expect(200)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).title).toBe('Remote title')
  })

  it('two-way needs a status map first and is refused for providers without it', async () => {
    const { member } = await orgWithPeople()
    const { conn } = await connectLinear(member.c, member.user.id)
    expect((await member.c.patch(`/api/integrations/connections/${conn.id}`).send({ syncMode: 'TWO_WAY' })).status).toBe(400)
    fakeViasocket.addConnection(member.user.id, 'jira-software-cloud', 'auth-jira')
    const jira = (await member.c.post('/api/integrations/connect').send({ provider: 'jira-software-cloud', authId: 'auth-jira' })).body.connection
    expect((await member.c.patch(`/api/integrations/connections/${jira.id}`).send({ syncMode: 'TWO_WAY', statusMap: { TODO: 'x' } })).status).toBe(400)
  })

  it('import-only connections take no live events', async () => {
    const { member } = await orgWithPeople()
    const { conn } = await connectLinear(member.c, member.user.id, { teamId: 'team-1', syncMode: 'IMPORT_ONLY' })
    expect(fakeViasocket.subscriptions).toHaveLength(0)
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } })).syncMode).toBe('IMPORT_ONLY')
  })

  it('unknown statuses are imported, flagged, and re-applied once a person approves a mapping', async () => {
    const { member, manager } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    // AI suggestions are best-effort; queue one so the suggestion path runs too.
    fakeViasocket.aiQueue.push({ toValue: 'IN_REVIEW', confidence: 0.8, reason: 'QA stage' })
    await deliver(handlers.New_Issue_Created!, issue({ state: { name: 'QA Ready' } })).expect(202)
    const t = await prisma.task.findFirstOrThrow()
    expect(t).toMatchObject({ status: 'TODO', needsReview: true })
    expect((await prisma.syncEvent.findFirstOrThrow()).status).toBe('NEEDS_MAPPING')
    const mapping = (await manager.c.get('/api/integrations/mappings')).body.mappings[0]
    expect(mapping).toMatchObject({ fromValue: 'QA Ready', toValue: 'IN_REVIEW', source: 'AI', active: false })
    expect((await member.c.post(`/api/integrations/mappings/${mapping.id}/decision`).send({ approve: true })).status).toBe(403)
    const d = (await manager.c.post(`/api/integrations/mappings/${mapping.id}/decision`).send({ approve: true }).expect(200)).body
    expect(d.reprocessed).toBe(1)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('IN_REVIEW')
  })

  it('invalid payloads fail permanently without retries; transient failures retry then dead-letter', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, { unexpected: 'shape' }).expect(202)
    const bad = await prisma.syncEvent.findFirstOrThrow()
    expect(bad).toMatchObject({ status: 'FAILED', attempts: 1 })
    expect(bad.error).toMatch(/Invalid payload/)

    // Transient: the connection disappears mid-flight → simulate a DB-level failure by deleting the subscription's task source later.
    const ok = await deliver(handlers.Updated_Issue!, issue({ updatedAt: '2026-11-09T00:00:00.000Z' }))
    const ev = await prisma.syncEvent.findUniqueOrThrow({ where: { id: ok.body.eventId } })
    expect(ev.status).toBe('PROCESSED')
    // Force retry exhaustion through the processor directly.
    await prisma.syncEvent.update({
      where: { id: ev.id },
      data: { status: 'FAILED', attempts: MAX_ATTEMPTS - 1, payload: { id: 'x', title: 'y', updatedAt: 'definitely-not-a-date' } },
    })
    await processSyncEvent(ev.id, { attempt: MAX_ATTEMPTS })
    expect((await prisma.syncEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('FAILED')
    const notes = (await member.c.get('/api/notifications')).body.items
    expect(notes.some((n: { kind: string }) => n.kind === 'integration_failure')).toBe(true)
  })

  it('retry re-queues a failed event and sync history is scoped to the owner', async () => {
    const { member, manager, owner } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, { broken: true }).expect(202)
    const ev = await prisma.syncEvent.findFirstOrThrow()
    expect((await member.c.get('/api/integrations/sync-history')).body.total).toBe(1)
    expect((await manager.c.get('/api/integrations/sync-history')).body.total).toBe(0)
    expect((await owner.c.get('/api/integrations/sync-history?all=true')).body.total).toBe(1)
    expect((await manager.c.post('/api/integrations/retry').send({ eventId: ev.id })).status).toBe(404)
    await prisma.syncEvent.update({ where: { id: ev.id }, data: { payload: issue() } })
    await member.c.post('/api/integrations/retry').send({ eventId: ev.id }).expect(200)
    expect((await prisma.syncEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('PROCESSED')
  })

  it('deleted/archived issues archive the task; comments attach to the imported task', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, issue()).expect(202)
    await deliver(handlers.New_Issue_Comment!, { id: 'c1', body: 'Please add tests', issueId: 'lin_123', user: { name: 'Sam' } }).expect(202)
    const t = await prisma.task.findFirstOrThrow({ include: { comments: true } })
    expect(t.comments[0]!.body).toContain('Please add tests')
    await deliver(handlers.Updated_Issue!, { action: 'remove', type: 'Issue', data: issue({ updatedAt: '2026-11-06T00:00:00.000Z' }) }).expect(202)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).archivedAt).not.toBeNull()
  })
})

describe('GitHub evidence', () => {
  async function connectGithub(c: Client, userId: string) {
    fakeViasocket.addConnection(userId, 'github', 'auth-gh')
    const conn = (await c.post('/api/integrations/connect').send({ provider: 'github', authId: 'auth-gh' })).body.connection
    await c
      .patch(`/api/integrations/connections/${conn.id}`)
      .send({ repos: ['acme/web', 'acme/api'] })
      .expect(200)
    return fakeViasocket.subscriptions
      .filter((s) => s.trigger === 'Pull_Request_Opens_or_Closes')
      .map((s) => ({
        repo: s.inputData.repoFullName,
        path: new URL(/"(https:[^"]+)"/.exec(s.code!)![1]!).pathname,
        token: /Bearer ([\w-]+)/.exec(s.code!)![1]!,
      }))
  }

  it('subscribes once per repository and turns PRs into evidence matched by task key', async () => {
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    await deliver(handlers.New_Issue_Created!, issue()).expect(202)
    const prHooks = await connectGithub(member.c, member.user.id)
    expect(prHooks.map((h) => h.repo).sort()).toEqual(['acme/api', 'acme/web'])
    expect(fakeViasocket.subscriptions.filter((s) => s.app === 'github')).toHaveLength(6) // PR, commit, release × 2 repos
    await deliver(prHooks[0]!, {
      action: 'closed',
      repository: { full_name: 'acme/web' },
      pull_request: { id: 1, number: 12, title: 'ENG-42: login flow', merged: true, state: 'closed', html_url: 'https://github.com/acme/web/pull/12' },
    }).expect(202)
    const ev = await prisma.evidence.findFirstOrThrow({ include: { task: true } })
    expect(ev).toMatchObject({ kind: 'PULL_REQUEST', source: 'GITHUB', status: 'RECEIVED' })
    expect(ev.task?.title).toBe('Implement authentication')
  })

  it('keeps unmatched items for the person to match; a merged PR is not auto-verified', async () => {
    const { member } = await orgWithPeople()
    const prHooks = await connectGithub(member.c, member.user.id)
    await deliver(prHooks[0]!, {
      action: 'opened',
      repository: { full_name: 'acme/web' },
      pull_request: { id: 2, number: 13, title: 'Refactor', state: 'open' },
    }).expect(202)
    const ev = await prisma.evidence.findFirstOrThrow()
    expect(ev.taskId).toBeNull()
    expect((await member.c.get('/api/evidence?unmatched=true')).body.total).toBe(1)
    const t = (await member.c.post('/api/tasks').send({ title: 'Refactor billing' })).body.task
    await member.c.post(`/api/evidence/${ev.id}/match`).send({ taskId: t.id }).expect(200)
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('RECEIVED')
  })
})

describe('retries and dead letters', () => {
  it('a transient failure stays FAILED (retryable) until the last attempt, then becomes DEAD', async () => {
    const { ADAPTERS } = await import('../src/integrations/providers/index.js')
    const { member } = await orgWithPeople()
    const { handlers } = await connectLinear(member.c, member.user.id)
    const real = ADAPTERS.linear!
    await deliver(handlers.New_Issue_Created!, issue()).expect(202)
    const ev = await prisma.syncEvent.findFirstOrThrow()
    await prisma.syncEvent.update({ where: { id: ev.id }, data: { status: 'FAILED' } })
    // The adapter accepts the payload, but writing it fails at the database (an invalid date): a transient-class error.
    const broken = {
      provider: 'linear',
      externalId: 'e1',
      externalKey: null,
      title: 't',
      description: null,
      rawStatus: null,
      rawStatusCategory: null,
      rawPriority: null,
      assignee: null,
      dueAt: new Date('invalid'),
      labels: [],
      sourceUrl: null,
      externalUpdatedAt: null,
      revision: null,
      deleted: false,
    }
    ADAPTERS.linear = { ...real, normalize: () => ({ type: 'task', items: [broken] }) } as never
    try {
      await expect(processSyncEvent(ev.id, { attempt: 2 })).rejects.toThrow()
      expect((await prisma.syncEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('FAILED')
      await expect(processSyncEvent(ev.id, { attempt: MAX_ATTEMPTS })).rejects.toThrow()
      expect((await prisma.syncEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('DEAD')
    } finally {
      ADAPTERS.linear = real
    }
  })
})

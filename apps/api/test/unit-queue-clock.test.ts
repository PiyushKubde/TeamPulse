import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { registerInline, run } from '../src/jobs/queues.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'

describe('in-process queue', () => {
  afterEach(() => vi.useRealTimers())

  it('retries a failing job with backoff and stops after it succeeds', async () => {
    vi.useFakeTimers()
    const attempts: number[] = []
    registerInline('ai', 'flaky', async (_d, attempt) => {
      attempts.push(attempt!)
      if (attempt! < 3) throw new Error('not yet')
    })
    const done = run('ai', 'flaky', {}, null)
    await vi.advanceTimersByTimeAsync(5000 + 10000)
    await done
    expect(attempts).toEqual([1, 2, 3])
  })

  it('gives up after 5 attempts', async () => {
    vi.useFakeTimers()
    let n = 0
    registerInline('ai', 'broken', async () => {
      n++
      throw new Error('always')
    })
    const done = run('ai', 'broken', {}, null)
    await vi.advanceTimersByTimeAsync(5000 + 10000 + 20000 + 40000)
    await done
    expect(n).toBe(5)
  })
})

describe('scheduler route', () => {
  afterEach(() => {
    env.CRON_SECRET = undefined
  })

  it('answers only Embarko’s scheduler (Bearer CRON_SECRET) and runs the named job', async () => {
    const app = createApp()
    expect((await request(app).get('/api/internal/cron/tick')).status).toBe(401) // no secret configured
    env.CRON_SECRET = 's3cret-value'
    expect((await request(app).get('/api/internal/cron/tick').set('Authorization', 'Bearer wrong')).status).toBe(401)
    expect((await request(app).get('/api/internal/cron/nope').set('Authorization', 'Bearer s3cret-value')).status).toBe(404)
    const ok = await request(app).get('/api/internal/cron/tick').set('Authorization', 'Bearer s3cret-value')
    expect(ok.status).toBe(200)
    expect(ok.text).toBe('tick: ok')
  })
})

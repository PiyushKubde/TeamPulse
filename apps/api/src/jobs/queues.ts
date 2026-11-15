// In-process job queue. KONVO runs as one process (Embarko hosts one process per app), so background work runs here,
// after the request has answered. Each job retries 5 times with exponential backoff (5s, 10s, 20s, ...). Work that must
// survive a restart is found again by the 5-minute tick: sync events still waiting are re-queued from the database.
// ponytail: in-memory queue, one process only; move to a shared queue (Redis/BullMQ) if KONVO ever runs several instances.
import { isTest } from '../config/env.js'
import { logger } from '../config/logger.js'

export const QUEUES = ['ingest', 'snapshots', 'reports', 'reminders', 'delivery', 'ai'] as const
export type QueueName = (typeof QUEUES)[number]
export interface JobOptions {
  /** Same id while queued or running = the job is not added twice. */
  jobId?: string
}

type Handler = (data: never, attempt?: number) => Promise<unknown>
const handlers = new Map<string, Handler>()
/** processors.ts registers every job here. */
export const registerInline = (name: QueueName, job: string, fn: Handler) => handlers.set(`${name}:${job}`, fn)

const ATTEMPTS = 5
const BASE_DELAY = 5000
const CONCURRENCY: Partial<Record<QueueName, number>> = { ingest: 5 }
const active = new Map<QueueName, number>()
const waiting = new Map<QueueName, (() => void)[]>()
const inFlight = new Set<string>()

/** Jobs queued or running, per queue (the on-call monitor watches the ingest backlog). */
export const pendingJobs = (name: QueueName) => (active.get(name) ?? 0) + (waiting.get(name)?.length ?? 0)

function slot(name: QueueName) {
  const limit = CONCURRENCY[name] ?? 1
  if ((active.get(name) ?? 0) < limit) {
    active.set(name, (active.get(name) ?? 0) + 1)
    return Promise.resolve()
  }
  return new Promise<void>((ok) => waiting.set(name, [...(waiting.get(name) ?? []), ok]))
}
function release(name: QueueName) {
  const next = waiting.get(name)?.shift()
  if (next) next()
  else active.set(name, Math.max(0, (active.get(name) ?? 1) - 1))
}

/** Runs one job with retries (exported for its test; callers use enqueue). */
export async function run(name: QueueName, job: string, data: unknown, key: string | null) {
  const fn = handlers.get(`${name}:${job}`)
  if (!fn) return logger.error({ queue: name, job }, 'no processor for job')
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await slot(name)
    let done = false
    try {
      await fn(data as never, attempt)
      done = true
    } catch (e) {
      logger.warn({ queue: name, job, attempt, err: e instanceof Error ? e.message : e }, 'job failed')
    } finally {
      release(name)
    }
    if (done) break
    // Back off without holding a slot, so other jobs keep running.
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, BASE_DELAY * 2 ** (attempt - 1)))
  }
  if (key) inFlight.delete(key)
}

export async function enqueue(name: QueueName, job: string, data: Record<string, unknown>, opts: JobOptions = {}) {
  // Tests run jobs inline and deterministically.
  if (isTest) {
    const fn = handlers.get(`${name}:${job}`)
    if (fn) await fn(data as never).catch(() => undefined)
    return
  }
  const key = opts.jobId ? `${name}:${opts.jobId}` : null
  if (key) {
    if (inFlight.has(key)) return
    inFlight.add(key)
  }
  void run(name, job, data, key)
}

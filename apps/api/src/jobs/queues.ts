import { Queue, type JobsOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { env, isTest } from '../config/env.js'

export const QUEUES = ['ingest', 'snapshots', 'reports', 'reminders', 'delivery', 'ai'] as const
export type QueueName = (typeof QUEUES)[number]

let connection: Redis | null = null
export const redis = () => (connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }))

const queues = new Map<QueueName, Queue>()
export const queue = (name: QueueName) => {
  let q = queues.get(name)
  if (!q) queues.set(name, (q = new Queue(name, { connection: redis() })))
  return q
}

/** Default policy: 5 attempts with exponential backoff (5s, 10s, 20s, ...). After that the job is failed = dead letter. */
export const RETRY: JobsOptions = { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 }

type Handler = (data: never) => Promise<unknown>
const inlineHandlers = new Map<string, Handler>()
/** Tests run jobs inline, deterministically, instead of through Redis. */
export const registerInline = (name: QueueName, job: string, fn: Handler) => inlineHandlers.set(`${name}:${job}`, fn)

export async function enqueue(name: QueueName, job: string, data: Record<string, unknown>, opts: JobsOptions = {}) {
  if (isTest) {
    const fn = inlineHandlers.get(`${name}:${job}`)
    if (fn) await fn(data as never)
    return
  }
  await queue(name).add(job, data, { ...RETRY, ...opts })
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()))
  await connection?.quit().catch(() => undefined)
}

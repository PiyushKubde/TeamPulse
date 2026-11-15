// Background worker: ingestion, outbound sync, imports and scheduled automations. Runs as its own process so slow
// integrations never block the API.
import { Worker } from 'bullmq'
import { logger } from './config/logger.js'
import { prisma } from './lib/prisma.js'
import { QUEUES, closeQueues, queue, redis } from './jobs/queues.js'
import { PROCESSORS } from './jobs/processors.js'
import { reconcileSubscriptions } from './integrations/connections.js'
import { heartbeat } from './services/phone-alerts.js'

const workers = QUEUES.map(
  (name) =>
    new Worker(
      name,
      async (job) => {
        const fn = PROCESSORS[`${name}:${job.name}` as keyof typeof PROCESSORS] as ((d: unknown, attempt?: number) => Promise<unknown>) | undefined
        if (!fn) throw new Error(`No processor for ${name}:${job.name}`)
        return fn(job.data, job.attemptsMade + 1)
      },
      { connection: redis(), concurrency: name === 'ingest' ? 5 : 1 },
    ),
)
for (const w of workers) {
  w.on('failed', (job, err) => logger.warn({ queue: w.name, job: job?.name, attempts: job?.attemptsMade, err: err.message }, 'job failed'))
}

await queue('reminders').upsertJobScheduler('hourly', { pattern: '5 * * * *' }, { name: 'hourly' })
await queue('snapshots').upsertJobScheduler('nightly', { pattern: '0 2 * * *' }, { name: 'nightly' })
await queue('reports').upsertJobScheduler('weekly', { pattern: '0 8 * * 1' }, { name: 'weekly' })
// Answers to personal phone alerts are read back every minute (no public URL needed).
await queue('reminders').upsertJobScheduler('phone-answers', { pattern: '* * * * *' }, { name: 'phone-answers' })
// Invitations are (re)sent and acceptances picked up automatically.
await queue('reminders').upsertJobScheduler('phone-invites', { pattern: '*/5 * * * *' }, { name: 'phone-invites' })
// Lets the API's on-call monitor notice a dead worker.
await heartbeat('worker')
setInterval(() => void heartbeat('worker'), 60_000).unref()
logger.info('WorkPulse worker started')
// Point viaSocket handlers at the current public URL (tunnels change address on restart).
await reconcileSubscriptions().catch((e) => logger.warn({ err: e instanceof Error ? e.message : e }, 'reconcile failed'))

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()))
  await closeQueues()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

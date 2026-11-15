// Background worker: ingestion, outbound sync, imports and scheduled automations. Runs as its own process so slow
// integrations never block the API.
import { Worker } from 'bullmq'
import { logger } from './config/logger.js'
import { prisma } from './lib/prisma.js'
import { QUEUES, closeQueues, queue, redis } from './jobs/queues.js'
import { PROCESSORS } from './jobs/processors.js'

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
logger.info('WorkPulse worker started')

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()))
  await closeQueues()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

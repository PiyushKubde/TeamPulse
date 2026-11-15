import { createApp } from './app.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { prisma } from './lib/prisma.js'
import { closeQueues } from './jobs/queues.js'
import { startOpsMonitor } from './services/phone-alerts.js'

const server = createApp().listen(env.PORT, () => logger.info(`WorkPulse API on http://localhost:${env.PORT}`))
// On-call checks (M91 channel): database, Redis, worker, backlog, failed syncs, server errors, email, AI, delivery.
startOpsMonitor()

async function shutdown() {
  server.close()
  await closeQueues()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

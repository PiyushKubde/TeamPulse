// KONVO in one process: the API, the web app, background jobs and the clock (Embarko runs one process per app).
import { createApp } from './app.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { prisma, tuneDatabase } from './lib/prisma.js'
import { migrate } from './lib/migrate.js'
import './jobs/processors.js'
import { startClock } from './jobs/clock.js'
import { reconcileSubscriptions } from './integrations/connections.js'

// Migrations first, waiting out brief locks (Embarko replicates the SQLite file), then the app.
await migrate(env.DATABASE_URL)
await tuneDatabase()
const server = createApp().listen(env.PORT, '0.0.0.0', () => logger.info(`KONVO on http://localhost:${env.PORT}`))
startClock()
// Point viaSocket handlers at the current public URL (a dev tunnel or the app's address).
void reconcileSubscriptions().catch((e) => logger.warn({ err: e instanceof Error ? e.message : e }, 'reconcile failed'))

async function shutdown() {
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

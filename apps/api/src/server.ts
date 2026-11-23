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
void seedDemoCompany()
// Point viaSocket handlers at the current public URL (a dev tunnel or the app's address).
void reconcileSubscriptions().catch((e) => logger.warn({ err: e instanceof Error ? e.message : e }, 'reconcile failed'))

/**
 * DEMO_SEED=helios adds the Helios Corp demo company once, after the server is up (it takes a few seconds), so a
 * live app has something to show. It skips itself when the company exists, so restarts and redeploys add nothing.
 */
async function seedDemoCompany() {
  if (env.DEMO_SEED !== 'helios') return
  if (!env.DEMO_PASSWORD || env.DEMO_PASSWORD.length < 12) {
    logger.error('DEMO_SEED=helios needs DEMO_PASSWORD (at least 12 characters): demo company not created.')
    return
  }
  try {
    const { seedHelios } = await import('./demo/helios.js')
    await seedHelios({ password: env.DEMO_PASSWORD, log: (m) => logger.info({ demo: 'helios' }, m) })
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : e }, 'demo company seed failed')
  }
}

async function shutdown() {
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

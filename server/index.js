// Server entry point. Embarko sets PORT, DATA_DIR and CRON_SECRET; everything else is documented in .env.example.
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { createApp, runAlertJob } from './app.js'
import { createViasocketGateway } from './integrations/viasocket.js'
import { createM91Transport } from './integrations/m91.js'

const cfg = loadConfig()
const db = openDatabase(join(cfg.dataDir, 'teampulse.db'))
const vs = createViasocketGateway(cfg.viasocket)
const m91 = createM91Transport(cfg.m91)
const app = createApp({ db, cfg, vs, m91 })

if (process.env.DEV_LOGIN && cfg.production) console.warn('[config] DEV_LOGIN is ignored in production.')
console.log(`[config] Public URL: ${cfg.appUrl || '(not set)'}`)
console.log(`[config] Google sign-in: ${cfg.google.configured ? `configured, callback ${cfg.google.redirectUri}` : `NOT configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; callback ${cfg.google.redirectUri || 'needs APP_URL'})`}`)
console.log(`[config] ViaSocket: ${vs.configured ? 'configured' : 'not configured (integrations disabled)'}`)
console.log(`[config] M91: ${m91.status().state} — ${m91.status().message}`)
console.log(`[config] Scheduled jobs: ${cfg.cronSecret ? 'CRON_SECRET set' : 'no CRON_SECRET (scheduled routes refuse all calls)'}${cfg.localScheduler ? '; local scheduler on' : ''}`)
if (cfg.devLogin) console.log('[config] DEV_LOGIN is on: anyone can sign in by email. Local development only.')

const server = app.listen(cfg.port, cfg.host, () => console.log(`TeamPulse listening on http://${cfg.host}:${cfg.port}`))

// Local development only: Embarko runs the jobs through embarko.json schedules, never an in-process timer.
if (cfg.localScheduler && !cfg.production) {
  setInterval(() => runAlertJob({ db, vs, m91, cfg }).then((r) => console.log(`[scheduler] ${r.text}`)).catch((e) => console.error('[scheduler]', e.message)), 5 * 60000).unref()
}

const shutdown = () => server.close(() => { db.close(); process.exit(0) })
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

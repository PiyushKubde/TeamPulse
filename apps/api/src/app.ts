import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { rateLimit } from 'express-rate-limit'
import { env, isTest } from './config/env.js'
import { logger } from './config/logger.js'
import { HttpError } from './lib/errors.js'
import { loadSession } from './middleware/auth.js'
import { auth, startSession } from './modules/auth.js'
import { finishGoogle } from './modules/google.js'
import { orgs } from './modules/orgs.js'
import { routes } from './modules/index.js'
import { self } from './modules/people.js'
import { events } from './integrations/events.js'
import { recordServerError } from './services/phone-alerts.js'
import { BACKGROUND, SCHEDULES, runSchedule, type ScheduleName } from './jobs/clock.js'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

// The built web app (apps/web/dist), served by this same process in production.
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))

const allowedOrigins = new Set(
  env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
)

const limiter = (windowMs: number, limit: number) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, skip: () => env.DISABLE_RATE_LIMIT || isTest })

export function createApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use(helmet())

  // CORS: only the configured web origins, with credentials.
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-WorkPulse')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })

  app.get('/health', (_req, res) => res.json({ ok: true }))

  // Embarko's scheduler (embarko.json) calls these with "Bearer CRON_SECRET". Before the CSRF guard: no cookies here.
  app.all('/api/internal/cron/:name', async (req, res) => {
    const name = req.params.name as ScheduleName
    const given = Buffer.from(req.get('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${env.CRON_SECRET ?? ''}`)
    if (!env.CRON_SECRET || given.length !== expected.length || !timingSafeEqual(given, expected)) return res.sendStatus(401)
    if (!(name in SCHEDULES)) return res.sendStatus(404)
    if (BACKGROUND.includes(name)) {
      void runSchedule(name).catch((e) => logger.error({ job: name, err: e instanceof Error ? e.message : e }, 'scheduled job failed'))
      return res.status(202).send(`${name} started`)
    }
    res.send(`${name}: ${await runSchedule(name)}`)
  })

  // Inbound events from viaSocket handlers: bearer-token auth, own body limit, no cookies, no CSRF header.
  app.use('/api/integrations/events', limiter(60_000, 600), express.json({ limit: '512kb' }), events)

  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(loadSession)

  // CSRF: state-changing requests must carry a custom header, which a cross-site form or image cannot send,
  // and a browser only sends cross-origin after a CORS preflight that the allowlist above answers.
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    if (req.get('X-WorkPulse') !== '1') return next(new HttpError(403, 'csrf', 'Missing request header.'))
    next()
  })

  // Strict limit only on credential endpoints; /auth/me is read on every page load.
  const authLimit = limiter(15 * 60_000, 50)
  app.use(
    [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/auth/verify-email',
      '/api/auth/resend-verification',
      '/api/auth/google',
    ],
    authLimit,
  )
  app.use('/api/auth', auth)
  // The original KONVO registered this Google callback; keep it working so the existing Google client needs no change.
  app.get('/auth/google/callback', authLimit, (req, res) => finishGoogle(req, res, startSession))
  app.use('/api/ai', limiter(60_000, 30))
  app.use('/api', limiter(60_000, 600), self, orgs, routes)

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'No such endpoint.')))

  // The web app: static files, and index.html for every other path (client-side routes such as /tasks).
  if (existsSync(WEB_DIST) && !isTest) {
    app.use(
      express.static(WEB_DIST, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, path) => path.includes('/assets/') && res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'),
      }),
    )
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: WEB_DIST, headers: { 'Cache-Control': 'no-cache' } }))
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } })
    }
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request is too large.' } })
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON.' } })
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: { code: 'too_large', message: 'File is too large.' } })
    // Prisma unique violation → 409, without echoing internals.
    if (err?.code === 'P2002') return res.status(409).json({ error: { code: 'conflict', message: 'That already exists.' } })
    if (err?.code === 'P2025') return res.status(404).json({ error: { code: 'not_found', message: 'Record not found.' } })
    logger.error({ err, path: req.path, method: req.method }, 'unhandled error')
    // Counted only; the on-call monitor decides whether the rate is worth waking anybody.
    void recordServerError()
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Try again.' } })
  }
  app.use(onError)
  return app
}

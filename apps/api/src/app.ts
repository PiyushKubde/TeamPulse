import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { rateLimit } from 'express-rate-limit'
import { env, isTest } from './config/env.js'
import { logger } from './config/logger.js'
import { HttpError } from './lib/errors.js'
import { loadSession } from './middleware/auth.js'
import { auth } from './modules/auth.js'
import { orgs } from './modules/orgs.js'
import { routes } from './modules/index.js'
import { events } from './integrations/events.js'

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
    ],
    authLimit,
  )
  app.use('/api/auth', auth)
  app.use('/api/ai', limiter(60_000, 30))
  app.use('/api', limiter(60_000, 600), orgs, routes)

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'No such endpoint.')))

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
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Try again.' } })
  }
  app.use(onError)
  return app
}

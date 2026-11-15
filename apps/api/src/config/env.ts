import { z } from 'zod'

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : v === 'true' || v === '1'))

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  PUBLIC_API_URL: optional,
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  APP_ENCRYPTION_KEY: z.string().refine((k) => Buffer.from(k, 'base64').length === 32, 'APP_ENCRYPTION_KEY must be 32 bytes, base64'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  REQUIRE_EMAIL_VERIFICATION: bool(false),
  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  MAIL_FROM: z.string().default('WorkPulse <no-reply@localhost>'),
  /** Optional: the WorkPulse user whose connected Gmail sends system email (default: the oldest owner/admin connection). */
  MAIL_VIASOCKET_USER_ID: optional,
  S3_BUCKET: optional,
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_FORCE_PATH_STYLE: bool(true),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .default(10 * 1024 * 1024),
  DATA_DIR: z.string().default('./data'),
  AI_PROVIDER: z.enum(['viasocket', 'openai', '']).default('viasocket'),
  AI_SERVICE: z.string().default('openai'),
  AI_MODEL_FAST: z.string().default('gpt-6-luna'),
  AI_MODEL_ASSISTANT: z.string().default('gpt-6.1-terra'),
  OPENAI_API_KEY: optional,
  VIASOCKET_ORG_ID: optional,
  VIASOCKET_PROJECT_ID: optional,
  VIASOCKET_EMBED_SECRET: optional,
  DISABLE_RATE_LIMIT: bool(false),
  /** M91 send link of the on-call channel (anything from "?" on is stripped: that form raises an alert). */
  M91_SEND_LINK: optional.transform((v) => (v ? v.split('?')[0]!.replace(/\/$/, '') : undefined)),
  /** M91 API key (m91sk_…) to invite users by phone and alert them directly. */
  M91_API_KEY: optional,
})

export type Env = z.infer<typeof schema>

function load(): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.PUBLIC_API_URL) {
    // Not fatal: integrations that need inbound events report it on screen.
    console.warn('PUBLIC_API_URL is not set: external event subscriptions are unavailable.')
  }
  return parsed.data
}

export const env = load()
export const isProd = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
export const viasocketConfigured = Boolean(env.VIASOCKET_ORG_ID && env.VIASOCKET_PROJECT_ID && env.VIASOCKET_EMBED_SECRET)

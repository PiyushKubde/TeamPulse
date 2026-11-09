// All configuration comes from the environment. Nothing secret is ever hard-coded.
import { join } from 'node:path'

const env = process.env

export function loadConfig(overrides = {}) {
  // Embarko sets APP_NAME and DATA_DIR: a hosted run is always production (secure cookies, no dev sign-in).
  const production = env.NODE_ENV === 'production' || Boolean(env.APP_NAME && env.DATA_DIR)
  const devLogin = env.DEV_LOGIN === '1' || env.DEV_LOGIN === 'true'
  const cfg = {
    production,
    port: Number(env.PORT) || 3000,
    // Embarko sets PORT and DATA_DIR. Locally the app keeps its data in ./data and listens on 127.0.0.1 only.
    host: env.PORT && env.DATA_DIR ? '0.0.0.0' : (env.HOST || '127.0.0.1'),
    dataDir: env.DATA_DIR || join(process.cwd(), 'data'),
    // The public address. On Embarko it defaults to https://<APP_NAME>.embarko.app.
    appUrl: (env.APP_URL || (env.APP_NAME && env.DATA_DIR ? `https://${env.APP_NAME}.embarko.app` : '')).replace(/\/+$/, ''),
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: env.GOOGLE_REDIRECT_URI || ''
    },
    // Local development only: sign in without Google. Refused in production.
    devLogin: devLogin && !production,
    allowOrgCreation: env.ALLOW_ORG_CREATION !== 'false',
    cronSecret: env.CRON_SECRET || '',
    sessionDays: Number(env.SESSION_DAYS) || 14,
    uploadMaxBytes: Number(env.UPLOAD_MAX_BYTES) || 5 * 1024 * 1024,
    m91: {
      apiKey: env.M91_API_KEY || '',
      callbackToken: env.M91_CALLBACK_TOKEN || ''
    },
    viasocket: {
      orgId: env.VIASOCKET_ORG_ID || '',
      projectId: env.VIASOCKET_PROJECT_ID || '',
      secret: env.VIASOCKET_EMBED_SECRET || ''
    },
    localScheduler: env.LOCAL_SCHEDULER === '1',
    // Transactional email for verification and password reset (see server/auth/mailer.js).
    legal: { termsUrl: env.TERMS_URL || null, privacyUrl: env.PRIVACY_URL || null },
    mail: {
      provider: (env.MAIL_PROVIDER || '').toLowerCase(),
      from: env.MAIL_FROM || '',
      fromName: env.MAIL_FROM_NAME || 'TeamPulse',
      smtp: { host: env.SMTP_HOST || '', port: Number(env.SMTP_PORT) || 587, secure: env.SMTP_SECURE === 'true', user: env.SMTP_USER || '', pass: env.SMTP_PASS || '' },
      viasocket: { userId: env.MAIL_VIASOCKET_USER_ID || '', connectionId: env.MAIL_VIASOCKET_CONNECTION_ID || '' }
    },
    // AI work measurement (server/ai/provider.js). Keys stay on the server.
    ai: {
      provider: (env.AI_PROVIDER || '').toLowerCase(),
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.AI_MODEL || 'claude-opus-5-5',
      effort: env.AI_EFFORT || 'medium',
      timeoutMs: Number(env.AI_TIMEOUT_MS) || 120000,
      fallbacks: env.AI_FALLBACKS !== 'off'
    },
    ...overrides
  }
  // The callback defaults to APP_URL + /auth/google/callback, so production only needs the client id and secret.
  if (!cfg.google.redirectUri && cfg.appUrl) cfg.google.redirectUri = `${cfg.appUrl}/auth/google/callback`
  cfg.google.configured = Boolean(cfg.google.clientId && cfg.google.clientSecret && cfg.google.redirectUri)
  // M91 posts answers here (https only); the token authenticates the callback.
  cfg.m91.callbackUrl = cfg.appUrl.startsWith('https://') && cfg.m91.callbackToken ? `${cfg.appUrl}/api/webhooks/m91?token=${encodeURIComponent(cfg.m91.callbackToken)}` : ''
  return cfg
}

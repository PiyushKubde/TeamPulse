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
    appUrl: (env.APP_URL || '').replace(/\/+$/, ''),
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
      authKey: env.M91_AUTH_KEY || '',
      callbackToken: env.M91_CALLBACK_TOKEN || ''
    },
    viasocket: {
      orgId: env.VIASOCKET_ORG_ID || '',
      projectId: env.VIASOCKET_PROJECT_ID || '',
      secret: env.VIASOCKET_EMBED_SECRET || ''
    },
    localScheduler: env.LOCAL_SCHEDULER === '1',
    ...overrides
  }
  cfg.google.configured = Boolean(cfg.google.clientId && cfg.google.clientSecret && cfg.google.redirectUri)
  return cfg
}

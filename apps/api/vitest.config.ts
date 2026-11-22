import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const rootEnv = new URL('../../.env', import.meta.url)
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)
const testDb = process.env.TEST_DATABASE_URL
if (!testDb) throw new Error('TEST_DATABASE_URL is required for the API tests (a separate database; it is reset).')

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDb,
      APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64'),
      // Deterministic: integration tests use a fake viaSocket transport, never the real account.
      VIASOCKET_ORG_ID: 'test-org',
      VIASOCKET_PROJECT_ID: 'test-project',
      VIASOCKET_EMBED_SECRET: 'test-secret-not-real',
      PUBLIC_API_URL: 'https://workpulse.test',
      AI_PROVIDER: 'viasocket',
      SMTP_HOST: '',
      // Never reach real phones from tests; the M91 tests install a fake transport and set their own values.
      M91_API_KEY: '',
      M91_SEND_LINK: '',
      S3_BUCKET: '',
      DATA_DIR: './data-test',
    },
  },
})

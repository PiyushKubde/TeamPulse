import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

if (existsSync('.env')) process.loadEnvFile('.env')
// A separate database: the e2e run resets it.
const E2E_DB = process.env.E2E_DATABASE_URL ?? `file:${process.cwd()}/data-e2e/e2e.db`

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:5180', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run start:e2e -w @workpulse/api',
      url: 'http://localhost:4100/health',
      reuseExistingServer: false,
      env: {
        DATABASE_URL: E2E_DB,
        PORT: '4100',
        APP_URL: 'http://localhost:5180',
        CORS_ORIGINS: 'http://localhost:5180',
        DISABLE_RATE_LIMIT: 'true',
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        SMTP_HOST: '',
        AI_PROVIDER: '',
        // Never reach real phones from tests: the journey signs up with made-up numbers.
        M91_API_KEY: '',
        M91_SEND_LINK: '',
      },
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w @workpulse/web',
      url: 'http://localhost:5180',
      reuseExistingServer: false,
      env: { API_PROXY: 'http://localhost:4100', WEB_PORT: '5180' },
      timeout: 60_000,
    },
  ],
})

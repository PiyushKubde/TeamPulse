import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export default function setup() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.E2E_DATABASE_URL ?? (process.env.DATABASE_URL ?? '').replace(/\/[^/?]+(\?|$)/, '/workpulse_e2e$1')
  if (!/workpulse_e2e/.test(url)) throw new Error('Refusing to reset a database that is not the e2e database.')
  execSync('npx prisma migrate reset --force', {
    cwd: 'apps/api',
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
  })
}

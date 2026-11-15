import { execSync } from 'node:child_process'

export default function setup() {
  execSync('npx prisma migrate reset --force', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
  })
}

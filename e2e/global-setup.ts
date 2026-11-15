import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

// A fresh SQLite file for every e2e run: delete it and apply the migrations.
export default function setup() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.E2E_DATABASE_URL ?? `file:${process.cwd()}/data-e2e/e2e.db`
  const file = url.slice('file:'.length)
  if (!/data-e2e\//.test(file)) throw new Error('Refusing to reset a database that is not the e2e database.')
  mkdirSync(dirname(file), { recursive: true })
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) rmSync(f, { force: true })
  execSync('npx prisma migrate deploy', { cwd: 'apps/api', stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } })
}

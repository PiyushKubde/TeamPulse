import { execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

// A fresh SQLite file for every test run: delete it and apply the migrations.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL!
  const file = url.slice('file:'.length)
  if (!/data-test\//.test(file)) throw new Error('Refusing to reset a database that is not the test database.')
  mkdirSync(dirname(file), { recursive: true })
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) rmSync(f, { force: true })
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } })
}

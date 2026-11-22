import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'prisma/config'

// Prisma 7 does not read .env itself; the monorepo keeps one .env at the repository root.
const rootEnv = new URL('../../.env', import.meta.url)
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: databaseUrl() },
})

/** SQLite file: DATABASE_URL when set, else <DATA_DIR>/konvo.db (Embarko's persistent folder). Same rule as src/config/env.ts. */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const dir = resolve(process.env.DATA_DIR ?? 'data')
  mkdirSync(dir, { recursive: true })
  return `file:${dir}/konvo.db`
}

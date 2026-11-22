// Applies pending Prisma migrations at start-up, inside the app, through a connection that waits for locks.
// `prisma migrate deploy` gives up at once with "database is locked" when anything else holds the SQLite file for a
// moment (Embarko replicates it under DATA_DIR), which crash-looped a redeploy. Same bookkeeping table and checksums as
// Prisma, so `prisma migrate deploy` / `status` keep agreeing with what ran here.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createClient } from '@libsql/client'
import { logger } from '../config/logger.js'

const MIGRATIONS = new URL('../../prisma/migrations/', import.meta.url)
const BUSY = /database is locked|SQLITE_BUSY/i

async function withRetry<T>(what: string, fn: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!BUSY.test(String(e)) || attempt >= 10) throw e
      logger.warn({ attempt }, `${what}: database busy, retrying`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

export async function migrate(url: string) {
  const dir = MIGRATIONS
  if (!existsSync(dir)) return
  const db = createClient({ url, concurrency: 1, timeout: 30000 })
  try {
    await withRetry('prepare', () => db.execute('PRAGMA journal_mode = WAL'))
    await withRetry('prepare', () =>
      db.execute(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL,
        "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`),
    )
    const done = new Set(
      (await db.execute('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows.map((r) =>
        String(r.migration_name),
      ),
    )
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/migration.sql`, dir)))
      .map((d) => d.name)
      .sort()
    for (const name of names.filter((n) => !done.has(n))) {
      const sql = readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      await withRetry(`migration ${name}`, async () => {
        const tx = await db.transaction('write')
        try {
          await tx.executeMultiple(sql)
          await tx.execute({
            sql: 'INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, current_timestamp, ?, 1)',
            args: [randomUUID(), checksum, name],
          })
          await tx.commit()
        } catch (e) {
          await tx.rollback().catch(() => undefined)
          throw e
        }
      })
      logger.info({ migration: name }, 'migration applied')
    }
  } finally {
    db.close()
  }
}

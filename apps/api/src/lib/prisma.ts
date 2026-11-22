import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '../generated/prisma/client.js'
import { env } from '../config/env.js'

// One SQLite file (under DATA_DIR on Embarko, which keeps it across redeploys and replicates it).
if (env.DATABASE_URL.startsWith('file:')) mkdirSync(dirname(env.DATABASE_URL.slice('file:'.length)), { recursive: true })
// One connection: SQLite has one writer anyway and this driver runs statements synchronously, so a pool adds lock
// contention and nothing else. The timeout makes a write wait for another process (seed, replication) instead of failing.
// Never call the global client inside prisma.$transaction(async (tx) => …): with one connection that would wait forever.
export const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: env.DATABASE_URL, concurrency: 1, timeout: 15000 }) })

/** WAL lets other processes read during a write. (Foreign keys are on by default in libSQL.) */
export async function tuneDatabase() {
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL')
}
/** A JSON column that holds a list of strings (SQLite has no list columns). */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
export * from '../generated/prisma/client.js'

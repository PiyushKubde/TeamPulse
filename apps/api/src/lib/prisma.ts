import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '../generated/prisma/client.js'
import { env } from '../config/env.js'

// One SQLite file (under DATA_DIR on Embarko, which keeps it across redeploys and replicates it).
if (env.DATABASE_URL.startsWith('file:')) mkdirSync(dirname(env.DATABASE_URL.slice('file:'.length)), { recursive: true })
export const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: env.DATABASE_URL }) })

/** WAL lets reads run during a write; the busy timeout makes a second writer wait instead of failing. */
export async function tuneDatabase() {
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL')
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000')
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON')
}
/** A JSON column that holds a list of strings (SQLite has no list columns). */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
export * from '../generated/prisma/client.js'

// SQLite storage through Node's built-in node:sqlite. Every query is a prepared statement with bound parameters.
// Embarko persists only DATA_DIR and offers SQLite (no managed PostgreSQL), so this is the supported database.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export const now = () => new Date().toISOString()
export const uuid = () => randomUUID()

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
  }
  migrate(db)
  return db
}

/** Applies every committed migration file not yet recorded, each in its own transaction. Never drops tables. */
export function migrate(db, { log = () => {} } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version))
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  const ran = []
  for (const f of files) {
    if (applied.has(f)) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    // A migration that rebuilds a table (SQLite's documented 12-step procedure) starts with "-- foreign_keys: off":
    // foreign keys are switched off around its transaction, then checked before they are switched back on.
    const rebuild = sql.startsWith('-- foreign_keys: off')
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF')
    try {
      transaction(db, () => {
        db.exec(sql)
        if (rebuild) {
          const broken = db.prepare('PRAGMA foreign_key_check').all()
          if (broken.length) throw new Error(`Migration ${f} would break ${broken.length} foreign key(s); rolled back.`)
        }
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, now())
      })
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON')
    }
    log(`[migrate] applied ${f}`)
    ran.push(f)
  }
  return ran
}

let depth = 0
/** Runs fn in a transaction (nested calls join the outer one). */
export function transaction(db, fn) {
  if (depth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  depth++
  try {
    const out = fn()
    depth--
    db.exec('COMMIT')
    return out
  } catch (error) {
    depth--
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw error
  }
}

export const json = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

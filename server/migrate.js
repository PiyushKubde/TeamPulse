// `npm run migrate`: applies pending migrations to the database under DATA_DIR and exits.
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config.js'
import { migrate } from './db.js'

const cfg = loadConfig()
mkdirSync(cfg.dataDir, { recursive: true })
const file = join(cfg.dataDir, 'teampulse.db')
const db = new DatabaseSync(file)
db.exec('PRAGMA foreign_keys = ON')
const ran = migrate(db, { log: console.log })
console.log(ran.length ? `[migrate] ${ran.length} migration(s) applied to ${file}` : `[migrate] ${file} is up to date`)
db.close()

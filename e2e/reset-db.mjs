// Runs before the e2e API starts (see playwright.config.ts): a fresh SQLite file for every run. It must not run while
// the server is up — deleting an open SQLite file (and its WAL) under a running server corrupts what that server sees.
// The server applies the migrations itself on start.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.env.DATABASE_URL ?? ''
const file = url.slice('file:'.length)
if (!url.startsWith('file:') || !/data-e2e\//.test(file)) throw new Error(`Refusing to reset ${url}: not the e2e database.`)
mkdirSync(dirname(file), { recursive: true })
for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) rmSync(f, { force: true })

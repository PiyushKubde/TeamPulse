// Backups that fit Embarko: DATA_DIR survives redeploys but is not backed up, and Embarko's file store gives every file a
// PUBLIC link. So: a daily verified copy under DATA_DIR/backups (database snapshot via VACUUM INTO, checked with
// integrity_check, plus the private evidence files), and — when BACKUP_ENCRYPTION_KEY is set — the same archive
// encrypted with AES-256-GCM before it is uploaded off-host to the app's Embarko file store. Without the key nothing
// leaves the host. Newest 7 kept in each place. Restore: scripts/restore-backup.js.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { now, uuid } from '../db.js'

const KEEP = 7
const MAGIC = Buffer.from('TPB1')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) listFiles(p, base, out)
    else out.push({ path: p, rel: relative(base, p) })
  }
  return out
}

/** One archive: gzip(JSON) with the database snapshot and every evidence file, each with its SHA-256. */
export function packArchive(dbBytes, uploads) {
  return gzipSync(Buffer.from(JSON.stringify({
    format: 'teampulse-backup', version: 1, createdAt: now(),
    database: { sha256: sha(dbBytes), b64: dbBytes.toString('base64') },
    uploads: uploads.map((u) => ({ rel: u.rel, sha256: sha(u.bytes), b64: u.bytes.toString('base64') }))
  })))
}

export function unpackArchive(buf) {
  const a = JSON.parse(gunzipSync(buf).toString('utf8'))
  if (a.format !== 'teampulse-backup') throw new Error('Not a TeamPulse backup.')
  const db = Buffer.from(a.database.b64, 'base64')
  if (sha(db) !== a.database.sha256) throw new Error('Database checksum mismatch.')
  const uploads = a.uploads.map((u) => {
    const bytes = Buffer.from(u.b64, 'base64')
    if (sha(bytes) !== u.sha256) throw new Error(`Checksum mismatch for ${u.rel}.`)
    if (u.rel.includes('..')) throw new Error('Unsafe path in backup.')
    return { rel: u.rel, bytes }
  })
  return { createdAt: a.createdAt, db, uploads }
}

const keyFrom = (secret, salt) => scryptSync(String(secret), salt, 32)
export function encrypt(buf, secret) {
  const salt = randomBytes(16); const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyFrom(secret, salt), iv)
  const body = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body])
}
export function decrypt(buf, secret) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted TeamPulse backup.')
  const salt = buf.subarray(4, 20); const iv = buf.subarray(20, 32); const tag = buf.subarray(32, 48)
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret, salt), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(buf.subarray(48)), d.final()])
}

function verifySnapshot(file) {
  const snap = new DatabaseSync(file, { readOnly: true })
  try {
    const ok = snap.prepare('PRAGMA integrity_check').get()
    if (Object.values(ok)[0] !== 'ok') throw new Error('integrity_check failed')
    const count = (t) => snap.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
    return { organizations: count('organizations'), users: count('users'), tasks: count('tasks'), task_requests: count('task_requests'), impact_records: count('impact_records'), evidence: count('evidence') }
  } finally { snap.close() }
}

/** Off-host copy through the app's own Embarko file store (STORAGE_URL/STORAGE_TOKEN, set by Embarko). */
export function embarkoStorage(env = process.env, fetchImpl = fetch) {
  const { STORAGE_URL: base, STORAGE_TOKEN: token, APP_NAME: app } = env
  if (!base || !token || !app) return null
  const auth = { Authorization: `Bearer ${token}` }
  return {
    async put(name, bytes) {
      const res = await fetchImpl(`${base}/apps/${app}/files/${encodeURIComponent(name)}`, { method: 'PUT', headers: { ...auth, 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' }, body: bytes })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`upload ${res.status} ${body.error || ''}`.trim())
      return body
    },
    async list() {
      const res = await fetchImpl(`${base}/apps/${app}/files`, { headers: auth })
      if (!res.ok) throw new Error(`list ${res.status}`)
      return (await res.json()).files || []
    },
    async remove(id) { await fetchImpl(`${base}/apps/${app}/files/${id}`, { method: 'DELETE', headers: auth }) },
    async download(url) {
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`download ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }
  }
}

/** Makes one verified backup now; uploads it encrypted when a key and the store are available. */
export async function makeBackup(db, dataDir, { encryptionKey = process.env.BACKUP_ENCRYPTION_KEY, storage = embarkoStorage() } = {}) {
  const dir = join(dataDir, 'backups')
  mkdirSync(dir, { recursive: true })
  const ts = stamp()
  const snapFile = join(dir, `snapshot-${ts}.db`)
  db.prepare('VACUUM INTO ?').run(snapFile)
  let rows
  try { rows = verifySnapshot(snapFile) } catch (error) { rmSync(snapFile, { force: true }); throw error }
  const uploads = listFiles(join(dataDir, 'uploads')).map((f) => ({ rel: f.rel, bytes: readFileSync(f.path) }))
  const archive = packArchive(readFileSync(snapFile), uploads)
  rmSync(snapFile, { force: true })
  const file = `teampulse-${ts}.tpbackup`
  writeFileSync(join(dir, file), archive, { mode: 0o600 })
  const id = uuid()
  let offsite = { status: 'not_configured', id: null, error: null }
  if (encryptionKey && storage) {
    try {
      const out = await storage.put(`teampulse-backup-${ts}.enc`, encrypt(archive, encryptionKey))
      offsite = { status: 'uploaded', id: out.id || null, error: null, url: out.url || null }
      const old = (await storage.list()).filter((f) => /^teampulse-backup-.*\.enc$/.test(f.filename)).slice(KEEP)
      for (const f of old) await storage.remove(f.id)
    } catch (error) {
      offsite = { status: 'failed', id: null, error: String(error.message).slice(0, 200) }
    }
  }
  // Prove the off-host copy restores: download it back, decrypt with the configured key, restore into a temporary
  // folder, check integrity and compare row counts with the snapshot. The key never leaves the server.
  let restore = { ok: false, detail: offsite.status === 'uploaded' ? null : 'no off-host copy to check' }
  if (offsite.status === 'uploaded' && offsite.url && storage.download) {
    const tmp = mkdtempSync(join(tmpdir(), 'tp-restore-check-'))
    try {
      const back = unpackArchive(decrypt(await storage.download(offsite.url), encryptionKey))
      writeFileSync(join(tmp, 'teampulse.db'), back.db)
      const restored = verifySnapshot(join(tmp, 'teampulse.db'))
      const same = JSON.stringify(restored) === JSON.stringify(rows) && back.uploads.length === uploads.length
      restore = { ok: same, detail: same ? `restored from Embarko storage: integrity ok, ${restored.tasks} task(s), ${back.uploads.length} file(s) match` : 'restored copy does not match the snapshot' }
    } catch (error) {
      restore = { ok: false, detail: `restore check failed: ${String(error.message).slice(0, 150)}` }
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  }
  db.prepare(`INSERT INTO backups (id, file, sha256, size_bytes, rows_summary, offsite_id, offsite_status, offsite_error, restore_verified_at, restore_detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, file, sha(archive), archive.length, JSON.stringify({ ...rows, uploads: uploads.length }), offsite.id, offsite.status, offsite.error, restore.ok ? now() : null, restore.detail, now())
  // Local retention: newest KEEP archives.
  const archives = readdirSync(dir).filter((f) => f.endsWith('.tpbackup')).sort().reverse()
  for (const f of archives.slice(KEEP)) rmSync(join(dir, f), { force: true })
  console.log(`[backup] ${file}: ${archive.length} bytes, ${rows.tasks} task(s), ${uploads.length} file(s); off-host ${offsite.status}${offsite.error ? ` (${offsite.error})` : ''}; ${restore.ok ? 'restore VERIFIED' : `restore not verified (${restore.detail})`}`)
  return { file, rows, uploads: uploads.length, offsite: offsite.status, offsiteError: offsite.error, restoreVerified: restore.ok, restoreDetail: restore.detail }
}

/** Daily: a backup when the newest is older than 23 hours. */
export async function backupIfDue(db, dataDir, opts) {
  const last = db.prepare('SELECT created_at FROM backups ORDER BY created_at DESC LIMIT 1').get()
  if (last && Date.now() - Date.parse(last.created_at) < 23 * 3600000) return null
  return makeBackup(db, dataDir, opts)
}

export function lastBackup(db) {
  const b = db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 1').get()
  return b ? { at: b.created_at, file: b.file, offsite: b.offsite_status, restoreVerifiedAt: b.restore_verified_at, restoreDetail: b.restore_detail, rows: JSON.parse(b.rows_summary) } : null
}

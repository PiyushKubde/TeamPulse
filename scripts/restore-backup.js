// Restore a TeamPulse backup into an EMPTY data folder (never over a live one).
//   node scripts/restore-backup.js <backup file: .tpbackup (local) or the encrypted off-host copy> <target DATA_DIR>
// The encrypted off-host copy (teampulse-backup-*.gz from Embarko storage) needs BACKUP_ENCRYPTION_KEY. Checksums are verified first.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decrypt, unpackArchive } from '../server/services/backups.js'

const [file, target] = process.argv.slice(2)
if (!file || !target) { console.error('Usage: node scripts/restore-backup.js <backup> <empty target DATA_DIR>'); process.exit(2) }
if (existsSync(target) && readdirSync(target).length) { console.error('The target folder is not empty: restore only into an empty folder.'); process.exit(2) }
let buf = readFileSync(file)
if (buf.subarray(0, 4).toString() === 'TPB1') {
  if (!process.env.BACKUP_ENCRYPTION_KEY) { console.error('Set BACKUP_ENCRYPTION_KEY to decrypt an off-host backup.'); process.exit(2) }
  buf = decrypt(buf, process.env.BACKUP_ENCRYPTION_KEY)
}
const { createdAt, db, uploads } = unpackArchive(buf)
mkdirSync(target, { recursive: true })
writeFileSync(join(target, 'teampulse.db'), db, { mode: 0o600 })
for (const u of uploads) { const p = join(target, 'uploads', u.rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, u.bytes, { mode: 0o600 }) }
console.log(`Restored backup from ${createdAt}: database + ${uploads.length} evidence file(s) into ${target}. Point DATA_DIR at it and start the app.`)

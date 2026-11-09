import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { startApp, seedOrg } from './helpers.js'
import { recoverOutbox, emit } from '../server/services/events.js'
import { makeBackup, decrypt, encrypt } from '../server/services/backups.js'

test('outbox: every event is recorded, marked DONE after its handlers, and a PENDING one is replayed without duplicates', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    const c = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Outbox task', assigneeId: s.employee.id } })
    await t.settled()
    const row = t.db.prepare(`SELECT * FROM event_outbox WHERE type = 'task.assigned'`).get()
    assert.equal(row.status, 'DONE')
    // Simulate a crash after commit, before handlers ran: the notification is missing and the event is PENDING.
    t.db.prepare(`DELETE FROM notifications WHERE kind = 'task_assigned'`).run()
    t.db.prepare(`UPDATE event_outbox SET status = 'PENDING', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(row.id)
    assert.equal(recoverOutbox(), 1)
    await t.settled()
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'task_assigned'`).get().n, 1, 'recovered')
    assert.equal(t.db.prepare('SELECT status FROM event_outbox WHERE id = ?').get(row.id).status, 'DONE')
    // Replaying again creates nothing new (idempotent handlers).
    t.db.prepare(`UPDATE event_outbox SET status = 'PENDING', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(row.id)
    recoverOutbox(); await t.settled()
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'task_assigned'`).get().n, 1)
    // A fresh event is not replayed while it is still in flight.
    emit({ type: 'noop.test', orgId: s.org.id })
    assert.equal(recoverOutbox(), 0)
    void c
  } finally { await t.close() }
})

test('backups: verified snapshot + evidence, encrypted off-host upload, retention, and a working restore', async () => {
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Back me up', assigneeId: s.employee.id } })
    mkdirSync(join(t.cfg.dataDir, 'uploads', s.org.id), { recursive: true })
    writeFileSync(join(t.cfg.dataDir, 'uploads', s.org.id, 'x.txt'), 'evidence bytes')
    const uploaded = []
    const storage = { put: async (name, bytes) => { uploaded.push({ name, bytes }); return { id: `f${uploaded.length}` } }, list: async () => uploaded.map((u, i) => ({ id: `f${i + 1}`, filename: u.name })).reverse(), remove: async () => {} }
    const out = await makeBackup(t.db, t.cfg.dataDir, { encryptionKey: 'test-key-123', storage })
    assert.equal(out.rows.tasks, 1); assert.equal(out.uploads, 1); assert.equal(out.offsite, 'uploaded')
    const enc = uploaded[0].bytes
    assert.equal(enc.includes(Buffer.from('Back me up')), false, 'off-host copy is encrypted')
    assert.throws(() => decrypt(enc, 'wrong-key'))
    assert.ok(decrypt(encrypt(Buffer.from('x'), 'k'), 'k').equals(Buffer.from('x')))
    // No key → nothing leaves the host.
    assert.equal((await makeBackup(t.db, t.cfg.dataDir, { encryptionKey: '', storage })).offsite, 'not_configured')
    // Restore the encrypted copy into an empty folder and read it.
    const encFile = join(mkdtempSync(join(tmpdir(), 'tp-enc-')), 'b.enc'); writeFileSync(encFile, enc)
    const target = join(mkdtempSync(join(tmpdir(), 'tp-restore-')), 'data')
    execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/restore-backup.js', encFile, target], { env: { ...process.env, BACKUP_ENCRYPTION_KEY: 'test-key-123' } })
    const db = new DatabaseSync(join(target, 'teampulse.db'), { readOnly: true })
    assert.equal(db.prepare('SELECT title FROM tasks').get().title, 'Back me up')
    db.close()
    assert.equal(readFileSync(join(target, 'uploads', s.org.id, 'x.txt'), 'utf8'), 'evidence bytes')
    // Refuses to restore over a non-empty folder.
    assert.throws(() => execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/restore-backup.js', encFile, target], { env: { ...process.env, BACKUP_ENCRYPTION_KEY: 'test-key-123' }, stdio: 'pipe' }))
    assert.ok(readdirSync(join(t.cfg.dataDir, 'backups')).some((f) => f.endsWith('.tpbackup')))
    assert.ok(!existsSync(join(t.cfg.dataDir, 'backups', 'snapshot')))
  } finally { await t.close() }
})

test('the scheduled job reports row counts (persistence check) and makes the daily backup once', async () => {
  const t = await startApp()
  try {
    seedOrg(t.db)
    const r = await t.call('/tasks/alerts', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.match(r.text, /db: 2 org\(s\), 7 user\(s\), 0 task\(s\)/)
    assert.match(r.text, /backup made \(off-host not_configured\)/)
    const r2 = await t.call('/tasks/alerts', { headers: { Authorization: 'Bearer test-cron-secret' } })
    assert.match(r2.text, /last backup .* \(off-host not_configured\)/)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 1)
  } finally { await t.close() }
})

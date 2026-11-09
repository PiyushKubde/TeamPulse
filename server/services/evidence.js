// Evidence: links, and uploaded files kept privately under DATA_DIR (never publicly served).
// Files are downloaded only through an authorized route that re-checks access to the owning task/record.
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { now, uuid } from '../db.js'
import { forbidden, invalid, notFound } from '../errors.js'
import { canManageTask, requireVisibleTask } from '../access.js'
import * as v from '../validate.js'
import { recordEvent } from './tasks.js'

// Content types accepted for upload, checked against the file's own leading bytes where possible.
const ALLOWED = {
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/gif': { ext: 'gif', magic: [0x47, 0x49, 0x46] },
  'image/webp': { ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] },
  'text/plain': { ext: 'txt' },
  'text/csv': { ext: 'csv' },
  'application/zip': { ext: 'zip', magic: [0x50, 0x4b] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', magic: [0x50, 0x4b] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', magic: [0x50, 0x4b] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: 'pptx', magic: [0x50, 0x4b] }
}
export const ALLOWED_TYPES = Object.keys(ALLOWED)

export function listEvidence(db, ownerType, ownerId) {
  return db.prepare(`SELECT e.*, u.name AS creator FROM evidence e JOIN users u ON u.id = e.created_by WHERE e.owner_type = ? AND e.owner_id = ? ORDER BY e.created_at`).all(ownerType, ownerId)
    .map((e) => ({
      id: e.id, kind: e.kind, url: e.kind === 'link' ? e.url : `/api/evidence/${e.id}/download`, label: e.label, fileName: e.file_name,
      mimeType: e.mime_type, sizeBytes: e.size_bytes, createdBy: e.creator, createdAt: e.created_at
    }))
}

/** Resolves the owner and checks the caller may see it (and, for writes, may add to it). Returns { taskId }. */
function requireOwner(db, ctx, ownerType, ownerId, { write = false } = {}) {
  v.id(ownerId, 'Owner', { required: true })
  if (ownerType === 'task') {
    const t = requireVisibleTask(db, ctx, ownerId)
    if (write && t.assignee_id !== ctx.user.id && !canManageTask(db, ctx, t)) throw forbidden('Only the assignee or the task’s manager can add evidence.')
    return { taskId: t.id, task: t }
  }
  if (ownerType === 'submission') {
    const s = db.prepare('SELECT * FROM completion_submissions WHERE id = ? AND org_id = ?').get(ownerId, ctx.orgId)
    if (!s) throw notFound('Submission')
    const t = requireVisibleTask(db, ctx, s.task_id)
    if (write && (s.submitted_by !== ctx.user.id || s.status !== 'PENDING')) throw forbidden('Evidence can be added only by the submitter while the submission is pending.')
    return { taskId: t.id, task: t }
  }
  if (ownerType === 'impact') {
    const r = db.prepare('SELECT * FROM impact_records WHERE id = ? AND org_id = ?').get(ownerId, ctx.orgId)
    if (!r) throw notFound('Impact record')
    // Visibility of impact records is checked by the impact service's own scope.
    const visible = r.user_id === ctx.user.id || (ctx.role !== 'employee' && impactVisible(db, ctx, r))
    if (!visible) throw notFound('Impact record')
    if (write && (r.user_id !== ctx.user.id || r.verification_status === 'VERIFIED')) throw forbidden('Evidence can be added only by the contributor before verification.')
    return { taskId: r.task_id }
  }
  throw invalid('Unknown evidence owner.')
}

let impactVisible = () => false
export function setImpactVisibility(fn) { impactVisible = fn }

export function addLink(db, ctx, ownerType, ownerId, body) {
  const owner = requireOwner(db, ctx, ownerType, ownerId, { write: true })
  const url = v.url(body?.url, 'Link')
  const label = v.text(body?.label, 'Label', { max: 200 })
  const id = uuid()
  db.prepare(`INSERT INTO evidence (id, org_id, owner_type, owner_id, task_id, kind, url, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'link', ?, ?, ?, ?)`)
    .run(id, ctx.orgId, ownerType, ownerId, owner.taskId ?? null, url, label, ctx.user.id, now())
  if (owner.task) recordEvent(db, owner.task, ctx.user.id, 'evidence_added', { kind: 'link', label: label || url })
  return { id }
}

export function addFile(db, ctx, ownerType, ownerId, { buffer, fileName, mimeType, dataDir, maxBytes }) {
  const owner = requireOwner(db, ctx, ownerType, ownerId, { write: true })
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase()
  const rule = ALLOWED[type]
  if (!rule) throw invalid(`That file type is not accepted. Allowed: PDF, images, text, CSV, ZIP and Office documents.`)
  if (!buffer?.length) throw invalid('The file is empty.')
  if (buffer.length > maxBytes) throw invalid(`Files can be at most ${Math.round(maxBytes / 1024 / 1024)} MB.`)
  if (rule.magic && !rule.magic.every((b, i) => buffer[i] === b)) throw invalid('The file’s contents do not match its type.')
  const name = String(fileName || `evidence.${rule.ext}`).replace(/[^\w.\- ()]/g, '_').slice(0, 120)
  const id = uuid()
  const dir = join(dataDir, 'uploads', ctx.orgId)
  mkdirSync(dir, { recursive: true })
  const key = `${ctx.orgId}/${id}.${rule.ext}`
  writeFileSync(join(dataDir, 'uploads', key), buffer, { mode: 0o600 })
  db.prepare(`INSERT INTO evidence (id, org_id, owner_type, owner_id, task_id, kind, file_name, mime_type, size_bytes, storage_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.orgId, ownerType, ownerId, owner.taskId ?? null, name, type, buffer.length, key, ctx.user.id, now())
  if (owner.task) recordEvent(db, owner.task, ctx.user.id, 'evidence_added', { kind: 'file', label: name })
  return { id, fileName: name }
}

/** The stored file, only if the caller may see its owner. */
export function evidenceFile(db, ctx, id, dataDir) {
  const e = db.prepare('SELECT * FROM evidence WHERE id = ? AND org_id = ?').get(v.id(id, 'Evidence', { required: true }), ctx.orgId)
  if (!e || e.kind !== 'file') throw notFound('File')
  requireOwner(db, ctx, e.owner_type, e.owner_id)
  const path = join(dataDir, 'uploads', e.storage_key)
  if (!existsSync(path)) throw notFound('File')
  return { path, fileName: e.file_name, mimeType: e.mime_type }
}

export function deleteEvidence(db, ctx, id, dataDir) {
  const e = db.prepare('SELECT * FROM evidence WHERE id = ? AND org_id = ?').get(v.id(id, 'Evidence', { required: true }), ctx.orgId)
  if (!e) throw notFound('Evidence')
  requireOwner(db, ctx, e.owner_type, e.owner_id, { write: true })
  if (e.created_by !== ctx.user.id) throw forbidden('Only the person who added this evidence can remove it.')
  db.prepare('DELETE FROM evidence WHERE id = ?').run(e.id)
  if (e.storage_key) { try { unlinkSync(join(dataDir, 'uploads', e.storage_key)) } catch { /* already gone */ } }
  return { deleted: true }
}

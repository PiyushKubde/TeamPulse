// Reading and correcting external evidence.
// Visibility: an evidence row is visible to whoever collected it, the member it is attributed to, admins, and managers
// with either of them in scope. Another organization never sees it (404). Activity is never counted per person.
import { json, now, transaction, uuid } from '../db.js'
import { AppError, forbidden, invalid, notFound } from '../errors.js'
import { canManageTask, isAdmin, isManager, managersForTask, requireVisibleTask, scopeUserIds } from '../access.js'
import { audit } from '../services/audit.js'
import { raiseAlert } from '../services/alerts.js'
import { collectorFor } from './collectors.js'
import { IN_ANALYSIS, taskRef } from './matching.js'
import * as v from '../validate.js'

const userName = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)
const inScope = (db, ctx, uid) => Boolean(uid) && (uid === ctx.user.id || isAdmin(ctx) || (ctx.role === 'manager' && scopeUserIds(db, ctx).includes(uid)))
export const canSeeEvidence = (db, ctx, e) => e.org_id === ctx.orgId && (inScope(db, ctx, e.collector_id) || inScope(db, ctx, e.actor_user_id))

const VERIFICATION_TEXT = { system_recorded: 'Recorded by the app (observed fact)', self_reported: 'Written by a person (their account, not proof)', reported_figure: 'A reported figure (not independently verified)' }
const ATTRIBUTION_TEXT = { self: 'by the person who collected it', member: 'by another member', external: 'by someone outside the organization', unknown: 'author not known to KONVO', disputed: 'attribution disputed' }

export function presentEvidence(db, e, { withLinks = true } = {}) {
  const links = withLinks ? db.prepare(`SELECT l.*, t.title AS task_title, t.assignee_id FROM evidence_task_links l JOIN tasks t ON t.id = l.task_id WHERE l.evidence_id = ? AND l.status != 'rejected' ORDER BY l.confidence DESC`).all(e.id) : []
  return {
    id: e.id, app: e.app, appLabel: collectorFor(e.app)?.label || e.app, kind: e.kind, title: e.title, content: e.content, occurredAt: e.occurred_at,
    sourceUrl: e.source_url, resource: e.resource_ref, parent: e.parent_ref, status: e.status,
    verification: e.verification, verificationText: VERIFICATION_TEXT[e.verification],
    attribution: e.attribution, attributionText: ATTRIBUTION_TEXT[e.attribution], actorIdentity: e.actor_identity, actorId: e.actor_user_id, actorName: userName(db, e.actor_user_id),
    collectorId: e.collector_id, collectorName: userName(db, e.collector_id), method: e.method, metadata: json(e.metadata_json, {}),
    links: links.map((l) => ({ id: l.id, taskId: l.task_id, taskTitle: l.task_title, taskRef: taskRef(l.task_id), method: l.method, confidence: l.confidence, explanation: l.explanation, status: l.status, share: l.share, contributorId: l.contributor_id, contributorName: userName(db, l.contributor_id), taskOwnerId: l.assignee_id, usedInAnalysis: l.status === 'confirmed' || (l.status === 'suggested' && l.confidence >= IN_ANALYSIS) })),
    linkState: links.some((l) => l.status === 'confirmed') ? 'linked' : links.some((l) => l.confidence >= IN_ANALYSIS) ? 'suggested' : links.length ? 'possible' : 'unmatched'
  }
}

function requireEvidence(db, ctx, id) {
  const e = db.prepare('SELECT * FROM external_evidence WHERE id = ? AND org_id = ?').get(v.id(id, 'Evidence', { required: true }), ctx.orgId)
  if (!e || !canSeeEvidence(db, ctx, e)) throw notFound('Evidence')
  return e
}

/**
 * Evidence list. view: 'mine' (collected by me or attributed to me) | 'person' (userId, managers) | 'review' (managers:
 * disputed or unknown attribution, and shared links, for their people). state: linked | suggested | possible | unmatched.
 */
export function listEvidence(db, ctx, q = {}) {
  const view = q.view || 'mine'
  const params = [ctx.orgId]
  let where = 'e.org_id = ?'
  if (view === 'mine') { where += ' AND (e.collector_id = ? OR e.actor_user_id = ?)'; params.push(ctx.user.id, ctx.user.id) }
  else if (view === 'person') {
    const uid = v.id(q.userId, 'Person', { required: true })
    if (!inScope(db, ctx, uid)) throw notFound('Person')
    where += ' AND (e.collector_id = ? OR e.actor_user_id = ?)'; params.push(uid, uid)
  } else if (view === 'review') {
    if (!isManager(ctx)) throw forbidden('Only managers review evidence attribution.')
    where += ` AND (e.attribution IN ('disputed','unknown') OR EXISTS (SELECT 1 FROM evidence_task_links l WHERE l.evidence_id = e.id AND l.share = 'shared' AND l.status != 'rejected'))`
  } else throw invalid('Unknown view.')
  if (q.app) { where += ' AND e.app = ?'; params.push(String(q.app)) }
  where += ` AND e.status != 'removed_by_owner'`
  const rows = db.prepare(`SELECT e.* FROM external_evidence e WHERE ${where} ORDER BY e.occurred_at DESC LIMIT 300`).all(...params).filter((e) => canSeeEvidence(db, ctx, e))
  const items = rows.map((e) => presentEvidence(db, e))
  return q.state ? items.filter((i) => i.linkState === q.state) : items
}

export function getEvidence(db, ctx, id) { return presentEvidence(db, requireEvidence(db, ctx, id)) }

/** The person links evidence to one of their own tasks (confirmed, manual). It must be their own work or collection. */
export function linkToTask(db, ctx, id, body) {
  const e = requireEvidence(db, ctx, id)
  if (e.status !== 'active') throw invalid('This evidence is no longer available.')
  const task = requireVisibleTask(db, ctx, v.id(body?.taskId, 'Task', { required: true }))
  const mineToLink = e.actor_user_id === ctx.user.id || (e.collector_id === ctx.user.id && ['self', 'unknown', 'external'].includes(e.attribution))
  if (!mineToLink && !canManageTask(db, ctx, task)) throw forbidden('You can link only your own evidence, or evidence of people you manage.')
  if (e.attribution === 'member' && e.actor_user_id !== task.assignee_id && !canManageTask(db, ctx, task)) throw forbidden('This is another person’s work; a manager decides whether it belongs to this task.')
  const contributor = e.actor_user_id || (e.attribution === 'self' ? e.collector_id : null)
  const share = contributor && contributor !== task.assignee_id ? 'shared' : 'individual'
  const ts = now()
  db.prepare(`INSERT INTO evidence_task_links (id, org_id, evidence_id, task_id, contributor_id, method, confidence, explanation, status, share, decided_by, decided_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'manual', 1, ?, 'confirmed', ?, ?, ?, ?, ?)
              ON CONFLICT (evidence_id, task_id) DO UPDATE SET status = 'confirmed', method = 'manual', confidence = 1, decided_by = excluded.decided_by, decided_at = excluded.decided_at, updated_at = excluded.updated_at`)
    .run(uuid(), ctx.orgId, e.id, task.id, contributor, `Linked by ${ctx.user.name}.`, share, ctx.user.id, ts, ts, ts)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'evidence.linked', entityType: 'evidence', entityId: e.id, after: { taskId: task.id, share } })
  return getEvidence(db, ctx, e.id)
}

/** Confirm or reject a suggested link: the task owner, the contributor, or their manager. */
export function decideLink(db, ctx, linkId, body) {
  const l = db.prepare('SELECT * FROM evidence_task_links WHERE id = ? AND org_id = ?').get(v.id(linkId, 'Link', { required: true }), ctx.orgId)
  if (!l) throw notFound('Link')
  const e = requireEvidence(db, ctx, l.evidence_id)
  const task = requireVisibleTask(db, ctx, l.task_id)
  const action = v.oneOf(body?.action, 'Action', ['CONFIRM', 'REJECT'], { required: true })
  const allowed = task.assignee_id === ctx.user.id || l.contributor_id === ctx.user.id || canManageTask(db, ctx, task)
  if (!allowed) throw forbidden('Only the task’s owner, the contributor or their manager can decide this link.')
  if (action === 'CONFIRM' && e.attribution === 'disputed') throw new AppError(409, 'attribution_disputed', 'Its attribution is disputed; a manager must resolve it first.')
  db.prepare('UPDATE evidence_task_links SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(action === 'CONFIRM' ? 'confirmed' : 'rejected', ctx.user.id, now(), now(), l.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: `evidence_link.${action.toLowerCase()}`, entityType: 'evidence', entityId: e.id, before: { status: l.status }, after: { taskId: l.task_id } })
  return getEvidence(db, ctx, e.id)
}

/** "This is not mine": the attributed person disputes it. Its links stop counting; managers resolve it. */
export function disputeAttribution(db, ctx, id, body) {
  const e = requireEvidence(db, ctx, id)
  if (e.actor_user_id !== ctx.user.id && !(e.collector_id === ctx.user.id && e.attribution === 'self')) throw forbidden('Only the person it is attributed to can dispute it.')
  const reason = v.text(body?.reason, 'Reason', { required: true, max: 500 })
  const linked = db.prepare(`SELECT l.task_id FROM evidence_task_links l WHERE l.evidence_id = ? AND l.status != 'rejected'`).all(e.id)
  transaction(db, () => {
    db.prepare(`UPDATE external_evidence SET attribution = 'disputed', updated_at = ? WHERE id = ?`).run(now(), e.id)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'evidence.attribution_disputed', entityType: 'evidence', entityId: e.id, before: { attribution: e.attribution, actor: e.actor_user_id }, after: { reason } })
    // M91 intervention only when it matters: the evidence is tied to a task whose work has been (or is being) assessed.
    for (const { task_id } of linked) {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id)
      const assessed = db.prepare('SELECT 1 FROM contribution_assessments WHERE task_id = ? AND is_current = 1').get(task_id)
      raiseAlert(db, { orgId: ctx.orgId, rule: assessed ? 'evidence_attribution_review' : 'evidence_attribution_note', userIds: managersForTask(db, task).filter((m) => m !== ctx.user.id), taskId: task.id, title: `Evidence attribution disputed on “${task.title}”`, body: `${ctx.user.name}: ${reason}`, link: '#/contribution?tab=review', anchor: `${e.id}` })
    }
  })
  return getEvidence(db, ctx, e.id)
}

/** Manager: who did this? A member in their scope, or someone outside the organization. Resolves a dispute. */
export function resolveAttribution(db, ctx, id, body) {
  if (!isManager(ctx)) throw forbidden('Only managers resolve attribution.')
  const e = requireEvidence(db, ctx, id)
  const to = body?.external === true ? null : v.id(body?.userId, 'Person', { required: true })
  if (to && !inScope(db, ctx, to)) throw notFound('Person')
  if (to === ctx.user.id && !isAdmin(ctx)) throw forbidden('You cannot attribute evidence to yourself.')
  const attribution = !to ? 'external' : to === e.collector_id ? 'self' : 'member'
  transaction(db, () => {
    db.prepare('UPDATE external_evidence SET actor_user_id = ?, attribution = ?, updated_at = ? WHERE id = ?').run(to, attribution, now(), e.id)
    db.prepare(`UPDATE evidence_task_links SET contributor_id = ?, share = CASE WHEN ? IS NOT NULL AND ? = (SELECT assignee_id FROM tasks WHERE id = task_id) THEN 'individual' ELSE 'shared' END, updated_at = ? WHERE evidence_id = ?`).run(to, to, to, now(), e.id)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'evidence.attribution_resolved', entityType: 'evidence', entityId: e.id, before: { attribution: e.attribution, actor: e.actor_user_id }, after: { attribution, actor: to, reason: v.text(body?.reason, 'Reason', { max: 500 }) } })
  })
  return getEvidence(db, ctx, e.id)
}

/** Manager: a link is shared (several people contributed to the outcome) or individual; and whose contribution it is. */
export function setShare(db, ctx, linkId, body) {
  const l = db.prepare('SELECT * FROM evidence_task_links WHERE id = ? AND org_id = ?').get(v.id(linkId, 'Link', { required: true }), ctx.orgId)
  if (!l) throw notFound('Link')
  const task = requireVisibleTask(db, ctx, l.task_id)
  if (!canManageTask(db, ctx, task)) throw forbidden('Only the task’s manager can resolve shared ownership.')
  const share = v.oneOf(body?.share, 'Share', ['INDIVIDUAL', 'SHARED'], { required: true }).toLowerCase()
  const contributor = body?.contributorId === undefined ? l.contributor_id : v.id(body.contributorId, 'Contributor')
  if (contributor && !inScope(db, ctx, contributor)) throw notFound('Person')
  db.prepare('UPDATE evidence_task_links SET share = ?, contributor_id = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(share, contributor, ctx.user.id, now(), now(), l.id)
  audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'evidence_link.share', entityType: 'evidence', entityId: l.evidence_id, before: { share: l.share, contributor: l.contributor_id }, after: { share, contributor } })
  return getEvidence(db, ctx, l.evidence_id)
}

/** The collector removes evidence they collected (privacy): content cleared, links dropped, the record stays as removed. */
export function removeEvidence(db, ctx, id) {
  const e = requireEvidence(db, ctx, id)
  if (e.collector_id !== ctx.user.id) throw forbidden('Only the person who collected it can remove it.')
  transaction(db, () => {
    db.prepare(`UPDATE external_evidence SET status = 'removed_by_owner', title = NULL, content = NULL, metadata_json = '{}', updated_at = ? WHERE id = ?`).run(now(), e.id)
    db.prepare(`UPDATE evidence_task_links SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE evidence_id = ?`).run(ctx.user.id, now(), now(), e.id)
    audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'evidence.removed', entityType: 'evidence', entityId: e.id })
  })
  return { removed: true }
}

/** External evidence linked to a task (for the task page): visible rows only. */
export function taskEvidence(db, ctx, taskId) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  return db.prepare(`SELECT e.* FROM external_evidence e JOIN evidence_task_links l ON l.evidence_id = e.id WHERE l.task_id = ? AND l.status != 'rejected' AND e.status = 'active' ORDER BY e.occurred_at`).all(task.id)
    .filter((e) => canSeeEvidence(db, ctx, e)).map((e) => presentEvidence(db, e))
}

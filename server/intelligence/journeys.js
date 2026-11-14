// Contribution journeys (the contribution graph): one task, its history, the external evidence linked to it and the
// outcomes it produced, read as ONE piece of work — "reported → investigated → implemented → reviewed → delivered →
// outcome" — instead of many separate events.
//
// Facts and interpretation stay apart: every step is a recorded fact (an event, a commit, a review, an outcome
// record) with its source and original author; the STAGE a step is placed in is KONVO's rule-based reading,
// marked as such. Missing stages are listed as missing — never filled in. Nothing here scores anything; the
// assessment shown is the Phase 1 engine's, unchanged.
import { json } from '../db.js'
import { notFound } from '../errors.js'
import { isManager, requireVisibleTask, scopeUserIds, taskScopeSql } from '../access.js'
import { canSeeEvidence } from '../evidence/service.js'
import { IN_ANALYSIS, taskRef } from '../evidence/matching.js'
import * as v from '../validate.js'

export const STAGES = [
  ['reported', 'Reported'], ['planned', 'Planned'], ['investigated', 'Investigated'], ['implemented', 'Implemented'],
  ['reviewed', 'Reviewed'], ['rework', 'Rework'], ['blocked', 'Blocked'], ['delivered', 'Delivered'], ['accepted', 'Accepted'], ['outcome', 'Outcome']
]
const STAGE_INDEX = Object.fromEntries(STAGES.map(([k], i) => [k, i]))
const INVESTIGATE = /\b(investigat\w*|root cause|reproduc\w*|debug\w*|trac(e|ed|ing) (it|the)|found (the|that)|diagnos\w*|profil\w*|bisect\w*)\b/i
const APP_LABEL = { github: 'GitHub', slack: 'Slack', gmail: 'Gmail', 'google-calendar': 'Google Calendar', 'google-sheets': 'Google Sheets' }
const clip = (s, n) => (s == null ? null : String(s).length > n ? `${String(s).slice(0, n)}…` : String(s))
const userName = (db, id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null)

const EVIDENCE_STAGE = {
  pr_opened: 'implemented', pr_updated: 'implemented', commit: 'implemented', pr_closed: 'implemented', review_comment: 'reviewed', pr_merged: 'delivered',
  release: 'delivered', issue_opened: 'reported', issue_comment: 'investigated', email_sent: 'reported', sheet_row: 'outcome'
}
function evidenceStage(e, task) {
  if (EVIDENCE_STAGE[e.kind] && !['email_sent'].includes(e.kind)) return EVIDENCE_STAGE[e.kind]
  const text = `${e.title || ''} ${e.content || ''}`
  if (e.kind === 'email_received') return Date.parse(e.occurred_at) <= Date.parse(task.started_at || task.created_at) ? 'reported' : INVESTIGATE.test(text) ? 'investigated' : 'reported'
  if (e.kind === 'email_sent') return task.completed_at && Date.parse(e.occurred_at) >= Date.parse(task.completed_at) ? 'outcome' : INVESTIGATE.test(text) ? 'investigated' : 'reported'
  if (e.kind === 'meeting') return 'planned'
  // Messages: investigation when they describe it, otherwise coordination (planning).
  return INVESTIGATE.test(text) ? 'investigated' : 'planned'
}

/** Can this context see a person's journeys? Themselves, admins, and managers with them in scope. */
function canSeePerson(db, ctx, userId) {
  return userId === ctx.user.id || (isManager(ctx) && scopeUserIds(db, ctx).includes(userId))
}

/** The full journey of one task, from the viewer's point of view (only evidence they may see). */
export function taskJourney(db, ctx, taskId) {
  const task = requireVisibleTask(db, ctx, v.id(taskId, 'Task', { required: true }))
  const owner = task.assignee_id
  const who = (uid) => (uid ? { id: uid, name: userName(db, uid), isOwner: uid === owner } : null)
  const steps = []
  const push = (s) => steps.push({ fact: true, stageBy: 'rule', ...s })

  // Where the work came from: a request (internal, or an email/Slack intake) or the task's creation.
  if (task.source_request_id) {
    const r = db.prepare('SELECT * FROM task_requests WHERE id = ?').get(task.source_request_id)
    if (r) push({ id: `request:${r.id}`, stage: 'reported', at: r.created_at, source: r.source === 'external' ? (String(r.external_ref || '').split(':')[0] || 'external') : 'teampulse', title: `Requested: ${r.title}`, detail: clip(r.description, 300), author: r.requested_by ? who(r.requested_by) : { name: r.external_requester || 'External requester', external: true }, href: '#/requests' })
  }
  push({ id: `created:${task.id}`, stage: 'planned', at: task.created_at, source: 'teampulse', title: 'Task created', detail: task.expected_outcome ? `Expected outcome: ${clip(task.expected_outcome, 200)}` : null, author: who(task.created_by), href: `#/tasks/${task.id}` })

  for (const e of db.prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, rowid`).all(task.id)) {
    const d = json(e.data, {})
    if (e.type === 'progress' && d.note) push({ id: `event:${e.id}`, stage: INVESTIGATE.test(d.note) ? 'investigated' : 'implemented', at: e.created_at, source: 'teampulse', title: `Progress ${d.to}%`, detail: clip(d.note, 300), author: who(e.actor_id), href: `#/tasks/${task.id}` })
    else if (e.type === 'reopened') push({ id: `event:${e.id}`, stage: 'rework', at: e.created_at, source: 'teampulse', title: 'Reopened after completion', detail: clip(d.reason, 300), author: who(e.actor_id), href: `#/tasks/${task.id}` })
    else if (e.type === 'comment' && INVESTIGATE.test(d.body || '')) push({ id: `event:${e.id}`, stage: 'investigated', at: e.created_at, source: 'teampulse', title: 'Comment', detail: clip(d.body, 300), author: who(e.actor_id), href: `#/tasks/${task.id}` })
  }
  for (const b of db.prepare(`SELECT * FROM blockers WHERE task_id = ? ORDER BY reported_at`).all(task.id)) {
    const outside = Boolean(b.is_external) || Boolean(b.dependency_owner_id && b.dependency_owner_id !== owner)
    push({ id: `blocker:${b.id}`, stage: 'blocked', at: b.reported_at, source: 'teampulse', title: `Blocked${outside ? ' (outside their control)' : ''}`, detail: `${clip(b.description, 200)}${b.status === 'RESOLVED' ? ` — resolved${b.resolution_note ? `: ${clip(b.resolution_note, 120)}` : ''}` : ' — still open'}`, author: who(b.reported_by), href: `#/tasks/${task.id}`, outsideControl: outside, open: b.status === 'OPEN' })
  }
  for (const s of db.prepare(`SELECT * FROM completion_submissions WHERE task_id = ? ORDER BY created_at`).all(task.id)) {
    push({ id: `submission:${s.id}`, stage: 'delivered', at: s.created_at, source: 'teampulse', title: 'Submitted for review', detail: clip(`${s.summary} — ${s.outcome}`, 300), author: who(s.submitted_by), selfReported: true, href: `#/tasks/${task.id}` })
    for (const r of db.prepare(`SELECT * FROM manager_reviews WHERE subject_type = 'submission' AND subject_id = ? ORDER BY created_at`).all(s.id)) {
      push({ id: `review:${r.id}`, stage: r.decision === 'APPROVED' ? 'accepted' : 'rework', at: r.created_at, source: 'teampulse', title: r.decision === 'APPROVED' ? 'Approved by a manager' : 'Changes requested', detail: clip(r.comment, 300), author: who(r.reviewer_id), href: `#/tasks/${task.id}` })
    }
  }

  // External evidence linked to the task (confirmed, or suggested ≥ the analysis threshold; weaker ones listed apart).
  const links = db.prepare(`SELECT e.*, l.id AS link_id, l.status AS link_status, l.method AS link_method, l.confidence AS link_confidence, l.share, l.contributor_id FROM evidence_task_links l
                            JOIN external_evidence e ON e.id = l.evidence_id WHERE l.task_id = ? AND l.status != 'rejected' AND e.status = 'active' ORDER BY e.occurred_at`).all(task.id)
    .filter((e) => canSeeEvidence(db, ctx, e))
  const used = links.filter((e) => e.link_status === 'confirmed' || e.link_confidence >= IN_ANALYSIS)
  const weak = links.filter((e) => !(e.link_status === 'confirmed' || e.link_confidence >= IN_ANALYSIS))
  // Deduplicate: one person's commits in one repository are one step; a Slack thread is one step; updates of the same
  // item (a PR opened then merged) are already one evidence row.
  const groups = new Map()
  for (const e of used) {
    const key = e.kind === 'commit' ? `commit:${e.actor_user_id || e.actor_identity}:${e.resource_ref}` : e.app === 'slack' ? `slack:${e.parent_ref || e.external_id}` : `one:${e.id}`
    groups.set(key, [...(groups.get(key) || []), e])
  }
  for (const list of groups.values()) {
    const e = list[0]
    const many = list.length > 1
    const author = e.actor_user_id ? who(e.actor_user_id) : { name: e.actor_identity || 'unknown', external: e.attribution === 'external', unknown: e.attribution === 'unknown' }
    push({
      id: `evidence:${e.id}`, stage: evidenceStage(e, task), at: list.at(-1).occurred_at, source: e.app,
      title: `${APP_LABEL[e.app] || e.app}: ${many ? `series — ${clip(list.at(-1).title, 120)}` : clip(e.title, 140)}`,
      detail: many ? list.slice(0, 5).map((x) => `• ${clip(x.title, 100)}`).join('\n') : clip(e.content, 300), author,
      verification: e.verification, attribution: e.attribution, disputed: e.attribution === 'disputed', shared: e.share === 'shared',
      href: e.source_url || '#/evidence', evidenceIds: list.map((x) => x.id), linkIds: list.map((x) => x.link_id),
      linkedBy: e.link_status === 'confirmed' ? 'confirmed by a person' : `suggested (${e.link_method})`
    })
  }

  // Outcomes.
  const impacts = db.prepare(`SELECT * FROM impact_records WHERE org_id = ? AND task_id = ? ORDER BY created_at`).all(task.org_id, task.id)
  for (const r of impacts) {
    const value = r.value_type === 'NONE' ? null : `${r.value_type === 'ESTIMATED' ? '≈ ' : ''}${r.measurable_value} ${r.measurement_unit}${r.value_type === 'ESTIMATED' ? ' (estimate)' : ''}`
    push({ id: `impact:${r.id}`, stage: 'outcome', at: r.verified_at || r.created_at, source: 'teampulse', title: `${r.verification_status === 'VERIFIED' ? 'Verified outcome' : r.verification_status === 'REJECTED' ? 'Outcome not verified' : 'Claimed outcome (awaiting verification)'}: ${r.title}`, detail: [clip(r.result, 200), value].filter(Boolean).join(' · '), author: who(r.user_id), verified: r.verification_status === 'VERIFIED', href: `#/impact/${r.id}`, sharedKey: r.shared_outcome_key })
  }

  steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || STAGE_INDEX[a.stage] - STAGE_INDEX[b.stage])
  const reached = [...new Set(steps.map((s) => s.stage))]
  // Contributors: the owner, people whose evidence or outcomes are linked, contributors named on outcomes.
  const contributors = new Map()
  const addC = (uid, role) => { if (!uid) return; const c = contributors.get(uid) || { id: uid, name: userName(db, uid), roles: new Set() }; c.roles.add(role); contributors.set(uid, c) }
  addC(owner, 'task owner')
  for (const e of used) if (e.actor_user_id && e.actor_user_id !== owner) addC(e.actor_user_id, `${APP_LABEL[e.app]} evidence`)
  for (const r of impacts) { addC(r.user_id, 'outcome'); for (const c of json(r.contributors, [])) addC(c, 'named contributor') }
  for (const r of impacts.filter((x) => x.shared_outcome_key)) {
    for (const o of db.prepare(`SELECT DISTINCT user_id FROM impact_records WHERE org_id = ? AND shared_outcome_key = ? AND id != ?`).all(task.org_id, r.shared_outcome_key, r.id)) addC(o.user_id, 'shares the outcome')
  }
  // Everyone who contributed to work the viewer may see is named (their evidence is already visible on the task).
  const visibleContributors = [...contributors.values()].map((c) => ({ id: c.id, name: c.name, roles: [...c.roles] }))

  // What is missing — stated, never invented.
  const has = (st) => reached.includes(st)
  const missing = []
  const delivered = has('delivered') || ['SUBMITTED_FOR_REVIEW', 'COMPLETED'].includes(task.status)
  if (!task.description && !task.expected_outcome) missing.push('No description or expected outcome: why the work mattered is not recorded.')
  if (delivered && !used.length && !db.prepare(`SELECT 1 FROM evidence WHERE task_id = ?`).get(task.id)) missing.push('No evidence of the work (PR, document, test results, demo) is attached or linked.')
  if (used.some((e) => ['pr_opened', 'pr_merged', 'commit'].includes(e.kind)) && !has('reviewed') && !has('accepted')) missing.push('No review of the code or work is recorded.')
  if (task.status === 'COMPLETED' && !impacts.length) missing.push('No outcome is recorded: what changed because of this work?')
  if (impacts.length && !impacts.some((r) => r.verification_status === 'VERIFIED')) missing.push('The outcome is claimed but not verified by a manager yet.')
  if (weak.length) missing.push(`${weak.length} possible evidence link(s) wait for confirmation.`)
  if (links.some((e) => e.attribution === 'disputed')) missing.push('Some linked evidence has disputed authorship — a manager decides whose it is.')

  // The engine's current assessment (source of truth for complexity and dimensions).
  const a = owner ? db.prepare('SELECT * FROM contribution_assessments WHERE task_id = ? AND user_id = ? AND is_current = 1').get(task.id, owner) : null
  const eff = (k) => (a ? db.prepare('SELECT * FROM assessment_dimensions WHERE assessment_id = ? AND dimension = ? AND is_effective = 1').get(a.id, k) : null)
  const c = eff('complexity')
  const related = db.prepare(`SELECT DISTINCT t.id, t.title, t.status FROM evidence_task_links l1 JOIN evidence_task_links l2 ON l2.evidence_id = l1.evidence_id AND l2.task_id != l1.task_id JOIN tasks t ON t.id = l2.task_id
                              WHERE l1.task_id = ? AND l1.status != 'rejected' AND l2.status != 'rejected' LIMIT 10`).all(task.id)
    .filter((t) => { try { requireVisibleTask(db, ctx, t.id); return true } catch { return false } })
  return {
    task: { id: task.id, ref: taskRef(task.id), title: task.title, status: task.status, ownerId: owner, ownerName: userName(db, owner), priority: task.priority, createdAt: task.created_at, completedAt: task.completed_at },
    stages: STAGES.map(([k, l]) => ({ key: k, label: l, reached: has(k) })), steps, contributors: visibleContributors, missing,
    possibleLinks: weak.map((e) => ({ evidenceId: e.id, linkId: e.link_id, app: e.app, title: e.title, method: e.link_method, confidence: e.link_confidence, href: e.source_url })),
    related,
    assessment: a ? { id: a.id, complexity: c?.state === 'assessed' ? `L${c.level}` : null, evidenceState: a.evidence_state, managerStatus: a.manager_status, employeeStatus: a.employee_status, provider: a.provider, simulated: Boolean(json(a.context_json, {}).simulated) } : null,
    outcome: impacts.some((r) => r.verification_status === 'VERIFIED') ? 'verified' : impacts.length ? 'claimed' : 'none',
    note: 'Each step is a recorded fact with its source and author. The stage it sits in is KONVO’s rule-based reading. Missing steps are listed, never filled in.'
  }
}

/** A short summary of a journey for lists. */
function summarize(j) {
  const furthest = [...j.stages].reverse().find((s) => s.reached && !['blocked', 'rework'].includes(s.key))
  return {
    taskId: j.task.id, ref: j.task.ref, title: j.task.title, status: j.task.status, ownerId: j.task.ownerId, ownerName: j.task.ownerName,
    stage: furthest?.label || 'Planned', stagesReached: j.stages.filter((s) => s.reached).map((s) => s.key), outcome: j.outcome,
    complexity: j.assessment?.complexity || null, assessed: Boolean(j.assessment), shared: j.contributors.length > 1, contributors: j.contributors.map((c) => c.name),
    sources: [...new Set(j.steps.map((s) => s.source))], missing: j.missing.length, blocked: j.steps.some((s) => s.stage === 'blocked' && s.open),
    lastActivityAt: j.steps.at(-1)?.at || j.task.createdAt
  }
}

/** One journey per task with activity in the period — not one entry per event. */
export function listJourneys(db, ctx, { userId, from, to } = {}) {
  const uid = userId ? v.id(userId, 'Person', { required: true }) : ctx.user.id
  if (!canSeePerson(db, ctx, uid)) throw notFound('Person')
  const f = v.dateTime(from, 'From') || new Date(Date.now() - 30 * 86400000).toISOString()
  const t = v.dateTime(to, 'To') || new Date().toISOString()
  const scope = taskScopeSql(ctx)
  const tasks = db.prepare(`SELECT t.* FROM tasks t WHERE ${scope.sql} AND t.assignee_id = ? AND t.status != 'CANCELLED' AND (t.updated_at BETWEEN ? AND ? OR t.created_at BETWEEN ? AND ?
                            OR EXISTS (SELECT 1 FROM evidence_task_links l JOIN external_evidence e ON e.id = l.evidence_id WHERE l.task_id = t.id AND l.status != 'rejected' AND e.occurred_at BETWEEN ? AND ?))
                            ORDER BY t.updated_at DESC LIMIT 60`).all(...scope.params, uid, f, t, f, t, f, t)
  return { userId: uid, name: userName(db, uid), from: f, to: t, journeys: tasks.map((x) => summarize(taskJourney(db, ctx, x.id))), note: 'One entry per piece of work. Events are never counted as separate achievements.' }
}

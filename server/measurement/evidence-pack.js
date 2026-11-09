// Builds the evidence pack for one person's work on one task: everything TeamPulse already knows, as numbered
// references the model may cite (and nothing else), plus deterministic signals the guardrails rely on.
// The pack is deterministic (no "now"), so identical inputs hash identically and are never analysed twice.
//
// Future phases add normalized external evidence (GitHub, Slack, Gmail, Calendar, Sheets via ViaSocket) through
// EXTERNAL_SOURCES: each returns items of the same shape { kind, at, author, text, verified, source, href }.
// None is wired in this phase: external activity is not collected and is never treated as proof of value.
import { createHash } from 'node:crypto'
import { json } from '../db.js'

export const EXTERNAL_SOURCES = [] // (db, task, subjectId) => items; empty in phase 1 by design

const clip = (s, n = 1500) => (s == null ? null : String(s).length > n ? `${String(s).slice(0, n)}…` : String(s))
const words = (s) => (s ? String(s).trim().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length : 0)
const hostOf = (url) => { try { return new URL(url).host } catch { return null } }
// Quality problems mentioned in people's text (reviews, comments, submissions). Structured signals come first —
// a reopening after completion and "changes requested" review decisions are recorded events, not keywords. Text is
// only a secondary signal, so it is deliberately narrow: "added a regression test", "no regressions", "fixed the
// failing tests" are not problems. TeamPulse has no structured test results yet (CI data would come in phase 2).
const QUALITY_RE = /\b(fail(?:ed|ing|s)?\s+tests?|tests?\s+(?:are\s+|were\s+|still\s+)?fail(?:ed|ing|s|ures?)?|test\s+failures?|CI\s+(?:is\s+|was\s+)?(?:failing|red|broken)|regression(?!\s+(?:tests?|suites?|coverage|checks?|testing))|regressed|broke(?:n)?\s|bug\s+(?:was\s+)?(?:re)?introduced|rolled\s+back|rollback)/gi
const NEGATED = /\b(no|not|without|zero|fixed|fixes|fixing|resolved|resolves|addressed|prevent(?:s|ed|ing)?|avoid(?:s|ed|ing)?)\b[^.;!?]{0,25}$/i
/** True when the text reports a quality problem that is not negated or described as fixed. Exported for tests. */
export function reportsQualityProblem(text) {
  if (!text) return false
  for (const m of String(text).matchAll(QUALITY_RE)) {
    const before = String(text).slice(Math.max(0, m.index - 40), m.index)
    if (!NEGATED.test(before)) return true
  }
  return false
}

export function buildEvidencePack(db, task, subjectId) {
  const role = db.prepare(`SELECT m.role, m.title, t.name AS team FROM memberships m LEFT JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND m.org_id = ?`).get(subjectId, task.org_id) || {}
  const roleOf = (uid) => {
    if (!uid) return 'system'
    if (uid === subjectId) return 'employee'
    const r = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?').get(uid, task.org_id)?.role
    return r === 'employee' ? 'teammate' : r ? 'manager' : 'other'
  }
  const items = []
  const refs = {}
  const counters = {}
  const add = (kind, item, meta) => {
    counters[kind] = (counters[kind] || 0) + 1
    const ref = `${kind}-${counters[kind]}`
    items.push({ ref, kind, ...item })
    refs[ref] = { kind, ...meta }
    return ref
  }

  // History: what happened, in order. Progress notes and comments carry the narrative; status changes the shape.
  const events = db.prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, rowid`).all(task.id)
  const signals = { changesRequested: 0, approved: false, reopened: 0, qualityConcerns: [], managerChanges: [], reassigned: false, progressUpdates: 0 }
  for (const e of events) {
    const d = json(e.data, {})
    const by = roleOf(e.actor_id)
    if (e.type === 'progress') {
      signals.progressUpdates++
      if (d.note) add('update', { at: e.created_at, author: by, text: clip(d.note), progress: d.to }, { label: `Progress note (${d.to}%)`, taskId: task.id })
    } else if (e.type === 'comment') {
      const r = add('comment', { at: e.created_at, author: by, text: clip(d.body) }, { label: `Comment by ${by}`, taskId: task.id })
      if (reportsQualityProblem(d.body)) signals.qualityConcerns.push({ ref: r, text: clip(d.body, 200) })
    } else if (e.type === 'reopened') {
      signals.reopened++
      const r = add('event', { at: e.created_at, author: by, text: `Task reopened after completion. Reason: ${d.reason || 'not given'}` }, { label: 'Reopened after completion', taskId: task.id })
      signals.qualityConcerns.push({ ref: r, text: `Reopened after completion: ${clip(d.reason, 200) || 'no reason given'}` })
    } else if (e.type === 'reassigned') {
      signals.reassigned = true
      add('event', { at: e.created_at, author: by, text: `Task reassigned${d.reason ? `: ${d.reason}` : ''}` }, { label: 'Reassigned', taskId: task.id })
    } else if (e.type === 'deadline_changed' || e.type === 'priority_changed') {
      signals.managerChanges.push(e.type)
      add('event', { at: e.created_at, author: by, text: `${e.type === 'deadline_changed' ? 'Deadline' : 'Priority'} changed from ${d.from || 'none'} to ${d.to || 'none'}${d.reason ? ` (${d.reason})` : ''}` }, { label: e.type.replace('_', ' '), taskId: task.id })
    }
  }

  // Blockers: always context. Outside the person's control when external or waiting on someone else.
  const blockers = db.prepare(`SELECT * FROM blockers WHERE task_id = ? ORDER BY reported_at`).all(task.id)
  const blockerContext = blockers.map((b) => {
    const outside = Boolean(b.is_external) || Boolean(b.dependency_owner_id && b.dependency_owner_id !== subjectId)
    const ref = add('blocker', {
      at: b.reported_at, author: roleOf(b.reported_by), text: clip(b.description, 600), dependency: clip(b.dependency_note, 200), outsideEmployeeControl: outside,
      status: b.status, resolvedAt: b.resolved_at, resolution: clip(b.resolution_note, 400), escalated: Boolean(b.escalated_at)
    }, { label: `Blocker${b.is_external ? ' (external)' : ''}`, taskId: task.id })
    return { ref, outside, status: b.status, reportedAt: b.reported_at, resolvedAt: b.resolved_at, hours: b.resolved_at ? Math.round((Date.parse(b.resolved_at) - Date.parse(b.reported_at)) / 3600000) : null }
  })

  // Completion submissions (the employee's own account: claims, not proof) and the manager's review decisions.
  const subs = db.prepare(`SELECT * FROM completion_submissions WHERE task_id = ? ORDER BY created_at`).all(task.id)
  const claims = []
  for (const s of subs) {
    const ref = add('submission', { at: s.created_at, author: roleOf(s.submitted_by), selfReported: true, workSummary: clip(s.summary, 3000), outcomeClaimed: clip(s.outcome, 2000), reviewStatus: s.status },
      { label: 'Completion submission', taskId: task.id })
    if (s.submitted_by === subjectId) claims.push({ ref, text: clip(s.outcome, 500) })
    if (reportsQualityProblem(`${s.summary} ${s.outcome}`)) signals.qualityConcerns.push({ ref, text: 'Submission mentions failing tests / regression' })
    for (const r of db.prepare(`SELECT * FROM manager_reviews WHERE subject_type = 'submission' AND subject_id = ? ORDER BY created_at`).all(s.id)) {
      const rr = add('review', { at: r.created_at, author: roleOf(r.reviewer_id), decision: r.decision, text: clip(r.comment, 1500) }, { label: `Review: ${r.decision === 'APPROVED' ? 'approved' : 'changes requested'}`, taskId: task.id })
      if (r.decision === 'CHANGES_REQUESTED') signals.changesRequested++
      if (r.decision === 'APPROVED') signals.approved = true
      if (reportsQualityProblem(r.comment)) signals.qualityConcerns.push({ ref: rr, text: clip(r.comment, 200) })
    }
  }
  // A later approval after a quality concern settles review-time concerns (not regressions after completion).
  const lastApproval = db.prepare(`SELECT MAX(created_at) AS at FROM manager_reviews WHERE task_id = ? AND decision = 'APPROVED'`).get(task.id).at

  // Evidence attached to the task or its submissions. File contents are not read in this phase: only that they exist.
  const evidenceRows = db.prepare(`SELECT e.* FROM evidence e WHERE e.task_id = ? AND e.owner_type IN ('task','submission') ORDER BY e.created_at`).all(task.id)
  const evidenceRefs = evidenceRows.map((e) => add('evidence', {
    at: e.created_at, author: roleOf(e.created_by), type: e.kind, label: clip(e.label || e.file_name, 200), host: e.kind === 'link' ? hostOf(e.url) : null,
    note: e.kind === 'file' ? 'Uploaded file; its contents were not read.' : 'Link; the linked page was not opened.'
  }, { label: e.label || e.file_name || hostOf(e.url) || 'Evidence', evidenceId: e.id, href: e.kind === 'link' ? e.url : `/api/evidence/${e.id}/download`, taskId: task.id }))

  // Impact records about this task, by the person or naming them as a contributor. Only VERIFIED ones are outcomes.
  const impactRows = db.prepare(`SELECT * FROM impact_records WHERE org_id = ? AND task_id = ? ORDER BY created_at`).all(task.org_id, task.id)
    .filter((r) => r.user_id === subjectId || json(r.contributors, []).includes(subjectId))
  const impacts = impactRows.map((r) => {
    const contributors = [...new Set([r.user_id, ...json(r.contributors, [])])]
    const sharedWithKey = r.shared_outcome_key ? db.prepare(`SELECT DISTINCT user_id FROM impact_records WHERE org_id = ? AND shared_outcome_key = ? AND user_id != ?`).all(task.org_id, r.shared_outcome_key, subjectId).map((x) => x.user_id) : []
    const others = [...new Set([...contributors, ...sharedWithKey])].filter((u) => u !== subjectId)
    const evidenceCount = db.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE owner_type = 'impact' AND owner_id = ?`).get(r.id).n
    const ref = add('impact', {
      at: r.created_at, author: roleOf(r.user_id), category: r.category, outcomeType: r.outcome_type, before: clip(r.previous_state, 800), workPerformed: clip(r.work_performed, 800), result: clip(r.result, 800),
      value: r.value_type === 'NONE' ? null : { kind: r.value_type.toLowerCase(), amount: r.measurable_value, unit: r.measurement_unit },
      verification: r.verification_status.toLowerCase(), evidenceItems: evidenceCount, sharedWithOthers: others.length
    }, { label: `Impact record: ${r.title}`, impactId: r.id, href: `#/impact/${r.id}` })
    return { ref, id: r.id, title: r.title, category: r.category, valueType: r.value_type, value: r.measurable_value, unit: r.measurement_unit, verification: r.verification_status, evidenceCount, owner: r.user_id, others, sharedKey: r.shared_outcome_key }
  })

  // Context the employee added after an analysis (self-reported).
  for (const c of db.prepare(`SELECT * FROM assessment_feedback WHERE task_id = ? AND subject_user_id = ? AND action = 'ADD_CONTEXT' ORDER BY created_at`).all(task.id, subjectId)) {
    add('context', { at: c.created_at, author: 'employee', selfReported: true, text: clip(c.comment, 2000) }, { label: 'Context added by the employee', taskId: task.id })
  }

  // Collaboration already visible in TeamPulse: blockers of other people's tasks this person resolved, and their
  // comments on other people's tasks, while this task was open. (Message volume is never counted.)
  const from = task.started_at || task.assigned_at || task.created_at
  const to = task.completed_at || task.submitted_at || null
  const inWindow = (at) => at >= from && (!to || at <= to)
  for (const b of db.prepare(`SELECT b.*, t.title FROM blockers b JOIN tasks t ON t.id = b.task_id WHERE b.org_id = ? AND b.resolved_by = ? AND b.task_id != ? AND t.assignee_id IS NOT ? ORDER BY b.resolved_at LIMIT 10`).all(task.org_id, subjectId, task.id, subjectId)) {
    if (inWindow(b.resolved_at)) add('help', { at: b.resolved_at, author: 'employee', text: `Resolved a blocker on a teammate's task "${clip(b.title, 120)}": ${clip(b.resolution_note, 400) || 'no note'}` }, { label: `Unblocked: ${b.title}`, taskId: b.task_id, href: `#/tasks/${b.task_id}` })
  }
  for (const e of db.prepare(`SELECT e.*, t.title FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.org_id = ? AND e.actor_id = ? AND e.type = 'comment' AND e.task_id != ? AND t.assignee_id IS NOT ? ORDER BY e.created_at LIMIT 10`).all(task.org_id, subjectId, task.id, subjectId)) {
    if (inWindow(e.created_at)) add('help', { at: e.created_at, author: 'employee', text: `Comment on a teammate's task "${clip(e.title, 120)}": ${clip(json(e.data, {}).body, 400)}` }, { label: `Helped on: ${e.title}`, taskId: e.task_id, href: `#/tasks/${e.task_id}` })
  }
  for (const src of EXTERNAL_SOURCES) for (const it of src(db, task, subjectId) || []) add('external', it, { label: it.label || it.source, href: it.href || null })

  // Effort is context only (never rewarded): elapsed time and how many updates were posted.
  const effort = {
    startedAt: task.started_at, submittedAt: task.submitted_at, completedAt: task.completed_at,
    elapsedHours: task.started_at && (task.submitted_at || task.completed_at) ? Math.round((Date.parse(task.submitted_at || task.completed_at) - Date.parse(task.started_at)) / 3600000) : null,
    progressUpdates: signals.progressUpdates
  }

  const regression = signals.reopened > 0 || signals.qualityConcerns.some((q) => !lastApproval || items.find((i) => i.ref === q.ref)?.at > lastApproval)
  const substantiveWords = words(task.description) + words(task.expected_outcome) + items.filter((i) => ['update', 'comment', 'submission', 'review', 'context', 'impact', 'help'].includes(i.kind))
    .reduce((n, i) => n + words(i.text) + words(i.workSummary) + words(i.outcomeClaimed) + words(i.result) + words(i.workPerformed), 0)

  const pack = {
    person: { role: role.role || null, title: role.title || null, team: role.team || null, note: 'The person is referred to as "the employee"; names are left out on purpose.' },
    task: {
      ref: 'task', title: clip(task.title, 200), description: clip(task.description, 3000), expectedOutcome: clip(task.expected_outcome, 1500), priority: task.priority,
      status: task.status, dueAt: task.due_at, createdAt: task.created_at, createdBy: roleOf(task.created_by), assignedTo: task.assignee_id === subjectId ? 'employee' : 'someone else',
      note: 'Title and priority are labels set by people; they are not evidence of complexity.'
    },
    items,
    signals: {
      reviewApproved: signals.approved, changesRequested: signals.changesRequested, reopenedAfterCompletion: signals.reopened,
      qualityConcerns: signals.qualityConcerns.map((q) => q.ref), unresolvedQualityConcern: regression,
      blockersOutsideEmployeeControl: blockerContext.filter((b) => b.outside).map((b) => b.ref), openBlockers: blockerContext.filter((b) => b.status === 'OPEN').map((b) => b.ref),
      managerChangedDeadlineOrPriority: signals.managerChanges.length > 0, reassigned: signals.reassigned,
      verifiedImpactRecords: impacts.filter((i) => i.verification === 'VERIFIED').map((i) => i.ref),
      sharedImpactRecords: impacts.filter((i) => i.others.length).map((i) => i.ref)
    },
    effortContext: effort
  }
  const facts = {
    refs: { task: { kind: 'task', label: task.title, href: `#/tasks/${task.id}`, taskId: task.id }, ...refs },
    blockers: blockerContext, impacts, claims, effort, signals, regression, lastApproval,
    evidenceItems: evidenceRefs.length, substantiveWords,
    delivered: ['SUBMITTED_FOR_REVIEW', 'COMPLETED'].includes(task.status),
    blockedOutside: blockerContext.some((b) => b.outside && b.status === 'OPEN') || (task.status !== 'COMPLETED' && task.status !== 'SUBMITTED_FOR_REVIEW' && blockerContext.some((b) => b.outside)),
    period: { start: from, end: to || task.updated_at }
  }
  return { pack, facts }
}

/** Not enough to assess anything: no description, a one-line completion note, no evidence, no outcome records. */
export function isInsufficient(facts) {
  return facts.substantiveWords < 15 && facts.evidenceItems === 0 && facts.impacts.length === 0
}

export function hashInput(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

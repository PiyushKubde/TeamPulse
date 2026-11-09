// Manager reports with date and person filters, and CSV export. No report ranks people by task count.
import { json } from '../db.js'
import { invalid } from '../errors.js'
import { requireManager, scopeUserIds, taskScopeSql } from '../access.js'
import * as v from '../validate.js'
import { deriveConditions, listBlockers, presentTask } from './tasks.js'
import { contributionSummary, listImpact } from './impact.js'

function range(q) {
  const to = q.to ? v.dateTime(q.to, 'To') : new Date().toISOString()
  const from = q.from ? v.dateTime(String(q.from).length === 10 ? `${q.from}T00:00:00.000Z` : q.from, 'From') : new Date(Date.parse(to) - 30 * 86400000).toISOString()
  if (from > to) throw invalid('“From” must be before “To”.')
  return { from, to }
}

function scopedPeople(db, ctx, q) {
  const ids = scopeUserIds(db, ctx)
  if (q.userId) {
    const uid = v.id(q.userId, 'Person')
    if (!ids.includes(uid)) throw invalid('That person is not in your team.')
    return [uid]
  }
  return ids
}

export function buildReport(db, ctx, type, q = {}) {
  requireManager(ctx)
  const { from, to } = range(q)
  const people = scopedPeople(db, ctx, q)
  const names = Object.fromEntries(db.prepare(`SELECT id, name FROM users WHERE id IN (${people.map(() => '?').join(',')})`).all(...people).map((u) => [u.id, u.name]))
  const scope = taskScopeSql(ctx)
  const tasksIn = () => db.prepare(`SELECT t.* FROM tasks t WHERE ${scope.sql}`).all(...scope.params)
    .filter((t) => !q.userId || t.assignee_id === people[0])
  switch (type) {
    case 'workload': {
      const open = tasksIn().filter((t) => ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW'].includes(t.status))
      const rows = people.map((id) => {
        const mine = open.filter((t) => t.assignee_id === id)
        const d = mine.map((t) => deriveConditions(t))
        return { person: names[id], active: mine.length, assigned: mine.filter((t) => t.status === 'ASSIGNED').length, inProgress: mine.filter((t) => t.status === 'IN_PROGRESS').length,
          blocked: mine.filter((t) => t.status === 'BLOCKED').length, inReview: mine.filter((t) => t.status === 'SUBMITTED_FOR_REVIEW').length,
          overdue: d.filter((x) => x.overdue).length, atRisk: d.filter((x) => x.atRisk).length, critical: mine.filter((t) => t.priority === 'CRITICAL').length }
      })
      return { title: 'Team workload (current)', columns: ['person', 'active', 'assigned', 'inProgress', 'blocked', 'inReview', 'overdue', 'atRisk', 'critical'], rows, from, to }
    }
    case 'status': {
      const all = tasksIn().filter((t) => t.created_at <= to && (t.updated_at >= from))
      const by = {}
      for (const t of all) by[t.status] = (by[t.status] || 0) + 1
      const rows = ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED'].map((s) => ({ status: s, tasks: by[s] || 0 }))
      return { title: 'Task status distribution (tasks active in the period)', columns: ['status', 'tasks'], rows, from, to }
    }
    case 'overdue': {
      const rows = tasksIn().map((t) => ({ t, d: deriveConditions(t) })).filter((x) => x.d.overdue)
        .map(({ t, d }) => ({ task: t.title, assignee: names[t.assignee_id] || '(unassigned)', priority: t.priority, status: t.status, dueAt: t.due_at, hoursOverdue: d.hoursOverdue,
          openBlockers: db.prepare(`SELECT COUNT(*) AS n FROM blockers WHERE task_id = ? AND status = 'OPEN'`).get(t.id).n }))
      return { title: 'Overdue tasks', columns: ['task', 'assignee', 'priority', 'status', 'dueAt', 'hoursOverdue', 'openBlockers'], rows, from, to }
    }
    case 'blockers': {
      const rows = [...listBlockers(db, ctx, { status: 'OPEN' }), ...listBlockers(db, ctx, { status: 'RESOLVED' })]
        .filter((b) => b.reportedAt >= from && b.reportedAt <= to)
        .map((b) => ({ task: b.taskTitle, assignee: b.assigneeName, description: b.description, dependency: b.dependencyOwnerName || b.dependencyNote || (b.isExternal ? 'External' : ''),
          status: b.status, reportedAt: b.reportedAt, hoursOpen: b.hoursOpen, resolution: b.resolutionNote || '' }))
      return { title: 'Blocker history', columns: ['task', 'assignee', 'description', 'dependency', 'status', 'reportedAt', 'hoursOpen', 'resolution'], rows, from, to }
    }
    case 'contributions': {
      const s = contributionSummary(db, ctx, { from, to, ...(q.userId ? { userId: q.userId } : {}) })
      const rows = s.people.map((p) => ({ person: p.name, verified: p.verified, pending: p.pending, rejected: p.rejected, prevention: p.prevention, learning: p.learning, reusable: p.reusable, quality: p.quality,
        categories: Object.entries(p.byCategory).map(([k, n]) => `${k}:${n}`).join(' ') }))
      return { title: 'Employee contributions (by evidence, not task count)', columns: ['person', 'verified', 'pending', 'rejected', 'prevention', 'learning', 'reusable', 'quality', 'categories'], rows, totals: s.verifiedTotals, from, to }
    }
    case 'impact': {
      const rows = listImpact(db, ctx, { status: 'VERIFIED', from, to, ...(q.userId ? { userId: q.userId } : {}) })
        .map((r) => ({ person: r.userName, title: r.title, category: r.categoryLabel, outcomeType: r.outcomeType, result: r.result,
          value: r.valueType === 'NONE' ? '' : r.measurableValue, unit: r.measurementUnit || '', valueKind: r.valueType === 'NONE' ? 'none' : r.valueType.toLowerCase(), verifiedAt: r.verifiedAt }))
      return { title: 'Verified impact', columns: ['person', 'title', 'category', 'outcomeType', 'result', 'value', 'unit', 'valueKind', 'verifiedAt'], rows, from, to }
    }
    case 'weekly': {
      const w = weeklySummary(db, ctx, q)
      const rows = [
        ...w.verifiedOutcomes.map((r) => ({ section: 'Verified outcome', person: r.person, item: r.title, detail: [r.category, r.value, r.result].filter(Boolean).join(' · '), status: r.verificationStatus })),
        ...w.significantContributions.map((r) => ({ section: 'Contribution', person: r.person, item: r.title, detail: [r.category, r.value].filter(Boolean).join(' · '), status: r.verificationStatus })),
        ...w.learning.map((r) => ({ section: 'Learning', person: r.person, item: r.title, detail: r.result, status: r.verificationStatus })),
        ...w.qualityImprovements.map((r) => ({ section: 'Quality improvement', person: r.person, item: r.title, detail: r.category, status: r.verificationStatus })),
        ...w.reusableWork.map((r) => ({ section: 'Reusable work', person: r.person, item: r.title, detail: r.category, status: r.verificationStatus })),
        ...w.unresolvedBlockers.map((b) => ({ section: 'Unresolved blocker', person: b.assignee || '', item: b.task, detail: `${b.description}${b.dependency ? ` · waiting on ${b.dependency}` : ''}`, status: `open ${b.hoursOpen}h` })),
        ...w.missedCommitments.map((m) => ({ section: 'Missed commitment', person: m.assignee, item: m.task, detail: m.reasons.join('; ') || 'no reason recorded', status: m.countedAgainstPerson ? 'no documented reason' : 'documented reason' }))
      ]
      return { ...w, columns: ['section', 'person', 'item', 'detail', 'status'], rows }
    }
    default:
      throw invalid('Unknown report.')
  }
}

export const startOfWeek = (d = new Date()) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7))
  return x
}

/**
 * The weekly manager view: significant contributions, verified outcomes, unresolved blockers, quality improvements,
 * reusable work, and missed commitments with their documented reasons (blockers, deadline/priority changes).
 */
export function weeklySummary(db, ctx, q = {}) {
  requireManager(ctx)
  const ws = q.weekStart ? new Date(`${v.dateOnly(q.weekStart, 'Week start')}T00:00:00.000Z`) : startOfWeek()
  const from = ws.toISOString()
  const to = new Date(ws.getTime() + 7 * 86400000).toISOString()
  const people = scopedPeople(db, ctx, q)
  const inPeople = (id) => people.includes(id)
  const records = listImpact(db, ctx, {}).filter((r) => inPeople(r.userId))
  const created = records.filter((r) => r.createdAt >= from && r.createdAt < to)
  const verified = records.filter((r) => r.verificationStatus === 'VERIFIED' && r.verifiedAt >= from && r.verifiedAt < to)
  const scope = taskScopeSql(ctx)
  const tasks = db.prepare(`SELECT t.* FROM tasks t WHERE ${scope.sql}`).all(...scope.params)
  const missed = tasks.filter((t) => t.due_at && t.due_at >= from && t.due_at < to && (!t.completed_at || t.completed_at > t.due_at) && t.status !== 'CANCELLED' && (!t.assignee_id || inPeople(t.assignee_id)))
    .map((t) => {
      const events = db.prepare(`SELECT type, data FROM task_events WHERE task_id = ? AND type IN ('blocker_reported','deadline_changed','priority_changed','reassigned') ORDER BY created_at`).all(t.id)
      const reasons = events.map((e) => {
        const d = json(e.data, {})
        if (e.type === 'blocker_reported') return `Blocked: ${d.description}${d.external ? ' (external dependency)' : d.dependencyOwner ? ` (waiting on ${d.dependencyOwner})` : ''}`
        if (e.type === 'deadline_changed') return `Deadline changed${d.reason ? `: ${d.reason}` : ''}`
        if (e.type === 'priority_changed') return `Priority changed to ${d.to}${d.reason ? `: ${d.reason}` : ''}`
        return `Reassigned${d.reason ? `: ${d.reason}` : ''}`
      })
      // External dependencies and manager-driven changes are documented reasons and are not counted against the person.
      const notAgainst = events.some((e) => e.type === 'blocker_reported' || e.type === 'priority_changed' || e.type === 'deadline_changed' || e.type === 'reassigned')
      return { taskId: t.id, task: t.title, assignee: t.assignee_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(t.assignee_id)?.name : '(unassigned)', dueAt: t.due_at, status: t.status, reasons, countedAgainstPerson: !notAgainst }
    })
  const blockers = listBlockers(db, ctx, { status: 'OPEN' })
  return {
    title: `Weekly team summary — week of ${from.slice(0, 10)}`,
    weekStart: from.slice(0, 10), from, to,
    significantContributions: created.filter((r) => r.outcomeType !== 'LEARNING').map(brief),
    verifiedOutcomes: verified.map(brief),
    learning: created.filter((r) => r.outcomeType === 'LEARNING').map(brief),
    unresolvedBlockers: blockers.map((b) => ({ task: b.taskTitle, taskId: b.taskId, assignee: b.assigneeName, description: b.description, hoursOpen: b.hoursOpen, dependency: b.dependencyOwnerName || b.dependencyNote || (b.isExternal ? 'External' : null) })),
    qualityImprovements: records.filter((r) => (r.isQuality || r.category === 'RELIABILITY') && r.createdAt >= from && r.createdAt < to).map(brief),
    reusableWork: records.filter((r) => (r.isReusable || r.category === 'KNOWLEDGE_INNOVATION') && r.createdAt >= from && r.createdAt < to).map(brief),
    missedCommitments: missed,
    completedTasks: tasks.filter((t) => t.completed_at && t.completed_at >= from && t.completed_at < to).length
  }
}

const brief = (r) => ({ id: r.id, person: r.userName, title: r.title, category: r.categoryLabel, result: r.result, verificationStatus: r.verificationStatus,
  value: r.valueType === 'NONE' ? null : `${r.measurableValue} ${r.measurementUnit}${r.isEstimate ? ' (estimate)' : ''}` })

/** Plain text of the weekly summary, for Slack/Gmail delivery. */
export function weeklyText(s, orgName) {
  const lines = [`${orgName}: ${s.title}`, '']
  const section = (title, items, fmt) => { lines.push(`${title} (${items.length})`); for (const i of items.slice(0, 10)) lines.push(`• ${fmt(i)}`); if (!items.length) lines.push('• none'); lines.push('') }
  section('Verified outcomes', s.verifiedOutcomes, (r) => `${r.person}: ${r.title}${r.value ? ` — ${r.value}` : ''}`)
  section('Significant contributions', s.significantContributions, (r) => `${r.person}: ${r.title} [${r.verificationStatus.toLowerCase()}]`)
  section('Unresolved blockers', s.unresolvedBlockers, (b) => `${b.task} (${b.assignee || 'unassigned'}): ${b.description} — open ${b.hoursOpen}h`)
  section('Quality improvements', s.qualityImprovements, (r) => `${r.person}: ${r.title}`)
  section('Reusable work', s.reusableWork, (r) => `${r.person}: ${r.title}`)
  section('Missed commitments', s.missedCommitments, (m) => `${m.task} (${m.assignee})${m.reasons.length ? ` — ${m.reasons.join('; ')}` : ' — no reason recorded'}`)
  lines.push(`Completed tasks this week: ${s.completedTasks} (operational count only)`)
  return lines.join('\n')
}

const csvCell = (x) => {
  let s = x === null || x === undefined ? '' : String(x)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}` // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(report) {
  if (!report.columns) throw invalid('This report has no table to export.')
  return [report.columns.join(','), ...report.rows.map((r) => report.columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n'
}

export { presentTask }

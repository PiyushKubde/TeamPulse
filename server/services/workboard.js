// The team workboard: the tasks a person may see, laid out in five status columns.
// Columns are a read-only VIEW of the existing task lifecycle; nothing here changes a status or a rule.
//   To do        PENDING_ACCEPTANCE (awaiting the owner's acceptance), ASSIGNED (accepted, not started), DECLINED (owner declined, needs a new owner)
//   In progress  IN_PROGRESS
//   Blocked      BLOCKED (an open blocker exists)
//   In review    SUBMITTED_FOR_REVIEW (never "done" until a manager approves)
//   Done         COMPLETED (recent first, paged)
// CANCELLED and SUGGESTED tasks are not on the board. OVERDUE is derived from the deadline, never a column: an overdue task stays in its own column.
import { taskScopeSql } from '../access.js'
import { invalid } from '../errors.js'
import { orgTimezone, zonedParts, zonedTimeToMs, addDays } from '../time.js'
import * as v from '../validate.js'
import { listTasks, presentTask } from './tasks.js'

export const COLUMN_OF = { PENDING_ACCEPTANCE: 'todo', ASSIGNED: 'todo', DECLINED: 'todo', IN_PROGRESS: 'in_progress', BLOCKED: 'blocked', SUBMITTED_FOR_REVIEW: 'in_review', COMPLETED: 'done' }
export const COLUMNS = ['todo', 'in_progress', 'blocked', 'in_review', 'done']
const OPEN_STATUSES = Object.keys(COLUMN_OF).filter((s) => s !== 'COMPLETED')
const KPIS = ['ACTIVE', 'IN_PROGRESS', 'BLOCKED', 'OVERDUE', 'ATTENTION', 'COMPLETED']
const DEADLINES = ['OVERDUE', 'TODAY', 'WEEK', 'NONE']
const DONE_PAGE = 15
const DONE_MAX = 50

/** The card: just what the board shows. Descriptions, evidence and assessments stay on the task page. */
const card = (t, externalBlocker) => ({
  id: t.id, title: t.title, status: t.status, column: COLUMN_OF[t.status], priority: t.priority,
  assigneeId: t.assigneeId, assigneeName: t.assigneeName, dueAt: t.dueAt, overdue: t.overdue, hoursOverdue: t.hoursOverdue, atRisk: t.atRisk,
  unassigned: !t.assigneeId, awaitingAcceptance: t.status === 'PENDING_ACCEPTANCE', declined: t.status === 'DECLINED',
  blockedHours: t.blockedHours, externalBlocker: externalBlocker.has(t.id), pendingTransfer: t.pendingTransfer ? { toName: t.pendingTransfer.toName } : null,
  progress: t.progress, teamName: t.teamName, canManage: t.canManage, isMine: t.isMine, completedAt: t.completedAt
})

function dayBounds(tz, now = Date.now()) {
  const p = zonedParts(now, tz)
  const today = { year: p.year, month: p.month, day: p.day }
  const at = (d) => zonedTimeToMs(d, tz)
  return { start: at(today), tomorrow: at(addDays(today, 1)), weekEnd: at(addDays(today, 7)) }
}

function readFilters(q, tz) {
  const search = String(q.q ?? '').trim().slice(0, 100).replace(/[%_]/g, '')
  const assigneeId = q.assigneeId === 'none' ? 'none' : v.id(q.assigneeId || null, 'Assignee')
  const priority = q.priority === 'UNRESOLVED' || q.priority === 'unresolved' ? 'UNRESOLVED' : v.oneOf(q.priority, 'Priority', v.PRIORITIES)
  const deadline = v.oneOf(q.deadline, 'Deadline', DEADLINES)
  const kpi = v.oneOf(q.kpi, 'Metric', KPIS)
  const offset = Number.parseInt(q.doneOffset ?? '0', 10)
  const limit = Number.parseInt(q.doneLimit ?? String(DONE_PAGE), 10)
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw invalid('The completed-tasks page is not valid.')
  return { search, assigneeId, priority, deadline, kpi, doneOffset: offset, doneLimit: Math.min(limit, DONE_MAX), bounds: dayBounds(tz) }
}

const matchesDeadline = (t, deadline, b) => {
  if (!deadline) return true
  if (deadline === 'NONE') return !t.dueAt
  if (deadline === 'OVERDUE') return t.overdue
  if (!t.dueAt || t.overdue) return false // a missing deadline is never "due today" or "due this week", and a passed one is Overdue, not upcoming
  const due = Date.parse(t.dueAt)
  return deadline === 'TODAY' ? due >= b.start && due < b.tomorrow : due >= b.start && due < b.weekEnd
}

const matchesKpi = (t, kpi) => ({
  ACTIVE: () => true, IN_PROGRESS: () => t.status === 'IN_PROGRESS', BLOCKED: () => t.status === 'BLOCKED', OVERDUE: () => t.overdue,
  ATTENTION: () => t.overdue || t.status === 'BLOCKED', COMPLETED: () => false // completed work is shown in Done only
}[kpi] ?? (() => true))()

export function getWorkboard(db, ctx, q = {}) {
  const tz = orgTimezone(db, ctx.orgId)
  const f = readFilters(q, tz)

  // Everything open that this person may see (the server's own task scope), once, unfiltered: the metrics always describe the whole scope.
  const all = listTasks(db, ctx, { status: OPEN_STATUSES.join(','), sort: 'due' })
  const truncated = all.length >= 500
  const overdue = all.filter((t) => t.overdue)
  const blocked = all.filter((t) => t.status === 'BLOCKED')
  const metrics = {
    active: all.length,
    inProgress: all.filter((t) => t.status === 'IN_PROGRESS').length,
    blocked: blocked.length,
    overdue: overdue.length,
    completed: db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${taskScopeSql(ctx).sql} AND t.status = 'COMPLETED'`).get(...taskScopeSql(ctx).params).n,
    attention: new Set([...overdue, ...blocked].map((t) => t.id)).size // one task, one count, even when it is both overdue and blocked
  }
  const people = [...new Map(all.filter((t) => t.assigneeId).map((t) => [t.assigneeId, t.assigneeName])).entries()].map(([userId, name]) => ({ userId, name })).sort((a, b) => a.name.localeCompare(b.name))

  const needle = f.search.toLowerCase()
  const shown = all.filter((t) => (!needle || t.title.toLowerCase().includes(needle))
    && (!f.assigneeId || (f.assigneeId === 'none' ? !t.assigneeId : t.assigneeId === f.assigneeId))
    && (!f.priority || (f.priority === 'UNRESOLVED' ? !t.priority : t.priority === f.priority))
    && matchesDeadline(t, f.deadline, f.bounds) && matchesKpi(t, f.kpi))

  const ids = shown.map((t) => t.id)
  const external = new Set(ids.length ? db.prepare(`SELECT DISTINCT task_id FROM blockers WHERE status = 'OPEN' AND is_external = 1 AND task_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.task_id) : [])
  const columns = Object.fromEntries(COLUMNS.map((c) => [c, { count: 0, tasks: [] }]))
  for (const t of shown) { const c = columns[COLUMN_OF[t.status]]; c.tasks.push(card(t, external)); c.count += 1 }

  // Done: recent first, one page at a time. Deadline and metric filters describe open work, so they leave Done out rather than mislead.
  const done = columns.done
  if ((f.kpi && f.kpi !== 'COMPLETED') || f.deadline) done.skipped = true
  else {
    const scope = taskScopeSql(ctx)
    const where = [scope.sql, `t.status = 'COMPLETED'`]
    const params = [...scope.params]
    if (needle) { where.push('t.title LIKE ?'); params.push(`%${f.search}%`) }
    if (f.assigneeId === 'none') where.push('t.assignee_id IS NULL')
    else if (f.assigneeId) { where.push('t.assignee_id = ?'); params.push(f.assigneeId) }
    if (f.priority === 'UNRESOLVED') where.push('t.priority IS NULL')
    else if (f.priority) { where.push('t.priority = ?'); params.push(f.priority) }
    const sql = where.join(' AND ')
    done.count = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${sql}`).get(...params).n
    const rows = db.prepare(`SELECT t.* FROM tasks t WHERE ${sql} ORDER BY t.completed_at DESC, t.rowid DESC LIMIT ? OFFSET ?`).all(...params, f.doneLimit, f.doneOffset)
    done.tasks = rows.map((r) => card(presentTask(db, ctx, r), new Set()))
    done.hasMore = f.doneOffset + rows.length < done.count
  }

  return { timezone: tz, truncated, metrics, people, columns, filtered: Boolean(f.search || f.assigneeId || f.priority || f.deadline || f.kpi) }
}

// Controlled assessment of work that was submitted before assessments existed (or while AI was off).
//
// Nothing here runs by itself. A manager (or an admin who has been assigned to manage a team) sees which submitted
// tasks of their teams have no assessment and starts the assessment, in a bounded batch, when AI is configured and
// switched on. The rules that keep it safe:
//   • only tasks that were submitted (status SUBMITTED_FOR_REVIEW or COMPLETED, with an owner) and have NO assessment row at all;
//     a task that has any assessment, reviewed or not, is never a candidate, so a manager's decision is never replaced;
//   • a task that already has a queued or running analysis is not a candidate;
//   • each start is capped (BATCH_LIMIT) and idempotent: starting twice cannot create a second assessment, because the
//     candidates are recomputed each time and the engine itself refuses duplicate input (same input hash, pending run);
//   • nothing is sent to the AI unless the provider is configured AND the mode is 'on' (never in supervised or off mode);
//   • the start is recorded in the audit log.
import { audit } from '../services/audit.js'
import { AppError } from '../errors.js'
import { canManageTask, requireManager, taskScopeSql } from '../access.js'
import { analyseTask } from './assessments.js'

export const BATCH_LIMIT = 25

/** Why backlog assessment can or cannot be started right now, in words a manager can act on. */
export function backlogAi(provider, mode) {
  if (!provider.configured) return { ready: false, state: 'not_configured', reason: 'AI is not configured on this server. Ask an administrator to set it up; until then nothing can be assessed.' }
  if (mode.mode === 'off') return { ready: false, state: 'off', reason: 'AI analysis is switched off on this server.' }
  if (mode.mode !== 'on') return { ready: false, state: 'supervised', reason: 'AI is in supervised validation: assessments run only for tasks an administrator selected. Nothing is assessed in bulk.' }
  return { ready: true, state: provider.simulated ? 'simulated' : 'on', reason: null }
}

const CANDIDATES = (scopeSql) => `
  SELECT t.id, t.org_id, t.created_by, t.title, t.assignee_id, t.status, t.submitted_at, t.completed_at, t.team_id, u.name AS assignee_name, tm.name AS team_name
    FROM tasks t
    JOIN users u ON u.id = t.assignee_id
    LEFT JOIN teams tm ON tm.id = t.team_id
   WHERE ${scopeSql}
     AND t.assignee_id IS NOT NULL
     AND t.status IN ('SUBMITTED_FOR_REVIEW','COMPLETED')
     AND NOT EXISTS (SELECT 1 FROM contribution_assessments a WHERE a.task_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM ai_evaluation_runs r WHERE r.task_id = t.id AND r.status IN ('QUEUED','RUNNING'))
   ORDER BY COALESCE(t.submitted_at, t.completed_at) DESC, t.id`

/** Submitted tasks of the teams this person manages that have never been assessed. */
export function backlogCandidates(db, ctx) {
  const scope = taskScopeSql(ctx, 't')
  return db.prepare(CANDIDATES(scope.sql)).all(...scope.params).filter((t) => canManageTask(db, ctx, t) && t.assignee_id !== ctx.user.id)
}

export function backlogStatus(db, ctx, provider, mode) {
  requireManager(ctx)
  const rows = backlogCandidates(db, ctx)
  const failed = new Set(db.prepare(`SELECT task_id FROM ai_evaluation_runs WHERE status = 'FAILED' AND org_id = ?`).all(ctx.orgId).map((r) => r.task_id))
  return {
    ai: backlogAi(provider, mode), total: rows.length, batchLimit: BATCH_LIMIT,
    tasks: rows.slice(0, 200).map((t) => ({ taskId: t.id, title: t.title, assignee: t.assignee_name, team: t.team_name, status: t.status, at: t.completed_at || t.submitted_at, previousAttemptFailed: failed.has(t.id) }))
  }
}

/** Org-wide count for the admin overview: a number only, no task titles or people. */
export function backlogCount(db, orgId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM tasks t
     WHERE t.org_id = ? AND t.assignee_id IS NOT NULL AND t.status IN ('SUBMITTED_FOR_REVIEW','COMPLETED')
       AND NOT EXISTS (SELECT 1 FROM contribution_assessments a WHERE a.task_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM ai_evaluation_runs r WHERE r.task_id = t.id AND r.status IN ('QUEUED','RUNNING'))`).get(orgId).n
}

/**
 * Start assessments for up to BATCH_LIMIT never-assessed submitted tasks (optionally only the listed ones).
 * Safe to call repeatedly: it only ever acts on tasks that still have no assessment and no running analysis.
 */
export function startBacklog(db, ctx, provider, mode, { taskIds } = {}) {
  requireManager(ctx)
  const ai = backlogAi(provider, mode)
  if (!ai.ready) throw new AppError(409, `ai_${ai.state}`, ai.reason)
  let rows = backlogCandidates(db, ctx)
  if (Array.isArray(taskIds)) {
    const wanted = new Set(taskIds.map(String))
    rows = rows.filter((r) => wanted.has(r.id))
  }
  const batch = rows.slice(0, BATCH_LIMIT)
  const started = []; const skipped = []
  for (const t of batch) {
    try {
      const out = analyseTask(db, ctx, provider, t.id, { trigger: 'manual', mode })
      ;(out.status === 'unchanged' || out.status === 'in_progress' ? skipped : started).push({ taskId: t.id, title: t.title, status: out.status })
    } catch (error) {
      skipped.push({ taskId: t.id, title: t.title, status: 'not_started', code: error.code || 'error', reason: error.message })
    }
  }
  if (batch.length) audit(db, { orgId: ctx.orgId, actorId: ctx.user.id, action: 'assessment.backlog_started', entityType: 'organization', entityId: ctx.orgId, after: { requested: batch.length, started: started.length, skipped: skipped.length } })
  return { started, skipped, remaining: Math.max(0, rows.length - batch.length), batchLimit: BATCH_LIMIT }
}

// Where a completed task stands in the contribution lifecycle, decided from records only (no new table, no new column).
//
//   task submitted → AI assessment pending (or unavailable) → AI assessment completed → one of:
//     NOT_ENOUGH_EVIDENCE   the evidence cannot support a judgement; nothing is invented and nothing waits for a manager
//     ROUTINE               assessed, but it is routine work (not complex, no meaningful impact): recorded, not queued for review
//     SUBMITTED_FOR_REVIEW  a meaningful contribution: it waits for a manager to approve, adjust or dispute it
//     APPROVED / ADJUSTED / DISPUTED   a manager decided (the existing manager_status)
//
// "Meaningful" is decided from what the assessment itself found, never from how many tasks someone finished:
// complexity L3 or higher, an impact level of 3 or more (an AI estimate above 3 is capped until a manager verifies it), an impact backed by
// evidence or verified, or an employee who corrected or disputed it (so a manager must look). Everything else is routine.
// A manager can still open and review any assessment; this only decides what is queued for them.

export const MEANINGFUL_LEVEL = 3

const effective = (db, id, dimension) => db.prepare('SELECT state, level FROM assessment_dimensions WHERE assessment_id = ? AND dimension = ? AND is_effective = 1').get(id, dimension)

/** Not enough evidence to judge: a rules answer, or nothing could be rated. */
export const hasNoEvidence = (a) => a.provider === 'rules' || a.evidence_state === 'insufficient'

/** The person the work belongs to corrected or disputed the assessment: a manager must look, whatever the evidence or complexity. */
export const employeeChallenged = (a) => ['CORRECTION_PROPOSED', 'DISPUTED'].includes(a.employee_status)

/** Would this (pending) assessment be a meaningful contribution that a manager should review? */
export function isMeaningful(db, a) {
  if (employeeChallenged(a)) return true
  if (hasNoEvidence(a)) return false
  const complexity = effective(db, a.id, 'complexity')
  if (complexity?.state === 'assessed' && complexity.level >= MEANINGFUL_LEVEL) return true
  const impact = effective(db, a.id, 'impact')
  if (impact?.state === 'assessed' && impact.level >= MEANINGFUL_LEVEL) return true
  try { if (['verified', 'evidence_supported'].includes(JSON.parse(a.impact_json || '{}').basis)) return true } catch { /* unreadable impact block: not meaningful on that ground */ }
  return false
}

/** Is a manager's decision still needed? (Decided assessments are history, not queue.) */
export const waitsForManager = (db, a) => a.manager_status === 'PENDING' && isMeaningful(db, a)

export function lifecycleOfAssessment(db, a) {
  if (a.manager_status === 'APPROVED') return 'APPROVED'
  if (a.manager_status === 'ADJUSTED') return 'ADJUSTED'
  if (a.manager_status === 'DISPUTED') return 'DISPUTED'
  if (employeeChallenged(a)) return 'SUBMITTED_FOR_REVIEW'
  if (hasNoEvidence(a)) return 'NOT_ENOUGH_EVIDENCE'
  return isMeaningful(db, a) ? 'SUBMITTED_FOR_REVIEW' : 'ROUTINE'
}

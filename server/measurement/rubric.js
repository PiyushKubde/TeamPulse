// The default evaluation rubric. Versioned: every assessment records the rubric version it was made with.
// Role-specific rubrics can be added later as rows with another role_scope; this phase ships one default for all roles
// and tells the model the person's role and title so expectations are read in context.
import { now } from '../db.js'

export const DIMENSIONS = ['complexity', 'impact', 'quality', 'ownership', 'problem_solving', 'collaboration']
export const RATED = ['impact', 'quality', 'ownership', 'problem_solving', 'collaboration']
export const LABELS = { complexity: 'Complexity', impact: 'Impact', quality: 'Quality', ownership: 'Ownership', problem_solving: 'Problem-solving', collaboration: 'Collaboration' }

export const DEFAULT_RUBRIC = {
  id: 'rubric-default-v2',
  key: 'default',
  version: 'default-2026-11-v2',
  roleScope: 'all',
  definition: {
    principle: 'Work volume is not work value. Assess what this piece of work actually involved and achieved, from evidence, not how many tasks were closed or how long it took.',
    complexity: {
      levels: {
        L1: 'Routine: known procedure, repetitive work, minimal dependencies.',
        L2: 'Standard: some configuration or execution required, but the approach is established.',
        L3: 'Complex: required investigation, multiple steps, non-trivial decisions or dependencies.',
        L4: 'Highly complex: unclear problem, significant technical risk, cross-system work or a novel solution.'
      },
      considers: ['technical or logical difficulty', 'ambiguity and uncertainty', 'dependencies', 'novelty', 'number of systems or components involved', 'investigation required', 'risk']
    },
    dimensions: {
      impact: { considers: ['business value', 'customer value', 'time saved', 'revenue or growth', 'cost reduction', 'reliability', 'risks or future problems prevented', 'operational efficiency'], scale: '1 negligible · 2 minor · 3 meaningful for the team · 4 significant for the business or customers · 5 exceptional, verified at business level' },
      quality: { considers: ['correctness', 'completeness', 'reliability', 'testing and validation', 'rework', 'defects or regressions', 'acceptance criteria / expected outcome met'], scale: '1 serious defects or regressions · 2 rework or open problems · 3 acceptable, little validation shown · 4 complete and validated · 5 thoroughly validated, no rework' },
      ownership: { considers: ['responsibility', 'follow-through', 'communication', 'proactive updates', 'handling blockers (reporting and escalating them)', 'completion and handoff'], scale: '1 little follow-through · 3 did what was asked and kept people informed · 5 drove the work end to end and handled obstacles proactively' },
      problem_solving: { considers: ['investigation', 'root-cause analysis', 'decisions made', 'obstacles overcome', 'alternatives explored', 'prevention of recurring problems'], scale: '1 none needed or shown · 3 solved the problem at hand · 5 found a root cause or prevented a class of problems' },
      collaboration: { considers: ['helping others', 'unblocking teammates', 'reviews', 'knowledge sharing', 'documentation', 'cross-team contribution'], scale: '1 none shown · 3 worked well with others involved · 5 materially helped or unblocked others' }
    },
    rules: [
      'Never treat the number of completed tasks as productivity.',
      'Never raise complexity because of a priority, a title or a self-assessed label: only the work evidence counts.',
      'Effort and time spent are context, not merit. Long work is not better work.',
      'Read the person\'s role and title: judge against what the role is expected to do.',
      'Blockers outside the person\'s control (external dependencies, waiting on others) are context, never a fault.',
      'Separate individual and shared contributions; do not credit a shared outcome entirely to one person.',
      'An estimate is not a verified outcome. Never invent numbers, tests, deployments or business results.',
      'Connected-app activity or message volume is not proof of valuable work.',
      'If the evidence does not support a judgement, say insufficient_evidence instead of guessing.',
      'This is decision support for a manager, never a performance or employment decision.',
      'External activity is context, not output: a commit is not impact, a merged PR is not business success, a message is not a contribution, a meeting is not output, an email is not customer value, a spreadsheet value is not a verified result.',
      'External evidence keeps its author: work by a teammate or someone outside the organization is never the employee\'s contribution, and a shared outcome is not credited in full to one person.'
    ]
  }
}

/** Seeds the built-in default rubric (idempotent). */
export function seedRubrics(db) {
  // Only the current built-in default stays active; older versions remain for the assessments made with them.
  db.prepare(`UPDATE evaluation_rubrics SET is_active = 0 WHERE org_id IS NULL AND key = 'default' AND id != ?`).run(DEFAULT_RUBRIC.id)
  db.prepare(`INSERT INTO evaluation_rubrics (id, org_id, key, version, role_scope, definition, is_active, created_at)
              VALUES (?, NULL, ?, ?, ?, ?, 1, ?) ON CONFLICT (id) DO NOTHING`)
    .run(DEFAULT_RUBRIC.id, DEFAULT_RUBRIC.key, DEFAULT_RUBRIC.version, DEFAULT_RUBRIC.roleScope, JSON.stringify(DEFAULT_RUBRIC.definition), now())
}

/** The rubric for an organization: its own active one when present, else the built-in default. */
export function rubricFor(db, orgId) {
  const r = db.prepare(`SELECT * FROM evaluation_rubrics WHERE (org_id = ? OR org_id IS NULL) AND key = 'default' AND is_active = 1 ORDER BY org_id IS NULL, created_at DESC LIMIT 1`).get(orgId)
  return r ? { id: r.id, version: r.version, definition: JSON.parse(r.definition) } : { id: DEFAULT_RUBRIC.id, version: DEFAULT_RUBRIC.version, definition: DEFAULT_RUBRIC.definition }
}

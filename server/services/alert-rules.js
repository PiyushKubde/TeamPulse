// The alert rules KONVO evaluates, with configurable thresholds. M91 is used for important human attention only;
// every alert is also an in-app notification (the fallback when M91 is off or fails).
//
// Escalation ladder for the Slack/acceptance workflow, one M91 severity per rung (RULE_SEVERITY in alerts.js):
//   LOW      task_assignment      newly assigned work (never "late")
//   MEDIUM   no_movement          no meaningful movement since the owner accepted
//   HIGH     deadline_approaching the deadline is near (earlier for tasks given a short deadline)
//   CRITICAL deadline_missed      the deadline passed and the task is not done

export const ALERT_RULES = {
  task_assigned: { label: 'New task assigned', recipients: ['assignee'], m91Default: false, threshold: null },
  task_assignment: { label: 'Task assigned for acceptance', recipients: ['assignee'], m91Default: true, threshold: null },
  no_movement: { label: 'No meaningful movement since acceptance', recipients: ['manager'], m91Default: true, threshold: 'noMovementHours' },
  deadline_approaching: { label: 'Deadline approaching', recipients: ['assignee', 'manager'], m91Default: true, threshold: 'deadlineApproachingHours' },
  deadline_missed: { label: 'Deadline missed', recipients: ['assignee', 'manager'], m91Default: true, threshold: null },
  deadline_explanation_required: { label: 'Explain a missed deadline', recipients: ['assignee'], m91Default: false, threshold: null },
  not_started: { label: 'Assigned but not started', recipients: ['assignee'], m91Default: false, threshold: 'notStartedHours' },
  no_progress: { label: 'Task pending too long (no progress)', recipients: ['assignee', 'manager'], m91Default: false, threshold: 'noProgressHours' },
  unassigned: { label: 'Unassigned task', recipients: ['manager'], m91Default: false, threshold: 'unassignedHours' },
  critical_blocked: { label: 'Critical task blocked', recipients: ['assignee', 'manager'], m91Default: true, threshold: null },
  blocker_unresolved: { label: 'Blocker unresolved', recipients: ['manager'], m91Default: true, threshold: 'blockerUnresolvedHours' },
  submitted_for_review: { label: 'Task submitted for review', recipients: ['manager'], m91Default: false, threshold: null },
  // Sprint 2: human interventions only — never for ordinary evidence events or sync errors.
  evidence_attribution_review: { label: 'Disputed evidence on an assessed task needs your decision', recipients: ['manager'], m91Default: true, threshold: null },
  evidence_attribution_note: { label: 'Evidence attribution disputed', recipients: ['manager'], m91Default: false, threshold: null },
  assessment_disputed: { label: 'An employee disputes an analysis of their work', recipients: ['manager'], m91Default: true, threshold: null },
  impact_verification_needed: { label: 'A reported figure was linked to an outcome awaiting verification', recipients: ['manager'], m91Default: false, threshold: null }
}

export const DEFAULT_ALERT_SETTINGS = {
  m91Enabled: false,
  thresholds: { unassignedHours: 2, notStartedHours: 24, noProgressHours: 48, deadlineApproachingHours: 24, blockerUnresolvedHours: 24, noMovementHours: 24 },
  // Per rule: in-app always on; m91 per the default above.
  rules: Object.fromEntries(Object.entries(ALERT_RULES).map(([k, r]) => [k, { m91: r.m91Default }]))
}

export const THRESHOLD_LIMITS = { unassignedHours: [1, 168], notStartedHours: [1, 336], noProgressHours: [4, 336], deadlineApproachingHours: [1, 72], blockerUnresolvedHours: [1, 336], noMovementHours: [1, 336] }

import { dt } from '../ui.js'
import { app } from '../app.js'
import { renderWorkboard } from './workboard.js'
import { renderTeamOverview } from './overview.js'

// The home page: Team Overview for managers (overview.js), My Workspace (the board, workboard.js) for employees. The task-history wording below is shared with the task page.
export const renderDashboard = (main, q) => (app.isManager ? renderTeamOverview(main) : renderWorkboard(main, q))
export const EVENT_TEXT = {
  created: () => 'created the task',
  assigned: (d) => `assigned it to ${d.toName || 'someone'}`,
  reassigned: (d) => `reassigned it from ${d.fromName || 'nobody'} to ${d.toName || 'nobody'}${d.reason ? ` (${d.reason})` : ''}`,
  status_changed: (d) => `moved it ${d.from ? `from ${d.from.replace(/_/g, ' ').toLowerCase()} ` : ''}to ${String(d.to).replace(/_/g, ' ').toLowerCase()}${d.reason ? ` — ${d.reason}` : ''}`,
  reopened: (d) => `reopened it — ${d.reason}`,
  restored: (d) => `restored it — ${d.reason}`,
  progress: (d) => `updated progress to ${d.to}%${d.note ? ` — ${d.note}` : ''}`,
  comment: (d) => `commented: “${d.body}”`,
  deadline_changed: (d) => `changed the deadline${d.to ? ` to ${dt(d.to)}` : ' (removed)'}${d.reason ? ` — ${d.reason}` : ''}`,
  priority_changed: (d) => `${d.from ? `changed priority from ${d.from} to ${d.to}` : `set the priority to ${d.to}`}${d.reason ? ` — ${d.reason}` : ''}`,
  expectations_changed: (d) => `updated what is expected: ${(d.fields || []).join(', ').replace(/_/g, ' ')}${d.reason ? ` — ${d.reason}` : ''}`,
  change_requested: (d) => `asked for ${({ DEADLINE: 'a different deadline', PRIORITY: 'a different priority', SCOPE: 'a scope change', CLARIFICATION: 'clarification' })[d.kind] || 'a change'}${d.reason ? ` — ${d.reason}` : ''}`,
  change_decided: (d) => `${({ APPROVED: 'approved', REJECTED: 'did not approve', ANSWERED: 'answered' })[d.decision] || 'decided on'} a request for ${String(d.kind || 'change').toLowerCase()}${d.note ? ` — ${d.note}` : ''}`,
  edited: (d) => `edited ${d.fields.join(', ').replace(/_/g, ' ')}`,
  blocker_reported: (d) => `reported a blocker: ${d.description}${d.dependencyOwner ? ` (waiting on ${d.dependencyOwner})` : d.external ? ' (external)' : ''}`,
  blocker_resolved: (d) => `resolved a blocker: ${d.note}`,
  blocker_escalated: () => 'escalated a blocker',
  submitted_for_review: (d) => `submitted it for review: ${d.summary}`,
  review_decision: (d) => (d.decision === 'APPROVED' ? `approved the work${d.comment ? ` — ${d.comment}` : ''}` : `requested changes — ${d.comment}`),
  evidence_added: (d) => `added evidence: ${d.label}`,
  shared: (d) => `shared it to ${d.to}`,
  alert_response: (d) => `answered an alert: ${d.response}`,
  assignment_accepted: () => 'accepted the task',
  assignment_declined: (d) => `declined the task${d.reason ? ` — ${d.reason}` : ''}`,
  transfer_proposed: (d) => `offered the task to ${d.toName || 'a teammate'}${d.reason ? ` — ${d.reason}` : ''}`,
  transfer_accepted: (d) => `accepted the transfer from ${d.fromName || 'a teammate'}`,
  transfer_declined: (d) => `declined the transfer${d.reason ? ` — ${d.reason}` : ''}`,
  transfer_cancelled: (d) => `cancelled the transfer${d.note ? ` — ${d.note}` : ''}`,
  deadline_missed: (d) => `— the deadline of ${dt(d.dueAt)} passed without the task being done`,
  deadline_explained: (d) => `explained the missed deadline: ${d.reason || ''}`,
  deadline_context_added: () => 'added context to a missed-deadline explanation',
  deadline_explanation_reviewed: (d) => `reviewed a missed-deadline explanation: ${String(d.status || '').replace(/_/g, ' ').toLowerCase()}`
}
export const eventText = (e) => (EVENT_TEXT[e.type] ? EVENT_TEXT[e.type](e.data || {}) : e.type)

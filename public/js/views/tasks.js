import { api, html, raw, esc, modal, bindForm, toast, errorText, confirmDialog, ago, dt, statusBadge, prioBadge, conditionBadges, progressBar, empty, toLocalInput, fromLocalInput, STATUS_LABEL, icon, due, avatar, prov } from '../ui.js'
import { app } from '../app.js'
import { eventText } from './dashboard.js'
import { openContextBuilder } from './automations.js'
import { renderAssessmentCard } from './contribution.js'
import { renderTaskExternalEvidence } from './evidence.js'
import { renderExpectations } from './expectations.js'
import { renderInbox, workflowBanners, workflowActions, sourceCard, ownershipCard, deadlineCard } from './assignments.js'

let assignableCache = null
async function assignable() {
  assignableCache ||= api('/api/assignable')
  return assignableCache
}
let teamsCache = null
const teams = () => (teamsCache ||= api('/api/teams'))

// ---------- list ----------
/** One task as a card: what it is, why it matters, where it stands. Used by My Tasks and the overview. */
export function taskCard(t) {
  const sub = t.expectedOutcome || t.description || ''
  return html`<a class="task-card" href="#/tasks/${t.id}">
    <div class="row between nowrap" style="gap:8px">${statusBadge(t.status)}${prioBadge(t.priority)}</div>
    <div class="t">${t.title}</div>
    ${sub ? html`<div class="note" title="${sub}">${sub}</div>` : ''}
    <div class="foot">${progressBar(t.progress)}<span class="pct">${t.progress}%</span></div>
    <div class="meta">${due(t)}${t.status === 'BLOCKED' && t.blockedHours !== null ? html`<span class="due late">${icon('blocked', 'xs')}Blocked ${t.blockedHours}h</span>` : ''}${t.atRisk && !t.overdue ? html`<span class="badge warn">At risk</span>` : ''}${t.teamName ? html`<span>${t.teamName}</span>` : ''}${!t.dueAt && t.status !== 'BLOCKED' ? html`<span>No deadline</span>` : ''}</div>
  </a>`
}

export async function renderTaskList(main, { view, q }) {
  assignableCache = null
  teamsCache = null
  const isTeam = view === 'team'
  const params = new URLSearchParams({ view: isTeam ? 'team' : 'mine' })
  for (const k of ['status', 'priority', 'assigneeId', 'condition', 'q', 'sort', 'teamId']) if (q.get(k)) params.set(k, q.get(k))
  if (q.get('closed') === '1' || q.get('status')) params.set('includeClosed', 'true')
  const [tasks, people, teamList] = await Promise.all([api(`/api/tasks?${params}`), isTeam ? api('/api/members') : [], isTeam ? teams() : []])
  const base = isTeam ? '#/team-tasks' : '#/my-tasks'
  const sel = (name, opts, label) => html`<label class="sr" style="position:absolute;left:-999px" for="f-${name}">${label}</label><select id="f-${name}" name="${name}"><option value="">${label}</option>${opts.map(([v, l]) => html`<option value="${v}" ${q.get(name) === v ? raw('selected') : ''}>${l}</option>`)}</select>`
  const hasFilter = [...q.keys()].length > 0
  const TABS = [['', 'Open'], ['PENDING_ACCEPTANCE', 'Awaiting acceptance'], ['IN_PROGRESS', 'In progress'], ['BLOCKED', 'Blocked'], ['SUBMITTED_FOR_REVIEW', 'In review'], ['COMPLETED', 'Completed']]
  const tabHref = (v) => `${base}${v ? `?status=${v}` : ''}`
  const open = tasks.filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))
  const triage = (t) => !['PENDING_ACCEPTANCE', 'DECLINED'].includes(t.status)
  const groups = !isTeam && !q.get('status') && !q.get('q') ? [
    ['Awaiting your acceptance', 'inbox', 'warn', tasks.filter((t) => t.status === 'PENDING_ACCEPTANCE')],
    ['Needs attention', 'alert', 'warn', tasks.filter((t) => triage(t) && (t.overdue || t.status === 'BLOCKED' || t.atRisk))],
    ['In progress', 'trending', '', tasks.filter((t) => t.status === 'IN_PROGRESS' && !(t.overdue || t.atRisk))],
    ['Up next', 'clock', '', tasks.filter((t) => t.status === 'ASSIGNED' && !(t.overdue || t.atRisk))],
    ['Waiting for review', 'reviews', 'brand', tasks.filter((t) => t.status === 'SUBMITTED_FOR_REVIEW' && !(t.overdue || t.atRisk))],
    ['Declined — with your manager', 'x', '', tasks.filter((t) => t.status === 'DECLINED')],
    ['Completed', 'checkCircle', 'ok', tasks.filter((t) => t.status === 'COMPLETED')]
  ].filter(([, , , l]) => l.length) : null
  main.innerHTML = html`
    <div class="page-head"><div><div class="eyebrow">${icon(isTeam ? 'team' : 'tasks', 'xs')}${isTeam ? 'Team' : 'My work'}</div><h1>${isTeam ? 'Team tasks' : 'My tasks'}</h1><p>${isTeam ? 'Everything your teams are working on. Overdue and at-risk are calculated from deadlines and progress.' : 'What is assigned to you, most urgent first — and why it matters.'}</p></div>
      <div class="row">${app.session.integrations?.viasocket && (!isTeam || app.isManager) ? html`<button class="btn ghost" id="automate" title="${isTeam ? 'When a task in my team is completed…' : 'When a task is assigned to me…'}">${icon('apps')}Automate</button>` : ''}<button class="btn" id="new-task">${icon('plus')}${app.session.membership.creationMode === 'direct' ? 'New task' : 'Suggest a task'}</button></div></div>
    ${isTeam ? '' : html`<div id="inbox-slot"></div>`}
    <nav class="tabs" aria-label="Task status">${TABS.map(([v, l]) => html`<a href="${tabHref(v)}" ${(q.get('status') || '') === v && !q.get('condition') ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
    <form class="filters toolbar" id="filters" role="search">
      <div class="search-box">${icon('search', 'sm')}<input type="search" name="q" value="${q.get('q') || ''}" placeholder="Search title or description" aria-label="Search tasks"></div>
      ${sel('status', Object.entries(STATUS_LABEL).filter(([k]) => k !== 'SUGGESTED'), 'Any status')}
      ${sel('priority', [['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']], 'Any priority')}
      ${sel('condition', [['overdue', 'Overdue'], ['at_risk', 'At risk'], ...(isTeam ? [['unassigned', 'Unassigned']] : [])], 'Any condition')}
      ${isTeam ? sel('assigneeId', [['none', '(Unassigned)'], ...people.filter((p) => p.inScope).map((p) => [p.userId, p.name])], 'Anyone') : ''}
      ${isTeam && teamList.length > 1 ? sel('teamId', teamList.map((t) => [t.id, t.name]), 'Any team') : ''}
      ${sel('sort', [['due', 'Sort: due date'], ['priority', 'Sort: priority'], ['updated', 'Sort: recently updated'], ['created', 'Sort: newest'], ['title', 'Sort: title']], 'Sort: due date')}
      <label class="check small" style="margin:0"><input type="checkbox" name="closed" value="1" ${q.get('closed') === '1' ? raw('checked') : ''}> Show cancelled</label>
      <button class="btn ghost small" type="submit">Apply</button>
      ${hasFilter ? html`<a class="btn link small" href="${base}">Clear</a>` : ''}
    </form>
    ${!tasks.length ? (hasFilter ? empty('No tasks match', 'Try other filters, or clear them.', html`<a class="btn small ghost" href="${base}">Clear filters</a>`, 'search')
      : isTeam ? empty('No team tasks yet', 'Create a task and assign it, or approve a task request.', '', 'tasks') : empty('Nothing assigned to you', 'When someone assigns you a task it appears here. You can also suggest one, or connect your apps so the work you already do shows up.', html`<a class="btn small ghost" href="#/evidence">${icon('evidence')}My Work Evidence</a>`, 'tasks'))
    : isTeam ? html`<div class="table-wrap"><table class="task-table"><thead><tr><th>Task</th><th>Status</th><th class="hide-sm">Priority</th><th>Owner</th><th>Due</th><th class="hide-sm">Progress</th></tr></thead><tbody>
      ${tasks.map((t) => html`<tr class="clickable" data-href="#/tasks/${t.id}"><td><a href="#/tasks/${t.id}"><b>${t.title}</b></a><div class="meta" style="margin-top:3px">${conditionBadges(t)}${t.teamName ? html`<span>${t.teamName}</span>` : ''}</div></td>
        <td>${statusBadge(t.status)}${t.blockedHours !== null ? html`<div class="small muted" style="margin-top:3px">${t.blockedHours}h</div>` : ''}</td><td class="hide-sm">${prioBadge(t.priority)}</td>
        <td>${t.assigneeName ? html`<div class="row nowrap" style="gap:8px">${avatar(t.assigneeName, null, 'sm')}<span>${t.assigneeName}</span></div>` : html`<span class="badge warn">Unassigned</span>`}</td>
        <td class="nowrap">${due(t) || html`<span class="muted">—</span>`}</td><td class="hide-sm" style="width:120px">${progressBar(t.progress)}<div class="small muted" style="margin-top:3px">${t.progress}%</div></td></tr>`)}
    </tbody></table></div>`
    : groups ? html`${groups.map(([title, ic, tone, list]) => html`<section class="task-group"><h2 class="group-title"><span class="card-icon ${tone}">${icon(ic)}</span>${title}<span class="badge outline">${list.length}</span></h2><div class="task-cards">${list.map(taskCard)}</div></section>`)}`
    : html`<div class="task-cards">${tasks.map(taskCard)}</div>`}
    ${tasks.length && !isTeam && !open.length && !hasFilter ? '' : ''}`
  document.getElementById('new-task').addEventListener('click', () => openTaskForm())
  if (!isTeam) renderInbox(document.getElementById('inbox-slot'))
  document.getElementById('automate')?.addEventListener('click', () => openContextBuilder(isTeam ? 'task_completed_in_my_team' : 'task_assigned_to_me'))
  document.getElementById('filters').addEventListener('submit', (e) => {
    e.preventDefault()
    const p = new URLSearchParams()
    for (const el of e.target.elements) if (el.name && (el.type === 'checkbox' ? el.checked : el.value)) p.set(el.name, el.value)
    location.hash = `${base}${p.toString() ? `?${p}` : ''}`
  })
  document.querySelectorAll('#filters select').forEach((s) => s.addEventListener('change', () => document.getElementById('filters').requestSubmit()))
}

// ---------- create / edit ----------
export async function openTaskForm(existing = null, { defaultTeamId = null, defaultAssigneeId = null, onCreated = null } = {}) {
  const mode = existing ? 'edit' : app.session.membership.creationMode
  const [people, teamList] = await Promise.all([assignable().catch(() => []), teams().catch(() => [])])
  const myTeams = app.isAdmin ? teamList : app.role === 'manager' ? teamList.filter((t) => t.managedByMe) : teamList.filter((t) => t.id === app.session.membership.teamId)
  const isRequest = mode === 'request'
  const t = existing || {}
  // Pre-fill from context (e.g. opened from a team view).
  const preTeam = t.teamId || defaultTeamId || (myTeams.length === 1 ? myTeams[0].id : null)
  const preAssignee = t.assigneeId || defaultAssigneeId

  // When editing, show all fields; when creating, use progressive disclosure.
  const moreOpen = existing || Boolean(t.expectedOutcome || t.priority || t.dueAt || (myTeams.length > 1 && preTeam) || preAssignee)

  // Managers define what is expected; an employee creating directly only proposes priority and deadline.
  const proposing = !existing && !isRequest && !app.isManager
  const view = existing && app.isManager ? await api(`/api/tasks/${existing.id}/parameters`).catch(() => null) : null
  const ex = view ? { complexityExpectation: view.complexityExpectation.value, workType: view.workType.value, businessImpact: view.businessImpact.value, dependencies: view.dependencies.value, successCriteria: view.successCriteria.value, context: view.context.value } : {}
  const COMPLEXITY = [['NOT_ASSESSED', 'Not assessed'], ['L1', 'L1: simple, routine work'], ['L2', 'L2: some judgement or coordination'], ['L3', 'L3: complex, several moving parts'], ['L4', 'L4: very complex or high-risk']]
  const managerFields = isRequest || proposing ? '' : html`
    <div class="fields">
      <div class="field"><label for="t-cx">Complexity expected</label><select id="t-cx" name="complexityExpectation" data-testid="f-complexity">${COMPLEXITY.map(([v, l]) => html`<option value="${v}" ${(ex.complexityExpectation || 'NOT_ASSESSED') === v ? raw('selected') : ''}>${l}</option>`)}</select>
        <div class="hint">Your expectation before the work starts. The analysis of the actual work is separate.</div></div>
      <div class="field"><label for="t-wt">Work type <span class="field-hint">optional</span></label><input id="t-wt" name="workType" type="text" maxlength="40" value="${ex.workType || ''}" placeholder="e.g. Incident, Feature, Research" data-testid="f-worktype"></div>
    </div>
    <div class="field"><label for="t-imp">Business impact <span class="field-hint">optional</span></label><textarea id="t-imp" name="businessImpact" maxlength="2000" rows="2" placeholder="Who or what is affected if this is done, late or not done?" data-testid="f-impact">${ex.businessImpact || ''}</textarea></div>
    <div class="field"><label for="t-dep">Dependencies <span class="field-hint">optional</span></label><textarea id="t-dep" name="dependencies" maxlength="2000" rows="2" placeholder="People, systems or decisions this relies on">${ex.dependencies || ''}</textarea></div>
    <div class="field"><label for="t-sc">Success criteria <span class="field-hint">optional</span></label><textarea id="t-sc" name="successCriteria" maxlength="3000" rows="2" placeholder="How will you know it is done well?" data-testid="f-criteria">${ex.successCriteria || ''}</textarea></div>
    <div class="field"><label for="t-ctx">Supporting context <span class="field-hint">optional</span></label><textarea id="t-ctx" name="context" maxlength="4000" rows="2" placeholder="Background, links to discussions, constraints">${ex.context || ''}</textarea></div>`

  const detailFields = html`
    <div class="field"><label for="t-out">${isRequest ? 'What outcome do you expect?' : 'Expected outcome'} <span class="field-hint">optional</span></label><textarea id="t-out" name="expectedOutcome" maxlength="2000" rows="2" placeholder="What will be different when this is done? This helps the team assess impact later.">${t.expectedOutcome || ''}</textarea></div>
    <div class="fields">
      <div class="field"><label for="t-prio">${isRequest ? 'Suggested priority' : proposing ? 'Proposed priority' : 'Priority'}</label><select id="t-prio" name="priority" data-testid="f-priority">${t.priority ? '' : html`<option value="" selected>${isRequest ? 'No suggestion' : proposing ? 'No proposal' : 'Not decided yet'}</option>`}${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => html`<option value="${p}" ${t.priority === p ? raw('selected') : ''}>${p[0] + p.slice(1).toLowerCase()}</option>`)}</select>
        <div class="hint" id="t-prio-hint">${t.priority ? 'Changes are kept in the task history with your reason.' : proposing || isRequest ? 'A manager confirms the priority; nothing is official until then.' : 'Left empty, the priority stays unresolved until you confirm it. Nothing is assumed.'}</div></div>
      <div class="field"><label for="t-due">${isRequest ? 'Suggested deadline' : proposing ? 'Proposed deadline' : 'Deadline'} <span class="field-hint">optional</span></label><input id="t-due" name="dueAt" type="datetime-local" value="${toLocalInput(t.dueAt)}" data-testid="f-deadline"><div class="hint" id="t-due-hint">${proposing ? 'A manager confirms the deadline; until then it is not used for overdue alerts.' : 'Leave empty if there is no confirmed deadline yet.'}</div></div>
      ${isRequest ? '' : html`<div class="field"><label for="t-start">Start date <span class="field-hint">optional</span></label><input id="t-start" name="startDate" type="date" value="${t.startDate || ''}"></div>`}
      ${myTeams.length > 1 ? html`<div class="field"><label for="t-team">Team</label><select id="t-team" name="teamId"><option value="">(default)</option>${myTeams.map((x) => html`<option value="${x.id}" ${preTeam === x.id ? raw('selected') : ''}>${x.name}</option>`)}</select></div>` : (myTeams.length === 1 ? html`<input type="hidden" name="teamId" value="${myTeams[0].id}">` : '')}
      ${!existing ? html`<div class="field"><label for="t-assignee">${isRequest ? 'Suggested owner' : 'Assign to'} <span class="field-hint">optional</span></label><select id="t-assignee" name="assigneeId"><option value="">${isRequest ? '(let the manager decide)' : '(unassigned)'}</option>
        ${(isRequest ? [] : people).map((p) => html`<option value="${p.userId}" ${preAssignee === p.userId ? raw('selected') : ''}>${p.name}${p.userId === app.me.id ? ' (me)' : ''}</option>`)}</select>
        ${!isRequest && !people.length ? html`<div class="hint">You do not have permission to assign tasks.</div>` : ''}</div>` : ''}
    </div>
    ${managerFields}
    ${isRequest ? '' : html`<div class="field"><label for="t-links">Supporting links <span class="field-hint">optional</span></label><textarea id="t-links" name="links" rows="2" placeholder="One link per line (https://…)">${(t.links || []).map((l) => l.url).join('\n')}</textarea></div>`}
    ${existing ? html`<div class="field"><label for="t-reason2">Reason for this change <span class="field-hint">kept in history</span></label><input id="t-reason2" name="reason" type="text" maxlength="500" placeholder="e.g. scope clarified, deadline moved"></div>` : ''}`

  const content = html`<h2 id="modal-title">${existing ? 'Edit task' : isRequest ? 'Suggest a task' : 'New task'}</h2>
    ${isRequest ? html`<div class="notice">Your manager approves suggestions before they become official tasks.</div>` : ''}
    ${proposing ? html`<div class="notice" data-testid="proposal-note">You can create this task yourself. The priority and deadline you enter are a proposal until a manager confirms them.</div>` : ''}
    <form id="task-form"><div class="form-error"></div>
      <div class="field"><label for="t-title">Title</label><input id="t-title" name="title" type="text" required maxlength="200" value="${t.title || ''}" placeholder="What needs to get done?" autocomplete="off"></div>
      <div class="field"><label for="t-desc">Description <span class="field-hint">optional</span></label><textarea id="t-desc" name="description" maxlength="5000" rows="3" placeholder="More context — the problem, background, or approach.">${t.description || ''}</textarea></div>
      ${isRequest ? html`<div class="field"><label for="t-reason">Why is this needed?</label><textarea id="t-reason" name="reason" required maxlength="2000" rows="2" placeholder="What problem does this solve? Why now?"></textarea></div>` : ''}
      ${existing
        ? detailFields
        : html`<details class="task-more" id="task-more" ${moreOpen ? raw('open') : ''}><summary>${icon('chevronDown', 'xs')}<span>More options</span></summary><div class="task-more-body">${raw(detailFields)}</div></details>`}
      <div class="row end" style="margin-top:4px"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">${existing ? 'Save changes' : isRequest ? 'Send suggestion' : 'Create task'}</button></div>
    </form>`
  return modal(content.toString(), (el, close) => {
    // The suggested-owner list for requests comes from all members (a suggestion grants nothing).
    if (isRequest) api('/api/members').then((ms) => { const s = el.querySelector('#t-assignee'); if (s) ms.forEach((m) => s.insertAdjacentHTML('beforeend', `<option value="${esc(m.userId)}">${esc(m.name)}</option>`)) }).catch(() => {})
    // Enter on title opens More options and focuses description instead of submitting (unless description filled).
    const titleEl = el.querySelector('#t-title')
    titleEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const details = el.querySelector('#task-more')
        if (details && !details.open) { e.preventDefault(); details.open = true; el.querySelector('#t-desc')?.focus() }
      }
    })
    // Inline checks while typing; the server still validates everything.
    const mark = (input, msg) => { if (!input) return; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); const h = el.querySelector(`#${input.id}-hint`); if (h && msg) { h.dataset.keep ||= h.textContent; h.textContent = msg; h.classList.add('err-text') } else if (h?.dataset.keep) { h.textContent = h.dataset.keep; h.classList.remove('err-text') } }
    el.querySelector('#t-title')?.addEventListener('input', (e) => { e.target.setAttribute('aria-invalid', e.target.value.trim() ? 'false' : 'true') })
    el.querySelector('#t-due')?.addEventListener('input', (e) => mark(e.target, e.target.value && Date.parse(e.target.value) < Date.now() ? 'This deadline is already in the past.' : ''))
    bindForm(el.querySelector('#task-form'), async (d) => {
      const body = { ...d, dueAt: d.dueAt ? fromLocalInput(d.dueAt) : (existing ? null : undefined) }
      // An empty priority sends nothing: it never becomes Medium and never clears a confirmed one.
      if (!d.priority) delete body.priority
      if (existing) for (const k of ['businessImpact', 'dependencies', 'successCriteria', 'context', 'workType']) if (view && !d[k]) body[k] = null
      if ('links' in d || existing) body.links = (d.links || '').split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ url }))
      if (existing) {
        if (!d.startDate) body.startDate = null
        if (!d.description) body.description = null
        if (!d.expectedOutcome) body.expectedOutcome = null
        return api(`/api/tasks/${existing.id}`, { method: 'PATCH', body })
      }
      if (isRequest) {
        return api('/api/requests', { method: 'POST', body: { title: d.title, description: d.description, reason: d.reason, expectedOutcome: d.expectedOutcome, suggestedPriority: d.priority, suggestedDueAt: body.dueAt, suggestedAssigneeId: d.assigneeId, teamId: d.teamId } })
      }
      return api('/api/tasks', { method: 'POST', body })
    }, {
      onSuccess: (out) => {
        close(out)
        if (existing) { toast('Task updated.'); window.dispatchEvent(new HashChangeEvent('hashchange')); return }
        if (isRequest || out.mode === 'request') { toast('Suggestion sent for approval.'); location.hash = '#/requests'; return }
        toast('Task created.')
        if (onCreated) { onCreated(out.task); return } // the caller (the workboard) stays where it is and refreshes itself
        location.hash = `#/tasks/${out.task.id}`
      }
    })
  })
}

// ---------- detail ----------
export async function renderTaskDetail(main, id) {
  assignableCache = null
  const [d, wf] = await Promise.all([api(`/api/tasks/${id}`), api(`/api/tasks/${id}/workflow`)])
  const t = d.task
  const a = d.allowed
  const openBlockers = d.blockers.filter((b) => b.status === 'OPEN')
  const primary = [
    a.accept && html`<button class="btn" data-act="accept">${icon('check')}Accept</button>`,
    a.decline && html`<button class="btn ghost" data-act="decline">Decline</button>`,
    a.transfer && html`<button class="btn ghost" data-act="transfer">${icon('team')}Transfer task</button>`,
    a.start && html`<button class="btn" data-act="start">${icon('arrowRight')}Start work</button>`,
    a.submit && html`<button class="btn" data-act="submit">${icon('send')}Submit for review</button>`,
    a.review && html`<button class="btn" data-act="review">${icon('reviews')}Review submission</button>`,
    a.progress && html`<button class="btn ghost" data-act="progress">${icon('trending')}Update progress</button>`,
    a.block && html`<button class="btn ghost" data-act="block">${icon('blocked')}Report blocker</button>`
  ].filter(Boolean)
  const more = [
    a.assign && html`<button class="menu-item" data-act="assign">${icon('team', 'sm')}${t.assigneeId ? 'Reassign' : 'Assign'}</button>`,
    a.edit && !['COMPLETED', 'CANCELLED'].includes(t.status) && html`<button class="menu-item" data-act="edit">${icon('requests', 'sm')}Edit task</button>`,
    a.reopen && html`<button class="menu-item" data-act="reopen">${icon('refresh', 'sm')}Reopen</button>`,
    a.restore && html`<button class="menu-item" data-act="restore">${icon('refresh', 'sm')}Restore</button>`,
    a.cancel && html`<button class="menu-item" data-act="cancel">${icon('x', 'sm')}Cancel task</button>`,
    a.delete && html`<button class="menu-item danger" data-act="delete">${icon('x', 'sm')}Delete…</button>`
  ].filter(Boolean)
  const lastReview = d.submissions.flatMap((x) => x.reviews).at(-1)
  const changesAsked = lastReview && lastReview.decision !== 'APPROVED' && t.status !== 'COMPLETED'
  const person = (name, label) => name ? html`<div class="row nowrap" style="gap:8px">${avatar(name, null, 'sm')}<span>${name}</span></div>` : html`<span class="badge warn">${label}</span>`
  main.innerHTML = html`
    <div class="crumbs"><a href="${t.isMine ? '#/my-tasks' : '#/team-tasks'}">${t.isMine ? 'My tasks' : 'Team tasks'}</a>${icon('chevronRight', 'xs')}<span>${t.title.length > 48 ? `${t.title.slice(0, 48)}…` : t.title}</span></div>
    <header class="task-head"><div class="grow"><h1>${t.title}</h1>
      <div class="row" style="margin-top:10px">${statusBadge(t.status)} ${prioBadge(t.priority)} ${due(t)} ${conditionBadges(t)} ${t.teamName ? html`<span class="badge outline">${t.teamName}</span>` : ''}</div></div>
      <div class="task-actions">${primary}${more.length ? html`<details class="more-menu"><summary class="btn ghost" aria-label="More actions">${icon('more')}</summary><div class="menu inline">${more}</div></details>` : ''}</div></header>
    ${workflowBanners(wf, t, a)}
    ${openBlockers.length ? html`<div class="banner bad" role="status"><span class="lead-icon bad">${icon('blocked')}</span><div><b>Blocked for ${t.blockedHours}h</b><div>${openBlockers.map((b) => b.description).join(' · ')}</div><div class="small muted">A blocked task is never counted against the person doing it.</div></div></div>` : ''}
    ${changesAsked ? html`<div class="banner warn" role="status"><span class="lead-icon warn">${icon('alert')}</span><div><b>${lastReview.reviewer} asked for changes</b><div>${lastReview.comment || 'See the review below.'}</div></div></div>` : ''}
    ${t.status === 'SUBMITTED_FOR_REVIEW' ? html`<div class="banner brand" role="status"><span class="lead-icon brand">${icon('reviews')}</span><div><b>Waiting for review</b><div>Submitted ${ago(t.submittedAt)}. It is not complete until a manager approves it.</div></div></div>` : ''}
    <div class="grid side">
      <div class="stack">
        <section class="card" aria-labelledby="ov-h"><div class="card-head"><h2 id="ov-h"><span class="card-icon">${icon('note')}</span>What this is about</h2></div>
          ${t.description ? html`<p class="pre" style="margin-bottom:14px">${t.description}</p>` : html`<p class="muted" style="margin-bottom:14px">No description was added.</p>`}
          <div class="outcome-box"><div class="small muted">Expected outcome</div><div class="pre">${t.expectedOutcome || html`<span class="muted">Not stated — worth agreeing before you start.</span>`}</div></div>
          ${t.links.length ? html`<div class="chips" style="margin-top:12px">${t.links.map((l) => html`<a class="chip" href="${l.url}" target="_blank" rel="noopener noreferrer">${icon('evidence', 'xs')} ${l.label || l.url}</a>`)}</div>` : ''}
          ${t.sourceRequestId ? html`<p class="small muted" style="margin:12px 0 0">Created from <a href="#/requests">an approved suggestion</a>.</p>` : ''}
        </section>
        ${sourceCard(wf)}
        <section class="card facts" aria-labelledby="facts-h"><h2 id="facts-h" class="sr">Details</h2>
          <dl class="fact-grid">
            <div><dt>Owner</dt><dd>${person(t.assigneeName, 'Unassigned')}</dd></div>
            <div><dt>Due</dt><dd>${t.dueAt ? html`${dt(t.dueAt)}` : '—'}</dd></div>
            <div><dt>Progress</dt><dd><div class="row nowrap" style="gap:10px"><div style="flex:1;min-width:70px">${progressBar(t.progress)}</div><b>${t.progress}%</b></div>${t.lastProgressAt ? html`<div class="small muted">updated ${ago(t.lastProgressAt)}</div>` : ''}</dd></div>
            <div><dt>Created by</dt><dd>${t.createdByName}<div class="small muted">${dt(t.createdAt)}</div></dd></div>
            ${t.startDate ? html`<div><dt>Start date</dt><dd>${t.startDate}</dd></div>` : ''}
          </dl></section>
        ${d.submissions.length ? html`<section class="card" aria-labelledby="sub-h"><div class="card-head"><h2 id="sub-h"><span class="card-icon brand">${icon('reviews')}</span>Submission and review</h2>${prov('self', 'The employee’s account')}</div>
          ${d.submissions.map((s) => html`<div class="submission">
            <div class="row between"><b>${s.submittedBy} · ${dt(s.createdAt)}</b><span class="badge ${s.status === 'APPROVED' ? 'ok' : s.status === 'PENDING' ? 'info' : 'warn'}">${s.status.replace(/_/g, ' ').toLowerCase()}</span></div>
            <dl class="kv" style="margin-top:8px"><dt>Work summary</dt><dd class="pre">${s.summary}</dd><dt>Outcome achieved</dt><dd class="pre">${s.outcome}</dd>
            ${s.evidence.length ? html`<dt>Evidence</dt><dd>${s.evidence.map((e) => html`<div><a href="${e.url}" ${e.kind === 'link' ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${e.label || e.fileName || e.url}</a></div>`)}</dd>` : ''}</dl>
            ${s.reviews.map((r) => html`<div class="notice ${r.decision === 'APPROVED' ? 'ok' : 'warn'}" style="margin:10px 0 0"><b>${r.reviewer}</b> ${r.decision === 'APPROVED' ? 'approved' : 'requested changes'} ${ago(r.createdAt)}${r.comment ? html`: “${r.comment}”` : ''}</div>`)}
          </div>`)}
          ${t.status === 'COMPLETED' ? html`<div class="card-foot"><span class="muted">Completion is not the same as impact.</span>${t.isMine ? html`<a class="btn small ghost" href="#/impact?new=1&taskId=${t.id}">${icon('award')}Record the outcome</a>` : ''}</div>` : ''}
        </section>` : ''}
        ${deadlineCard(wf, t)}
        ${t.assigneeId ? html`<section class="card" id="ai-card" aria-live="polite">${raw('<div class="loading">Loading the contribution analysis…</div>')}</section>` : ''}
        <section class="card" id="exp-card" data-testid="expectations" aria-live="polite"><div class="loading">Loading what is expected…</div></section>
        <section class="card" aria-labelledby="act-h"><div class="card-head"><h2 id="act-h"><span class="card-icon">${icon('message')}</span>Activity and comments</h2>${prov('fact', 'Recorded history')}</div>
          <form id="comment" class="comment-form"><label for="c-body" class="sr">Comment</label><textarea id="c-body" name="body" rows="2" required maxlength="4000" placeholder="Write a comment…"></textarea><button class="btn" type="submit">Comment</button></form>
          <ul class="timeline" style="margin-top:16px">${[...d.events].reverse().map((e) => html`<li><div><b>${e.actorName || 'System'}</b> ${eventText(e)}</div><div class="when">${dt(e.createdAt)}</div></li>`)}</ul>
        </section>
      </div>
      <div class="stack">
        ${ownershipCard(wf)}
        <section class="card" aria-labelledby="blk-h"><div class="card-head"><h2 id="blk-h"><span class="card-icon ${openBlockers.length ? 'bad' : ''}">${icon('blocked')}</span>Blockers</h2>${a.block ? html`<button class="btn small ghost" data-act="block">Report</button>` : ''}</div>
          ${d.blockers.length ? html`<ul class="list">${d.blockers.map((b) => html`<li><div class="grow">
            <div class="row"><span class="badge ${b.status === 'OPEN' ? 'bad' : 'ok'}">${b.status === 'OPEN' ? `Open ${b.hoursOpen}h` : 'Resolved'}</span>${b.escalatedAt ? html`<span class="badge warn">Escalated</span>` : ''}${b.isExternal ? html`<span class="badge info">Outside their control</span>` : ''}</div>
            <div style="margin-top:6px">${b.description}</div>
            <div class="small muted">${b.reportedBy} · ${ago(b.reportedAt)}${b.dependencyOwnerName ? ` · waiting on ${b.dependencyOwnerName}` : ''}${b.dependencyNote ? ` · ${b.dependencyNote}` : ''}</div>
            ${b.resolutionNote ? html`<div class="small" style="margin-top:4px">Resolved by ${b.resolvedBy}: ${b.resolutionNote}</div>` : ''}
            ${b.status === 'OPEN' ? html`<div class="row" style="margin-top:8px"><button class="btn small ghost" data-resolve="${b.id}">Resolve</button>${!b.escalatedAt ? html`<button class="btn small ghost" data-escalate="${b.id}">Escalate</button>` : ''}</div>` : ''}
          </div></li>`)}</ul>` : html`<p class="muted small" style="margin:0">No blockers reported.</p>`}
        </section>
        <section class="card" aria-labelledby="att-h"><div class="card-head"><h2 id="att-h"><span class="card-icon">${icon('evidence')}</span>Evidence and attachments</h2></div>
          ${d.evidence.length ? html`<ul class="list">${d.evidence.map((e) => html`<li><span class="lead-icon">${icon(e.kind === 'file' ? 'note' : 'evidence')}</span><div class="grow"><a href="${e.url}" ${e.kind === 'link' ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${e.label || e.fileName || e.url}</a><div class="small muted">${e.kind === 'file' ? `${Math.ceil(e.sizeBytes / 1024)} KB · ` : ''}${e.createdBy} · ${ago(e.createdAt)}</div></div>
            ${e.createdBy === app.me.name ? html`<button class="btn small link" data-del-evidence="${e.id}" aria-label="Remove ${e.label || e.fileName || 'evidence'}">Remove</button>` : ''}</li>`)}</ul>` : html`<p class="muted small" style="margin:0">Nothing attached yet.</p>`}
          ${t.isMine || t.canManage ? html`<div class="row" style="margin-top:12px"><button class="btn small ghost" data-act="add-link">${icon('plus')}Add link</button><label class="btn small ghost" style="margin:0">${icon('plus')}Upload file<input type="file" id="ev-file" hidden accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.zip,.docx,.xlsx,.pptx"></label></div><div class="hint">Files are private to people who can see this task. Max 5 MB.</div>` : ''}
        </section>
        <section class="card" id="ext-evidence"></section>
        ${d.impact.length ? html`<section class="card"><div class="card-head"><h2><span class="card-icon ok">${icon('award')}</span>Recorded impact</h2></div><ul class="list">${d.impact.map((r) => html`<li><a href="#/impact/${r.id}">${r.title}</a></li>`)}</ul></section>` : ''}
        <section class="card"><div class="card-head"><h2><span class="card-icon">${icon('send')}</span>Share</h2></div><p class="small muted">Post this task to a Slack channel through your own connected Slack (viaSocket).</p><button class="btn small ghost" data-act="share">Share to Slack</button></section>
      </div>
    </div>`

  const aiCard = main.querySelector('#ai-card')
  if (aiCard) renderAssessmentCard(aiCard, id)
  const expCard = main.querySelector('#exp-card')
  if (expCard) renderExpectations(expCard, t, () => renderTaskDetail(main, id).catch((e) => toast(errorText(e), { error: true })))
  const ext = main.querySelector('#ext-evidence')
  if (ext) renderTaskExternalEvidence(ext, id)
  const reload = () => renderTaskDetail(main, id).catch((e) => toast(errorText(e), { error: true }))
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); app.refreshCounts(); reload() } catch (e) { toast(errorText(e), { error: true }) } }
  bindForm(main.querySelector('#comment'), (b) => api(`/api/tasks/${id}/comments`, { method: 'POST', body: b }), { onSuccess: reload })
  main.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    const r = await confirmDialog({ title: 'Resolve blocker', body: 'What resolved it? This is kept in the task history.', confirm: 'Resolve', reason: { label: 'Resolution note', required: true } })
    if (r?.ok) run(() => api(`/api/blockers/${b.dataset.resolve}/resolve`, { method: 'POST', body: { resolutionNote: r.reason } }), 'Blocker resolved.')
  }))
  main.querySelectorAll('[data-escalate]').forEach((b) => b.addEventListener('click', () => run(() => api(`/api/blockers/${b.dataset.escalate}/escalate`, { method: 'POST' }), 'Escalated to the manager.')))
  main.querySelectorAll('[data-del-evidence]').forEach((b) => b.addEventListener('click', async () => {
    const r = await confirmDialog({ title: 'Remove evidence?', body: 'The link or file is removed from this task.', confirm: 'Remove', danger: true })
    if (r?.ok) run(() => api(`/api/evidence/${b.dataset.delEvidence}`, { method: 'DELETE' }), 'Removed.')
  }))
  main.querySelector('#ev-file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]
    if (!f) return
    if (f.size > 5 * 1024 * 1024) { toast('Files can be at most 5 MB.', { error: true }); return }
    run(() => api(`/api/evidence/task/${id}/files`, { method: 'POST', rawBody: f, headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) } }), 'File uploaded.')
  })

  const ACTIONS = {
    start: () => run(() => api(`/api/tasks/${id}/status`, { method: 'POST', body: { status: 'IN_PROGRESS' } }), 'Started.'),
    edit: async () => { await openTaskForm(t); reload() },
    progress: () => modal(html`<h2 id="modal-title">Update progress</h2><form id="f"><div class="form-error"></div>
        <div class="field"><label for="p-val">Progress: <output id="p-out">${t.progress}</output>%</label><input id="p-val" name="progress" type="range" min="0" max="100" step="5" value="${t.progress}" style="width:100%"></div>
        <div class="field"><label for="p-note">What moved forward?</label><textarea id="p-note" name="note" maxlength="2000" placeholder="Describe what changed — specific actions taken, files touched, decisions made, blockers resolved."></textarea></div>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`.toString(), (el, close) => {
      el.querySelector('#p-val').addEventListener('input', (e) => { el.querySelector('#p-out').textContent = e.target.value })
      bindForm(el.querySelector('#f'), (b) => api(`/api/tasks/${id}/progress`, { method: 'POST', body: { ...b, progress: Number(b.progress) } }), { onSuccess: () => { close(); toast('Progress updated.'); reload() } })
    }),
    block: async () => {
      const people = await api('/api/members').catch(() => [])
      modal(html`<h2 id="modal-title">Report a blocker</h2><form id="f"><div class="form-error"></div>
        <div class="field"><label for="b-d">What is blocking you?</label><textarea id="b-d" name="description" required maxlength="2000"></textarea></div>
        <div class="field"><label for="b-o">Waiting on (optional)</label><select id="b-o" name="dependencyOwnerId"><option value="">(nobody in the organization)</option>${people.filter((p) => p.userId !== app.me.id).map((p) => html`<option value="${p.userId}">${p.name}</option>`)}</select></div>
        <div class="field"><label for="b-n">Dependency (optional)</label><input id="b-n" name="dependencyNote" type="text" maxlength="500" placeholder="e.g. Vendor API access, design sign-off"></div>
        <label class="check"><input type="checkbox" name="isExternal"> This is an external dependency (outside the team)</label>
        <p class="small muted">Blocked time is recorded and is not counted against you.</p>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Report blocker</button></div></form>`.toString(), (el, close) => {
        bindForm(el.querySelector('#f'), (b) => api(`/api/tasks/${id}/blockers`, { method: 'POST', body: b }), { onSuccess: () => { close(); toast('Blocker reported. Your manager has been told.'); reload() } })
      })
    },
    submit: () => modal(html`<h2 id="modal-title">Submit for review</h2><form id="f"><div class="form-error"></div>
        <div class="field"><label for="s-s">What did you accomplish?</label><textarea id="s-s" name="summary" required maxlength="4000" placeholder="Describe the work: what you built, changed, fixed, or delivered. Link evidence (PRs, docs, demos) below."></textarea></div>
        <div class="field"><label for="s-o">What changed because of this work?</label><textarea id="s-o" name="outcome" required maxlength="4000" placeholder="What is different now? Compare with the expected outcome: ${t.expectedOutcome || '—'}"></textarea></div>
        <div class="field"><label for="s-l">Evidence links</label><textarea id="s-l" name="links" rows="2" placeholder="One link per line (PR, doc, dashboard…)"></textarea><div class="hint">You can also upload files on the task page.</div></div>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Submit</button></div></form>`.toString(), (el, close) => {
      bindForm(el.querySelector('#f'), (b) => api(`/api/tasks/${id}/submit`, { method: 'POST', body: { summary: b.summary, outcome: b.outcome, evidenceLinks: (b.links || '').split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ url })) } }),
        { onSuccess: () => { close(); toast('Submitted. Your manager will review it.'); reload() } })
    }),
    review: () => {
      const s = d.submissions.find((x) => x.status === 'PENDING')
      modal(html`<h2 id="modal-title">Review submission</h2>
        <dl class="kv"><dt>Work summary</dt><dd class="pre">${s?.summary}</dd><dt>Outcome</dt><dd class="pre">${s?.outcome}</dd><dt>Expected</dt><dd class="pre">${t.expectedOutcome || '—'}</dd></dl>
        <form id="f" style="margin-top:12px"><div class="form-error"></div>
        <div class="field"><label for="r-c">Review comment</label><textarea id="r-c" name="comment" maxlength="4000" placeholder="Required when requesting changes"></textarea></div>
        <p class="small muted">Approving completes the task. It does not verify any claimed business impact — that is reviewed separately.</p>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn ghost" type="submit" name="decision" value="CHANGES_REQUESTED">Request changes</button><button class="btn" type="submit" name="decision" value="APPROVED">Approve</button></div></form>`.toString(), (el, close) => {
        const f = el.querySelector('#f')
        f.addEventListener('submit', async (e) => {
          e.preventDefault()
          const decision = e.submitter?.value
          try { await api(`/api/tasks/${id}/review`, { method: 'POST', body: { decision, comment: f.comment.value.trim() || undefined } }); close(); toast(decision === 'APPROVED' ? 'Approved — task completed.' : 'Changes requested.'); reload(); app.refreshCounts() } catch (err) { f.querySelector('.form-error').innerHTML = html`<div class="notice err">${errorText(err)}</div>`.toString() }
        })
      })
    },
    assign: async () => {
      const people = await assignable()
      modal(html`<h2 id="modal-title">${t.assigneeId ? 'Reassign task' : 'Assign task'}</h2><form id="f"><div class="form-error"></div>
        <div class="field"><label for="a-p">Owner</label><select id="a-p" name="assigneeId"><option value="">(unassigned)</option>${people.map((p) => html`<option value="${p.userId}" ${p.userId === t.assigneeId ? raw('selected') : ''}>${p.name}</option>`)}</select></div>
        <div class="field"><label for="a-r">Reason (optional)</label><input id="a-r" name="reason" type="text" maxlength="500"></div>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`.toString(), (el, close) => {
        bindForm(el.querySelector('#f'), (b) => api(`/api/tasks/${id}/assign`, { method: 'POST', body: { assigneeId: b.assigneeId || null, reason: b.reason } }), { onSuccess: () => { close(); toast('Assignment saved.'); reload() } })
      })
    },
    cancel: async () => { const r = await confirmDialog({ title: 'Cancel this task?', body: 'It leaves active lists. You can restore it later.', confirm: 'Cancel task', danger: true, reason: { label: 'Reason', required: true } }); if (r?.ok) run(() => api(`/api/tasks/${id}/status`, { method: 'POST', body: { status: 'CANCELLED', reason: r.reason } }), 'Task cancelled.') },
    reopen: async () => { const r = await confirmDialog({ title: 'Reopen this task?', body: 'It goes back to In progress for its owner. The reopening is recorded.', confirm: 'Reopen', reason: { label: 'Why is it reopened?', required: true } }); if (r?.ok) run(() => api(`/api/tasks/${id}/status`, { method: 'POST', body: { status: 'IN_PROGRESS', reason: r.reason } }), 'Reopened.') },
    restore: async () => { const r = await confirmDialog({ title: 'Restore this task?', body: 'It becomes an active, assigned task again.', confirm: 'Restore', reason: { label: 'Reason', required: true } }); if (r?.ok) run(() => api(`/api/tasks/${id}/status`, { method: 'POST', body: { status: 'ASSIGNED', reason: r.reason } }), 'Restored.') },
    delete: async () => { const r = await confirmDialog({ title: 'Delete this task permanently?', body: 'This cannot be undone. Tasks with completed work or impact cannot be deleted — cancel them instead.', confirm: 'Delete', danger: true }); if (r?.ok) { try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); toast('Deleted.'); location.hash = '#/team-tasks' } catch (e) { toast(errorText(e), { error: true }) } } },
    'add-link': () => modal(html`<h2 id="modal-title">Add evidence link</h2><form id="f"><div class="form-error"></div>
        <div class="field"><label for="l-u">Link</label><input id="l-u" name="url" type="url" required placeholder="https://"></div>
        <div class="field"><label for="l-l">Label</label><input id="l-l" name="label" type="text" maxlength="200"></div>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Add</button></div></form>`.toString(), (el, close) => {
      bindForm(el.querySelector('#f'), (b) => api(`/api/evidence/task/${id}/links`, { method: 'POST', body: b }), { onSuccess: () => { close(); reload() } })
    }),
    share: () => shareToSlack(t),
    ...workflowActions({ id, wf, run })
  }
  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { b.closest('details')?.removeAttribute('open'); ACTIONS[b.dataset.act]?.(b) }))
  const moreMenu = main.querySelector('.more-menu')
  if (moreMenu) {
    const away = (e) => { if (!moreMenu.isConnected) return document.removeEventListener('click', away); if (!moreMenu.contains(e.target)) moreMenu.removeAttribute('open') }
    document.addEventListener('click', away)
    moreMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { moreMenu.removeAttribute('open'); moreMenu.querySelector('summary').focus() } })
  }
}

async function shareToSlack(t) {
  let conns
  try { conns = await api('/api/viasocket/connections') } catch (e) { toast(errorText(e), { error: true }); return }
  const slack = conns.connections.filter((c) => c.app === 'slack' && c.status !== 'missing')
  if (!conns.configured) return modal(html`<h2 id="modal-title">Share to Slack</h2><div class="notice warn">ViaSocket is not configured on this server, so Slack is unavailable.</div><div class="row end"><button class="btn ghost" data-close>Close</button></div>`.toString())
  if (!slack.length) return modal(html`<h2 id="modal-title">Share to Slack</h2><p>Connect your Slack first in the Automation Center.</p><div class="row end"><button class="btn ghost" data-close>Close</button><a class="btn" href="#/automations">Connect Slack</a></div>`.toString(), (el, close) => el.querySelector('a').addEventListener('click', () => close()))
  modal(html`<h2 id="modal-title">Share to Slack</h2><form id="f"><div class="form-error"></div>
    <div class="field"><label for="s-c">Slack account</label><select id="s-c" name="connectionId">${slack.map((c) => html`<option value="${c.id}">${c.label || 'Slack'}</option>`)}</select></div>
    <div class="field"><label for="s-ch">Channel</label><select id="s-ch" name="slackChannelId" required><option value="">Loading channels…</option></select></div>
    <div class="field"><label for="s-n">Note (optional)</label><input id="s-n" name="note" type="text" maxlength="500"></div>
    <p class="small muted">Posts a real message to the channel, from your Slack.</p>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Post</button></div></form>`.toString(), (el, close) => {
    const loadCh = async () => {
      const s = el.querySelector('#s-ch')
      try { const ch = await api(`/api/viasocket/connections/${el.querySelector('#s-c').value}/slack-channels`); s.innerHTML = ch.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('') } catch (e) { s.innerHTML = '<option value="">Could not load channels</option>'; el.querySelector('.form-error').innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() }
    }
    el.querySelector('#s-c').addEventListener('change', loadCh)
    loadCh()
    bindForm(el.querySelector('#f'), async (b) => {
      const out = await api(`/api/tasks/${t.id}/share`, { method: 'POST', body: b })
      if (out.status !== 'SUCCEEDED') throw new Error(out.error || 'Slack did not confirm the post.')
      return out
    }, { onSuccess: (out) => { close(); toast(out.summary) } })
  })
}

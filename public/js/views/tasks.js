import { api, html, raw, esc, modal, bindForm, toast, errorText, confirmDialog, ago, dt, statusBadge, prioBadge, conditionBadges, progressBar, empty, toLocalInput, fromLocalInput, STATUS_LABEL } from '../ui.js'
import { app } from '../app.js'
import { eventText } from './dashboard.js'

let assignableCache = null
async function assignable() {
  assignableCache ||= api('/api/assignable')
  return assignableCache
}
let teamsCache = null
const teams = () => (teamsCache ||= api('/api/teams'))

// ---------- list ----------
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
  main.innerHTML = html`
    <div class="page-head"><div><h1>${isTeam ? 'Team tasks' : 'My tasks'}</h1><p>${isTeam ? 'Everything your teams are working on. Overdue and at-risk are calculated from deadlines and progress.' : 'Tasks assigned to you.'}</p></div>
      <div class="row"><button class="btn" id="new-task">${app.session.membership.creationMode === 'direct' ? 'New task' : 'Suggest a task'}</button></div></div>
    <form class="filters" id="filters" role="search">
      <input type="search" name="q" value="${q.get('q') || ''}" placeholder="Search title or description" aria-label="Search tasks">
      ${sel('status', Object.entries(STATUS_LABEL).filter(([k]) => k !== 'SUGGESTED'), 'Any status')}
      ${sel('priority', [['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']], 'Any priority')}
      ${sel('condition', [['overdue', 'Overdue'], ['at_risk', 'At risk'], ...(isTeam ? [['unassigned', 'Unassigned']] : [])], 'Any condition')}
      ${isTeam ? sel('assigneeId', [['none', '(Unassigned)'], ...people.filter((p) => p.inScope).map((p) => [p.userId, p.name])], 'Anyone') : ''}
      ${isTeam && teamList.length > 1 ? sel('teamId', teamList.map((t) => [t.id, t.name]), 'Any team') : ''}
      ${sel('sort', [['due', 'Sort: due date'], ['priority', 'Sort: priority'], ['updated', 'Sort: recently updated'], ['created', 'Sort: newest'], ['title', 'Sort: title']], 'Sort: due date')}
      <label class="check small" style="margin:0"><input type="checkbox" name="closed" value="1" ${q.get('closed') === '1' ? raw('checked') : ''}> Show cancelled</label>
      <button class="btn ghost small" type="submit">Apply</button>
      ${[...q.keys()].length ? html`<a class="btn link small" href="${base}">Clear</a>` : ''}
    </form>
    ${tasks.length ? html`<div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Priority</th>${isTeam ? html`<th>Owner</th>` : ''}<th>Due</th><th class="hide-sm">Progress</th></tr></thead><tbody>
      ${tasks.map((t) => html`<tr class="clickable" data-href="#/tasks/${t.id}"><td><a href="#/tasks/${t.id}"><b>${t.title}</b></a><div class="row small" style="margin-top:2px">${conditionBadges(t)}${t.teamName ? html`<span class="muted">${t.teamName}</span>` : ''}</div></td>
        <td>${statusBadge(t.status)}${t.blockedHours !== null ? html`<div class="small muted">${t.blockedHours}h</div>` : ''}</td><td>${prioBadge(t.priority)}</td>
        ${isTeam ? html`<td>${t.assigneeName || html`<span class="muted">—</span>`}</td>` : ''}
        <td class="nowrap">${t.dueAt ? html`<span title="${dt(t.dueAt)}">${ago(t.dueAt)}</span>` : html`<span class="muted">—</span>`}</td><td class="hide-sm" style="width:110px">${progressBar(t.progress)}<div class="small muted">${t.progress}%</div></td></tr>`)}
    </tbody></table></div>` : empty(isTeam ? 'No tasks match' : 'No tasks here', isTeam ? 'Try other filters, or create a task.' : 'When someone assigns you a task it appears here. You can also suggest one.')}`
  document.getElementById('new-task').addEventListener('click', () => openTaskForm())
  document.getElementById('filters').addEventListener('submit', (e) => {
    e.preventDefault()
    const p = new URLSearchParams()
    for (const el of e.target.elements) if (el.name && (el.type === 'checkbox' ? el.checked : el.value)) p.set(el.name, el.value)
    location.hash = `${base}${p.toString() ? `?${p}` : ''}`
  })
  document.querySelectorAll('#filters select').forEach((s) => s.addEventListener('change', () => document.getElementById('filters').requestSubmit()))
}

// ---------- create / edit ----------
export async function openTaskForm(existing = null) {
  const mode = existing ? 'edit' : app.session.membership.creationMode
  const [people, teamList] = await Promise.all([assignable().catch(() => []), teams().catch(() => [])])
  const myTeams = app.isAdmin ? teamList : app.role === 'manager' ? teamList.filter((t) => t.managedByMe) : teamList.filter((t) => t.id === app.session.membership.teamId)
  const isRequest = mode === 'request'
  const t = existing || {}
  const content = html`<h2 id="modal-title">${existing ? 'Edit task' : isRequest ? 'Suggest a task' : 'New task'}</h2>
    ${isRequest ? html`<div class="notice">Your manager approves suggestions before they become official tasks.</div>` : ''}
    <form id="task-form"><div class="form-error"></div>
      <div class="field"><label for="t-title">Title</label><input id="t-title" name="title" type="text" required maxlength="200" value="${t.title || ''}"></div>
      <div class="field"><label for="t-desc">Description</label><textarea id="t-desc" name="description" maxlength="5000">${t.description || ''}</textarea></div>
      ${isRequest ? html`<div class="field"><label for="t-reason">Why is this needed?</label><textarea id="t-reason" name="reason" required maxlength="2000"></textarea></div>` : ''}
      <div class="field"><label for="t-out">Expected outcome</label><textarea id="t-out" name="expectedOutcome" maxlength="2000" placeholder="What will be different when this is done?">${t.expectedOutcome || ''}</textarea></div>
      <div class="fields">
        <div class="field"><label for="t-prio">${isRequest ? 'Suggested priority' : 'Priority'}</label><select id="t-prio" name="priority">${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => html`<option value="${p}" ${(t.priority || 'MEDIUM') === p ? raw('selected') : ''}>${p[0] + p.slice(1).toLowerCase()}</option>`)}</select></div>
        <div class="field"><label for="t-due">${isRequest ? 'Suggested deadline' : 'Due'}</label><input id="t-due" name="dueAt" type="datetime-local" value="${toLocalInput(t.dueAt)}"></div>
        ${isRequest ? '' : html`<div class="field"><label for="t-start">Start date</label><input id="t-start" name="startDate" type="date" value="${t.startDate || ''}"></div>`}
        ${myTeams.length ? html`<div class="field"><label for="t-team">Team</label><select id="t-team" name="teamId"><option value="">(default)</option>${myTeams.map((x) => html`<option value="${x.id}" ${t.teamId === x.id ? raw('selected') : ''}>${x.name}</option>`)}</select></div>` : ''}
        ${!existing ? html`<div class="field"><label for="t-assignee">${isRequest ? 'Suggested owner' : 'Assign to'}</label><select id="t-assignee" name="assigneeId"><option value="">${isRequest ? '(let the manager decide)' : '(unassigned)'}</option>
          ${(isRequest ? [] : people).map((p) => html`<option value="${p.userId}">${p.name}${p.userId === app.me.id ? ' (me)' : ''}</option>`)}</select>
          ${!isRequest && !people.length ? html`<div class="hint">You do not have permission to assign tasks.</div>` : ''}</div>` : ''}
      </div>
      ${isRequest ? '' : html`<div class="field"><label for="t-links">Supporting links</label><textarea id="t-links" name="links" rows="2" placeholder="One link per line (https://…)">${(t.links || []).map((l) => l.url).join('\n')}</textarea></div>`}
      ${existing ? html`<div class="field"><label for="t-reason2">Reason for change (kept in history)</label><input id="t-reason2" name="reason" type="text" maxlength="500"></div>` : ''}
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">${existing ? 'Save' : isRequest ? 'Send suggestion' : 'Create task'}</button></div>
    </form>`
  return modal(content.toString(), (el, close) => {
    // The suggested-owner list for requests comes from all members (a suggestion grants nothing).
    if (isRequest) api('/api/members').then((ms) => { const s = el.querySelector('#t-assignee'); ms.forEach((m) => s.insertAdjacentHTML('beforeend', `<option value="${esc(m.userId)}">${esc(m.name)}</option>`)) }).catch(() => {})
    bindForm(el.querySelector('#task-form'), async (d) => {
      const body = { ...d, dueAt: d.dueAt ? fromLocalInput(d.dueAt) : (existing ? null : undefined) }
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
        location.hash = `#/tasks/${out.task.id}`
      }
    })
  })
}

// ---------- detail ----------
export async function renderTaskDetail(main, id) {
  assignableCache = null
  const d = await api(`/api/tasks/${id}`)
  const t = d.task
  const a = d.allowed
  const openBlockers = d.blockers.filter((b) => b.status === 'OPEN')
  const actions = [
    a.start && html`<button class="btn" data-act="start">Start work</button>`,
    a.progress && html`<button class="btn ghost" data-act="progress">Update progress</button>`,
    a.submit && html`<button class="btn" data-act="submit">Submit for review</button>`,
    a.review && html`<button class="btn" data-act="review">Review submission</button>`,
    a.block && html`<button class="btn ghost" data-act="block">Report blocker</button>`,
    a.assign && html`<button class="btn ghost" data-act="assign">${t.assigneeId ? 'Reassign' : 'Assign'}</button>`,
    a.edit && !['COMPLETED', 'CANCELLED'].includes(t.status) && html`<button class="btn ghost" data-act="edit">Edit</button>`,
    a.reopen && html`<button class="btn ghost" data-act="reopen">Reopen</button>`,
    a.restore && html`<button class="btn ghost" data-act="restore">Restore</button>`,
    a.cancel && html`<button class="btn ghost" data-act="cancel">Cancel task</button>`,
    a.delete && html`<button class="btn ghost" data-act="delete" style="color:var(--bad)">Delete</button>`
  ].filter(Boolean)
  main.innerHTML = html`
    <div class="small muted" style="margin-bottom:6px"><a href="${t.isMine ? '#/my-tasks' : '#/team-tasks'}">← Back to tasks</a></div>
    <div class="page-head"><div><h1>${t.title}</h1>
      <div class="row" style="margin-top:8px">${statusBadge(t.status)} ${prioBadge(t.priority)} ${conditionBadges(t)} ${t.teamName ? html`<span class="badge outline">${t.teamName}</span>` : ''}</div></div>
      <div class="row">${actions}</div></div>
    ${openBlockers.length ? html`<div class="notice err"><b>Blocked for ${t.blockedHours}h.</b> ${openBlockers.map((b) => b.description).join(' · ')} — a blocked task does not count against the person doing it.</div>` : ''}
    ${t.status === 'SUBMITTED_FOR_REVIEW' ? html`<div class="notice">Submitted for review ${ago(t.submittedAt)}. It is not complete until a manager approves it.</div>` : ''}
    <div class="grid side">
      <div class="stack">
        <section class="card"><h2 style="margin-bottom:10px">Details</h2>
          <dl class="kv">
            <dt>Owner</dt><dd>${t.assigneeName || html`<span class="badge warn">Unassigned</span>`}</dd>
            <dt>Created by</dt><dd>${t.createdByName} · ${dt(t.createdAt)}</dd>
            <dt>Due</dt><dd>${t.dueAt ? html`${dt(t.dueAt)} <span class="muted">(${ago(t.dueAt)})</span>` : '—'}</dd>
            <dt>Start date</dt><dd>${t.startDate || '—'}</dd>
            <dt>Progress</dt><dd><div class="row">${html`<div style="width:160px">${progressBar(t.progress)}</div>`}<span>${t.progress}%</span>${t.lastProgressAt ? html`<span class="muted small">updated ${ago(t.lastProgressAt)}</span>` : ''}</div></dd>
            <dt>Description</dt><dd class="pre">${t.description || '—'}</dd>
            <dt>Expected outcome</dt><dd class="pre">${t.expectedOutcome || '—'}</dd>
            ${t.links.length ? html`<dt>Links</dt><dd>${t.links.map((l) => html`<div><a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.label || l.url}</a></div>`)}</dd>` : ''}
            ${t.sourceRequestId ? html`<dt>From request</dt><dd><a href="#/requests">Approved suggestion</a></dd>` : ''}
          </dl></section>
        ${d.submissions.length ? html`<section class="card"><h2 style="margin-bottom:10px">Completion submissions and reviews</h2>
          ${d.submissions.map((s) => html`<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
            <div class="row between"><b>${s.submittedBy} · ${dt(s.createdAt)}</b><span class="badge ${s.status === 'APPROVED' ? 'ok' : s.status === 'PENDING' ? 'info' : 'warn'}">${s.status.replace(/_/g, ' ').toLowerCase()}</span></div>
            <dl class="kv" style="margin-top:6px"><dt>Work summary</dt><dd class="pre">${s.summary}</dd><dt>Outcome achieved</dt><dd class="pre">${s.outcome}</dd>
            ${s.evidence.length ? html`<dt>Evidence</dt><dd>${s.evidence.map((e) => html`<div><a href="${e.url}" ${e.kind === 'link' ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${e.label || e.fileName || e.url}</a></div>`)}</dd>` : ''}</dl>
            ${s.reviews.map((r) => html`<div class="notice ${r.decision === 'APPROVED' ? 'ok' : 'warn'}" style="margin:8px 0 0"><b>${r.reviewer}</b> ${r.decision === 'APPROVED' ? 'approved' : 'requested changes'} ${ago(r.createdAt)}${r.comment ? html`: “${r.comment}”` : ''}</div>`)}
          </div>`)}
          ${t.status === 'COMPLETED' ? html`<p class="small muted" style="margin-top:10px">Completion is not the same as impact. ${t.isMine ? html`<a href="#/impact?new=1&taskId=${t.id}">Record the outcome this delivered</a> so it can be verified.` : ''}</p>` : ''}
        </section>` : ''}
        <section class="card"><div class="card-head"><h2>Activity and comments</h2></div>
          <ul class="timeline">${d.events.map((e) => html`<li><div><b>${e.actorName || 'System'}</b> ${eventText(e)}</div><div class="when">${dt(e.createdAt)}</div></li>`)}</ul>
          <form id="comment" class="row" style="margin-top:8px;align-items:flex-start"><div class="grow" style="flex:1"><label for="c-body" class="sr" style="position:absolute;left:-999px">Comment</label><textarea id="c-body" name="body" rows="2" required maxlength="4000" placeholder="Write a comment…" style="min-height:44px"></textarea></div><button class="btn ghost" type="submit">Comment</button></form>
        </section>
      </div>
      <div class="stack">
        <section class="card"><div class="card-head"><h2>Blockers</h2>${a.block ? html`<button class="btn small ghost" data-act="block">Report</button>` : ''}</div>
          ${d.blockers.length ? html`<ul class="list">${d.blockers.map((b) => html`<li><div class="grow">
            <div class="row"><span class="badge ${b.status === 'OPEN' ? 'bad' : 'ok'}">${b.status === 'OPEN' ? `Open ${b.hoursOpen}h` : 'Resolved'}</span>${b.escalatedAt ? html`<span class="badge warn">Escalated</span>` : ''}${b.isExternal ? html`<span class="badge outline">External</span>` : ''}</div>
            <div style="margin-top:4px">${b.description}</div>
            <div class="small muted">${b.reportedBy} · ${ago(b.reportedAt)}${b.dependencyOwnerName ? ` · waiting on ${b.dependencyOwnerName}` : ''}${b.dependencyNote ? ` · ${b.dependencyNote}` : ''}</div>
            ${b.resolutionNote ? html`<div class="small">Resolved by ${b.resolvedBy}: ${b.resolutionNote}</div>` : ''}
            ${b.status === 'OPEN' ? html`<div class="row" style="margin-top:6px"><button class="btn small ghost" data-resolve="${b.id}">Resolve</button>${!b.escalatedAt ? html`<button class="btn small ghost" data-escalate="${b.id}">Escalate</button>` : ''}</div>` : ''}
          </div></li>`)}</ul>` : html`<p class="muted small">No blockers reported.</p>`}
        </section>
        <section class="card"><div class="card-head"><h2>Evidence</h2></div>
          ${d.evidence.length ? html`<ul class="list">${d.evidence.map((e) => html`<li><div class="grow"><a href="${e.url}" ${e.kind === 'link' ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${e.label || e.fileName || e.url}</a><div class="small muted">${e.kind === 'file' ? `${Math.ceil(e.sizeBytes / 1024)} KB · ` : ''}${e.createdBy} · ${ago(e.createdAt)}</div></div>
            ${e.createdBy === app.me.name ? html`<button class="btn small link" data-del-evidence="${e.id}" aria-label="Remove">Remove</button>` : ''}</li>`)}</ul>` : html`<p class="muted small">No evidence attached.</p>`}
          ${t.isMine || t.canManage ? html`<div class="row" style="margin-top:8px"><button class="btn small ghost" data-act="add-link">Add link</button><label class="btn small ghost" style="margin:0">Upload file<input type="file" id="ev-file" hidden accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.zip,.docx,.xlsx,.pptx"></label></div><div class="hint">Files are private to people who can see this task. Max 5 MB.</div>` : ''}
        </section>
        ${d.impact.length ? html`<section class="card"><h2 style="margin-bottom:8px">Recorded impact</h2><ul class="list">${d.impact.map((r) => html`<li><a href="#/impact/${r.id}">${r.title}</a></li>`)}</ul></section>` : ''}
        <section class="card"><div class="card-head"><h2>Share</h2></div><p class="small muted">Post this task to a Slack channel through your own connected Slack (ViaSocket).</p><button class="btn small ghost" data-act="share">Share to Slack</button></section>
      </div>
    </div>`

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
        <div class="field"><label for="p-note">What moved forward?</label><textarea id="p-note" name="note" maxlength="2000"></textarea></div>
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
        <div class="field"><label for="s-s">Work summary</label><textarea id="s-s" name="summary" required maxlength="4000" placeholder="What did you do?"></textarea></div>
        <div class="field"><label for="s-o">Outcome achieved</label><textarea id="s-o" name="outcome" required maxlength="4000" placeholder="What is different now? Compare with the expected outcome: ${t.expectedOutcome || '—'}"></textarea></div>
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
    share: () => shareToSlack(t)
  }
  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => ACTIONS[b.dataset.act]?.()))
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

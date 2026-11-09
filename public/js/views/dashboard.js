import { api, html, avatar, ago, dt, statusBadge, prioBadge, conditionBadges, progressBar, verifyBadge, empty, bindForm, toast, requestBadge } from '../ui.js'
import { app } from '../app.js'
import { openTaskForm } from './tasks.js'

const stat = (label, value, { tone = '', href = null } = {}) => href
  ? html`<a class="stat ${value ? tone : ''}" href="${href}"><div class="label">${label}</div><div class="value">${value}</div></a>`
  : html`<div class="stat ${value ? tone : ''}"><div class="label">${label}</div><div class="value">${value}</div></div>`

const ATTENTION = { overdue: ['Overdue', 'bad'], unassigned: ['No owner', 'warn'], blocked_long: ['Blocked too long', 'bad'], no_progress: ['No progress', 'warn'], not_started: ['Not started', 'warn'], awaiting_review: ['Awaiting your review', 'brand'], at_risk: ['At risk', 'warn'] }

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
  priority_changed: (d) => `changed priority from ${d.from} to ${d.to}${d.reason ? ` — ${d.reason}` : ''}`,
  edited: (d) => `edited ${d.fields.join(', ').replace(/_/g, ' ')}`,
  blocker_reported: (d) => `reported a blocker: ${d.description}${d.dependencyOwner ? ` (waiting on ${d.dependencyOwner})` : d.external ? ' (external)' : ''}`,
  blocker_resolved: (d) => `resolved a blocker: ${d.note}`,
  blocker_escalated: () => 'escalated a blocker',
  submitted_for_review: (d) => `submitted it for review: ${d.summary}`,
  review_decision: (d) => (d.decision === 'APPROVED' ? `approved the work${d.comment ? ` — ${d.comment}` : ''}` : `requested changes — ${d.comment}`),
  evidence_added: (d) => `added evidence: ${d.label}`,
  shared: (d) => `shared it to ${d.to}`,
  alert_response: (d) => `answered an alert: ${d.response}`
}
export const eventText = (e) => (EVENT_TEXT[e.type] ? EVENT_TEXT[e.type](e.data || {}) : e.type)

const taskLine = (t, extra = '') => html`<li><div class="grow"><a href="#/tasks/${t.id}"><b>${t.title}</b></a>
  <div class="row small muted" style="margin-top:2px">${statusBadge(t.status)} ${prioBadge(t.priority)} ${conditionBadges(t)} ${t.assigneeName ? html`<span>· ${t.assigneeName}</span>` : ''} ${t.dueAt ? html`<span>· due ${ago(t.dueAt)}</span>` : ''} ${extra}</div></div></li>`

export async function renderDashboard(main) {
  const data = await api('/api/dashboard')
  const m = data.manager
  const p = data.personal
  main.innerHTML = html`
    <div class="page-head"><div><h1>${m ? 'Team dashboard' : 'My dashboard'}</h1><p>${m ? 'Where the team stands, where people need help, and the outcomes they delivered. Task counts are operational only.' : 'Your work, what needs you, and the difference you made.'}</p></div>
      <div class="row"><button class="btn" id="new-task">${app.session.membership.creationMode === 'direct' ? 'New task' : 'Suggest a task'}</button></div></div>
    ${m ? managerSection(m) : ''}
    ${m ? html`<div class="section-title"><h2>My own work</h2></div>` : ''}
    ${personalSection(p, !m)}
  `
  document.getElementById('new-task').addEventListener('click', () => openTaskForm())
  const f = document.getElementById('reflection')
  if (f) bindForm(f, (d) => api('/api/reflections', { method: 'PUT', body: { day: p.reflection.day, ...d } }), { onSuccess: (r) => { toast('Reflection saved.'); document.getElementById('refl-saved').textContent = `Saved ${ago(r.savedAt)}` } })
}

function managerSection(m) {
  const c = m.counts
  return html`
    <div class="stats" aria-label="Team summary">
      ${stat('Team members', c.teamMembers)}
      ${stat('Active tasks', c.active, { href: '#/team-tasks' })}
      ${stat('Pending (not started)', c.pending, { href: '#/team-tasks?status=ASSIGNED' })}
      ${stat('In progress', c.inProgress, { href: '#/team-tasks?status=IN_PROGRESS' })}
      ${stat('Blocked', c.blocked, { tone: 'bad', href: '#/team-tasks?status=BLOCKED' })}
      ${stat('Awaiting review', c.awaitingReview, { tone: 'warn', href: '#/team-tasks?status=SUBMITTED_FOR_REVIEW' })}
      ${stat('Overdue', c.overdue, { tone: 'bad', href: '#/team-tasks?condition=overdue' })}
      ${stat('Unassigned', c.unassigned, { tone: 'warn', href: '#/team-tasks?condition=unassigned' })}
      ${stat('Completed', c.completed, { href: '#/team-tasks?status=COMPLETED' })}
      ${stat('Requests to decide', c.pendingRequests, { tone: 'warn', href: '#/requests' })}
      ${stat('Impact to verify', c.pendingImpact, { tone: 'warn', href: '#/impact?status=PENDING' })}
    </div>
    <div class="grid side">
      <section class="card" aria-labelledby="att-h"><div class="card-head"><div><h2 id="att-h">Attention required</h2><p>Overdue, ownerless, stuck or waiting on you</p></div></div>
        ${m.attention.length ? html`<ul class="list">${m.attention.slice(0, 12).map((a) => html`<li><span class="badge ${ATTENTION[a.kind][1]}" style="min-width:110px;justify-content:center">${ATTENTION[a.kind][0]}</span>
          <div class="grow"><a href="#/tasks/${a.task.id}"><b>${a.task.title}</b></a><div class="small muted">${a.detail}${a.task.assigneeName ? ` · ${a.task.assigneeName}` : ''}</div></div></li>`)}</ul>`
          : empty('All clear', 'Nothing overdue, blocked or waiting on you.')}
      </section>
      <section class="card" aria-labelledby="act-h"><div class="card-head"><h2 id="act-h">Recent activity</h2></div>
        ${m.activity.length ? html`<ul class="timeline" style="max-height:420px;overflow-y:auto">${m.activity.slice(0, 15).map((e) => html`<li><div><b>${e.actorName || 'System'}</b> ${eventText(e)} on <a href="#/tasks/${e.taskId}">${e.taskTitle}</a></div><div class="when">${ago(e.createdAt)}</div></li>`)}</ul>`
          : empty('No activity yet', 'Create a task to get started.')}
      </section>
    </div>
    <div class="grid two" style="margin-top:16px">
      <section class="card" aria-labelledby="wl-h"><div class="card-head"><div><h2 id="wl-h">Team workload</h2><p>Open work per person — a planning view, not a performance measure</p></div></div>
        ${m.workload.length ? html`<div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Active</th><th class="num">Blocked</th><th class="num">Due ≤3d</th><th class="num">Overdue</th><th class="num hide-sm">Review</th></tr></thead><tbody>
          ${m.workload.map((w) => html`<tr class="clickable" data-href="#/team-tasks?assigneeId=${w.userId}"><td><div class="row">${avatar(w.name, w.pictureUrl)}<span>${w.name}</span></div></td><td class="num">${w.active}</td><td class="num">${w.blocked ? html`<span class="badge bad">${w.blocked}</span>` : 0}</td><td class="num">${w.dueSoon}</td><td class="num">${w.overdue ? html`<span class="badge bad">${w.overdue}</span>` : 0}</td><td class="num hide-sm">${w.inReview}</td></tr>`)}
          </tbody></table></div>` : empty('No team members yet', 'Invite people from Settings → Members.', html`<a class="btn small" href="#/settings/members">Invite people</a>`)}
      </section>
      <section class="card" aria-labelledby="imp-h"><div class="card-head"><div><h2 id="imp-h">Team impact (last ${m.impact.periodDays} days)</h2><p>Verified outcomes — not task counts</p></div><a class="btn small ghost" href="#/impact">All impact</a></div>
        ${m.impact.verifiedTotals.length ? html`<div class="row" style="margin-bottom:10px">${m.impact.verifiedTotals.map((t) => html`<span class="badge ${t.valueType === 'ESTIMATED' ? 'warn' : 'ok'}">${t.categoryLabel}: ${t.valueType === 'ESTIMATED' ? '≈' : ''}${t.total.toLocaleString()} ${t.unit}${t.valueType === 'ESTIMATED' ? ' (est.)' : ''}</span>`)}</div>` : ''}
        ${m.impact.recent.length ? html`<ul class="list">${m.impact.recent.map((r) => html`<li><div class="grow"><a href="#/impact/${r.id}"><b>${r.title}</b></a><div class="small muted">${r.userName} · ${r.categoryLabel}${r.measurableValue !== null ? ` · ${r.isEstimate ? '≈ ' : ''}${r.measurableValue} ${r.measurementUnit}${r.isEstimate ? ' (estimate)' : ''}` : ''}</div><div class="small">${r.result}</div></div></li>`)}</ul>`
          : empty('No verified outcomes yet', 'When people record outcomes and you verify them, they appear here.')}
      </section>
    </div>`
}

function personalSection(p, solo) {
  const c = p.counts
  return html`
    <div class="stats">
      ${stat('My active tasks', c.active, { href: '#/my-tasks' })}
      ${stat('Awaiting my action', c.awaitingMe, { tone: 'warn' })}
      ${stat('Not started', c.pending, { href: '#/my-tasks?status=ASSIGNED' })}
      ${stat('Blocked', c.blocked, { tone: 'bad', href: '#/my-tasks?status=BLOCKED' })}
      ${stat('Due in 3 days', c.dueSoon, { tone: 'warn' })}
      ${stat('Overdue', c.overdue, { tone: 'bad', href: '#/my-tasks?condition=overdue' })}
      ${stat('In review', c.inReview, { href: '#/my-tasks?status=SUBMITTED_FOR_REVIEW' })}
    </div>
    <div class="grid two">
      <section class="card"><div class="card-head"><h2>Awaiting my action</h2></div>
        ${p.awaitingMe.length || p.clarifications.length ? html`<ul class="list">${p.awaitingMe.map((a) => taskLine(a.task, html`<span class="badge warn">${a.detail}</span>`))}
          ${p.clarifications.map((r) => html`<li><div class="grow"><a href="#/requests"><b>${r.title}</b></a><div class="small muted">${requestBadge(r.status)} ${r.decisionNote}</div></div></li>`)}</ul>`
          : empty('Nothing waiting on you', 'Nice. Pick up the next task when ready.')}
      </section>
      <section class="card"><div class="card-head"><h2>Upcoming deadlines</h2></div>
        ${p.overdue.length || p.upcoming.length ? html`<ul class="list">${[...p.overdue, ...p.upcoming].slice(0, 8).map((t) => html`<li><div class="grow"><a href="#/tasks/${t.id}"><b>${t.title}</b></a><div class="row small muted">${conditionBadges(t)} <span>${dt(t.dueAt)}</span></div></div><div style="width:80px">${progressBar(t.progress)}</div></li>`)}</ul>`
          : empty('No deadlines coming up', '')}
      </section>
      <section class="card"><div class="card-head"><h2>Blocked and in review</h2></div>
        ${p.blocked.length || p.inReview.length ? html`<ul class="list">${[...p.blocked, ...p.inReview].map((t) => taskLine(t, t.blockedHours !== null ? html`<span>· blocked ${t.blockedHours}h</span>` : ''))}</ul>` : empty('Nothing blocked or in review', '')}
      </section>
      <section class="card"><div class="card-head"><h2>Recent feedback</h2></div>
        ${p.feedback.length ? html`<ul class="list">${p.feedback.map((f) => html`<li><div class="grow"><a href="${f.impactId ? `#/impact/${f.impactId}` : `#/tasks/${f.taskId}`}"><b>${f.title}</b></a>
          <div class="small"><span class="badge ${['APPROVED', 'VERIFIED'].includes(f.decision) ? 'ok' : 'warn'}">${f.decision.replace(/_/g, ' ').toLowerCase()}</span> ${f.reviewer} ${f.comment ? `— “${f.comment}”` : ''}</div><div class="small muted">${ago(f.createdAt)}</div></div></li>`)}</ul>`
          : empty('No feedback yet', 'Reviews of your work and impact appear here.')}
      </section>
    </div>
    <div class="grid two" style="margin-top:16px">
      <section class="card"><div class="card-head"><div><h2>My contributions and impact</h2><p>What changed because of your work</p></div><a class="btn small" href="#/impact?new=1">Record an outcome</a></div>
        ${p.impact.length ? html`<ul class="list">${p.impact.map((r) => html`<li><div class="grow"><a href="#/impact/${r.id}"><b>${r.title}</b></a><div class="small muted">${r.categoryLabel}</div></div>${verifyBadge(r.verificationStatus)}</li>`)}</ul>`
          : empty('No outcomes recorded yet', 'Record a contribution: the problem, what you did, and what changed.')}
      </section>
      <section class="card" aria-labelledby="refl-h"><div class="card-head"><div><h2 id="refl-h">Daily reflection</h2><p>Private to you. Five quick prompts.</p></div><span class="small muted" id="refl-saved">${p.reflection.savedAt ? `Saved ${ago(p.reflection.savedAt)}` : ''}</span></div>
        <form id="reflection"><div class="form-error"></div>
          ${[['contribution', 'What was my most important contribution today?'], ['changeMade', 'What changed because of my work?'], ['blockedBy', 'What blocked me?'], ['learned', 'What did I learn?'], ['tomorrow', 'What will I focus on tomorrow?']].map(([k, label]) => html`<div class="field"><label for="r-${k}">${label}</label><textarea id="r-${k}" name="${k}" rows="2" maxlength="2000" style="min-height:52px">${p.reflection[k]}</textarea></div>`)}
          <button class="btn ghost" type="submit">Save reflection</button></form>
      </section>
    </div>
    ${solo ? '' : ''}`
}

document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-href]')
  if (tr && !e.target.closest('a,button')) location.hash = tr.dataset.href
})

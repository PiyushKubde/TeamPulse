import { api, html, raw, avatar, ago, dt, statusBadge, prioBadge, conditionBadges, progressBar, verifyBadge, empty, bindForm, toast, requestBadge, errorText, icon, due, prov } from '../ui.js'
import { app } from '../app.js'
import { openTaskForm, taskCard } from './tasks.js'
import { renderSignals } from './assistant.js'

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
  if (!data.manager) return renderEmployeeOverview(main, data.personal)
  const m = data.manager
  const p = data.personal
  main.innerHTML = html`
    <div class="page-head"><div><h1>Team dashboard</h1><p>Where the team stands, where people need help, and the outcomes they delivered. Task counts are operational only.</p></div>
      <div class="row"><button class="btn" id="new-task">${icon('plus')}${app.session.membership.creationMode === 'direct' ? 'New task' : 'Suggest a task'}</button></div></div>
    <section class="card intervene" id="dash-signals" style="margin-bottom:16px"></section>
    ${managerSection(m)}
    <div class="section-title"><h2>My own work</h2><a class="btn small ghost" href="#/assistant?run=1">${icon('sparkles')}Analyse my day</a></div>
    ${personalSection(p, false)}
  `
  renderSignals(document.getElementById('dash-signals'), { scope: 'team', limit: 6, title: 'Where to intervene' })
  document.getElementById('new-task').addEventListener('click', () => openTaskForm())
  const cd = document.getElementById('contrib-dash')
  if (cd) {
    api(`/api/contribution/team?from=${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}`).then((t) => {
      const box = cd.querySelector('.loading')
      const needs = t.people.filter((p) => p.awaitingYourReview || p.disputes)
      box.outerHTML = (t.people.some((p) => p.analysed)
        ? html`<p class="small muted" style="margin-bottom:8px">Last 30 days: ${t.people.reduce((n, p) => n + p.analysed, 0)} piece(s) of work analysed; ${t.team.verifiedOutcomes} verified team outcome(s) (shared ones counted once).</p>
          ${needs.length ? html`<ul class="list">${needs.map((p) => html`<li><div class="grow"><a href="#/contribution/${p.userId}"><b>${p.name}</b></a></div>${p.awaitingYourReview ? html`<span class="badge warn">${p.awaitingYourReview} to review</span>` : ''}${p.disputes ? html`<span class="badge warn">${p.disputes} disputed</span>` : ''}</li>`)}</ul>` : html`<p class="small">Nothing waiting for your review.</p>`}`
        : empty('No analysed work yet', 'Work is analysed when it is submitted for review.')).toString()
    }).catch((e) => { cd.querySelector('.loading').outerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() })
  }
  bindReflection(p)
}

function bindReflection(p) {
  const f = document.getElementById('reflection')
  if (f) bindForm(f, (d) => api('/api/reflections', { method: 'PUT', body: { day: p.reflection.day, ...d } }), { onSuccess: (r) => { toast('Reflection saved.'); document.getElementById('refl-saved').textContent = `Saved ${ago(r.savedAt)}` } })
}

// ------------------------------------------------------------------------------------------------ employee overview
// "What should I focus on, what have I accomplished, and what contribution have I made?" — from records only.
const tzMinutes = () => -new Date().getTimezoneOffset()
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening' }
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there'
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const failed = (r) => r.status === 'rejected'

const RANK = (t) => (t.overdue ? 0 : t.status === 'BLOCKED' ? 1 : t.atRisk ? 2 : t.status === 'IN_PROGRESS' ? 3 : t.status === 'SUBMITTED_FOR_REVIEW' ? 5 : 4)
const byUrgency = (a, b) => RANK(a) - RANK(b) || (Date.parse(a.dueAt || '9999-12-31') - Date.parse(b.dueAt || '9999-12-31'))

function hero(p, tasks, attention) {
  const inProgress = tasks.filter((t) => t.status === 'IN_PROGRESS').length
  const notStarted = tasks.filter((t) => t.status === 'ASSIGNED').length
  const parts = []
  if (inProgress) parts.push(html`<b>${plural(inProgress, 'task')} in progress</b>`)
  if (notStarted) parts.push(html`<b>${notStarted} not started</b>`)
  if (p.blocked.length) parts.push(html`<b>${p.blocked.length} blocked</b>`)
  if (attention) parts.push(html`<b>${attention} waiting on you</b>`)
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const lede = parts.length
    ? html`You have ${parts.map((x, i) => html`${i ? (i === parts.length - 1 ? ' and ' : ', ') : ''}${x}`)}. Here is where your attention matters most today.`
    : html`Nothing is assigned to you right now. Suggest a task, or connect your apps so the work you do shows up here.`
  return html`<header class="hero"><div><div class="eyebrow">${icon('calendar', 'xs')}${today}</div><h1>${greeting()}, ${firstName(app.me.name)}</h1><p class="lede">${lede}</p></div>
    <div class="row"><a class="btn" href="#/assistant?run=1">${icon('sparkles')}Analyse my day</a><button class="btn ghost" id="new-task">${icon('plus')}${app.session.membership.creationMode === 'direct' ? 'New task' : 'Suggest a task'}</button></div></header>`
}

function focusCard(digest) {
  if (failed(digest)) return html`<section class="card focus-card"><div class="notice err">${errorText(digest.reason)}</div></section>`
  const items = digest.value.priorities.slice(0, 4)
  return html`<section class="card focus-card" aria-labelledby="focus-h"><div class="card-head"><div><h2 id="focus-h"><span class="card-icon brand">${icon('target')}</span>Today’s focus</h2><p>Ordered by urgency: requested changes, deadlines, blockers, then what to continue.</p></div>${prov('fact', 'From your tasks')}</div>
    ${items.length ? html`<ol class="focus-list">${items.map((x) => html`<li><div style="min-width:0"><a href="${x.href}">${x.text}</a><div class="why">${x.why}</div></div></li>`)}</ol>`
      : empty('You are clear for today', 'No requested changes, deadlines or blockers. A good moment to pick up something new or record an outcome.', html`<a class="btn small ghost" href="#/requests">${icon('plus')}Suggest a task</a>`, 'checkCircle')}
    <div class="card-foot"><span class="muted">Want the full picture of your day?</span><a href="#/assistant?run=1">Analyse my day ${icon('arrowRight', 'xs')}</a></div></section>`
}

function inProgressCard(tasks) {
  if (failed(tasks)) return html`<section class="card"><div class="notice err">${errorText(tasks.reason)}</div></section>`
  const list = tasks.value.filter((t) => t.status !== 'SUBMITTED_FOR_REVIEW').sort(byUrgency)
  return html`<section class="card" aria-labelledby="wip-h"><div class="card-head"><div><h2 id="wip-h"><span class="card-icon">${icon('trending')}</span>Work in progress</h2><p>Your open tasks, most urgent first.</p></div><a class="btn small subtle" href="#/my-tasks">All my tasks${icon('arrowRight', 'sm')}</a></div>
    ${list.length ? html`<div class="task-cards">${list.slice(0, 6).map(taskCard)}</div>${list.length > 6 ? html`<p class="small muted" style="margin:12px 0 0">${list.length - 6} more in <a href="#/my-tasks">My Tasks</a>.</p>` : ''}`
      : empty('No open tasks', 'When work is assigned to you, it appears here with its deadline and progress.', '', 'tasks')}</section>`
}

function attentionCard(p) {
  const rows = [
    ...p.awaitingMe.map((a) => html`<li><span class="lead-icon warn">${icon('alert')}</span><div class="grow"><a class="ttl" href="#/tasks/${a.task.id}">${a.task.title}</a><div class="small muted">${a.detail}</div></div></li>`),
    ...p.clarifications.map((r) => html`<li><span class="lead-icon brand">${icon('help')}</span><div class="grow"><a class="ttl" href="#/requests">${r.title}</a><div class="small muted">Your manager asked for clarification${r.decisionNote ? `: “${r.decisionNote}”` : ''}</div></div>${requestBadge(r.status)}</li>`)
  ]
  return html`<section class="card" aria-labelledby="att-h"><div class="card-head"><div><h2 id="att-h"><span class="card-icon warn">${icon('alert')}</span>Needs your attention</h2><p>Things only you can move forward.</p></div></div>
    ${rows.length ? html`<ul class="mini-list">${rows}</ul>` : ''}
    <div id="my-signals" ${rows.length ? raw('style="margin-top:14px"') : ''}></div></section>`
}

function blockersCard(p) {
  return html`<section class="card" aria-labelledby="blk-h"><div class="card-head"><div><h2 id="blk-h"><span class="card-icon bad">${icon('blocked')}</span>Blockers</h2><p>Work waiting on someone or something.</p></div></div>
    ${p.blocked.length ? html`<ul class="mini-list">${p.blocked.map((t) => html`<li><span class="lead-icon bad">${icon('blocked')}</span><div class="grow"><a class="ttl" href="#/tasks/${t.id}">${t.title}</a>
      <div class="meta">${t.blockedHours !== null ? html`<span>Blocked for ${t.blockedHours}h</span>` : ''}${due(t)}</div></div><a class="btn small ghost" href="#/tasks/${t.id}">Update</a></li>`)}</ul>
      <div class="principle" style="margin-top:14px">${icon('shield')}<span>If something outside your control is blocking you, say so on the blocker. It is shown as a reason, never counted against you.</span></div>`
      : html`<p class="small muted" style="margin:0">Nothing is blocking you. If you get stuck, report a blocker on the task so your manager can help.</p>`}</section>`
}

function evidenceCard(evidence) {
  if (failed(evidence)) return html`<section class="card"><div class="notice err">${errorText(evidence.reason)}</div></section>`
  const pending = evidence.value.flatMap((e) => e.links.filter((l) => l.status === 'suggested').map((l) => ({ e, l }))).slice(0, 4)
  const none = !evidence.value.length
  return html`<section class="card" aria-labelledby="ev-h" id="ev-confirm"><div class="card-head"><div><h2 id="ev-h"><span class="card-icon teal">${icon('evidence')}</span>Evidence to confirm</h2><p>TeamPulse noticed these in your connected apps. Nothing counts until you confirm it.</p></div></div>
    ${pending.length ? html`<ul class="mini-list">${pending.map(({ e, l }) => html`<li data-ev-link="${l.id}"><span class="lead-icon teal">${icon('evidence')}</span><div class="grow">
        <div class="ttl">${e.title}</div>
        <div class="meta"><span>${e.appLabel}</span><span class="sep"></span><span>${ago(e.occurredAt)}</span></div>
        <div class="row" style="margin-top:6px;gap:6px">${prov('suggested', 'Suggested match')}<span class="small">for <a href="#/tasks/${l.taskId}">${l.taskTitle}</a></span></div>
        ${l.explanation ? html`<div class="small muted" style="margin-top:4px">${l.explanation}</div>` : ''}
        <div class="row" style="margin-top:8px;gap:6px"><button class="btn small" data-ev-act="CONFIRM">${icon('check')}It belongs here</button><button class="btn small ghost" data-ev-act="REJECT">Not this task</button></div></div></li>`)}</ul>
      <div class="card-foot"><span class="muted">Confirmed evidence is used when your work is analysed.</span><a href="#/evidence">My Work Evidence ${icon('arrowRight', 'xs')}</a></div>`
      : none ? empty('No app evidence yet', 'Connect GitHub, Slack, Gmail, Calendar or Sheets, choose what to collect, and your work shows up here for you to confirm.', html`<a class="btn small ghost" href="#/evidence">${icon('apps')}Set up My Work Evidence</a>`, 'evidence')
        : empty('Nothing to confirm', 'All suggested matches have been decided.', html`<a class="btn small subtle" href="#/evidence">My Work Evidence</a>`, 'checkCircle')}</section>`
}

function completedCard(p) {
  return html`<section class="card" aria-labelledby="done-h"><div class="card-head"><div><h2 id="done-h"><span class="card-icon ok">${icon('checkCircle')}</span>Recently completed</h2><p>Approved work. Completion is not impact — record what changed.</p></div><a class="btn small subtle" href="#/my-tasks?status=COMPLETED">All${icon('arrowRight', 'sm')}</a></div>
    ${p.completed.length ? html`<ul class="mini-list">${p.completed.slice(0, 5).map((t) => html`<li><div class="grow"><a class="ttl" href="#/tasks/${t.id}">${t.title}</a><div class="small muted">Completed ${ago(t.completedAt)}</div></div><a class="btn small ghost" href="#/impact?new=1&taskId=${t.id}" title="Completion is not impact: record what changed">Record outcome</a></li>`)}</ul>`
      : html`<p class="small muted" style="margin:0">Nothing completed yet. Tasks you finish and your manager approves appear here.</p>`}</section>`
}

const VERIFY_PROV = { VERIFIED: () => prov('verified'), PENDING: () => prov('unverified', 'Awaiting verification'), REJECTED: () => html`<span class="badge bad">Not verified</span>` }
function contributionsCard(p, digest) {
  const highlights = failed(digest) ? [] : digest.value.highlights
  const has = highlights.length || p.impact.length || p.feedback.length
  return html`<section class="card" aria-labelledby="mat-h"><div class="card-head"><div><h2 id="mat-h"><span class="card-icon brand">${icon('award')}</span>Contributions that mattered</h2><p>What changed because of your work — and who has confirmed it.</p></div><a class="btn small subtle" href="#/contributions">Journeys${icon('arrowRight', 'sm')}</a></div>
    ${has ? html`<ul class="mini-list">
      ${highlights.map((h) => html`<li><span class="lead-icon brand">${icon('sparkles')}</span><div class="grow"><a class="ttl" href="${h.href}">${h.text}</a><div class="small muted">Today: ${h.why}</div></div>${prov('fact', 'Recorded')}</li>`)}
      ${p.impact.map((r) => html`<li><span class="lead-icon ok">${icon('award')}</span><div class="grow"><a class="ttl" href="#/impact/${r.id}">${r.title}</a><div class="small muted">${r.categoryLabel}</div></div>${(VERIFY_PROV[r.verificationStatus] || (() => verifyBadge(r.verificationStatus)))()}</li>`)}
      ${p.feedback.slice(0, 3).map((f) => html`<li><span class="lead-icon">${icon('message')}</span><div class="grow"><a class="ttl" href="${f.impactId ? `#/impact/${f.impactId}` : `#/tasks/${f.taskId}`}">${f.title}</a>
        <div class="small muted">${f.reviewer} ${['APPROVED', 'VERIFIED'].includes(f.decision) ? 'approved it' : 'asked for changes'}${f.comment ? ` — “${f.comment}”` : ''} · ${ago(f.createdAt)}</div></div></li>`)}
    </ul>` : empty('Your contributions will show here', 'When you deliver work and record what it changed, it appears here — verified by your manager, never ranked.', html`<a class="btn small ghost" href="#/impact?new=1">${icon('plus')}Record an outcome</a>`, 'award')}</section>`
}

function nextStepsCard(digest) {
  if (failed(digest) || !digest.value.missing.length) return ''
  return html`<section class="card" aria-labelledby="next-h"><div class="card-head"><div><h2 id="next-h"><span class="card-icon">${icon('help')}</span>Missing context</h2><p>Small additions that make your work visible.</p></div>${prov('missing', 'Not recorded yet')}</div>
    <ul class="mini-list">${digest.value.missing.map((m) => html`<li><div class="grow"><a class="ttl" href="${m.href}">${m.text}</a><div class="small muted">${m.action}</div></div></li>`)}</ul></section>`
}

function reflectionCard(p) {
  const saved = Boolean(p.reflection.savedAt)
  return html`<details class="card reflect" ${saved ? '' : raw('open')}><summary><div><h2 id="refl-h"><span class="card-icon">${icon('note')}</span>Daily reflection</h2><p class="small muted" style="margin:3px 0 0">Private to you. Five quick prompts — skip any.</p></div>
      <span class="row" style="gap:8px"><span class="small muted" id="refl-saved">${saved ? `Saved ${ago(p.reflection.savedAt)}` : ''}</span><span class="chev">${icon('chevronDown')}</span></span></summary>
    <form id="reflection" aria-labelledby="refl-h"><div class="form-error"></div><div class="reflect-grid">
      ${[['contribution', 'What was my most important contribution today?'], ['changeMade', 'What changed because of my work?'], ['blockedBy', 'What blocked me?'], ['learned', 'What did I learn?'], ['tomorrow', 'What will I focus on tomorrow?']].map(([k, label]) => html`<div class="field"><label for="r-${k}">${label}</label><textarea id="r-${k}" name="${k}" rows="2" maxlength="2000">${p.reflection[k]}</textarea></div>`)}</div>
      <button class="btn ghost" type="submit">Save reflection</button></form></details>`
}

// Position of a section when the overview collapses to one column (phones, narrow windows).
const o = (n, section) => (section ? html`<div style="--o:${n}">${section}</div>` : '')

async function renderEmployeeOverview(main, p) {
  const [tasks, digest, evidence] = await Promise.allSettled([
    api('/api/tasks?view=mine&status=ASSIGNED,IN_PROGRESS,BLOCKED,SUBMITTED_FOR_REVIEW'),
    api(`/api/assistant/day?tz=${tzMinutes()}`),
    api('/api/work-evidence?view=mine')
  ])
  const openTasks = failed(tasks) ? [] : tasks.value
  main.innerHTML = html`${hero(p, openTasks, p.awaitingMe.length + p.clarifications.length)}
    <div class="overview">
      <div class="col">${o(1, focusCard(digest))}${o(3, inProgressCard(tasks))}${o(6, contributionsCard(p, digest))}${o(8, completedCard(p))}</div>
      <div class="col">${o(2, attentionCard(p))}${o(4, evidenceCard(evidence))}${o(5, blockersCard(p))}${o(7, nextStepsCard(digest))}</div>
    </div>
    <div style="margin-top:16px">${reflectionCard(p)}</div>
    <p class="principle" style="margin-top:24px">${icon('heart')}<span>TeamPulse shows what your work achieved, not how busy you were. There are no scores, rankings or activity counts — and you can correct anything that is wrong.</span></p>`.toString()
  document.getElementById('new-task').addEventListener('click', () => openTaskForm())
  renderSignals(document.getElementById('my-signals'), { scope: 'mine', limit: 4 })
  bindReflection(p)
  main.querySelectorAll('[data-ev-act]').forEach((b) => b.addEventListener('click', async () => {
    const li = b.closest('[data-ev-link]')
    li.querySelectorAll('button').forEach((x) => { x.disabled = true })
    try {
      await api(`/api/work-evidence-links/${li.dataset.evLink}`, { method: 'POST', body: { action: b.dataset.evAct } })
      toast(b.dataset.evAct === 'CONFIRM' ? 'Linked — it now counts as part of that work.' : 'Removed the suggestion.')
      li.remove()
    } catch (e) { toast(errorText(e), { error: true }); li.querySelectorAll('button').forEach((x) => { x.disabled = false }) }
  }))
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
    <section class="card" style="margin-top:16px" aria-labelledby="nh-h"><div class="card-head"><div><h2 id="nh-h">People who may need help</h2><p>Signals per person — overdue, blocked, stalled or overloaded work. Not a performance ranking: blocked and external dependencies are reasons, not faults.</p></div></div>
      ${m.needsHelp.length ? html`<ul class="list">${m.needsHelp.map((p) => html`<li>${avatar(p.name, p.pictureUrl)}<div class="grow"><a href="#/team-tasks?assigneeId=${p.userId}"><b>${p.name}</b></a> <span class="small muted">${p.teamName || ''} · ${p.active} active</span>
        <div class="row" style="margin-top:4px">${p.reasons.map((r) => html`<span class="badge ${r.severity >= 3 ? 'bad' : r.severity === 2 ? 'warn' : 'outline'}">${r.text}</span>`)}</div></div></li>`)}</ul>`
        : empty('Nobody looks stuck', 'No one has overdue, blocked, stalled or unusually heavy work right now.')}
    </section>
    <section class="card" style="margin-top:16px" aria-labelledby="ca-h" id="contrib-dash"><div class="card-head"><div><h2 id="ca-h">Contribution analysis</h2><p>What people's work involved — complexity, quality, ownership and verified impact, with reasons. Not a ranking.</p></div><a class="btn small ghost" href="#/contribution">Open</a></div>
      <div class="loading">Loading…</div></section>
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
      ${stat('Completed', c.completed, { tone: 'ok', href: '#/my-tasks?status=COMPLETED' })}
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
      <section class="card"><div class="card-head"><h2>Recently completed</h2><a class="btn small ghost" href="#/my-tasks?status=COMPLETED">All completed</a></div>
        ${p.completed.length ? html`<ul class="list">${p.completed.map((t) => html`<li><div class="grow"><a href="#/tasks/${t.id}"><b>${t.title}</b></a><div class="small muted">completed ${ago(t.completedAt)}</div></div><a class="btn small ghost" href="#/impact?new=1&taskId=${t.id}" title="Completion is not impact: record what changed">Record outcome</a></li>`)}</ul>`
          : empty('Nothing completed yet', 'Tasks you finish and your manager approves appear here.')}
      </section>
      <section class="card"><div class="card-head"><h2>Recent feedback</h2></div>
        ${p.feedback.length ? html`<ul class="list">${p.feedback.map((f) => html`<li><div class="grow"><a href="${f.impactId ? `#/impact/${f.impactId}` : `#/tasks/${f.taskId}`}"><b>${f.title}</b></a>
          <div class="small"><span class="badge ${['APPROVED', 'VERIFIED'].includes(f.decision) ? 'ok' : 'warn'}">${f.decision.replace(/_/g, ' ').toLowerCase()}</span> ${f.reviewer} ${f.comment ? `— “${f.comment}”` : ''}</div><div class="small muted">${ago(f.createdAt)}</div></div></li>`)}</ul>`
          : empty('No feedback yet', 'Reviews of your work and impact appear here.')}
      </section>
    </div>
    <div class="grid two" style="margin-top:16px">
      <section class="card"><div class="card-head"><div><h2>My contributions and impact</h2><p>What changed because of your work</p></div><div class="row"><a class="btn small ghost" href="#/contribution/${app.me.id}">My contribution analysis</a><a class="btn small" href="#/impact?new=1">Record an outcome</a></div></div>
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

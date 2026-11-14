// Work Intelligence: the manager's view of what is happening across the team, who is working on what, where work is stuck and what has
// actually come out of it. The Team tab is people first (one row each, alphabetical, never ranked); the dimensions and evidence live in the contribution profile. Everything shown comes from /api/analytics/* (computed on the server from records the caller may see).
// Fairness is part of the design: people are listed alphabetically and never ranked, bars show the mix of task states and not volume,
// there is no score or grade, a deadline that is only suggested or proposed is never shown as confirmed, and missing data says so
// ("No activity recorded", "Not enough data") instead of showing a zero.
import { api, html, raw, errorText, dt, ago, icon, empty, loading, prioBadge, statusBadge, progressBar, stageBadge } from '../ui.js'
import { app } from '../app.js'

const PRIORITIES = [['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low'], ['UNRESOLVED', 'Not set']]
const COMPLEXITY = [['L1', 'L1'], ['L2', 'L2'], ['L3', 'L3'], ['L4', 'L4'], ['NOT_ASSESSED', 'Not assessed']]
const STATUSES = ['PENDING_ACCEPTANCE', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED', 'DECLINED']
const STATUS_TEXT = (s) => String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const ADVANCED = ['priority', 'complexity', 'status', 'deadline', 'outcome', 'workType']
const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['custom', 'Custom range']]
const DEFAULT_NOTES = ['Priority and deadlines are what managers expected. They are context for the work, never a performance score.', 'A missed deadline is shown with its context (approved changes, blockers); it is not counted against anyone.', 'Numbers of tasks are not a measure of contribution. Shared outcomes are counted once.']

const HEALTH = [
  ['ON_TRACK', 'onTrack', 'On track', 'Open, has a confirmed deadline, and is not overdue, blocked or at risk.'],
  ['AT_RISK', 'atRisk', 'At risk', 'Open and not yet overdue, but little time is left for the progress made (the app’s own at-risk rule).'],
  ['BLOCKED', 'blocked', 'Blocked', 'The task’s status is Blocked. A blocker can be outside the owner’s control.'],
  ['OVERDUE', 'overdue', 'Overdue', 'Open and past its confirmed deadline. Suggested or proposed deadlines are never counted.'],
  ['UNCONFIRMED_DEADLINE', 'unconfirmedDeadline', 'Deadline not confirmed', 'Open with no confirmed deadline, so it cannot be judged against one.']
]
const KPIS = [
  ['tasks', 'Total tasks', 'Every task in the selected period and filters that you are allowed to see.', 'all'],
  ['open', 'Active', 'Tasks that are not completed, cancelled or declined.', 'open'],
  ['completed', 'Completed', 'Tasks whose status is Completed.', 'ok'],
  ['blocked', 'Blocked', 'Tasks whose status is Blocked. A blocker can be outside the owner’s control.', 'warn'],
  ['atrisk', 'At risk', 'Open, not overdue, and little time left for the progress made (the app’s own at-risk rule). Needs a confirmed deadline.', 'warn'],
  ['overdue', 'Overdue', 'Open and past the confirmed deadline. Suggested or proposed deadlines are never counted.', 'bad']
]
const KPI_TEST = { tasks: () => true, open: (r) => r.health !== null, completed: (r) => r.status === 'COMPLETED', blocked: (r) => r.status === 'BLOCKED', atrisk: (r) => r.atRisk, overdue: (r) => r.overdue }
const GROUP_TEST = { completed: (r) => r.status === 'COMPLETED', inProgress: (r) => r.status === 'IN_PROGRESS', blocked: (r) => r.status === 'BLOCKED', other: (r) => !['COMPLETED', 'IN_PROGRESS', 'BLOCKED'].includes(r.status) }
const KIND = { OVERDUE: ['bad', 'Overdue'], REVIEW: ['info', 'Awaiting review'], CHANGE_REQUEST: ['info', 'Change request'], BLOCKED: ['warn', 'Blocked'], UNCONFIRMED: ['outline', 'Not confirmed'] }
const OUTCOME_CHIP = { VERIFIED: ['ok', 'Verified'], CLAIMED: ['outline', 'Claimed, not verified'] }
const PRIO_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const FIELD_LABEL = { priority: 'Priority', deadline: 'Deadline', expected_outcome: 'Expected outcome', complexity: 'Complexity expected', business_impact: 'Business impact', dependencies: 'Dependencies', success_criteria: 'Success criteria', context: 'Context', work_type: 'Work type', response_sla: 'Response target', factors: 'Priority factors', verified_incident: 'Verified incident' }
const SOURCE = { MANAGER: 'a manager', LEGACY: 'the existing record', EMPLOYEE: 'the person who created the task', SLACK_EXTRACTION: 'a Slack message', RECOMMENDATION: 'a priority recommendation', CHANGE_REQUEST: 'an approved change request', REQUEST_APPROVAL: 'an approved request' }
const CR_STATUS = { PENDING: ['info', 'Waiting for a manager'], APPROVED: ['ok', 'Approved'], REJECTED: ['bad', 'Not approved'], ANSWERED: ['ok', 'Answered'], WITHDRAWN: ['outline', 'Withdrawn'] }
const PAGE = 25

const n = (v) => Number(v || 0).toLocaleString()
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase())
const noActivity = html`<span class="muted">No activity recorded</span>`
const activity = (iso) => (iso ? html`<span title="${dt(iso)}">${ago(iso)}</span>` : noActivity)
const fieldText = (field, v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (field === 'deadline') return dt(v)
  if (field === 'priority') return (PRIORITIES.find(([k]) => k === v) || [0, v])[1]
  if (field === 'response_sla') return `${v.amount} ${String(v.unit).replace(/_/g, ' ')}`
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} ${x ?? '?'}`).join(', ')
  return String(v)
}
const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : '')

// ---------- the URL is the single source of truth for the server-side filters ----------
function rangeOf(q) {
  const r = q.get('range')
  if (r === 'custom' || (!r && (q.get('from') || q.get('to')))) return 'custom'
  return ['7', '30', '90'].includes(r) ? r : '90'
}
function serverParams(q, tab) {
  const p = new URLSearchParams()
  if (tab === 'task') return p
  const r = rangeOf(q)
  if (r === 'custom') {
    for (const k of ['from', 'to']) { const v = q.get(k); if (v) p.set(k, v.length === 10 ? `${v}${k === 'from' ? 'T00:00:00.000Z' : 'T23:59:59.000Z'}` : v) }
  } else if (r !== '90') {
    const to = new Date()
    p.set('to', to.toISOString()); p.set('from', new Date(to.getTime() - Number(r) * 86400000).toISOString())
  }
  for (const k of ADVANCED) if (q.get(k)) p.set(k, q.get(k))
  if (tab === 'team') for (const k of ['teamId', 'userId']) if (q.get(k)) p.set(k, q.get(k))
  return p
}
const hashFor = (q, over = {}) => {
  const u = new URLSearchParams(q)
  for (const [k, v] of Object.entries(over)) { if (v === null || v === undefined || v === '') u.delete(k); else u.set(k, v) }
  return `#/analytics?${u}`
}

// ---------- small visual building blocks (SVG / CSS, no chart dependency) ----------
function kpiRow(s, relabel = {}) {
  const val = { tasks: s.tasks, open: s.open, completed: s.completed, blocked: s.blocked, atrisk: s.atRisk, overdue: s.overdue }
  return html`<div class="wi-kpis" data-testid="analytics-summary" role="group" aria-label="Summary of tasks. Select a card to filter the task table.">${KPIS.map(([id, label, tip, tone]) => html`
    <div class="stat wi-kpi ${val[id] > 0 && ['warn', 'bad'].includes(tone) ? tone : ''}" data-testid="stat-${id}" data-kpi="${id}">
      <button type="button" class="wi-kpi-btn" data-testid="kpi-${id}" data-kpi-btn="${id}" title="${tip}" aria-pressed="false" aria-label="${relabel[id] || label}: ${val[id]}. ${tip} Select to filter the task table.">
        <span class="label">${relabel[id] || label}</span><span class="value">${n(val[id])}</span>
      </button>
    </div>`)}</div>`
}

function attentionList(a) {
  if (!a) return html`<p class="muted">Not enough data.</p>`
  const total = Object.values(a.totals).reduce((x, y) => x + y, 0)
  if (!total) return html`<p class="muted" data-testid="attention-list">Nothing needs attention right now.</p>`
  return html`<div data-testid="attention-list"><div class="row wi-chips">${Object.entries(KIND).filter(([k]) => a.totals[k]).map(([k, [tone, label]]) => html`<span class="badge ${tone}">${label} ${a.totals[k]}</span>`)}</div>
    <ul class="wi-attn">${a.items.map((i) => html`<li><span class="badge ${KIND[i.kind][0]}">${KIND[i.kind][1]}</span><div class="wi-attn-main"><a href="#/tasks/${i.taskId}">${i.title}</a><div class="small muted">${i.ownerName || 'Unassigned'} · ${i.issue}</div></div></li>`)}</ul>
    ${a.more ? html`<p class="small muted">+${a.more} more not shown. Use the filters or the task table to see them all.</p>` : ''}
    <p class="small muted">From current task data. Blocked work is context for you, not a fault of its owner.</p></div>`
}

function outcomesSection(o) {
  if (!o) return html`<p class="muted">Not enough data.</p>`
  return html`<div data-testid="outcomes-section"><div class="wi-counts"><div><span class="value">${n(o.verified)}</span><span class="label">Verified</span></div><div><span class="value">${n(o.claimed)}</span><span class="label">Claimed, awaiting verification</span></div><div><span class="value">${n(o.shared)}</span><span class="label">Shared (counted once)</span></div></div>
    ${o.items.length ? html`<ul class="wi-outcomes">${o.items.map((i) => html`<li><div class="wi-attn-main"><a href="#/impact/${i.id}">${i.title}</a><div class="small muted">${i.category}${i.people.length ? ` · ${i.people.join(', ')}` : ''} · <a href="#/tasks/${i.taskId}">${i.taskTitle}</a></div></div><span class="row nowrap">${i.shared ? html`<span class="badge outline" title="Several people recorded this outcome; it counts once.">Shared</span>` : ''}<span class="badge ${OUTCOME_CHIP[i.state][0]}">${OUTCOME_CHIP[i.state][1]}</span></span></li>`)}</ul>` : html`<p class="muted">No outcomes are recorded for these filters.</p>`}
    <p class="small muted wi-caption">A claimed outcome is not verified until a manager confirms it. A shared outcome counts once for the team however many people recorded it. Outcomes are never turned into a score or a money value.</p></div>`
}

const distBars = (obj, order, total) => html`<ul class="wi-dist">${order.map(([k, l]) => html`<li><span class="small">${l}</span><span class="wi-track"><span style="width:${total ? ((obj[k] || 0) / total) * 100 : 0}%"></span></span><b class="small">${n(obj[k])}</b></li>`)}</ul>`

// ---------- the task table: sortable, paged, filtered by clicks on the charts above ----------
const COLS = [
  ['title', 'Task', (r) => r.title.toLowerCase()], ['owner', 'Owner', (r) => (r.assigneeName || '~').toLowerCase()], ['status', 'Status', (r) => r.status], ['priority', 'Priority', (r) => PRIO_RANK[r.priority] ?? 9],
  ['deadline', 'Deadline', (r) => r.deadline || '~'], ['expected', 'Expected complexity', (r) => r.complexityExpectation || '~'], ['observed', 'Observed complexity', (r) => r.observedComplexity || '~'],
  ['outcome', 'Outcome', (r) => ({ VERIFIED: 0, CLAIMED: 1, NONE: 2 })[r.outcome]], ['activity', 'Last meaningful activity', (r) => r.lastMeaningfulAt || '']
]
function taskRow(r, showOwner) {
  return html`<tr class="clickable" data-task="${r.id}" data-href="#/analytics?tab=task&taskId=${r.id}">
    <td><a href="#/analytics?tab=task&taskId=${r.id}" title="Task analytics">${r.title}</a> <a class="small muted" href="#/tasks/${r.id}" aria-label="Open the task ${r.title}">Open task</a></td>
    ${showOwner ? html`<td>${r.assigneeName || html`<span class="muted">Unassigned</span>`}</td>` : ''}<td>${statusBadge(r.status)}</td><td>${r.priority ? prioBadge(r.priority) : html`<span class="muted">Not set</span>`}</td>
    <td>${r.deadline ? html`${dt(r.deadline)}${r.overdue ? html` <span class="badge bad">Overdue</span>` : ''}` : html`<span class="muted">${r.deadlineState === 'UNCONFIRMED' ? 'Unconfirmed' : 'Not set'}</span>`}${r.missedDeadline ? html` <span class="badge outline">Finished after the deadline</span>` : ''}</td>
    <td>${r.complexityExpectation || html`<span class="muted">Not assessed</span>`}</td><td>${r.observedComplexity || html`<span class="muted">Not assessed</span>`}</td>
    <td>${r.outcome === 'VERIFIED' ? html`<span class="badge ok">Verified</span>` : r.outcome === 'CLAIMED' ? html`<span class="badge outline">Claimed</span>` : html`<span class="muted">None recorded</span>`}</td><td>${activity(r.lastMeaningfulAt)}</td></tr>`
}
function mountTable(host, rows, { showOwner = true, total = rows.length, truncated = false } = {}) {
  const st = { filter: null, sort: null, page: 0 }
  const cols = COLS.filter(([k]) => showOwner || k !== 'owner')
  const paint = () => {
    let list = rows.filter((r) => (st.filter ? st.filter.test(r) : true))
    if (st.sort) { const c = COLS.find(([k]) => k === st.sort.key)[2]; list = list.slice().sort((a, b) => { const x = c(a); const y = c(b); return (x < y ? -1 : x > y ? 1 : 0) * st.sort.dir }) }
    const pages = Math.max(1, Math.ceil(list.length / PAGE))
    st.page = Math.min(st.page, pages - 1)
    const slice = list.slice(st.page * PAGE, st.page * PAGE + PAGE)
    host.innerHTML = html`<div class="row between wi-table-head"><h2 class="wi-h">Tasks <span class="small muted">(${n(list.length)}${st.filter ? ` of ${n(rows.length)}` : ''}${truncated ? `; the newest ${n(rows.length)} of ${n(total)} are loaded` : ''})</span></h2>
      ${st.filter ? html`<span class="chip wi-chip" data-testid="filter-chip">Filtered by: ${st.filter.label} <button type="button" class="wi-x" data-clear aria-label="Clear the table filter">${raw('&times;')}</button></span>` : ''}</div>
      ${list.length ? html`<div class="table-wrap"><table class="task-table" data-testid="analytics-tasks"><thead><tr>${cols.map(([k, l]) => html`<th scope="col" aria-sort="${st.sort?.key === k ? (st.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="wi-sort" data-sort="${k}">${l}${st.sort?.key === k ? (st.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`)}</tr></thead><tbody>${slice.map((r) => taskRow(r, showOwner))}</tbody></table></div>
      ${pages > 1 ? html`<div class="row between wi-pager"><span class="small muted">Page ${st.page + 1} of ${pages}</span><span class="row"><button type="button" class="btn small ghost" data-page="-1" ${st.page === 0 ? raw('disabled') : ''}>Previous</button><button type="button" class="btn small ghost" data-page="1" ${st.page >= pages - 1 ? raw('disabled') : ''}>Next</button></span></div>` : ''}` : empty('No tasks match', st.filter ? 'Clear the table filter to see every task again.' : 'No tasks match the current filters.', st.filter ? html`<button type="button" class="btn small" data-clear>Clear filter</button>` : '')}`.toString()
    host.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => ctl.setFilter(null)))
    host.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.sort; st.sort = st.sort?.key === k ? { key: k, dir: -st.sort.dir } : { key: k, dir: 1 }; st.page = 0; paint() }))
    host.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { st.page += Number(b.dataset.page); paint() }))
    host.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) location.hash = tr.dataset.href }))
    host.closest('main')?.querySelectorAll('[data-kpi-btn]').forEach((b) => b.setAttribute('aria-pressed', String(st.filter?.kpi === b.dataset.kpiBtn)))
  }
  const ctl = { setFilter(f, { scroll = true } = {}) { st.filter = f; st.page = 0; paint(); if (f && scroll) host.scrollIntoView({ block: 'start' }) } }
  paint()
  return ctl
}

// ---------- the three views ----------
function bindFilters(main, ctl, { showOwner }) {
  const set = (f) => ctl.setFilter(f)
  main.querySelectorAll('[data-kpi-btn]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.kpiBtn
    set(id === 'tasks' ? null : { kpi: id, label: KPIS.find(([k]) => k === id)[1], test: KPI_TEST[id] })
  }))
  main.querySelectorAll('[data-health]').forEach((b) => b.addEventListener('click', () => set({ label: b.dataset.label, test: (r) => r.health === b.dataset.health })))
  if (showOwner) {
    main.querySelectorAll('.wi-bar [data-group]').forEach((b) => b.addEventListener('click', () => {
      const owner = b.dataset.owner; const g = GROUP_TEST[b.dataset.group]
      set({ label: b.dataset.label, test: (r) => (owner === 'none' ? !r.assigneeId : r.assigneeId === owner) && g(r) })
    }))
  }
}

const card = (id, title, sub, body, extra = '') => html`<section class="card wi-card ${extra}" aria-labelledby="wi-${id}"><div class="card-head"><div><h2 id="wi-${id}">${title}</h2>${sub ? html`<p>${sub}</p>` : ''}</div></div>${body}</section>`

// ---------- the Team tab: people and their work ----------
const WORK_RANK = (r) => (r.overdue || r.status === 'BLOCKED' ? 0 : r.status === 'IN_PROGRESS' ? 1 : r.status === 'SUBMITTED_FOR_REVIEW' ? 2 : r.status === 'ASSIGNED' ? 3 : 4)
const needsAttention = (r) => r.overdue || r.status === 'BLOCKED' || r.status === 'SUBMITTED_FOR_REVIEW'
const profileHref = (id, from = 'analytics') => (from ? `#/contribution/${id}?from=${from}` : `#/contribution/${id}`)
const dayText = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** One task: title (a link to the existing task page), then status and confirmed-deadline context. Overdue and blocked are context, not a verdict on the person. */
function workLine(r, { detail = false } = {}) {
  const deadline = r.deadline ? html`<span class="${r.overdue ? 'wi-late' : ''}">${r.overdue ? 'Overdue · ' : 'Due '}${dayText(r.deadline)}</span>` : r.deadlineState === 'UNCONFIRMED' ? html`<span class="muted">Deadline not confirmed</span>` : ''
  return html`<div class="wi-task"><a class="wi-ttl" href="#/tasks/${r.id}">${r.title}</a>
    <div class="wi-sub"><span>${STATUS_TEXT(r.status)}</span>${deadline}${r.priority ? prioBadge(r.priority) : ''}${detail && r.progress > 0 ? html`<span class="muted">Progress ${r.progress}%</span>` : ''}${r.status === 'BLOCKED' ? html`<span class="muted" title="A blocker is context for the manager, not a fault of the owner.">Blocker open</span>` : ''}</div></div>`
}

export function peopleList(d, { from = 'analytics', contributions = false } = {}) {
  const open = (r) => r.health !== null
  const rows = d.people.map((p) => ({ id: p.userId, name: p.name, team: p.team, p, tasks: d.tasks.filter((r) => r.assigneeId === p.userId) }))
  const u = d.unassigned
  if (u?.tasks) rows.push({ id: null, name: 'Unassigned work', team: null, p: { open: u.open, completed: u.completed, blocked: u.blocked, lastMeaningfulAt: null }, tasks: d.tasks.filter((r) => !r.assigneeId) })
  if (!rows.length) return html`<p class="muted">Not enough data: nobody has tasks in this period.</p>`
  const li = (r) => {
    const cur = r.tasks.filter(open).sort((a, b) => WORK_RANK(a) - WORK_RANK(b) || String(a.deadline || '~').localeCompare(String(b.deadline || '~')))
    const flags = [cur.some((t) => t.status === 'IN_PROGRESS') && 'progress', r.p.completed > 0 && 'completed', cur.some(needsAttention) && 'attention'].filter(Boolean).join(' ')
    return html`<li class="wi-row" data-person-row data-flags="${flags}">
      <div class="wi-c-who">${r.id ? html`<a class="wi-pname" href="${profileHref(r.id, from)}" data-person="${r.id}" title="Open ${r.name}’s contribution profile">${r.name}</a>` : html`<span class="wi-pname muted">${r.name}</span>`}${r.team ? html`<div class="small muted">${r.team}</div>` : ''}</div>
      <div class="wi-c-work" data-label="Current work">${cur.length ? html`${workLine(cur[0], { detail: true })}${cur.length > 1 ? html`<details class="wi-more"><summary>+${cur.length - 1} more task${cur.length > 2 ? 's' : ''}</summary>${cur.slice(1).map((t) => workLine(t))}</details>` : ''}` : html`<span class="muted">No open work</span>`}</div>
      <div class="wi-c-load small" data-label="Workload"><b>${n(r.p.open)}</b> active · <b>${n(r.p.completed)}</b> completed${r.p.blocked ? html` · <b>${n(r.p.blocked)}</b> blocked` : ''}</div>
      <div class="wi-c-act small" data-label="Latest meaningful activity">${r.id ? activity(r.p.lastMeaningfulAt) : html`<span class="muted">—</span>`}</div>
      <div class="wi-c-assess small" data-label="Contribution assessment">${r.id ? html`<span data-assess="${r.id}" class="muted">Reading the assessments…</span><div class="wi-contribs" data-contribs="${r.id}"></div><a class="wi-profile-link" href="${profileHref(r.id, from)}">View contribution profile ${icon('arrowRight', 'xs')}</a>` : html`<span class="muted">Needs an owner</span>`}</div></li>`
  }
  return html`<ul class="wi-people-list" data-testid="people-list" aria-label="People and their work, alphabetical">
    <li class="wi-row wi-head" aria-hidden="true"><div>Employee</div><div>Current work</div><div>Workload</div><div>Latest meaningful activity</div><div>${contributions ? 'Contributions' : 'Contribution assessment'}</div></li>${rows.map(li)}</ul>
    <p class="small muted wi-caption wi-empty-filter" hidden>No one matches this view.</p>`
}

/** The short assessment status per person, from the existing contribution overview. The detail (dimensions, evidence, corrections) lives in the profile. */
export async function fillAssessments(host, d, { analysis = true } = {}) {
  const q = new URLSearchParams({ from: d.period.from, to: d.period.to })
  let team
  try { team = await api(`/api/contribution/team?${q}`) } catch { host.querySelectorAll('[data-assess]').forEach((el) => { el.textContent = 'Assessment status unavailable' }); return }
  if (!host.isConnected) return
  const aiOff = app.session?.integrations?.ai === 'not_configured'
  for (const x of team.people) {
    const el = host.querySelector(`[data-assess="${x.userId}"]`)
    if (!el) continue
    const m = x.complexityMix || {}
    const levels = ['L4', 'L3', 'L2', 'L1'].filter((k) => m[k])
    const bits = []
    if (analysis && levels.length) bits.push(html`<span class="wi-lv">${levels.map((k) => html`<span class="badge ${k === 'L4' || k === 'L3' ? 'brand' : 'outline'}" title="Complexity assessed from the work and its evidence">${m[k]}× ${k}</span>`)}</span>`.toString())
    if (x.awaitingYourReview) bits.push(html`<span class="badge warn" title="Meaningful contributions waiting for your decision">${x.awaitingYourReview} awaiting your review</span>`.toString())
    if (x.approved) bits.push(html`<span class="badge ok" title="Assessments a manager approved or adjusted">${x.approved} approved</span>`.toString())
    if (x.verifiedOutcomes) bits.push(html`<span class="badge ok" title="Outcomes a manager verified">${x.verifiedOutcomes} verified outcome${x.verifiedOutcomes === 1 ? '' : 's'}</span>`.toString())
    if (x.disputes) bits.push(html`<span class="badge warn">${x.disputes} disputed by them</span>`.toString())
    const quiet = analysis ? [x.routine && `${x.routine} routine`, x.notEnoughEvidence && `${x.notEnoughEvidence} without enough evidence`].filter(Boolean) : []
    el.className = ''
    el.innerHTML = (bits.length ? bits.join(' ') : html`<span class="muted">${aiOff && !x.analysed ? 'AI assessment is not switched on yet' : 'Not enough evidence yet'}</span>`.toString())
      + (quiet.length ? html`<div class="muted">${quiet.join(' · ')}</div>`.toString() : '')
  }
  host.querySelectorAll('[data-assess].muted').forEach((el) => { if (el.textContent.startsWith('Reading')) el.textContent = aiOff ? 'AI assessment is not switched on yet' : 'Not enough evidence yet' })
  // Recorded contributions: the latest two per person with where each stands; how many still wait for a manager. A claim is never shown as verified.
  try {
    const list = await api(`/api/impact?${q}`)
    if (!host.isConnected) return
    const by = new Map()
    for (const c of list) { if (!by.has(c.userId)) by.set(c.userId, []); by.get(c.userId).push(c) }
    for (const [uid, items] of by) {
      const el = host.querySelector(`[data-contribs="${uid}"]`)
      if (!el) continue
      const waiting = items.filter((c) => c.stage === 'CLAIMED' || c.stage === 'SUPPORTED').length
      el.innerHTML = html`${items.slice(0, 2).map((c) => html`<div class="wi-contrib"><a href="#/impact/${c.id}" title="${c.title}">${c.title}</a> ${stageBadge(c)}</div>`)}${waiting ? html`<div class="small muted">${waiting} awaiting your review</div>` : ''}`.toString()
    }
  } catch { /* contributions are an extra here; the profile has them */ }
}

/** Verified outcomes only, briefly; claimed ones are a count, never mixed in. */
function teamOutcomes(o) {
  if (!o) return html`<p class="muted">Not enough data.</p>`
  const verified = o.items.filter((i) => i.state === 'VERIFIED')
  return html`<div data-testid="outcomes-section"><p class="small muted wi-oc-sum"><b>${n(o.verified)}</b> verified${o.claimed ? html` · ${n(o.claimed)} claimed, awaiting verification` : ''}</p>
    ${verified.length ? html`<ul class="wi-outcomes">${verified.map((i) => html`<li><div class="wi-attn-main"><a href="#/impact/${i.id}">${i.title}</a><div class="small muted">${i.category}${i.people.length ? ` · ${i.people.join(', ')}` : ''} · <a href="${i.taskId ? `#/tasks/${i.taskId}` : `#/impact/${i.id}`}">${i.taskId ? 'Task and evidence' : 'Contribution and evidence'}</a></div></div><span class="row nowrap">${i.shared ? html`<span class="badge outline" title="Several people recorded this outcome; it counts once.">Shared</span>` : ''}<span class="badge ok">Verified</span></span></li>`)}</ul>` : html`<p class="muted">No verified outcomes yet.</p>`}</div>`
}

function teamView(main, d) {
  const s = d.summary
  if (!s.tasks) return html`<div data-testid="analytics-empty">${empty('No tasks match these filters', 'Nothing was created, worked on or completed in this period for the people you manage. Try a longer date range or reset the filters.', html`<a class="btn small ghost" href="#/analytics">Reset filters</a>`, 'trending')}</div>`
  return html`<div class="wi-team">
    <p class="small muted wi-caption" data-testid="wi-people-link">Who is doing what, current tasks and progress, what is blocked and what awaits review are on <a href="#/contribution">People</a>. This page is about what the work involved and what the evidence says.</p>
    <div id="wi-patterns" data-testid="wi-patterns"><div class="loading">Reading the assessments…</div></div>
    <section class="wi-sec" aria-labelledby="wi-out"><h2 id="wi-out">What the evidence says: verified outcomes</h2>${teamOutcomes(d.outcomeList)}</section></div>`
}

/** Pooled patterns of the team's assessments: complexity, assessed dimensions, change over time. Never per person, never a ranking. */
async function fillPatterns(host, d) {
  const box = host.querySelector('#wi-patterns')
  if (!box) return
  const q = new URLSearchParams({ from: d.period.from, to: d.period.to })
  let t
  try { t = await api(`/api/contribution/team?${q}`) } catch (e) { if (box.isConnected) box.innerHTML = html`<p class="muted">Could not load the assessments: ${errorText(e)}</p>`.toString(); return }
  if (!box.isConnected) return
  const pt = t.patterns
  const aiOff = app.session?.integrations?.ai === 'not_configured'
  if (!pt || !pt.assessments) {
    box.innerHTML = html`<section class="wi-sec"><h2>What the work involved</h2><p class="muted" style="margin:10px 0 0">${aiOff ? 'AI assessment is not switched on yet, so nothing has been assessed and nothing is estimated.' : 'No assessments in this period yet. Submitted tasks are assessed automatically; work submitted earlier can be started from Reviews → Not yet assessed.'}</p></section>`.toString()
    return
  }
  const mix = pt.complexityMix
  const total = ['L1', 'L2', 'L3', 'L4'].reduce((a, k) => a + mix[k], 0)
  const levelText = { L1: 'Simple', L2: 'Moderate', L3: 'Complex', L4: 'Very complex' }
  const dimOrder = Object.entries(pt.dimensions)
  const range = (w) => `${dayText(w.from)} – ${dayText(w.to)}`
  box.innerHTML = html`
    <section class="wi-sec" aria-labelledby="wi-cx" data-testid="wi-complexity"><h2 id="wi-cx">How complex the work was</h2>
      <p class="small muted wi-caption">Assessed from the work and its evidence, pooled for the team in this period.${mix.insufficient ? ` ${n(mix.insufficient)} could not be judged (not enough evidence), which says nothing about the work.` : ''}</p>
      ${distBars(mix, ['L4', 'L3', 'L2', 'L1'].map((k) => [k, `${k} · ${levelText[k]}`]), total)}</section>
    <section class="wi-sec" aria-labelledby="wi-dim" data-testid="wi-dimensions"><h2 id="wi-dim">Assessment dimensions</h2>
      <p class="small muted wi-caption">How the assessed work was rated on each dimension. Counts of assessments, not scores for people.</p>
      <div class="wi-dims">${dimOrder.map(([, x]) => html`<div class="wi-dim"><h3 class="wi-h3">${x.label}</h3>${x.assessed ? distBars(x.levels, [5, 4, 3, 2, 1].map((l) => [l, `Level ${l}`]), x.assessed) : html`<p class="small muted">Nothing assessed on this yet.</p>`}${x.insufficient ? html`<p class="small muted">${n(x.insufficient)} without enough evidence</p>` : ''}</div>`)}</div></section>
    <section class="wi-sec" aria-labelledby="wi-time" data-testid="wi-over-time"><h2 id="wi-time">How contribution changed over time</h2>
      <p class="small muted wi-caption">Three equal periods ending now. “Meaningful” is the work that reached your review; routine work and work without enough evidence are recorded but not queued.</p>
      <div class="table-wrap"><table class="wi-table"><thead><tr><th scope="col">Period</th><th scope="col">Assessed</th><th scope="col">Meaningful</th><th scope="col">Approved by a manager</th><th scope="col">Complex or very complex</th><th scope="col">Not enough evidence</th></tr></thead>
        <tbody>${pt.overTime.map((w, i) => html`<tr${i === pt.overTime.length - 1 ? raw(' aria-current="true"') : ''}><th scope="row">${range(w)}${i === pt.overTime.length - 1 ? ' (this period)' : ''}</th><td>${n(w.assessments)}</td><td>${n(w.meaningful)}</td><td>${n(w.approved)}</td><td>${n(w.complexityMix.L3 + w.complexityMix.L4)}</td><td>${n(w.notEnoughEvidence)}</td></tr>`)}</tbody></table></div></section>`.toString()
}

function personView(main, d) {
  const s = d.summary
  const mix = d.measurement?.complexityMix || {}
  const open = d.tasks.filter((r) => r.blockers.open > 0)
  const complexity = html`<div class="grid two"><div><h3 class="wi-h3">Expected by the manager</h3>${distBars(s.byComplexityExpectation, COMPLEXITY, s.tasks)}</div><div><h3 class="wi-h3">Observed in the work</h3>${distBars(s.byObservedComplexity, COMPLEXITY, s.tasks)}</div></div>
    <p class="small muted wi-caption">Observed complexity comes from analyses of the actual work and its evidence${mix.insufficient ? `; ${mix.insufficient} piece(s) of work did not have enough evidence to judge` : ''}. Expected complexity is the manager’s estimate. Neither is a score.</p>`
  const context = html`<dl class="kv"><dt>Deadline confirmed</dt><dd>${n(s.deadlines.confirmed)}</dd><dt>Not confirmed</dt><dd>${n(s.deadlines.notConfirmed)}</dd><dt>Finished by the deadline</dt><dd>${n(s.deadlines.met)}</dd><dt>Finished after it</dt><dd>${n(s.deadlines.missed)}</dd><dt>Overdue now</dt><dd>${n(s.deadlines.overdueNow)}</dd></dl>
    <p class="small muted wi-caption">Deadlines are context for the work. A date that moved through an approved change, or a blocker outside the person’s control, is not a mark against them.</p>`
  const changes = html`<dl class="kv"><dt>Deadlines changed</dt><dd>${n(s.changes.deadlineChanged)}</dd><dt>Priorities changed</dt><dd>${n(s.changes.priorityChanged)}</dd><dt>Tasks with changes</dt><dd>${n(s.changes.tasksWithChanges)}</dd><dt>Change requests</dt><dd>${n(s.changes.requests)}${s.changes.pendingRequests ? ` (${s.changes.pendingRequests} waiting)` : ''}</dd></dl>`
  const blockers = open.length ? html`<ul class="wi-attn">${open.map((r) => html`<li><span class="badge warn">${r.blockers.open} open</span><div class="wi-attn-main"><a href="#/tasks/${r.id}">${r.title}</a><div class="small muted">${r.blockers.total} blocker${r.blockers.total === 1 ? '' : 's'} reported in total</div></div></li>`)}</ul>` : html`<p class="muted">No open blockers on this person’s tasks.</p>`
  const recent = d.recent?.length ? html`<ul class="wi-attn">${d.recent.map((r) => html`<li>${statusBadge(r.status)}<div class="wi-attn-main"><a href="#/tasks/${r.id}">${r.title}</a><div class="small muted">${r.at ? html`Last meaningful activity ${ago(r.at)}` : html`No activity recorded · created ${ago(r.createdAt)}`}</div></div></li>`)}</ul>` : html`<p class="muted">Not enough data: no tasks in this period.</p>`
  return html`<section class="card wi-profile" data-testid="person-measure"><h2 class="wi-h">${d.person.name}</h2><p class="small muted">${[d.person.team, cap(d.person.role), d.person.title].filter(Boolean).join(' · ')}${d.viewingOwn ? ' · Your own profile' : ''}</p>${d.measurement?.narrative ? html`<p class="small">${d.measurement.narrative}</p>` : ''}<p class="small muted">There is no score or ranking here: review complexity, evidence, ownership and outcomes together.</p></section>
    ${s.tasks ? html`${kpiRow(s, { tasks: 'Assigned', open: 'Active' })}
    <div class="wi-grid">
      ${card('complexity', 'Complexity', 'What the work involved.', complexity, 'wi-wide')}
      ${card('outcomes', 'Verified outcomes', 'Evidence-backed results from this person’s work.', outcomesSection(d.outcomeList), 'wi-wide')}
      ${card('deadlines', 'Deadline context', '', context)}
      ${card('changes', 'Changes in scope or expectations', '', changes)}
      ${card('blockers', 'Blockers and dependencies', 'Often outside the person’s control.', blockers)}
      ${card('recent', 'Recent task activity', '', recent)}
      ${d.attention?.items?.length ? card('attention', 'Needs attention', '', attentionList(d.attention), 'wi-wide') : ''}
    </div>
    <section class="wi-tasks" data-testid="task-table" data-host="table" aria-label="Tasks"></section>` : html`<div data-testid="analytics-empty">${empty('No tasks in this period', 'This person has no tasks matching the filters. Try a longer date range or reset the filters.', html`<a class="btn small" href="#/analytics?tab=person&userId=${d.person.id}">Reset filters</a>`, 'trending')}</div>`}`
}

function taskView(d) {
  const r = d.task
  const o = d.original || {}
  const cur = d.current
  const health = r?.health ? HEALTH.find(([k]) => k === r.health) : null
  const side = (title, testid, vals) => html`<section class="card wi-card" data-testid="${testid}"><div class="card-head"><div><h2 class="wi-h">${title}</h2></div></div><dl class="kv">${vals.map(([l, v]) => html`<dt>${l}</dt><dd>${v}</dd>`)}</dl></section>`
  const original = side('Original expectations', 'task-original', [['Priority', o.priority ? fieldText('priority', o.priority) : 'Not set at the start'], ['Deadline', o.deadline ? fieldText('deadline', o.deadline) : 'Not set at the start'], ['Expected outcome', o.expected_outcome || '—'], ['Complexity expected', o.complexity || '—'], ['Work type', o.work_type || '—']])
  const now = side('Current confirmed expectations', 'task-current', [['Priority', cur.priority ? fieldText('priority', cur.priority) : 'Not set'], ['Deadline', cur.deadline ? fieldText('deadline', cur.deadline) : 'Not confirmed'], ['Expected outcome', cur.expectedOutcome || '—'], ['Complexity expected', r?.complexityExpectation || '—'], ['Work type', r?.workType || '—']])
  const sugg = d.suggestions?.length ? html`<ul class="wi-attn">${d.suggestions.map((x) => html`<li><span class="badge warn">${x.status === 'PROPOSED' ? 'Proposed' : 'Suggested'}</span><div class="wi-attn-main"><b>${FIELD_LABEL[x.field] || x.field}:</b> ${fieldText(x.field, x.value)}<div class="small muted">From ${SOURCE[x.source] || String(x.source).toLowerCase().replace(/_/g, ' ')}${x.confidence ? ` · ${String(x.confidence).toLowerCase()} confidence` : ''} · not confirmed, so it is not an expectation yet</div></div></li>`)}</ul>` : html`<p class="muted">No suggestions or proposals are waiting.</p>`
  const hist = d.history.length ? html`<ul class="timeline" data-testid="task-history">${d.history.map((e) => html`<li class="${e.status === 'REJECTED' ? 'wi-rej' : ''}"><div><b>${e.actorName || 'System'}</b> ${e.status === 'SUGGESTED' ? 'suggested' : e.status === 'PROPOSED' ? 'proposed' : e.status === 'REJECTED' ? 'rejected a suggestion for' : e.kind === 'CONFIRM' ? 'confirmed' : 'changed'} ${(FIELD_LABEL[e.field] || e.field).toLowerCase()}${e.status === 'CONFIRMED' && e.oldValue !== null && e.oldValue !== undefined ? html` from ${fieldText(e.field, e.oldValue)}` : ''} ${e.status === 'REJECTED' ? '' : html`to <b>${fieldText(e.field, e.value)}</b>`} ${e.status === 'SUGGESTED' || e.status === 'PROPOSED' ? html`<span class="badge warn">Not confirmed</span>` : ''}</div><div class="when">${dt(e.at)} · ${SOURCE[e.source] || String(e.source).toLowerCase().replace(/_/g, ' ')}${e.reason ? ` · “${e.reason}”` : ''}</div></li>`)}</ul>` : html`<ul class="timeline" data-testid="task-history"><li class="muted">No expectation history yet.</li></ul>`
  const reqs = d.changeRequests.length ? html`<ul class="wi-attn">${d.changeRequests.map((c) => html`<li><span class="badge ${(CR_STATUS[c.status] || CR_STATUS.PENDING)[0]}">${(CR_STATUS[c.status] || CR_STATUS.PENDING)[1]}</span><div class="wi-attn-main"><b>${c.requestedBy}</b> asked for ${String(c.kind).toLowerCase()} change<div class="small muted">${c.reason}${c.decisionNote ? ` · ${c.decidedBy || 'A manager'}: ${c.decisionNote}` : ''}</div></div></li>`)}</ul>` : html`<p class="muted">No change requests.</p>`
  const blockers = d.blockers.length ? html`<ul class="wi-attn">${d.blockers.map((b) => html`<li><span class="badge ${b.status === 'OPEN' ? 'warn' : 'ok'}">${b.status === 'OPEN' ? 'Open' : 'Resolved'}</span><div class="wi-attn-main">${b.description}<div class="small muted">Reported ${ago(b.reported_at)}${b.resolved_at ? ` · resolved ${ago(b.resolved_at)}` : ''}</div></div></li>`)}</ul>` : html`<p class="muted">No blockers reported.</p>`
  const outcomes = d.outcomes.length ? html`<ul class="wi-attn">${d.outcomes.map((x) => html`<li><span class="badge ${x.state === 'VERIFIED' ? 'ok' : 'outline'}">${x.state === 'VERIFIED' ? 'Verified' : x.state === 'PENDING' ? 'Claimed, not verified' : cap(String(x.state).toLowerCase())}</span><div class="wi-attn-main"><a href="#/impact/${x.id}">${x.title}</a><div class="small muted">${x.category}${x.shared ? ' · shared outcome' : ''}</div></div></li>`)}</ul>` : html`<p class="muted">No outcomes recorded for this task.</p>`
  const journey = d.journey?.steps?.length ? html`<ol class="plain-ol small">${d.journey.steps.slice(0, 8).map((x) => html`<li>${x.title || x.stage}${x.at ? html` <span class="muted">· ${ago(x.at)}</span>` : ''}</li>`)}</ol>${d.journey.steps.length > 8 ? html`<p class="small muted">${d.journey.steps.length - 8} more steps in the full journey.</p>` : ''}` : html`<p class="muted">Not enough data.</p>`
  return html`<section class="card wi-profile" data-testid="task-analytics"><div class="row between"><h2 class="wi-h"><a href="#/tasks/${r?.id}">${r?.title || 'Task'}</a></h2>${r ? html`<span class="row">${statusBadge(r.status)} ${r.priority ? prioBadge(r.priority) : html`<span class="badge outline">Priority not set</span>`} ${health ? html`<span class="badge outline" title="${health[3]}">${health[2]}</span>` : ''}</span>` : ''}</div>
      <div class="wi-facts"><div><span class="label">Owner</span><b>${d.owner?.name || 'Unassigned'}</b></div><div><span class="label">Contributors</span><b>${d.contributors.length ? d.contributors.map((c) => `${c.name} (${c.role})`).join(', ') : 'None recorded'}</b></div><div><span class="label">Progress</span><div class="wi-prog">${progressBar(d.progress ?? 0)}<b>${d.progress ?? 0}%</b></div></div><div><span class="label">Evidence attached</span><b>${n(d.evidenceCount)}</b></div><div><span class="label">Last meaningful activity</span><b>${activity(d.lastMeaningfulAt)}</b></div></div>
      ${r ? html`<p class="small muted">Priority changed ${r.priorityChanges}×, deadline changed ${r.deadlineChanges}×, ${r.changeRequests} change request(s). A change by a manager or through an approved request is context, not a mark against anyone.</p>` : ''}</section>
    <div class="grid two wi-gap">${original}${now}</div>
    <div class="wi-grid">
      ${card('suggestions', 'Suggestions and proposals', 'Not confirmed: they are never shown as the current value.', sugg)}
      ${card('requests', 'Change requests', '', reqs)}
      ${card('history', 'Change history', 'Every confirmation, suggestion and change, with who and why.', hist, 'wi-wide')}
      ${card('deadline', 'Deadline context', '', html`<dl class="kv"><dt>Original deadline</dt><dd>${o.deadline ? dt(o.deadline) : 'None at the start'}</dd><dt>Current deadline</dt><dd>${cur.deadline ? dt(cur.deadline) : 'Not confirmed'}</dd><dt>Finished</dt><dd>${r?.completedAt ? `${dt(r.completedAt)}${r.missedDeadline ? ' (after the deadline)' : r.metDeadline ? ' (by the deadline)' : ''}` : 'Not yet'}</dd></dl><p class="small muted wi-caption">Context for the work, not a mark against anyone.</p>`)}
      ${card('blockers', 'Blockers', 'Often outside the owner’s control.', blockers)}
      ${card('outcomes', 'Outcome', 'Verified means a manager confirmed it.', outcomes)}
      ${card('journey', 'Journey', 'How the work moved.', journey)}
    </div>`
}

// ---------- the page ----------
export async function renderAnalytics(main, q) {
  const manager = app.isManager
  const tab = manager ? (['team', 'person', 'task'].includes(q.get('tab')) ? q.get('tab') : 'team') : 'person'
  const [members, teams] = manager ? await Promise.all([api('/api/members').catch(() => []), api('/api/teams').catch(() => [])]) : [[], []]
  const people = members.filter((m) => !m.status || m.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  const myTeams = teams.filter((t) => app.isAdmin || t.managedByMe)
  const personId = tab === 'person' ? (manager ? q.get('userId') || people[0]?.userId : app.me.id) : null
  const range = rangeOf(q)
  const activeAdv = ADVANCED.filter((k) => q.get(k)).length
  const f = (k) => q.get(k) || ''
  const tabLink = (k, label) => html`<a href="${hashFor(q, { tab: k, taskId: k === 'task' ? q.get('taskId') : null })}" role="tab" data-testid="tab-${k}" class="tab-link" ${tab === k ? raw('aria-selected="true" aria-current="page"') : raw('aria-selected="false"')}>${label}</a>`
  const opt = (v, l, cur) => html`<option value="${v}" ${String(cur) === String(v) ? raw('selected') : ''}>${l}</option>`

  main.innerHTML = html`<header class="page-head"><div><h1>${manager ? 'Work Intelligence' : 'My progress'}</h1><p class="muted">Understand your team’s work and contribution.</p></div></header>
    ${manager ? html`<div class="tabs" role="tablist" aria-label="Views">${tabLink('team', 'Team')}${tabLink('person', 'Person')}${tabLink('task', 'Task')}</div>` : ''}
    <form id="af" class="wi-controls" data-testid="analytics-filters" aria-label="Filters"><input type="hidden" name="tab" value="${tab}">
      <div class="wi-bar-row">
        ${tab === 'task' ? '' : html`<label class="wi-field"><span class="small muted">Date range</span><select name="range" id="af-range" data-testid="af-range">${RANGES.map(([v, l]) => opt(v, l, range))}</select></label>
        <span class="wi-custom" ${range === 'custom' ? '' : raw('hidden')}><label class="wi-field"><span class="small muted">From</span><input type="date" name="from" id="af-from" value="${dateOnly(f('from'))}"></label><label class="wi-field"><span class="small muted">To</span><input type="date" name="to" id="af-to" value="${dateOnly(f('to'))}"></label></span>`}
        ${manager && tab === 'team' && myTeams.length > 1 ? html`<label class="wi-field"><span class="small muted">Team</span><select name="teamId" id="af-team" data-testid="af-team"><option value="">All my teams</option>${myTeams.map((t) => opt(t.id, t.name, f('teamId')))}</select></label>` : ''}
        ${manager && tab === 'team' ? html`<label class="wi-field"><span class="small muted">Employee</span><select name="userId" id="af-user" data-testid="af-user"><option value="">Everyone</option>${people.map((p) => opt(p.userId, p.name, f('userId')))}</select></label>` : ''}
        ${manager && tab === 'person' ? html`<label class="wi-field"><span class="small muted">Employee</span><select name="userId" id="af-user" data-testid="af-user">${people.map((p) => opt(p.userId, p.name, personId))}</select></label>` : ''}
        ${tab === 'task' ? html`<label class="wi-field wi-grow"><span class="small muted">Find a task</span><input type="search" id="af-task-q" placeholder="Type to narrow the list" autocomplete="off"></label><label class="wi-field wi-grow"><span class="small muted">Task</span><select name="taskId" id="af-task" data-testid="af-task"><option value="">Choose a task</option></select></label>` : ''}
        <span class="wi-actions">
          ${tab === 'task' ? '' : html`<button type="button" class="btn small ghost" id="wi-more" data-testid="filters-toggle" aria-expanded="false" aria-controls="wi-panel">${icon('more')}More filters${activeAdv ? ` (${activeAdv})` : ''}</button>`}
          <button type="button" class="btn small ghost" id="wi-refresh" data-testid="refresh">${icon('refresh')}Refresh</button>
          <span class="small muted" id="wi-updated" role="status" aria-live="polite"></span>
        </span>
      </div>
      ${tab === 'task' ? '' : html`<div id="wi-panel" class="wi-panel" hidden><div class="fields">
        <div class="field"><label for="af-pr">Priority</label><select id="af-pr" name="priority" data-testid="af-priority"><option value="">Any</option>${PRIORITIES.map(([k, l]) => opt(k, l, f('priority')))}</select></div>
        <div class="field"><label for="af-cx">Complexity expected</label><select id="af-cx" name="complexity"><option value="">Any</option>${COMPLEXITY.map(([k, l]) => opt(k, l, f('complexity')))}</select></div>
        <div class="field"><label for="af-st">Status</label><select id="af-st" name="status"><option value="">Any</option>${STATUSES.map((s) => opt(s, STATUS_TEXT(s), f('status')))}</select></div>
        <div class="field"><label for="af-dl">Deadline</label><select id="af-dl" name="deadline"><option value="">Any</option>${[['CONFIRMED', 'Confirmed'], ['NOT_CONFIRMED', 'Not confirmed'], ['OVERDUE', 'Overdue now'], ['MISSED', 'Finished after the deadline'], ['MET', 'Finished by the deadline']].map(([k, l]) => opt(k, l, f('deadline')))}</select></div>
        <div class="field"><label for="af-oc">Outcome</label><select id="af-oc" name="outcome"><option value="">Any</option>${[['VERIFIED', 'Verified'], ['CLAIMED', 'Claimed, not verified'], ['NONE', 'None recorded']].map(([k, l]) => opt(k, l, f('outcome')))}</select></div>
        <div class="field"><label for="af-wt">Work type</label><input id="af-wt" name="workType" type="text" maxlength="40" value="${f('workType')}"></div></div>
        <div class="row"><button class="btn small" type="submit" data-testid="af-apply">Apply filters</button><a class="btn small ghost" href="#/analytics?tab=${tab}${personId && manager ? `&userId=${personId}` : ''}" data-testid="filters-reset">Reset filters</a></div></div>`}
      <p class="small err-text" id="wi-err" role="alert" hidden></p>
    </form>
    <details class="notice wi-notes" data-testid="analytics-notes" role="note"><summary><b>How to read this</b> <span class="muted small">fairness and definitions</span></summary><ul>${DEFAULT_NOTES.map((x) => html`<li>${x}</li>`)}</ul></details>
    <div id="an-body" data-testid="analytics-body" aria-live="polite" aria-busy="true">${loading('Reading the latest work data…')}</div>`.toString()

  const form = main.querySelector('#af')
  const err = main.querySelector('#wi-err')
  const go = () => {
    const u = new URLSearchParams()
    for (const [k, v] of new FormData(form)) if (String(v).trim()) u.set(k, String(v).trim())
    if (u.get('range') !== 'custom') { u.delete('from'); u.delete('to') }
    if (u.get('range') === 'custom' && u.get('from') && u.get('to') && u.get('from') > u.get('to')) { err.textContent = 'The start of the date range is after its end.'; err.hidden = false; return }
    err.hidden = true
    if (u.get('range') === '90') u.delete('range')
    location.hash = `#/analytics?${u}`
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); go() })
  const panel = main.querySelector('#wi-panel')
  const more = main.querySelector('#wi-more')
  if (more && panel) {
    more.addEventListener('click', () => { panel.hidden = !panel.hidden; more.setAttribute('aria-expanded', String(!panel.hidden)) })
    if (activeAdv) { panel.hidden = false; more.setAttribute('aria-expanded', 'true') }
  }
  form.querySelector('#af-range')?.addEventListener('change', (e) => { if (e.target.value === 'custom') form.querySelector('.wi-custom').hidden = false; else go() })
  form.querySelectorAll('#af-from,#af-to').forEach((x) => x.addEventListener('change', () => { if (form.querySelector('#af-from').value && form.querySelector('#af-to').value) go() }))
  form.querySelectorAll('#af-team,#af-user').forEach((x) => x.addEventListener('change', go))
  main.querySelector('#wi-refresh').addEventListener('click', () => load())

  // the task picker: a search box narrows the list of tasks
  if (tab === 'task') {
    const all = await api('/api/tasks?view=team').catch(() => [])
    const select = form.querySelector('#af-task')
    const fill = (needle) => {
      const list = all.filter((t) => !needle || t.title.toLowerCase().includes(needle.toLowerCase()))
      select.innerHTML = html`<option value="">${list.length ? 'Choose a task' : 'No task matches'}</option>${list.map((t) => opt(t.id, t.title, q.get('taskId')))}`.toString()
    }
    fill('')
    form.querySelector('#af-task-q').addEventListener('input', (e) => fill(e.target.value))
    select.addEventListener('change', go)
  }

  const body = main.querySelector('#an-body')
  const notesEl = main.querySelector('[data-testid=analytics-notes] ul')
  async function load() {
    body.setAttribute('aria-busy', 'true')
    body.innerHTML = loading('Reading the latest work data…').toString()
    let data = null
    try {
      const params = serverParams(q, tab)
      if (tab === 'team') data = await api(`/api/analytics/team?${params}`)
      else if (tab === 'person' && personId) data = await api(`/api/analytics/person/${personId}?${params}`)
      else if (tab === 'task' && q.get('taskId')) data = await api(`/api/analytics/task/${q.get('taskId')}`)
    } catch (e) {
      body.innerHTML = html`<div class="notice err" role="alert"><b>Could not load the analytics.</b> ${errorText(e)} <button type="button" class="btn small ghost" id="wi-retry">Try again</button></div>`.toString()
      body.setAttribute('aria-busy', 'false')
      body.querySelector('#wi-retry')?.addEventListener('click', () => load())
      return
    }
    body.setAttribute('aria-busy', 'false')
    if (data?.notes?.length) notesEl.innerHTML = data.notes.map((x) => html`<li>${x}</li>`).join('')
    main.querySelector('#wi-updated').textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    if (!data) {
      body.innerHTML = empty(tab === 'task' ? 'Choose a task' : 'Choose a person', tab === 'task' ? 'Pick a task above to see what was expected, what changed and what came out of it.' : 'There is nobody to show yet.', '', 'trending').toString()
      return
    }
    if (data.view === 'task') { body.innerHTML = taskView(data).toString(); return }
    body.innerHTML = (data.view === 'team' ? teamView(main, data) : personView(main, data)).toString()
    if (data.view === 'team') fillPatterns(body, data)
    const host = body.querySelector('[data-host=table]')
    if (host) {
      const showOwner = data.view === 'team'
      const ctl = mountTable(host, data.tasks, { showOwner, total: data.summary.tasks, truncated: Boolean(data.truncated) })
      bindFilters(body, ctl, { showOwner })
    }
  }
  await load()
}

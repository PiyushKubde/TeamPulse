// Team Overview (managers): what needs me today, in one screen. Built only from data that already exists (the workboard feed and the same counts the
// navigation shows); there are no charts and no new numbers. The board itself lives on the Workboard page.
import { api, html, icon, errorText, avatar, loading } from '../ui.js'
import { app } from '../app.js'
import { renderContributions } from './workboard.js'

// What needs a manager: overdue work, blocked work (context, never a fault of the owner), and submissions waiting for their review.
const needsMe = (t) => t.overdue || t.column === 'blocked' || (t.column === 'in_review' && t.canManage && !t.isMine)
const RANK = (t) => (t.overdue ? 0 : t.column === 'blocked' ? 1 : 2)

const WAITING = [
  ['review', 'Priorities and deadlines to confirm', '#/review'],
  ['reviews', 'Assessments to confirm', '#/reviews'],
  ['verify', 'Contributions to verify', '#/impact?view=team&status=PENDING'],
  ['evidence', 'Evidence to resolve', '#/contribution?tab=review'],
  ['requests', 'Task requests to decide', '#/requests']
]

export async function renderTeamOverview(main) {
  main.innerHTML = loading().toString()
  let wb
  try { [wb] = await Promise.all([api('/api/workboard'), app.refreshCounts()]) } catch (e) {
    main.innerHTML = html`<div class="notice err" role="alert"><b>Could not load the overview.</b> ${errorText(e)} <button type="button" class="btn small ghost" id="ov-retry">Try again</button></div>`.toString()
    main.querySelector('#ov-retry')?.addEventListener('click', () => renderTeamOverview(main))
    return
  }
  if (!main.isConnected) return
  const all = Object.values(wb.columns).flatMap((c) => c.tasks)
  const need = all.filter(needsMe).sort((a, b) => RANK(a) - RANK(b) || (b.hoursOverdue || 0) - (a.hoursOverdue || 0))
  const toApprove = all.filter((t) => t.column === 'in_review' && t.canManage && !t.isMine).length
  const waiting = [...(toApprove ? [['approve', 'Submitted work to approve', '#/workboard', toApprove]] : []), ...WAITING.map(([k, l, h]) => [k, l, h, app.counts[k] || 0])].filter((w) => w[3] > 0)
  const empty = !wb.metrics.active && !wb.columns.done.count
  const glance = [['IN_PROGRESS', 'In progress', wb.metrics.inProgress, 'Tasks whose status is In progress.'], ['COMPLETED', 'Completed', wb.metrics.completed, 'Tasks whose status is Completed.'], ['ATTENTION', 'Needs attention', need.length, 'Overdue, blocked, or waiting for your review. Blocked work is context, not a fault of its owner.']]
  const why = (t) => [t.overdue ? html`<span class="badge bad">Overdue</span>` : '', t.column === 'blocked' ? html`<span class="badge warn" title="A blocker is context for you, not a fault of the owner.">Blocked${t.externalBlocker ? ' · outside their control' : ''}</span>` : '', t.column === 'in_review' ? html`<span class="badge info">Waiting for your review</span>` : '']

  main.innerHTML = html`<div class="ov">
    <header class="wb-head"><div><h1>Team Overview</h1><p>What needs you today.</p></div>
      <div class="row"><a class="btn" href="#/workboard">${icon('tasks')}Open the Workboard</a></div></header>
    ${empty ? html`<section class="wi-sec"><h2>Your team has no tasks yet</h2><p class="muted" style="margin:10px 0">Add a task on the Workboard, or invite people first. Once work is moving, what needs you appears here.</p>
        <div class="row"><a class="btn" href="#/workboard">Go to the Workboard</a><a class="btn ghost" href="#/settings/members">Invite people</a></div></section>` : html`
    <div class="wi-glance" data-testid="overview-glance" role="group" aria-label="Team at a glance. Select one to see those tasks on the Workboard.">${glance.map(([k, l, v, tip]) => html`<a class="wi-g ${k === 'ATTENTION' && v ? 'warn' : ''}" href="#/workboard?kpi=${k}" title="${tip}"><b class="value">${v}</b> <span>${l}</span></a>`)}</div>
    <section class="wi-sec" aria-labelledby="ov-attn"><h2 id="ov-attn">Needs attention</h2>
      ${need.length ? html`<ul class="ov-list" data-testid="needs-attention">${need.slice(0, 8).map((t) => html`<li class="ov-row">${t.assigneeName ? avatar(t.assigneeName, null, 'sm') : ''}<div class="grow"><a class="ov-ttl" href="#/tasks/${t.id}">${t.title}</a><div class="small muted">${t.assigneeName || 'Unassigned'}</div></div><span class="row nowrap" style="gap:6px">${why(t)}</span></li>`)}</ul>
        ${need.length > 8 ? html`<p class="small muted" style="margin:10px 0 0">${need.length - 8} more on the <a href="#/workboard?kpi=ATTENTION">Workboard</a>.</p>` : ''}`
        : html`<p class="muted" data-testid="all-clear" style="margin:10px 0 0">Nothing needs attention right now.</p>`}</section>
    <section class="wi-sec" aria-labelledby="ov-wait"><h2 id="ov-wait">Waiting for you</h2>
      ${waiting.length ? html`<ul class="ov-list" data-testid="waiting-for-you">${waiting.map(([, l, href, n]) => html`<li class="ov-row"><a class="ov-ttl grow" href="${href}">${l}</a><span class="count-pill">${n}</span><a class="small" href="${href}" aria-label="Open ${l}">${icon('arrowRight', 'sm')}</a></li>`)}</ul>`
        : html`<p class="muted" style="margin:10px 0 0">Nothing is waiting for you.</p>`}</section>
    <div id="ov-contrib"></div>`}
  </div>`.toString()
  const box = main.querySelector('#ov-contrib')
  if (box) renderContributions(box)
}

// Overview = the team workboard: five status columns, one card per task.
// The board only DISPLAYS the existing lifecycle. A move is offered only where the task API already allows it, and the server decides every move.
import { api, html, avatar, ago, bindForm, errorText, toast, icon, confirmDialog, prov } from '../ui.js'
import { app } from '../app.js'
import { openTaskForm } from './tasks.js'
import { renderInbox } from './assignments.js'

const COLUMNS = [
  { key: 'todo', title: 'To do', hint: 'Assigned, not started yet' },
  { key: 'in_progress', title: 'In progress', hint: 'Being worked on' },
  { key: 'blocked', title: 'Blocked', hint: 'Waiting on a blocker' },
  { key: 'in_review', title: 'In review', hint: 'Submitted, waiting for a manager' },
  { key: 'done', title: 'Done', hint: 'Approved by a manager' }
]
const PRIO = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }
const KPI_LABEL = { ACTIVE: 'Active', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', OVERDUE: 'Overdue', ATTENTION: 'Needs attention', COMPLETED: 'Completed' }

/** Moves the existing task API allows, keyed "status>target column". Anything else has its own workflow on the task page. */
const MOVES = {
  'ASSIGNED>in_progress': { status: 'IN_PROGRESS', who: (c) => c.isMine, verb: 'Start work' },
  'IN_PROGRESS>todo': { status: 'ASSIGNED', who: (c) => c.isMine || c.canManage, verb: 'Move back to To do' },
  'COMPLETED>in_progress': { status: 'IN_PROGRESS', who: (c) => c.canManage, verb: 'Reopen', reason: 'Why is it reopened?' }
}
/** Why a card cannot simply be dropped there. Shown instead of calling the server for a move that is never allowed. */
function whyNot(c, target) {
  if (c.awaitingAcceptance) return 'The owner has to accept this task first. Open it to accept or decline.'
  if (c.declined) return 'The owner declined this task. Open it to assign someone else.'
  if (target === 'blocked') return 'Report a blocker on the task to mark it blocked.'
  if (target === 'in_review') return 'Work is submitted for review from the task page, with a summary.'
  if (target === 'done') return 'A task is done only when a manager approves its review.'
  if (c.column === 'blocked') return 'Resolve the blocker on the task page to resume work.'
  if (c.column === 'in_review') return 'A manager’s review decides where submitted work goes next.'
  if (c.column === 'done') return 'Only a manager can reopen finished work, and only back to In progress.'
  if (c.column === 'todo' && target === 'in_progress') return 'Only the owner can start this task.'
  if (c.column === 'in_progress' && target === 'todo') return 'Only the owner or a manager can move this task back.'
  return 'That move is not part of the task workflow.'
}
const moveFor = (c, target) => { const m = MOVES[`${c.status}>${target}`]; return m && m.who(c) ? m : null }

const first = (n) => String(n || '').trim().split(/\s+/)[0] || ''
/** "Nov 16" in the organization's timezone (with the year only when it is not this year). */
function dueLabel(c, tz) {
  const year = (d) => new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: tz }).format(d)
  const d = new Date(c.dueAt)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(year(d) === year(new Date()) ? {} : { year: 'numeric' }), timeZone: tz }).format(d)
}

function cardHtml(c, tz, busy) {
  const soon = c.dueAt && !c.overdue && Date.parse(c.dueAt) - Date.now() < 48 * 3600000
  const menu = COLUMNS.map((x) => [x.key, x.key === c.column ? null : moveFor(c, x.key)]).filter(([, m]) => m)
  const stuck = c.column === 'todo' || c.column === 'done' ? 'in_progress' : c.column === 'in_progress' ? 'todo' : 'done'
  return html`<article class="wb-card ${c.overdue ? 'is-overdue' : ''} ${busy ? 'is-busy' : ''}" data-id="${c.id}" data-col="${c.column}" draggable="${busy ? 'false' : 'true'}" aria-busy="${busy ? 'true' : 'false'}">
    <a class="wb-title" href="#/tasks/${c.id}" draggable="false">${c.title}</a>
    <div class="wb-meta">
      ${c.assigneeName ? (app.isManager && c.assigneeId ? html`<a class="wb-who" href="#/contribution/${c.assigneeId}?from=dashboard" draggable="false" title="Owner: ${c.assigneeName} — open their work, evidence and contribution">${avatar(c.assigneeName, null, 'sm')}<span>${first(c.assigneeName)}</span></a>` : html`<span class="wb-who" title="Owner: ${c.assigneeName}">${avatar(c.assigneeName, null, 'sm')}<span>${first(c.assigneeName)}</span></span>`) : html`<span class="wb-flag warn">Unassigned</span>`}
      ${c.dueAt ? html`<span class="wb-due ${c.overdue ? 'late' : soon ? 'soon' : ''}" title="${c.overdue ? `Overdue by ${c.hoursOverdue}h` : 'Deadline'}">${icon('clock', 'xs')}${c.overdue ? 'Overdue · ' : ''}${dueLabel(c, tz)}</span>` : ''}
      ${c.priority ? html`<span class="wb-prio prio prio-${c.priority}" title="Confirmed priority">${icon('flag', 'xs')}${PRIO[c.priority]}</span>` : ''}
    </div>
    ${c.awaitingAcceptance || c.declined || c.column === 'blocked' || c.pendingTransfer || (c.column === 'in_review' && c.canManage && !c.isMine) || (c.atRisk && !c.overdue) ? html`<div class="wb-flags">
      ${c.awaitingAcceptance ? html`<span class="wb-flag info">Awaiting acceptance</span>` : ''}
      ${c.declined ? html`<span class="wb-flag warn">Declined by owner</span>` : ''}
      ${c.column === 'blocked' ? html`<span class="wb-flag bad">${icon('blocked', 'xs')}${c.externalBlocker ? 'External blocker' : 'Blocked'}${c.blockedHours ? ` · ${c.blockedHours}h` : ''}</span>` : ''}
      ${c.pendingTransfer ? html`<span class="wb-flag info" title="Offered to ${c.pendingTransfer.toName}">Transfer pending</span>` : ''}
      ${c.column === 'in_review' && c.canManage && !c.isMine ? html`<span class="wb-flag brand">Needs your review</span>` : ''}
      ${c.atRisk && !c.overdue ? html`<span class="wb-flag warn">At risk</span>` : ''}</div>` : ''}
    <details class="wb-menu"><summary aria-label="Move or open: ${c.title}" title="Move or open">${icon('more', 'sm')}</summary>
      <div class="menu inline">${menu.map(([t, m]) => html`<button type="button" class="menu-item" data-move="${t}">${m.verb}</button>`)}
        <a class="menu-item" href="#/tasks/${c.id}">Open task</a>
        ${menu.length ? '' : html`<div class="menu-note">${whyNot(c, stuck)}</div>`}</div></details>
  </article>`
}

/**
 * Work volume is not work value: next to the board, the few contributions that carry weight (complex work or verified outcomes, with the evidence behind them)
 * and what waits on the manager's own judgement. Everything comes from the existing contribution-intelligence API; nothing is scored or ranked.
 */
async function renderContributions(box) {
  let t
  try { t = await api(`/api/contribution/intelligence?from=${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}`) } catch { return } // an extra: the board does not depend on it
  if (!box.isConnected) return
  const toAssess = t.people.reduce((n, p) => n + p.awaitingYourReview, 0)
  const rv = t.evidenceReview
  const evidence = rv ? rv.disputed + rv.unknownAuthor + rv.sharedPending : 0
  const items = t.significant.slice(0, 3)
  box.innerHTML = html`<section class="wb-contrib" aria-labelledby="wbc-h"><div class="wb-contrib-head"><h2 id="wbc-h">${icon('award', 'sm')}Contributions that matter</h2>
      <span class="wb-contrib-note">Complex work and verified outcomes, with their evidence. Not task counts, not a ranking.</span>
      <span class="wb-contrib-links">${toAssess ? html`<a class="wb-flag warn" href="#/reviews">${toAssess} awaiting your assessment</a>` : ''}${evidence ? html`<a class="wb-flag info" href="#/contribution?tab=review">${evidence} evidence to resolve</a>` : ''}<a href="#/analytics">Work Analytics ${icon('arrowRight', 'xs')}</a></span></div>
    ${items.length ? html`<ul class="wb-contrib-list">${items.map((x) => html`<li><a href="#/tasks/${x.taskId}"><span class="ttl">${x.taskTitle}</span><span class="who">${x.name}${x.complexityReason ? ` — ${x.complexityReason}` : ''}</span>
        <span class="wb-contrib-tags">${x.complexity ? html`<span class="badge brand">Complexity ${x.complexity}</span>` : ''}${x.verifiedOutcomes ? prov('verified', 'Verified outcome') : ''}${x.externalEvidence ? prov('fact', 'Evidence from apps') : ''}${x.sharedWithOthers ? html`<span class="badge outline">Shared work</span>` : ''}${x.managerStatus === 'PENDING' ? html`<span class="badge warn">Awaiting your assessment</span>` : ''}${x.simulated ? html`<span class="badge warn">simulated</span>` : ''}</span></a></li>`)}</ul>`
      : html`<p class="wb-contrib-empty">Nothing yet. Complex work and outcomes you verify appear here once work is analysed from its evidence.</p>`}</section>`.toString()
}

const REFLECTION_PROMPTS = [['contribution', 'What was my most important contribution today?'], ['changeMade', 'What changed because of my work?'], ['blockedBy', 'What blocked me?'], ['learned', 'What did I learn?'], ['tomorrow', 'What will I focus on tomorrow?']]
/** The employee's private daily reflection used to live on the old Overview; it stays one click away, collapsed under the board. */
async function renderReflection(box) {
  let r
  try { r = await api('/api/reflections/today') } catch { return } // a private extra: the board does not depend on it
  if (!box.isConnected) return
  box.innerHTML = html`<details class="card reflect" style="margin-top:8px"><summary><div><h2 id="refl-h">Daily reflection</h2><p class="small muted" style="margin:3px 0 0">Private to you. Five quick prompts — skip any.</p></div>
      <span class="row" style="gap:8px"><span class="small muted" id="refl-saved">${r.savedAt ? `Saved ${ago(r.savedAt)}` : ''}</span><span class="chev">${icon('chevronDown')}</span></span></summary>
    <form id="reflection" aria-labelledby="refl-h"><div class="form-error"></div><div class="reflect-grid">
      ${REFLECTION_PROMPTS.map(([k, label]) => html`<div class="field"><label for="r-${k}">${label}</label><textarea id="r-${k}" name="${k}" rows="2" maxlength="2000">${r[k]}</textarea></div>`)}</div>
      <button class="btn ghost" type="submit">Save reflection</button></form></details>`.toString()
  bindForm(box.querySelector('#reflection'), (d) => api('/api/reflections', { method: 'PUT', body: { day: r.day, ...d } }), { onSuccess: (out) => { toast('Reflection saved.'); box.querySelector('#refl-saved').textContent = `Saved ${ago(out.savedAt)}` } })
}

export async function renderWorkboard(main, q = new URLSearchParams()) {
  const manager = app.isManager
  const f = { q: '', assigneeId: q.get('assigneeId') || '', priority: q.get('priority') || '', deadline: q.get('deadline') || '', kpi: (q.get('kpi') || '').toUpperCase() }
  let data = null
  let seq = 0 // only the newest request may paint
  let doneShown = 0 // how many completed tasks the person has loaded (for "Show more")
  const busy = new Set()
  const live = () => main.isConnected

  main.innerHTML = html`<div class="wb">
    <header class="wb-head"><div><h1>${manager ? 'Team Workboard' : 'My workboard'}</h1><p>${manager ? 'See what your team is working on.' : 'See what you are working on.'}</p></div>
      <div class="row">${manager ? html`<a class="btn ghost" href="#/copilot">${icon('copilot')}Ask Copilot</a>` : ''}<button class="btn ghost icon-only" id="wb-refresh" aria-label="Refresh the board" title="Refresh">${icon('refresh')}</button><button class="btn" id="wb-new">${icon('plus')}${app.session.membership.creationMode === 'direct' ? 'New task' : 'Suggest a task'}</button></div></header>
    <div id="wb-inbox"></div>
    <div class="wb-summary"><div class="wb-metrics" id="wb-metrics" role="group" aria-label="Task summary"></div><div class="wb-attn" id="wb-attn" aria-live="polite"></div></div>
    ${manager ? html`<div id="wb-contrib"></div>` : ''}
    <form class="wb-toolbar" id="wb-filters" role="search" onsubmit="return false">
      <div class="search-box">${icon('search', 'sm')}<input type="search" id="wb-q" placeholder="Search tasks" aria-label="Search tasks by title" autocomplete="off" maxlength="100"></div>
      ${manager ? html`<select id="wb-assignee" aria-label="Filter by assignee"><option value="">Anyone</option></select>` : ''}
      <select id="wb-priority" aria-label="Filter by priority"><option value="">Any priority</option>${Object.entries(PRIO).map(([k, l]) => html`<option value="${k}">${l}</option>`)}<option value="UNRESOLVED">Priority not set</option></select>
      <select id="wb-deadline" aria-label="Filter by deadline"><option value="">Any deadline</option><option value="OVERDUE">Overdue</option><option value="TODAY">Due today</option><option value="WEEK">Due this week</option><option value="NONE">No deadline</option></select>
      <span class="wb-active" id="wb-active" aria-live="polite"></span><button type="button" class="btn link small" id="wb-clear" hidden>Clear filters</button>
    </form>
    <div class="wb-board" id="wb-board" role="region" aria-label="Task board" tabindex="0"><div class="wb-loading"><span class="spinner" aria-hidden="true"></span>Loading the board…</div></div>
    <div class="wb-foot small muted" id="wb-foot"></div>
    ${manager ? '' : html`<div id="wb-reflection"></div>`}
  </div>`.toString()
  const $ = (id) => main.querySelector(`#${id}`)
  if (manager) api('/api/parameter-review').then((r) => { if (live() && Array.isArray(r) && r.length) $('wb-attn').dataset.review = String(r.length), paintAttention() }).catch(() => {})
  renderInbox($('wb-inbox'))
  if (!manager) renderReflection($('wb-reflection'))
  else renderContributions($('wb-contrib'))

  const qs = (extra = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...f, ...extra })) if (v !== '' && v !== undefined && v !== null) p.set(k, v)
    return p
  }

  // ---------- painting ----------
  function paintMetrics() {
    const m = data.metrics
    const tiles = [['ACTIVE', 'Active', m.active, ''], ['COMPLETED', 'Completed', m.completed, ''], ['BLOCKED', 'Blocked', m.blocked, 'bad'], ['OVERDUE', 'Overdue', m.overdue, 'bad']]
    $('wb-metrics').innerHTML = tiles.map(([k, l, n, tone]) => html`<button type="button" class="wb-metric ${n && tone ? tone : ''}" data-kpi="${k}" aria-pressed="${f.kpi === k}"><span class="n">${n}</span><span class="l">${l}</span></button>`).join('')
  }
  function paintAttention() {
    const box = $('wb-attn')
    if (!data) return
    const m = data.metrics
    const review = Number(box.dataset.review || 0)
    const parts = []
    if (m.overdue) parts.push(`${m.overdue} overdue`)
    if (m.blocked) parts.push(`${m.blocked} blocked`)
    box.innerHTML = (m.attention
      ? html`<button type="button" class="wb-attn-line" data-kpi="ATTENTION" aria-pressed="${f.kpi === 'ATTENTION'}">${icon('alert', 'sm')}<b>${m.attention} ${m.attention === 1 ? 'item needs' : 'items need'} attention</b> · ${parts.join(' · ')}</button>`
      : html`<span class="wb-ontrack">${icon('checkCircle', 'sm')}All work on track</span>`).toString()
      + (review ? html`<a class="wb-review" href="#/review" title="Open the Review Queue">${icon('flag', 'sm')}${review} to review</a>`.toString() : '')
  }
  function columnHtml(col) {
    const c = data.columns[col.key]
    const addable = col.key === 'todo'
    return html`<section class="wb-col" data-col="${col.key}" aria-labelledby="wbh-${col.key}">
      <header><h2 id="wbh-${col.key}" title="${col.hint}">${col.title}</h2><span class="wb-count" aria-label="${c.count} tasks">${c.count}</span></header>
      <div class="wb-list" data-list="${col.key}" tabindex="-1">
        ${c.tasks.map((t) => cardHtml(t, data.timezone, busy.has(t.id)))}
        ${c.skipped ? html`<p class="wb-empty">Not part of this filter.</p>` : c.tasks.length ? '' : html`<p class="wb-empty">${data.filtered ? 'No matching tasks' : col.key === 'done' ? 'Nothing completed yet' : 'No tasks'}</p>`}
        ${col.key === 'done' && c.hasMore ? html`<button type="button" class="btn small ghost wb-more" id="wb-more">Show more (${c.count - c.tasks.length} older)</button>` : ''}
      </div>
      ${addable ? html`<footer><button type="button" class="wb-add" id="wb-add">${icon('plus', 'sm')}${app.session.membership.creationMode === 'direct' ? 'Add a task' : 'Suggest a task'}</button></footer>` : ''}
    </section>`.toString()
  }
  function paintColumn(key) {
    const el = $('wb-board').querySelector(`.wb-col[data-col="${key}"]`)
    const col = COLUMNS.find((c) => c.key === key)
    if (!el) return
    const keepScroll = el.querySelector('.wb-list').scrollTop
    el.outerHTML = columnHtml(col)
    $('wb-board').querySelector(`.wb-col[data-col="${key}"] .wb-list`).scrollTop = keepScroll
  }
  function paintBoard() {
    const board = $('wb-board')
    const scroll = board.scrollLeft
    board.innerHTML = COLUMNS.map(columnHtml).join('')
    board.scrollLeft = scroll
    paintMetrics(); paintAttention()
    // Assignee list: the people who own visible open work (from the server, so nothing outside the person's scope is offered).
    const sel = $('wb-assignee')
    if (sel) { // managers only: an employee's board holds their own work
      const keep = f.assigneeId
      sel.innerHTML = `<option value="">Anyone</option><option value="none">Unassigned</option>${data.people.map((p) => `<option value="${p.userId}">${p.name.replace(/[&<>"]/g, '')}</option>`).join('')}`
      sel.value = [...sel.options].some((o) => o.value === keep) ? keep : ''
    }
    $('wb-priority').value = f.priority; $('wb-deadline').value = f.deadline
    const active = [f.q && 'search', f.assigneeId && 'assignee', f.priority && 'priority', f.deadline && 'deadline', f.kpi && KPI_LABEL[f.kpi]].filter(Boolean)
    $('wb-active').textContent = active.length ? `${active.length} filter${active.length === 1 ? '' : 's'} on${f.kpi ? ` · ${KPI_LABEL[f.kpi]}` : ''}` : ''
    $('wb-clear').hidden = !active.length
    $('wb-foot').textContent = data.truncated ? 'Showing the first 500 open tasks. Use Tasks to see everything.' : ''
  }

  // ---------- loading ----------
  async function load({ quiet = false } = {}) {
    const mine = ++seq
    if (!quiet && !data) $('wb-board').innerHTML = html`<div class="wb-loading"><span class="spinner" aria-hidden="true"></span>Loading the board…</div>`.toString()
    try {
      const out = await api(`/api/workboard?${qs({ doneLimit: Math.min(50, Math.max(15, doneShown || 15)) })}`)
      if (mine !== seq || !live()) return // a newer request replaced this one
      data = out
      doneShown = out.columns.done.tasks.length
      paintBoard()
    } catch (e) {
      if (mine !== seq || !live()) return
      if (data && quiet) { toast(errorText(e), { error: true }); return }
      $('wb-board').innerHTML = html`<div class="wb-error notice err" role="alert"><b>Could not load the board.</b> ${errorText(e)} <button type="button" class="btn small ghost" id="wb-retry">Retry</button></div>`.toString()
      $('wb-retry').addEventListener('click', () => load())
    }
  }

  async function showMoreDone() {
    const btn = $('wb-more')
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…' }
    const mine = seq
    try {
      const out = await api(`/api/workboard?${qs({ doneOffset: data.columns.done.tasks.length, doneLimit: 15 })}`)
      if (mine !== seq || !live()) return
      const d = data.columns.done
      const have = new Set(d.tasks.map((t) => t.id))
      d.tasks.push(...out.columns.done.tasks.filter((t) => !have.has(t.id)))
      d.count = out.columns.done.count; d.hasMore = d.tasks.length < d.count
      doneShown = d.tasks.length
      paintColumn('done')
    } catch (e) { toast(errorText(e), { error: true }); paintColumn('done') }
  }

  // ---------- moving a card (the existing status API; the server decides) ----------
  async function move(id, target) {
    if (busy.has(id)) return // one move at a time per task
    const from = COLUMNS.find((c) => data.columns[c.key].tasks.some((t) => t.id === id))?.key
    const card = data.columns[from]?.tasks.find((t) => t.id === id)
    if (!card || from === target) return
    const rule = moveFor(card, target)
    if (!rule) { toast(whyNot(card, target)); return }
    let reason
    if (rule.reason) {
      const r = await confirmDialog({ title: 'Reopen this task?', body: 'It goes back to In progress for its owner. The reopening is recorded.', confirm: 'Reopen', reason: { label: rule.reason, required: true } })
      if (!r?.ok) return
      reason = r.reason
    }
    // Show the card in its new column straight away, and put it back if the server refuses.
    const snapshot = JSON.stringify(data.columns)
    const src = data.columns[from]; const dst = data.columns[target]
    src.tasks = src.tasks.filter((t) => t.id !== id); src.count -= 1
    dst.tasks.unshift({ ...card, column: target, status: rule.status }); dst.count += 1
    busy.add(id); paintColumn(from); paintColumn(target)
    const mine = seq
    try {
      await api(`/api/tasks/${id}/status`, { method: 'POST', body: { status: rule.status, ...(reason ? { reason } : {}) } })
      busy.delete(id)
      toast(target === 'todo' ? 'Moved back to To do.' : rule.status === 'IN_PROGRESS' && from === 'done' ? 'Reopened.' : 'Started.')
      app.refreshCounts()
      await load({ quiet: true }) // counts, metrics and order come from the server
    } catch (e) {
      busy.delete(id)
      if (mine === seq && live()) { data.columns = JSON.parse(snapshot); paintColumn(from); paintColumn(target) }
      toast(errorText(e), { error: true })
    }
  }

  // ---------- events ----------
  const board = $('wb-board')
  let dragId = null
  board.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('.wb-card')
    if (!c || busy.has(c.dataset.id)) { e.preventDefault(); return }
    dragId = c.dataset.id
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId)
    c.classList.add('dragging')
    const card = Object.values(data.columns).flatMap((x) => x.tasks).find((t) => t.id === dragId)
    // Mark where this card may go; the other columns explain themselves when dropped on.
    board.querySelectorAll('.wb-col').forEach((col) => col.classList.toggle('can-drop', Boolean(card && col.dataset.col !== card.column && moveFor(card, col.dataset.col))))
  })
  board.addEventListener('dragend', () => { dragId = null; board.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); board.querySelectorAll('.wb-col').forEach((c) => c.classList.remove('can-drop', 'drag-over')) })
  board.addEventListener('dragover', (e) => { const col = e.target.closest?.('.wb-col'); if (!col || !dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; // every column accepts the drop; a column that cannot take the card explains why instead of failing silently
    board.querySelectorAll('.drag-over').forEach((x) => x !== col && x.classList.remove('drag-over')); col.classList.toggle('drag-over', col.classList.contains('can-drop')) })
  board.addEventListener('drop', (e) => { const col = e.target.closest?.('.wb-col'); if (!col || !dragId) return; e.preventDefault(); const id = dragId; board.querySelectorAll('.wb-col').forEach((c) => c.classList.remove('can-drop', 'drag-over')); move(id, col.dataset.col) })

  main.addEventListener('click', (e) => {
    const t = e.target
    const kpi = t.closest('[data-kpi]')
    if (kpi) { f.kpi = f.kpi === kpi.dataset.kpi ? '' : kpi.dataset.kpi; doneShown = 0; load({ quiet: true }); return }
    const mv = t.closest('[data-move]')
    if (mv) { const id = mv.closest('.wb-card').dataset.id; mv.closest('details').removeAttribute('open'); move(id, mv.dataset.move); return }
    if (t.closest('#wb-more')) { showMoreDone(); return }
    if (t.closest('#wb-add')) { openTaskForm(null, { onCreated: () => { toast('Task created.'); load({ quiet: true }) } }); return }
    const cardEl = t.closest('.wb-card')
    // The whole card opens the task (the title is a real link, so keyboard and middle-click work too).
    if (cardEl && !t.closest('a, button, details')) location.hash = `#/tasks/${cardEl.dataset.id}`
    if (!t.closest('.wb-menu')) main.querySelectorAll('.wb-menu[open]').forEach((d) => d.removeAttribute('open'))
  })
  $('wb-new').addEventListener('click', () => openTaskForm(null, { onCreated: () => { toast('Task created.'); load({ quiet: true }) } }))
  $('wb-refresh').addEventListener('click', () => { doneShown = 0; load({ quiet: true }) })
  let timer = null
  $('wb-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); doneShown = 0; load({ quiet: true }) }, 250) })
  for (const [id, key] of [['wb-assignee', 'assigneeId'], ['wb-priority', 'priority'], ['wb-deadline', 'deadline']]) $(id)?.addEventListener('change', (e) => { f[key] = e.target.value; doneShown = 0; load({ quiet: true }) })
  $('wb-clear').addEventListener('click', () => { Object.assign(f, { q: '', assigneeId: '', priority: '', deadline: '', kpi: '' }); $('wb-q').value = ''; doneShown = 0; load({ quiet: true }) })
  // A menu near the bottom of its column opens upward, so the list does not clip it.
  main.addEventListener('toggle', (e) => { const d = e.target; if (!d.classList?.contains('wb-menu') || !d.open) return; d.classList.toggle('up', d.closest('.wb-list').getBoundingClientRect().bottom - d.getBoundingClientRect().bottom < 150) }, true)
  main.addEventListener('keydown', (e) => { if (e.key === 'Escape') main.querySelectorAll('.wb-menu[open]').forEach((d) => d.removeAttribute('open')) })

  await load()
  if (data && !data.columns.todo.tasks.length && !data.columns.in_progress.tasks.length && !data.metrics.active && !data.filtered && !data.columns.done.count) {
    // A brand-new board: the columns stay (so "Add a task" is right there); one quiet line says why they are empty.
    $('wb-foot').innerHTML = html`<span>Nothing here yet. ${manager ? 'Add a task, or approve a suggestion in Task Requests.' : 'Tasks assigned to you appear here.'}</span>`.toString()
  }
}

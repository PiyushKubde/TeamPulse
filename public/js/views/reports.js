import { api, html, raw, empty, d } from '../ui.js'
import { openContextBuilder } from './automations.js'

const REPORTS = [['weekly', 'Weekly team summary'], ['workload', 'Team workload'], ['status', 'Task status distribution'], ['overdue', 'Overdue tasks'], ['blockers', 'Blocker history'], ['contributions', 'Employee contributions'], ['impact', 'Verified impact']]
const LABELS = { person: 'Person', active: 'Active', assigned: 'Not started', inProgress: 'In progress', blocked: 'Blocked', inReview: 'In review', overdue: 'Overdue', atRisk: 'At risk', critical: 'Critical', status: 'Status', tasks: 'Tasks', task: 'Task', assignee: 'Owner', priority: 'Priority', dueAt: 'Due', hoursOverdue: 'Hours overdue', openBlockers: 'Open blockers', description: 'Description', dependency: 'Dependency', reportedAt: 'Reported', hoursOpen: 'Hours open', resolution: 'Resolution', verified: 'Verified', pending: 'Pending', rejected: 'Not verified', prevention: 'Prevention', learning: 'Learning', reusable: 'Reusable', quality: 'Quality', categories: 'Categories', title: 'Title', category: 'Category', outcomeType: 'Kind', result: 'Result', value: 'Value', unit: 'Unit', valueKind: 'Measured / estimate', verifiedAt: 'Verified' }
const cell = (k, v) => (/At$/.test(k) && v ? d(v) : v ?? '')

export async function renderReports(main, q) {
  const type = q.get('type') || 'weekly'
  const people = await api('/api/members')
  const params = new URLSearchParams()
  for (const k of ['from', 'to', 'userId', 'weekStart']) if (q.get(k)) params.set(k, q.get(k))
  const report = await api(`/api/reports/${type}?${params}`)
  main.innerHTML = html`<div class="page-head"><div><h1>Reports</h1><p>Operational views and evidence of contribution. No report ranks people by how many tasks they closed.</p></div>
    <div class="row">${type === 'weekly' ? html`<button class="btn ghost" id="automate" title="When my weekly report is ready…">Send each report to Google Sheets, Slack or Gmail</button>` : html`<a class="btn ghost" href="/api/reports/${type}.csv?${params}" download>Export CSV</a>`}</div></div>
    <form class="filters" id="rf">
      <select name="type" aria-label="Report">${REPORTS.map(([k, l]) => html`<option value="${k}" ${k === type ? raw('selected') : ''}>${l}</option>`)}</select>
      ${type === 'weekly' ? html`<label class="small" for="ws" style="margin:0">Week of</label><input id="ws" type="date" name="weekStart" value="${report.weekStart}">`
        : html`<label class="small" for="from" style="margin:0">From</label><input id="from" type="date" name="from" value="${(q.get('from') || report.from || '').slice(0, 10)}"><label class="small" for="to" style="margin:0">To</label><input id="to" type="date" name="to" value="${(q.get('to') || '').slice(0, 10)}">`}
      <select name="userId" aria-label="Person"><option value="">Everyone in my scope</option>${people.filter((p) => p.inScope).map((p) => html`<option value="${p.userId}" ${q.get('userId') === p.userId ? raw('selected') : ''}>${p.name}</option>`)}</select>
      <button class="btn small ghost" type="submit">Apply</button></form>
    <div id="rb"></div>`
  main.querySelector('#rf').addEventListener('submit', (e) => {
    e.preventDefault()
    const p = new URLSearchParams()
    for (const el of e.target.elements) if (el.name && el.value) p.set(el.name, el.value)
    location.hash = `#/reports?${p}`
  })
  main.querySelector('#automate')?.addEventListener('click', () => openContextBuilder('weekly_report_ready'))
  main.querySelector('select[name=type]').addEventListener('change', (e) => { location.hash = `#/reports?type=${e.target.value}` })
  const rb = main.querySelector('#rb')
  if (type === 'weekly') return renderWeekly(rb, report)
  rb.innerHTML = html`<h2 style="margin-bottom:8px">${report.title}</h2>
    ${report.totals?.length ? html`<div class="row" style="margin-bottom:10px">${report.totals.map((t) => html`<span class="badge ${t.valueType === 'ESTIMATED' ? 'warn' : 'ok'}">${t.categoryLabel}: ${t.valueType === 'ESTIMATED' ? '≈' : ''}${t.total.toLocaleString()} ${t.unit}</span>`)}</div>` : ''}
    ${report.rows.length ? html`<div class="table-wrap"><table><thead><tr>${report.columns.map((c) => html`<th>${LABELS[c] || c}</th>`)}</tr></thead><tbody>${report.rows.map((r) => html`<tr>${report.columns.map((c) => html`<td class="${typeof r[c] === 'number' ? 'num' : ''}">${cell(c, r[c])}</td>`)}</tr>`)}</tbody></table></div>`
      : html`<div class="card">${empty('Nothing in this period', 'Try a wider date range.')}</div>`}`
}

function renderWeekly(rb, w) {
  const list = (items, fmt, none) => (items.length ? html`<ul class="list">${items.map(fmt)}</ul>` : html`<p class="muted small">${none}</p>`)
  const rec = (r) => html`<li><div class="grow"><a href="#/impact/${r.id}"><b>${r.title}</b></a><div class="small muted">${r.person} · ${r.category}${r.value ? ` · ${r.value}` : ''}</div><div class="small">${r.result}</div></div></li>`
  rb.innerHTML = html`<h2 style="margin-bottom:4px">${w.title}</h2><p class="small muted" style="margin-bottom:12px">${w.completedTasks} task(s) completed this week — shown for operations, not as a measure of anyone’s value.</p>
    <div class="grid two">
      <section class="card"><h3 style="margin-bottom:8px">Verified outcomes</h3>${list(w.verifiedOutcomes, rec, 'No outcomes verified this week.')}</section>
      <section class="card"><h3 style="margin-bottom:8px">Significant contributions</h3>${list(w.significantContributions, (r) => html`<li><div class="grow"><a href="#/impact/${r.id}"><b>${r.title}</b></a><div class="small muted">${r.person} · ${r.category} · ${r.verificationStatus.toLowerCase()}</div></div></li>`, 'No contributions recorded this week.')}</section>
      <section class="card"><h3 style="margin-bottom:8px">Unresolved blockers</h3>${list(w.unresolvedBlockers, (b) => html`<li><div class="grow"><a href="#/tasks/${b.taskId}"><b>${b.task}</b></a><div class="small">${b.description}</div><div class="small muted">${b.assignee || 'unassigned'} · open ${b.hoursOpen}h${b.dependency ? ` · waiting on ${b.dependency}` : ''}</div></div></li>`, 'No open blockers.')}</section>
      <section class="card"><h3 style="margin-bottom:8px">Missed commitments</h3>${list(w.missedCommitments, (m) => html`<li><div class="grow"><a href="#/tasks/${m.taskId}"><b>${m.task}</b></a> <span class="badge ${m.countedAgainstPerson ? 'warn' : 'outline'}">${m.countedAgainstPerson ? 'No reason recorded' : 'Documented reason'}</span>
        <div class="small muted">${m.assignee} · due ${d(m.dueAt)}</div>${m.reasons.map((r) => html`<div class="small">• ${r}</div>`)}</div></li>`, 'No deadlines missed this week.')}
        <p class="small muted" style="margin-top:8px">External dependencies and manager-driven priority or deadline changes are documented reasons, not failures.</p></section>
      <section class="card"><h3 style="margin-bottom:8px">Quality improvements</h3>${list(w.qualityImprovements, rec, 'None recorded.')}</section>
      <section class="card"><h3 style="margin-bottom:8px">Reusable work</h3>${list(w.reusableWork, rec, 'None recorded.')}</section>
      ${w.learning.length ? html`<section class="card"><h3 style="margin-bottom:8px">Learning</h3>${list(w.learning, rec, '')}</section>` : ''}
    </div>`
}

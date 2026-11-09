import { api, html, raw, ago, dt, empty, toast, errorText } from '../ui.js'
import { app } from '../app.js'

const DELIVERY = { QUEUED: 'info', SENDING: 'info', SENT: 'ok', DELIVERED: 'ok', FAILED: 'bad', NOT_CONFIGURED: 'warn', SKIPPED: 'outline' }

export async function renderAlerts(main, q) {
  const tab = q.get('tab') || 'inbox'
  main.innerHTML = html`<div class="page-head"><div><h1>Alerts &amp; notifications</h1><p>In-app notifications for everything that needs you. Important alerts can also go out through M91.</p></div>
    ${app.isAdmin ? html`<a class="btn ghost" href="#/settings/alerts">Alert settings</a>` : ''}</div>
    <div class="tabs">${[['inbox', 'Notifications'], ['history', 'M91 alert history']].map(([k, l]) => html`<a href="#/alerts?tab=${k}" ${tab === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</div><div id="tb"></div>`
  const tb = main.querySelector('#tb')
  if (tab === 'history') {
    const [rows, settings] = await Promise.all([api('/api/alerts/history'), api('/api/alerts/settings')])
    tb.innerHTML = html`<div class="notice ${settings.m91.state === 'ready' ? 'ok' : 'warn'}"><b>M91:</b> ${settings.m91.message} ${settings.m91Enabled ? '' : 'M91 alerts are turned off for this organization.'}</div>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Alert</th>${app.isAdmin ? html`<th>Recipient</th>` : ''}<th>Status</th><th class="num">Attempts</th><th>Detail</th>${app.isAdmin ? html`<th></th>` : ''}</tr></thead><tbody>
      ${rows.map((r) => html`<tr><td class="nowrap" title="${dt(r.createdAt)}">${ago(r.createdAt)}</td><td>${r.ruleLabel}</td>${app.isAdmin ? html`<td>${r.recipientName || '—'}</td>` : ''}<td><span class="badge ${DELIVERY[r.status]}">${r.status.replace('_', ' ').toLowerCase()}</span></td><td class="num">${r.attempts}</td><td class="small">${r.lastError || ''}</td>
        ${app.isAdmin ? html`<td>${['FAILED', 'NOT_CONFIGURED'].includes(r.status) ? html`<button class="btn small ghost" data-retry="${r.id}">Retry</button>` : ''}</td>` : ''}</tr>`)}</tbody></table></div>`
        : html`<div class="card">${empty('No external alerts yet', 'When M91 is on, important alerts and their delivery status appear here. In-app notifications are always on.')}</div>`}`
    tb.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/api/alerts/deliveries/${b.dataset.retry}/retry`, { method: 'POST' }); toast('Queued again.'); renderAlerts(main, q) } catch (e) { toast(errorText(e), { error: true }) } }))
    return
  }
  const { notifications, unread } = await api('/api/notifications')
  tb.innerHTML = html`<div class="row between" style="margin-bottom:10px"><span class="muted">${unread} unread</span>${unread ? html`<button class="btn small ghost" id="all-read">Mark all as read</button>` : ''}</div>
    ${notifications.length ? html`<ul class="list card">${notifications.map((n) => html`<li style="${n.read ? '' : 'font-weight:600'}"><span class="badge ${n.read ? 'outline' : 'brand'}" aria-label="${n.read ? 'read' : 'unread'}">${n.read ? '·' : 'New'}</span>
      <div class="grow">${n.link ? html`<a href="${n.link}" data-read="${n.id}">${n.title}</a>` : n.title}${n.body ? html`<div class="small muted" style="font-weight:400">${n.body}</div>` : ''}</div><span class="small muted nowrap" style="font-weight:400">${ago(n.createdAt)}</span></li>`)}</ul>`
      : html`<div class="card">${empty('You are all caught up', 'Assignments, reviews, blockers and deadline alerts appear here.')}</div>`}`
  tb.querySelector('#all-read')?.addEventListener('click', async () => { await api('/api/notifications/read', { method: 'POST', body: { ids: 'all' } }); app.refreshCounts(); renderAlerts(main, q) })
  tb.querySelectorAll('[data-read]').forEach((a) => a.addEventListener('click', () => { api('/api/notifications/read', { method: 'POST', body: { ids: [a.dataset.read] } }).then(() => app.refreshCounts()).catch(() => {}) }))
}

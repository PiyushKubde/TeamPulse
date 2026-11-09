// TeamPulse browser app. Talks only to this server's /api; the server decides every permission.
import { api, html, raw, esc, avatar, loading, errorBlock, toast } from './ui.js'
import { renderLogin, renderWelcome, renderSignup, renderForgot, renderReset, renderVerify } from './views/onboarding.js'
import { renderDashboard } from './views/dashboard.js'
import { renderTaskList, renderTaskDetail } from './views/tasks.js'
import { renderRequests } from './views/requests.js'
import { renderImpact, renderImpactDetail } from './views/impact.js'
import { renderAutomations } from './views/automations.js'
import { renderAlerts } from './views/alerts.js'
import { renderReports } from './views/reports.js'
import { renderSettings } from './views/settings.js'
import { renderContribution, renderPerson } from './views/contribution.js'
import { renderEvidence } from './views/evidence.js'

const ICONS = {
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  mine: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  team: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  requests: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  impact: 'M22 12h-4l-3 9L9 3l-3 9H2',
  automations: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  alerts: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  reports: 'M18 20V10M12 20V4M6 20v-6',
  evidence: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  intelligence: 'M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2zM9 21h6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'
}
const icon = (k) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[k]}"/></svg>`)
const LOGO = raw(`<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#4338ca"/><path d="M5 17h6l3-7 4 13 3-6h6" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`)

export const app = {
  session: null,
  get role() { return this.session?.membership?.role },
  get isManager() { return ['manager', 'admin'].includes(this.role) },
  get isAdmin() { return this.role === 'admin' },
  get me() { return this.session?.user },
  counts: {}
}

const NAV = [
  { key: 'dashboard', label: 'Dashboard', href: '#/dashboard', icon: 'dashboard' },
  { key: 'my-tasks', label: 'My Tasks', href: '#/my-tasks', icon: 'mine' },
  { key: 'team-tasks', label: 'Team Tasks', href: '#/team-tasks', icon: 'team', manager: true },
  { key: 'requests', label: 'Task Requests', href: '#/requests', icon: 'requests', count: 'requests' },
  { key: 'impact', label: 'Performance & Impact', href: '#/impact', icon: 'impact' },
  { key: 'evidence', label: 'My work evidence', href: '#/evidence', icon: 'evidence' },
  { key: 'intelligence', label: 'Team intelligence', href: '#/contribution', icon: 'intelligence', manager: true },
  { key: 'automations', label: 'Automation Center', href: '#/automations', icon: 'automations' },
  { key: 'alerts', label: 'Alerts & Notifications', href: '#/alerts', icon: 'alerts', count: 'unread' },
  { key: 'reports', label: 'Reports', href: '#/reports', icon: 'reports', manager: true },
  { key: 'settings', label: 'Settings', href: '#/settings', icon: 'settings' }
]

function shell(active) {
  const m = app.session.membership
  return html`<div class="shell" id="shell">
    <aside class="sidebar" aria-label="Main navigation">
      <a class="brand" href="#/dashboard">${LOGO}<span>TeamPulse</span></a>
      <div class="org-name" title="${m.orgName}">${m.orgName}</div>
      <nav class="nav" id="nav">${NAV.filter((n) => !n.manager || app.isManager).map((n) => html`<a href="${n.href}" ${n.key === active ? raw('aria-current="page"') : ''}>${icon(n.icon)}<span>${n.label}</span>${n.count && app.counts[n.count] ? html`<span class="count">${app.counts[n.count]}</span>` : ''}</a>`)}</nav>
      <div class="sidebar-foot">${avatar(app.me.name, app.me.pictureUrl)}<div class="who"><b>${app.me.name}</b><span>${m.role}</span></div>
        <button class="btn small ghost" id="logout" title="Sign out">Sign out</button></div>
    </aside>
    <div>
      <div class="topbar"><button class="btn small ghost" id="nav-toggle" aria-label="Open menu" aria-expanded="false">☰</button><a class="brand" href="#/dashboard">${LOGO}<span>TeamPulse</span></a></div>
      <main id="main" tabindex="-1">${loading()}</main>
    </div>
  </div>`
}

async function refreshCounts() {
  if (!app.session?.membership) return
  try {
    const [n, r] = await Promise.all([api('/api/notifications?unread=true'), app.isManager ? api('/api/requests?status=PENDING') : Promise.resolve([])])
    app.counts = { unread: n.unread, requests: r.filter((x) => x.requestedBy !== app.me.id).length }
    const nav = document.getElementById('nav')
    if (nav) nav.querySelectorAll('a').forEach((a) => {
      const item = NAV.find((x) => x.href === a.getAttribute('href'))
      if (!item?.count) return
      a.querySelector('.count')?.remove()
      if (app.counts[item.count]) a.insertAdjacentHTML('beforeend', `<span class="count">${esc(app.counts[item.count])}</span>`)
    })
  } catch { /* counts are best-effort */ }
}
app.refreshCounts = refreshCounts

const ROUTES = [
  [/^#\/dashboard$/, 'dashboard', () => renderDashboard],
  [/^#\/my-tasks$/, 'my-tasks', () => (main, q) => renderTaskList(main, { view: 'mine', q })],
  [/^#\/team-tasks$/, 'team-tasks', () => (main, q) => renderTaskList(main, { view: 'team', q })],
  [/^#\/tasks\/([0-9a-f-]{36})$/, 'my-tasks', (m) => (main) => renderTaskDetail(main, m[1])],
  [/^#\/requests$/, 'requests', () => renderRequests],
  [/^#\/impact$/, 'impact', () => renderImpact],
  [/^#\/impact\/([0-9a-f-]{36})$/, 'impact', (m) => (main) => renderImpactDetail(main, m[1])],
  [/^#\/contribution$/, 'intelligence', () => renderContribution],
  [/^#\/evidence$/, 'evidence', () => renderEvidence],
  [/^#\/contribution\/([0-9a-f-]{36})$/, 'impact', (m) => (main, q) => renderPerson(main, m[1], q)],
  [/^#\/automations$/, 'automations', () => renderAutomations],
  [/^#\/alerts$/, 'alerts', () => renderAlerts],
  [/^#\/reports$/, 'reports', () => renderReports],
  [/^#\/settings(?:\/([a-z-]+))?$/, 'settings', (m) => (main) => renderSettings(main, m[1] || 'profile')]
]

let currentShellKey = null
async function route() {
  const root = document.getElementById('root')
  const [path, query = ''] = location.hash.split('?')
  const q = new URLSearchParams(query)
  if (!app.session) app.session = await api('/api/session')
  const s = app.session
  if (path.startsWith('#/invite/')) sessionStorage.setItem('tp_invite', path.slice('#/invite/'.length))
  // Links from emails work whether or not someone is signed in on this browser.
  if (path.startsWith('#/verify/')) { currentShellKey = null; return renderVerify(root, path.slice('#/verify/'.length)) }
  if (path.startsWith('#/reset/')) { currentShellKey = null; return renderReset(root, path.slice('#/reset/'.length)) }
  if (!s.user) {
    currentShellKey = null
    if (path === '#/signup') return renderSignup(root)
    if (path === '#/forgot') return renderForgot(root)
    return renderLogin(root, q)
  }
  if (!s.membership) { currentShellKey = null; return renderWelcome(root) }
  if (path === '' || path === '#/' || path === '#/login' || path === '#/signup' || path === '#/forgot' || path === '#/welcome' || path.startsWith('#/invite/')) { location.replace('#/dashboard'); return }
  const hit = ROUTES.map(([re, key, fn]) => { const m = path.match(re); return m ? { key, view: fn(m) } : null }).find(Boolean)
  const key = hit?.key || 'dashboard'
  if (currentShellKey === null) {
    root.innerHTML = shell(key)
    document.getElementById('logout').addEventListener('click', async () => { await api('/api/session/logout', { method: 'POST' }); app.session = null; location.hash = '#/login'; route() })
    document.getElementById('nav-toggle').addEventListener('click', (e) => { const sh = document.getElementById('shell'); sh.classList.toggle('nav-open'); e.currentTarget.setAttribute('aria-expanded', sh.classList.contains('nav-open')) })
    document.getElementById('nav').addEventListener('click', () => document.getElementById('shell').classList.remove('nav-open'))
    refreshCounts()
  } else {
    document.querySelectorAll('#nav a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === NAV.find((n) => n.key === key)?.href))
    document.querySelectorAll('#nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'))
  }
  currentShellKey = key
  const main = document.getElementById('main')
  main.innerHTML = loading().toString()
  if (!hit) { main.innerHTML = html`<div class="empty"><h3>Page not found</h3><p><a href="#/dashboard">Go to the dashboard</a></p></div>`.toString(); return }
  // Manager-only screens: a clear message instead of an error (the server refuses the data anyway).
  if (['team-tasks', 'reports'].includes(key) && !app.isManager && !path.startsWith('#/tasks/')) {
    main.innerHTML = html`<div class="card" style="max-width:640px;margin-top:24px"><h1>${key === 'reports' ? 'Reports are for managers' : 'Team Tasks is for managers'}</h1>
      <p class="muted">${key === 'reports' ? 'Reports cover a whole team, so only managers and admins can open them.' : 'Team Tasks shows a whole team’s work, so only managers and admins can open it.'} Your own work is always in My Tasks and on your dashboard.</p>
      <div class="row"><a class="btn" href="#/my-tasks">Go to My Tasks</a><a class="btn ghost" href="#/dashboard">Dashboard</a></div></div>`.toString()
    return
  }
  try {
    await hit.view(main, q)
  } catch (e) {
    main.innerHTML = errorBlock(e).toString()
  }
  if (document.activeElement === document.body) main.focus({ preventScroll: true })
}

export function rerender() { route().catch((e) => toast(e.message, { error: true })) }
/** Go somewhere after the signed-in state changed: one render with a fresh session (no stale render racing it). */
export function navigate(hash, { replace = false } = {}) {
  app.session = null; currentShellKey = null
  if (location.hash === hash) rerender()
  else if (replace) { history.replaceState(null, '', hash); rerender() } else location.hash = hash
}
export async function reloadSession() { app.session = await api('/api/session'); currentShellKey = null; rerender() }

window.addEventListener('hashchange', rerender)
rerender()
setInterval(() => { if (!document.hidden) refreshCounts() }, 60000)

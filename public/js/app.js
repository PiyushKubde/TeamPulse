// KONVO browser app. Talks only to this server's /api; the server decides every permission.
import { api, html, raw, esc, avatar, loading, errorBlock, toast, icon, themePref, setThemePref } from './ui.js'
import { renderLogin, renderWelcome, renderSignup, renderForgot, renderReset, renderVerify, renderInviteAccept } from './views/onboarding.js'
import { renderLanding } from './views/landing.js'
import { renderDashboard } from './views/dashboard.js'
import { renderWorkboard } from './views/workboard.js'
import { renderMyContributions } from './views/my-contributions.js'
import { renderAdmin } from './views/admin.js'
import { renderTaskList, renderTaskDetail } from './views/tasks.js'
import { renderRequests } from './views/requests.js'
import { renderImpact, renderImpactDetail } from './views/impact.js'
import { renderAutomations } from './views/automations.js'
import { renderAlerts } from './views/alerts.js'
import { renderReports } from './views/reports.js'
import { renderSettings } from './views/settings.js'
import { renderContribution, renderPerson } from './views/contribution.js'
import { renderEvidence } from './views/evidence.js'
import { renderAssistant, renderCopilot } from './views/assistant.js'
import { renderContributions, renderJourney } from './views/journeys.js'
import { renderReviews } from './views/reviews.js'
import { renderSlackIntake } from './views/assignments.js'
import { renderReviewQueue } from './views/expectations.js'
import { renderAnalytics } from './views/work-intelligence.js'
import { BRAND, logoMark } from './brand.js'

const LOGO = raw(logoMark(28))

// The document title follows the page: "Tasks · KONVO", and the full product line on public pages.
const setTitle = (label) => { document.title = label ? `${label} · ${BRAND.name}` : `${BRAND.name} — ${BRAND.category}` }

// Admins have two views: the admin console (set-up and status) and the team workspace (the manager's daily work). The choice is remembered per browser.
const readMode = () => { try { return localStorage.getItem('tp-mode') === 'team' ? 'team' : 'admin' } catch { return 'admin' } }

export const app = {
  session: null,
  get role() { return this.session?.membership?.role },
  // Mirrors the server (server/access.js): a manager has authority over their teams' work; an admin runs the organization and acts as a manager
  // only for teams they were explicitly assigned to manage. isStaff is for organization set-up screens (people, invitations, permissions).
  get isStaff() { return ['manager', 'admin'].includes(this.role) },
  get isManager() { return this.role === 'manager' || (this.role === 'admin' && (this.session?.membership?.managedTeamIds?.length ?? 0) > 0) },
  get isAdmin() { return this.role === 'admin' },
  get adminMode() { return this.role === 'admin' && (!this.isManager || readMode() === 'admin') },
  get me() { return this.session?.user },
  counts: {}
}

// Navigation by role (Phase 1 of the UX blueprint). Four places per role, each opening to the pages that used to be separate links, so nothing is
// removed and every route still works. `tab` is the label on the phone's bottom bar; `sum` adds the counts of several sub-links into one badge.
const NAV_MANAGER = () => [
  { key: 'dashboard', label: 'Team Overview', href: '#/dashboard', icon: 'home', tab: 'Overview' },
  { key: 'workboard', label: 'Workboard', href: '#/workboard', icon: 'tasks', tab: 'Workboard', children: [{ key: 'team-tasks', label: 'Team tasks', href: '#/team-tasks' }] },
  { key: 'intelligence', label: 'People', href: '#/contribution', icon: 'team', tab: 'People', children: [{ key: 'impact', label: 'Contributions', href: '#/impact?view=team' }, { key: 'contributions', label: 'Journeys', href: '#/contributions' }] },
  { key: 'reviews-group', label: 'Reviews', href: '#/review', icon: 'flag', tab: 'Reviews', sum: ['review', 'reviews', 'verify', 'evidence'], children: [
    { key: 'review', label: 'Priorities and deadlines', href: '#/review', count: 'review' },
    { key: 'reviews', label: 'Assessments to confirm', href: '#/reviews', count: 'reviews' },
    { key: 'verify', label: 'Contributions to verify', href: '#/impact?view=team&status=PENDING', count: 'verify' },
    { key: 'evidence-review', label: 'Evidence to resolve', href: '#/contribution?tab=review', count: 'evidence' }] },
  { key: 'analytics', label: 'Work Intelligence', href: '#/analytics', icon: 'trending' },
  { section: 'Tools' },
  { key: 'requests', label: 'Task requests', href: '#/requests', icon: 'requests', count: 'requests' },
  { key: 'copilot', label: 'Ask about your team', href: '#/copilot', icon: 'copilot' },
  { key: 'slack-intake', label: 'Work from Slack', href: '#/slack-intake', icon: 'hash' },
  { key: 'automations', label: 'Connected apps', href: '#/automations', icon: 'apps' },
  { key: 'reports', label: 'Reports', href: '#/reports', icon: 'reports' }
]
const NAV_EMPLOYEE = () => [
  { key: 'dashboard', label: 'My Workspace', href: '#/dashboard', icon: 'home', tab: 'Workspace', children: [{ key: 'assistant', label: 'Prepare my day', href: '#/assistant' }] },
  { key: 'my-tasks', label: 'My Tasks', href: '#/my-tasks', icon: 'tasks', tab: 'Tasks', children: [{ key: 'requests', label: 'Task requests', href: '#/requests' }] },
  { key: 'my-contributions', label: 'My Contributions', href: '#/my-contributions', icon: 'award', tab: 'Contributions', children: [
    { key: 'contributions', label: 'Journeys', href: '#/contributions' }, { key: 'my-contribution', label: 'My contribution', href: `#/contribution/${app.me?.id}` }, { key: 'analytics', label: 'My progress', href: '#/analytics' }, { key: 'impact', label: 'Other contributions', href: '#/impact' }] },
  { key: 'settings', label: 'My Profile', href: '#/settings/profile', icon: 'profile', tab: 'Profile', children: [{ key: 'automations', label: 'Connected apps', href: '#/automations' }, { key: 'evidence', label: 'My work evidence', href: '#/evidence' }] }
]
const NAV_ADMIN = () => [
  { key: 'admin', label: 'Admin overview', href: '#/admin', icon: 'home', tab: 'Overview' },
  { key: 'settings-organization', label: 'Organization', href: '#/settings/organization', icon: 'settings' },
  { key: 'settings-members', label: 'Users and teams', href: '#/settings/members', icon: 'team', tab: 'Users' },
  { key: 'settings-permissions', label: 'Roles and permissions', href: '#/settings/permissions', icon: 'shield', tab: 'Roles' },
  { key: 'automations', label: 'Connected apps', href: '#/automations', icon: 'apps', tab: 'Apps' },
  { key: 'settings-alerts', label: 'Alert settings', href: '#/settings/alerts', icon: 'alerts' },
  { key: 'settings-audit', label: 'Audit history', href: '#/settings/audit', icon: 'reports' },
  { key: 'settings-profile', label: 'My profile', href: '#/settings/profile', icon: 'profile' }
]
const navItems = () => (app.adminMode ? NAV_ADMIN() : app.isManager ? NAV_MANAGER() : NAV_EMPLOYEE())
const childrenOf = (n) => n.children || []
const groupKeys = (n) => [n.key, ...childrenOf(n).map((c) => c.key)]
// Pages that are not in the navigation (a manager's own work, reached from the profile menu) still get a proper window title.
const EXTRA_TITLES = { 'my-tasks': 'My Tasks', evidence: 'My work evidence', assistant: 'Prepare my day', impact: 'Contributions', 'impact-mine': 'My contributions', 'my-contribution': 'My contribution' }
// Account links under the navigation (a <nav> too, so they are found with the rest of the navigation).
const footItems = () => [
  { key: 'alerts', label: 'Alerts', href: '#/alerts', icon: 'alerts', count: 'unread' },
  ...(app.isManager && !app.adminMode ? [{ key: 'settings', label: 'Settings', href: '#/settings', icon: 'settings' }] : [])
]
const titleFor = (key) => navItems().flatMap((n) => (n.section ? [] : [n, ...childrenOf(n)])).concat(footItems()).find((n) => n.key === key)?.label || EXTRA_TITLES[key] || null
const countBadge = (k) => (app.counts[k] ? html`<span class="count" data-count="${k}">${app.counts[k]}</span>` : '')
const navLink = (n, active, cls = '') => html`<a class="${cls}" href="${n.href}" data-key="${n.key}" ${n.key === active ? raw('aria-current="page"') : ''}>${n.icon ? icon(n.icon) : ''}<span>${n.label}</span>${n.count ? countBadge(n.count) : ''}</a>`
/** One place with its sub-links; it is open (and highlighted) when the page you are on is in it. */
const navGroup = (n, active) => {
  const keys = groupKeys(n)
  const open = keys.includes(active)
  const sum = (n.sum || []).reduce((t, k) => t + (app.counts[k] || 0), 0)
  return html`<div class="nav-group ${open ? 'open' : ''}"><a class="nav-top" href="${n.href}" data-key="${n.key}" ${n.key === active ? raw('aria-current="page"') : ''} ${open && n.key !== active ? raw('data-in-group="true"') : ''}>${icon(n.icon)}<span>${n.label}</span>${sum ? html`<span class="count" data-count-sum="${n.key}">${sum}</span>` : n.count ? countBadge(n.count) : ''}</a>
    ${childrenOf(n).length ? html`<div class="nav-sub">${childrenOf(n).map((c) => navLink(c, active))}</div>` : ''}</div>`
}
const navHtml = (active) => html`${navItems().map((n) => (n.section ? html`<div class="nav-section">${n.section}</div>` : navGroup(n, active)))}`
const THEMES = [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']]

function shell(active) {
  const m = app.session.membership
  const me = app.me
  const tabs = navItems().filter((n) => n.tab)
  return html`<div class="shell" id="shell">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <a class="logo" href="#/dashboard">${LOGO}<span class="wordmark">${BRAND.name}</span></a>
      <div class="org-name" title="${m.orgName}"><span class="org-dot" aria-hidden="true">${(m.orgName || '?').slice(0, 1).toUpperCase()}</span><span>${m.orgName}</span></div>
      <nav class="nav" id="nav">${navHtml(active)}</nav>
      <div class="sidebar-foot">
        <nav aria-label="Account" class="foot-nav">${footItems().map((n) => navLink(n, active, 'foot-link'))}</nav>
        <button class="profile-btn" id="profile-btn" data-profile aria-haspopup="menu" aria-expanded="false" aria-controls="profile-menu">${avatar(me.name, me.pictureUrl)}<span class="who"><b>${me.name}</b><span>${m.role}</span></span>${icon('chevronUpDown', 'sm')}</button>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <button class="icon-btn" id="nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">${icon('menu')}</button>
        <a class="logo" href="#/dashboard">${LOGO}<span class="wordmark">${BRAND.name}</span></a>
        <a class="icon-btn" href="#/alerts" aria-label="Alerts">${icon('alerts')}${app.counts.unread ? html`<span class="dot" data-count="unread">${app.counts.unread}</span>` : ''}</a>
        <button class="profile-mini" id="profile-btn-m" data-profile aria-haspopup="menu" aria-expanded="false" aria-controls="profile-menu" aria-label="Account and theme">${avatar(me.name, me.pictureUrl)}</button>
      </header>
      <main id="main" tabindex="-1">${loading()}</main>
    </div>
    <nav class="tabbar" aria-label="Quick navigation">${tabs.map((n) => html`<a href="${n.href}" data-key="${n.key}" data-keys="${groupKeys(n).join(' ')}" ${groupKeys(n).includes(active) ? raw('aria-current="page"') : ''}>${icon(n.icon)}<span>${n.tab}</span></a>`)}
      <button type="button" id="more-toggle" aria-controls="sidebar" aria-expanded="false">${icon('more')}<span>More</span></button></nav>
    <div class="menu" id="profile-menu" role="menu" aria-label="Account" hidden>
      <div class="menu-head">${avatar(me.name, me.pictureUrl, 'lg')}<div class="who"><b>${me.name}</b><span>${me.email}</span><span style="text-transform:capitalize">${m.role} · ${m.orgName}</span></div></div>
      <hr>
      ${app.isAdmin && app.isManager ? html`<div class="menu-label">View</div>
      <button class="menu-item" role="menuitem" data-mode="admin" aria-current="${app.adminMode}">${icon('settings', 'sm')}Admin console${app.adminMode ? ' ✓' : ''}</button>
      <button class="menu-item" role="menuitem" data-mode="manager" aria-current="${!app.adminMode}">${icon('team', 'sm')}Team workspace${!app.adminMode ? ' ✓' : ''}</button>
      <hr>` : ''}
      ${app.isStaff ? html`<div class="menu-label">My workspace</div>
      <a class="menu-item" role="menuitem" href="#/my-tasks">${icon('tasks', 'sm')}My tasks</a>
      <a class="menu-item" role="menuitem" href="#/impact?view=mine">${icon('award', 'sm')}My contributions</a>
      <a class="menu-item" role="menuitem" href="#/evidence">${icon('evidence', 'sm')}My work evidence</a>
      <a class="menu-item" role="menuitem" href="#/assistant">${icon('sparkles', 'sm')}Prepare my day</a>
      <hr>` : ''}
      <a class="menu-item" role="menuitem" href="#/settings/profile">${icon('profile', 'sm')}Profile</a>
      <a class="menu-item" role="menuitem" href="#/settings">${icon('settings', 'sm')}Settings</a>
      <hr>
      <div class="menu-label" id="theme-label">Appearance</div>
      <div class="theme-switch" role="radiogroup" aria-labelledby="theme-label">${THEMES.map(([k, l, i]) => html`<button type="button" role="radio" data-theme-pick="${k}" aria-checked="${themePref() === k}">${icon(i)}<span>${l}</span></button>`)}</div>
      <hr>
      <button class="menu-item" role="menuitem" id="logout">${icon('logout', 'sm')}Sign out</button>
    </div>
  </div>`
}

let menuOpener = null
function closeMenu(focusBack = false) {
  const menu = document.getElementById('profile-menu')
  if (!menu || menu.hidden) return
  menu.hidden = true; menuOpener?.setAttribute('aria-expanded', 'false'); if (focusBack) menuOpener?.focus(); menuOpener = null
}
function openMenu(btn) {
  const menu = document.getElementById('profile-menu')
  menuOpener = btn; btn.setAttribute('aria-expanded', 'true'); menu.hidden = false
  const r = btn.getBoundingClientRect(); const w = Math.min(280, window.innerWidth - 20)
  Object.assign(menu.style, { position: 'fixed', width: `${w}px` })
  if (r.top > window.innerHeight / 2) Object.assign(menu.style, { left: `${Math.min(Math.max(10, r.left), window.innerWidth - w - 10)}px`, top: 'auto', bottom: `${window.innerHeight - r.top + 6}px` })
  else Object.assign(menu.style, { left: `${Math.max(10, Math.min(window.innerWidth - w - 10, r.right - w))}px`, top: `${r.bottom + 6}px`, bottom: 'auto' })
  menu.querySelector('[aria-checked="true"]')?.focus()
}
// Document-level handlers, registered once; they look up the current shell each time.
document.addEventListener('click', (e) => { if (!e.target.closest('#profile-menu, [data-profile]')) closeMenu() })
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const sh = document.getElementById('shell')
  if (!document.getElementById('profile-menu')?.hidden) closeMenu(true)
  else if (sh?.classList.contains('nav-open')) { sh.dispatchEvent(new CustomEvent('drawer', { detail: false })); document.getElementById('nav-toggle')?.focus() }
})

function wireShell() {
  const sh = document.getElementById('shell')
  const menu = document.getElementById('profile-menu')
  const drawerButtons = [document.getElementById('nav-toggle'), document.getElementById('more-toggle')]
  const sidebar = document.getElementById('sidebar')
  const phone = matchMedia('(max-width: 820px)')
  // On a phone the closed drawer is off-screen: inert keeps keyboard focus and screen readers out of it.
  const syncInert = () => { sidebar.inert = phone.matches && !sh.classList.contains('nav-open') }
  const setDrawer = (open) => { sh.classList.toggle('nav-open', open); drawerButtons.forEach((b) => b.setAttribute('aria-expanded', String(open))); syncInert(); if (open) document.querySelector('#nav a')?.focus() }
  phone.addEventListener('change', syncInert)
  syncInert()
  drawerButtons.forEach((b) => b.addEventListener('click', () => setDrawer(!sh.classList.contains('nav-open'))))
  document.getElementById('sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) setDrawer(false) })
  sh.addEventListener('click', (e) => { if (sh.classList.contains('nav-open') && !e.target.closest('#sidebar, #nav-toggle, #more-toggle')) setDrawer(false) })

  // Profile menu: one menu, opened from the sidebar (desktop) or the top bar (phone), placed next to its button.
  document.querySelectorAll('[data-profile]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); if (!menu.hidden && menuOpener === b) closeMenu(); else { closeMenu(); openMenu(b) } }))
  sh.addEventListener('drawer', (e) => setDrawer(e.detail))
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]')
    if (b) { closeMenu(); app.setMode(b.dataset.mode, b.dataset.mode === 'manager' ? '#/dashboard' : '#/admin'); return }
    if (e.target.closest('a.menu-item')) closeMenu()
  })
  menu.querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
    setThemePref(b.dataset.themePick)
    menu.querySelectorAll('[data-theme-pick]').forEach((x) => x.setAttribute('aria-checked', String(x === b)))
  }))
  menu.querySelector('.theme-switch').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return
    const all = [...menu.querySelectorAll('[data-theme-pick]')]; const i = all.indexOf(document.activeElement)
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]; next.focus(); next.click()
  })
  document.getElementById('logout').addEventListener('click', async () => { closeMenu(); await api('/api/session/logout', { method: 'POST' }); app.session = null; location.hash = '#/login'; route() })
}

function markActive(key) {
  const nav = document.getElementById('nav')
  if (nav) nav.innerHTML = navHtml(key).toString()
  document.querySelectorAll('#shell .tabbar a[data-keys]').forEach((a) => { if (a.dataset.keys.split(' ').includes(key)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current') })
  document.querySelectorAll('#shell .foot-nav a[data-key]').forEach((a) => { if (a.dataset.key === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current') })
}

async function refreshCounts() {
  if (!app.session?.membership) return
  try {
    const [n, r] = await Promise.all([api('/api/notifications?unread=true'), app.isManager ? api('/api/requests?status=PENDING') : Promise.resolve([])])
    const sig = app.isManager ? await api('/api/signals?scope=team').catch(() => []) : []
    const queue = app.isManager ? await api('/api/parameter-review').catch(() => []) : []
    const pending = app.isManager ? await api('/api/impact?view=team&status=PENDING').catch(() => []) : []
    const evidence = app.isManager ? await api('/api/work-evidence?view=review').catch(() => []) : []
    app.counts = { unread: n.unread, requests: r.filter((x) => x.requestedBy !== app.me.id).length, reviews: sig.filter((x) => x.severity !== 'low').length, review: queue.length,
      verify: Array.isArray(pending) ? pending.filter((x) => x.userId !== app.me.id).length : 0, evidence: Array.isArray(evidence) ? evidence.length : 0 }
    const nav = document.getElementById('nav')
    if (nav) nav.innerHTML = navHtml(currentShellKey).toString()
    document.querySelectorAll('#shell .foot-nav a[data-key]').forEach((a) => {
      const item = footItems().find((x) => x.key === a.dataset.key && x.count)
      if (!item) return
      a.querySelector('.count')?.remove()
      if (app.counts[item.count]) a.insertAdjacentHTML('beforeend', `<span class="count" data-count="${esc(item.count)}">${esc(app.counts[item.count])}</span>`)
    })
    const bell = document.querySelector('.topbar a[href="#/alerts"]')
    if (bell) { bell.querySelector('.dot')?.remove(); if (app.counts.unread) bell.insertAdjacentHTML('beforeend', `<span class="dot">${esc(app.counts.unread)}</span>`) }
  } catch { /* counts are best-effort */ }
}
app.refreshCounts = refreshCounts

const ROUTES = [
  [/^#\/dashboard$/, 'dashboard', () => renderDashboard],
  [/^#\/workboard$/, 'workboard', () => renderWorkboard],
  [/^#\/my-contributions$/, 'my-contributions', () => renderMyContributions],
  [/^#\/admin$/, 'admin', () => renderAdmin],
  [/^#\/my-tasks$/, 'my-tasks', () => (main, q) => renderTaskList(main, { view: 'mine', q })],
  [/^#\/team-tasks$/, 'team-tasks', () => (main, q) => renderTaskList(main, { view: 'team', q })],
  [/^#\/tasks\/([0-9a-f-]{36})$/, 'my-tasks', (m) => (main) => renderTaskDetail(main, m[1])],
  [/^#\/slack-intake$/, 'slack-intake', () => renderSlackIntake],
  [/^#\/requests$/, 'requests', () => renderRequests],
  [/^#\/impact$/, 'impact', () => renderImpact],
  [/^#\/impact\/([0-9a-f-]{36})$/, 'impact', (m) => (main) => renderImpactDetail(main, m[1])],
  [/^#\/contribution$/, 'intelligence', () => renderContribution],
  [/^#\/evidence$/, 'evidence', () => renderEvidence],
  [/^#\/assistant$/, 'assistant', () => renderAssistant],
  [/^#\/contributions$/, 'contributions', () => renderContributions],
  [/^#\/journey\/([0-9a-f-]{36})$/, 'contributions', (m) => (main) => renderJourney(main, m[1])],
  [/^#\/reviews$/, 'reviews', () => renderReviews],
  [/^#\/review$/, 'review', () => renderReviewQueue],
  [/^#\/analytics$/, 'analytics', () => renderAnalytics],
  [/^#\/copilot$/, 'copilot', () => renderCopilot],
  [/^#\/contribution\/([0-9a-f-]{36})$/, 'contributions', (m) => (main, q) => renderPerson(main, m[1], q)],
  [/^#\/automations$/, 'automations', () => renderAutomations],
  [/^#\/alerts$/, 'alerts', () => renderAlerts],
  [/^#\/reports$/, 'reports', () => renderReports],
  [/^#\/settings(?:\/([a-z-]+))?$/, 'settings', (m) => (main) => renderSettings(main, m[1] || 'profile')]
]

let currentShellKey = null
// Every navigation paints into an element of its own. A page that is still loading when the person moves on keeps writing into the
// element it was given, which has been replaced by then, so it can no longer paint over (or look up elements of) the page opened after it.
let navSeq = 0
function claimRoot() {
  const old = document.getElementById('root')
  const fresh = old.cloneNode(false)
  old.replaceWith(fresh)
  return fresh
}
async function route() {
  const nav = ++navSeq
  const [path, query = ''] = location.hash.split('?')
  const q = new URLSearchParams(query)
  if (!app.session) app.session = await api('/api/session')
  if (nav !== navSeq) return // a newer navigation began while the session loaded: it paints, this one must not
  const s = app.session
  // Invitation pages are handled before anything else — they work for signed-in and signed-out users.
  if (path.startsWith('#/invite/')) {
    sessionStorage.setItem('tp_invite', path.slice('#/invite/'.length))
    currentShellKey = null
    setTitle('Accept invitation')
    return renderInviteAccept(claimRoot(), path.slice('#/invite/'.length))
  }
  // Links from emails work whether or not someone is signed in on this browser.
  if (path.startsWith('#/verify/')) { currentShellKey = null; setTitle('Confirm your email'); return renderVerify(claimRoot(), path.slice('#/verify/'.length)) }
  if (path.startsWith('#/reset/')) { currentShellKey = null; setTitle('Reset your password'); return renderReset(claimRoot(), path.slice('#/reset/'.length)) }
  if (!s.user) {
    currentShellKey = null
    if (path === '#/login') { setTitle('Log in'); return renderLogin(claimRoot(), q) }
    if (path === '#/signup') { setTitle('Create your account'); return renderSignup(claimRoot()) }
    if (path === '#/forgot') { setTitle('Reset your password'); return renderForgot(claimRoot()) }
    setTitle(null)
    if (path === '' || path === '#/' || path === '#/landing') return renderLanding(claimRoot())
    // Any other unknown path for unauthenticated users → landing
    return renderLanding(claimRoot())
  }
  if (!s.membership) { currentShellKey = null; setTitle('Welcome'); return renderWelcome(claimRoot()) }
  if (path === '' || path === '#/' || path === '#/landing' || path === '#/login' || path === '#/signup' || path === '#/forgot' || path === '#/welcome') { location.replace(app.adminMode ? '#/admin' : '#/dashboard'); return }
  if (app.adminMode && path === '#/dashboard') { location.replace('#/admin'); return }
  const hit = ROUTES.map(([re, key, fn]) => { const m = path.match(re); return m ? { key, view: fn(m) } : null }).find(Boolean)
  let key = hit?.key || 'dashboard'
  if (app.isManager && path.startsWith('#/tasks/')) key = 'team-tasks'
  if (path.startsWith('#/contribution/')) key = q.get('from') === 'dashboard' ? 'dashboard' : q.get('from') === 'workboard' ? 'workboard' : q.get('from') === 'analytics' ? 'analytics' : path.endsWith(app.me.id) ? 'my-contribution' : app.isManager ? 'intelligence' : 'contributions'
  if (!app.isManager && key === 'workboard') key = 'dashboard'
  const settingsTab = path.match(/^#\/settings(?:\/([a-z-]+))?$/)
  if (settingsTab && app.adminMode) key = `settings-${settingsTab[1] || 'profile'}`
  if (app.isManager && key === 'impact' && q.get('status') === 'PENDING') key = 'verify'
  if (app.isManager && key === 'intelligence' && q.get('tab') === 'review') key = 'evidence-review'
  if (app.isManager && key === 'impact' && q.get('view') === 'mine') key = 'impact-mine'
  setTitle(titleFor(key))
  if (currentShellKey === null) {
    claimRoot().innerHTML = shell(key)
    wireShell()
    refreshCounts()
  } else {
    markActive(key)
  }
  currentShellKey = key
  const previous = document.getElementById('main')
  const main = previous.cloneNode(false)
  previous.replaceWith(main)
  main.innerHTML = loading().toString()
  if (!hit) { main.innerHTML = html`<div class="empty"><h3>Page not found</h3><p><a href="#/dashboard">Go to the dashboard</a></p></div>`.toString(); return }
  // Manager-only screens: a clear message instead of an error (the server refuses the data anyway).
  if (['team-tasks', 'reports', 'copilot', 'slack-intake'].includes(key) && !app.isManager && !path.startsWith('#/tasks/')) {
    main.innerHTML = html`<div class="card" style="max-width:640px;margin-top:24px"><h1>${key === 'reports' ? 'Reports are for managers' : key === 'copilot' ? 'Ask about your team is for managers' : key === 'slack-intake' ? 'Work from Slack is for managers' : 'Team tasks is for managers'}</h1>
      <p class="muted">${key === 'reports' ? 'Reports cover a whole team, so only a team’s manager can open them (an admin only for a team they are assigned to manage).' : key === 'copilot' ? 'The Copilot answers questions about a whole team. Ask about your own work with Prepare my day.' : key === 'slack-intake' ? 'Work from Slack shows how a team’s tasks arrive and who owns them, so only managers and admins can open it. Tasks assigned to you are in My Workspace.' : 'Team tasks shows a whole team’s work, so only managers and admins can open it.'} Your own work is always in My Tasks and My Workspace.</p>
      <div class="row"><a class="btn" href="#/my-tasks">Go to My Tasks</a><a class="btn ghost" href="#/dashboard">Dashboard</a></div></div>`.toString()
    return
  }
  if (key === 'admin' && !app.isAdmin) {
    main.innerHTML = html`<div class="card" style="max-width:640px;margin-top:24px"><h1>The admin overview is for administrators</h1><p class="muted">It holds organization set-up and system status, so only admins can open it.</p><div class="row"><a class="btn" href="#/dashboard">Go to the dashboard</a></div></div>`.toString()
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
/** An admin changes between the admin console and the team workspace: the navigation is rebuilt and the matching home page opens. */
app.setMode = (mode, hash) => {
  try { localStorage.setItem('tp-mode', mode === 'manager' ? 'team' : 'admin') } catch { /* private mode: applies for this page only */ }
  currentShellKey = null
  if (location.hash === hash) rerender(); else location.hash = hash
}
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

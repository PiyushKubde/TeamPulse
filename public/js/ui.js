// Small UI toolkit: escaping templates, API calls, toasts, modals, formatters. No secrets ever live here.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])
class Raw { constructor(s) { this.s = s } toString() { return this.s } }
export const raw = (s) => new Raw(String(s))
/** Tagged template: every interpolation is escaped unless it is raw() or an array of raw/strings from html``. */
export function html(strings, ...values) {
  let out = strings[0]
  values.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('')
    else if (v instanceof Raw) out += v.s
    else if (v === false || v === null || v === undefined) out += ''
    else out += esc(v)
    out += strings[i + 1]
  })
  return raw(out)
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`)
    this.status = status
    this.code = body?.error?.code
    this.details = body?.error?.details
  }
}

export async function api(path, { method = 'GET', body, headers = {}, rawBody } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Requested-With': 'TeamPulse' } : {}), ...headers },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    if (res.status === 401 && data?.error?.code === 'unauthenticated' && !path.startsWith('/api/session')) { location.hash = '#/login'; }
    throw new ApiError(res.status, data)
  }
  return data
}

let toastTimer
export function toast(message, { error = false } = {}) {
  const el = document.getElementById('toast')
  el.textContent = message
  el.className = `toast${error ? ' err' : ''}`
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, error ? 6000 : 3500)
}

export const errorText = (e) => (e?.message || 'Something went wrong.')

/** Opens a modal with the given HTML; `onMount(el, close)` wires it. Resolves with whatever close() is given. */
export function modal(content, onMount) {
  const dlg = document.getElementById('modal')
  const body = document.getElementById('modal-body')
  body.innerHTML = `<div class="modal-inner">${content}</div>`
  return new Promise((resolve) => {
    let done = false
    const close = (value) => { if (done) return; done = true; dlg.close(); resolve(value) }
    dlg.onclose = () => { if (!done) { done = true; resolve(undefined) } }
    dlg.onclick = (e) => { if (e.target === dlg) close(undefined) }
    body.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); close(undefined) }))
    dlg.showModal()
    onMount?.(body, close)
    body.querySelector('input:not([type=hidden]), textarea, select')?.focus()
  })
}

/** A confirmation dialog for destructive or important actions. */
export function confirmDialog({ title, body, confirm = 'Confirm', danger = false, reason = null }) {
  return modal(html`<h2 id="modal-title">${title}</h2><p>${body}</p>
    ${reason ? html`<div class="field"><label for="cf-reason">${reason.label}</label><textarea id="cf-reason" ${reason.required ? raw('required') : ''} maxlength="1000"></textarea></div>` : ''}
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : ''}" id="cf-ok">${confirm}</button></div>`.toString(),
  (el, close) => {
    el.querySelector('#cf-ok').addEventListener('click', () => {
      const r = el.querySelector('#cf-reason')
      if (r && reason?.required && !r.value.trim()) { r.focus(); r.reportValidity?.(); return }
      close(r ? { ok: true, reason: r.value.trim() } : { ok: true })
    })
  })
}

/** Reads a form into an object; empty strings become undefined unless keepEmpty. */
export function formData(form, { keepEmpty = false } = {}) {
  const out = {}
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue }
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue }
    const v = el.value.trim()
    if (v === '' && !keepEmpty) continue
    out[el.name] = v
  }
  return out
}

/** Wires a form submit: disables the button, shows server errors inline, calls onSuccess. */
export function bindForm(form, submit, { onSuccess, errorBox } = {}) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = form.querySelector('[type=submit]')
    const box = errorBox || form.querySelector('.form-error')
    if (box) box.innerHTML = ''
    btn && (btn.disabled = true)
    try {
      const out = await submit(formData(form))
      onSuccess?.(out)
    } catch (err) {
      if (box) box.innerHTML = html`<div class="notice err" role="alert">${errorText(err)}</div>`.toString()
      else toast(errorText(err), { error: true })
      const field = err.details?.field && form.querySelector(`[name="${err.details.field}"]`)
      field?.focus()
    } finally { btn && (btn.disabled = false) }
  })
}

// ---------- formatting ----------
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
export function ago(iso) {
  if (!iso) return ''
  const s = (Date.parse(iso) - Date.now()) / 1000
  const a = Math.abs(s)
  if (a < 60) return rtf.format(Math.round(s), 'second')
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day')
  return new Date(iso).toLocaleDateString()
}
export const dt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—')
export const d = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—')
/** An ISO string → value for <input type=datetime-local> in local time. */
export const toLocalInput = (iso) => { if (!iso) return ''; const x = new Date(iso); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null)
export const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()
export const avatar = (name, url, size = '') => html`<span class="avatar ${size}" aria-hidden="true">${url ? html`<img src="${url}" alt="" referrerpolicy="no-referrer">` : initials(name)}</span>`

// ---------- icons (one stroke set, 24px grid) ----------
const ICON = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  evidence: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  journeys: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19h8a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7h8"/>',
  sparkles: 'M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  team: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  intelligence: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V16a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1.26A7 7 0 0 0 12 2z',
  reviews: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  copilot: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 8.5h8M8 12.5h5"/>',
  reports: 'M18 20V10M12 20V4M6 20v-6',
  requests: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  alerts: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  impact: 'M22 12h-4l-3 9L9 3l-3 9H2',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 18 6-6-6-6',
  chevronUpDown: 'm7 15 5 5 5-5M7 9l5-5 5 5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  plus: 'M12 5v14M5 12h14',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  check: 'M20 6 9 17l-5-5',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  blocked: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  x: 'M18 6 6 18M6 6l12 12',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  trending: 'M22 7 13.5 15.5 8.5 10.5 2 17M16 7h6v6',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  message: 'M7.9 20A9 9 0 1 0 4 16.1L2 22z',
  send: 'm22 2-7 20-4-9-9-4zM22 2 11 13',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  github: 'M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8'
}
/** An inline SVG icon. size: '' (18px) | 'sm' (15px) | 'xs' (13px). */
export const icon = (name, size = '') => {
  const d = ICON[name] || ICON.dot
  return raw(`<svg class="i ${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d.startsWith('<') ? d : `<path d="${d}"/>`}</svg>`)
}

const APP_TILE = { github: ['github', 'GitHub'], slack: ['hash', 'Slack'], gmail: ['mail', 'Gmail'], 'google-calendar': ['calendar', 'Google Calendar'], 'google-sheets': ['table', 'Google Sheets'] }
/** A source application's tile: one icon per app, the same everywhere evidence appears. */
export const appTile = (slug, size = '') => html`<span class="app-icon ${slug} ${size}" title="${(APP_TILE[slug] || [])[1] || slug}">${icon((APP_TILE[slug] || ['dot'])[0])}</span>`

// ---------- theme (light | dark | system), stored per browser; applied before first paint by index.html ----------
export function themePref() { return document.documentElement.dataset.themePref || 'light' }
export function setThemePref(pref) {
  const p = ['light', 'dark', 'system'].includes(pref) ? pref : 'light'
  try { localStorage.setItem('tp-theme', p) } catch { /* private mode: still applies for this page */ }
  const root = document.documentElement
  root.dataset.themePref = p
  root.dataset.theme = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
}

// ---------- domain components ----------
export const STATUS_LABEL = { SUGGESTED: 'Suggested', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', SUBMITTED_FOR_REVIEW: 'In review', COMPLETED: 'Completed', CANCELLED: 'Cancelled' }
export const statusBadge = (s) => html`<span class="badge status s-${s}">${STATUS_LABEL[s] || s}</span>`
const PRIO_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }
export const prioBadge = (p) => html`<span class="prio prio-${p}" title="Priority">${icon('flag', 'xs')}${PRIO_LABEL[p] || p}</span>`
export function conditionBadges(t) {
  return html`${t.overdue ? html`<span class="badge bad">Overdue ${t.hoursOverdue}h</span>` : ''}${t.atRisk ? html`<span class="badge warn">At risk</span>` : ''}${t.unassigned ? html`<span class="badge warn">Unassigned</span>` : ''}`
}
/** "Due tomorrow", "Overdue by 2 days" — relative when close, a date when far. */
export function dueText(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  const day = 86400000
  const startOf = (x) => { const d0 = new Date(x); d0.setHours(0, 0, 0, 0); return d0.getTime() }
  const days = Math.round((startOf(iso) - startOf(Date.now())) / day)
  if (ms < 0) { const late = Math.max(1, Math.round(-ms / 3600000)); return late < 48 ? `Overdue by ${late}h` : `Overdue by ${Math.round(late / 24)} days` }
  if (days === 0) return `Due today, ${new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  if (days === 1) return 'Due tomorrow'
  if (days < 7) return `Due ${new Date(iso).toLocaleDateString(undefined, { weekday: 'long' })}`
  return `Due ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}
export const due = (t) => (t.dueAt ? html`<span class="due ${t.overdue ? 'late' : t.atRisk || (Date.parse(t.dueAt) - Date.now() < 48 * 3600000) ? 'soon' : ''}">${icon('clock', 'xs')}${dueText(t.dueAt)}</span>` : '')
export const progressBar = (p) => html`<div class="progress ${Number(p) >= 100 ? 'ok' : ''}" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><span style="width:${Number(p) || 0}%"></span></div>`
export const REQUEST_LABEL = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CLARIFICATION_REQUESTED: 'Needs clarification', WITHDRAWN: 'Withdrawn' }
export const requestBadge = (s) => html`<span class="badge ${({ PENDING: 'info', APPROVED: 'ok', REJECTED: 'bad', CLARIFICATION_REQUESTED: 'warn' })[s] || 'outline'}">${REQUEST_LABEL[s] || s}</span>`
export const verifyBadge = (s) => html`<span class="badge ${({ PENDING: 'info', VERIFIED: 'ok', REJECTED: 'bad' })[s]}">${({ PENDING: 'Pending verification', VERIFIED: 'Verified', REJECTED: 'Not verified' })[s]}</span>`
/**
 * Provenance label — where a statement comes from. The same visual language everywhere:
 * fact (recorded by TeamPulse or a connected app) · ai (an AI interpretation) · suggested (a proposal awaiting a person) ·
 * self (the person's own account) · verified (a manager verified it) · unverified (a claim) · missing (no evidence yet).
 */
const PROV = { fact: ['eye', 'From records'], ai: ['sparkles', 'AI interpretation'], suggested: ['sparkles', 'Suggested'], self: ['message', 'Your account'], verified: ['shield', 'Manager verified'], unverified: ['alert', 'Not verified yet'], missing: ['help', 'Missing'] }
export const prov = (kind, text = null, title = null) => html`<span class="prov ${kind}" ${title ? raw(`title="${esc(title)}"`) : ''}>${icon(PROV[kind][0], 'xs')}${text || PROV[kind][1]}</span>`
export const CATEGORIES = { REVENUE_GROWTH: 'Revenue or growth', CUSTOMER_EXPERIENCE: 'Customer experience', TIME_SAVED: 'Time saved', RELIABILITY: 'Reliability', COST_REDUCTION: 'Cost reduction', OPERATIONAL_EFFICIENCY: 'Operational efficiency', KNOWLEDGE_INNOVATION: 'Knowledge sharing and innovation' }
export const OUTCOME_TYPES = { DELIVERED: 'Delivered outcome', PREVENTION: 'Prevented a problem', RESEARCH: 'Research / avoided wasted effort', LEARNING: 'Learning (experiment did not work out)' }
export const empty = (title, body, action = '', iconName = 'inbox') => html`<div class="empty"><span class="empty-icon">${icon(iconName)}</span><h3>${title}</h3>${body ? html`<p>${body}</p>` : ''}${action}</div>`
export const loading = (what = 'Loading…') => html`<div class="loading" role="status" aria-live="polite"><span class="loading-label"><span class="spinner" aria-hidden="true"></span>${what}</span><span class="skel h"></span><span class="skel"></span><span class="skel" style="width:72%"></span></div>`
export const errorBlock = (e, retry = true) => html`<div class="notice err" role="alert"><b>Could not load this page.</b> ${errorText(e)} ${retry ? html`<button class="btn small ghost" onclick="location.reload()">Retry</button>` : ''}</div>`

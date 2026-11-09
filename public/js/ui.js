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
export const avatar = (name, url) => html`<span class="avatar" aria-hidden="true">${url ? html`<img src="${url}" alt="" referrerpolicy="no-referrer">` : initials(name)}</span>`

export const STATUS_LABEL = { SUGGESTED: 'Suggested', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', SUBMITTED_FOR_REVIEW: 'In review', COMPLETED: 'Completed', CANCELLED: 'Cancelled' }
const STATUS_TONE = { ASSIGNED: '', IN_PROGRESS: 'info', BLOCKED: 'bad', SUBMITTED_FOR_REVIEW: 'brand', COMPLETED: 'ok', CANCELLED: 'outline', SUGGESTED: 'outline' }
export const statusBadge = (s) => html`<span class="badge ${STATUS_TONE[s] || ''}">${STATUS_LABEL[s] || s}</span>`
export const prioBadge = (p) => html`<span class="badge prio-${p}">${p[0] + p.slice(1).toLowerCase()}</span>`
export function conditionBadges(t) {
  return html`${t.overdue ? html`<span class="badge bad">Overdue ${t.hoursOverdue}h</span>` : ''}${t.atRisk ? html`<span class="badge warn">At risk</span>` : ''}${t.unassigned ? html`<span class="badge warn">Unassigned</span>` : ''}`
}
export const progressBar = (p) => html`<div class="progress" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><span style="width:${Number(p) || 0}%"></span></div>`
export const REQUEST_LABEL = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CLARIFICATION_REQUESTED: 'Needs clarification', WITHDRAWN: 'Withdrawn' }
export const requestBadge = (s) => html`<span class="badge ${({ PENDING: 'info', APPROVED: 'ok', REJECTED: 'bad', CLARIFICATION_REQUESTED: 'warn' })[s] || 'outline'}">${REQUEST_LABEL[s] || s}</span>`
export const verifyBadge = (s) => html`<span class="badge ${({ PENDING: 'info', VERIFIED: 'ok', REJECTED: 'bad' })[s]}">${({ PENDING: 'Pending verification', VERIFIED: 'Verified', REJECTED: 'Not verified' })[s]}</span>`
export const CATEGORIES = { REVENUE_GROWTH: 'Revenue or growth', CUSTOMER_EXPERIENCE: 'Customer experience', TIME_SAVED: 'Time saved', RELIABILITY: 'Reliability', COST_REDUCTION: 'Cost reduction', OPERATIONAL_EFFICIENCY: 'Operational efficiency', KNOWLEDGE_INNOVATION: 'Knowledge sharing and innovation' }
export const OUTCOME_TYPES = { DELIVERED: 'Delivered outcome', PREVENTION: 'Prevented a problem', RESEARCH: 'Research / avoided wasted effort', LEARNING: 'Learning (experiment did not work out)' }
export const empty = (title, body, action = '') => html`<div class="empty"><h3>${title}</h3><p>${body}</p>${action}</div>`
export const loading = (what = 'Loading…') => html`<div class="loading">${what}</div>`
export const errorBlock = (e, retry = true) => html`<div class="notice err" role="alert"><b>Could not load this page.</b> ${errorText(e)} ${retry ? html`<button class="btn small ghost" onclick="location.reload()">Retry</button>` : ''}</div>`

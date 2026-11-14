// Manager-led expectations: the task's Expectations panel (confirmed values, suggestions, history, priority recommendation,
// change requests), the manager's review queue, and work analytics. The server decides every permission; nothing here edits a
// confirmed value except through the manager's own routes, and employees only ever see read-only values and can request a change.
import { api, html, raw, modal, bindForm, toast, errorText, ago, dt, icon, empty, prioBadge, toLocalInput, fromLocalInput } from '../ui.js'
import { app } from '../app.js'

const PRIORITIES = [['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']]
const COMPLEXITY = [['NOT_ASSESSED', 'Not assessed'], ['L1', 'L1'], ['L2', 'L2'], ['L3', 'L3'], ['L4', 'L4']]
const LABELS = { priority: 'Priority', deadline: 'Deadline', expectedOutcome: 'Expected outcome', complexityExpectation: 'Complexity expected', businessImpact: 'Business impact', dependencies: 'Dependencies', successCriteria: 'Success criteria', context: 'Supporting context', workType: 'Work type', responseSla: 'Response target' }
const FIELD = { priority: 'priority', deadline: 'deadline', expectedOutcome: 'expected_outcome', complexityExpectation: 'complexity', businessImpact: 'business_impact', dependencies: 'dependencies', successCriteria: 'success_criteria', context: 'context', workType: 'work_type', responseSla: 'response_sla' }
const LABEL_BY_FIELD = Object.fromEntries(Object.entries(FIELD).map(([k, f]) => [f, LABELS[k]]))
const SOURCE = { MANAGER: 'a manager', LEGACY: 'the existing record', EMPLOYEE: 'the person who created the task', SLACK_EXTRACTION: 'a Slack message', RECOMMENDATION: 'a priority recommendation', CHANGE_REQUEST: 'an approved change request', REQUEST_APPROVAL: 'an approved request' }
const STATE = { CONFIRMED: ['ok', 'Confirmed'], SUGGESTED: ['warn', 'Suggested'], PROPOSED: ['warn', 'Proposed'], UNRESOLVED: ['outline', 'Not set'], UNCONFIRMED: ['warn', 'Unconfirmed'], NOT_SET: ['outline', 'Not set'] }
const CR_KIND = { DEADLINE: 'a different deadline', PRIORITY: 'a different priority', SCOPE: 'a scope change', CLARIFICATION: 'clarification' }
const CR_STATUS = { PENDING: ['info', 'Waiting for a manager'], APPROVED: ['ok', 'Approved'], REJECTED: ['bad', 'Not approved'], ANSWERED: ['ok', 'Answered'], WITHDRAWN: ['outline', 'Withdrawn'] }
const CLOSED = ['COMPLETED', 'CANCELLED', 'DECLINED']

const stateChip = (s) => html`<span class="badge ${(STATE[s] || STATE.UNRESOLVED)[0]}" data-state="${s}">${(STATE[s] || STATE.UNRESOLVED)[1]}</span>`
const sourceText = (s) => SOURCE[s] || String(s || '').toLowerCase().replace(/_/g, ' ')
const pretty = (key, v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (key === 'deadline' || key === 'dueAt') return dt(v)
  if (key === 'priority') return (PRIORITIES.find(([k]) => k === v) || [0, v])[1]
  if (key === 'responseSla') return `${v.amount} ${String(v.unit).replace(/_/g, ' ')}`
  return String(v)
}
const histValue = (field, v) => (v === null || v === undefined ? '—' : field === 'deadline' ? dt(v) : field === 'priority' ? pretty('priority', v) : field === 'factors' ? Object.entries(v).map(([k, n]) => `${k} ${n ?? '?'}`).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v))
const sel = (name, opts, cur, extra = '') => html`<select name="${name}" ${raw(extra)}>${opts.map(([v, l]) => html`<option value="${v}" ${cur === v ? raw('selected') : ''}>${l}</option>`)}</select>`

// ================= the task's Expectations panel =================
export async function renderExpectations(el, t, reload) {
  let p
  try { p = await api(`/api/tasks/${t.id}/parameters`) } catch (e) { el.innerHTML = html`<div class="notice err" role="alert">${errorText(e)}</div>`.toString(); return }
  const manage = p.canManage
  const open = !CLOSED.includes(t.status)
  const rows = Object.keys(LABELS).map((k) => {
    const f = p[k]
    if (!f) return ''
    const base = p.baseline[FIELD[k]]
    const changed = f.state === 'CONFIRMED' && base && JSON.stringify(base.value) !== JSON.stringify(f.value)
    if (f.state === 'UNRESOLVED' && ['businessImpact', 'dependencies', 'successCriteria', 'context', 'workType', 'responseSla', 'complexityExpectation'].includes(k) && !manage) return ''
    const sg = f.suggestion
    return html`<div class="exp-row" data-field="${k}" data-state="${f.state}">
      <div class="exp-head"><b>${LABELS[k]}</b>${stateChip(f.state)}</div>
      <div class="exp-value pre">${k === 'priority' && f.value ? prioBadge(f.value) : pretty(k, f.value)}</div>
      ${f.state === 'CONFIRMED' ? html`<div class="small muted">Confirmed by ${f.confirmedBy?.name || 'a manager'}${f.confirmedAt ? ` ${ago(f.confirmedAt)}` : ''} · from ${sourceText(f.source)}${changed ? html` · originally <b>${pretty(k, base.value)}</b>` : ''}</div>` : ''}
      ${f.state === 'UNRESOLVED' ? html`<div class="small muted">${k === 'priority' ? 'No priority has been confirmed. Nothing is assumed.' : k === 'deadline' ? 'No confirmed deadline: it cannot be overdue and raises no deadline alert.' : 'Not set.'}</div>` : ''}
      ${sg ? html`<div class="exp-suggestion" data-testid="suggestion-${k}"><div><b>${sg.status === 'PROPOSED' ? 'Proposed' : 'Suggested'}: ${pretty(k, sg.value)}</b> <span class="small muted">· from ${sourceText(sg.source)}${sg.actorName ? ` (${sg.actorName})` : ''}${sg.confidence ? ` · ${String(sg.confidence).toLowerCase()} confidence` : ''} · ${ago(sg.createdAt)}</span></div>
        ${sg.evidence?.slackRef ? html`<div class="small muted">Read from a Slack message${sg.evidence.extractedAt ? ` at ${dt(sg.evidence.extractedAt)}` : ''}. Not confirmed: it is not used for overdue alerts or deadlines.</div>` : html`<div class="small muted">Not confirmed: it is not used for overdue alerts or deadlines.</div>`}
        ${manage && open ? html`<div class="row" style="margin-top:6px"><button class="btn small" data-accept="${k}" data-testid="accept-${k}">Accept</button><button class="btn small ghost" data-edit-confirm="${k}" data-testid="edit-${k}">Edit and confirm</button><button class="btn small ghost" data-reject="${k}" data-testid="reject-${k}">Reject</button></div>` : ''}</div>` : ''}
      ${manage && open && f.state !== 'CONFIRMED' && !sg && k !== 'responseSla' ? html`<div class="row" style="margin-top:6px"><button class="btn small ghost" data-set="${k}" data-testid="set-${k}">Confirm a value</button></div>` : ''}
    </div>`
  })
  const tg = p.targets
  const targets = manage && tg && (tg.responseSla || tg.completionTarget) ? html`<div class="exp-targets" data-testid="targets"><b>Suggested targets</b> <span class="badge warn">Suggested – not confirmed</span>
    ${tg.responseSla ? html`<div class="small">Response target: ${tg.responseSla.amount} ${String(tg.responseSla.unit).replace(/_/g, ' ')}${tg.responseSla.respondBy ? `, by ${dt(tg.responseSla.respondBy)}` : ''}. <span class="muted">${tg.responseSla.basis}</span></div>` : ''}
    ${tg.completionTarget ? html`<div class="small">Completion target: ${dt(tg.completionTarget.dueAt)}. <span class="muted">${tg.completionTarget.basis}</span> <button class="btn small ghost" data-use-target="${tg.completionTarget.dueAt}">Confirm as the deadline</button></div>` : ''}
    <div class="small muted">These do not change the official deadline. Times follow the organization's time zone and working calendar.</div></div>` : ''

  const recs = p.recommendations || []
  const latest = recs[0]
  const fac = p.factors || {}
  const FACTORS = [['businessImpact', 'Business impact', 30], ['urgency', 'Urgency', 25], ['dependencies', 'Dependencies', 20], ['risk', 'Risk', 15], ['strategic', 'Strategic importance', 10]]
  const recommend = manage && open ? html`<details class="exp-reco" id="reco" data-testid="reco"><summary><b>Suggest priority</b> <span class="small muted">a recommendation, not a decision</span></summary>
    <form id="factors-form" class="stack" style="margin-top:10px"><div class="form-error"></div>
      <p class="small muted">Rate what you know from 1 (low) to 5 (high). Anything left as Unknown adds nothing: it is never guessed. Urgency comes from the confirmed deadline if you leave it unknown.</p>
      <div class="fields">${FACTORS.map(([k, l, w]) => html`<div class="field"><label for="fx-${k}">${l} <span class="field-hint">weight ${w}</span></label><select id="fx-${k}" name="${k}" data-testid="factor-${k}"><option value="">Unknown</option>${[1, 2, 3, 4, 5].map((n) => html`<option value="${n}" ${fac[k] === n ? raw('selected') : ''}>${n}</option>`)}</select></div>`)}</div>
      <label class="check"><input type="checkbox" name="verifiedIncident" ${p.verifiedIncident ? raw('checked') : ''}> A verified incident is affecting people now</label>
      <div class="row"><button class="btn" type="submit" data-testid="suggest-priority">Save ratings and suggest a priority</button></div></form>
    ${latest ? recommendationCard(latest) : ''}
    ${recs.length > 1 ? html`<details style="margin-top:8px"><summary class="small muted">Earlier recommendations (${recs.length - 1})</summary><ul class="list">${recs.slice(1).map((r) => html`<li><div class="grow small">${dt(r.createdAt)}: ${r.suggestedPriority ? `${r.suggestedPriority} (score ${r.score})` : 'not enough ratings'} · ${r.status.toLowerCase()}${r.finalPriority ? `, final ${r.finalPriority}` : ''} · ${r.configVersion}</div></li>`)}</ul></details>` : ''}</details>` : ''

  const crs = p.changeRequests || []
  const mine = t.isMine && open
  const crBlock = (crs.length || mine) ? html`<div class="exp-requests" data-testid="change-requests"><div class="row between"><b>Change requests</b>${mine ? html`<button class="btn small ghost" id="req-change" data-testid="request-change">Request a change</button>` : ''}</div>
    ${crs.length ? html`<ul class="list">${crs.map((r) => html`<li data-cr="${r.id}" data-status="${r.status}"><div class="grow"><div><span class="badge ${CR_STATUS[r.status][0]}">${CR_STATUS[r.status][1]}</span> <b>${r.requestedByName}</b> asked for ${CR_KIND[r.kind]} <span class="small muted">${ago(r.createdAt)}</span></div>
      ${r.proposed?.dueAt ? html`<div class="small">Proposed deadline: ${dt(r.proposed.dueAt)}</div>` : ''}${r.proposed?.priority ? html`<div class="small">Proposed priority: ${pretty('priority', r.proposed.priority)}</div>` : ''}
      ${r.kind === 'SCOPE' ? html`<div class="small">${Object.entries(r.proposed || {}).map(([k, v]) => `${LABELS[k] || k}: ${v}`).join(' · ')}</div>` : ''}
      <div class="small pre">${r.reason}</div>${r.decisionNote ? html`<div class="small muted">${r.decidedByName || 'A manager'}: ${r.decisionNote}</div>` : ''}
      ${r.status === 'PENDING' ? html`<div class="row" style="margin-top:6px">${manage ? html`<button class="btn small" data-decide="${r.id}" data-testid="decide-${r.kind.toLowerCase()}">Decide</button>` : ''}${r.requestedBy === app.me.id ? html`<button class="btn small ghost" data-withdraw="${r.id}">Withdraw</button>` : ''}</div>` : ''}</div></li>`)}</ul>` : html`<p class="small muted" style="margin:6px 0 0">No requests yet. If the deadline, priority or scope needs to change, ask here; a manager decides.</p>`}</div>` : ''

  const history = p.history.length ? html`<details class="exp-history" data-testid="history"><summary class="small">History (${p.history.length})</summary><ul class="timeline">${p.history.map((e) => html`<li><div><b>${e.actorName || 'System'}</b> ${({ CONFIRMED: e.kind === 'CHANGE' ? 'changed' : 'confirmed', SUGGESTED: 'suggested', PROPOSED: 'proposed', REJECTED: 'rejected a suggestion for' })[e.status] || e.status.toLowerCase()} <b>${LABEL_BY_FIELD[e.field] || e.field.replace(/_/g, ' ')}</b>${e.status === 'REJECTED' ? '' : html`: ${e.kind === 'CHANGE' ? html`${histValue(e.field, e.oldValue)} → ` : ''}${histValue(e.field, e.value)}`} <span class="small muted">· ${sourceText(e.source)}${e.reason ? ` · ${e.reason}` : ''}${e.confidence ? ` · ${String(e.confidence).toLowerCase()} confidence` : ''}</span></div><div class="when">${dt(e.createdAt)}</div></li>`)}</ul></details>` : ''

  el.innerHTML = html`<div class="card-head"><h2><span class="card-icon">${icon('target')}</span>What is expected</h2>${manage ? '' : html`<span class="small muted">Set by your manager</span>`}</div>
    ${p.origin === 'EMPLOYEE' || p.origin === 'SLACK' ? html`<div class="notice" data-testid="origin-note">${p.origin === 'SLACK' ? 'Created from Slack.' : 'Created by an employee.'} Priority and deadline stay unconfirmed until a manager confirms them.</div>` : ''}
    <div class="exp-grid">${rows}</div>${targets}${recommend}${crBlock}${history}`.toString()

  // ---- wiring ----
  const done = async (msg) => { if (msg) toast(msg); app.refreshCounts?.(); (reload || (() => renderExpectations(el, t, reload)))() }
  const run = async (fn, msg) => { try { await fn(); await done(msg) } catch (e) { toast(errorText(e), { error: true }) } }
  const base = `/api/tasks/${t.id}/parameters`
  el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => run(() => api(`${base}/${FIELD[b.dataset.accept]}/accept`, { method: 'POST', body: {} }), 'Confirmed.')))
  el.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const r = await reasonDialog('Reject this suggestion?', 'It stays in the history. The value remains not set.', 'Reject', false)
    if (r) run(() => api(`${base}/${FIELD[b.dataset.reject]}/reject`, { method: 'POST', body: { reason: r.reason } }), 'Suggestion rejected.')
  }))
  const editAndConfirm = async (key, current) => {
    const v = await valueDialog(key, current)
    if (v) run(async () => {
      if (p[key].suggestion) await api(`${base}/${FIELD[key]}/accept`, { method: 'POST', body: { value: v.value, reason: v.reason } })
      else await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { [key === 'deadline' ? 'dueAt' : key]: v.value, reason: v.reason } })
    }, 'Confirmed.')
  }
  el.querySelectorAll('[data-edit-confirm]').forEach((b) => b.addEventListener('click', () => editAndConfirm(b.dataset.editConfirm, p[b.dataset.editConfirm].suggestion?.value)))
  el.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => editAndConfirm(b.dataset.set, null)))
  el.querySelector('[data-use-target]')?.addEventListener('click', (e) => run(() => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { dueAt: e.target.dataset.useTarget, reason: 'Confirmed the suggested completion target.' } }), 'Deadline confirmed.'))
  el.querySelector('#factors-form') && bindForm(el.querySelector('#factors-form'), async (d) => {
    const factors = Object.fromEntries(FACTORS.map(([k]) => [k, d[k] ? Number(d[k]) : null]))
    await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { factors, verifiedIncident: Boolean(d.verifiedIncident) } })
    return api(`/api/tasks/${t.id}/priority-recommendation`, { method: 'POST' })
  }, { onSuccess: () => { sessionStorage.setItem('exp-reco-open', t.id); done('Recommendation ready.') } })
  if (sessionStorage.getItem('exp-reco-open') === t.id) { const r = el.querySelector('#reco'); if (r) r.open = true; sessionStorage.removeItem('exp-reco-open') }
  el.querySelectorAll('[data-reco-accept]').forEach((b) => b.addEventListener('click', () => run(() => api(`/api/tasks/${t.id}/priority-recommendation/${b.dataset.recoAccept}/decision`, { method: 'POST', body: { decision: 'ACCEPT' } }), 'Priority confirmed.')))
  el.querySelectorAll('[data-reco-dismiss]').forEach((b) => b.addEventListener('click', () => run(() => api(`/api/tasks/${t.id}/priority-recommendation/${b.dataset.recoDismiss}/decision`, { method: 'POST', body: { decision: 'REJECT' } }), 'Recommendation dismissed.')))
  el.querySelectorAll('[data-reco-override]').forEach((b) => b.addEventListener('click', async () => {
    const r = await modal(html`<h2 id="modal-title">Override the recommendation</h2><p class="muted">You choose the priority. The recommendation and your reason are kept for audit.</p>
      <form id="f"><div class="form-error"></div><div class="field"><label for="o-p">Priority</label>${sel('priority', PRIORITIES.filter(([k]) => k !== b.dataset.suggested), 'HIGH', 'id="o-p" data-testid="override-priority"')}</div>
      <div class="field"><label for="o-r">Reason (required)</label><textarea id="o-r" name="reason" required maxlength="1000" data-testid="override-reason"></textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit" data-testid="override-submit">Confirm priority</button></div></form>`.toString(), (m, close) => {
      bindForm(m.querySelector('#f'), (d) => api(`/api/tasks/${t.id}/priority-recommendation/${b.dataset.recoOverride}/decision`, { method: 'POST', body: { decision: 'OVERRIDE', priority: d.priority, reason: d.reason } }), { onSuccess: () => close(true) })
    })
    if (r) done('Priority confirmed.')
  }))
  el.querySelector('#req-change')?.addEventListener('click', async () => { if (await changeRequestDialog(t)) done('Request sent to your manager.') })
  el.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', async () => { const cr = crs.find((x) => x.id === b.dataset.decide); if (cr && await decideDialog(cr)) done('Decision saved.') }))
  el.querySelectorAll('[data-withdraw]').forEach((b) => b.addEventListener('click', () => run(() => api(`/api/change-requests/${b.dataset.withdraw}/withdraw`, { method: 'POST' }), 'Request withdrawn.')))
}

function recommendationCard(r) {
  const open = r.status === 'OPEN'
  return html`<div class="exp-rec" data-testid="recommendation" data-status="${r.status}">
    ${r.suggestedPriority
    ? html`<div class="row"><b>Suggested priority: ${prioBadge(r.suggestedPriority)}</b><span class="badge outline">Score ${r.score}</span><span class="badge ${r.confidence === 'HIGH' ? 'ok' : r.confidence === 'MEDIUM' ? 'info' : 'warn'}">${String(r.confidence).toLowerCase()} confidence</span><span class="small muted">${r.configVersion}</span></div>`
    : html`<div><b>Not enough rated factors to suggest a priority.</b> <span class="small muted">${r.configVersion}</span></div>`}
    ${r.criticalReview ? html`<div class="notice warn" role="status" data-testid="critical-warning"><b>Critical needs your confirmation.</b> Only you can confirm a Critical priority; keywords or scores alone never do.</div>` : ''}
    <table class="small"><thead><tr><th>Factor</th><th>Weight</th><th>Score</th><th>Why</th></tr></thead><tbody>${r.factors.map((f) => html`<tr><td>${f.label}</td><td>${f.weight}</td><td>${f.known ? `${f.score} / 5` : 'Unknown'}</td><td>${f.explanation}${f.evidence?.length ? html` <span class="muted">· evidence: ${f.evidence.map((e) => e.kind).join(', ')}</span>` : ''}</td></tr>`)}</tbody></table>
    <p class="small muted" style="margin:6px 0">${r.note}</p>
    ${open ? html`<div class="row">${r.suggestedPriority ? html`<button class="btn small" data-reco-accept="${r.id}" data-testid="reco-accept">Accept ${r.suggestedPriority.toLowerCase()}</button><button class="btn small ghost" data-reco-override="${r.id}" data-suggested="${r.suggestedPriority}" data-testid="reco-override">Override…</button>` : ''}<button class="btn small ghost" data-reco-dismiss="${r.id}">Dismiss</button></div>` : html`<div class="small muted">${r.status === 'ACCEPTED' ? `Accepted by a manager ${ago(r.decidedAt)}.` : r.status === 'OVERRIDDEN' ? `Overridden: final priority ${r.finalPriority}. ${r.decisionNote || ''}` : r.status === 'REJECTED' ? 'Dismissed.' : 'Replaced by a newer recommendation.'}</div>`}</div>`
}

/** Asks for a reason (optional or required). Resolves { reason } or undefined. */
function reasonDialog(title, body, confirm, required) {
  return modal(html`<h2 id="modal-title">${title}</h2><p>${body}</p><form id="f"><div class="field"><label for="rd-r">Reason ${required ? '' : html`<span class="field-hint">optional</span>`}</label><textarea id="rd-r" name="reason" maxlength="1000" ${required ? raw('required') : ''}></textarea></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit" data-testid="reason-ok">${confirm}</button></div></form>`.toString(), (m, close) => {
    m.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); close({ reason: m.querySelector('#rd-r').value.trim() || undefined }) })
  })
}

/** Edit-and-confirm / set a value for one field. Resolves { value, reason } or undefined. */
function valueDialog(key, current) {
  const input = key === 'priority' ? sel('value', PRIORITIES, current || 'MEDIUM', 'id="vd-v" data-testid="value-input"')
    : key === 'deadline' ? html`<input id="vd-v" name="value" type="datetime-local" required value="${toLocalInput(current)}" data-testid="value-input">`
      : key === 'complexityExpectation' ? sel('value', COMPLEXITY.filter(([k]) => k !== 'NOT_ASSESSED'), current || 'L2', 'id="vd-v" data-testid="value-input"')
        : html`<textarea id="vd-v" name="value" required maxlength="3000" rows="3" data-testid="value-input">${current || ''}</textarea>`
  return modal(html`<h2 id="modal-title">Confirm ${LABELS[key].toLowerCase()}</h2><form id="f"><div class="form-error"></div>
    <div class="field"><label for="vd-v">${LABELS[key]}</label>${input}</div>
    <div class="field"><label for="vd-r">Reason <span class="field-hint">optional, kept in the history</span></label><input id="vd-r" name="reason" type="text" maxlength="1000"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit" data-testid="value-confirm">Confirm</button></div></form>`.toString(), (m, close) => {
    m.querySelector('#f').addEventListener('submit', (e) => {
      e.preventDefault()
      const raw0 = m.querySelector('#vd-v').value.trim()
      if (!raw0) return
      close({ value: key === 'deadline' ? fromLocalInput(raw0) : raw0, reason: m.querySelector('#vd-r').value.trim() || undefined })
    })
  })
}

// ================= employee: request a change =================
export function changeRequestDialog(t) {
  return modal(html`<h2 id="modal-title">Request a change</h2><p class="muted">Your manager decides. The deadline, priority and scope stay as they are until then.</p>
    <form id="f"><div class="form-error"></div>
      <div class="field"><label for="cr-k">What do you need?</label><select id="cr-k" name="kind" data-testid="cr-kind"><option value="DEADLINE">A different deadline</option><option value="PRIORITY">A different priority</option><option value="SCOPE">A scope change</option><option value="CLARIFICATION">Clarification</option></select></div>
      <div class="field" data-for="DEADLINE"><label for="cr-d">Proposed deadline</label><input id="cr-d" name="dueAt" type="datetime-local" data-testid="cr-deadline"></div>
      <div class="field" data-for="PRIORITY" hidden><label for="cr-p">Proposed priority</label>${sel('priority', PRIORITIES, t.priority === 'LOW' ? 'MEDIUM' : 'LOW', 'id="cr-p"')}</div>
      <div data-for="SCOPE" hidden><div class="field"><label for="cr-s1">Expected outcome</label><textarea id="cr-s1" name="expectedOutcome" maxlength="2000" rows="2"></textarea></div><div class="field"><label for="cr-s2">Success criteria</label><textarea id="cr-s2" name="successCriteria" maxlength="3000" rows="2"></textarea></div><div class="field"><label for="cr-s3">Dependencies or context</label><textarea id="cr-s3" name="dependencies" maxlength="2000" rows="2"></textarea></div></div>
      <div class="field"><label for="cr-r" id="cr-rl">Why?</label><textarea id="cr-r" name="reason" required minlength="3" maxlength="2000" rows="3" data-testid="cr-reason"></textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit" data-testid="cr-submit">Send request</button></div></form>`.toString(), (m, close) => {
    const kind = m.querySelector('#cr-k')
    const sync = () => {
      m.querySelectorAll('[data-for]').forEach((x) => { x.hidden = x.dataset.for !== kind.value })
      m.querySelector('#cr-rl').textContent = kind.value === 'CLARIFICATION' ? 'Your question' : 'Why?'
    }
    kind.addEventListener('change', sync)
    bindForm(m.querySelector('#f'), (d) => {
      const proposed = d.kind === 'DEADLINE' ? { dueAt: fromLocalInput(d.dueAt) } : d.kind === 'PRIORITY' ? { priority: d.priority } : d.kind === 'SCOPE' ? Object.fromEntries(['expectedOutcome', 'successCriteria', 'dependencies'].filter((k) => d[k]).map((k) => [k, d[k]])) : undefined
      return api(`/api/tasks/${t.id}/change-requests`, { method: 'POST', body: { kind: d.kind, reason: d.reason, proposed } })
    }, { onSuccess: () => close(true) })
  })
}

// ================= manager: decide on a change request =================
export function decideDialog(cr) {
  const clar = cr.kind === 'CLARIFICATION'
  return modal(html`<h2 id="modal-title">${clar ? 'Answer' : 'Decide on'} ${CR_KIND[cr.kind]}</h2><p><b>${cr.requestedByName}</b>: ${cr.reason}</p>
    ${cr.proposed?.dueAt ? html`<p>Proposed deadline: <b>${dt(cr.proposed.dueAt)}</b></p>` : ''}${cr.proposed?.priority ? html`<p>Proposed priority: <b>${pretty('priority', cr.proposed.priority)}</b></p>` : ''}
    <form id="f"><div class="form-error"></div>
      ${clar ? '' : html`<fieldset class="field" style="border:0;padding:0"><legend class="small muted">Decision</legend><label class="check"><input type="radio" name="decision" value="APPROVE" checked data-testid="decision-approve"> Approve and apply it</label><label class="check"><input type="radio" name="decision" value="REJECT" data-testid="decision-reject"> Do not approve</label></fieldset>`}
      <div class="field"><label for="dd-n">${clar ? 'Your answer' : 'Note'} <span class="field-hint">${clar ? 'required' : 'required when not approving'}</span></label><textarea id="dd-n" name="note" maxlength="2000" ${clar ? raw('required') : ''} data-testid="decision-note"></textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit" data-testid="decision-submit">Save decision</button></div></form>`.toString(), (m, close) => {
    bindForm(m.querySelector('#f'), (d) => api(`/api/change-requests/${cr.id}/decision`, { method: 'POST', body: { decision: clar ? 'ANSWER' : d.decision || 'APPROVE', note: d.note } }), { onSuccess: () => close(true) })
  })
}

// ================= manager review queue =================
export async function renderReviewQueue(main) {
  if (!app.isManager) { main.innerHTML = empty('The review queue is for managers', 'Priority and deadline confirmations and change requests are decided by managers.').toString(); return }
  const [queue, requests] = await Promise.all([api('/api/parameter-review'), api('/api/change-requests?status=PENDING')])
  const paint = () => {
    main.innerHTML = html`<header class="page-head"><div><h1>Priorities and deadlines</h1><p class="muted">Priorities and deadlines that are not confirmed yet, and changes people have asked for. Nothing here is official until you decide.</p></div></header>
      <section class="card" data-testid="review-queue" aria-labelledby="rq-h"><div class="card-head"><h2 id="rq-h"><span class="card-icon">${icon('flag')}</span>Waiting for confirmation (${queue.length})</h2></div>
        ${queue.length ? html`<ul class="list">${queue.map((q) => html`<li data-testid="review-item" data-task="${q.taskId}"><div class="grow">
          <a href="#/tasks/${q.taskId}"><b>${q.title}</b></a> <span class="small muted">${q.assigneeName ? `· ${q.assigneeName}` : '· unassigned'} · ${q.origin === 'SLACK' ? 'from Slack' : q.origin === 'EMPLOYEE' ? 'created by an employee' : q.origin === 'REQUEST' ? 'from a request' : ''}</span>
          <div class="row small" style="margin-top:4px">Priority ${stateChip(q.priorityState)} Deadline ${stateChip(q.deadlineState)} ${q.pendingChangeRequests ? html`<span class="badge info">${q.pendingChangeRequests} request${q.pendingChangeRequests > 1 ? 's' : ''}</span>` : ''}</div>
          ${q.suggestions.map((s) => html`<div class="small" style="margin-top:4px"><b>${s.status === 'PROPOSED' ? 'Proposed' : 'Suggested'} ${(LABEL_BY_FIELD[s.field] || s.field).toLowerCase()}:</b> ${pretty(s.field === 'deadline' ? 'deadline' : s.field === 'priority' ? 'priority' : s.field, s.value)} <span class="muted">· ${sourceText(s.source)}</span></div>`)}
        </div><a class="btn small" href="#/tasks/${q.taskId}" data-testid="review-open">Review</a></li>`)}</ul>` : empty('Nothing waiting', 'Every open task has a confirmed priority and no suggestion is waiting.', '', 'checkCircle')}</section>
      <section class="card" data-testid="cr-queue" style="margin-top:16px" aria-labelledby="cq-h"><div class="card-head"><h2 id="cq-h"><span class="card-icon">${icon('message')}</span>Change requests (${requests.length})</h2></div>
        ${requests.length ? html`<ul class="list">${requests.map((r) => html`<li data-testid="cr-item" data-cr="${r.id}"><div class="grow"><b>${r.requestedByName}</b> asks for ${CR_KIND[r.kind]} on <a href="#/tasks/${r.taskId}">${r.taskTitle}</a> <span class="small muted">${ago(r.createdAt)}</span>
          ${r.proposed?.dueAt ? html`<div class="small">Proposed deadline: ${dt(r.proposed.dueAt)}</div>` : ''}${r.proposed?.priority ? html`<div class="small">Proposed priority: ${pretty('priority', r.proposed.priority)}</div>` : ''}${r.kind === 'SCOPE' ? html`<div class="small">${Object.entries(r.proposed || {}).map(([k, v]) => `${LABELS[k] || k}: ${v}`).join(' · ')}</div>` : ''}
          <div class="small pre">${r.reason}</div></div><button class="btn small" data-decide="${r.id}" data-testid="cr-decide">${r.kind === 'CLARIFICATION' ? 'Answer' : 'Decide'}</button></li>`)}</ul>` : empty('No pending requests', 'When someone asks for a different deadline, priority or scope, it appears here.', '', 'inbox')}</section>`.toString()
    main.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', async () => {
      const cr = requests.find((x) => x.id === b.dataset.decide)
      if (cr && await decideDialog(cr)) { toast('Decision saved.'); app.refreshCounts?.(); renderReviewQueue(main).catch((e) => toast(errorText(e), { error: true })) }
    }))
  }
  paint()
}

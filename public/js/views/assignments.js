// The acceptance workflow in the browser: accept / decline / transfer, the mandatory missed-deadline explanation, and the
// manager's Slack intake view. The server decides every permission; buttons only reflect what it says is allowed.
import { api, html, raw, modal, bindForm, toast, errorText, confirmDialog, ago, dt, statusBadge, prioBadge, conditionBadges, empty, icon, due, avatar, prov, STATUS_LABEL } from '../ui.js'
import { app, rerender } from '../app.js'

const STATE = { PENDING: ['info', 'Waiting for an answer'], ACCEPTED: ['ok', 'Accepted'], DECLINED: ['bad', 'Declined'], TRANSFERRED_OUT: ['outline', 'Handed over'], SUPERSEDED: ['outline', 'Replaced by a manager'] }
const SOURCE = { SLACK_MENTION: 'Tagged in Slack', TRANSFER: 'Handed over by a teammate', MANAGER: 'Assigned by a manager' }
const TRANSFER = { PENDING: ['info', 'Waiting for an answer'], ACCEPTED: ['ok', 'Accepted'], DECLINED: ['warn', 'Declined'], CANCELLED: ['outline', 'Withdrawn'] }
const REVIEW = { PENDING: ['info', 'Waiting for review'], REVIEWED: ['outline', 'Reviewed'], ACCEPTED: ['ok', 'Explanation accepted'], NEEDS_CLARIFICATION: ['warn', 'Needs clarification'], FOLLOW_UP_REQUIRED: ['warn', 'Follow-up required'] }
const ROLE = { REQUESTER: 'Requested by', SUPPORT: 'Helping', REVIEWER: 'Reviewer' }
const SEV = { LOW: 'Low · assigned', MEDIUM: 'Medium · no movement', HIGH: 'High · deadline near', CRITICAL: 'Critical · deadline missed' }
const badge = ([tone, label]) => html`<span class="badge ${tone}">${label}</span>`
const sev = (s) => html`<span class="sev ${s}" title="${SEV[s] || s}">${s[0] + s.slice(1).toLowerCase()}</span>`
const excerpt = (s, n = 160) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''))
/** Slack markup → readable text: <@U123> becomes @Name when the name is known, otherwise a neutral @someone (ids are for managers, not employees). */
export const slackText = (text, names = {}, fallback = '@someone') => String(text || '')
  .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => (names[id] ? `@${names[id]}` : fallback))
  .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2').replace(/<(https?:[^>]+)>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const links = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ url }))

// ---------- dialogs (shared by the task page, the inbox and the manager view) ----------
/** Decline with a reason. Resolves true when the task was declined, false when the person backed out. */
export async function declineDialog(taskId) {
  const r = await confirmDialog({ title: 'Decline this task?', body: 'Your manager is told and decides who takes it. Declining is never counted against you.', confirm: 'Decline task', danger: true, reason: { label: 'Why can you not take it?', required: true } })
  if (!r?.ok) return false
  await api(`/api/tasks/${taskId}/decline`, { method: 'POST', body: { reason: r.reason } })
  return true
}

/** Offer the task to a teammate (candidates come from the server: your own team only). Resolves true when offered. */
export async function transferDialog(taskId, candidates) {
  if (!candidates?.length) { await modal(html`<h2 id="modal-title">Nobody to hand it to</h2><p>There is nobody else in your team to offer this task to. You can decline it with a reason, or ask your manager.</p><div class="row end"><button class="btn" data-close>OK</button></div>`.toString()); return false }
  const out = await modal(html`<h2 id="modal-title">Transfer this task</h2><p class="small muted">Choose a teammate. They must accept before it becomes theirs — until then it stays with you.</p>
    <form id="f"><div class="form-error"></div>
      <div class="field"><label for="tr-to">Hand it to</label><select id="tr-to" name="toUserId" required><option value="">Choose a teammate…</option>${candidates.map((c) => html`<option value="${c.userId}">${c.name}</option>`)}</select></div>
      <div class="field"><label for="tr-r">Why?</label><textarea id="tr-r" name="reason" required minlength="3" maxlength="1000" placeholder="e.g. they know this system better, or I am at capacity"></textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Offer transfer</button></div></form>`.toString(),
  (el, close) => bindForm(el.querySelector('#f'), (b) => api(`/api/tasks/${taskId}/transfer`, { method: 'POST', body: b }), { onSuccess: () => close(true) }))
  return out === true
}

/** The offered person answers. Accepting is one click; declining needs a reason. */
export async function answerTransfer(transferId, decision) {
  if (decision === 'ACCEPT') { await api(`/api/transfers/${transferId}/decision`, { method: 'POST', body: { decision } }); return true }
  const r = await confirmDialog({ title: 'Decline this transfer?', body: 'The task stays with the person who offered it, and they are told why.', confirm: 'Decline transfer', danger: true, reason: { label: 'Why can you not take it?', required: true } })
  if (!r?.ok) return false
  await api(`/api/transfers/${transferId}/decision`, { method: 'POST', body: { decision, note: r.reason } })
  return true
}

export async function withdrawTransfer(transferId) {
  const r = await confirmDialog({ title: 'Cancel this transfer?', body: 'The task stays with its current owner. The offer stays in the history.', confirm: 'Cancel transfer', reason: { label: 'Note (optional)', required: false } })
  if (!r?.ok) return false
  await api(`/api/transfers/${transferId}/cancel`, { method: 'POST', body: { note: r.reason || undefined } })
  return true
}

const attempt = async (fn, message, after) => {
  try { if ((await fn()) === false) return; if (message) toast(message); app.refreshCounts?.(); await after?.() } catch (e) { toast(errorText(e), { error: true }) }
}

// ---------- "Awaiting your answer": dashboards and My tasks ----------
/** What waits on this person: tasks to accept, transfers offered to them, overdue work needing an explanation. Renders nothing when clear. */
export async function renderInbox(box) {
  if (!box?.isConnected) return // the page this belonged to is gone
  let inbox
  try { inbox = await api('/api/assignments/inbox') } catch (e) { if (!box.isConnected) return; box.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
  let explain = []
  try {
    const overdue = await api('/api/tasks?view=mine&condition=overdue')
    const checked = await Promise.all(overdue.slice(0, 6).map((t) => api(`/api/tasks/${t.id}/workflow`).then((w) => (w.deadline.explanationRequired.length ? t : null)).catch(() => null)))
    explain = checked.filter(Boolean)
  } catch { /* the explanation prompts are also on each task */ }
  if (!box.isConnected) return // the page was replaced while this loaded
  const { awaitingAcceptance: waiting, transfersOfferedToMe: offered, transfersIProposed: proposed, declinedByMe: declined, candidates } = inbox
  if (!waiting.length && !offered.length && !proposed.length && !explain.length && !declined.length) { box.innerHTML = ''; return }
  box.innerHTML = html`<section class="card" aria-labelledby="inbox-h" style="margin-bottom:16px"><div class="card-head"><div><h2 id="inbox-h"><span class="card-icon warn">${icon('inbox')}</span>Waiting for your answer</h2><p>Accepting is one click. You can decline with a reason, or hand a task to a teammate. None of this is held against you.</p></div></div>
    <ul class="mini-list">
      ${waiting.map((t) => html`<li class="inbox-item" data-task="${t.id}"><span class="lead-icon warn">${icon('inbox')}</span><div class="grow"><a class="ttl" href="#/tasks/${t.id}">${t.title}</a>
        <div class="row small muted" style="margin-top:3px">${prioBadge(t.priority)} ${due(t)} <span>${t.requesterName ? `${t.requesterName} asked${t.fromSlack ? ' in Slack' : ''}` : t.fromSlack ? 'From Slack' : ''}</span></div>
        ${t.pendingTransfer ? html`<div class="small muted" style="margin-top:6px">You offered this to ${t.pendingTransfer.toName}. Waiting for their answer.</div>`
          : html`<div class="assign-actions"><button class="btn small" data-a="accept">${icon('check', 'sm')}Accept</button><button class="btn small ghost" data-a="decline">Decline</button><button class="btn small ghost" data-a="transfer">Transfer</button></div>`}</div></li>`)}
      ${offered.map((x) => html`<li class="inbox-item" data-transfer="${x.id}"><span class="lead-icon brand">${icon('team')}</span><div class="grow"><a class="ttl" href="#/tasks/${x.taskId}">${x.taskTitle}</a>
        <div class="small muted">${x.fromName} offered you this task: “${excerpt(x.reason, 120)}”</div>
        <div class="assign-actions"><button class="btn small" data-a="t-accept">${icon('check', 'sm')}Accept it</button><button class="btn small ghost" data-a="t-decline">Decline</button></div></div></li>`)}
      ${proposed.map((x) => html`<li class="inbox-item" data-transfer="${x.id}"><span class="lead-icon">${icon('clock')}</span><div class="grow"><a class="ttl" href="#/tasks/${x.taskId}">${x.taskTitle}</a>
        <div class="small muted">Offered to ${x.toName}. It stays yours until they accept.</div><div class="assign-actions"><button class="btn small ghost" data-a="t-cancel">Cancel offer</button></div></div></li>`)}
      ${explain.map((t) => html`<li class="inbox-item"><span class="lead-icon bad">${icon('alert')}</span><div class="grow"><a class="ttl" href="#/tasks/${t.id}">${t.title}</a><div class="small muted">Missed its deadline. Tell your manager what happened.</div>
        <div class="assign-actions"><a class="btn small" href="#/tasks/${t.id}">Explain what happened</a></div></div></li>`)}
      ${declined.map((t) => html`<li class="inbox-item"><span class="lead-icon">${icon('x')}</span><div class="grow"><a class="ttl" href="#/tasks/${t.id}">${t.title}</a><div class="small muted">You declined it${t.reason ? `: “${excerpt(t.reason, 100)}”` : ''}. It is with your manager now.</div></div></li>`)}
    </ul></section>`.toString()
  const again = () => renderInbox(box)
  box.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
    const li = b.closest('li')
    const task = li.dataset.task
    const transfer = li.dataset.transfer
    const act = b.dataset.a
    b.disabled = true
    const reenable = () => { b.disabled = false }
    if (act === 'accept') attempt(() => api(`/api/tasks/${task}/accept`, { method: 'POST' }), 'Accepted. It is now in your active work.', again).finally(reenable)
    else if (act === 'decline') attempt(() => declineDialog(task), 'Declined. Your manager has been told.', again).finally(reenable)
    else if (act === 'transfer') attempt(() => transferDialog(task, candidates), 'Offered. It stays yours until they accept.', again).finally(reenable)
    else if (act === 't-accept') attempt(() => answerTransfer(transfer, 'ACCEPT'), 'Accepted. The task is yours now.', again).finally(reenable)
    else if (act === 't-decline') attempt(() => answerTransfer(transfer, 'DECLINE'), 'Declined. The task stays with them.', again).finally(reenable)
    else if (act === 't-cancel') attempt(() => withdrawTransfer(transfer), 'Offer cancelled.', again).finally(reenable)
  }))
}

// ---------- the task page ----------
const banner = (tone, ic, title, body, actions = '') => html`<div class="banner ${tone}" role="status"><span class="lead-icon ${tone}">${icon(ic)}</span><div><b>${title}</b>${body ? html`<div>${body}</div>` : ''}${actions}</div></div>`

/** Banners at the top of a task: waiting for acceptance, declined, transfer pending/offered, explanation required. */
export function workflowBanners(wf, t, a) {
  const out = []
  if (t.status === 'PENDING_ACCEPTANCE') {
    out.push(t.isMine
      ? banner('warn', 'inbox', 'This task was given to you', 'Accept it to start, hand it to a teammate, or decline with a reason. Accepting is just an acknowledgement — nothing is counted until real work happens.')
      : banner('warn', 'clock', `Waiting for ${t.assigneeName || 'the owner'} to accept`, wf.source ? 'It came from a Slack message. Until they accept, it is not part of their active work.' : 'Until they accept, it is not part of their active work.'))
  }
  if (t.status === 'DECLINED') {
    out.push(banner('bad', 'x', `${t.assigneeName || 'The owner'} declined this task`, t.declinedReason ? `Reason: “${t.declinedReason}”. It needs a new owner or more detail. This is not held against them.` : 'It needs a new owner. This is not held against them.',
      a.assign ? html`<div class="assign-actions"><button class="btn small" data-act="assign">${icon('team', 'sm')}Choose a new owner</button></div>` : ''))
  }
  const x = t.pendingTransfer
  if (x) {
    if (a.decideTransfer) {
      out.push(banner('brand', 'team', `${x.fromName} offered you this task`, `“${x.reason}”. It becomes yours only if you accept.`,
        html`<div class="assign-actions"><button class="btn small" data-act="tr-accept" data-id="${x.id}">${icon('check', 'sm')}Accept it</button><button class="btn small ghost" data-act="tr-decline" data-id="${x.id}">Decline</button></div>`))
    } else {
      out.push(banner('brand', 'clock', `Transfer pending: ${x.fromName} → ${x.toName}`, `Ownership changes only if ${x.toName} accepts. Until then ${x.fromName} stays the owner.`,
        a.cancelTransfer ? html`<div class="assign-actions"><button class="btn small ghost" data-act="tr-cancel" data-id="${x.id}">Cancel transfer</button></div>` : ''))
    }
  }
  for (const dueAt of wf.deadline.explanationRequired) {
    out.push(banner('bad', 'alert', 'This task missed its deadline', `It was due ${dt(dueAt)}. Please tell your manager what happened. It takes a minute, and a missed deadline is not a score — the reason is what matters.`,
      html`<div class="assign-actions"><button class="btn small" data-act="explain" data-due="${dueAt}">${icon('requests', 'sm')}Explain what happened</button></div>`))
  }
  return out
}

/** "Where this came from": the original Slack message. */
export function sourceCard(wf) {
  const s = wf.source
  if (!s) return ''
  // When exactly one person is tagged, they are the person this task was first given to.
  const tagged = wf.assignments.find((x) => x.source === 'SLACK_MENTION')
  const names = s.mentions.length === 1 && tagged ? { [s.mentions[0]]: tagged.name } : {}
  return html`<section class="card" aria-labelledby="src-h"><div class="card-head"><h2 id="src-h"><span class="card-icon">${icon('hash')}</span>Where this came from</h2>${prov('fact', 'Slack message')}</div>
    <div class="small muted">${s.senderName ? `${s.senderName} wrote` : 'Posted'} in Slack${app.isManager && s.channelId ? ` · channel ${s.channelId}` : ''} · ${ago(s.receivedAt)}</div>
    <blockquote class="quote">${s.text ? slackText(s.text, names) : 'The message text is no longer kept.'}</blockquote>
    <div class="row between" style="margin-top:10px">${s.permalink ? html`<a href="${s.permalink}" target="_blank" rel="noopener noreferrer">${icon('arrowRight', 'xs')} Open in Slack</a>` : html`<span class="small muted">No Slack link was available.</span>`}
      <span class="small muted">${s.extraction === 'deterministic' ? 'Read by fixed rules. No AI was used.' : ''}</span></div></section>`
}

/** Who owned the task, how each owner answered, every transfer, and who else was involved. */
export function ownershipCard(wf) {
  if (!wf.assignments.length && !wf.transfers.length && !wf.participants.length) return ''
  return html`<section class="card" aria-labelledby="own-h"><div class="card-head"><h2 id="own-h"><span class="card-icon">${icon('team')}</span>Ownership history</h2>${prov('fact', 'Recorded history')}</div>
    ${wf.assignments.length ? html`<ul class="list">${wf.assignments.map((x) => html`<li><div class="grow"><div class="row"><b>${x.name}</b> ${badge(STATE[x.state] || ['outline', x.state])}</div>
      <div class="small muted">${SOURCE[x.source] || x.source}${x.assignedByName ? ` · ${x.assignedByName}` : ''} · ${dt(x.assignedAt)}${x.respondedAt ? ` · answered ${ago(x.respondedAt)}` : ''}</div>${x.reason ? html`<div class="small">“${x.reason}”</div>` : ''}</div></li>`)}</ul>` : ''}
    ${wf.transfers.length ? html`<h3 style="margin:14px 0 6px">Transfers</h3><ul class="list">${wf.transfers.map((x) => html`<li><div class="grow"><div class="row"><b>${x.fromName} → ${x.toName}</b> ${badge(TRANSFER[x.status] || ['outline', x.status])}</div>
      <div class="small">“${x.reason}”</div><div class="small muted">Offered ${ago(x.createdAt)}${x.decidedAt ? ` · settled ${ago(x.decidedAt)}${x.decidedByName ? ` by ${x.decidedByName}` : ''}` : ''}</div>${x.decisionNote ? html`<div class="small">Answer: “${x.decisionNote}”</div>` : ''}</div></li>`)}</ul>` : ''}
    ${wf.participants.length ? html`<h3 style="margin:14px 0 6px">Others involved</h3><div class="chips">${wf.participants.map((p) => html`<span class="chip">${ROLE[p.role] || p.role}: ${p.name}</span>`)}</div><p class="small muted" style="margin:6px 0 0">They did not own the task. Shared work is counted once.</p>` : ''}</section>`
}

const explanationBlock = (x, t) => html`<div class="submission" data-exp="${x.id}">
  <div class="row between"><b>${x.userName}: ${x.reasonLabel}</b>${badge(REVIEW[x.reviewStatus] || ['outline', x.reviewStatus])}</div>
  <div class="small muted">For the deadline of ${dt(x.originalDeadline)} · written ${ago(x.submittedAt)}</div>
  ${x.explanation ? html`<p class="pre" style="margin:8px 0 0">${x.explanation}</p>` : ''}
  ${x.evidenceLinks.length ? html`<div class="chips" style="margin-top:8px">${x.evidenceLinks.map((l) => html`<a class="chip" href="${l.url}" target="_blank" rel="noopener noreferrer">${icon('evidence', 'xs')} ${l.label || l.url}</a>`)}</div>` : ''}
  ${x.entries.map((e) => html`<div class="entry ${e.kind === 'REVIEW' ? 'review' : ''}"><div class="small"><b>${e.authorName}</b> ${e.kind === 'REVIEW' ? `reviewed it: ${(REVIEW[e.reviewStatus] || [0, e.reviewStatus])[1].toLowerCase()}` : 'added context'} · ${ago(e.createdAt)}</div>${e.body ? html`<div class="pre">${e.body}</div>` : ''}</div>`)}
  <div class="assign-actions">${x.userId === app.me.id ? html`<button class="btn small ghost" data-act="exp-context" data-id="${x.id}">Add context</button>` : ''}${t.canManage && (x.userId !== app.me.id || app.isAdmin) ? html`<button class="btn small" data-act="exp-review" data-id="${x.id}">Review</button>` : ''}</div></div>`

/** Missed deadlines (kept after completion) with each explanation, its added context and the manager's reviews. */
export function deadlineCard(wf, t) {
  const d = wf.deadline
  if (!d.missed.length && !d.explanations.length) return ''
  return html`<section class="card" id="deadline-card" aria-labelledby="dl-h"><div class="card-head"><div><h2 id="dl-h"><span class="card-icon bad">${icon('clock')}</span>Missed deadline</h2><p>A missed deadline is information, not a score. What matters is why, and whether it was communicated.</p></div>${prov('fact', 'Recorded history')}</div>
    <ul class="list">${d.missed.map((m) => html`<li><div class="grow"><b>Due ${dt(m.dueAt)}</b><div class="small muted">Noticed ${ago(m.missedAt)}</div></div>${m.explained ? html`<span class="badge ok">Explained</span>` : html`<span class="badge warn">Not explained yet</span>`}</li>`)}</ul>
    ${d.explanations.map((x) => explanationBlock(x, t))}</section>`
}

function explainDialog(id, wf, dueAt) {
  return modal(html`<h2 id="modal-title">What happened with the deadline?</h2><p class="small muted">Your manager reads this. It is context, not a penalty: blockers, scope changes and unrealistic deadlines are all valid reasons.</p>
    <form id="f"><div class="form-error"></div>
      <div class="field"><label for="x-c">Main reason</label><select id="x-c" name="reasonCategory" required><option value="">Choose a reason…</option>${wf.deadline.reasons.map((r) => html`<option value="${r.key}">${r.label}</option>`)}</select></div>
      <div class="field"><label for="x-t" id="x-tl">What happened? <span class="field-hint">optional</span></label><textarea id="x-t" name="explanation" maxlength="4000" placeholder="A few sentences: what got in the way, and what you did about it."></textarea></div>
      <div class="field"><label for="x-l">Supporting links <span class="field-hint">optional</span></label><textarea id="x-l" name="links" rows="2" placeholder="One link per line (ticket, thread, document…)"></textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Send explanation</button></div></form>`.toString(), (el, close) => {
    const sel = el.querySelector('#x-c'); const ta = el.querySelector('#x-t')
    sel.addEventListener('change', () => {
      const other = sel.value === 'OTHER'
      ta.required = other; if (other) ta.minLength = 10; else ta.removeAttribute('minlength')
      el.querySelector('#x-tl').innerHTML = other ? 'What happened? <span class="field-hint">required for “Other” (at least 10 characters)</span>' : 'What happened? <span class="field-hint">optional</span>'
    })
    bindForm(el.querySelector('#f'), (b) => api(`/api/tasks/${id}/deadline-explanation`, { method: 'POST', body: { reasonCategory: b.reasonCategory, explanation: b.explanation, dueAt, evidenceLinks: links(b.links) } }), { onSuccess: () => close(true) })
  })
}

const contextDialog = (explanationId) => modal(html`<h2 id="modal-title">Add to your explanation</h2><p class="small muted">What you wrote before stays exactly as it was. This is added below it.</p>
  <form id="f"><div class="form-error"></div><div class="field"><label for="c-b">More context</label><textarea id="c-b" name="body" required minlength="3" maxlength="4000"></textarea></div>
  <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Add</button></div></form>`.toString(),
(el, close) => bindForm(el.querySelector('#f'), (b) => api(`/api/deadline-explanations/${explanationId}/context`, { method: 'POST', body: b }), { onSuccess: () => close(true) }))

const reviewDialog = (explanationId) => modal(html`<h2 id="modal-title">Review this explanation</h2><p class="small muted">Your decision and comment are kept as part of the history. A missed deadline never lowers anyone’s rating on its own.</p>
  <form id="f"><div class="form-error"></div>
    <div class="field"><label for="v-s">Decision</label><select id="v-s" name="status" required>${Object.entries(REVIEW).filter(([k]) => k !== 'PENDING').map(([k, [, l]]) => html`<option value="${k}">${l}</option>`)}</select></div>
    <div class="field"><label for="v-c" id="v-cl">Comment <span class="field-hint">optional</span></label><textarea id="v-c" name="comment" maxlength="2000"></textarea></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save review</button></div></form>`.toString(), (el, close) => {
  const sel = el.querySelector('#v-s'); const ta = el.querySelector('#v-c')
  const sync = () => { const need = ['NEEDS_CLARIFICATION', 'FOLLOW_UP_REQUIRED'].includes(sel.value); ta.required = need; el.querySelector('#v-cl').innerHTML = `Comment <span class="field-hint">${need ? 'required: say what you need' : 'optional'}</span>` }
  sel.addEventListener('change', sync); sync()
  bindForm(el.querySelector('#f'), (b) => api(`/api/deadline-explanations/${explanationId}/review`, { method: 'POST', body: b }), { onSuccess: () => close(true) })
})

/** Click handlers for the task page (the generic data-act binder passes the clicked button). */
export function workflowActions({ id, wf, run }) {
  const done = (msg) => run(async () => {}, msg)
  const guard = async (fn) => { try { await fn() } catch (e) { toast(errorText(e), { error: true }) } }
  return {
    accept: () => run(() => api(`/api/tasks/${id}/accept`, { method: 'POST' }), 'Accepted. It is now in your active work.'),
    decline: () => guard(async () => { if (await declineDialog(id)) done('Declined. Your manager has been told.') }),
    transfer: () => guard(async () => { if (await transferDialog(id, wf.candidates)) done('Offered. It stays yours until they accept.') }),
    'tr-accept': (b) => guard(async () => { if (await answerTransfer(b.dataset.id, 'ACCEPT')) done('Accepted. The task is yours now.') }),
    'tr-decline': (b) => guard(async () => { if (await answerTransfer(b.dataset.id, 'DECLINE')) done('Declined. The task stays with them.') }),
    'tr-cancel': (b) => guard(async () => { if (await withdrawTransfer(b.dataset.id)) done('Transfer cancelled.') }),
    explain: (b) => guard(async () => { if (await explainDialog(id, wf, b.dataset.due) === true) done('Thank you. Your manager has your explanation.') }),
    'exp-context': (b) => guard(async () => { if (await contextDialog(b.dataset.id) === true) done('Added.') }),
    'exp-review': (b) => guard(async () => { if (await reviewDialog(b.dataset.id) === true) done('Review saved.') })
  }
}

// ---------- manager: Slack intake ----------
const REASON = { unmapped: 'Not mapped to a person yet', unconfirmed: 'Claimed by someone, not confirmed', workspace_mismatch: 'Mapped in a different Slack workspace', inactive: 'The mapped person is no longer active' }
const assignBadge = (t) => (t.pendingTransfer ? html`<span class="badge info">Transfer pending</span>` : t.status === 'PENDING_ACCEPTANCE' ? html`<span class="badge warn">Waiting for acceptance</span>` : t.status === 'DECLINED' ? html`<span class="badge bad">Declined</span>` : t.acceptanceState === 'accepted' ? html`<span class="badge ok">Accepted</span>` : html`<span class="muted">—</span>`)
const tile = (label, n, href, tone = '') => (href
  ? html`<a class="stat ${n ? tone : ''}" href="${href}"><div class="label">${label}</div><div class="value">${n}</div></a>`
  : html`<div class="stat ${n ? tone : ''}"><div class="label">${label}</div><div class="value">${n}</div></div>`)

export async function renderSlackIntake(main, q) {
  const params = new URLSearchParams()
  for (const k of ['assigneeId', 'teamId', 'status', 'acceptance', 'severity', 'due']) if (q.get(k)) params.set(k, q.get(k))
  const [ov, members, teams, assignable] = await Promise.all([api(`/api/slack-intake/overview?${params}`), api('/api/members'), api('/api/teams'), api('/api/assignable').catch(() => [])])
  const s = ov.summary
  const sel = (name, opts, label) => html`<label class="sr" style="position:absolute;left:-999px" for="f-${name}">${label}</label><select id="f-${name}" name="${name}"><option value="">${label}</option>${opts.map(([v, l]) => html`<option value="${v}" ${q.get(name) === v ? raw('selected') : ''}>${l}</option>`)}</select>`
  const hasFilter = [...q.keys()].length > 0
  const people = members.filter((m) => m.inScope && m.status === 'active')
  const declined = ov.tasks.filter((t) => t.status === 'DECLINED')
  const slackNames = Object.fromEntries(ov.identities.mappings.map((x) => [x.slackUserId, x.name]))
  const queue = [...ov.explanations].sort((a, b) => Number(['PENDING', 'NEEDS_CLARIFICATION'].includes(b.reviewStatus)) - Number(['PENDING', 'NEEDS_CLARIFICATION'].includes(a.reviewStatus)))
  main.innerHTML = html`
    <div class="page-head"><div><div class="eyebrow">${icon('hash', 'xs')}Slack intake</div><h1>Work from Slack</h1><p>Tasks created from messages in your task channels: where each came from, who was tagged, who owns it now, and what is waiting on you. Nothing here ranks or scores anyone.</p></div>
      <div class="row"><a class="btn ghost" href="#/automations">${icon('apps')}Channel setup</a></div></div>
    <div class="stats" aria-label="Summary">
      ${tile('Awaiting acceptance', s.pendingAcceptance, '#/slack-intake?acceptance=pending', 'warn')}${tile('Accepted', s.accepted, '#/slack-intake?acceptance=accepted')}${tile('Declined', s.declined, '#/slack-intake?acceptance=declined', 'bad')}
      ${tile('Transfers pending', s.pendingTransfers, '#/slack-intake?acceptance=transfer_pending', 'warn')}${tile('Need a manager', s.needManager, null, 'warn')}${tile('Overdue', s.overdue, '#/slack-intake?due=overdue', 'bad')}
      ${tile('Explanations to review', s.explanationsToReview, null, 'warn')}${tile('Slack people to map', s.unresolvedPeople, null, 'warn')}
    </div>
    <form class="filters toolbar slack-filters" id="filters" role="search">
      ${sel('assigneeId', people.map((p) => [p.userId, p.name]), 'Any employee')}
      ${teams.length > 1 ? sel('teamId', teams.map((t) => [t.id, t.name]), 'Any team') : ''}
      ${sel('status', Object.entries(STATUS_LABEL).filter(([k]) => k !== 'SUGGESTED'), 'Any status')}
      ${sel('acceptance', [['pending', 'Awaiting acceptance'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['transfer_pending', 'Transfer pending']], 'Any assignment state')}
      ${sel('severity', Object.entries(SEV), 'Any alert level')}
      ${sel('due', [['overdue', 'Overdue'], ['week', 'Due within 7 days']], 'Any deadline')}
      <button class="btn ghost small" type="submit">Apply</button>${hasFilter ? html`<a class="btn link small" href="#/slack-intake">Clear</a>` : ''}
    </form>
    ${ov.tasks.length ? html`<div class="table-wrap"><table class="task-table"><thead><tr><th>Task</th><th class="hide-sm">Asked by · tagged</th><th>Owner now</th><th>Assignment</th><th class="hide-sm">Last real movement</th><th>Due</th><th class="hide-sm">Alerts</th></tr></thead><tbody>
      ${ov.tasks.map((t) => html`<tr class="clickable" data-href="#/tasks/${t.id}"><td><a href="#/tasks/${t.id}"><b>${t.title}</b></a><div class="meta" style="margin-top:3px">${statusBadge(t.status)} ${conditionBadges(t)} ${t.permalink ? html`<a href="${t.permalink}" target="_blank" rel="noopener noreferrer">Slack ${icon('arrowRight', 'xs')}</a>` : ''}</div></td>
        <td class="hide-sm">${t.requesterName || '—'}<div class="small muted">tagged ${t.taggedName || '—'}</div></td>
        <td>${t.assigneeName ? html`<div class="row nowrap" style="gap:8px">${avatar(t.assigneeName, null, 'sm')}<span>${t.assigneeName}</span></div>` : '—'}${t.transfers ? html`<div class="small muted">${t.transfers} transfer${t.transfers === 1 ? '' : 's'}</div>` : ''}</td>
        <td>${assignBadge(t)}</td>
        <td class="hide-sm">${t.hoursSinceMovement !== null ? html`<span class="${t.hoursSinceMovement >= 24 ? 'badge warn' : ''}">${t.hoursSinceMovement}h without movement</span>` : t.lastMeaningfulAt ? ago(t.lastMeaningfulAt) : html`<span class="muted">—</span>`}${t.openBlockers ? html`<div class="small muted">${t.openBlockers} open blocker${t.openBlockers === 1 ? '' : 's'}</div>` : ''}</td>
        <td class="nowrap">${due(t) || html`<span class="muted">—</span>`}</td>
        <td class="hide-sm">${t.alerts.length ? html`<span class="row" style="gap:4px">${t.alerts.map(sev)}</span>` : html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div>`
      : hasFilter ? empty('Nothing matches', 'Try other filters, or clear them.', html`<a class="btn small ghost" href="#/slack-intake">Clear filters</a>`, 'search')
        : empty('No tasks from Slack yet', 'Set up a Slack channel for task intake in Connected Apps, map your people to their Slack ids below, then tag someone in a task message.', html`<a class="btn small" href="#/automations">${icon('apps')}Set up a channel</a>`, 'hash')}

    <section class="card" id="need-manager" style="margin-top:16px"><div class="card-head"><div><h2><span class="card-icon warn">${icon('help')}</span>Needs a manager</h2><p>Task messages that could not be assigned on their own: nobody tagged, several people tagged, or a person who is not mapped. Nothing was guessed.</p></div></div>
      ${ov.needManager.length ? html`<ul class="mini-list">${ov.needManager.map((n) => html`<li><div class="grow"><div class="ttl">${excerpt(slackText(n.text, slackNames, `@${n.mentions[0] || 'someone'}`), 140) || 'Message text no longer kept'}</div><div class="small muted">${n.senderName || 'Someone'} · ${ago(n.createdAt)}</div><div class="small">${n.reason}</div></div>
        <div class="row" style="gap:6px">${n.requestStatus ? html`<span class="badge ${n.requestStatus === 'PENDING' ? 'warn' : 'outline'}">${n.requestStatus.toLowerCase()}</span>` : ''}${n.permalink ? html`<a class="btn small ghost" href="${n.permalink}" target="_blank" rel="noopener noreferrer">Slack</a>` : ''}${n.requestId ? html`<a class="btn small" href="#/requests">Decide</a>` : ''}</div></li>`)}</ul>`
        : empty('Nothing waiting', 'Every task message so far could be assigned to the person tagged.', '', 'checkCircle')}</section>

    <div class="grid two" style="margin-top:16px">
      <section class="card" id="transfers"><div class="card-head"><div><h2><span class="card-icon">${icon('team')}</span>Transfers</h2><p>A transfer changes the owner only after the new person accepts. Settle a pending one to keep the current owner.</p></div></div>
        ${ov.transfers.length ? html`<ul class="list">${ov.transfers.slice(0, 12).map((x) => html`<li><div class="grow"><a href="#/tasks/${x.taskId}"><b>${x.taskTitle}</b></a><div class="small">${x.fromName} → ${x.toName} · “${excerpt(x.reason, 90)}”</div>
          <div class="small muted">${ago(x.createdAt)}${x.decidedAt ? ` · settled ${ago(x.decidedAt)}` : ''}${x.decisionNote ? ` · “${excerpt(x.decisionNote, 80)}”` : ''}</div>${x.status === 'PENDING' ? html`<div class="assign-actions"><button class="btn small ghost" data-settle="${x.id}">Keep current owner</button></div>` : ''}</div>${badge(TRANSFER[x.status] || ['outline', x.status])}</li>`)}</ul>`
          : empty('No transfers', 'When someone offers a task to a teammate it appears here.', '', 'team')}</section>
      <section class="card" id="declined"><div class="card-head"><div><h2><span class="card-icon bad">${icon('x')}</span>Declined tasks</h2><p>They need a new owner or more detail. A decline is never held against anyone.</p></div></div>
        ${declined.length ? html`<ul class="list">${declined.map((t) => html`<li data-task="${t.id}"><div class="grow"><a href="#/tasks/${t.id}"><b>${t.title}</b></a><div class="small muted">${t.assigneeName} declined ${ago(t.statusChangedAt)}</div><div class="small">“${t.declinedReason || 'No reason given'}”</div>
          ${assignable.length ? html`<div class="assign-actions"><label class="sr" for="re-${t.id}" style="position:absolute;left:-999px">New owner</label><select id="re-${t.id}" data-owner><option value="">New owner…</option>${assignable.filter((p) => p.userId !== t.assigneeId).map((p) => html`<option value="${p.userId}">${p.name}</option>`)}</select><button class="btn small" data-reassign>Reassign</button></div>` : ''}</div></li>`)}</ul>`
          : empty('Nothing declined', '', '', 'checkCircle')}</section>
    </div>

    <section class="card" id="explanations" style="margin-top:16px"><div class="card-head"><div><h2><span class="card-icon bad">${icon('clock')}</span>Missed deadlines</h2><p>What happened, who explained it, and what you decided. History stays after the task is completed.</p></div></div>
      ${ov.missed.length ? html`<div class="table-wrap"><table><thead><tr><th>Task</th><th class="hide-sm">Owner</th><th>Deadline</th><th>Explanation</th></tr></thead><tbody>${ov.missed.map((m) => {
        const x = queue.find((e) => e.taskId === m.taskId && e.originalDeadline === m.dueAt)
        return html`<tr class="clickable" data-href="#/tasks/${m.taskId}"><td><a href="#/tasks/${m.taskId}"><b>${m.title}</b></a><div class="small muted">${STATUS_LABEL[m.status] || m.status}</div></td><td class="hide-sm">${m.ownerName || '—'}</td><td class="nowrap">${dt(m.dueAt)}</td>
          <td>${x ? html`${badge(REVIEW[x.reviewStatus] || ['outline', x.reviewStatus])}<div class="small muted">${x.reasonLabel}</div>` : m.explained ? html`<span class="badge ok">Explained</span>` : html`<span class="badge warn">Not explained yet</span>`}</td></tr>`
      })}</tbody></table></div>` : empty('No missed deadlines', 'When a task passes its deadline it is recorded here with the owner’s explanation.', '', 'checkCircle')}</section>

    <section class="card" id="slack-people" style="margin-top:16px"><div class="card-head"><div><h2><span class="card-icon">${icon('profile')}</span>Slack people</h2><p>A tagged person is assigned a task only when you confirmed who they are. Display names are never used to guess.</p></div></div>
      ${ov.identities.unresolved.length ? html`<h3 style="margin:0 0 6px">Tagged in task messages, not usable yet</h3><ul class="list" style="margin-bottom:14px">${ov.identities.unresolved.map((u) => html`<li><div class="grow"><b class="mono">${u.slackUserId}</b> <span class="badge warn">${REASON[u.reason] || u.reason}</span><div class="small muted">Tagged ${u.count}× · last ${ago(u.lastSeenAt)}${u.claimedByName ? ` · claimed by ${u.claimedByName}` : ''}</div></div>
        ${u.claimedByUserId && u.reason === 'unconfirmed' ? html`<button class="btn small" data-confirm-user="${u.claimedByUserId}" data-confirm-id="${u.slackUserId}">Confirm it is ${u.claimedByName}</button>` : html`<button class="btn small ghost" data-prefill="${u.slackUserId}">Map to a person…</button>`}</li>`)}</ul>` : ''}
      ${ov.identities.mappings.length ? html`<ul class="list">${ov.identities.mappings.map((m) => html`<li><div class="grow"><b>${m.name}</b> <span class="mono small muted">${m.slackUserId}</span>${m.workspaceId ? html` <span class="small muted">· ${m.workspaceId}</span>` : ''}</div>
        ${m.confirmed ? html`<span class="badge ok" title="${m.confirmedByName ? `Confirmed by ${m.confirmedByName}` : ''}">Confirmed</span>` : html`<span class="badge warn">Self-declared</span><button class="btn small" data-confirm-user="${m.userId}" data-confirm-id="${m.slackUserId}">Confirm</button>`}
        <button class="btn small link" data-remove="${m.id}" aria-label="Remove mapping for ${m.name}">Remove</button></li>`)}</ul>` : html`<p class="small muted">No Slack people mapped yet.</p>`}
      <form id="map-form" style="margin-top:14px"><div class="form-error"></div><div class="fields">
        <div class="field"><label for="m-u">Person</label><select id="m-u" name="userId" required><option value="">Choose a person…</option>${people.map((p) => html`<option value="${p.userId}">${p.name}${p.teamName ? ` · ${p.teamName}` : ''}</option>`)}</select></div>
        <div class="field"><label for="m-s">Slack user id</label><input id="m-s" name="slackUserId" required pattern="[UWuw][A-Za-z0-9]{6,20}" placeholder="U0123ABCD" autocomplete="off"><div class="hint">In Slack: open their profile, ⋯, Copy member ID.</div></div>
        <div class="field"><label for="m-w">Workspace id <span class="field-hint">optional</span></label><input id="m-w" name="workspaceId" pattern="[Tt][A-Za-z0-9]{6,20}" placeholder="T0123ABCD" autocomplete="off"></div></div>
        <button class="btn" type="submit">Map this person</button></form></section>`.toString()

  document.getElementById('filters').addEventListener('submit', (e) => {
    e.preventDefault()
    const p = new URLSearchParams()
    for (const el of e.target.elements) if (el.name && el.value) p.set(el.name, el.value)
    location.hash = `#/slack-intake${p.toString() ? `?${p}` : ''}`
  })
  document.querySelectorAll('#filters select').forEach((x) => x.addEventListener('change', () => document.getElementById('filters').requestSubmit()))
  const go = async (fn, msg) => { try { if ((await fn()) === false) return; if (msg) toast(msg); rerender() } catch (e) { toast(errorText(e), { error: true }) } }
  main.querySelectorAll('[data-settle]').forEach((b) => b.addEventListener('click', () => go(() => withdrawTransfer(b.dataset.settle), 'The current owner keeps the task.')))
  main.querySelectorAll('[data-reassign]').forEach((b) => b.addEventListener('click', () => {
    const li = b.closest('li'); const to = li.querySelector('[data-owner]').value
    if (!to) { toast('Choose the new owner first.', { error: true }); return }
    go(() => api(`/api/tasks/${li.dataset.task}/assign`, { method: 'POST', body: { assigneeId: to, reason: 'Reassigned after a decline' } }), 'Reassigned. The new owner must accept.')
  }))
  main.querySelectorAll('[data-confirm-user]').forEach((b) => b.addEventListener('click', () => go(() => api('/api/slack-identities', { method: 'POST', body: { userId: b.dataset.confirmUser, slackUserId: b.dataset.confirmId } }), 'Confirmed. Tags of this person now assign tasks to them.')))
  main.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const r = await confirmDialog({ title: 'Remove this mapping?', body: 'Tags of this Slack user stop assigning tasks. Tasks already created stay as they are.', confirm: 'Remove', danger: true })
    if (r?.ok) go(() => api(`/api/slack-identities/${b.dataset.remove}`, { method: 'DELETE' }), 'Mapping removed.')
  }))
  main.querySelectorAll('[data-prefill]').forEach((b) => b.addEventListener('click', () => { const f = document.getElementById('m-s'); f.value = b.dataset.prefill; f.scrollIntoView({ block: 'center' }); document.getElementById('m-u').focus() }))
  bindForm(document.getElementById('map-form'), (d) => api('/api/slack-identities', { method: 'POST', body: { userId: d.userId, slackUserId: String(d.slackUserId).toUpperCase(), workspaceId: d.workspaceId ? String(d.workspaceId).toUpperCase() : undefined } }), { onSuccess: () => { toast('Mapped. Tags of this Slack user now assign tasks to them.'); rerender() } })
}

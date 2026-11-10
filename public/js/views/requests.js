import { api, html, raw, modal, bindForm, toast, errorText, ago, dt, prioBadge, requestBadge, empty, toLocalInput, fromLocalInput, confirmDialog, icon, avatar } from '../ui.js'
import { app } from '../app.js'
import { openTaskForm } from './tasks.js'

export async function renderRequests(main, q) {
  const status = q.get('status') || ''
  const list = await api(`/api/requests${status ? `?status=${status}` : ''}`)
  const mine = list.filter((r) => r.requestedBy === app.me.id)
  const toDecide = app.isManager ? list.filter((r) => r.requestedBy !== app.me.id && ['PENDING', 'CLARIFICATION_REQUESTED'].includes(r.status)) : []
  const decided = app.isManager ? list.filter((r) => r.requestedBy !== app.me.id && !['PENDING', 'CLARIFICATION_REQUESTED'].includes(r.status)) : []
  const card = (r, { decide = false } = {}) => html`<article class="card request-card ${decide ? 'to-decide' : ''}">
    <div class="row between" style="align-items:flex-start;gap:12px"><div class="row nowrap" style="gap:12px;min-width:0">${r.source === 'external' ? html`<span class="app-icon tp">${icon('inbox')}</span>` : avatar(r.requestedByName, null)}<div style="min-width:0"><h3>${r.title}</h3><div class="meta" style="margin-top:2px">${r.source === 'external' ? html`<span class="badge brand">External</span><span>from ${r.externalRequester || 'an automation'}</span>` : html`<span>${r.requestedByName}</span>`}<span class="sep"></span><span>${ago(r.createdAt)}</span>${r.teamName ? html`<span class="sep"></span><span>${r.teamName}</span>` : ''}</div></div></div>
      <div class="row nowrap" style="gap:8px">${requestBadge(r.status)} ${prioBadge(r.suggestedPriority)}</div></div>
    <dl class="kv" style="margin-top:12px">
      ${r.description ? html`<dt>Description</dt><dd class="pre">${r.description}</dd>` : ''}
      ${r.reason ? html`<dt>Why it is needed</dt><dd class="pre">${r.reason}</dd>` : ''}
      ${r.expectedOutcome ? html`<dt>Expected outcome</dt><dd class="pre">${r.expectedOutcome}</dd>` : ''}
      ${r.suggestedDueAt ? html`<dt>Suggested deadline</dt><dd>${dt(r.suggestedDueAt)}</dd>` : ''}
      ${r.suggestedAssigneeName ? html`<dt>Suggested owner</dt><dd>${r.suggestedAssigneeName}</dd>` : ''}
      ${r.decisionNote ? html`<dt>${r.status === 'CLARIFICATION_REQUESTED' ? 'Question' : 'Decision note'}</dt><dd class="pre">${r.decisionNote} <span class="muted small">— ${r.decidedByName}, ${ago(r.decidedAt)}</span></dd>` : ''}
    </dl>
    <div class="row" style="margin-top:14px">
      ${decide ? html`<button class="btn small" data-approve="${r.id}">${icon('check')}Approve…</button><button class="btn small ghost" data-clarify="${r.id}">Ask a question</button><button class="btn small subtle" data-reject="${r.id}">Reject</button>` : ''}
      ${r.requestedBy === app.me.id && ['PENDING', 'CLARIFICATION_REQUESTED'].includes(r.status) ? html`<button class="btn small ${r.status === 'CLARIFICATION_REQUESTED' ? '' : 'ghost'}" data-edit="${r.id}">${r.status === 'CLARIFICATION_REQUESTED' ? 'Answer and resubmit' : 'Edit'}</button><button class="btn small subtle" data-withdraw="${r.id}">Withdraw</button>` : ''}
      ${r.taskId ? html`<a class="btn small ghost" href="#/tasks/${r.taskId}">Open task</a>` : ''}
    </div></article>`
  main.innerHTML = html`
    <div class="page-head"><div><div class="eyebrow">${icon('requests', 'xs')}Requests</div><h1>Task requests</h1><p>Suggestions become official tasks only when a manager approves them. External requests from automations land here too — never assigned automatically.</p></div>
      <button class="btn" id="suggest">${icon('plus')}Suggest a task</button></div>
    <nav class="tabs" aria-label="Request status">${[['', 'All'], ['PENDING', 'Pending'], ['CLARIFICATION_REQUESTED', 'Needs clarification'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']].map(([k, l]) => html`<a href="#/requests${k ? `?status=${k}` : ''}" ${status === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
    ${app.isManager ? html`<h2 class="group-title" style="margin-bottom:12px"><span class="card-icon warn">${icon('alert')}</span>To decide<span class="badge outline">${toDecide.length}</span></h2><div class="stack">${toDecide.length ? toDecide.map((r) => card(r, { decide: true })) : html`<div class="card">${empty('Nothing to decide', 'New suggestions from your team will appear here.', '', 'checkCircle')}</div>`}</div>` : ''}
    <h2 class="group-title" style="margin:28px 0 12px"><span class="card-icon">${icon('requests')}</span>My requests<span class="badge outline">${mine.length}</span></h2>
    <div class="stack">${mine.length ? mine.map((r) => card(r)) : html`<div class="card">${empty('No requests yet', 'Suggest a task when you see work that should be done.', '', 'requests')}</div>`}</div>
    ${decided.length ? html`<h2 class="group-title" style="margin:28px 0 12px"><span class="card-icon ok">${icon('checkCircle')}</span>Decided<span class="badge outline">${decided.length}</span></h2><div class="stack">${decided.map((r) => card(r))}</div>` : ''}`

  const reload = () => { app.refreshCounts(); renderRequests(main, q) }
  main.querySelector('#suggest').addEventListener('click', async () => {
    await modal(html`<h2 id="modal-title">Suggest a task</h2><form id="f"><div class="form-error"></div>
      <div class="field"><label for="r-t">Proposed title</label><input id="r-t" name="title" type="text" required maxlength="200"></div>
      <div class="field"><label for="r-d">Description</label><textarea id="r-d" name="description" maxlength="5000"></textarea></div>
      <div class="field"><label for="r-r">Reason for the task</label><textarea id="r-r" name="reason" required maxlength="2000"></textarea></div>
      <div class="field"><label for="r-o">Expected outcome</label><textarea id="r-o" name="expectedOutcome" maxlength="2000"></textarea></div>
      <div class="fields"><div class="field"><label for="r-p">Suggested priority</label><select id="r-p" name="suggestedPriority">${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => html`<option ${p === 'MEDIUM' ? raw('selected') : ''} value="${p}">${p[0] + p.slice(1).toLowerCase()}</option>`)}</select></div>
      <div class="field"><label for="r-due">Suggested deadline</label><input id="r-due" name="suggestedDueAt" type="datetime-local"></div></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Send for approval</button></div></form>`.toString(), (el, close) => {
      bindForm(el.querySelector('#f'), (b) => api('/api/requests', { method: 'POST', body: { ...b, suggestedDueAt: fromLocalInput(b.suggestedDueAt) } }), { onSuccess: () => { close(); toast('Suggestion sent.'); reload() } })
    })
  })
  const byId = (id) => list.find((r) => r.id === id)
  main.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    const r = byId(b.dataset.approve)
    const people = await api('/api/assignable')
    modal(html`<h2 id="modal-title">Approve: ${r.title}</h2><p class="muted">Approving creates an official task. Adjust anything before it is created.</p><form id="f"><div class="form-error"></div>
      <div class="fields">
        <div class="field"><label for="a-a">Assign to</label><select id="a-a" name="assigneeId"><option value="">(unassigned)</option>${people.map((p) => html`<option value="${p.userId}" ${p.userId === (r.suggestedAssigneeId || r.requestedBy) ? raw('selected') : ''}>${p.name}</option>`)}</select></div>
        <div class="field"><label for="a-p">Priority</label><select id="a-p" name="priority">${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => html`<option value="${p}" ${p === r.suggestedPriority ? raw('selected') : ''}>${p[0] + p.slice(1).toLowerCase()}</option>`)}</select></div>
        <div class="field"><label for="a-d">Due</label><input id="a-d" name="dueAt" type="datetime-local" value="${toLocalInput(r.suggestedDueAt)}"></div>
      </div>
      <div class="field"><label for="a-n">Note to the requester (optional)</label><input id="a-n" name="note" type="text" maxlength="2000"></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Approve and create task</button></div></form>`.toString(), (el, close) => {
      bindForm(el.querySelector('#f'), (d) => api(`/api/requests/${r.id}/decision`, { method: 'POST', body: { decision: 'APPROVE', assigneeId: d.assigneeId || null, priority: d.priority, dueAt: fromLocalInput(d.dueAt), note: d.note } }),
        { onSuccess: (out) => { close(); toast('Approved — task created.'); location.hash = `#/tasks/${out.task.id}` } })
    })
  }))
  for (const [attr, decision, title, label, ok] of [['reject', 'REJECT', 'Reject this request?', 'Reason (shared with the requester)', 'Reject'], ['clarify', 'CLARIFY', 'Ask for clarification', 'Your question', 'Send question']]) {
    main.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', async () => {
      const res = await confirmDialog({ title, body: byId(b.dataset[attr]).title, confirm: ok, danger: decision === 'REJECT', reason: { label, required: true } })
      if (!res?.ok) return
      try { await api(`/api/requests/${b.dataset[attr]}/decision`, { method: 'POST', body: { decision, note: res.reason } }); toast(decision === 'REJECT' ? 'Rejected.' : 'Question sent.'); reload() } catch (e) { toast(errorText(e), { error: true }) }
    }))
  }
  main.querySelectorAll('[data-withdraw]').forEach((b) => b.addEventListener('click', async () => {
    const res = await confirmDialog({ title: 'Withdraw this request?', body: 'It will no longer be considered.', confirm: 'Withdraw', danger: true })
    if (res?.ok) { await api(`/api/requests/${b.dataset.withdraw}/withdraw`, { method: 'POST' }).catch((e) => toast(errorText(e), { error: true })); reload() }
  }))
  main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const r = byId(b.dataset.edit)
    modal(html`<h2 id="modal-title">${r.status === 'CLARIFICATION_REQUESTED' ? 'Answer and resubmit' : 'Edit request'}</h2>
      ${r.decisionNote && r.status === 'CLARIFICATION_REQUESTED' ? html`<div class="notice warn"><b>Question:</b> ${r.decisionNote}</div>` : ''}
      <form id="f"><div class="form-error"></div>
      <div class="field"><label for="e-t">Title</label><input id="e-t" name="title" required maxlength="200" type="text" value="${r.title}"></div>
      <div class="field"><label for="e-d">Description</label><textarea id="e-d" name="description" maxlength="5000">${r.description || ''}</textarea></div>
      <div class="field"><label for="e-r">Reason</label><textarea id="e-r" name="reason" required maxlength="2000">${r.reason || ''}</textarea></div>
      <div class="field"><label for="e-o">Expected outcome</label><textarea id="e-o" name="expectedOutcome" maxlength="2000">${r.expectedOutcome || ''}</textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Resubmit</button></div></form>`.toString(), (el, close) => {
      bindForm(el.querySelector('#f'), (d) => api(`/api/requests/${r.id}`, { method: 'PATCH', body: d }), { onSuccess: () => { close(); toast('Resubmitted.'); reload() } })
    })
  }))
  void openTaskForm
}

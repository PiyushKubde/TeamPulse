import { api, html, raw, modal, bindForm, toast, errorText, ago, dt, stageBadge, STAGE, empty, CATEGORIES, OUTCOME_TYPES, confirmDialog, icon } from '../ui.js'
import { app } from '../app.js'

const said = (t) => t || html`<span class="muted">Not described</span>`

export async function renderImpact(main, q) {
  const view = q.get('view') || (app.isManager ? 'team' : 'mine')
  const status = q.get('status') || ''
  const params = new URLSearchParams()
  if (view === 'mine') params.set('view', 'mine')
  if (status) params.set('status', status)
  if (q.get('category')) params.set('category', q.get('category'))
  const [records, summary] = await Promise.all([api(`/api/impact?${params}`), api(`/api/impact-summary${view === 'mine' ? '?view=mine' : ''}`)])
  main.innerHTML = html`
    <div class="crumbs"><a href="#/contributions">Contributions</a></div>
    <div class="page-head"><div><div class="eyebrow">${icon('award', 'xs')}Outcomes</div><h1>Outcomes &amp; impact</h1><p>Contributions shown by what changed, with evidence and verification — never a single score. Research, prevention and learning count; estimates are labelled.</p></div>
      <button class="btn" id="new-impact">Record a contribution</button></div>
    <div class="tabs">${(app.isManager ? [['team', 'Team'], ['mine', 'Mine']] : [['mine', 'Mine']]).map(([k, l]) => html`<a href="#/impact?view=${k}" ${view === k ? raw('aria-current="page"') : ''}>${l}</a>`)}
      ${app.isManager ? html`<a href="#/impact?view=team&status=PENDING" ${status === 'PENDING' && view === 'team' ? raw('aria-current="page"') : ''}>To verify</a>` : ''}
      <a href="${app.isManager ? '#/contribution' : `#/contribution/${app.me.id}`}">Contribution analysis →</a>
      ${app.isManager ? html`<a href="#/reports?type=weekly">Weekly view →</a>` : ''}</div>
    ${summary.verifiedTotals.length ? html`<section class="card" style="margin-bottom:16px"><h2 style="margin-bottom:8px">Verified measurable outcomes</h2><div class="row">${summary.verifiedTotals.map((t) => html`<span class="badge ${t.valueType === 'ESTIMATED' ? 'warn' : 'ok'}" title="${t.records} record(s)">${t.categoryLabel}: ${t.valueType === 'ESTIMATED' ? '≈' : ''}${t.total.toLocaleString()} ${t.unit}${t.valueType === 'ESTIMATED' ? ' (estimate)' : ''}</span>`)}</div><p class="small muted" style="margin-top:6px">Shared team outcomes are counted once. Measured and estimated values are never added together.</p></section>` : ''}
    ${view === 'team' && summary.people.length ? html`<section class="card" style="margin-bottom:16px"><h2 style="margin-bottom:10px">Contributions by person</h2><div class="table-wrap"><table><thead><tr><th>Person</th><th>Verified outcomes by category</th><th class="num">Verified</th><th class="num">Pending</th><th class="num hide-sm">Prevention</th><th class="num hide-sm">Learning</th><th class="num hide-sm">Reusable</th></tr></thead><tbody>
      ${summary.people.map((p) => html`<tr><td>${p.name}</td><td>${Object.entries(p.byCategory).map(([k, n]) => html`<span class="badge outline" style="margin:0 4px 4px 0">${CATEGORIES[k]} · ${n}</span>`)}${!Object.keys(p.byCategory).length ? html`<span class="muted small">—</span>` : ''}</td><td class="num">${p.verified}</td><td class="num">${p.pending}</td><td class="num hide-sm">${p.prevention}</td><td class="num hide-sm">${p.learning}</td><td class="num hide-sm">${p.reusable}</td></tr>`)}
      </tbody></table></div></section>` : ''}
    <form class="filters" id="f"><select name="category" aria-label="Category"><option value="">All categories</option>${Object.entries(CATEGORIES).map(([k, l]) => html`<option value="${k}" ${q.get('category') === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <select name="status" aria-label="Verification"><option value="">Any verification</option>${['PENDING', 'VERIFIED', 'REJECTED'].map((s) => html`<option value="${s}" ${status === s ? raw('selected') : ''}>${s[0] + s.slice(1).toLowerCase()}</option>`)}</select></form>
    ${records.length ? html`<div class="stack">${records.map((r) => html`<article class="card"><div class="row between"><div><a href="#/impact/${r.id}"><h3>${r.title}</h3></a><div class="small muted">${r.userName} · ${r.categoryLabel} · ${OUTCOME_TYPES[r.outcomeType]} · ${ago(r.createdAt)}${r.taskTitle ? html` · task <a href="#/tasks/${r.taskId}">${r.taskTitle}</a>` : ''}</div></div><span class="row nowrap">${r.evidenceCount ? html`<span class="badge outline" title="Evidence links or files attached">${r.evidenceCount} evidence</span>` : ''}${stageBadge(r)}</span></div>
      <div class="grid three" style="margin-top:10px;gap:10px"><div><div class="small muted">Problem or opportunity</div><div class="pre">${said(r.previousState)}</div></div><div><div class="small muted">What was done</div><div class="pre">${said(r.workPerformed)}</div></div><div><div class="small muted">What changed</div><div class="pre">${said(r.result)}</div></div></div>
      ${r.measurableValue !== null ? html`<div style="margin-top:8px"><span class="badge ${r.isEstimate ? 'warn' : 'ok'}">${r.isEstimate ? 'Estimate: ≈ ' : 'Measured: '}${r.measurableValue} ${r.measurementUnit}</span></div>` : ''}
      ${r.verificationStatus === 'REJECTED' ? html`<div class="notice err small" style="margin:8px 0 0">Not verified: ${r.rejectionReason}</div>` : ''}
    </article>`)}</div>` : empty('No contributions recorded yet', view === 'mine' ? 'Record a contribution when you solved something that mattered: the problem, what you did, and what changed. A short note is enough, and the number of records is never a measure.' : 'When your team records outcomes, they appear here for you to verify.')}`
  main.querySelector('#new-impact').addEventListener('click', () => openImpactForm())
  main.querySelectorAll('#f select').forEach((s) => s.addEventListener('change', () => {
    const p = new URLSearchParams({ view })
    for (const el of main.querySelector('#f').elements) if (el.value) p.set(el.name, el.value)
    location.hash = `#/impact?${p}`
  }))
  if (q.get('new') === '1') openImpactForm(null, q.get('taskId'))
}

export async function openImpactForm(existing = null, taskId = null) {
  const [tasks, people] = await Promise.all([api('/api/tasks?view=mine&includeClosed=true').catch(() => []), api('/api/members').catch(() => [])])
  const r = existing || {}
  return modal(html`<h2 id="modal-title">${existing ? 'Edit contribution' : 'Record a contribution'}</h2>
    <p class="small muted">Say what you contributed, in as much detail as you have. A short record is fine. Records are not points: the value of the work matters, not how many you write. It stays a claim until you attach evidence and a manager verifies it. Don’t invent numbers: leave the value empty if it was not measured.</p>
    <form id="imp"><div class="form-error"></div>
    <div class="field"><label for="i-t">Title</label><input id="i-t" name="title" type="text" required maxlength="200" value="${r.title || ''}" placeholder="e.g. Cut deploy time by 70%"></div>
    <div class="fields">
      <div class="field"><label for="i-c">Impact category</label><select id="i-c" name="category" required>${existing ? '' : html`<option value="" selected disabled>Choose a category</option>`}${Object.entries(CATEGORIES).map(([k, l]) => html`<option value="${k}" ${r.category === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
      <div class="field"><label for="i-o">Kind of outcome</label><select id="i-o" name="outcomeType">${Object.entries(OUTCOME_TYPES).map(([k, l]) => html`<option value="${k}" ${(r.outcomeType || 'DELIVERED') === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
    </div>
    ${existing ? '' : html`<div class="field"><label for="i-d">Date of contribution (optional)</label><input id="i-d" name="contributedOn" type="date" max="${new Date().toISOString().slice(0, 10)}"><div class="hint">Leave empty for today.</div></div>`}<div class="field"><label for="i-task">Related task (optional)</label><select id="i-task" name="taskId" ${existing ? raw('disabled') : ''}><option value="">(none)</option>${tasks.map((t) => html`<option value="${t.id}" ${(taskId || r.taskId) === t.id ? raw('selected') : ''}>${t.title}</option>`)}</select></div>
    <div class="field"><label for="i-p">The problem or opportunity, and why it mattered <span class="field-hint">optional</span></label><textarea id="i-p" name="previousState" maxlength="4000">${r.previousState || ''}</textarea></div>
    <div class="field"><label for="i-w">What you did <span class="field-hint">optional</span></label><textarea id="i-w" name="workPerformed" maxlength="4000">${r.workPerformed || ''}</textarea></div>
    <div class="field"><label for="i-r">What changed as a result <span class="field-hint">optional</span></label><textarea id="i-r" name="result" maxlength="4000">${r.result || ''}</textarea></div>
    <fieldset><legend>Measurable value</legend>
      <div class="row" style="margin-bottom:8px">${[['NONE', 'No measurable value'], ['MEASURED', 'Measured'], ['ESTIMATED', 'Estimate']].map(([k, l]) => html`<label class="check" style="margin:0 12px 0 0"><input type="radio" name="valueType" value="${k}" ${(r.valueType || 'NONE') === k ? raw('checked') : ''}> ${l}</label>`)}</div>
      <div class="fields" id="val-fields"><div class="field"><label for="i-v">Value</label><input id="i-v" name="measurableValue" type="number" step="any" value="${r.measurableValue ?? ''}"></div>
      <div class="field"><label for="i-u">Unit</label><input id="i-u" name="measurementUnit" type="text" maxlength="40" value="${r.measurementUnit || ''}" placeholder="hours/week, ₹/month, % fewer errors"></div></div>
    </fieldset>
    <div class="row" style="margin-bottom:10px"><label class="check"><input type="checkbox" name="isQuality" ${r.isQuality ? raw('checked') : ''}> Quality or reliability improvement</label><label class="check"><input type="checkbox" name="isReusable" ${r.isReusable ? raw('checked') : ''}> Reusable work (others can use it)</label></div>
    <div class="fields"><div class="field"><label for="i-s">Shared outcome key (optional)</label><input id="i-s" name="sharedOutcomeKey" type="text" maxlength="80" value="${r.sharedOutcomeKey || ''}" placeholder="e.g. churn-q4"><div class="hint">Teammates recording the same outcome use the same key, so it is counted once.</div></div>
    <div class="field"><label for="i-co">Collaborators (optional)</label><select id="i-co" name="contributors" multiple size="3">${people.filter((p) => p.userId !== app.me.id).map((p) => html`<option value="${p.userId}" ${(r.contributors || []).some((c) => c.id === p.userId) ? raw('selected') : ''}>${p.name}</option>`)}</select></div></div>
    ${existing ? '' : html`<div class="field"><label for="i-e">Evidence links</label><textarea id="i-e" name="evidence" rows="2" placeholder="One link per line (dashboard, ticket, doc…)"></textarea></div>`}
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">${existing ? 'Save and resubmit' : 'Save contribution'}</button></div></form>`.toString(), (el, close) => {
    const form = el.querySelector('#imp')
    const sync = () => { const none = form.querySelector('input[name=valueType]:checked').value === 'NONE'; el.querySelector('#val-fields').style.display = none ? 'none' : '' }
    form.querySelectorAll('input[name=valueType]').forEach((x) => x.addEventListener('change', sync))
    sync()
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = form.elements
      const body = {
        title: f.title.value, category: f.category.value, outcomeType: f.outcomeType.value, previousState: f.previousState.value, workPerformed: f.workPerformed.value, result: f.result.value,
        valueType: form.querySelector('input[name=valueType]:checked').value, measurableValue: f.measurableValue.value === '' ? null : Number(f.measurableValue.value), measurementUnit: f.measurementUnit.value || null,
        isQuality: f.isQuality.checked, isReusable: f.isReusable.checked, sharedOutcomeKey: f.sharedOutcomeKey.value || null, contributors: [...f.contributors.selectedOptions].map((o) => o.value)
      }
      if (!existing) { body.taskId = f.taskId.value || null; body.contributedOn = f.contributedOn.value || undefined; body.evidenceLinks = (f.evidence.value || '').split('\n').map((s) => s.trim()).filter(Boolean).map((url) => ({ url })) }
      try {
        const out = await api(existing ? `/api/impact/${existing.id}` : '/api/impact', { method: existing ? 'PATCH' : 'POST', body })
        close(out); toast('Saved. It stays a claim until evidence supports it and a manager verifies it.'); location.hash = `#/impact/${out.id}`
        if (existing) window.dispatchEvent(new HashChangeEvent('hashchange'))
      } catch (err) { form.querySelector('.form-error').innerHTML = html`<div class="notice err" role="alert">${errorText(err)}</div>`.toString() }
    })
  })
}

export async function renderImpactDetail(main, id) {
  const r = await api(`/api/impact/${id}`)
  const mine = r.userId === app.me.id
  const canVerify = app.isManager && !mine
  main.innerHTML = html`
    <div class="crumbs"><a href="#/impact">Outcomes &amp; impact</a></div>
    <div class="page-head"><div><h1>${r.title}</h1><div class="row" style="margin-top:8px">${stageBadge(r)} <span class="badge outline">${r.categoryLabel}</span> <span class="badge outline">${OUTCOME_TYPES[r.outcomeType]}</span>${r.isQuality ? html`<span class="badge outline">Quality</span>` : ''}${r.isReusable ? html`<span class="badge outline">Reusable</span>` : ''}</div></div>
      <div class="row">${canVerify && r.verificationStatus !== 'VERIFIED' ? html`<button class="btn" id="verify">Verify</button><button class="btn ghost" id="reject">Reject</button>` : ''}${mine && r.verificationStatus !== 'VERIFIED' ? html`<button class="btn ghost" id="edit">Edit</button>` : ''}</div></div>
    ${r.verificationStatus === 'REJECTED' ? html`<div class="notice err"><b>Not verified:</b> ${r.rejectionReason}${mine ? ' — edit the record to resubmit it.' : ''}</div>` : ''}
    <div class="grid side"><section class="card"><dl class="kv">
      <dt>Contributor</dt><dd>${r.userName}${r.contributors.length ? html` with ${r.contributors.map((c) => c.name).join(', ')}` : ''}</dd>
      ${r.taskId ? html`<dt>Related task</dt><dd><a href="#/tasks/${r.taskId}">${r.taskTitle}</a></dd>` : ''}
      <dt>Problem or opportunity</dt><dd class="pre">${said(r.previousState)}</dd>
      <dt>What was done</dt><dd class="pre">${said(r.workPerformed)}</dd>
      <dt>What changed</dt><dd class="pre">${said(r.result)}</dd>
      <dt>Measurable value</dt><dd>${r.measurableValue === null ? html`<span class="muted">None claimed</span>` : html`<span class="badge ${r.isEstimate ? 'warn' : 'ok'}">${r.isEstimate ? 'Estimate: ≈ ' : 'Measured: '}${r.measurableValue} ${r.measurementUnit}</span>`}</dd>
      ${r.sharedOutcomeKey ? html`<dt>Shared outcome</dt><dd class="mono">${r.sharedOutcomeKey}</dd>` : ''}
      <dt>Where it stands</dt><dd>${stageBadge(r)} <span class="small muted">${STAGE[r.stage][2]}</span></dd>
      <dt>Date</dt><dd>${dt(r.createdAt)}</dd>
    </dl></section>
    <div class="stack"><section class="card"><h2 style="margin-bottom:8px">Evidence</h2>
      ${r.evidence.length ? html`<ul class="list">${r.evidence.map((e) => html`<li><a href="${e.url}" ${e.kind === 'link' ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${e.label || e.fileName || e.url}</a></li>`)}</ul>` : html`<p class="muted small">No evidence attached yet. That does not mean nothing was contributed; add a link or file to support it.</p>`}
      ${mine && r.verificationStatus !== 'VERIFIED' ? html`<div class="row" style="margin-top:8px"><button class="btn small ghost" id="add-link">Add link</button><label class="btn small ghost" style="margin:0">Upload file<input type="file" id="ev-file" hidden></label></div>` : ''}</section>
    <section class="card"><h2 style="margin-bottom:8px">Review history</h2>${r.reviews.length ? html`<ul class="timeline">${r.reviews.map((x) => html`<li><div><b>${x.reviewer}</b> ${x.decision === 'VERIFIED' ? 'verified it' : 'did not verify it'}${x.comment ? `: “${x.comment}”` : ''}</div><div class="when">${dt(x.createdAt)}</div></li>`)}</ul>` : html`<p class="muted small">Not reviewed yet.</p>`}</section></div></div>`
  const reload = () => renderImpactDetail(main, id)
  main.querySelector('#edit')?.addEventListener('click', () => openImpactForm(r))
  main.querySelector('#verify')?.addEventListener('click', async () => {
    const res = await confirmDialog({ title: 'Verify this outcome?', body: 'Confirm that the evidence supports the result described.', confirm: 'Verify', reason: { label: 'Comment (optional)', required: false } })
    if (res?.ok) { try { await api(`/api/impact/${id}/verification`, { method: 'POST', body: { decision: 'VERIFIED', comment: res.reason || undefined } }); toast('Verified.'); reload() } catch (e) { toast(errorText(e), { error: true }) } }
  })
  main.querySelector('#reject')?.addEventListener('click', async () => {
    const res = await confirmDialog({ title: 'Reject this claim?', body: 'Explain what is missing so it can be fixed and resubmitted.', confirm: 'Reject', danger: true, reason: { label: 'Reason', required: true } })
    if (res?.ok) { try { await api(`/api/impact/${id}/verification`, { method: 'POST', body: { decision: 'REJECTED', comment: res.reason } }); toast('Marked as not verified.'); reload() } catch (e) { toast(errorText(e), { error: true }) } }
  })
  main.querySelector('#add-link')?.addEventListener('click', () => modal(html`<h2 id="modal-title">Add evidence link</h2><form id="f"><div class="form-error"></div><div class="field"><label for="l-u">Link</label><input id="l-u" name="url" type="url" required></div><div class="field"><label for="l-l">Label</label><input id="l-l" name="label" type="text" maxlength="200"></div><div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Add</button></div></form>`.toString(), (el, close) => bindForm(el.querySelector('#f'), (b) => api(`/api/evidence/impact/${id}/links`, { method: 'POST', body: b }), { onSuccess: () => { close(); reload() } })))
  main.querySelector('#ev-file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]
    if (!f) return
    try { await api(`/api/evidence/impact/${id}/files`, { method: 'POST', rawBody: f, headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) } }); toast('Uploaded.'); reload() } catch (err) { toast(errorText(err), { error: true }) }
  })
}

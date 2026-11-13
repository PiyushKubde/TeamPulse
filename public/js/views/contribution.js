// AI contribution analysis: the card on a task page, a person's contribution profile, and the team overview.
// Plain language for employees; the reasons and evidence behind every level for managers. Never a score or a rank.
import { api, html, raw, modal, bindForm, toast, errorText, ago, d, empty, loading, icon, avatar, prov, statusBadge, due, progressBar, appTile } from '../ui.js'
import { app } from '../app.js'
import { renderEvidenceReview } from './evidence.js'
import { questionBox } from './assistant.js'

const CX = { 1: 'Routine', 2: 'Standard', 3: 'Complex', 4: 'Highly complex' }
const STATE_TEXT = { insufficient_evidence: 'Not enough evidence', not_applicable: 'Not applicable' }
const EMP = { PENDING: ['Waiting for your confirmation', 'info'], CONFIRMED: ['Confirmed by the employee', 'ok'], CORRECTION_PROPOSED: ['Employee proposed a correction', 'warn'], DISPUTED: ['Disputed by the employee', 'warn'] }
const MGR = { PENDING: ['Not reviewed by a manager', 'outline'], APPROVED: ['Approved by a manager', 'ok'], ADJUSTED: ['Adjusted by a manager', 'brand'], DISPUTED: ['Disputed by a manager', 'warn'] }
const ACTION_TEXT = { CONFIRM: 'confirmed the analysis', PROPOSE_CORRECTION: 'proposed a correction', ADD_CONTEXT: 'added context', DISPUTE: 'disputed the analysis', APPROVE: 'approved the analysis', ADJUST: 'adjusted a level', MANAGER_DISPUTE: 'disputed the analysis' }
const DIM_KEYS = [['complexity', 'Complexity'], ['impact', 'Impact'], ['quality', 'Quality'], ['ownership', 'Ownership'], ['problem_solving', 'Problem-solving'], ['collaboration', 'Collaboration']]

const pct = (c) => (c == null ? '' : `model-reported confidence ${Math.round(c * 100)}%`)
const BASIS = { verified: ['Impact level backed by a manager-verified outcome', 'ok'], evidence_supported: ['Impact level is an estimate: the outcome record has evidence but is not verified yet', 'info'], claimed: ['Impact level is an estimate from the employee\'s own claims — nothing verified', 'warn'], none: ['No outcome recorded: impact cannot be judged', 'outline'] }
const dots = (level, max = 5) => html`<span class="dots" aria-label="level ${level} of ${max}">${Array.from({ length: max }, (_, i) => html`<i class="${i < level ? 'on' : ''}"></i>`)}</span>`
const evidenceChips = (list) => (list?.length ? html`<div class="chips">${list.map((e) => e.href ? html`<a class="chip" href="${e.href}" ${e.href.startsWith('http') ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${e.label}</a>` : html`<span class="chip">${e.label}</span>`)}</div>` : '')
const levelCell = (dim) => dim.state !== 'assessed'
  ? html`<span class="badge outline">${STATE_TEXT[dim.state] || dim.state}</span>`
  : dim.key === 'complexity' ? html`<span class="badge brand">L${dim.level} · ${CX[dim.level]}</span>` : html`${dots(dim.level)} <span class="small muted">${dim.level}/5</span>`

/** The analysis card on a task page. Loads itself; polls while an analysis runs. */
export async function renderAssessmentCard(box, taskId) {
  let v
  try { v = await api(`/api/tasks/${taskId}/assessment`) } catch (e) { box.innerHTML = html`<div class="notice err">Could not load the analysis. ${errorText(e)} <button class="btn small ghost" id="ai-retry">Retry</button></div>`.toString(); box.querySelector('#ai-retry').onclick = () => renderAssessmentCard(box, taskId); return }
  if (v.hidden) { box.remove(); return }
  const reload = () => renderAssessmentCard(box, taskId)
  const a = v.assessment
  const running = v.run && ['QUEUED', 'RUNNING'].includes(v.run.status)
  const failed = v.run?.status === 'FAILED' && (!a || Date.parse(v.run.createdAt) > Date.parse(a.createdAt))
  const analyseLabel = a ? 'Analyse again' : v.isMine ? 'Analyse my work' : 'Analyse this work'
  box.innerHTML = html`<div class="card-head"><div><h2><span class="card-icon brand">${icon('intelligence')}</span>Contribution analysis</h2>
      <p>${v.isMine ? 'What KONVO understood about your work — check it, correct it, or add context.' : `What ${v.subjectName}'s work involved and why — decision support for your judgement.`}</p></div>
      ${v.available && v.can.analyse ? html`<button class="btn small ${a ? 'ghost' : ''}" id="ai-analyse" ${running ? raw('disabled') : ''}>${icon('sparkles')}${analyseLabel}</button>` : ''}</div>
    ${!v.available ? html`<p class="muted small">${v.reason}</p>` : ''}
    ${v.available && !v.ai.configured && !a ? html`<div class="notice">AI analysis is not set up on this server yet. Work with very little information is still checked by rules; for full analysis an administrator must configure an AI provider.</div>` : ''}
    ${v.available && v.ai.configured && v.ai.mode === 'supervised' ? html`<div class="notice">${v.ai.selectedForSupervisedTest ? html`<b>Supervised live-AI validation.</b> This task is selected for a supervised test with ${v.ai.model}. Only an administrator can start it; no automatic runs and no notifications.` : html`AI analysis is in <b>supervised validation</b>: only tasks selected by an administrator are analysed for now.`}</div>` : ''}
    ${v.available && v.ai.configured && v.ai.mode === 'off' ? html`<div class="notice">AI analysis is switched off on this server.</div>` : ''}
    ${v.available && v.can.preview && v.ai.configured && !v.ai.simulated ? html`<p class="small" style="margin:0 0 8px"><button class="btn link" id="ai-preview">See exactly what would be sent to the AI</button></p>` : ''}
    ${running ? html`<div class="ai-block" role="status" style="margin-bottom:12px"><span class="spinner" aria-hidden="true"></span> Analysing the work and its evidence… this usually takes under a minute.</div>` : ''}
    ${failed ? html`<div class="notice err" role="alert"><b>The last analysis failed.</b> ${v.run.error || ''} ${v.can.analyse ? html`<button class="btn small ghost" id="ai-again">Try again</button>` : ''}</div>` : ''}
    ${a ? assessmentBody(a, v) : v.available && !running && !failed ? html`<p class="muted small">${v.isMine ? 'No analysis yet. It runs automatically when you submit the work, or press “Analyse my work”.' : 'No analysis yet. It runs automatically when the work is submitted.'}</p>` : ''}`.toString()

  const start = async (btn) => {
    btn.disabled = true
    try {
      const r = await api(`/api/tasks/${taskId}/assessment/analyse`, { method: 'POST' })
      if (r.status === 'unchanged') toast('Nothing changed since the last analysis, so it was not repeated.')
      reload()
    } catch (e) { toast(errorText(e), { error: true }); btn.disabled = false }
  }
  box.querySelector('#ai-analyse')?.addEventListener('click', (e) => start(e.currentTarget))
  box.querySelector('#ai-preview')?.addEventListener('click', async () => {
    try {
      const p = await api(`/api/tasks/${taskId}/assessment/preview`)
      modal(html`<h2 id="modal-title">What would be sent to the AI</h2>
        <p class="small">${p.insufficient ? 'Too little evidence: rules would answer and the AI would not be called.' : `Provider ${p.provider} · model ${p.model} · ${Math.ceil(p.bytes / 1024)} KB of task data.`} Built from KONVO data only: ${p.externalSources} external sources, ${p.filesOpened} files opened. Names are left out.</p>
        ${p.blockedBy ? html`<div class="notice warn small">${p.blockedBy}</div>` : ''}
        <p class="small muted">Items: ${Object.entries(p.itemCounts).map(([k, n]) => `${n} ${k}`).join(' · ') || 'none'} · prompt ${p.promptVersion} · ${p.guardrailVersion} · rubric ${p.rubricVersion}</p>
        <pre class="pack-preview">${JSON.stringify(p.pack, null, 2)}</pre>
        <div class="row end"><button class="btn" data-close>Close</button></div>`.toString())
    } catch (e) { toast(errorText(e), { error: true }) }
  })
  box.querySelector('#ai-again')?.addEventListener('click', (e) => start(e.currentTarget))
  if (running) setTimeout(() => { if (box.isConnected) reload() }, 3000)
  if (a) bindActions(box, a, v, taskId, reload)
}

function assessmentBody(a, v) {
  const dims = [a.complexity, ...a.dimensions]
  const imp = a.impact
  const outcome = (o) => html`<li><b>${o.title || o.text}</b>${o.categoryLabel ? html` <span class="small muted">· ${o.categoryLabel}</span>` : ''}${o.value != null ? html` <span class="badge ${o.valueType === 'MEASURED' ? 'ok' : 'warn'}">${o.valueType === 'ESTIMATED' ? '≈ ' : ''}${o.value} ${o.unit}${o.valueType === 'ESTIMATED' ? ' (estimate)' : ''}</span>` : ''}
    ${o.shared ? html`<div class="small muted">Shared with ${o.otherContributors.join(', ')} — not this person's alone</div>` : ''}${o.impactId ? html` <a class="small" href="#/impact/${o.impactId}">open</a>` : ''}</li>`
  const col = (title, hint, list, tone) => html`<div class="impact-col"><div class="row between"><b>${title}</b><span class="badge ${tone}">${list.length}</span></div><div class="small muted">${hint}</div>
    ${list.length ? html`<ul class="plain">${list.map((o) => (o.text && !o.title ? html`<li>${o.text}${o.label ? html` <span class="badge warn">${o.label}</span>` : ''}</li>` : outcome(o)))}</ul>` : html`<div class="small muted" style="margin-top:4px">None</div>`}</div>`
  const ctx = a.context
  return html`
    <div class="row" style="margin:4px 0 10px">
      <span class="badge ${a.evidenceState === 'sufficient' ? 'ok' : a.evidenceState === 'partial' ? 'warn' : 'bad'}">${a.evidenceState === 'sufficient' ? 'Enough evidence' : a.evidenceState === 'partial' ? 'Partly enough evidence' : 'Not enough evidence'}</span>
      <span class="badge ${EMP[a.employeeStatus][1]}">${EMP[a.employeeStatus][0]}</span><span class="badge ${MGR[a.managerStatus][1]}">${MGR[a.managerStatus][0]}</span>
      ${a.simulated ? html`<span class="badge warn" title="AI_PROVIDER=mock">Simulated — development only, not AI</span>` : ''}
      ${a.provider === 'rules' ? html`<span class="badge outline">Rules only (no AI call)</span>` : ''}
      ${a.live ? html`<span class="badge brand" title="Generated by ${a.model}">Live AI · ${a.provider === 'viasocket' ? `viaSocket AI · ${a.model} (model as requested; viaSocket does not confirm it)` : a.model}</span>` : ''}
      ${a.fallback?.kind === 'provider_backup' ? html`<span class="badge warn wrap" title="${a.fallback.primaryError || ''}">viaSocket AI failed — answered by the ${a.provider} backup (${a.model})</span>`
        : a.fallback ? html`<span class="badge warn" title="The requested model declined; the answer came from a fallback model">Fallback: ${a.requestedModel} → ${a.model}</span>` : ''}</div>
    <div class="ai-understood"><div class="row between" style="gap:8px"><span class="small muted">What KONVO understood</span>${a.provider === 'rules' ? prov('fact', 'Rules only') : prov('ai', a.simulated ? 'Simulated interpretation' : 'AI interpretation')}</div><p>${a.understanding || '—'}</p>
      ${a.summary ? html`<div class="small muted" style="margin-top:6px">Contribution</div><p>${a.summary}</p>` : ''}</div>
    <div class="table-wrap" style="margin-top:12px"><table class="dims"><thead><tr><th>Dimension</th><th>Level</th><th>Why</th></tr></thead><tbody>
      ${dims.map((x) => html`<tr><td><b>${x.label}</b><div style="margin-top:4px">${x.adjustments.length ? prov('verified', 'Manager decision') : a.provider === 'rules' ? prov('fact', 'Rules') : prov('ai', a.simulated ? 'Simulated' : 'AI suggestion')}</div>${x.confidence != null && x.state === 'assessed' ? html`<div class="small muted">${pct(x.confidence)}</div>` : ''}</td><td style="white-space:nowrap">${levelCell(x)}</td>
        <td><div>${x.reason}</div>${evidenceChips(x.evidence)}
          ${x.original ? html`<div class="small" style="margin-top:4px">Originally ${x.original.state === 'assessed' ? (x.key === 'complexity' ? `L${x.original.level}` : `${x.original.level}/5`) : STATE_TEXT[x.original.state]} (${x.original.source === 'ai' ? 'AI' : 'rules'}).</div>` : ''}
          ${x.adjustments.map((j) => html`<div class="small" style="margin-top:2px">${j.by} set ${j.levelText}${x.key === 'complexity' ? '' : '/5'} ${ago(j.at)}: “${j.reason}”</div>`)}</td></tr>`)}
    </tbody></table></div>
    <h3 style="margin:16px 0 8px">Impact: claimed, estimated, supported, verified</h3>
    ${imp.basis ? html`<p class="small" style="margin:-4px 0 8px"><span class="badge wrap ${BASIS[imp.basis][1]}">${BASIS[imp.basis][0]}</span></p>` : ''}
    <div class="impact-grid">
      ${col('Claimed', 'The employee\'s own account', imp.claimed, 'outline')}
      ${col('AI-estimated', 'Likely, not verified', imp.estimated, 'warn')}
      ${col('Evidence-supported', 'Recorded outcome with evidence, awaiting verification', imp.evidenceSupported, 'info')}
      ${col('Manager-verified', 'Verified by a manager', imp.verified, 'ok')}
    </div>
    ${ctx.blockers.length || ctx.shared.length || ctx.effort?.elapsedHours != null ? html`<h3 style="margin:16px 0 8px">Context</h3><ul class="plain">
      ${ctx.blockers.map((b) => html`<li><span class="badge ${b.outside ? 'info' : 'outline'}">${b.outside ? 'Outside their control' : 'Blocker'}</span> ${b.label}${b.hours != null ? ` · ${b.hours}h` : ' · still open'}${b.outside ? html` <span class="small muted">— not counted against them</span>` : ''}</li>`)}
      ${ctx.blockerNote ? html`<li class="small">${ctx.blockerNote}</li>` : ''}
      ${ctx.shared.map((s) => html`<li><span class="badge brand">Shared</span> ${s.title} — with ${s.others.join(', ')}</li>`)}
      ${ctx.sharedNote ? html`<li class="small">${ctx.sharedNote}</li>` : ''}
      ${ctx.effort?.elapsedHours != null ? html`<li class="small muted">Effort (context only, never rewarded): about ${ctx.effort.elapsedHours}h from start to submission, ${ctx.effort.progressUpdates} progress update(s).</li>` : ''}
    </ul>` : ''}
    ${a.missing.length ? html`<h3 style="margin:16px 0 8px">What would make this more reliable</h3><ul class="plain">${a.missing.map((m) => html`<li>• ${m}</li>`)}</ul>` : ''}
    ${a.guardrails.length ? html`<details style="margin-top:12px"><summary class="small">Rules KONVO applied (${a.guardrails.length})</summary><ul class="plain small" style="margin-top:6px">${a.guardrails.map((g) => html`<li>• ${g}</li>`)}</ul></details>` : ''}
    ${v.can.respond ? html`<div class="decision-box"><div><b>Is this right?</b><div class="small muted">Confirm it, correct it, or add what the analysis could not see.</div></div><div class="row"><button class="btn small" data-emp="CONFIRM">Looks right</button><button class="btn small ghost" data-emp="PROPOSE_CORRECTION">Suggest a correction</button><button class="btn small ghost" data-emp="ADD_CONTEXT">Add context</button><button class="btn small ghost" data-emp="DISPUTE">Dispute</button></div></div>` : ''}
    ${v.can.review ? html`<div class="decision-box manager"><div><b>Your decision ${prov('verified', 'Manager')}</b><div class="small muted">The AI only suggests. You make the judgement; the analysis only explains the work.</div></div><div class="row"><button class="btn small" data-mgr="APPROVE">Approve analysis</button><button class="btn small ghost" data-mgr="ADJUST">Adjust a level</button><button class="btn small ghost" data-mgr="MANAGER_DISPUTE">Dispute</button></div></div>` : ''}
    ${a.feedback.length || v.history.length ? html`<details style="margin-top:12px" ${a.feedback.some((f) => f.actorRole === 'employee' && f.action !== 'CONFIRM') && v.can.review ? raw('open') : ''}><summary class="small">History (${a.feedback.length} response${a.feedback.length === 1 ? '' : 's'}${v.history.length ? `, ${v.history.length} earlier analysis${v.history.length === 1 ? '' : 'es'}` : ''})</summary>
      <ul class="timeline" style="margin-top:6px">${a.feedback.map((f) => html`<li><div><b>${f.by}</b> ${ACTION_TEXT[f.action]}${f.dimensionLabel ? html` — ${f.dimensionLabel} ${f.fromLevel ?? '—'} → ${f.toLevel}` : ''}${f.comment ? html`: “${f.comment}”` : ''}</div><div class="when">${ago(f.at)}</div></li>`)}
      ${v.history.map((h) => html`<li><div class="muted">Earlier analysis (${h.provider}${h.model ? ` · ${h.model}` : ''}) — kept unchanged</div>
        ${(h.responses || []).map((f) => html`<div class="small">On that analysis, <b>${f.by}</b> ${ACTION_TEXT[f.action]}${f.dimensionLabel ? html` — ${f.dimensionLabel} ${f.fromLevel ?? '—'} → ${f.toLevel}` : ''}${f.comment ? html`: “${f.comment}”` : ''}</div>`)}
        <div class="when">${ago(h.createdAt)}</div></li>`)}</ul></details>` : ''}
    <p class="small muted" style="margin-top:10px">${a.provider === 'rules' ? 'Rules' : `${a.simulated ? 'Simulated analyser' : 'AI'}: ${a.provider}${a.model ? ` · ${a.model}` : ''}`} · rubric ${a.rubricVersion} · prompt ${a.promptVersion}${a.guardrailVersion ? ` · ${a.guardrailVersion}` : ''} · ${ago(a.createdAt)}. Confidence is reported by the model and not yet calibrated. Decision support, not a performance decision.</p>`
}

function levelForm(dimHint) {
  return html`<div class="field"><label for="lv-d">Dimension</label><select id="lv-d" name="dimension">${DIM_KEYS.map(([k, l]) => html`<option value="${k}" ${k === dimHint ? raw('selected') : ''}>${l}</option>`)}</select></div>
    <div class="field"><label for="lv-l">Level</label><select id="lv-l" name="level"></select><div class="hint">Complexity: L1 routine · L2 standard · L3 complex · L4 highly complex. Others: 1 (low) to 5 (exceptional).</div></div>`
}
function wireLevels(el) {
  const sel = el.querySelector('#lv-d'); const lv = el.querySelector('#lv-l')
  const fill = () => { lv.innerHTML = (sel.value === 'complexity' ? [1, 2, 3, 4].map((n) => `<option value="${n}">L${n} · ${CX[n]}</option>`) : [1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`)).join('') }
  sel.addEventListener('change', fill); fill()
}

function bindActions(box, a, v, taskId, reload) {
  const post = (path, body) => api(`/api/tasks/${taskId}/assessment/${path}`, { method: 'POST', body })
  const EMP_FORMS = {
    PROPOSE_CORRECTION: { title: 'Suggest a correction', intro: 'Your manager sees your suggestion next to the original analysis. The original is kept.', level: true, label: 'Why? What did the analysis miss?' },
    ADD_CONTEXT: { title: 'Add context', intro: 'Anything the analysis could not see: what was hard, what you decided, who you helped. It is marked as your own account.', label: 'Context' },
    DISPUTE: { title: 'Dispute this analysis', intro: 'Tell your manager what is wrong. The analysis is not changed by this.', label: 'What is wrong?' }
  }
  box.querySelectorAll('[data-emp]').forEach((b) => b.addEventListener('click', async () => {
    const action = b.dataset.emp
    if (action === 'CONFIRM') { try { await post('respond', { action }); toast('Thanks — confirmed.'); reload() } catch (e) { toast(errorText(e), { error: true }) } return }
    const f = EMP_FORMS[action]
    modal(html`<h2 id="modal-title">${f.title}</h2><p class="small muted">${f.intro}</p><form id="f"><div class="form-error"></div>${f.level ? levelForm('complexity') : ''}
      <div class="field"><label for="fb-c">${f.label}</label><textarea id="fb-c" name="comment" required maxlength="2000"></textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Send</button></div></form>`.toString(), (el, close) => {
      if (f.level) wireLevels(el)
      bindForm(el.querySelector('#f'), (d) => post('respond', { action, comment: d.comment, ...(f.level ? { dimension: d.dimension, level: Number(d.level) } : {}) }), {
        onSuccess: async () => {
          close()
          if (action === 'ADD_CONTEXT' && a.managerStatus !== 'PENDING') {
            toast('Context saved. Your manager has reviewed this analysis, so they decide whether to run it again.')
          } else if (action === 'ADD_CONTEXT') {
            toast('Context saved. Analysing again with it…')
            try { await api(`/api/tasks/${taskId}/assessment/analyse`, { method: 'POST' }) } catch (e) { toast(errorText(e), { error: true }) }
          } else toast('Sent to your manager.')
          reload()
        }
      })
    })
  }))
  const MGR_FORMS = {
    APPROVE: { title: 'Approve this analysis', intro: 'You agree the analysis fairly describes the work.', label: 'Comment (optional)', required: false },
    ADJUST: { title: 'Adjust a level', intro: 'Your level replaces the AI\'s for this dimension. The AI\'s original and your reason are kept in the history.', label: 'Reason (shown to the employee)', required: true, level: true },
    MANAGER_DISPUTE: { title: 'Dispute this analysis', intro: 'Mark the analysis as not reliable, with a reason the employee can see.', label: 'Reason', required: true }
  }
  box.querySelectorAll('[data-mgr]').forEach((b) => b.addEventListener('click', () => {
    const action = b.dataset.mgr; const f = MGR_FORMS[action]
    const proposal = a.feedback.filter((x) => x.action === 'PROPOSE_CORRECTION').at(-1)
    modal(html`<h2 id="modal-title">${f.title}</h2><p class="small muted">${f.intro}</p>
      ${proposal ? html`<div class="notice small">${proposal.by} suggested ${proposal.dimensionLabel} ${proposal.toLevel}: “${proposal.comment}”</div>` : ''}
      <form id="f"><div class="form-error"></div>${f.level ? levelForm(proposal?.dimension || 'quality') : ''}
      <div class="field"><label for="mg-c">${f.label}</label><textarea id="mg-c" name="comment" ${f.required ? raw('required') : ''} maxlength="2000"></textarea></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`.toString(), (el, close) => {
      if (f.level) wireLevels(el)
      bindForm(el.querySelector('#f'), (d) => post('review', { action, comment: d.comment || undefined, ...(f.level ? { dimension: d.dimension, level: Number(d.level) } : {}) }), { onSuccess: () => { close(); toast('Saved.'); reload() } })
    })
  }))
}

// ---------- pages ----------
const range = (q) => { const days = [30, 90, 180].includes(Number(q.get('days'))) ? Number(q.get('days')) : 90; return { days, from: new Date(Date.now() - days * 86400000).toISOString() } }
const mix = (m) => html`<span class="row" style="gap:4px">${['L4', 'L3', 'L2', 'L1'].filter((k) => m[k]).map((k) => html`<span class="badge ${k === 'L4' || k === 'L3' ? 'brand' : 'outline'}" title="${CX[k.slice(1)]}">${m[k]}× ${k}</span>`)}${m.insufficient ? html`<span class="badge outline" title="Not enough evidence to judge">${m.insufficient}× ?</span>` : ''}${!m.L1 && !m.L2 && !m.L3 && !m.L4 && !m.insufficient ? html`<span class="muted small">—</span>` : ''}</span>`

export async function renderContribution(main, q) {
  if (!app.isManager) { location.replace(`#/contribution/${app.me.id}`); return }
  const { days, from } = range(q)
  const tab = q.get('tab') === 'review' ? 'review' : 'team'
  main.innerHTML = loading().toString()
  const [t, unverified] = await Promise.all([api(`/api/contribution/intelligence?from=${encodeURIComponent(from)}`), api('/api/impact?view=team&status=PENDING').catch(() => [])])
  const rv = t.evidenceReview
  const toReview = rv.disputed + rv.unknownAuthor + rv.sharedPending
  const awaiting = t.people.reduce((n, x) => n + x.awaitingYourReview, 0)
  const outside = t.blockers.filter((b) => b.outsideControl).length
  const shared = t.significant.filter((x) => x.sharedWithOthers)
  main.innerHTML = html`<div class="page-head"><div><div class="eyebrow">${icon('intelligence', 'xs')}Team intelligence</div><h1>Team intelligence</h1><p>What your people's work involved and achieved — complexity, quality, ownership, problem-solving, collaboration, verified impact and the evidence behind them. ${t.note}</p></div>
      <div class="row"><a class="btn ghost" href="#/copilot">${icon('copilot')}Manager Copilot</a><a class="btn ghost" href="#/reviews">${icon('reviews')}Contribution reviews</a></div></div>
    <div class="row between" style="margin-bottom:16px;gap:12px"><div class="segmented" role="group" aria-label="Period">${[[30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months']].map(([n, l]) => html`<a href="#/contribution?days=${n}${tab === 'review' ? '&tab=review' : ''}" ${days === n ? raw('aria-current="page"') : ''}>${l}</a>`)}</div>
      <div class="segmented" role="group" aria-label="View"><a href="#/contribution?days=${days}" ${tab === 'team' ? raw('aria-current="page"') : ''}>Team</a><a href="#/contribution?days=${days}&tab=review" ${tab === 'review' ? raw('aria-current="page"') : ''}>Evidence to review${toReview ? html` <span class="count-pill">${toReview}</span>` : ''}</a></div></div>
    ${tab === 'team' ? html`<nav class="decisions" aria-label="Team at a glance">
      <a class="decision" href="#/contribution"><span class="lead-icon brand">${icon('award')}</span><span class="d-body"><span class="d-label">Significant contributions</span><span class="d-value">${t.significant.length || 'None yet'}</span></span></a>
      <a class="decision ${t.blockers.length ? 'open' : ''}" href="#blockers"><span class="lead-icon ${t.blockers.length ? 'bad' : ''}">${icon('blocked')}</span><span class="d-body"><span class="d-label">Open blockers${outside ? ` · ${outside} outside their control` : ''}</span><span class="d-value">${t.blockers.length || 'None'}</span></span></a>
      <a class="decision ${unverified.length ? 'open' : ''}" href="#/impact?view=team&status=PENDING"><span class="lead-icon ${unverified.length ? 'warn' : ''}">${icon('shield')}</span><span class="d-body"><span class="d-label">Unverified outcomes</span><span class="d-value">${unverified.length || 'None'}</span></span></a>
      <a class="decision ${awaiting ? 'open' : ''}" href="#/reviews"><span class="lead-icon ${awaiting ? 'warn' : ''}">${icon('reviews')}</span><span class="d-body"><span class="d-label">Analyses awaiting you</span><span class="d-value">${awaiting || 'None'}</span></span></a>
      <a class="decision" href="#/contribution?days=${days}&tab=review"><span class="lead-icon teal">${icon('team')}</span><span class="d-body"><span class="d-label">Shared work to resolve</span><span class="d-value">${rv.sharedPending || 'None'}</span></span></a></nav>` : ''}
    ${tab === 'team' ? html`<section class="card copilot" style="margin-bottom:16px"><div class="card-head"><div><h2><span class="card-icon brand">${icon('copilot')}</span>Ask about your team</h2><p>Manager Copilot — answers from your team’s records, each linked to the task, contribution or evidence behind it.</p></div></div><div id="copilot"></div></section>` : ''}
    ${tab === 'review' ? html`<section class="card"><div class="card-head"><div><h2><span class="card-icon teal">${icon('evidence')}</span>Evidence to review</h2><p>${rv.disputed} disputed · ${rv.unknownAuthor} with an unknown author · ${rv.sharedPending} shared links. Decide whose work it is; nothing is credited until then.</p></div></div><div id="review-box">${loading()}</div></section>` : html`
    <div class="grid two">
      <section class="card"><div class="card-head"><div><h2><span class="card-icon brand">${icon('award')}</span>Significant contributions</h2><p>Complex (L3+) work or verified outcomes, most recent first — with the reason. Not a ranking.</p></div></div>
        ${t.significant.length ? html`<ul class="mini-list">${t.significant.map((x) => html`<li>${avatar(x.name, null, 'sm')}<div class="grow"><a class="ttl" href="#/tasks/${x.taskId}">${x.taskTitle}</a><div class="small muted"><a href="#/contribution/${x.userId}">${x.name}</a>${x.complexityReason ? ` — ${x.complexityReason}` : ''}</div>
          <div class="row" style="gap:6px;margin-top:6px">${x.complexity ? html`<span class="badge brand">${x.complexity}</span>` : ''}${x.verifiedOutcomes ? prov('verified', `${x.verifiedOutcomes} verified outcome${x.verifiedOutcomes === 1 ? '' : 's'}`) : ''}${x.externalEvidence ? prov('fact', 'Evidence from apps') : ''}${x.sharedWithOthers ? html`<span class="badge outline">Shared work</span>` : ''}${x.managerStatus === 'PENDING' ? html`<span class="badge outline">Not yet reviewed</span>` : x.managerStatus === 'APPROVED' || x.managerStatus === 'ADJUSTED' ? prov('verified', 'Reviewed by you') : ''}${x.simulated ? html`<span class="badge warn">simulated</span>` : ''}</div></div></li>`)}</ul>` : empty('Nothing yet', 'Analysed complex work and verified outcomes appear here.', '', 'award')}</section>
      <section class="card" id="blockers"><div class="card-head"><div><h2><span class="card-icon bad">${icon('blocked')}</span>Open blockers</h2><p>Blockers outside a person's control are context, never a fault.</p></div></div>
        ${t.blockers.length ? html`<ul class="mini-list">${t.blockers.map((b) => html`<li><span class="lead-icon bad">${icon('blocked')}</span><div class="grow"><a class="ttl" href="#/tasks/${b.taskId}">${b.taskTitle}</a><div class="small muted"><a href="#/contribution/${b.userId}">${b.name}</a> · since ${ago(b.since)}</div><div class="small">${b.description}</div>
          <div class="row" style="gap:6px;margin-top:6px">${b.outsideControl ? html`<span class="badge info">Outside their control</span>` : ''}${b.escalated ? html`<span class="badge warn">Escalated</span>` : ''}</div></div></li>`)}</ul>` : empty('No open blockers', 'Nobody in your teams is blocked.', '', 'checkCircle')}</section>
      <section class="card"><div class="card-head"><div><h2><span class="card-icon warn">${icon('shield')}</span>Unverified outcomes</h2><p>An outcome someone recorded is a claim until you verify it.</p></div>${prov('unverified', 'Awaiting you')}</div>
        ${unverified.length ? html`<ul class="mini-list">${unverified.slice(0, 5).map((r) => html`<li><div class="grow"><a class="ttl" href="#/impact/${r.id}">${r.title}</a><div class="small muted">${r.userName} · ${r.categoryLabel}</div></div><a class="btn small ghost" href="#/impact/${r.id}">Verify</a></li>`)}</ul>${unverified.length > 5 ? html`<p class="small muted" style="margin:10px 0 0"><a href="#/impact?view=team&status=PENDING">All ${unverified.length}</a></p>` : ''}` : empty('Nothing to verify', 'Recorded outcomes waiting for your verification appear here.', '', 'checkCircle')}</section>
      <section class="card"><div class="card-head"><div><h2><span class="card-icon teal">${icon('team')}</span>Shared ownership</h2><p>Several people, one outcome — counted once; each person’s part stays theirs.</p></div></div>
        ${shared.length || rv.sharedPending ? html`<ul class="mini-list">${shared.slice(0, 5).map((x) => html`<li><div class="grow"><a class="ttl" href="#/tasks/${x.taskId}">${x.taskTitle}</a><div class="small muted">${x.name} and others</div></div></li>`)}${rv.sharedPending ? html`<li><span class="lead-icon teal">${icon('evidence')}</span><div class="grow"><a class="ttl" href="#/contribution?days=${days}&tab=review">${rv.sharedPending} shared link(s) to resolve</a><div class="small muted">Decide whose work it is.</div></div></li>` : ''}</ul>` : empty('No shared work', 'Shared ownership appears here when people contribute to one outcome.', '', 'team')}</section>
    </div>
    <section class="card" style="margin-top:16px"><div class="card-head"><div><h2><span class="card-icon">${icon('team')}</span>Your people</h2><p>Alphabetical. Open a person to see their tasks, evidence, journeys and the reasons behind each assessment.</p></div><span class="badge ok" title="${t.team.note}">${t.team.verifiedOutcomes} verified team outcome(s)</span></div>
      ${t.people.length ? html`<div class="table-wrap"><table><thead><tr><th>Person</th><th>Analysed work (complexity)</th><th class="num">Verified outcomes</th><th class="num hide-sm">Blocked by others</th><th class="num">Awaiting your review</th><th class="num">Disputes</th></tr></thead><tbody>
        ${t.people.map((p) => html`<tr class="clickable" data-href="#/contribution/${p.userId}"><td><div class="row nowrap" style="gap:10px">${avatar(p.name, null, 'sm')}<div><a href="#/contribution/${p.userId}"><b>${p.name}</b></a><div class="small muted">${p.title || p.role}${p.team ? ` · ${p.team}` : ''}</div></div></div></td>
          <td>${mix(p.complexityMix)}</td><td class="num">${p.verifiedOutcomes}${p.sharedOutcomes ? html` <span class="small muted">(${p.sharedOutcomes} shared)</span>` : ''}</td>
          <td class="num hide-sm">${p.blockedByOthers || 0}</td><td class="num">${p.awaitingYourReview ? html`<span class="badge warn">${p.awaitingYourReview}</span>` : 0}</td><td class="num">${p.disputes ? html`<span class="badge warn">${p.disputes}</span>` : 0}</td></tr>`)}
      </tbody></table></div>` : empty('Nobody to show yet', 'People in the teams you manage appear here once their work has been analysed.', '', 'team')}
    </section>`}`.toString()
  main.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href }))
  const cp = main.querySelector('#copilot')
  if (cp) api('/api/assistant/suggestions').then((sg) => questionBox(cp, { team: true, suggestions: sg.team })).catch(() => cp.remove())
  const rb = main.querySelector('#review-box')
  if (rb) renderEvidenceReview(rb)
}

export async function renderPerson(main, userId, q) {
  const { days, from } = range(q)
  main.innerHTML = loading().toString()
  const p = await api(`/api/contribution/people/${userId}?from=${encodeURIComponent(from)}`)
  const me = userId === app.me.id
  const fromBoard = q?.get('from') === 'dashboard' // opened from the Workboard: the way back is the Workboard
  const dimCard = ([, s]) => html`<div class="dim-card"><div class="row between"><b>${s.label}</b><span class="small muted">${s.assessed} assessed${s.insufficient ? ` · ${s.insufficient} not enough evidence` : ''}${s.notApplicable ? ` · ${s.notApplicable} n/a` : ''}</span></div>
    <div class="row" style="gap:4px;margin:6px 0">${[5, 4, 3, 2, 1].filter((l) => s.levels[l]).map((l) => html`<span class="badge ${l >= 4 ? 'ok' : l === 3 ? 'info' : 'warn'}">${s.levels[l]}× level ${l}</span>`)}</div>
    ${s.highlights.length ? html`<ul class="plain small">${s.highlights.map((h) => html`<li><a href="#/tasks/${h.taskId}">${h.taskTitle}</a>${h.complexity ? html` <span class="badge outline">L${h.complexity}</span>` : ''} — ${h.level}/5${h.source === 'manager' ? ' (manager)' : ''}: ${h.reason}</li>`)}</ul>` : ''}</div>`
  main.innerHTML = html`<div class="crumbs">${app.isManager && !fromBoard ? html`<a href="#/contribution">Team intelligence</a>` : html`<a href="#/dashboard">Overview</a>`}${icon('chevronRight', 'xs')}<span>${me ? 'My contribution' : p.person.name}</span></div>
    <div class="page-head person-head"><div class="row nowrap" style="gap:14px;align-items:center">${avatar(p.person.name, null, 'lg')}<div style="min-width:0;white-space:normal"><h1>${me ? 'My contribution' : p.person.name}</h1><p style="margin:2px 0 0">${[p.person.role[0].toUpperCase() + p.person.role.slice(1), p.person.title, p.person.team].filter(Boolean).join(' · ')}</p>${me ? '' : html`<p class="small muted" style="margin:3px 0 0">Responsibilities are read from the tasks assigned to them, below. No separate list is recorded.</p>`}</div></div>
      <div class="row"><a class="btn ghost" href="#/contributions?userId=${userId}">${icon('journeys')}Journeys</a>${app.isManager && !me ? html`<a class="btn ghost" href="#/team-tasks?assigneeId=${userId}">${icon('tasks')}Their tasks</a>` : ''}</div></div>
    <div class="segmented" role="group" aria-label="Period" style="margin-bottom:16px">${[[30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months']].map(([n, l]) => html`<a href="#/contribution/${userId}?days=${n}${fromBoard ? '&from=dashboard' : ''}" ${days === n ? raw('aria-current="page"') : ''}>${l}</a>`)}</div>
    <div class="principle" style="margin-bottom:16px">${icon('shield')}<span>${p.note}</span></div>
    ${p.canReview ? html`<div class="row" style="margin-bottom:12px"><button class="btn small" id="analyse-person">Analyse ${p.person.name}'s recent work</button><span class="small muted">Uses their tasks and the evidence linked to them. Results appear on each task.</span></div>` : me ? html`<div class="row" style="margin-bottom:12px"><a class="btn small" href="#/evidence">My work evidence and “Analyse my work”</a></div>` : ''}
    <section class="card"><div class="card-head"><h2>In short</h2>${prov('ai', 'Summary of the assessments below')}</div><p>${p.narrative}</p>
      <div class="row" style="margin-top:8px">${mix(p.complexityMix)}${p.reviews.awaitingManager && !me ? html`<span class="badge warn">${p.reviews.awaitingManager} awaiting review</span>` : ''}${p.reviews.awaitingEmployee && me ? html`<span class="badge info">${p.reviews.awaitingEmployee} waiting for your confirmation</span>` : ''}</div></section>
    ${me ? '' : html`<div class="grid two" style="margin-top:16px"><section class="card" id="p-tasks"><div class="card-head"><h2><span class="card-icon">${icon('tasks')}</span>Assigned tasks</h2><a class="btn small subtle" href="#/team-tasks?assigneeId=${userId}">All${icon('arrowRight', 'sm')}</a></div>${loading()}</section>
      <section class="card" id="p-evidence"><div class="card-head"><h2><span class="card-icon teal">${icon('evidence')}</span>Recent evidence</h2></div>${loading()}</section></div>`}
    ${(() => { const all = Object.entries(p.dimensions); const rated = all.filter(([, s]) => s.assessed); const rest = all.filter(([, s]) => !s.assessed); return html`${rated.length ? html`<div class="grid two" style="margin-top:16px">${rated.map(dimCard)}</div>` : ''}${rest.length ? html`<p class="small muted" style="margin:12px 0 0">Not enough evidence to rate yet: ${rest.map(([, x]) => x.label).join(', ')}. Nothing is guessed.</p>` : ''}` })()}
    <div class="grid two" style="margin-top:16px">
      <section class="card"><h2 style="margin-bottom:8px">Verified outcomes</h2>
        ${p.verified.length ? html`<ul class="list">${p.verified.map((o) => html`<li><div class="grow"><a href="#/impact/${o.impactId}"><b>${o.title}</b></a> <span class="small muted">· ${o.categoryLabel}</span>
          ${o.value ? html` <span class="badge ${o.value.kind === 'MEASURED' ? 'ok' : 'warn'}">${o.value.kind === 'ESTIMATED' ? '≈ ' : ''}${o.value.amount} ${o.value.unit}</span>` : ''}
          <div class="small">${o.result}</div>${o.shared ? html`<div class="small muted">Shared with ${o.otherContributors.join(', ')} · ${o.role}</div>` : ''}</div></li>`)}</ul>` : html`<p class="muted small">No manager-verified outcomes in this period.</p>`}</section>
      <section class="card"><h2 style="margin-bottom:8px">AI-estimated outcomes <span class="badge warn">not verified</span></h2>
        ${p.estimated.length ? html`<ul class="plain small">${p.estimated.map((e) => html`<li>• ${e.text} — <a href="#/tasks/${e.taskId}">${e.taskTitle}</a></li>`)}</ul>` : html`<p class="muted small">None.</p>`}
        ${p.blockers.itemsAffected ? html`<p class="small" style="margin-top:10px"><span class="badge info">Context</span> ${p.blockers.itemsAffected} piece(s) of work held up by others (about ${p.blockers.outsideControlHours}h). Not a fault.</p>` : ''}</section>
    </div>
    <section class="card" id="p-work" style="margin-top:16px"><h2 style="margin-bottom:4px">Analysed work</h2><p class="small muted" style="margin:0 0 8px">Simulated = development simulation · Rules only = no AI model read it · Approved/Adjusted = a manager has judged it · Estimates are never verified outcomes.</p>
      ${p.work.length ? html`<div class="table-wrap"><table><thead><tr><th>Task</th><th>Complexity</th>${DIM_KEYS.slice(1).map(([, l]) => html`<th class="num hide-sm">${l}</th>`)}<th>Status</th></tr></thead><tbody>
        ${p.work.map((w) => html`<tr><td><a href="#/tasks/${w.taskId}">${w.taskTitle}</a><div class="small muted">${d(w.periodEnd)}${w.simulated ? html` <span class="badge warn" title="A development simulation, not an AI analysis">Simulated</span>` : ''}${w.provider === 'rules' ? html` <span class="badge outline" title="Rules only: no AI model read this work">Rules only</span>` : ''}</div></td>
          <td>${w.complexity ? html`<span class="badge brand">${w.complexity}</span>` : html`<span class="badge outline">?</span>`}</td>
          ${DIM_KEYS.slice(1).map(([k]) => html`<td class="num hide-sm">${w.levels[k] ?? html`<span class="muted">—</span>`}</td>`)}
          <td><span class="badge ${EMP[w.employeeStatus][1]}">${!me && w.employeeStatus === 'PENDING' ? 'Waiting for the employee' : EMP[w.employeeStatus][0]}</span> <span class="badge ${MGR[w.managerStatus][1]}">${MGR[w.managerStatus][0]}</span></td></tr>`)}
      </tbody></table></div>` : empty('No analysed work in this period', me ? 'Your work is analysed when you submit it for review, or when you press “Analyse my work” on a task.' : 'Work is analysed when it is submitted for review.')}
    </section>`.toString()
  // A long history would bury the work that carries weight: show the newest rows and keep the rest one click away.
  const workRows = [...main.querySelectorAll('#p-work tbody tr')]
  if (workRows.length > 8) {
    workRows.slice(8).forEach((r) => { r.hidden = true })
    main.querySelector('#p-work .table-wrap').insertAdjacentHTML('afterend', `<button type="button" class="btn small ghost" id="p-work-all" style="margin-top:10px">Show all ${workRows.length} analysed pieces</button>`)
    main.querySelector('#p-work-all').addEventListener('click', (e) => { workRows.forEach((r) => { r.hidden = false }); e.currentTarget.remove() })
  }
  if (!me) {
    api(`/api/tasks?view=team&assigneeId=${userId}`).then((tasks) => {
      const box = main.querySelector('#p-tasks'); if (!box) return
      const open = tasks.filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))
      box.querySelector('.loading')?.remove()
      box.insertAdjacentHTML('beforeend', open.length ? html`<ul class="mini-list">${open.slice(0, 6).map((t) => html`<li><div class="grow"><a class="ttl" href="#/tasks/${t.id}">${t.title}</a><div class="meta" style="margin-top:4px">${statusBadge(t.status)}${due(t)}${t.status === 'BLOCKED' && t.blockedHours !== null ? html`<span class="due late">Blocked ${t.blockedHours}h</span>` : ''}</div></div><div style="width:70px">${progressBar(t.progress)}</div></li>`)}</ul>`.toString() : empty('No open tasks', 'Nothing is assigned to this person right now.', '', 'tasks').toString())
    }).catch((e) => { main.querySelector('#p-tasks .loading')?.replaceWith(Object.assign(document.createElement('div'), { className: 'notice err', textContent: errorText(e) })) })
    api(`/api/work-evidence?view=person&userId=${userId}`).then((items) => {
      const box = main.querySelector('#p-evidence'); if (!box) return
      box.querySelector('.loading')?.remove()
      box.insertAdjacentHTML('beforeend', items.length ? html`<ul class="mini-list">${items.slice(0, 5).map((e) => html`<li>${appTile(e.app, 'sm')}<div class="grow"><div class="ttl">${e.title || e.kind}</div><div class="small muted">${e.appLabel} · ${ago(e.occurredAt)} · ${e.linkState === 'linked' ? 'linked to a task' : e.linkState === 'unmatched' ? 'not linked' : 'suggested link'}</div></div></li>`)}</ul>`.toString() : empty('No evidence', 'Nothing collected from connected apps for this person.', '', 'evidence').toString())
    }).catch(() => { main.querySelector('#p-evidence')?.remove() })
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('#analyse-person')
  if (!b) return
  const userId = location.hash.match(/#\/contribution\/([0-9a-f-]{36})/)?.[1]
  if (!userId) return
  b.disabled = true
  try {
    const r = await api('/api/contribution/analyse', { method: 'POST', body: { userId } })
    const done = r.results.filter((x) => x.status !== 'not_analysed').length
    toast(`${done} of ${r.tasks} task(s) sent for analysis${r.results.find((x) => x.reason) ? ` — ${r.results.find((x) => x.reason).reason}` : ''}`)
  } catch (err) { toast(errorText(err), { error: true }) } finally { b.disabled = false }
})

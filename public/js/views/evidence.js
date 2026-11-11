// "My work evidence": what TeamPulse collects from the person's own connected apps, how it is linked to their tasks,
// and the "Analyse my work" action. Plus the managers' evidence review (attribution and shared ownership).
// Plain language first; the viaSocket details stay behind "Advanced".
import { api, html, raw, modal, bindForm, toast, errorText, ago, dt, empty, loading, confirmDialog, icon, appTile, prov } from '../ui.js'
import { app } from '../app.js'

const STATUS = { ACTIVE: ['Collecting', 'ok'], PAUSED: ['Paused', 'outline'], NEEDS_RECONNECT: ['Reconnect needed', 'warn'], FAILED: ['Not working', 'bad'] }
const LINK_STATE = { linked: ['Linked to a task', 'ok'], suggested: ['Suggested link', 'info'], possible: ['Possible match — confirm?', 'warn'], unmatched: ['Not linked', 'outline'] }
const STATES = [['review', 'Needs your confirmation'], ['linked', 'Linked'], ['unmatched', 'Not linked'], ['all', 'All']]

function evidenceItem(e, { canAct = true } = {}) {
  const [stateText, stateTone] = LINK_STATE[e.linkState]
  const suggested = e.links.filter((l) => l.status === 'suggested')
  const confirmed = e.links.filter((l) => l.status === 'confirmed')
  return html`<li class="ev-item" data-id="${e.id}">${appTile(e.app)}<div class="grow" style="min-width:0">
    <div class="row" style="gap:6px"><span class="small muted">${e.appLabel}</span><span class="badge ${stateTone}">${stateText}</span>
      ${e.status !== 'active' ? html`<span class="badge warn">${e.status}</span>` : ''}${e.attribution === 'disputed' ? html`<span class="badge warn">Attribution disputed</span>` : ''}</div>
    <div class="ev-title"><b>${e.title || e.kind}</b></div>
    ${e.content ? html`<div class="small ev-content">${e.content.slice(0, 280)}${e.content.length > 280 ? '…' : ''}</div>` : ''}
    <div class="meta" style="margin-top:4px"><span>${ago(e.occurredAt)}</span><span class="sep"></span><span>${e.verificationText}</span><span class="sep"></span><span>${e.actorName ? `by ${e.actorName}` : e.attributionText}</span>${e.collectorName && e.collectorName !== e.actorName ? html`<span class="sep"></span><span>collected by ${e.collectorName}</span>` : ''}${e.sourceUrl ? raw(`<span class="sep"></span><a href="${encodeURI(e.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open in ${e.appLabel}</a>`) : ''}</div>
    ${confirmed.map((l) => html`<div class="link-row"><span>${prov('self', 'Confirmed')}</span><span class="small">Part of <a href="#/tasks/${l.taskId}">${l.taskTitle}</a> <span class="muted">(${l.taskRef})${l.share === 'shared' ? ` · shared${l.contributorName ? `, ${l.contributorName}'s contribution` : ''}` : ''}</span></span></div>`)}
    ${suggested.map((l) => html`<div class="suggest-block link-row"><div><span>${prov('suggested', 'Suggested match')}</span> <span class="small">for <a href="#/tasks/${l.taskId}">${l.taskTitle}</a> <span class="muted">(${l.taskRef}) · ${l.method.replace('_', ' ')}, ${Math.round(l.confidence * 100)}%</span></span>
      <div class="small muted" style="margin-top:2px">${l.explanation}</div></div>
      ${canAct ? html`<span class="row" style="gap:6px"><button class="btn small" data-link="${l.id}" data-act="CONFIRM">${icon('check')}Yes, it belongs here</button><button class="btn small ghost" data-link="${l.id}" data-act="REJECT">No</button></span>` : ''}</div>`)}
    ${canAct && e.status === 'active' ? html`<div class="row" style="gap:6px;margin-top:8px">
      <button class="btn small ghost" data-ev-link="${e.id}">${icon('evidence')}Link to a task</button>
      ${e.actorId === app.me.id || (e.collectorId === app.me.id && e.attribution === 'self') ? html`<button class="btn small subtle" data-ev-dispute="${e.id}">Not mine</button>` : ''}
      ${e.collectorId === app.me.id ? html`<button class="btn small subtle" data-ev-remove="${e.id}">Remove</button>` : ''}</div>` : ''}
  </div></li>`
}

function bindEvidenceActions(root, reload, myTasks) {
  root.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/work-evidence-links/${b.dataset.link}`, { method: 'POST', body: { action: b.dataset.act } }); toast(b.dataset.act === 'CONFIRM' ? 'Linked.' : 'Removed the suggestion.'); reload() } catch (e) { toast(errorText(e), { error: true }) }
  }))
  root.querySelectorAll('[data-ev-link]').forEach((b) => b.addEventListener('click', async () => {
    const tasks = await myTasks()
    modal(html`<h2 id="modal-title">Link to a task</h2><form id="f"><div class="form-error"></div>
      <div class="field"><label for="lt">Which of your tasks does this belong to?</label><select id="lt" name="taskId" required>${tasks.map((t) => html`<option value="${t.id}">${t.title}</option>`)}</select></div>
      <p class="small muted">Linked evidence is used when the task is analysed. You can remove the link later.</p>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Link</button></div></form>`.toString(), (el, close) => {
      bindForm(el.querySelector('#f'), (d) => api(`/api/work-evidence/${b.dataset.evLink}/links`, { method: 'POST', body: d }), { onSuccess: () => { close(); toast('Linked.'); reload() } })
    })
  }))
  root.querySelectorAll('[data-ev-dispute]').forEach((b) => b.addEventListener('click', async () => {
    const r = await confirmDialog({ title: 'This is not mine', body: 'It stops counting for you, and your manager decides whose work it is.', confirm: 'Send', reason: { label: 'What happened? (e.g. paired with someone, someone else wrote it)', required: true } })
    if (r?.ok) { try { await api(`/api/work-evidence/${b.dataset.evDispute}/dispute`, { method: 'POST', body: { reason: r.reason } }); toast('Sent to your manager.'); reload() } catch (e) { toast(errorText(e), { error: true }) } }
  }))
  root.querySelectorAll('[data-ev-remove]').forEach((b) => b.addEventListener('click', async () => {
    const r = await confirmDialog({ title: 'Remove this evidence?', body: 'Its content is deleted from TeamPulse and it is no longer used anywhere. The original in the app is not touched.', confirm: 'Remove', danger: true })
    if (r?.ok) { try { await api(`/api/work-evidence/${b.dataset.evRemove}`, { method: 'DELETE' }); toast('Removed.'); reload() } catch (e) { toast(errorText(e), { error: true }) } }
  }))
}

export async function renderEvidence(main, q) {
  const state = STATES.some(([k]) => k === q.get('state')) ? q.get('state') : 'review'
  main.innerHTML = loading().toString()
  const [sources, catalog, items, identities, conns] = await Promise.all([
    api('/api/work-evidence/sources'), api('/api/work-evidence/catalog'), api('/api/work-evidence?view=mine'), api('/api/work-evidence/identities'),
    api('/api/viasocket/connections').catch(() => ({ configured: false, connections: [] }))
  ])
  const filtered = items.filter((e) => state === 'all' || (state === 'review' ? ['suggested', 'possible'].includes(e.linkState) && e.links.some((l) => l.status === 'suggested') : e.linkState === state))
  const pending = items.filter((e) => e.links.some((l) => l.status === 'suggested')).length
  const errors = sources.reduce((n, s) => n + s.collectionErrors, 0)
  const active = sources.filter((s) => s.status === 'ACTIVE').length
  main.innerHTML = html`<div class="page-head"><div><div class="eyebrow">${icon('evidence', 'xs')}Evidence</div><h1>My work evidence</h1><p>What TeamPulse notices in the apps you connected — only the repositories, channels, labels, calendars or sheets you chose — and which of your tasks it belongs to. Activity is never counted; it only explains your work.</p></div>
      <button class="btn" id="analyse-mine">${icon('sparkles')}Analyse my work</button></div>
    <div id="analyse-out"></div>
    <ol class="trust-steps" aria-label="How evidence becomes part of your work">
      <li>${prov('fact', 'Observed')}<span>TeamPulse notices activity in the sources you chose.</span></li>
      <li>${prov('suggested', 'Suggested')}<span>It proposes which of your tasks it belongs to. Nothing counts yet.</span></li>
      <li>${prov('self', 'Confirmed by you')}<span>You decide. Only then is it used when your work is analysed.</span></li></ol>
    <section aria-labelledby="src-h" style="margin-top:20px"><div class="section-title" style="margin-top:0"><div><h2 id="src-h">Connected sources</h2><p class="small muted" style="margin:2px 0 0">${sources.length ? `${active} collecting${errors ? ` · ${errors} event(s) could not be read` : ''}` : 'Nothing is collected yet.'}</p></div>
      ${catalog.configured ? html`<button class="btn small" id="add-source">${icon('plus')}Add a source</button>` : ''}</div>
      ${!catalog.configured ? html`<div class="notice">New sources cannot be added: app connections are not set up on this server (viaSocket keys missing).</div>` : ''}
      ${sources.length ? html`<div class="source-grid">${sources.map((s) => html`<article class="card source ${s.status === 'ACTIVE' ? '' : 'off'}">
          <div class="row nowrap" style="gap:12px;align-items:flex-start">${appTile(s.app, 'lg')}<div class="grow" style="min-width:0"><div class="row" style="gap:6px"><b>${s.appLabel}</b><span class="badge ${STATUS[s.status]?.[1] || 'outline'}">${STATUS[s.status]?.[0] || s.status}</span></div>
            <div class="clip" title="${s.scope}">${s.scope}</div><div class="small muted">${s.kinds.map((k) => k.label).join(' · ')}</div></div></div>
          <div class="small muted health">${s.lastSuccessAt ? `Last event ${ago(s.lastEventAt)}` : 'No events yet'}${s.lastHealthAt ? ` · checked ${ago(s.lastHealthAt)}` : ''}${Object.entries(s.linkState).length ? ` · ${Object.entries(s.linkState).map(([k, n]) => `${n} ${k === 'unmatched' ? 'not linked' : k}`).join(', ')}` : ''}</div>
          ${s.lastError ? html`<div class="notice err small" style="margin:8px 0 0">${s.lastError}</div>` : ''}
          <details class="small"><summary>Advanced</summary><ul class="plain">${s.history.map((h) => html`<li>${dt(h.at)} · ${h.kind} · ${h.status}${h.items ? ` · ${h.items} item(s)` : ''}${h.error ? ` · ${h.error}` : ''}</li>`)}</ul></details>
          <div class="row" style="gap:6px;margin-top:10px">${s.status === 'ACTIVE' ? html`<button class="btn small ghost" data-src="${s.id}" data-to="PAUSED">Pause</button>` : s.status === 'PAUSED' ? html`<button class="btn small ghost" data-src="${s.id}" data-to="ACTIVE">Resume</button>` : ''}<button class="btn small subtle" data-src="${s.id}" data-to="DELETED">Stop</button></div></article>`)}</div>`
        : catalog.configured ? html`<div class="card">${empty('No sources yet', 'Add GitHub, Slack, Gmail, Google Calendar or Google Sheets. First connect the account in Connected Apps.', html`<a class="btn small ghost" href="#/automations">${icon('apps')}Connect an app</a>`, 'apps')}</div>` : ''}
    </section>
    <section class="card" style="margin-top:20px" aria-labelledby="ev-h"><div class="card-head"><div><h2 id="ev-h">Evidence</h2><p>${pending ? `${pending} item(s) wait for your confirmation.` : 'Nothing waits for you.'} Only confirmed links and high-confidence suggestions are used when your work is analysed.</p></div></div>
      <div class="tabs">${STATES.map(([k, l]) => html`<a href="#/evidence?state=${k}" ${k === state ? raw('aria-current="page"') : ''}>${l}${k === 'review' && pending ? html` <span class="badge brand">${pending}</span>` : ''}</a>`)}</div>
      ${filtered.length ? html`<ul class="list ev-list">${filtered.slice(0, 100).map((e) => evidenceItem(e))}</ul>` : empty(state === 'review' ? 'Nothing to confirm' : 'No evidence here', state === 'review' ? 'Suggested matches appear here for you to confirm or reject.' : 'Collected evidence appears here.', '', state === 'review' ? 'checkCircle' : 'inbox')}
    </section>
    <section class="card" style="margin-top:20px" aria-labelledby="id-h"><div class="card-head"><div><h2 id="id-h">Who you are in each app</h2><p>So your commits and messages are recognised as yours — and nobody else’s are. Each identity can belong to one person only.</p></div><button class="btn small ghost" id="add-identity">${icon('plus')}Add</button></div>
      ${identities.length ? html`<ul class="list">${identities.map((i) => html`<li>${appTile(i.app)}<div class="grow"><b>${i.identity}</b> <span class="small muted">${i.app} · ${i.source === 'connection' ? 'from your connected account' : 'added by you'}</span></div><button class="btn small subtle" data-identity="${i.id}">Remove</button></li>`)}</ul>` : html`<p class="small muted" style="margin:0">None yet. Without it, your GitHub and Slack activity shows as “author not known”.</p>`}
    </section>`.toString()
  const reload = () => renderEvidence(main, q).catch((e) => toast(errorText(e), { error: true }))
  let tasksCache = null
  const myTasks = async () => (tasksCache ||= await api('/api/tasks?view=mine&includeClosed=true'))
  bindEvidenceActions(main, reload, myTasks)
  main.querySelector('#analyse-mine').addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true
    const box = main.querySelector('#analyse-out')
    box.innerHTML = html`<div class="ai-block" role="status" style="margin-bottom:16px"><span class="spinner" aria-hidden="true"></span> Matching your evidence and analysing your recent tasks…</div>`.toString()
    try {
      const r = await api('/api/contribution/analyse', { method: 'POST', body: {} })
      const T = { queued: 'Analysing…', in_progress: 'Already being analysed', unchanged: 'Nothing new since the last analysis', done: 'Done (too little evidence for AI)', not_analysed: 'Not analysed' }
      box.innerHTML = html`<section class="card" style="margin-bottom:16px"><div class="card-head"><h2><span class="card-icon brand">${icon('sparkles')}</span>Analysis started</h2>${prov('ai', 'AI-assisted')}</div>
        <p class="small muted">${r.tasks} recent task(s)${r.pendingConfirmations ? ` · ${r.pendingConfirmations} evidence link(s) wait for your confirmation` : ''}. Results appear on each task’s page.</p>
        <ul class="list">${r.results.map((x) => html`<li><div class="grow"><a href="#/tasks/${x.taskId}">${x.title}</a><div class="small ${x.status === 'not_analysed' ? '' : 'muted'}">${T[x.status] || x.status}${x.reason ? ` — ${x.reason}` : ''}</div></div></li>`)}</ul>
        ${!r.results.length ? html`<p class="small">No recent tasks to analyse.</p>` : ''}</section>`.toString()
    } catch (e) { box.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() } finally { ev.currentTarget && (ev.currentTarget.disabled = false) }
  })
  main.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.to === 'DELETED') { const r = await confirmDialog({ title: 'Stop collecting from this source?', body: 'The viaSocket triggers are removed. Evidence already collected stays until you remove it.', confirm: 'Stop', danger: true }); if (!r?.ok) return }
    try { await api(`/api/work-evidence/sources/${b.dataset.src}/status`, { method: 'POST', body: { status: b.dataset.to } }); reload() } catch (e) { toast(errorText(e), { error: true }) }
  }))
  main.querySelectorAll('[data-identity]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/api/work-evidence/identities/${b.dataset.identity}`, { method: 'DELETE' }); reload() } catch (e) { toast(errorText(e), { error: true }) } }))
  main.querySelector('#add-identity').addEventListener('click', () => modal(html`<h2 id="modal-title">Who are you in…</h2><form id="f"><div class="form-error"></div>
    <div class="field"><label for="ia">App</label><select id="ia" name="app"><option value="github">GitHub (username)</option><option value="slack">Slack (member id, e.g. U0123ABCD)</option><option value="gmail">Gmail (address)</option><option value="google-calendar">Google Calendar (address)</option></select></div>
    <div class="field"><label for="ii">Identity</label><input id="ii" name="identity" type="text" required maxlength="200"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Add</button></div></form>`.toString(), (el, close) => {
    bindForm(el.querySelector('#f'), (d) => api('/api/work-evidence/identities', { method: 'POST', body: d }), { onSuccess: () => { close(); reload() } })
  }))
  main.querySelector('#add-source')?.addEventListener('click', () => openAddSource(catalog, conns, reload))
}

function openAddSource(catalog, conns, reload) {
  const connected = (slug) => (conns.connections || []).filter((c) => c.app === slug)
  modal(html`<h2 id="modal-title">Add a source</h2><form id="f"><div class="form-error"></div>
    <div class="field"><label for="sa">App</label><select id="sa" name="app">${catalog.apps.map((a) => html`<option value="${a.app}">${a.label}</option>`)}</select><div class="hint" id="sa-help"></div></div>
    <div class="field"><label for="sc">Your connected account</label><select id="sc" name="connectionId"></select><div class="hint" id="sc-help"></div></div>
    <div class="field"><label for="ss">What to collect from</label><select id="ss" name="scope" disabled><option value="">Choose an account first</option></select></div>
    <div class="field" id="sheet-field" hidden><label for="sh">Sheet</label><select id="sh" name="sheet"></select></div>
    <fieldset class="field" style="border:0;padding:0"><legend class="small">Events</legend><div id="kinds"></div></fieldset>
    <p class="small muted">TeamPulse only reads. Nothing is posted, sent or changed in the app.</p>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Start collecting</button></div></form>`.toString(), (el, close) => {
    const $ = (s) => el.querySelector(s)
    const loadScopes = async () => {
      const scope = $('#ss'); scope.disabled = true; scope.innerHTML = '<option value="">Loading…</option>'
      if (!$('#sc').value) { scope.innerHTML = '<option value="">Connect this app first</option>'; return }
      try {
        const r = await api(`/api/work-evidence/scope-options?app=${encodeURIComponent($('#sa').value)}&connectionId=${encodeURIComponent($('#sc').value)}`)
        scope.innerHTML = r.options.length ? r.options.map((o) => html`<option value="${o.value}">${o.label}</option>`).join('') : '<option value="">Nothing found in this account</option>'
        scope.disabled = !r.options.length
        await loadSheets()
      } catch (e) { scope.innerHTML = html`<option value="">${errorText(e)}</option>`.toString() }
    }
    const loadSheets = async () => {
      const a = catalog.apps.find((x) => x.app === $('#sa').value)
      $('#sheet-field').hidden = !a.needsSubPick
      if (!a.needsSubPick || !$('#ss').value) return
      const r = await api(`/api/work-evidence/scope-options?app=${encodeURIComponent(a.app)}&connectionId=${encodeURIComponent($('#sc').value)}&parent=${encodeURIComponent($('#ss').value)}`)
      $('#sh').innerHTML = r.options.map((o) => html`<option value="${o.value}">${o.label}</option>`).join('')
    }
    const onApp = () => {
      const a = catalog.apps.find((x) => x.app === $('#sa').value)
      $('#sa-help').textContent = a.help
      const cs = connected(a.app)
      $('#sc').innerHTML = cs.length ? cs.map((c) => html`<option value="${c.id}">${c.label || a.label}${c.status === 'expired' ? ' (expired)' : ''}</option>`).join('') : ''
      $('#sc-help').innerHTML = cs.length ? '' : html`No ${a.label} account connected. <a href="#/automations">Connect it in the Automation Center</a>, then come back.`.toString()
      $('#kinds').innerHTML = a.kinds.map((k) => html`<label class="check"><input type="checkbox" name="kind" value="${k.kind}" ${k.default ? raw('checked') : ''}> ${k.label}</label>`).join('')
      loadScopes()
    }
    $('#sa').addEventListener('change', onApp); $('#sc').addEventListener('change', loadScopes); $('#ss').addEventListener('change', loadSheets)
    onApp()
    bindForm($('#f'), () => {
      const scopeLabel = $('#ss').selectedOptions[0]?.textContent
      return api('/api/work-evidence/sources', { method: 'POST', body: { app: $('#sa').value, connectionId: $('#sc').value, scope: { value: $('#ss').value, label: scopeLabel, ...(!$('#sheet-field').hidden ? { sheet: $('#sh').value } : {}) }, kinds: [...el.querySelectorAll('input[name=kind]:checked')].map((i) => i.value) } })
    }, {
      onSuccess: (out) => {
        close()
        const bad = out.results.filter((r) => r.status !== 'active')
        toast(bad.length ? `Started with ${out.results.length - bad.length} of ${out.results.length} event kinds. ${bad[0].error || ''}` : 'Collecting. New events will appear here.', { error: bad.length === out.results.length })
        reload()
      }
    })
  })
}

/** Managers: evidence whose attribution is disputed or unknown, and shared links to resolve. */
export async function renderEvidenceReview(box) {
  let items
  try { items = await api('/api/work-evidence?view=review') } catch (e) { box.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
  const people = await api('/api/members').catch(() => [])
  box.innerHTML = items.length ? html`<ul class="list">${items.slice(0, 50).map((e) => html`${evidenceItem(e, { canAct: false })}
    <li class="ev-resolve" style="border-top:0;padding-top:0"><div class="row" style="gap:6px">
      <label class="small" for="r-${e.id}">Whose work is this?</label>
      <select id="r-${e.id}" data-resolve-select="${e.id}"><option value="">Choose…</option>${people.filter((p) => p.userId !== app.me.id || app.isAdmin).map((p) => html`<option value="${p.userId}" ${p.userId === e.actorId ? raw('selected') : ''}>${p.name}</option>`)}<option value="__external">Someone outside the organization</option></select>
      <button class="btn small" data-resolve="${e.id}">Save</button>
      ${e.links.filter((l) => l.share === 'shared').map((l) => html`<span class="small muted">Shared on “${l.taskTitle}”</span><button class="btn small ghost" data-share="${l.id}" data-to="INDIVIDUAL">Only ${l.contributorName || 'contributor'}'s</button>`)}
    </div></li>`)}</ul>` : empty('Nothing to review', 'Disputed or unknown authorship and shared links appear here.')
  box.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    const val = box.querySelector(`[data-resolve-select="${b.dataset.resolve}"]`).value
    if (!val) return toast('Choose a person first.', { error: true })
    try { await api(`/api/work-evidence/${b.dataset.resolve}/attribution`, { method: 'POST', body: val === '__external' ? { external: true } : { userId: val } }); toast('Saved.'); renderEvidenceReview(box) } catch (e) { toast(errorText(e), { error: true }) }
  }))
  box.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/work-evidence-links/${b.dataset.share}/share`, { method: 'POST', body: { share: b.dataset.to } }); toast('Saved.'); renderEvidenceReview(box) } catch (e) { toast(errorText(e), { error: true }) }
  }))
}

/** The task page's external evidence list. */
export async function renderTaskExternalEvidence(box, taskId) {
  try {
    const items = await api(`/api/tasks/${taskId}/external-evidence`)
    if (!items.length) { box.remove(); return }
    box.innerHTML = html`<div class="card-head"><h2><span class="card-icon teal">${icon('evidence')}</span>From connected apps</h2></div><ul class="list">${items.map((e) => html`<li>${appTile(e.app, 'sm')}<div class="grow" style="min-width:0"><div class="small">${e.links.find((l) => l.taskId === taskId)?.status === 'confirmed' ? prov('self', 'Confirmed') : prov('suggested', 'Suggested')}</div>
      <div>${e.sourceUrl ? html`<a href="${e.sourceUrl}" target="_blank" rel="noopener noreferrer">${e.title || e.kind}</a>` : e.title || e.kind}</div>
      <div class="small muted">${ago(e.occurredAt)} · ${e.actorName ? `by ${e.actorName}` : e.attributionText}</div></div></li>`)}</ul>`.toString()
  } catch { box.remove() }
}

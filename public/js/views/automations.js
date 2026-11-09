// Automation Center: (1) Connected Apps — curated ViaSocket apps in context, (2) Ready-made TeamPulse automations,
// (3) Advanced Builder — the full ViaSocket Embed. The browser only ever holds the per-user embed token.
import { api, html, raw, esc, modal, bindForm, toast, errorText, ago, empty, confirmDialog } from '../ui.js'
import { app } from '../app.js'

const EMBED_SCRIPT = 'https://embed.viasocket.com/prod-embedcomponent.js'
const EMBED_ORIGIN = 'https://embedfrontend.viasocket.com'
let sdkPromise = null
const loadSdk = () => (sdkPromise ||= import('/vendor/viasocket-apps-browser.js').then((sdk) => { sdk.loadConnectScript().catch(() => {}); return sdk }))
const CONNECT_ERRORS = { rejected: 'The app refused the connection, or ViaSocket did not accept it.', invalid: 'ViaSocket did not accept this app id.', script: 'ViaSocket’s connect script could not load. Check your connection or ad blocker.', unavailable: 'The popup could not open. Allow popups for this site and try again.' }
const STATUS_BADGE = { ACTIVE: 'ok', PAUSED: 'outline', NEEDS_SETUP: 'warn', FAILED: 'bad' }
const RUN_BADGE = { SUCCEEDED: 'ok', FAILED: 'bad', UNKNOWN: 'warn', RUNNING: 'info', SKIPPED: 'outline' }

export async function renderAutomations(main, q) {
  const tab = q.get('tab') || 'apps'
  const [conns, autos] = await Promise.all([api('/api/viasocket/connections'), api('/api/automations')])
  main.innerHTML = html`
    <div class="page-head"><div><h1>Automation Center</h1><p>Connect the apps your team already uses, switch on ready-made TeamPulse automations, or build your own with the full ViaSocket builder.</p></div></div>
    ${!conns.configured ? html`<div class="notice warn"><b>ViaSocket is not configured on this server.</b> App connections, the New Task Notification, the Weekly Team Report delivery and the Advanced Builder need an admin to set <span class="mono">VIASOCKET_ORG_ID</span>, <span class="mono">VIASOCKET_PROJECT_ID</span> and <span class="mono">VIASOCKET_EMBED_SECRET</span> (see README → ViaSocket). External requests and in-app notifications work without it.</div>` : ''}
    <div class="tabs" role="tablist">${[['apps', 'Connected apps'], ['ready', 'Ready-made automations'], ['builder', 'Advanced builder']].map(([k, l]) => html`<a href="#/automations?tab=${k}" ${tab === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</div>
    <div id="tab-body"></div>`
  const body = main.querySelector('#tab-body')
  if (tab === 'apps') return renderApps(body, conns, () => renderAutomations(main, q))
  if (tab === 'ready') return renderReady(body, autos, conns, () => renderAutomations(main, q))
  return renderBuilder(body, conns, q.get('app'))
}

// ---------- 1. Connected apps ----------
function renderApps(body, conns, reload) {
  const byApp = (slug) => conns.connections.filter((c) => c.app === slug)
  body.innerHTML = html`
    ${conns.error ? html`<div class="notice warn">${conns.error}</div>` : ''}
    <div class="grid two">${conns.apps.map((a) => html`<article class="card"><div class="app-card"><div class="app-icon" aria-hidden="true">${a.name[0]}</div><div style="flex:1;min-width:0">
      <div class="row between"><h3>${a.name}</h3>${a.runsInTeamPulse ? html`<span class="badge brand">Used by TeamPulse</span>` : html`<span class="badge outline">Builder</span>`}</div>
      <p class="small" style="margin-top:4px">${a.purpose}</p>
      <div class="small muted">Used by: ${a.usedBy.join(' · ')}</div>
      ${a.error ? html`<div class="notice err small" style="margin-top:8px">${a.error}</div>` : ''}
      ${byApp(a.slug).length ? html`<ul class="list" style="margin-top:8px">${byApp(a.slug).map((c) => html`<li><div class="grow"><b>${c.label || a.name}</b> <span class="badge ${c.status === 'active' ? 'ok' : c.status === 'unknown' ? 'outline' : 'bad'}">${({ active: 'Connected', expired: 'Expired', missing: 'Removed on ViaSocket', unknown: 'Status unknown' })[c.status]}</span><div class="small muted">since ${ago(c.createdAt)}</div></div>
        ${c.status === 'expired' ? html`<button class="btn small" data-reconnect="${c.id}">Reconnect</button>` : ''}<button class="btn small ghost" data-disconnect="${c.id}" data-name="${a.name}">Disconnect</button></li>`)}</ul>` : ''}
      <div class="row" style="margin-top:10px">
        <button class="btn small" data-connect="${a.slug}" ${!conns.configured || !a.serviceId ? raw('disabled') : ''}>${byApp(a.slug).length ? 'Connect another' : `Connect ${a.name}`}</button>
        ${!a.runsInTeamPulse ? html`<a class="btn small ghost" href="#/automations?tab=builder&app=${a.slug}">Build with ${a.name}</a>` : ''}
      </div></div></div></article>`)}</div>
    <p class="small muted" style="margin-top:12px">You sign in on each app’s own page in a ViaSocket popup. ViaSocket keeps the access; TeamPulse stores only a reference to your connection, on the server.</p>`
  if (!conns.configured) return
  // Token and SDK are fetched on page load so the popup can open straight from the click (browsers block it otherwise).
  const ready = Promise.all([api(`/api/viasocket/token?apps=${conns.apps.map((a) => a.slug).join(',')}`), loadSdk()])
  ready.catch((e) => toast(errorText(e), { error: true }))
  body.querySelectorAll('[data-connect]').forEach((b) => b.addEventListener('click', async () => {
    const [{ token, serviceIds }, sdk] = await ready
    const appDef = conns.apps.find((a) => a.slug === b.dataset.connect)
    const save = (authId) => api('/api/viasocket/connections', { method: 'POST', body: { app: appDef.slug, authId } }).then(() => { toast(`${appDef.name} connected.`); reload() })
    try {
      const { authId } = await sdk.connect({ embedToken: token, serviceId: serviceIds[appDef.slug], ...(appDef.actions ? { actions: appDef.actions, skipActionSelection: true } : {}), onLateSuccess: ({ authId: late }) => save(late).catch((e) => toast(errorText(e), { error: true })) })
      await save(authId)
    } catch (e) {
      if (e.code === 'closed') return
      toast(CONNECT_ERRORS[e.code] || errorText(e), { error: true })
    }
  }))
  body.querySelectorAll('[data-reconnect]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const [r, sdk] = await Promise.all([api(`/api/viasocket/connections/${b.dataset.reconnect}/reconnect`), loadSdk()])
      const { authId } = await sdk.connect({ embedToken: r.token, serviceId: r.serviceId, authId: r.authId })
      await api('/api/viasocket/connections', { method: 'POST', body: { app: r.app, authId } })
      toast('Reconnected.'); reload()
    } catch (e) { if (e.code !== 'closed') toast(CONNECT_ERRORS[e.code] || errorText(e), { error: true }) }
  }))
  body.querySelectorAll('[data-disconnect]').forEach((b) => b.addEventListener('click', async () => {
    const r = await confirmDialog({ title: `Disconnect ${b.dataset.name}?`, body: 'TeamPulse pauses what it runs on this account and revokes the connection on ViaSocket. Automations that use it will need setup again.', confirm: 'Disconnect', danger: true })
    if (!r?.ok) return
    try { await api(`/api/viasocket/connections/${b.dataset.disconnect}`, { method: 'DELETE' }); toast('Disconnected.'); reload() } catch (e) { toast(errorText(e), { error: true }) }
  }))
}

// ---------- 2. Ready-made automations ----------
function renderReady(body, autos, conns, reload) {
  const canConfigure = autos.canConfigure
  body.innerHTML = html`
    ${!canConfigure ? html`<div class="notice">Managers and admins configure these automations for the organization. You can see what is active.</div>` : ''}
    <div class="stack">${autos.automations.map((a) => html`<article class="card"><div class="row between"><div><h3>${a.name}</h3><p class="small muted" style="max-width:75ch">${a.description}</p></div>
      ${!a.available ? html`<span class="badge outline">Coming next</span>` : a.workflow ? html`<span class="badge ${STATUS_BADGE[a.workflow.status]}">${a.workflow.status.replace('_', ' ').toLowerCase()}</span>` : html`<span class="badge outline">Not set up</span>`}</div>
      ${a.workflow ? html`<div class="small muted" style="margin-top:6px">Set up by ${a.workflow.ownerName}${a.workflow.config.channel ? ` · via ${a.workflow.config.channel === 'slack' ? `Slack ${a.workflow.config.slackChannelLabel || ''}` : `Gmail${a.workflow.config.emailTo ? ` to ${a.workflow.config.emailTo}` : ' to each assignee'}`}` : ''}${a.workflow.lastRunAt ? ` · last run ${ago(a.workflow.lastRunAt)}` : ''}</div>
        ${a.workflow.lastError ? html`<div class="notice err small" style="margin:8px 0 0">Last error: ${a.workflow.lastError}</div>` : ''}` : ''}
      ${a.available && canConfigure ? html`<div class="row" style="margin-top:10px">
        ${a.key === 'external_request_intake' ? html`<button class="btn small" data-intake>${a.tokenIssued ? 'Rotate intake token' : 'Create intake token'}</button><button class="btn small ghost" data-config="${a.key}">Default team</button>` : html`<button class="btn small" data-config="${a.key}" ${!autos.viasocketConfigured ? raw('disabled title="ViaSocket is not configured"') : ''}>${a.workflow ? 'Change setup' : 'Set up'}</button>`}
        ${a.workflow && ['ACTIVE', 'FAILED'].includes(a.workflow.status) ? html`<button class="btn small ghost" data-status="${a.key}" data-to="PAUSED">Pause</button>` : ''}
        ${a.workflow && a.workflow.status === 'PAUSED' ? html`<button class="btn small ghost" data-status="${a.key}" data-to="ACTIVE">Resume</button>` : ''}
        ${a.key === 'weekly_team_report' ? html`<button class="btn small ghost" data-preview>Preview this week</button>` : ''}
      </div>` : ''}
      ${a.key === 'external_request_intake' && canConfigure ? html`<details style="margin-top:10px"><summary class="small">How to send requests</summary><div class="small" style="margin-top:6px">
        <p>Point any ViaSocket flow (for example a Gmail “new email with label” or Slack “new message” trigger, built in the Advanced builder) at this endpoint with an HTTP step. Every request becomes a <b>pending task request</b> for manager approval — never an assigned task.</p>
        <pre class="mono" style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:6px">POST ${location.origin}/api/inbound/task-requests
Authorization: Bearer &lt;intake token&gt;
Content-Type: application/json

{"title": "…", "description": "…", "reason": "…", "requester": "customer@example.com",
 "externalRef": "unique-id-from-source", "suggestedPriority": "HIGH", "suggestedDueAt": "2026-12-01"}</pre>
        <p class="muted">externalRef makes retries safe: the same reference never creates a second request.</p></div></details>` : ''}
      ${a.recentRuns.length ? html`<details style="margin-top:10px"><summary class="small">Recent runs (${a.recentRuns.length})</summary><div class="table-wrap" style="margin-top:6px"><table><thead><tr><th>When</th><th>Trigger</th><th>Status</th><th>Result</th><th></th></tr></thead><tbody>
        ${a.recentRuns.map((r) => html`<tr><td class="nowrap">${ago(r.startedAt)}</td><td>${r.trigger}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ''}</td><td><span class="badge ${RUN_BADGE[r.status]}">${r.status.toLowerCase()}</span></td><td class="small">${r.summary || r.error || ''}${r.status === 'UNKNOWN' ? html`<div class="muted">Not retried automatically: it may have been delivered.</div>` : ''}</td>
          <td>${r.status === 'FAILED' && r.useCase === 'new_task_notification' ? html`<button class="btn small ghost" data-retry="${r.id}">Retry</button>` : ''}</td></tr>`)}</tbody></table></div></details>` : ''}
    </article>`)}</div>`

  const conn = (slug) => conns.connections.filter((c) => c.app === slug && c.status !== 'missing')
  body.querySelectorAll('[data-config]').forEach((b) => b.addEventListener('click', async () => {
    const a = autos.automations.find((x) => x.key === b.dataset.config)
    if (a.key === 'external_request_intake') {
      const teams = await api('/api/teams')
      return modal(html`<h2 id="modal-title">External requests: default team</h2><form id="f"><div class="form-error"></div><div class="field"><label for="x-t">Requests go to</label><select id="x-t" name="defaultTeamId"><option value="">(admins decide)</option>${teams.map((t) => html`<option value="${t.id}" ${a.workflow?.config.defaultTeamId === t.id ? raw('selected') : ''}>${t.name}</option>`)}</select></div>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`.toString(), (el, close) => bindForm(el.querySelector('#f'), (d) => api(`/api/automations/${a.key}`, { method: 'PUT', body: { defaultTeamId: d.defaultTeamId || null } }), { onSuccess: () => { close(); toast('Saved.'); reload() } }))
    }
    const slack = conn('slack')
    const gmail = conn('gmail')
    if (!slack.length && !gmail.length) return modal(html`<h2 id="modal-title">Connect Slack or Gmail first</h2><p>This automation sends through your own Slack or Gmail account.</p><div class="row end"><button class="btn ghost" data-close>Close</button><a class="btn" href="#/automations?tab=apps">Connect an app</a></div>`.toString(), (el, close) => el.querySelector('a').addEventListener('click', () => close()))
    modal(html`<h2 id="modal-title">${a.name}</h2><form id="f"><div class="form-error"></div>
      <div class="field"><label for="c-ch">Deliver through</label><select id="c-ch" name="channel">${slack.length ? html`<option value="slack" ${a.workflow?.config.channel === 'slack' ? raw('selected') : ''}>Slack</option>` : ''}${gmail.length ? html`<option value="gmail" ${a.workflow?.config.channel === 'gmail' ? raw('selected') : ''}>Gmail</option>` : ''}</select></div>
      <div class="field"><label for="c-conn">Account</label><select id="c-conn" name="connectionId"></select></div>
      <div class="field" id="slack-ch"><label for="c-sl">Slack channel</label><select id="c-sl" name="slackChannelId"><option value="">Loading…</option></select></div>
      ${a.key === 'weekly_team_report' ? html`<div class="field" id="mail-to"><label for="c-to">Send the report to</label><input id="c-to" name="emailTo" type="email" value="${a.workflow?.config.emailTo || app.me.email}"></div>` : html`<p class="small muted" id="mail-note">With Gmail, each assignee gets an email from your Gmail account.</p>`}
      <p class="small muted">Runs use your own connected account. Messages only inform — they never change tasks or approvals.</p>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save and activate</button></div></form>`.toString(), (el, close) => {
      const chSel = el.querySelector('#c-ch'); const connSel = el.querySelector('#c-conn'); const slSel = el.querySelector('#c-sl')
      const fillConn = () => { const list = chSel.value === 'slack' ? slack : gmail; connSel.innerHTML = list.map((c) => `<option value="${esc(c.id)}">${esc(c.label || chSel.value)}</option>`).join('') }
      const fillChannels = async () => {
        if (chSel.value !== 'slack') return
        slSel.innerHTML = '<option value="">Loading…</option>'
        try { const ch = await api(`/api/viasocket/connections/${connSel.value}/slack-channels`); slSel.innerHTML = ch.map((c) => `<option value="${esc(c.value)}" ${a.workflow?.config.slackChannelId === c.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('') } catch (e) { slSel.innerHTML = '<option value="">Could not load</option>'; el.querySelector('.form-error').innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() }
      }
      const sync = () => { el.querySelector('#slack-ch').style.display = chSel.value === 'slack' ? '' : 'none'; const m = el.querySelector('#mail-to, #mail-note'); if (m) m.style.display = chSel.value === 'gmail' ? '' : 'none'; fillConn(); fillChannels() }
      chSel.addEventListener('change', sync); connSel.addEventListener('change', fillChannels); sync()
      bindForm(el.querySelector('#f'), (d) => api(`/api/automations/${a.key}`, { method: 'PUT', body: { channel: d.channel, connectionId: d.connectionId, slackChannelId: d.channel === 'slack' ? d.slackChannelId : undefined, emailTo: d.emailTo } }), { onSuccess: () => { close(); toast(`${a.name} is active.`); reload() } })
    })
  }))
  body.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/automations/${b.dataset.status}/status`, { method: 'POST', body: { status: b.dataset.to } }); toast(b.dataset.to === 'PAUSED' ? 'Paused.' : 'Resumed.'); reload() } catch (e) { toast(errorText(e), { error: true }) }
  }))
  body.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true
    try { await api(`/api/automations/runs/${b.dataset.retry}/retry`, { method: 'POST' }); toast('Retried.'); reload() } catch (e) { toast(errorText(e), { error: true }); b.disabled = false }
  }))
  body.querySelector('[data-intake]')?.addEventListener('click', async () => {
    const a = autos.automations.find((x) => x.key === 'external_request_intake')
    if (a.tokenIssued) { const r = await confirmDialog({ title: 'Rotate the intake token?', body: 'Flows using the old token stop working until you update them with the new one.', confirm: 'Rotate', danger: true }); if (!r?.ok) return }
    try {
      const { token } = await api('/api/automations/external_request_intake/token', { method: 'POST' })
      modal(html`<h2 id="modal-title">Intake token</h2><div class="notice warn">Copy it now — it is shown only once. Store it as a secret in your ViaSocket flow.</div><input type="text" readonly value="${token}" id="tok" class="mono" onclick="this.select()"><div class="row end" style="margin-top:12px"><button class="btn" data-close>Done</button></div>`.toString())
      reload()
    } catch (e) { toast(errorText(e), { error: true }) }
  })
  body.querySelector('[data-preview]')?.addEventListener('click', async () => {
    try { const { text } = await api('/api/automations/weekly_team_report/preview', { method: 'POST', body: {} }); modal(html`<h2 id="modal-title">Weekly report preview</h2><pre class="pre small" style="background:var(--surface-2);padding:12px;border-radius:8px">${text}</pre><div class="row end"><button class="btn" data-close>Close</button></div>`.toString()) } catch (e) { toast(errorText(e), { error: true }) }
  })
}

// ---------- 3. Advanced builder (full ViaSocket Embed) ----------
async function renderBuilder(body, conns, appSlug) {
  const flows = await api('/api/viasocket/embed-flows').catch(() => [])
  const focus = appSlug && conns.apps.find((a) => a.slug === appSlug)
  body.innerHTML = html`
    <p class="muted" style="margin-bottom:10px">${focus ? html`Building with <b>${focus.name}</b>. <a href="#/automations?tab=builder">Show all apps</a>` : 'Build your own automations across 2,300+ apps. Each person’s flows are their own.'}</p>
    ${conns.configured ? html`<div id="embed-box" aria-label="ViaSocket automation builder"><div class="loading">Loading the builder…</div></div>` : html`<div class="card">${empty('Builder unavailable', 'ViaSocket is not configured on this server.')}</div>`}
    ${flows.length ? html`<h2 style="margin:18px 0 8px">Your published flows</h2><ul class="list card">${flows.map((f) => html`<li><div class="grow"><b>${f.title || f.flowId}</b><div class="small muted">updated ${ago(f.updatedAt)}</div></div><span class="badge ${f.status === 'active' ? 'ok' : 'outline'}">${f.status}</span></li>`)}</ul>` : ''}`
  if (!conns.configured) return
  try {
    const { token, serviceIds } = await api(`/api/viasocket/token${focus ? `?apps=${focus.slug}` : ''}`)
    // Flow events: check the origin, then let the server read the flow back from ViaSocket (never trust the browser's copy).
    const onFlow = (flow) => { if (flow?.id && ['published', 'updated', 'paused', 'deleted'].includes(flow.action)) api(`/api/viasocket/embed-flows/${encodeURIComponent(flow.id)}/sync`, { method: 'POST' }).then(() => toast(`Flow ${flow.action}.`)).catch(() => {}) }
    const listener = (event) => { if (event.origin !== EMBED_ORIGIN) return; onFlow(event.data) }
    window.addEventListener('message', listener)
    window.addEventListener('hashchange', () => window.removeEventListener('message', listener), { once: true })
    await loadScript(EMBED_SCRIPT)
    const box = document.getElementById('embed-box')
    if (!box) return
    box.innerHTML = ''
    const embed = window.viaSocket.mount({
      embedToken: token, parent: '#embed-box',
      config: { pageheading: 'Automation', pagesubheading: 'Automate the work around your TeamPulse tasks.', showTemplates: true, themeJson: { '--primary-color': '#4338ca' } },
      ...(focus && serviceIds[focus.slug] ? { open: { serviceId: serviceIds[focus.slug] } } : {})
    })
    embed.on?.('error', (e) => { box.innerHTML = html`<div class="notice err" style="margin:12px">The builder reported an error: ${e?.message || 'unknown'}</div>`.toString() })
    window.addEventListener('hashchange', () => { try { embed.destroy?.() } catch { /* already gone */ } }, { once: true })
  } catch (e) {
    const box = document.getElementById('embed-box')
    if (box) box.innerHTML = html`<div class="notice err" style="margin:12px">Could not load the builder: ${errorText(e)}</div>`.toString()
  }
}

function loadScript(src) {
  if (window.viaSocket?.mount) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('The ViaSocket builder script could not load. Check your connection or ad blocker.'))
    document.head.appendChild(s)
  })
}

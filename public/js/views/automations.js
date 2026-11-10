// Automation Center: (1) Connected Apps — curated ViaSocket apps in context, (2) Ready-made TeamPulse automations,
// (3) Advanced Builder — the full ViaSocket Embed. The browser only ever holds the per-user embed token.
import { api, html, raw, esc, modal, bindForm, toast, errorText, ago, empty, confirmDialog, loading, icon, appTile } from '../ui.js'
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
    <div class="page-head"><div><div class="eyebrow">${icon('apps', 'xs')}Connected apps</div><h1>${app.isManager ? 'Automation Center' : 'Connected apps'}</h1><p>Connect the apps you already use. TeamPulse can then collect the work evidence you allow, send notifications, and run ready-made automations — the full builder is there when you need more.</p></div></div>
    <section class="card steps-card"><ol class="steps"><li class="${(conns.connections || []).length ? 'done' : ''}"><b>Connect</b> an app below</li><li><a href="#/evidence"><b>Choose what to collect</b></a> — repositories, channels, a label, a calendar or a sheet</li><li><a href="#/assistant"><b>Analyse your work</b></a> — the evidence is linked to your tasks for you</li></ol></section>
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
    <div class="grid two">${conns.apps.map((a) => html`<article class="card"><div class="app-card">${a.slug ? appTile(a.slug, 'lg') : html`<div class="app-icon lg" aria-hidden="true">${a.name[0]}</div>`}<div style="flex:1;min-width:0">
      <div class="row between"><h3>${a.name}</h3>${a.runsInTeamPulse ? html`<span class="badge brand">Used by TeamPulse</span>` : html`<span class="badge outline">Builder</span>`}</div>
      <p class="small" style="margin-top:4px">${a.purpose}</p>
      <div class="small muted">Used by: ${a.usedBy.join(' · ')}</div>
      ${a.error ? html`<div class="notice err small" style="margin-top:8px">${a.error}</div>` : ''}
      ${byApp(a.slug).length ? html`<ul class="list" style="margin-top:8px">${byApp(a.slug).map((c) => html`<li><div class="grow"><b>${c.label || a.name}</b> <span class="badge ${c.status === 'active' ? 'ok' : c.status === 'unknown' ? 'outline' : 'bad'}">${({ active: 'Connected', expired: 'Expired', missing: 'Removed on ViaSocket', unknown: 'Status unknown' })[c.status]}</span><div class="small muted">since ${ago(c.createdAt)}</div></div>
        ${c.status === 'expired' ? html`<button class="btn small" data-reconnect="${c.id}">Reconnect</button>` : ''}<button class="btn small ghost" data-disconnect="${c.id}" data-name="${a.name}">Disconnect</button></li>`)}</ul>` : ''}
      <div class="row" style="margin-top:10px">
        <button class="btn small" data-connect="${a.slug}" ${!conns.configured || !a.serviceId ? raw('disabled') : ''}>${byApp(a.slug).length ? 'Connect another' : `Connect ${a.name}`}</button>
        <button class="btn small ghost" data-build="${a.slug}" data-name="${a.name}" ${!conns.configured ? raw('disabled') : ''}>Build with ${a.name}</button>
      </div></div></div></article>`)}</div>
    <p class="small muted" style="margin-top:12px">You sign in on each app’s own page in a ViaSocket popup. ViaSocket keeps the access; TeamPulse stores only a reference to your connection, on the server.</p>`
  // Restricted builder: only this app, only its curated actions, started from a TeamPulse event this person may use.
  body.querySelectorAll('[data-build]').forEach((b) => b.addEventListener('click', async () => {
    let contexts
    try { contexts = await api(`/api/viasocket/contexts?app=${b.dataset.build}`) } catch (e) { toast(errorText(e), { error: true }); return }
    if (!contexts.length) { toast(`${b.dataset.name} automations here are for managers.`, { error: true }); return }
    if (contexts.length === 1) return openContextBuilder(contexts[0].key, b.dataset.build)
    const pick = await modal(html`<h2 id="modal-title">Build with ${b.dataset.name}</h2><p class="muted">What should start it?</p><div class="stack">${contexts.map((c) => html`<button class="btn ghost" data-ctx="${c.key}" style="justify-content:flex-start">${c.label}</button>`)}</div><div class="row end" style="margin-top:12px"><button class="btn ghost" data-close>Cancel</button></div>`.toString(),
      (el, close) => el.querySelectorAll('[data-ctx]').forEach((x) => x.addEventListener('click', () => close(x.dataset.ctx))))
    if (pick) openContextBuilder(pick, b.dataset.build)
  }))
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
const DELIVERY_TARGETS = {
  new_task_notification: { slack: [['channel', 'Post in a team channel'], ['me', 'Message me in Slack']], gmail: [['assignee', 'Email the assignee'], ['me', 'Email me']] },
  weekly_team_report: { slack: [['channel', 'Post in a channel'], ['me', 'Message me in Slack']], gmail: [['recipients', 'Email these recipients'], ['me', 'Email me']] }
}
const deliveryText = (c) => !c?.channel ? '' : c.channel === 'slack'
  ? (c.slackUserId ? `Slack direct message to ${c.slackChannelLabel || 'you'}` : `Slack ${c.slackChannelLabel || 'channel'}`)
  : (c.target === 'assignee' ? 'Gmail, to each assignee' : c.target === 'recipients' ? `Gmail, to ${c.emailTo}` : 'Gmail, to you')

/**
 * The delivery form shared by team notifications, the weekly report and personal notifications: account → where.
 * Slack targets come from the user's own workspace (live pickers), never a typed id. Calls onSubmit(body).
 */
export function deliveryForm({ title, intro = '', conns, targets, current = {}, submitLabel = 'Save and activate', onSubmit, allowTest = true }) {
  const slack = conns.connections.filter((c) => c.app === 'slack' && c.status !== 'missing')
  const gmail = conns.connections.filter((c) => c.app === 'gmail' && c.status !== 'missing')
  if (!slack.length && !gmail.length) return modal(html`<h2 id="modal-title">Connect Slack or Gmail first</h2><p>This sends through your own Slack or Gmail account.</p><div class="row end"><button class="btn ghost" data-close>Close</button><a class="btn" href="#/automations?tab=apps">Connect an app</a></div>`.toString(), (el, close) => el.querySelector('a').addEventListener('click', () => close()))
  return modal(html`<h2 id="modal-title">${title}</h2>${intro ? html`<p class="small muted">${intro}</p>` : ''}<form id="f"><div class="form-error"></div>
    <div class="field"><label for="c-ch">Deliver through</label><select id="c-ch" name="channel">${slack.length ? html`<option value="slack" ${current.channel === 'slack' ? raw('selected') : ''}>Slack</option>` : ''}${gmail.length ? html`<option value="gmail" ${current.channel === 'gmail' ? raw('selected') : ''}>Gmail</option>` : ''}</select></div>
    <div class="field"><label for="c-conn">Your account</label><select id="c-conn" name="connectionId"></select></div>
    <div class="field" id="t-wrap"><label for="c-target">Send to</label><select id="c-target" name="target"></select></div>
    <div class="field" id="pick-wrap"><label for="c-pick" id="c-pick-label">Channel</label><select id="c-pick" name="pick"><option value="">Loading…</option></select></div>
    <div class="field" id="mail-to" hidden><label for="c-to">Recipients</label><input id="c-to" name="emailTo" type="email" value="${current.emailTo || app.me.email}"></div>
    <p class="small muted">Runs on your own connected account. Messages only inform — they never change tasks or approvals.</p>
    <div class="row end">${allowTest ? html`<button class="btn ghost" type="button" id="c-test">Send me a test</button>` : ''}<button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">${submitLabel}</button></div></form>`.toString(), (el, close) => {
    const $ = (s) => el.querySelector(s)
    const fillConn = () => { const list = $('#c-ch').value === 'slack' ? slack : gmail; $('#c-conn').innerHTML = list.map((c) => `<option value="${esc(c.id)}" ${current.connectionId === c.id ? 'selected' : ''}>${esc(c.label || $('#c-ch').value)}</option>`).join('') }
    const fillTargets = () => { $('#c-target').innerHTML = targets[$('#c-ch').value].map(([v, l]) => `<option value="${v}" ${current.target === v ? 'selected' : ''}>${esc(l)}</option>`).join(''); $('#t-wrap').hidden = targets[$('#c-ch').value].length < 2 }
    const fillPick = async () => {
      const ch = $('#c-ch').value; const t = $('#c-target').value
      $('#mail-to').hidden = !(ch === 'gmail' && t === 'recipients')
      $('#pick-wrap').hidden = ch !== 'slack'
      if (ch !== 'slack') return
      const dm = t === 'me'
      $('#c-pick-label').textContent = dm ? 'Which Slack user are you?' : 'Channel'
      $('#c-pick').innerHTML = '<option value="">Loading…</option>'
      try {
        const list = await api(`/api/viasocket/connections/${$('#c-conn').value}/${dm ? 'slack-users' : 'slack-channels'}`)
        const sel = dm ? current.slackUserId : current.slackChannelId
        $('#c-pick').innerHTML = list.map((o) => `<option value="${esc(o.value)}" ${sel === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('') || '<option value="">Nothing found</option>'
      } catch (e) { $('#c-pick').innerHTML = '<option value="">Could not load</option>'; $('.form-error').innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() }
    }
    const sync = () => { fillConn(); fillTargets(); fillPick() }
    $('#c-ch').addEventListener('change', sync); $('#c-conn').addEventListener('change', fillPick); $('#c-target').addEventListener('change', fillPick); sync()
    const read = () => {
      const ch = $('#c-ch').value; const t = $('#c-target').value; const pick = $('#c-pick').value
      return { channel: ch, connectionId: $('#c-conn').value, target: t, ...(ch === 'slack' ? (t === 'me' ? { slackUserId: pick, slackMode: 'user' } : { slackChannelId: pick, slackMode: 'channel' }) : {}), ...(t === 'recipients' ? { emailTo: $('#c-to').value.trim() } : {}) }
    }
    $('#c-test')?.addEventListener('click', async () => {
      const b = read()
      const where = b.channel === 'gmail' ? `an email to ${app.me.email}` : b.target === 'me' ? 'a Slack direct message to the user you picked' : `a message in ${$('#c-pick').selectedOptions[0]?.text || 'the channel'}`
      const ok = await confirmDialog({ title: 'Send a real test message?', body: `This sends ${where}, from your own ${b.channel === 'gmail' ? 'Gmail' : 'Slack'}, now.`, confirm: 'Send test' })
      if (!ok?.ok) return
      try { const out = await api('/api/automations/test-send', { method: 'POST', body: { ...b, target: b.channel === 'gmail' ? 'me' : b.target } }); toast(out.status === 'SUCCEEDED' ? out.summary : `Not confirmed: ${out.error}`, { error: out.status !== 'SUCCEEDED' }) } catch (e) { toast(errorText(e), { error: true }) }
    })
    bindForm($('#f'), () => onSubmit(read()), { onSuccess: () => close(true) })
  })
}

function renderReady(body, autos, conns, reload) {
  const canConfigure = autos.canConfigure
  body.innerHTML = html`
    <div class="notice">Your own notifications are in <a href="#/settings/profile">Settings → Profile</a>. ${canConfigure ? 'These are yours as a manager: each runs on your own connected account and covers only your teams.' : 'Managers set these up for their teams.'}</div>
    <div class="stack">${autos.automations.map((a) => html`<article class="card" id="auto-${a.key}"><div class="row between"><div><h3>${a.name}</h3><p class="small muted" style="max-width:75ch">${a.description}</p></div>
      ${a.key === 'gmail_slack_intake' ? '' : a.workflow ? html`<span class="badge ${STATUS_BADGE[a.workflow.status]}">${a.workflow.status.replace('_', ' ').toLowerCase()}</span>` : html`<span class="badge outline">Not set up</span>`}</div>
      ${a.workflow && a.key !== 'external_request_intake' ? html`<div class="small muted" style="margin-top:6px">${deliveryText(a.workflow.config)}${a.workflow.lastRunAt ? ` · last run ${ago(a.workflow.lastRunAt)}` : ''}</div>
        ${a.workflow.lastError ? html`<div class="notice err small" style="margin:8px 0 0">Last error: ${a.workflow.lastError}</div>` : ''}` : ''}
      ${a.othersRunning?.length ? html`<div class="small muted" style="margin-top:4px">Also set up by: ${a.othersRunning.map((o) => `${o.name} (${o.status.toLowerCase()})`).join(', ')}</div>` : ''}
      ${a.key === 'gmail_slack_intake' ? html`<div id="intakes" style="margin-top:10px">${canConfigure ? loading('Loading your intakes…') : ''}</div>` : ''}
      ${canConfigure && a.key !== 'gmail_slack_intake' ? html`<div class="row" style="margin-top:10px">
        ${a.key === 'external_request_intake' ? html`<button class="btn small" data-intake>${a.tokenIssued ? 'Rotate intake token' : 'Create intake token'}</button><button class="btn small ghost" data-config="${a.key}">Default team</button>` : html`<button class="btn small" data-config="${a.key}" ${!autos.viasocketConfigured ? raw('disabled title="ViaSocket is not configured"') : ''}>${a.workflow ? 'Change setup' : 'Set up'}</button>`}
        ${a.workflow && ['ACTIVE', 'FAILED'].includes(a.workflow.status) ? html`<button class="btn small ghost" data-status="${a.key}" data-to="PAUSED">Pause</button>` : ''}
        ${a.workflow && a.workflow.status === 'PAUSED' ? html`<button class="btn small ghost" data-status="${a.key}" data-to="ACTIVE">Resume</button>` : ''}
        ${a.key === 'weekly_team_report' ? html`<button class="btn small ghost" data-preview>Preview this week</button>` : ''}
      </div>` : ''}
      ${a.key === 'external_request_intake' && canConfigure ? html`<details style="margin-top:10px"><summary class="small">How to send requests</summary><div class="small" style="margin-top:6px">
        <p>Any system can post here with an HTTP step. Every request becomes a <b>pending task request</b> for manager approval — never an assigned task.</p>
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

  if (canConfigure) renderIntakes(body.querySelector('#intakes'), conns, autos.viasocketConfigured)
  body.querySelectorAll('[data-config]').forEach((b) => b.addEventListener('click', async () => {
    const a = autos.automations.find((x) => x.key === b.dataset.config)
    if (a.key === 'external_request_intake') {
      const teams = await api('/api/teams')
      return modal(html`<h2 id="modal-title">External requests: default team</h2><form id="f"><div class="form-error"></div><div class="field"><label for="x-t">Requests go to</label><select id="x-t" name="defaultTeamId"><option value="">(admins decide)</option>${teams.map((t) => html`<option value="${t.id}" ${a.workflow?.config.defaultTeamId === t.id ? raw('selected') : ''}>${t.name}</option>`)}</select></div>
        <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`.toString(), (el, close) => bindForm(el.querySelector('#f'), (d) => api(`/api/automations/${a.key}`, { method: 'PUT', body: { defaultTeamId: d.defaultTeamId || null } }), { onSuccess: () => { close(); toast('Saved.'); reload() } }))
    }
    const done = await deliveryForm({ title: a.name, conns, targets: DELIVERY_TARGETS[a.key], current: a.workflow?.config || {}, onSubmit: (body) => api(`/api/automations/${a.key}`, { method: 'PUT', body }) })
    if (done) { toast(`${a.name} is active.`); reload() }
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
    if (a.tokenIssued) { const r = await confirmDialog({ title: 'Rotate the intake token?', body: 'Systems using the old token stop working until you update them with the new one.', confirm: 'Rotate', danger: true }); if (!r?.ok) return }
    try {
      const { token } = await api('/api/automations/external_request_intake/token', { method: 'POST' })
      modal(html`<h2 id="modal-title">Intake token</h2><div class="notice warn">Copy it now — it is shown only once.</div><input type="text" readonly value="${token}" id="tok" class="mono" onclick="this.select()"><div class="row end" style="margin-top:12px"><button class="btn" data-close>Done</button></div>`.toString())
      reload()
    } catch (e) { toast(errorText(e), { error: true }) }
  })
  body.querySelector('[data-preview]')?.addEventListener('click', async () => {
    try { const { text } = await api('/api/automations/weekly_team_report/preview', { method: 'POST', body: {} }); modal(html`<h2 id="modal-title">Weekly report preview</h2><pre class="pre small" style="background:var(--surface-2);padding:12px;border-radius:8px">${text}</pre><div class="row end"><button class="btn" data-close>Close</button></div>`.toString()) } catch (e) { toast(errorText(e), { error: true }) }
  })
}

// C: the manager's Gmail / Slack intakes.
async function renderIntakes(box, conns, configured) {
  if (!box) return
  const draw = async () => {
    let list = []
    try { list = await api('/api/intakes') } catch (e) { box.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
    box.innerHTML = html`${list.length ? html`<ul class="list">${list.map((i) => html`<li><div class="grow"><b>${i.app === 'gmail' ? 'Gmail label' : 'Slack'} “${i.target}”</b> → ${i.teamName || 'admins'}
        <div class="small muted">${i.mine ? '' : `${i.ownerName} · `}${i.eventsReceived} message(s) received${i.lastEventAt ? `, last ${ago(i.lastEventAt)}` : ''}</div>${i.lastError ? html`<div class="small" style="color:var(--bad)">${i.lastError}</div>` : ''}</div>
        <span class="badge ${STATUS_BADGE[i.status] || 'outline'}">${i.status.toLowerCase()}</span>
        ${i.status === 'ACTIVE' ? html`<button class="btn small ghost" data-i="${i.id}" data-to="PAUSED">Pause</button>` : i.mine ? html`<button class="btn small ghost" data-i="${i.id}" data-to="ACTIVE">Resume</button>` : ''}
        ${i.mine ? html`<button class="btn small ghost" data-i="${i.id}" data-to="DELETED">Remove</button>` : ''}</li>`)}</ul>`
      : html`<p class="small muted">No intakes yet.</p>`}
      <div class="row" style="margin-top:8px"><button class="btn small" id="add-intake" ${!configured ? raw('disabled title="ViaSocket is not configured"') : ''}>Add Gmail or Slack intake</button></div>`.toString()
    box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.to === 'DELETED') { const r = await confirmDialog({ title: 'Remove this intake?', body: 'New messages stop becoming requests. Requests already created stay.', confirm: 'Remove', danger: true }); if (!r?.ok) return }
      try { await api(`/api/intakes/${b.dataset.i}/status`, { method: 'POST', body: { status: b.dataset.to } }); draw() } catch (e) { toast(errorText(e), { error: true }) }
    }))
    box.querySelector('#add-intake')?.addEventListener('click', () => addIntake(conns, draw))
  }
  draw()
}

async function addIntake(conns, done) {
  const g = conns.connections.filter((c) => c.app === 'gmail' && c.status !== 'missing')
  const s = conns.connections.filter((c) => c.app === 'slack' && c.status !== 'missing')
  if (!g.length && !s.length) return modal(html`<h2 id="modal-title">Connect Gmail or Slack first</h2><p>Intake listens on your own Gmail or Slack account.</p><div class="row end"><button class="btn ghost" data-close>Close</button><a class="btn" href="#/automations?tab=apps">Connect an app</a></div>`.toString(), (el, close) => el.querySelector('a').addEventListener('click', () => close()))
  const teams = (await api('/api/teams')).filter((t) => app.isAdmin || t.managedByMe)
  modal(html`<h2 id="modal-title">Gmail / Slack intake</h2><p class="small muted">Each new email with the label, or each new message in the channel, becomes a <b>pending</b> task request for your team. Nothing is assigned or approved automatically. Use a dedicated label or channel.</p>
    <form id="f"><div class="form-error"></div>
    <div class="field"><label for="i-app">Listen on</label><select id="i-app" name="app">${g.length ? html`<option value="gmail">Gmail (a label)</option>` : ''}${s.length ? html`<option value="slack">Slack (a channel)</option>` : ''}</select></div>
    <div class="field"><label for="i-conn">Your account</label><select id="i-conn" name="connectionId"></select></div>
    <div class="field"><label for="i-target" id="i-target-label">Label</label><select id="i-target" name="target"><option value="">Loading…</option></select><div class="hint" id="i-hint"></div></div>
    <div class="field"><label for="i-team">Requests go to</label><select id="i-team" name="teamId">${teams.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></div>
    <div id="i-preview"></div>
    <div class="row end"><button class="btn ghost" type="button" id="i-sample">Preview a real message</button><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Switch on</button></div></form>`.toString(), (el, close) => {
    const $ = (q) => el.querySelector(q)
    const fill = async () => {
      const isG = $('#i-app').value === 'gmail'
      $('#i-conn').innerHTML = (isG ? g : s).map((c) => `<option value="${esc(c.id)}">${esc(c.label || $('#i-app').value)}</option>`).join('')
      $('#i-target-label').textContent = isG ? 'Gmail label' : 'Slack channel'
      $('#i-hint').textContent = isG ? 'Create a label such as “TeamPulse” in Gmail and apply it to emails that should become requests.' : 'Use a channel only for requests — not one TeamPulse posts notifications or reports to.'
      await fillTargets()
    }
    const fillTargets = async () => {
      $('#i-target').innerHTML = '<option value="">Loading…</option>'
      try {
        const out = await api(`/api/intakes/targets?app=${$('#i-app').value}&connectionId=${encodeURIComponent($('#i-conn').value)}`)
        $('#i-target').innerHTML = out.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('') || '<option value="">Nothing found</option>'
        if (out.message) $('#i-hint').textContent = out.message
      } catch (e) { $('#i-target').innerHTML = '<option value="">Could not load</option>'; $('.form-error').innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() }
    }
    $('#i-app').addEventListener('change', fill); $('#i-conn').addEventListener('change', fillTargets); fill()
    const read = () => ({ app: $('#i-app').value, connectionId: $('#i-conn').value, target: $('#i-target').value, teamId: $('#i-team').value || undefined })
    $('#i-sample').addEventListener('click', async () => {
      $('#i-preview').innerHTML = loading('Reading a recent message…').toString()
      try {
        const out = await api('/api/intakes/sample', { method: 'POST', body: read() })
        $('#i-preview').innerHTML = out.found && out.preview?.title
          ? html`<div class="notice ok small"><b>A request would look like:</b><br>Title: ${out.preview.title}<br>From: ${out.preview.requester || '—'}${out.preview.ignore ? html`<br><i>This one would be ignored: ${out.preview.ignore}</i>` : ''}</div>`.toString()
          : html`<div class="notice warn small">No recent message found there yet. Send one, then preview again.</div>`.toString()
      } catch (e) { $('#i-preview').innerHTML = html`<div class="notice err small">${errorText(e)}</div>`.toString() }
    })
    bindForm($('#f'), () => api('/api/intakes', { method: 'POST', body: read() }), { onSuccess: () => { close(); toast('Intake is on. New messages become pending requests.'); done() } })
  })
}

// D: the restricted builder for one TeamPulse context, in a modal. Used by My Tasks, Reports and Team Tasks.
export async function openContextBuilder(context, appSlug) {
  let cfg
  try { cfg = await api(`/api/viasocket/context/${context}${appSlug ? `?app=${encodeURIComponent(appSlug)}` : ''}`) } catch (e) { toast(errorText(e), { error: true }); return }
  const names = { 'google-sheets': 'Google Sheets', slack: 'Slack', gmail: 'Gmail', 'google-calendar': 'Google Calendar', github: 'GitHub' }
  await modal(html`<h2 id="modal-title">Automate: ${cfg.label}</h2><p class="small muted">Pick an app (${Object.keys(cfg.serviceIds).map((s) => names[s] || s).join(', ')}) and publish. TeamPulse then sends your own events here.</p>
    <div id="ctx-box" style="height:560px;border:1px solid var(--border);border-radius:8px"><div class="loading">Loading…</div></div>
    <div class="row end" style="margin-top:10px"><button class="btn" data-close>Done</button></div>`.toString(), async (el) => {
    const dlg = document.getElementById('modal'); dlg.style.width = 'min(1100px, calc(100vw - 32px))'
    const listener = (event) => {
      if (event.origin !== EMBED_ORIGIN) return
      const flow = event.data
      if (flow?.id && ['published', 'updated', 'paused', 'deleted'].includes(flow.action)) api(`/api/viasocket/embed-flows/${encodeURIComponent(flow.id)}/sync`, { method: 'POST', body: { context, app: appSlug } }).then(() => toast(`Flow ${flow.action}.`)).catch(() => {})
    }
    window.addEventListener('message', listener)
    dlg.addEventListener('close', () => { window.removeEventListener('message', listener); dlg.style.width = '' }, { once: true })
    try {
      await loadScript(EMBED_SCRIPT)
      el.querySelector('#ctx-box').innerHTML = ''
      const embed = window.viaSocket.mount({ embedToken: cfg.token, parent: '#ctx-box', config: { pageheading: 'Automation', pagesubheading: cfg.label, filteredServices: cfg.filteredServices, showEnabled: false, hideWebhook: true, hideApi: true, hideFunction: true, themeJson: { '--primary-color': '#111111' } }, open: { dummy_payload: cfg.dummyPayload, meta: cfg.meta } })
      dlg.addEventListener('close', () => { try { embed.destroy?.() } catch { /* gone */ } }, { once: true })
    } catch (e) { el.querySelector('#ctx-box').innerHTML = html`<div class="notice err" style="margin:12px">${errorText(e)}</div>`.toString() }
  })
}

// ---------- 3. Advanced builder (full ViaSocket Embed) ----------
async function renderBuilder(body, conns, appSlug) {
  const flows = await api('/api/viasocket/embed-flows').catch(() => [])
  const focus = appSlug && conns.apps.find((a) => a.slug === appSlug)
  body.innerHTML = html`
    <p class="muted" style="margin-bottom:10px">${focus ? html`Building with <b>${focus.name}</b>. <a href="#/automations?tab=builder">Show all apps</a>` : 'Build your own automations across 2,300+ apps. Each person’s flows are their own.'}</p>
    ${conns.configured ? html`<div id="embed-box" aria-label="ViaSocket automation builder"><div class="loading">Loading the builder…</div></div>` : html`<div class="card">${empty('Builder unavailable', 'ViaSocket is not configured on this server.')}</div>`}
    ${flows.length ? html`<h2 style="margin:18px 0 8px">Your published flows</h2><ul class="list card">${flows.map((f) => html`<li><div class="grow"><b>${f.title || f.flowId}</b><div class="small muted">${f.context ? `${({ task_assigned_to_me: 'When a task is assigned to me', weekly_report_ready: 'When my weekly report is ready', task_completed_in_my_team: 'When a task in my team is completed' })[f.context] || f.context} · ` : ''}updated ${ago(f.updatedAt)}</div></div><span class="badge ${f.status === 'active' ? 'ok' : 'outline'}">${f.status}</span><button class="btn small ghost" data-runs="${f.flowId}" data-title="${f.title || f.flowId}">Runs</button></li>`)}</ul>` : ''}`
  body.querySelectorAll('[data-runs]').forEach((b) => b.addEventListener('click', async () => {
    modal(html`<h2 id="modal-title">Runs: ${b.dataset.title}</h2><div id="runs">${loading('Reading runs from ViaSocket…')}</div><div class="row end" style="margin-top:12px"><button class="btn" data-close>Close</button></div>`.toString(), async (el) => {
      try {
        const runs = await api(`/api/viasocket/embed-flows/${encodeURIComponent(b.dataset.runs)}/runs`)
        el.querySelector('#runs').innerHTML = runs.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Status</th><th>Error</th></tr></thead><tbody>${runs.map((r) => html`<tr><td class="nowrap">${r.at ? ago(r.at) : '—'}</td><td><span class="badge ${r.status === 'failed' ? 'bad' : /success|ok|complete/.test(r.status) ? 'ok' : 'outline'}">${r.status}</span></td><td class="small">${r.error || ''}</td></tr>`)}</tbody></table></div><p class="small muted">Last 30 days, from ViaSocket.</p>`.toString()
          : empty('No runs yet', 'Runs appear here once TeamPulse sends an event to this flow.').toString()
      } catch (e) { el.querySelector('#runs').innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() }
    })
  }))
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
      config: { pageheading: 'Automation', pagesubheading: 'Automate the work around your TeamPulse tasks.', showTemplates: true, themeJson: { '--primary-color': '#111111' } },
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

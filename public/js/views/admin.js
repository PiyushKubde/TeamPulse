// Admin console: set up and look after the organization. Everything here is configuration and status; the team's daily work (reviews, the
// workboard, people) is the manager's workspace, reached with the switch in the profile menu. Read-only status comes from /api/admin/system, which
// says only whether something is configured, never the secret.
import { api, html, icon, errorText, loading, d } from '../ui.js'
import { app } from '../app.js'

const flag = (on, yes = 'Set up', no = 'Not set up') => html`<span class="badge ${on ? 'ok' : 'outline'}">${on ? yes : no}</span>`
const MODE = { off: 'Off', supervised: 'Supervised (admins only, selected tasks)', on: 'Automatic (every submitted task)' }

export async function renderAdmin(main) {
  main.innerHTML = loading().toString()
  let s
  try { s = await api('/api/admin/system') } catch (e) {
    main.innerHTML = html`<div class="notice err" role="alert"><b>Could not load the admin overview.</b> ${errorText(e)} <button type="button" class="btn small ghost" id="ad-retry">Try again</button></div>`.toString()
    main.querySelector('#ad-retry')?.addEventListener('click', () => renderAdmin(main))
    return
  }
  if (!main.isConnected) return
  const { organization: o, ai, integrations: i, backup } = s
  const people = o.members.admin + o.members.manager + o.members.employee
  main.innerHTML = html`<div class="ov">
    <header class="wb-head"><div><h1>Admin overview</h1><p>Set up ${o.name} and keep it running. Daily team work lives in the Team workspace.</p></div>
      ${app.isManager ? html`<div class="row"><button class="btn ghost" id="ad-team">${icon('team')}Open Team workspace</button></div>` : ''}</header>
    ${app.isManager ? '' : html`<div class="notice" data-testid="ad-not-manager"><b>An admin runs the organization; a manager runs a team's work.</b> You do not see tasks, assessments or reviews of the people in a team unless you are assigned as that team's manager. To act as a manager, assign yourself (or another person) as the manager in <a href="#/settings/members">Users and teams</a>.</div>`}

    <section class="wi-sec" aria-labelledby="ad-org"><h2 id="ad-org">Organization and people</h2>
      <p class="muted" style="margin:10px 0 0" data-testid="ad-members"><b>${people}</b> active ${people === 1 ? 'person' : 'people'}: ${o.members.admin} admin${o.members.admin === 1 ? '' : 's'}, ${o.members.manager} manager${o.members.manager === 1 ? '' : 's'}, ${o.members.employee} employee${o.members.employee === 1 ? '' : 's'} · ${o.teams} team${o.teams === 1 ? '' : 's'}</p>
      <div class="row" style="margin-top:12px"><a class="btn small" href="#/settings/members">Users and teams</a><a class="btn small ghost" href="#/settings/permissions">Roles and permissions</a><a class="btn small ghost" href="#/settings/organization">Organization settings</a></div></section>

    <section class="wi-sec" aria-labelledby="ad-ai"><h2 id="ad-ai">AI assessment</h2>
      ${s.unassessedSubmitted ? html`<p class="small muted" style="margin:8px 0 0" data-testid="ad-backlog">${s.unassessedSubmitted} submitted task${s.unassessedSubmitted === 1 ? ' has' : 's have'} no assessment yet (submitted before AI was on, or while it was unavailable). Nothing is assessed in bulk automatically: the manager of each team starts it, when AI is on.</p>` : ''}
      <p style="margin:10px 0 6px" data-testid="ai-status">${ai.live ? html`<b>Real AI assessment is available.</b> ${ai.provider}${ai.model ? `, model ${ai.model}` : ''}.` : ai.simulated ? html`<b>Development simulator.</b> Assessments are simulated, never real AI.` : html`<b>AI assessment is off.</b> ${ai.reason || 'No provider is set up.'}`}</p>
      <dl class="kv"><dt>Mode</dt><dd>${MODE[ai.mode] || ai.mode}</dd><dt>Runs by itself on submit</dt><dd>${flag(ai.automatic, 'Yes', 'No')}</dd>${ai.requestedProvider === 'viasocket' ? html`<dt>viaSocket data policy approved</dt><dd>${flag(ai.policyConfirmed, 'Confirmed', 'Not confirmed')}</dd>` : ''}</dl>
      ${ai.live && ai.automatic ? html`<p class="small muted">Submitted tasks are assessed automatically. Tasks with too little evidence are answered by rules and never sent to the provider.</p>` : html`<h3 style="margin:14px 0 6px;font-size:var(--fs-base)">To turn it on</h3><ol class="small" data-testid="ai-steps" style="margin:0;padding-left:20px;display:grid;gap:6px">${ai.steps.map((x) => html`<li>${x}</li>`)}</ol>`}
      <p class="small muted" style="margin:12px 0 0">Until then the task workflow works as normal; submitted tasks show “Assessment unavailable” and nothing is estimated. Employee data is never sent anywhere without this approval.</p></section>

    <section class="wi-sec" aria-labelledby="ad-apps"><h2 id="ad-apps">Connected apps</h2>
      <ul class="ov-list"><li class="ov-row"><span class="grow">Google sign-in</span>${flag(i.google)}</li><li class="ov-row"><span class="grow">Email (password sign-in, invitations)</span>${flag(i.email)}</li><li class="ov-row"><span class="grow">viaSocket (apps and automations)</span>${flag(i.viasocket)}</li><li class="ov-row"><span class="grow">M91 (alert delivery)</span>${flag(i.m91)}</li></ul>
      <div class="row" style="margin-top:12px"><a class="btn small ghost" href="#/automations">Open Connected apps</a></div></section>

    <section class="wi-sec" aria-labelledby="ad-sys"><h2 id="ad-sys">Backups, alerts and audit</h2>
      <p class="muted" style="margin:10px 0 0">${backup ? html`Last backup <b>${d(backup.at)}</b> · off-host copy ${backup.offsite} · restore ${backup.restoreVerified ? 'verified' : 'not verified yet'}` : 'No backup has been recorded yet.'}</p>
      <div class="row" style="margin-top:12px"><a class="btn small ghost" href="#/settings/audit">Audit history</a><a class="btn small ghost" href="#/settings/alerts">Alert settings</a></div></section>
  </div>`.toString()
  main.querySelector('#ad-team')?.addEventListener('click', () => app.setMode('manager', '#/dashboard'))
}

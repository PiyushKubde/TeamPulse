import { api, html, raw, modal, bindForm, toast, errorText, ago, dt, empty, confirmDialog } from '../ui.js'
import { app, reloadSession } from '../app.js'

const TABS = () => [['profile', 'Profile'], ['organization', 'Organization', app.isManager], ['members', 'Teams & members', app.isManager], ['permissions', 'Employee permissions', app.isManager], ['alerts', 'Alert settings', app.isAdmin], ['audit', 'Audit history', app.isManager]].filter((t) => t[2] !== false)
const PERMS = [['can_create_tasks', 'Can create tasks', 'Without this, the employee can only suggest tasks.'], ['can_create_directly', 'Can create directly', 'Create official tasks without approval (needs approval to be off).'], ['approval_required', 'Approval required', 'New tasks go to you as requests first.'], ['can_self_assign', 'Can self-assign', 'Assign tasks to themselves.'], ['can_assign_others', 'Can assign others', 'Assign tasks to people in their own team.']]

export async function renderSettings(main, tab) {
  const tabs = TABS()
  if (!tabs.some(([k]) => k === tab)) tab = 'profile'
  main.innerHTML = html`<div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<a href="#/settings/${k}" ${k === tab ? raw('aria-current="page"') : ''}>${l}</a>`)}</div><div id="sb"></div>`
  const sb = main.querySelector('#sb')
  const reload = () => renderSettings(main, tab)
  await ({ profile, organization, members, permissions, alerts, audit })[tab](sb, reload)
}

async function profile(sb) {
  const s = app.session
  sb.innerHTML = html`<section class="card" style="max-width:640px"><dl class="kv"><dt>Name</dt><dd>${s.user.name}</dd><dt>Email</dt><dd>${s.user.email} ${s.user.emailVerified ? html`<span class="badge ok">verified by Google</span>` : ''}</dd>
    <dt>Organization</dt><dd>${s.membership.orgName}</dd><dt>Role</dt><dd style="text-transform:capitalize">${s.membership.role}</dd></dl>
    <p class="small muted" style="margin-top:8px">Name, email and picture come from your Google account and refresh each time you sign in.</p>
    <form id="pf" style="margin-top:14px"><div class="form-error"></div><div class="field"><label for="ph">Phone for urgent alerts (optional)</label><input id="ph" name="phone" type="tel" value="${s.user.phone || ''}" placeholder="+919876543210"><div class="hint">Used only for important alerts through M91 when your admin turns them on.</div></div><button class="btn" type="submit">Save</button></form>
    ${app.role === 'employee' ? html`<h3 style="margin:18px 0 8px">My task permissions</h3><ul class="list">${PERMS.map(([k, l]) => html`<li><span class="badge ${s.membership.permissions[k] ? 'ok' : 'outline'}">${s.membership.permissions[k] ? 'Yes' : 'No'}</span><div class="grow">${l}</div></li>`)}</ul>` : ''}</section>`
  bindForm(sb.querySelector('#pf'), (d) => api('/api/profile', { method: 'PATCH', body: { phone: d.phone || null } }), { onSuccess: (out) => {
    const M = { reachable: 'Saved. M91 can reach this phone.', invited: 'Saved. Accept the TeamPulse invitation in the M91 app to receive urgent alerts.', invite_failed: `Saved, but the M91 invitation failed: ${out.m91Error || ''}` }
    toast(M[out.m91] || 'Saved.'); reloadSession()
  } })
}

async function organization(sb, reload) {
  const org = await api('/api/organization')
  sb.innerHTML = html`<section class="card" style="max-width:640px">
    <form id="of"><div class="form-error"></div><div class="field"><label for="on">Organization name</label><input id="on" name="name" type="text" value="${org.name}" ${app.isAdmin ? '' : raw('disabled')} required minlength="2" maxlength="120"></div>${app.isAdmin ? html`<button class="btn" type="submit">Save</button>` : ''}</form>
    <h3 style="margin:18px 0 6px">Join code</h3><p class="small muted">People who sign in can ask to join with this code. Every request needs approval — the code alone grants nothing.</p>
    <div class="row"><input type="text" readonly value="${org.joinCode}" class="mono" style="max-width:220px" onclick="this.select()">${app.isAdmin ? html`<button class="btn small ghost" id="rot">Rotate code</button>` : ''}</div></section>`
  if (app.isAdmin) bindForm(sb.querySelector('#of'), (d) => api('/api/organization', { method: 'PATCH', body: d }), { onSuccess: () => { toast('Saved.'); reloadSession() } })
  sb.querySelector('#rot')?.addEventListener('click', async () => { const r = await confirmDialog({ title: 'Rotate the join code?', body: 'The old code stops working.', confirm: 'Rotate', danger: true }); if (r?.ok) { await api('/api/organization/join-code', { method: 'POST' }); reload() } })
}

async function members(sb, reload) {
  const [people, teams, invites, joins] = await Promise.all([api(`/api/members${app.isAdmin ? '?all=true' : ''}`), api('/api/teams'), api('/api/invitations'), api('/api/join-requests')])
  const teamOpts = (sel, only = null) => teams.filter((t) => !only || only.includes(t.id)).map((t) => html`<option value="${t.id}" ${t.id === sel ? raw('selected') : ''}>${t.name}</option>`)
  const myTeams = app.isAdmin ? null : app.session.membership.managedTeamIds
  sb.innerHTML = html`
    ${joins.length ? html`<section class="card" style="margin-bottom:16px"><h2 style="margin-bottom:8px">Requests to join (${joins.length})</h2><ul class="list">${joins.map((j) => html`<li><div class="grow"><b>${j.name}</b> <span class="small muted">${j.email}${j.emailVerified ? '' : ' (unverified email)'}</span>${j.message ? html`<div class="small">“${j.message}”</div>` : ''}<div class="small muted">${ago(j.createdAt)}</div></div>
      <button class="btn small" data-approve="${j.id}">Approve</button><button class="btn small ghost" data-reject="${j.id}">Decline</button></li>`)}</ul></section>` : ''}
    <div class="grid two">
      <section class="card"><div class="card-head"><h2>Invite someone</h2></div>
        <form id="inv"><div class="form-error"></div><div class="field"><label for="ie">Google account email</label><input id="ie" name="email" type="email" required></div>
          <div class="fields"><div class="field"><label for="ir">Role</label><select id="ir" name="role"><option value="employee">Employee</option>${app.isAdmin ? html`<option value="manager">Manager</option><option value="admin">Admin</option>` : ''}</select></div>
          <div class="field"><label for="it">Team</label><select id="it" name="teamId">${app.isAdmin ? html`<option value="">(none)</option>` : ''}${teamOpts(null, myTeams)}</select></div></div>
          <button class="btn" type="submit">Create invitation</button><p class="hint">Only that Google account can accept it. Share the link yourself.</p></form>
        ${invites.length ? html`<h3 style="margin:14px 0 6px">Pending invitations</h3><ul class="list">${invites.map((i) => html`<li><div class="grow">${i.email} <span class="small muted">· ${i.role}${i.teamName ? ` · ${i.teamName}` : ''} · ${i.expired ? 'expired' : `expires ${ago(i.expiresAt)}`}</span></div><button class="btn small ghost" data-revoke="${i.id}">Revoke</button></li>`)}</ul>` : ''}
      </section>
      <section class="card"><div class="card-head"><h2>Teams</h2>${app.isAdmin ? html`<button class="btn small" id="new-team">New team</button>` : ''}</div>
        ${teams.length ? html`<ul class="list">${teams.map((t) => html`<li><div class="grow"><b>${t.name}</b><div class="small muted">${t.managerName ? `Manager: ${t.managerName}` : 'No manager'} · ${t.memberCount} member(s)</div></div>${app.isAdmin ? html`<button class="btn small ghost" data-team="${t.id}">Edit</button><button class="btn small ghost" data-del-team="${t.id}" data-name="${t.name}">Delete</button>` : ''}</li>`)}</ul>` : empty('No teams', '')}
      </section>
    </div>
    <section class="card" style="margin-top:16px"><h2 style="margin-bottom:10px">Members</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Team</th><th class="hide-sm">Last sign-in</th><th>Status</th>${app.isAdmin ? html`<th></th>` : ''}</tr></thead><tbody>
      ${people.map((p) => html`<tr><td><b>${p.name}</b><div class="small muted">${p.email || ''}</div></td>
        <td>${app.isAdmin && p.userId !== app.me.id ? html`<select data-role="${p.userId}" aria-label="Role for ${p.name}">${['employee', 'manager', 'admin'].map((r) => html`<option value="${r}" ${p.role === r ? raw('selected') : ''}>${r}</option>`)}</select>` : html`<span style="text-transform:capitalize">${p.role}</span>`}</td>
        <td>${(app.isAdmin || (p.role === 'employee' && myTeams?.includes(p.teamId))) && p.inScope ? html`<select data-teamof="${p.userId}" aria-label="Team for ${p.name}">${app.isAdmin ? html`<option value="">(none)</option>` : ''}${teamOpts(p.teamId, myTeams)}</select>` : p.teamName || '—'}</td>
        <td class="hide-sm small">${p.lastLoginAt ? ago(p.lastLoginAt) : '—'}</td><td>${p.status === 'active' ? html`<span class="badge ok">Active</span>` : html`<span class="badge outline">Deactivated</span>`}</td>
        ${app.isAdmin ? html`<td>${p.userId !== app.me.id ? html`<button class="btn small ghost" data-active="${p.userId}" data-to="${p.status === 'active' ? 'deactivated' : 'active'}" data-name="${p.name}">${p.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>` : ''}</tr>`)}
    </tbody></table></div></section>`

  const act = async (fn, msg) => { try { await fn(); toast(msg); reload() } catch (e) { toast(errorText(e), { error: true }); reload() } }
  bindForm(sb.querySelector('#inv'), (d) => api('/api/invitations', { method: 'POST', body: d }), { onSuccess: (out) => {
    modal(html`<h2 id="modal-title">Invitation created</h2><p>Send this link to <b>${out.email}</b>. It works only for that Google account and expires in 14 days.</p><input type="text" readonly value="${out.link}" onclick="this.select()" class="mono"><div class="row end" style="margin-top:12px"><button class="btn ghost" id="copy">Copy link</button><button class="btn" data-close>Done</button></div>`.toString(), (el) => el.querySelector('#copy').addEventListener('click', () => navigator.clipboard?.writeText(out.link).then(() => toast('Copied.'))))
    reload()
  } })
  sb.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => { const r = await confirmDialog({ title: 'Revoke invitation?', body: 'The link stops working.', confirm: 'Revoke', danger: true }); if (r?.ok) act(() => api(`/api/invitations/${b.dataset.revoke}`, { method: 'DELETE' }), 'Revoked.') }))
  sb.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => {
    modal(html`<h2 id="modal-title">Approve join request</h2><form id="f"><div class="form-error"></div><div class="fields"><div class="field"><label for="jr">Role</label><select id="jr" name="role"><option value="employee">Employee</option>${app.isAdmin ? html`<option value="manager">Manager</option><option value="admin">Admin</option>` : ''}</select></div>
      <div class="field"><label for="jt">Team</label><select id="jt" name="teamId">${teamOpts(null, myTeams)}</select></div></div><div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Approve</button></div></form>`.toString(), (el, close) =>
      bindForm(el.querySelector('#f'), (d) => api(`/api/join-requests/${b.dataset.approve}/decision`, { method: 'POST', body: { decision: 'approve', ...d } }), { onSuccess: () => { close(); toast('Approved.'); reload() } }))
  }))
  sb.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => { const r = await confirmDialog({ title: 'Decline this request?', body: 'They will not get access.', confirm: 'Decline', danger: true }); if (r?.ok) act(() => api(`/api/join-requests/${b.dataset.reject}/decision`, { method: 'POST', body: { decision: 'reject' } }), 'Declined.') }))
  sb.querySelectorAll('[data-role]').forEach((s) => s.addEventListener('change', async () => {
    const r = await confirmDialog({ title: `Change role to ${s.value}?`, body: 'Roles control what this person can see and do. The change is audited.', confirm: 'Change role' })
    if (r?.ok) act(() => api(`/api/members/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }), 'Role updated.'); else reload()
  }))
  sb.querySelectorAll('[data-teamof]').forEach((s) => s.addEventListener('change', () => act(() => api(`/api/members/${s.dataset.teamof}`, { method: 'PATCH', body: { teamId: s.value || null } }), 'Team updated.')))
  sb.querySelectorAll('[data-active]').forEach((b) => b.addEventListener('click', async () => {
    const off = b.dataset.to === 'deactivated'
    const r = await confirmDialog({ title: `${off ? 'Deactivate' : 'Reactivate'} ${b.dataset.name}?`, body: off ? 'They are signed out and lose access. Their tasks and history stay.' : 'They regain access with their current role.', confirm: off ? 'Deactivate' : 'Reactivate', danger: off })
    if (r?.ok) act(() => api(`/api/members/${b.dataset.active}`, { method: 'PATCH', body: { status: b.dataset.to } }), 'Updated.')
  }))
  const teamForm = (t = {}) => modal(html`<h2 id="modal-title">${t.id ? 'Edit team' : 'New team'}</h2><form id="f"><div class="form-error"></div><div class="field"><label for="tn">Name</label><input id="tn" name="name" type="text" required maxlength="80" value="${t.name || ''}"></div>
    <div class="field"><label for="tm">Manager</label><select id="tm" name="managerId"><option value="">(none)</option>${people.filter((p) => ['manager', 'admin'].includes(p.role) && p.status === 'active').map((p) => html`<option value="${p.userId}" ${t.managerId === p.userId ? raw('selected') : ''}>${p.name}</option>`)}</select></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`.toString(), (el, close) =>
    bindForm(el.querySelector('#f'), (d) => api(t.id ? `/api/teams/${t.id}` : '/api/teams', { method: t.id ? 'PATCH' : 'POST', body: { name: d.name, managerId: d.managerId || null } }), { onSuccess: () => { close(); toast('Saved.'); reloadSession() } }))
  sb.querySelector('#new-team')?.addEventListener('click', () => teamForm())
  sb.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', () => teamForm(teams.find((t) => t.id === b.dataset.team))))
  sb.querySelectorAll('[data-del-team]').forEach((b) => b.addEventListener('click', async () => { const r = await confirmDialog({ title: `Delete team ${b.dataset.name}?`, body: 'Only empty teams can be deleted.', confirm: 'Delete', danger: true }); if (r?.ok) act(() => api(`/api/teams/${b.dataset.delTeam}`, { method: 'DELETE' }), 'Team deleted.') }))
}

async function permissions(sb, reload) {
  const [list, audit] = await Promise.all([api('/api/permissions'), api('/api/audit?entityType=employee_permissions')])
  sb.innerHTML = html`<p class="muted" style="max-width:80ch">Decide, per employee, how they can create and assign work. Creating tasks never implies assigning them; self-assignment and assigning others are separate. Every change is recorded.</p>
    ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Employee</th>${PERMS.map(([, l, h]) => html`<th title="${h}">${l}</th>`)}<th>Effect</th></tr></thead><tbody>
      ${list.map((e) => html`<tr><td><b>${e.name}</b><div class="small muted">${e.teamName || ''}</div></td>${PERMS.map(([k, l]) => html`<td><input type="checkbox" aria-label="${l} for ${e.name}" data-user="${e.userId}" data-perm="${k}" ${e.permissions[k] ? raw('checked') : ''}></td>`)}
        <td class="small">${e.permissions.can_create_tasks && e.permissions.can_create_directly && !e.permissions.approval_required ? 'Creates tasks directly' : 'Suggests tasks for approval'}</td></tr>`)}</tbody></table></div>`
      : html`<div class="card">${empty('No employees in your teams', 'Invite people from Teams & members.')}</div>`}
    <h2 style="margin:20px 0 8px">Permission history</h2>
    ${audit.length ? html`<ul class="list card">${audit.slice(0, 30).map((a) => html`<li><div class="grow small"><b>${a.actor}</b> changed ${(list.find((x) => x.userId === a.entityId)?.name) || 'an employee'}: ${Object.entries(a.after || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} → ${v ? 'yes' : 'no'}`).join(', ')}</div><span class="small muted nowrap">${dt(a.createdAt)}</span></li>`)}</ul>` : html`<p class="muted small">No changes yet.</p>`}`
  sb.querySelectorAll('[data-perm]').forEach((c) => c.addEventListener('change', async () => {
    try { const out = await api(`/api/permissions/${c.dataset.user}`, { method: 'PATCH', body: { [c.dataset.perm]: c.checked } }); toast(out.changed.length ? 'Permission updated.' : 'No change.'); reload() } catch (e) { toast(errorText(e), { error: true }); reload() }
  }))
}

async function alerts(sb, reload) {
  const s = await api('/api/alerts/settings')
  const TH = { unassignedHours: 'Unassigned task', notStartedHours: 'Assigned but not started', noProgressHours: 'No meaningful progress', deadlineApproachingHours: 'Deadline approaching (hours before)', blockerUnresolvedHours: 'Blocker unresolved' }
  sb.innerHTML = html`<div class="notice ${s.m91.state === 'ready' ? 'ok' : 'warn'}"><b>M91 status:</b> ${s.m91.message}</div>
    <form id="af" class="stack" style="max-width:820px"><div class="form-error"></div>
    <section class="card"><h2 style="margin-bottom:8px">M91 alerts</h2><label class="check"><input type="checkbox" name="m91Enabled" ${s.m91Enabled ? raw('checked') : ''}> Send important alerts through M91 (in addition to in-app notifications)</label>
      <p class="small muted">Use M91 for important human attention only. In-app notifications are always sent and are the fallback when M91 is off or fails.</p>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Alert</th><th>Recipients</th><th>Also via M91</th></tr></thead><tbody>
        ${s.rules.map((r) => html`<tr><td>${r.label}</td><td class="small">${r.recipients.join(' + ')}</td><td><input type="checkbox" data-rule="${r.key}" aria-label="M91 for ${r.label}" ${r.m91 ? raw('checked') : ''}></td></tr>`)}</tbody></table></div></section>
    <section class="card"><h2 style="margin-bottom:8px">Thresholds (hours)</h2><div class="fields">${Object.entries(TH).map(([k, l]) => html`<div class="field"><label for="th-${k}">${l}</label><input id="th-${k}" type="number" min="${s.limits[k][0]}" max="${s.limits[k][1]}" step="0.5" data-th="${k}" value="${s.thresholds[k]}"></div>`)}</div>
      <p class="small muted">Deadline missed alerts fire as soon as the deadline passes. Checks run every 15 minutes.</p></section>
    <div><button class="btn" type="submit">Save alert settings</button></div></form>`
  sb.querySelector('#af').addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = { m91Enabled: e.target.m91Enabled.checked, thresholds: {}, rules: {} }
    sb.querySelectorAll('[data-th]').forEach((i) => { body.thresholds[i.dataset.th] = Number(i.value) })
    sb.querySelectorAll('[data-rule]').forEach((i) => { body.rules[i.dataset.rule] = { m91: i.checked } })
    try { await api('/api/alerts/settings', { method: 'PATCH', body }); toast('Alert settings saved.'); reload() } catch (err) { sb.querySelector('.form-error').innerHTML = html`<div class="notice err">${errorText(err)}</div>`.toString() }
  })
}

async function audit(sb) {
  const rows = await api('/api/audit')
  sb.innerHTML = html`<p class="muted">${app.isAdmin ? 'Sensitive changes across the organization.' : 'Permission changes in your teams.'}</p>
    ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Change</th></tr></thead><tbody>${rows.map((a) => html`<tr><td class="nowrap small">${dt(a.createdAt)}</td><td>${a.actor || 'System'}</td><td class="mono">${a.action}</td><td class="small mono" style="max-width:420px;word-break:break-word">${a.before ? `${JSON.stringify(a.before)} → ` : ''}${a.after ? JSON.stringify(a.after) : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="card">${empty('Nothing recorded yet', '')}</div>`}`
}

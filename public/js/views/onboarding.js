import { api, html, raw, bindForm, toast, errorText } from '../ui.js'
import { reloadSession } from '../app.js'

const LOGO = raw(`<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#4338ca"/><path d="M5 17h6l3-7 4 13 3-6h6" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`)
const GOOGLE = raw(`<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`)

export function renderLogin(root, q) {
  const s = window.__session || null
  void s
  root.innerHTML = html`<div class="auth"><div class="panel card" style="padding:28px">
    <div class="brand">${LOGO}<span>TeamPulse</span></div>
    <h1>Work that matters, made visible</h1>
    <p class="muted">Tasks, blockers and the outcomes behind them — for teams that value impact over task counts.</p>
    <div class="pillars"><div>✓ See what everyone is working on and where they need help</div><div>✓ Approve suggestions, review completed work</div><div>✓ Record verified outcomes, not just ticked boxes</div></div>
    ${q.get('error') ? html`<div class="notice err" role="alert">${q.get('error')}</div>` : ''}
    <div id="login-actions"><div class="loading">Checking sign-in options…</div></div>
  </div></div>`
  api('/api/session').then((sess) => {
    const box = document.getElementById('login-actions')
    const invite = sessionStorage.getItem('tp_invite')
    const href = `/auth/google${invite ? `?returnTo=${encodeURIComponent(`#/invite/${invite}`)}` : ''}`
    box.innerHTML = html`
      ${sess.googleConfigured ? html`<a class="btn google" style="width:100%" href="${href}">${GOOGLE} Continue with Google</a>`
        : html`<div class="notice warn">Google sign-in is not configured on this server yet. An administrator must set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI (see README).</div>`}
      ${sess.devLogin ? html`<details style="margin-top:16px"><summary class="small muted">Local development sign-in</summary>
        <form id="dev-login" class="stack" style="margin-top:10px"><div class="form-error"></div>
          <div><label for="dev-email">Email</label><input id="dev-email" name="email" type="email" required placeholder="you@example.com"></div>
          <div><label for="dev-name">Name</label><input id="dev-name" name="name" type="text" placeholder="Your name"></div>
          <button class="btn ghost" type="submit">Sign in (development only)</button></form></details>` : ''}
      <p class="small muted" style="margin-top:16px">New here? Sign in first, then create your organization, accept an invitation, or ask to join with a code.</p>`.toString()
    const f = document.getElementById('dev-login')
    if (f) bindForm(f, (d) => api('/auth/dev-login', { method: 'POST', body: d }), { onSuccess: () => reloadSession() })
  }).catch((e) => { document.getElementById('login-actions').innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() })
}

export async function renderWelcome(root) {
  const invite = sessionStorage.getItem('tp_invite')
  const [sess, ob] = await Promise.all([api('/api/session'), api(`/api/onboarding${invite ? `?inviteToken=${encodeURIComponent(invite)}` : ''}`)])
  if (sess.deactivated) {
    root.innerHTML = html`<div class="auth"><div class="panel card" style="padding:28px"><h1>Account deactivated</h1><p>Your access to this organization was turned off by an admin. Contact them if this is a mistake.</p><button class="btn ghost" id="out">Sign out</button></div></div>`
    document.getElementById('out').onclick = async () => { await api('/api/session/logout', { method: 'POST' }); location.hash = '#/login'; reloadSession() }
    return
  }
  const jr = ob.joinRequest
  root.innerHTML = html`<div class="auth"><div class="panel" style="width:min(560px,100%)"><div class="card" style="padding:28px">
    <div class="brand">${LOGO}<span>TeamPulse</span></div>
    <h1>Welcome, ${sess.user.name}</h1>
    <p class="muted">Signed in as ${sess.user.email}${sess.user.emailVerified ? '' : ' (email not verified by Google)'}. Join your team’s organization to continue.</p>
    ${ob.invitations.length ? html`<h2 style="margin:18px 0 8px">Invitations</h2><ul class="list">${ob.invitations.map((i) => html`<li><div class="grow"><b>${i.orgName}</b><div class="small muted">as ${i.role} · sent to ${i.email}</div>
        ${i.emailMatches ? '' : html`<div class="small" style="color:var(--bad)">This invitation is for ${i.email}. Sign in with that Google account to accept it.</div>`}</div>
        ${i.emailMatches ? html`<button class="btn small" data-accept="${i.id}">Accept</button>` : ''}</li>`)}</ul>` : ''}
    ${jr?.status === 'pending' ? html`<div class="notice" style="margin-top:16px">Your request to join <b>${jr.orgName}</b> is waiting for a manager or admin to approve it. <button class="btn link" id="withdraw">Withdraw request</button></div>` : html`
      ${jr?.status === 'rejected' ? html`<div class="notice warn" style="margin-top:16px">Your request to join ${jr.orgName} was not approved.</div>` : ''}
      <h2 style="margin:18px 0 8px">Join with a code</h2>
      <form id="join" class="stack"><div class="form-error"></div>
        <div><label for="code">Organization join code</label><input id="code" name="joinCode" type="text" required maxlength="20" autocomplete="off" placeholder="e.g. 7F3A9C21B0"><div class="hint">Ask your manager for it. A manager or admin approves every request.</div></div>
        <div><label for="msg">Message (optional)</label><input id="msg" name="message" type="text" maxlength="500" placeholder="Hi, I joined the Platform team"></div>
        <button class="btn" type="submit">Request to join</button></form>
      ${ob.allowOrgCreation ? html`<h2 style="margin:22px 0 8px">Or create a new organization</h2>
      <form id="create" class="stack"><div class="form-error"></div>
        <div><label for="org">Organization name</label><input id="org" name="name" type="text" required minlength="2" maxlength="120"></div>
        <div><label for="team">First team</label><input id="team" name="teamName" type="text" maxlength="80" placeholder="General"></div>
        <button class="btn ghost" type="submit">Create organization (you become its admin)</button></form>` : ''}`}
    <p style="margin-top:18px"><button class="btn link" id="out">Sign out</button></p>
  </div></div></div>`
  root.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true
    try { await api(`/api/invitations/${b.dataset.accept}/accept`, { method: 'POST' }); sessionStorage.removeItem('tp_invite'); toast('Welcome aboard!'); location.hash = '#/dashboard'; reloadSession() } catch (e) { toast(errorText(e), { error: true }); b.disabled = false }
  }))
  const join = document.getElementById('join')
  if (join) bindForm(join, (d) => api('/api/join-requests', { method: 'POST', body: d }), { onSuccess: () => { toast('Request sent.'); renderWelcome(root) } })
  const create = document.getElementById('create')
  if (create) bindForm(create, (d) => api('/api/organizations', { method: 'POST', body: d }), { onSuccess: () => { location.hash = '#/settings/members'; reloadSession() } })
  document.getElementById('withdraw')?.addEventListener('click', async () => { await api('/api/join-requests/mine', { method: 'DELETE' }); renderWelcome(root) })
  document.getElementById('out').onclick = async () => { await api('/api/session/logout', { method: 'POST' }); location.hash = '#/login'; reloadSession() }
}

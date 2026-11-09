import { api, html, raw, bindForm, toast, errorText } from '../ui.js'
import { reloadSession, navigate } from '../app.js'

const LOGO = raw(`<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#4338ca"/><path d="M5 17h6l3-7 4 13 3-6h6" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`)
const GOOGLE = raw(`<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`)

const POLICY_HINT = 'At least 12 characters, using at least three of: lowercase, uppercase, numbers, symbols (or 20+ characters of any kind). Avoid your name, your email and common passwords.'

function authCard(inner) {
  return html`<div class="auth"><div class="panel card" style="padding:28px">
    <div class="brand">${LOGO}<span>TeamPulse</span></div>${inner}</div></div>`
}
const googleHref = () => { const invite = sessionStorage.getItem('tp_invite'); return `/auth/google${invite ? `?returnTo=${encodeURIComponent(`#/invite/${invite}`)}` : ''}` }
const googleButton = (sess) => sess.googleConfigured ? html`<a class="btn google" style="width:100%" href="${googleHref()}">${GOOGLE} Continue with Google</a>`
  : html`<div class="notice warn"><b>Google sign-in is not set up yet.</b> An administrator must add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to this app’s settings${sess.googleCallbackUrl ? html`, and register this redirect URI in the Google OAuth client: <span class="mono" style="word-break:break-all">${sess.googleCallbackUrl}</span>` : ''}.</div>`
const divider = html`<div class="divider" role="separator"><span>or</span></div>`
const emailOff = html`<div class="notice">Email and password sign-in is not available on this server yet (no email provider is configured). Use Continue with Google.</div>`
const sentNotice = (msg) => html`<div class="notice ok" role="status">${msg}</div>`

export function renderLogin(root, q) {
  root.innerHTML = authCard(html`
    <h1>Work that matters, made visible</h1>
    <p class="muted">Tasks, blockers and the outcomes behind them — for teams that value impact over task counts.</p>
    <div class="pillars"><div>✓ See what everyone is working on and where they need help</div><div>✓ Approve suggestions, review completed work</div><div>✓ Record verified outcomes, not just ticked boxes</div></div>
    ${q.get('error') ? html`<div class="notice err" role="alert">${q.get('error')}</div>` : ''}
    ${q.get('notice') ? sentNotice(q.get('notice')) : ''}
    <div id="login-actions"><div class="loading">Checking sign-in options…</div></div>`)
  api('/api/session').then((sess) => {
    const box = document.getElementById('login-actions')
    const email = sess.emailAuth?.available
    box.innerHTML = html`
      ${googleButton(sess)}
      ${divider}
      ${email ? html`<form id="pw-login" class="stack" novalidate><div class="form-error"></div>
          <div><label for="li-email">Email</label><input id="li-email" name="email" type="email" required autocomplete="username" maxlength="254"></div>
          <div><label for="li-pw">Password</label><input id="li-pw" name="password" type="password" required autocomplete="current-password" maxlength="128"></div>
          <button class="btn" type="submit">Sign in</button>
        </form>
        <div class="row" style="justify-content:space-between;margin-top:10px"><a href="#/forgot">Forgot password?</a><a href="#/signup">Create account</a></div>` : emailOff}
      ${sess.devLogin ? html`<details style="margin-top:16px"><summary class="small muted">Local development sign-in</summary>
        <form id="dev-login" class="stack" style="margin-top:10px"><div class="form-error"></div>
          <div><label for="dev-email">Email</label><input id="dev-email" name="email" type="email" required placeholder="you@example.com"></div>
          <div><label for="dev-name">Name</label><input id="dev-name" name="name" type="text" placeholder="Your name"></div>
          <button class="btn ghost" type="submit">Sign in (development only)</button></form></details>` : ''}
      <p class="small muted" style="margin-top:16px">After signing in, create your organization, accept an invitation, or ask to join with a code.</p>`.toString()
    const pl = document.getElementById('pw-login')
    if (pl) bindForm(pl, (d) => api('/auth/login', { method: 'POST', body: d }), { onSuccess: () => { navigate(sessionStorage.getItem('tp_invite') ? `#/invite/${sessionStorage.getItem('tp_invite')}` : '#/dashboard') } })
    const f = document.getElementById('dev-login')
    if (f) bindForm(f, (d) => api('/auth/dev-login', { method: 'POST', body: d }), { onSuccess: () => reloadSession() })
  }).catch((e) => { document.getElementById('login-actions').innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() })
}

export async function renderSignup(root) {
  const sess = await api('/api/session')
  root.innerHTML = authCard(html`
    <h1>Create your account</h1>
    <p class="muted">You’ll confirm your email before you can sign in. Then create your organization, accept an invitation, or ask to join one.</p>
    ${googleButton(sess)}
    ${divider}
    <div id="su-box">${sess.emailAuth?.available ? html`<form id="su" class="stack" novalidate><div class="form-error"></div>
        <div><label for="su-name">Full name</label><input id="su-name" name="name" type="text" required maxlength="120" autocomplete="name"></div>
        <div><label for="su-email">Email</label><input id="su-email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
        <div><label for="su-pw">Password</label><input id="su-pw" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" aria-describedby="su-pw-hint"><div class="hint" id="su-pw-hint">${POLICY_HINT}</div></div>
        <div><label for="su-pw2">Confirm password</label><input id="su-pw2" name="confirmPassword" type="password" required maxlength="128" autocomplete="new-password"></div>
        <label class="check"><input type="checkbox" name="acceptTerms" value="true" required> <span>I agree to the ${sess.legal?.termsUrl ? html`<a href="${sess.legal.termsUrl}" target="_blank" rel="noopener">terms of use</a>` : 'terms of use'} and ${sess.legal?.privacyUrl ? html`<a href="${sess.legal.privacyUrl}" target="_blank" rel="noopener">privacy policy</a>` : 'privacy policy'}</span></label>
        <button class="btn" type="submit">Create account</button>
      </form>` : emailOff}</div>
    <p style="margin-top:14px">Already have an account? <a href="#/login">Sign in</a></p>`)
  const f = document.getElementById('su')
  if (f) bindForm(f, (d) => api('/auth/register', { method: 'POST', body: { ...d, acceptTerms: f.acceptTerms.checked } }), { onSuccess: (out) => {
    const email = f.email.value
    document.getElementById('su-box').innerHTML = html`${sentNotice(out.message)}<p class="small muted">The link is valid for 24 hours. Didn’t get it? <button class="btn link" id="resend">Send it again</button></p>`.toString()
    document.getElementById('resend').onclick = async (e) => { e.target.disabled = true; try { const r = await api('/auth/email/resend', { method: 'POST', body: { email } }); toast(r.message) } catch (err) { toast(errorText(err), { error: true }) } }
  } })
}

export async function renderForgot(root) {
  const sess = await api('/api/session')
  root.innerHTML = authCard(html`
    <h1>Reset your password</h1>
    <div id="fg-box">${sess.emailAuth?.available ? html`<p class="muted">Enter your account email. If it can be used, we’ll send a link to choose a new password (valid for 30 minutes).</p>
      <form id="fg" class="stack" novalidate><div class="form-error"></div>
        <div><label for="fg-email">Email</label><input id="fg-email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
        <button class="btn" type="submit">Send reset link</button></form>` : emailOff}</div>
    <p style="margin-top:14px"><a href="#/login">Back to sign in</a></p>`)
  const f = document.getElementById('fg')
  if (f) bindForm(f, (d) => api('/auth/password/forgot', { method: 'POST', body: d }), { onSuccess: (out) => { document.getElementById('fg-box').innerHTML = sentNotice(out.message).toString() } })
}

export async function renderReset(root, token) {
  root.innerHTML = authCard(html`<h1>Choose a password</h1><div id="rs-box"><div class="loading">Checking your link…</div></div>`)
  const box = document.getElementById('rs-box')
  let info
  try { info = await api('/auth/password/check', { method: 'POST', body: { token } }) } catch (e) { box.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
  if (info.state !== 'valid') {
    box.innerHTML = html`<div class="notice err" role="alert">${info.state === 'expired' ? 'This link has expired.' : 'This link is not valid or was already used.'}</div>
      <p><a href="#/forgot">Ask for a new link</a> · <a href="#/login">Sign in</a></p>`.toString()
    return
  }
  const adding = info.purpose === 'link_password'
  box.innerHTML = html`<p class="muted">${adding ? 'Set a password so you can also sign in with your email. Google sign-in keeps working.' : 'Choose a new password. You’ll be signed out everywhere else.'}</p>
    <form id="rs" class="stack" novalidate><div class="form-error"></div>
      <div><label for="rs-pw">New password</label><input id="rs-pw" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" aria-describedby="rs-hint"><div class="hint" id="rs-hint">${POLICY_HINT}</div></div>
      <div><label for="rs-pw2">Confirm password</label><input id="rs-pw2" name="confirmPassword" type="password" required maxlength="128" autocomplete="new-password"></div>
      <button class="btn" type="submit">${adding ? 'Add password' : 'Set new password'}</button></form>`.toString()
  bindForm(document.getElementById('rs'), (d) => api('/auth/password/reset', { method: 'POST', body: { ...d, token } }), { onSuccess: () => { toast(adding ? 'Password added.' : 'Password changed.'); navigate('#/dashboard', { replace: true }) } })
}

export async function renderVerify(root, token) {
  // A form (not an automatic request) so link scanners can't use the link, and the password proves it is the same
  // person who signed up — nobody can get an account they registered for someone else's email confirmed.
  root.innerHTML = authCard(html`<h1>Confirm your email</h1><div id="vf-box">
    <p class="muted">Enter the password you chose when you created your account.</p>
    <form id="vf" class="stack" novalidate><div class="form-error"></div>
      <div><label for="vf-pw">Password</label><input id="vf-pw" name="password" type="password" required maxlength="128" autocomplete="current-password"></div>
      <button class="btn" type="submit">Confirm email and sign in</button></form>
    <p class="small muted" style="margin-top:12px">Didn’t create a TeamPulse account? Ignore this, or <a href="#/signup">create one with your own password</a>.</p></div>`)
  bindForm(document.getElementById('vf'), (d) => api('/auth/email/verify', { method: 'POST', body: { token, password: d.password } }), {
    onSuccess: () => { toast('Email confirmed. Welcome!'); navigate('#/dashboard', { replace: true }) }
  })
}

export async function renderWelcome(root) {
  const invite = sessionStorage.getItem('tp_invite')
  const [sess, ob] = await Promise.all([api('/api/session'), api(`/api/onboarding${invite ? `?inviteToken=${encodeURIComponent(invite)}` : ''}`)])
  if (sess.deactivated) {
    root.innerHTML = html`<div class="auth"><div class="panel card" style="padding:28px"><h1>Account deactivated</h1><p>Your access to this organization was turned off by an admin. Contact them if this is a mistake.</p><button class="btn ghost" id="out">Sign out</button></div></div>`
    document.getElementById('out').onclick = async () => { await api('/api/session/logout', { method: 'POST' }); navigate('#/login') }
    return
  }
  const jr = ob.joinRequest
  root.innerHTML = html`<div class="auth"><div class="panel" style="width:min(560px,100%)"><div class="card" style="padding:28px">
    <div class="brand">${LOGO}<span>TeamPulse</span></div>
    <h1>Welcome, ${sess.user.name}</h1>
    <p class="muted">Signed in as ${sess.user.email}${sess.user.emailVerified ? '' : ' (email not verified)'}. Join your team’s organization to continue.</p>
    ${ob.invitations.length ? html`<h2 style="margin:18px 0 8px">Invitations</h2><ul class="list">${ob.invitations.map((i) => html`<li><div class="grow"><b>${i.orgName}</b><div class="small muted">as ${i.role} · sent to ${i.email}</div>
        ${i.emailMatches ? '' : html`<div class="small" style="color:var(--bad)">This invitation is for ${i.email}. Sign in with that email (or its Google account) to accept it.</div>`}</div>
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
    try { await api(`/api/invitations/${b.dataset.accept}/accept`, { method: 'POST' }); sessionStorage.removeItem('tp_invite'); toast('Welcome aboard!'); navigate('#/dashboard') } catch (e) { toast(errorText(e), { error: true }); b.disabled = false }
  }))
  const join = document.getElementById('join')
  if (join) bindForm(join, (d) => api('/api/join-requests', { method: 'POST', body: d }), { onSuccess: () => { toast('Request sent.'); renderWelcome(root) } })
  const create = document.getElementById('create')
  if (create) bindForm(create, (d) => api('/api/organizations', { method: 'POST', body: d }), { onSuccess: () => { navigate('#/settings/members') } })
  document.getElementById('withdraw')?.addEventListener('click', async () => { await api('/api/join-requests/mine', { method: 'DELETE' }); renderWelcome(root) })
  document.getElementById('out').onclick = async () => { await api('/api/session/logout', { method: 'POST' }); navigate('#/login') }
}

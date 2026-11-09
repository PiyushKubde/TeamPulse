// Email/password authentication. Delivery uses a CAPTURING mailer (simulated): it proves the flows and the links,
// not that a real provider delivered anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { startApp, seedOrg, makeUser } from './helpers.js'

function capture() {
  const m = { configured: true, provider: 'capture', sent: [] }
  m.send = async (msg) => { m.sent.push(msg); return { providerId: `cap-${m.sent.length}` } }
  m.linkFor = (to, kind) => { const msg = [...m.sent].reverse().find((x) => x.to === to && x.text.includes(`/#/${kind}/`)); return msg ? msg.text.match(new RegExp(`/#/${kind}/([A-Za-z0-9_-]+)`))[1] : null }
  return m
}
const PW = 'Sturdy-Lantern-42'
const reg = (t, email, extra = {}) => t.call('/auth/register', { method: 'POST', body: { name: 'Nina Nova', email, password: PW, confirmPassword: PW, acceptTerms: true, ...extra } })
const login = (t, email, password = PW) => t.call('/auth/login', { method: 'POST', body: { email, password } })
const asCookie = (cookie) => ({ cookie })
const verify = (t, token, password = PW) => t.call('/auth/email/verify', { method: 'POST', body: { token, password } })

test('registration: validation, hashed password, verification email, no access before verifying', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    assert.equal((await reg(t, 'nina@example.com', { password: 'short', confirmPassword: 'short' })).status, 400)
    assert.equal((await reg(t, 'nina@example.com', { password: 'alllowercaseletters', confirmPassword: 'alllowercaseletters' })).status, 400)
    assert.equal((await reg(t, 'nina@example.com', { confirmPassword: 'Different-Lantern-42' })).status, 400)
    assert.equal((await reg(t, 'not-an-email')).status, 400)
    assert.equal((await reg(t, 'nina@example.com', { acceptTerms: false })).status, 400)
    assert.equal((await reg(t, 'nina@example.com', { password: 'Ninanova-Lantern-42', confirmPassword: 'Ninanova-Lantern-42' })).body.error.message.includes('email'), true)
    const r = await reg(t, 'Nina@Example.com')
    assert.equal(r.status, 200)
    assert.equal(r.cookie, null, 'no session before verification')
    const u = t.db.prepare(`SELECT * FROM users WHERE email = 'nina@example.com'`).get()
    assert.match(u.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    assert.equal(u.password_hash.includes(PW), false)
    assert.equal(u.email_verified, 0); assert.equal(u.google_sub, null)
    assert.equal(mailer.sent.length, 1)
    const token = mailer.linkFor('nina@example.com', 'verify')
    assert.ok(token)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = ?').get(token).n, 0, 'token stored only as a hash')
    // Login before verification: refused (correct password → told to verify; a new link is sent).
    const early = await login(t, 'nina@example.com')
    assert.equal(early.status, 403); assert.equal(early.body.error.code, 'email_not_verified'); assert.equal(early.cookie, null)
    // Verify → signed in; no organization and no role yet.
    const v = await verify(t, mailer.linkFor('nina@example.com', 'verify'))
    assert.equal(v.status, 200)
    const s = await t.call('/api/session', { headers: asCookie(v.cookie) })
    assert.equal(s.body.user.emailVerified, true)
    assert.equal(s.body.membership, null)
    assert.deepEqual(s.body.user.signIn, { google: false, password: true })
    assert.equal(JSON.stringify(s.body).includes('argon2'), false, 'no hash in API responses')
    assert.equal((await t.call('/api/tasks', { headers: asCookie(v.cookie) })).body.error.code, 'no_organization')
    // Then the normal org rules: create an org → admin of that org only.
    const o = await t.call('/api/organizations', { method: 'POST', headers: asCookie(v.cookie), body: { name: 'Nova Co' } })
    assert.equal(o.status, 200)
    assert.equal((await t.call('/api/session', { headers: asCookie(v.cookie) })).body.membership.role, 'admin')
    assert.ok(t.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'auth.email_verified'`).get())
  } finally { await t.close() }
})

test('pre-registration squatting: a link alone cannot verify an account someone else registered for your email', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    const SQUAT = 'Squatter-Lantern-13'
    await reg(t, 'owner@example.com', { password: SQUAT, confirmPassword: SQUAT }) // attacker, without the mailbox
    const token = mailer.linkFor('owner@example.com', 'verify') // lands in the real owner's inbox
    // The owner clicks it but does not know the attacker's password: refused, nothing verified, link still usable.
    const r = await verify(t, token, PW)
    assert.equal(r.status, 401); assert.equal(r.cookie, null)
    assert.equal(t.db.prepare(`SELECT email_verified FROM users WHERE email = 'owner@example.com'`).get().email_verified, 0)
    assert.equal((await verify(t, token, '')).status, 401)
    // The owner registers with their own password: it replaces the squatter's; only the newest link works.
    await reg(t, 'owner@example.com')
    assert.equal((await verify(t, token, SQUAT)).status, 400, 'the squatter-era link is dead')
    const v = await verify(t, mailer.linkFor('owner@example.com', 'verify'), PW)
    assert.equal(v.status, 200)
    assert.equal((await login(t, 'owner@example.com', SQUAT)).status, 401, 'squatter password never works')
    assert.equal((await login(t, 'owner@example.com')).status, 200)
  } finally { await t.close() }
})

test('duplicate registration: same generic answer, no second account, owner informed', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    await reg(t, 'dup@example.com')
    await verify(t, mailer.linkFor('dup@example.com', 'verify'))
    const first = await reg(t, 'fresh@example.com')
    const again = await reg(t, 'dup@example.com', { password: 'Other-Lantern-77', confirmPassword: 'Other-Lantern-77' })
    assert.equal(again.status, 200); assert.deepEqual(again.body, first.body, 'indistinguishable answers')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'dup@example.com'`).get().n, 1)
    assert.equal((await login(t, 'dup@example.com', 'Other-Lantern-77')).status, 401, 'password not overwritten')
    assert.ok(mailer.sent.at(-1).subject.includes('already have'))
  } finally { await t.close() }
})

test('login: valid, invalid password, unknown email — generic message; lockout; logout', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    await reg(t, 'lou@example.com')
    await verify(t, mailer.linkFor('lou@example.com', 'verify'))
    const ok = await login(t, 'LOU@example.com')
    assert.equal(ok.status, 200); assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/)
    const bad = await login(t, 'lou@example.com', 'Wrong-Lantern-42')
    const unknown = await login(t, 'nobody@example.com', 'Wrong-Lantern-42')
    assert.equal(bad.status, 401); assert.equal(unknown.status, 401)
    assert.equal(bad.body.error.message, unknown.body.error.message, 'no enumeration')
    for (let i = 0; i < 4; i++) await login(t, 'lou@example.com', 'Wrong-Lantern-42')
    assert.equal((await login(t, 'lou@example.com')).status, 401, 'locked after 5 failures, even with the right password')
    assert.ok(t.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'auth.login_locked'`).get())
    // CSRF header required.
    const nocsrf = await fetch(`${t.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'lou@example.com', password: PW }) })
    assert.equal(nocsrf.status, 403)
    // Logout ends the session.
    await t.call('/api/session/logout', { method: 'POST', headers: asCookie(ok.cookie) })
    assert.equal((await t.call('/api/session', { headers: asCookie(ok.cookie) })).body.user, null)
  } finally { await t.close() }
})

test('verification links: expired and reused links are refused', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    await reg(t, 'exp@example.com')
    const token = mailer.linkFor('exp@example.com', 'verify')
    t.db.prepare(`UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z'`).run()
    const r = await t.call('/auth/email/verify', { method: 'POST', body: { token } })
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'token_expired')
    await t.call('/auth/email/resend', { method: 'POST', body: { email: 'exp@example.com' } })
    const fresh = mailer.linkFor('exp@example.com', 'verify')
    assert.notEqual(fresh, token)
    assert.equal((await verify(t, fresh)).status, 200)
    assert.equal((await verify(t, fresh)).body.error.code, 'token_invalid')
  } finally { await t.close() }
})

test('forgot + reset: generic answer, valid reset, expired link, reused link, sessions invalidated', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    await reg(t, 'rex@example.com')
    await verify(t, mailer.linkFor('rex@example.com', 'verify'))
    const session = (await login(t, 'rex@example.com')).cookie
    const known = await t.call('/auth/password/forgot', { method: 'POST', body: { email: 'rex@example.com' } })
    const unknown = await t.call('/auth/password/forgot', { method: 'POST', body: { email: 'ghost@example.com' } })
    assert.deepEqual(known.body, unknown.body)
    assert.equal(mailer.sent.filter((m) => m.to === 'ghost@example.com').length, 0)
    const token = mailer.linkFor('rex@example.com', 'reset')
    assert.equal((await t.call('/auth/password/check', { method: 'POST', body: { token } })).body.state, 'valid')
    const NEW = 'Brand-New-Lantern-99'
    assert.equal((await t.call('/auth/password/reset', { method: 'POST', body: { token, password: 'weak', confirmPassword: 'weak' } })).status, 400)
    const ok = await t.call('/auth/password/reset', { method: 'POST', body: { token, password: NEW, confirmPassword: NEW } })
    assert.equal(ok.status, 200)
    assert.equal((await t.call('/api/session', { headers: asCookie(session) })).body.user, null, 'old sessions ended')
    assert.equal((await login(t, 'rex@example.com')).status, 401)
    assert.equal((await login(t, 'rex@example.com', NEW)).status, 200)
    const reuse = await t.call('/auth/password/reset', { method: 'POST', body: { token, password: 'Another-Lantern-11', confirmPassword: 'Another-Lantern-11' } })
    assert.equal(reuse.status, 400); assert.equal(reuse.body.error.code, 'token_invalid')
    await t.call('/auth/password/forgot', { method: 'POST', body: { email: 'rex@example.com' } })
    const t2 = mailer.linkFor('rex@example.com', 'reset')
    t.db.prepare(`UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL`).run()
    assert.equal((await t.call('/auth/password/check', { method: 'POST', body: { token: t2 } })).body.state, 'expired')
    assert.equal((await t.call('/auth/password/reset', { method: 'POST', body: { token: t2, password: 'Another-Lantern-11', confirmPassword: 'Another-Lantern-11' } })).body.error.code, 'token_expired')
  } finally { await t.close() }
})

test('change password: needs the current one; other sessions end, this one stays', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    await reg(t, 'cp@example.com')
    await verify(t, mailer.linkFor('cp@example.com', 'verify'))
    const a = (await login(t, 'cp@example.com')).cookie
    const b = (await login(t, 'cp@example.com')).cookie
    const NEW = 'Changed-Lantern-55'
    assert.equal((await t.call('/api/account/password', { method: 'POST', headers: asCookie(a), body: { currentPassword: 'Wrong-Lantern-1', password: NEW, confirmPassword: NEW } })).status, 401)
    assert.equal((await t.call('/api/account/password', { method: 'POST', headers: asCookie(a), body: { currentPassword: PW, password: NEW, confirmPassword: NEW } })).status, 200)
    assert.ok((await t.call('/api/session', { headers: asCookie(a) })).body.user)
    assert.equal((await t.call('/api/session', { headers: asCookie(b) })).body.user, null)
  } finally { await t.close() }
})

// ---- Google still works, and linking ----
const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const idToken = (claims) => { const h = b64({ alg: 'RS256', kid: 'k1' }); const p = b64(claims); return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url')}` }
const google = { clientId: CLIENT_ID, clientSecret: 's', redirectUri: 'https://teampulse.test/auth/google/callback', configured: true }
async function googleLogin(t, g, { sub, email, verified = true }) {
  const start = await t.call('/auth/google')
  const url = new URL(start.headers.get('location'))
  g.next = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, email, email_verified: verified, name: 'G User', nonce: url.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 600 }
  return t.call(`/auth/google/callback?code=c&state=${url.searchParams.get('state')}`)
}
const fakeGoogle = () => { const g = {}; g.transport = { exchangeCode: async () => ({ id_token: idToken(g.next) }), jwks: async () => [jwk] }; return g }

test('linking: verified email account + Google with the same verified email → one account, org/role/history kept', async () => {
  const mailer = capture(); const g = fakeGoogle()
  const t = await startApp({ mailer, google: g.transport, cfgOverrides: { google } })
  try {
    const s = seedOrg(t.db)
    await reg(t, 'link@example.com')
    await verify(t, mailer.linkFor('link@example.com', 'verify'))
    const u = t.db.prepare(`SELECT * FROM users WHERE email = 'link@example.com'`).get()
    t.db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES ('mx', ?, ?, 'manager', ?, 'active', 'x', 'x')`).run(s.org.id, u.id, s.teamA)
    const cb = await googleLogin(t, g, { sub: 'g-link-1', email: 'link@example.com' })
    assert.equal(cb.headers.get('location'), '/#/dashboard')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'link@example.com'`).get().n, 1, 'no duplicate')
    const after = t.db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)
    assert.equal(after.google_sub, 'g-link-1'); assert.ok(after.password_hash, 'password kept')
    const sess = await t.call('/api/session', { headers: asCookie(cb.cookie) })
    assert.equal(sess.body.user.id, u.id); assert.equal(sess.body.membership.role, 'manager', 'role preserved')
    assert.deepEqual(sess.body.user.signIn, { google: true, password: true })
    assert.equal((await login(t, 'link@example.com')).status, 200, 'password still works')
    assert.ok(t.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'auth.google_linked'`).get())
  } finally { await t.close() }
})

test('linking: an UNVERIFIED password sign-up is never merged by email alone; Google proof removes the unproven password', async () => {
  const mailer = capture(); const g = fakeGoogle()
  const t = await startApp({ mailer, google: g.transport, cfgOverrides: { google } })
  try {
    await reg(t, 'victim@example.com', { password: 'Attacker-Lantern-66', confirmPassword: 'Attacker-Lantern-66' })
    // Google does not vouch for the email → refused, no second account.
    const unv = await googleLogin(t, g, { sub: 'g-x', email: 'victim@example.com', verified: false })
    assert.match(unv.headers.get('location'), /#\/login\?error=/)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'victim@example.com'`).get().n, 1)
    // The real owner signs in with Google (verified) → takes the account; the attacker's password stops working.
    const cb = await googleLogin(t, g, { sub: 'g-victim', email: 'victim@example.com' })
    assert.equal(cb.headers.get('location'), '/#/dashboard')
    const u = t.db.prepare(`SELECT * FROM users WHERE lower(email) = 'victim@example.com'`).get()
    assert.equal(u.password_hash, null); assert.equal(u.google_sub, 'g-victim')
    assert.equal((await login(t, 'victim@example.com', 'Attacker-Lantern-66')).status, 401)
    assert.equal((await verify(t, mailer.linkFor('victim@example.com', 'verify'))).status, 400, 'pending link dead')
  } finally { await t.close() }
})

test('linking: a Google user adds password sign-in only through an emailed link; registering their email does the same', async () => {
  const mailer = capture(); const g = fakeGoogle()
  const t = await startApp({ mailer, google: g.transport, cfgOverrides: { google } })
  try {
    const cb = await googleLogin(t, g, { sub: 'g-only', email: 'gonly@example.com' })
    const id = t.db.prepare(`SELECT id FROM users WHERE google_sub = 'g-only'`).get().id
    // Registering the Google user's email: generic answer, no new account, a set-password link goes to the mailbox.
    await reg(t, 'gonly@example.com')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'gonly@example.com'`).get().n, 1)
    assert.equal((await login(t, 'gonly@example.com')).status, 401, 'registering did not set a password')
    // Signed in: ask for the link; set a password with it.
    assert.equal((await t.call('/api/account/password-link', { method: 'POST', headers: asCookie(cb.cookie) })).body.ok, true)
    const token = mailer.linkFor('gonly@example.com', 'reset')
    assert.equal((await t.call('/auth/password/check', { method: 'POST', body: { token } })).body.purpose, 'link_password')
    const NEW = 'Linked-Lantern-31'
    assert.equal((await t.call('/auth/password/reset', { method: 'POST', body: { token, password: NEW, confirmPassword: NEW } })).status, 200)
    const both = await login(t, 'gonly@example.com', NEW)
    assert.equal(both.status, 200)
    assert.equal((await t.call('/api/session', { headers: asCookie(both.cookie) })).body.user.id, id, 'same account')
    assert.equal(t.db.prepare('SELECT google_sub FROM users WHERE id = ?').get(id).google_sub, 'g-only', 'Google subject preserved')
    // Google still signs in to the same account.
    const again = await googleLogin(t, g, { sub: 'g-only', email: 'gonly@example.com' })
    assert.equal((await t.call('/api/session', { headers: asCookie(again.cookie) })).body.user.id, id)
  } finally { await t.close() }
})

test('organization isolation and roles are unchanged for password accounts; existing Google users keep working', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    const s = seedOrg(t.db)
    await reg(t, 'iso@example.com')
    const v = await verify(t, mailer.linkFor('iso@example.com', 'verify'))
    assert.equal((await t.call('/api/tasks', { headers: asCookie(v.cookie) })).status, 403)
    const task = await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'Private', assigneeId: s.employee.id } })
    await t.call('/api/organizations', { method: 'POST', headers: asCookie(v.cookie), body: { name: 'Other Co' } })
    assert.equal((await t.call(`/api/tasks/${task.body.task.id}`, { headers: asCookie(v.cookie) })).status, 404)
    assert.equal((await t.call('/api/session', { as: s.manager })).body.membership.role, 'manager')
    assert.equal((await t.call('/api/tasks', { as: s.admin })).status, 200, 'existing (Google) sessions unaffected')
    assert.equal((await login(t, s.employee.email, PW)).status, 401, 'Google-only users have no password')
  } finally { await t.close() }
})

test('invitations: a verified password account accepts with exactly the invited role; no role before that', async () => {
  const mailer = capture()
  const t = await startApp({ mailer })
  try {
    const s = seedOrg(t.db)
    const inv = await t.call('/api/invitations', { method: 'POST', as: s.manager, body: { email: 'invitee@example.com', role: 'employee' } })
    await reg(t, 'invitee@example.com')
    const v = await verify(t, mailer.linkFor('invitee@example.com', 'verify'))
    assert.equal((await t.call('/api/session', { headers: asCookie(v.cookie) })).body.membership, null, 'no automatic membership')
    const ob = await t.call('/api/onboarding', { headers: asCookie(v.cookie) })
    assert.equal(ob.body.invitations[0].emailMatches, true)
    assert.equal((await t.call(`/api/invitations/${inv.body.id}/accept`, { method: 'POST', headers: asCookie(v.cookie) })).status, 200)
    const sess = await t.call('/api/session', { headers: asCookie(v.cookie) })
    assert.equal(sess.body.membership.role, 'employee'); assert.equal(sess.body.membership.orgId, s.org.id)
  } finally { await t.close() }
})

test('without an email provider: sign-up and reset say so; nothing pretends to send', async () => {
  const t = await startApp()
  try {
    const r = await reg(t, 'np@example.com')
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'email_not_configured')
    assert.equal((await t.call('/auth/password/forgot', { method: 'POST', body: { email: 'np@example.com' } })).status, 503)
    assert.equal((await t.call('/api/session')).body.emailAuth.available, false)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'np@example.com'`).get().n, 0)
    void makeUser
  } finally { await t.close() }
})

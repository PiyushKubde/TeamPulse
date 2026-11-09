import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { startApp, makeUser } from './helpers.js'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(claims, { key = privateKey, kid = 'k1' } = {}) {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' })
  const body = b64(claims)
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')
  return `${head}.${body}.${sig}`
}

/** A fake Google: the token endpoint answers with an ID token for whatever claims the test queued. */
function fakeGoogle() {
  const g = { next: null, exchanges: [] }
  g.transport = {
    async exchangeCode(params) { g.exchanges.push(params); return { id_token: g.next(params) } },
    async jwks() { return [jwk] }
  }
  return g
}

const google = { clientId: CLIENT_ID, clientSecret: 'secret', redirectUri: 'https://teampulse.test/auth/google/callback', configured: true }

async function startLogin(t) {
  const res = await t.call('/auth/google')
  assert.equal(res.status, 302)
  const url = new URL(res.headers.get('location'))
  assert.equal(url.host, 'accounts.google.com')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  return { state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce') }
}

test('Google login: new user registers by sub, logs out, logs back in as the same account', async () => {
  const g = fakeGoogle()
  const t = await startApp({ google: g.transport, cfgOverrides: { google } })
  try {
    const { state, nonce } = await startLogin(t)
    const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-sub-123', email: 'priya@example.com', email_verified: true, name: 'Priya', picture: 'https://lh3.googleusercontent.com/a/x', nonce, exp: Math.floor(Date.now() / 1000) + 3600 }
    g.next = () => idToken(claims)
    const cb = await t.call(`/auth/google/callback?code=abc&state=${state}`)
    assert.equal(cb.status, 302)
    assert.equal(cb.headers.get('location'), '/#/dashboard')
    const cookie = cb.headers.get('set-cookie').split(';')[0]
    assert.match(cb.headers.get('set-cookie'), /HttpOnly/)
    assert.match(cb.headers.get('set-cookie'), /SameSite=Lax/)
    assert.equal(g.exchanges[0].code_verifier.length > 40, true, 'PKCE verifier is sent')
    const s = await t.call('/api/session', { headers: { cookie } })
    assert.equal(s.body.user.email, 'priya@example.com')
    assert.equal(s.body.user.emailVerified, true)
    assert.equal(s.body.membership, null, 'a new user has no organization and no role')
    const row = t.db.prepare('SELECT * FROM users WHERE google_sub = ?').get('google-sub-123')
    assert.equal(row.picture_url, 'https://lh3.googleusercontent.com/a/x')

    // State is single-use.
    const replay = await t.call(`/auth/google/callback?code=abc&state=${state}`)
    assert.match(replay.headers.get('location'), /#\/login\?error=/)

    const out = await t.call('/api/session/logout', { method: 'POST', headers: { cookie } })
    assert.equal(out.status, 200)
    assert.equal((await t.call('/api/session', { headers: { cookie } })).body.user, null)

    // Second login with a changed email: same account (identity is the sub, not the email).
    const second = await startLogin(t)
    g.next = () => idToken({ ...claims, nonce: second.nonce, email: 'priya.new@example.com' })
    const cb2 = await t.call(`/auth/google/callback?code=def&state=${second.state}`)
    const cookie2 = cb2.headers.get('set-cookie').split(';')[0]
    const s2 = await t.call('/api/session', { headers: { cookie: cookie2 } })
    assert.equal(s2.body.user.id, s.body.user.id)
    assert.equal(s2.body.user.email, 'priya.new@example.com')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  } finally { await t.close() }
})

test('Google login rejects a wrong audience, a wrong nonce, a forged signature and an expired token', async () => {
  const g = fakeGoogle()
  const t = await startApp({ google: g.transport, cfgOverrides: { google } })
  try {
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const cases = [
      (nonce) => idToken({ iss: 'accounts.google.com', aud: 'someone-else', sub: 's', email: 'a@b.co', nonce, exp: Date.now() / 1000 + 60 }),
      () => idToken({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: 's', email: 'a@b.co', nonce: 'wrong', exp: Date.now() / 1000 + 60 }),
      (nonce) => idToken({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: 's', email: 'a@b.co', nonce, exp: Date.now() / 1000 + 60 }, { key: forged }),
      (nonce) => idToken({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: 's', email: 'a@b.co', nonce, exp: Date.now() / 1000 - 3600 }),
      (nonce) => idToken({ iss: 'https://evil.example', aud: CLIENT_ID, sub: 's', email: 'a@b.co', nonce, exp: Date.now() / 1000 + 60 })
    ]
    for (const make of cases) {
      const { state, nonce } = await startLogin(t)
      g.next = () => make(nonce)
      const cb = await t.call(`/auth/google/callback?code=x&state=${state}`)
      assert.match(cb.headers.get('location'), /#\/login\?error=/)
      assert.equal(cb.headers.get('set-cookie'), null)
    }
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
  } finally { await t.close() }
})

test('without Google config, /auth/google explains what is missing; dev login is off by default', async () => {
  const t = await startApp({ cfgOverrides: { google: { configured: false } } })
  try {
    const r = await t.call('/auth/google')
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, 'google_not_configured')
    const d = await t.call('/auth/dev-login', { method: 'POST', body: { email: 'x@y.co' } })
    assert.equal(d.status, 404)
  } finally { await t.close() }
})

test('API needs a session; mutations need the CSRF header', async () => {
  const t = await startApp()
  try {
    assert.equal((await t.call('/api/tasks')).status, 401)
    const u = makeUser(t.db, { name: 'No Org' })
    const r = await t.call('/api/tasks', { as: u })
    assert.equal(r.status, 403)
    assert.equal(r.body.error.code, 'no_organization')
    const res = await fetch(`${t.base}/api/organizations`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: u.cookie }, body: '{"name":"X Org"}' })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, 'csrf')
  } finally { await t.close() }
})

// Google OAuth 2.0 / OpenID Connect: authorization code flow with PKCE, state and nonce.
// https://developers.google.com/identity/openid-connect/openid-connect
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { now } from '../db.js'
import { AppError } from '../errors.js'
import { randomToken, sha256 } from './sessions.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

/** The HTTP side of Google, separate so tests can replace it. */
export function googleTransport(fetchImpl = fetch) {
  let keys = null
  let keysAt = 0
  return {
    async exchangeCode(params) {
      const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new AppError(401, 'google_exchange_failed', `Google did not accept the sign-in (${body.error || res.status}).`)
      return body
    },
    async jwks() {
      if (keys && Date.now() - keysAt < 3600000) return keys
      const res = await fetchImpl(CERTS_URL)
      if (!res.ok) throw new AppError(502, 'google_keys_unavailable', 'Could not read Google’s signing keys. Try again.')
      keys = (await res.json()).keys || []
      keysAt = Date.now()
      return keys
    }
  }
}

const b64urlJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/** Verifies an ID token's RS256 signature against Google's published keys and its standard claims. */
export async function verifyIdToken(idToken, { clientId, nonce, transport }) {
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw new AppError(401, 'invalid_id_token', 'Google returned an invalid sign-in token.')
  const header = b64urlJson(parts[0])
  const claims = b64urlJson(parts[1])
  if (header.alg !== 'RS256') throw new AppError(401, 'invalid_id_token', 'Unexpected sign-in token algorithm.')
  const jwk = (await transport.jwks()).find((k) => k.kid === header.kid)
  if (!jwk) throw new AppError(401, 'invalid_id_token', 'The sign-in token was signed with an unknown key.')
  const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))
  if (!ok) throw new AppError(401, 'invalid_id_token', 'The sign-in token signature is not valid.')
  const t = Math.floor(Date.now() / 1000)
  if (!ISSUERS.has(claims.iss)) throw new AppError(401, 'invalid_id_token', 'The sign-in token was not issued by Google.')
  if (claims.aud !== clientId) throw new AppError(401, 'invalid_id_token', 'The sign-in token is for a different application.')
  if (typeof claims.exp !== 'number' || claims.exp < t - 60) throw new AppError(401, 'invalid_id_token', 'The sign-in token has expired.')
  if (claims.nonce !== nonce) throw new AppError(401, 'invalid_id_token', 'The sign-in could not be matched to this browser. Try again.')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AppError(401, 'invalid_id_token', 'The sign-in token has no account id.')
  return claims
}

const safeReturn = (p) => (typeof p === 'string' && /^#\/[A-Za-z0-9/_\-?=&.]{0,200}$/.test(p) ? p : null)

/** Step 1: a Google sign-in URL. State, nonce and PKCE verifier are kept server-side for 10 minutes. */
export function startGoogleLogin(db, google, { returnTo } = {}) {
  if (!google.configured) throw new AppError(503, 'google_not_configured', 'Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.')
  const state = randomToken()
  const nonce = randomToken()
  const verifier = randomToken(48)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now())
  db.prepare('INSERT INTO oauth_states (state_hash, nonce, code_verifier, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(state), nonce, verifier, safeReturn(returnTo), new Date(Date.now() + 600000).toISOString(), now())
  const params = new URLSearchParams({
    client_id: google.clientId, redirect_uri: google.redirectUri, response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
  })
  return `${AUTH_URL}?${params}`
}

/** Step 2: the callback. Consumes the state once, exchanges the code, verifies the ID token, upserts the user by `sub`. */
export async function finishGoogleLogin(db, google, transport, { code, state }) {
  if (typeof state !== 'string' || typeof code !== 'string' || !state || !code) throw new AppError(400, 'invalid_callback', 'The sign-in response was incomplete. Try again.')
  const row = db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').get(sha256(state))
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(sha256(state))
  if (!row || row.expires_at < now()) throw new AppError(400, 'invalid_state', 'This sign-in link has expired or was already used. Try again.')
  const tokens = await transport.exchangeCode({
    code, client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: google.redirectUri, grant_type: 'authorization_code', code_verifier: row.code_verifier
  })
  const claims = await verifyIdToken(tokens.id_token, { clientId: google.clientId, nonce: row.nonce, transport })
  const user = upsertGoogleUser(db, {
    sub: claims.sub, email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === 'true', name: claims.name, picture: claims.picture
  })
  return { user, returnTo: row.return_to }
}

/**
 * Identity is Google's stable `sub`; email, name and picture are refreshed on each sign-in.
 * A first Google sign-in whose email matches an existing account (email/password sign-up):
 *  - Google says the email is verified and the account's email is verified → link Google to that account (both
 *    sides proved the same mailbox). Organization, role, tasks and history stay as they are.
 *  - Google says verified, the account never verified its email (an unproven sign-up, possibly someone else
 *    pre-registering this address) → Google proves the owner: the unproven password is removed, Google is linked,
 *    any sessions and pending links of that account end.
 *  - Google does not vouch for the email → never merged, and no second account is created for it.
 */
export function upsertGoogleUser(db, { sub, email, emailVerified, name, picture }) {
  if (!email) throw new AppError(400, 'email_required', 'Your Google account did not share an email address.')
  const ts = now()
  const mail = String(email).toLowerCase()
  const cleanName = String(name || mail.split('@')[0]).slice(0, 120)
  const pic = typeof picture === 'string' && picture.startsWith('https://') ? picture.slice(0, 500) : null
  const existing = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub)
  if (existing) {
    db.prepare('UPDATE users SET email = ?, email_verified = ?, email_verified_at = CASE WHEN ? = 1 THEN COALESCE(email_verified_at, ?) ELSE email_verified_at END, name = ?, picture_url = ?, last_login_at = ?, updated_at = ? WHERE id = ?')
      .run(mail, emailVerified ? 1 : 0, emailVerified ? 1 : 0, ts, cleanName, pic, ts, ts, existing.id)
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id)
  }
  const sameEmail = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND google_sub IS NULL ORDER BY email_verified DESC, created_at').all(mail)
  if (sameEmail.length) {
    if (!emailVerified) throw new AppError(409, 'email_unverified_conflict', 'An account with this email already exists. Sign in with your email and password, or verify your email with Google first.')
    const target = sameEmail[0]
    const audited = (action) => db.prepare(`INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id, created_at) VALUES (?, (SELECT org_id FROM memberships WHERE user_id = ?), ?, ?, 'user', ?, ?)`).run(crypto.randomUUID(), target.id, target.id, action, target.id, ts)
    if (target.email_verified) {
      db.prepare('UPDATE users SET google_sub = ?, picture_url = COALESCE(picture_url, ?), last_login_at = ?, updated_at = ? WHERE id = ?').run(sub, pic, ts, ts, target.id)
      audited('auth.google_linked')
    } else {
      db.prepare('UPDATE users SET google_sub = ?, name = ?, picture_url = ?, password_hash = NULL, password_updated_at = NULL, email_verified = 1, email_verified_at = ?, failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
        .run(sub, cleanName, pic, ts, ts, ts, target.id)
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id)
      db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(ts, target.id)
      audited('auth.google_claimed_unverified_signup')
    }
    return db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)
  }
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO users (id, google_sub, email, email_verified, email_verified_at, name, picture_url, last_login_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, sub, mail, emailVerified ? 1 : 0, emailVerified ? ts : null, cleanName, pic, ts, ts, ts)
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

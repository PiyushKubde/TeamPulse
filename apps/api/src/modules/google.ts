// Google sign-in: OAuth 2.0 / OpenID Connect authorization code flow with PKCE, state and nonce (ported from KONVO).
// https://developers.google.com/identity/openid-connect/openid-connect
// State, nonce and PKCE verifier travel in an encrypted, httpOnly, 10-minute cookie scoped to the callback path, so a
// stolen callback URL is useless in another browser and nothing needs a database table.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import type { Request, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { decrypt, encrypt, randomToken } from '../lib/crypto.js'
import { HttpError } from '../lib/errors.js'
import { env, isProd } from '../config/env.js'
import { logger } from '../config/logger.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
const COOKIE = 'konvo_oauth'
// Readable on both callback paths (/api/auth/google/callback and the original KONVO /auth/google/callback).
const COOKIE_PATH = '/'

export const googleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
const redirectUri = () => env.GOOGLE_REDIRECT_URI ?? `${env.APP_URL}/api/auth/google/callback`
const fail = (code: string, message: string, status = 401) => new HttpError(status, code, message)

let keys: { kid: string }[] | null = null
let keysAt = 0
async function jwks() {
  if (keys && Date.now() - keysAt < 36e5) return keys
  const res = await fetch(CERTS_URL)
  if (!res.ok) throw fail('google_keys_unavailable', 'Could not read Google’s signing keys. Try again.', 502)
  keys = ((await res.json()) as { keys?: { kid: string }[] }).keys ?? []
  keysAt = Date.now()
  return keys
}

const b64urlJson = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

/** Verifies an ID token's RS256 signature against Google's published keys, and its standard claims. */
export async function verifyIdToken(idToken: unknown, nonce: string) {
  const parts = String(idToken ?? '').split('.')
  if (parts.length !== 3) throw fail('invalid_id_token', 'Google returned an invalid sign-in token.')
  const header = b64urlJson(parts[0]!)
  const claims = b64urlJson(parts[1]!)
  if (header.alg !== 'RS256') throw fail('invalid_id_token', 'Unexpected sign-in token algorithm.')
  const jwk = (await jwks()).find((k) => k.kid === header.kid)
  if (!jwk) throw fail('invalid_id_token', 'The sign-in token was signed with an unknown key.')
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
  const ok = verifySignature('RSA-SHA256', signed, createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'))
  if (!ok) throw fail('invalid_id_token', 'The sign-in token signature is not valid.')
  const t = Math.floor(Date.now() / 1000)
  if (!ISSUERS.has(String(claims.iss))) throw fail('invalid_id_token', 'The sign-in token was not issued by Google.')
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw fail('invalid_id_token', 'The sign-in token is for a different application.')
  if (typeof claims.exp !== 'number' || claims.exp < t - 60) throw fail('invalid_id_token', 'The sign-in token has expired.')
  if (claims.nonce !== nonce) throw fail('invalid_id_token', 'The sign-in could not be matched to this browser. Try again.')
  if (typeof claims.sub !== 'string' || !claims.sub) throw fail('invalid_id_token', 'The sign-in token has no account id.')
  return claims as { sub: string; email?: string; email_verified?: boolean | string; name?: string; picture?: string }
}

/** Only same-site paths, never "//host" or a scheme, so the redirect can't be used to send people elsewhere. */
const safeReturn = (p: unknown) => (typeof p === 'string' && /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]{0,300}$/.test(p) ? p : null)

/** Step 1: send the browser to Google. */
export function startGoogle(req: Request, res: Response) {
  if (!googleConfigured()) return res.redirect(302, `${env.APP_URL}/login?error=${encodeURIComponent('Google sign-in isn’t set up on this server yet.')}`)
  const state = randomToken()
  const nonce = randomToken()
  const verifier = randomToken(48)
  const payload = { state, nonce, verifier, returnTo: safeReturn(req.query.returnTo), exp: Date.now() + 6e5 }
  res.cookie(COOKIE, encrypt(JSON.stringify(payload)), { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 6e5, path: COOKIE_PATH })
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  res.redirect(302, `${AUTH_URL}?${params}`)
}

/**
 * Identity is Google's stable `sub`; email and name refresh on each sign-in. A first Google sign-in whose email matches an
 * existing account:
 *  - Google vouches for the email and the account verified it too → link (both proved the same mailbox).
 *  - Google vouches, the account never verified (an unproven sign-up, possibly someone pre-registering the address) →
 *    Google proves the owner: the unproven password is removed, Google is linked, that account's sessions and links end.
 *  - Google does not vouch for the email → never merged, and no second account is made.
 */
export async function upsertGoogleUser(c: { sub: string; email?: string; emailVerified: boolean; name?: string }) {
  if (!c.email) throw fail('email_required', 'Your Google account did not share an email address.', 400)
  const email = c.email.toLowerCase()
  const name = (c.name || email.split('@')[0]!).slice(0, 120)
  const verifiedAt = c.emailVerified ? new Date() : null
  const bySub = await prisma.user.findUnique({ where: { googleSub: c.sub } })
  if (bySub) {
    const taken = email !== bySub.email && (await prisma.user.findUnique({ where: { email } }))
    return prisma.user.update({
      where: { id: bySub.id },
      data: { ...(taken ? {} : { email }), name, ...(verifiedAt && !bySub.emailVerifiedAt ? { emailVerifiedAt: verifiedAt } : {}) },
    })
  }
  const same = await prisma.user.findUnique({ where: { email } })
  if (same) {
    if (!c.emailVerified) throw fail('email_unverified_conflict', 'An account with this email already exists. Sign in with your email and password.', 409)
    if (same.emailVerifiedAt) return prisma.user.update({ where: { id: same.id }, data: { googleSub: c.sub } })
    const [user] = await prisma.$transaction([
      prisma.user.update({ where: { id: same.id }, data: { googleSub: c.sub, name, passwordHash: null, emailVerifiedAt: verifiedAt } }),
      prisma.session.deleteMany({ where: { userId: same.id } }),
      prisma.authToken.updateMany({ where: { userId: same.id, usedAt: null }, data: { usedAt: new Date() } }),
    ])
    return user
  }
  return prisma.user.create({ data: { googleSub: c.sub, email, name, emailVerifiedAt: verifiedAt } })
}

/** Step 2: Google sends the browser back. Consumes the state once, exchanges the code, verifies the token, signs in. */
export async function finishGoogle(req: Request, res: Response, startSession: (res: Response, userId: string) => Promise<void>) {
  const back = (path: string) => res.redirect(302, `${env.APP_URL}${path}`)
  const raw = req.cookies?.[COOKIE] as string | undefined
  res.clearCookie(COOKIE, { path: COOKIE_PATH })
  try {
    if (req.query.error) throw fail('google_denied', 'Google sign-in was cancelled.', 400)
    const { code, state } = req.query
    if (typeof code !== 'string' || typeof state !== 'string' || !raw) throw fail('invalid_callback', 'The sign-in response was incomplete. Try again.', 400)
    let saved: { state: string; nonce: string; verifier: string; returnTo: string | null; exp: number }
    try {
      saved = JSON.parse(decrypt(raw))
    } catch {
      throw fail('invalid_state', 'This sign-in link has expired or was already used. Try again.', 400)
    }
    if (saved.state !== state || saved.exp < Date.now()) throw fail('invalid_state', 'This sign-in link has expired or was already used. Try again.', 400)
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: saved.verifier,
      }),
    })
    const tokens = (await tokenRes.json().catch(() => ({}))) as { id_token?: string; error?: string }
    if (!tokenRes.ok) throw fail('google_exchange_failed', `Google did not accept the sign-in (${tokens.error ?? tokenRes.status}).`)
    const claims = await verifyIdToken(tokens.id_token, saved.nonce)
    const user = await upsertGoogleUser({
      sub: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: claims.name,
    })
    await startSession(res, user.id)
    back(saved.returnTo ?? '/')
  } catch (e) {
    logger.warn({ code: e instanceof HttpError ? e.code : 'error', err: e instanceof Error ? e.message : e }, 'Google sign-in failed')
    back(`/login?error=${encodeURIComponent(e instanceof HttpError ? e.message : 'Sign-in failed. Try again.')}`)
  }
}

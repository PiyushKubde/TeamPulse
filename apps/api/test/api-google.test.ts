// MOCKED GOOGLE: the token and key endpoints are answered by a fake that signs real RS256 ID tokens with a test key.
import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../src/config/env.js'
import { prisma } from '../src/lib/prisma.js'
import { upsertGoogleUser } from '../src/modules/google.js'
import { client, signUp } from './helpers.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(claims: Record<string, unknown>) {
  const head = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
  const body = b64({ iss: 'https://accounts.google.com', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, ...claims })
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}

let claims: Record<string, unknown> = {}
let exchanged: URLSearchParams | null = null
const realFetch = globalThis.fetch
beforeEach(() => {
  env.GOOGLE_CLIENT_ID = 'cid'
  env.GOOGLE_CLIENT_SECRET = 'secret'
  exchanged = null
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }))
    if (url === 'https://oauth2.googleapis.com/token') {
      exchanged = new URLSearchParams(String(init?.body))
      return new Response(JSON.stringify({ id_token: idToken(claims) }))
    }
    return realFetch(input, init)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  env.GOOGLE_CLIENT_ID = undefined
  env.GOOGLE_CLIENT_SECRET = undefined
})

/** Runs the whole browser round trip: start → (Google) → callback. Returns the final redirect. */
async function signInWithGoogle(c: ReturnType<typeof client>, returnTo = '/', tamper?: (u: URL) => void) {
  const start = await c.get(`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`).expect(302)
  const google = new URL(start.headers.location!)
  claims = { ...claims, nonce: google.searchParams.get('nonce') }
  const cb = new URL('http://x/api/auth/google/callback')
  cb.searchParams.set('code', 'the-code')
  cb.searchParams.set('state', google.searchParams.get('state')!)
  tamper?.(cb)
  const done = await c.get(cb.pathname + cb.search).expect(302)
  return { google, location: done.headers.location! }
}

describe('Google sign-in', () => {
  it('uses PKCE, verifies the signed token, creates the account and signs in; returns to a same-site path only', async () => {
    const c = client()
    expect((await c.get('/api/auth/providers')).body).toEqual({ google: true })
    claims = { sub: 'g-1', email: `Gina${Date.now()}@Gmail.com`, email_verified: true, name: 'Gina' }
    const { google, location } = await signInWithGoogle(c, '/accept-invite?token=abc')
    expect(google.searchParams.get('code_challenge_method')).toBe('S256')
    expect(exchanged?.get('code_verifier')).toBeTruthy()
    expect(location).toBe(`${env.APP_URL}/accept-invite?token=abc`)
    const me = (await c.get('/api/auth/me').expect(200)).body
    expect(me.user).toMatchObject({ name: 'Gina', emailVerified: true })
    expect(me.phoneAlerts.hasPhone).toBe(false) // the app asks for the number next

    claims = { sub: 'g-1', email: claims.email, email_verified: true, name: 'Gina' }
    expect((await signInWithGoogle(client(), '//evil.example')).location).toBe(`${env.APP_URL}/`)
    expect(await prisma.user.count({ where: { googleSub: 'g-1' } })).toBe(1)
  })

  it('rejects a replayed or forged state, and a token meant for another browser', async () => {
    claims = { sub: 'g-2', email: `g2-${Date.now()}@x.com`, email_verified: true }
    const forged = await signInWithGoogle(client(), '/', (u) => u.searchParams.set('state', 'forged'))
    expect(forged.location).toMatch(/\/login\?error=.*expired/)
    // Callback opened in a browser that never started the sign-in: no state cookie.
    const c = client()
    const start = await c.get('/api/auth/google').expect(302)
    const state = new URL(start.headers.location!).searchParams.get('state')!
    const other = await client().get(`/api/auth/google/callback?code=x&state=${state}`).expect(302)
    expect(other.headers.location).toMatch(/\/login\?error=/)
    expect(await prisma.user.count({ where: { googleSub: 'g-2' } })).toBe(0)
  })

  it('links to a verified password account; takes over an unverified one; never merges when Google does not vouch', async () => {
    const verified = await signUp('Vera')
    await prisma.user.update({ where: { id: verified.user.id }, data: { emailVerifiedAt: new Date() } })
    const linked = await upsertGoogleUser({ sub: 'g-v', email: verified.email, emailVerified: true, name: 'Vera G' })
    expect(linked.id).toBe(verified.user.id)
    expect(linked.passwordHash).toBeTruthy()

    const squatter = await signUp('Squat')
    const claimed = await upsertGoogleUser({ sub: 'g-s', email: squatter.email, emailVerified: true, name: 'Real Owner' })
    expect(claimed).toMatchObject({ id: squatter.user.id, passwordHash: null, name: 'Real Owner' })
    expect(await prisma.session.count({ where: { userId: squatter.user.id } })).toBe(0)

    const other = await signUp('Other')
    await expect(upsertGoogleUser({ sub: 'g-o', email: other.email, emailVerified: false })).rejects.toThrow(/already exists/)
  })

  it('without Google set up, the button is hidden and the route explains', async () => {
    env.GOOGLE_CLIENT_ID = undefined
    const c = client()
    expect((await c.get('/api/auth/providers')).body).toEqual({ google: false })
    const r = await c.get('/api/auth/google').expect(302)
    expect(r.headers.location).toMatch(/\/login\?error=.*set%20up/)
  })
})

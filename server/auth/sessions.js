// Opaque session tokens in an HttpOnly cookie; only their SHA-256 is stored.
import { createHash, randomBytes } from 'node:crypto'
import { now } from '../db.js'

export const COOKIE = 'tp_session'
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export function createSession(db, userId, { days = 14, userAgent = null } = {}) {
  const token = randomToken()
  const expires = new Date(Date.now() + days * 86400000).toISOString()
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, expires, now(), userAgent ? String(userAgent).slice(0, 200) : null)
  return { token, expires }
}

export function sessionUser(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now())
  return row || null
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

export function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

export function cookieHeader(name, value, { maxAgeSeconds, secure }) {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, secure ? 'Secure' : null].filter(Boolean).join('; ')
}

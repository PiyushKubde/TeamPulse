// Email/password accounts alongside Google. Rules:
// - Passwords: Argon2id (password.js). Tokens: 32 random bytes, only their SHA-256 stored, expiring, single use.
// - No account enumeration: registration, resend and forgot-password always answer the same; login failures are
//   one generic message (a correct password for an unverified account may say "verify first": the password proves it).
// - No duplicate account for one verified email. Linking needs proof of the mailbox: an email link, or Google's
//   verified email (google.js). A role is never granted here: org rules are unchanged.
import { randomBytes } from 'node:crypto'
import { now, transaction, uuid } from '../db.js'
import { AppError, invalid } from '../errors.js'
import * as v from '../validate.js'
import { audit } from '../services/audit.js'
import { sha256 } from './sessions.js'
import { burnTime, checkPasswordPolicy, hashPassword, verifyPassword } from './password.js'
import { EMAILS } from './mailer.js'

const TTL = { verify_email: 24 * 3600000, reset_password: 30 * 60000, link_password: 3600000 }
const LOCK_AFTER = 5
const LOCK_MS = 15 * 60000
const GENERIC_LOGIN = 'Email or password is incorrect.'

const sendLimits = new Map() // `${purpose}:${email}` → [timestamps]; at most 3 emails per 15 minutes per address
function allowSend(key) {
  const t = Date.now()
  const recent = (sendLimits.get(key) || []).filter((x) => t - x < 15 * 60000)
  if (recent.length >= 3) return false
  recent.push(t); sendLimits.set(key, recent)
  if (sendLimits.size > 20000) sendLimits.clear()
  return true
}

const orgOf = (db, userId) => db.prepare('SELECT org_id FROM memberships WHERE user_id = ?').get(userId)?.org_id ?? null
function authAudit(db, userId, action, after) {
  audit(db, { orgId: orgOf(db, userId), actorId: userId, action, entityType: 'user', entityId: userId, ...(after ? { after } : {}) })
}

/** A fresh single-use token for (user, purpose); earlier unused ones for the same purpose stop working. */
function issueToken(db, userId, purpose) {
  const token = randomBytes(32).toString('base64url')
  const ts = now()
  db.prepare(`UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL`).run(ts, userId, purpose)
  db.prepare(`INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uuid(), userId, purpose, sha256(token), new Date(Date.now() + TTL[purpose]).toISOString(), ts)
  return token
}

/** Looks a token up without using it. */
export function checkToken(db, token, purposes) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(sha256(token))
  if (!row || !purposes.includes(row.purpose)) return null
  if (row.used_at) return { ...row, state: 'used' }
  if (row.expires_at <= now()) return { ...row, state: 'expired' }
  return { ...row, state: 'valid' }
}

/** Uses a token exactly once (atomic): a second use, or an expired token, is refused. */
function consumeToken(db, token, purposes) {
  const row = checkToken(db, token, purposes)
  if (!row || row.state !== 'valid') throw new AppError(400, row?.state === 'expired' ? 'token_expired' : 'token_invalid', row?.state === 'expired' ? 'This link has expired. Ask for a new one.' : 'This link is not valid or was already used. Ask for a new one.')
  const used = db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), row.id).changes
  if (!used) throw new AppError(400, 'token_invalid', 'This link was already used. Ask for a new one.')
  return row
}

async function send(mailer, to, purpose, email) {
  if (!allowSend(`${purpose}:${to}`)) { console.log(`[auth] ${purpose} email not sent: rate limit for this address`); return false }
  try {
    await mailer.send({ to, ...email })
    console.log(`[auth] ${purpose} email accepted by ${mailer.provider}`)
    return true
  } catch (error) {
    console.log(`[auth] ${purpose} email FAILED via ${mailer.provider}: ${String(error.message).slice(0, 160)}`)
    return false
  }
}

const usersByEmail = (db, email) => db.prepare('SELECT * FROM users WHERE lower(email) = ? ORDER BY email_verified DESC, created_at').all(email)
const requireMail = (mailer) => {
  if (!mailer.configured) throw new AppError(503, 'email_not_configured', 'Email sign-up is not available yet: this server has no email provider configured. Use Continue with Google, or ask an administrator.')
}
const GENERIC_SENT = { ok: true, message: 'If this email can be used, we have sent it a link. Check your inbox (and spam folder).' }

/** Sign up. Always the same answer, whatever exists already. */
export async function register(db, mailer, cfg, body) {
  requireMail(mailer)
  const name = v.text(body?.name, 'Full name', { required: true, max: 120 })
  const email = v.email(body?.email)
  if (body?.password !== body?.confirmPassword) throw invalid('The two passwords do not match.', { field: 'confirmPassword' })
  checkPasswordPolicy(body?.password, { email, name })
  if (body?.acceptTerms !== true) throw invalid('Accept the terms to create an account.', { field: 'acceptTerms' })
  const hash = await hashPassword(body.password) // always, so the answer takes as long whether or not the email exists
  const existing = usersByEmail(db, email)
  const verified = existing.find((u) => u.email_verified)
  if (verified) {
    // Someone owns this mailbox already: tell the owner; never create a second account or change theirs.
    if (verified.password_hash) void send(mailer, email, 'already_registered', EMAILS.alreadyRegistered(verified.name, `${cfg.appUrl}/#/login`))
    else void send(mailer, email, 'link_password', EMAILS.linkPassword(verified.name, `${cfg.appUrl}/#/reset/${issueToken(db, verified.id, 'link_password')}`))
    authAudit(db, verified.id, 'auth.register_existing_email')
    return GENERIC_SENT
  }
  const ts = now()
  let user = existing[0]
  if (user) {
    // An unverified sign-up for this email: the latest one wins. Confirming needs the mailbox AND this password, so a
    // squatter who registered someone else's email can never get that account verified.
    db.prepare('UPDATE users SET name = ?, password_hash = ?, password_updated_at = ?, updated_at = ? WHERE id = ?').run(name, hash, ts, ts, user.id)
  } else {
    user = { id: uuid() }
    db.prepare(`INSERT INTO users (id, google_sub, email, email_verified, name, password_hash, password_updated_at, created_at, updated_at) VALUES (?, NULL, ?, 0, ?, ?, ?, ?, ?)`)
      .run(user.id, email, name, hash, ts, ts, ts)
  }
  authAudit(db, user.id, 'auth.registered')
  void send(mailer, email, 'verify_email', EMAILS.verify(name, `${cfg.appUrl}/#/verify/${issueToken(db, user.id, 'verify_email')}`))
  return GENERIC_SENT
}

export async function resendVerification(db, mailer, cfg, body) {
  requireMail(mailer)
  const email = v.email(body?.email)
  const u = usersByEmail(db, email).find((x) => !x.email_verified && x.password_hash)
  if (u) void send(mailer, email, 'verify_email', EMAILS.verify(u.name, `${cfg.appUrl}/#/verify/${issueToken(db, u.id, 'verify_email')}`))
  return GENERIC_SENT
}

/**
 * Confirms the mailbox. Needs the link (proof of the mailbox) AND the password chosen at sign-up (proof it is the same
 * person), so nobody can get an account they registered for someone else's email verified. Wrong passwords count
 * towards the lockout. Returns the user (the route signs them in).
 */
export async function verifyEmail(db, body) {
  const preview = checkToken(db, body?.token, ['verify_email'])
  if (!preview || preview.state !== 'valid') return consumeToken(db, body?.token, ['verify_email']) // throws the right error
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(preview.user_id)
  const password = typeof body?.password === 'string' ? body.password : ''
  const locked = user.locked_until && user.locked_until > now()
  if (locked || !user.password_hash || !password || password.length > 128 || !(await verifyPassword(password, user.password_hash))) {
    if (!locked && user.password_hash) {
      const fails = user.failed_logins + 1
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(fails >= LOCK_AFTER ? 0 : fails, fails >= LOCK_AFTER ? new Date(Date.now() + LOCK_MS).toISOString() : null, user.id)
      authAudit(db, user.id, fails >= LOCK_AFTER ? 'auth.login_locked' : 'auth.verify_wrong_password')
    }
    throw new AppError(401, 'invalid_login', 'That is not the password chosen when this account was created. If you did not create it, register again with your own password.')
  }
  return transaction(db, () => {
    consumeToken(db, body.token, ['verify_email'])
    const other = db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND email_verified = 1 AND id != ?').get(user.email.toLowerCase(), user.id)
    if (other) throw new AppError(409, 'email_in_use', 'This email already belongs to a verified account. Sign in to it instead.')
    const ts = now()
    db.prepare('UPDATE users SET email_verified = 1, email_verified_at = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(ts, ts, user.id)
    authAudit(db, user.id, 'auth.email_verified')
    return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  })
}

/** Email + password sign-in. One generic failure message; lockout after repeated failures. */
export async function login(db, mailer, cfg, body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!email || !password || password.length > 128) throw new AppError(401, 'invalid_login', GENERIC_LOGIN)
  const user = usersByEmail(db, email).find((u) => u.password_hash)
  if (!user) { await burnTime(password); throw new AppError(401, 'invalid_login', GENERIC_LOGIN) }
  if (user.locked_until && user.locked_until > now()) { await burnTime(password); throw new AppError(401, 'invalid_login', GENERIC_LOGIN) }
  if (!(await verifyPassword(password, user.password_hash))) {
    const fails = user.failed_logins + 1
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(fails >= LOCK_AFTER ? 0 : fails, fails >= LOCK_AFTER ? new Date(Date.now() + LOCK_MS).toISOString() : null, user.id)
    authAudit(db, user.id, fails >= LOCK_AFTER ? 'auth.login_locked' : 'auth.login_failed')
    throw new AppError(401, 'invalid_login', GENERIC_LOGIN)
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id)
  if (!user.email_verified) {
    if (mailer.configured) await send(mailer, user.email, 'verify_email', EMAILS.verify(user.name, `${cfg.appUrl}/#/verify/${issueToken(db, user.id, 'verify_email')}`))
    throw new AppError(403, 'email_not_verified', 'Confirm your email first: we have sent you a new link.')
  }
  const ts = now()
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, user.id)
  authAudit(db, user.id, 'auth.login_password')
  return user
}

/** Forgot password: same answer whether or not the email exists. Google-only accounts get a "set a password" link. */
export async function forgotPassword(db, mailer, cfg, body) {
  requireMail(mailer)
  const email = v.email(body?.email)
  const u = usersByEmail(db, email).find((x) => x.email_verified) || usersByEmail(db, email).find((x) => x.password_hash)
  if (u) {
    const purpose = u.password_hash ? 'reset_password' : 'link_password'
    void send(mailer, email, purpose, (purpose === 'reset_password' ? EMAILS.reset : EMAILS.linkPassword)(u.name, `${cfg.appUrl}/#/reset/${issueToken(db, u.id, purpose)}`))
    authAudit(db, u.id, 'auth.password_reset_requested')
  }
  return GENERIC_SENT
}

/** What a reset/link token is, without using it (the page shows the right form or a clear error). */
export function describeToken(db, body) {
  const t = checkToken(db, body?.token, ['reset_password', 'link_password'])
  if (!t) return { state: 'invalid' }
  return { state: t.state, purpose: t.purpose }
}

/**
 * Sets a new password from a reset or link-password token. The token proves the mailbox, so the email counts as
 * verified. Every existing session of the account ends.
 */
export async function resetPassword(db, body) {
  const preview = checkToken(db, body?.token, ['reset_password', 'link_password'])
  const user = preview ? db.prepare('SELECT * FROM users WHERE id = ?').get(preview.user_id) : null
  if (user) checkPasswordPolicy(body?.password, { email: user.email, name: user.name })
  if (body?.password !== body?.confirmPassword) throw invalid('The two passwords do not match.', { field: 'confirmPassword' })
  const hash = await hashPassword(String(body?.password || ''))
  return transaction(db, () => {
    const t = consumeToken(db, body?.token, ['reset_password', 'link_password'])
    const ts = now()
    db.prepare(`UPDATE users SET password_hash = ?, password_updated_at = ?, email_verified = 1, email_verified_at = COALESCE(email_verified_at, ?),
                failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`).run(hash, ts, ts, ts, t.user_id)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.user_id)
    db.prepare(`UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose IN ('reset_password','link_password') AND used_at IS NULL`).run(ts, t.user_id)
    authAudit(db, t.user_id, t.purpose === 'link_password' ? 'auth.password_added' : 'auth.password_reset')
    return db.prepare('SELECT * FROM users WHERE id = ?').get(t.user_id)
  })
}

/** Signed in: change the password (current one required); other sessions end. */
export async function changePassword(db, user, body, currentSessionToken) {
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  if (!fresh.password_hash) throw new AppError(409, 'no_password', 'Your account has no password yet. Use “Add password sign-in”.')
  if (!(await verifyPassword(String(body?.currentPassword || ''), fresh.password_hash))) throw new AppError(401, 'invalid_login', 'Your current password is incorrect.')
  checkPasswordPolicy(body?.password, { email: fresh.email, name: fresh.name })
  if (body?.password !== body?.confirmPassword) throw invalid('The two passwords do not match.', { field: 'confirmPassword' })
  const ts = now()
  db.prepare('UPDATE users SET password_hash = ?, password_updated_at = ?, updated_at = ? WHERE id = ?').run(await hashPassword(body.password), ts, ts, fresh.id)
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(fresh.id, sha256(currentSessionToken || ''))
  authAudit(db, fresh.id, 'auth.password_changed')
  return { ok: true }
}

/** Signed in with Google, no password yet: proof of the mailbox by an emailed link before a password is added. */
export async function requestPasswordLink(db, mailer, cfg, user) {
  requireMail(mailer)
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  if (fresh.password_hash) throw new AppError(409, 'has_password', 'Your account already has a password.')
  const sent = await send(mailer, fresh.email, 'link_password', EMAILS.linkPassword(fresh.name, `${cfg.appUrl}/#/reset/${issueToken(db, fresh.id, 'link_password')}`))
  authAudit(db, fresh.id, 'auth.password_link_requested')
  return { ok: sent, message: sent ? `We sent a link to ${fresh.email}.` : 'The email could not be sent right now. Try again later.' }
}

/**
 * Register with email + password, no email verification required.
 * The account is immediately verified and the caller signs the user in.
 */
export async function registerDirect(db, body) {
  const name = v.text(body?.name, 'Full name', { required: true, max: 120 })
  const email = v.email(body?.email)
  if (body?.password !== body?.confirmPassword) throw invalid('The two passwords do not match.', { field: 'confirmPassword' })
  checkPasswordPolicy(body?.password, { email, name })
  const hash = await hashPassword(body.password)
  const existing = usersByEmail(db, email)
  if (existing.some((u) => u.email_verified)) throw invalid('An account with this email already exists. Sign in instead.', { field: 'email' })
  const ts = now()
  let user = existing[0]
  if (user) {
    // Unverified record (e.g. from an earlier email-verification flow): take it over and verify it now.
    db.prepare('UPDATE users SET name = ?, email_verified = 1, email_verified_at = ?, password_hash = ?, password_updated_at = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(name, ts, hash, ts, ts, user.id)
  } else {
    user = { id: uuid() }
    db.prepare(`INSERT INTO users (id, google_sub, email, email_verified, email_verified_at, name, password_hash, password_updated_at, created_at, updated_at)
                VALUES (?, NULL, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(user.id, email, ts, name, hash, ts, ts, ts)
  }
  authAudit(db, user.id, 'auth.registered_direct')
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
}

export const signInMethods = (u) => ({ google: Boolean(u.google_sub), password: Boolean(u.password_hash) })

/**
 * Register with email+password via an invitation token: no email verification needed.
 * Returns the created/updated user. The caller must accept the invitation and set the session.
 */
export async function registerForInvitation(db, body, invitedEmail) {
  const name = v.text(body?.name, 'Full name', { required: true, max: 120 })
  const email = invitedEmail.toLowerCase()
  if (body?.password !== body?.confirmPassword) throw invalid('The two passwords do not match.', { field: 'confirmPassword' })
  checkPasswordPolicy(body?.password, { email, name })
  const hash = await hashPassword(body.password)
  const existing = usersByEmail(db, email)
  if (existing.some((u) => u.email_verified)) throw invalid('An account with this email already exists. Sign in to accept the invitation.', { field: 'email' })
  const ts = now()
  let user = existing[0]
  if (user) {
    db.prepare('UPDATE users SET name = ?, email_verified = 1, email_verified_at = ?, password_hash = ?, password_updated_at = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(name, ts, hash, ts, ts, user.id)
  } else {
    user = { id: uuid() }
    db.prepare(`INSERT INTO users (id, google_sub, email, email_verified, email_verified_at, name, password_hash, password_updated_at, created_at, updated_at)
                VALUES (?, NULL, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(user.id, email, ts, name, hash, ts, ts, ts)
  }
  authAudit(db, user.id, 'auth.registered_via_invitation')
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
}

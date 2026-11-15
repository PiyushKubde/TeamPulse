import { Router, type Request, type Response } from 'express'
import { hash, verify } from '@node-rs/argon2'
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema, verifyEmailSchema } from '@workpulse/shared'
import { prisma } from '../lib/prisma.js'
import { body } from '../lib/validate.js'
import { randomToken, sha256 } from '../lib/crypto.js'
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js'
import { env, isProd } from '../config/env.js'
import { mailConfigured, sendMail } from '../lib/mailer.js'
import { connectPhone } from '../services/phone-alerts.js'
import { platformConfigured } from '../lib/m91.js'
import { SESSION_COOKIE, requireAuth, userOf } from '../middleware/auth.js'

export const auth = Router()

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } // OWASP argon2id baseline
// Hash used when the email is unknown, so login timing does not reveal which emails exist.
const DUMMY_HASH = hash('dummy-password-for-timing', ARGON)

export async function startSession(res: Response, userId: string) {
  const token = randomToken()
  const membership = await prisma.organizationMember.findFirst({ where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } })
  await prisma.session.create({
    data: { userId, tokenHash: sha256(token), activeOrgId: membership?.orgId ?? null, expiresAt: new Date(Date.now() + env.SESSION_DAYS * 864e5) },
  })
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: env.SESSION_DAYS * 864e5, path: '/' })
}

async function issueToken(userId: string, kind: 'VERIFY_EMAIL' | 'RESET_PASSWORD', hours: number) {
  const token = randomToken()
  await prisma.authToken.create({ data: { userId, kind, tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * 36e5) } })
  return token
}

async function consumeToken(token: string, kind: 'VERIFY_EMAIL' | 'RESET_PASSWORD') {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } })
  if (!row || row.kind !== kind || row.usedAt || row.expiresAt < new Date()) throw badRequest('This link is invalid or has expired.')
  await prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } })
  return row.userId
}

export async function sendVerification(userId: string, email: string) {
  const token = await issueToken(userId, 'VERIFY_EMAIL', 48)
  return sendMail(
    email,
    'Verify your WorkPulse email',
    `Confirm your email address:\n\n${env.APP_URL}/verify-email?token=${token}\n\nThis link expires in 48 hours.`,
  )
}

export const hashPassword = (password: string) => hash(password, ARGON)

auth.post('/register', async (req, res) => {
  const input = body(req, registerSchema)
  if (await prisma.user.findUnique({ where: { email: input.email } })) throw conflict('An account with this email already exists.')
  const user = await prisma.user.create({ data: { email: input.email, name: input.name, passwordHash: await hashPassword(input.password) } })
  await sendVerification(user.id, user.email)
  // The number (if given) is invited to M91 right away, so urgent alerts can reach this person.
  await connectPhone(user.id, input.phone)
  await startSession(res, user.id)
  res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, emailVerified: false } })
})

auth.post('/login', async (req, res) => {
  const input = body(req, loginSchema)
  const user = await prisma.user.findUnique({ where: { email: input.email } })
  const ok = user?.passwordHash ? await verify(user.passwordHash, input.password) : (await verify(await DUMMY_HASH, input.password), false)
  if (!user || !ok) throw unauthorized('Email or password is incorrect.')
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) throw forbidden('Verify your email address before signing in.')
  await startSession(res, user.id)
  res.json({ user: { id: user.id, email: user.email, name: user.name } })
})

auth.post('/logout', async (req: Request, res) => {
  if (req.auth) await prisma.session.delete({ where: { id: req.auth.sessionId } }).catch(() => undefined)
  res.clearCookie(SESSION_COOKIE, { path: '/' })
  res.status(204).end()
})

auth.post('/forgot-password', async (req, res) => {
  const { email } = body(req, forgotPasswordSchema)
  const user = await prisma.user.findUnique({ where: { email } })
  if (user) {
    const token = await issueToken(user.id, 'RESET_PASSWORD', 1)
    await sendMail(
      email,
      'Reset your WorkPulse password',
      `Choose a new password:\n\n${env.APP_URL}/reset-password?token=${token}\n\nThis link expires in 1 hour. If you did not ask for it, ignore this email.`,
    )
  }
  // Same answer whether or not the email exists.
  res.json({ ok: true })
})

auth.post('/reset-password', async (req, res) => {
  const input = body(req, resetPasswordSchema)
  const userId = await consumeToken(input.token, 'RESET_PASSWORD')
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(input.password) } }),
    prisma.session.deleteMany({ where: { userId } }),
  ])
  res.json({ ok: true })
})

auth.post('/verify-email', async (req, res) => {
  const { token } = body(req, verifyEmailSchema)
  const userId = await consumeToken(token, 'VERIFY_EMAIL')
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } })
  res.json({ ok: true })
})

auth.post('/resend-verification', requireAuth, async (req, res) => {
  const user = userOf(req)
  if (user.emailVerifiedAt) return res.json({ ok: true, delivered: true })
  const r = await sendVerification(user.id, user.email)
  if (!r.delivered)
    throw new HttpError(
      503,
      'mail_not_configured',
      'WorkPulse could not send the email: no email sender is set up (connect Gmail in Integrations or configure SMTP).',
    )
  res.json({ ok: true, delivered: true })
})

auth.get('/me', requireAuth, async (req, res) => {
  const user = userOf(req)
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    include: { org: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const active = memberships.find((m) => m.orgId === req.auth!.activeOrgId)
  res.json({
    user: { id: user.id, email: user.email, name: user.name, emailVerified: Boolean(user.emailVerifiedAt) },
    activeOrgId: active?.orgId ?? null,
    role: active?.role ?? null,
    organizations: memberships.map((m) => ({ ...m.org, role: m.role })),
    mailConfigured: await mailConfigured(),
    phoneAlerts: await prisma.user
      .findUniqueOrThrow({ where: { id: user.id }, select: { phone: true, phoneAlertState: true } })
      .then((u) => ({ available: platformConfigured(), hasPhone: Boolean(u.phone), state: u.phoneAlertState })),
  })
})

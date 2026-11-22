import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { sha256 } from '../lib/crypto.js'
import { buildCtx, type Ctx } from '../lib/scope.js'
import { forbidden, unauthorized } from '../lib/errors.js'

export const SESSION_COOKIE = 'wp_session'

declare module 'express-serve-static-core' {
  interface Request {
    auth?: { user: { id: string; email: string; name: string; emailVerifiedAt: Date | null }; sessionId: string; activeOrgId: string | null }
    ctx?: Ctx
  }
}

/** Reads the session cookie if present. Never fails; routes decide whether a session is required. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined
  if (token) {
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { id: true, email: true, name: true, emailVerifiedAt: true } } },
    })
    if (session && session.expiresAt > new Date()) {
      req.auth = { user: session.user, sessionId: session.id, activeOrgId: session.activeOrgId }
    }
  }
  next()
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized())
  next()
}

/** Resolves the active organization from the session and builds the caller's scope. */
export async function requireOrg(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized())
  const orgId = req.auth.activeOrgId
  if (!orgId) return next(forbidden('Create or join an organization first.'))
  const ctx = await buildCtx(req.auth.user.id, orgId)
  if (!ctx) return next(forbidden('You are not an active member of this organization.'))
  req.ctx = ctx
  next()
}

export const ctxOf = (req: Request): Ctx => {
  if (!req.ctx) throw unauthorized()
  return req.ctx
}
export const userOf = (req: Request) => {
  if (!req.auth) throw unauthorized()
  return req.auth.user
}

import type { Request } from 'express'
import { prisma, type Prisma } from './prisma.js'

export async function audit(
  req: Request | null,
  orgId: string,
  action: string,
  target: { type: string; id?: string | null },
  diff: Prisma.InputJsonValue = {},
) {
  await prisma.auditLog.create({
    data: { orgId, actorId: req?.auth?.user.id ?? null, action, targetType: target.type, targetId: target.id ?? null, diff, ip: req?.ip ?? null },
  })
}

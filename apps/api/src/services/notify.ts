import { prisma } from '../lib/prisma.js'

/** In-app notification. dedupeKey makes repeated triggers (retries, scheduled scans) idempotent. */
export async function notify(input: { orgId: string; userId: string; kind: string; title: string; body?: string; link?: string; dedupeKey: string }) {
  await prisma.notification.upsert({ where: { dedupeKey: input.dedupeKey }, create: input, update: {} })
}

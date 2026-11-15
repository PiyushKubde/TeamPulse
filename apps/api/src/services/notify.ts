import { prisma } from '../lib/prisma.js'
import { enqueue } from '../jobs/queues.js'

/** In-app notification. dedupeKey makes repeated triggers (retries, scheduled scans) idempotent. New notifications of
 *  the moments people chose also ring their phone (services/phone-alerts.ts decides which), from the worker. */
export async function notify(input: { orgId: string; userId: string; kind: string; title: string; body?: string; link?: string; dedupeKey: string }) {
  const exists = await prisma.notification.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } })
  if (exists) return
  await prisma.notification.upsert({ where: { dedupeKey: input.dedupeKey }, create: input, update: {} })
  await enqueue('delivery', 'phone', input).catch(() => undefined)
}

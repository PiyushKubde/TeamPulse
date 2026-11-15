// POST /api/integrations/events/:provider/:subscriptionId — called by the handler KONVO installed on viaSocket.
// Authenticated by a per-subscription bearer token (stored as a hash). Never trusts the payload: it is stored as
// data and validated by the provider adapter in the background. Duplicates (retries, replays) are absorbed by the
// unique (orgId, provider, idempotencyKey) constraint.
import { Router } from 'express'
import { createHash } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { safeEqualHex, sha256 } from '../lib/crypto.js'
import { HttpError } from '../lib/errors.js'
import { enqueue } from '../jobs/queues.js'
import { provider } from './catalog.js'
import { ADAPTERS } from './providers/index.js'

export const events = Router()

events.post('/:provider/:subscriptionId', async (req, res) => {
  const { provider: slug, subscriptionId } = req.params
  const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId) || token.length < 20) throw new HttpError(401, 'unauthorized', 'Invalid credentials.')
  const sub = await prisma.integrationSubscription.findUnique({ where: { id: subscriptionId }, include: { connection: true } })
  // Same answer for unknown subscription and wrong token: nothing about which ids exist leaks.
  if (!sub || !safeEqualHex(sha256(token), sub.tokenHash) || sub.connection.provider !== slug) throw new HttpError(401, 'unauthorized', 'Invalid credentials.')
  if (sub.status !== 'ACTIVE' || sub.connection.status === 'REVOKED') throw new HttpError(410, 'gone', 'This subscription is no longer active.')
  const payload = (req.body as { event?: unknown })?.event
  if (payload == null || typeof payload !== 'object') throw new HttpError(400, 'bad_request', 'Expected { event: {...} }.')
  // Provider verification tokens are not needed and are never stored (Slack's Events API envelope carries one).
  for (const k of ['token', 'authorizations', 'viasocketHelp']) delete (payload as Record<string, unknown>)[k]

  const trigger = provider(slug)?.triggers.find((t) => t.key === sub.triggerKey)
  const bodyHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const key = ADAPTERS[slug]?.idempotencyKey(trigger?.kind ?? 'task', payload, `hash:${bodyHash}`, sub.resource) ?? `hash:${bodyHash}`
  let eventId: string
  try {
    const row = await prisma.syncEvent.create({
      data: {
        orgId: sub.connection.orgId,
        subscriptionId: sub.id,
        connectionId: sub.connectionId,
        provider: slug,
        eventType: sub.triggerKey,
        idempotencyKey: key.slice(0, 500),
        payload: payload as object,
      },
    })
    eventId = row.id
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return res.status(200).json({ ok: true, duplicate: true })
    throw e
  }
  await prisma.integrationSubscription.update({ where: { id: sub.id }, data: { lastEventAt: new Date() } })
  // Never block the caller on processing; a slow or failing ingest is retried in the background.
  await enqueue('ingest', 'event', { eventId }, { jobId: eventId })
  res.status(202).json({ ok: true, eventId })
})

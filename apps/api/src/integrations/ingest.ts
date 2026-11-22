// Background processing of received SyncEvents. Each event is processed at most once to a final state; failures
// retry with backoff (BullMQ) and land in DEAD after the last attempt, visible in Sync History with a Retry button.
import { prisma } from '../lib/prisma.js'
import { logger } from '../config/logger.js'
import { aiStatus } from '../ai/provider.js'
import { suggestEvidenceMatch, suggestMapping } from '../ai/features.js'
import { notify } from '../services/notify.js'
import { provider } from './catalog.js'
import { ADAPTERS } from './providers/index.js'
import { applyComment, applyEvidence, applyTask, type ApplyResult } from './normalization/normalizer.js'
import { applyIntake, confirmationText } from './intake.js'
import { deliverToSlack } from './delivery.js'

export const MAX_ATTEMPTS = 5

/** Thrown for problems a retry cannot fix (invalid payload): the event fails immediately, no retries. */
export class PermanentError extends Error {}

export async function processSyncEvent(eventId: string, opts: { attempt?: number; backfill?: boolean } = {}) {
  const event = await prisma.syncEvent.findUnique({ where: { id: eventId }, include: { subscription: { include: { connection: true } } } })
  if (!event) return null
  if (['PROCESSED', 'SKIPPED_STALE', 'SKIPPED_DUPLICATE'].includes(event.status)) return event.status
  const conn = event.subscription?.connection
  if (!conn || conn.status === 'REVOKED') {
    await prisma.syncEvent.update({ where: { id: eventId }, data: { status: 'FAILED', error: 'The connection was removed.', processedAt: new Date() } })
    return 'FAILED'
  }
  const trigger = provider(event.provider)?.triggers.find((t) => t.key === event.subscription!.triggerKey)
  const adapter = ADAPTERS[event.provider]
  await prisma.syncEvent.update({ where: { id: eventId }, data: { status: 'PROCESSING', attempts: { increment: 1 } } })
  try {
    if (!trigger || !adapter) throw new PermanentError(`No adapter for ${event.provider} ${event.subscription!.triggerKey}.`)
    let normalized
    try {
      normalized = adapter.normalize(trigger.kind, event.payload, event.subscription!.resource)
    } catch (e) {
      throw new PermanentError(`Invalid payload: ${e instanceof Error ? e.message.slice(0, 400) : 'unreadable'}`)
    }
    const results: ApplyResult[] = []
    for (const item of normalized.items) {
      if (normalized.type === 'task') results.push(await applyTask(conn, item as never, { backfill: opts.backfill }))
      else if (normalized.type === 'comment') results.push(await applyComment(conn, item as never))
      else if (normalized.type === 'intake') {
        const r = await applyIntake(conn, item as never)
        results.push(r)
        if (r.outcome === 'created' && r.taskId && r.taskTitle) {
          await deliverToSlack(conn.userId, conn.orgId, confirmationText(r.taskTitle, r.taskId), `slack-confirm:${r.taskId}`).catch((e) =>
            logger.info({ err: e?.message }, 'slack confirmation not sent'),
          )
        }
      } else {
        const r = await applyEvidence(conn, item as never)
        results.push(r)
        if (!r.taskId && r.evidenceId) await suggestMatch(conn.userId, conn.orgId, r.evidenceId)
      }
    }
    const stale = results.length > 0 && results.every((r) => r.outcome === 'stale')
    const needsMapping = results.some((r) => r.flagged.some((f) => !f.startsWith('created without AI')))
    const note =
      results
        .map((r) => ('reason' in r ? r.reason : r.flagged.length ? `Needs review: ${r.flagged.join(', ')}` : null))
        .filter(Boolean)
        .join(' ') || null
    await prisma.syncEvent.update({
      where: { id: eventId },
      data: {
        status: stale ? 'SKIPPED_STALE' : needsMapping ? 'NEEDS_MAPPING' : 'PROCESSED',
        error: note,
        taskId: results.find((r) => r.taskId)?.taskId ?? null,
        processedAt: new Date(),
      },
    })
    await prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), lastError: null } })
    if (needsMapping && aiStatus().configured) await suggestMappings(conn.userId, conn.orgId, event.provider)
    return stale ? 'SKIPPED_STALE' : 'PROCESSED'
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 500) : 'Unknown error'
    const permanent = e instanceof PermanentError
    const dead = permanent || (opts.attempt ?? event.attempts + 1) >= MAX_ATTEMPTS
    await prisma.syncEvent.update({ where: { id: eventId }, data: { status: dead ? (permanent ? 'FAILED' : 'DEAD') : 'FAILED', error: message } })
    await prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastError: message } })
    if (dead) {
      await notify({
        orgId: conn.orgId,
        userId: conn.userId,
        kind: 'integration_failure',
        title: `${provider(event.provider)?.name ?? event.provider} sync failed`,
        body: message,
        link: '/sync-history',
        dedupeKey: `sync-dead:${eventId}`,
      })
      logger.warn({ eventId, provider: event.provider, error: message }, 'sync event dead-lettered')
    }
    if (!permanent) throw e // let BullMQ retry with backoff
    return 'FAILED'
  }
}

/** AI suggestions for pending (inactive) mappings with no suggestion yet. Suggestions are never activated automatically. */
async function suggestMappings(userId: string, orgId: string, providerSlug: string) {
  const pending = await prisma.syncMapping.findMany({ where: { orgId, provider: providerSlug, active: false, source: 'DEFAULT', approvedAt: null }, take: 5 })
  for (const m of pending) {
    if (m.kind === 'FIELD') continue
    try {
      const s = await suggestMapping(userId, providerSlug, m.kind, m.fromValue)
      await prisma.syncMapping.update({ where: { id: m.id }, data: { toValue: s.toValue, confidence: s.confidence, source: 'AI' } })
    } catch (e) {
      logger.info({ err: e instanceof Error ? e.message : e }, 'mapping suggestion skipped')
    }
  }
}

async function suggestMatch(userId: string, orgId: string, evidenceId: string) {
  if (!aiStatus().configured) return
  const ev = await prisma.evidence.findUnique({ where: { id: evidenceId } })
  if (!ev || ev.taskId || ev.suggestedTaskId) return
  const candidates = await prisma.task.findMany({
    where: {
      orgId,
      deletedAt: null,
      assigneeId: userId,
      status: { in: ['IN_PROGRESS', 'IN_REVIEW', 'COMPLETED'] },
      updatedAt: { gte: new Date(Date.now() - 30 * 864e5) },
    },
    select: { id: true, title: true, source: { select: { externalKey: true } } },
    take: 40,
  })
  try {
    const s = await suggestEvidenceMatch(
      userId,
      { title: ev.title, meta: ev.sourceMeta },
      candidates.map((c) => ({ id: c.id, title: c.title, key: c.source?.externalKey ?? null })),
    )
    if (s && s.confidence >= 0.5) await prisma.evidence.update({ where: { id: ev.id }, data: { suggestedTaskId: s.taskId, matchConfidence: s.confidence } })
  } catch (e) {
    logger.info({ err: e instanceof Error ? e.message : e }, 'evidence match suggestion skipped')
  }
}

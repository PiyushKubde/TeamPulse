// Linear adapter. Accepts Linear's webhook envelope ({ action, type, data, updatedFrom }) or the bare issue/comment.
// Field names follow Linear's webhook/GraphQL schema; confirmed against a real sampleEvent before going live.
import { z } from 'zod'
import type { Normalized, NormalizedComment, NormalizedTask } from '../normalization/types.js'

const date = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null || v === '' ? null : new Date(v)))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), 'invalid date')

const issue = z.looseObject({
  id: z.string().min(1),
  identifier: z.string().nullish(),
  title: z.string().min(1).max(2000),
  description: z.string().nullish(),
  url: z.string().nullish(),
  priority: z.union([z.number(), z.string()]).nullish(),
  priorityLabel: z.string().nullish(),
  state: z.looseObject({ name: z.string().nullish(), type: z.string().nullish() }).nullish(),
  assignee: z.looseObject({ id: z.string().nullish(), name: z.string().nullish(), email: z.string().nullish() }).nullish(),
  dueDate: date,
  updatedAt: date,
  archivedAt: date,
  labels: z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({ nodes: z.array(z.looseObject({ name: z.string() })) })]).nullish(),
})

const comment = z.looseObject({
  id: z.string().min(1),
  body: z.string().max(20000),
  issueId: z.string().nullish(),
  issue: z.looseObject({ id: z.string() }).nullish(),
  user: z.looseObject({ name: z.string().nullish() }).nullish(),
  createdAt: date,
})

const envelope = z.looseObject({ action: z.string().optional(), type: z.string().optional(), data: z.unknown(), webhookTimestamp: z.number().optional() })

function unwrap(body: unknown) {
  const e = envelope.safeParse(body)
  return e.success && e.data.data && typeof e.data.data === 'object' ? { record: e.data.data, action: e.data.action ?? null } : { record: body, action: null }
}

export function normalizeIssue(body: unknown): NormalizedTask {
  const { record, action } = unwrap(body)
  const i = issue.parse(record)
  const labels = Array.isArray(i.labels) ? i.labels : (i.labels?.nodes ?? [])
  return {
    provider: 'linear',
    externalId: i.id,
    externalKey: i.identifier ?? null,
    title: i.title,
    description: i.description ?? null,
    rawStatus: i.state?.name ?? null,
    rawStatusCategory: i.state?.type ?? null,
    rawPriority: i.priority != null ? String(i.priority) : (i.priorityLabel ?? null),
    assignee: i.assignee ? { externalId: i.assignee.id ?? null, email: i.assignee.email ?? null, name: i.assignee.name ?? null } : null,
    dueAt: i.dueDate,
    labels: labels.map((l) => l.name).slice(0, 20),
    sourceUrl: i.url ?? null,
    externalUpdatedAt: i.updatedAt,
    revision: null,
    deleted: action === 'remove' || Boolean(i.archivedAt),
  }
}

export function normalizeComment(body: unknown): NormalizedComment {
  const c = comment.parse(unwrap(body).record)
  const issueId = c.issueId ?? c.issue?.id
  if (!issueId) throw new Error('comment without issue id')
  return { provider: 'linear', externalId: c.id, issueExternalId: issueId, body: c.body, author: c.user?.name ?? null, createdAt: c.createdAt }
}

export function normalize(kind: string, body: unknown): Normalized {
  if (kind === 'comment') return { type: 'comment', items: [normalizeComment(body)] }
  return { type: 'task', items: [normalizeIssue(body)] }
}

/** Idempotency key: the issue id plus its updatedAt (a retried delivery of the same change has the same key). */
export function idempotencyKey(kind: string, body: unknown, fallback: string) {
  try {
    if (kind === 'comment') return `comment:${normalizeComment(body).externalId}`
    const n = normalizeIssue(body)
    return `${n.externalId}:${n.externalUpdatedAt?.toISOString() ?? fallback}`
  } catch {
    return fallback
  }
}

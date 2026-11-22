// Jira Software Cloud adapter. Accepts Jira's webhook envelope ({ webhookEvent, issue, timestamp }) or a bare issue.
import { z } from 'zod'
import type { Normalized, NormalizedTask } from '../normalization/types.js'

const date = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null || v === '' ? null : new Date(v)))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), 'invalid date')

/** Jira descriptions are plain text (v2) or Atlassian Document Format (v3); ADF is flattened to text. */
function adfText(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as { text?: string; content?: unknown[]; type?: string }
  const inner = (n.content ?? []).map(adfText).join(n.type === 'doc' ? '\n' : '')
  return (n.text ?? '') + inner + (n.type === 'paragraph' ? '\n' : '')
}

const issue = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  key: z.string().nullish(),
  self: z.string().nullish(),
  fields: z.looseObject({
    summary: z.string().min(1).max(2000),
    description: z.unknown().nullish(),
    status: z.looseObject({ name: z.string().nullish(), statusCategory: z.looseObject({ key: z.string().nullish() }).nullish() }).nullish(),
    priority: z.looseObject({ name: z.string().nullish() }).nullish(),
    assignee: z.looseObject({ accountId: z.string().nullish(), emailAddress: z.string().nullish(), displayName: z.string().nullish() }).nullish(),
    duedate: date,
    updated: date,
    labels: z.array(z.string()).nullish(),
  }),
})

const envelope = z.looseObject({ webhookEvent: z.string().optional(), issue: z.unknown().optional() })

export function normalizeIssue(body: unknown): NormalizedTask {
  const e = envelope.safeParse(body)
  const record = e.success && e.data.issue ? e.data.issue : body
  const i = issue.parse(record)
  const base = i.self ? i.self.replace(/\/rest\/api\/.*$/, '') : null
  const desc = i.fields.description == null ? null : adfText(i.fields.description).trim().slice(0, 20000) || null
  return {
    provider: 'jira-software-cloud',
    externalId: i.id,
    externalKey: i.key ?? null,
    title: i.fields.summary,
    description: desc,
    rawStatus: i.fields.status?.name ?? null,
    rawStatusCategory: i.fields.status?.statusCategory?.key ?? null,
    rawPriority: i.fields.priority?.name ?? null,
    assignee: i.fields.assignee
      ? { externalId: i.fields.assignee.accountId ?? null, email: i.fields.assignee.emailAddress ?? null, name: i.fields.assignee.displayName ?? null }
      : null,
    dueAt: i.fields.duedate,
    labels: (i.fields.labels ?? []).slice(0, 20),
    sourceUrl: base && i.key ? `${base}/browse/${i.key}` : null,
    externalUpdatedAt: i.fields.updated,
    revision: null,
    deleted: e.success && e.data.webhookEvent === 'jira:issue_deleted',
  }
}

export function normalize(_kind: string, body: unknown): Normalized {
  // Find_Issue_via_JQL (backfill) answers a list or { issues: [] }.
  const list = Array.isArray(body) ? body : (body as { issues?: unknown[] } | null)?.issues
  if (Array.isArray(list)) return { type: 'task', items: list.map(normalizeIssue) }
  return { type: 'task', items: [normalizeIssue(body)] }
}

export function idempotencyKey(_kind: string, body: unknown, fallback: string) {
  try {
    const n = normalizeIssue(body)
    return `${n.externalId}:${n.externalUpdatedAt?.toISOString() ?? fallback}`
  } catch {
    return fallback
  }
}

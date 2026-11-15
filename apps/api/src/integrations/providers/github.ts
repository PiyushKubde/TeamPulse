// GitHub adapter: pull requests, commits and releases become evidence; issues (opt-in) become tasks.
import { z } from 'zod'
import type { Normalized, NormalizedEvidence, NormalizedTask } from '../normalization/types.js'

const date = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null || v === '' ? null : new Date(v)))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), 'invalid date')
const user = z.looseObject({ login: z.string().nullish(), email: z.string().nullish() }).nullish()

const pr = z.looseObject({
  action: z.string().nullish(),
  number: z.number().nullish(),
  repository: z.looseObject({ full_name: z.string() }).nullish(),
  pull_request: z.looseObject({
    id: z.union([z.number(), z.string()]).transform(String),
    number: z.number(),
    title: z.string().max(2000),
    body: z.string().nullish(),
    html_url: z.string().nullish(),
    state: z.string().nullish(),
    merged: z.boolean().nullish(),
    merged_at: date,
    updated_at: date,
    user,
    head: z.looseObject({ ref: z.string().nullish() }).nullish(),
    additions: z.number().nullish(),
    deletions: z.number().nullish(),
  }),
})

const commit = z.looseObject({
  sha: z.string().min(7),
  html_url: z.string().nullish(),
  commit: z.looseObject({ message: z.string().max(20000), author: z.looseObject({ name: z.string().nullish(), email: z.string().nullish(), date }).nullish() }),
  author: user,
})

const release = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  tag_name: z.string().nullish(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  html_url: z.string().nullish(),
  published_at: date,
  author: user,
})

const ghIssue = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  number: z.number(),
  title: z.string().min(1).max(2000),
  body: z.string().nullish(),
  html_url: z.string().nullish(),
  state: z.string().nullish(),
  state_reason: z.string().nullish(),
  assignee: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String).nullish(), login: z.string().nullish() }).nullish(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).nullish(),
  updated_at: date,
  pull_request: z.unknown().optional(),
})

/** Polled GitHub triggers deliver a list[]; instant ones a single object. */
const asList = (body: unknown) =>
  Array.isArray(body) ? body : Array.isArray((body as { list?: unknown[] })?.list) ? (body as { list: unknown[] }).list : [body]

export function normalizePr(body: unknown): NormalizedEvidence {
  const e = pr.parse(body)
  const p = e.pull_request
  const repo = e.repository?.full_name ?? ''
  return {
    provider: 'github',
    externalId: `pr:${repo}#${p.number}:${p.merged ? 'merged' : (p.state ?? e.action ?? 'open')}`,
    kind: 'PULL_REQUEST',
    title: `${p.merged ? 'Merged' : p.state === 'closed' ? 'Closed' : 'Opened'} PR #${p.number}: ${p.title}`.slice(0, 200),
    url: p.html_url ?? null,
    searchText: [p.title, p.head?.ref, p.body?.slice(0, 2000)].filter(Boolean).join(' '),
    meta: {
      repo,
      number: p.number,
      state: p.state,
      merged: p.merged ?? false,
      mergedAt: p.merged_at,
      author: p.user?.login,
      branch: p.head?.ref,
      additions: p.additions,
      deletions: p.deletions,
    },
    occurredAt: p.merged_at ?? p.updated_at,
  }
}

export function normalizeCommit(body: unknown, repo = ''): NormalizedEvidence {
  const c = commit.parse(body)
  const first = c.commit.message.split('\n')[0]!.slice(0, 180)
  return {
    provider: 'github',
    externalId: `commit:${c.sha}`,
    kind: 'COMMIT',
    title: `Commit ${c.sha.slice(0, 7)}: ${first}`,
    url: c.html_url ?? null,
    searchText: c.commit.message.slice(0, 2000),
    meta: { repo, sha: c.sha, author: c.author?.login ?? c.commit.author?.name, authorEmail: c.commit.author?.email },
    occurredAt: c.commit.author?.date ?? null,
  }
}

export function normalizeRelease(body: unknown, repo = ''): NormalizedEvidence {
  const r = release.parse(body)
  return {
    provider: 'github',
    externalId: `release:${r.id}`,
    kind: 'RELEASE',
    title: `Release ${r.name || r.tag_name || r.id}`.slice(0, 200),
    url: r.html_url ?? null,
    searchText: [r.name, r.tag_name, r.body?.slice(0, 4000)].filter(Boolean).join(' '),
    meta: { repo, tag: r.tag_name, author: r.author?.login, publishedAt: r.published_at },
    occurredAt: r.published_at,
  }
}

export function normalizeIssue(body: unknown, repo = ''): NormalizedTask {
  const i = ghIssue.parse((body as { issue?: unknown })?.issue ?? body)
  return {
    provider: 'github',
    externalId: i.id,
    externalKey: repo ? `${repo}#${i.number}` : `#${i.number}`,
    title: i.title,
    description: i.body ?? null,
    rawStatus: null,
    rawStatusCategory: i.state === 'closed' && i.state_reason === 'not_planned' ? 'not_planned' : (i.state ?? 'open'),
    rawPriority: null,
    assignee: i.assignee ? { externalId: i.assignee.id ?? null, email: null, name: i.assignee.login ?? null } : null,
    dueAt: null,
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).slice(0, 20),
    sourceUrl: i.html_url ?? null,
    externalUpdatedAt: i.updated_at,
    revision: null,
    deleted: false,
  }
}

export function normalize(kind: string, body: unknown, resource = ''): Normalized {
  if (kind === 'evidence_pr') return { type: 'evidence', items: [normalizePr(body)] }
  if (kind === 'evidence_commit') return { type: 'evidence', items: asList(body).map((c) => normalizeCommit(c, resource)) }
  if (kind === 'evidence_release') return { type: 'evidence', items: asList(body).map((r) => normalizeRelease(r, resource)) }
  return {
    type: 'task',
    items: asList(body)
      .filter((i) => !(i as { pull_request?: unknown })?.pull_request)
      .map((i) => normalizeIssue(i, resource)),
  }
}

export function idempotencyKey(kind: string, body: unknown, fallback: string, resource = '') {
  try {
    const n = normalize(kind, body, resource)
    return (
      n.items
        .map((i) => ('externalUpdatedAt' in i ? `${i.externalId}:${i.externalUpdatedAt?.toISOString() ?? ''}` : i.externalId))
        .join('|')
        .slice(0, 500) || fallback
    )
  } catch {
    return fallback
  }
}

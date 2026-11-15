import type { Priority, TaskStatus } from '@workpulse/shared'

/** The common shape every provider adapter produces. Only these fields can ever reach a task from outside. */
export interface NormalizedTask {
  provider: string
  externalId: string
  externalKey: string | null
  title: string
  description: string | null
  /** Provider's own status words, mapped to WorkPulse by status-mapping. */
  rawStatus: string | null
  /** Provider's status category when it has one (Linear state.type, Jira statusCategory.key). */
  rawStatusCategory: string | null
  rawPriority: string | null
  assignee: { externalId: string | null; email: string | null; name: string | null } | null
  dueAt: Date | null
  labels: string[]
  sourceUrl: string | null
  /** For ordering: events at or before the stored value are stale. */
  externalUpdatedAt: Date | null
  revision: string | null
  deleted: boolean
}

export interface NormalizedComment {
  provider: string
  externalId: string
  issueExternalId: string
  body: string
  author: string | null
  createdAt: Date | null
}

export interface NormalizedEvidence {
  provider: string
  externalId: string
  kind: 'PULL_REQUEST' | 'COMMIT' | 'RELEASE'
  title: string
  url: string | null
  /** Free text searched for task keys (ENG-42, PROJ-7): title, branch, body. */
  searchText: string
  meta: Record<string, unknown>
  occurredAt: Date | null
}

export type Normalized =
  { type: 'task'; items: NormalizedTask[] } | { type: 'comment'; items: NormalizedComment[] } | { type: 'evidence'; items: NormalizedEvidence[] }

export type { Priority, TaskStatus }

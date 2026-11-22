import type { Priority, TaskStatus } from '@workpulse/shared'

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')

/** Known status names across providers (lowercased). */
const STATUS_NAMES: Record<string, TaskStatus> = {
  backlog: 'BACKLOG',
  triage: 'BACKLOG',
  icebox: 'BACKLOG',
  todo: 'TODO',
  'to do': 'TODO',
  open: 'TODO',
  new: 'TODO',
  unstarted: 'TODO',
  'selected for development': 'TODO',
  ready: 'TODO',
  'in progress': 'IN_PROGRESS',
  started: 'IN_PROGRESS',
  doing: 'IN_PROGRESS',
  'in development': 'IN_PROGRESS',
  'in review': 'IN_REVIEW',
  review: 'IN_REVIEW',
  'code review': 'IN_REVIEW',
  'ready for review': 'IN_REVIEW',
  qa: 'IN_REVIEW',
  testing: 'IN_REVIEW',
  blocked: 'BLOCKED',
  'on hold': 'BLOCKED',
  done: 'COMPLETED',
  completed: 'COMPLETED',
  closed: 'COMPLETED',
  resolved: 'COMPLETED',
  merged: 'COMPLETED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  "won't do": 'CANCELLED',
  'wont do': 'CANCELLED',
  duplicate: 'CANCELLED',
  'not planned': 'CANCELLED',
}

/** Provider status categories: Linear state.type, Jira statusCategory.key, GitHub issue state. */
const STATUS_CATEGORIES: Record<string, Record<string, TaskStatus>> = {
  linear: { backlog: 'BACKLOG', triage: 'BACKLOG', unstarted: 'TODO', started: 'IN_PROGRESS', completed: 'COMPLETED', canceled: 'CANCELLED' },
  'jira-software-cloud': { new: 'TODO', indeterminate: 'IN_PROGRESS', done: 'COMPLETED' },
  github: { open: 'TODO', closed: 'COMPLETED', not_planned: 'CANCELLED' },
}

export type MappingResult<T> = { value: T; source: 'ORG' | 'NAME' | 'CATEGORY' | 'FALLBACK' }

/**
 * Org-approved mappings win, then known names, then the provider's category. Anything else falls back (TODO) and
 * is flagged for a person to map: an unknown value never silently becomes something meaningful.
 */
export function mapStatus(provider: string, raw: string | null, category: string | null, orgMap: Map<string, string>): MappingResult<TaskStatus> {
  if (raw) {
    const approved = orgMap.get(norm(raw))
    if (approved) return { value: approved as TaskStatus, source: 'ORG' }
    const named = STATUS_NAMES[norm(raw)]
    if (named) return { value: named, source: 'NAME' }
  }
  const cat = category ? STATUS_CATEGORIES[provider]?.[category.toLowerCase()] : undefined
  if (cat) return { value: cat, source: 'CATEGORY' }
  return { value: 'TODO', source: 'FALLBACK' }
}

const PRIORITY_NAMES: Record<string, Priority> = {
  urgent: 'CRITICAL',
  critical: 'CRITICAL',
  highest: 'CRITICAL',
  blocker: 'CRITICAL',
  p0: 'CRITICAL',
  '1': 'CRITICAL',
  high: 'HIGH',
  major: 'HIGH',
  p1: 'HIGH',
  '2': 'HIGH',
  medium: 'MEDIUM',
  normal: 'MEDIUM',
  p2: 'MEDIUM',
  '3': 'MEDIUM',
  low: 'LOW',
  lowest: 'LOW',
  minor: 'LOW',
  trivial: 'LOW',
  p3: 'LOW',
  p4: 'LOW',
  '4': 'LOW',
  // Linear 0 / "No priority": a deliberate "not set", mapped to the neutral default without a flag.
  '0': 'MEDIUM',
  'no priority': 'MEDIUM',
  none: 'MEDIUM',
}

export function mapPriority(raw: string | null, orgMap: Map<string, string>): MappingResult<Priority> {
  if (raw == null || raw === '') return { value: 'MEDIUM', source: 'NAME' }
  const approved = orgMap.get(norm(raw))
  if (approved) return { value: approved as Priority, source: 'ORG' }
  const named = PRIORITY_NAMES[norm(raw)]
  if (named) return { value: named, source: 'NAME' }
  return { value: 'MEDIUM', source: 'FALLBACK' }
}

export const normKey = norm

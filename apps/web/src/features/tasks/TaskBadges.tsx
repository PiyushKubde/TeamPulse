import { AlertOctagon, ExternalLink, Link2 } from 'lucide-react'
import { Badge, IMPACT_TONE, PRIORITY_TONE, STATUS_TONE, label } from '@/components/ui'
import { fmtDate, isOverdue } from '@/lib/utils'
import type { Task } from '@/lib/types'

export const PROVIDER_NAME: Record<string, string> = { linear: 'Linear', 'jira-software-cloud': 'Jira', github: 'GitHub', slack: 'Slack', gmail: 'Gmail' }

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status]}>{label(status)}</Badge>
export const PriorityBadge = ({ priority }: { priority: string }) => <Badge tone={PRIORITY_TONE[priority]}>{label(priority)}</Badge>
export const ImpactBadge = ({ impact }: { impact: string }) => (impact === 'NONE' ? null : <Badge tone={IMPACT_TONE[impact]}>{label(impact)} impact</Badge>)

export function SourceBadge({ task }: { task: Pick<Task, 'source'> }) {
  if (!task.source) return null
  const name = PROVIDER_NAME[task.source.provider] ?? task.source.provider
  return task.source.sourceUrl ? (
    <a href={task.source.sourceUrl} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="inline-flex">
      <Badge tone="neutral">
        <Link2 className="size-3" /> {name} {task.source.externalKey} <ExternalLink className="size-3" />
      </Badge>
    </a>
  ) : (
    <Badge>
      {name} {task.source.externalKey}
    </Badge>
  )
}

export function DueLabel({ task }: { task: Pick<Task, 'dueAt' | 'status'> }) {
  if (!task.dueAt) return <span className="text-xs text-muted">No due date</span>
  const late = isOverdue(task.dueAt, task.status)
  return (
    <span className={late ? 'inline-flex items-center gap-1 text-xs font-medium text-danger' : 'text-xs text-ink-soft'}>
      {late && <AlertOctagon className="size-3" />}
      {late ? 'Overdue · ' : 'Due '}
      {fmtDate(task.dueAt)}
    </span>
  )
}

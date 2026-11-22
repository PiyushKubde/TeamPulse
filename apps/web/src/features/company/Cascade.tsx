// The goal cascade: company objectives at the top, the goals that serve them below, with the KPIs under each objective.
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn, fmtDate } from '@/lib/utils'
import { Badge, Card, CardHeader, EmptyState, ErrorState, Progress, Skeleton, label } from '@/components/ui'
import { useCascade, type CascadeGoal, type Kpi } from './api'
import { KpiItem } from './Kpis'
import { PersonButton } from './parts'

const GOAL_TONE = { ON_TRACK: 'green', AT_RISK: 'amber', OFF_TRACK: 'red', ACHIEVED: 'teal', MISSED: 'red' } as const
const tone = (v: number) => (v >= 70 ? 'green' : v >= 45 ? 'amber' : 'red')

export function Cascade({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useCascade()
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  const { roots, kids, kpisByGoal, loose, descendants } = useMemo(() => {
    const goals = q.data?.goals ?? []
    const ids = new Set(goals.map((g) => g.id))
    const kids = new Map<string, CascadeGoal[]>()
    const roots: CascadeGoal[] = []
    for (const g of goals) {
      if (g.parentId && ids.has(g.parentId)) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g])
      else roots.push(g)
    }
    const kpisByGoal = new Map<string, Kpi[]>()
    const loose: Kpi[] = []
    for (const k of q.data?.kpis ?? []) {
      if (k.goalId && ids.has(k.goalId)) kpisByGoal.set(k.goalId, [...(kpisByGoal.get(k.goalId) ?? []), k])
      else loose.push(k)
    }
    const count = (id: string, seen = new Set<string>()): number => {
      if (seen.has(id)) return 0
      seen.add(id)
      return (kids.get(id) ?? []).reduce((n, c) => n + 1 + count(c.id, seen), 0)
    }
    const descendants = new Map(goals.map((g) => [g.id, count(g.id)]))
    return { roots, kids, kpisByGoal, loose, descendants }
  }, [q.data])

  if (q.isLoading) return <Skeleton className="h-64" />
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} retry={() => q.refetch()} />
      </Card>
    )
  if (!roots.length && !loose.length)
    return <EmptyState title="No objectives yet" description="Set a company objective in Goals & OKRs, then link team and personal goals beneath it." />

  const node = (g: CascadeGoal, depth: number, trail: Set<string>): React.ReactNode => {
    if (trail.has(g.id)) return null
    const next = new Set(trail).add(g.id)
    const children = kids.get(g.id) ?? []
    const kpis = kpisByGoal.get(g.id) ?? []
    const isClosed = closed[g.id] ?? false
    const hasMore = children.length > 0 || g.keyResults.length > 0 || kpis.length > 0
    return (
      <li key={g.id} role="treeitem" aria-level={depth + 1} aria-expanded={hasMore ? !isClosed : undefined}>
        <div className={cn('rounded-lg border border-line bg-surface p-3', depth === 0 && 'shadow-xs')}>
          <div className="flex items-start gap-2">
            {hasMore ? (
              <button
                type="button"
                aria-label={`${isClosed ? 'Expand' : 'Collapse'} ${g.title}`}
                onClick={() => setClosed((c) => ({ ...c, [g.id]: !isClosed }))}
                className="mt-0.5 grid size-6 shrink-0 place-items-center rounded text-muted hover:text-ink"
              >
                {isClosed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
            ) : (
              <span className="size-6 shrink-0" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink">{g.title}</span>
                <Badge tone={GOAL_TONE[g.status as keyof typeof GOAL_TONE] ?? 'neutral'}>{label(g.status)}</Badge>
                <Badge>{label(g.period)}</Badge>
                {g.team && <Badge tone="blue">{g.team.name}</Badge>}
                {descendants.get(g.id) ? <span className="text-xs text-muted">{descendants.get(g.id)} below</span> : null}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <PersonButton id={g.ownerId} name={g.ownerName} title={g.ownerTitle} onOpen={onOpen} />
                <span className="text-xs text-muted">due {fmtDate(g.dueDate, 'd MMM yyyy')}</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1">
                  <Progress value={g.progress} tone={tone(g.progress)} label={`${g.title} progress`} />
                </div>
                <span className="tabular w-10 text-right text-sm font-semibold">{g.progress}%</span>
              </div>
            </div>
          </div>
          {!isClosed && (g.keyResults.length > 0 || kpis.length > 0) && (
            <div className="ml-8 mt-3 space-y-3">
              {g.keyResults.length > 0 && (
                <ul className="space-y-1.5" aria-label={`Key results of ${g.title}`}>
                  {g.keyResults.map((k) => (
                    <li key={k.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-soft">
                      <span>◦ {k.title}</span>
                      <span className="tabular text-muted">
                        {k.current}
                        {k.unit ? ` ${k.unit}` : ''} of {k.target}
                        {k.unit ? ` ${k.unit}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {kpis.length > 0 && (
                <ul className="space-y-2" aria-label={`KPIs for ${g.title}`}>
                  {kpis.map((k) => (
                    <KpiItem key={k.id} kpi={k} showOwner />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {children.length > 0 && !isClosed && (
          <ul role="group" className="ml-5 mt-2 space-y-2 border-l border-line pl-4">
            {children.map((c) => node(c, depth + 1, next))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className="space-y-6">
      <ul role="tree" aria-label="Goal cascade" className="space-y-3">
        {roots.map((g) => node(g, 0, new Set()))}
      </ul>
      {loose.length > 0 && (
        <Card>
          <CardHeader title="KPIs not tied to an objective" description="Numbers people are accountable for that are not linked to a specific goal." />
          <ul className="space-y-2 px-4 pb-4">
            {loose.map((k) => (
              <KpiItem key={k.id} kpi={k} showOwner />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

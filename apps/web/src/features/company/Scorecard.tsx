// One person's scorecard, in a side panel: result, why, goals, KPIs, chain above, reports and peers.
import { X } from 'lucide-react'
import { fmtDate } from '@/lib/utils'
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Progress, Skeleton, label } from '@/components/ui'
import { Sheet, SheetClose } from '@/components/ui/overlay'
import { pct, usePersonDetail, type PersonBrief, type PersonDetail } from './api'
import { AddKpi, KpiItem } from './Kpis'
import { HealthChip, PctBar, PersonButton, VALUE_NOTE } from './parts'

const tone = (v: number | null) => (v === null ? 'blue' : v >= 70 ? 'green' : v >= 45 ? 'amber' : 'red')
const GOAL_TONE = { ON_TRACK: 'green', AT_RISK: 'amber', OFF_TRACK: 'red', ACHIEVED: 'teal', MISSED: 'red' } as const

function Stat({ title, value, hint }: { title: string; value: number | null; hint?: string }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="text-xs font-medium text-muted">{title}</div>
      <div className="tabular mt-1 text-xl font-semibold text-ink">{pct(value)}</div>
      <div className="mt-1.5">
        {value !== null ? <Progress value={value} tone={tone(value)} label={title} /> : <div className="h-1.5 rounded-full bg-line/60" />}
      </div>
      {hint && <div className="mt-1.5 text-[11px] leading-snug text-muted">{hint}</div>}
    </div>
  )
}

function BriefRows({ rows, onOpen, empty }: { rows: PersonBrief[]; onOpen: (id: string) => void; empty: string }) {
  if (!rows.length) return <p className="px-4 pb-4 text-sm text-muted">{empty}</p>
  return (
    <ul className="divide-y divide-line px-4 pb-2">
      {rows.map((r) => (
        <li key={r.userId} className="flex items-center justify-between gap-3 py-2">
          <PersonButton id={r.userId} name={r.name} title={r.title} onOpen={onOpen} />
          <div className="flex items-center gap-3">
            <div className="w-20">
              <PctBar value={r.overall} label={`${r.name} overall`} />
            </div>
            <HealthChip health={r.health} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Body({ d, onOpen }: { d: PersonDetail; onOpen: (id: string) => void }) {
  const p = d.person
  const dims = Object.entries(p.dimensionDetail ?? {})
  return (
    <div className="space-y-4 p-5">
      {d.chain.length > 0 && (
        <nav aria-label="Chain of command" className="flex flex-wrap items-center gap-1 text-xs text-muted">
          <span>Reports up to:</span>
          {d.chain.map((c, i) => (
            <span key={c.userId} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>›</span>}
              <button type="button" className="font-semibold text-primary hover:underline" onClick={() => onOpen(c.userId)}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat title="Overall" value={p.overall} hint="Average of the three below" />
        <Stat title="Value score" value={p.score} hint="Impact, quality and reliability of delivered work" />
        <Stat title="Goal progress" value={p.goalProgress} hint={p.goalCount ? `${p.goalCount} active goals` : 'No active goals'} />
        <Stat title="KPI attainment" value={p.kpiAttainment} hint={p.kpiCount ? `${p.kpiCount} KPIs` : 'No KPIs yet'} />
      </div>
      {p.subtreeSize > 0 && (
        <p className="text-sm text-ink-soft">
          Their line ({p.subtreeSize} {p.subtreeSize === 1 ? 'person' : 'people'} below them) is at <strong>{pct(p.rollupOverall)}</strong> overall.
        </p>
      )}

      <Card>
        <CardHeader title="Why this value score" description="Each part, how much it counts, and what it was based on." />
        {dims.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">No scored work in this period yet.</p>
        ) : (
          <ul className="space-y-3 px-4 pb-4">
            {dims.map(([k, v]) => (
              <li key={k}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-ink">{label(k)}</span>
                  <span className="tabular text-ink-soft">
                    {pct(v.value === null ? null : Math.round(v.value))} <span className="text-xs text-muted">· counts {Math.round(v.weight)}%</span>
                  </span>
                </div>
                {v.value !== null ? <Progress value={v.value} tone={tone(v.value)} label={label(k)} /> : null}
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-primary">{v.missing ? 'Why there is no value' : 'What it is based on'}</summary>
                  {v.missing ? (
                    <p className="mt-1 text-xs text-muted">{v.missing}</p>
                  ) : (
                    <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 text-xs text-muted">
                      {Object.entries(v.inputs).map(([ik, iv]) => (
                        <div key={ik} className="contents">
                          <dt>{label(ik.replace(/([A-Z])/g, ' $1').trim())}</dt>
                          <dd className="tabular text-right text-ink-soft">{String(iv)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Goals" description="Objectives and key results. Progress comes from the results." />
        {d.goals.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">No goals set.</p>
        ) : (
          <ul className="space-y-3 px-4 pb-4">
            {d.goals.map((g) => (
              <li key={g.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{g.title}</span>
                  <Badge tone={GOAL_TONE[g.status as keyof typeof GOAL_TONE] ?? 'neutral'}>{label(g.status)}</Badge>
                  <span className="text-xs text-muted">
                    {label(g.period)} · due {fmtDate(g.dueDate, 'd MMM yyyy')}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1">
                    <Progress value={g.progress} tone={tone(g.progress)} label={`${g.title} progress`} />
                  </div>
                  <span className="tabular w-10 text-right text-sm font-semibold">{g.progress}%</span>
                </div>
                {g.keyResults.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {g.keyResults.map((k) => (
                      <li key={k.id} className="flex justify-between gap-2 text-xs text-ink-soft">
                        <span>◦ {k.title}</span>
                        <span className="tabular text-muted">
                          {k.current} of {k.target}
                          {k.unit ? ` ${k.unit}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="KPIs" description="Numbers this person is accountable for, with the trend." />
        <div className="space-y-3 px-4 pb-4">
          {d.kpis.length === 0 ? (
            <p className="text-sm text-muted">No KPIs yet.</p>
          ) : (
            <ul className="space-y-3">
              {d.kpis.map((k) => (
                <KpiItem key={k.id} kpi={k} />
              ))}
            </ul>
          )}
          {d.canAddKpi && <AddKpi ownerId={p.userId} ownerName={p.name} />}
        </div>
      </Card>

      {d.reports.length > 0 && (
        <Card>
          <CardHeader title="Direct reports" description="Compare the people who report to them." />
          <BriefRows rows={[...d.reports].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))} onOpen={onOpen} empty="" />
        </Card>
      )}
      <Card>
        <CardHeader title="Peers" description="Others who report to the same person." />
        <BriefRows
          rows={[...d.peers].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))}
          onOpen={onOpen}
          empty="No peers: nobody else reports to the same person."
        />
      </Card>
      <p className="text-xs text-muted">{VALUE_NOTE}</p>
    </div>
  )
}

export function Scorecard({ userId, days, onOpen, onClose }: { userId: string | null; days: number; onOpen: (id: string) => void; onClose: () => void }) {
  const q = usePersonDetail(userId, days)
  const p = q.data?.person
  return (
    <Sheet open={!!userId} onOpenChange={(o) => !o && onClose()} title={p ? `${p.name}'s scorecard` : 'Scorecard'}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        {p ? (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={p.name} className="size-11 text-sm" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-ink">{p.name}</h2>
              <p className="truncate text-sm text-muted">
                {p.title ?? 'No title'} · {label(p.role)} · last {days} days
              </p>
            </div>
            <HealthChip health={p.health} />
          </div>
        ) : (
          <h2 className="text-lg font-semibold text-ink">Scorecard</h2>
        )}
        <SheetClose asChild>
          <Button variant="ghost" aria-label="Close scorecard">
            <X />
          </Button>
        </SheetClose>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {q.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
          </div>
        ) : q.error || !q.data ? (
          <div className="p-5">
            <ErrorState error={q.error} retry={() => q.refetch()} />
          </div>
        ) : q.data ? (
          <Body d={q.data} onOpen={onOpen} />
        ) : (
          <EmptyState title="Not found" />
        )}
      </div>
    </Sheet>
  )
}

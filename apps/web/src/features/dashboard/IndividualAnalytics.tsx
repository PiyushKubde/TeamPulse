import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertOctagon, ArrowRight, CheckCircle2, ExternalLink, FileCheck2, HelpCircle, Sparkles } from 'lucide-react'
import { addDays, format } from 'date-fns'
import { api, errorMessage } from '@/lib/api'
import { useRange, RANGES } from '@/lib/range'
import { useAiStatus } from '@/lib/queries'
import { fmtDate, minutes, pct } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, KpiCard, Progress, QueryState, Select, Skeleton, label } from '@/components/ui'
import { Modal } from '@/components/ui/overlay'
import { BarList, BarsChart, ChartCard, DonutChart, LinesChart } from '@/components/charts'
import type { Score } from '@/lib/types'
import { ImpactBadge, PriorityBadge } from '../tasks/TaskBadges'

interface MiniTask {
  id: string
  title: string
  status: string
  priority: string
  impactLevel: string
  dueAt: string | null
  completedAt: string | null
  project: { id: string; name: string } | null
}

export interface IndividualData {
  user: { id: string; name: string; role: string }
  score: Score
  kpis: {
    score: number | null
    impact: number | null
    goalAchievement: { due: number; achieved: number; rate: number | null; avgProgress: number | null }
    reliability: number | null
    completedOutcomes: number
    highImpactCompleted: number
    activeBlockers: number
  }
  weekly: {
    week: string
    planned: number
    completed: number
    impactPoints: number
    score: number | null
    impact: number | null
    reliability: number | null
    blockers: number
  }[]
  workload: { id: string | null; name: string; value: number }[]
  workloadByStatus: { status: string; value: number }[]
  timeAllocation: { name: string; minutes: number }[]
  recentHighImpact: MiniTask[]
  upcoming: MiniTask[]
  delayed: MiniTask[]
  recentEvidence: {
    id: string
    title: string
    kind: string
    status: string
    url: string | null
    createdAt: string
    task: { id: string; title: string } | null
  }[]
}

export const DIMENSION_INFO: Record<string, { name: string; info: string }> = {
  impact: {
    name: 'Impact',
    info: 'Impact points from completed outcomes (Low 0.5, Medium 2, High 5, Critical 10; × complexity 0.9–1.3; unverified work counts half) compared with the expected points for the period. Task count is never used.',
  },
  quality: {
    name: 'Execution quality',
    info: 'Average of quality assessments (1–5) made by managers on completed work, scaled to 0–100. Missing when nobody has assessed the work yet.',
  },
  alignment: { name: 'Goal alignment', info: 'Share of earned impact that came from work linked to a goal.' },
  reliability: {
    name: 'Delivery reliability',
    info: 'Commitments with a due date finished on time. Work that was late because of an external or dependency blocker is excused, not counted as missed.',
  },
  evidence: { name: 'Evidence completeness', info: 'Medium-or-higher impact outcomes with at least one verified evidence item.' },
}

export const weekLabel = (w: string) => format(new Date(`${w}T00:00:00`), 'd MMM')

export function ScoreExplainer({ score, open, onOpenChange }: { score: Score; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Why this score?"
      description={`Scoring model ${score.model?.name ?? 'Default'} v${score.model?.version ?? 1}. Every input is shown; missing data is left out and its weight is shared by the other dimensions, never treated as zero.`}
    >
      <div className="space-y-4">
        {Object.entries(score.dimensions).map(([k, d]) => (
          <div key={k} className="rounded-lg border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {DIMENSION_INFO[k]?.name} <span className="text-xs font-normal text-muted">· weight {d.weight}%</span>
              </p>
              <span className="text-lg font-semibold tabular">
                {d.value == null ? <span className="text-sm font-normal text-muted">No data</span> : Math.round(d.value)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{DIMENSION_INFO[k]?.info}</p>
            {d.missing ? (
              <p className="mt-2 text-xs text-warn">{d.missing}</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(d.inputs).map(([ik, iv]) => (
                  <Badge key={ik}>
                    {label(ik.replace(/([A-Z])/g, '_$1'))}: {iv}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="rounded-lg bg-canvas p-3 text-xs text-ink-soft">
          <p className="font-medium text-ink">Diagnostics (not scored)</p>
          <p className="mt-1">
            Estimate accuracy {pct(score.diagnostics.estimateAccuracy)} · Avg. cycle time {score.diagnostics.avgCycleHours ?? '—'} h · Work in progress{' '}
            {score.diagnostics.workInProgress} · Reopened {score.diagnostics.reopened}
          </p>
          <p className="mt-1 text-muted">
            Effort and hours are shown for planning only: they never raise or lower a score. Think a value is wrong? Ask for a correction in Reviews &amp;
            Feedback.
          </p>
        </div>
      </div>
    </Modal>
  )
}

export function RangeSelect() {
  const r = useRange()
  return (
    <Select aria-label="Date range" className="w-44" value={r.key} onChange={(e) => r.setRange(e.target.value)}>
      {RANGES.map((x) => (
        <option key={x.value} value={x.value}>
          {x.label}
        </option>
      ))}
    </Select>
  )
}

export function useIndividual(userId?: string) {
  const r = useRange()
  return useQuery({
    queryKey: ['analytics', 'individual', userId, r.from, r.to, r.projectId],
    queryFn: () => api<IndividualData>('/analytics/individual', { query: { userId, from: r.from, to: r.to, projectId: r.projectId } }),
  })
}

export function KpiRow({ d, taskLink }: { d: IndividualData; taskLink: (q: Record<string, string>) => void }) {
  const [explain, setExplain] = useState(false)
  const k = d.kpis
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Overall score"
          value={pct(k.score)}
          unit={k.score == null ? undefined : '/100'}
          info="Weighted, explainable score across five dimensions. Click for the full breakdown."
          onClick={() => setExplain(true)}
          hint={d.score.excludedWeight ? `${d.score.excludedWeight}% of weight has no data` : 'All dimensions have data'}
        />
        <KpiCard
          label="Impact"
          value={pct(k.impact)}
          unit={k.impact == null ? undefined : '/100'}
          info={DIMENSION_INFO.impact!.info}
          hint={`${d.score.metrics.impactPoints} impact points`}
          onClick={() => setExplain(true)}
        />
        <KpiCard
          label="Goal achievement"
          value={
            k.goalAchievement.rate == null ? (k.goalAchievement.avgProgress == null ? '—' : `${k.goalAchievement.avgProgress}%`) : `${k.goalAchievement.rate}%`
          }
          info="Share of goals due in this range that were achieved. While goals are still open, their average progress is shown instead."
          hint={
            k.goalAchievement.rate == null
              ? k.goalAchievement.due
                ? 'Average progress of open goals'
                : 'No goals due in range'
              : `${k.goalAchievement.achieved} of ${k.goalAchievement.due} achieved`
          }
        />
        <KpiCard
          label="Delivery reliability"
          value={pct(k.reliability)}
          unit={k.reliability == null ? undefined : '%'}
          info={DIMENSION_INFO.reliability!.info}
          hint={`${d.score.metrics.onTime}/${d.score.metrics.committed} on time${d.score.metrics.excusedLate ? ` · ${d.score.metrics.excusedLate} excused` : ''}`}
        />
        <KpiCard
          label="Completed outcomes"
          value={k.completedOutcomes}
          info="Completed top-level tasks in the range. Shown for context; it does not drive the score."
          hint={`${k.highImpactCompleted} high or critical impact`}
          onClick={() => taskLink({ status: 'COMPLETED' })}
        />
        <KpiCard
          label="Active blockers"
          value={k.activeBlockers}
          tone={k.activeBlockers ? 'amber' : undefined}
          info="Open tasks currently blocked. Blockers are signals to act on, not performance judgements."
          onClick={() => taskLink({ status: 'BLOCKED' })}
        />
      </div>
      <ScoreExplainer score={d.score} open={explain} onOpenChange={setExplain} />
    </>
  )
}

/** All individual charts. Clicking a week opens that week's tasks; clicking a project or status filters the task list. */
export function IndividualCharts({ d, taskLink, compact }: { d: IndividualData; taskLink: (q: Record<string, string>) => void; compact?: boolean }) {
  const weeks = d.weekly.map((w) => ({ ...w, label: weekLabel(w.week) }))
  const openWeek = (w: { week: string }) =>
    taskLink({ dueFrom: w.week, dueTo: format(addDays(new Date(`${w.week}T00:00:00`), 6), 'yyyy-MM-dd'), assigneeId: d.user.id, status: '' })
  const empty = weeks.every((w) => !w.planned && !w.completed)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Planned vs. completed, by week"
        info="Planned = tasks due that week. Completed = tasks finished that week. Click a week to see its tasks."
        empty={empty}
        table={{ columns: ['Week', 'Planned', 'Completed'], rows: weeks.map((w) => [w.label, w.planned, w.completed]) }}
      >
        <BarsChart
          data={weeks}
          x="label"
          series={[
            { key: 'planned', name: 'Planned', color: 'var(--color-c5)' },
            { key: 'completed', name: 'Completed', color: 'var(--color-c1)' },
          ]}
          onSelect={openWeek}
        />
      </ChartCard>
      <ChartCard
        title="Impact and reliability trend"
        info="Weekly impact dimension and delivery reliability (0–100). Gaps mean no data that week."
        empty={weeks.every((w) => w.impact == null && w.reliability == null)}
        table={{ columns: ['Week', 'Impact', 'Reliability', 'Score'], rows: weeks.map((w) => [w.label, w.impact, w.reliability, w.score]) }}
      >
        <LinesChart
          data={weeks}
          x="label"
          yMax={100}
          series={[
            { key: 'impact', name: 'Impact' },
            { key: 'reliability', name: 'Reliability', color: 'var(--color-c2)' },
          ]}
          onSelect={openWeek}
        />
      </ChartCard>
      {!compact && (
        <>
          <ChartCard
            title="Workload by project"
            info="Open tasks per project. Click a project to see them."
            empty={!d.workload.length}
            table={{ columns: ['Project', 'Open tasks'], rows: d.workload.map((w) => [w.name, w.value]) }}
          >
            <DonutChart data={d.workload} onSelect={(s) => taskLink({ projectId: s.id ?? '', assigneeId: d.user.id })} />
          </ChartCard>
          <ChartCard
            title="Time allocation"
            info="Tracked focus and work sessions by project. Effort is shown for planning; it is not a productivity measure."
            empty={!d.timeAllocation.length}
            table={{ columns: ['Area', 'Minutes'], rows: d.timeAllocation.map((t) => [t.name, t.minutes]) }}
          >
            <div className="h-full overflow-y-auto pr-1">
              <BarList
                rows={d.timeAllocation.sort((a, b) => b.minutes - a.minutes).map((t) => ({ key: t.name, label: t.name, value: t.minutes }))}
                format={minutes}
              />
            </div>
          </ChartCard>
          <ChartCard
            title="Impact points by week"
            info="Sum of impact points of work completed each week (before verification weighting)."
            empty={weeks.every((w) => !w.impactPoints)}
            table={{ columns: ['Week', 'Impact points'], rows: weeks.map((w) => [w.label, w.impactPoints]) }}
          >
            <BarsChart data={weeks} x="label" series={[{ key: 'impactPoints', name: 'Impact points', color: 'var(--color-c3)' }]} onSelect={openWeek} />
          </ChartCard>
          <ChartCard
            title="Blockers reported, by week"
            info="New blockers per week. Click a week to see its tasks."
            empty={weeks.every((w) => !w.blockers)}
            table={{ columns: ['Week', 'Blockers'], rows: weeks.map((w) => [w.label, w.blockers]) }}
          >
            <BarsChart data={weeks} x="label" series={[{ key: 'blockers', name: 'Blockers', color: 'var(--color-c4)' }]} onSelect={openWeek} />
          </ChartCard>
          <ChartCard
            title="Open work by status"
            info="Click a status to see those tasks."
            empty={d.workloadByStatus.every((s) => !s.value)}
            table={{ columns: ['Status', 'Tasks'], rows: d.workloadByStatus.map((s) => [label(s.status), s.value]) }}
            height={200}
          >
            <BarList
              rows={d.workloadByStatus.map((s) => ({
                key: s.status,
                label: label(s.status),
                value: s.value,
                tone: s.status === 'BLOCKED' ? 'var(--color-c4)' : 'var(--color-c1)',
              }))}
              onSelect={(s) => taskLink({ status: s, assigneeId: d.user.id })}
            />
          </ChartCard>
        </>
      )}
    </div>
  )
}

export function WorkLists({ d, openTask }: { d: IndividualData; openTask: (id: string) => void }) {
  const Row = ({ t, right }: { t: MiniTask; right: React.ReactNode }) => (
    <li>
      <button onClick={() => openTask(t.id)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-canvas">
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
        {right}
      </button>
    </li>
  )
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader title="Recent high-impact work" info="Completed High or Critical impact outcomes in the range." />
        {d.recentHighImpact.length ? (
          <ul className="divide-y divide-line py-1">
            {d.recentHighImpact.map((t) => (
              <Row
                key={t.id}
                t={t}
                right={
                  <>
                    <ImpactBadge impact={t.impactLevel} />
                    <span className="text-xs text-muted">{fmtDate(t.completedAt)}</span>
                  </>
                }
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<CheckCircle2 />}
            title="No high-impact outcomes yet"
            description="Rate the expected impact of your tasks so the work that matters most is visible."
          />
        )}
      </Card>
      <Card>
        <CardHeader title="Upcoming priorities" />
        {d.upcoming.length ? (
          <ul className="divide-y divide-line py-1">
            {d.upcoming.map((t) => (
              <Row
                key={t.id}
                t={t}
                right={
                  <>
                    <PriorityBadge priority={t.priority} />
                    <span className="text-xs text-muted">{fmtDate(t.dueAt)}</span>
                  </>
                }
              />
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing due soon" />
        )}
      </Card>
      <Card>
        <CardHeader title="Delayed commitments" info="Open tasks past their due date." />
        {d.delayed.length ? (
          <ul className="divide-y divide-line py-1">
            {d.delayed.map((t) => (
              <Row
                key={t.id}
                t={t}
                right={
                  <span className="flex items-center gap-1 text-xs text-danger">
                    <AlertOctagon className="size-3" />
                    {fmtDate(t.dueAt)}
                  </span>
                }
              />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<CheckCircle2 />} title="Nothing overdue" />
        )}
      </Card>
    </div>
  )
}

export function RecentEvidence({ d, openTask }: { d: IndividualData; openTask: (id: string) => void }) {
  return (
    <Card>
      <CardHeader title="Recent evidence" info="Evidence attached to this person’s tasks. Received is not the same as verified." />
      {d.recentEvidence.length ? (
        <ul className="divide-y divide-line py-1">
          {d.recentEvidence.map((e) => (
            <li key={e.id} className="flex items-center gap-2 px-4 py-2 text-sm">
              <FileCheck2 className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">
                {e.url ? (
                  <a className="hover:text-primary" href={e.url} target="_blank" rel="noreferrer noopener">
                    {e.title} <ExternalLink className="inline size-3" />
                  </a>
                ) : (
                  e.title
                )}
              </span>
              <Badge tone={e.status === 'VERIFIED' ? 'green' : e.status === 'REJECTED' ? 'red' : 'amber'}>{label(e.status)}</Badge>
              {e.task && (
                <button className="hidden max-w-40 truncate text-xs text-muted hover:text-primary sm:block" onClick={() => openTask(e.task!.id)}>
                  {e.task.title}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No evidence yet" description="Attach links, files or connect GitHub to collect pull requests and releases." />
      )}
    </Card>
  )
}

/** On-demand AI insights grounded in the person's own tasks. */
export function AiInsights({ userId }: { userId?: string }) {
  const ai = useAiStatus()
  const [kind, setKind] = useState<'weekly_summary' | 'deadline_risk' | 'blockers'>('weekly_summary')
  const m = useMutation({
    mutationFn: (k: typeof kind) =>
      api<{ summary: string; findings: { taskId: string | null; finding: string; suggestion: string }[]; missingData: string[]; basedOnTasks: number }>(
        '/ai/analyze-work',
        { body: { kind: k, userId } },
      ),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const navigate = useNavigate()
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-4 text-primary" /> AI insights
          </span>
        }
        info="Generated from your actual tasks, blockers and postponements. Suggestions only: AI never rates people."
        action={
          ai.data?.configured && (
            <div className="flex gap-1.5">
              <Select aria-label="Insight type" className="h-8 w-40 text-xs" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="weekly_summary">Weekly summary</option>
                <option value="deadline_risk">Deadline risks</option>
                <option value="blockers">Blocker patterns</option>
              </Select>
              <Button size="sm" variant="secondary" onClick={() => m.mutate(kind)} loading={m.isPending}>
                Analyze
              </Button>
            </div>
          )
        }
      />
      <div className="p-4 text-sm">
        {!ai.data?.configured ? (
          <p className="text-xs text-muted">{ai.data?.reason ?? 'AI is not configured.'}</p>
        ) : m.isPending ? (
          <Skeleton className="h-16" />
        ) : m.data ? (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-ink-soft">{m.data.summary}</p>
            {m.data.findings.length > 0 && (
              <ul className="space-y-2">
                {m.data.findings.map((f, i) => (
                  <li key={i} className="rounded-lg border border-line p-2.5">
                    <p className="text-sm">{f.finding}</p>
                    <p className="mt-0.5 text-xs text-muted">{f.suggestion}</p>
                    {f.taskId && (
                      <button
                        className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        onClick={() => navigate(`/tasks?task=${f.taskId}&assigneeId=all`)}
                      >
                        Open task <ArrowRight className="size-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {m.data.missingData.length > 0 && <p className="text-xs text-warn">Missing data: {m.data.missingData.join('; ')}</p>}
            <p className="text-[11px] text-muted">Based on {m.data.basedOnTasks} tasks. AI-written; check before acting.</p>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <HelpCircle className="size-3.5" /> Choose an insight and press Analyze.
          </p>
        )}
      </div>
    </Card>
  )
}

export function GoalsPanel({ ownerId }: { ownerId?: string }) {
  const q = useQuery({
    queryKey: ['goals', 'owner', ownerId],
    queryFn: () =>
      api<{ goals: { id: string; title: string; period: string; progress: number; status: string; dueDate: string; progressSource: string }[] }>('/goals', {
        query: { ownerId, active: true },
      }),
  })
  return (
    <Card>
      <CardHeader
        title="Goal progress"
        info="Progress comes from key results when a goal has them; otherwise the owner sets it. Linked task counts do not move progress."
        action={
          <Link to="/goals" className="text-xs text-primary hover:underline">
            All goals
          </Link>
        }
      />
      <QueryState q={q} skeleton={<Skeleton className="m-4 h-20" />}>
        {(d) =>
          d.goals.length ? (
            <ul className="space-y-3 p-4">
              {d.goals.slice(0, 6).map((g) => (
                <li key={g.id}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{g.title}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Badge tone={g.status === 'ON_TRACK' ? 'green' : g.status === 'AT_RISK' ? 'amber' : 'red'}>{label(g.status)}</Badge>
                      <span className="text-xs tabular text-ink-soft">{g.progress}%</span>
                    </span>
                  </div>
                  <Progress value={g.progress} tone={g.status === 'ON_TRACK' ? 'teal' : g.status === 'AT_RISK' ? 'amber' : 'red'} label={g.title} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No active goals"
              description="Set weekly or quarterly goals to see alignment."
              action={
                <Link to="/goals">
                  <Button size="sm" variant="secondary">
                    Add a goal
                  </Button>
                </Link>
              }
            />
          )
        }
      </QueryState>
    </Card>
  )
}

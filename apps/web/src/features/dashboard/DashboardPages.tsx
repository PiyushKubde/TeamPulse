import { useNavigate } from 'react-router-dom'
import { qs } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Card, ErrorState, PageHeader, Skeleton } from '@/components/ui'
import { AiInsights, GoalsPanel, IndividualCharts, KpiRow, RangeSelect, RecentEvidence, WorkLists, useIndividual } from './IndividualAnalytics'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'
import { Building2, CalendarCheck } from 'lucide-react'
import { HEALTH_LABEL, pct, useCompanyOverview } from '@/features/company/api'
import { HealthChip } from '@/features/company/parts'

export const DashSkeleton = () => (
  <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Skeleton className="h-72" />
      <Skeleton className="h-72" />
    </div>
  </div>
)

/** Where the signed-in person stands in the company: their own result and the roll-up of their line. */
function CompanyStanding() {
  const q = useCompanyOverview(28)
  const mine = q.data?.people.find((p) => p.isMe)
  if (!mine) return null
  return (
    <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-md bg-primary-soft text-primary" aria-hidden>
          <Building2 className="size-5" />
        </span>
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Where I stand in the company</h2>
          <p className="text-[13px] text-muted">
            Overall <strong className="text-ink">{pct(mine.overall)}</strong> · {HEALTH_LABEL[mine.health]}
            {mine.subtreeSize > 0 && (
              <>
                {' '}
                · my line of {mine.subtreeSize} <strong className="text-ink">{pct(mine.rollupOverall)}</strong>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <HealthChip health={mine.health} />
        <Link to="/company">
          <Button variant="secondary">See the company</Button>
        </Link>
      </div>
    </Card>
  )
}

export function MyDashboard() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const q = useIndividual()
  const taskLink = (f: Record<string, string>) => navigate(`/tasks${qs({ view: 'list', ...f })}`)
  const openTask = (id: string) => navigate(`/tasks?task=${id}&assigneeId=all`)
  const hour = new Date().getHours()
  return (
    <div>
      <PageHeader
        title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${me?.user.name.split(' ')[0] ?? ''}`}
        description="What you delivered, what it was worth, and what matters next."
        actions={
          <>
            <RangeSelect />
            <Link to="/planner">
              <Button variant="secondary">
                <CalendarCheck /> Plan today
              </Button>
            </Link>
          </>
        }
      />
      {q.isLoading ? (
        <DashSkeleton />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <div className="space-y-4">
          <CompanyStanding />
          <KpiRow d={q.data} taskLink={taskLink} />
          <IndividualCharts d={q.data} taskLink={taskLink} compact />
          <WorkLists d={q.data} openTask={openTask} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <AiInsights />
            </div>
            <GoalsPanel ownerId={me?.user.id} />
          </div>
          <RecentEvidence d={q.data} openTask={openTask} />
        </div>
      )}
    </div>
  )
}

export function MyAnalytics() {
  const navigate = useNavigate()
  const q = useIndividual()
  const taskLink = (f: Record<string, string>) => navigate(`/tasks${qs({ view: 'list', ...f })}`)
  return (
    <div>
      <PageHeader
        title="My analytics"
        description="Impact, reliability and evidence over time. Every number explains itself: use the info icons and the score breakdown."
        actions={<RangeSelect />}
      />
      {q.isLoading ? (
        <DashSkeleton />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <div className="space-y-4">
          <KpiRow d={q.data} taskLink={taskLink} />
          <IndividualCharts d={q.data} taskLink={taskLink} />
        </div>
      )}
    </div>
  )
}

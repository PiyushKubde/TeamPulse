import { useNavigate } from 'react-router-dom'
import { qs } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Card, ErrorState, PageHeader, Skeleton } from '@/components/ui'
import { AiInsights, GoalsPanel, IndividualCharts, KpiRow, RangeSelect, RecentEvidence, WorkLists, useIndividual } from './IndividualAnalytics'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'
import { CalendarCheck } from 'lucide-react'

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

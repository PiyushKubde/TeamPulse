import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderKanban, Plus } from 'lucide-react'
import { PROJECT_STATUSES } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMembers, useTeams } from '@/lib/queries'
import { fmtDate } from '@/lib/utils'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KpiCard,
  PageHeader,
  Progress,
  Select,
  Skeleton,
  Textarea,
  label,
} from '@/components/ui'
import { Modal } from '@/components/ui/overlay'
import { BarList, BarsChart, ChartCard, DonutChart } from '@/components/charts'

interface Project {
  id: string
  name: string
  description: string | null
  status: string
  progress: number
  taskCount: number
  completedCount: number
  blockedCount: number
  overdue: boolean
  targetDate: string | null
  owner: { id: string; name: string }
  team: { id: string; name: string } | null
  canEdit: boolean
}

export function ProjectsPage() {
  const { isManager } = useAuth()
  const [creating, setCreating] = useState(false)
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/projects') })
  return (
    <div>
      <PageHeader
        title="Projects"
        description="Progress is the completed share of planned impact, not a task count."
        actions={
          isManager && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New project
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : q.error ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : !q.data?.projects.length ? (
        <Card>
          <EmptyState
            icon={<FolderKanban />}
            title="No projects yet"
            description={isManager ? 'Create a project to group related work.' : 'Your manager creates projects.'}
            action={
              isManager && (
                <Button onClick={() => setCreating(true)}>
                  <Plus /> New project
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {q.data.projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`}>
              <Card className="h-full p-4 transition hover:border-primary/40 hover:shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{p.name}</p>
                  <Badge tone={p.status === 'ACTIVE' ? 'blue' : p.status === 'COMPLETED' ? 'green' : 'neutral'}>{label(p.status)}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 min-h-8 text-xs text-muted">{p.description ?? 'No description'}</p>
                <div className="mt-3 mb-1 flex justify-between text-xs">
                  <span className="text-muted">
                    {p.completedCount}/{p.taskCount} tasks{p.blockedCount ? ` · ${p.blockedCount} blocked` : ''}
                  </span>
                  <span className="font-medium tabular">{p.progress}%</span>
                </div>
                <Progress value={p.progress} tone={p.overdue ? 'red' : 'blue'} label={`${p.name} progress`} />
                <p className="mt-3 text-xs text-muted">
                  {p.owner.name}
                  {p.team ? ` · ${p.team.name}` : ''}
                  {p.targetDate ? ` · target ${fmtDate(p.targetDate)}` : ''}
                  {p.overdue && <span className="text-danger"> · past target</span>}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <ProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function ProjectDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project?: Project }) {
  const qc = useQueryClient()
  const teams = useTeams()
  const members = useMembers()
  const [v, setV] = useState({
    name: project?.name ?? '',
    description: project?.description ?? '',
    teamId: project?.team?.id ?? '',
    ownerId: project?.owner.id ?? '',
    status: project?.status ?? 'ACTIVE',
    targetDate: project?.targetDate?.slice(0, 10) ?? '',
  })
  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: v.name,
        description: v.description || null,
        teamId: v.teamId || null,
        ownerId: v.ownerId || undefined,
        status: v.status,
        targetDate: v.targetDate || null,
      }
      return project ? api(`/projects/${project.id}`, { method: 'PATCH', body }) : api('/projects', { body })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['analytics'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={project ? 'Edit project' : 'New project'}
      footer={
        <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!v.name}>
          {project ? 'Save' : 'Create'}
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="p-name" className="sm:col-span-2">
          <Input id="p-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="p-desc" className="sm:col-span-2">
          <Textarea id="p-desc" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Field>
        <Field label="Team" htmlFor="p-team">
          <Select id="p-team" value={v.teamId} onChange={(e) => setV({ ...v, teamId: e.target.value })}>
            <option value="">No team</option>
            {(teams.data ?? [])
              .filter((t) => t.canManage)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Owner" htmlFor="p-owner">
          <Select id="p-owner" value={v.ownerId} onChange={(e) => setV({ ...v, ownerId: e.target.value })}>
            <option value="">Me</option>
            {(members.data ?? [])
              .filter((m) => m.status === 'ACTIVE')
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Status" htmlFor="p-status">
          <Select id="p-status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Target date" htmlFor="p-target">
          <Input id="p-target" type="date" value={v.targetDate} onChange={(e) => setV({ ...v, targetDate: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

export function ProjectDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const q = useQuery({
    queryKey: ['project-analytics', id],
    queryFn: () =>
      api<{
        project: Project
        statusCounts: { status: string; value: number }[]
        burnup: { week: string; scope: number; completed: number }[]
        contributors: { userId: string; name: string; completed: number; impactPoints: number; open: number }[]
        overdue: { id: string; title: string; dueAt: string }[]
      }>(`/analytics/projects/${id}`),
  })
  const pq = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/projects'), select: (d) => d.projects.find((p) => p.id === id) })
  if (q.isLoading) return <Skeleton className="h-96" />
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} retry={() => q.refetch()} />
      </Card>
    )
  const d = q.data
  const p = pq.data
  const go = (f: string) => navigate(`/tasks?projectId=${id}&assigneeId=all&view=list${f}`)
  return (
    <div>
      <PageHeader
        title={d.project.name}
        description={d.project.description ?? undefined}
        actions={
          <>
            {p?.canEdit && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Button onClick={() => go('')}>View tasks</Button>
          </>
        }
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Progress" value={`${p?.progress ?? 0}%`} info="Completed share of planned impact weight across top-level tasks." />
          <KpiCard label="Completed" value={d.statusCounts.find((s) => s.status === 'COMPLETED')?.value ?? 0} onClick={() => go('&status=COMPLETED')} />
          <KpiCard label="Blocked" value={d.statusCounts.find((s) => s.status === 'BLOCKED')?.value ?? 0} tone="amber" onClick={() => go('&status=BLOCKED')} />
          <KpiCard
            label="Overdue"
            value={d.overdue.length}
            tone={d.overdue.length ? 'red' : undefined}
            hint={d.project.targetDate ? `Target ${fmtDate(d.project.targetDate)}` : 'No target date'}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="Scope vs. completed (12 weeks)"
            info="Total tasks in the project and how many were completed, by end of each week. Click a week to open its tasks."
            empty={!d.burnup.some((b) => b.scope)}
            table={{ columns: ['Week', 'Scope', 'Completed'], rows: d.burnup.map((b) => [b.week, b.scope, b.completed]) }}
          >
            <BarsChart
              data={d.burnup.map((b) => ({ ...b, label: fmtDate(b.week) }))}
              x="label"
              series={[
                { key: 'scope', name: 'Scope', color: 'var(--color-c5)' },
                { key: 'completed', name: 'Completed' },
              ]}
              onSelect={() => go('')}
            />
          </ChartCard>
          <ChartCard
            title="Tasks by status"
            info="Click a status to see the tasks."
            empty={!d.statusCounts.some((s) => s.value)}
            table={{ columns: ['Status', 'Tasks'], rows: d.statusCounts.map((s) => [label(s.status), s.value]) }}
          >
            <DonutChart
              data={d.statusCounts.map((s) => ({ name: label(s.status), value: s.value, id: s.status }))}
              onSelect={(s) => s.id && go(`&status=${s.id}`)}
            />
          </ChartCard>
        </div>
        <Card>
          <CardHeader
            title="Contributions"
            info="Impact points of completed work per person in this project. Click a person to see their profile (managers) or tasks."
          />
          {d.contributors.length ? (
            <div className="p-4">
              <BarList
                rows={d.contributors.map((c) => ({ key: c.userId, label: c.name, value: c.impactPoints, sub: `· ${c.completed} done · ${c.open} open` }))}
                onSelect={(uid) => navigate(`/tasks?projectId=${id}&assigneeId=${uid}&view=list`)}
              />
            </div>
          ) : (
            <EmptyState title="No contributions yet" />
          )}
        </Card>
      </div>
      {p && <ProjectDialog key={p.id + editing} open={editing} onOpenChange={setEditing} project={p} />}
    </div>
  )
}

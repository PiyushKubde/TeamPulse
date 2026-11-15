import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { CalendarDays, ChevronLeft, ChevronRight, Columns3, GanttChart, List, ListChecks, Plus, X } from 'lucide-react'
import { PRIORITIES, TASK_STATUSES } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useGoalsList, useMembers, useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, label } from '@/components/ui'
import type { Task, TaskStatus } from '@/lib/types'
import { DueLabel, ImpactBadge, PROVIDER_NAME, PriorityBadge, SourceBadge, StatusBadge } from './TaskBadges'
import { CreateTaskDialog } from './TaskForm'
import { TaskDrawer } from './TaskDrawer'

type View = 'kanban' | 'list' | 'calendar' | 'timeline'
const FILTER_KEYS = ['q', 'status', 'priority', 'projectId', 'assigneeId', 'provider', 'goalId', 'category', 'needsReview', 'dueFrom', 'dueTo'] as const

export function TasksPage() {
  const { me, isManager } = useAuth()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const view = (params.get('view') as View) ?? 'kanban'
  const openTask = params.get('task')
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const set = (k: string, v: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (v) n.set(k, v)
      else n.delete(k)
      return n
    })
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined]))
  // Default scope: my work. Managers can widen it with the assignee filter.
  const query = { ...filters, assigneeId: filters.assigneeId ?? 'me', parentId: 'none', pageSize: 500, sort: view === 'list' ? 'dueAt' : 'sortOrder' }
  if (query.assigneeId === 'all') delete (query as Record<string, unknown>).assigneeId
  const q = useQuery({
    queryKey: ['tasks', query],
    queryFn: () => api<{ items: Task[]; total: number }>('/tasks', { query }),
    placeholderData: keepPreviousData,
  })
  const members = useMembers()
  const projects = useProjects()
  const goals = useGoalsList()
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskStatus }) => api(`/tasks/${id}`, { method: 'PATCH', body: { status } }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ['tasks', query] })
      qc.setQueryData<{ items: Task[]; total: number }>(['tasks', query], (d) => d && { ...d, items: d.items.map((t) => (t.id === id ? { ...t, status } : t)) })
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  })
  const bulk = useMutation({
    mutationFn: (b: { action: string; value?: string | null }) =>
      api<{ updated: number; skipped: string[] }>('/tasks/bulk', { body: { ids: [...selected], ...b } }),
    onSuccess: (r) => {
      toast.success(`${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped (no permission)` : ''}`)
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
  const tasks = q.data?.items ?? []
  const activeFilters = FILTER_KEYS.filter((k) => params.get(k))

  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Native and imported work in one place. Impact matters more than volume."
        actions={
          <>
            <Segmented<View>
              label="View"
              value={view}
              onChange={(v) => set('view', v)}
              options={[
                {
                  value: 'kanban',
                  label: (
                    <>
                      <Columns3 /> Board
                    </>
                  ),
                },
                {
                  value: 'list',
                  label: (
                    <>
                      <List /> List
                    </>
                  ),
                },
                {
                  value: 'calendar',
                  label: (
                    <>
                      <CalendarDays /> Calendar
                    </>
                  ),
                },
                {
                  value: 'timeline',
                  label: (
                    <>
                      <GanttChart /> Timeline
                    </>
                  ),
                },
              ]}
            />
            <Button onClick={() => setCreating(true)}>
              <Plus /> New task
            </Button>
          </>
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Search tasks"
            placeholder="Search…"
            className="w-44"
            defaultValue={params.get('q') ?? ''}
            onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value || null)}
          />
          <Select
            aria-label="Assignee"
            className="w-40"
            value={params.get('assigneeId') ?? 'me'}
            onChange={(e) => set('assigneeId', e.target.value === 'me' ? null : e.target.value)}
          >
            <option value="me">Assigned to me</option>
            <option value="all">{isManager ? 'Everyone I can see' : 'All my tasks'}</option>
            <option value="none">Unassigned</option>
            {(members.data ?? [])
              .filter((m) => m.managed && m.userId !== me?.user.id)
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
          </Select>
          <Select aria-label="Status" className="w-36" value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value || null)}>
            <option value="">Any status</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
          <Select aria-label="Priority" className="w-36" value={params.get('priority') ?? ''} onChange={(e) => set('priority', e.target.value || null)}>
            <option value="">Any priority</option>
            {PRIORITIES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
          <Select aria-label="Project" className="w-40" value={params.get('projectId') ?? ''} onChange={(e) => set('projectId', e.target.value || null)}>
            <option value="">Any project</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Goal" className="w-40" value={params.get('goalId') ?? ''} onChange={(e) => set('goalId', e.target.value || null)}>
            <option value="">Any goal</option>
            {(goals.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>
          <Select aria-label="Source" className="w-36" value={params.get('provider') ?? ''} onChange={(e) => set('provider', e.target.value || null)}>
            <option value="">Any source</option>
            <option value="native">WorkPulse</option>
            {Object.entries(PROVIDER_NAME)
              .filter(([k]) => ['linear', 'jira-software-cloud', 'github'].includes(k))
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </Select>
          <Input
            aria-label="Category"
            placeholder="Category"
            className="w-32"
            defaultValue={params.get('category') ?? ''}
            onKeyDown={(e) => e.key === 'Enter' && set('category', (e.target as HTMLInputElement).value || null)}
          />
          {activeFilters.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setParams((p) => {
                  const n = new URLSearchParams(p)
                  FILTER_KEYS.forEach((k) => n.delete(k))
                  return n
                })
              }
            >
              <X /> Clear
            </Button>
          )}
          <span className="ml-auto text-xs text-muted tabular">{q.data ? `${q.data.total} task${q.data.total === 1 ? '' : 's'}` : ''}</span>
        </div>
      </Card>

      {selected.size > 0 && (
        <Card className="mb-3 flex flex-wrap items-center gap-2 border-primary/30 bg-primary-soft/40 px-3 py-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Select
            aria-label="Set status"
            className="w-36"
            value=""
            onChange={(e) => e.target.value && bulk.mutate({ action: 'status', value: e.target.value })}
          >
            <option value="">Set status…</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Set priority"
            className="w-36"
            value=""
            onChange={(e) => e.target.value && bulk.mutate({ action: 'priority', value: e.target.value })}
          >
            <option value="">Set priority…</option>
            {PRIORITIES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Move to project"
            className="w-40"
            value=""
            onChange={(e) => e.target.value && bulk.mutate({ action: 'project', value: e.target.value === 'none' ? null : e.target.value })}
          >
            <option value="">Move to project…</option>
            <option value="none">No project</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" onClick={() => bulk.mutate({ action: 'archive' })}>
            Archive
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Cancel
          </Button>
        </Card>
      )}

      {q.isLoading ? (
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : q.error ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : tasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListChecks />}
            title={activeFilters.length ? 'No tasks match these filters' : 'No tasks yet'}
            description={
              activeFilters.length ? 'Clear a filter to see more.' : 'Create a task, or connect Linear, Jira or GitHub in Integrations to bring your work in.'
            }
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus /> New task
              </Button>
            }
          />
        </Card>
      ) : view === 'kanban' ? (
        <Kanban tasks={tasks} onOpen={(id) => set('task', id)} onMove={(id, status) => move.mutate({ id, status })} />
      ) : view === 'list' ? (
        <TaskTable tasks={tasks} onOpen={(id) => set('task', id)} selected={selected} setSelected={setSelected} />
      ) : view === 'calendar' ? (
        <CalendarView tasks={tasks} onOpen={(id) => set('task', id)} />
      ) : (
        <Timeline tasks={tasks} onOpen={(id) => set('task', id)} />
      )}

      <CreateTaskDialog open={creating} onOpenChange={setCreating} />
      <TaskDrawer taskId={openTask} onClose={() => set('task', null)} onOpen={(id) => set('task', id)} />
    </div>
  )
}

export function TaskCard({ task, onOpen, draggable }: { task: Task; onOpen: () => void; draggable?: boolean }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${task.title}`}
      draggable={draggable && task.canEdit}
      onDragStart={(e) => e.dataTransfer.setData('text/task', task.id)}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      className="block w-full cursor-pointer rounded-lg border border-line bg-surface p-3 text-left shadow-[0_1px_1px_rgba(15,27,51,0.04)] transition hover:border-primary/40 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug text-ink">{task.title}</p>
        {task.assignee && <Avatar name={task.assignee.name} className="size-6 text-[10px]" />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <PriorityBadge priority={task.priority} />
        <ImpactBadge impact={task.impactLevel} />
        {task.openBlockers > 0 && (
          <Badge tone="red">
            {task.openBlockers} blocker{task.openBlockers > 1 ? 's' : ''}
          </Badge>
        )}
        {task.needsReview && <Badge tone="amber">Needs review</Badge>}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <DueLabel task={task} />
        <SourceBadge task={task} />
      </div>
      {(task._count.subtasks > 0 || task.project) && (
        <p className="mt-1.5 truncate text-[11px] text-muted">
          {task.project?.name}
          {task.project && task._count.subtasks > 0 ? ' · ' : ''}
          {task._count.subtasks > 0 ? `${task._count.subtasks} subtasks` : ''}
        </p>
      )}
    </div>
  )
}

function Kanban({ tasks, onOpen, onMove }: { tasks: Task[]; onOpen: (id: string) => void; onMove: (id: string, s: TaskStatus) => void }) {
  const [over, setOver] = useState<string | null>(null)
  const cols: TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'COMPLETED']
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {cols.map((s) => {
        const items = tasks.filter((t) => t.status === s)
        return (
          <section
            key={s}
            aria-label={label(s)}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(s)
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null)
              const id = e.dataTransfer.getData('text/task')
              if (id) onMove(id, s)
            }}
            className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-line/40 p-2', over === s && 'ring-2 ring-primary/40')}
          >
            <header className="mb-2 flex items-center justify-between px-1.5 pt-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label(s)}</span>
              <span className="text-xs text-muted tabular">{items.length}</span>
            </header>
            <div className="flex min-h-24 flex-col gap-2">
              {items.map((t) => (
                <TaskCard key={t.id} task={t} draggable onOpen={() => onOpen(t.id)} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function TaskTable({
  tasks,
  onOpen,
  selected,
  setSelected,
}: {
  tasks: Task[]
  onOpen: (id: string) => void
  selected: Set<string>
  setSelected: (s: Set<string>) => void
}) {
  const toggle = (id: string) => {
    const n = new Set(selected)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setSelected(n)
  }
  const all = tasks.length > 0 && tasks.every((t) => selected.has(t.id))
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b border-line text-left text-xs text-muted">
          <tr>
            <th className="w-10 px-3 py-2.5">
              <input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSelected(all ? new Set() : new Set(tasks.map((t) => t.id)))} />
            </th>
            <th className="px-3 py-2.5 font-medium">Task</th>
            <th className="px-3 py-2.5 font-medium">Status</th>
            <th className="px-3 py-2.5 font-medium">Priority</th>
            <th className="px-3 py-2.5 font-medium">Impact</th>
            <th className="px-3 py-2.5 font-medium">Assignee</th>
            <th className="px-3 py-2.5 font-medium">Due</th>
            <th className="px-3 py-2.5 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className="border-b border-line/70 last:border-0 hover:bg-canvas/60">
              <td className="px-3 py-2">
                <input type="checkbox" aria-label={`Select ${t.title}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
              </td>
              <td className="max-w-80 px-3 py-2">
                <button className="truncate text-left font-medium text-ink hover:text-primary" onClick={() => onOpen(t.id)}>
                  {t.title}
                </button>
                {t.project && <p className="truncate text-xs text-muted">{t.project.name}</p>}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={t.status} />
              </td>
              <td className="px-3 py-2">
                <PriorityBadge priority={t.priority} />
              </td>
              <td className="px-3 py-2">{t.impactLevel === 'NONE' ? <span className="text-xs text-muted">—</span> : <ImpactBadge impact={t.impactLevel} />}</td>
              <td className="px-3 py-2 text-ink-soft">{t.assignee?.name ?? <span className="text-muted">Unassigned</span>}</td>
              <td className="px-3 py-2">
                <DueLabel task={t} />
              </td>
              <td className="px-3 py-2">
                <SourceBadge task={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function CalendarView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [month, setMonth] = useState(startOfMonth(new Date()))
  const days = eachDayOfInterval({ start: startOfWeek(month, { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }) })
  const undated = tasks.filter((t) => !t.dueAt).length
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft />
          </Button>
          <h2 className="w-36 text-center text-sm font-semibold">{format(month, 'MMMM yyyy')}</h2>
          <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight />
          </Button>
        </div>
        {undated > 0 && (
          <span className="text-xs text-muted">
            {undated} task{undated > 1 ? 's' : ''} without a due date not shown
          </span>
        )}
      </div>
      <div className="grid grid-cols-7 border-b border-line text-center text-[11px] font-medium text-muted">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="py-1.5">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const items = tasks.filter((t) => t.dueAt && isSameDay(new Date(t.dueAt), d))
          return (
            <div key={d.toISOString()} className={cn('min-h-24 border-b border-r border-line/70 p-1.5', !isSameMonth(d, month) && 'bg-canvas/60')}>
              <p className={cn('mb-1 text-right text-[11px] tabular', isSameDay(d, new Date()) ? 'font-semibold text-primary' : 'text-muted')}>
                {format(d, 'd')}
              </p>
              <div className="space-y-1">
                {items.slice(0, 3).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onOpen(t.id)}
                    className={cn(
                      'block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px]',
                      t.status === 'COMPLETED'
                        ? 'bg-success-soft text-success line-through'
                        : t.status === 'BLOCKED'
                          ? 'bg-danger-soft text-danger'
                          : 'bg-primary-soft text-primary',
                    )}
                  >
                    {t.title}
                  </button>
                ))}
                {items.length > 3 && <p className="px-1 text-[11px] text-muted">+{items.length - 3} more</p>}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Timeline({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const start = startOfWeek(addDays(new Date(), -14), { weekStartsOn: 1 })
  const span = 56
  const end = addDays(start, span)
  const rows = useMemo(
    () =>
      tasks
        .filter((t) => t.dueAt)
        .map((t) => ({ t, from: new Date(t.startedAt ?? t.createdAt), to: new Date(t.dueAt!) }))
        .filter((r) => r.to >= start && r.from <= end)
        .sort((a, b) => a.to.getTime() - b.to.getTime()),
    [tasks, start, end],
  )
  const pos = (d: Date) => Math.max(0, Math.min(100, (differenceInCalendarDays(d, start) / span) * 100))
  const todayX = pos(new Date())
  if (!rows.length)
    return (
      <Card>
        <EmptyState
          icon={<GanttChart />}
          title="Nothing to show on the timeline"
          description="Tasks need a due date within the next six weeks to appear here."
        />
      </Card>
    )
  return (
    <Card className="overflow-x-auto p-4">
      <div className="min-w-[760px]">
        <div className="relative ml-56 mb-2 h-5 text-[11px] text-muted">
          {Array.from({ length: span / 7 }).map((_, i) => (
            <span key={i} className="absolute" style={{ left: `${(i * 7 * 100) / span}%` }}>
              {format(addDays(start, i * 7), 'd MMM')}
            </span>
          ))}
        </div>
        <div className="relative">
          <div className="absolute inset-y-0 ml-56 w-[calc(100%-14rem)]">
            <div className="absolute inset-y-0 w-px bg-primary/50" style={{ left: `${todayX}%` }} aria-hidden />
          </div>
          {rows.map(({ t, from, to }) => {
            const left = pos(from)
            const width = Math.max(1.5, pos(to) - left)
            return (
              <div key={t.id} className="flex items-center py-1">
                <button onClick={() => onOpen(t.id)} className="w-56 shrink-0 truncate pr-3 text-left text-sm hover:text-primary">
                  {t.title}
                </button>
                <div className="relative h-6 flex-1 rounded bg-canvas">
                  <button
                    onClick={() => onOpen(t.id)}
                    aria-label={`${t.title}, due ${format(to, 'd MMM')}`}
                    className={cn(
                      'absolute top-1 h-4 rounded',
                      t.status === 'COMPLETED' ? 'bg-success/70' : t.status === 'BLOCKED' ? 'bg-danger/70' : to < new Date() ? 'bg-warn/70' : 'bg-primary/70',
                    )}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex gap-4 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-primary/70" /> On track
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-warn/70" /> Past due
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-danger/70" /> Blocked
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-success/70" /> Completed
          </span>
        </div>
      </div>
    </Card>
  )
}

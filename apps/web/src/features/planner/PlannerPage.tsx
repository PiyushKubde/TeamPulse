import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { addDays, format } from 'date-fns'
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Pause, Play, Plus, Sparkles, Target, X } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useAiStatus } from '@/lib/queries'
import { minutes, todayYmd } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, Progress, Select, Skeleton, Textarea, label } from '@/components/ui'
import { Modal } from '@/components/ui/overlay'
import type { Task } from '@/lib/types'
import { DueLabel, ImpactBadge, PriorityBadge } from '../tasks/TaskBadges'

interface Outcome {
  text: string
  taskId?: string | null
  done: boolean
}
interface PlannerData {
  date: string
  plan: {
    topOutcomes: Outcome[]
    plannedTaskIds: string[]
    checkIn: string | null
    energy: number | null
    review: string | null
    carryForward: { taskId: string; reason: string }[]
    reviewedAt: string | null
  } | null
  planned: Task[]
  inProgress: Task[]
  dueSoon: Task[]
  completed: Task[]
  blocked: (Task & { blockerReasons: string[] })[]
  sessions: { id: string; startedAt: string; endedAt: string | null; task: { id: string; title: string } | null }[]
  goals: { id: string; title: string; period: string; progress: number; status: string }[]
  effort: { focusMins: number; completedEstimateMins: number; completedActualMins: number; completedWithEstimates: number }
  isToday: boolean
}

export function PlannerPage() {
  const [date, setDate] = useState(todayYmd())
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['planner', date], queryFn: () => api<PlannerData>(`/planner/${date}`) })
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/planner', { method: 'PUT', body: { date, ...body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['planner', date] }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const [reviewing, setReviewing] = useState(false)
  const shift = (n: number) => setDate(format(addDays(new Date(`${date}T00:00:00`), n), 'yyyy-MM-dd'))
  const d = q.data
  const outcomes = d?.plan?.topOutcomes ?? []
  const plannedIds = d?.plan?.plannedTaskIds ?? []
  const openTask = (id: string) => navigate(`/tasks?task=${id}`)

  return (
    <div>
      <PageHeader
        title="Daily planner"
        description="Choose up to three outcomes that matter, plan the work behind them, and close the day honestly."
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Previous day" onClick={() => shift(-1)}>
              <ChevronLeft />
            </Button>
            <Input type="date" aria-label="Date" className="w-40" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <Button variant="ghost" size="icon" aria-label="Next day" onClick={() => shift(1)}>
              <ChevronRight />
            </Button>
            {date !== todayYmd() && (
              <Button variant="secondary" size="sm" onClick={() => setDate(todayYmd())}>
                Today
              </Button>
            )}
          </div>
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-96" />
      ) : q.error || !d ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Outcomes
              outcomes={outcomes}
              candidates={[...new Map([...d.inProgress, ...d.dueSoon].map((t) => [t.id, t])).values()]}
              onSave={(o) => save.mutate({ topOutcomes: o })}
            />
            <AiPlan
              date={date}
              onApply={(p) => save.mutate({ topOutcomes: p.topOutcomes.map((o) => ({ ...o, done: false })), plannedTaskIds: p.orderedTaskIds })}
            />
            <Card>
              <CardHeader
                title="Today’s plan"
                description="Tasks you intend to move today. Unfinished ones need a reason at the end of the day."
                action={
                  d.plan?.reviewedAt ? null : (
                    <Button size="sm" variant="secondary" onClick={() => setReviewing(true)} disabled={!d.plan}>
                      End-of-day review
                    </Button>
                  )
                }
              />
              {d.planned.length === 0 ? (
                <EmptyState icon={<Target />} title="Nothing planned yet" description="Add tasks from “In progress” or “Due soon” below." />
              ) : (
                <ul className="divide-y divide-line">
                  {d.planned.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                      <button
                        aria-label={t.status === 'COMPLETED' ? 'Completed' : 'Mark complete'}
                        disabled={t.status === 'COMPLETED' || !t.canEdit}
                        onClick={() =>
                          api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'COMPLETED' } }).then(() =>
                            qc.invalidateQueries({ queryKey: ['planner', date] }),
                          )
                        }
                      >
                        {t.status === 'COMPLETED' ? (
                          <CheckCircle2 className="size-5 text-success" />
                        ) : (
                          <Circle className="size-5 text-line-strong hover:text-success" />
                        )}
                      </button>
                      <button className="min-w-0 flex-1 text-left" onClick={() => openTask(t.id)}>
                        <p className={`truncate text-sm ${t.status === 'COMPLETED' ? 'text-muted line-through' : 'font-medium'}`}>{t.title}</p>
                        <div className="mt-0.5 flex gap-1.5">
                          <PriorityBadge priority={t.priority} />
                          <ImpactBadge impact={t.impactLevel} />
                        </div>
                      </button>
                      <FocusButton task={t} date={date} />
                      <button
                        aria-label="Remove from plan"
                        className="text-muted hover:text-danger"
                        onClick={() => save.mutate({ plannedTaskIds: plannedIds.filter((x) => x !== t.id) })}
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {d.plan?.reviewedAt && (
                <div className="border-t border-line bg-success-soft/40 px-4 py-3 text-sm">
                  <p className="font-medium text-success">Day reviewed</p>
                  <p className="mt-1 whitespace-pre-wrap text-ink-soft">{d.plan.review}</p>
                  {d.plan.carryForward.map((c) => (
                    <p key={c.taskId} className="mt-1 text-xs text-muted">
                      Carried forward: {d.planned.find((t) => t.id === c.taskId)?.title}: {c.reason}
                    </p>
                  ))}
                </div>
              )}
            </Card>
            <div className="grid gap-4 md:grid-cols-2">
              <TaskPick
                title="In progress"
                tasks={d.inProgress}
                planned={plannedIds}
                onAdd={(id) => save.mutate({ plannedTaskIds: [...plannedIds, id] })}
                onOpen={openTask}
              />
              <TaskPick
                title="Due soon"
                tasks={d.dueSoon}
                planned={plannedIds}
                onAdd={(id) => save.mutate({ plannedTaskIds: [...plannedIds, id] })}
                onOpen={openTask}
              />
            </div>
          </div>
          <div className="space-y-4">
            <CheckIn plan={d.plan} onSave={(b) => save.mutate(b)} />
            <FocusTimer date={date} candidates={d.planned.length ? d.planned : d.inProgress} sessions={d.sessions} />
            <Card>
              <CardHeader title="Effort" info="Estimates versus tracked time help you plan. They are never used to score you." />
              <div className="space-y-1 p-4 text-sm">
                <p className="flex justify-between">
                  <span className="text-muted">Focus time today</span>
                  <span className="tabular font-medium">{minutes(d.effort.focusMins)}</span>
                </p>
                <p className="flex justify-between">
                  <span className="text-muted">Completed, estimated</span>
                  <span className="tabular">{minutes(d.effort.completedEstimateMins)}</span>
                </p>
                <p className="flex justify-between">
                  <span className="text-muted">Completed, tracked</span>
                  <span className="tabular">{minutes(d.effort.completedActualMins)}</span>
                </p>
              </div>
            </Card>
            <Card>
              <CardHeader title="Completed today" />
              {d.completed.length ? (
                <ul className="space-y-1 p-3">
                  {d.completed.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="size-4 text-success" />
                      <button className="truncate hover:text-primary" onClick={() => openTask(t.id)}>
                        {t.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-xs text-muted">Nothing completed yet.</p>
              )}
            </Card>
            <Card>
              <CardHeader title="Blockers" />
              {d.blocked.length ? (
                <ul className="space-y-2 p-3">
                  {d.blocked.map((t) => (
                    <li key={t.id} className="text-sm">
                      <button className="font-medium hover:text-primary" onClick={() => openTask(t.id)}>
                        {t.title}
                      </button>
                      <p className="text-xs text-muted">{t.blockerReasons.join('; ')}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-xs text-muted">No blocked work.</p>
              )}
            </Card>
            <Card>
              <CardHeader title="Goals in play" />
              {d.goals.length ? (
                <ul className="space-y-3 p-4">
                  {d.goals.map((g) => (
                    <li key={g.id}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="truncate">{g.title}</span>
                        <span className="text-xs tabular text-muted">{g.progress}%</span>
                      </div>
                      <Progress value={g.progress} tone="teal" label={g.title} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-xs text-muted">No active goals for this day.</p>
              )}
            </Card>
          </div>
        </div>
      )}
      {d && <ReviewDialog open={reviewing} onOpenChange={setReviewing} date={date} planned={d.planned} />}
    </div>
  )
}

function Outcomes({ outcomes, candidates, onSave }: { outcomes: Outcome[]; candidates: Task[]; onSave: (o: Outcome[]) => void }) {
  const [text, setText] = useState('')
  const [taskId, setTaskId] = useState('')
  return (
    <Card>
      <CardHeader title="Top three expected outcomes" info="Outcomes, not activities: what will be true at the end of the day that wasn’t this morning?" />
      <ul className="divide-y divide-line">
        {outcomes.map((o, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5">
            <button aria-label={o.done ? 'Mark not done' : 'Mark done'} onClick={() => onSave(outcomes.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}>
              {o.done ? (
                <CheckCircle2 className="size-5 text-success" />
              ) : (
                <span className="flex size-5 items-center justify-center rounded-full border-2 border-primary/40 text-[10px] font-bold text-primary">
                  {i + 1}
                </span>
              )}
            </button>
            <span className={`flex-1 text-sm ${o.done ? 'text-muted line-through' : 'font-medium'}`}>{o.text}</span>
            {o.taskId && <Badge tone="blue">{candidates.find((c) => c.id === o.taskId)?.title.slice(0, 24) ?? 'Linked task'}</Badge>}
            <button aria-label="Remove outcome" className="text-muted hover:text-danger" onClick={() => onSave(outcomes.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {outcomes.length < 3 && (
        <form
          className="flex flex-wrap gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!text.trim()) return
            onSave([...outcomes, { text: text.trim(), taskId: taskId || null, done: false }])
            setText('')
            setTaskId('')
          }}
        >
          <Input
            aria-label="New outcome"
            className="min-w-48 flex-1"
            placeholder="e.g. Pricing page approved by marketing"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Select aria-label="Link to task" className="w-48" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">No linked task</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            <Plus /> Add
          </Button>
        </form>
      )}
    </Card>
  )
}

function AiPlan({
  date,
  onApply,
}: {
  date: string
  onApply: (p: { topOutcomes: { text: string; taskId: string | null }[]; orderedTaskIds: string[] }) => void
}) {
  const ai = useAiStatus()
  const m = useMutation({
    mutationFn: () =>
      api<{ topOutcomes: { text: string; taskId: string | null }[]; orderedTaskIds: string[]; warnings: string[]; rationale: string }>('/ai/plan-day', {
        body: { date },
      }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!ai.data?.configured) return null
  return (
    <Card className="p-4">
      {!m.data ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink-soft">
            <Sparkles className="mr-1 inline size-4 text-primary" />
            Let AI suggest outcomes and an order from your open work.
          </p>
          <Button size="sm" variant="secondary" onClick={() => m.mutate()} loading={m.isPending}>
            Suggest a plan
          </Button>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-xs font-medium text-ink-soft">Suggested plan (AI). Apply to replace today’s outcomes and plan.</p>
          <ol className="list-decimal space-y-0.5 pl-5">
            {m.data.topOutcomes.map((o, i) => (
              <li key={i}>{o.text}</li>
            ))}
          </ol>
          {m.data.warnings.map((w, i) => (
            <p key={i} className="text-xs text-warn">
              {w}
            </p>
          ))}
          <p className="text-xs text-muted">{m.data.rationale}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onApply(m.data!)
                m.reset()
              }}
            >
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => m.reset()}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function TaskPick({
  title,
  tasks,
  planned,
  onAdd,
  onOpen,
}: {
  title: string
  tasks: Task[]
  planned: string[]
  onAdd: (id: string) => void
  onOpen: (id: string) => void
}) {
  const items = tasks.filter((t) => !planned.includes(t.id))
  return (
    <Card>
      <CardHeader title={title} />
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.slice(0, 8).map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-4 py-2">
              <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(t.id)}>
                <p className="truncate text-sm">{t.title}</p>
                <DueLabel task={t} />
              </button>
              <Button size="sm" variant="ghost" aria-label={`Add ${t.title} to today`} onClick={() => onAdd(t.id)}>
                <Plus />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-xs text-muted">Nothing here.</p>
      )}
    </Card>
  )
}

function CheckIn({ plan, onSave }: { plan: PlannerData['plan']; onSave: (b: Record<string, unknown>) => void }) {
  const [text, setText] = useState(plan?.checkIn ?? '')
  useEffect(() => {
    setText(plan?.checkIn ?? '')
  }, [plan?.checkIn])
  return (
    <Card>
      <CardHeader title="Morning check-in" />
      <div className="space-y-3 p-4">
        <Field label="Energy" htmlFor="energy">
          <div id="energy" className="flex gap-1" role="radiogroup" aria-label="Energy">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={plan?.energy === n}
                onClick={() => onSave({ energy: n })}
                className={`size-8 rounded-md border text-sm ${plan?.energy === n ? 'border-primary bg-primary-soft text-primary' : 'border-line-strong text-ink-soft hover:bg-hover'}`}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Notes for today" htmlFor="checkin">
          <Textarea
            id="checkin"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== (plan?.checkIn ?? '') && onSave({ checkIn: text || null })}
            placeholder="Anything that could get in the way?"
          />
        </Field>
      </div>
    </Card>
  )
}

function FocusButton({ task, date }: { task: Task; date: string }) {
  const qc = useQueryClient()
  const start = useMutation({
    mutationFn: () => api('/sessions/start', { body: { taskId: task.id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['planner', date] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!task.canEdit || task.status === 'COMPLETED') return null
  return (
    <Button size="sm" variant="ghost" aria-label={`Focus on ${task.title}`} onClick={() => start.mutate()}>
      <Play />
    </Button>
  )
}

function FocusTimer({ date, candidates, sessions }: { date: string; candidates: Task[]; sessions: PlannerData['sessions'] }) {
  const qc = useQueryClient()
  const active = sessions.find((s) => !s.endedAt)
  const [now, setNow] = useState(Date.now())
  const [taskId, setTaskId] = useState('')
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['planner', date] })
    qc.invalidateQueries({ queryKey: ['tasks'] })
  }
  const start = useMutation({ mutationFn: () => api('/sessions/start', { body: { taskId: taskId || null } }), onSuccess: refresh })
  const stop = useMutation({
    mutationFn: () => api<{ session: { minutes: number } }>('/sessions/stop', { method: 'POST' }),
    onSuccess: (r) => {
      refresh()
      toast.success(`Logged ${minutes(r.session.minutes)}`)
    },
  })
  const elapsed = active ? Math.floor((now - new Date(active.startedAt).getTime()) / 1000) : 0
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')
  return (
    <Card>
      <CardHeader title="Focus timer" info="Time is added to the task’s tracked effort when you stop." />
      <div className="p-4 text-center">
        <p className="text-4xl font-semibold tabular tracking-tight" aria-live="polite">
          {mm}:{ss}
        </p>
        <p className="mt-1 truncate text-xs text-muted">{active ? (active.task?.title ?? 'Unlinked session') : 'Not running'}</p>
        {active ? (
          <Button className="mt-3" variant="secondary" onClick={() => stop.mutate()} loading={stop.isPending}>
            <Pause /> Stop
          </Button>
        ) : (
          <div className="mt-3 flex gap-2">
            <Select aria-label="Focus task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">No task</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              <Play /> Start
            </Button>
          </div>
        )}
        {sessions.filter((s) => s.endedAt).length > 0 && (
          <p className="mt-3 text-xs text-muted">{sessions.filter((s) => s.endedAt).length} session(s) logged today</p>
        )}
      </div>
    </Card>
  )
}

function ReviewDialog({ open, onOpenChange, date, planned }: { open: boolean; onOpenChange: (o: boolean) => void; date: string; planned: Task[] }) {
  const qc = useQueryClient()
  const open_ = planned.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED')
  const [review, setReview] = useState('')
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const m = useMutation({
    mutationFn: () =>
      api<{ nextDate: string }>('/planner/review', { body: { date, review, carryForward: open_.map((t) => ({ taskId: t.id, reason: reasons[t.id] ?? '' })) } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['planner'] })
      onOpenChange(false)
      toast.success(`Day closed. ${open_.length ? `${open_.length} task(s) moved to ${r.nextDate}.` : ''}`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const ready = review.trim() && open_.every((t) => (reasons[t.id] ?? '').trim().length >= 3)
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="End-of-day review"
      description="What moved forward, and why anything planned didn’t. Carried-forward work goes onto tomorrow’s plan."
      footer={
        <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!ready}>
          Close the day
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="How did the day go?" htmlFor="rev">
          <Textarea
            id="rev"
            rows={3}
            value={review}
            onChange={(e) => setReview(e.target.value)}
            placeholder="Outcomes delivered, surprises, what you learned"
          />
        </Field>
        {open_.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-ink-soft">Not finished: give a short reason for each</p>
            {open_.map((t) => (
              <Field key={t.id} label={t.title} htmlFor={`cf-${t.id}`}>
                <Input
                  id={`cf-${t.id}`}
                  value={reasons[t.id] ?? ''}
                  onChange={(e) => setReasons((r) => ({ ...r, [t.id]: e.target.value }))}
                  placeholder={`e.g. waiting on review (${label(t.status)})`}
                />
              </Field>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

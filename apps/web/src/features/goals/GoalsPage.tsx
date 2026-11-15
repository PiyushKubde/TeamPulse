import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { format, endOfMonth, endOfQuarter, endOfWeek, startOfMonth, startOfQuarter, startOfWeek } from 'date-fns'
import { ChevronDown, ChevronRight, Plus, Target, Trash2 } from 'lucide-react'
import { GOAL_PERIODS, GOAL_STATUSES } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMembers, useTeams } from '@/lib/queries'
import { fmtDate, fmtDateTime } from '@/lib/utils'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Textarea,
  label,
  type Tone,
} from '@/components/ui'
import { Confirm, Modal } from '@/components/ui/overlay'

interface KR {
  id: string
  title: string
  unit: string | null
  start: number
  target: number
  current: number
}
interface Goal {
  id: string
  title: string
  description: string | null
  period: string
  status: string
  progress: number
  progressSource: 'key_results' | 'manual'
  startDate: string
  dueDate: string
  expectedOutcome: string | null
  actualOutcome: string | null
  owner: { id: string; name: string }
  team: { id: string; name: string } | null
  keyResults: KR[]
  linkedTasks: number
  completedTasks: number
  highImpactCompleted: number
  canEdit: boolean
}

export const GOAL_TONE: Record<string, Tone> = { ON_TRACK: 'green', AT_RISK: 'amber', OFF_TRACK: 'red', ACHIEVED: 'teal', MISSED: 'red', CANCELLED: 'neutral' }

const defaultRange = (period: string) => {
  const now = new Date()
  const [s, e] =
    period === 'DAILY'
      ? [now, now]
      : period === 'WEEKLY'
        ? [startOfWeek(now, { weekStartsOn: 1 }), endOfWeek(now, { weekStartsOn: 1 })]
        : period === 'MONTHLY'
          ? [startOfMonth(now), endOfMonth(now)]
          : [startOfQuarter(now), endOfQuarter(now)]
  return { startDate: format(s, 'yyyy-MM-dd'), dueDate: format(e, 'yyyy-MM-dd') }
}

export function GoalsPage() {
  const [params, setParams] = useSearchParams()
  const { me } = useAuth()
  const period = params.get('period') ?? ''
  const owner = params.get('owner') ?? 'me'
  const [creating, setCreating] = useState(false)
  const q = useQuery({
    queryKey: ['goals', period, owner],
    queryFn: () =>
      api<{ goals: Goal[] }>('/goals', { query: { period: period || undefined, ownerId: owner === 'me' ? me?.user.id : owner === 'all' ? undefined : owner } }),
  })
  const members = useMembers()
  const set = (k: string, v: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (v) n.set(k, v)
      else n.delete(k)
      return n
    })
  const goals = q.data?.goals ?? []
  const active = goals.filter((g) => ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'].includes(g.status))
  return (
    <div>
      <PageHeader
        title="Goals & OKRs"
        description="Objectives with measurable key results. Progress comes from results, never from how many tasks are linked."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New goal
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          label="Period"
          value={period}
          onChange={(v) => set('period', v)}
          options={[{ value: '', label: 'All' }, ...GOAL_PERIODS.map((p) => ({ value: p, label: label(p) }))]}
        />
        <Select aria-label="Owner" className="w-48" value={owner} onChange={(e) => set('owner', e.target.value === 'me' ? '' : e.target.value)}>
          <option value="me">My goals</option>
          <option value="all">All goals I can see</option>
          {(members.data ?? [])
            .filter((m) => m.managed && m.userId !== me?.user.id)
            .map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
        </Select>
        {active.length > 0 && (
          <span className="ml-auto text-xs text-muted">
            {active.length} active · {active.filter((g) => g.status !== 'ON_TRACK').length} need attention
          </span>
        )}
      </div>
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : q.error ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : goals.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Target />}
            title="No goals here"
            description="Set a weekly goal or a quarterly objective with key results."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus /> New goal
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} />
          ))}
        </div>
      )}
      <GoalDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function GoalCard({ goal: g }: { goal: Goal }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: ['goals'] })
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/goals/${g.id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const updateKr = useMutation({
    mutationFn: ({ id, current }: { id: string; current: number }) => api(`/key-results/${id}`, { method: 'PATCH', body: { current } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({ mutationFn: () => api(`/goals/${g.id}`, { method: 'DELETE' }), onSuccess: refresh })
  const history = useQuery({
    queryKey: ['goal', g.id],
    queryFn: () => api<{ goal: { updates: { id: string; progress: number; status: string; note: string | null; createdAt: string }[] } }>(`/goals/${g.id}`),
    enabled: open,
  })
  return (
    <Card>
      <button className="flex w-full items-start gap-3 p-4 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="mt-0.5 size-4 text-muted" /> : <ChevronRight className="mt-0.5 size-4 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{g.title}</p>
            <Badge>{label(g.period)}</Badge>
            <Badge tone={GOAL_TONE[g.status]}>{label(g.status)}</Badge>
            {g.team && <Badge tone="blue">{g.team.name}</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {g.owner.name} · {fmtDate(g.startDate)} – {fmtDate(g.dueDate)} · {g.linkedTasks} linked tasks ({g.completedTasks} done, {g.highImpactCompleted}{' '}
            high-impact)
          </p>
        </div>
        <div className="w-40 shrink-0">
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-muted">{g.progressSource === 'key_results' ? 'From key results' : 'Set by owner'}</span>
            <span className="font-medium tabular">{g.progress}%</span>
          </div>
          <Progress
            value={g.progress}
            tone={g.status === 'ON_TRACK' || g.status === 'ACHIEVED' ? 'teal' : g.status === 'AT_RISK' ? 'amber' : 'red'}
            label={`${g.title} progress`}
          />
        </div>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line p-4">
          {g.description && <p className="text-sm text-ink-soft">{g.description}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg bg-canvas p-3 text-sm">
              <p className="text-xs font-medium text-muted">Expected outcome</p>
              <p className="mt-1">{g.expectedOutcome ?? '—'}</p>
            </div>
            <div className="rounded-lg bg-canvas p-3 text-sm">
              <p className="text-xs font-medium text-muted">Actual outcome</p>
              {g.canEdit ? (
                <Textarea
                  aria-label="Actual outcome"
                  rows={2}
                  className="mt-1"
                  defaultValue={g.actualOutcome ?? ''}
                  onBlur={(e) => e.target.value !== (g.actualOutcome ?? '') && patch.mutate({ actualOutcome: e.target.value || null })}
                />
              ) : (
                <p className="mt-1">{g.actualOutcome ?? '—'}</p>
              )}
            </div>
          </div>
          {g.keyResults.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Key results</p>
              <ul className="space-y-2">
                {g.keyResults.map((kr) => {
                  const span = kr.target - kr.start
                  const p = span === 0 ? (kr.current >= kr.target ? 100 : 0) : Math.max(0, Math.min(100, ((kr.current - kr.start) / span) * 100))
                  return (
                    <li key={kr.id} className="grid items-center gap-3 sm:grid-cols-[1fr_10rem_8rem]">
                      <span className="text-sm">{kr.title}</span>
                      <Progress value={p} tone="teal" label={kr.title} />
                      {g.canEdit ? (
                        <div className="flex items-center gap-1 text-xs">
                          <Input
                            aria-label={`${kr.title} current value`}
                            type="number"
                            className="h-8 w-20"
                            defaultValue={kr.current}
                            onBlur={(e) => Number(e.target.value) !== kr.current && updateKr.mutate({ id: kr.id, current: Number(e.target.value) })}
                          />{' '}
                          <span className="text-muted">
                            / {kr.target}
                            {kr.unit ? ` ${kr.unit}` : ''}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs tabular">
                          {kr.current} / {kr.target}
                          {kr.unit ? ` ${kr.unit}` : ''}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {g.canEdit && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Status" htmlFor={`gs-${g.id}`}>
                <Select id={`gs-${g.id}`} className="w-40" value={g.status} onChange={(e) => patch.mutate({ status: e.target.value })}>
                  {GOAL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              {g.progressSource === 'manual' && (
                <Field label="Progress %" htmlFor={`gp-${g.id}`}>
                  <Input
                    id={`gp-${g.id}`}
                    type="number"
                    min={0}
                    max={100}
                    className="w-24"
                    defaultValue={g.progress}
                    onBlur={(e) => Number(e.target.value) !== g.progress && patch.mutate({ progress: Math.max(0, Math.min(100, Number(e.target.value))) })}
                  />
                </Field>
              )}
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Plus /> Key result
              </Button>
              <Link to={`/tasks?goalId=${g.id}&assigneeId=all&view=list`} className="text-sm text-primary hover:underline">
                Linked tasks
              </Link>
              <Confirm
                title="Delete this goal?"
                description="Linked tasks stay; they are just no longer linked."
                confirmLabel="Delete"
                danger
                onConfirm={() => del.mutateAsync()}
                trigger={
                  <Button variant="ghost" size="sm" className="ml-auto text-danger">
                    <Trash2 /> Delete
                  </Button>
                }
              />
            </div>
          )}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</p>
            {history.isLoading ? (
              <Skeleton className="h-10" />
            ) : (history.data?.goal.updates ?? []).length === 0 ? (
              <p className="text-xs text-muted">No updates yet.</p>
            ) : (
              <ul className="space-y-1 text-xs text-ink-soft">
                {history.data!.goal.updates.map((u) => (
                  <li key={u.id}>
                    <span className="text-muted">{fmtDateTime(u.createdAt)}</span> · {u.progress}% · {label(u.status)}
                    {u.note ? ` · ${u.note}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <AddKeyResult goalId={g.id} open={editing} onOpenChange={setEditing} />
        </div>
      )}
    </Card>
  )
}

function AddKeyResult({ goalId, open, onOpenChange }: { goalId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ title: '', unit: '', start: '0', target: '', current: '0' })
  const m = useMutation({
    mutationFn: () =>
      api(`/goals/${goalId}/key-results`, {
        body: { title: v.title, unit: v.unit || null, start: Number(v.start), target: Number(v.target), current: Number(v.current) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add key result"
      description="Once a goal has key results, its progress is calculated from them."
      footer={
        <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!v.title || v.target === ''}>
          Add
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Key result" htmlFor="kr-t" className="col-span-2">
          <Input id="kr-t" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="e.g. Weekly active teams" />
        </Field>
        <Field label="Start" htmlFor="kr-s">
          <Input id="kr-s" type="number" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} />
        </Field>
        <Field label="Target" htmlFor="kr-g">
          <Input id="kr-g" type="number" value={v.target} onChange={(e) => setV({ ...v, target: e.target.value })} />
        </Field>
        <Field label="Current" htmlFor="kr-c">
          <Input id="kr-c" type="number" value={v.current} onChange={(e) => setV({ ...v, current: e.target.value })} />
        </Field>
        <Field label="Unit" htmlFor="kr-u">
          <Input id="kr-u" value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} placeholder="%, users, €" />
        </Field>
      </div>
    </Modal>
  )
}

function GoalDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { me, isManager } = useAuth()
  const qc = useQueryClient()
  const members = useMembers()
  const teams = useTeams()
  const [v, setV] = useState({ title: '', description: '', period: 'WEEKLY', expectedOutcome: '', ownerId: '', teamId: '', ...defaultRange('WEEKLY') })
  const [krs, setKrs] = useState<{ title: string; target: string; unit: string }[]>([])
  const m = useMutation({
    mutationFn: () =>
      api('/goals', {
        body: {
          title: v.title,
          description: v.description || null,
          period: v.period,
          expectedOutcome: v.expectedOutcome || null,
          ownerId: v.ownerId || undefined,
          teamId: v.teamId || null,
          startDate: v.startDate,
          dueDate: v.dueDate,
          keyResults: krs
            .filter((k) => k.title && k.target)
            .map((k) => ({ title: k.title, target: Number(k.target), unit: k.unit || null, start: 0, current: 0 })),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      onOpenChange(false)
      setKrs([])
      setV({ ...v, title: '', description: '', expectedOutcome: '' })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="New goal"
      footer={
        <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!v.title}>
          Create goal
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Goal" htmlFor="g-title" className="sm:col-span-2">
          <Input id="g-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="e.g. Make onboarding self-serve" />
        </Field>
        <Field label="Period" htmlFor="g-period">
          <Select
            id="g-period"
            value={v.period}
            onChange={(e) => setV({ ...v, period: e.target.value, ...(e.target.value !== 'MILESTONE' ? defaultRange(e.target.value) : {}) })}
          >
            {GOAL_PERIODS.map((p) => (
              <option key={p} value={p}>
                {label(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Owner" htmlFor="g-owner">
          <Select id="g-owner" value={v.ownerId} onChange={(e) => setV({ ...v, ownerId: e.target.value })}>
            <option value="">Me</option>
            {(members.data ?? [])
              .filter((x) => x.managed && x.userId !== me?.user.id)
              .map((x) => (
                <option key={x.userId} value={x.userId}>
                  {x.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Start" htmlFor="g-start">
          <Input id="g-start" type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} />
        </Field>
        <Field label="Due" htmlFor="g-due">
          <Input id="g-due" type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} />
        </Field>
        {isManager && (
          <Field label="Team goal (optional)" htmlFor="g-team">
            <Select id="g-team" value={v.teamId} onChange={(e) => setV({ ...v, teamId: e.target.value })}>
              <option value="">Personal goal</option>
              {(teams.data ?? [])
                .filter((t) => t.canManage)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="Expected outcome" htmlFor="g-exp" className="sm:col-span-2">
          <Textarea
            id="g-exp"
            rows={2}
            value={v.expectedOutcome}
            onChange={(e) => setV({ ...v, expectedOutcome: e.target.value })}
            placeholder="What will be measurably true when this is done?"
          />
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-ink-soft">Key results (optional)</p>
            <Button size="sm" variant="ghost" onClick={() => setKrs([...krs, { title: '', target: '', unit: '' }])}>
              <Plus /> Add
            </Button>
          </div>
          {krs.map((k, i) => (
            <div key={i} className="mb-2 grid grid-cols-[1fr_6rem_5rem] gap-2">
              <Input
                aria-label="Key result"
                value={k.title}
                onChange={(e) => setKrs(krs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                placeholder="Measurable result"
              />
              <Input
                aria-label="Target"
                type="number"
                value={k.target}
                onChange={(e) => setKrs(krs.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}
                placeholder="Target"
              />
              <Input
                aria-label="Unit"
                value={k.unit}
                onChange={(e) => setKrs(krs.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}
                placeholder="Unit"
              />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

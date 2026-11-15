import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Sparkles } from 'lucide-react'
import { IMPACT_LEVELS, PRIORITIES, TASK_STATUSES } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAiStatus, useGoalsList, useMembers, useProjects } from '@/lib/queries'
import { Button, Field, Input, Select, Textarea, label } from '@/components/ui'
import { Modal } from '@/components/ui/overlay'
import type { Task } from '@/lib/types'

interface FormValues {
  title: string
  description: string
  status: string
  priority: string
  impactLevel: string
  complexity: string
  projectId: string
  assigneeId: string
  dueAt: string
  estimateMins: string
  category: string
  labels: string
  goalId: string
  recurrenceRule: string
}

const toBody = (v: FormValues, subtasks: string[] = []) => ({
  body: {
    title: v.title,
    description: v.description || null,
    status: v.status,
    priority: v.priority,
    impactLevel: v.impactLevel,
    complexity: Number(v.complexity),
    projectId: v.projectId || null,
    assigneeId: v.assigneeId === '' ? null : v.assigneeId,
    dueAt: v.dueAt ? new Date(`${v.dueAt}T17:00:00`).toISOString() : null,
    estimateMins: v.estimateMins ? Number(v.estimateMins) : null,
    category: v.category || null,
    labels: v.labels
      ? v.labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean)
      : [],
    goalIds: v.goalId ? [v.goalId] : [],
    recurrenceRule: v.recurrenceRule || null,
  },
  subtasks,
})

/** Create a task, optionally starting from an AI draft (the person reviews every field before saving). */
export function CreateTaskDialog({
  open,
  onOpenChange,
  defaults,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  defaults?: Partial<FormValues> & { parentId?: string }
}) {
  const { me, isManager } = useAuth()
  const qc = useQueryClient()
  const members = useMembers()
  const projects = useProjects()
  const goals = useGoalsList()
  const ai = useAiStatus()
  const [nl, setNl] = useState('')
  const [subtasks, setSubtasks] = useState<string[]>([])
  const [aiNote, setAiNote] = useState<string | null>(null)
  const f = useForm<FormValues>({
    defaultValues: {
      title: '',
      description: '',
      status: 'TODO',
      priority: 'MEDIUM',
      impactLevel: 'NONE',
      complexity: '2',
      projectId: '',
      // Managers and admins: WorkPulse picks the best fit by default. Members own what they create.
      assigneeId: isManager ? 'auto' : (me?.user.id ?? ''),
      dueAt: '',
      estimateMins: '',
      category: '',
      labels: '',
      goalId: '',
      recurrenceRule: '',
      ...defaults,
    },
  })
  const draft = useMutation({
    mutationFn: () =>
      api<{
        draft: {
          title: string
          description: string | null
          priority: string
          dueDate: string | null
          category: string | null
          suggestedImpact: string
          estimateMins: number | null
          subtasks: string[]
          rationale: string
        }
      }>('/ai/create-task', { body: { text: nl } }),
    onSuccess: ({ draft: d }) => {
      f.reset({
        ...f.getValues(),
        title: d.title,
        description: d.description ?? '',
        priority: d.priority,
        dueAt: d.dueDate ?? '',
        category: d.category ?? '',
        impactLevel: d.suggestedImpact,
        estimateMins: d.estimateMins ? String(d.estimateMins) : '',
      })
      setSubtasks(d.subtasks)
      setAiNote(d.rationale)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const save = useMutation({
    mutationFn: async (v: FormValues) => {
      const { body, subtasks: subs } = toBody(v, subtasks)
      const { task } = await api<{ task: Task }>('/tasks', { body: { ...body, parentId: defaults?.parentId } })
      for (const title of subs) await api('/tasks', { body: { title, parentId: task.id, assigneeId: body.assigneeId, projectId: body.projectId } })
      return task
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task'] })
      toast.success('Task created')
      f.reset()
      setSubtasks([])
      setAiNote(null)
      setNl('')
      onOpenChange(false)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const assignable = (members.data ?? []).filter((m) => m.status === 'ACTIVE' && (m.userId === me?.user.id || m.managed))

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={defaults?.parentId ? 'New subtask' : 'New task'}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={f.handleSubmit((v) => save.mutate(v))} loading={save.isPending}>
            Create task
          </Button>
        </>
      }
    >
      {!defaults?.parentId && (
        <div className="mb-4 rounded-lg border border-line bg-canvas/70 p-3">
          <label htmlFor="nl" className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
            <Sparkles className="size-3.5 text-primary" /> Describe it in plain words (optional)
          </label>
          <div className="mt-2 flex gap-2">
            <Input
              id="nl"
              value={nl}
              onChange={(e) => setNl(e.target.value)}
              placeholder="e.g. Prepare the Q4 board deck by Friday, high priority"
              disabled={!ai.data?.configured}
            />
            <Button variant="secondary" onClick={() => draft.mutate()} loading={draft.isPending} disabled={!ai.data?.configured || nl.trim().length < 3}>
              Draft
            </Button>
          </div>
          {!ai.data?.configured && <p className="mt-1.5 text-xs text-muted">{ai.data?.reason ?? 'AI is not configured.'}</p>}
          {aiNote && <p className="mt-2 text-xs text-ink-soft">AI suggestion, review before saving: {aiNote}</p>}
        </div>
      )}
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()}>
        <Field label="Title" htmlFor="t-title" className="sm:col-span-2" error={f.formState.errors.title?.message}>
          <Input id="t-title" {...f.register('title', { required: 'Title is required', maxLength: 200 })} autoFocus />
        </Field>
        <Field label="Description" htmlFor="t-desc" className="sm:col-span-2">
          <Textarea id="t-desc" rows={3} {...f.register('description')} />
        </Field>
        <Field label="Status" htmlFor="t-status">
          <Select id="t-status" {...f.register('status')}>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority" htmlFor="t-pri">
          <Select id="t-pri" {...f.register('priority')}>
            {PRIORITIES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Expected impact" htmlFor="t-impact" hint="The business value of the outcome, not the effort.">
          <Select id="t-impact" {...f.register('impactLevel')}>
            {IMPACT_LEVELS.map((s) => (
              <option key={s} value={s}>
                {s === 'NONE' ? 'Not rated' : label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Complexity" htmlFor="t-cx">
          <Select id="t-cx" {...f.register('complexity')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} · {['Trivial', 'Simple', 'Moderate', 'Complex', 'Very complex'][n - 1]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assignee" htmlFor="t-assignee">
          <Select id="t-assignee" {...f.register('assigneeId')}>
            {isManager && <option value="auto">Auto-assign (best fit)</option>}
            <option value="">Unassigned</option>
            {assignable.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.userId === me?.user.id ? `${m.name} (me)` : m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Project" htmlFor="t-project">
          <Select id="t-project" {...f.register('projectId')}>
            <option value="">No project</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due date" htmlFor="t-due">
          <Input id="t-due" type="date" {...f.register('dueAt')} />
        </Field>
        <Field label="Estimate (minutes)" htmlFor="t-est">
          <Input id="t-est" type="number" min={0} step={15} {...f.register('estimateMins')} />
        </Field>
        <Field label="Goal" htmlFor="t-goal">
          <Select id="t-goal" {...f.register('goalId')}>
            <option value="">Not linked</option>
            {(goals.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Repeats" htmlFor="t-rec">
          <Select id="t-rec" {...f.register('recurrenceRule')}>
            <option value="">Does not repeat</option>
            <option value="DAILY">Daily</option>
            <option value="WEEKDAYS">Weekdays</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>
        </Field>
        <Field label="Category" htmlFor="t-cat">
          <Input id="t-cat" placeholder="e.g. Engineering" {...f.register('category')} />
        </Field>
        <Field label="Labels" htmlFor="t-labels" hint="Comma-separated">
          <Input id="t-labels" {...f.register('labels')} />
        </Field>
        {subtasks.length > 0 && (
          <div className="sm:col-span-2">
            <p className="mb-1.5 text-xs font-medium text-ink-soft">Subtasks to create</p>
            <ul className="space-y-1">
              {subtasks.map((s, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Input value={s} onChange={(e) => setSubtasks((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Subtask ${i + 1}`} />
                  <Button variant="ghost" size="sm" onClick={() => setSubtasks((xs) => xs.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  )
}

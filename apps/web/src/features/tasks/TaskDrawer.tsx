import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, ExternalLink, FileUp, Link2, Paperclip, Plus, Sparkles, Trash2, X, XCircle } from 'lucide-react'
import { EVIDENCE_KINDS, IMPACT_LEVELS, PRIORITIES, TASK_STATUSES } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAiStatus, useGoalsList, useMembers, useProjects } from '@/lib/queries'
import { ago, fmtDate, fmtDateTime, minutes } from '@/lib/utils'
import { Avatar, Badge, Button, Field, Input, Select, Spinner, Textarea, label, ErrorState } from '@/components/ui'
import { Confirm, Modal, Sheet, SheetClose, Tabs, TabPanel } from '@/components/ui/overlay'
import type { Task } from '@/lib/types'
import { ImpactBadge, PROVIDER_NAME, SourceBadge, StatusBadge } from './TaskBadges'
import { CreateTaskDialog } from './TaskForm'

interface TaskDetail extends Task {
  creator: { id: string; name: string }
  parent: { id: string; title: string } | null
  subtasks: { id: string; title: string; status: string; assignee: { id: string; name: string } | null }[]
  dependsOn: { id: string; title: string; status: string }[]
  blocking: { id: string; title: string; status: string }[]
  blockers: { id: string; reason: string; kind: string; createdAt: string; resolvedAt: string | null; resolution: string | null }[]
  attachments: { id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string }[]
  assessments: { id: string; quality: number; impact: string | null; note: string | null; assessorId: string; createdAt: string }[]
  conflicts: { id: string; field: string; internalValue: string | null; externalValue: string | null }[]
  source: {
    provider: string
    externalKey: string | null
    sourceUrl: string | null
    lastSyncedAt: string
    externalUpdatedAt: string | null
    raw?: unknown
  } | null
  canAssess: boolean
}

interface EvidenceRow {
  id: string
  kind: string
  title: string
  url: string | null
  source: string
  status: string
  aiSummary: string | null
  createdAt: string
  mimeType: string | null
  canVerify: boolean
  verifications: {
    id: string
    status: string
    qualityScore: number | null
    impactNote: string | null
    note: string | null
    verifierName: string | null
    createdAt: string
  }[]
}

export function TaskDrawer({ taskId, onClose, onOpen }: { taskId: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  return (
    <Sheet open={Boolean(taskId)} onOpenChange={(o) => !o && onClose()} title="Task details">
      {taskId && <TaskDetailView taskId={taskId} onOpen={onOpen} onClose={onClose} />}
    </Sheet>
  )
}

function TaskDetailView({ taskId, onOpen, onClose }: { taskId: string; onOpen: (id: string) => void; onClose: () => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState('details')
  const q = useQuery({ queryKey: ['task', taskId], queryFn: () => api<{ task: TaskDetail }>(`/tasks/${taskId}`), select: (d) => d.task })
  const members = useMembers()
  const projects = useProjects()
  const goals = useGoalsList()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId] })
    qc.invalidateQueries({ queryKey: ['tasks'] })
  }
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/tasks/${taskId}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({
    mutationFn: () => api(`/tasks/${taskId}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh()
      onClose()
      toast.success('Task deleted')
    },
  })

  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const t = q.data
  const ro = !t.canEdit
  const sel = (field: string, value: string) => patch.mutate({ [field]: value === '' ? null : value })

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {t.parent && (
              <button className="mb-1 text-xs text-primary hover:underline" onClick={() => onOpen(t.parent!.id)}>
                ↑ {t.parent.title}
              </button>
            )}
            <input
              key={t.updatedAt}
              defaultValue={t.title}
              disabled={ro}
              aria-label="Title"
              onBlur={(e) => e.target.value.trim() && e.target.value !== t.title && patch.mutate({ title: e.target.value.trim() })}
              className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold text-ink hover:border-line focus:border-primary focus:outline-none disabled:hover:border-transparent"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1">
              <StatusBadge status={t.status} />
              <ImpactBadge impact={t.impactLevel} />
              <SourceBadge task={t} />
              {ro && <Badge tone="neutral">View only</Badge>}
            </div>
          </div>
          <SheetClose className="rounded-md p-1.5 text-muted hover:bg-canvas" aria-label="Close">
            <X className="size-4" />
          </SheetClose>
        </div>
        {t.needsReview && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Some values from {PROVIDER_NAME[t.source?.provider ?? ''] ?? 'the source'} could not be mapped (status, priority or assignee). Check them, or
            approve a mapping in Integrations.
            {t.canEdit && (
              <button className="ml-auto shrink-0 font-medium underline" onClick={() => patch.mutate({ needsReview: false })}>
                Dismiss
              </button>
            )}
          </div>
        )}
        {t.conflicts.length > 0 && <Conflicts conflicts={t.conflicts} onDone={refresh} />}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'details', label: 'Details' },
            { value: 'evidence', label: `Evidence (${t._count.evidence})` },
            { value: 'comments', label: `Comments (${t._count.comments})` },
            { value: 'activity', label: 'Activity' },
          ]}
        >
          <TabPanel value="details" className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status" htmlFor="d-status">
                <Select id="d-status" value={t.status} disabled={ro} onChange={(e) => sel('status', e.target.value)}>
                  {TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority" htmlFor="d-pri">
                <Select id="d-pri" value={t.priority} disabled={ro} onChange={(e) => sel('priority', e.target.value)}>
                  {PRIORITIES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Expected impact" htmlFor="d-imp">
                <Select id="d-imp" value={t.impactLevel} disabled={ro} onChange={(e) => sel('impactLevel', e.target.value)}>
                  {IMPACT_LEVELS.map((s) => (
                    <option key={s} value={s}>
                      {s === 'NONE' ? 'Not rated' : label(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Complexity" htmlFor="d-cx">
                <Select id="d-cx" value={String(t.complexity)} disabled={ro} onChange={(e) => patch.mutate({ complexity: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Assignee" htmlFor="d-as">
                <Select id="d-as" value={t.assigneeId ?? ''} disabled={ro} onChange={(e) => sel('assigneeId', e.target.value)}>
                  <option value="">Unassigned</option>
                  {(members.data ?? [])
                    .filter((m) => m.status === 'ACTIVE')
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Project" htmlFor="d-proj">
                <Select id="d-proj" value={t.projectId ?? ''} disabled={ro} onChange={(e) => sel('projectId', e.target.value)}>
                  <option value="">No project</option>
                  {(projects.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Due date" htmlFor="d-due">
                <Input
                  id="d-due"
                  type="date"
                  disabled={ro}
                  defaultValue={t.dueAt ? t.dueAt.slice(0, 10) : ''}
                  key={`due${t.updatedAt}`}
                  onBlur={(e) => patch.mutate({ dueAt: e.target.value ? new Date(`${e.target.value}T17:00:00`).toISOString() : null })}
                />
              </Field>
              <Field label="Goal" htmlFor="d-goal">
                <Select
                  id="d-goal"
                  value={t.goals[0]?.id ?? ''}
                  disabled={ro}
                  onChange={(e) => patch.mutate({ goalIds: e.target.value ? [e.target.value] : [] })}
                >
                  <option value="">Not linked</option>
                  {[...(goals.data ?? []), ...t.goals.filter((g) => !(goals.data ?? []).some((x) => x.id === g.id))].map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Estimate (min)" htmlFor="d-est">
                <Input
                  id="d-est"
                  type="number"
                  min={0}
                  disabled={ro}
                  defaultValue={t.estimateMins ?? ''}
                  key={`est${t.updatedAt}`}
                  onBlur={(e) => patch.mutate({ estimateMins: e.target.value ? Number(e.target.value) : null })}
                />
              </Field>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-ink-soft">Tracked effort</p>
                <p className="pt-2 text-sm tabular">
                  {minutes(t.actualMins)}
                  {t.estimateMins ? <span className="text-muted"> of {minutes(t.estimateMins)} estimated</span> : null}
                </p>
              </div>
            </div>
            <Field label="Description" htmlFor="d-desc">
              <Textarea
                id="d-desc"
                rows={4}
                disabled={ro}
                defaultValue={t.description ?? ''}
                key={`desc${t.updatedAt}`}
                onBlur={(e) => e.target.value !== (t.description ?? '') && patch.mutate({ description: e.target.value || null })}
              />
            </Field>

            <AiClassify task={t} onApply={(body) => patch.mutate(body)} />
            <Blockers task={t} onChange={refresh} />
            <Subtasks task={t} onOpen={onOpen} onChange={refresh} />
            <Dependencies task={t} onOpen={onOpen} onChange={(ids) => patch.mutate({ dependsOnIds: ids })} />
            <Attachments task={t} onChange={refresh} />
            {t.canAssess && <Assessment task={t} onChange={refresh} />}

            <div className="flex items-center justify-between border-t border-line pt-4 text-xs text-muted">
              <span>
                Created by {t.creator.name} · {fmtDateTime(t.createdAt)}
                {t.reopenCount ? ` · reopened ${t.reopenCount}×` : ''}
              </span>
              {t.canEdit && (
                <Confirm
                  title="Delete this task?"
                  description="It will be removed from lists, analytics and reports. Its history stays in the audit log."
                  confirmLabel="Delete"
                  danger
                  onConfirm={() => del.mutateAsync()}
                  trigger={
                    <Button variant="ghost" size="sm" className="text-danger">
                      <Trash2 /> Delete
                    </Button>
                  }
                />
              )}
            </div>
          </TabPanel>
          <TabPanel value="evidence">
            <Evidence task={t} />
          </TabPanel>
          <TabPanel value="comments">
            <Comments taskId={t.id} />
          </TabPanel>
          <TabPanel value="activity">
            <ActivityList taskId={t.id} />
          </TabPanel>
        </Tabs>
      </div>
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Conflicts({ conflicts, onDone }: { conflicts: TaskDetail['conflicts']; onDone: () => void }) {
  const resolve = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: string }) => api(`/integrations/conflicts/${id}/resolve`, { body: { keep } }),
    onSuccess: onDone,
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-warn/30 bg-warn-soft p-3 text-xs">
      <p className="font-medium text-warn">Changed in both WorkPulse and the source. Choose which value to keep:</p>
      {conflicts.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.field}</span>
          <Button size="sm" variant="secondary" onClick={() => resolve.mutate({ id: c.id, keep: 'internal' })}>
            WorkPulse: {JSON.parse(c.internalValue ?? 'null') ?? '—'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => resolve.mutate({ id: c.id, keep: 'external' })}>
            Source: {JSON.parse(c.externalValue ?? 'null') ?? '—'}
          </Button>
        </div>
      ))}
    </div>
  )
}

function AiClassify({ task, onApply }: { task: TaskDetail; onApply: (b: Record<string, unknown>) => void }) {
  const ai = useAiStatus()
  const goals = useGoalsList()
  const m = useMutation({
    mutationFn: () =>
      api<{ suggestion: { category: string; complexity: number; suggestedImpact: string; suggestedGoalIds: string[]; ambiguous: boolean; rationale: string } }>(
        `/ai/classify/${task.id}`,
        { method: 'POST' },
      ),
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!task.canEdit || !ai.data?.configured) return null
  const s = m.data?.suggestion
  return (
    <div className="rounded-lg border border-dashed border-line-strong p-3">
      {!s ? (
        <Button variant="ghost" size="sm" onClick={() => m.mutate()} loading={m.isPending}>
          <Sparkles className="text-primary" /> Suggest category, complexity and impact
        </Button>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-xs font-medium text-ink-soft">AI suggestion. Nothing changes until you apply it.</p>
          <div className="flex flex-wrap gap-1.5">
            <Badge>{s.category}</Badge>
            <Badge>Complexity {s.complexity}</Badge>
            <Badge tone="teal">{label(s.suggestedImpact)} impact</Badge>
            {s.suggestedGoalIds.map((id) => (
              <Badge key={id} tone="blue">
                {goals.data?.find((g) => g.id === id)?.title ?? 'Goal'}
              </Badge>
            ))}
            {s.ambiguous && <Badge tone="amber">Ambiguous</Badge>}
          </div>
          <p className="text-xs text-muted">{s.rationale}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onApply({
                  category: s.category,
                  complexity: s.complexity,
                  impactLevel: s.suggestedImpact,
                  ...(s.suggestedGoalIds.length ? { goalIds: s.suggestedGoalIds } : {}),
                })
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
    </div>
  )
}

function Blockers({ task, onChange }: { task: TaskDetail; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [kind, setKind] = useState('INTERNAL')
  const add = useMutation({
    mutationFn: () => api(`/tasks/${task.id}/blockers`, { body: { reason, kind } }),
    onSuccess: () => {
      setOpen(false)
      setReason('')
      onChange()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const resolve = useMutation({ mutationFn: (id: string) => api(`/blockers/${id}/resolve`, { body: {} }), onSuccess: onChange })
  const open_ = task.blockers.filter((b) => !b.resolvedAt)
  return (
    <Section
      title="Blockers"
      action={
        task.canEdit && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <Plus /> Report blocker
          </Button>
        )
      }
    >
      {task.blockers.length === 0 ? (
        <p className="text-xs text-muted">No blockers reported.</p>
      ) : (
        <ul className="space-y-1.5">
          {[...open_, ...task.blockers.filter((b) => b.resolvedAt)].map((b) => (
            <li key={b.id} className="flex items-start justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <div>
                <p className={b.resolvedAt ? 'text-muted line-through' : ''}>{b.reason}</p>
                <p className="text-xs text-muted">
                  {label(b.kind)} · {ago(b.createdAt)}
                  {b.resolution ? ` · ${b.resolution}` : ''}
                </p>
              </div>
              {!b.resolvedAt && task.canEdit && (
                <Button size="sm" variant="secondary" onClick={() => resolve.mutate(b.id)}>
                  Resolve
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Report a blocker"
        description="External and dependency blockers are not counted against delivery reliability."
        footer={
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={reason.trim().length < 3}>
            Report
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="What is blocking this?" htmlFor="b-reason">
            <Textarea id="b-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Kind" htmlFor="b-kind">
            <Select id="b-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="INTERNAL">Internal (inside the team)</option>
              <option value="EXTERNAL">External (vendor, customer, other company)</option>
              <option value="DEPENDENCY">Dependency (another team or task)</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </Section>
  )
}

function Subtasks({ task, onOpen, onChange }: { task: TaskDetail; onOpen: (id: string) => void; onChange: () => void }) {
  const [creating, setCreating] = useState(false)
  const ai = useAiStatus()
  const decompose = useMutation({
    mutationFn: () => api<{ subtasks: { title: string; estimateMins: number | null }[]; notes: string }>('/ai/decompose', { body: { taskId: task.id } }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const createAll = useMutation({
    mutationFn: async (items: { title: string; estimateMins: number | null }[]) => {
      for (const s of items)
        await api('/tasks', {
          body: { title: s.title, estimateMins: s.estimateMins, parentId: task.id, assigneeId: task.assigneeId, projectId: task.projectId },
        })
    },
    onSuccess: () => {
      decompose.reset()
      onChange()
    },
  })
  const done = task.subtasks.filter((s) => s.status === 'COMPLETED').length
  return (
    <Section
      title={`Subtasks${task.subtasks.length ? ` · ${done}/${task.subtasks.length}` : ''}`}
      action={
        task.canEdit && (
          <div className="flex gap-1">
            {ai.data?.configured && (
              <Button variant="ghost" size="sm" onClick={() => decompose.mutate()} loading={decompose.isPending}>
                <Sparkles className="text-primary" /> Break down
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
              <Plus /> Add
            </Button>
          </div>
        )
      }
    >
      {task.subtasks.length === 0 && !decompose.data && <p className="text-xs text-muted">No subtasks.</p>}
      <ul className="space-y-1">
        {task.subtasks.map((s) => (
          <li key={s.id}>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-canvas" onClick={() => onOpen(s.id)}>
              {s.status === 'COMPLETED' ? <CheckCircle2 className="size-4 text-success" /> : <span className="size-4 rounded-full border border-line-strong" />}
              <span className={s.status === 'COMPLETED' ? 'text-muted line-through' : ''}>{s.title}</span>
              <span className="ml-auto text-xs text-muted">{s.assignee?.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {decompose.data && (
        <div className="mt-2 rounded-lg border border-dashed border-line-strong p-3 text-sm">
          <p className="mb-1.5 text-xs font-medium text-ink-soft">Suggested subtasks (AI). Review before creating.</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {decompose.data.subtasks.map((s, i) => (
              <li key={i}>
                {s.title}
                {s.estimateMins ? <span className="text-muted"> · {minutes(s.estimateMins)}</span> : null}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => createAll.mutate(decompose.data!.subtasks)} loading={createAll.isPending}>
              Create {decompose.data.subtasks.length}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => decompose.reset()}>
              Discard
            </Button>
          </div>
        </div>
      )}
      <CreateTaskDialog
        open={creating}
        onOpenChange={(o) => {
          setCreating(o)
          if (!o) onChange()
        }}
        defaults={{ parentId: task.id, projectId: task.projectId ?? '', assigneeId: task.assigneeId ?? '' }}
      />
    </Section>
  )
}

function Dependencies({ task, onOpen, onChange }: { task: TaskDetail; onOpen: (id: string) => void; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('')
  const search = useQuery({
    queryKey: ['tasks', 'dep-search', q],
    queryFn: () => api<{ items: Task[] }>('/tasks', { query: { q, pageSize: 6 } }),
    enabled: q.length >= 2,
  })
  const ids = task.dependsOn.map((d) => d.id)
  return (
    <Section title="Dependencies">
      {task.dependsOn.length === 0 && task.blocking.length === 0 && <p className="mb-2 text-xs text-muted">No dependencies.</p>}
      <ul className="space-y-1 text-sm">
        {task.dependsOn.map((d) => (
          <li key={d.id} className="flex items-center gap-2">
            <span className="text-xs text-muted">Waits on</span>
            <button className="text-primary hover:underline" onClick={() => onOpen(d.id)}>
              {d.title}
            </button>
            <StatusBadge status={d.status} />
            {task.canEdit && (
              <button aria-label="Remove dependency" className="ml-auto text-muted hover:text-danger" onClick={() => onChange(ids.filter((x) => x !== d.id))}>
                <X className="size-3.5" />
              </button>
            )}
          </li>
        ))}
        {task.blocking.map((d) => (
          <li key={d.id} className="flex items-center gap-2">
            <span className="text-xs text-muted">Blocks</span>
            <button className="text-primary hover:underline" onClick={() => onOpen(d.id)}>
              {d.title}
            </button>
            <StatusBadge status={d.status} />
          </li>
        ))}
      </ul>
      {task.canEdit && (
        <div className="relative mt-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a task this waits on…" aria-label="Search tasks to add as dependency" />
          {q.length >= 2 && (
            <div className="absolute left-0 right-0 top-10 z-10 rounded-lg border border-line bg-surface shadow">
              {(search.data?.items ?? [])
                .filter((x) => x.id !== task.id && !ids.includes(x.id))
                .map((x) => (
                  <button
                    key={x.id}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-canvas"
                    onClick={() => {
                      onChange([...ids, x.id])
                      setQ('')
                    }}
                  >
                    {x.title}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function Attachments({ task, onChange }: { task: TaskDetail; onChange: () => void }) {
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return api(`/tasks/${task.id}/attachments`, { form })
    },
    onSuccess: () => {
      onChange()
      toast.success('File attached')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({ mutationFn: (id: string) => api(`/attachments/${id}`, { method: 'DELETE' }), onSuccess: onChange })
  return (
    <Section
      title="Attachments"
      action={
        task.canEdit && (
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-soft hover:bg-canvas">
            <Paperclip className="size-3.5" /> Attach
            <input type="file" className="sr-only" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          </label>
        )
      }
    >
      {task.attachments.length === 0 ? (
        <p className="text-xs text-muted">No files.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {task.attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <a className="text-primary hover:underline" href={`/api/attachments/${a.id}/download`}>
                {a.fileName}
              </a>
              <span className="text-xs text-muted">{Math.ceil(a.sizeBytes / 1024)} KB</span>
              {task.canEdit && (
                <button className="ml-auto text-muted hover:text-danger" aria-label={`Remove ${a.fileName}`} onClick={() => remove.mutate(a.id)}>
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Assessment({ task, onChange }: { task: TaskDetail; onChange: () => void }) {
  const [quality, setQuality] = useState(String(task.assessments[0]?.quality ?? 3))
  const [impact, setImpact] = useState(task.assessments[0]?.impact ?? '')
  const [note, setNote] = useState(task.assessments[0]?.note ?? '')
  const save = useMutation({
    mutationFn: () =>
      api(`/tasks/${task.id}/assessment`, { method: 'PUT', body: { quality: Number(quality), impact: impact || null, note: note || undefined } }),
    onSuccess: () => {
      onChange()
      toast.success('Assessment saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Section title="Your assessment (manager)">
      {task.status !== 'COMPLETED' ? (
        <p className="text-xs text-muted">Assess once the task is completed.</p>
      ) : (
        <div className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
          <Field label="Execution quality" htmlFor="as-q">
            <Select id="as-q" value={quality} onChange={(e) => setQuality(e.target.value)}>
              {[
                ['1', '1 · Needs significant rework'],
                ['2', '2 · Below expectations'],
                ['3', '3 · Meets expectations'],
                ['4', '4 · Strong'],
                ['5', '5 · Exceptional'],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Business impact delivered" htmlFor="as-i">
            <Select id="as-i" value={impact} onChange={(e) => setImpact(e.target.value)}>
              <option value="">Not assessed</option>
              {IMPACT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {label(l)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note" htmlFor="as-n" className="sm:col-span-2">
            <Textarea id="as-n" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
              Save assessment
            </Button>
          </div>
        </div>
      )}
    </Section>
  )
}

export function Evidence({ task }: { task: Pick<TaskDetail, 'id' | 'canEdit'> }) {
  const qc = useQueryClient()
  const ai = useAiStatus()
  const q = useQuery({ queryKey: ['evidence', task.id], queryFn: () => api<{ items: EvidenceRow[] }>('/evidence', { query: { taskId: task.id } }) })
  const [adding, setAdding] = useState<'link' | 'file' | null>(null)
  const [verifying, setVerifying] = useState<EvidenceRow | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['evidence', task.id] })
    qc.invalidateQueries({ queryKey: ['task', task.id] })
  }
  const summarize = useMutation({
    mutationFn: (id: string) => api(`/ai/evidence-summary/${id}`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const tone = { RECEIVED: 'amber', VERIFIED: 'green', REJECTED: 'red' } as const
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Evidence shows what was delivered. Receiving it is not verification, and a merged pull request alone does not prove business value.
      </p>
      {task.canEdit && (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setAdding('link')}>
            <Link2 /> Add link
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAdding('file')}>
            <FileUp /> Upload file
          </Button>
        </div>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : (q.data?.items ?? []).length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">No evidence yet.</p>
      ) : (
        <ul className="space-y-2">
          {q.data!.items.map((e) => (
            <li key={e.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{label(e.kind)}</Badge>
                <Badge tone={tone[e.status as keyof typeof tone]}>{label(e.status)}</Badge>
                {e.source !== 'MANUAL' && e.source !== 'UPLOAD' && <Badge tone="blue">{label(e.source)}</Badge>}
                <span className="ml-auto text-xs text-muted">{ago(e.createdAt)}</span>
              </div>
              <p className="mt-1.5 text-sm font-medium">
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">
                    {e.title} <ExternalLink className="size-3" />
                  </a>
                ) : e.mimeType ? (
                  <a href={`/api/evidence/${e.id}/file`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {e.title}
                  </a>
                ) : (
                  e.title
                )}
              </p>
              {e.aiSummary && (
                <p className="mt-1 text-xs text-ink-soft">
                  <span className="font-medium">AI summary:</span> {e.aiSummary}
                </p>
              )}
              {e.verifications.map((v) => (
                <p key={v.id} className="mt-1 text-xs text-muted">
                  {v.status === 'VERIFIED' ? (
                    <CheckCircle2 className="mr-1 inline size-3 text-success" />
                  ) : (
                    <XCircle className="mr-1 inline size-3 text-danger" />
                  )}
                  {label(v.status)} by {v.verifierName} · {fmtDate(v.createdAt)}
                  {v.qualityScore ? ` · quality ${v.qualityScore}/5` : ''}
                  {v.impactNote ? ` · impact: ${v.impactNote}` : ''}
                  {v.note ? ` · ${v.note}` : ''}
                </p>
              ))}
              <div className="mt-2 flex gap-2">
                {e.canVerify && (
                  <Button size="sm" variant="secondary" onClick={() => setVerifying(e)}>
                    Verify / reject
                  </Button>
                )}
                {ai.data?.configured && !e.aiSummary && (
                  <Button size="sm" variant="ghost" onClick={() => summarize.mutate(e.id)} loading={summarize.isPending && summarize.variables === e.id}>
                    <Sparkles className="text-primary" /> Summarise
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <AddEvidence taskId={task.id} mode={adding} onClose={() => setAdding(null)} onDone={refresh} />
      {verifying && <VerifyEvidence evidence={verifying} onClose={() => setVerifying(null)} onDone={refresh} />}
    </div>
  )
}

function AddEvidence({ taskId, mode, onClose, onDone }: { taskId: string; mode: 'link' | 'file' | null; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState('URL')
  const [file, setFile] = useState<File | null>(null)
  const m = useMutation({
    mutationFn: () => {
      if (mode === 'file') {
        const form = new FormData()
        form.append('taskId', taskId)
        form.append('title', title)
        form.append('file', file!)
        return api('/evidence/upload', { form })
      }
      return api('/evidence', { body: { taskId, kind, title, url } })
    },
    onSuccess: () => {
      onDone()
      onClose()
      setTitle('')
      setUrl('')
      setFile(null)
      toast.success('Evidence added')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open={mode !== null}
      onOpenChange={(o) => !o && onClose()}
      title={mode === 'file' ? 'Upload evidence' : 'Add evidence link'}
      footer={
        <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!title || (mode === 'file' ? !file : !url)}>
          Add
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Title" htmlFor="ev-title">
          <Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Production deployment" />
        </Field>
        {mode === 'link' ? (
          <>
            <Field label="Kind" htmlFor="ev-kind">
              <Select id="ev-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                {EVIDENCE_KINDS.filter((k) => !['FILE', 'SCREENSHOT'].includes(k)).map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Link" htmlFor="ev-url">
              <Input id="ev-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </Field>
          </>
        ) : (
          <Field label="File" htmlFor="ev-file" hint="Images, PDF, text, CSV or Office documents.">
            <input id="ev-file" type="file" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

function VerifyEvidence({ evidence, onClose, onDone }: { evidence: EvidenceRow; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState('VERIFIED')
  const [quality, setQuality] = useState('')
  const [impactNote, setImpactNote] = useState('')
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () =>
      api(`/evidence/${evidence.id}/verify`, {
        body: { status, qualityScore: quality ? Number(quality) : null, impactNote: impactNote || undefined, note: note || undefined },
      }),
    onSuccess: () => {
      onDone()
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Verify evidence"
      description={evidence.title}
      footer={
        <Button onClick={() => m.mutate()} loading={m.isPending}>
          Save
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Verification" htmlFor="v-status">
          <Select id="v-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="VERIFIED">Verified: it shows what it claims</option>
            <option value="REJECTED">Rejected: it does not</option>
          </Select>
        </Field>
        <Field label="Quality of the work (optional)" htmlFor="v-q">
          <Select id="v-q" value={quality} onChange={(e) => setQuality(e.target.value)}>
            <option value="">Not assessed</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Business impact observed (optional)" htmlFor="v-imp" hint="Kept separate from verification.">
          <Input id="v-imp" value={impactNote} onChange={(e) => setImpactNote(e.target.value)} placeholder="e.g. Checkout conversion +2%" />
        </Field>
        <Field label="Note" htmlFor="v-note">
          <Textarea id="v-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function Comments({ taskId }: { taskId: string }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const q = useQuery({
    queryKey: ['comments', taskId],
    queryFn: () =>
      api<{ comments: { id: string; body: string; authorName: string | null; createdAt: string; externalId: string | null }[] }>(`/tasks/${taskId}/comments`),
  })
  const add = useMutation({
    mutationFn: () => api(`/tasks/${taskId}/comments`, { body: { body } }),
    onSuccess: () => {
      setBody('')
      qc.invalidateQueries({ queryKey: ['comments', taskId] })
      qc.invalidateQueries({ queryKey: ['task', taskId] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="space-y-3">
      {q.isLoading ? (
        <Spinner />
      ) : (q.data?.comments ?? []).length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {q.data!.comments.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <Avatar name={c.authorName ?? 'External'} />
              <div className="min-w-0 flex-1">
                <p className="text-xs">
                  <span className="font-medium text-ink">{c.authorName ?? 'External'}</span> <span className="text-muted">· {ago(c.createdAt)}</span>
                  {c.externalId && <Badge className="ml-1">synced</Badge>}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-soft">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2 border-t border-line pt-3">
        <Textarea aria-label="Write a comment" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment…" />
        <Button size="sm" onClick={() => add.mutate()} disabled={!body.trim()} loading={add.isPending}>
          Comment
        </Button>
      </div>
    </div>
  )
}

const ACTIVITY_TEXT: Record<string, string> = {
  created: 'created the task',
  imported: 'imported from',
  commented: 'commented',
  blocker_reported: 'reported a blocker',
  blocker_resolved: 'resolved a blocker',
  evidence_added: 'added evidence',
  evidence_verified: 'verified evidence',
  evidence_rejected: 'rejected evidence',
  assessed: 'assessed quality',
  carried_forward: 'carried forward',
  attachment_added: 'attached',
  archived_by_source: 'archived by',
  deleted: 'deleted the task',
  pushed_to_source: 'pushed to source',
  conflict_resolved: 'resolved a conflict',
}

function ActivityList({ taskId }: { taskId: string }) {
  const q = useQuery({
    queryKey: ['activity', taskId],
    queryFn: () =>
      api<{
        activity: {
          id: string
          kind: string
          field: string | null
          fromValue: string | null
          toValue: string | null
          actorType: string
          actorName: string | null
          createdAt: string
        }[]
      }>(`/tasks/${taskId}/activity`),
  })
  if (q.isLoading) return <Spinner />
  const fmt = (v: string | null) => (v == null ? '—' : /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDate(v) : v.length > 36 ? '…' : label(v))
  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {(q.data?.activity ?? []).map((a) => (
        <li key={a.id} className="text-sm">
          <span className="absolute -left-1 mt-1.5 size-2 rounded-full bg-line-strong" />
          <span className="font-medium">
            {a.actorType === 'SYNC' ? 'Sync' : a.actorType === 'SYSTEM' ? 'System' : a.actorType === 'AI' ? 'AI' : (a.actorName ?? 'Someone')}
          </span>{' '}
          <span className="text-ink-soft">
            {a.kind === 'field_changed' ? (
              <>
                changed {a.field} from <b>{fmt(a.fromValue)}</b> to <b>{fmt(a.toValue)}</b>
              </>
            ) : (
              <>
                {ACTIVITY_TEXT[a.kind] ?? a.kind}
                {a.toValue && a.kind !== 'field_changed' ? (
                  <>
                    : <span className="text-ink">{a.toValue}</span>
                  </>
                ) : null}
              </>
            )}
          </span>
          <span className="block text-xs text-muted">{fmtDateTime(a.createdAt)}</span>
        </li>
      ))}
    </ol>
  )
}

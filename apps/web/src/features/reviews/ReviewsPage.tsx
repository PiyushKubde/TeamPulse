import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, MessageSquareQuote, Scale } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { fmtDateTime } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Select, Skeleton, Textarea, PageHeader, label } from '@/components/ui'
import { Modal, Tabs, TabPanel } from '@/components/ui/overlay'

export function ReviewsPage() {
  const { isManager } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'mine'
  return (
    <div>
      <PageHeader
        title="Reviews & feedback"
        description="Feedback, self-assessments, evidence waiting for verification, and correction requests. Manager assessments stay separate from objective delivery metrics."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setParams({ tab: v })}
        tabs={[
          { value: 'mine', label: 'Feedback for me' },
          ...(isManager
            ? [
                { value: 'given', label: 'Feedback I gave' },
                { value: 'evidence', label: 'Evidence to verify' },
              ]
            : []),
          { value: 'unmatched', label: 'Unmatched evidence' },
          { value: 'corrections', label: 'Corrections' },
        ]}
      >
        <TabPanel value="mine">
          <MyFeedback />
        </TabPanel>
        <TabPanel value="given">
          <GivenFeedback />
        </TabPanel>
        <TabPanel value="evidence">
          <EvidenceQueue />
        </TabPanel>
        <TabPanel value="unmatched">
          <Unmatched />
        </TabPanel>
        <TabPanel value="corrections">
          <Corrections />
        </TabPanel>
      </Tabs>
    </div>
  )
}

function MyFeedback() {
  const { me } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['feedback', 'mine'],
    queryFn: () =>
      api<{
        feedback: {
          id: string
          kind: string
          body: string
          rating: number | null
          authorName: string | null
          createdAt: string
          acknowledgedAt: string | null
          response: string | null
          canAcknowledge: boolean
        }[]
      }>('/feedback'),
  })
  const [ack, setAck] = useState<string | null>(null)
  const [response, setResponse] = useState('')
  const [self, setSelf] = useState('')
  const acknowledge = useMutation({
    mutationFn: () => api(`/feedback/${ack}/acknowledge`, { body: { response: response || undefined } }),
    onSuccess: () => {
      setAck(null)
      setResponse('')
      qc.invalidateQueries({ queryKey: ['feedback'] })
    },
  })
  const selfAssess = useMutation({
    mutationFn: () => api('/feedback', { body: { subjectUserId: me!.user.id, kind: 'SELF', body: self, periodLabel: new Date().toISOString().slice(0, 7) } }),
    onSuccess: () => {
      setSelf('')
      qc.invalidateQueries({ queryKey: ['feedback'] })
      toast.success('Self-assessment saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Feedback history" />
        {q.isLoading ? (
          <Skeleton className="m-4 h-24" />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data?.feedback.length ? (
          <EmptyState icon={<MessageSquareQuote />} title="No feedback yet" />
        ) : (
          <ul className="divide-y divide-line">
            {q.data.feedback.map((f) => (
              <li key={f.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge tone={f.kind === 'SELF' ? 'neutral' : 'blue'}>{label(f.kind)}</Badge>
                  {f.authorName} · {fmtDateTime(f.createdAt)}
                  {f.rating ? ` · ${f.rating}/5` : ''}
                  {f.acknowledgedAt && (
                    <Badge tone="green">
                      <CheckCircle2 className="size-3" /> Acknowledged
                    </Badge>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{f.body}</p>
                {f.response && <p className="mt-1 border-l-2 border-line pl-2 text-xs text-muted">Your response: {f.response}</p>}
                {f.canAcknowledge && (
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAck(f.id)}>
                    Acknowledge
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Self-assessment" info="Your own view of your outcomes, kept alongside your manager’s feedback." />
        <div className="space-y-2 p-4">
          <Textarea
            aria-label="Self-assessment"
            rows={6}
            value={self}
            onChange={(e) => setSelf(e.target.value)}
            placeholder="What did you deliver this period, what was its impact, and what would you do differently?"
          />
          <Button onClick={() => selfAssess.mutate()} disabled={self.trim().length < 3} loading={selfAssess.isPending}>
            Save
          </Button>
        </div>
      </Card>
      <Modal
        open={Boolean(ack)}
        onOpenChange={(o) => !o && setAck(null)}
        title="Acknowledge feedback"
        footer={
          <Button onClick={() => acknowledge.mutate()} loading={acknowledge.isPending}>
            Acknowledge
          </Button>
        }
      >
        <Field label="Response (optional)" htmlFor="ack-r">
          <Textarea id="ack-r" rows={3} value={response} onChange={(e) => setResponse(e.target.value)} />
        </Field>
      </Modal>
    </div>
  )
}

function GivenFeedback() {
  const q = useQuery({
    queryKey: ['feedback', 'given'],
    queryFn: () =>
      api<{
        feedback: {
          id: string
          kind: string
          body: string
          subjectName: string | null
          subjectUserId: string
          createdAt: string
          acknowledgedAt: string | null
          response: string | null
        }[]
      }>('/feedback/given'),
  })
  return (
    <Card>
      {q.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : !q.data?.feedback.length ? (
        <EmptyState title="You haven’t given feedback yet" description="Open a person from Member performance to give feedback." />
      ) : (
        <ul className="divide-y divide-line">
          {q.data.feedback.map((f) => (
            <li key={f.id} className="px-4 py-3 text-sm">
              <div className="flex items-center gap-2 text-xs text-muted">
                <Link to={`/team/members/${f.subjectUserId}`} className="font-medium text-ink hover:text-primary">
                  {f.subjectName}
                </Link>
                <Badge>{label(f.kind)}</Badge>
                {fmtDateTime(f.createdAt)}
                {f.acknowledgedAt ? <Badge tone="green">Acknowledged</Badge> : <Badge tone="amber">Not acknowledged</Badge>}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{f.body}</p>
              {f.response && <p className="mt-1 text-xs text-muted">Response: {f.response}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function EvidenceQueue() {
  const q = useQuery({
    queryKey: ['evidence', 'queue'],
    queryFn: () =>
      api<{
        items: {
          id: string
          title: string
          kind: string
          url: string | null
          createdAt: string
          canVerify: boolean
          task: { id: string; title: string } | null
        }[]
      }>('/evidence', { query: { status: 'RECEIVED' } }),
  })
  const items = (q.data?.items ?? []).filter((e) => e.canVerify && e.task)
  return (
    <Card>
      <CardHeader
        title="Evidence waiting for verification"
        info="On tasks of people you manage. Open the task to verify or reject, and optionally record quality and observed impact separately."
      />
      {q.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : !items.length ? (
        <EmptyState icon={<CheckCircle2 />} title="Nothing to verify" />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <Badge>{label(e.kind)}</Badge>
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <Link className="truncate text-xs text-primary hover:underline" to={`/tasks?task=${e.task!.id}&assigneeId=all`}>
                {e.task!.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Unmatched() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['evidence', 'unmatched'],
    queryFn: () =>
      api<{
        items: {
          id: string
          title: string
          kind: string
          url: string | null
          createdAt: string
          suggestedTaskId: string | null
          matchConfidence: number | null
        }[]
      }>('/evidence', { query: { unmatched: true } }),
  })
  const [search, setSearch] = useState<Record<string, string>>({})
  const tasks = useQuery({
    queryKey: ['tasks', 'for-match'],
    queryFn: () => api<{ items: { id: string; title: string }[] }>('/tasks', { query: { assigneeId: 'me', pageSize: 200, sort: 'updatedAt' } }),
  })
  const match = useMutation({
    mutationFn: ({ id, taskId }: { id: string; taskId: string }) => api(`/evidence/${id}/match`, { body: { taskId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evidence'] })
      toast.success('Attached to task')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Card>
      <CardHeader
        title="Collected evidence without a task"
        info="Pull requests, commits and releases that did not mention a task key. Attach each to the task it belongs to; suggestions are never applied automatically."
      />
      {q.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : !q.data?.items.length ? (
        <EmptyState title="Nothing unmatched" />
      ) : (
        <ul className="divide-y divide-line">
          {q.data.items.map((e) => {
            const suggested = tasks.data?.items.find((t) => t.id === e.suggestedTaskId)
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <Badge>{label(e.kind)}</Badge>
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate hover:text-primary">
                    {e.title}
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                )}
                {suggested && (
                  <Button size="sm" variant="secondary" onClick={() => match.mutate({ id: e.id, taskId: suggested.id })}>
                    Attach to “{suggested.title.slice(0, 30)}” <Badge tone="violet">AI {Math.round((e.matchConfidence ?? 0) * 100)}%</Badge>
                  </Button>
                )}
                <Select
                  aria-label="Attach to task"
                  className="w-56"
                  value={search[e.id] ?? ''}
                  onChange={(ev) => {
                    setSearch({ ...search, [e.id]: ev.target.value })
                    if (ev.target.value) match.mutate({ id: e.id, taskId: ev.target.value })
                  }}
                >
                  <option value="">Attach to…</option>
                  {(tasks.data?.items ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </Select>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function Corrections() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['corrections'],
    queryFn: () =>
      api<{
        corrections: {
          id: string
          targetType: string
          targetId: string
          field: string | null
          reason: string
          status: string
          resolution: string | null
          requesterName: string
          createdAt: string
          canResolve: boolean
        }[]
      }>('/corrections'),
  })
  const [creating, setCreating] = useState(false)
  const [resolving, setResolving] = useState<{ id: string; status: string } | null>(null)
  const [text, setText] = useState('')
  const [v, setV] = useState({ targetType: 'TASK', targetId: '', field: '', reason: '' })
  const create = useMutation({
    mutationFn: () => api('/corrections', { body: { ...v, field: v.field || undefined } }),
    onSuccess: () => {
      setCreating(false)
      qc.invalidateQueries({ queryKey: ['corrections'] })
      toast.success('Request sent to your manager')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const resolve = useMutation({
    mutationFn: () => api(`/corrections/${resolving!.id}/resolve`, { body: { status: resolving!.status, resolution: text } }),
    onSuccess: () => {
      setResolving(null)
      setText('')
      qc.invalidateQueries({ queryKey: ['corrections'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Card>
      <CardHeader
        title="Correction requests"
        info="Challenge a rating, assessment, score input or record you think is wrong. Your manager resolves it with a written answer."
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Scale /> Request a correction
          </Button>
        }
      />
      {q.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : !q.data?.corrections.length ? (
        <EmptyState title="No correction requests" />
      ) : (
        <ul className="divide-y divide-line">
          {q.data.corrections.map((c) => (
            <li key={c.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={c.status === 'OPEN' ? 'amber' : c.status === 'ACCEPTED' ? 'green' : 'neutral'}>{label(c.status)}</Badge>
                {c.requesterName} · {label(c.targetType)}
                {c.field ? ` · ${c.field}` : ''} · {fmtDateTime(c.createdAt)}
                {c.targetType === 'TASK' && (
                  <Link to={`/tasks?task=${c.targetId}&assigneeId=all`} className="text-primary hover:underline">
                    Open task
                  </Link>
                )}
              </div>
              <p className="mt-1">{c.reason}</p>
              {c.resolution && <p className="mt-1 border-l-2 border-line pl-2 text-xs text-muted">Resolution: {c.resolution}</p>}
              {c.canResolve && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => setResolving({ id: c.id, status: 'ACCEPTED' })}>
                    Accept
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setResolving({ id: c.id, status: 'REJECTED' })}>
                    Reject
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={creating}
        onOpenChange={setCreating}
        title="Request a correction"
        footer={
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!v.targetId || v.reason.trim().length < 10}>
            Send
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="What is wrong?" htmlFor="c-type">
            <Select id="c-type" value={v.targetType} onChange={(e) => setV({ ...v, targetType: e.target.value })}>
              <option value="TASK">A task (e.g. its impact rating)</option>
              <option value="ASSESSMENT">A quality assessment</option>
              <option value="EVIDENCE">An evidence decision</option>
              <option value="FEEDBACK">Feedback</option>
              <option value="SNAPSHOT">A score snapshot</option>
            </Select>
          </Field>
          <Field label="Record id" htmlFor="c-id" hint="Copy it from the record’s link (the long id in the address bar).">
            <Input id="c-id" value={v.targetId} onChange={(e) => setV({ ...v, targetId: e.target.value.trim() })} />
          </Field>
          <Field label="Field (optional)" htmlFor="c-f">
            <Input id="c-f" value={v.field} onChange={(e) => setV({ ...v, field: e.target.value })} placeholder="e.g. impactLevel" />
          </Field>
          <Field label="Why it should change" htmlFor="c-r">
            <Textarea id="c-r" rows={4} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
          </Field>
        </div>
      </Modal>
      <Modal
        open={Boolean(resolving)}
        onOpenChange={(o) => !o && setResolving(null)}
        title={resolving?.status === 'ACCEPTED' ? 'Accept correction' : 'Reject correction'}
        description="Explain the decision; the requester sees it."
        footer={
          <Button onClick={() => resolve.mutate()} loading={resolve.isPending} disabled={text.trim().length < 3}>
            Save
          </Button>
        }
      >
        <Textarea
          aria-label="Resolution"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={resolving?.status === 'ACCEPTED' ? 'What was changed?' : 'Why does the record stand?'}
        />
      </Modal>
    </Card>
  )
}

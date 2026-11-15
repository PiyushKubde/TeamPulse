import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Clock, RefreshCcw, RotateCw, Workflow } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, fmtDateTime } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, KpiCard, PageHeader, Select, Skeleton, label, type Tone } from '@/components/ui'
import { Modal } from '@/components/ui/overlay'
import { PROVIDER_NAME } from '../tasks/TaskBadges'

const EVENT_TONE: Record<string, Tone> = {
  RECEIVED: 'neutral',
  PROCESSING: 'blue',
  PROCESSED: 'green',
  SKIPPED_STALE: 'neutral',
  SKIPPED_DUPLICATE: 'neutral',
  NEEDS_MAPPING: 'amber',
  FAILED: 'red',
  DEAD: 'red',
}
const EVENT_TEXT: Record<string, string> = { SKIPPED_STALE: 'Skipped (older than stored)', NEEDS_MAPPING: 'Needs mapping', DEAD: 'Failed after retries' }

export function AutomationCenter() {
  const q = useQuery({
    queryKey: ['automations'],
    queryFn: () =>
      api<{
        workflows: {
          id: string
          provider: string
          connectionId: string
          kind: string
          name: string
          status: string
          lastEventAt: string | null
          createdAt: string
          events: Record<string, number>
        }[]
        executions: { id: string; automation: string; status: string; attempts: number; error: string | null; updatedAt: string }[]
        scheduled: { key: string; name: string; schedule: string; channel: string }[]
      }>('/automations'),
  })
  const [runsFor, setRunsFor] = useState<string | null>(null)
  return (
    <div>
      <PageHeader
        title="Automation Center"
        description="Everything WorkPulse runs for you: live event subscriptions, delivery flows and scheduled automations."
        actions={
          <Link to="/integrations">
            <Button variant="secondary">Manage connections</Button>
          </Link>
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-96" />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Connected workflows" value={q.data.workflows.length} />
            <KpiCard label="Active" value={q.data.workflows.filter((w) => w.status === 'ACTIVE').length} tone="green" />
            <KpiCard
              label="With errors"
              value={q.data.workflows.filter((w) => w.status === 'ERROR').length}
              tone={q.data.workflows.some((w) => w.status === 'ERROR') ? 'red' : undefined}
            />
            <KpiCard
              label="Failed deliveries"
              value={q.data.executions.filter((e) => e.status === 'FAILED').length}
              tone={q.data.executions.some((e) => e.status === 'FAILED') ? 'red' : undefined}
            />
          </div>
          <Card>
            <CardHeader
              title="Your workflows on viaSocket"
              info="Event subscriptions bring new and updated work in; action flows deliver messages and push status. They run under your own connections."
            />
            {q.data.workflows.length === 0 ? (
              <EmptyState
                icon={<Workflow />}
                title="No workflows yet"
                description="Connect Linear, Jira, GitHub or Slack and choose what to sync."
                action={
                  <Link to="/integrations">
                    <Button size="sm">Go to Integrations</Button>
                  </Link>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="border-b border-line text-left text-xs text-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Workflow</th>
                      <th className="px-4 py-2.5 font-medium">App</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">Last event</th>
                      <th className="px-4 py-2.5 font-medium">Events</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.workflows.map((w) => (
                      <tr key={w.id} className="border-b border-line/70 last:border-0">
                        <td className="px-4 py-2.5">
                          <p className="font-medium">{w.name}</p>
                          <p className="text-xs text-muted">{w.kind === 'action_flow' ? 'Action flow' : 'Event subscription'}</p>
                        </td>
                        <td className="px-4 py-2.5">{PROVIDER_NAME[w.provider] ?? w.provider}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={w.status === 'ACTIVE' ? 'green' : w.status === 'ERROR' ? 'red' : 'neutral'}>{label(w.status)}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted">{w.kind === 'action_flow' ? '—' : ago(w.lastEventAt)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(w.events).map(([s, n]) => (
                              <Badge key={s} tone={EVENT_TONE[s]}>
                                {n} {(EVENT_TEXT[s] ?? label(s)).toLowerCase()}
                              </Badge>
                            ))}
                            {!Object.keys(w.events).length && <span className="text-xs text-muted">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="ghost" onClick={() => setRunsFor(w.id)}>
                            Run history
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Scheduled automations"
                info="Run by WorkPulse’s worker. External delivery only goes to destinations you connected and chose."
              />
              <ul className="divide-y divide-line">
                {q.data.scheduled.map((s) => (
                  <li key={s.key} className="flex items-start gap-3 px-4 py-2.5">
                    <Clock className="mt-0.5 size-4 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{s.name}</p>
                      <p className="text-xs text-muted">
                        {s.schedule} · {s.channel}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Recent deliveries" info="Each delivery runs once per dedupe key; retries never send twice." />
              {q.data.executions.length === 0 ? (
                <EmptyState title="No deliveries yet" />
              ) : (
                <ul className="max-h-96 divide-y divide-line overflow-y-auto">
                  {q.data.executions.map((e) => (
                    <li key={e.id} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{label(e.automation)}</span>
                        <Badge tone={e.status === 'SUCCEEDED' ? 'green' : e.status === 'FAILED' ? 'red' : 'blue'}>{label(e.status)}</Badge>
                        <span className="ml-auto text-xs text-muted">{ago(e.updatedAt)}</span>
                      </div>
                      {e.error && <p className="mt-0.5 text-xs text-danger">{e.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
      {runsFor && <RunHistory id={runsFor} onClose={() => setRunsFor(null)} />}
    </div>
  )
}

function RunHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['runs', id],
    queryFn: () => api<{ runs: { status: string; createdAt: string; console: unknown; flowHitId: string }[] }>(`/automations/${id}/runs`),
  })
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Run history" description="The last 30 days, from viaSocket." wide>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : !q.data?.runs.length ? (
        <EmptyState title="No runs yet" />
      ) : (
        <ul className="divide-y divide-line">
          {q.data.runs.map((r) => (
            <li key={r.flowHitId} className="py-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={r.status === 'success' ? 'green' : 'red'}>{r.status}</Badge>
                <span className="text-xs text-muted">{fmtDateTime(r.createdAt)}</span>
              </div>
              {r.status !== 'success' && r.console != null && (
                <pre className="mt-1 max-h-32 overflow-auto rounded bg-canvas p-2 text-[11px]">{JSON.stringify(r.console, null, 1).slice(0, 2000)}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

export function SyncHistory() {
  const { isAdmin } = useAuth()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const all = params.get('all') === 'true'
  const connectionId = params.get('connectionId') ?? undefined
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['sync-history', status, all, connectionId, page],
    queryFn: () =>
      api<{
        items: {
          id: string
          provider: string
          eventType: string
          status: string
          attempts: number
          error: string | null
          taskId: string | null
          receivedAt: string
          subscription: { triggerKey: string; resource: string } | null
        }[]
        total: number
        counts: Record<string, number>
      }>('/integrations/sync-history', { query: { status: status || undefined, all, connectionId, page } }),
  })
  const retry = useMutation({
    mutationFn: (eventId: string) => api('/integrations/retry', { body: { eventId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sync-history'] })
      toast.success('Queued for retry')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const set = (k: string, v: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (v) n.set(k, v)
      else n.delete(k)
      return n
    })
  return (
    <div>
      <PageHeader
        title="Sync history"
        description="Every event received from your connected apps and what happened to it. Duplicates are absorbed; older updates never overwrite newer ones."
        actions={
          <>
            <Select
              aria-label="Status"
              className="w-48"
              value={status}
              onChange={(e) => {
                set('status', e.target.value)
                setPage(1)
              }}
            >
              <option value="">All outcomes</option>
              {Object.keys(EVENT_TONE).map((s) => (
                <option key={s} value={s}>
                  {EVENT_TEXT[s] ?? label(s)}
                </option>
              ))}
            </Select>
            {isAdmin && (
              <Select aria-label="Scope" className="w-40" value={all ? 'all' : 'mine'} onChange={(e) => set('all', e.target.value === 'all' ? 'true' : '')}>
                <option value="mine">My connections</option>
                <option value="all">Whole organization</option>
              </Select>
            )}
            {connectionId && (
              <Button variant="ghost" size="sm" onClick={() => set('connectionId', '')}>
                All connections
              </Button>
            )}
            <Button variant="secondary" onClick={() => q.refetch()}>
              <RefreshCcw /> Refresh
            </Button>
          </>
        }
      />
      {q.data && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {Object.entries(q.data.counts).map(([s, n]) => (
            <button key={s} onClick={() => set('status', s)}>
              <Badge tone={EVENT_TONE[s]}>
                {n} {(EVENT_TEXT[s] ?? label(s)).toLowerCase()}
              </Badge>
            </button>
          ))}
        </div>
      )}
      <Card>
        {q.isLoading ? (
          <Skeleton className="m-4 h-40" />
        ) : q.error || !q.data ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState icon={<RefreshCcw />} title="No sync events" description="Events appear here once a connected app sends new or updated work." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Received</th>
                  <th className="px-4 py-2.5 font-medium">App / event</th>
                  <th className="px-4 py-2.5 font-medium">Outcome</th>
                  <th className="px-4 py-2.5 font-medium">Details</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((e) => (
                  <tr key={e.id} className="border-b border-line/70 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">{fmtDateTime(e.receivedAt)}</td>
                    <td className="px-4 py-2.5">
                      <p>{PROVIDER_NAME[e.provider] ?? e.provider}</p>
                      <p className="text-xs text-muted">
                        {(e.subscription?.triggerKey ?? e.eventType).replace(/_/g, ' ')}
                        {e.subscription?.resource ? ` · ${e.subscription.resource}` : ''}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={EVENT_TONE[e.status]}>{EVENT_TEXT[e.status] ?? label(e.status)}</Badge>
                      {e.attempts > 1 && <span className="ml-1 text-xs text-muted">{e.attempts} attempts</span>}
                    </td>
                    <td className="max-w-xs px-4 py-2.5 text-xs text-ink-soft">
                      <p className="line-clamp-2">{e.error ?? '—'}</p>
                      {e.taskId && (
                        <Link to={`/tasks?task=${e.taskId}&assigneeId=all`} className="text-primary hover:underline">
                          Open task
                        </Link>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setDetail(e.id)}>
                        Inspect
                      </Button>
                      {['FAILED', 'DEAD', 'NEEDS_MAPPING'].includes(e.status) && e.subscription && (
                        <Button size="sm" variant="secondary" onClick={() => retry.mutate(e.id)} loading={retry.isPending && retry.variables === e.id}>
                          <RotateCw /> Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted">
              <span>{q.data.total} events</span>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="ghost" disabled={page * 50 >= q.data.total} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </span>
            </div>
          </div>
        )}
      </Card>
      {detail && <EventDetail id={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function EventDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['sync-event', id],
    queryFn: () => api<{ event: { payload: unknown; idempotencyKey: string; error: string | null; status: string } }>(`/integrations/sync-history/${id}`),
  })
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="Imported data"
      description="The raw event as received. It is untrusted data: only the mapped fields reach your task."
    >
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.data ? (
        <div className="space-y-2 text-xs">
          <p>
            <span className="text-muted">Idempotency key:</span> <code>{q.data.event.idempotencyKey}</code>
          </p>
          {q.data.event.error && <p className="text-danger">{q.data.event.error}</p>}
          <pre className="max-h-[50vh] overflow-auto rounded-lg bg-canvas p-3">{JSON.stringify(q.data.event.payload, null, 2)}</pre>
        </div>
      ) : (
        <ErrorState error={q.error} />
      )}
    </Modal>
  )
}

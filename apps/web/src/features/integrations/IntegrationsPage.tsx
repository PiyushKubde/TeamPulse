import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { connect } from 'viasocket-apps/browser'
import { AlertTriangle, CheckCircle2, CloudDownload, Info, Plug, RefreshCcw, Send, Unplug } from 'lucide-react'
import { PRIORITIES, TASK_STATUSES } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMembers } from '@/lib/queries'
import { ago, fmtDateTime } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, label } from '@/components/ui'
import { Confirm, Modal, Tabs, TabPanel } from '@/components/ui/overlay'

interface Connection {
  id: string
  provider: string
  label: string | null
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ERROR'
  syncMode: 'IMPORT_ONLY' | 'ONE_WAY' | 'TWO_WAY'
  settings: Record<string, unknown> & {
    teamId?: string
    teamName?: string
    projectKey?: string
    projectName?: string
    repos?: string[]
    importIssues?: boolean
    delivery?: { messageto: string; channelId?: string; userId?: string; label?: string }
    statusMap?: Record<string, string>
    userMap?: Record<string, string>
  }
  lastError: string | null
  lastSyncAt: string | null
  subscriptions: { id: string; triggerKey: string; resource: string; status: string; lastEventAt: string | null }[]
}
interface Provider {
  slug: string
  name: string
  icon: string
  description: string
  capabilities: string[]
  supportsTwoWay: boolean
  pickers: { setting: string; label: string; fieldKey: string }[]
  verifiedLiveAt: string | null
  connections: Connection[]
}
interface Catalog {
  configured: boolean
  liveSyncAvailable: boolean
  providers: Provider[]
}

const STATUS_TONE = { ACTIVE: 'green', EXPIRED: 'amber', ERROR: 'red', REVOKED: 'neutral' } as const

export function IntegrationsPage() {
  const [tab, setTab] = useState('apps')
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<Catalog>('/integrations') })
  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect your own accounts. WorkPulse brings tasks in, collects evidence and delivers reports; each connection belongs to you and only acts for you."
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'apps', label: 'Apps' },
          { value: 'mappings', label: 'Mappings' },
        ]}
      >
        <TabPanel value="apps">
          {q.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          ) : q.error || !q.data ? (
            <Card>
              <ErrorState error={q.error} retry={() => q.refetch()} />
            </Card>
          ) : (
            <div className="space-y-4">
              {!q.data.configured && (
                <Notice tone="red">Integrations are not configured on this server (the viaSocket keys are missing). Ask an administrator.</Notice>
              )}
              {q.data.configured && !q.data.liveSyncAvailable && (
                <Notice tone="amber">
                  Live sync is unavailable: the server has no public address (PUBLIC_API_URL) for viaSocket to send events to. You can still connect apps,
                  import existing issues and send reports.
                </Notice>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                {q.data.providers.map((p) => (
                  <ProviderCard key={p.slug} p={p} disabled={!q.data!.configured} />
                ))}
              </div>
              <p className="text-xs text-muted">
                Trello, Asana, ClickUp, Notion, Google Calendar and Google Sheets are not offered yet. They appear here only once their sync has been built and
                tested.
              </p>
            </div>
          )}
        </TabPanel>
        <TabPanel value="mappings">
          <Mappings />
        </TabPanel>
      </Tabs>
    </div>
  )
}

const Notice = ({ tone, children }: { tone: 'amber' | 'red' | 'blue'; children: React.ReactNode }) => (
  <div
    className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${tone === 'red' ? 'border-danger/20 bg-danger-soft text-danger' : tone === 'amber' ? 'border-warn/20 bg-warn-soft text-warn' : 'border-primary/15 bg-primary-soft text-primary'}`}
  >
    {tone === 'blue' ? <Info className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
    <div>{children}</div>
  </div>
)

function useConnect(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (reconnectAuth?: string) => {
      const setup = await api<{ embedToken: string; serviceId: string; actions: string[] }>('/integrations/connect-setup', { body: { provider: slug } })
      const result = await connect({
        embedToken: setup.embedToken,
        serviceId: setup.serviceId,
        actions: setup.actions,
        skipActionSelection: true,
        ...(reconnectAuth ? { authId: reconnectAuth } : {}),
      })
      return api('/integrations/connect', { body: { provider: slug, authId: result.authId } })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['integrations'] })
      toast.success('Connected. Now choose what to sync.')
    },
    onError: (e) => {
      const code = (e as { code?: string }).code
      if (code === 'closed') toast('Connection window closed before finishing.')
      else toast.error(errorMessage(e))
    },
  })
}

function ProviderCard({ p, disabled }: { p: Provider; disabled: boolean }) {
  const c = useConnect(p.slug)
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 p-4">
        <img src={p.icon} alt="" className="size-10 rounded-lg border border-line object-contain" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{p.name}</p>
            {p.capabilities.map((cap) => (
              <Badge key={cap}>{cap === 'tasks' ? 'Task sync' : cap === 'evidence' ? 'Evidence' : 'Delivery'}</Badge>
            ))}
            {p.verifiedLiveAt ? <Badge tone="green">Verified live</Badge> : <Badge tone="amber">Not yet verified with a live account</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">{p.description}</p>
        </div>
        {p.connections.length === 0 && (
          <Button onClick={() => c.mutate(undefined)} loading={c.isPending} disabled={disabled}>
            <Plug /> Connect
          </Button>
        )}
      </div>
      {p.connections.map((conn) => (
        <ConnectionPanel key={conn.id} p={p} conn={conn} onReconnect={(auth) => c.mutate(auth)} />
      ))}
    </Card>
  )
}

function ConnectionPanel({ p, conn, onReconnect }: { p: Provider; conn: Connection; onReconnect: (authId?: string) => void }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['integrations'] })
  const [settings, setSettings] = useState(conn.settings)
  const [mode, setMode] = useState(conn.syncMode)
  const [statusMapOpen, setStatusMapOpen] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)
  useEffect(() => {
    setSettings(conn.settings)
    setMode(conn.syncMode)
  }, [conn.settings, conn.syncMode])
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ warning: string | null }>(`/integrations/connections/${conn.id}`, { method: 'PATCH', body }),
    onSuccess: (r) => {
      refresh()
      if (r.warning) toast.warning(r.warning)
      else toast.success('Saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const backfill = useMutation({
    mutationFn: () => api(`/integrations/connections/${conn.id}/backfill`, { method: 'POST' }),
    onSuccess: () => toast.success('Import started. New tasks appear in a moment; see Sync History.'),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const test = useMutation({
    mutationFn: () => api(`/integrations/connections/${conn.id}/test-delivery`, { method: 'POST' }),
    onSuccess: () => toast.success('Test message sent'),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const disconnect = useMutation({
    mutationFn: () => api('/integrations/disconnect', { body: { connectionId: conn.id } }),
    onSuccess: () => {
      refresh()
      toast.success('Disconnected and access revoked')
    },
  })
  const isTasks = p.capabilities.includes('tasks') && p.slug !== 'github'
  const active = conn.subscriptions.filter((s) => !s.triggerKey.startsWith('flow:') && s.status === 'ACTIVE').length
  const configured =
    p.slug === 'linear'
      ? Boolean(settings.teamId)
      : p.slug === 'jira-software-cloud'
        ? Boolean(settings.projectKey)
        : p.slug === 'github'
          ? Boolean(settings.repos?.length)
          : p.slug === 'slack'
            ? Boolean(settings.delivery?.channelId || settings.delivery?.userId)
            : true

  return (
    <div className="space-y-4 border-t border-line bg-canvas/40 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={STATUS_TONE[conn.status]}>{label(conn.status)}</Badge>
        <span className="text-muted">
          {conn.label ?? 'Connected account'} · last sync {ago(conn.lastSyncAt)}
        </span>
        {active > 0 && (
          <Badge tone="blue">
            {active} live subscription{active > 1 ? 's' : ''}
          </Badge>
        )}
        {conn.status === 'EXPIRED' && (
          <Button size="sm" onClick={() => onReconnect(undefined)}>
            Reconnect
          </Button>
        )}
      </div>
      {conn.lastError && <Notice tone="red">{conn.lastError}</Notice>}

      {p.slug === 'linear' && (
        <Picker
          conn={conn}
          fieldKey="team_id"
          labelText="Linear team to sync"
          value={settings.teamId}
          display={settings.teamName}
          onPick={(o) => save.mutate({ teamId: o.value, teamName: o.label })}
        />
      )}
      {p.slug === 'jira-software-cloud' && (
        <Picker
          conn={conn}
          fieldKey="project"
          labelText="Jira project to sync"
          value={settings.projectKey}
          display={settings.projectName}
          onPick={(o) => save.mutate({ projectKey: o.value, projectName: o.label })}
        />
      )}
      {p.slug === 'github' && (
        <div className="space-y-2">
          <Picker
            conn={conn}
            fieldKey="repoFullName"
            labelText="Add a repository"
            onPick={(o) => !settings.repos?.includes(o.value) && save.mutate({ repos: [...(settings.repos ?? []), o.value].slice(0, 20) })}
          />
          <div className="flex flex-wrap gap-1.5">
            {(settings.repos ?? []).map((r) => (
              <Badge key={r} tone="blue">
                {r}{' '}
                <button aria-label={`Remove ${r}`} onClick={() => save.mutate({ repos: settings.repos!.filter((x) => x !== r) })}>
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={Boolean(settings.importIssues)} onChange={(e) => save.mutate({ importIssues: e.target.checked })} /> Also import new
            GitHub issues as tasks
          </label>
          <p className="text-xs text-muted">
            Pull requests, commits and releases arrive as evidence. They attach to a task when they mention its key (e.g. ENG-42); otherwise they wait in
            Reviews for you to match them.
          </p>
        </div>
      )}
      {p.slug === 'slack' && (
        <div className="space-y-2">
          <Field label="Send reports and alerts to" htmlFor={`sl-${conn.id}`}>
            <Select
              id={`sl-${conn.id}`}
              value={settings.delivery?.messageto ?? 'channel'}
              onChange={(e) => setSettings({ ...settings, delivery: { messageto: e.target.value } })}
            >
              <option value="channel">A channel</option>
              <option value="user">A direct message to me</option>
            </Select>
          </Field>
          {(settings.delivery?.messageto ?? 'channel') === 'channel' ? (
            <Picker
              conn={conn}
              fieldKey="destination.channel_id"
              labelText="Channel"
              value={settings.delivery?.channelId}
              display={settings.delivery?.label}
              onPick={(o) => save.mutate({ delivery: { messageto: 'channel', channelId: o.value, label: o.label } })}
            />
          ) : (
            <Picker
              conn={conn}
              fieldKey="destination.userId"
              labelText="Choose yourself"
              value={settings.delivery?.userId}
              display={settings.delivery?.label}
              onPick={(o) => save.mutate({ delivery: { messageto: 'user', userId: o.value, label: o.label } })}
            />
          )}
        </div>
      )}
      {p.slug === 'gmail' && <p className="text-sm text-ink-soft">Reports you send by email go from this Gmail account to your own address.</p>}

      {isTasks && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Sync mode"
            htmlFor={`mode-${conn.id}`}
            hint={
              mode === 'IMPORT_ONLY'
                ? 'One-time import; later changes are not synced.'
                : mode === 'ONE_WAY'
                  ? 'Changes flow into WorkPulse. Internal ratings and evidence are never overwritten.'
                  : 'Status changes also flow back. Conflicts are shown for you to resolve.'
            }
          >
            <Select
              id={`mode-${conn.id}`}
              value={mode}
              onChange={(e) => {
                const m = e.target.value as Connection['syncMode']
                if (m === 'TWO_WAY' && !Object.keys(settings.statusMap ?? {}).length) {
                  setStatusMapOpen(true)
                  return
                }
                setMode(m)
                save.mutate({ syncMode: m })
              }}
            >
              <option value="IMPORT_ONLY">Import only</option>
              <option value="ONE_WAY">One-way ({p.name} → WorkPulse)</option>
              {p.supportsTwoWay && <option value="TWO_WAY">Two-way (status)</option>}
            </Select>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => backfill.mutate()} loading={backfill.isPending} disabled={!configured}>
              <CloudDownload /> Import existing issues
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPeopleOpen(true)}>
              Match people
            </Button>
            {p.supportsTwoWay && (
              <Button size="sm" variant="ghost" onClick={() => setStatusMapOpen(true)}>
                Status mapping
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {configured ? (
          <span className="flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="size-3.5" /> Set up
          </span>
        ) : (
          <span className="text-xs text-warn">Finish the choices above to start syncing.</span>
        )}
        {p.capabilities.includes('delivery') && (
          <Button size="sm" variant="secondary" onClick={() => test.mutate()} loading={test.isPending} disabled={!configured}>
            <Send /> Send test message
          </Button>
        )}
        <Link to={`/sync-history?connectionId=${conn.id}`} className="text-xs text-primary hover:underline">
          <RefreshCcw className="mr-1 inline size-3" />
          Sync history
        </Link>
        <Confirm
          title={`Disconnect ${p.name}?`}
          description="WorkPulse removes its automations on this account and revokes access. Tasks already imported stay, but stop syncing."
          confirmLabel="Disconnect"
          danger
          onConfirm={() => disconnect.mutateAsync()}
          trigger={
            <Button size="sm" variant="ghost" className="ml-auto text-danger">
              <Unplug /> Disconnect
            </Button>
          }
        />
      </div>
      {statusMapOpen && (
        <StatusMapDialog
          conn={conn}
          onClose={() => setStatusMapOpen(false)}
          onSave={(statusMap, enable) => {
            save.mutate({ statusMap, ...(enable ? { syncMode: 'TWO_WAY' } : {}) })
            setStatusMapOpen(false)
          }}
        />
      )}
      {peopleOpen && (
        <PeopleDialog
          conn={conn}
          onClose={() => setPeopleOpen(false)}
          onSave={(userMap) => {
            save.mutate({ userMap })
            setPeopleOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** A searchable, paged list of options from the user's own account (viaSocket listOptions), chosen once. */
function Picker({
  conn,
  fieldKey,
  labelText,
  value,
  display,
  onPick,
  existing,
}: {
  conn: Connection
  fieldKey: string
  labelText: string
  value?: string
  display?: string
  onPick: (o: { label: string; value: string }) => void
  existing?: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [pages, setPages] = useState<{ options: { label: string; value: string }[]; paginate: string | null; hasMore: boolean; message: string | null }[]>([])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])
  const load = useMutation({
    mutationFn: (paginate?: string) =>
      api<{ options: { label: string; value: string }[]; paginate: string | null; hasMore: boolean; message: string | null }>(
        `/integrations/connections/${conn.id}/options`,
        { query: { fieldKey, search: debounced || undefined, paginate, existingFields: existing ? JSON.stringify(existing) : undefined } },
      ),
    onSuccess: (r, paginate) => setPages((p) => (paginate ? [...p, r] : [r])),
    onError: (e) => toast.error(errorMessage(e)),
  })
  useEffect(() => {
    if (open) load.mutate(undefined)
  }, [open, debounced]) // eslint-disable-line react-hooks/exhaustive-deps
  const options = pages.flatMap((p) => p.options)
  const last = pages.at(-1)
  return (
    <>
      <Field label={labelText} htmlFor={`pick-${conn.id}-${fieldKey}`}>
        <button
          id={`pick-${conn.id}-${fieldKey}`}
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-9 w-full items-center justify-between rounded-lg border border-line-strong bg-surface px-3 text-left text-sm hover:bg-canvas"
        >
          <span className={value ? '' : 'text-muted'}>{display ?? value ?? 'Choose…'}</span>
          <span className="text-xs text-primary">{value ? 'Change' : 'Choose'}</span>
        </button>
      </Field>
      <Modal open={open} onOpenChange={setOpen} title={labelText} description="From your connected account.">
        <Input aria-label="Search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <div className="mt-3 max-h-80 overflow-y-auto">
          {load.isPending && !options.length ? (
            <Skeleton className="h-24" />
          ) : options.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{last?.message ?? 'Nothing found.'}</p>
          ) : (
            <ul>
              {options.map((o) => (
                <li key={o.value}>
                  <button
                    className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-canvas"
                    onClick={() => {
                      onPick(o)
                      setOpen(false)
                    }}
                  >
                    {o.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {last?.hasMore && (
            <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => load.mutate(last.paginate ?? undefined)} loading={load.isPending}>
              Load more
            </Button>
          )}
        </div>
      </Modal>
    </>
  )
}

function StatusMapDialog({ conn, onClose, onSave }: { conn: Connection; onClose: () => void; onSave: (m: Record<string, string>, enable: boolean) => void }) {
  const [map, setMap] = useState<Record<string, { value: string; label: string }>>(
    Object.fromEntries(Object.entries(conn.settings.statusMap ?? {}).map(([k, v]) => [k, { value: v, label: v }])),
  )
  const [opts, setOpts] = useState<{ label: string; value: string }[]>([])
  const load = useQuery({
    queryKey: ['status-options', conn.id],
    queryFn: () => api<{ options: { label: string; value: string }[] }>(`/integrations/connections/${conn.id}/options`, { query: { fieldKey: 'stateID' } }),
    enabled: Boolean(conn.settings.teamId),
  })
  useEffect(() => {
    if (load.data) setOpts(load.data.options)
  }, [load.data])
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Status mapping for two-way sync"
      description="When a task changes status in WorkPulse, Linear is set to the state you choose here. Unmapped statuses are not pushed."
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() =>
              onSave(
                Object.fromEntries(
                  Object.entries(map)
                    .filter(([, v]) => v.value)
                    .map(([k, v]) => [k, v.value]),
                ),
                false,
              )
            }
          >
            Save
          </Button>
          <Button
            onClick={() =>
              onSave(
                Object.fromEntries(
                  Object.entries(map)
                    .filter(([, v]) => v.value)
                    .map(([k, v]) => [k, v.value]),
                ),
                true,
              )
            }
            disabled={!Object.values(map).some((v) => v.value)}
          >
            Save and turn on two-way
          </Button>
        </>
      }
    >
      {!conn.settings.teamId ? (
        <p className="text-sm text-warn">Choose a Linear team first.</p>
      ) : load.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-2">
          {TASK_STATUSES.map((s) => (
            <div key={s} className="grid grid-cols-[8rem_1fr] items-center gap-3">
              <span className="text-sm">{label(s)}</span>
              <Select
                aria-label={`Linear state for ${label(s)}`}
                value={map[s]?.value ?? ''}
                onChange={(e) => setMap({ ...map, [s]: { value: e.target.value, label: opts.find((o) => o.value === e.target.value)?.label ?? '' } })}
              >
                <option value="">Don’t push</option>
                {opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

function PeopleDialog({ conn, onClose, onSave }: { conn: Connection; onClose: () => void; onSave: (m: Record<string, string>) => void }) {
  const members = useMembers()
  const [rows, setRows] = useState<{ ext: string; user: string }[]>(Object.entries(conn.settings.userMap ?? {}).map(([ext, user]) => ({ ext, user })))
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Match people"
      description="Assignees are matched by email automatically. Add a row when an external account uses a different email (use the external user id shown in Sync History)."
      footer={<Button onClick={() => onSave(Object.fromEntries(rows.filter((r) => r.ext && r.user).map((r) => [r.ext, r.user])))}>Save</Button>}
    >
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              aria-label="External user id"
              value={r.ext}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, ext: e.target.value } : x)))}
              placeholder="External user id"
            />
            <Select aria-label="WorkPulse member" value={r.user} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)))}>
              <option value="">Member…</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Button variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setRows([...rows, { ext: '', user: '' }])}>
          Add match
        </Button>
      </div>
    </Modal>
  )
}

function Mappings() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['mappings'],
    queryFn: () =>
      api<{
        mappings: {
          id: string
          provider: string
          kind: string
          fromValue: string
          toValue: string
          confidence: number
          source: string
          active: boolean
          approvedAt: string | null
        }[]
        canDecide: boolean
      }>('/integrations/mappings'),
  })
  const decide = useMutation({
    mutationFn: ({ id, approve, toValue }: { id: string; approve: boolean; toValue?: string }) =>
      api<{ reprocessed: number }>(`/integrations/mappings/${id}/decision`, { body: { approve, toValue } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['mappings'] })
      toast.success(r.reprocessed ? `Applied to ${r.reprocessed} waiting event(s)` : 'Saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const [choice, setChoice] = useState<Record<string, string>>({})
  if (q.isLoading) return <Skeleton className="h-40" />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const pending = q.data.mappings.filter((m) => !m.approvedAt)
  const decided = q.data.mappings.filter((m) => m.approvedAt)
  return (
    <div className="space-y-4">
      <Notice tone="blue">
        Values WorkPulse did not recognise (a custom status like “QA Ready”) are imported with a safe default and flagged. Approve a mapping and the waiting
        events are re-applied. AI suggestions are never applied without approval.
      </Notice>
      <Card>
        <CardHeader title="Waiting for a decision" />
        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting" />
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <Badge>{m.provider}</Badge>
                <Badge tone="neutral">{label(m.kind)}</Badge>
                <span className="font-medium">“{m.fromValue}”</span>→
                <Select
                  aria-label={`Map ${m.fromValue}`}
                  className="w-40"
                  value={choice[m.id] ?? m.toValue}
                  onChange={(e) => setChoice({ ...choice, [m.id]: e.target.value })}
                  disabled={!q.data!.canDecide}
                >
                  {(m.kind === 'STATUS' ? TASK_STATUSES : PRIORITIES).map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </Select>
                {m.source === 'AI' && <Badge tone="violet">AI suggestion · {Math.round(m.confidence * 100)}%</Badge>}
                {q.data!.canDecide ? (
                  <span className="ml-auto flex gap-2">
                    <Button size="sm" onClick={() => decide.mutate({ id: m.id, approve: true, toValue: choice[m.id] ?? m.toValue })}>
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: m.id, approve: false })}>
                      Reject
                    </Button>
                  </span>
                ) : (
                  <span className="ml-auto text-xs text-muted">A manager or admin decides</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {decided.length > 0 && (
        <Card>
          <CardHeader title="Decided" />
          <ul className="divide-y divide-line">
            {decided.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <Badge>{m.provider}</Badge>“{m.fromValue}” → {label(m.toValue)}
                <Badge tone={m.active ? 'green' : 'neutral'} className="ml-auto">
                  {m.active ? 'Active' : 'Rejected'}
                </Badge>
                <span className="text-xs text-muted">{fmtDateTime(m.approvedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

export { Notice }
export const useIsAdmin = () => useAuth().isAdmin

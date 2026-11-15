import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { connect } from 'viasocket-apps/browser'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, CloudDownload, Info, Plug, RefreshCcw, Send, Unplug } from 'lucide-react'
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
    intake?: { channelId: string; label?: string } | null
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

/** What a provider does in each direction, shown on its card. */
function directions(p: Provider) {
  const into = [
    p.capabilities.includes('tasks') && (p.slug === 'github' ? 'tasks from issues (optional)' : 'tasks'),
    p.capabilities.includes('evidence') && 'evidence',
    p.capabilities.includes('intake') && 'tasks from messages',
  ].filter(Boolean) as string[]
  const out = [
    p.capabilities.includes('delivery') && (p.slug === 'gmail' ? 'reports, KONVO system emails' : 'reports, alerts, task confirmations'),
    p.supportsTwoWay && 'status updates (optional)',
  ].filter(Boolean) as string[]
  return { into, out }
}

function Direction({ dir, title, subtitle, children }: { dir: 'in' | 'out'; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className={`space-y-3 rounded-lg border bg-surface p-3 ${dir === 'in' ? 'border-teal/30' : 'border-primary/25'}`}>
      <header className="flex items-center gap-2">
        <span className={`flex size-6 items-center justify-center rounded-md ${dir === 'in' ? 'bg-teal-soft text-teal' : 'bg-primary-soft text-primary'}`}>
          {dir === 'in' ? <ArrowDownToLine className="size-3.5" /> : <ArrowUpFromLine className="size-3.5" />}
        </span>
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
      </header>
      {children}
    </section>
  )
}

export function IntegrationsPage() {
  const [tab, setTab] = useState('apps')
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<Catalog>('/integrations') })
  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Each connection works in two directions: into KONVO (new tasks and evidence arrive by themselves) and out of KONVO (reports, alerts and status updates are sent by themselves). Each connection belongs to you and only acts for you."
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'apps', label: 'Apps' },
          { value: 'mappings', label: 'Unrecognised values' },
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
            {p.verifiedLiveAt ? <Badge tone="green">Verified live</Badge> : <Badge tone="amber">Not yet verified with a live account</Badge>}
          </div>
          <div className="mt-2 grid gap-1 text-xs">
            <p className="flex items-start gap-1.5">
              <ArrowDownToLine className="mt-0.5 size-3.5 shrink-0 text-teal" />
              <span>
                <span className="font-medium text-ink">Into KONVO:</span> <span className="text-ink-soft">{directions(p).into.join(', ') || 'nothing'}</span>
              </span>
            </p>
            <p className="flex items-start gap-1.5">
              <ArrowUpFromLine className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span>
                <span className="font-medium text-ink">Out of KONVO:</span>{' '}
                <span className="text-ink-soft">{directions(p).out.join(', ') || 'nothing (read only)'}</span>
              </span>
            </p>
          </div>
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
  const active = conn.subscriptions.filter((s) => !s.triggerKey.startsWith('flow:') && s.status === 'ACTIVE').length
  const configured =
    p.slug === 'linear'
      ? Boolean(settings.teamId)
      : p.slug === 'jira-software-cloud'
        ? Boolean(settings.projectKey)
        : p.slug === 'github'
          ? Boolean(settings.repos?.length)
          : p.slug === 'slack'
            ? Boolean(settings.intake?.channelId || settings.delivery?.channelId || settings.delivery?.userId)
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
        <Button
          size="sm"
          variant={conn.status === 'EXPIRED' ? 'primary' : 'ghost'}
          onClick={() => onReconnect(undefined)}
          title="Sign in again, for an expired connection or to grant permissions a new feature needs. Your choices are kept."
        >
          {conn.status === 'EXPIRED' ? 'Reconnect' : 'Reconnect / update permissions'}
        </Button>
      </div>
      {conn.lastError && <Notice tone="red">{conn.lastError}</Notice>}

      <Direction dir="in" title="Into KONVO" subtitle={`What ${p.name} creates here, automatically`}>
        {(p.slug === 'linear' || p.slug === 'jira-software-cloud') && (
          <>
            <Picker
              conn={conn}
              fieldKey={p.slug === 'linear' ? 'team_id' : 'project'}
              labelText={p.slug === 'linear' ? 'Bring in issues from this Linear team' : 'Bring in issues from this Jira project'}
              value={p.slug === 'linear' ? settings.teamId : settings.projectKey}
              display={p.slug === 'linear' ? settings.teamName : settings.projectName}
              onPick={(o) => save.mutate(p.slug === 'linear' ? { teamId: o.value, teamName: o.label } : { projectKey: o.value, projectName: o.label })}
            />
            <Field
              label="How"
              htmlFor={`mode-${conn.id}`}
              hint={
                mode === 'IMPORT_ONLY'
                  ? 'Only what you import with the button below. Later changes in ' + p.name + ' are ignored.'
                  : `New issues become tasks automatically, and edits, status changes and comments keep them up to date. Your impact ratings, assessments and evidence in KONVO are never overwritten.`
              }
            >
              <Select
                id={`mode-${conn.id}`}
                value={mode === 'IMPORT_ONLY' ? 'IMPORT_ONLY' : 'SYNC'}
                onChange={(e) => {
                  const m = e.target.value === 'IMPORT_ONLY' ? 'IMPORT_ONLY' : 'ONE_WAY'
                  setMode(m)
                  save.mutate({ syncMode: m })
                }}
              >
                <option value="SYNC">Keep in sync automatically</option>
                <option value="IMPORT_ONLY">Import existing issues only</option>
              </Select>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => backfill.mutate()} loading={backfill.isPending} disabled={!configured}>
                <CloudDownload /> Import existing issues (last 90 days)
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPeopleOpen(true)}>
                Match people
              </Button>
            </div>
          </>
        )}
        {p.slug === 'github' && (
          <>
            <Picker
              conn={conn}
              fieldKey="repoFullName"
              labelText="Watch a repository"
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
            <p className="text-xs text-muted">
              Pull requests, commits and releases arrive as <strong>evidence</strong> and attach to the task whose key they mention (e.g. ENG-42); the rest wait
              in Reviews for you to match.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={Boolean(settings.importIssues)} onChange={(e) => save.mutate({ importIssues: e.target.checked })} /> Also create
              tasks from new GitHub issues
            </label>
          </>
        )}
        {p.slug === 'slack' && (
          <>
            <Picker
              conn={conn}
              fieldKey="channel_id"
              labelText="Turn messages in this channel into tasks"
              value={settings.intake?.channelId}
              display={settings.intake?.label}
              onPick={(o) => save.mutate({ intake: { channelId: o.value, label: o.label } })}
            />
            <p className="text-xs text-muted">
              AI reads every message posted there: work requests become tasks (title, priority, due date, assignee), chatter is skipped. Bot messages, including
              KONVO’s own, are ignored.
            </p>
            {settings.intake?.channelId && (
              <Button size="sm" variant="ghost" onClick={() => save.mutate({ intake: null })}>
                Stop creating tasks from Slack
              </Button>
            )}
          </>
        )}
        {p.slug === 'gmail' && <p className="text-xs text-muted">Nothing: Gmail does not create tasks in KONVO.</p>}
      </Direction>

      <Direction dir="out" title="Out of KONVO" subtitle={`What KONVO sends to ${p.name}, automatically`}>
        {p.slug === 'linear' && (
          <>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                disabled={mode === 'IMPORT_ONLY'}
                checked={mode === 'TWO_WAY'}
                onChange={(e) => {
                  if (e.target.checked && !Object.keys(settings.statusMap ?? {}).length) return setStatusMapOpen(true)
                  const m = e.target.checked ? 'TWO_WAY' : 'ONE_WAY'
                  setMode(m)
                  save.mutate({ syncMode: m })
                }}
              />
              <span>
                Update the Linear issue when its status changes in KONVO
                <span className="block text-xs text-muted">
                  {mode === 'IMPORT_ONLY'
                    ? 'Needs “Keep in sync automatically” above.'
                    : 'If both sides change the same field before syncing, you choose which value wins.'}
                </span>
              </span>
            </label>
            <Button size="sm" variant="ghost" onClick={() => setStatusMapOpen(true)}>
              Status mapping
            </Button>
          </>
        )}
        {(p.slug === 'jira-software-cloud' || p.slug === 'github') && (
          <p className="text-xs text-muted">Nothing: KONVO only reads from {p.name}; it never changes anything there.</p>
        )}
        {p.slug === 'slack' && (
          <>
            <Field label="Send to" htmlFor={`sl-${conn.id}`}>
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
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
              <li>Daily report, weekdays 18:00 (your time zone)</li>
              <li>Weekly report, Mondays</li>
              <li>Blocker escalations for people you manage (blocked over 48 h)</li>
              <li>“Task created” confirmations for messages turned into tasks</li>
              <li>Any report you send with “Send to Slack”</li>
            </ul>
          </>
        )}
        {p.slug === 'gmail' && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
            <li>Reports you send with “Email me”, to your own address</li>
            <li>When you are an owner or admin: KONVO’s own emails (verification, password reset, invitations) to anyone in the organization</li>
          </ul>
        )}
        {p.capabilities.includes('delivery') && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => test.mutate()}
            loading={test.isPending}
            disabled={p.slug === 'slack' && !(settings.delivery?.channelId || settings.delivery?.userId)}
          >
            <Send /> Send test message
          </Button>
        )}
      </Direction>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {configured ? (
          <span className="flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="size-3.5" /> Set up
          </span>
        ) : (
          <span className="text-xs text-warn">Finish the choices above to start syncing.</span>
        )}
        <Link to={`/sync-history?connectionId=${conn.id}`} className="text-xs text-primary hover:underline">
          <RefreshCcw className="mr-1 inline size-3" />
          Sync history
        </Link>
        <Confirm
          title={`Disconnect ${p.name}?`}
          description="KONVO removes its automations on this account and revokes access. Tasks already imported stay, but stop syncing."
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
          className="flex h-9 w-full items-center justify-between rounded-lg border border-line-strong bg-surface px-3 text-left text-sm hover:bg-hover"
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
                    className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-hover"
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
      description="When a task changes status in KONVO, Linear is set to the state you choose here. Unmapped statuses are not pushed."
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
            <Select aria-label="KONVO member" value={r.user} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)))}>
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
        <p>
          KONVO has a fixed set of statuses (Backlog, To do, In progress, In review, Blocked, Completed, Cancelled) and priorities. Linear and Jira let teams
          invent their own, like a status called “QA Ready”. KONVO understands the common ones by itself (“In Progress”, “Done”, “Won’t Do”…).
        </p>
        <p className="mt-1.5">
          When it meets one it doesn’t know, the task is still imported (as “To do”) and marked “Needs review”, and the value is listed here. AI suggests what
          it probably means (for example “QA Ready” → In review). A manager or admin clicks <strong>Approve</strong> (or picks another value), and every task
          waiting on it is corrected at once. From then on that value is understood automatically.
        </p>
      </Notice>
      <Card>
        <CardHeader title="Waiting for a decision" description="Each row is a value from one of your apps that KONVO has not seen before." />
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

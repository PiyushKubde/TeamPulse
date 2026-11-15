import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Plus, Trash2, UserPlus } from 'lucide-react'
import { DEFAULT_WEIGHTS, ROLES, SCORE_DIMENSIONS } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMembers, useTeams } from '@/lib/queries'
import { fmtDateTime } from '@/lib/utils'
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Skeleton, label } from '@/components/ui'
import { Confirm, Modal, Tabs, TabPanel } from '@/components/ui/overlay'
import { DIMENSION_INFO } from '../dashboard/IndividualAnalytics'

export function SettingsPage() {
  const { isAdmin, isManager } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'profile'
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs
        value={tab}
        onValueChange={(v) => setParams({ tab: v })}
        tabs={[
          { value: 'profile', label: 'Profile' },
          ...(isManager
            ? [
                { value: 'members', label: 'Members' },
                { value: 'teams', label: 'Teams' },
              ]
            : []),
          ...(isAdmin
            ? [
                { value: 'org', label: 'Organization' },
                { value: 'mentors', label: 'Mentors' },
              ]
            : []),
          { value: 'scoring', label: 'Scoring' },
          ...(isAdmin ? [{ value: 'audit', label: 'Audit log' }] : []),
        ]}
      >
        <TabPanel value="profile">
          <div className="grid gap-4 xl:grid-cols-2">
            <Profile />
            <PhoneAlerts />
          </div>
        </TabPanel>
        <TabPanel value="members">
          <Members />
        </TabPanel>
        <TabPanel value="teams">
          <Teams />
        </TabPanel>
        <TabPanel value="org">
          <Organization />
        </TabPanel>
        <TabPanel value="mentors">
          <Mentors />
        </TabPanel>
        <TabPanel value="scoring">
          <Scoring />
        </TabPanel>
        <TabPanel value="audit">
          <Audit />
        </TabPanel>
      </Tabs>
    </div>
  )
}

function Profile() {
  const { refresh } = useAuth()
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api<{ user: { name: string; email: string; timezone: string } }>('/me/profile') })
  const [v, setV] = useState({ name: '', timezone: '' })
  useEffect(() => {
    if (q.data) setV({ name: q.data.user.name, timezone: q.data.user.timezone })
  }, [q.data])
  const save = useMutation({
    mutationFn: () => api('/me', { method: 'PATCH', body: v }),
    onSuccess: () => {
      refresh()
      toast.success('Profile saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const zones = Intl.supportedValuesOf?.('timeZone') ?? [v.timezone]
  if (q.isLoading) return <Skeleton className="h-40" />
  return (
    <Card className="max-w-xl p-5">
      <div className="space-y-4">
        <Field label="Name" htmlFor="pf-name">
          <Input id="pf-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="pf-email">
          <Input id="pf-email" value={q.data?.user.email ?? ''} disabled />
        </Field>
        <Field label="Time zone" htmlFor="pf-tz" hint="Used for your daily planner, reminders and daily reports.">
          <Select id="pf-tz" value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
      </div>
    </Card>
  )
}

function Members() {
  const { isAdmin, me } = useAuth()
  const qc = useQueryClient()
  const members = useMembers()
  const teams = useTeams()
  const invites = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api<{ invitations: { id: string; email: string; role: string; expiresAt: string }[] }>('/invitations'),
  })
  const [inviting, setInviting] = useState(false)
  const [inv, setInv] = useState({ email: '', role: 'MEMBER', teamId: '' })
  const [link, setLink] = useState<string | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['members'] })
    qc.invalidateQueries({ queryKey: ['invitations'] })
  }
  const invite = useMutation({
    mutationFn: () => api<{ link: string | null }>('/invitations', { body: { email: inv.email, role: inv.role, teamId: inv.teamId || undefined } }),
    onSuccess: (r) => {
      refresh()
      setInv({ email: '', role: 'MEMBER', teamId: '' })
      if (r.link) setLink(r.link)
      else {
        setInviting(false)
        toast.success('Invitation sent')
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const update = useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: Record<string, unknown> }) => api(`/members/${userId}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/members/${userId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const revoke = useMutation({ mutationFn: (id: string) => api(`/invitations/${id}`, { method: 'DELETE' }), onSuccess: refresh })
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="People"
          action={
            <Button
              size="sm"
              onClick={() => {
                setLink(null)
                setInviting(true)
              }}
            >
              <UserPlus /> Invite
            </Button>
          }
        />
        {members.isLoading ? (
          <Skeleton className="m-4 h-32" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Teams</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(members.data ?? []).map((m) => (
                  <tr key={m.userId} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar name={m.name} />
                        <div>
                          <p className="font-medium">{m.name}</p>
                          {m.email && <p className="text-xs text-muted">{m.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {isAdmin && m.userId !== me?.user.id ? (
                        <Select
                          aria-label={`Role of ${m.name}`}
                          className="h-8 w-32 text-xs"
                          value={m.role}
                          onChange={(e) => update.mutate({ userId: m.userId, body: { role: e.target.value } })}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {label(r)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge>{label(m.role)}</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-soft">{m.teams.map((t) => t.name).join(', ') || '—'}</td>
                    <td className="px-4 py-2">
                      <Badge tone={m.status === 'ACTIVE' ? 'green' : 'neutral'}>{label(m.status)}</Badge>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {isAdmin && m.userId !== me?.user.id && m.role !== 'OWNER' && (
                        <span className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => update.mutate({ userId: m.userId, body: { status: m.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' } })}
                          >
                            {m.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                          </Button>
                          <Confirm
                            title={`Remove ${m.name}?`}
                            description="They lose access. Their open tasks become unassigned; their history stays."
                            confirmLabel="Remove"
                            danger
                            onConfirm={() => remove.mutateAsync(m.userId)}
                            trigger={
                              <Button size="sm" variant="ghost" className="text-danger" aria-label={`Remove ${m.name}`}>
                                <Trash2 />
                              </Button>
                            }
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Pending invitations" />
        {!invites.data?.invitations.length ? (
          <p className="p-4 text-sm text-muted">None.</p>
        ) : (
          <ul className="divide-y divide-line">
            {invites.data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="flex-1">{i.email}</span>
                <Badge>{label(i.role)}</Badge>
                <span className="text-xs text-muted">expires {fmtDateTime(i.expiresAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal
        open={inviting}
        onOpenChange={setInviting}
        title="Invite someone"
        footer={
          !link && (
            <Button onClick={() => invite.mutate()} loading={invite.isPending} disabled={!inv.email || (!isAdmin && !inv.teamId)}>
              Send invitation
            </Button>
          )
        }
      >
        {link ? (
          <div className="space-y-2 text-sm">
            <p>Email isn’t configured on this server, so share this invitation link yourself. It expires in 7 days.</p>
            <div className="flex gap-2">
              <Input readOnly value={link} aria-label="Invitation link" />
              <Button variant="secondary" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success('Copied'))}>
                <Copy />
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Email" htmlFor="inv-email">
              <Input id="inv-email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            </Field>
            <Field label="Role" htmlFor="inv-role">
              <Select id="inv-role" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })} disabled={!isAdmin}>
                {ROLES.filter((r) => r !== 'OWNER').map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Team" htmlFor="inv-team" hint={isAdmin ? 'Optional' : 'Managers invite people into the teams they manage.'}>
              <Select id="inv-team" value={inv.teamId} onChange={(e) => setInv({ ...inv, teamId: e.target.value })}>
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
          </div>
        )}
      </Modal>
    </div>
  )
}

function Teams() {
  const { isAdmin } = useAuth()
  const qc = useQueryClient()
  const teams = useTeams()
  const members = useMembers()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [managerId, setManagerId] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['teams'] })
    qc.invalidateQueries({ queryKey: ['members'] })
  }
  const create = useMutation({
    mutationFn: () => api('/teams', { body: { name, managerId: managerId || null } }),
    onSuccess: () => {
      refresh()
      setCreating(false)
      setName('')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/teams/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({ mutationFn: (id: string) => api(`/teams/${id}`, { method: 'DELETE' }), onSuccess: refresh })
  const managers = (members.data ?? []).filter((m) => ['OWNER', 'ADMIN', 'MANAGER'].includes(m.role))
  const team = teams.data?.find((t) => t.id === editing)
  return (
    <Card>
      <CardHeader
        title="Teams"
        description="A team's manager sees and manages its members' work."
        action={
          isAdmin && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New team
            </Button>
          )
        }
      />
      {teams.isLoading ? (
        <Skeleton className="m-4 h-32" />
      ) : !teams.data?.length ? (
        <EmptyState title="No teams yet" />
      ) : (
        <ul className="divide-y divide-line">
          {teams.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="w-40 font-medium">{t.name}</span>
              {isAdmin ? (
                <Select
                  aria-label={`Manager of ${t.name}`}
                  className="h-8 w-44 text-xs"
                  value={t.manager?.id ?? ''}
                  onChange={(e) => patch.mutate({ id: t.id, body: { managerId: e.target.value || null } })}
                >
                  <option value="">No manager</option>
                  {managers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-xs text-muted">Manager: {t.manager?.name ?? '—'}</span>
              )}
              <span className="flex-1 truncate text-xs text-ink-soft">{t.members.map((m) => m.name).join(', ') || 'No members'}</span>
              {t.canManage && (
                <Button size="sm" variant="secondary" onClick={() => setEditing(t.id)}>
                  Members
                </Button>
              )}
              {isAdmin && (
                <Confirm
                  title={`Delete ${t.name}?`}
                  description="Members stay in the organization; projects keep their tasks."
                  confirmLabel="Delete"
                  danger
                  onConfirm={() => del.mutateAsync(t.id)}
                  trigger={
                    <Button size="sm" variant="ghost" className="text-danger" aria-label={`Delete ${t.name}`}>
                      <Trash2 />
                    </Button>
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={creating}
        onOpenChange={setCreating}
        title="New team"
        footer={
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name}>
            Create
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Name" htmlFor="t-name">
            <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Manager" htmlFor="t-mgr" hint="Only people with the Manager, Admin or Owner role.">
            <Select id="t-mgr" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">No manager</option>
              {managers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
      {team && (
        <TeamMembersDialog
          team={team}
          allMembers={(members.data ?? []).filter((m) => m.status === 'ACTIVE')}
          onClose={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </Card>
  )
}

function TeamMembersDialog({
  team,
  allMembers,
  onClose,
}: {
  team: { id: string; name: string; members: { id: string }[] }
  allMembers: { userId: string; name: string; role: string }[]
  onClose: () => void
}) {
  const [ids, setIds] = useState<Set<string>>(new Set(team.members.map((m) => m.id)))
  const save = useMutation({
    mutationFn: () => api(`/teams/${team.id}/members`, { method: 'PUT', body: { userIds: [...ids] } }),
    onSuccess: onClose,
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${team.name} members`}
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
      }
    >
      <ul className="max-h-80 space-y-1 overflow-y-auto">
        {allMembers.map((m) => (
          <li key={m.userId}>
            <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-canvas">
              <input
                type="checkbox"
                checked={ids.has(m.userId)}
                onChange={(e) => {
                  const n = new Set(ids)
                  if (e.target.checked) n.add(m.userId)
                  else n.delete(m.userId)
                  setIds(n)
                }}
              />
              {m.name}
              <Badge className="ml-auto">{label(m.role)}</Badge>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

function Organization() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['organization'],
    queryFn: () => api<{ organization: { name: string; settings: { retentionDays?: number; requireReportApproval?: boolean } } }>('/organization'),
  })
  const [v, setV] = useState({ name: '', retentionDays: 730, requireReportApproval: false })
  useEffect(() => {
    if (q.data)
      setV({
        name: q.data.organization.name,
        retentionDays: q.data.organization.settings.retentionDays ?? 730,
        requireReportApproval: Boolean(q.data.organization.settings.requireReportApproval),
      })
  }, [q.data])
  const save = useMutation({
    mutationFn: () =>
      api('/organization', {
        method: 'PATCH',
        body: { name: v.name, settings: { retentionDays: v.retentionDays, requireReportApproval: v.requireReportApproval } },
      }),
    onSuccess: () => {
      qc.invalidateQueries()
      toast.success('Saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <Skeleton className="h-40" />
  return (
    <Card className="max-w-xl p-5">
      <div className="space-y-4">
        <Field label="Organization name" htmlFor="o-name">
          <Input id="o-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Data retention (days)" htmlFor="o-ret" hint="How long completed work history is kept (30–3650).">
          <Input id="o-ret" type="number" min={30} max={3650} value={v.retentionDays} onChange={(e) => setV({ ...v, retentionDays: Number(e.target.value) })} />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={v.requireReportApproval} onChange={(e) => setV({ ...v, requireReportApproval: e.target.checked })} />
          <span>Only admins may send team reports outside WorkPulse (email, Slack)</span>
        </label>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
      </div>
    </Card>
  )
}

function Mentors() {
  const qc = useQueryClient()
  const members = useMembers()
  const q = useQuery({
    queryKey: ['mentorships'],
    queryFn: () => api<{ mentorships: { id: string; mentor: { name: string }; mentee: { name: string } }[] }>('/mentorships'),
  })
  const [v, setV] = useState({ mentorId: '', menteeId: '' })
  const add = useMutation({
    mutationFn: () => api('/mentorships', { body: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mentorships'] })
      setV({ mentorId: '', menteeId: '' })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({
    mutationFn: (id: string) => api(`/mentorships/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mentorships'] }),
  })
  const people = members.data ?? []
  return (
    <Card>
      <CardHeader title="Mentor assignments" description="Mentors can read their mentees’ work and give mentor feedback; they cannot change it." />
      <div className="flex flex-wrap items-end gap-2 border-b border-line p-4">
        <Field label="Mentor" htmlFor="m-mentor">
          <Select id="m-mentor" className="w-48" value={v.mentorId} onChange={(e) => setV({ ...v, mentorId: e.target.value })}>
            <option value="">Choose…</option>
            {people
              .filter((p) => p.role !== 'MEMBER')
              .map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Mentee" htmlFor="m-mentee">
          <Select id="m-mentee" className="w-48" value={v.menteeId} onChange={(e) => setV({ ...v, menteeId: e.target.value })}>
            <option value="">Choose…</option>
            {people
              .filter((p) => p.role !== 'OWNER')
              .map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
        <Button onClick={() => add.mutate()} disabled={!v.mentorId || !v.menteeId} loading={add.isPending}>
          Assign
        </Button>
      </div>
      {!q.data?.mentorships.length ? (
        <p className="p-4 text-sm text-muted">No mentor assignments.</p>
      ) : (
        <ul className="divide-y divide-line">
          {q.data.mentorships.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="flex-1">
                {m.mentor.name} → {m.mentee.name}
              </span>
              <Button size="sm" variant="ghost" onClick={() => del.mutate(m.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Scoring() {
  const { isAdmin } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['scoring-models'],
    queryFn: () =>
      api<{
        models: { id: string; name: string; role: string | null; version: number; weights: Record<string, number>; active: boolean; createdAt: string }[]
        impactTargetPerWeek: number
      }>('/scoring-models'),
  })
  const active = q.data?.models.find((m) => m.active && !m.role)
  const [w, setW] = useState<Record<string, number>>(DEFAULT_WEIGHTS)
  const [name, setName] = useState('Default')
  const [role, setRole] = useState('')
  const [target, setTarget] = useState(10)
  useEffect(() => {
    if (active) setW(active.weights)
    if (q.data) setTarget(Number(q.data.impactTargetPerWeek))
  }, [active, q.data])
  const total = Object.values(w).reduce((a, b) => a + b, 0)
  const save = useMutation({
    mutationFn: () => api('/scoring-models', { body: { name, role: role || null, weights: w } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scoring-models'] })
      toast.success('New scoring version saved. Earlier snapshots keep their version.')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const saveTarget = useMutation({
    mutationFn: () => api('/scoring-models/target', { method: 'PUT', body: { impactTargetPerWeek: target } }),
    onSuccess: () => toast.success('Saved'),
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <Skeleton className="h-60" />
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Dimension weights" description="Saving creates a new version; past snapshots stay explainable under the version they used." />
        <div className="space-y-3 p-4">
          {SCORE_DIMENSIONS.map((d) => (
            <div key={d} className="grid grid-cols-[10rem_1fr_3.5rem] items-center gap-3">
              <span className="text-sm">{DIMENSION_INFO[d]?.name}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={w[d] ?? 0}
                disabled={!isAdmin}
                aria-label={`${DIMENSION_INFO[d]?.name} weight`}
                onChange={(e) => setW({ ...w, [d]: Number(e.target.value) })}
              />
              <span className="text-right text-sm tabular">{w[d]}%</span>
            </div>
          ))}
          <p className={`text-xs ${total === 100 ? 'text-muted' : 'text-danger'}`}>
            Total {total}% {total !== 100 && '(must be 100%)'}
          </p>
          {isAdmin && (
            <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <Field label="Model name" htmlFor="sm-name">
                <Input id="sm-name" className="w-36" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Applies to" htmlFor="sm-role">
                <Select id="sm-role" className="w-36" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="">Everyone (default)</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {label(r)}s
                    </option>
                  ))}
                </Select>
              </Field>
              <Button onClick={() => save.mutate()} disabled={total !== 100} loading={save.isPending}>
                Save new version
              </Button>
            </div>
          )}
          <p className="text-xs text-muted">
            Efficiency (estimate vs. actual, cycle time) is always shown but never weighted, so hours never count as productivity.
          </p>
        </div>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Expected impact per person per week"
            info="The impact dimension compares earned impact points with this target (Critical 10, High 5, Medium 2, Low 0.5 points)."
          />
          <div className="flex items-end gap-2 p-4">
            <Field label="Impact points" htmlFor="sm-target">
              <Input
                id="sm-target"
                type="number"
                min={1}
                max={200}
                className="w-28"
                value={target}
                disabled={!isAdmin}
                onChange={(e) => setTarget(Number(e.target.value))}
              />
            </Field>
            {isAdmin && (
              <Button variant="secondary" onClick={() => saveTarget.mutate()} loading={saveTarget.isPending}>
                Save
              </Button>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Versions" />
          <ul className="divide-y divide-line text-sm">
            {q.data?.models.map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-4 py-2">
                <span className="flex-1">
                  {m.name} v{m.version}
                  {m.role ? ` · ${label(m.role)}s` : ''}
                </span>
                <span className="text-xs text-muted">{SCORE_DIMENSIONS.map((d) => m.weights[d]).join(' / ')}</span>
                {m.active && <Badge tone="green">Active</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function Audit() {
  const [page, setPage] = useState(1)
  const q = useQuery({
    queryKey: ['audit', page],
    queryFn: () =>
      api<{
        items: { id: string; action: string; targetType: string; actorName: string | null; createdAt: string; diff: unknown; ip: string | null }[]
        total: number
      }>('/audit-logs', { query: { page } }),
  })
  return (
    <Card>
      <CardHeader title="Audit log" description="Role, scoring, assessment, evidence, integration and membership changes." />
      {q.isLoading ? (
        <Skeleton className="m-4 h-40" />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {q.data?.items.map((a) => (
              <li key={a.id} className="px-4 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{a.action}</Badge>
                  <span>{a.actorName ?? 'System'}</span>
                  <span className="text-xs text-muted">
                    {a.targetType} · {fmtDateTime(a.createdAt)}
                    {a.ip ? ` · ${a.ip}` : ''}
                  </span>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{JSON.stringify(a.diff)}</p>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-line px-4 py-2 text-xs text-muted">
            <span>{q.data?.total} entries</span>
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="ghost" disabled={page * 50 >= (q.data?.total ?? 0)} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </span>
          </div>
        </>
      )}
    </Card>
  )
}

interface PhoneAlertsState {
  available: boolean
  phone: string | null
  state: 'pending' | 'accepted' | 'declined' | null
  moments: { key: string; label: string; on: boolean }[]
  recent: { id: string; title: string; status: string; decision: string | null; createdAt: string }[]
}

/** The person's own phone alerts through M91. Says only what rings, why, and what to do. */
export function PhoneAlerts() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['phone-alerts'], queryFn: () => api<PhoneAlertsState>('/me/phone-alerts') })
  const [phone, setPhone] = useState('')
  const done = (d: PhoneAlertsState) => qc.setQueryData(['phone-alerts'], d)
  const save = useMutation({
    mutationFn: () => api<PhoneAlertsState>('/me/phone', { method: 'PUT', body: { phone } }),
    onSuccess: (d) => {
      done(d)
      toast.success('Invitation sent to your M91 app')
    },
    onError: (e) => toast.error(errorMessage(e), { duration: 10000 }),
  })
  const refresh = useMutation({
    mutationFn: () => api<PhoneAlertsState>('/me/phone/refresh', { method: 'POST' }),
    onSuccess: (d) => {
      done(d)
      toast(d.state === 'accepted' ? 'Connected: your phone will ring' : 'Not accepted yet: open the M91 app and accept the invitation')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const test = useMutation({
    mutationFn: () => api<{ delivered: number }>('/me/phone/test', { method: 'POST' }),
    onSuccess: () => toast.success('Test alert sent: your phone should ring now'),
    onError: (e) => toast.error(errorMessage(e), { duration: 10000 }),
  })
  const prefs = useMutation({
    mutationFn: (b: Record<string, boolean>) => api<PhoneAlertsState>('/me/alert-prefs', { method: 'PATCH', body: b }),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: () => api<PhoneAlertsState>('/me/phone', { method: 'DELETE' }), onSuccess: done })
  if (q.isLoading) return <Skeleton className="h-60" />
  const d = q.data
  if (!d) return null
  return (
    <Card>
      <CardHeader
        title="Your phone"
        description="WorkPulse rings your phone, even on silent, when something needs you now: you can answer right from the alert."
      />
      <div className="space-y-4 p-5 text-sm">
        {!d.available ? (
          <p className="text-muted">Phone alerts aren’t set up on this server yet. An administrator needs to add the M91 API key.</p>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-ink-soft">
              <li>
                Install M91 on your phone:{' '}
                <a className="text-primary hover:underline" href="https://apps.apple.com/app/id6759090472" target="_blank" rel="noreferrer">
                  iPhone
                </a>{' '}
                ·{' '}
                <a className="text-primary hover:underline" href="https://play.google.com/store/apps/details?id=com.msg91.m91" target="_blank" rel="noreferrer">
                  Android
                </a>
                , and sign in with your number.
              </li>
              <li>Enter the same number below.</li>
              <li>Accept the WorkPulse invitation that appears in the M91 app.</li>
            </ol>
            {d.phone ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas p-3">
                <span className="font-medium">+{d.phone}</span>
                <Badge tone={d.state === 'accepted' ? 'green' : d.state === 'declined' ? 'red' : 'amber'}>
                  {d.state === 'accepted' ? 'Connected' : d.state === 'declined' ? 'Invitation declined' : 'Waiting for you to accept in the M91 app'}
                </Badge>
                {d.state !== 'accepted' && (
                  <Button size="sm" variant="secondary" onClick={() => refresh.mutate()} loading={refresh.isPending}>
                    I’ve accepted it
                  </Button>
                )}
                {d.state === 'accepted' && (
                  <Button size="sm" variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
                    Send a test alert
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => remove.mutate()}>
                  Remove
                </Button>
              </div>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  save.mutate()
                }}
              >
                <Input aria-label="Mobile number" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <Button type="submit" loading={save.isPending} disabled={phone.replace(/\D/g, '').length < 10}>
                  Send invitation
                </Button>
              </form>
            )}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Your phone rings when…</p>
              <ul className="space-y-1.5">
                {d.moments.map((m) => (
                  <li key={m.key}>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={m.on} onChange={(e) => prefs.mutate({ [m.key]: e.target.checked })} />
                      <span>{m.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Your answer counts: “Can’t take it” passes a task to the next best person, “I’ll unblock it” tells the teammate you’re on it.
              </p>
            </div>
            {d.recent.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Recent alerts</p>
                <ul className="space-y-1 text-xs text-ink-soft">
                  {d.recent.map((a) => (
                    <li key={a.id} className="flex gap-2">
                      <span className="flex-1 truncate">{a.title}</span>
                      <span className="text-muted">{a.decision ?? (a.status === 'OPEN' ? 'waiting' : 'closed')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

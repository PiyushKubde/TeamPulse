// Owners and admins: who reports to whom, how departments nest, and how open the company views are.
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Search } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useMembers, useTeams } from '@/lib/queries'
import { Button, Card, CardHeader, Input, Segmented, Select, Skeleton } from '@/components/ui'

const PAGE = 40 // each row has a full list of people to pick from, so show them in pages

function Transparency() {
  const qc = useQueryClient()
  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => api<{ organization: { settings: { transparency?: 'OPEN' | 'PRIVATE' } } }>('/organization'),
  })
  const current = org.data?.organization.settings.transparency ?? 'OPEN'
  const set = useMutation({
    mutationFn: (transparency: 'OPEN' | 'PRIVATE') => api('/organization', { method: 'PATCH', body: { settings: { transparency } } }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['organization'] }), qc.invalidateQueries({ queryKey: ['company'] })])
      toast.success('Visibility updated')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Card>
      <CardHeader title="Who can see how people are doing" description="Applies to the Company views: org chart, comparisons, goal cascade and scorecards." />
      <div className="space-y-3 px-5 py-4">
        {org.isLoading ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <Segmented
            label="Visibility"
            value={current}
            onChange={(v) => set.mutate(v)}
            options={[
              { value: 'OPEN', label: 'Open to everyone' },
              { value: 'PRIVATE', label: 'Private' },
            ]}
          />
        )}
        <p className="max-w-[70ch] text-sm text-ink-soft">
          {current === 'OPEN'
            ? 'Open: every person in the company can see everyone’s scorecard, goals and KPIs, from the CEO to an intern, so peers, mentors and managers can compare. Tasks, evidence and comments stay private; people still edit only their own work.'
            : 'Private: people see only themselves, the people they manage and their mentees. Owners and admins still see everyone.'}
        </p>
      </div>
    </Card>
  )
}

export function Structure() {
  const qc = useQueryClient()
  const members = useMembers()
  const teams = useTeams()
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const refreshPeople = () => Promise.all([qc.invalidateQueries({ queryKey: ['members'] }), qc.invalidateQueries({ queryKey: ['company'] })])
  const refreshTeams = () => Promise.all([qc.invalidateQueries({ queryKey: ['teams'] }), qc.invalidateQueries({ queryKey: ['company'] })])

  const setBoss = useMutation({
    mutationFn: (v: { userId: string; reportsToId: string | null }) => api(`/members/${v.userId}`, { method: 'PATCH', body: { reportsToId: v.reportsToId } }),
    onSuccess: async () => {
      await refreshPeople()
      toast.success('Reporting line saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const setParent = useMutation({
    mutationFn: (v: { id: string; parentId: string | null }) => api(`/teams/${v.id}`, { method: 'PATCH', body: { parentId: v.parentId } }),
    onSuccess: async () => {
      await refreshTeams()
      toast.success('Department saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const active = useMemo(() => (members.data ?? []).filter((m) => m.status === 'ACTIVE').sort((a, b) => a.name.localeCompare(b.name)), [members.data])
  const term = q.trim().toLowerCase()
  const filtered = term ? active.filter((m) => `${m.name} ${m.title ?? ''}`.toLowerCase().includes(term)) : active
  const unassigned = active.filter((m) => !m.reportsToId).length

  return (
    <div className="space-y-4">
      <Transparency />

      <Card>
        <CardHeader
          title="Reporting lines"
          description={`Who each person reports to. The top of the company (for example the CEO) reports to no one. ${unassigned} ${unassigned === 1 ? 'person has' : 'people have'} no manager set.`}
        />
        <div className="px-5 py-4">
          <div className="relative mb-3 w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              aria-label="Search people"
              placeholder="Search name or title"
              className="pl-8"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setShown(PAGE)
              }}
            />
          </div>
          {members.isLoading ? (
            <Skeleton className="h-48" />
          ) : (
            <ul className="divide-y divide-line">
              {filtered.slice(0, shown).map((m) => (
                <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{m.name}</div>
                    <div className="truncate text-xs text-muted">{m.title ?? m.role.toLowerCase()}</div>
                  </div>
                  <Select
                    aria-label={`Who ${m.name} reports to`}
                    className="w-full sm:w-64"
                    value={m.reportsToId ?? ''}
                    disabled={setBoss.isPending}
                    onChange={(e) => setBoss.mutate({ userId: m.userId, reportsToId: e.target.value || null })}
                  >
                    <option value="">Top of the company (no manager)</option>
                    {active
                      .filter((o) => o.userId !== m.userId)
                      .map((o) => (
                        <option key={o.userId} value={o.userId}>
                          {o.name}
                          {o.title ? ` — ${o.title}` : ''}
                        </option>
                      ))}
                  </Select>
                </li>
              ))}
            </ul>
          )}
          {filtered.length > shown && (
            <Button variant="ghost" className="mt-2" onClick={() => setShown((s) => s + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown)} more ({filtered.length - shown} left)
            </Button>
          )}
          {!members.isLoading && filtered.length === 0 && <p className="text-sm text-muted">No one matches.</p>}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Departments"
          description="Put a team under a department (or another team) to roll results up. A team cannot sit under its own sub-team."
        />
        <div className="px-5 py-4">
          {teams.isLoading ? (
            <Skeleton className="h-24" />
          ) : (teams.data ?? []).length === 0 ? (
            <p className="text-sm text-muted">No teams yet. Create teams in Settings.</p>
          ) : (
            <ul className="divide-y divide-line">
              {(teams.data ?? []).map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{t.name}</div>
                    <div className="truncate text-xs text-muted">
                      {t.members.length} {t.members.length === 1 ? 'person' : 'people'}
                      {t.manager ? ` · led by ${t.manager.name}` : ''}
                    </div>
                  </div>
                  <Select
                    aria-label={`Department of ${t.name}`}
                    className="w-full sm:w-64"
                    value={t.parentId ?? ''}
                    disabled={setParent.isPending}
                    onChange={(e) => setParent.mutate({ id: t.id, parentId: e.target.value || null })}
                  >
                    <option value="">Top level (a department)</option>
                    {(teams.data ?? [])
                      .filter((o) => o.id !== t.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          Under {o.name}
                        </option>
                      ))}
                  </Select>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  )
}

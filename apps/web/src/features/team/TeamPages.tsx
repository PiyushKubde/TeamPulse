import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, Inbox, Layers, Search, Sparkles, UserX, Users } from 'lucide-react'
import { api, errorMessage, qs } from '@/lib/api'
import { useRange } from '@/lib/range'
import { useAiStatus, useProjects, useTeams } from '@/lib/queries'
import { ago, fmtDateTime, pct } from '@/lib/utils'
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KpiCard,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  label,
} from '@/components/ui'
import { Modal } from '@/components/ui/overlay'
import { BarList, BarsChart, ChartCard, DonutChart, LinesChart, SERIES } from '@/components/charts'
import {
  AiInsights,
  GoalsPanel,
  IndividualCharts,
  KpiRow,
  RangeSelect,
  RecentEvidence,
  WorkLists,
  useIndividual,
  weekLabel,
} from '../dashboard/IndividualAnalytics'
import { DashSkeleton } from '../dashboard/DashboardPages'

interface MemberRow {
  userId: string
  name: string
  role: string
  title: string | null
  score: number | null
  impact: number | null
  reliability: number | null
  deliveryRate: number | null
  goalsAchieved: number
  goalsDue: number
  completed: number
  highImpact: number
  impactPoints: number
  activeTasks: number
  inProgress: number
  blockers: number
  overdue: number
  estimateHours: number
  missingDimensions: string[]
  lastActivity: string | null
}

interface TeamData {
  team: { id: string; name: string } | null
  memberCount: number
  kpis: {
    deliveryRate: number | null
    highImpactOutcomes: number
    goalAchievement: { due: number; achieved: number; rate: number | null; avgProgress: number | null }
    activeBlockers: number
    overdue: number
    avgCycleHours: number | null
    completedOutcomes: number
  }
  weekly: {
    week: string
    completed: number
    onTime: number
    late: number
    planned: number
    impactPoints: number
    highImpact: number
    score: number | null
    blockers: number
  }[]
  members: MemberRow[]
  distribution: { byStatus: { status: string; value: number }[]; byImpact: { level: string; value: number }[]; byCategory: { name: string; value: number }[] }
  projects: { id: string; name: string; total: number; completed: number; blocked: number; progress: number }[]
  blockers: { byKind: { kind: string; open: number; resolved: number }[]; avgResolutionHours: number | null }
  health: {
    overloaded: { userId: string; name: string; activeTasks: number; estimateHours: number }[]
    unbalanced: boolean
    excessiveWip: { userId: string; name: string; inProgress: number }[]
    repeatedlyBlockedProjects: { name: string; count: number }[]
    longBlocked: { id: string; title: string; assigneeId: string | null }[]
    pendingReviews: number
    unassignedWork: number
    delayedMilestones: number
  }
}

function useTeamData() {
  const r = useRange()
  return useQuery({
    queryKey: ['analytics', 'team', r.from, r.to, r.teamId, r.projectId],
    queryFn: () => api<TeamData>('/analytics/team', { query: { from: r.from, to: r.to, teamId: r.teamId, projectId: r.projectId } }),
  })
}

/** Date range, team and project filters shared by every team page; they update every KPI and chart on the page. */
function TeamFilters() {
  const r = useRange()
  const teams = useTeams()
  const projects = useProjects()
  return (
    <>
      <RangeSelect />
      <Select aria-label="Team" className="w-40" value={r.teamId ?? ''} onChange={(e) => r.setTeam(e.target.value || null)}>
        <option value="">All my people</option>
        {(teams.data ?? [])
          .filter((t) => t.canManage)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
      </Select>
      <Select aria-label="Project" className="w-40" value={r.projectId ?? ''} onChange={(e) => r.setProject(e.target.value || null)}>
        <option value="">All projects</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </>
  )
}

const tasksLink = (f: Record<string, string | undefined>) => `/tasks${qs({ view: 'list', assigneeId: 'all', ...f })}`

function TeamKpis({ d }: { d: TeamData }) {
  const navigate = useNavigate()
  const r = useRange()
  const k = d.kpis
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiCard
        label="Delivery rate"
        value={pct(k.deliveryRate)}
        unit={k.deliveryRate == null ? undefined : '%'}
        info="Commitments due in the range that were completed by their due date."
        hint={`${d.memberCount} people`}
      />
      <KpiCard
        label="High-impact outcomes"
        value={k.highImpactOutcomes}
        info="Completed High or Critical impact tasks in the range."
        hint={`${k.completedOutcomes} outcomes in total`}
        onClick={() => navigate(tasksLink({ status: 'COMPLETED', projectId: r.projectId }))}
      />
      <KpiCard
        label="Goal achievement"
        value={
          k.goalAchievement.rate != null ? `${k.goalAchievement.rate}%` : k.goalAchievement.avgProgress != null ? `${k.goalAchievement.avgProgress}%` : '—'
        }
        info="Achieved share of goals due in the range; average progress while they are open."
        hint={k.goalAchievement.due ? `${k.goalAchievement.achieved}/${k.goalAchievement.due} achieved` : 'No goals due'}
        onClick={() => navigate('/goals')}
      />
      <KpiCard
        label="Active blockers"
        value={k.activeBlockers}
        tone={k.activeBlockers ? 'amber' : undefined}
        info="Open tasks currently blocked."
        onClick={() => navigate(tasksLink({ status: 'BLOCKED', projectId: r.projectId }))}
      />
      <KpiCard
        label="Overdue commitments"
        value={k.overdue}
        tone={k.overdue ? 'red' : undefined}
        info="Open tasks past their due date."
        onClick={() => navigate(tasksLink({ dueTo: new Date(Date.now() - 864e5).toISOString().slice(0, 10), projectId: r.projectId }))}
      />
      <KpiCard
        label="Avg. cycle time"
        value={k.avgCycleHours ?? '—'}
        unit={k.avgCycleHours == null ? undefined : 'h'}
        info="Average time from start to completion for work completed in the range. Context only, not scored."
      />
    </div>
  )
}

function Health({ d }: { d: TeamData }) {
  const h = d.health
  const navigate = useNavigate()
  const signals: { key: string; icon: React.ReactNode; title: string; detail: React.ReactNode; tone: 'amber' | 'red' | 'neutral'; onClick?: () => void }[] = []
  for (const o of h.overloaded)
    signals.push({
      key: `o${o.userId}`,
      icon: <Users />,
      title: `${o.name} may be overloaded`,
      detail: `${o.activeTasks} open tasks · ~${o.estimateHours}h estimated`,
      tone: 'amber',
      onClick: () => navigate(`/team/members/${o.userId}`),
    })
  if (h.unbalanced)
    signals.push({
      key: 'unb',
      icon: <Layers />,
      title: 'Workload is unbalanced',
      detail: 'One person has more than three times the open work of another.',
      tone: 'amber',
      onClick: () => navigate('/team/members?sort=activeTasks'),
    })
  for (const w of h.excessiveWip)
    signals.push({
      key: `w${w.userId}`,
      icon: <Layers />,
      title: `${w.name} has ${w.inProgress} tasks in progress`,
      detail: 'A lot of parallel work slows each item down.',
      tone: 'amber',
      onClick: () => navigate(`/team/members/${w.userId}`),
    })
  for (const p of h.repeatedlyBlockedProjects)
    signals.push({ key: `p${p.name}`, icon: <AlertTriangle />, title: `${p.name} is repeatedly blocked`, detail: `${p.count} blockers recently`, tone: 'red' })
  if (h.longBlocked.length)
    signals.push({
      key: 'lb',
      icon: <AlertTriangle />,
      title: `${h.longBlocked.length} task${h.longBlocked.length > 1 ? 's' : ''} blocked for over 3 days`,
      detail: h.longBlocked
        .slice(0, 3)
        .map((t) => t.title)
        .join(' · '),
      tone: 'red',
      onClick: () => navigate(tasksLink({ status: 'BLOCKED' })),
    })
  if (h.pendingReviews)
    signals.push({
      key: 'rev',
      icon: <Inbox />,
      title: `${h.pendingReviews} evidence item${h.pendingReviews > 1 ? 's' : ''} waiting for verification`,
      detail: 'On completed tasks of your people.',
      tone: 'neutral',
      onClick: () => navigate('/reviews?tab=evidence'),
    })
  if (h.unassignedWork)
    signals.push({
      key: 'un',
      icon: <UserX />,
      title: `${h.unassignedWork} open task${h.unassignedWork > 1 ? 's are' : ' is'} unassigned`,
      detail: 'Nobody owns them yet.',
      tone: 'neutral',
      onClick: () => navigate(tasksLink({ assigneeId: 'none' })),
    })
  if (h.delayedMilestones)
    signals.push({
      key: 'ms',
      icon: <AlertTriangle />,
      title: `${h.delayedMilestones} milestone${h.delayedMilestones > 1 ? 's' : ''} past due`,
      detail: 'Still open after their due date.',
      tone: 'red',
      onClick: () => navigate('/goals?period=MILESTONE'),
    })
  return (
    <Card>
      <CardHeader title="Team health" info="Signals to investigate, not judgements about people. Click a signal to see what is behind it." />
      {signals.length ? (
        <ul className="divide-y divide-line">
          {signals.map((s) => (
            <li key={s.key}>
              <button disabled={!s.onClick} onClick={s.onClick} className="flex w-full items-start gap-3 px-4 py-2.5 text-left enabled:hover:bg-hover">
                <span
                  className={`mt-0.5 rounded-md p-1.5 [&_svg]:size-3.5 ${s.tone === 'red' ? 'bg-danger-soft text-danger' : s.tone === 'amber' ? 'bg-warn-soft text-warn' : 'bg-canvas text-ink-soft'}`}
                >
                  {s.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className="block truncate text-xs text-muted">{s.detail}</span>
                </span>
                {s.onClick && <ChevronRight className="mt-1 size-4 text-muted" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No signals right now" description="Workload, blockers and reviews look healthy for this selection." />
      )}
    </Card>
  )
}

function TeamCharts({ d, full }: { d: TeamData; full?: boolean }) {
  const navigate = useNavigate()
  const r = useRange()
  const weeks = d.weekly.map((w) => ({ ...w, label: weekLabel(w.week) }))
  const openWeek = (w: { week: string }) =>
    navigate(
      tasksLink({ dueFrom: w.week, dueTo: new Date(new Date(`${w.week}T00:00:00Z`).getTime() + 6 * 864e5).toISOString().slice(0, 10), projectId: r.projectId }),
    )
  const contrib = [...d.members].sort((a, b) => b.impactPoints - a.impactPoints)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Weekly delivery"
        info="Completed work each week, split by on time and late. Click a week to see its tasks."
        empty={weeks.every((w) => !w.completed && !w.planned)}
        table={{ columns: ['Week', 'On time', 'Late', 'Planned'], rows: weeks.map((w) => [w.label, w.onTime, w.late, w.planned]) }}
      >
        <BarsChart
          data={weeks}
          x="label"
          stacked
          series={[
            { key: 'onTime', name: 'On time', color: 'var(--color-c2)' },
            { key: 'late', name: 'Late', color: 'var(--color-c4)' },
          ]}
          onSelect={openWeek}
        />
      </ChartCard>
      <ChartCard
        title="Impact delivered"
        info="Impact points of completed work each week (one critical outcome = 10, one low = 0.5). Click a week to see its tasks."
        empty={weeks.every((w) => !w.impactPoints)}
        table={{ columns: ['Week', 'Impact points', 'High-impact outcomes'], rows: weeks.map((w) => [w.label, w.impactPoints, w.highImpact]) }}
      >
        <BarsChart data={weeks} x="label" series={[{ key: 'impactPoints', name: 'Impact points', color: 'var(--color-c3)' }]} onSelect={openWeek} />
      </ChartCard>
      <ChartCard
        title="Individual contribution"
        info="Impact points per person in the range. Click a person to open their profile. A comparison of outcomes, not of hours or task counts."
        empty={!contrib.some((m) => m.impactPoints)}
        table={{
          columns: ['Person', 'Impact points', 'High-impact outcomes', 'Completed'],
          rows: contrib.map((m) => [m.name, m.impactPoints, m.highImpact, m.completed]),
        }}
      >
        <div className="h-full overflow-y-auto pr-1">
          <BarList
            rows={contrib.map((m) => ({ key: m.userId, label: m.name, value: m.impactPoints, sub: `· ${m.highImpact} high-impact` }))}
            onSelect={(id) => navigate(`/team/members/${id}`)}
          />
        </div>
      </ChartCard>
      <ChartCard
        title="Workload distribution"
        info="Open tasks per person, split by in progress and other open states. Click a person to open their profile."
        empty={!d.members.some((m) => m.activeTasks)}
        table={{
          columns: ['Person', 'In progress', 'Other open', 'Blocked'],
          rows: d.members.map((m) => [m.name, m.inProgress, m.activeTasks - m.inProgress, m.blockers]),
        }}
      >
        <BarsChart
          data={d.members.map((m) => ({ ...m, first: m.name.split(' ')[0], other: m.activeTasks - m.inProgress }))}
          x="first"
          stacked
          series={[
            { key: 'inProgress', name: 'In progress', color: 'var(--color-c1)' },
            { key: 'other', name: 'Other open', color: 'var(--color-c5)' },
          ]}
          onSelect={(m) => navigate(`/team/members/${m.userId}`)}
        />
      </ChartCard>
      <ChartCard
        title="Project progress"
        info="Completed share of tasks touched in the range, per project. Click a project to open it."
        empty={!d.projects.length}
        table={{
          columns: ['Project', 'Completed', 'Total', 'Blocked', 'Progress %'],
          rows: d.projects.map((p) => [p.name, p.completed, p.total, p.blocked, p.progress]),
        }}
      >
        <div className="h-full overflow-y-auto pr-1">
          <BarList
            rows={d.projects
              .sort((a, b) => b.total - a.total)
              .map((p, i) => ({
                key: p.id,
                label: p.name,
                value: p.progress,
                sub: `· ${p.completed}/${p.total}${p.blocked ? ` · ${p.blocked} blocked` : ''}`,
                tone: SERIES[i % 5],
              }))}
            max={100}
            format={(v) => `${v}%`}
            onSelect={(id) => navigate(`/projects/${id}`)}
          />
        </div>
      </ChartCard>
      <ChartCard
        title="Delivery reliability by person"
        info="Share of each person's commitments completed on time in the range (externally blocked delays excused). Click a person to open their profile."
        empty={!d.members.some((m) => m.deliveryRate != null)}
        table={{ columns: ['Person', 'Reliability %'], rows: d.members.map((m) => [m.name, m.deliveryRate]) }}
      >
        <div className="h-full overflow-y-auto pr-1">
          <BarList
            rows={d.members
              .filter((m) => m.deliveryRate != null)
              .map((m) => ({ key: m.userId, label: m.name, value: m.deliveryRate!, tone: 'var(--color-c2)' }))}
            max={100}
            format={(v) => `${v}%`}
            onSelect={(id) => navigate(`/team/members/${id}`)}
          />
        </div>
      </ChartCard>
      {full && (
        <>
          <ChartCard
            title="Work by status"
            info="Open tasks by status. Click a status to see those tasks."
            empty={d.distribution.byStatus.every((s) => !s.value)}
            table={{ columns: ['Status', 'Tasks'], rows: d.distribution.byStatus.map((s) => [label(s.status), s.value]) }}
          >
            <DonutChart
              data={d.distribution.byStatus.map((s) => ({ name: label(s.status), value: s.value, id: s.status }))}
              onSelect={(s) => s.id && navigate(tasksLink({ status: s.id, projectId: r.projectId }))}
            />
          </ChartCard>
          <ChartCard
            title="Completed work by category"
            info="What the team spent its delivered work on."
            empty={!d.distribution.byCategory.length}
            table={{ columns: ['Category', 'Completed'], rows: d.distribution.byCategory.map((c) => [c.name, c.value]) }}
          >
            <DonutChart
              data={d.distribution.byCategory}
              onSelect={(s) => s.name !== 'Uncategorised' && navigate(tasksLink({ category: s.name, status: 'COMPLETED' }))}
            />
          </ChartCard>
          <ChartCard
            title="Blockers by kind"
            info={`Open and resolved blockers. Average resolution ${d.blockers.avgResolutionHours ?? '—'} h. External and dependency blockers are not counted against people.`}
            empty={d.blockers.byKind.every((b) => !b.open && !b.resolved)}
            table={{ columns: ['Kind', 'Open', 'Resolved'], rows: d.blockers.byKind.map((b) => [label(b.kind), b.open, b.resolved]) }}
          >
            <BarsChart
              data={d.blockers.byKind.map((b) => ({ ...b, kindLabel: label(b.kind) }))}
              x="kindLabel"
              series={[
                { key: 'open', name: 'Open', color: 'var(--color-c4)' },
                { key: 'resolved', name: 'Resolved', color: 'var(--color-c2)' },
              ]}
              onSelect={() => navigate(tasksLink({ status: 'BLOCKED' }))}
            />
          </ChartCard>
          <ChartCard
            title="Team score history"
            info="Weekly team score from stored snapshots. Gaps mean no scoreable data that week."
            description={r.teamId ? undefined : 'Select a single team above to see its score history.'}
            empty={weeks.every((w) => w.score == null)}
            table={{ columns: ['Week', 'Score', 'Blockers'], rows: weeks.map((w) => [w.label, w.score, w.blockers]) }}
          >
            <LinesChart data={weeks} x="label" yMax={100} series={[{ key: 'score', name: 'Team score' }]} onSelect={openWeek} />
          </ChartCard>
        </>
      )}
    </div>
  )
}

export function TeamOverview() {
  const q = useTeamData()
  return (
    <div>
      <PageHeader title="Team overview" description="Delivery, impact and health for the people you manage." actions={<TeamFilters />} />
      {q.isLoading ? (
        <DashSkeleton />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : q.data.memberCount === 0 ? (
        <Card>
          <EmptyState
            icon={<Users />}
            title="No one to show yet"
            description="Add people to your team in Settings, or invite them."
            action={
              <Link to="/settings?tab=teams">
                <Button size="sm">Manage teams</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <TeamKpis d={q.data} />
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <MemberTable rows={q.data.members} compact />
            </div>
            <Health d={q.data} />
          </div>
          <TeamCharts d={q.data} />
        </div>
      )}
    </div>
  )
}

export function TeamAnalytics() {
  const q = useTeamData()
  return (
    <div>
      <PageHeader
        title="Team analytics"
        description="Every chart responds to the filters above; click any bar, slice or row to see the records behind it."
        actions={<TeamFilters />}
      />
      {q.isLoading ? (
        <DashSkeleton />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <div className="space-y-4">
          <TeamKpis d={q.data} />
          <TeamCharts d={q.data} full />
        </div>
      )}
    </div>
  )
}

type SortKey = 'name' | 'role' | 'score' | 'impact' | 'deliveryRate' | 'goalsAchieved' | 'activeTasks' | 'blockers' | 'lastActivity'

function MemberTable({ rows, compact }: { rows: MemberRow[]; compact?: boolean }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'impact', dir: -1 })
  const shown = useMemo(() => {
    const list = rows.filter((r) => (!search || r.name.toLowerCase().includes(search.toLowerCase())) && (!role || r.role === role))
    const val = (r: MemberRow) => (sort.key === 'lastActivity' ? (r.lastActivity ? new Date(r.lastActivity).getTime() : 0) : r[sort.key])
    return list.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      if (x == null) return 1
      if (y == null) return -1
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [rows, search, role, sort])
  const Th = ({ k, children, info }: { k: SortKey; children: React.ReactNode; info?: string }) => (
    <th className="px-3 py-2.5 font-medium" aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        className="inline-flex items-center gap-1 hover:text-ink"
        title={info}
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}
      >
        {children}
        {sort.key === k && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  )
  return (
    <Card>
      <CardHeader
        title="Teammates"
        info="Click a person to open their profile. Scores are explainable and exclude dimensions without data; they are a starting point for a conversation, not a verdict."
        action={
          <div className="flex gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
              <Input
                aria-label="Search people"
                className="h-8 w-40 pl-7 text-xs"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {!compact && (
              <Select aria-label="Role" className="h-8 w-32 text-xs" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">All roles</option>
                {['MEMBER', 'MENTOR', 'MANAGER', 'ADMIN', 'OWNER'].map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </Select>
            )}
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <Th k="name">Name</Th>
              <Th k="role">Role</Th>
              <Th k="impact" info="Impact dimension, 0–100">
                Impact
              </Th>
              <Th k="deliveryRate" info="On-time share of commitments">
                Delivery
              </Th>
              <Th k="goalsAchieved">Goals</Th>
              <Th k="activeTasks">Active</Th>
              <Th k="blockers">Blockers</Th>
              <Th k="lastActivity">Last activity</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr
                key={m.userId}
                onClick={() => navigate(`/team/members/${m.userId}`)}
                className="cursor-pointer border-b border-line/70 last:border-0 hover:bg-hover/70"
              >
                <td className="px-3 py-2">
                  <Link
                    to={`/team/members/${m.userId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-2 font-medium hover:text-primary"
                  >
                    <Avatar name={m.name} />
                    {m.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-ink-soft">{m.title ?? label(m.role)}</td>
                <td className="px-3 py-2 tabular">
                  {m.impact == null ? <span className="text-xs text-muted">No data</span> : Math.round(m.impact)}
                  <span className="ml-1 text-xs text-muted">{m.highImpact ? `· ${m.highImpact} high` : ''}</span>
                </td>
                <td className="px-3 py-2 tabular">{m.deliveryRate == null ? <span className="text-xs text-muted">No due work</span> : `${m.deliveryRate}%`}</td>
                <td className="px-3 py-2 tabular">{m.goalsDue ? `${m.goalsAchieved}/${m.goalsDue}` : '—'}</td>
                <td className="px-3 py-2 tabular">
                  {m.activeTasks}
                  {m.overdue ? (
                    <Badge tone="red" className="ml-1.5">
                      {m.overdue} overdue
                    </Badge>
                  ) : null}
                </td>
                <td className="px-3 py-2 tabular">{m.blockers ? <Badge tone="amber">{m.blockers}</Badge> : <span className="text-muted">0</span>}</td>
                <td className="px-3 py-2 text-xs text-muted">{ago(m.lastActivity)}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-muted">
                  No one matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function MemberPerformance() {
  const q = useTeamData()
  return (
    <div>
      <PageHeader
        title="Member performance"
        description="Compare outcomes, not activity. Sort by any column; click a person for their full profile."
        actions={<TeamFilters />}
      />
      {q.isLoading ? (
        <Skeleton className="h-96" />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <MemberTable rows={q.data.members} />
      )}
    </div>
  )
}

// ───────────── Member profile ─────────────

export function MemberProfile() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const q = useIndividual(userId)
  const taskLink = (f: Record<string, string>) => navigate(`/tasks${qs({ view: 'list', assigneeId: userId, ...f })}`)
  const openTask = (id: string) => navigate(`/tasks?task=${id}&assigneeId=all`)
  return (
    <div>
      {q.isLoading ? (
        <DashSkeleton />
      ) : q.error || !q.data ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          <PageHeader
            title={q.data.user.name}
            description={
              <span className="flex items-center gap-2">
                {label(q.data.user.role)} ·{' '}
                <Link to={`/tasks?assigneeId=${userId}&view=list`} className="text-primary hover:underline">
                  All tasks
                </Link>
              </span>
            }
            actions={
              <>
                <RangeSelect />
                <FeedbackButton userId={userId!} name={q.data.user.name} />
              </>
            }
          />
          <div className="space-y-4">
            <KpiRow d={q.data} taskLink={taskLink} />
            <AiMemberSummary userId={userId!} />
            <IndividualCharts d={q.data} taskLink={taskLink} />
            <WorkLists d={q.data} openTask={openTask} />
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <DailyTimeline userId={userId!} />
              </div>
              <GoalsPanel ownerId={userId} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <RecentEvidence d={q.data} openTask={openTask} />
              <FeedbackHistory userId={userId!} />
            </div>
            <AiInsights userId={userId} />
          </div>
        </>
      )}
    </div>
  )
}

function AiMemberSummary({ userId }: { userId: string }) {
  const ai = useAiStatus()
  const m = useMutation({
    mutationFn: () => api<{ summary: string; missingData: string[]; basedOnTasks: number }>('/ai/analyze-work', { body: { kind: 'weekly_summary', userId } }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!ai.data?.configured) return null
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="size-4 text-primary" /> AI performance summary
          </p>
          {m.data ? (
            <>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{m.data.summary}</p>
              {m.data.missingData.length > 0 && <p className="mt-1 text-xs text-warn">Missing data: {m.data.missingData.join('; ')}</p>}
              <p className="mt-1 text-[11px] text-muted">Factual summary of the last 14 days from {m.data.basedOnTasks} tasks. It does not rate the person.</p>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted">A factual summary of recent outcomes, work in progress and blockers, grounded in their tasks.</p>
          )}
        </div>
        <Button size="sm" variant="secondary" onClick={() => m.mutate()} loading={m.isPending}>
          {m.data ? 'Refresh' : 'Generate'}
        </Button>
      </div>
    </Card>
  )
}

function DailyTimeline({ userId }: { userId: string }) {
  const r = useRange()
  const q = useQuery({
    queryKey: ['tasks', 'timeline', userId, r.from],
    queryFn: () =>
      api<{ items: { id: string; title: string; status: string; impactLevel: string; updatedAt: string; completedAt: string | null }[] }>('/tasks', {
        query: { assigneeId: userId, sort: 'updatedAt', pageSize: 40 },
      }),
  })
  const byDay = new Map<string, { id: string; title: string; status: string; impactLevel: string; updatedAt: string }[]>()
  for (const t of q.data?.items ?? []) {
    const d = (t.completedAt ?? t.updatedAt).slice(0, 10)
    byDay.set(d, [...(byDay.get(d) ?? []), t])
  }
  return (
    <Card>
      <CardHeader title="Daily work timeline" info="Most recently updated or completed tasks, grouped by day." />
      {q.isLoading ? (
        <Skeleton className="m-4 h-32" />
      ) : byDay.size === 0 ? (
        <EmptyState title="No recent activity" />
      ) : (
        <ol className="max-h-80 space-y-3 overflow-y-auto p-4">
          {[...byDay].slice(0, 10).map(([day, items]) => (
            <li key={day}>
              <p className="mb-1 text-xs font-medium text-muted">
                {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
              </p>
              <ul className="space-y-1">
                {items.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks?task=${t.id}&assigneeId=all`} className="flex items-center gap-2 text-sm hover:text-primary">
                      <span
                        className={`size-1.5 rounded-full ${t.status === 'COMPLETED' ? 'bg-success' : t.status === 'BLOCKED' ? 'bg-danger' : 'bg-primary'}`}
                      />
                      <span className="truncate">{t.title}</span>
                      <Badge className="ml-auto">{label(t.status)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

function FeedbackHistory({ userId }: { userId: string }) {
  const q = useQuery({
    queryKey: ['feedback', userId],
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
        }[]
      }>('/feedback', { query: { userId } }),
  })
  return (
    <Card>
      <CardHeader title="Feedback" info="Manager, mentor, peer feedback and self-assessments. Kept separate from objective delivery metrics." />
      {q.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : !q.data?.feedback.length ? (
        <EmptyState title="No feedback yet" />
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-y-auto">
          {q.data.feedback.map((f) => (
            <li key={f.id} className="px-4 py-3 text-sm">
              <div className="flex items-center gap-2 text-xs text-muted">
                <Badge tone={f.kind === 'SELF' ? 'neutral' : 'blue'}>{label(f.kind)}</Badge>
                {f.authorName} · {fmtDateTime(f.createdAt)}
                {f.rating ? ` · ${f.rating}/5` : ''}
                {f.acknowledgedAt && <Badge tone="green">Acknowledged</Badge>}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-ink-soft">{f.body}</p>
              {f.response && <p className="mt-1 border-l-2 border-line pl-2 text-xs text-muted">Response: {f.response}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function FeedbackButton({ userId, name }: { userId: string; name: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('MANAGER')
  const [body, setBody] = useState('')
  const [rating, setRating] = useState('')
  const m = useMutation({
    mutationFn: () => api('/feedback', { body: { subjectUserId: userId, kind, body, rating: rating ? Number(rating) : null } }),
    onSuccess: () => {
      setOpen(false)
      setBody('')
      qc.invalidateQueries({ queryKey: ['feedback'] })
      toast.success('Feedback shared')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Give feedback
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={`Feedback for ${name}`}
        description="They are notified and can acknowledge or respond."
        footer={
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={body.trim().length < 3}>
            Share
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Type" htmlFor="fb-kind">
            <Select id="fb-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="MANAGER">Manager feedback</option>
              <option value="MENTOR">Mentor feedback</option>
              <option value="PEER">Peer feedback</option>
            </Select>
          </Field>
          <Field label="Feedback" htmlFor="fb-body">
            <Textarea
              id="fb-body"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Be specific: what happened, its effect, what to keep or change."
            />
          </Field>
          <Field label="Rating (optional)" htmlFor="fb-r">
            <Select id="fb-r" value={rating} onChange={(e) => setRating(e.target.value)}>
              <option value="">No rating</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  )
}

// Ranked comparison of a group: peers, team, mentors, managers, leaders, departments, everyone.
import { useMemo, useState } from 'react'
import { Segmented, Select, EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { CompanyOverview } from './api'
import { HealthChip, PctBar, PersonButton, VALUE_NOTE } from './parts'

export type CompareGroup = 'peers' | 'team' | 'mentors' | 'managers' | 'leaders' | 'departments' | 'everyone'

const GROUPS: { value: CompareGroup; label: string }[] = [
  { value: 'peers', label: 'My peers' },
  { value: 'team', label: 'My team' },
  { value: 'mentors', label: 'Mentors' },
  { value: 'managers', label: 'Managers' },
  { value: 'leaders', label: 'Leadership' },
  { value: 'departments', label: 'Departments' },
  { value: 'everyone', label: 'Everyone' },
]

interface Row {
  id: string
  name: string
  sub: string | null
  indent: number
  score: number | null
  goals: number | null
  kpi: number | null
  overall: number | null
  health: CompanyOverview['people'][number]['health']
  mine: boolean
  isPerson: boolean
}

/** Pure: the rows of one comparison group, best result first. */
export function compareRows(data: CompanyOverview, group: CompareGroup): Row[] {
  const me = data.people.find((p) => p.userId === data.me)
  const person = (p: CompanyOverview['people'][number]): Row => ({
    id: p.userId,
    name: p.name,
    sub: p.title,
    indent: 0,
    score: p.score,
    goals: p.goalProgress,
    kpi: p.kpiAttainment,
    overall: p.overall,
    health: p.health,
    mine: p.isMe,
    isPerson: true,
  })
  const rank = (a: Row, b: Row) => (b.overall ?? -1) - (a.overall ?? -1) || a.name.localeCompare(b.name)

  if (group === 'departments') {
    const ids = new Set(data.teams.map((t) => t.id))
    const kids = new Map<string, typeof data.teams>()
    for (const t of data.teams) if (t.parentId && ids.has(t.parentId)) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t])
    const myTeams = new Set(me?.teamIds ?? [])
    const toRow = (t: (typeof data.teams)[number], indent: number): Row => ({
      id: t.id,
      name: t.name,
      sub: `${t.people} ${t.people === 1 ? 'person' : 'people'}`,
      indent,
      score: t.score,
      goals: t.goalProgress,
      kpi: t.kpiAttainment,
      overall: t.overall,
      health: t.health,
      mine: myTeams.has(t.id),
      isPerson: false,
    })
    const out: Row[] = []
    const add = (t: (typeof data.teams)[number], indent: number) => {
      out.push(toRow(t, indent))
      ;[...(kids.get(t.id) ?? [])].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1)).forEach((c) => add(c, indent + 1))
    }
    data.teams
      .filter((t) => !t.parentId || !ids.has(t.parentId))
      .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))
      .forEach((t) => add(t, 0))
    return out
  }

  let list = data.people
  if (group === 'peers') list = me ? data.people.filter((p) => p.reportsToId === me.reportsToId) : []
  else if (group === 'team') {
    const mine = new Set(me?.teamIds ?? [])
    list = data.people.filter((p) => p.teamIds.some((t) => mine.has(t)))
  } else if (group === 'mentors') list = data.people.filter((p) => p.role === 'MENTOR')
  else if (group === 'managers') list = data.people.filter((p) => p.role === 'MANAGER')
  else if (group === 'leaders') list = data.people.filter((p) => p.directReports > 0)
  return list.map(person).sort(rank)
}

const EMPTY: Record<CompareGroup, string> = {
  peers: 'You have no peers yet: nobody else reports to the same person as you.',
  team: 'You are not on a team yet.',
  mentors: 'No mentors in the company yet.',
  managers: 'No managers in the company yet.',
  leaders: 'Nobody has direct reports yet. Set reporting lines in the Structure tab.',
  departments: 'No departments yet.',
  everyone: 'No one to show.',
}

export function Compare({ data, onOpen, initial = 'peers' }: { data: CompanyOverview; onOpen: (id: string) => void; initial?: CompareGroup }) {
  const [group, setGroup] = useState<CompareGroup>(initial)
  const rows = useMemo(() => compareRows(data, group), [data, group])
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="hidden md:block">
          <Segmented label="Compare group" value={group} onChange={setGroup} options={GROUPS} />
        </div>
        <Select aria-label="Compare group" className="w-48 md:hidden" value={group} onChange={(e) => setGroup(e.target.value as CompareGroup)}>
          {GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-xs text-muted">{rows.length} shown</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nothing to compare" description={EMPTY[group]} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[640px] text-left">
            <caption className="sr-only">Comparison of {GROUPS.find((g) => g.value === group)?.label}, best overall result first</caption>
            <thead className="border-b border-line bg-surface-2 text-xs text-muted">
              <tr>
                <th scope="col" className="w-10 px-3 py-2 font-medium">
                  #
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {group === 'departments' ? 'Department' : 'Person'}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Value score
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Goal progress
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  KPI attainment
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Overall
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Health
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={cn('border-b border-line last:border-0', r.mine && 'bg-primary-soft/50')} aria-current={r.mine ? 'true' : undefined}>
                  <td className="tabular px-3 py-2.5 text-sm text-muted">{r.indent === 0 ? i + 1 : ''}</td>
                  <td className="px-3 py-2.5" style={{ paddingLeft: `${0.75 + r.indent * 1.25}rem` }}>
                    {r.isPerson ? (
                      <PersonButton id={r.id} name={r.name} title={r.sub} onOpen={onOpen} mine={r.mine} />
                    ) : (
                      <div>
                        <div className="text-sm font-semibold text-ink">
                          {r.name}
                          {r.mine && <span className="ml-1.5 text-xs font-medium text-primary">(your team)</span>}
                        </div>
                        <div className="text-xs text-muted">{r.sub}</div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <PctBar value={r.score} label={`${r.name} value score`} />
                  </td>
                  <td className="px-3 py-2.5">
                    <PctBar value={r.goals} label={`${r.name} goal progress`} />
                  </td>
                  <td className="px-3 py-2.5">
                    <PctBar value={r.kpi} label={`${r.name} KPI attainment`} />
                  </td>
                  <td className="px-3 py-2.5">
                    <PctBar value={r.overall} label={`${r.name} overall`} />
                  </td>
                  <td className="px-3 py-2.5">
                    <HealthChip health={r.health} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">{VALUE_NOTE}</p>
    </div>
  )
}

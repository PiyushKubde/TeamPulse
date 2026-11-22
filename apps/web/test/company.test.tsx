import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Compare, compareRows } from '@/features/company/Compare'
import { OrgChart } from '@/features/company/OrgChart'
import type { CompanyOverview, CompanyPerson } from '@/features/company/api'

const person = (o: Partial<CompanyPerson> & { userId: string; name: string }): CompanyPerson => ({
  title: null,
  role: 'MEMBER',
  reportsToId: null,
  teamIds: [],
  score: null,
  dimensions: {},
  goalProgress: null,
  goalCount: 0,
  kpiAttainment: null,
  kpiCount: 0,
  overall: null,
  health: 'NO_DATA',
  isMe: false,
  depth: 0,
  directReports: 0,
  subtreeSize: 0,
  rollupOverall: null,
  ...o,
})

const data: CompanyOverview = {
  days: 28,
  transparency: 'OPEN',
  me: 'me',
  summary: { people: 5, overall: 60, health: 'AT_RISK', onTrack: 1, atRisk: 2, offTrack: 1 },
  teams: [],
  people: [
    person({
      userId: 'ceo',
      name: 'Cora CEO',
      title: 'CEO',
      role: 'OWNER',
      directReports: 2,
      subtreeSize: 4,
      overall: 70,
      rollupOverall: 60,
      health: 'ON_TRACK',
    }),
    person({
      userId: 'vp',
      name: 'Vic VP',
      role: 'MANAGER',
      reportsToId: 'ceo',
      depth: 1,
      directReports: 2,
      subtreeSize: 2,
      overall: 55,
      rollupOverall: 50,
      health: 'AT_RISK',
    }),
    person({
      userId: 'me',
      name: 'Mia Me',
      reportsToId: 'vp',
      depth: 2,
      overall: 40,
      health: 'OFF_TRACK',
      isMe: true,
      score: 40,
      goalProgress: 50,
      kpiAttainment: 30,
    }),
    person({ userId: 'pal', name: 'Pat Peer', reportsToId: 'vp', depth: 2, overall: 80, health: 'ON_TRACK', score: 85 }),
    person({ userId: 'new', name: 'Nia New', reportsToId: 'ceo', depth: 1, overall: null }),
  ],
}

describe('company compare', () => {
  it('groups peers as people with the same manager and ranks by overall result, best first', () => {
    const rows = compareRows(data, 'peers')
    expect(rows.map((r) => r.name)).toEqual(['Pat Peer', 'Mia Me'])
    expect(compareRows(data, 'managers').map((r) => r.name)).toEqual(['Vic VP'])
    expect(compareRows(data, 'leaders').map((r) => r.name)).toEqual(['Cora CEO', 'Vic VP'])
    // people with no data sort last rather than looking like a zero
    expect(compareRows(data, 'everyone').at(-1)?.name).toBe('Nia New')
  })

  it('renders the ranked table, marks the viewer, shows "—" for missing data, and states the value-not-volume rule', async () => {
    const onOpen = vi.fn()
    render(<Compare data={data} onOpen={onOpen} initial="peers" />)
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Pat Peer')).toBeInTheDocument()
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    expect(within(rows[1]!).getByText('(you)')).toBeInTheDocument()
    expect(within(rows[0]!).getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText(/never use raw task counts or hours/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /open pat peer's scorecard/i }))
    expect(onOpen).toHaveBeenCalledWith('pal')
  })
})

describe('company org chart', () => {
  it('starts with the top two levels open, expands on demand, and a search reveals deep matches', async () => {
    const deep = [...data.people, person({ userId: 'ic', name: 'Ivy Deep', reportsToId: 'me', depth: 3, overall: 65, health: 'AT_RISK' })].map((p) =>
      p.userId === 'me' ? { ...p, subtreeSize: 1, directReports: 1 } : p,
    )
    render(<OrgChart data={{ ...data, people: deep }} onOpen={() => {}} />)
    expect(screen.getByText('Cora CEO')).toBeInTheDocument()
    expect(screen.getByText('Mia Me')).toBeInTheDocument()
    expect(screen.queryByText('Ivy Deep')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /expand mia me's line/i }))
    expect(screen.getByText('Ivy Deep')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /collapse mia me's line/i }))
    expect(screen.queryByText('Ivy Deep')).not.toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: /search people/i }), 'ivy')
    expect(screen.getByText('Ivy Deep')).toBeInTheDocument()
    expect(screen.queryByText('Pat Peer')).not.toBeInTheDocument()
  })
})

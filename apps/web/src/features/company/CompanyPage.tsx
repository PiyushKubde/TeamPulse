// Company: the whole organization in the open, from the CEO down.
import { useSearchParams } from 'react-router-dom'
import { Card, ErrorState, KpiCard, PageHeader, Segmented, Skeleton } from '@/components/ui'
import { TabPanel, Tabs } from '@/components/ui/overlay'
import { useAuth } from '@/lib/auth'
import { HEALTH_LABEL, pct, useCompanyOverview } from './api'
import { Cascade } from './Cascade'
import { Compare } from './Compare'
import { OrgChart } from './OrgChart'
import { useOpenPerson } from './parts'
import { Scorecard } from './Scorecard'
import { Structure } from './Structure'

const DAYS = [
  { value: '28', label: '4 weeks' },
  { value: '56', label: '8 weeks' },
  { value: '90', label: '90 days' },
]

export function CompanyPage() {
  const { isAdmin } = useAuth()
  const [params, setParams] = useSearchParams()
  const days = Number(params.get('days') ?? 28) || 28
  const { openId, open, close } = useOpenPerson()
  const q = useCompanyOverview(days)
  const set = (k: string, v: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p)
      n.set(k, v)
      return n
    })
  const tabs = [
    { value: 'chart', label: 'Org chart' },
    { value: 'compare', label: 'Compare' },
    { value: 'cascade', label: 'Goal cascade' },
    ...(isAdmin ? [{ value: 'structure', label: 'Structure' }] : []),
  ]
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab')! : 'chart'
  const d = q.data
  const me = d?.people.find((p) => p.isMe)

  return (
    <div>
      <PageHeader
        title="Company"
        description="How the whole company is moving, from the CEO to every team: objectives, KPIs and delivered value, in the open, so peers, mentors and leaders can see and compare."
        actions={<Segmented label="Period" value={String(days)} onChange={(v) => set('days', v)} options={DAYS} />}
      />
      {d?.transparency === 'PRIVATE' && (
        <p role="note" className="mb-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-soft">
          Your company limits visibility, so you see your own line only.
        </p>
      )}
      {q.isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : q.error || !d ? (
        <Card>
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="Company overall"
              value={pct(d.summary.overall)}
              hint={HEALTH_LABEL[d.summary.health]}
              tone={d.summary.health === 'ON_TRACK' ? 'green' : d.summary.health === 'AT_RISK' ? 'amber' : d.summary.health === 'OFF_TRACK' ? 'red' : undefined}
              info="The average of every person's overall result: delivered value, goal progress and KPI attainment."
            />
            <KpiCard
              label="People"
              value={d.summary.people}
              hint={`${d.summary.onTrack} on track · ${d.summary.atRisk} at risk · ${d.summary.offTrack} off track`}
            />
            <KpiCard
              label="Me"
              value={pct(me?.overall)}
              hint={me ? HEALTH_LABEL[me.health] : 'Not in this view'}
              onClick={me ? () => open(me.userId) : undefined}
            />
            <KpiCard
              label="My line"
              value={pct(me?.rollupOverall)}
              hint={me && me.subtreeSize > 0 ? `${me.subtreeSize} ${me.subtreeSize === 1 ? 'person' : 'people'} below me` : 'No one reports to me'}
              info="The average result of you and everyone who reports to you, directly or indirectly."
            />
          </div>
          <Tabs value={tab} onValueChange={(v) => set('tab', v)} tabs={tabs}>
            <TabPanel value="chart">
              <OrgChart data={d} onOpen={open} />
            </TabPanel>
            <TabPanel value="compare">
              <Compare data={d} onOpen={open} initial={me && me.reportsToId ? 'peers' : 'leaders'} />
            </TabPanel>
            <TabPanel value="cascade">
              <Cascade onOpen={open} />
            </TabPanel>
            {isAdmin && (
              <TabPanel value="structure">
                <Structure />
              </TabPanel>
            )}
          </Tabs>
        </>
      )}
      <Scorecard userId={openId} days={days} onOpen={open} onClose={close} />
    </div>
  )
}

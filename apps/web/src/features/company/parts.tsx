// Small shared pieces for the company views.
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Avatar, Badge, Progress } from '@/components/ui'
import { HEALTH_LABEL, HEALTH_TONE, pct, type Health } from './api'

const DOT: Record<Health, string> = { ON_TRACK: 'bg-success', AT_RISK: 'bg-warn', OFF_TRACK: 'bg-danger', NO_DATA: 'bg-line-strong' }

export const HealthDot = ({ health }: { health: Health }) => (
  <span role="img" aria-label={HEALTH_LABEL[health]} title={HEALTH_LABEL[health]} className={cn('inline-block size-2.5 shrink-0 rounded-full', DOT[health])} />
)

export const HealthChip = ({ health }: { health: Health }) => <Badge tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Badge>

const toneOf = (v: number | null) => (v === null ? 'blue' : v >= 70 ? 'green' : v >= 45 ? 'amber' : 'red')

/** A number with a thin bar under it; "—" when there is no data (never a misleading 0). */
export function PctBar({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="min-w-[72px]">
      <div className="tabular text-sm font-medium text-ink">{pct(value)}</div>
      {value !== null ? <Progress value={value} tone={toneOf(value)} label={label} /> : <div className="h-1.5 w-full rounded-full bg-line/60" aria-hidden />}
    </div>
  )
}

/** Opens a person's scorecard by putting ?person=<id> in the URL (so it can be linked and survives refresh). */
export function useOpenPerson() {
  const [params, setParams] = useSearchParams()
  return {
    openId: params.get('person'),
    open: (id: string) =>
      setParams((p) => {
        const n = new URLSearchParams(p)
        n.set('person', id)
        return n
      }),
    close: () =>
      setParams((p) => {
        const n = new URLSearchParams(p)
        n.delete('person')
        return n
      }),
  }
}

export function PersonButton({
  id,
  name,
  title,
  onOpen,
  mine,
  extra,
}: {
  id: string
  name: string
  title?: string | null
  onOpen: (id: string) => void
  mine?: boolean
  extra?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      aria-label={`Open ${name}'s scorecard`}
      className="flex min-w-0 items-center gap-2.5 rounded-md text-left hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
    >
      <Avatar name={name} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">
          {name}
          {mine && <span className="ml-1.5 text-xs font-medium text-primary">(you)</span>}
        </span>
        {title && <span className="block truncate text-xs text-muted">{title}</span>}
        {extra}
      </span>
    </button>
  )
}

export const VALUE_NOTE = 'Ranks use delivered value (value score, goal progress and KPI attainment). They never use raw task counts or hours worked.'

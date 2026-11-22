import { useSearchParams } from 'react-router-dom'
import { endOfDay, startOfDay, startOfQuarter, subWeeks } from 'date-fns'

export const RANGES = [
  { value: '2w', label: 'Last 2 weeks' },
  { value: '4w', label: 'Last 4 weeks' },
  { value: '8w', label: 'Last 8 weeks' },
  { value: '12w', label: 'Last 12 weeks' },
  { value: 'qtd', label: 'Quarter to date' },
] as const

/** Global date range, kept in the URL so every chart and KPI on a page shares it and links are shareable. */
export function useRange() {
  const [params, setParams] = useSearchParams()
  const key = params.get('range') ?? '8w'
  const now = new Date()
  const from = key === 'qtd' ? startOfQuarter(now) : subWeeks(now, Number(key.replace('w', '')) || 8)
  const set = (k: string, v: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (v) n.set(k, v)
      else n.delete(k)
      return n
    })
  return {
    key,
    // Exact instants in the viewer's time zone; stable for the whole day so query keys don't churn.
    from: startOfDay(from).toISOString(),
    to: endOfDay(now).toISOString(),
    setRange: (v: string) => set('range', v),
    teamId: params.get('team') ?? undefined,
    setTeam: (v: string | null) => set('team', v),
    projectId: params.get('project') ?? undefined,
    setProject: (v: string | null) => set('project', v),
    params,
    set,
  }
}

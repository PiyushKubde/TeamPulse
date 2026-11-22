// KPI display (with a trend line), logging a reading, deleting, and the add-KPI form.
import { useId, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { fmtDate } from '@/lib/utils'
import { Badge, Button, Field, Input, Progress, Select } from '@/components/ui'
import { Confirm } from '@/components/ui/overlay'
import type { Kpi, KpiReading } from './api'

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))
const tone = (v: number) => (v >= 70 ? 'green' : v >= 45 ? 'amber' : 'red')

/** A tiny trend line of the readings. Decorative: the numbers beside it carry the meaning. */
export function Sparkline({ readings }: { readings: KpiReading[] }) {
  if (readings.length < 2) return <span className="text-xs text-muted">Not enough readings for a trend</span>
  const w = 120
  const h = 28
  const vals = readings.map((r) => r.value)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const span = hi - lo || 1
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`)
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Trend over ${readings.length} readings, from ${num(vals[0]!)} to ${num(vals[vals.length - 1]!)}`}
    >
      <polyline points={pts.join(' ')} fill="none" stroke="var(--color-c1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1]!.split(',')[0]} cy={pts[pts.length - 1]!.split(',')[1]} r="2.5" fill="var(--color-c1)" />
    </svg>
  )
}

function useRefreshKpis() {
  const qc = useQueryClient()
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['company'] }), qc.invalidateQueries({ queryKey: ['kpis'] })])
}

export function KpiItem({ kpi, showOwner }: { kpi: Kpi; showOwner?: boolean }) {
  const refresh = useRefreshKpis()
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const id = useId()
  const log = useMutation({
    mutationFn: () => api(`/kpis/${kpi.id}/readings`, { method: 'POST', body: { value: Number(value), note: note.trim() || null } }),
    onSuccess: async () => {
      setValue('')
      setNote('')
      await refresh()
      toast.success('Reading logged')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({
    mutationFn: () => api(`/kpis/${kpi.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh()
      toast.success('KPI removed')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const unit = kpi.unit ? ` ${kpi.unit}` : ''
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim() !== '' && Number.isFinite(Number(value))) log.mutate()
  }
  const last = kpi.readings[kpi.readings.length - 1]
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{kpi.name}</div>
          <div className="text-xs text-muted">
            {showOwner && kpi.ownerName ? `${kpi.ownerName} · ` : ''}
            {kpi.direction === 'LOWER' ? 'Lower is better' : 'Higher is better'} · {kpi.cadence.toLowerCase()}
          </div>
        </div>
        <Badge tone={tone(kpi.attainment)}>{kpi.attainment}% to target</Badge>
      </div>
      <div className="mt-2 grid items-center gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <div className="tabular text-sm text-ink-soft">
            <span className="text-lg font-semibold text-ink">
              {num(kpi.current)}
              {unit}
            </span>{' '}
            now · from {num(kpi.baseline)} · target {num(kpi.target)}
            {unit}
          </div>
          <div className="mt-1.5">
            <Progress value={kpi.attainment} tone={tone(kpi.attainment)} label={`${kpi.name} attainment`} />
          </div>
          {last && (
            <div className="mt-1 text-xs text-muted">
              Last reading {fmtDate(last.at)}
              {last.note ? ` · ${last.note}` : ''}
            </div>
          )}
        </div>
        <Sparkline readings={kpi.readings} />
      </div>
      {kpi.canEdit && (
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <div className="w-28">
            <label htmlFor={`${id}-v`} className="sr-only">
              New reading for {kpi.name}
            </label>
            <Input
              id={`${id}-v`}
              type="number"
              step="any"
              inputMode="decimal"
              placeholder="New value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="min-w-[140px] flex-1">
            <label htmlFor={`${id}-n`} className="sr-only">
              Note (optional)
            </label>
            <Input id={`${id}-n`} placeholder="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button type="submit" variant="secondary" loading={log.isPending} disabled={value.trim() === '' || !Number.isFinite(Number(value))}>
            Log reading
          </Button>
          <Confirm
            danger
            title="Remove this KPI?"
            description="Its readings stay in the audit trail, but it disappears from scorecards."
            confirmLabel="Remove"
            onConfirm={() => del.mutateAsync()}
            trigger={
              <Button type="button" variant="ghost" aria-label={`Remove ${kpi.name}`}>
                <Trash2 />
              </Button>
            }
          />
        </form>
      )}
    </li>
  )
}

export function AddKpi({ ownerId, ownerName }: { ownerId: string; ownerName: string }) {
  const refresh = useRefreshKpis()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ name: '', unit: '', direction: 'HIGHER', baseline: '0', target: '', cadence: 'MONTHLY' })
  const create = useMutation({
    mutationFn: () =>
      api('/kpis', {
        method: 'POST',
        body: {
          ownerId,
          name: f.name.trim(),
          unit: f.unit.trim() || null,
          direction: f.direction,
          baseline: Number(f.baseline),
          target: Number(f.target),
          cadence: f.cadence,
        },
      }),
    onSuccess: async () => {
      setF({ name: '', unit: '', direction: 'HIGHER', baseline: '0', target: '', cadence: 'MONTHLY' })
      setOpen(false)
      await refresh()
      toast.success('KPI added')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const valid = f.name.trim().length > 0 && f.target.trim() !== '' && Number.isFinite(Number(f.target)) && Number.isFinite(Number(f.baseline))
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus /> Add KPI for {ownerName.split(' ')[0]}
      </Button>
    )
  return (
    <form
      className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) create.mutate()
      }}
    >
      <Field label="KPI name" htmlFor="kpi-name" className="sm:col-span-2">
        <Input
          id="kpi-name"
          placeholder="e.g. Monthly recurring revenue"
          maxLength={200}
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
      </Field>
      <Field label="Unit (optional)" htmlFor="kpi-unit">
        <Input id="kpi-unit" placeholder="₹, %, ms, tickets…" maxLength={30} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
      </Field>
      <Field label="Better when" htmlFor="kpi-dir">
        <Select id="kpi-dir" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
          <option value="HIGHER">Higher (revenue, activations)</option>
          <option value="LOWER">Lower (churn, latency)</option>
        </Select>
      </Field>
      <Field label="Starting value" htmlFor="kpi-base">
        <Input id="kpi-base" type="number" step="any" value={f.baseline} onChange={(e) => setF({ ...f, baseline: e.target.value })} />
      </Field>
      <Field label="Target" htmlFor="kpi-target">
        <Input id="kpi-target" type="number" step="any" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
      </Field>
      <Field label="Review cadence" htmlFor="kpi-cad">
        <Select id="kpi-cad" value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value })}>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
          <option value="QUARTERLY">Quarterly</option>
        </Select>
      </Field>
      <div className="flex items-end justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" loading={create.isPending} disabled={!valid}>
          Add KPI
        </Button>
      </div>
    </form>
  )
}

// Chart building blocks. Rules (validated palette, see index.css): categorical hues in fixed order and following the
// entity; one y-axis; 2px lines; rounded bar ends; legends for 2+ series; value-first tooltips; every chart has a
// table view so no value is reachable only by hover or colour.
import { useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Table2, BarChart3 } from 'lucide-react'
import { Card, CardHeader, EmptyState } from '@/components/ui'

export const SERIES = ['var(--color-c1)', 'var(--color-c2)', 'var(--color-c3)', 'var(--color-c4)', 'var(--color-c5)']
const AXIS = { fontSize: 11, fill: 'var(--color-muted)' }

export interface SeriesDef {
  key: string
  name: string
  color?: string
}

interface TipProps {
  active?: boolean
  payload?: readonly { dataKey?: unknown; name?: unknown; value?: unknown; color?: string }[]
  label?: unknown
  format?: (v: number) => string
}

function ChartTooltip({ active, payload, label, format }: TipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-muted">{label == null ? '' : String(label)}</p>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded" style={{ background: p.color }} aria-hidden />
          <span className="font-semibold text-ink tabular">{p.value == null ? '—' : format ? format(Number(p.value)) : String(p.value)}</span>
          <span className="text-muted">{String(p.name ?? '')}</span>
        </div>
      ))}
    </div>
  )
}

/** Card + title + info + "table view" toggle. */
export function ChartCard({
  title,
  info,
  description,
  action,
  empty,
  table,
  children,
  height = 240,
}: {
  title: string
  info?: string
  description?: ReactNode
  action?: ReactNode
  empty?: boolean
  table: { columns: string[]; rows: (string | number | null)[][] }
  children: ReactNode
  height?: number
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={title}
        info={info}
        description={description}
        action={
          <div className="flex items-center gap-1">
            {action}
            {!empty && (
              <button
                type="button"
                onClick={() => setAsTable((v) => !v)}
                className="rounded-md p-1.5 text-muted hover:bg-canvas hover:text-ink"
                aria-label={asTable ? 'Show chart' : 'Show as table'}
                title={asTable ? 'Show chart' : 'Show as table'}
              >
                {asTable ? <BarChart3 className="size-4" /> : <Table2 className="size-4" />}
              </button>
            )}
          </div>
        }
      />
      <div className="flex-1 p-3">
        {empty ? (
          <EmptyState title="No data in this range" description="Change the date range or filters." />
        ) : asTable ? (
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-left text-muted">
                <tr>
                  {table.columns.map((c) => (
                    <th key={c} className="px-2 py-1.5 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {r.map((v, j) => (
                      <td key={j} className="px-2 py-1.5 tabular">
                        {v ?? '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ height }}>{children}</div>
        )}
      </div>
    </Card>
  )
}

/** Grouped bars over a category axis (weeks). onSelect receives the clicked category's row. */
export function BarsChart<T extends Record<string, unknown>>({
  data,
  x,
  series,
  onSelect,
  stacked,
  format,
  yMax,
}: {
  data: T[]
  x: keyof T & string
  series: SeriesDef[]
  onSelect?: (row: T) => void
  stacked?: boolean
  format?: (v: number) => string
  yMax?: number
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        barGap={2}
        barCategoryGap="28%"
        onClick={(s) => {
          const i = s?.activeTooltipIndex
          if (onSelect && i != null) onSelect(data[Number(i)]!)
        }}
        style={{ cursor: onSelect ? 'pointer' : undefined }}
      >
        <CartesianGrid vertical={false} stroke="var(--color-line)" />
        <XAxis dataKey={x as string} tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={32} allowDecimals={false} domain={yMax ? [0, yMax] : undefined} />
        <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: 'var(--color-canvas)' }} />
        {series.length > 1 && <Legend iconType="rect" iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            fill={s.color ?? SERIES[i]}
            radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]}
            stackId={stacked ? 'a' : undefined}
            maxBarSize={28}
            stroke="var(--color-surface)"
            strokeWidth={stacked ? 2 : 0}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

export function LinesChart<T extends Record<string, unknown>>({
  data,
  x,
  series,
  onSelect,
  yMax,
  format,
}: {
  data: T[]
  x: keyof T & string
  series: SeriesDef[]
  onSelect?: (row: T) => void
  yMax?: number
  format?: (v: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        onClick={(s) => {
          const i = s?.activeTooltipIndex
          if (onSelect && i != null) onSelect(data[Number(i)]!)
        }}
        style={{ cursor: onSelect ? 'pointer' : undefined }}
      >
        <CartesianGrid vertical={false} stroke="var(--color-line)" />
        <XAxis dataKey={x as string} tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={32} domain={[0, yMax ?? 'auto']} />
        <Tooltip content={<ChartTooltip format={format} />} cursor={{ stroke: 'var(--color-line-strong)', strokeWidth: 1 }} />
        {series.length > 1 && <Legend iconType="plainline" iconSize={12} wrapperStyle={{ fontSize: 11 }} />}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="linear"
            dataKey={s.key}
            name={s.name}
            stroke={s.color ?? SERIES[i]}
            strokeWidth={2}
            dot={{ r: 3, strokeWidth: 2, fill: 'var(--color-surface)' }}
            activeDot={{ r: 5 }}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

/** Part-to-whole with ≤ 5 slices (more fold into "Other"). Legend lists every slice with its value. */
export function DonutChart({
  data,
  onSelect,
}: {
  data: { name: string; value: number; id?: string | null }[]
  onSelect?: (d: { name: string; value: number; id?: string | null }) => void
}) {
  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value)
  const slices = sorted.length > 5 ? [...sorted.slice(0, 4), { name: 'Other', value: sorted.slice(4).reduce((s, d) => s + d.value, 0), id: undefined }] : sorted
  const total = slices.reduce((s, d) => s + d.value, 0)
  return (
    <div className="flex h-full items-center gap-4">
      <div className="h-full w-1/2 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="88%"
              paddingAngle={slices.length > 1 ? 2 : 0}
              stroke="var(--color-surface)"
              strokeWidth={2}
              onClick={(d) => onSelect?.(d.payload as never)}
              style={{ cursor: onSelect ? 'pointer' : undefined }}
            >
              {slices.map((s, i) => (
                <Cell key={s.name} fill={SERIES[i]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-1/2 space-y-1.5 text-xs">
        {slices.map((s, i) => (
          <li key={s.name}>
            <button
              type="button"
              disabled={!onSelect || s.name === 'Other'}
              onClick={() => onSelect?.(s)}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left enabled:hover:bg-canvas"
            >
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i] }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ink-soft">{s.name}</span>
              <span className="font-medium text-ink tabular">{s.value}</span>
              <span className="w-9 text-right text-muted tabular">{total ? Math.round((s.value / total) * 100) : 0}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Horizontal labelled bars (ranked comparisons, progress). Each row is a button when onSelect is given. */
export function BarList({
  rows,
  max,
  onSelect,
  format,
}: {
  rows: { key: string; label: string; value: number; sub?: string; tone?: string }[]
  max?: number
  onSelect?: (key: string) => void
  format?: (v: number) => string
}) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const inner = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-ink-soft">{r.label}</span>
              <span className="shrink-0 font-medium text-ink tabular">
                {format ? format(r.value) : r.value}
                {r.sub && <span className="ml-1 font-normal text-muted">{r.sub}</span>}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-line">
              <div className="h-full rounded-full" style={{ width: `${(r.value / m) * 100}%`, background: r.tone ?? 'var(--color-c1)' }} />
            </div>
          </>
        )
        return (
          <li key={r.key}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(r.key)} className="block w-full rounded px-1 py-0.5 text-left hover:bg-canvas">
                {inner}
              </button>
            ) : (
              <div className="px-1">{inner}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
